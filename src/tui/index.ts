import {
  Editor,
  Key,
  Loader,
  Markdown,
  matchesKey,
  ProcessTerminal,
  type Terminal,
  Text,
  TuiMainScreen,
} from '@earendil-works/pi-tui'

import { parseCommand } from '@/commands'

import { formatBanner } from './banner'
import { createClient as createClientDefault, type Client } from './client'
import {
  formatQueuePanel,
  formatToolEnd,
  formatToolStart,
  formatUsageSummary,
  formatUserPromptHistory,
  withTimestamp,
} from './format'
import { armTerminalGuard } from './terminal-guard'
import { colors, editorTheme, markdownTheme } from './theme'

export type ClientFactory = (url: string) => Promise<Client>
export type TerminalFactory = () => Terminal

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000

// Bare slash-command names (no leading `/`) the TUI intercepts client-side.
// The hatching ritual tells the agent to point users at `/quit` (see
// src/init/hatching.ts); without an intercept the literal text would be shipped
// to the LLM as a chat message. Grammar (case-insensitive, whitespace-tolerant,
// `//foo` escapes to a literal prompt) comes from `parseCommand` in
// src/commands so channel and TUI slash commands stay consistent. Arguments
// after the name disqualify the match: `/quit me a story` is a real prompt, not
// a command.
const QUIT_COMMAND_NAMES: ReadonlySet<string> = new Set(['quit', 'exit'])
const TUI_COMMAND_NAMES: ReadonlySet<TuiCommandName> = new Set(['quit', 'reload', 'restart'])

type TuiCommandName = 'quit' | 'reload' | 'restart'

function parseBareTuiCommand(text: string): TuiCommandName | null {
  const parsed = parseCommand(text)
  if (parsed === null || parsed.args.length > 0) return null
  if (QUIT_COMMAND_NAMES.has(parsed.name)) return 'quit'
  if (TUI_COMMAND_NAMES.has(parsed.name as TuiCommandName)) return parsed.name as TuiCommandName
  return null
}

export type VersionMismatch = { expected: string; actual: string }

export type TuiOptions = {
  url: string
  initialPrompt?: string
  createClient?: ClientFactory
  createTerminal?: TerminalFactory
  handshakeTimeoutMs?: number
  exit?: (code: number) => void
  // Locally-known typeclaw version the host CLI is running. When provided
  // and the connected frame's serverVersion is defined and differs,
  // onVersionMismatch is invoked AND a yellow warning line is rendered
  // into the TUI history. The container-side local TUI omits this so no
  // mismatch check fires when client and server are guaranteed in lockstep.
  expectedVersion?: string
  onVersionMismatch?: (info: VersionMismatch) => void
}

// Outcome of a single `run()` cycle.
//   - 'detach': idle Esc — return to the session-viewer list. Closing the WS
//     ends the server-side AgentSession (accepted; the list re-shows it as a
//     read-only transcript).
//   - 'exit': deliberate /quit or Ctrl+C — terminate the client.
//   - 'lostConnection': WS closed AFTER the handshake without a deliberate
//     quit/detach — exactly the self-restart case, and the only one where a
//     fresh connect can recover the session.
//   - 'connectFailed': pre-handshake connect/handshake error.
// The CLI reconnect loop spins only on 'lostConnection'.
export type TuiRunResult =
  | { reason: 'detach' }
  | { reason: 'exit'; exitCode: number }
  | { reason: 'lostConnection' }
  | { reason: 'connectFailed' }

export function createTui({
  url,
  initialPrompt,
  createClient = createClientDefault,
  createTerminal = () => new ProcessTerminal(),
  handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
  exit = process.exit.bind(process),
  expectedVersion,
  onVersionMismatch,
}: TuiOptions) {
  async function run(): Promise<TuiRunResult> {
    const terminal = createTerminal()
    // pi-tui 0.87 exports TUI only as an interface; TuiMainScreen is the
    // concrete scrollback renderer (dist/tui.d.ts:213-244, tui-main-screen.d.ts:11-12).
    const tui = new TuiMainScreen(terminal)
    const displayUrl = redactUrl(url)

    const status = new Text(colors.dim(`connecting to ${displayUrl}...`), 0, 0)
    tui.addChild(status)
    tui.start()
    // Armed once the terminal is in raw mode + Kitty kbd protocol: restores the
    // terminal on an abnormal exit (SSH SIGHUP, kill, crash) that never reaches
    // tui.stop(), so the shell isn't left echoing Kitty key-release events.
    const guard = armTerminalGuard()
    tui.requestRender()

    // Pre-handshake failures resolve 'connectFailed' (not throw): the standalone
    // CLI injects exit=process.exit so exit(1) ends the process and the return is
    // moot; the viewer injects a no-op exit so run() resolves cleanly and the
    // caller maps connectFailed into an error result instead of an uncaught reject.
    const maybeClient = await createClient(url).catch((err) => {
      status.setText(colors.red(`connection error: ${err instanceof Error ? err.message : String(err)}`))
      tui.requestRender()
      tui.stop()
      guard.disarm()
      exit(1)
      return null
    })
    if (maybeClient === null) return { reason: 'connectFailed' }
    const client = maybeClient

    const handshake = await waitForConnected(client, displayUrl, handshakeTimeoutMs).catch((err) => {
      status.setText(colors.red(`connection error: ${err instanceof Error ? err.message : String(err)}`))
      tui.requestRender()
      client.close()
      tui.stop()
      guard.disarm()
      exit(1)
      return null
    })
    if (handshake === null) return { reason: 'connectFailed' }

    const { sessionId, serverVersion } = handshake
    // The banner card already carries session id, version, and url, so it
    // supersedes the old one-line session status in place (status is child[0],
    // pinned above all scrollback).
    status.setText(formatBanner({ sessionId, displayUrl, ...(serverVersion !== undefined ? { serverVersion } : {}) }))
    tui.requestRender()

    const editor = new Editor(tui, editorTheme, { paddingX: 0 })
    const statusBar = new Text('', 0, 0)
    let replyInFlight = false
    let onReplyDone: (() => void) | null = null
    let currentAssistant: Markdown | null = null
    let currentAssistantText = ''
    let queuePanel: Text | null = null
    let thinkingLoader: Loader | null = null
    let reloadLoader: Loader | null = null
    let restartLoader: Loader | null = null
    let usageLabel: string | null = null
    let connectionLabel = 'connected'

    const shortSessionId = sessionId.length > 14 ? `${sessionId.slice(0, 14)}…` : sessionId
    const refreshStatusBar = () => {
      const parts = [
        colors.dim(connectionLabel),
        colors.dim(`session ${shortSessionId}`),
        serverVersion !== undefined ? colors.dim(`v${serverVersion}`) : null,
        usageLabel !== null ? colors.accent(usageLabel) : null,
      ].filter((part): part is string => part !== null)
      statusBar.setText(parts.join(colors.dim('  ·  ')))
    }
    refreshStatusBar()

    // Pi-tui's Container.addChild appends to the end of the children array.
    // The bottom tail is pinned as [...history, queuePanel?, editor, statusBar]:
    // the editor stays above the persistent status bar, and the queue panel,
    // when present, sits just above the editor. Any new history entry is
    // inserted by stripping that tail, appending the entry, then re-appending
    // the tail in order so nothing ever renders below the status bar.
    const reattachTail = () => {
      if (queuePanel) tui.addChild(queuePanel)
      tui.addChild(editor)
      tui.addChild(statusBar)
    }
    const detachTail = () => {
      if (queuePanel) tui.removeChild(queuePanel)
      tui.removeChild(editor)
      tui.removeChild(statusBar)
    }

    const appendHistory = (component: Text | Markdown) => {
      detachTail()
      tui.addChild(component)
      reattachTail()
    }

    const updateQueuePanel = (pending: ReadonlyArray<{ id: string; text: string; ts: number }>) => {
      if (pending.length === 0) {
        if (queuePanel) {
          tui.removeChild(queuePanel)
          queuePanel = null
          tui.requestRender()
        }
        return
      }
      const text = formatQueuePanel(pending)
      if (queuePanel) {
        queuePanel.setText(text)
      } else {
        tui.removeChild(editor)
        tui.removeChild(statusBar)
        queuePanel = new Text(text, 0, 0)
        tui.addChild(queuePanel)
        tui.addChild(editor)
        tui.addChild(statusBar)
      }
      tui.requestRender()
    }

    const showThinking = () => {
      if (thinkingLoader !== null) return
      const loader = new Loader(tui, colors.accent, colors.dim, 'thinking…')
      thinkingLoader = loader
      appendHistory(loader)
      loader.start()
      tui.requestRender()
    }
    const hideThinking = () => {
      if (thinkingLoader === null) return
      thinkingLoader.stop()
      tui.removeChild(thinkingLoader)
      thinkingLoader = null
    }
    const stopAllLoaders = () => {
      thinkingLoader?.stop()
      reloadLoader?.stop()
      restartLoader?.stop()
    }

    // Reset between text segments so a new Markdown block is created after
    // any non-text event (tool calls). Otherwise text_delta after a tool call
    // would append to the previous Markdown and visually push the tool lines
    // down on every chunk.
    const sealAssistantBlock = () => {
      currentAssistant = null
      currentAssistantText = ''
    }

    const finishAssistantTurn = () => {
      hideThinking()
      sealAssistantBlock()
      replyInFlight = false
      onReplyDone?.()
      onReplyDone = null
    }

    const ensureAssistantBlock = (): Markdown => {
      if (currentAssistant) return currentAssistant
      const md = new Markdown('', 0, 0, markdownTheme)
      currentAssistant = md
      currentAssistantText = ''
      appendHistory(md)
      return md
    }

    client.onMessage((msg) => {
      switch (msg.type) {
        case 'prompt_started': {
          appendHistory(new Text(withTimestamp(msg.ts, formatUserPromptHistory(msg.text)), 0, 0))
          if (replyInFlight) showThinking()
          tui.requestRender()
          break
        }
        case 'text_delta': {
          hideThinking()
          const block = ensureAssistantBlock()
          currentAssistantText += msg.delta
          block.setText(currentAssistantText)
          tui.requestRender()
          break
        }
        case 'tool_start': {
          hideThinking()
          sealAssistantBlock()
          appendHistory(new Text(withTimestamp(msg.ts, formatToolStart(msg.name, msg.args)), 0, 0))
          tui.requestRender()
          break
        }
        case 'tool_end': {
          sealAssistantBlock()
          appendHistory(
            new Text(withTimestamp(msg.ts, formatToolEnd(msg.name, msg.error, msg.result, msg.durationMs)), 0, 0),
          )
          tui.requestRender()
          break
        }
        case 'done': {
          if (msg.usage !== undefined) {
            usageLabel = formatUsageSummary(msg.usage)
            refreshStatusBar()
          }
          finishAssistantTurn()
          tui.requestRender()
          break
        }
        case 'error': {
          appendHistory(new Text(withTimestamp(msg.ts, colors.red(`error: ${msg.message}`)), 0, 0))
          finishAssistantTurn()
          tui.requestRender()
          break
        }
        case 'queue_state': {
          updateQueuePanel(msg.pending)
          break
        }
        case 'reload_result': {
          if (reloadLoader !== null) {
            reloadLoader.stop()
            tui.removeChild(reloadLoader)
            reloadLoader = null
          }
          for (const result of msg.results) {
            const text = result.ok
              ? `${colors.green('●')} ${colors.bold(`[${result.scope}]`)} ${result.summary}`
              : `${colors.red('●')} ${colors.bold(`[${result.scope}]`)} ${result.reason}`
            appendHistory(new Text(text, 0, 0))
          }
          tui.requestRender()
          break
        }
        case 'restart_result': {
          if (restartLoader !== null) {
            restartLoader.stop()
            tui.removeChild(restartLoader)
            restartLoader = null
          }
          const text =
            msg.status === 'accepted'
              ? colors.green(colors.dim(msg.message ?? 'restart scheduled; reconnecting when the new container is up'))
              : colors.red(`restart failed: ${msg.error ?? 'unknown error'}`)
          appendHistory(new Text(text, 0, 0))
          tui.requestRender()
          break
        }
      }
    })

    let settleOutcome: ((result: TuiRunResult) => void) | null = null
    const outcome = new Promise<TuiRunResult>((resolve) => {
      settleOutcome = resolve
    })
    const settle = (result: TuiRunResult): void => {
      if (settleOutcome === null) return
      const fn = settleOutcome
      settleOutcome = null
      fn(result)
    }

    client.onClose(() => {
      stopAllLoaders()
      connectionLabel = 'disconnected'
      refreshStatusBar()
      appendHistory(new Text(colors.dim('disconnected'), 0, 0))
      tui.requestRender()
      // A user-initiated detach/exit already closed the WS deliberately and
      // settled the outcome; onClose then fires but must not override it.
      settle({ reason: 'lostConnection' })
    })

    function send(text: string): Promise<void> {
      replyInFlight = true
      client.send({ type: 'prompt', text })
      return new Promise<void>((resolve) => {
        onReplyDone = resolve
      })
    }

    function runTuiCommand(command: TuiCommandName): boolean {
      if (command === 'quit') {
        exitWith(0)
        return true
      }
      if (command === 'reload') {
        client.send({ type: 'reload' })
        if (reloadLoader === null) {
          const loader = new Loader(tui, colors.accent, colors.dim, 'reloading…')
          reloadLoader = loader
          appendHistory(loader)
          loader.start()
        }
        tui.requestRender()
        return true
      }
      client.send({ type: 'restart' })
      if (restartLoader === null) {
        const loader = new Loader(
          tui,
          colors.yellow,
          colors.dim,
          'restart requested… reconnecting when the new container is up',
        )
        restartLoader = loader
        appendHistory(loader)
        loader.start()
      }
      tui.requestRender()
      return true
    }

    // Esc means "abort the in-flight reply" while a turn is generating, and
    // "detach back to the session list" when idle. The Editor does not bind
    // Esc, so a top-level listener intercepts it without fighting the editor.
    tui.addInputListener((data) => {
      if (!matchesKey(data, Key.escape)) return undefined
      if (replyInFlight) {
        client.send({ type: 'abort' })
        return { consume: true }
      }
      detach()
      return { consume: true }
    })

    // Settle BEFORE closing the client: client.close() fires onClose, which
    // settles 'lostConnection'. settle() is idempotent, so the first call wins —
    // settling the deliberate outcome first keeps the later onClose a no-op.
    // drainInput() runs before stop() so late Kitty key-release bytes (the keys
    // that triggered the exit) are swallowed instead of leaking to the shell
    // over a slow SSH link. The promise is memoized so repeated callers (a
    // fire-and-forget detach/exit plus the end-of-run await) share ONE teardown
    // and the end-of-run await truly blocks until draining finishes — otherwise
    // the next clack picker could start reading stdin mid-drain.
    let teardownPromise: Promise<void> | null = null
    const teardown = (): Promise<void> => {
      teardownPromise ??= (async () => {
        stopAllLoaders()
        await terminal.drainInput().catch(() => {})
        tui.stop()
        client.close()
        guard.disarm()
      })()
      return teardownPromise
    }

    const exitWith = (code: number): void => {
      settle({ reason: 'exit', exitCode: code })
      void teardown().finally(() => exit(code))
    }

    const detach = (): void => {
      settle({ reason: 'detach' })
      void teardown()
    }

    // Ctrl+C exits the client. In raw mode the kernel does NOT generate SIGINT,
    // so we intercept the \x03 byte ourselves; the Editor would otherwise
    // swallow it. teardown() restores raw-mode/cursor/echo before we settle.
    tui.addInputListener((data) => {
      if (matchesKey(data, Key.ctrl('c'))) {
        exitWith(0)
        return { consume: true }
      }
      return undefined
    })

    editor.onSubmit = (text) => {
      if (text.trim().length === 0) return
      const command = parseBareTuiCommand(text)
      if (command !== null) {
        if (command !== 'quit') {
          editor.setText('')
          editor.addToHistory(text)
        }
        runTuiCommand(command)
        return
      }
      editor.setText('')
      editor.addToHistory(text)
      tui.requestRender()
      void send(text)
    }
    tui.addChild(editor)
    tui.addChild(statusBar)
    tui.setFocus(editor)
    tui.requestRender()

    if (expectedVersion !== undefined && serverVersion !== undefined && serverVersion !== expectedVersion) {
      const mismatch: VersionMismatch = { expected: expectedVersion, actual: serverVersion }
      const warning = formatVersionMismatchWarning(mismatch)
      appendHistory(new Text(colors.yellow(warning), 0, 0))
      tui.requestRender()
      onVersionMismatch?.(mismatch)
    }

    if (initialPrompt) {
      // initialPrompt bypasses editor.onSubmit, so the quit intercept above
      // would never run. Guard the same way so `typeclaw tui /quit` exits —
      // and `/reload` / `/restart` stay websocket control frames — instead of
      // leaking the command into the agent's chat context.
      const command = parseBareTuiCommand(initialPrompt)
      if (command !== null) {
        runTuiCommand(command)
        if (command === 'quit') return { reason: 'exit', exitCode: 0 }
      } else {
        await send(initialPrompt)
      }
    }

    const result = await outcome
    await teardown()
    return result
  }

  return { run }
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.searchParams.has('token')) parsed.searchParams.set('token', '<redacted>')
    return parsed.toString()
  } catch {
    return url
  }
}

async function waitForConnected(
  client: Client,
  url: string,
  timeoutMs: number,
): Promise<{ sessionId: string; serverVersion?: string }> {
  return await new Promise<{ sessionId: string; serverVersion?: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out waiting for connected message from ${url} after ${timeoutMs}ms`))
    }, timeoutMs)
    const cleanupFns: Array<() => void> = []
    const cleanup = () => {
      clearTimeout(timer)
      for (const fn of cleanupFns.splice(0)) fn()
    }
    cleanupFns.push(
      client.onMessage((msg) => {
        if (msg.type === 'connected') {
          cleanup()
          resolve({
            sessionId: msg.sessionId,
            ...(msg.serverVersion !== undefined ? { serverVersion: msg.serverVersion } : {}),
          })
        }
        if (msg.type === 'error') {
          cleanup()
          reject(new Error(msg.message))
        }
      }),
    )
    cleanupFns.push(
      client.onClose(() => {
        cleanup()
        reject(new Error(`connection to ${url} closed before the session was ready`))
      }),
    )
    cleanupFns.push(
      client.onError((err) => {
        cleanup()
        reject(err instanceof Error ? err : new Error(`connection to ${url} failed`))
      }),
    )
  })
}

export function formatVersionMismatchWarning({ expected, actual }: VersionMismatch): string {
  return `WARN: host CLI is v${expected}, agent container is v${actual}. Some commands may hang or fail. Try \`typeclaw restart --build\`.`
}
