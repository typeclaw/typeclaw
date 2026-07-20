import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { z } from 'zod'

import { GITHUB_API_BASE, githubJsonHeaders } from '@/channels/adapters/github/auth-pat'
import type { ResolveGithubTokenForRepo } from '@/channels/github-token-bridge'
import { defineTool } from '@/plugin'
import { ensureSessionTmpDir } from '@/sandbox'

import { TYPECLAW_GIT_ASKPASS_PATH } from './git-askpass'

const execFileAsync = promisify(execFile)
const FULL_SHA = /^[0-9a-f]{40}$/i
const REPO_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

type RunProcess = (file: string, args: string[], options: { env: NodeJS.ProcessEnv }) => Promise<void>
type GithubFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export async function prepareReviewerCheckout(options: {
  repoSlug: string
  headSha: string
  sessionId: string
  resolveTokenForRepo: ResolveGithubTokenForRepo
  fetchImpl?: GithubFetch
  runProcess?: RunProcess
  ensureAskPass?: () => Promise<string>
}): Promise<{ path: string; repoSlug: string; headSha: string }> {
  if (!REPO_SLUG.test(options.repoSlug)) throw new Error('repository must be one owner/repo slug')
  if (!FULL_SHA.test(options.headSha)) throw new Error('headSha must be a full 40-character commit SHA')
  const tokenResult = await options.resolveTokenForRepo(options.repoSlug)
  if (tokenResult.kind !== 'token') throw new Error(tokenResult.reason)
  const token = tokenResult.token
  await verifyCommit(options.fetchImpl ?? fetch, options.repoSlug, options.headSha, token)

  const sessionRoot = await ensureSessionTmpDir(options.sessionId)
  const checkout = await mkdtemp(path.join(sessionRoot, 'review-checkout-'))
  const run = options.runProcess ?? defaultRunProcess
  try {
    const baseEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: sessionRoot,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    }
    await run('git', ['init', '--quiet', checkout], { env: baseEnv })
    const askPass = options.ensureAskPass === undefined ? TYPECLAW_GIT_ASKPASS_PATH : await options.ensureAskPass()
    await run(
      'git',
      [
        '-C',
        checkout,
        '-c',
        'credential.helper=',
        '-c',
        'core.hooksPath=/dev/null',
        'fetch',
        '--depth=1',
        `https://github.com/${options.repoSlug}.git`,
        options.headSha,
      ],
      { env: { ...baseEnv, GIT_ASKPASS: askPass, TYPECLAW_GIT_TOKEN: token } },
    )
    await run(
      'git',
      [
        '-C',
        checkout,
        '-c',
        'credential.helper=',
        '-c',
        'core.hooksPath=/dev/null',
        'checkout',
        '--quiet',
        '--detach',
        options.headSha,
      ],
      { env: baseEnv },
    )
    return { path: checkout, repoSlug: options.repoSlug, headSha: options.headSha.toLocaleLowerCase() }
  } catch (error) {
    await rm(checkout, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

export function createReviewerCheckoutTool(resolveTokenForRepo: ResolveGithubTokenForRepo) {
  return defineTool({
    description:
      'Prepare a runtime-owned token-safe scratch checkout of one allowlisted GitHub repository at an exact full commit SHA.',
    parameters: z.object({ repoSlug: z.string(), headSha: z.string() }),
    // `repoSlug` ("owner/repo") and `headSha` (40-hex) are remote GitHub
    // coordinates, never local paths — repoSlug is only ever interpolated into
    // `https://github.com/<slug>.git` and prepareReviewerCheckout rejects
    // anything not matching /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/. Declared so the
    // required "/" in a slug isn't misread as a path separator. Scoped to THIS
    // tool: an undeclared reader passing a slug-shaped value still fails closed.
    fileOperands: { nonFile: ['repoSlug', 'headSha'] },
    async execute(args, ctx) {
      try {
        const receipt = await prepareReviewerCheckout({
          repoSlug: args.repoSlug,
          headSha: args.headSha,
          sessionId: ctx.sessionId,
          resolveTokenForRepo,
        })
        return {
          content: [{ type: 'text' as const, text: `Reviewer checkout ready: ${receipt.path} @ ${receipt.headSha}` }],
          details: { ok: true, ...receipt },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          content: [{ type: 'text' as const, text: `Reviewer checkout failed: ${message}` }],
          details: { ok: false, error: message },
        }
      }
    },
  })
}

async function verifyCommit(fetchImpl: GithubFetch, repoSlug: string, sha: string, token: string): Promise<void> {
  const response = await fetchImpl(`${GITHUB_API_BASE}/repos/${repoSlug}/commits/${sha}`, {
    headers: githubJsonHeaders(token),
    redirect: 'error',
  })
  if (!response.ok) throw new Error(`GitHub could not verify ${repoSlug}@${sha} (${response.status})`)
  const body = (await response.json().catch(() => null)) as { sha?: unknown } | null
  if (typeof body?.sha !== 'string' || body.sha.toLocaleLowerCase() !== sha.toLocaleLowerCase())
    throw new Error('GitHub commit verification returned a different SHA')
}

async function defaultRunProcess(file: string, args: string[], options: { env: NodeJS.ProcessEnv }): Promise<void> {
  await execFileAsync(file, args, { ...options, maxBuffer: 1024 * 1024 })
}
