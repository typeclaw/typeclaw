import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as z from 'zod'

import { configSchema, dockerfileSchema } from '@/config/config'
import type { DockerExec } from '@/container'

import { buildDockerfile } from './dockerfile'
import { buildGitignore } from './gitignore'
import {
  defaultRunHatching,
  findAgentDir,
  hasExistingChannelSecrets,
  hasExistingOAuthCredentials,
  type HatchingResult,
  type HatchRunner,
  initGitRepo,
  type InitStepEvent,
  type InstallRunner,
  isDirectoryNonEmpty,
  isHatched,
  isInitialized,
  readExistingProviderApiKey,
  runInit,
  scaffold,
  writeDockerAssets,
  writeSecrets,
} from './index'
import { makeFakeOAuthLoginRunner } from './oauth-login'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-init-'))
})

const okHatch: HatchRunner = async () => ({ ok: true }) as HatchingResult

// Default exec stub for tests: pretends docker is installed and the daemon
// is reachable. Tests that exercise the preflight failure path override this
// with their own DockerExec to simulate ENOENT or daemon-down conditions.
const okDocker: DockerExec = async () => ({ exitCode: 0, stdout: '29.4.0\n', stderr: '' })

// Default install stub for tests: pretends `bun install` succeeded without
// shelling out. The real installer fans 500+ HTTP requests at npm with no
// lockfile, which both wastes ~5s per test and exposes us to the Bun 1.3.x
// isolated-linker fetch deadlock (oven-sh/bun#26341). The runInit pipeline
// tests verify composition — step ordering, event emission, failure
// propagation — not the install primitive itself, so we never need a real
// install here. Tests that exercise the failure path override this with their
// own InstallRunner.
const okInstall: InstallRunner = async () => ({ ok: true })

// Hermetic stub for the eager github webhook install path. Returns empty
// hook lists and successful POSTs so runInit's github branch never reaches
// the real api.github.com. Tests that assert webhook side effects use a
// recording variant instead.
const okGithubFetch: typeof fetch = (() => {
  let nextId = 100
  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method ?? 'GET'
    if (/\/hooks(\?|$)/.test(url) && method === 'GET') return Response.json([])
    if (url.endsWith('/hooks') && method === 'POST') return Response.json({ id: nextId++ }, { status: 201 })
    return new Response('unexpected', { status: 500 })
  }
  return Object.assign(handler, { preconnect: () => {} }) as typeof fetch
})()

function captureHatch(): { runner: HatchRunner; calls: Array<{ cwd: string; port: number; cliEntry?: string }> } {
  const calls: Array<{ cwd: string; port: number; cliEntry?: string }> = []
  const runner: HatchRunner = async (options) => {
    calls.push(options)
    return { ok: true }
  }
  return { runner, calls }
}

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function runGit(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out.trim()
}

async function readSecrets(root: string): Promise<{
  providers?: Record<string, unknown>
  channels?: Record<string, Record<string, unknown>>
}> {
  return JSON.parse(await readFile(join(root, 'secrets.json'), 'utf8')) as {
    providers?: Record<string, unknown>
    channels?: Record<string, Record<string, unknown>>
  }
}

describe('runInit', () => {
  test('runs scaffold, install, dockerfile, git, and hatching steps in order', async () => {
    const events: InitStepEvent[] = []

    await runInit({
      cwd: root,
      apiKey: 'fw_test_key',
      runHatching: okHatch,
      runBunInstall: okInstall,
      dockerExec: okDocker,
      onProgress: (e) => events.push(e),
    })

    expect(events.map((e) => `${e.step}:${e.phase}`)).toEqual([
      'preflight:start',
      'preflight:done',
      'scaffold:start',
      'scaffold:done',
      'install:start',
      'install:done',
      'dockerfile:start',
      'dockerfile:done',
      'git:start',
      'git:done',
      'hatching:start',
      'hatching:done',
    ])
  })

  test('hatching runs after git (sees committed agent folder)', async () => {
    const seenAt: Array<{ hasGit: boolean; hasDockerfile: boolean }> = []
    const runHatching: HatchRunner = async ({ cwd }) => {
      seenAt.push({
        hasGit: existsSync(join(cwd, '.git')),
        hasDockerfile: existsSync(join(cwd, 'Dockerfile')),
      })
      return { ok: true }
    }

    await runInit({ cwd: root, apiKey: 'fw_test_key', runHatching, runBunInstall: okInstall, dockerExec: okDocker })

    expect(seenAt).toEqual([{ hasGit: true, hasDockerfile: true }])
  })

  test('hatching receives the init cwd and the configured port', async () => {
    const { runner, calls } = captureHatch()

    await runInit({
      cwd: root,
      apiKey: 'fw_test_key',
      runHatching: runner,
      runBunInstall: okInstall,
      dockerExec: okDocker,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.cwd).toBe(root)
    expect(calls[0]?.port).toBeGreaterThan(0)
  })

  test('hatching forwards cliEntry when runInit receives it', async () => {
    const { runner, calls } = captureHatch()

    await runInit({
      cwd: root,
      apiKey: 'fw_test_key',
      runHatching: runner,
      runBunInstall: okInstall,
      dockerExec: okDocker,
      cliEntry: '/fake/cli/entry.ts',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.cliEntry).toBe('/fake/cli/entry.ts')
  })

  test('hatching omits cliEntry when runInit is called without it', async () => {
    const { runner, calls } = captureHatch()

    await runInit({
      cwd: root,
      apiKey: 'fw_test_key',
      runHatching: runner,
      runBunInstall: okInstall,
      dockerExec: okDocker,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.cliEntry).toBeUndefined()
  })

  test('hatching failure is reported via event, not thrown', async () => {
    const runHatching: HatchRunner = async () => ({ ok: false, reason: 'simulated boom' })
    const events: InitStepEvent[] = []

    await runInit({
      cwd: root,
      apiKey: 'fw_test_key',
      runHatching,
      runBunInstall: okInstall,
      dockerExec: okDocker,
      onProgress: (e) => events.push(e),
    })

    const hatchDone = events.find((e) => e.step === 'hatching' && e.phase === 'done')
    if (!(hatchDone && hatchDone.step === 'hatching' && hatchDone.phase === 'done')) {
      throw new Error('expected hatching:done')
    }
    expect(hatchDone.result).toEqual({ ok: false, reason: 'simulated boom' })
  })

  test('produces an initialized agent folder (config, secrets, markdown, git repo)', async () => {
    await runInit({
      cwd: root,
      apiKey: 'fw_integration_key',
      model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo',
      runHatching: okHatch,
      runBunInstall: okInstall,
      dockerExec: okDocker,
    })

    expect(isInitialized(root)).toBe(true)
    expect((await readSecrets(root)).providers?.fireworks).toEqual({
      type: 'api_key',
      key: { value: 'fw_integration_key' },
    })
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(true)
    expect(existsSync(join(root, '.git'))).toBe(true)
    expect(await runGit(root, ['log', '--oneline'])).toContain('Initial commit 🥚')
  })

  test('git step sees scaffolded files (step ordering)', async () => {
    await runInit({
      cwd: root,
      apiKey: 'fw_test_key',
      runHatching: okHatch,
      runBunInstall: okInstall,
      dockerExec: okDocker,
    })

    const tracked = (await runGit(root, ['ls-files'])).split('\n')
    expect(tracked).toContain('typeclaw.json')
    expect(tracked).toContain('cron.json')
    expect(tracked).toContain('package.json')
    expect(tracked).toContain('.gitignore')
    expect(tracked).toContain('AGENTS.md')
    // packages/.gitkeep must be tracked so cloning the agent folder onto a
    // fresh machine still has the workspace root present (git ignores empty dirs).
    expect(tracked).toContain('packages/.gitkeep')
    // Dockerfile is gitignored (regenerated on every `typeclaw start`),
    // so it must NOT appear in the initial commit even though it exists on disk.
    expect(tracked).not.toContain('Dockerfile')
    expect(existsSync(join(root, 'Dockerfile'))).toBe(true)
  })

  test('dockerfile step writes Dockerfile and reports devMode via event', async () => {
    const events: InitStepEvent[] = []

    await runInit({
      cwd: root,
      apiKey: 'fw_test_key',
      runHatching: okHatch,
      runBunInstall: okInstall,
      dockerExec: okDocker,
      onProgress: (e) => events.push(e),
    })

    expect(existsSync(join(root, 'Dockerfile'))).toBe(true)

    const dockerDone = events.find((e) => e.step === 'dockerfile' && e.phase === 'done')
    if (!(dockerDone && dockerDone.step === 'dockerfile' && dockerDone.phase === 'done' && dockerDone.result.ok)) {
      throw new Error('expected dockerfile:done with ok result')
    }
    expect(dockerDone.result.devMode).toBe(true)
  })

  test('Dockerfile installs git so agents can use it at runtime', async () => {
    await runInit({
      cwd: root,
      apiKey: 'fw_test_key',
      runHatching: okHatch,
      runBunInstall: okInstall,
      dockerExec: okDocker,
      onProgress: () => {},
    })

    const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8')
    expect(dockerfile).toMatch(/apt-get[\s\S]+install[\s\S]+\bgit\b/)
  })

  test('emits git done event with skipped: false when repo is freshly initialized', async () => {
    const events: InitStepEvent[] = []

    await runInit({
      cwd: root,
      apiKey: 'fw_test_key',
      runHatching: okHatch,
      runBunInstall: okInstall,
      dockerExec: okDocker,
      onProgress: (e) => events.push(e),
    })

    const gitDone = events.find((e) => e.step === 'git' && e.phase === 'done')
    if (!(gitDone && gitDone.step === 'git' && gitDone.phase === 'done' && gitDone.result.ok)) {
      throw new Error('expected git:done with ok result')
    }
    expect(gitDone.result.skipped).toBe(false)
  })

  test('skips git init when .git already exists', async () => {
    await mkdir(join(root, '.git'))
    const events: InitStepEvent[] = []

    await runInit({
      cwd: root,
      apiKey: 'fw_test_key',
      runHatching: okHatch,
      runBunInstall: okInstall,
      dockerExec: okDocker,
      onProgress: (e) => events.push(e),
    })

    const gitDone = events.find((e) => e.step === 'git' && e.phase === 'done')
    if (!(gitDone && gitDone.step === 'git' && gitDone.phase === 'done' && gitDone.result.ok)) {
      throw new Error('expected git:done with ok result')
    }
    expect(gitDone.result.skipped).toBe(true)
  })

  test('step failure is reported via event, not thrown, and later steps still run', async () => {
    // given: invalid package.json so writeDockerAssets fails to parse it.
    // scaffold preserves existing package.json, so this sticks through the pipeline.
    await writeFile(join(root, 'package.json'), '{ not valid json')
    const events: InitStepEvent[] = []

    // when
    await runInit({
      cwd: root,
      apiKey: 'fw_test_key',
      runHatching: okHatch,
      runBunInstall: okInstall,
      dockerExec: okDocker,
      onProgress: (e) => events.push(e),
    })

    // then: dockerfile failed softly, git and hatching still ran
    const dockerDone = events.find((e) => e.step === 'dockerfile' && e.phase === 'done')
    if (!(dockerDone && dockerDone.step === 'dockerfile' && dockerDone.phase === 'done')) {
      throw new Error('expected dockerfile:done')
    }
    expect(dockerDone.result.ok).toBe(false)

    const steps = events.map((e) => `${e.step}:${e.phase}`)
    expect(steps).toContain('git:start')
    expect(steps).toContain('git:done')
    expect(steps).toContain('hatching:start')
    expect(steps).toContain('hatching:done')
  })

  test('works without onProgress callback', async () => {
    await runInit({
      cwd: root,
      apiKey: 'fw_test_key',
      runHatching: okHatch,
      runBunInstall: okInstall,
      dockerExec: okDocker,
    })

    expect(isInitialized(root)).toBe(true)
  })

  test('is idempotent: re-running after a failed hatching re-runs all steps without crashing', async () => {
    // given: a prior run where hatching failed (e.g. docker daemon was down).
    const failingHatch: HatchRunner = async () => ({ ok: false, reason: 'docker build failed' })
    await runInit({
      cwd: root,
      apiKey: 'fw_first_key',
      model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo',
      runHatching: failingHatch,
      runBunInstall: okInstall,
      dockerExec: okDocker,
    })
    expect(isInitialized(root)).toBe(true)
    expect(await isHatched(root)).toBe(false)

    // when: the user retries `typeclaw init` with a working setup.
    const events: InitStepEvent[] = []
    await runInit({
      cwd: root,
      apiKey: 'fw_second_key',
      model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo',
      runHatching: okHatch,
      runBunInstall: okInstall,
      dockerExec: okDocker,
      onProgress: (e) => events.push(e),
    })

    // then: every step ran again, and git step reports skipped because the repo already exists.
    expect(events.map((e) => `${e.step}:${e.phase}`)).toEqual([
      'preflight:start',
      'preflight:done',
      'scaffold:start',
      'scaffold:done',
      'install:start',
      'install:done',
      'dockerfile:start',
      'dockerfile:done',
      'git:start',
      'git:done',
      'hatching:start',
      'hatching:done',
    ])
    const gitDone = events.find((e) => e.step === 'git' && e.phase === 'done')
    if (!(gitDone && gitDone.step === 'git' && gitDone.phase === 'done' && gitDone.result.ok)) {
      throw new Error('expected git:done with ok result')
    }
    expect(gitDone.result.skipped).toBe(true)
    expect((await readSecrets(root)).providers?.fireworks).toEqual({ type: 'api_key', key: { value: 'fw_second_key' } })
  })

  test('aborts before scaffolding when docker binary is missing', async () => {
    // given: an exec stub that simulates Bun.spawn's ENOENT path
    // (defaultDockerExec catches the throw and returns this exact stderr).
    const missingDocker: DockerExec = async () => ({
      exitCode: -1,
      stdout: '',
      stderr: 'docker: command not found in $PATH',
    })
    const events: InitStepEvent[] = []

    // when
    await runInit({
      cwd: root,
      apiKey: 'fw_test_key',
      runHatching: okHatch,
      runBunInstall: okInstall,
      dockerExec: missingDocker,
      onProgress: (e) => events.push(e),
    })

    // then: only the preflight step ran; nothing else.
    expect(events.map((e) => `${e.step}:${e.phase}`)).toEqual(['preflight:start', 'preflight:done'])
    const preflightDone = events.find((e) => e.step === 'preflight' && e.phase === 'done')
    if (!(preflightDone && preflightDone.step === 'preflight' && preflightDone.phase === 'done')) {
      throw new Error('expected preflight:done')
    }
    expect(preflightDone.result).toEqual({
      ok: false,
      reason: 'binary-missing',
      detail: 'docker: command not found in $PATH',
    })

    // then: nothing was written to disk — the agent folder must look exactly
    // as it did before runInit was called, so the user can re-run init after
    // installing docker without manual cleanup.
    expect(isInitialized(root)).toBe(false)
    expect(existsSync(join(root, '.env'))).toBe(false)
    expect(existsSync(join(root, 'package.json'))).toBe(false)
    expect(existsSync(join(root, 'Dockerfile'))).toBe(false)
    expect(existsSync(join(root, '.git'))).toBe(false)
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(false)
    expect(existsSync(join(root, 'workspace'))).toBe(false)
    expect(existsSync(join(root, 'packages'))).toBe(false)
  })

  test('aborts before scaffolding when docker daemon is unreachable', async () => {
    const daemonDown: DockerExec = async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n',
    })
    const events: InitStepEvent[] = []

    await runInit({
      cwd: root,
      apiKey: 'fw_test_key',
      runHatching: okHatch,
      runBunInstall: okInstall,
      dockerExec: daemonDown,
      onProgress: (e) => events.push(e),
    })

    expect(events.map((e) => `${e.step}:${e.phase}`)).toEqual(['preflight:start', 'preflight:done'])
    const preflightDone = events.find((e) => e.step === 'preflight' && e.phase === 'done')
    if (!(preflightDone && preflightDone.step === 'preflight' && preflightDone.phase === 'done')) {
      throw new Error('expected preflight:done')
    }
    expect(preflightDone.result.ok).toBe(false)
    if (preflightDone.result.ok) throw new Error('unreachable')
    expect(preflightDone.result.reason).toBe('daemon-down')
    expect(preflightDone.result.detail).toContain('Cannot connect to the Docker daemon')

    expect(isInitialized(root)).toBe(false)
  })

  test('hatching is not invoked when preflight fails', async () => {
    const missingDocker: DockerExec = async () => ({
      exitCode: -1,
      stdout: '',
      stderr: 'docker: command not found in $PATH',
    })
    let hatchingInvoked = false
    const trackingHatch: HatchRunner = async () => {
      hatchingInvoked = true
      return { ok: true }
    }

    await runInit({
      cwd: root,
      apiKey: 'fw_test_key',
      runHatching: trackingHatch,
      runBunInstall: okInstall,
      dockerExec: missingDocker,
    })

    expect(hatchingInvoked).toBe(false)
  })

  test('OAuth path: emits oauth-login step, omits API key credentials, calls login runner with chosen model', async () => {
    const calls: Array<{ cwd: string; model: string; providerId: string }> = []
    const fakeLogin = makeFakeOAuthLoginRunner({
      onCalled: (opts) => {
        calls.push({ cwd: opts.cwd, model: opts.model, providerId: opts.providerId })
      },
    })
    const events: InitStepEvent[] = []

    await runInit({
      cwd: root,
      model: 'openai-codex/gpt-5.5',
      llmAuth: { kind: 'oauth', runLogin: fakeLogin },
      runHatching: okHatch,
      runBunInstall: okInstall,
      dockerExec: okDocker,
      onProgress: (e) => events.push(e),
    })

    expect(calls).toEqual([{ cwd: root, model: 'openai-codex/gpt-5.5', providerId: 'openai-codex' }])
    expect(events.map((e) => `${e.step}:${e.phase}`)).toEqual([
      'preflight:start',
      'preflight:done',
      'oauth-login:start',
      'oauth-login:done',
      'scaffold:start',
      'scaffold:done',
      'install:start',
      'install:done',
      'dockerfile:start',
      'dockerfile:done',
      'git:start',
      'git:done',
      'hatching:start',
      'hatching:done',
    ])
    expect(existsSync(join(root, '.env'))).toBe(false)
    expect(existsSync(join(root, 'secrets.json'))).toBe(false)
  })

  test('OAuth path: aborts before scaffold when login fails (no half-init folder)', async () => {
    const fakeLogin = makeFakeOAuthLoginRunner({ result: { ok: false, reason: 'browser closed' } })

    await expect(
      runInit({
        cwd: root,
        model: 'openai-codex/gpt-5.5',
        llmAuth: { kind: 'oauth', runLogin: fakeLogin },
        runHatching: okHatch,
        runBunInstall: okInstall,
        dockerExec: okDocker,
      }),
    ).rejects.toThrow(/OAuth login failed: browser closed/)

    // Scaffold-side artifacts must not exist.
    expect(existsSync(join(root, 'typeclaw.json'))).toBe(false)
    expect(existsSync(join(root, '.env'))).toBe(false)
  })

  test('OAuth path: skips oauth-login step on api-key path', async () => {
    const events: InitStepEvent[] = []

    await runInit({
      cwd: root,
      apiKey: 'fw_test_key',
      runHatching: okHatch,
      runBunInstall: okInstall,
      dockerExec: okDocker,
      onProgress: (e) => events.push(e),
    })

    expect(events.some((e) => e.step === 'oauth-login')).toBe(false)
  })

  test('oauth-completed: skips the oauth-login step and writes no API key', async () => {
    const events: InitStepEvent[] = []

    await runInit({
      cwd: root,
      model: 'openai-codex/gpt-5.5',
      llmAuth: { kind: 'oauth-completed' },
      runHatching: okHatch,
      runBunInstall: okInstall,
      dockerExec: okDocker,
      onProgress: (e) => events.push(e),
    })

    expect(events.some((e) => e.step === 'oauth-login')).toBe(false)
    expect(events.map((e) => `${e.step}:${e.phase}`)).toContain('scaffold:done')
    expect(existsSync(join(root, '.env'))).toBe(false)
    expect(existsSync(join(root, 'secrets.json'))).toBe(false)
  })

  test('oauth-completed (vision): different provider with oauth-completed skips oauth-login, no vision API key', async () => {
    const events: InitStepEvent[] = []

    await runInit({
      cwd: root,
      model: 'zai/glm-4.6',
      apiKey: 'zai_test_key',
      visionModel: 'openai-codex/gpt-5.5',
      visionAuth: { kind: 'oauth-completed' },
      runHatching: okHatch,
      runBunInstall: okInstall,
      dockerExec: okDocker,
      onProgress: (e) => events.push(e),
    })

    expect(events.some((e) => e.step === 'oauth-login')).toBe(false)
    expect(events.map((e) => `${e.step}:${e.phase}`)).toContain('scaffold:done')

    const secrets = await readSecrets(root)
    expect(secrets.providers?.zai).toBeDefined()
    expect(secrets.providers?.['openai-codex']).toBeUndefined()
  })

  test('throws when neither apiKey nor llmAuth is provided', async () => {
    await expect(
      runInit({ cwd: root, runHatching: okHatch, runBunInstall: okInstall, dockerExec: okDocker }),
    ).rejects.toThrow(/requires either `llmAuth` or `apiKey`/)
  })
})

describe('isDirectoryNonEmpty', () => {
  test('returns false for empty directory', () => {
    expect(isDirectoryNonEmpty(root)).toBe(false)
  })

  test('returns false when directory only contains dotfiles', async () => {
    await writeFile(join(root, '.hidden'), '')
    expect(isDirectoryNonEmpty(root)).toBe(false)
  })

  test('returns true when directory contains a regular file', async () => {
    await writeFile(join(root, 'file.txt'), '')
    expect(isDirectoryNonEmpty(root)).toBe(true)
  })

  test('returns true when directory contains a regular subdirectory', async () => {
    await mkdir(join(root, 'sub'))
    expect(isDirectoryNonEmpty(root)).toBe(true)
  })

  test('returns false for a nonexistent directory', () => {
    expect(isDirectoryNonEmpty(join(root, 'does-not-exist'))).toBe(false)
  })
})

describe('isInitialized', () => {
  test('returns false when no typeclaw.json exists', () => {
    expect(isInitialized(root)).toBe(false)
  })

  test('returns true when typeclaw.json exists', async () => {
    await writeFile(join(root, 'typeclaw.json'), '{}')
    expect(isInitialized(root)).toBe(true)
  })
})

describe('findAgentDir', () => {
  test('returns the dir itself when it contains typeclaw.json', async () => {
    await writeFile(join(root, 'typeclaw.json'), '{}')
    expect(findAgentDir(root)).toBe(root)
  })

  test('walks up to a parent that contains typeclaw.json', async () => {
    await writeFile(join(root, 'typeclaw.json'), '{}')
    const sub = join(root, 'workspace', 'sub')
    await mkdir(sub, { recursive: true })

    expect(findAgentDir(sub)).toBe(root)
  })

  test('resolves to the agent root even when the agent root has .git (since typeclaw.json is checked first at each level)', async () => {
    await writeFile(join(root, 'typeclaw.json'), '{}')
    await mkdir(join(root, '.git'))
    const sub = join(root, 'workspace')
    await mkdir(sub)

    expect(findAgentDir(sub)).toBe(root)
  })

  test('returns null when a .git boundary is hit before any typeclaw.json', async () => {
    // given: an outer parent has typeclaw.json, but an inner project introduces .git first.
    await writeFile(join(root, 'typeclaw.json'), '{}')
    const inner = join(root, 'unrelated-project')
    await mkdir(join(inner, '.git'), { recursive: true })
    const sub = join(inner, 'src')
    await mkdir(sub, { recursive: true })

    expect(findAgentDir(sub)).toBeNull()
  })

  test('returns null when no typeclaw.json exists up to the filesystem root', () => {
    expect(findAgentDir(root)).toBeNull()
  })

  test('returns null for a nonexistent start directory', () => {
    expect(findAgentDir(join(root, 'does-not-exist'))).toBeNull()
  })
})

describe('isHatched', () => {
  test('returns false for a fresh directory (no git)', async () => {
    expect(await isHatched(root)).toBe(false)
  })

  test('returns false after initGitRepo (initial commit only, no Hatched)', async () => {
    await scaffold(root)
    await initGitRepo(root)

    expect(await isHatched(root)).toBe(false)
  })

  test('returns true once a Hatched 🐣 commit exists', async () => {
    // given: a scaffolded repo with the exact commit subject the hatching ritual produces.
    await scaffold(root)
    await initGitRepo(root)
    await writeFile(join(root, 'IDENTITY.md'), 'I am Test.\n')
    await runGit(root, ['add', 'IDENTITY.md'])
    await runGit(root, ['commit', '-m', 'Hatched 🐣'])

    expect(await isHatched(root)).toBe(true)
  })
})

describe('scaffold', () => {
  test('creates expected directories', async () => {
    await scaffold(root)

    for (const dir of ['workspace', 'public', 'sessions', '.agents/skills', 'mounts', 'packages']) {
      const path = join(root, dir)
      expect(existsSync(path)).toBe(true)
      expect(statSync(path).isDirectory()).toBe(true)
    }
  })

  test('writes packages/.gitkeep so the empty workspace root survives the initial git commit', async () => {
    await scaffold(root)

    const gitkeep = join(root, 'packages', '.gitkeep')
    expect(existsSync(gitkeep)).toBe(true)
    expect(await readFile(gitkeep, 'utf8')).toBe('')
  })

  test('writes public/.gitkeep so the empty guest-visible zone survives the initial git commit', async () => {
    await scaffold(root)

    const gitkeep = join(root, 'public', '.gitkeep')
    expect(existsSync(gitkeep)).toBe(true)
    expect(await readFile(gitkeep, 'utf8')).toBe('')
  })

  test('does NOT scaffold MEMORY.md or memory/ (owned by the bundled memory plugin)', async () => {
    await scaffold(root)
    expect(existsSync(join(root, 'MEMORY.md'))).toBe(false)
    expect(existsSync(join(root, 'memory'))).toBe(false)
  })

  test('writes typeclaw.json with only $schema and models.default (no defaults duplicated)', async () => {
    await scaffold(root)

    const raw = await readFile(join(root, 'typeclaw.json'), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(JSON.parse(raw)).toEqual({
      $schema: './node_modules/typeclaw/typeclaw.schema.json',
      models: { default: 'openai/gpt-5.4-nano' },
    })
  })

  test('writes models.vision when visionModel is passed alongside the default model', async () => {
    await scaffold(root, { model: 'zai/glm-4.6', visionModel: 'openai/gpt-5.4-nano' })

    const cfg = JSON.parse(await readFile(join(root, 'typeclaw.json'), 'utf8')) as {
      models: Record<string, string>
    }
    expect(cfg.models).toEqual({ default: 'zai/glm-4.6', vision: 'openai/gpt-5.4-nano' })
  })

  test('omits every field whose default is already provided by configSchema or a bundled plugin', async () => {
    await scaffold(root)

    const cfg = JSON.parse(await readFile(join(root, 'typeclaw.json'), 'utf8')) as Record<string, unknown>
    expect(cfg.mounts).toBeUndefined()
    expect(cfg.memory).toBeUndefined()
    expect(cfg.network).toBeUndefined()
  })

  test('writes cron.json with an empty jobs array and $schema reference', async () => {
    await scaffold(root)

    const raw = await readFile(join(root, 'cron.json'), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(JSON.parse(raw)).toEqual({
      $schema: './node_modules/typeclaw/cron.schema.json',
      jobs: [],
    })
  })

  test('preserves existing cron.json instead of overwriting', async () => {
    const original = '{"jobs":[{"id":"mine","schedule":"* * * * *","kind":"prompt","prompt":"hi"}]}\n'
    await writeFile(join(root, 'cron.json'), original)

    await scaffold(root)

    expect(await readFile(join(root, 'cron.json'), 'utf8')).toBe(original)
  })

  test('writes typeclaw.json that passes configSchema validation', async () => {
    await scaffold(root)

    const raw = await readFile(join(root, 'typeclaw.json'), 'utf8')
    expect(() => configSchema.parse(JSON.parse(raw))).not.toThrow()
  })

  test('writes typeclaw.json that passes typeclaw.schema.json validation', async () => {
    await scaffold(root)

    const rawConfig = await readFile(join(root, 'typeclaw.json'), 'utf8')
    const rawSchema = await readFile(join(repoRoot, 'typeclaw.schema.json'), 'utf8')
    const schema = z.fromJSONSchema(JSON.parse(rawSchema))

    expect(() => schema.parse(JSON.parse(rawConfig))).not.toThrow()
  })

  test('writes cron.json that passes cron.schema.json validation', async () => {
    await scaffold(root)

    const rawCron = await readFile(join(root, 'cron.json'), 'utf8')
    const rawSchema = await readFile(join(repoRoot, 'cron.schema.json'), 'utf8')
    const schema = z.fromJSONSchema(JSON.parse(rawSchema))

    expect(() => schema.parse(JSON.parse(rawCron))).not.toThrow()
  })

  test('creates empty markdown files', async () => {
    await scaffold(root)

    for (const file of ['AGENTS.md', 'IDENTITY.md', 'SOUL.md', 'USER.md']) {
      expect(await readFile(join(root, file), 'utf8')).toBe('')
    }
  })

  test('writes a private package.json named after the folder with typeclaw as a file: dependency', async () => {
    await scaffold(root)

    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(pkg.name).toBe(basename(root))
    expect(pkg.private).toBe(true)
    expect(pkg.type).toBe('module')
    const deps = pkg.dependencies as Record<string, string>
    expect(deps.typeclaw).toMatch(/^file:/)
    expect(pkg.scripts).toBeUndefined()
  })

  test('package.json declares packages/* as a bun workspace root', async () => {
    await scaffold(root)

    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(pkg.workspaces).toEqual(['packages/*'])
  })

  test('package.json bundles agent-browser so the agent-browser skill can shell out to the CLI', async () => {
    await scaffold(root)

    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    expect(pkg.dependencies['agent-browser']).toBeDefined()
    expect(pkg.dependencies['agent-browser']).toMatch(/^[\^~]?\d+\.\d+\.\d+/)
  })

  test('package.json typeclaw file: dependency points at the typeclaw repo', async () => {
    await scaffold(root)

    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    const spec = pkg.dependencies.typeclaw ?? ''
    expect(spec.startsWith('file:')).toBe(true)
    const target = join(root, spec.slice('file:'.length))
    const targetPkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf8')) as { name: string }
    expect(targetPkg.name).toBe('typeclaw')
  })

  test('preserves existing package.json instead of overwriting', async () => {
    const original = '{"name":"keep-me"}\n'
    await writeFile(join(root, 'package.json'), original)

    await scaffold(root)

    expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(original)
  })

  test('writes .gitignore with both truly-ignored entries and system-managed entries', async () => {
    await scaffold(root)

    const gitignore = await readFile(join(root, '.gitignore'), 'utf8')
    expect(gitignore).toContain('.env')
    expect(gitignore).toContain('sessions/')
    expect(gitignore).toContain('memory/')
    expect(gitignore).toMatch(/^workspace\/$/m)
    expect(gitignore).toContain('mounts/')
    expect(gitignore).toMatch(/^Dockerfile$/m)
    expect(gitignore).toMatch(/^packages\/\*\/node_modules\/$/m)
  })

  test('gitignores the persistent-$HOME overlay (.typeclaw/home/) so symlinked credentials like ~/.codex/auth.json never enter git history', () => {
    const gitignore = buildGitignore({ append: [] })
    expect(gitignore).toMatch(/^\.typeclaw\/home\/$/m)
    const trulyIgnoredHeader = gitignore.indexOf('# Truly ignored:')
    const persistHomeIdx = gitignore.indexOf('.typeclaw/home/')
    const systemManagedHeader = gitignore.indexOf('# System-managed:')
    expect(trulyIgnoredHeader).toBeGreaterThan(-1)
    expect(systemManagedHeader).toBeGreaterThan(-1)
    expect(persistHomeIdx).toBeGreaterThan(trulyIgnoredHeader)
    expect(persistHomeIdx).toBeLessThan(systemManagedHeader)
  })

  test('buildGitignore includes custom entries from git.ignore.append before managed entries', () => {
    const gitignore = buildGitignore({ append: ['scratch/', '*.local.log'] })

    const customCommentIdx = gitignore.indexOf('# Custom entries from typeclaw.json#git.ignore.append.')
    const scratchIdx = gitignore.indexOf('scratch/')
    const logIdx = gitignore.indexOf('*.local.log')
    const trulyIgnoredIdx = gitignore.indexOf('# Truly ignored:')
    expect(customCommentIdx).toBeGreaterThan(-1)
    expect(customCommentIdx).toBeLessThan(scratchIdx)
    expect(scratchIdx).toBeLessThan(logIdx)
    expect(logIdx).toBeLessThan(trulyIgnoredIdx)
  })

  test('buildGitignore without config matches an empty git.ignore.append config', () => {
    expect(buildGitignore()).toBe(buildGitignore({ append: [] }))
  })

  test('preserves existing markdown files instead of overwriting', async () => {
    const original = '# existing content\n'
    await writeFile(join(root, 'AGENTS.md'), original)

    await scaffold(root)

    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(original)
  })

  test('preserves existing .gitignore instead of overwriting', async () => {
    const original = 'custom-entry\n'
    await writeFile(join(root, '.gitignore'), original)

    await scaffold(root)

    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe(original)
  })

  test('omits channels block when no adapter is requested', async () => {
    await scaffold(root)

    const cfg = JSON.parse(await readFile(join(root, 'typeclaw.json'), 'utf8')) as Record<string, unknown>
    expect(cfg.channels).toBeUndefined()
  })

  test('writes empty channels.<adapter> blocks for every requested adapter (no allow field)', async () => {
    await scaffold(root, { withDiscord: true, withSlack: true, withTelegram: true, withKakaotalk: true })

    const cfg = JSON.parse(await readFile(join(root, 'typeclaw.json'), 'utf8')) as {
      channels?: Record<string, Record<string, unknown>>
    }
    expect(cfg.channels?.['discord-bot']).toEqual({})
    expect(cfg.channels?.['slack-bot']).toEqual({})
    expect(cfg.channels?.['telegram-bot']).toEqual({})
    expect(cfg.channels?.kakaotalk).toEqual({})
  })

  test('omits adapter blocks not selected by the operator', async () => {
    await scaffold(root, { withDiscord: true })

    const cfg = JSON.parse(await readFile(join(root, 'typeclaw.json'), 'utf8')) as {
      channels?: Record<string, unknown>
    }
    expect(cfg.channels).toEqual({ 'discord-bot': {} })
  })

  // Scoped-by-default: a freshly-hatched chat agent seeds NO member match, so
  // every inbound author resolves to `guest` and is dropped until the operator
  // claims `owner` (runOwnerClaim) and explicitly grants others. This makes the
  // owner-claim flow a precondition for the agent to speak — surfaced by the
  // mute-until-claimed warning — rather than letting any stranger drive it.
  test('seeds NO member match when a chat adapter is selected (scoped-by-default)', async () => {
    await scaffold(root, { withSlack: true })

    const cfg = JSON.parse(await readFile(join(root, 'typeclaw.json'), 'utf8')) as {
      roles?: { member?: { match?: string[] } }
    }
    expect(cfg.roles?.member?.match).toBeUndefined()
  })

  test('seeds NO member match even when multiple chat adapters are selected', async () => {
    await scaffold(root, { withDiscord: true, withSlack: true, withTelegram: true, withKakaotalk: true })

    const cfg = JSON.parse(await readFile(join(root, 'typeclaw.json'), 'utf8')) as {
      roles?: { member?: { match?: string[] } }
    }
    expect(cfg.roles?.member).toBeUndefined()
  })

  test('omits roles block entirely when no chat adapter is selected (greenfield is silent until configured)', async () => {
    await scaffold(root)

    const cfg = JSON.parse(await readFile(join(root, 'typeclaw.json'), 'utf8')) as Record<string, unknown>
    expect(cfg.roles).toBeUndefined()
  })
})

describe('initGitRepo', () => {
  test('initializes a git repo with an initial commit on main', async () => {
    await scaffold(root)

    const result = await initGitRepo(root)

    expect(result).toEqual({ ok: true, skipped: false })
    expect(existsSync(join(root, '.git'))).toBe(true)
    expect(await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main')
    expect(await runGit(root, ['log', '--oneline'])).toContain('Initial commit 🥚')
  })

  test('authors the initial commit as TypeClaw', async () => {
    await scaffold(root)

    await initGitRepo(root)

    expect(await runGit(root, ['log', '-1', '--format=%an'])).toBe('TypeClaw')
    expect(await runGit(root, ['log', '-1', '--format=%ae'])).toBe('hello@typeclaw.dev')
  })

  test('respects .gitignore (does not track .env)', async () => {
    await scaffold(root)
    await writeSecrets(root, { apiKey: 'fw_test', model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' })

    await initGitRepo(root)

    const tracked = await runGit(root, ['ls-files'])
    expect(tracked.split('\n')).not.toContain('.env')
  })

  test('skips when .git already exists', async () => {
    await scaffold(root)
    await mkdir(join(root, '.git'))

    const result = await initGitRepo(root)

    expect(result).toEqual({ ok: true, skipped: true })
  })
})

describe('writeDockerAssets', () => {
  test('writes a Dockerfile with oven/bun base image', async () => {
    await scaffold(root)

    await writeDockerAssets(root)

    const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8')
    expect(dockerfile).toContain('FROM oven/bun:1.3.13-slim')
    expect(dockerfile).toContain('WORKDIR /agent')
    expect(dockerfile).toContain('typeclaw')
  })

  test('Dockerfile leads with an AUTOGENERATED warning so users and agents do not edit the artifact', async () => {
    await scaffold(root)

    await writeDockerAssets(root)

    const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8')
    // The very first line is `# syntax=docker/dockerfile:1.7` (BuildKit
    // requires this to be line 1), so the AUTOGENERATED warning is line 2.
    // Both must be present and adjacent so the human-readable warning is
    // immediately under the syntax directive.
    const lines = dockerfile.split('\n')
    expect(lines[0]).toBe('# syntax=docker/dockerfile:1.7')
    expect(lines[1]?.startsWith('# AUTOGENERATED')).toBe(true)
    expect(dockerfile).toContain('src/init/dockerfile.ts')
    expect(dockerfile).toMatch(/rewritten on every[^\n]*typeclaw start/)
  })

  test('Dockerfile installs agent-browser globally and pre-downloads Chromium with system deps', async () => {
    await scaffold(root)

    await writeDockerAssets(root)

    const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8')
    // The bun install lives in its own RUN (with a cache mount preceding the
    // command on the next line via \ continuation). Match `RUN` + arbitrary
    // continuation slop + the actual install command. Lazy quantifier prevents
    // crossing into the next RUN block.
    expect(dockerfile).toMatch(/^RUN[\s\S]+?\bbun install -g agent-browser\b/m)
    expect(dockerfile).toMatch(/^[^#\n]*\bagent-browser install --with-deps\b/m)
  })

  test('Dockerfile bundles tmux for long-running detachable agent sessions', async () => {
    await scaffold(root)

    await writeDockerAssets(root)

    const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8')
    // tmux must appear inside an apt-get install line. The package list spans
    // line continuations, so match across them with [\s\S]. We do not anchor
    // to a trailing apt-cache cleanup because cache-mounted /var/lib/apt/lists
    // is excluded from the image automatically; the cleanup line was removed
    // intentionally as part of the cache-mount migration.
    expect(dockerfile).toMatch(/apt-get install[\s\S]+?\btmux\b/)
  })

  test('Dockerfile bundles GitHub CLI via the official cli.github.com apt repo', async () => {
    await scaffold(root)

    await writeDockerAssets(root)

    const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8')
    // gh is not in Debian's default repos; the only sustainable install is
    // through the upstream apt source. Pin the URL, the keyring location,
    // and the actual `apt-get install` that pulls in gh so a regression in
    // any of these (key removed, repo line dropped, package name typo)
    // fails loudly here instead of at `docker build` time on a user's
    // machine. The package list spans line continuations, so the regex
    // crosses newlines with [\s\S] and uses a lazy quantifier to stop at
    // the first gh occurrence inside the apt-get install block.
    expect(dockerfile).toContain('https://cli.github.com/packages')
    expect(dockerfile).toContain('/etc/apt/keyrings/githubcli-archive-keyring.gpg')
    expect(dockerfile).toMatch(/apt-get install[\s\S]+?\bgh\b/)
  })

  test('Dockerfile opts in to BuildKit via the syntax directive so cache mounts are honored', async () => {
    await scaffold(root)

    await writeDockerAssets(root)

    const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8')
    // # syntax=... MUST be the very first line of the file (BuildKit parser
    // rejects it anywhere else). Without it, older Docker versions fall back
    // to the legacy builder, which silently ignores --mount=type=cache and
    // leaves us with no cache benefit at all.
    expect(dockerfile.split('\n')[0]).toBe('# syntax=docker/dockerfile:1.7')
  })

  test('Dockerfile includes custom lines from typeclaw.json docker.file.append before ENTRYPOINT', async () => {
    await scaffold(root)
    const raw = JSON.parse(await readFile(join(root, 'typeclaw.json'), 'utf8')) as Record<string, unknown>
    raw.docker = { file: { append: ['RUN apt-get update', 'ENV CUSTOM_TOOL=1'] } }
    await writeFile(join(root, 'typeclaw.json'), `${JSON.stringify(raw, null, 2)}\n`)

    await writeDockerAssets(root)

    const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8')
    const commentIdx = dockerfile.indexOf('# Custom lines from typeclaw.json#docker.file.append.')
    const runIdx = dockerfile.indexOf('RUN apt-get update')
    const envIdx = dockerfile.indexOf('ENV CUSTOM_TOOL=1')
    const entrypointIdx = dockerfile.indexOf('ENTRYPOINT ["/usr/local/bin/typeclaw-entrypoint"]')
    expect(commentIdx).toBeGreaterThan(-1)
    expect(commentIdx).toBeLessThan(runIdx)
    expect(runIdx).toBeLessThan(envIdx)
    expect(envIdx).toBeLessThan(entrypointIdx)
  })

  test('buildDockerfile without config matches a fully-defaulted docker.file config', () => {
    expect(buildDockerfile()).toBe(buildDockerfile(dockerfileSchema.parse({})))
  })

  test('Dockerfile cache-mounts apt directories so package re-installs reuse downloaded .debs', async () => {
    await scaffold(root)

    await writeDockerAssets(root)

    const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8')
    // Both apt cache directories must be mounted as type=cache. The mount
    // also has to use sharing=locked so concurrent BuildKit jobs (e.g. when
    // a user runs `typeclaw start --build` on multiple agents in parallel)
    // serialize their writes to the shared cache instead of corrupting it.
    expect(dockerfile).toMatch(/--mount=type=cache,target=\/var\/cache\/apt,sharing=locked/)
    expect(dockerfile).toMatch(/--mount=type=cache,target=\/var\/lib\/apt\/lists,sharing=locked/)

    // Defeating Debian's docker-clean is a precondition for the cache mount
    // to retain anything: without this, every apt install ends with a
    // post-invoke hook that wipes /var/cache/apt/archives.
    expect(dockerfile).toContain('rm -f /etc/apt/apt.conf.d/docker-clean')
    expect(dockerfile).toContain('Binary::apt::APT::Keep-Downloaded-Packages')
  })

  test('Dockerfile cache-mounts bun tarball cache so agent-browser version bumps reuse fetched packages', async () => {
    await scaffold(root)

    await writeDockerAssets(root)

    const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8')
    // The bun install -g RUN must mount /root/.bun/install/cache. This is
    // the path bun uses for its global tarball cache (see bun docs); a
    // miss without the mount means re-downloading every dependency of
    // agent-browser on every CLI version bump.
    expect(dockerfile).toMatch(
      /--mount=type=cache,target=\/root\/\.bun\/install\/cache[\s\S]+?bun install -g agent-browser/,
    )
  })

  test('Dockerfile does NOT cache-mount agent-browser cache because the runtime needs the binary in the image', async () => {
    await scaffold(root)

    await writeDockerAssets(root)

    const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8')
    // Common cache-optimization mistake: mounting ~/.agent-browser/browsers
    // would make rebuilds faster but ship a broken image, because cache
    // mounts are excluded from the final image. The Chrome for Testing
    // binary lives at ~/.agent-browser/browsers/chrome-<version>/chrome and
    // the runtime calls into it directly; if it disappears, the agent's
    // browser tool fails to launch on every container start.
    expect(dockerfile).not.toMatch(/--mount=type=cache,target=[^\s]*\.agent-browser\/browsers/)
  })

  test('Dockerfile registers the GitHub CLI apt repo in a layer separate from the package install', async () => {
    await scaffold(root)

    await writeDockerAssets(root)

    const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8')
    // The keyring fetch (curl + gpg --dearmor) must complete in an earlier
    // RUN than the apt-get install line that pulls gh. Otherwise, editing the
    // package list invalidates the keyring fetch too, wasting network on
    // every Dockerfile.ts change. Anchor on the install command's exact
    // option flags (not comment text) so the assertion ignores prose mentions
    // of "gh" in surrounding comments.
    const curlIdx = dockerfile.indexOf('curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg')
    const aptInstallIdx = dockerfile.indexOf('apt-get install -y --no-install-recommends \\\n')
    expect(curlIdx).toBeGreaterThan(-1)
    expect(aptInstallIdx).toBeGreaterThan(-1)
    expect(curlIdx).toBeLessThan(aptInstallIdx)
  })

  test('Dockerfile falls back to apt chromium on arm64 since Chrome for Testing has no linux/arm64 build', async () => {
    await scaffold(root)

    await writeDockerAssets(root)

    const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8')
    expect(dockerfile).toContain('ARG TARGETARCH')
    // arm64 branch must apt-install chromium and configure agent-browser to use it,
    // since `agent-browser install` would fail (no upstream linux/arm64 binary).
    expect(dockerfile).toMatch(/\$TARGETARCH.*=.*["']?arm64["']?/)
    expect(dockerfile).toMatch(/apt-get install[^\n]*\bchromium\b/)
    expect(dockerfile).toMatch(/"executablePath"\s*:\s*"\/usr\/bin\/chromium"/)
  })

  test('returns devMode true when typeclaw dep is a file: spec', async () => {
    await scaffold(root)

    const result = await writeDockerAssets(root)

    expect(result).toEqual({ ok: true, devMode: true })
  })

  test('returns devMode false when typeclaw dep is a version range', async () => {
    await scaffold(root)
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<string, unknown>
    ;(pkg.dependencies as Record<string, string>).typeclaw = '^0.1.0'
    await writeFile(join(root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)

    const result = await writeDockerAssets(root)

    expect(result).toEqual({ ok: true, devMode: false })
    expect(existsSync(join(root, 'Dockerfile'))).toBe(true)
  })

  test('preserves an existing Dockerfile instead of overwriting', async () => {
    await scaffold(root)
    const original = '# my custom Dockerfile\n'
    await writeFile(join(root, 'Dockerfile'), original)

    await writeDockerAssets(root)

    expect(await readFile(join(root, 'Dockerfile'), 'utf8')).toBe(original)
  })
})

describe('writeSecrets', () => {
  test('writes an OpenAI API key to secrets.json#providers when model is an OpenAI model', async () => {
    await writeSecrets(root, { apiKey: 'openai-test-key', model: 'openai/gpt-5.4-nano' })

    expect((await readSecrets(root)).providers?.openai).toEqual({ type: 'api_key', key: { value: 'openai-test-key' } })
  })

  test('writes a Fireworks API key to secrets.json#providers when model is a Fireworks model', async () => {
    await writeSecrets(root, {
      apiKey: 'fw_test_abc123',
      model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo',
    })

    expect((await readSecrets(root)).providers?.fireworks).toEqual({
      type: 'api_key',
      key: { value: 'fw_test_abc123' },
    })
  })

  test('defaults to OpenAI provider when model is omitted (matches DEFAULT_MODEL_REF)', async () => {
    await writeSecrets(root, { apiKey: 'openai-default-key' })

    expect((await readSecrets(root)).providers?.openai).toEqual({
      type: 'api_key',
      key: { value: 'openai-default-key' },
    })
  })

  test('writes a second provider API key when vision profile uses a different provider', async () => {
    await writeSecrets(root, {
      apiKey: 'zai_key',
      model: 'zai/glm-4.6',
      visionModel: 'openai/gpt-5.4-nano',
      visionApiKey: 'openai_vision_key',
    })

    const providers = (await readSecrets(root)).providers
    expect(providers?.zai).toEqual({ type: 'api_key', key: { value: 'zai_key' } })
    expect(providers?.openai).toEqual({ type: 'api_key', key: { value: 'openai_vision_key' } })
  })

  test('does NOT write a second provider key when vision provider matches the default provider', async () => {
    await writeSecrets(root, {
      apiKey: 'openai_key',
      model: 'openai/gpt-5.4-nano',
      visionModel: 'openai/gpt-5.4',
      visionApiKey: 'should_not_overwrite',
    })

    expect((await readSecrets(root)).providers?.openai).toEqual({
      type: 'api_key',
      key: { value: 'openai_key' },
    })
  })

  test('updates an existing provider API key in secrets.json', async () => {
    await writeSecrets(root, { apiKey: 'fw_old', model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' })
    await writeSecrets(root, { apiKey: 'fw_new', model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' })

    expect((await readSecrets(root)).providers?.fireworks).toEqual({ type: 'api_key', key: { value: 'fw_new' } })
  })

  test('preserves an existing provider API key when no new provider key is provided', async () => {
    await writeSecrets(root, { apiKey: 'fw_existing', model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' })
    await writeSecrets(root, { model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' })

    expect((await readSecrets(root)).providers?.fireworks).toEqual({ type: 'api_key', key: { value: 'fw_existing' } })
  })

  test('reads an existing provider API key from secrets.json', async () => {
    await writeSecrets(root, { apiKey: 'openai-existing-key', model: 'openai/gpt-5.4-nano' })

    expect(await readExistingProviderApiKey(root, 'openai')).toBe('openai-existing-key')
    expect(await readExistingProviderApiKey(root, 'fireworks')).toBe(null)
  })

  test('ignores blank provider API keys in secrets.json', async () => {
    await writeFile(
      join(root, 'secrets.json'),
      `${JSON.stringify({ version: 2, providers: { openai: { type: 'api_key', key: { value: '   ' } } }, channels: {} }, null, 2)}\n`,
    )

    expect(await readExistingProviderApiKey(root, 'openai')).toBe(null)
  })

  test('returns null when reading a provider API key without secrets.json', async () => {
    expect(await readExistingProviderApiKey(root, 'openai')).toBe(null)
    expect(existsSync(join(root, 'secrets.json'))).toBe(false)
  })

  test('writes telegram-bot.token to secrets.json#channels (not .env) when telegramBotToken is provided', async () => {
    await writeSecrets(root, {
      apiKey: 'fw_test',
      model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo',
      telegramBotToken: '1234567890:ABCdef',
    })

    const secrets = await readSecrets(root)
    expect(secrets.providers?.fireworks).toEqual({ type: 'api_key', key: { value: 'fw_test' } })
    expect(secrets.channels?.['telegram-bot']).toEqual({ token: { value: '1234567890:ABCdef' } })
  })

  test('writes discord-bot.token to secrets.json#channels when discordBotToken is provided', async () => {
    await writeSecrets(root, { apiKey: 'openai-key', model: 'openai/gpt-5.4-nano', discordBotToken: 'discord-tok' })

    const secrets = await readSecrets(root)
    expect(secrets.channels?.['discord-bot']).toEqual({ token: { value: 'discord-tok' } })
    expect(secrets.providers?.openai).toEqual({ type: 'api_key', key: { value: 'openai-key' } })
  })

  test('merges botToken + appToken into the same slack-bot slot in secrets.json', async () => {
    await writeSecrets(root, {
      apiKey: 'openai-key',
      model: 'openai/gpt-5.4-nano',
      slackBotToken: 'xoxb-a',
      slackAppToken: 'xapp-b',
    })

    const secrets = await readSecrets(root)
    expect(secrets.channels?.['slack-bot']).toEqual({
      botToken: { value: 'xoxb-a' },
      appToken: { value: 'xapp-b' },
    })
  })

  test('does not create secrets.json#channels entries when no channel tokens are provided', async () => {
    await writeSecrets(root, {
      apiKey: 'fw_test',
      model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo',
      telegramBotToken: '',
    })

    expect((await readSecrets(root)).providers?.fireworks).toEqual({ type: 'api_key', key: { value: 'fw_test' } })
    expect((await readSecrets(root)).channels).toEqual({})
  })
})

describe('hasExistingOAuthCredentials', () => {
  async function seedProviders(providers: Record<string, unknown>): Promise<void> {
    await writeFile(join(root, 'secrets.json'), `${JSON.stringify({ version: 2, providers, channels: {} }, null, 2)}\n`)
  }

  test('returns false when secrets.json does not exist', async () => {
    expect(await hasExistingOAuthCredentials(root, 'openai-codex')).toBe(false)
    expect(await hasExistingOAuthCredentials(root, 'anthropic')).toBe(false)
  })

  test('returns false for providers without OAuth support', async () => {
    await seedProviders({ openai: { type: 'oauth', access_token: 'tok-x' } })
    expect(await hasExistingOAuthCredentials(root, 'openai')).toBe(false)
    expect(await hasExistingOAuthCredentials(root, 'fireworks')).toBe(false)
  })

  test('returns true when the OAuth slot has a non-empty access_token', async () => {
    await seedProviders({ 'openai-codex': { type: 'oauth', access_token: 'tok-fresh', refresh_token: 'r' } })
    expect(await hasExistingOAuthCredentials(root, 'openai-codex')).toBe(true)
  })

  test('returns false when the slot is api_key-shaped instead of oauth', async () => {
    await seedProviders({ 'openai-codex': { type: 'api_key', key: { value: 'sk-anything' } } })
    expect(await hasExistingOAuthCredentials(root, 'openai-codex')).toBe(false)
  })

  test('returns false when access_token is missing', async () => {
    await seedProviders({ 'openai-codex': { type: 'oauth' } })
    expect(await hasExistingOAuthCredentials(root, 'openai-codex')).toBe(false)
  })

  test('returns false when access_token is empty or whitespace', async () => {
    await seedProviders({ 'openai-codex': { type: 'oauth', access_token: '' } })
    expect(await hasExistingOAuthCredentials(root, 'openai-codex')).toBe(false)
    await seedProviders({ 'openai-codex': { type: 'oauth', access_token: '   ' } })
    expect(await hasExistingOAuthCredentials(root, 'openai-codex')).toBe(false)
  })

  test('routes by oauthProviderId, not the providerId argument', async () => {
    // anthropic's oauthProviderId === 'anthropic' (same name), so this is
    // a sanity check rather than a mismatch case — but the test pins the
    // behavior so a future provider whose oauthProviderId diverges from
    // its id can't silently break this code path.
    await seedProviders({ anthropic: { type: 'oauth', access_token: 'ant-tok' } })
    expect(await hasExistingOAuthCredentials(root, 'anthropic')).toBe(true)
  })
})

describe('hasExistingChannelSecrets', () => {
  async function seedChannels(channels: Record<string, unknown>): Promise<void> {
    await writeFile(join(root, 'secrets.json'), `${JSON.stringify({ version: 2, providers: {}, channels }, null, 2)}\n`)
  }

  test('returns false when secrets.json does not exist', async () => {
    expect(await hasExistingChannelSecrets(root, 'discord')).toBe(false)
    expect(await hasExistingChannelSecrets(root, 'slack')).toBe(false)
    expect(await hasExistingChannelSecrets(root, 'telegram')).toBe(false)
    expect(await hasExistingChannelSecrets(root, 'kakaotalk')).toBe(false)
  })

  test('returns true when discord-bot.token is present', async () => {
    await seedChannels({ 'discord-bot': { token: { value: 'discord-existing' } } })
    expect(await hasExistingChannelSecrets(root, 'discord')).toBe(true)
  })

  test('accepts the string-shorthand Secret shape', async () => {
    await seedChannels({ 'discord-bot': { token: 'discord-shorthand' } })
    expect(await hasExistingChannelSecrets(root, 'discord')).toBe(true)
  })

  test('returns true when slack-bot has BOTH botToken and appToken', async () => {
    await seedChannels({
      'slack-bot': { botToken: { value: 'xoxb-1' }, appToken: { value: 'xapp-1' } },
    })
    expect(await hasExistingChannelSecrets(root, 'slack')).toBe(true)
  })

  test('returns false when slack-bot has only botToken (partial slot)', async () => {
    await seedChannels({ 'slack-bot': { botToken: { value: 'xoxb-1' } } })
    expect(await hasExistingChannelSecrets(root, 'slack')).toBe(false)
  })

  test('returns true when telegram-bot.token is present', async () => {
    await seedChannels({ 'telegram-bot': { token: { value: '123:abc' } } })
    expect(await hasExistingChannelSecrets(root, 'telegram')).toBe(true)
  })

  test('returns false when the relevant slot is empty', async () => {
    await seedChannels({ 'discord-bot': {} })
    expect(await hasExistingChannelSecrets(root, 'discord')).toBe(false)
  })

  test('returns true when env-bound Secret is recorded under the field', async () => {
    await seedChannels({ 'discord-bot': { token: { env: 'CUSTOM_DISCORD_ENV' } } })
    expect(await hasExistingChannelSecrets(root, 'discord')).toBe(true)
  })

  test('returns true when slack-bot has BOTH fields env-bound', async () => {
    await seedChannels({
      'slack-bot': { botToken: { env: 'MY_SLACK_BOT' }, appToken: { env: 'MY_SLACK_APP' } },
    })
    expect(await hasExistingChannelSecrets(root, 'slack')).toBe(true)
  })

  test('returns true when slack-bot mixes value-bound and env-bound fields', async () => {
    await seedChannels({
      'slack-bot': { botToken: { value: 'xoxb-1' }, appToken: { env: 'MY_SLACK_APP' } },
    })
    expect(await hasExistingChannelSecrets(root, 'slack')).toBe(true)
  })

  test('returns true when kakaotalk has a full account record with renewal fields (email + encryptedPassword)', async () => {
    await seedChannels({
      kakaotalk: {
        currentAccount: 'acc-1',
        accounts: {
          'acc-1': {
            account_id: 'acc-1',
            oauth_token: 'tok',
            user_id: 'u1',
            device_uuid: 'd1',
            device_type: 'tablet',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            email: 'user@example.com',
            encryptedPassword: {
              v: 1,
              alg: 'AES-256-GCM',
              kid: 'k1',
              iv: 'iv1',
              ciphertext: 'ct1',
              authTag: 'tag1',
              createdAt: '2026-01-01T00:00:00Z',
            },
          },
        },
      },
    })
    expect(await hasExistingChannelSecrets(root, 'kakaotalk')).toBe(true)
  })

  test('returns false when kakaotalk account lacks renewal fields (legacy block, no unattended renewal possible)', async () => {
    await seedChannels({
      kakaotalk: {
        currentAccount: 'acc-1',
        accounts: {
          'acc-1': {
            account_id: 'acc-1',
            oauth_token: 'tok',
            user_id: 'u1',
            device_uuid: 'd1',
            device_type: 'tablet',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        },
      },
    })
    expect(await hasExistingChannelSecrets(root, 'kakaotalk')).toBe(false)
  })

  test('returns false when kakaotalk currentAccount is null or missing from accounts', async () => {
    await seedChannels({ kakaotalk: { currentAccount: null, accounts: {} } })
    expect(await hasExistingChannelSecrets(root, 'kakaotalk')).toBe(false)

    await seedChannels({ kakaotalk: { currentAccount: 'acc-missing', accounts: {} } })
    expect(await hasExistingChannelSecrets(root, 'kakaotalk')).toBe(false)
  })
})

describe('channel secret reuse (init re-run preserves existing tokens)', () => {
  test('omitting discordBotToken on a re-run preserves the existing slot', async () => {
    await writeSecrets(root, { apiKey: 'fw1', discordBotToken: 'discord-old' })
    await writeSecrets(root, { apiKey: 'fw2' })

    const secrets = await readSecrets(root)
    expect(secrets.channels?.['discord-bot']).toEqual({ token: { value: 'discord-old' } })
  })

  test('omitting slack tokens on a re-run preserves both botToken and appToken', async () => {
    await writeSecrets(root, { apiKey: 'fw1', slackBotToken: 'xoxb-old', slackAppToken: 'xapp-old' })
    await writeSecrets(root, { apiKey: 'fw2' })

    const secrets = await readSecrets(root)
    expect(secrets.channels?.['slack-bot']).toEqual({
      botToken: { value: 'xoxb-old' },
      appToken: { value: 'xapp-old' },
    })
  })

  test('omitting telegramBotToken on a re-run preserves the existing slot', async () => {
    await writeSecrets(root, { apiKey: 'fw1', telegramBotToken: '111:old' })
    await writeSecrets(root, { apiKey: 'fw2' })

    const secrets = await readSecrets(root)
    expect(secrets.channels?.['telegram-bot']).toEqual({ token: { value: '111:old' } })
  })

  test('runInit with withDiscord=true and no token wires the adapter in typeclaw.json without overwriting the existing slot', async () => {
    await writeSecrets(root, { apiKey: 'fw_seed', discordBotToken: 'discord-existing' })

    await runInit({
      cwd: root,
      apiKey: 'fw_seed',
      withDiscord: true,
      runHatching: okHatch,
      runBunInstall: okInstall,
      dockerExec: okDocker,
    })

    const config = JSON.parse(await readFile(join(root, 'typeclaw.json'), 'utf8')) as {
      channels?: Record<string, unknown>
    }
    expect(config.channels?.['discord-bot']).toEqual({})

    const secrets = await readSecrets(root)
    expect(secrets.channels?.['discord-bot']).toEqual({ token: { value: 'discord-existing' } })
  })

  test('runInit with withSlack=true and no tokens wires slack without disturbing existing botToken/appToken', async () => {
    await writeSecrets(root, { apiKey: 'fw_seed', slackBotToken: 'xoxb-existing', slackAppToken: 'xapp-existing' })

    await runInit({
      cwd: root,
      apiKey: 'fw_seed',
      withSlack: true,
      runHatching: okHatch,
      runBunInstall: okInstall,
      dockerExec: okDocker,
    })

    const config = JSON.parse(await readFile(join(root, 'typeclaw.json'), 'utf8')) as {
      channels?: Record<string, unknown>
    }
    expect(config.channels?.['slack-bot']).toEqual({})

    const secrets = await readSecrets(root)
    expect(secrets.channels?.['slack-bot']).toEqual({
      botToken: { value: 'xoxb-existing' },
      appToken: { value: 'xapp-existing' },
    })
  })

  test('runInit with withKakaotalk=true and no runKakaotalkAuth wires kakaotalk without re-authenticating', async () => {
    await writeFile(
      join(root, 'secrets.json'),
      `${JSON.stringify(
        {
          version: 2,
          providers: { fireworks: { type: 'api_key', key: { value: 'fw_seed' } } },
          channels: {
            kakaotalk: {
              currentAccount: 'acc-1',
              accounts: {
                'acc-1': {
                  account_id: 'acc-1',
                  oauth_token: 'tok',
                  user_id: 'u1',
                  device_uuid: 'd1',
                  device_type: 'tablet',
                  created_at: '2026-01-01T00:00:00Z',
                  updated_at: '2026-01-01T00:00:00Z',
                },
              },
            },
          },
        },
        null,
        2,
      )}\n`,
    )

    await runInit({
      cwd: root,
      apiKey: 'fw_seed',
      withKakaotalk: true,
      runHatching: okHatch,
      runBunInstall: okInstall,
      dockerExec: okDocker,
    })

    const config = JSON.parse(await readFile(join(root, 'typeclaw.json'), 'utf8')) as {
      channels?: Record<string, unknown>
    }
    expect(config.channels?.kakaotalk).toEqual({})

    const secrets = await readSecrets(root)
    expect(secrets.channels?.kakaotalk).toMatchObject({
      currentAccount: 'acc-1',
      accounts: { 'acc-1': { oauth_token: 'tok' } },
    })
  })

  test('runInit with withGithub=true and githubCredentials writes the channel block and secrets', async () => {
    await runInit({
      cwd: root,
      apiKey: 'fw_test_key',
      withGithub: true,
      githubCredentials: {
        webhookSecret: 'whsec_test',
        tunnelProvider: 'external',
        webhookUrl: 'https://example.com/hook',
        webhookPort: 8975,
        repos: ['acme/repo-a'],
        auth: { type: 'pat', pat: 'ghp_test' },
      },
      githubFetchImpl: okGithubFetch,
      runHatching: okHatch,
      runBunInstall: okInstall,
      dockerExec: okDocker,
    })

    const config = JSON.parse(await readFile(join(root, 'typeclaw.json'), 'utf8')) as {
      channels?: Record<string, Record<string, unknown>>
      roles?: { member?: { match?: string[] } }
      tunnels?: Array<Record<string, unknown>>
    }
    expect(config.channels?.github).toMatchObject({
      webhookUrl: 'https://example.com/hook',
      webhookPort: 8975,
    })
    expect(config.tunnels).toEqual([
      {
        name: 'github-webhook',
        provider: 'external',
        externalUrl: 'https://example.com/hook',
        for: { kind: 'channel', name: 'github' },
      },
    ])
    expect(config.channels?.github?.eventAllowlist).toBeUndefined()
    expect(config.roles?.member?.match).toContain('github:acme/repo-a')

    const secrets = await readSecrets(root)
    expect(secrets.channels?.github).toMatchObject({
      auth: { type: 'pat', token: { value: 'ghp_test' } },
      webhookSecret: { value: 'whsec_test' },
    })
  })

  test('runInit with withGithub=true but no credentials is a no-op for github', async () => {
    await runInit({
      cwd: root,
      apiKey: 'fw_test_key',
      withGithub: true,
      runHatching: okHatch,
      runBunInstall: okInstall,
      dockerExec: okDocker,
    })

    const config = JSON.parse(await readFile(join(root, 'typeclaw.json'), 'utf8')) as {
      channels?: Record<string, unknown>
    }
    expect(config.channels?.github).toBeUndefined()
  })

  test('runInit with withGithub=true overwrites a pre-existing secrets.json#channels.github block', async () => {
    // given: a prior partial init left a github credentials block on disk
    await writeFile(
      join(root, 'secrets.json'),
      `${JSON.stringify(
        {
          version: 2,
          providers: { fireworks: { type: 'api_key', key: { value: 'fw_seed' } } },
          channels: {
            github: {
              auth: { type: 'pat', token: { value: 'old_pat' } },
              webhookSecret: { value: 'old_whsec' },
            },
          },
        },
        null,
        2,
      )}\n`,
    )

    // when: the user re-runs init with new credentials
    await runInit({
      cwd: root,
      apiKey: 'fw_test_key',
      withGithub: true,
      githubCredentials: {
        webhookSecret: 'new_whsec',
        tunnelProvider: 'external',
        webhookUrl: 'https://example.com/new',
        webhookPort: 9090,
        repos: ['acme/repo-b'],
        auth: { type: 'pat', pat: 'new_pat' },
      },
      githubFetchImpl: okGithubFetch,
      runHatching: okHatch,
      runBunInstall: okInstall,
      dockerExec: okDocker,
    })

    // then: secrets and config reflect the new credentials, not the old ones
    const secrets = await readSecrets(root)
    expect(secrets.channels?.github).toMatchObject({
      auth: { type: 'pat', token: { value: 'new_pat' } },
      webhookSecret: { value: 'new_whsec' },
    })

    const config = JSON.parse(await readFile(join(root, 'typeclaw.json'), 'utf8')) as {
      channels?: Record<string, Record<string, unknown>>
      roles?: { member?: { match?: string[] } }
    }
    expect(config.channels?.github).toMatchObject({
      webhookUrl: 'https://example.com/new',
      webhookPort: 9090,
    })
    expect(config.roles?.member?.match).toContain('github:acme/repo-b')
  })

  test('runInit with github cloudflare-quick credentials writes tunnel config without webhookUrl', async () => {
    const events: InitStepEvent[] = []
    await runInit({
      cwd: root,
      apiKey: 'fw_test_key',
      withGithub: true,
      githubCredentials: {
        webhookSecret: 'whsec_test',
        tunnelProvider: 'cloudflare-quick',
        webhookPort: 8975,
        repos: ['acme/repo-a'],
        auth: { type: 'pat', pat: 'ghp_test' },
      },
      onProgress: (e) => events.push(e),
      runHatching: okHatch,
      runBunInstall: okInstall,
      dockerExec: okDocker,
    })

    const config = JSON.parse(await readFile(join(root, 'typeclaw.json'), 'utf8')) as {
      channels?: Record<string, Record<string, unknown>>
      docker?: { file?: { cloudflared?: boolean } }
      tunnels?: Array<Record<string, unknown>>
    }
    expect(config.channels?.github?.webhookUrl).toBeUndefined()
    expect(config.docker?.file?.cloudflared).toBe(true)
    expect(config.tunnels).toEqual([
      { name: 'github-webhook', provider: 'cloudflare-quick', for: { kind: 'channel', name: 'github' } },
    ])
    expect(events.some((e) => e.step === 'github-webhooks')).toBe(false)
  })

  test('runInit eagerly installs github webhooks when the credentials carry a known webhookUrl', async () => {
    const events: InitStepEvent[] = []
    const calls: Array<{ url: string; method: string; body?: string }> = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method ?? 'GET'
      const body = typeof init?.body === 'string' ? init.body : undefined
      calls.push(body !== undefined ? { url, method, body } : { url, method })
      if (/\/hooks(\?|$)/.test(url) && method === 'GET') return Response.json([])
      if (url.endsWith('/hooks') && method === 'POST') return Response.json({ id: 777 }, { status: 201 })
      return new Response('unexpected', { status: 500 })
    }) as unknown as typeof fetch as typeof fetch

    await runInit({
      cwd: root,
      apiKey: 'fw_test_key',
      withGithub: true,
      githubCredentials: {
        webhookSecret: 'whsec_init',
        tunnelProvider: 'external',
        webhookUrl: 'https://init.example.com/hook',
        webhookPort: 8975,
        repos: ['acme/repo-a'],
        auth: { type: 'pat', pat: 'ghp_test' },
      },
      githubFetchImpl: fetchImpl,
      onProgress: (e) => events.push(e),
      runHatching: okHatch,
      runBunInstall: okInstall,
      dockerExec: okDocker,
    })

    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/hooks'))
    expect(post?.url).toBe('https://api.github.com/repos/acme/repo-a/hooks')
    const body = JSON.parse(post?.body ?? '{}') as { config?: { url?: string; secret?: string } }
    expect(body.config?.url).toBe('https://init.example.com/hook')
    expect(body.config?.secret).toBe('whsec_init')

    const doneEvent = events.find(
      (e): e is Extract<InitStepEvent, { step: 'github-webhooks'; phase: 'done' }> =>
        e.step === 'github-webhooks' && e.phase === 'done',
    )
    expect(doneEvent).toBeDefined()
    if (doneEvent && !('error' in doneEvent.result)) {
      expect(doneEvent.result.repos).toEqual([{ repo: 'acme/repo-a', action: 'created', hookId: 777 }])
    } else {
      throw new Error('expected structured success result, got error or no event')
    }
  })
})

// Guards the exact bug site of the hatching-hostd fix: that the default
// hatching implementation forwards `cliEntry` into `start()`. The runInit
// pipeline tests above stop at `runInit -> runHatching` (their fake
// runHatching captures call args but never reaches start()), so without
// these, a future contributor could drop `cliEntry` from defaultRunHatching's
// start() call and the suite would stay green.
describe('defaultRunHatching', () => {
  type StartCall = Parameters<typeof import('@/container').start>[0]

  function fakeStart(): { fn: typeof import('@/container').start; calls: StartCall[] } {
    const calls: StartCall[] = []
    const fn: typeof import('@/container').start = async (options) => {
      calls.push(options)
      return {
        ok: true,
        plan: {
          containerName: 'fake',
          imageTag: 'fake:latest',
          buildContext: options.cwd,
          dockerfile: 'Dockerfile',
          runArgs: [],
          needsBuild: false,
          hostPort: 19173,
          tuiToken: 'fake-tui-token',
        },
        containerId: 'fake-id',
        built: false,
        hostPort: 19173,
        tuiToken: 'fake-tui-token',
        hostd: { state: 'disabled' },
        alreadyRunning: false,
        autoUpgrade: { kind: 'skipped-already-running' },
      }
    }
    return { fn, calls }
  }

  // Bypass real Docker / TUI / HTTP probes — defaultRunHatching's behavior we
  // care about is "did it pass cliEntry through to start()", and the rest of
  // the function (waitForAgent + TUI) just needs to not blow up.
  const fakeTui: typeof import('@/tui').createTui = () =>
    ({ run: async () => ({ reason: 'exit', exitCode: 0 }) }) as ReturnType<typeof import('@/tui').createTui>
  const fakeWaitForAgent = async () => {}

  test('forwards cliEntry to start() when provided', async () => {
    const { fn, calls } = fakeStart()

    const result = await defaultRunHatching({
      cwd: '/agent',
      port: 8973,
      cliEntry: '/fake/cli/entry.ts',
      startContainer: fn,
      tui: fakeTui,
      waitForAgent: fakeWaitForAgent,
    })

    expect(result).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.cliEntry).toBe('/fake/cli/entry.ts')
  })

  test('omits cliEntry from start() when not provided', async () => {
    const { fn, calls } = fakeStart()

    await defaultRunHatching({
      cwd: '/agent',
      port: 8973,
      startContainer: fn,
      tui: fakeTui,
      waitForAgent: fakeWaitForAgent,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.cliEntry).toBeUndefined()
  })

  test('propagates start() failure as a hatching failure', async () => {
    const failingStart: typeof import('@/container').start = async () => ({ ok: false, reason: 'docker not running' })

    const result = await defaultRunHatching({
      cwd: '/agent',
      port: 8973,
      cliEntry: '/fake/cli/entry.ts',
      startContainer: failingStart,
      tui: fakeTui,
      waitForAgent: fakeWaitForAgent,
    })

    expect(result).toEqual({ ok: false, reason: 'docker not running' })
  })

  function capturingTui(): {
    fn: typeof import('@/tui').createTui
    calls: Parameters<typeof import('@/tui').createTui>[0][]
  } {
    const calls: Parameters<typeof import('@/tui').createTui>[0][] = []
    const fn: typeof import('@/tui').createTui = (options) => {
      calls.push(options)
      return { run: async () => ({ reason: 'exit', exitCode: 0 }) } as ReturnType<typeof import('@/tui').createTui>
    }
    return { fn, calls }
  }

  test('inlines typeclaw.json content into the hatching prompt when readable', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tc-hatch-inline-'))
    try {
      const json = '{\n  "models": {\n    "default": "openai-codex/gpt-5.4-mini"\n  }\n}\n'
      await writeFile(join(cwd, 'typeclaw.json'), json, 'utf8')

      const { fn: tui, calls: tuiCalls } = capturingTui()
      const { fn: startFn } = fakeStart()

      await defaultRunHatching({
        cwd,
        port: 8973,
        startContainer: startFn,
        tui,
        waitForAgent: fakeWaitForAgent,
      })

      expect(tuiCalls).toHaveLength(1)
      const prompt = tuiCalls[0]?.initialPrompt
      expect(prompt).toBeDefined()
      expect(prompt).toContain('<current-typeclaw-json>')
      expect(prompt).toContain(json)
      expect(prompt).toContain('in the SAME assistant message')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('falls back to read-instructions when typeclaw.json is missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tc-hatch-nofile-'))
    try {
      const { fn: tui, calls: tuiCalls } = capturingTui()
      const { fn: startFn } = fakeStart()

      const result = await defaultRunHatching({
        cwd,
        port: 8973,
        startContainer: startFn,
        tui,
        waitForAgent: fakeWaitForAgent,
      })

      expect(result).toEqual({ ok: true })
      expect(tuiCalls).toHaveLength(1)
      const prompt = tuiCalls[0]?.initialPrompt
      expect(prompt).toBeDefined()
      expect(prompt).not.toContain('<current-typeclaw-json>')
      expect(prompt).toContain('Read `typeclaw.json`')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
