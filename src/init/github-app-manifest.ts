import { randomBytes } from 'node:crypto'
import { basename } from 'node:path'

import { AppAuthStrategy } from '@/channels/adapters/github/auth-app'
import { GITHUB_API_BASE, githubJsonHeaders, githubPublicHeaders } from '@/channels/adapters/github/auth-pat'
import { GITHUB_APP_MANIFEST_PERMISSIONS } from '@/channels/adapters/github/permission-guidance'

// Host stage only: the manifest callback server binds the operator's loopback
// interface, which is only reachable from a browser on the same machine.

const APP_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/
const MANIFEST_CODE_RE = /^[A-Za-z0-9]+$/
const NO_INSTALLATION_MESSAGE = 'GitHub App has no installations'
const REPOS_PAGE_SIZE = 100

export type GithubAppNameStatus = 'available' | 'taken' | 'unknown'

export type GithubAppCredentials = {
  appId: number
  slug: string
  privateKey: string
  htmlUrl: string
}

export type GithubAppManifestSession = {
  url: string
  code: Promise<string>
  // A browser on another machine (SSH, remote dev box) cannot reach the
  // loopback callback, so the operator pastes the redirect URL instead.
  parsePastedInput(input: string): string | null
  stop(): void
}

export function suggestGithubAppName(agentDir: string): string {
  const slug = basename(agentDir)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return slug === '' ? 'typeclaw-agent' : slug
}

export function validateGithubAppName(name: string): string | undefined {
  if (name === '') return 'App name is required'
  return APP_SLUG_RE.test(name) ? undefined : 'Use lowercase letters, digits, and hyphens'
}

export function validateGithubAppOwner(owner: string): string | undefined {
  if (owner === '') return undefined
  return OWNER_RE.test(owner) ? undefined : 'Enter an organization login, or leave blank for your personal account'
}

// A 404 only proves no *public* App uses the slug; another owner's private App
// can still hold it, and GitHub's confirmation page rejects that case.
export async function checkGithubAppName(name: string, fetchImpl: typeof fetch = fetch): Promise<GithubAppNameStatus> {
  try {
    const response = await fetchImpl(`${GITHUB_API_BASE}/apps/${encodeURIComponent(name)}`, {
      headers: githubPublicHeaders(),
    })
    if (response.status === 200) return 'taken'
    if (response.status === 404) return 'available'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

export function buildGithubAppManifest(options: { name: string; redirectUrl: string }): Record<string, unknown> {
  // No hook_attributes: TypeClaw registers its own repository webhooks.
  return {
    name: options.name,
    url: 'https://typeclaw.dev',
    redirect_url: options.redirectUrl,
    public: false,
    default_permissions: { ...GITHUB_APP_MANIFEST_PERMISSIONS },
  }
}

export function githubAppRegistrationUrl(owner: string | undefined, state: string): string {
  const base =
    owner === undefined || owner === ''
      ? 'https://github.com/settings/apps/new'
      : `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new`
  return `${base}?state=${encodeURIComponent(state)}`
}

export function githubAppInstallUrl(slug: string): string {
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`
}

export function startGithubAppManifestSession(options: { name: string; owner?: string }): GithubAppManifestSession {
  const state = randomBytes(16).toString('hex')
  let resolveCode!: (code: string) => void
  const code = new Promise<string>((resolve) => {
    resolveCode = resolve
  })
  let manifestJson = ''
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req): Response {
      const url = new URL(req.url)
      if (url.pathname === '/') {
        return new Response(registrationPage(options.owner, state, manifestJson), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        })
      }
      if (url.pathname === '/callback') {
        const received = url.searchParams.get('code')
        if (url.searchParams.get('state') !== state || received === null || !MANIFEST_CODE_RE.test(received)) {
          return new Response('This callback does not match the pending GitHub App registration.', { status: 400 })
        }
        resolveCode(received)
        return new Response('GitHub App created. Return to your terminal to finish setup; you can close this tab.', {
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        })
      }
      return new Response('Not found', { status: 404 })
    },
  })
  const origin = `http://127.0.0.1:${server.port}`
  manifestJson = JSON.stringify(buildGithubAppManifest({ name: options.name, redirectUrl: `${origin}/callback` }))
  return {
    url: `${origin}/`,
    code,
    parsePastedInput: (input) => parsePastedManifestCode(input, state),
    stop: () => {
      // Graceful: the callback that resolved `code` is still writing the
      // browser's success page when callers stop the session.
      void server.stop()
    },
  }
}

export function parsePastedManifestCode(input: string, expectedState: string): string | null {
  const trimmed = input.trim()
  if (MANIFEST_CODE_RE.test(trimmed)) return trimmed
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  const code = url.searchParams.get('code')
  if (code === null || !MANIFEST_CODE_RE.test(code)) return null
  return url.searchParams.get('state') === expectedState ? code : null
}

export async function exchangeGithubAppManifestCode(
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GithubAppCredentials> {
  if (!MANIFEST_CODE_RE.test(code)) throw new Error('GitHub App manifest code is malformed')
  const response = await fetchImpl(`${GITHUB_API_BASE}/app-manifests/${code}/conversions`, {
    method: 'POST',
    headers: githubPublicHeaders(),
  })
  if (!response.ok) {
    throw new Error(
      `GitHub rejected the App manifest code (${response.status}). Codes work once and expire after an hour.`,
    )
  }
  const raw = (await response.json()) as { id?: unknown; slug?: unknown; pem?: unknown; html_url?: unknown }
  if (typeof raw.id !== 'number' || raw.id <= 0) throw new Error('GitHub App conversion returned no App ID')
  if (typeof raw.slug !== 'string' || raw.slug === '') throw new Error('GitHub App conversion returned no slug')
  if (typeof raw.pem !== 'string' || !raw.pem.startsWith('-----BEGIN')) {
    throw new Error('GitHub App conversion returned no private key')
  }
  return {
    appId: raw.id,
    slug: raw.slug,
    privateKey: raw.pem,
    htmlUrl: typeof raw.html_url === 'string' ? raw.html_url : `https://github.com/apps/${raw.slug}`,
  }
}

export async function waitForGithubAppInstallation(options: {
  appId: number
  privateKey: string
  signal: AbortSignal
  fetchImpl?: typeof fetch
  pollIntervalMs?: number
}): Promise<{ repos: string[] }> {
  const baseFetch = options.fetchImpl ?? fetch
  const signal = options.signal
  // Every GitHub request, including the ones AppAuthStrategy makes, carries the
  // deadline so expiry also cancels a request that is still in flight.
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
    baseFetch(input, { ...init, signal })) as typeof fetch
  const pollIntervalMs = options.pollIntervalMs ?? 3000
  const strategy = new AppAuthStrategy({ appId: options.appId, privateKey: { value: options.privateKey }, fetchImpl })
  let token: string
  while (true) {
    signal.throwIfAborted()
    try {
      token = await strategy.token()
      break
    } catch (error) {
      signal.throwIfAborted()
      if (!(error instanceof Error) || error.message !== NO_INSTALLATION_MESSAGE) throw error
    }
    await abortableDelay(pollIntervalMs, signal)
  }
  return { repos: await listInstallationRepos(token, fetchImpl) }
}

async function listInstallationRepos(token: string, fetchImpl: typeof fetch): Promise<string[]> {
  const repos: string[] = []
  for (let page = 1; ; page++) {
    const response = await fetchImpl(
      `${GITHUB_API_BASE}/installation/repositories?per_page=${REPOS_PAGE_SIZE}&page=${page}`,
      { headers: githubJsonHeaders(token) },
    )
    if (!response.ok) throw new Error(`GitHub App installation repositories fetch failed: ${response.status}`)
    const raw = (await response.json()) as { repositories?: Array<{ full_name?: unknown }> }
    const batch = raw.repositories ?? []
    for (const repo of batch) if (typeof repo.full_name === 'string') repos.push(repo.full_name)
    if (batch.length < REPOS_PAGE_SIZE) break
  }
  return repos.sort((a, b) => a.localeCompare(b))
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function registrationPage(owner: string | undefined, state: string, manifestJson: string): string {
  const action = escapeHtml(githubAppRegistrationUrl(owner, state))
  return [
    '<!doctype html>',
    '<meta charset="utf-8">',
    '<title>Create GitHub App</title>',
    `<form id="manifest" action="${action}" method="post">`,
    `<input type="hidden" name="manifest" value="${escapeHtml(manifestJson)}">`,
    '<noscript><button type="submit">Continue to GitHub</button></noscript>',
    '</form>',
    '<script>document.getElementById("manifest").submit()</script>',
  ].join('\n')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
