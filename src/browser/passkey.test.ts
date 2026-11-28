import { describe, expect, onTestFinished, test } from 'bun:test'

import type { Passkey } from 'typevault'

import { answerPasskeyPrompt, servesRelyingParty } from './passkey'

type Call = { method: string; params: Record<string, unknown>; sessionId?: string }
type CdpCredential = Record<string, unknown>

// Chrome stand-in: one tab, the commands the passkey flow sends, and a site
// that answers the Enter on its focused button: `registers` creates that
// credential, `asserts` signs in with the loaded one, and neither does nothing.
function fakeChrome(options: {
  url: string
  focused?: string | null
  site?: { registers: CdpCredential } | 'asserts'
  failAdd?: boolean
  dropsAuthenticator?: boolean
}) {
  const calls: Call[] = []
  const credentials: CdpCredential[] = []
  // Each test stops its own server, so tests running at once never stop one another's.
  const server = Bun.serve({
    port: 0,
    // The address cdpUrl dials: a wildcard bind can leave its IPv4 port to another process on a busy machine.
    hostname: '127.0.0.1',
    fetch: (req, srv) => (srv.upgrade(req, { data: undefined }) ? undefined : new Response('no', { status: 400 })),
    websocket: {
      message(ws, raw) {
        const { id, method, params, sessionId } = JSON.parse(String(raw)) as Call & { id: number }
        calls.push({ method, params, ...(sessionId === undefined ? {} : { sessionId }) })
        const reply = (result: unknown): void => void ws.send(JSON.stringify({ id, result }))
        const fail = (message: string): void => void ws.send(JSON.stringify({ id, error: { message } }))
        const emit = (event: string, credential: CdpCredential): void =>
          void ws.send(
            JSON.stringify({ method: event, sessionId: 'S0', params: { authenticatorId: 'auth-1', credential } }),
          )
        switch (method) {
          case 'Target.getTargets':
            return reply({ targetInfos: [{ targetId: 't0', type: 'page', url: options.url }] })
          case 'Target.attachToTarget':
            return reply({ sessionId: 'S0' })
          case 'Runtime.evaluate':
            return reply({ result: { value: options.focused === undefined ? 'button' : options.focused } })
          case 'WebAuthn.addVirtualAuthenticator':
            return options.failAdd
              ? fail('Chrome only supports one internal authenticator per environment')
              : reply({ authenticatorId: 'auth-1' })
          case 'WebAuthn.addCredential':
            credentials.push(params['credential'] as CdpCredential)
            return reply({})
          case 'WebAuthn.getCredentials':
            return options.dropsAuthenticator
              ? fail('Could not find a Virtual Authenticator matching the ID')
              : reply({ credentials })
          case 'Input.dispatchKeyEvent':
            reply({})
            if (params['type'] !== 'keyUp' || options.site === undefined) return
            if (options.site === 'asserts') {
              const used = { ...credentials[0], signCount: Number(credentials[0]?.['signCount'] ?? 0) + 1 }
              credentials[0] = used
              return emit('WebAuthn.credentialAsserted', used)
            }
            credentials.push(options.site.registers)
            return emit('WebAuthn.credentialAdded', options.site.registers)
          default:
            return reply({})
        }
      },
    },
  })
  onTestFinished(() => void server.stop(true))
  return { cdpUrl: `ws://127.0.0.1:${server.port}`, calls }
}

const chromeCredential = {
  credentialId: 'Y3JlZA==',
  isResidentCredential: true,
  rpId: 'example.com',
  privateKey: 'a2V5+/8=',
  userHandle: 'dXNlcg==',
  userName: 'bot@example.com',
  signCount: 1,
}
const stored: Passkey = {
  rp_id: 'example.com',
  credential_id: 'Y3JlZA',
  private_key: 'a2V5-_8',
  discoverable: true,
  user_handle: 'dXNlcg',
  user_name: 'bot@example.com',
  sign_count: 1,
}
const methods = (calls: readonly Call[]): string[] => calls.map((call) => call.method)

describe('answerPasskeyPrompt', () => {
  test('presses the focused button with a user-verifying platform authenticator and returns what the site registered', async () => {
    // given
    const chrome = fakeChrome({ url: 'https://example.com/settings', site: { registers: chromeCredential } })

    // when
    const outcome = await answerPasskeyPrompt({ cdpUrl: chrome.cdpUrl })

    // then
    expect(outcome).toEqual({ status: 'registered', url: 'https://example.com/settings', credential: stored })
    expect(chrome.calls.find((call) => call.method === 'WebAuthn.enable')?.params).toEqual({ enableUI: false })
    expect(chrome.calls.find((call) => call.method === 'WebAuthn.addVirtualAuthenticator')?.params).toEqual({
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    })
    const order = methods(chrome.calls)
    expect(order.indexOf('WebAuthn.addVirtualAuthenticator')).toBeLessThan(order.indexOf('Input.dispatchKeyEvent'))
  })

  test('loads a stored passkey in Chrome encoding and returns it with the sign count the site advanced', async () => {
    // given
    const chrome = fakeChrome({ url: 'https://login.example.com/', site: 'asserts' })

    // when
    const outcome = await answerPasskeyPrompt({ cdpUrl: chrome.cdpUrl, credential: stored })

    // then
    expect(chrome.calls.find((call) => call.method === 'WebAuthn.addCredential')?.params['credential']).toEqual(
      chromeCredential,
    )
    expect(outcome).toEqual({
      status: 'signed-in',
      url: 'https://login.example.com/',
      credential: { ...stored, sign_count: 2 },
    })
  })

  test('reports a page that never asks for a passkey', async () => {
    const chrome = fakeChrome({ url: 'https://example.com/settings' })

    expect(await answerPasskeyPrompt({ cdpUrl: chrome.cdpUrl, timeoutMs: 50 })).toEqual({
      status: 'not-used',
      url: 'https://example.com/settings',
    })
  })

  test('refuses a tab outside the passkey site before touching it', async () => {
    const chrome = fakeChrome({ url: 'https://evil.test/login', site: 'asserts' })

    expect(await answerPasskeyPrompt({ cdpUrl: chrome.cdpUrl, credential: stored })).toMatchObject({
      status: 'refused',
    })
    expect(methods(chrome.calls)).toEqual(['Target.getTargets'])
  })

  test('refuses without arming when nothing is focused', async () => {
    const chrome = fakeChrome({ url: 'https://example.com/login', focused: null, site: 'asserts' })

    expect(await answerPasskeyPrompt({ cdpUrl: chrome.cdpUrl, credential: stored })).toMatchObject({
      status: 'refused',
    })
    expect(
      methods(chrome.calls).filter((method) => method.startsWith('WebAuthn.') || method.startsWith('Input.')),
    ).toEqual([])
  })

  test('refuses when the tab already has a platform authenticator, adding no credential and pressing nothing', async () => {
    const chrome = fakeChrome({ url: 'https://example.com/login', failAdd: true, site: 'asserts' })

    expect(await answerPasskeyPrompt({ cdpUrl: chrome.cdpUrl, credential: stored })).toMatchObject({
      status: 'refused',
    })
    expect(methods(chrome.calls)).not.toContain('WebAuthn.addCredential')
    expect(methods(chrome.calls)).not.toContain('Input.dispatchKeyEvent')
  })

  test('keeps a registration whose credential event arrived even when reading it back fails', async () => {
    const chrome = fakeChrome({
      url: 'https://example.com/settings',
      site: { registers: chromeCredential },
      dropsAuthenticator: true,
    })

    expect(await answerPasskeyPrompt({ cdpUrl: chrome.cdpUrl })).toEqual({
      status: 'registered',
      url: 'https://example.com/settings',
      credential: stored,
    })
  })

  test('reports an authenticator dropped before the site used it, not a page that never asked', async () => {
    const chrome = fakeChrome({ url: 'https://example.com/settings', dropsAuthenticator: true })

    const outcome = await answerPasskeyPrompt({ cdpUrl: chrome.cdpUrl, timeoutMs: 50 })

    expect(outcome).toMatchObject({ status: 'refused' })
    expect(outcome.status === 'refused' ? outcome.reason : '').toContain('dropped')
  })
})

describe('servesRelyingParty', () => {
  test.each([
    ['https://example.com/login', true],
    ['https://login.example.com/', true],
    ['https://EXAMPLE.com/', true],
    ['https://notexample.com/', false],
    ['https://example.com.evil.test/', false],
    ['not a url', false],
  ])('%s serves example.com: %p', (url, expected) => {
    expect(servesRelyingParty(url, 'example.com')).toBe(expected)
  })
})
