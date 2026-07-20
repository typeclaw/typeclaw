import { afterEach, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import path from 'node:path'

import { SESSION_TMP_ROOT } from '@/sandbox'

import { TYPECLAW_GIT_ASKPASS_PATH } from './git-askpass'
import { prepareReviewerCheckout } from './review-checkout'

const SHA = '0123456789abcdef0123456789abcdef01234567'
const sessionId = `review-checkout-${process.pid}`

afterEach(async () => {
  await rm(path.join(SESSION_TMP_ROOT, sessionId), { recursive: true, force: true })
})

describe('prepareReviewerCheckout', () => {
  test('scopes the token to the verified repo fetch and checks out token-free', async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = []
    const receipt = await prepareReviewerCheckout({
      repoSlug: 'acme/widgets',
      headSha: SHA,
      sessionId,
      resolveTokenForRepo: async (slug) =>
        slug === 'acme/widgets' ? { kind: 'token', token: 'ghs_secret' } : { kind: 'unavailable', reason: 'denied' },
      fetchImpl: async (input, init) => {
        expect(String(input)).toContain(`/repos/acme/widgets/commits/${SHA}`)
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ghs_secret')
        return new Response(JSON.stringify({ sha: SHA }))
      },
      ensureAskPass: async () => '/safe/typeclaw-git-askpass',
      runProcess: async (_file, args, options) => {
        calls.push({ args, env: options.env })
      },
    })

    expect(receipt.path).toStartWith(path.join(SESSION_TMP_ROOT, sessionId, 'review-checkout-'))
    expect(calls).toHaveLength(3)
    expect(calls.flatMap((call) => call.args).join(' ')).not.toContain('ghs_secret')
    expect(calls[1]?.env.TYPECLAW_GIT_TOKEN).toBe('ghs_secret')
    expect(calls[2]?.env.TYPECLAW_GIT_TOKEN).toBeUndefined()
    expect(calls[1]?.args).toContain('credential.helper=')
    expect(calls[1]?.args).toContain('core.hooksPath=/dev/null')
    expect(calls[2]?.args).toContain(SHA)
  })

  test('rejects non-full SHAs before token resolution', async () => {
    let resolved = false
    await expect(
      prepareReviewerCheckout({
        repoSlug: 'acme/widgets',
        headSha: 'abc123',
        sessionId,
        resolveTokenForRepo: async () => {
          resolved = true
          return { kind: 'token', token: 'secret' }
        },
      }),
    ).rejects.toThrow(/full 40-character/i)
    expect(resolved).toBe(false)
  })

  test('uses the image-baked askpass path without a runtime write', async () => {
    const calls: Array<{ env: NodeJS.ProcessEnv }> = []
    await prepareReviewerCheckout({
      repoSlug: 'acme/widgets',
      headSha: SHA,
      sessionId,
      resolveTokenForRepo: async () => ({ kind: 'token', token: 'ghs_secret' }),
      fetchImpl: async () => new Response(JSON.stringify({ sha: SHA })),
      runProcess: async (_file, _args, options) => {
        calls.push({ env: options.env })
      },
    })
    expect(calls[1]?.env.GIT_ASKPASS).toBe(TYPECLAW_GIT_ASKPASS_PATH)
  })

  test('rejects a commit verification response for a different SHA', async () => {
    await expect(
      prepareReviewerCheckout({
        repoSlug: 'acme/widgets',
        headSha: SHA,
        sessionId,
        resolveTokenForRepo: async () => ({ kind: 'token', token: 'secret' }),
        fetchImpl: async () => new Response(JSON.stringify({ sha: 'f'.repeat(40) })),
      }),
    ).rejects.toThrow(/different SHA/i)
  })
})
