import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as z from 'zod'

import { configSchema } from '@/config/config'

import {
  type HatchingResult,
  type HatchRunner,
  initGitRepo,
  type InitStepEvent,
  isDirectoryNonEmpty,
  isHatched,
  isInitialized,
  runInit,
  scaffold,
  writeDockerAssets,
  writeSecrets,
} from './index'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-init-'))
})

const okHatch: HatchRunner = async () => ({ ok: true }) as HatchingResult

function captureHatch(): { runner: HatchRunner; calls: Array<{ cwd: string; port: number }> } {
  const calls: Array<{ cwd: string; port: number }> = []
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

describe('runInit', () => {
  test('runs scaffold, install, dockerfile, git, and hatching steps in order', async () => {
    const events: InitStepEvent[] = []

    await runInit({ cwd: root, apiKey: 'fw_test_key', runHatching: okHatch, onProgress: (e) => events.push(e) })

    expect(events.map((e) => `${e.step}:${e.phase}`)).toEqual([
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

    await runInit({ cwd: root, apiKey: 'fw_test_key', runHatching })

    expect(seenAt).toEqual([{ hasGit: true, hasDockerfile: true }])
  })

  test('hatching receives the init cwd and the configured port', async () => {
    const { runner, calls } = captureHatch()

    await runInit({ cwd: root, apiKey: 'fw_test_key', runHatching: runner })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.cwd).toBe(root)
    expect(calls[0]?.port).toBeGreaterThan(0)
  })

  test('hatching failure is reported via event, not thrown', async () => {
    const runHatching: HatchRunner = async () => ({ ok: false, reason: 'simulated boom' })
    const events: InitStepEvent[] = []

    await runInit({ cwd: root, apiKey: 'fw_test_key', runHatching, onProgress: (e) => events.push(e) })

    const hatchDone = events.find((e) => e.step === 'hatching' && e.phase === 'done')
    if (!(hatchDone && hatchDone.step === 'hatching' && hatchDone.phase === 'done')) {
      throw new Error('expected hatching:done')
    }
    expect(hatchDone.result).toEqual({ ok: false, reason: 'simulated boom' })
  })

  test('produces an initialized agent folder (config, secrets, markdown, git repo)', async () => {
    await runInit({ cwd: root, apiKey: 'fw_integration_key', runHatching: okHatch })

    expect(isInitialized(root)).toBe(true)
    expect(await readFile(join(root, '.env'), 'utf8')).toBe('FIREWORKS_API_KEY=fw_integration_key\n')
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(true)
    expect(existsSync(join(root, '.git'))).toBe(true)
    expect(await runGit(root, ['log', '--oneline'])).toContain('Initial commit 🥚')
  })

  test('git step sees scaffolded files (step ordering)', async () => {
    await runInit({ cwd: root, apiKey: 'fw_test_key', runHatching: okHatch })

    const tracked = (await runGit(root, ['ls-files'])).split('\n')
    expect(tracked).toContain('typeclaw.json')
    expect(tracked).toContain('cron.json')
    expect(tracked).toContain('package.json')
    expect(tracked).toContain('.gitignore')
    expect(tracked).toContain('AGENTS.md')
    expect(tracked).toContain('Dockerfile')
  })

  test('dockerfile step writes Dockerfile and reports devMode via event', async () => {
    const events: InitStepEvent[] = []

    await runInit({ cwd: root, apiKey: 'fw_test_key', runHatching: okHatch, onProgress: (e) => events.push(e) })

    expect(existsSync(join(root, 'Dockerfile'))).toBe(true)

    const dockerDone = events.find((e) => e.step === 'dockerfile' && e.phase === 'done')
    if (!(dockerDone && dockerDone.step === 'dockerfile' && dockerDone.phase === 'done' && dockerDone.result.ok)) {
      throw new Error('expected dockerfile:done with ok result')
    }
    expect(dockerDone.result.devMode).toBe(true)
  })

  test('Dockerfile installs git so agents can use it at runtime', async () => {
    await runInit({ cwd: root, apiKey: 'fw_test_key', runHatching: okHatch, onProgress: () => {} })

    const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8')
    expect(dockerfile).toMatch(/apt-get[\s\S]+install[\s\S]+\bgit\b/)
  })

  test('emits git done event with skipped: false when repo is freshly initialized', async () => {
    const events: InitStepEvent[] = []

    await runInit({ cwd: root, apiKey: 'fw_test_key', runHatching: okHatch, onProgress: (e) => events.push(e) })

    const gitDone = events.find((e) => e.step === 'git' && e.phase === 'done')
    if (!(gitDone && gitDone.step === 'git' && gitDone.phase === 'done' && gitDone.result.ok)) {
      throw new Error('expected git:done with ok result')
    }
    expect(gitDone.result.skipped).toBe(false)
  })

  test('skips git init when .git already exists', async () => {
    await mkdir(join(root, '.git'))
    const events: InitStepEvent[] = []

    await runInit({ cwd: root, apiKey: 'fw_test_key', runHatching: okHatch, onProgress: (e) => events.push(e) })

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
    await runInit({ cwd: root, apiKey: 'fw_test_key', runHatching: okHatch, onProgress: (e) => events.push(e) })

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
    await runInit({ cwd: root, apiKey: 'fw_test_key', runHatching: okHatch })

    expect(isInitialized(root)).toBe(true)
  })

  test('is idempotent: re-running after a failed hatching re-runs all steps without crashing', async () => {
    // given: a prior run where hatching failed (e.g. docker daemon was down).
    const failingHatch: HatchRunner = async () => ({ ok: false, reason: 'docker build failed' })
    await runInit({ cwd: root, apiKey: 'fw_first_key', runHatching: failingHatch })
    expect(isInitialized(root)).toBe(true)
    expect(await isHatched(root)).toBe(false)

    // when: the user retries `typeclaw init` with a working setup.
    const events: InitStepEvent[] = []
    await runInit({ cwd: root, apiKey: 'fw_second_key', runHatching: okHatch, onProgress: (e) => events.push(e) })

    // then: every step ran again, and git step reports skipped because the repo already exists.
    expect(events.map((e) => `${e.step}:${e.phase}`)).toEqual([
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
    expect(await readFile(join(root, '.env'), 'utf8')).toBe('FIREWORKS_API_KEY=fw_second_key\n')
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

    for (const dir of ['workspace', 'sessions', 'memory', 'skills', '.agents/skills', 'mounts']) {
      const path = join(root, dir)
      expect(existsSync(path)).toBe(true)
      expect(statSync(path).isDirectory()).toBe(true)
    }
  })

  test('writes typeclaw.json with $schema reference, model, and empty mounts array', async () => {
    await scaffold(root)

    const raw = await readFile(join(root, 'typeclaw.json'), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(JSON.parse(raw)).toEqual({
      $schema: './node_modules/typeclaw/typeclaw.schema.json',
      model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo',
      mounts: [],
    })
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

    for (const file of ['AGENTS.md', 'IDENTITY.md', 'SOUL.md', 'USER.md', 'MEMORY.md']) {
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
    expect(gitignore).toMatch(/^channels\/state\/$/m)
    expect(gitignore).toMatch(/^channels\/sessions\.json$/m)
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
    await writeSecrets(root, { fireworksApiKey: 'fw_test' })

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
    expect(dockerfile).toContain('FROM oven/bun:1-slim')
    expect(dockerfile).toContain('WORKDIR /agent')
    expect(dockerfile).toContain('typeclaw')
  })

  test('Dockerfile leads with an AUTOGENERATED warning so users and agents do not edit the artifact', async () => {
    await scaffold(root)

    await writeDockerAssets(root)

    const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8')
    expect(dockerfile.startsWith('# AUTOGENERATED')).toBe(true)
    expect(dockerfile).toContain('src/init/dockerfile.ts')
    expect(dockerfile).toMatch(/rewritten on every[^\n]*typeclaw start/)
  })

  test('Dockerfile installs agent-browser globally and pre-downloads Chromium with system deps', async () => {
    await scaffold(root)

    await writeDockerAssets(root)

    const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8')
    // anchored to the start of a line so a commented-out RUN does not match.
    expect(dockerfile).toMatch(/^RUN[^\n]*\bbun install -g agent-browser\b/m)
    expect(dockerfile).toMatch(/^[^#\n]*\bagent-browser install --with-deps\b/m)
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
  test('writes FIREWORKS_API_KEY to .env', async () => {
    await writeSecrets(root, { fireworksApiKey: 'fw_test_abc123' })

    expect(await readFile(join(root, '.env'), 'utf8')).toBe('FIREWORKS_API_KEY=fw_test_abc123\n')
  })

  test('overwrites an existing .env', async () => {
    await writeFile(join(root, '.env'), 'OLD=1\n')
    await writeSecrets(root, { fireworksApiKey: 'fw_new' })

    expect(await readFile(join(root, '.env'), 'utf8')).toBe('FIREWORKS_API_KEY=fw_new\n')
  })
})
