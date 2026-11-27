import { describe, expect, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'

import {
  checkGithubAppName,
  exchangeGithubAppManifestCode,
  githubAppRegistrationUrl,
  parsePastedManifestCode,
  startGithubAppManifestSession,
  suggestGithubAppName,
  validateGithubAppName,
  waitForGithubAppInstallation,
} from './github-app-manifest'

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs1', format: 'pem' })
  .toString()

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function fakeFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)) as typeof fetch
}

function unescapeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

describe('suggestGithubAppName', () => {
  test('slugifies the agent folder name', () => {
    expect(suggestGithubAppName('/agents/My Agent_v2')).toBe('my-agent-v2')
  })

  test('falls back when the folder name has no usable characters', () => {
    expect(suggestGithubAppName('/agents/에이전트')).toBe('typeclaw-agent')
  })
})

describe('validateGithubAppName', () => {
  test('accepts a lowercase hyphenated slug and rejects anything that would not be one', () => {
    expect(validateGithubAppName('my-agent-2')).toBeUndefined()
    expect(validateGithubAppName('My Agent')).toBeDefined()
    expect(validateGithubAppName('-agent')).toBeDefined()
    expect(validateGithubAppName('')).toBeDefined()
  })
})

describe('checkGithubAppName', () => {
  test('maps the public App lookup to taken, available, or unknown', async () => {
    const statusFor = (status: number) =>
      checkGithubAppName(
        'my-agent',
        fakeFetch(() => new Response('', { status })),
      )
    expect(await statusFor(200)).toBe('taken')
    expect(await statusFor(404)).toBe('available')
    expect(await statusFor(503)).toBe('unknown')
    expect(
      await checkGithubAppName(
        'my-agent',
        fakeFetch(() => {
          throw new Error('offline')
        }),
      ),
    ).toBe('unknown')
  })
})

describe('startGithubAppManifestSession', () => {
  test('serves a form that posts the manifest to the owner registration page with a loopback redirect', async () => {
    const session = startGithubAppManifestSession({ name: 'my-agent', owner: 'acme-corp' })
    try {
      const html = await (await fetch(session.url)).text()
      const action = unescapeHtml(/action="([^"]+)"/.exec(html)?.[1] ?? '')
      const manifest = JSON.parse(unescapeHtml(/name="manifest" value="([^"]+)"/.exec(html)?.[1] ?? '{}'))

      expect(action).toStartWith('https://github.com/organizations/acme-corp/settings/apps/new?state=')
      expect(manifest.name).toBe('my-agent')
      expect(manifest.public).toBe(false)
      expect(manifest.hook_attributes).toBeUndefined()
      expect(manifest.redirect_url).toBe(new URL('/callback', session.url).toString())
      expect(manifest.default_permissions).toMatchObject({
        repository_hooks: 'write',
        checks: 'write',
        statuses: 'read',
      })
    } finally {
      session.stop()
    }
  })

  test('resolves the code only for a callback carrying the registration state', async () => {
    const session = startGithubAppManifestSession({ name: 'my-agent' })
    try {
      const html = await (await fetch(session.url)).text()
      const state = new URL(unescapeHtml(/action="([^"]+)"/.exec(html)?.[1] ?? '')).searchParams.get('state')
      const callback = new URL('/callback', session.url)

      callback.search = new URLSearchParams({ code: 'forged', state: 'wrong' }).toString()
      expect((await fetch(callback)).status).toBe(400)

      callback.search = new URLSearchParams({ code: 'abc123', state: state ?? '' }).toString()
      expect((await fetch(callback)).status).toBe(200)
      expect(await session.code).toBe('abc123')
    } finally {
      session.stop()
    }
  })

  test('still delivers the success page when the caller stops the session as soon as the code arrives', async () => {
    const session = startGithubAppManifestSession({ name: 'my-agent' })
    void session.code.then(() => session.stop())
    const html = await (await fetch(session.url)).text()
    const state = new URL(unescapeHtml(/action="([^"]+)"/.exec(html)?.[1] ?? '')).searchParams.get('state')
    const callback = new URL('/callback', session.url)
    callback.search = new URLSearchParams({ code: 'abc123', state: state ?? '' }).toString()

    const response = await fetch(callback)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('GitHub App created')
  })
})

describe('parsePastedManifestCode', () => {
  test('accepts a bare code or a redirect URL whose state matches', () => {
    expect(parsePastedManifestCode(' abc123 ', 'st')).toBe('abc123')
    expect(parsePastedManifestCode('http://127.0.0.1:5000/callback?code=abc123&state=st', 'st')).toBe('abc123')
  })

  test('rejects a redirect URL with another state, and input that is neither', () => {
    expect(parsePastedManifestCode('http://127.0.0.1:5000/callback?code=abc123&state=other', 'st')).toBeNull()
    expect(parsePastedManifestCode('not a code', 'st')).toBeNull()
  })
})

describe('githubAppRegistrationUrl', () => {
  test('targets the personal registration page when no owner is given', () => {
    expect(githubAppRegistrationUrl(undefined, 'st')).toBe('https://github.com/settings/apps/new?state=st')
  })
})

describe('exchangeGithubAppManifestCode', () => {
  test('returns the App ID, slug, and private key from the conversion', async () => {
    let requested: { url: string; method?: string } | undefined
    const credentials = await exchangeGithubAppManifestCode(
      'abc123',
      fakeFetch((url, init) => {
        requested = { url, method: init?.method }
        return jsonResponse({ id: 42, slug: 'my-agent', pem: privateKey, html_url: 'https://github.com/apps/my-agent' })
      }),
    )

    expect(requested).toEqual({ url: 'https://api.github.com/app-manifests/abc123/conversions', method: 'POST' })
    expect(credentials).toEqual({
      appId: 42,
      slug: 'my-agent',
      privateKey,
      htmlUrl: 'https://github.com/apps/my-agent',
    })
  })

  test('fails on a rejected code or a response without a private key', async () => {
    await expect(
      exchangeGithubAppManifestCode(
        'abc123',
        fakeFetch(() => jsonResponse({ message: 'Not Found' }, 404)),
      ),
    ).rejects.toThrow('rejected')
    await expect(
      exchangeGithubAppManifestCode(
        'abc123',
        fakeFetch(() => jsonResponse({ id: 42, slug: 'my-agent' })),
      ),
    ).rejects.toThrow('private key')
  })
})

describe('waitForGithubAppInstallation', () => {
  test('polls until the App is installed, then lists every accessible repository', async () => {
    let installationPolls = 0
    const pageOne = Array.from({ length: 100 }, (_, i) => ({
      full_name: `acme-corp/repo-${String(i).padStart(3, '0')}`,
    }))
    const fetchImpl = fakeFetch((url) => {
      const { pathname, searchParams } = new URL(url)
      if (pathname === '/app/installations') {
        installationPolls++
        return jsonResponse(installationPolls < 3 ? [] : [{ id: 7 }])
      }
      if (pathname === '/app/installations/7/access_tokens') {
        return jsonResponse({ token: 'ghs_test', expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201)
      }
      if (pathname === '/installation/repositories') {
        return jsonResponse({
          repositories: searchParams.get('page') === '1' ? pageOne : [{ full_name: 'acme-corp/api' }],
        })
      }
      return jsonResponse({}, 404)
    })

    const result = await waitForGithubAppInstallation({
      appId: 42,
      privateKey,
      signal: new AbortController().signal,
      fetchImpl,
      pollIntervalMs: 0,
    })

    expect(installationPolls).toBe(3)
    expect(result.repos).toHaveLength(101)
    expect(result.repos[0]).toBe('acme-corp/api')
  })

  test('the deadline cancels a GitHub request that is still in flight', async () => {
    const controller = new AbortController()
    let requestStarted!: () => void
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve
    })
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestStarted()
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    }) as typeof fetch

    const waiting = waitForGithubAppInstallation({ appId: 42, privateKey, signal: controller.signal, fetchImpl })
    await started
    controller.abort(new Error('deadline'))

    await expect(waiting).rejects.toThrow('deadline')
  })

  test('stops polling when aborted', async () => {
    const controller = new AbortController()
    const fetchImpl = fakeFetch((url) => {
      if (new URL(url).pathname === '/app/installations') {
        controller.abort(new Error('gave up'))
        return jsonResponse([])
      }
      return jsonResponse({}, 404)
    })

    await expect(
      waitForGithubAppInstallation({ appId: 42, privateKey, signal: controller.signal, fetchImpl, pollIntervalMs: 0 }),
    ).rejects.toThrow('gave up')
  })
})
