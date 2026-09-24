import {
  Key,
  Markdown,
  matchesKey,
  ProcessTerminal,
  type Component,
  type Terminal,
  Text,
  TuiMainScreen,
} from '@earendil-works/pi-tui'

import { formatToolEnd, formatToolStart, formatUserPromptHistory } from '@/tui/format'
import { armTerminalGuard } from '@/tui/terminal-guard'
import { colors, markdownTheme } from '@/tui/theme'

import { streamSessionEvents, type LiveSourceFactory, type StreamPhase } from './index'
import { originLabel, shortSessionId } from './label'
import { TimeGate } from './render'
import type { SessionSummary } from './session-list'
import type { InspectEvent, InspectFilter } from './types'

export type TranscriptViewOutcome = { reason: 'back' | 'exit' }

export type TranscriptViewOptions = {
  summary: SessionSummary
  filter: InspectFilter
  sinceMs: number | undefined
  liveSource?: LiveSourceFactory
  createTerminal?: () => Terminal
  maxHistoryEntries?: number
}

export const MAX_LIVE_HISTORY_ENTRIES = 250

// Read-only pi-tui transcript viewer: the rich counterpart to the line
// renderer, matching the live TUI's look (markdown assistant blocks, formatted
// tool panels) but with NO editor and NO websocket writes. It owns its own
// raw-mode terminal, so the caller must NOT wrap it in a tail scope (a second
// raw-stdin owner would corrupt input — same rule as the writable tui branch).
// esc -> back to the list; q / ctrl-c -> exit.
export function createTranscriptView(opts: TranscriptViewOptions) {
  async function run(): Promise<TranscriptViewOutcome> {
    const terminal = (opts.createTerminal ?? (() => new ProcessTerminal()))()
    // pi-tui 0.87 exports TUI only as an interface; use its concrete
    // main-screen renderer to preserve this viewer's scrollback behavior
    // (dist/tui.d.ts:213-244, tui-main-screen.d.ts:11-12).
    const tui = new TuiMainScreen(terminal)

    const status = new Text(statusLine('replay'), 0, 0)
    tui.addChild(new Text(header(opts.summary), 0, 0))
    tui.addChild(status)
    tui.start()
    // Restores the terminal on an abnormal exit (SSH SIGHUP, kill, crash) that
    // never reaches tui.stop(), so the shell isn't left in Kitty kbd mode.
    const guard = armTerminalGuard()
    tui.requestRender()

    // The status line is pinned last (no editor to pin, unlike createTui). Each
    // event's components are inserted before it: strip status, add them, re-add
    // status. pi-tui re-renders (and re-lays out every Markdown block in) the
    // whole child list each frame, so an unbounded live tail makes per-frame cost
    // grow until the viewer stalls; the window evicts the oldest entry to keep
    // render cost bounded. Components are evicted per event so a timestamp never
    // outlives its body. Header and pinned status are never evicted.
    const history = new BoundedComponentWindow<HistoryEntry>(opts.maxHistoryEntries ?? MAX_LIVE_HISTORY_ENTRIES)
    const appendEntry = (entry: HistoryEntry): void => {
      tui.removeChild(status)
      const evicted = history.push(entry)
      if (evicted !== null) {
        for (const component of evicted.components) tui.removeChild(component)
        promoteVisibleRunHead(history, evicted)
      }
      for (const component of entry.components) tui.addChild(component)
      tui.addChild(status)
    }

    let settle: ((o: TranscriptViewOutcome) => void) | null = null
    const outcome = new Promise<TranscriptViewOutcome>((resolve) => {
      settle = resolve
    })
    // drainInput() before stop() swallows late Kitty key-release bytes so they
    // don't leak to the shell over a slow SSH link; disarm() drops the abnormal-
    // exit guard now that a clean teardown ran.
    const finish = (reason: TranscriptViewOutcome['reason']): void => {
      if (settle === null) return
      const fn = settle
      settle = null
      void terminal
        .drainInput()
        .catch(() => {})
        .then(() => {
          tui.stop()
          guard.disarm()
          fn({ reason })
        })
    }

    tui.addInputListener((data) => {
      if (matchesKey(data, Key.ctrl('c')) || data === 'q') {
        finish('exit')
        return { consume: true }
      }
      if (matchesKey(data, Key.escape)) {
        finish('back')
        return { consume: true }
      }
      return undefined
    })

    const abort = new AbortController()
    // Drive the shared read pipeline into the component tree. Batch renders
    // during replay (one render at replay-end) to avoid redraw storms on long
    // transcripts; render per event once live.
    let live = false
    const timeGate = new TimeGate()
    const onEvent = (event: InspectEvent): void => {
      const body = componentFor(event)
      const stamped = timeGate.shouldShow(event.cat)
      const time = new Text(stamped ? formatEventTime(event.ts) : '', 0, 0)
      appendEntry({ kind: 'event', cat: event.cat, ts: event.ts, time, stamped, components: [time, body] })
      if (live) tui.requestRender()
    }
    const onPhase = (phase: StreamPhase): void => {
      if (phase.phase === 'replay-end') {
        tui.requestRender()
      } else if (phase.phase === 'live-start') {
        timeGate.reset()
        appendEntry({
          kind: 'divider',
          components: [new Text(divider(phase.sessionLive ? 'live' : 'live (broadcasts only)'), 0, 0)],
        })
        live = true
        tui.requestRender()
      }
    }

    const pump = streamSessionEvents({
      summary: opts.summary,
      filter: opts.filter,
      sinceMs: opts.sinceMs,
      onEvent,
      onPhase,
      signal: abort.signal,
      ...(opts.liveSource !== undefined ? { liveSource: opts.liveSource } : {}),
      blockWhenReplayOnly: true,
    })

    const result = await outcome
    // The viewer was dismissed: stop the pipeline (replay-only idle wait, or a
    // live tail) so it does not run past the closed terminal.
    abort.abort()
    await pump.catch(() => {})
    return result
  }

  return { run }
}

export function componentFor(event: InspectEvent): Component {
  switch (event.cat) {
    case 'assistant':
      return new Markdown(event.text, 0, 0, markdownTheme)
    case 'user':
      return new Text(formatUserPromptHistory(event.text), 0, 0)
    case 'tool':
      return new Text(
        event.phase === 'start'
          ? formatToolStart(event.name, event.args)
          : formatToolEnd(event.name, event.isError === true, event.result, event.durationMs ?? 0),
        0,
        0,
      )
    case 'thinking':
      return new Text(colors.gray(event.redacted === true ? '[redacted thinking]' : event.text), 0, 0)
    case 'meta':
      return new Text(colors.dim(`origin: ${originLabel(event.origin)}`), 0, 0)
    case 'error':
      return new Text(
        event.stopReason === 'aborted' ? colors.yellow(event.message) : colors.red(`error: ${event.message}`),
        0,
        0,
      )
    case 'done':
      return new Text(colors.dim(doneSummary(event)), 0, 0)
    case 'broadcast':
      return new Text(colors.dim(`broadcast: ${compact(event.payload)}`), 0, 0)
    case 'cron-fire':
      return new Text(colors.dim(`cron ${event.jobId} fired`), 0, 0)
    case 'inbound':
      return new Text(colors.cyan(`[${event.decision}] ${event.authorName}: ${event.text}`), 0, 0)
  }
}

function doneSummary(event: Extract<InspectEvent, { cat: 'done' }>): string {
  const parts = [`${event.input} in / ${event.output} out tok`, `$${event.cost.toFixed(4)}`]
  if (event.stopReason !== undefined) parts.push(`stop=${event.stopReason}`)
  return parts.join(' · ')
}

function compact(payload: unknown): string {
  if (payload !== null && typeof payload === 'object' && 'kind' in payload) {
    return String((payload as { kind: unknown }).kind)
  }
  const s = JSON.stringify(payload) ?? String(payload)
  return s.length > 200 ? `${s.slice(0, 200)}…` : s
}

function formatEventTime(ts: number): string {
  if (ts === 0) return colors.dim('--:--:--')
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return colors.dim(`${hh}:${mm}:${ss}`)
}

function header(summary: SessionSummary): string {
  const id = shortSessionId(summary.sessionId)
  const label = summary.origin === null ? '(unknown origin)' : originLabel(summary.origin)
  return colors.dim(`─── ${id} · ${label} ───`)
}

function statusLine(_phase: 'replay'): string {
  return colors.dim('── read-only · esc to return to list · q to quit ──')
}

function divider(text: string): string {
  return colors.dim(`─── ${text} ───`)
}

// After the stamped head of a same-category run is evicted, the new first
// visible row of that run would have a blank timestamp. Fill its already-present
// (blank) Text so the visible window never shows a run with no timestamp at all.
// Mutates text in place — no child add/remove/reorder.
function promoteVisibleRunHead(history: BoundedComponentWindow<HistoryEntry>, evicted: HistoryEntry): void {
  if (evicted.kind !== 'event' || !evicted.stamped) return
  const first = history.first()
  if (first === undefined || first.kind !== 'event' || first.stamped || first.cat !== evicted.cat) return
  first.time.setText(formatEventTime(first.ts))
  first.stamped = true
}

// An event row carries its category + ts + the (possibly blank) timestamp Text
// so the window can re-stamp the visible run head after eviction. Non-event rows
// (the live divider) have no category and never participate in re-stamping.
export type HistoryEntry =
  | {
      kind: 'event'
      cat: InspectEvent['cat']
      ts: number
      time: Text
      stamped: boolean
      components: readonly Component[]
    }
  | { kind: 'divider'; components: readonly Component[] }

export class BoundedComponentWindow<T> {
  private readonly entries: T[] = []

  constructor(private readonly maxEntries: number) {}

  push(entry: T): T | null {
    this.entries.push(entry)
    if (this.entries.length <= this.maxEntries) return null
    return this.entries.shift() ?? null
  }

  first(): T | undefined {
    return this.entries[0]
  }

  get size(): number {
    return this.entries.length
  }
}
