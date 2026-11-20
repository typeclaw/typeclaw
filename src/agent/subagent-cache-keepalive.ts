import type { StreamFn } from '@earendil-works/pi-agent-core'

import type { LiveSubagentRegistry } from './live-subagents'

const TTL_MS = 5 * 60_000
const INTERVAL_MS = TTL_MS * 0.9
export const MAX_SUBAGENT_CACHE_PINGS = 6

type Request = {
  readonly model: Parameters<StreamFn>[0]
  readonly context: Parameters<StreamFn>[1]
  readonly options: NonNullable<Parameters<StreamFn>[2]>
  readonly payload: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Inspect the actual cache markers, including hook overrides and env-derived
// retention. Never turn a no-cache or one-hour request into a five-minute one.
function hasShortCache(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasShortCache)
  if (!isRecord(value)) return false
  if (isRecord(value.cache_control) && value.cache_control.type === 'ephemeral') {
    return value.cache_control.ttl === undefined || value.cache_control.ttl === '5m'
  }
  return Object.values(value).some(hasShortCache)
}

export class SubagentCacheKeepalive {
  private request: Request | undefined
  private refreshedAt = 0
  private idle = false
  private closed = false
  private pings = 0
  private cancelTimer: (() => void) | undefined
  private controller: AbortController | undefined
  private readonly unsubscribe: () => void

  constructor(
    private readonly sessionId: string,
    private readonly registry: LiveSubagentRegistry,
    private readonly stream: StreamFn,
    private readonly clock = {
      now: () => Date.now(),
      schedule: (callback: () => void, delay: number): (() => void) => {
        const timer = setTimeout(callback, delay)
        timer.unref()
        return () => clearTimeout(timer)
      },
    },
    private readonly log: (line: string) => void = console.debug,
  ) {
    this.unsubscribe = registry.subscribe((parent) => {
      if (parent === sessionId) this.reconcile()
    })
  }

  capture(model: Request['model'], context: Request['context'], options: Request['options'], payload: unknown): void {
    this.request = undefined
    if (
      this.closed ||
      model.api !== 'anthropic-messages' ||
      options.cacheRetention === 'none' ||
      !isRecord(payload) ||
      !hasShortCache(payload)
    ) {
      return
    }
    // Snapshot after all payload hooks and prompt-cache-key handling. Rebuilding
    // from session state can reorder tools or include new messages/system text.
    this.request = {
      model: structuredClone(model),
      context: structuredClone(context),
      options: { ...options },
      payload: structuredClone(payload),
    }
    this.refreshedAt = this.clock.now()
  }

  invalidate(): void {
    this.request = undefined
    this.stop()
  }

  startTurn(): void {
    this.idle = false
    this.pings = 0
    this.stop()
  }

  settle(): void {
    if (this.closed) return
    this.idle = true
    this.reconcile()
  }

  close(): void {
    this.closed = true
    this.request = undefined
    this.stop()
    this.unsubscribe()
  }

  private running(): boolean {
    return this.registry
      .list({ parentSessionId: this.sessionId })
      .some((child) => child.background === true && child.status === 'running')
  }

  private stop(): void {
    this.cancelTimer?.()
    this.cancelTimer = undefined
    this.controller?.abort()
    this.controller = undefined
  }

  private reconcile(): void {
    if (this.closed || !this.idle || !this.running()) {
      this.stop()
      return
    }
    if (!this.request || this.pings >= MAX_SUBAGENT_CACHE_PINGS || this.cancelTimer || this.controller) return
    // A late callback or a long real turn must not buy a cold cache write.
    const age = this.clock.now() - this.refreshedAt
    if (age > INTERVAL_MS + (TTL_MS - INTERVAL_MS) / 2) return
    this.cancelTimer = this.clock.schedule(
      () => {
        this.cancelTimer = undefined
        void this.ping()
      },
      Math.max(0, INTERVAL_MS - age),
    )
  }

  private async ping(): Promise<void> {
    const request = this.request
    if (
      !request ||
      !this.idle ||
      this.closed ||
      !this.running() ||
      this.clock.now() - this.refreshedAt > INTERVAL_MS + (TTL_MS - INTERVAL_MS) / 2
    ) {
      return
    }
    const controller = new AbortController()
    this.controller = controller
    this.pings += 1
    const startedAt = this.clock.now()
    // Legacy thinking requires max_tokens > budget_tokens. Preserve that budget:
    // changing thinking settings invalidates the very cache we want to refresh.
    const thinking = request.payload.thinking
    const maxTokens =
      isRecord(thinking) && thinking.type === 'enabled' && typeof thinking.budget_tokens === 'number'
        ? thinking.budget_tokens + 1
        : 1
    let prefilled = false
    this.log(`[agent] subagent cache keepalive ${this.pings}/${MAX_SUBAGENT_CACHE_PINGS}`)
    try {
      const events = await this.stream(request.model, request.context, {
        ...request.options,
        // Pi adds `thread` after onPayload; a rejected ping could turn off the
        // real session's continuation before the response stream even starts.
        disableContinuation: true,
        signal: controller.signal,
        maxTokens,
        maxRetries: 0,
        timeoutMs: 15_000,
        onPayload: () => ({ ...structuredClone(request.payload), max_tokens: maxTokens }),
        onResponse: undefined,
        // message_start follows prefill, unlike the SDK's synthetic start event.
        // Stop here even for legacy thinking, without generating its full budget.
        onProviderStreamEvent: (event) => {
          if (isRecord(event) && event.type === 'message_start') {
            prefilled = true
            controller.abort()
          }
        },
      })
      const result = await events.result()
      if (result.stopReason === 'error') {
        this.log(`[agent] subagent cache keepalive failed: ${result.errorMessage ?? 'provider error'}`)
      }
    } catch (error) {
      this.log(`[agent] subagent cache keepalive failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      // A new turn/completion/close may already have cancelled this ping.
      if (this.controller === controller) {
        this.controller = undefined
        if (prefilled) {
          this.refreshedAt = startedAt
          this.reconcile()
        } else if (this.request === request) {
          this.request = undefined
        }
      }
    }
  }
}
