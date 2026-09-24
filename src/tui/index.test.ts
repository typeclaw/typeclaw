import { describe, expect, test } from 'bun:test'

import type { Terminal } from '@earendil-works/pi-tui'

import type { ClientMessage, ServerMessage } from '@/shared'

import { type Client } from './client'
import { createTui, formatVersionMismatchWarning, type VersionMismatch } from './index'

// oxlint-disable-next-line no-control-regex -- intentionally strips ESC and BEL from rendered ANSI/APC sequences
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b_[^\x07]*\x07/g, '')

class FakeTerminal implements Terminal {
  written: string[] = []
  rows = 30
  columns = 80
  kittyProtocolActive = false
  inputHandler: ((data: string) => void) | null = null
  resizeHandler: (() => void) | null = null
  stopped = false

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inputHandler = onInput
    this.resizeHandler = onResize
  }

  stop(): void {
    this.stopped = true
  }

  async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}

  write(data: string): void {
    this.written.push(data)
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

  joined(): string {
    return this.written.join('')
  }

  visible(): string {
    return stripAnsi(this.joined())
  }

  // pi-tui repaints the whole viewport on each render and each repaint is one
  // write, so counting frames that contain a substring distinguishes a widget
  // that was removed (appears in a bounded number of frames) from one that
  // lingers (appears in every later repaint too). `visible()` can't see this —
  // it's the flattened byte history where removed widgets still show once.
  frameCount(substring: string): number {
    return this.written.filter((frame) => stripAnsi(frame).includes(substring)).length
  }
}

type FakeClient = Client & {
  emit: (msg: ServerMessage) => void
  triggerClose: () => void
  sent: ClientMessage[]
}

type FakeClientOptions = {
  autoDoneOnPrompt?: boolean
  autoDoneOnAbort?: boolean
  autoPromptStarted?: boolean
}

let fakePromptStartedCounter = 0

function fakeClient(options: FakeClientOptions = {}): FakeClient {
  const autoDoneOnPrompt = options.autoDoneOnPrompt ?? true
  const autoDoneOnAbort = options.autoDoneOnAbort ?? false
  const autoPromptStarted = options.autoPromptStarted ?? true
  const listeners = new Set<(msg: ServerMessage) => void>()
  const closeListeners = new Set<() => void>()
  const pending: ServerMessage[] = []
  const sent: ClientMessage[] = []
  const broadcast = (msg: ServerMessage) => {
    if (listeners.size === 0) {
      pending.push(msg)
      return
    }
    for (const fn of listeners) fn(msg)
  }
  return {
    onMessage: (fn) => {
      listeners.add(fn)
      if (pending.length > 0) {
        const buffered = pending.splice(0)
        for (const msg of buffered) fn(msg)
      }
      return () => listeners.delete(fn)
    },
    onClose: (fn) => {
      closeListeners.add(fn)
      return () => closeListeners.delete(fn)
    },
    onError: () => () => false,
    send: (msg) => {
      sent.push(msg)
      if (msg.type === 'prompt' && autoPromptStarted) {
        const messageId = `fake-${++fakePromptStartedCounter}`
        queueMicrotask(() => broadcast({ type: 'prompt_started', messageId, text: msg.text }))
      }
      if (msg.type === 'prompt' && autoDoneOnPrompt) queueMicrotask(() => broadcast({ type: 'done' }))
      if (msg.type === 'abort' && autoDoneOnAbort) queueMicrotask(() => broadcast({ type: 'done' }))
    },
    close: () => {
      for (const fn of closeListeners) fn()
    },
    emit: broadcast,
    triggerClose: () => {
      for (const fn of closeListeners) fn()
    },
    sent,
  }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 30))

// pi-tui defers renders through process.nextTick → a throttled setTimeout, so a
// fixed flush() races the pipeline on slow CI (Windows). Poll until the text
// appears; reject on timeout so a genuinely-missing render still fails.
const waitForVisible = (terminal: FakeTerminal, substring: string, timeoutMs = 2_000) =>
  new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const check = () => {
      if (terminal.visible().includes(substring)) return resolve()
      if (Date.now() > deadline) {
        return reject(
          new Error(`timed out after ${timeoutMs}ms waiting for ${JSON.stringify(substring)} in terminal output`),
        )
      }
      setTimeout(check, 1)
    }
    check()
  })

describe('createTui', () => {
  test('exits when the server closes before sending connected', async () => {
    // given
    const terminal = new FakeTerminal()
    const client = fakeClient()
    let exitCode: number | undefined

    const tui = createTui({
      url: 'ws://ignored',
      createClient: async () => client,
      createTerminal: () => terminal,
      handshakeTimeoutMs: 2_000,
      exit: (code) => {
        exitCode = code
      },
    })
    const runPromise = tui.run()
    await flush()

    // when
    client.triggerClose()

    // then
    await expect(runPromise).resolves.toEqual({ reason: 'connectFailed' })
    expect(exitCode).toBe(1)
  })

  test('reports connectFailed when the server never sends connected', async () => {
    // given
    const terminal = new FakeTerminal()
    const client = fakeClient()
    let exitCode: number | undefined

    const tui = createTui({
      url: 'ws://ignored',
      createClient: async () => client,
      createTerminal: () => terminal,
      handshakeTimeoutMs: 20,
      exit: (code) => {
        exitCode = code
      },
    })

    // when / then
    await expect(tui.run()).resolves.toEqual({ reason: 'connectFailed' })
    expect(exitCode).toBe(1)
  })

  test('renders the initial prompt as a user history line and sends it to the server', async () => {
    // given
    const terminal = new FakeTerminal()
    const client = fakeClient()
    client.emit({ type: 'connected', sessionId: 'sid-1' })

    // when
    const tui = createTui({
      url: 'ws://ignored',
      initialPrompt: '<hatching>secret</hatching>\n\nHello!',
      createClient: async () => client,
      createTerminal: () => terminal,
    })
    const runPromise = tui.run()
    await flush()
    client.triggerClose()
    await runPromise

    // then
    expect(client.sent).toEqual([{ type: 'prompt', text: '<hatching>secret</hatching>\n\nHello!' }])
    expect(terminal.visible()).toContain('> Hello!')
    expect(terminal.visible()).not.toContain('secret')
  })

  test('renders the startup banner with the session id on connect', async () => {
    // given
    const terminal = new FakeTerminal()
    const client = fakeClient()
    client.emit({ type: 'connected', sessionId: 'sid-banner', serverVersion: '1.2.3' })

    // when
    const tui = createTui({ url: 'ws://ignored', createClient: async () => client, createTerminal: () => terminal })
    const runPromise = tui.run()
    await flush()

    // then
    const visible = terminal.visible()
    expect(visible).toContain('session')
    expect(visible).toContain('sid-banner')
    expect(visible).toContain('v1.2.3')

    client.triggerClose()
    await runPromise
  })

  test('updates the bottom status bar with token usage when a turn completes', async () => {
    // given
    const terminal = new FakeTerminal()
    const client = fakeClient({ autoDoneOnPrompt: false })
    client.emit({ type: 'connected', sessionId: 'sid-usage' })
    const tui = createTui({
      url: 'ws://ignored',
      initialPrompt: 'go',
      createClient: async () => client,
      createTerminal: () => terminal,
    })
    const runPromise = tui.run()
    await flush()

    // when
    client.emit({ type: 'done', usage: { input: 1000, output: 11300, totalTokens: 12300, cost: 0.0042 } })
    await flush()

    // then
    const visible = terminal.visible()
    expect(visible).toContain('12.3k tok')
    expect(visible).toContain('$0.0042')

    client.triggerClose()
    await runPromise
  })

  test('streams assistant text into the chat history (user input is not overwritten)', async () => {
    // given: an in-flight stream that we drive chunk by chunk while the user types
    const terminal = new FakeTerminal()
    const client = fakeClient({ autoDoneOnPrompt: false })
    client.emit({ type: 'connected', sessionId: 'sid-stream' })

    const tui = createTui({
      url: 'ws://ignored',
      initialPrompt: 'go',
      createClient: async () => client,
      createTerminal: () => terminal,
    })
    const runPromise = tui.run()
    await flush()

    // when: stream three chunks interleaved with user keystrokes
    client.emit({ type: 'text_delta', delta: '안녕' })
    await flush()
    terminal.feed('h')
    await flush()
    client.emit({ type: 'text_delta', delta: '하세요' })
    await flush()
    terminal.feed('i')
    await flush()
    client.emit({ type: 'text_delta', delta: '!' })
    await flush()
    client.emit({ type: 'done' })
    await flush()

    // then: the assistant text appears intact in the rendered output
    const visible = terminal.visible()
    expect(visible).toContain('안녕하세요!')

    client.triggerClose()
    await runPromise
  })

  test('sends abort when Esc is pressed during an in-flight reply', async () => {
    // given
    const terminal = new FakeTerminal()
    const client = fakeClient({ autoDoneOnPrompt: false, autoDoneOnAbort: true })
    client.emit({ type: 'connected', sessionId: 'sid-abort' })

    const tui = createTui({
      url: 'ws://ignored',
      initialPrompt: 'go',
      createClient: async () => client,
      createTerminal: () => terminal,
    })
    const runPromise = tui.run()
    await flush()

    // when
    terminal.feed('\x1b')
    await flush()

    // then
    expect(client.sent).toContainEqual({ type: 'abort' })

    client.triggerClose()
    await runPromise
  })

  test('Ctrl+C closes the client, stops the TUI, and exits cleanly', async () => {
    // given: an in-flight reply that would otherwise keep run() awaiting forever,
    // so we can be sure Ctrl+C does its work even mid-turn.
    const terminal = new FakeTerminal()
    const client = fakeClient({ autoDoneOnPrompt: false })
    client.emit({ type: 'connected', sessionId: 'sid-ctrl-c' })
    let exitCode: number | undefined
    let clientClosed = false
    const originalClose = client.close
    client.close = () => {
      clientClosed = true
      originalClose()
    }

    const tui = createTui({
      url: 'ws://ignored',
      initialPrompt: 'go',
      createClient: async () => client,
      createTerminal: () => terminal,
      exit: (code) => {
        exitCode = code
      },
    })
    // Intentionally do NOT await tui.run(): in production Ctrl+C calls
    // process.exit which terminates the process; the in-flight `await send()`
    // never resolving is fine because the process is gone. The test verifies
    // the side effects of the Ctrl+C handler instead.
    void tui.run().catch(() => {})
    await flush()

    // when
    terminal.feed('\x03')
    await flush()

    // then
    expect(exitCode).toBe(0)
    expect(terminal.stopped).toBe(true)
    expect(clientClosed).toBe(true)
  })

  test('/quit exits cleanly without sending the literal text to the agent', async () => {
    // given: an idle session ready to receive a prompt
    const terminal = new FakeTerminal()
    const client = fakeClient()
    client.emit({ type: 'connected', sessionId: 'sid-slash-quit' })
    let exitCode: number | undefined
    let clientClosed = false
    const originalClose = client.close
    client.close = () => {
      clientClosed = true
      originalClose()
    }

    const tui = createTui({
      url: 'ws://ignored',
      createClient: async () => client,
      createTerminal: () => terminal,
      exit: (code) => {
        exitCode = code
      },
    })
    void tui.run().catch(() => {})
    await flush()

    // when: user types `/quit` and submits
    for (const ch of '/quit') terminal.feed(ch)
    terminal.feed('\r')
    await flush()

    // then: the TUI exits like Ctrl+C, and nothing was shipped to the agent
    expect(exitCode).toBe(0)
    expect(terminal.stopped).toBe(true)
    expect(clientClosed).toBe(true)
    expect(client.sent).toEqual([])
  })

  test('/exit is treated as an alias for /quit', async () => {
    // given
    const terminal = new FakeTerminal()
    const client = fakeClient()
    client.emit({ type: 'connected', sessionId: 'sid-slash-exit' })
    let exitCode: number | undefined

    const tui = createTui({
      url: 'ws://ignored',
      createClient: async () => client,
      createTerminal: () => terminal,
      exit: (code) => {
        exitCode = code
      },
    })
    void tui.run().catch(() => {})
    await flush()

    // when
    for (const ch of '/exit') terminal.feed(ch)
    terminal.feed('\r')
    await flush()

    // then
    expect(exitCode).toBe(0)
    expect(client.sent).toEqual([])
  })

  test('text that merely starts with /quit is sent to the agent as a normal prompt', async () => {
    // given: only a bare /quit or /exit (no args) should trigger the quit path;
    // anything else (e.g. `/quit me a story`) is just a normal user message
    const terminal = new FakeTerminal()
    const client = fakeClient()
    client.emit({ type: 'connected', sessionId: 'sid-slash-prefix' })
    let exitCode: number | undefined

    const tui = createTui({
      url: 'ws://ignored',
      createClient: async () => client,
      createTerminal: () => terminal,
      exit: (code) => {
        exitCode = code
      },
    })
    const runPromise = tui.run()
    await flush()

    // when
    for (const ch of '/quit me a story') terminal.feed(ch)
    terminal.feed('\r')
    await flush()

    // then
    expect(exitCode).toBeUndefined()
    expect(client.sent).toContainEqual({ type: 'prompt', text: '/quit me a story' })

    client.triggerClose()
    await runPromise
  })

  test('quit command matching is case-insensitive and tolerates surrounding whitespace', async () => {
    // given: parseCommand normalizes the command name to lowercase and ignores
    // leading/trailing whitespace, so `  /QUIT  ` should still exit the TUI
    const terminal = new FakeTerminal()
    const client = fakeClient()
    client.emit({ type: 'connected', sessionId: 'sid-slash-case' })
    let exitCode: number | undefined

    const tui = createTui({
      url: 'ws://ignored',
      createClient: async () => client,
      createTerminal: () => terminal,
      exit: (code) => {
        exitCode = code
      },
    })
    void tui.run().catch(() => {})
    await flush()

    // when
    for (const ch of '  /QUIT  ') terminal.feed(ch)
    terminal.feed('\r')
    await flush()

    // then
    expect(exitCode).toBe(0)
    expect(client.sent).toEqual([])
  })

  test('//quit is treated as a literal prompt, not a quit command (escape syntax)', async () => {
    // given: parseCommand treats a leading `//` as the user-facing escape for
    // text that legitimately starts with a slash. The TUI must honor that so
    // users can ask the agent ABOUT `/quit` without exiting.
    const terminal = new FakeTerminal()
    const client = fakeClient()
    client.emit({ type: 'connected', sessionId: 'sid-slash-escape' })
    let exitCode: number | undefined

    const tui = createTui({
      url: 'ws://ignored',
      createClient: async () => client,
      createTerminal: () => terminal,
      exit: (code) => {
        exitCode = code
      },
    })
    const runPromise = tui.run()
    await flush()

    // when
    for (const ch of '//quit') terminal.feed(ch)
    terminal.feed('\r')
    await flush()

    // then
    expect(exitCode).toBeUndefined()
    expect(client.sent).toContainEqual({ type: 'prompt', text: '//quit' })

    client.triggerClose()
    await runPromise
  })

  test('initialPrompt of /quit exits cleanly without sending it to the agent', async () => {
    // given: `typeclaw tui /quit` (or `typeclaw run /quit`) routes the positional
    // arg straight into createTui as initialPrompt, bypassing editor.onSubmit.
    // The guard must catch it there too, otherwise the literal `/quit` would
    // leak into the agent's chat context — the exact bug we're fixing.
    const terminal = new FakeTerminal()
    const client = fakeClient()
    client.emit({ type: 'connected', sessionId: 'sid-initial-quit' })
    let exitCode: number | undefined

    const tui = createTui({
      url: 'ws://ignored',
      initialPrompt: '/quit',
      createClient: async () => client,
      createTerminal: () => terminal,
      exit: (code) => {
        exitCode = code
      },
    })
    void tui.run().catch(() => {})
    await flush()

    // then: no terminal input needed; the TUI should already be tearing down
    expect(exitCode).toBe(0)
    expect(client.sent).toEqual([])
  })

  test('/reload sends a reload frame and renders reload results without exiting', async () => {
    // given
    const terminal = new FakeTerminal()
    const client = fakeClient()
    client.emit({ type: 'connected', sessionId: 'sid-slash-reload' })
    let exitCode: number | undefined

    const tui = createTui({
      url: 'ws://ignored',
      createClient: async () => client,
      createTerminal: () => terminal,
      exit: (code) => {
        exitCode = code
      },
    })
    const runPromise = tui.run()
    await flush()

    // when
    for (const ch of '/reload') terminal.feed(ch)
    terminal.feed('\r')
    await flush()
    client.emit({
      type: 'reload_result',
      results: [
        { scope: 'cron', ok: true, summary: 'loaded 1 job' },
        { scope: 'channels', ok: false, reason: 'bad config' },
      ],
    })
    await flush()

    // then
    expect(exitCode).toBeUndefined()
    expect(client.sent).toEqual([{ type: 'reload' }])
    expect(client.sent.some((msg) => msg.type === 'prompt')).toBe(false)
    const visible = terminal.visible()
    expect(visible).toContain('reloading…')
    expect(visible).toContain('● [cron] loaded 1 job')
    expect(visible).toContain('● [channels] bad config')

    client.triggerClose()
    await runPromise
  })

  test('/reload with args and //reload are sent as normal prompts', async () => {
    // given
    const terminal = new FakeTerminal()
    const client = fakeClient()
    client.emit({ type: 'connected', sessionId: 'sid-slash-reload-literal' })

    const tui = createTui({
      url: 'ws://ignored',
      createClient: async () => client,
      createTerminal: () => terminal,
    })
    const runPromise = tui.run()
    await flush()

    // when
    for (const ch of '/reload with args') terminal.feed(ch)
    terminal.feed('\r')
    await flush()
    for (const ch of '//reload') terminal.feed(ch)
    terminal.feed('\r')
    await flush()

    // then
    expect(client.sent).toContainEqual({ type: 'prompt', text: '/reload with args' })
    expect(client.sent).toContainEqual({ type: 'prompt', text: '//reload' })
    expect(client.sent.some((msg) => msg.type === 'reload')).toBe(false)

    client.triggerClose()
    await runPromise
  })

  test('/restart sends a restart frame and renders accepted and failed results without exiting', async () => {
    // given
    const terminal = new FakeTerminal()
    const client = fakeClient()
    client.emit({ type: 'connected', sessionId: 'sid-slash-restart' })
    let exitCode: number | undefined

    const tui = createTui({
      url: 'ws://ignored',
      createClient: async () => client,
      createTerminal: () => terminal,
      exit: (code) => {
        exitCode = code
      },
    })
    const runPromise = tui.run()
    await flush()

    // when
    for (const ch of '/restart') terminal.feed(ch)
    terminal.feed('\r')
    await flush()
    client.emit({
      type: 'restart_result',
      status: 'accepted',
      message: 'restart scheduled; reconnecting when the new container is up',
    })
    await flush()
    client.emit({ type: 'restart_result', status: 'failed', error: 'denied' })
    await flush()

    // then
    expect(exitCode).toBeUndefined()
    expect(client.sent).toEqual([{ type: 'restart' }])
    expect(client.sent.some((msg) => msg.type === 'prompt')).toBe(false)
    const visible = terminal.visible()
    expect(visible).toContain('restart requested… reconnecting when the new container is up')
    expect(visible).toContain('restart scheduled; reconnecting when the new container is up')
    expect(visible).toContain('restart failed: denied')
    // Regression guard: the loader is torn down on the first restart_result, so
    // it appears in exactly one repaint (the pre-result spin). If it leaked into
    // later frames the restart status would read as still-in-flight after the
    // server already replied.
    expect(terminal.frameCount('restart requested…')).toBe(1)

    client.triggerClose()
    await runPromise
  })

  test('reload and restart command matching is case-insensitive and tolerates surrounding whitespace', async () => {
    // given
    const terminal = new FakeTerminal()
    const client = fakeClient()
    client.emit({ type: 'connected', sessionId: 'sid-slash-reload-restart-case' })

    const tui = createTui({
      url: 'ws://ignored',
      createClient: async () => client,
      createTerminal: () => terminal,
    })
    const runPromise = tui.run()
    await flush()

    // when
    for (const ch of '  /RELOAD  ') terminal.feed(ch)
    terminal.feed('\r')
    await flush()
    for (const ch of '  /ReStArT  ') terminal.feed(ch)
    terminal.feed('\r')
    await flush()

    // then
    expect(client.sent).toEqual([{ type: 'reload' }, { type: 'restart' }])

    client.triggerClose()
    await runPromise
  })

  test('initialPrompt of /restart sends a restart frame instead of a prompt', async () => {
    // given
    const terminal = new FakeTerminal()
    const client = fakeClient()
    client.emit({ type: 'connected', sessionId: 'sid-initial-restart' })

    const tui = createTui({
      url: 'ws://ignored',
      initialPrompt: '/restart',
      createClient: async () => client,
      createTerminal: () => terminal,
    })
    const runPromise = tui.run()
    await flush()

    // then
    expect(client.sent).toEqual([{ type: 'restart' }])

    client.triggerClose()
    await runPromise
  })

  test('does not send abort when Esc is pressed with no reply in flight', async () => {
    // given: connect, finish initial prompt, then idle
    const terminal = new FakeTerminal()
    const client = fakeClient()
    client.emit({ type: 'connected', sessionId: 'sid-idle' })

    const tui = createTui({
      url: 'ws://ignored',
      initialPrompt: 'go',
      createClient: async () => client,
      createTerminal: () => terminal,
    })
    const runPromise = tui.run()
    await flush()

    // when
    terminal.feed('\x1b')
    await flush()

    // then
    expect(client.sent).toEqual([{ type: 'prompt', text: 'go' }])

    client.triggerClose()
    await runPromise
  })

  test('keeps the editor pinned at the bottom: every new history entry renders ABOVE the editor', async () => {
    // given
    const terminal = new FakeTerminal()
    const client = fakeClient({ autoDoneOnPrompt: false })
    client.emit({ type: 'connected', sessionId: 'sid-pin' })

    const tui = createTui({
      url: 'ws://ignored',
      initialPrompt: 'first',
      createClient: async () => client,
      createTerminal: () => terminal,
    })
    const runPromise = tui.run()
    await flush()

    // when: drive a full turn (assistant text + tool + done) so multiple
    // history entries are appended after the editor was first added
    client.emit({ type: 'text_delta', delta: 'reply text' })
    await flush()
    client.emit({ type: 'tool_start', toolCallId: 't', name: 'Read', args: {} })
    await flush()
    client.emit({ type: 'tool_end', toolCallId: 't', name: 'Read', error: false, result: 'r', durationMs: 1 })
    await flush()
    client.emit({ type: 'done' })
    await waitForVisible(terminal, '✓ Read')

    // then: every history marker appears BEFORE the editor's bottom border in
    // the rendered output. The editor draws horizontal box-drawing borders
    // (U+2500) above and below itself, so its position in the buffer is the
    // last occurrence of that character.
    const visible = terminal.visible()
    const lastEditorBorderIdx = visible.lastIndexOf('─')
    const userPromptIdx = visible.indexOf('> first')
    const assistantTextIdx = visible.indexOf('reply text')
    const toolStartIdx = visible.indexOf('● Read')
    const toolEndIdx = visible.indexOf('✓ Read')
    expect(lastEditorBorderIdx).toBeGreaterThan(-1)
    expect(userPromptIdx).toBeGreaterThan(-1)
    expect(assistantTextIdx).toBeGreaterThan(-1)
    expect(toolStartIdx).toBeGreaterThan(-1)
    expect(toolEndIdx).toBeGreaterThan(-1)
    expect(userPromptIdx).toBeLessThan(lastEditorBorderIdx)
    expect(assistantTextIdx).toBeLessThan(lastEditorBorderIdx)
    expect(toolStartIdx).toBeLessThan(lastEditorBorderIdx)
    expect(toolEndIdx).toBeLessThan(lastEditorBorderIdx)

    client.triggerClose()
    await runPromise
  })

  test('shows a tool start and end line in the chat history', async () => {
    // given
    const terminal = new FakeTerminal()
    const client = fakeClient({ autoDoneOnPrompt: false })
    client.emit({ type: 'connected', sessionId: 'sid-tool' })

    const tui = createTui({
      url: 'ws://ignored',
      initialPrompt: 'list files',
      createClient: async () => client,
      createTerminal: () => terminal,
    })
    const runPromise = tui.run()
    await flush()

    // when
    client.emit({ type: 'tool_start', toolCallId: 't1', name: 'Read', args: { path: '/x' } })
    await flush()
    client.emit({ type: 'tool_end', toolCallId: 't1', name: 'Read', error: false, result: 'hello', durationMs: 42 })
    await flush()
    client.emit({ type: 'done' })
    await flush()

    // then
    const visible = terminal.visible()
    expect(visible).toContain('● Read')
    expect(visible).toContain('✓ Read')
    expect(visible).toContain('42ms')

    client.triggerClose()
    await runPromise
  })
})

describe('createTui queue panel', () => {
  test('renders [QUEUED] lines for each pending item when queue_state arrives', async () => {
    // given
    const terminal = new FakeTerminal()
    const client = fakeClient()
    client.emit({ type: 'connected', sessionId: 'sid-queue' })

    const tui = createTui({
      url: 'ws://ignored',
      createClient: async () => client,
      createTerminal: () => terminal,
    })
    const runPromise = tui.run()
    await flush()

    // when
    client.emit({
      type: 'queue_state',
      pending: [
        { id: 'q1', text: 'fix the lint error', ts: 1 },
        { id: 'q2', text: 'then run the tests', ts: 2 },
      ],
    })
    await waitForVisible(terminal, '[QUEUED] then run the tests')

    // then
    const visible = terminal.visible()
    expect(visible).toContain('[QUEUED] fix the lint error')
    expect(visible).toContain('[QUEUED] then run the tests')

    client.triggerClose()
    await runPromise
  })

  test('updates the panel when queue_state arrives again with different items', async () => {
    // given: an initial queue with two items
    const terminal = new FakeTerminal()
    const client = fakeClient()
    client.emit({ type: 'connected', sessionId: 'sid-queue-update' })

    const tui = createTui({
      url: 'ws://ignored',
      createClient: async () => client,
      createTerminal: () => terminal,
    })
    const runPromise = tui.run()
    await flush()
    client.emit({
      type: 'queue_state',
      pending: [
        { id: 'q1', text: 'old-a', ts: 1 },
        { id: 'q2', text: 'old-b', ts: 2 },
      ],
    })
    await flush()

    // when: a fresh queue_state replaces both items
    terminal.written.length = 0
    client.emit({ type: 'queue_state', pending: [{ id: 'q3', text: 'new-c', ts: 3 }] })
    await waitForVisible(terminal, '[QUEUED] new-c')

    // then: the latest render shows the new item; nothing about the dropped ids
    const visible = terminal.visible()
    expect(visible).toContain('[QUEUED] new-c')
    expect(visible).not.toContain('old-a')
    expect(visible).not.toContain('old-b')

    client.triggerClose()
    await runPromise
  })

  test('hides the panel when queue_state arrives empty', async () => {
    // given: queue is showing one item
    const terminal = new FakeTerminal()
    const client = fakeClient()
    client.emit({ type: 'connected', sessionId: 'sid-queue-hide' })

    const tui = createTui({
      url: 'ws://ignored',
      createClient: async () => client,
      createTerminal: () => terminal,
    })
    const runPromise = tui.run()
    await flush()
    client.emit({ type: 'queue_state', pending: [{ id: 'q1', text: 'pending one', ts: 1 }] })
    await waitForVisible(terminal, '[QUEUED] pending one')
    expect(terminal.visible()).toContain('[QUEUED] pending one')

    // when
    terminal.written.length = 0
    client.emit({ type: 'queue_state', pending: [] })
    await flush()

    // then
    expect(terminal.visible()).not.toContain('[QUEUED]')

    client.triggerClose()
    await runPromise
  })

  test('queue panel sits ABOVE the editor (between history and editor)', async () => {
    // given: an initial prompt produces a user-history entry, then queue arrives
    const terminal = new FakeTerminal()
    const client = fakeClient()
    client.emit({ type: 'connected', sessionId: 'sid-queue-pos' })

    const tui = createTui({
      url: 'ws://ignored',
      initialPrompt: 'first',
      createClient: async () => client,
      createTerminal: () => terminal,
    })
    const runPromise = tui.run()
    await flush()

    // when
    client.emit({ type: 'queue_state', pending: [{ id: 'q1', text: 'queued thing', ts: 1 }] })
    await waitForVisible(terminal, '[QUEUED] queued thing')

    // then: layout invariant is [...history, queuePanel, editor]
    const visible = terminal.visible()
    const queuedIdx = visible.indexOf('[QUEUED] queued thing')
    const lastEditorBorderIdx = visible.lastIndexOf('─')
    const userPromptIdx = visible.indexOf('> first')
    expect(queuedIdx).toBeGreaterThan(-1)
    expect(lastEditorBorderIdx).toBeGreaterThan(-1)
    expect(userPromptIdx).toBeGreaterThan(-1)
    expect(userPromptIdx).toBeLessThan(queuedIdx)
    expect(queuedIdx).toBeLessThan(lastEditorBorderIdx)

    client.triggerClose()
    await runPromise
  })

  test('queued prompts appear in chat history at execution time, not submission time', async () => {
    // given: a slow first turn so the user can queue a second prompt mid-stream
    const terminal = new FakeTerminal()
    const client = fakeClient({ autoPromptStarted: false, autoDoneOnPrompt: false })
    client.emit({ type: 'connected', sessionId: 'sid-order' })

    const tui = createTui({
      url: 'ws://ignored',
      createClient: async () => client,
      createTerminal: () => terminal,
    })
    const runPromise = tui.run()
    await flush()

    // when: user submits A; server starts the first turn (prompt_started → text_delta);
    // user submits B while the first turn is still streaming
    terminal.feed('A')
    terminal.feed('\r')
    await flush()
    client.emit({ type: 'prompt_started', messageId: 'm-a', text: 'A' })
    await flush()
    client.emit({ type: 'text_delta', delta: 'response to A' })
    await flush()

    terminal.feed('B')
    terminal.feed('\r')
    await flush()
    client.emit({ type: 'queue_state', pending: [{ id: 'm-b', text: 'B', ts: 1 }] })
    await waitForVisible(terminal, '[QUEUED] B')

    // then: B is shown in the QUEUED panel but NOT yet in the chat history
    let visible = terminal.visible()
    expect(visible).toContain('> A')
    expect(visible).toContain('response to A')
    expect(visible).toContain('[QUEUED] B')
    const aIdxEarly = visible.indexOf('> A')
    expect(visible.indexOf('> B', aIdxEarly + 1)).toBe(-1)

    // when: A finishes, drain pops B and emits prompt_started for B
    client.emit({ type: 'done' })
    await flush()
    client.emit({ type: 'queue_state', pending: [] })
    await flush()
    client.emit({ type: 'prompt_started', messageId: 'm-b', text: 'B' })
    await flush()
    client.emit({ type: 'text_delta', delta: 'response to B' })
    await waitForVisible(terminal, 'response to B')
    client.emit({ type: 'done' })
    await flush()

    // then: in the latest rendered frame, chat reads A → response A → B → response B
    // in execution order, and the QUEUED panel for B is no longer rendered.
    visible = terminal.visible()
    const aPromptIdx = visible.lastIndexOf('> A')
    const aReplyIdx = visible.lastIndexOf('response to A')
    const bPromptIdx = visible.lastIndexOf('> B')
    const bReplyIdx = visible.lastIndexOf('response to B')
    const lastQueueBIdx = visible.lastIndexOf('[QUEUED] B')
    expect(aPromptIdx).toBeGreaterThan(-1)
    expect(aReplyIdx).toBeGreaterThan(aPromptIdx)
    expect(bPromptIdx).toBeGreaterThan(aReplyIdx)
    expect(bReplyIdx).toBeGreaterThan(bPromptIdx)
    expect(lastQueueBIdx).toBeLessThan(bPromptIdx)

    client.triggerClose()
    await runPromise
  })

  test('a new history entry arriving while queue is non-empty does not push the queue out of position', async () => {
    // given: queue panel is visible
    const terminal = new FakeTerminal()
    const client = fakeClient()
    client.emit({ type: 'connected', sessionId: 'sid-queue-history' })

    const tui = createTui({
      url: 'ws://ignored',
      createClient: async () => client,
      createTerminal: () => terminal,
    })
    const runPromise = tui.run()
    await flush()
    client.emit({ type: 'queue_state', pending: [{ id: 'q1', text: 'still queued', ts: 1 }] })
    await flush()

    // when: a history-style event (tool start) arrives, then we capture only
    // the writes from the next render so positions reflect the LATEST frame
    // rather than the cumulative log of past frames.
    terminal.written.length = 0
    client.emit({ type: 'tool_start', toolCallId: 't', name: 'Read', args: {} })
    await waitForVisible(terminal, '● Read')

    // then: layout invariant is [...history, queuePanel, editor]
    const visible = terminal.visible()
    const toolIdx = visible.indexOf('● Read')
    const queuedIdx = visible.indexOf('[QUEUED] still queued')
    const lastEditorBorderIdx = visible.lastIndexOf('─')
    expect(toolIdx).toBeGreaterThan(-1)
    expect(queuedIdx).toBeGreaterThan(-1)
    expect(toolIdx).toBeLessThan(queuedIdx)
    expect(queuedIdx).toBeLessThan(lastEditorBorderIdx)

    client.triggerClose()
    await runPromise
  })

  test('invokes onVersionMismatch and renders a warning when serverVersion differs from expectedVersion', async () => {
    // given
    const terminal = new FakeTerminal()
    const client = fakeClient()
    client.emit({ type: 'connected', sessionId: 'sid-mismatch', serverVersion: '0.3.1' })
    const seen: VersionMismatch[] = []

    // when
    const tui = createTui({
      url: 'ws://ignored',
      createClient: async () => client,
      createTerminal: () => terminal,
      expectedVersion: '0.3.2',
      onVersionMismatch: (info) => seen.push(info),
    })
    const runPromise = tui.run()
    await flush()
    client.triggerClose()
    await runPromise

    // then
    expect(seen).toEqual([{ expected: '0.3.2', actual: '0.3.1' }])
    expect(terminal.visible()).toContain('host CLI is v0.3.2, agent container is v0.3.1')
    expect(terminal.visible()).toContain('typeclaw restart --build')
  })

  test('skips the version warning when expectedVersion matches serverVersion', async () => {
    // given
    const terminal = new FakeTerminal()
    const client = fakeClient()
    client.emit({ type: 'connected', sessionId: 'sid-match', serverVersion: '0.3.2' })
    const seen: VersionMismatch[] = []

    // when
    const tui = createTui({
      url: 'ws://ignored',
      createClient: async () => client,
      createTerminal: () => terminal,
      expectedVersion: '0.3.2',
      onVersionMismatch: (info) => seen.push(info),
    })
    const runPromise = tui.run()
    await flush()
    client.triggerClose()
    await runPromise

    // then
    expect(seen).toEqual([])
    expect(terminal.visible()).not.toContain('host CLI is v')
  })

  test('skips the version warning when the server omits serverVersion (old server)', async () => {
    // given
    const terminal = new FakeTerminal()
    const client = fakeClient()
    client.emit({ type: 'connected', sessionId: 'sid-old' })
    const seen: VersionMismatch[] = []

    // when
    const tui = createTui({
      url: 'ws://ignored',
      createClient: async () => client,
      createTerminal: () => terminal,
      expectedVersion: '0.3.2',
      onVersionMismatch: (info) => seen.push(info),
    })
    const runPromise = tui.run()
    await flush()
    client.triggerClose()
    await runPromise

    // then
    expect(seen).toEqual([])
    expect(terminal.visible()).not.toContain('host CLI is v')
  })

  test('skips the version warning when expectedVersion is not configured (container-side local TUI)', async () => {
    // given
    const terminal = new FakeTerminal()
    const client = fakeClient()
    client.emit({ type: 'connected', sessionId: 'sid-noexpect', serverVersion: '0.3.1' })

    // when
    const tui = createTui({
      url: 'ws://ignored',
      createClient: async () => client,
      createTerminal: () => terminal,
    })
    const runPromise = tui.run()
    await flush()
    client.triggerClose()
    await runPromise

    // then
    expect(terminal.visible()).not.toContain('host CLI is v')
  })

  test('formatVersionMismatchWarning renders the expected one-line warning', () => {
    expect(formatVersionMismatchWarning({ expected: '1.2.3', actual: '1.2.0' })).toBe(
      'WARN: host CLI is v1.2.3, agent container is v1.2.0. Some commands may hang or fail. Try `typeclaw restart --build`.',
    )
  })

  test('resolves lostConnection when the WS closes after handshake without user action', async () => {
    // given
    const terminal = new FakeTerminal()
    const client = fakeClient()
    client.emit({ type: 'connected', sessionId: 'sid-lost' })
    const tui = createTui({
      url: 'ws://ignored',
      createClient: async () => client,
      createTerminal: () => terminal,
      exit: () => {},
    })

    // when
    const runPromise = tui.run()
    await flush()
    client.triggerClose()

    // then
    await expect(runPromise).resolves.toEqual({ reason: 'lostConnection' })
  })

  test('resolves exit when the user submits /quit', async () => {
    // given
    const terminal = new FakeTerminal()
    const client = fakeClient()
    client.emit({ type: 'connected', sessionId: 'sid-quit' })
    const tui = createTui({
      url: 'ws://ignored',
      initialPrompt: '/quit',
      createClient: async () => client,
      createTerminal: () => terminal,
      exit: () => {},
    })

    // when
    const outcome = await tui.run()

    // then
    expect(outcome).toEqual({ reason: 'exit', exitCode: 0 })
  })

  test('resolves detach when Esc is pressed while idle', async () => {
    // given
    const terminal = new FakeTerminal()
    const client = fakeClient()
    client.emit({ type: 'connected', sessionId: 'sid-detach' })
    const tui = createTui({
      url: 'ws://ignored',
      createClient: async () => client,
      createTerminal: () => terminal,
      exit: () => {},
    })

    // when
    const runPromise = tui.run()
    await flush()
    terminal.feed('\x1b')

    // then
    await expect(runPromise).resolves.toEqual({ reason: 'detach' })
  })
})
