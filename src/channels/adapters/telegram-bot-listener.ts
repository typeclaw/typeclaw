import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { TelegramBotError } from 'agent-messenger/telegrambot'
import type { TelegramBotClient, TelegramBotUser, TelegramMessage, TelegramUpdate } from 'agent-messenger/telegrambot'

const CURSOR_VERSION = 1
const FETCH_TIMEOUT_GRACE_MS = 10_000
const RECONNECT_BASE_DELAY_MS = 1_000
const RECONNECT_MAX_DELAY_MS = 30_000
const FATAL_ERROR_CODES = new Set(['unauthorized', 'conflict'])

export type TelegramBotCursorState =
  | { version: 1; status: 'initializing' }
  | { version: 1; status: 'ready'; offset: number }

export interface TelegramBotCursorStore {
  read(): Promise<TelegramBotCursorState | null>
  write(state: TelegramBotCursorState): Promise<void>
}

export type TelegramBotPollingListenerEventMap = {
  connected: [info: { user: TelegramBotUser }]
  disconnected: []
  error: [error: Error]
  message: [event: TelegramMessage]
  channel_post: [event: TelegramMessage]
}

type ListenerEvent = keyof TelegramBotPollingListenerEventMap
type ListenerHandler<K extends ListenerEvent> = (...args: TelegramBotPollingListenerEventMap[K]) => void | Promise<void>
type Backoff = (delayMs: number, signal: AbortSignal) => Promise<void>

export type TelegramBotPollingClient = Pick<TelegramBotClient, 'deleteWebhook' | 'getUpdates'>

export type TelegramBotPollingListenerOptions = {
  agentDir: string
  botUser: TelegramBotUser
  timeoutSeconds: number
  limit: number
  allowedUpdates: string[]
  cursorStore?: TelegramBotCursorStore
  backoff?: Backoff
}

export type TelegramBotPollingListenerStopOptions = {
  finishCurrentDispatch?: boolean
}

export interface TelegramBotPollingListener {
  start(): Promise<void>
  stop(options?: TelegramBotPollingListenerStopOptions): Promise<void>
  on<K extends ListenerEvent>(event: K, handler: ListenerHandler<K>): this
}

export type TelegramBotPollingListenerFactory = (
  client: TelegramBotPollingClient,
  options: TelegramBotPollingListenerOptions,
) => TelegramBotPollingListener

export function telegramBotCursorPath(agentDir: string, botId: number): string {
  return join(agentDir, 'channels', 'telegram-bot', 'cursors', `${botId}.json`)
}

export function createTelegramBotPollingListener(
  client: TelegramBotPollingClient,
  options: TelegramBotPollingListenerOptions,
): TelegramBotPollingListener {
  return new DurableTelegramBotPollingListener(client, options)
}

class DurableTelegramBotPollingListener implements TelegramBotPollingListener {
  private readonly handlers = new Map<ListenerEvent, Set<ListenerHandler<ListenerEvent>>>()
  private readonly cursorStore: TelegramBotCursorStore
  private running = false
  private generation = 0
  private offset = 0
  private reconnectAttempts = 0
  private pollDisconnected = false
  private activeAbortController: AbortController | null = null
  private pollLoopPromise: Promise<void> | null = null
  private dispatchingGeneration: number | null = null
  private finishingDispatchGeneration: number | null = null

  constructor(
    private readonly client: TelegramBotPollingClient,
    private readonly options: TelegramBotPollingListenerOptions,
  ) {
    this.cursorStore =
      options.cursorStore ?? createFileCursorStore(telegramBotCursorPath(options.agentDir, options.botUser.id))
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.reconnectAttempts = 0
    this.pollDisconnected = false
    const generation = ++this.generation

    try {
      const state = await this.cursorStore.read()
      if (!this.isCurrent(generation)) return

      if (state === null) {
        await this.cursorStore.write({ version: 1, status: 'initializing' })
        if (!this.isCurrent(generation)) return
        await this.client.deleteWebhook({ drop_pending_updates: true })
        if (!this.isCurrent(generation)) return
        await this.cursorStore.write({ version: 1, status: 'ready', offset: 0 })
        this.offset = 0
      } else if (state.status === 'initializing') {
        // A crash may have happened before or after the first destructive drop.
        // Preserve possible backlog on recovery rather than risk dropping twice.
        await this.client.deleteWebhook({ drop_pending_updates: false })
        if (!this.isCurrent(generation)) return
        await this.cursorStore.write({ version: 1, status: 'ready', offset: 0 })
        this.offset = 0
      } else {
        this.offset = state.offset
        await this.client.deleteWebhook({ drop_pending_updates: false })
      }

      if (!this.isCurrent(generation)) return
      await this.emitSafely('connected', { user: this.options.botUser })
      if (!this.isCurrent(generation)) return
      this.pollLoopPromise = this.supervisePollLoop(generation)
    } catch (error) {
      if (this.isCurrent(generation)) this.running = false
      this.abortActiveOperation()
      throw normalizeError(error)
    }
  }

  async stop(options: TelegramBotPollingListenerStopOptions = {}): Promise<void> {
    this.running = false
    if (options.finishCurrentDispatch === true && this.dispatchingGeneration === this.generation) {
      this.finishingDispatchGeneration = this.generation
    } else {
      this.generation++
      this.finishingDispatchGeneration = null
    }
    this.abortActiveOperation()
    await this.pollLoopPromise
    this.pollLoopPromise = null
    if (this.finishingDispatchGeneration !== null) {
      this.generation++
      this.finishingDispatchGeneration = null
    }
  }

  on<K extends ListenerEvent>(event: K, handler: ListenerHandler<K>): this {
    const handlers = this.handlers.get(event) ?? new Set<ListenerHandler<ListenerEvent>>()
    handlers.add(handler as ListenerHandler<ListenerEvent>)
    this.handlers.set(event, handlers)
    return this
  }

  private isCurrent(generation: number): boolean {
    return this.running && generation === this.generation
  }

  private async supervisePollLoop(generation: number): Promise<void> {
    try {
      await this.pollLoop(generation)
    } catch (error) {
      if (this.isCurrent(generation)) await this.terminate(normalizeError(error))
    }
  }

  private async pollLoop(generation: number): Promise<void> {
    let firstSuccessfulPoll = true
    while (this.isCurrent(generation)) {
      const pollController = new AbortController()
      this.activeAbortController = pollController
      const fetchTimeout = setTimeout(
        () => pollController.abort(),
        (this.options.timeoutSeconds + FETCH_TIMEOUT_GRACE_MS / 1_000) * 1_000,
      )

      let updates: TelegramUpdate[]
      try {
        updates = await settleWithAbort(
          this.client.getUpdates(
            {
              offset: this.offset,
              limit: this.options.limit,
              timeout: this.options.timeoutSeconds,
              allowed_updates: firstSuccessfulPoll ? this.options.allowedUpdates : undefined,
            },
            pollController.signal,
          ),
          pollController.signal,
        )
      } catch (error) {
        clearTimeout(fetchTimeout)
        this.clearActiveOperation(pollController)
        if (!this.isCurrent(generation)) return
        if (error instanceof TelegramBotError && FATAL_ERROR_CODES.has(error.code)) {
          await this.terminate(error)
          return
        }
        this.pollDisconnected = true
        await this.emitSafely('disconnected')
        await this.backoff(generation)
        continue
      }
      clearTimeout(fetchTimeout)
      this.clearActiveOperation(pollController)

      if (!this.isCurrent(generation)) return
      firstSuccessfulPoll = false
      this.reconnectAttempts = 0
      if (this.pollDisconnected) {
        this.pollDisconnected = false
        await this.emitSafely('connected', { user: this.options.botUser })
      }
      for (const update of updates) {
        if (!this.isCurrent(generation)) return
        this.dispatchingGeneration = generation
        const handlerErrors = await this.dispatch(update)
        if (handlerErrors.length > 0) {
          this.dispatchingGeneration = null
          await this.terminate(new AggregateError(handlerErrors, 'Telegram bot update handler failed'))
          return
        }
        if (!this.mayFinishDispatch(generation)) {
          this.dispatchingGeneration = null
          return
        }

        const nextOffset = update.update_id + 1
        // Telegram only sees the higher offset after its durable checkpoint exists.
        try {
          await this.cursorStore.write({ version: 1, status: 'ready', offset: nextOffset })
        } catch (error) {
          this.dispatchingGeneration = null
          await this.terminate(
            new Error(
              `Telegram bot cursor checkpoint failed; update ${update.update_id} was not acknowledged and will replay after recovery: ${normalizeError(error).message}`,
            ),
          )
          return
        }
        this.offset = nextOffset
        this.dispatchingGeneration = null
        if (!this.running) return
      }
    }
  }

  private async dispatch(update: TelegramUpdate): Promise<Error[]> {
    const errors: Error[] = []
    if (update.message !== undefined) errors.push(...(await this.runHandlers('message', update.message)))
    if (update.channel_post !== undefined) errors.push(...(await this.runHandlers('channel_post', update.channel_post)))
    return errors
  }

  private async terminate(error: Error): Promise<void> {
    this.running = false
    this.abortActiveOperation()
    await this.emitSafely('error', error)
    await this.emitSafely('disconnected')
  }

  private async emitSafely<K extends ListenerEvent>(
    event: K,
    ...args: TelegramBotPollingListenerEventMap[K]
  ): Promise<void> {
    await this.runHandlers(event, ...args)
  }

  private async runHandlers<K extends ListenerEvent>(
    event: K,
    ...args: TelegramBotPollingListenerEventMap[K]
  ): Promise<Error[]> {
    const handlers = this.handlers.get(event)
    if (handlers === undefined) return []
    const errors: Error[] = []
    for (const handler of handlers) {
      try {
        await handler(...args)
      } catch (error) {
        errors.push(normalizeError(error))
      }
    }
    return errors
  }

  private async backoff(generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_DELAY_MS)
    this.reconnectAttempts++
    const controller = new AbortController()
    this.activeAbortController = controller
    try {
      await (this.options.backoff ?? delayWithAbort)(delay, controller.signal)
    } finally {
      this.clearActiveOperation(controller)
    }
  }

  private abortActiveOperation(): void {
    this.activeAbortController?.abort()
    this.activeAbortController = null
  }

  private clearActiveOperation(controller: AbortController): void {
    if (this.activeAbortController === controller) this.activeAbortController = null
  }

  private mayFinishDispatch(generation: number): boolean {
    return this.isCurrent(generation) || this.finishingDispatchGeneration === generation
  }
}

function createFileCursorStore(path: string): TelegramBotCursorStore {
  return {
    async read(): Promise<TelegramBotCursorState | null> {
      let raw: string
      try {
        raw = await readFile(path, 'utf8')
      } catch (error) {
        if (isEnoent(error)) return null
        throw error
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (error) {
        throw cursorStateError(path, `invalid JSON: ${normalizeError(error).message}`)
      }
      if (!isRecord(parsed) || parsed.version !== CURSOR_VERSION) {
        const version = isRecord(parsed) ? parsed.version : undefined
        throw cursorStateError(path, `unsupported version ${String(version)}`)
      }
      if (parsed.status === 'initializing') return { version: 1, status: 'initializing' }
      if (parsed.status === 'ready' && Number.isSafeInteger(parsed.offset) && (parsed.offset as number) >= 0) {
        return { version: 1, status: 'ready', offset: parsed.offset as number }
      }
      throw cursorStateError(path, 'invalid status or offset')
    },

    async write(state: TelegramBotCursorState): Promise<void> {
      await mkdir(dirname(path), { recursive: true })
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, path)
    },
  }
}

function cursorStateError(path: string, detail: string): Error {
  return new Error(
    `Telegram bot cursor state at ${path} is corrupt or unsupported (${detail}). ` +
      'Inspect and repair the file before restarting; moving it aside creates a first boot that drops pending updates.',
  )
}

async function delayWithAbort(delayMs: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, delayMs)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

async function settleWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  // Retaining both outcomes sinks a late SDK settlement after the abort race wins.
  const retained = promise.then(
    (value) => ({ kind: 'fulfilled' as const, value }),
    (error: unknown) => ({ kind: 'rejected' as const, error }),
  )
  const aborted = new Promise<{ kind: 'aborted' }>((resolve) => {
    if (signal.aborted) {
      resolve({ kind: 'aborted' })
      return
    }
    signal.addEventListener('abort', () => resolve({ kind: 'aborted' }), { once: true })
  })
  const result = await Promise.race([retained, aborted])
  if (result.kind === 'fulfilled') return result.value
  if (result.kind === 'rejected') throw result.error
  throw new DOMException('Aborted', 'AbortError')
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function isEnoent(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
