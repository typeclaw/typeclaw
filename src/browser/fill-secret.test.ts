import { afterEach, describe, expect, test } from 'bun:test'

import { JSDOM } from 'jsdom'

import { CLEAR_FIELD_FUNCTION, fillSecretIntoFocusedField } from './fill-secret'

type Focus = { kind: string; field?: string }
type FakeOptions = {
  // A target's own `focus` overrides the default for that tab.
  targets: { url: string; focus?: Focus }[]
  focus: Focus
  // What makes the page navigate: a real Enter keystroke (script-driven logins
  // that cancel a direct form submit), only a direct form submit, or nothing.
  navigatesOn: 'enter' | 'form-submit' | 'never'
  // The Enter keystroke fires the form's submit event (SPA logins that handle
  // it in script and never navigate): at once, or this many ms later (a
  // handler that validates asynchronously before submitting).
  enterSubmits?: 'now' | 'late'
  failOn?: 'Page.enable' | 'submit'
}
type Call = { method: string; params: Record<string, unknown>; sessionId?: string }

let server: ReturnType<typeof Bun.serve> | undefined

afterEach(() => {
  server?.stop(true)
  server = undefined
})

// Hand-rolled Chrome stand-in: answers the CDP commands the fill flow sends and
// fires a main-frame navigation when the page "submits". Like Chrome, a
// navigation destroys the old document, so calls on its element handle fail.
function fakeChrome(options: FakeOptions): { cdpUrl: string; calls: Call[]; submits: () => number } {
  const calls: Call[] = []
  let submitSeen = false
  let submits = 0
  let handleAlive = true
  let lateSubmitPending = false
  const submit = (): void => {
    submitSeen = true
    submits++
  }
  server = Bun.serve({
    port: 0,
    fetch: (req, srv) => (srv.upgrade(req, { data: undefined }) ? undefined : new Response('no', { status: 400 })),
    websocket: {
      message(ws, raw) {
        const { id, method, params, sessionId } = JSON.parse(String(raw)) as Call & { id: number }
        calls.push({ method, params, ...(sessionId === undefined ? {} : { sessionId }) })
        const reply = (result: unknown): void => {
          ws.send(JSON.stringify({ id, result }))
        }
        const fail = (): void => {
          ws.send(JSON.stringify({ id, error: { message: `${method} failed` } }))
        }
        const navigate = (): void => {
          handleAlive = false
          ws.send(JSON.stringify({ method: 'Page.frameStartedLoading', sessionId, params: { frameId: 'main' } }))
          ws.send(JSON.stringify({ method: 'Page.frameNavigated', sessionId, params: { frame: { id: 'main' } } }))
        }
        const focusOf = (): Focus => options.targets[Number(sessionId?.slice('S:t'.length))]?.focus ?? options.focus
        if (method === 'Page.enable' && options.failOn === 'Page.enable') return fail()
        switch (method) {
          case 'Target.getTargets':
            return reply({
              targetInfos: options.targets.map((t, i) => ({ targetId: `t${i}`, type: 'page', url: t.url })),
            })
          case 'Target.attachToTarget':
            return reply({ sessionId: `S:${String(params['targetId'])}` })
          case 'Page.getFrameTree':
            return reply({ frameTree: { frame: { id: 'main' } } })
          case 'Input.dispatchKeyEvent':
            reply({})
            if (params['type'] === 'keyUp' && params['key'] === 'Enter') {
              if (options.navigatesOn === 'enter') navigate()
              if (options.enterSubmits === 'now') submit()
              else if (options.enterSubmits === 'late') lateSubmitPending = true
            }
            return
          case 'Runtime.evaluate':
            return reply(params['returnByValue'] ? { result: { value: focusOf() } } : { result: { objectId: 'el-1' } })
          case 'Runtime.callFunctionOn': {
            const fn = String(params['functionDeclaration'])
            if (!handleAlive) {
              ws.send(JSON.stringify({ id, error: { message: 'Cannot find context with specified id' } }))
              return
            }
            // A late submit lands after Enter returns, but before the page can
            // run the fallback submit.
            if (fn.includes('requestSubmit') && lateSubmitPending) {
              lateSubmitPending = false
              submit()
            }
            if (fn.includes('requestSubmit') && options.failOn === 'submit') return fail()
            reply({ result: { value: fn.includes('__typeclawSubmitSeen === true') ? submitSeen : true } })
            // requestSubmit() always fires another submit; only a browser-side
            // check of the submit-seen marker can skip it.
            const guarded = fn.includes('__typeclawSubmitSeen === true')
            if (fn.includes('requestSubmit') && !(guarded && submitSeen)) {
              submit()
              if (options.navigatesOn === 'form-submit') navigate()
            }
            return
          }
          default:
            return reply({})
        }
      },
    },
  })
  return { cdpUrl: `ws://127.0.0.1:${server.port}/devtools/browser/x`, calls, submits: () => submits }
}

const password: Focus = { kind: 'editable', field: 'input[type=password]' }
const insertedText = (calls: Call[]) =>
  calls.filter((c) => c.method === 'Input.insertText').map((c) => c.params['text'])
const clearCalls = (calls: Call[]) =>
  calls.filter((c) => c.method === 'Runtime.callFunctionOn' && c.params['functionDeclaration'] === CLEAR_FIELD_FUNCTION)

describe('fillSecretIntoFocusedField', () => {
  test('submits with a real Enter so a script-driven login runs, and reports the navigation without the value', async () => {
    const { cdpUrl, calls, submits } = fakeChrome({
      targets: [{ url: 'https://example.com/login' }],
      focus: password,
      navigatesOn: 'enter',
    })

    const outcome = await fillSecretIntoFocusedField({ cdpUrl, value: 'hunter2', submit: true })

    expect(outcome).toEqual({ status: 'submitted', url: 'https://example.com/login', field: 'input[type=password]' })
    expect(JSON.stringify(outcome)).not.toContain('hunter2')
    expect(insertedText(calls)).toEqual(['hunter2'])
    expect(submits()).toBe(0)
    expect(clearCalls(calls)).toEqual([])
  })

  test('submits the form directly when Enter does nothing, as in a form without a submit button', async () => {
    const { cdpUrl, submits } = fakeChrome({
      targets: [{ url: 'https://example.com/login' }],
      focus: password,
      navigatesOn: 'form-submit',
    })

    const outcome = await fillSecretIntoFocusedField({
      cdpUrl,
      value: 'hunter2',
      submit: true,
      // The fallback waits out the whole Enter grace period, so the navigation
      // budget must comfortably exceed it on a loaded machine.
      navigationTimeoutMs: 10_000,
    })

    expect(outcome).toMatchObject({ status: 'submitted' })
    expect(submits()).toBe(1)
  })

  test.each([
    ['at once', 'now'],
    ['late in the grace period', 'late'],
  ] as const)(
    'does not submit the form a second time when Enter fires its submit event %s',
    async (_when, enterSubmits) => {
      const { cdpUrl, submits } = fakeChrome({
        targets: [{ url: 'https://app.example/login' }],
        focus: password,
        navigatesOn: 'never',
        enterSubmits,
      })

      const outcome = await fillSecretIntoFocusedField({
        cdpUrl,
        value: 'hunter2',
        submit: true,
        navigationTimeoutMs: 60,
      })

      expect(outcome).toMatchObject({ status: 'not-navigated', cleared: true })
      expect(submits()).toBe(1)
    },
  )

  test('clears the field when the submit does not navigate, so the value is not left on the page', async () => {
    const { cdpUrl, calls } = fakeChrome({
      targets: [{ url: 'https://example.com/login' }],
      focus: password,
      navigatesOn: 'never',
    })

    const outcome = await fillSecretIntoFocusedField({
      cdpUrl,
      value: 'hunter2',
      submit: true,
      navigationTimeoutMs: 50,
    })

    expect(outcome).toMatchObject({ status: 'not-navigated', cleared: true })
    expect(clearCalls(calls)).toHaveLength(1)
  })

  test('leaves a plain fill in place for non-submit fields such as an address', async () => {
    const { cdpUrl, calls } = fakeChrome({
      targets: [{ url: 'https://shop.example/checkout' }],
      focus: { kind: 'editable', field: 'textarea' },
      navigatesOn: 'never',
    })

    const outcome = await fillSecretIntoFocusedField({ cdpUrl, value: '1 Main St', submit: false })

    expect(outcome).toEqual({ status: 'filled', url: 'https://shop.example/checkout', field: 'textarea' })
    expect(insertedText(calls)).toEqual(['1 Main St'])
  })

  test('refuses without typing when nothing editable is focused', async () => {
    const { cdpUrl, calls } = fakeChrome({
      targets: [{ url: 'https://example.com/' }],
      focus: { kind: 'none', field: 'button' },
      navigatesOn: 'never',
    })

    const outcome = await fillSecretIntoFocusedField({ cdpUrl, value: 'hunter2', submit: false })

    expect(outcome).toMatchObject({ status: 'refused' })
    expect(insertedText(calls)).toEqual([])
  })

  test('asks for a url when several tabs are open, and uses the one it names', async () => {
    const targets = [{ url: 'https://a.example/login' }, { url: 'https://b.example/' }]
    const ambiguous = fakeChrome({ targets, focus: password, navigatesOn: 'never' })
    expect(await fillSecretIntoFocusedField({ cdpUrl: ambiguous.cdpUrl, value: 'x', submit: false })).toMatchObject({
      status: 'refused',
    })
    expect(insertedText(ambiguous.calls)).toEqual([])
    server?.stop(true)

    const picked = fakeChrome({ targets, focus: password, navigatesOn: 'never' })
    const outcome = await fillSecretIntoFocusedField({
      cdpUrl: picked.cdpUrl,
      value: 'x',
      submit: false,
      url: 'https://a.example',
    })
    expect(outcome).toMatchObject({ status: 'filled', url: 'https://a.example/login' })
    expect(picked.calls.find((c) => c.method === 'Target.attachToTarget')?.params['targetId']).toBe('t0')
  })

  test('prefers the tab whose url equals the one passed over tabs it is only a prefix of', async () => {
    const { cdpUrl, calls } = fakeChrome({
      targets: [{ url: 'https://shop.example/' }, { url: 'https://shop.example/login' }],
      focus: password,
      navigatesOn: 'never',
    })

    const outcome = await fillSecretIntoFocusedField({
      cdpUrl,
      value: 'x',
      submit: false,
      url: 'https://shop.example/',
    })

    expect(outcome).toMatchObject({ status: 'filled', url: 'https://shop.example/' })
    expect(calls.find((c) => c.method === 'Input.insertText')?.sessionId).toBe('S:t0')
  })

  test('fills the one duplicate tab whose focus is in an editable field', async () => {
    const none: Focus = { kind: 'none', field: 'body' }
    const { cdpUrl, calls } = fakeChrome({
      targets: [
        { url: 'https://shop.example/login', focus: none },
        { url: 'https://shop.example/login', focus: password },
      ],
      focus: none,
      navigatesOn: 'never',
    })

    const outcome = await fillSecretIntoFocusedField({
      cdpUrl,
      value: 'x',
      submit: false,
      url: 'https://shop.example/login',
    })

    expect(outcome).toMatchObject({ status: 'filled', field: 'input[type=password]' })
    expect(calls.filter((c) => c.method === 'Input.insertText').map((c) => c.sessionId)).toEqual(['S:t1'])
  })

  test('refuses without typing when several duplicate tabs all have a focused field', async () => {
    const { cdpUrl, calls } = fakeChrome({
      targets: [{ url: 'https://shop.example/login' }, { url: 'https://shop.example/login' }],
      focus: password,
      navigatesOn: 'never',
    })

    const outcome = await fillSecretIntoFocusedField({ cdpUrl, value: 'x', submit: false })

    expect(outcome).toMatchObject({ status: 'refused' })
    expect(insertedText(calls)).toEqual([])
  })

  test.each(['Page.enable', 'submit'] as const)(
    'clears the field and rethrows when %s fails after the value was typed',
    async (failOn) => {
      const { cdpUrl, calls } = fakeChrome({
        targets: [{ url: 'https://example.com/login' }],
        focus: password,
        navigatesOn: 'never',
        failOn,
      })

      await expect(
        fillSecretIntoFocusedField({ cdpUrl, value: 'hunter2', submit: true, navigationTimeoutMs: 50 }),
      ).rejects.toThrow('failed')

      expect(insertedText(calls)).toEqual(['hunter2'])
      expect(clearCalls(calls)).toHaveLength(1)
    },
  )
})

describe('CLEAR_FIELD_FUNCTION', () => {
  // Mirrors React's inputValueTracking: the element gets an own `value`
  // property whose setter records what the app last saw, and the change
  // plugin only fires onChange when the live value differs from that record.
  function controlledInput(dom: JSDOM, initial: string) {
    const input = dom.window.document.createElement('input')
    dom.window.document.body.append(input)
    const native = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!
    let tracked = ''
    const state = { value: initial }
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => native.get!.call(input),
      set: (next: string) => {
        tracked = next
        native.set!.call(input, next)
      },
    })
    const render = (): void => {
      input.value = state.value
    }
    input.addEventListener('input', () => {
      const live = native.get!.call(input) as string
      if (live === tracked) return
      tracked = live
      state.value = live
    })
    render()
    return { input, state, render }
  }

  test('empties a controlled input so the app state is cleared and a re-render keeps it empty', () => {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' })
    const { input, state, render } = controlledInput(dom, 'hunter2')
    const clear = dom.window.eval(`(${CLEAR_FIELD_FUNCTION})`) as (this: HTMLElement) => boolean

    expect(clear.call(input)).toBe(true)
    render()

    expect(state.value).toBe('')
    expect(input.value).toBe('')
  })
})
