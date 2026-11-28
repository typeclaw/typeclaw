// Answers one passkey registration or sign-in in a managed-browser tab with a
// Chrome DevTools virtual authenticator, so the agent can use a passkey it
// never sees. The private key only ever travels runtime <-> Chrome, over a CDP
// connection of the runtime's own: sessions reach Chrome through their own
// connections, which never see this authenticator's id or its events.
//
// The whole exchange happens inside one call. Chrome keeps a tab's virtual
// authenticators in one environment that any CDP session's detach tears down,
// so an authenticator left waiting for the agent to click would vanish the
// moment its browser driver disconnected. Instead the agent focuses the
// site's passkey button first, and this presses it.

import type { Passkey } from 'typevault'

import { CdpConnection } from './cdp-connection'

// A platform authenticator that verifies the user, so sites asking for a
// discoverable, user-verified passkey (the common case) accept it.
const AUTHENTICATOR = {
  protocol: 'ctap2',
  transport: 'internal',
  hasResidentKey: true,
  hasUserVerification: true,
  isUserVerified: true,
  automaticPresenceSimulation: true,
}
const DEFAULT_TIMEOUT_MS = 30_000

export type PasskeyOptions = {
  cdpUrl: string
  url?: string
  // Loaded for a sign-in; without one the site registers a new credential.
  credential?: Passkey
  timeoutMs?: number
}

export type PasskeyOutcome =
  | { status: 'registered' | 'signed-in'; url: string; credential: Passkey }
  | { status: 'not-used'; url: string }
  | { status: 'refused'; reason: string }

export async function answerPasskeyPrompt(options: PasskeyOptions): Promise<PasskeyOutcome> {
  const cdp = await CdpConnection.open(options.cdpUrl)
  try {
    const target = await pickPage(cdp, options.url)
    if ('reason' in target) return { status: 'refused', reason: target.reason }
    const loaded = options.credential
    if (loaded !== undefined && !servesRelyingParty(target.url, loaded.rp_id)) {
      return {
        status: 'refused',
        reason: `${target.url} is not a page of ${loaded.rp_id}, the site this passkey is for`,
      }
    }
    const { sessionId } = (await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })) as {
      sessionId: string
    }
    // Background tabs report no focus; emulate it so the key press reaches the focused button.
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId)
    const focused = await focusedControl(cdp, sessionId)
    if (focused === undefined) {
      return {
        status: 'refused',
        reason: `nothing is focused on ${target.url}; focus the site's passkey button with your browser driver (without clicking it) first`,
      }
    }
    await cdp.send('WebAuthn.enable', { enableUI: false }, sessionId)
    let authenticatorId: string
    try {
      ;({ authenticatorId } = (await cdp.send(
        'WebAuthn.addVirtualAuthenticator',
        { options: AUTHENTICATOR },
        sessionId,
      )) as {
        authenticatorId: string
      })
    } catch (error) {
      // Chrome allows one platform authenticator per tab; a browser driver testing passkeys may have added its own.
      return {
        status: 'refused',
        reason: `could not add a passkey authenticator to ${target.url} (${error instanceof Error ? error.message : String(error)}); remove any virtual authenticator your browser driver added to this tab and retry`,
      }
    }
    if (loaded !== undefined) {
      await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: toCdpCredential(loaded) }, sessionId)
    }
    // Subscribed before the press, so a fast answer can't slip past.
    const answered = cdp.waitForEvent(
      loaded === undefined ? 'WebAuthn.credentialAdded' : 'WebAuthn.credentialAsserted',
      sessionId,
      (params) => (params as { authenticatorId?: string }).authenticatorId === authenticatorId,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
    await pressEnter(cdp, sessionId)
    const event = (await answered) as { credential?: CdpCredential } | undefined
    // The event carries the credential; reading it back is only a fallback, and tells a dropped authenticator from
    // a page that never asked.
    const credentials = await heldCredentials(cdp, sessionId, authenticatorId)
    const pick = (candidates: readonly CdpCredential[]): CdpCredential | undefined =>
      loaded === undefined
        ? candidates.at(-1)
        : candidates.find((candidate) => toBase64Url(candidate.credentialId) === loaded.credential_id)
    const credential =
      event?.credential ?? (event === undefined || credentials === undefined ? undefined : pick(credentials))
    if (
      credential === undefined ||
      (loaded !== undefined && toBase64Url(credential.credentialId) !== loaded.credential_id)
    ) {
      if (credentials === undefined) {
        return {
          status: 'refused',
          reason: `the browser dropped the passkey authenticator on ${target.url} before the site used it (another connection to the tab detached); try again`,
        }
      }
      return { status: 'not-used', url: target.url }
    }
    return {
      status: loaded === undefined ? 'registered' : 'signed-in',
      url: target.url,
      credential: fromCdpCredential(credential, loaded),
    }
  } finally {
    cdp.close()
  }
}

// WebAuthn's own rule: a page may use credentials for its registrable domain or any parent of it.
export function servesRelyingParty(url: string, rpId: string): boolean {
  const host = URL.parse(url)?.hostname.toLowerCase()
  const rp = rpId.toLowerCase()
  return host !== undefined && (host === rp || host.endsWith(`.${rp}`))
}

type TargetInfo = { targetId: string; type: string; url: string }

async function pickPage(
  cdp: CdpConnection,
  url: string | undefined,
): Promise<{ targetId: string; url: string } | { reason: string }> {
  const { targetInfos } = (await cdp.send('Target.getTargets')) as { targetInfos: TargetInfo[] }
  const pages = targetInfos.filter((t) => t.type === 'page' && !/^(devtools|chrome|chrome-extension):/.test(t.url))
  const prefixed = url === undefined ? pages : pages.filter((t) => t.url === url || t.url.startsWith(url))
  const exact = url === undefined ? [] : prefixed.filter((t) => t.url === url)
  const matches = exact.length > 0 ? exact : prefixed
  if (matches.length === 1) return matches[0]!
  if (matches.length === 0) {
    return { reason: url === undefined ? 'the shared browser has no open tab' : `no open tab matches ${url}` }
  }
  return { reason: `several tabs match; pass the exact \`url\` of one of: ${matches.map((t) => t.url).join(', ')}` }
}

// The deepest focused element, through shadow roots; undefined when focus sits on the page itself.
const FOCUSED_EXPRESSION = `(() => {
  let el = document.activeElement
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement
  return !el || el === document.body || el === document.documentElement ? null : el.tagName.toLowerCase()
})()`

async function focusedControl(cdp: CdpConnection, sessionId: string): Promise<string | undefined> {
  const { result } = (await cdp.send(
    'Runtime.evaluate',
    { expression: FOCUSED_EXPRESSION, returnByValue: true },
    sessionId,
  )) as { result: { value?: string | null } }
  return result.value ?? undefined
}

async function pressEnter(cdp: CdpConnection, sessionId: string): Promise<void> {
  const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', ...key }, sessionId)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key }, sessionId)
}

async function heldCredentials(
  cdp: CdpConnection,
  sessionId: string,
  authenticatorId: string,
): Promise<CdpCredential[] | undefined> {
  try {
    const { credentials } = (await cdp.send('WebAuthn.getCredentials', { authenticatorId }, sessionId)) as {
      credentials: CdpCredential[]
    }
    return credentials
  } catch {
    return undefined
  }
}

// CDP's Credential: binary values in standard base64, where the vault keeps base64url.
type CdpCredential = {
  credentialId: string
  isResidentCredential: boolean
  rpId: string
  privateKey: string
  userHandle?: string
  userName?: string
  signCount: number
}

function toCdpCredential(passkey: Passkey): CdpCredential {
  return {
    credentialId: toBase64(passkey.credential_id),
    isResidentCredential: passkey.discoverable,
    rpId: passkey.rp_id,
    privateKey: toBase64(passkey.private_key),
    ...(passkey.user_handle === undefined ? {} : { userHandle: toBase64(passkey.user_handle) }),
    ...(passkey.user_name === undefined ? {} : { userName: passkey.user_name }),
    signCount: passkey.sign_count ?? 0,
  }
}

function fromCdpCredential(credential: CdpCredential, loaded: Passkey | undefined): Passkey {
  const userName = credential.userName || loaded?.user_name
  return {
    rp_id: credential.rpId,
    credential_id: toBase64Url(credential.credentialId),
    private_key: toBase64Url(credential.privateKey),
    discoverable: credential.isResidentCredential,
    ...(credential.userHandle ? { user_handle: toBase64Url(credential.userHandle) } : {}),
    ...(userName ? { user_name: userName } : {}),
    ...(credential.signCount > 0 ? { sign_count: credential.signCount } : {}),
  }
}

const toBase64 = (base64url: string): string => Buffer.from(base64url, 'base64url').toString('base64')
const toBase64Url = (base64: string): string => Buffer.from(base64, 'base64').toString('base64url')
