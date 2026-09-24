import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Markdown, type Terminal, Text } from '@earendil-works/pi-tui'

import type { SessionSummary } from './session-list'
import { BoundedComponentWindow, createTranscriptView, componentFor, type HistoryEntry } from './transcript-view'
import type { InspectEvent } from './types'
import { parseFilter } from './types'

function eventEntry(cat: InspectEvent['cat'], stamped: boolean, ts = 1): HistoryEntry {
  const time = new Text(stamped ? '12:00:00' : '', 0, 0)
  return { kind: 'event', cat, ts, time, stamped, components: [time, new Text(`${cat} body`, 0, 0)] }
}

class FakeTerminal implements Terminal {
  rows = 30
  columns = 80
  kittyProtocolActive = false
  stopped = false
  readonly writes: string[] = []
  private inputHandler: ((data: string) => void) | null = null

  start(onInput: (data: string) => void, _onResize: () => void): void {
    this.inputHandler = onInput
  }
  stop(): void {
    this.stopped = true
  }
  async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}
  write(data: string): void {
    this.writes.push(data)
  }
  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}
  feed(data: string): void {
    this.inputHandler?.(data)
  }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

// Polls accumulated terminal writes until the replay render has flushed the
// expected content. Replaces a fixed `flush()` for the content-asserting tests:
// a 10ms sleep raced the async pi-tui render under parallel CI load, feeding esc
// before the frame painted so the asserted text/timestamp was absent.
async function waitForFrame(
  terminal: FakeTerminal,
  predicate: (frame: string) => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate(terminal.writes.join(''))) return
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('componentFor', () => {
  test('assistant text becomes a Markdown block', () => {
    const ev: InspectEvent = { cat: 'assistant', ts: 1, text: '# hi\n\nbody' }
    expect(componentFor(ev)).toBeInstanceOf(Markdown)
  })

  test('user / tool / meta / done become Text components', () => {
    const cases: InspectEvent[] = [
      { cat: 'user', ts: 1, text: 'hello' },
      { cat: 'tool', ts: 1, phase: 'start', toolCallId: 'c1', name: 'read', args: { path: 'x' } },
      {
        cat: 'tool',
        ts: 1,
        phase: 'end',
        toolCallId: 'c1',
        name: 'read',
        result: 'ok',
        isError: false,
        durationMs: 12,
      },
      { cat: 'meta', ts: 1, origin: { kind: 'tui' } },
      { cat: 'done', ts: 1, input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: 0.01 },
      { cat: 'error', ts: 1, message: 'boom' },
    ]
    for (const ev of cases) expect(componentFor(ev)).toBeInstanceOf(Text)
  })
})

describe('BoundedComponentWindow', () => {
  test('keeps every entry until the cap is reached', () => {
    const window = new BoundedComponentWindow<HistoryEntry>(3)
    expect(window.push(eventEntry('user', true))).toBeNull()
    expect(window.push(eventEntry('thinking', true))).toBeNull()
    expect(window.push(eventEntry('tool', true))).toBeNull()
    expect(window.size).toBe(3)
  })

  test('evicts the oldest entry once the cap is exceeded', () => {
    const window = new BoundedComponentWindow<HistoryEntry>(2)
    const first = eventEntry('user', true)
    const second = eventEntry('thinking', true)
    const third = eventEntry('tool', true)

    expect(window.push(first)).toBeNull()
    expect(window.push(second)).toBeNull()
    expect(window.push(third)).toBe(first)
    expect(window.size).toBe(2)
  })

  test('evicts the whole entry so a timestamp never outlives its body', () => {
    const window = new BoundedComponentWindow<HistoryEntry>(1)
    const firstEntry = eventEntry('assistant', true)
    const secondEntry = eventEntry('user', true)

    expect(window.push(firstEntry)).toBeNull()
    const evicted = window.push(secondEntry)
    expect(evicted).toBe(firstEntry)
    expect(window.size).toBe(1)
  })

  test('first() returns the oldest still-visible entry', () => {
    const window = new BoundedComponentWindow<HistoryEntry>(2)
    expect(window.first()).toBeUndefined()
    const a = eventEntry('user', true)
    const b = eventEntry('thinking', true)
    const c = eventEntry('tool', true)
    window.push(a)
    window.push(b)
    expect(window.first()).toBe(a)
    window.push(c)
    expect(window.first()).toBe(b)
  })
})

describe('createTranscriptView run()', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'typeclaw-transcript-view-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const FILTER = parseFilter(undefined)
  if (!FILTER.ok) throw new Error('default filter')

  async function seed(): Promise<SessionSummary> {
    const file = join(dir, 's.jsonl')
    const lines = [
      JSON.stringify({
        type: 'custom',
        customType: 'typeclaw.session-meta',
        data: { origin: { kind: 'tui' } },
        timestamp: 1,
      }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'hi', timestamp: 2 } }),
    ]
    await writeFile(file, lines.join('\n') + '\n')
    return {
      sessionId: 's',
      sessionFile: file,
      basename: 's.jsonl',
      mtimeMs: 1,
      origin: { kind: 'tui' },
      firstPrompt: null,
    }
  }

  test('esc returns back; the terminal is stopped', async () => {
    const summary = await seed()
    const terminal = new FakeTerminal()
    const view = createTranscriptView({
      summary,
      filter: FILTER.filter,
      sinceMs: undefined,
      createTerminal: () => terminal,
    })

    const runPromise = view.run()
    await flush()
    terminal.feed('\x1b')

    await expect(runPromise).resolves.toEqual({ reason: 'back' })
    expect(terminal.stopped).toBe(true)
  })

  test('q exits', async () => {
    const summary = await seed()
    const terminal = new FakeTerminal()
    const view = createTranscriptView({
      summary,
      filter: FILTER.filter,
      sinceMs: undefined,
      createTerminal: () => terminal,
    })

    const runPromise = view.run()
    await flush()
    terminal.feed('q')

    await expect(runPromise).resolves.toEqual({ reason: 'exit' })
  })

  test('ctrl-c exits', async () => {
    const summary = await seed()
    const terminal = new FakeTerminal()
    const view = createTranscriptView({
      summary,
      filter: FILTER.filter,
      sinceMs: undefined,
      createTerminal: () => terminal,
    })

    const runPromise = view.run()
    await flush()
    terminal.feed('\x03')

    await expect(runPromise).resolves.toEqual({ reason: 'exit' })
  })

  test('a run of same-category events renders the timestamp on the first block only, not the second', async () => {
    // given: an assistant turn with two consecutive thinking blocks (one shared ts)
    const ts = Date.parse('2026-06-10T08:00:00.000Z')
    const file = join(dir, 'group.jsonl')
    await writeFile(
      file,
      JSON.stringify({
        type: 'message',
        timestamp: new Date(ts).toISOString(),
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'first thought' },
            { type: 'thinking', thinking: 'second thought' },
          ],
          timestamp: ts,
        },
      }) + '\n',
    )
    const groupSummary: SessionSummary = {
      sessionId: 'g',
      sessionFile: file,
      basename: 'group.jsonl',
      mtimeMs: 1,
      origin: { kind: 'tui' },
      firstPrompt: null,
    }
    const terminal = new FakeTerminal()
    const view = createTranscriptView({
      summary: groupSummary,
      filter: FILTER.filter,
      sinceMs: undefined,
      createTerminal: () => terminal,
    })

    // when: the viewer replays and we dismiss it
    const runPromise = view.run()
    await waitForFrame(terminal, (frame) => frame.includes('first thought') && frame.includes('second thought'))
    terminal.feed('\x1b')
    await runPromise

    // then: the final frame shows both thoughts but the HH:MM:SS stamp exactly once
    const p = (n: number): string => String(n).padStart(2, '0')
    const d = new Date(ts)
    const stamp = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    const frame = terminal.writes.join('')
    expect(frame).toContain('first thought')
    expect(frame).toContain('second thought')
    expect(frame.split(stamp).length - 1).toBe(1)
  })

  test('evicting the stamped head of a same-category run re-stamps the new first visible row', async () => {
    // given: a session with no replay events, then a live run of same-category
    // thinking events long enough to evict the originally-stamped head
    const file = join(dir, 'evict.jsonl')
    await writeFile(
      file,
      JSON.stringify({
        type: 'custom',
        customType: 'typeclaw.session-meta',
        data: { origin: { kind: 'tui' } },
        timestamp: 1,
      }) + '\n',
    )
    const summary: SessionSummary = {
      sessionId: 'e',
      sessionFile: file,
      basename: 'evict.jsonl',
      mtimeMs: 1,
      origin: { kind: 'tui' },
      firstPrompt: null,
    }

    const base = Date.parse('2026-06-10T09:00:00.000Z')
    const count = 5
    async function* live(o: { onSubscribed?: (live: boolean) => void }): AsyncGenerator<InspectEvent> {
      o.onSubscribed?.(true)
      for (let i = 0; i < count; i++) {
        yield { cat: 'thinking', ts: base + i * 1000, text: `thought ${i}` }
      }
    }

    const terminal = new FakeTerminal()
    const view = createTranscriptView({
      summary,
      filter: FILTER.filter,
      sinceMs: undefined,
      createTerminal: () => terminal,
      liveSource: (o) => live(o),
      maxHistoryEntries: 2,
    })

    // when: the viewer tails the live run (which overflows the 2-entry window)
    const runPromise = view.run()
    await waitForFrame(terminal, (frame) => frame.includes(`thought ${count - 1}`))
    terminal.feed('\x1b')
    await runPromise

    // then: the final frame still carries a timestamp for the run even though the
    // first thinking event (and its stamp) was evicted — the new first visible
    // row was promoted. The meta divider's '--:--:--' must not be the only stamp.
    const p = (n: number): string => String(n).padStart(2, '0')
    const hhmmss = (ms: number): string => {
      const d = new Date(ms)
      return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    }
    const frame = terminal.writes.join('')
    const survivor = base + (count - 2) * 1000
    expect(frame).toContain(`thought ${count - 1}`)
    expect(frame).toContain(hhmmss(survivor))
  })
})
