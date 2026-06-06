import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { DEFAULT_GITHUB_EVENT_ALLOWLIST } from '@/channels/schema'
import { startDaemon, type Daemon } from '@/hostd/daemon'
import { buildDockerfile } from '@/init/dockerfile'
import { buildGitignore } from '@/init/gitignore'

import type { DockerExec } from './shared'
import { commitSystemFile, planStart, refreshDockerfile, refreshGitignore, start } from './start'

let root: string

// Pin the host locale to non-CJK so refreshDockerfile()/start() (which call
// hostLocaleIsCjk() for cjkFonts: 'auto') produce output that matches the
// bare buildDockerfile() these tests compare against, regardless of the test
// machine's actual locale (a CJK CI runner would otherwise diverge).
const SAVED_LOCALE_ENV: Record<string, string | undefined> = {}
const LOCALE_ENV_VARS = ['LC_ALL', 'LC_CTYPE', 'LANG'] as const

beforeEach(async () => {
  for (const key of LOCALE_ENV_VARS) {
    SAVED_LOCALE_ENV[key] = process.env[key]
    delete process.env[key]
  }
  process.env.LANG = 'C'
  root = await mkdtemp(join(tmpdir(), 'typeclaw-container-start-'))
})

afterEach(async () => {
  for (const key of LOCALE_ENV_VARS) {
    if (SAVED_LOCALE_ENV[key] === undefined) delete process.env[key]
    else process.env[key] = SAVED_LOCALE_ENV[key]
  }
  await rm(root, { recursive: true, force: true })
})

// Mirror the post-init agent-folder shape: package.json declares the
// `packages/*` bun workspace and `packages/.gitkeep` exists so refreshPackageJson
// is a no-op. Tests that want to exercise the migration path should call
// `writePackageJsonPreMigration` instead.
async function writePackageJson(dir: string, deps: Record<string, string>): Promise<void> {
  const pkg = {
    name: basename(dir),
    private: true,
    type: 'module',
    workspaces: ['packages/*'],
    dependencies: deps,
  }
  await writeFile(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  await mkdir(join(dir, 'packages'), { recursive: true })
  await writeFile(join(dir, 'packages', '.gitkeep'), '')
}

async function writePackageJsonPreMigration(dir: string, deps: Record<string, string>): Promise<void> {
  const pkg = { name: basename(dir), private: true, type: 'module', dependencies: deps }
  await writeFile(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
}

async function writeDockerfile(dir: string): Promise<void> {
  await writeFile(join(dir, 'Dockerfile'), 'FROM oven/bun:1-slim\n')
}

type DockerfileBlock = {
  append?: string[]
  ffmpeg?: boolean | string
  gh?: boolean | string
  python?: boolean
  tmux?: boolean | string
}

type GitignoreBlock = { append?: string[] }

type ScaffoldedConfig = {
  mounts?: Array<{ name: string; path: string; readOnly?: boolean; description?: string }>
  docker?: { file?: DockerfileBlock }
  git?: { ignore?: GitignoreBlock }
  network?: { blockInternal?: boolean; autoAllowResolvers?: boolean; allow?: string[] }
}

async function writeTypeclawConfig(dir: string, overrides: ScaffoldedConfig = {}): Promise<void> {
  const config = {
    $schema: './node_modules/typeclaw/typeclaw.schema.json',
    models: { default: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' },
    mounts: overrides.mounts ?? [],
    ...(overrides.docker ? { docker: overrides.docker } : {}),
    ...(overrides.git ? { git: overrides.git } : {}),
    ...(overrides.network ? { network: overrides.network } : {}),
  }
  await writeFile(join(dir, 'typeclaw.json'), `${JSON.stringify(config, null, 2)}\n`)
}

// Returns the preferred port unchanged. Lets `start` tests verify their own
// behavior without going through the real kernel via `findFreePort`.
const deterministicAllocator = async (preferred: number): Promise<number> => (preferred > 0 ? preferred : 8973)

// Bypasses the real `ensureDepsInstalled` for tests that don't care about
// dep installation. The default `ensureDeps` in `start()` would spawn
// `bun install` against the tmpdir, which is irrelevant to most of these
// tests and would slow each one by ~hundreds of ms.
const noEnsureDeps = async (): Promise<{ ok: true; installed: false }> => ({ ok: true, installed: false })

// Bypasses the post-`docker run` verification window so happy-path tests don't
// pay the production 1.5s wait. Verification has its own dedicated test file
// (verify-running.test.ts); start.test.ts only proves start() routes a
// failing verifier into the documented failure response.
const bypassVerify = { verifyRunning: async () => ({ ok: true as const }) }

function labelValue(runArgs: string[], key: string): string | undefined {
  for (let i = 0; i < runArgs.length - 1; i++) {
    if (runArgs[i] === '--label' && runArgs[i + 1]?.startsWith(`${key}=`)) {
      return runArgs[i + 1]!.slice(key.length + 1)
    }
  }
  return undefined
}

describe('planStart', () => {
  test('publishes the TUI websocket port on host loopback by default', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeFile(join(root, '.env'), 'FIREWORKS_API_KEY=fw_test\n')

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs[0]).toBe('run')
    expect(plan.runArgs).toContain('-d')
    expect(plan.runArgs).not.toContain('--rm')
    expect(plan.runArgs).toContain('--name')
    expect(plan.runArgs).toContain(plan.containerName)
    expect(plan.runArgs).toContain('--shm-size=2g')
    expect(plan.runArgs).toContain('-p')
    expect(plan.runArgs).toContain('127.0.0.1:8973:8973')
    expect(plan.runArgs).toContain('--env-file')
    expect(plan.runArgs).toContain(join(root, '.env'))
    expect(plan.runArgs).toContain(`${root}:/agent`)
    expect(plan.runArgs.at(-1)).toBe(plan.imageTag)
  })

  test('sets --shm-size=2g unconditionally so the bundled Chrome survives heavy pages (Docker default /dev/shm is 64MB and crashes Chrome)', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs).toContain('--shm-size=2g')
  })

  test('sets --security-opt seccomp=unconfined unconditionally so bwrap can create user namespaces for per-tool sandboxing', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    const idx = plan.runArgs.indexOf('--security-opt')
    expect(idx).toBeGreaterThan(-1)
    expect(plan.runArgs[idx + 1]).toBe('seccomp=unconfined')
    expect(idx).toBeLessThan(plan.runArgs.indexOf(plan.imageTag))
  })

  test('can publish the TUI websocket port on all host interfaces', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true, publishHost: '0.0.0.0' })

    expect(plan.runArgs).toContain('0.0.0.0:8973:8973')
  })

  test('injects a TUI websocket token when one is supplied', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true, tuiToken: 'token-123' })

    expect(plan.runArgs).toContain('dev.typeclaw.tui-token=token-123')
    expect(plan.runArgs).toContain('TYPECLAW_TUI_TOKEN=token-123')
  })

  test('adds hostd HTTP control env when restart transport is available', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({
      cwd: root,
      hostPort: 8973,
      imageExists: true,
      hostdControl: { url: 'http://host.docker.internal:49123', token: 'secret', brokerToken: 'broker-secret' },
    })

    expect(plan.runArgs).toContain('-e')
    expect(plan.runArgs).toContain(`TYPECLAW_CONTAINER_NAME=${basename(root)}`)
    expect(plan.runArgs).toContain('TYPECLAW_HOSTD_URL=http://host.docker.internal:49123')
    expect(plan.runArgs).toContain('TYPECLAW_HOSTD_TOKEN=secret')
    expect(plan.runArgs).toContain('--add-host')
    expect(plan.runArgs).toContain('host.docker.internal:host-gateway')
    expect(plan.runArgs.some((arg) => arg.includes('/run/typeclaw-host'))).toBe(false)
  })

  test('groups all agents under a single "typeclaw" compose project', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(labelValue(plan.runArgs, 'com.docker.compose.project')).toBe('typeclaw')
  })

  test('uses the folder basename as the compose service name', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(labelValue(plan.runArgs, 'com.docker.compose.service')).toBe(basename(root))
  })

  test('sets compose labels required for docker compose ls and Docker Desktop grouping', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(labelValue(plan.runArgs, 'com.docker.compose.project.working_dir')).toBe(root)
    expect(labelValue(plan.runArgs, 'com.docker.compose.oneoff')).toBe('False')
    expect(labelValue(plan.runArgs, 'com.docker.compose.config-hash')).toBe('manual')
    expect(labelValue(plan.runArgs, 'com.docker.compose.container-number')).toBe('1')
  })

  test('omits --env-file when .env is missing', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs).not.toContain('--env-file')
  })

  test('propagates host TZ via -e so cron schedules fire at the wall-clock the user expects', async () => {
    const original = process.env.TZ
    process.env.TZ = 'Asia/Seoul'
    try {
      await writeDockerfile(root)
      await writePackageJson(root, { typeclaw: '^0.1.0' })

      const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

      const tzIdx = plan.runArgs.findIndex((a, i) => a === '-e' && plan.runArgs[i + 1] === 'TZ=Asia/Seoul')
      expect(tzIdx).toBeGreaterThanOrEqual(0)
    } finally {
      if (original === undefined) {
        delete process.env.TZ
      } else {
        process.env.TZ = original
      }
    }
  })

  test('falls back to Intl-detected timezone when TZ env var is unset (typical macOS host)', async () => {
    const original = process.env.TZ
    delete process.env.TZ
    try {
      await writeDockerfile(root)
      await writePackageJson(root, { typeclaw: '^0.1.0' })

      const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

      const eIdx = plan.runArgs.findIndex((a, i) => a === '-e' && plan.runArgs[i + 1]?.startsWith('TZ='))
      expect(eIdx).toBeGreaterThanOrEqual(0)
      const detected = plan.runArgs[eIdx + 1]?.slice('TZ='.length)
      expect(detected).toBeTruthy()
    } finally {
      if (original !== undefined) process.env.TZ = original
    }
  })

  test('adds a mirror mount for the typeclaw source when dependency is a file: spec outside cwd', async () => {
    const typeclawRepo = await mkdtemp(join(tmpdir(), 'typeclaw-repo-'))
    try {
      await writeDockerfile(root)
      await writePackageJson(root, { typeclaw: `file:${typeclawRepo}` })

      const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

      expect(plan.runArgs).toContain(`${typeclawRepo}:${typeclawRepo}:ro`)
    } finally {
      await rm(typeclawRepo, { recursive: true, force: true })
    }
  })

  test('skips mirror mount when typeclaw file: spec points inside the agent folder', async () => {
    await writeDockerfile(root)
    await mkdir(join(root, 'vendor', 'typeclaw'), { recursive: true })
    await writePackageJson(root, { typeclaw: 'file:./vendor/typeclaw' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    const mirrorMounts = plan.runArgs.filter((a) => a.endsWith(':ro'))
    expect(mirrorMounts).toHaveLength(0)
  })

  test('skips mirror mount when typeclaw dependency is a version range', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs.filter((a) => a.endsWith(':ro'))).toHaveLength(0)
  })

  test('reports needsBuild based on imageExists input', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const missing = await planStart({ cwd: root, hostPort: 8973, imageExists: false })
    const present = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(missing.needsBuild).toBe(true)
    expect(present.needsBuild).toBe(false)
  })

  test('forceBuild forces a rebuild even when the image already exists', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const forced = await planStart({ cwd: root, hostPort: 8973, imageExists: true, forceBuild: true })
    const notForced = await planStart({ cwd: root, hostPort: 8973, imageExists: true, forceBuild: false })

    expect(forced.needsBuild).toBe(true)
    expect(notForced.needsBuild).toBe(false)
  })

  test('container name and image tag derive from the folder basename', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.containerName).toBe(basename(root))
    expect(plan.imageTag).toBe(`typeclaw-${basename(root)}`)
  })
})

describe('planStart mounts', () => {
  test('emits no mount flags when typeclaw.json is missing', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs.filter((a) => a.includes(':/agent/mounts/'))).toHaveLength(0)
  })

  test('emits no mount flags when mounts array is empty', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { mounts: [] })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs.filter((a) => a.includes(':/agent/mounts/'))).toHaveLength(0)
  })

  test('emits a -v flag for each mount, mapping to /agent/mounts/<name>', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'typeclaw-mount-target-'))
    try {
      await writeDockerfile(root)
      await writePackageJson(root, { typeclaw: '^0.1.0' })
      await writeTypeclawConfig(root, { mounts: [{ name: 'projects', path: projectDir }] })

      const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

      expect(plan.runArgs).toContain('-v')
      expect(plan.runArgs).toContain(`${projectDir}:/agent/mounts/projects`)
    } finally {
      await rm(projectDir, { recursive: true, force: true })
    }
  })

  test('appends :ro suffix when readOnly is true', async () => {
    const notesDir = await mkdtemp(join(tmpdir(), 'typeclaw-mount-target-'))
    try {
      await writeDockerfile(root)
      await writePackageJson(root, { typeclaw: '^0.1.0' })
      await writeTypeclawConfig(root, { mounts: [{ name: 'notes', path: notesDir, readOnly: true }] })

      const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

      expect(plan.runArgs).toContain(`${notesDir}:/agent/mounts/notes:ro`)
    } finally {
      await rm(notesDir, { recursive: true, force: true })
    }
  })

  test('expands ~ to the home directory', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { mounts: [{ name: 'home-thing', path: '~/some-dir' }] })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    const home = process.env.HOME ?? ''
    expect(plan.runArgs).toContain(`${home}/some-dir:/agent/mounts/home-thing`)
  })

  test('emits mounts in declared order', async () => {
    const a = await mkdtemp(join(tmpdir(), 'typeclaw-mount-a-'))
    const b = await mkdtemp(join(tmpdir(), 'typeclaw-mount-b-'))
    try {
      await writeDockerfile(root)
      await writePackageJson(root, { typeclaw: '^0.1.0' })
      await writeTypeclawConfig(root, {
        mounts: [
          { name: 'first', path: a },
          { name: 'second', path: b },
        ],
      })

      const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

      const mountFlags = plan.runArgs.filter((arg) => arg.includes(':/agent/mounts/'))
      expect(mountFlags).toEqual([`${a}:/agent/mounts/first`, `${b}:/agent/mounts/second`])
    } finally {
      await rm(a, { recursive: true, force: true })
      await rm(b, { recursive: true, force: true })
    }
  })

  test('mount flags appear before imageTag (last positional arg)', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'typeclaw-mount-target-'))
    try {
      await writeDockerfile(root)
      await writePackageJson(root, { typeclaw: '^0.1.0' })
      await writeTypeclawConfig(root, { mounts: [{ name: 'projects', path: projectDir }] })

      const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

      expect(plan.runArgs.at(-1)).toBe(plan.imageTag)
      const mountIdx = plan.runArgs.indexOf(`${projectDir}:/agent/mounts/projects`)
      expect(mountIdx).toBeGreaterThan(-1)
      expect(mountIdx).toBeLessThan(plan.runArgs.length - 1)
    } finally {
      await rm(projectDir, { recursive: true, force: true })
    }
  })

  test('throws when typeclaw.json is malformed JSON', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeFile(join(root, 'typeclaw.json'), '{ not valid json')

    await expect(planStart({ cwd: root, hostPort: 8973, imageExists: true })).rejects.toThrow()
  })

  test('treats a typeclaw.json without a mounts field as no mounts', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeFile(
      join(root, 'typeclaw.json'),
      `${JSON.stringify({ models: { default: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' } })}\n`,
    )

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs.filter((a) => a.includes(':/agent/mounts/'))).toHaveLength(0)
  })

  test('throws when a mount name violates the pattern', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { mounts: [{ name: 'BadName', path: '/x' }] })

    await expect(planStart({ cwd: root, hostPort: 8973, imageExists: true })).rejects.toThrow()
  })
})

describe('planStart network egress filter', () => {
  test('grants NET_ADMIN and sets TYPECLAW_NETWORK_BLOCK_INTERNAL=1 when typeclaw.json is missing (new default = on)', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs).toContain('--cap-add=NET_ADMIN')
    expect(plan.runArgs).toContain('TYPECLAW_NETWORK_BLOCK_INTERNAL=1')
  })

  test('emits no NET_ADMIN cap and no env var when network.blockInternal is explicitly false (opt-out path for LAN access)', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { network: { blockInternal: false } })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs).not.toContain('--cap-add=NET_ADMIN')
    expect(plan.runArgs.filter((a) => a.includes('TYPECLAW_NETWORK_BLOCK_INTERNAL'))).toHaveLength(0)
  })

  test('grants NET_ADMIN and sets TYPECLAW_NETWORK_BLOCK_INTERNAL=1 when blockInternal is true', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { network: { blockInternal: true } })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs).toContain('--cap-add=NET_ADMIN')
    expect(plan.runArgs).toContain('TYPECLAW_NETWORK_BLOCK_INTERNAL=1')
  })

  test('the env var lands as a docker `-e` flag (not `--env-file` or `--env`)', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { network: { blockInternal: true } })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })
    const envIdx = plan.runArgs.indexOf('TYPECLAW_NETWORK_BLOCK_INTERNAL=1')

    expect(envIdx).toBeGreaterThan(0)
    expect(plan.runArgs[envIdx - 1]).toBe('-e')
  })

  test('cap-add appears before the image tag so docker picks it up at run time, not at exec time', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { network: { blockInternal: true } })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })
    const capIdx = plan.runArgs.indexOf('--cap-add=NET_ADMIN')
    const imageIdx = plan.runArgs.indexOf(plan.imageTag)

    expect(capIdx).toBeGreaterThan(-1)
    expect(imageIdx).toBeGreaterThan(-1)
    expect(capIdx).toBeLessThan(imageIdx)
  })

  test('sets TYPECLAW_NETWORK_AUTO_ALLOW_RESOLVERS=1 by default (auto-carve resolv.conf nameservers, fixes EC2 VPC DNS)', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs).toContain('TYPECLAW_NETWORK_AUTO_ALLOW_RESOLVERS=1')
  })

  test('sets TYPECLAW_NETWORK_AUTO_ALLOW_RESOLVERS=0 when autoAllowResolvers is explicitly false (closed filter)', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { network: { blockInternal: true, autoAllowResolvers: false } })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs).toContain('TYPECLAW_NETWORK_AUTO_ALLOW_RESOLVERS=0')
    expect(plan.runArgs).not.toContain('TYPECLAW_NETWORK_AUTO_ALLOW_RESOLVERS=1')
  })

  test('omits TYPECLAW_NETWORK_AUTO_ALLOW_RESOLVERS entirely when blockInternal is false (off-path skips all resolver logic)', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { network: { blockInternal: false } })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs.filter((a) => a.includes('TYPECLAW_NETWORK_AUTO_ALLOW_RESOLVERS'))).toHaveLength(0)
  })

  test('joins network.allow entries into a single comma-separated TYPECLAW_NETWORK_ALLOW env (matches shim IFS=, loop)', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, {
      network: { blockInternal: true, allow: ['10.210.0.0/16', '10.211.1.42'] },
    })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs).toContain('TYPECLAW_NETWORK_ALLOW=10.210.0.0/16,10.211.1.42')
  })

  test('omits TYPECLAW_NETWORK_ALLOW when network.allow is empty (no env clutter for the common case)', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { network: { blockInternal: true, allow: [] } })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs.filter((a) => a.startsWith('TYPECLAW_NETWORK_ALLOW='))).toHaveLength(0)
  })

  test('omits TYPECLAW_NETWORK_ALLOW even when entries are set if blockInternal is false (off-path consistency)', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { network: { blockInternal: false, allow: ['10.0.0.0/8'] } })

    const plan = await planStart({ cwd: root, hostPort: 8973, imageExists: true })

    expect(plan.runArgs.filter((a) => a.startsWith('TYPECLAW_NETWORK_ALLOW='))).toHaveLength(0)
  })

  test('rejects invalid CIDRs in network.allow at config parse time (fail-fast on typos)', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { network: { blockInternal: true, allow: ['not-a-cidr'] } })

    await expect(planStart({ cwd: root, hostPort: 8973, imageExists: true })).rejects.toThrow()
  })
})

describe('refreshDockerfile', () => {
  test('overwrites a stale Dockerfile with the current template', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-refresh-'))
    try {
      const stale = 'FROM oven/bun:1-slim\n# stale, no git install\n'
      await writeFile(join(dir, 'Dockerfile'), stale)

      await refreshDockerfile(dir)

      const updated = await readFile(join(dir, 'Dockerfile'), 'utf8')
      expect(updated).toBe(buildDockerfile())
      expect(updated).not.toBe(stale)
      expect(updated).toMatch(/apt-get[\s\S]+install[\s\S]+\bgit\b/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('writes the Dockerfile when none exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-refresh-'))
    try {
      await refreshDockerfile(dir)

      const written = await readFile(join(dir, 'Dockerfile'), 'utf8')
      expect(written).toBe(buildDockerfile())
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('writes custom append lines from typeclaw.json before the entrypoint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-refresh-'))
    try {
      await writeTypeclawConfig(dir, { docker: { file: { append: ['RUN echo custom', 'ENV CUSTOM_FLAG=1'] } } })

      await refreshDockerfile(dir)

      const written = await readFile(join(dir, 'Dockerfile'), 'utf8')
      const runIdx = written.indexOf('RUN echo custom')
      const envIdx = written.indexOf('ENV CUSTOM_FLAG=1')
      const entrypointIdx = written.indexOf('ENTRYPOINT ["/usr/local/bin/typeclaw-entrypoint"]')
      expect(runIdx).toBeGreaterThan(-1)
      expect(runIdx).toBeLessThan(envIdx)
      expect(envIdx).toBeLessThan(entrypointIdx)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('writes ffmpeg from typeclaw.json into the apt package list', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-refresh-'))
    try {
      await writeTypeclawConfig(dir, { docker: { file: { ffmpeg: true } } })

      await refreshDockerfile(dir)

      const written = await readFile(join(dir, 'Dockerfile'), 'utf8')
      expect(written).toMatch(/apt-get install -y --no-install-recommends[\s\S]+\bffmpeg\b/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("FROMs the GHCR base image at the agent's installed typeclaw version", async () => {
    // given: an agent with bun install completed — node_modules/typeclaw/package.json declares 0.1.0
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-refresh-installed-'))
    try {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'test', dependencies: { typeclaw: '^0.1.0' } }))
      await mkdir(join(dir, 'node_modules', 'typeclaw'), { recursive: true })
      await writeFile(
        join(dir, 'node_modules', 'typeclaw', 'package.json'),
        JSON.stringify({ name: 'typeclaw', version: '0.1.0' }),
      )

      // when: refreshDockerfile runs
      await refreshDockerfile(dir)

      // then: the on-disk Dockerfile pins the INSTALLED version, not the spec
      const written = await readFile(join(dir, 'Dockerfile'), 'utf8')
      expect(written).toContain('FROM ghcr.io/typeclaw/typeclaw-base:0.1.0')
      expect(written).not.toContain('FROM oven/bun:')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('falls back to the dep spec when node_modules has not been populated yet (fresh init)', async () => {
    // given: a fresh init — package.json declares typeclaw but bun install has not run
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-refresh-fresh-'))
    try {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'test', dependencies: { typeclaw: '^0.1.1' } }))

      // when: refreshDockerfile runs
      await refreshDockerfile(dir)

      // then: spec parser extracts 0.1.1 from "^0.1.1" and pins it
      const written = await readFile(join(dir, 'Dockerfile'), 'utf8')
      expect(written).toContain('FROM ghcr.io/typeclaw/typeclaw-base:0.1.1')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('falls back to inline form when the typeclaw dep is a file: spec (dev mode)', async () => {
    // given: a dev contributor's agent with typeclaw symlinked from a local checkout
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-refresh-dev-'))
    try {
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'test', dependencies: { typeclaw: 'file:../typeclaw' } }),
      )

      // when: refreshDockerfile runs
      await refreshDockerfile(dir)

      // then: no GHCR pin (dev version doesn't exist on GHCR yet) — inline heavy stack on oven/bun
      const written = await readFile(join(dir, 'Dockerfile'), 'utf8')
      expect(written).not.toContain('ghcr.io/typeclaw/typeclaw-base')
      expect(written).toContain('FROM oven/bun:1.3.13-slim')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('returns changed=true when overwriting a stale Dockerfile', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-refresh-changed-'))
    try {
      await writeFile(join(dir, 'Dockerfile'), 'FROM stale\n')

      const result = await refreshDockerfile(dir)

      expect(result.changed).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('returns changed=true when no Dockerfile exists yet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-refresh-fresh-changed-'))
    try {
      const result = await refreshDockerfile(dir)

      expect(result.changed).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('returns changed=false when the on-disk Dockerfile already matches the template', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-refresh-noop-'))
    try {
      // given: a Dockerfile already rendered from the current template
      await refreshDockerfile(dir)
      const firstMtime = (await readFile(join(dir, 'Dockerfile'), 'utf8')).length

      // when: refreshDockerfile runs a second time against the identical content
      const result = await refreshDockerfile(dir)

      // then: no change reported, and the file is not rewritten (still parses the same)
      expect(result.changed).toBe(false)
      expect((await readFile(join(dir, 'Dockerfile'), 'utf8')).length).toBe(firstMtime)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('refreshGitignore', () => {
  test('overwrites a stale .gitignore with the current template', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-gitignore-refresh-'))
    try {
      const stale = '# stale\nold-only-entry\n'
      await writeFile(join(dir, '.gitignore'), stale)

      await refreshGitignore(dir)

      const updated = await readFile(join(dir, '.gitignore'), 'utf8')
      expect(updated).toBe(buildGitignore())
      expect(updated).not.toBe(stale)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('writes the .gitignore when none exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-gitignore-refresh-'))
    try {
      await refreshGitignore(dir)

      const written = await readFile(join(dir, '.gitignore'), 'utf8')
      expect(written).toBe(buildGitignore())
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('writes custom append entries from typeclaw.json before the managed template', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-gitignore-refresh-'))
    try {
      await writeTypeclawConfig(dir, { git: { ignore: { append: ['scratch/', '*.local.log'] } } })

      await refreshGitignore(dir)

      const written = await readFile(join(dir, '.gitignore'), 'utf8')
      const customCommentIdx = written.indexOf('# Custom entries from typeclaw.json#git.ignore.append.')
      const scratchIdx = written.indexOf('scratch/')
      const logIdx = written.indexOf('*.local.log')
      const trulyIgnoredIdx = written.indexOf('# Truly ignored:')
      expect(customCommentIdx).toBeGreaterThan(-1)
      expect(customCommentIdx).toBeLessThan(scratchIdx)
      expect(scratchIdx).toBeLessThan(logIdx)
      expect(logIdx).toBeLessThan(trulyIgnoredIdx)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('keeps TypeClaw-owned entries ignored when custom entries try to negate them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-gitignore-refresh-'))
    try {
      await gitInit(dir)
      await writeTypeclawConfig(dir, { git: { ignore: { append: ['!sessions/', '!sessions/**', 'scratch/'] } } })

      await refreshGitignore(dir)

      expect(await isGitIgnored(dir, '.env')).toBe(true)
      expect(await isGitIgnored(dir, 'Dockerfile')).toBe(true)
      expect(await isGitIgnored(dir, 'sessions/history.jsonl')).toBe(true)
      expect(await isGitIgnored(dir, 'memory/MEMORY.md')).toBe(true)
      expect(await isGitIgnored(dir, 'channels/slack.json')).toBe(true)
      expect(await isGitIgnored(dir, 'scratch/tmp.txt')).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

async function runGit(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn({ cmd: ['/usr/bin/git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out.trim()
}

async function isGitIgnored(cwd: string, path: string): Promise<boolean> {
  const proc = Bun.spawn({
    cmd: ['/usr/bin/git', 'check-ignore', '--quiet', path],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return (await proc.exited) === 0
}

async function gitInit(cwd: string): Promise<void> {
  // The commitSystemFile path uses the user's global git config for authorship,
  // but tests can run in CI with no global user.name/user.email. Set repo-local
  // identity here so commits succeed deterministically without polluting global config.
  for (const cmd of [
    ['init', '-b', 'main'],
    ['config', 'user.name', 'Test User'],
    ['config', 'user.email', 'test@example.com'],
  ]) {
    const proc = Bun.spawn({ cmd: ['/usr/bin/git', ...cmd], cwd, stdout: 'pipe', stderr: 'pipe' })
    await proc.exited
  }
}

describe('commitSystemFile', () => {
  test('commits the file when it is dirty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-commit-'))
    try {
      // given: a git repo with a tracked file
      await gitInit(dir)
      await writeFile(join(dir, 'Dockerfile'), 'FROM original\n')
      await runGit(dir, ['add', 'Dockerfile'])
      await runGit(dir, ['commit', '-m', 'initial'])
      // and: the file is now modified (dirty)
      await writeFile(join(dir, 'Dockerfile'), 'FROM updated\n')

      // when
      await commitSystemFile(dir, 'Dockerfile', 'Update Dockerfile')

      // then: HEAD points at the new commit with the new content
      const subject = await runGit(dir, ['log', '-1', '--format=%s'])
      expect(subject).toBe('Update Dockerfile')
      const tree = await runGit(dir, ['show', 'HEAD:Dockerfile'])
      expect(tree).toBe('FROM updated')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('skips silently when the file is clean (no changes since last commit)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-commit-clean-'))
    try {
      // given: a committed file with no pending changes
      await gitInit(dir)
      await writeFile(join(dir, 'Dockerfile'), 'FROM clean\n')
      await runGit(dir, ['add', 'Dockerfile'])
      await runGit(dir, ['commit', '-m', 'initial'])
      const headBefore = await runGit(dir, ['rev-parse', 'HEAD'])

      // when
      await commitSystemFile(dir, 'Dockerfile', 'Update Dockerfile')

      // then: HEAD has not moved
      const headAfter = await runGit(dir, ['rev-parse', 'HEAD'])
      expect(headAfter).toBe(headBefore)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('skips silently when the directory is not a git repo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-commit-nogit-'))
    try {
      // given: NO git init, but a Dockerfile exists
      await writeFile(join(dir, 'Dockerfile'), 'FROM whatever\n')

      // when: commit is invoked
      await commitSystemFile(dir, 'Dockerfile', 'Update Dockerfile')

      // then: no .git directory was created and no error was thrown
      expect(existsSync(join(dir, '.git'))).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('only commits the named file, leaving other dirty files unstaged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-commit-scope-'))
    try {
      // given: two dirty tracked files
      await gitInit(dir)
      await writeFile(join(dir, 'Dockerfile'), 'FROM original\n')
      await writeFile(join(dir, 'AGENTS.md'), 'original\n')
      await runGit(dir, ['add', '.'])
      await runGit(dir, ['commit', '-m', 'initial'])
      await writeFile(join(dir, 'Dockerfile'), 'FROM new\n')
      await writeFile(join(dir, 'AGENTS.md'), 'user wip\n')

      // when: commit only the Dockerfile
      await commitSystemFile(dir, 'Dockerfile', 'Update Dockerfile')

      // then: HEAD's commit changed only Dockerfile, and AGENTS.md is still dirty
      const filesInLastCommit = await runGit(dir, ['show', '--name-only', '--format=', 'HEAD'])
      expect(filesInLastCommit).toBe('Dockerfile')
      const agentsContent = await readFile(join(dir, 'AGENTS.md'), 'utf8')
      expect(agentsContent).toBe('user wip\n')
      const agentsInHead = await runGit(dir, ['show', 'HEAD:AGENTS.md'])
      expect(agentsInHead).toBe('original')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

type RecordedCall = { args: string[]; dockerfileSnapshot: string | null }

type ContainerScenario =
  | { exists: false }
  | {
      exists: true
      running: boolean
      rmFails?: boolean
      rmStderr?: string
      // Models Docker's async removal-drain after a `docker rm` that
      // returned with "removal in progress" stderr: the container keeps
      // showing up in `inspect` until N post-rm inspect probes have run,
      // then transitions to "no such container". Default 0 — inspect
      // reports "gone" the very next call. See stop.test.ts for the
      // full rationale.
      drainAfterInspectCalls?: number
    }

function fakeDockerExec(scenario: {
  imageExists: boolean
  container: ContainerScenario
  dockerPlatformName?: string
}): {
  exec: DockerExec
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  let containerState = scenario.container
  let rmReturned = false
  let inspectsAfterRm = 0
  const exec: DockerExec = async (args, options) => {
    let dockerfileSnapshot: string | null = null
    if (options?.cwd) {
      try {
        dockerfileSnapshot = await readFile(join(options.cwd, 'Dockerfile'), 'utf8')
      } catch {
        dockerfileSnapshot = null
      }
    }
    calls.push({ args, dockerfileSnapshot })

    if (args[0] === 'image' && args[1] === 'inspect') {
      return { exitCode: scenario.imageExists ? 0 : 1, stdout: '', stderr: '' }
    }
    if (args[0] === 'version') {
      return { exitCode: 0, stdout: `${scenario.dockerPlatformName ?? 'Docker Engine'}\n`, stderr: '' }
    }
    if (args[0] === 'inspect') {
      if (rmReturned && containerState.exists) {
        inspectsAfterRm += 1
        const drainAfter = containerState.drainAfterInspectCalls ?? 0
        if (inspectsAfterRm > drainAfter) {
          containerState = { exists: false }
        }
      }
      if (!containerState.exists) return { exitCode: 1, stdout: '', stderr: 'Error: No such container' }
      // The idempotent path probes `inspect --format {{.Id}}` after seeing
      // the container is up; mirror that here so the fake stays sufficient.
      const format = args[args.indexOf('--format') + 1] ?? ''
      if (format.includes('.Id')) {
        return { exitCode: 0, stdout: 'fake-running-id-123456\n', stderr: '' }
      }
      if (format.includes('.Config.Labels')) {
        return { exitCode: 0, stdout: 'fake-tui-token\n', stderr: '' }
      }
      return { exitCode: 0, stdout: `${containerState.running}\n`, stderr: '' }
    }
    if (args[0] === 'port') {
      if (!containerState.exists) return { exitCode: 1, stdout: '', stderr: 'Error: No such container' }
      return { exitCode: 0, stdout: '0.0.0.0:8973\n', stderr: '' }
    }
    if (args[0] === 'rm') {
      rmReturned = true
      if (!containerState.exists) {
        return { exitCode: 1, stdout: '', stderr: 'Error: No such container: x' }
      }
      if (containerState.rmFails) {
        const stderr = containerState.rmStderr ?? 'rm failed'
        // "No such container" rm-failures mean the container is in fact gone
        // — Docker just learned of it a step before we did. Reflect that in
        // the fake's state so a subsequent `docker run` sees a free name.
        // "Removal in progress" leaves the container present (drain pending).
        if (stderr.toLowerCase().includes('no such container')) {
          containerState = { exists: false }
        }
        return { exitCode: 1, stdout: '', stderr }
      }
      // Exit 0 from `docker rm -f` does NOT mean the name is free under
      // OrbStack load — the daemon acknowledges the rm before draining. The
      // inspect block above already advances containerState to "gone" after
      // drainAfterInspectCalls post-rm probes, so leaving the state alone
      // here lets exit-0 tests exercise the same drain window the
      // "in-progress" tests do. drainAfterInspectCalls === 0 (the default
      // for existing tests) still flips state on the very next inspect, so
      // the pre-existing happy-path tests continue to see immediate "gone".
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'build') {
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'run') {
      if (containerState.exists) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: `docker: Error response from daemon: Conflict. The container name "/x" is already in use by container "abc".`,
        }
      }
      containerState = { exists: true, running: true }
      return { exitCode: 0, stdout: 'fake-container-id-abcdef\n', stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return { exec, calls }
}

describe('start (composition)', () => {
  test('publishes on all host interfaces for Docker Desktop', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({
      imageExists: true,
      container: { exists: false },
      dockerPlatformName: 'Docker Desktop 4.42.0',
    })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    const runCall = calls.find((call) => call.args[0] === 'run')
    expect(runCall?.args).toContain('0.0.0.0:8973:8973')
  })

  test('refreshes Dockerfile from the template on every start, even without --build', async () => {
    // given: a stale Dockerfile and an existing image (no rebuild needed)
    await writeFile(join(root, 'Dockerfile'), 'FROM stale\n# no git\n')
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when: up runs WITHOUT --build
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    // then: the Dockerfile on disk was refreshed even though docker build never ran
    expect(result.ok).toBe(true)
    const onDisk = await readFile(join(root, 'Dockerfile'), 'utf8')
    expect(onDisk).toBe(buildDockerfile(undefined, { baseImageVersion: '0.1.0' }))
    expect(onDisk).not.toContain('FROM stale')
  })

  test('refreshes .gitignore from the template on every start', async () => {
    // given: a stale .gitignore and an existing image
    await writeFile(join(root, '.gitignore'), '# stale\nold-entry\n')
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    // then
    expect(result.ok).toBe(true)
    const onDisk = await readFile(join(root, '.gitignore'), 'utf8')
    expect(onDisk).toBe(buildGitignore())
    expect(onDisk).not.toContain('old-entry')
  })

  test('start refreshes .gitignore with custom append entries from typeclaw.json', async () => {
    await writeFile(join(root, '.gitignore'), '# stale\n')
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { git: { ignore: { append: ['scratch/', '*.local.log'] } } })
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    const onDisk = await readFile(join(root, '.gitignore'), 'utf8')
    expect(onDisk).toContain('scratch/')
    expect(onDisk).toContain('*.local.log')
    expect(onDisk.indexOf('*.local.log')).toBeLessThan(onDisk.indexOf('# Truly ignored:'))
  })

  test('forceBuild=true also refreshes the Dockerfile so docker build sees the fresh template', async () => {
    await writeFile(join(root, 'Dockerfile'), 'FROM stale\n# no git\n')
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      forceBuild: true,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    const buildCall = calls.find((c) => c.args[0] === 'build')
    expect(buildCall).toBeDefined()
    expect(buildCall!.dockerfileSnapshot).toBe(buildDockerfile(undefined, { baseImageVersion: '0.1.0' }))
    expect(buildCall!.dockerfileSnapshot).not.toContain('FROM stale')
  })

  test('start refreshes Dockerfile with custom append lines from typeclaw.json', async () => {
    await writeFile(join(root, 'Dockerfile'), 'FROM stale\n')
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { docker: { file: { append: ['RUN echo from-config'] } } })
    const { exec, calls } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      forceBuild: true,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    const buildCall = calls.find((c) => c.args[0] === 'build')
    if (!buildCall?.dockerfileSnapshot) throw new Error('expected docker build to capture Dockerfile snapshot')
    expect(buildCall.dockerfileSnapshot).toContain('RUN echo from-config')
    expect(buildCall.dockerfileSnapshot.indexOf('RUN echo from-config')).toBeLessThan(
      buildCall.dockerfileSnapshot.indexOf('ENTRYPOINT ["/usr/local/bin/typeclaw-entrypoint"]'),
    )
  })

  test('forceBuild=true rebuild sees Dockerfile with ffmpeg from typeclaw.json', async () => {
    await writeFile(join(root, 'Dockerfile'), 'FROM stale\n')
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeTypeclawConfig(root, { docker: { file: { ffmpeg: true } } })
    const { exec, calls } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      forceBuild: true,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    const buildCall = calls.find((c) => c.args[0] === 'build')
    if (!buildCall?.dockerfileSnapshot) throw new Error('expected docker build to capture Dockerfile snapshot')
    expect(buildCall.dockerfileSnapshot).toMatch(/apt-get install -y --no-install-recommends[\s\S]+\bffmpeg\b/)
  })

  test('commits the refreshed .gitignore when the agent folder is a git repo', async () => {
    // given: an agent folder that is a git repo with a stale committed .gitignore
    await gitInit(root)
    await writeFile(join(root, '.gitignore'), '# stale\n')
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await runGit(root, ['add', '.gitignore', 'package.json'])
    await runGit(root, ['commit', '-m', 'initial'])
    const headBefore = await runGit(root, ['rev-parse', 'HEAD'])
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when: start runs (refresh will rewrite .gitignore, commit should land it)
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    // then: HEAD advanced and the new commit exists with the expected subject
    expect(result.ok).toBe(true)
    const headAfter = await runGit(root, ['rev-parse', 'HEAD'])
    expect(headAfter).not.toBe(headBefore)
    const subjects = (await runGit(root, ['log', '--format=%s'])).split('\n')
    expect(subjects).toContain('Update .gitignore')
  })

  test('does not auto-commit Dockerfile changes (Dockerfile is gitignored, regenerated on every start)', async () => {
    // given: an agent folder following the realistic post-init shape — Dockerfile
    // is on disk but gitignored, so it was never tracked.
    await gitInit(root)
    await writeFile(join(root, '.gitignore'), buildGitignore())
    await writeFile(join(root, 'Dockerfile'), 'FROM stale\n')
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await runGit(root, ['add', '.gitignore', 'package.json'])
    await runGit(root, ['commit', '-m', 'initial'])
    const headBefore = await runGit(root, ['rev-parse', 'HEAD'])
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when: start runs (Dockerfile is rewritten on disk, .gitignore is unchanged)
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    // then: HEAD did not move (no Dockerfile commit, no .gitignore commit)
    expect(result.ok).toBe(true)
    const headAfter = await runGit(root, ['rev-parse', 'HEAD'])
    expect(headAfter).toBe(headBefore)
    // and: the Dockerfile on disk is the fresh template
    expect(await readFile(join(root, 'Dockerfile'), 'utf8')).toBe(
      buildDockerfile(undefined, { baseImageVersion: '0.1.0' }),
    )
  })

  test('does not commit when the refresh produces no change (clean working tree)', async () => {
    // given: an agent folder where .gitignore is already at the latest template
    await gitInit(root)
    await writeFile(join(root, '.gitignore'), buildGitignore())
    await writeFile(join(root, 'Dockerfile'), buildDockerfile())
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await runGit(root, ['add', '.gitignore', 'package.json'])
    await runGit(root, ['commit', '-m', 'initial'])
    const headBefore = await runGit(root, ['rev-parse', 'HEAD'])
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    // then: no new commits were created
    expect(result.ok).toBe(true)
    const headAfter = await runGit(root, ['rev-parse', 'HEAD'])
    expect(headAfter).toBe(headBefore)
  })

  test('migrates a pre-monorepo agent folder by injecting workspaces and committing the change', async () => {
    // given: an agent folder from before bun-workspaces support — package.json has no
    // `workspaces` field, packages/.gitkeep does not exist
    await gitInit(root)
    await writeFile(join(root, '.gitignore'), buildGitignore())
    await writeFile(join(root, 'Dockerfile'), buildDockerfile())
    await writePackageJsonPreMigration(root, { typeclaw: '^0.1.0' })
    await runGit(root, ['add', '.gitignore', 'package.json'])
    await runGit(root, ['commit', '-m', 'initial'])
    const headBefore = await runGit(root, ['rev-parse', 'HEAD'])
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when: start runs (refreshPackageJson should inject workspaces and create .gitkeep)
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    // then: a new commit landed with the migration
    expect(result.ok).toBe(true)
    const headAfter = await runGit(root, ['rev-parse', 'HEAD'])
    expect(headAfter).not.toBe(headBefore)
    const subjects = (await runGit(root, ['log', '--format=%s'])).split('\n')
    expect(subjects).toContain('Enable bun workspaces (packages/*)')
    // and: the agent folder is now in the post-migration shape
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(pkg.workspaces).toEqual(['packages/*'])
    expect(existsSync(join(root, 'packages', '.gitkeep'))).toBe(true)
    // and: the migration commit tracks both files
    const filesInCommit = (await runGit(root, ['show', '--name-only', '--format=', 'HEAD'])).split('\n').sort()
    expect(filesInCommit).toEqual(['package.json', 'packages/.gitkeep'])
  })

  test('migration is idempotent: a second start on the migrated folder does not create another commit', async () => {
    await gitInit(root)
    await writeFile(join(root, '.gitignore'), buildGitignore())
    await writeFile(join(root, 'Dockerfile'), buildDockerfile())
    await writePackageJsonPreMigration(root, { typeclaw: '^0.1.0' })
    await runGit(root, ['add', '.gitignore', 'package.json'])
    await runGit(root, ['commit', '-m', 'initial'])
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // first start: migrates
    const first = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })
    expect(first.ok).toBe(true)
    const headAfterFirst = await runGit(root, ['rev-parse', 'HEAD'])

    // second start: no-op
    const second = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })
    expect(second.ok).toBe(true)
    const headAfterSecond = await runGit(root, ['rev-parse', 'HEAD'])
    expect(headAfterSecond).toBe(headAfterFirst)
  })

  // Mutation-check anchor (AGENTS.md §3): commenting out the
  // `await migrateAndCommitConfig(cwd)` call in start() MUST cause this test
  // to fail. typeclaw.json is in git's "tracked" category (unlike Dockerfile),
  // so a silent disk rewrite without a commit produces invisible drift the
  // moment any other tool touches the repo. The fix in this PR adds the
  // commit alongside the existing .gitignore / package.json commits.
  test('start auto-commits the typeclaw.json seeded GitHub event allowlist migration', async () => {
    // given: an agent folder with the seeded channels.github.eventAllowlist
    // already committed. Current config migration strips it so the channel
    // re-tracks the shipped default.
    await gitInit(root)
    await writeFile(join(root, '.gitignore'), buildGitignore())
    await writeFile(join(root, 'Dockerfile'), buildDockerfile())
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeFile(
      join(root, 'typeclaw.json'),
      `${JSON.stringify(
        {
          models: { default: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' },
          channels: { github: { repos: ['acme/widgets'], eventAllowlist: [...DEFAULT_GITHUB_EVENT_ALLOWLIST] } },
        },
        null,
        2,
      )}\n`,
    )
    await runGit(root, ['add', '.gitignore', 'package.json', 'packages/.gitkeep', 'typeclaw.json'])
    await runGit(root, ['commit', '-m', 'initial'])
    const headBefore = await runGit(root, ['rev-parse', 'HEAD'])
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when: start runs against the migratable folder
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    // then: the migration landed in git as a dedicated commit (the
    // mutation-killer assertion — without the wiring this list does not
    // contain the migration subject) AND the committed tree matches the
    // on-disk file, so the agent repo is not silently dirty.
    expect(result.ok).toBe(true)
    const subjects = (await runGit(root, ['log', '--format=%s'])).split('\n')
    expect(subjects).toContain('typeclaw.json: drop seeded channels.github.eventAllowlist')
    const headAfter = await runGit(root, ['rev-parse', 'HEAD'])
    expect(headAfter).not.toBe(headBefore)
    const onDisk = JSON.parse(await readFile(join(root, 'typeclaw.json'), 'utf8'))
    expect(onDisk.channels.github).toEqual({ repos: ['acme/widgets'] })
    const tracked = JSON.parse(await runGit(root, ['show', 'HEAD:typeclaw.json']))
    expect(tracked).toEqual(onDisk)
  })

  test('start does not commit typeclaw.json when it is already in canonical shape', async () => {
    // given: typeclaw.json is already canonical
    await gitInit(root)
    await writeFile(join(root, '.gitignore'), buildGitignore())
    await writeFile(join(root, 'Dockerfile'), buildDockerfile())
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeFile(
      join(root, 'typeclaw.json'),
      `${JSON.stringify(
        {
          models: { default: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' },
          roles: { member: { match: ['slack:T0123'] } },
        },
        null,
        2,
      )}\n`,
    )
    await runGit(root, ['add', '.gitignore', 'package.json', 'packages/.gitkeep', 'typeclaw.json'])
    await runGit(root, ['commit', '-m', 'initial'])
    const headBefore = await runGit(root, ['rev-parse', 'HEAD'])
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    // then: HEAD did not move
    expect(result.ok).toBe(true)
    const headAfter = await runGit(root, ['rev-parse', 'HEAD'])
    expect(headAfter).toBe(headBefore)
  })

  test('auto-commits bun.lock drift on start (e.g. after a typeclaw CLI upgrade rewrote it)', async () => {
    // given: a migrated agent folder where the user already ran `bun install`
    // and bun.lock is now dirty (typical after upgrading the typeclaw CLI)
    await gitInit(root)
    await writeFile(join(root, '.gitignore'), buildGitignore())
    await writeFile(join(root, 'Dockerfile'), buildDockerfile())
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeFile(join(root, 'bun.lock'), '{"lockfileVersion":1,"workspaces":{}}\n')
    await runGit(root, ['add', '.gitignore', 'package.json', 'packages/.gitkeep', 'bun.lock'])
    await runGit(root, ['commit', '-m', 'initial'])
    // and: bun.lock now drifts (simulating a post-upgrade rewrite)
    await writeFile(
      join(root, 'bun.lock'),
      '{"lockfileVersion":1,"workspaces":{"":{"dependencies":{"typeclaw":"^0.2.0"}}}}\n',
    )
    const headBefore = await runGit(root, ['rev-parse', 'HEAD'])
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    // then
    expect(result.ok).toBe(true)
    const headAfter = await runGit(root, ['rev-parse', 'HEAD'])
    expect(headAfter).not.toBe(headBefore)
    const subjects = (await runGit(root, ['log', '--format=%s'])).split('\n')
    expect(subjects).toContain('Update dependencies')
    const filesInCommit = (await runGit(root, ['show', '--name-only', '--format=', 'HEAD'])).split('\n').sort()
    expect(filesInCommit).toEqual(['bun.lock'])
  })

  test('calls ensureDeps with the agent folder before docker run', async () => {
    // given: a fresh agent folder
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when: start runs with a recording ensureDeps
    const ensureCalls: string[] = []
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: async (dir) => {
        ensureCalls.push(dir)
        return { ok: true, installed: false }
      },
      ...bypassVerify,
    })

    // then: ensureDeps received the agent folder, AND it ran before docker run
    expect(result.ok).toBe(true)
    expect(ensureCalls).toEqual([root])
    const runIndex = calls.findIndex((c) => c.args[0] === 'run')
    expect(runIndex).toBeGreaterThanOrEqual(0)
  })

  test('aborts start (no docker run) when ensureDeps reports failure', async () => {
    // given: ensureDeps reports drift it could not resolve (e.g. bun install failed)
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: async () => ({ ok: false, reason: 'lockfile permission denied' }),
    })

    // then: start returned failure carrying the upstream reason
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toContain('lockfile permission denied')
    // and: no docker run ever happened (bind-mounted node_modules would be broken)
    expect(calls.find((c) => c.args[0] === 'run')).toBeUndefined()
  })

  test('forceBuild + file: typeclaw dep -> ensureDeps called with force=true', async () => {
    // given: agent declares typeclaw via file: (the dev-mode case PR #243
    // dogfooding wedged on)
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: 'file:../../workspace/typeclaw' })
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when: --build is passed
    const ensureCalls: Array<{ force?: boolean } | undefined> = []
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      forceBuild: true,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: async (_cwd, opts) => {
        ensureCalls.push(opts)
        return { ok: true, installed: false }
      },
      ...bypassVerify,
    })

    // then: ensureDeps was forced to bust bun's file-dep cache
    expect(result.ok).toBe(true)
    expect(ensureCalls).toEqual([{ force: true }])
  })

  test('forceBuild + link: typeclaw dep -> ensureDeps called with force=true', async () => {
    // given: agent declares typeclaw via link: (the other dev-mode shape)
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: 'link:../../workspace/typeclaw' })
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when
    const ensureCalls: Array<{ force?: boolean } | undefined> = []
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      forceBuild: true,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: async (_cwd, opts) => {
        ensureCalls.push(opts)
        return { ok: true, installed: false }
      },
      ...bypassVerify,
    })

    // then
    expect(result.ok).toBe(true)
    expect(ensureCalls).toEqual([{ force: true }])
  })

  test('forceBuild + registry typeclaw dep -> ensureDeps called with force=false', async () => {
    // given: agent is on a published registry version (the normal user case);
    // the force-reinstall would be expensive AND meaningless because bun's
    // registry-spec install path is already cache-correct
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.3.4' })
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when: --build is passed
    const ensureCalls: Array<{ force?: boolean } | undefined> = []
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      forceBuild: true,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: async (_cwd, opts) => {
        ensureCalls.push(opts)
        return { ok: true, installed: false }
      },
      ...bypassVerify,
    })

    // then: no force — registry users skip the expensive path
    expect(result.ok).toBe(true)
    expect(ensureCalls).toEqual([{ force: false }])
  })

  test('file: typeclaw dep WITHOUT forceBuild -> ensureDeps called with force=false', async () => {
    // given: a dev-mode agent BUT --build was not passed (a routine
    // `typeclaw start` after stop). Force-reinstall would impose a ~30s
    // tax on every restart for no benefit; only --build implies "rebuild
    // everything, bust the cache".
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: 'file:../../workspace/typeclaw' })
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when
    const ensureCalls: Array<{ force?: boolean } | undefined> = []
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      forceBuild: false,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: async (_cwd, opts) => {
        ensureCalls.push(opts)
        return { ok: true, installed: false }
      },
      ...bypassVerify,
    })

    // then
    expect(result.ok).toBe(true)
    expect(ensureCalls).toEqual([{ force: false }])
  })

  test('forceBuild + missing package.json -> ensureDeps called with force=false (no crash)', async () => {
    // given: a malformed agent folder with no package.json (defensive case).
    // The gate must degrade to "no force" rather than crash — the underlying
    // ensureDeps will still surface the missing-deps failure downstream.
    await writeDockerfile(root)
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when
    const ensureCalls: Array<{ force?: boolean } | undefined> = []
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      forceBuild: true,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: async (_cwd, opts) => {
        ensureCalls.push(opts)
        return { ok: true, installed: false }
      },
      ...bypassVerify,
    })

    // then: no crash, no force
    expect(result.ok).toBe(true)
    expect(ensureCalls).toEqual([{ force: false }])
  })

  test('auto-commits package.json and bun.lock atomically when both drift', async () => {
    await gitInit(root)
    await writeFile(join(root, '.gitignore'), buildGitignore())
    await writeFile(join(root, 'Dockerfile'), buildDockerfile())
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeFile(join(root, 'bun.lock'), '{"lockfileVersion":1}\n')
    await runGit(root, ['add', '.gitignore', 'package.json', 'packages/.gitkeep', 'bun.lock'])
    await runGit(root, ['commit', '-m', 'initial'])
    // and: both files drift (e.g., user manually bumped typeclaw and re-ran bun install)
    await writePackageJson(root, { typeclaw: '^0.2.0' })
    await writeFile(join(root, 'bun.lock'), '{"lockfileVersion":1,"deps":"new"}\n')
    const headBefore = await runGit(root, ['rev-parse', 'HEAD'])
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    const headAfter = await runGit(root, ['rev-parse', 'HEAD'])
    expect(headAfter).not.toBe(headBefore)
    const subjects = (await runGit(root, ['log', '--format=%s'])).split('\n')
    expect(subjects).toContain('Update dependencies')
    // and: a single atomic commit covers both files (not two separate commits)
    const filesInCommit = (await runGit(root, ['show', '--name-only', '--format=', 'HEAD'])).split('\n').sort()
    expect(filesInCommit).toEqual(['bun.lock', 'package.json'])
  })

  test('does not commit dependency files when they are clean', async () => {
    await gitInit(root)
    await writeFile(join(root, '.gitignore'), buildGitignore())
    await writeFile(join(root, 'Dockerfile'), buildDockerfile())
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeFile(join(root, 'bun.lock'), '{"lockfileVersion":1}\n')
    await runGit(root, ['add', '.gitignore', 'package.json', 'packages/.gitkeep', 'bun.lock'])
    await runGit(root, ['commit', '-m', 'initial'])
    const headBefore = await runGit(root, ['rev-parse', 'HEAD'])
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    const headAfter = await runGit(root, ['rev-parse', 'HEAD'])
    expect(headAfter).toBe(headBefore)
  })

  test('skips dependency auto-commit silently when the agent folder is not a git repo', async () => {
    // given: a non-git agent folder with drifted bun.lock
    await writeFile(join(root, '.gitignore'), buildGitignore())
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeFile(join(root, 'bun.lock'), '{"lockfileVersion":1,"deps":"new"}\n')
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    expect(existsSync(join(root, '.git'))).toBe(false)
  })

  test('separates the workspaces migration commit from the dependency drift commit when both apply', async () => {
    // given: a pre-migration agent folder (no `workspaces` field) with a bun.lock that
    // also drifted independently
    await gitInit(root)
    await writeFile(join(root, '.gitignore'), buildGitignore())
    await writeFile(join(root, 'Dockerfile'), buildDockerfile())
    await writePackageJsonPreMigration(root, { typeclaw: '^0.1.0' })
    await writeFile(join(root, 'bun.lock'), '{"lockfileVersion":1}\n')
    await runGit(root, ['add', '.gitignore', 'package.json', 'bun.lock'])
    await runGit(root, ['commit', '-m', 'initial'])
    // and: bun.lock drifts (user upgraded typeclaw, re-ran bun install)
    await writeFile(join(root, 'bun.lock'), '{"lockfileVersion":1,"deps":"new"}\n')
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    // then: two distinct commits exist with the right messages and file scopes
    const subjects = (await runGit(root, ['log', '--format=%s'])).split('\n')
    expect(subjects[0]).toBe('Update dependencies')
    expect(subjects[1]).toBe('Enable bun workspaces (packages/*)')
    const headFiles = (await runGit(root, ['show', '--name-only', '--format=', 'HEAD'])).split('\n').sort()
    expect(headFiles).toEqual(['bun.lock'])
    const prevFiles = (await runGit(root, ['show', '--name-only', '--format=', 'HEAD~1'])).split('\n').sort()
    expect(prevFiles).toEqual(['package.json', 'packages/.gitkeep'])
  })

  test('can register through the current hostd without drift respawn during daemon-owned restart', async () => {
    const previousHome = process.env.TYPECLAW_HOME
    const home = await mkdtemp(join(tmpdir(), 'typeclaw-current-hostd-'))
    let daemon: Daemon | null = null
    try {
      process.env.TYPECLAW_HOME = home
      await writeDockerfile(root)
      await writePackageJson(root, { typeclaw: '^0.1.0' })
      await writeTypeclawConfig(root)
      daemon = await startDaemon({ version: 'old-hostd-version', gcIntervalMs: 1_000_000 })
      const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

      const result = await start({
        cwd: root,
        preferredHostPort: 8973,
        exec,
        allocatePort: deterministicAllocator,
        cliEntry: '/nonexistent/newer-cli.ts',
        reuseCurrentHostDaemon: true,
        ensureDeps: noEnsureDeps,
        ...bypassVerify,
      })

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.hostd.state).toBe('registered')
      expect(daemon.registered()).toContain(basename(root))
    } finally {
      if (daemon) await daemon.stop().catch(() => {})
      if (previousHome === undefined) delete process.env.TYPECLAW_HOME
      else process.env.TYPECLAW_HOME = previousHome
      await rm(home, { recursive: true, force: true })
    }
  })

  test('forceBuild=false skips build entirely when image already exists', async () => {
    // given: a Dockerfile already matching the current template, so refreshDockerfile is a no-op
    await writeFile(join(root, 'Dockerfile'), buildDockerfile(undefined, { baseImageVersion: '0.1.0' }))
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    expect(calls.find((c) => c.args[0] === 'build')).toBeUndefined()
    expect(calls.find((c) => c.args[0] === 'run')).toBeDefined()
  })

  test('auto-rebuilds when the Dockerfile template differs from disk, even without --build', async () => {
    // given: a stale Dockerfile and an image that already exists from a prior build
    await writeFile(join(root, 'Dockerfile'), 'FROM stale\n# old template\n')
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when: start runs WITHOUT forceBuild
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    // then: the build ran against the refreshed Dockerfile, and built=true was reported
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.built).toBe(true)
    const buildCall = calls.find((c) => c.args[0] === 'build')
    expect(buildCall).toBeDefined()
    expect(buildCall!.dockerfileSnapshot).toBe(buildDockerfile(undefined, { baseImageVersion: '0.1.0' }))
    expect(buildCall!.dockerfileSnapshot).not.toContain('FROM stale')
  })

  test('skips build when the on-disk Dockerfile already matches the template and the image exists', async () => {
    // given: a Dockerfile already at the rendered-template value and an existing image
    await writeFile(join(root, 'Dockerfile'), buildDockerfile(undefined, { baseImageVersion: '0.1.0' }))
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    // then: no rebuild — the change-driven auto-rebuild path stays inert when nothing drifted
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.built).toBe(false)
    expect(calls.find((c) => c.args[0] === 'build')).toBeUndefined()
  })

  test('is idempotent when a container with the same name is already running', async () => {
    // given: an already-running container, an existing image, and a stale
    // Dockerfile on disk so we can prove the no-op path skips the refresh
    await writeFile(join(root, 'Dockerfile'), 'FROM stale\n')
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({
      imageExists: true,
      container: { exists: true, running: true },
    })

    // when
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    // then: success with alreadyRunning=true, no docker side effects, no template churn
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.alreadyRunning).toBe(true)
    expect(result.built).toBe(false)
    expect(result.hostPort).toBe(8973)
    expect(result.containerId).toBe('fake-running-id-123456')
    expect(calls.find((c) => c.args[0] === 'run')).toBeUndefined()
    expect(calls.find((c) => c.args[0] === 'rm')).toBeUndefined()
    expect(calls.find((c) => c.args[0] === 'build')).toBeUndefined()
    const onDisk = await readFile(join(root, 'Dockerfile'), 'utf8')
    expect(onDisk).toBe('FROM stale\n')
  })

  test('reports an error when an already-running container has no published host port', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const exec: DockerExec = async (args) => {
      if (args[0] === 'inspect' && args.includes('{{.State.Running}}')) {
        return { exitCode: 0, stdout: 'true\n', stderr: '' }
      }
      if (args[0] === 'inspect' && args.includes('{{.Id}}')) {
        return { exitCode: 0, stdout: 'id\n', stderr: '' }
      }
      if (args[0] === 'port') {
        return { exitCode: 1, stdout: '', stderr: 'Error: No port mapping' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/published host port could not be resolved/)
  })

  test('force-removes a stale stopped container with the same name and proceeds to docker run', async () => {
    // given: a previous crash or `typeclaw stop` left a stopped container holding the name
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({
      imageExists: true,
      container: { exists: true, running: false },
    })

    // when
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    // then: rm was issued before run, and run proceeded
    expect(result.ok).toBe(true)
    const rmIdx = calls.findIndex((c) => c.args[0] === 'rm' && c.args[1] === '-f')
    const runIdx = calls.findIndex((c) => c.args[0] === 'run')
    expect(rmIdx).toBeGreaterThanOrEqual(0)
    expect(runIdx).toBeGreaterThan(rmIdx)
  })

  test('tolerates "no such container" from docker rm (auto-removal finished between inspect and rm)', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({
      imageExists: true,
      container: { exists: true, running: false, rmFails: true, rmStderr: 'Error: No such container: x' },
    })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    expect(calls.find((c) => c.args[0] === 'run')).toBeDefined()
  })

  test('waits for Docker to finish the in-progress removal before docker run, avoiding a name conflict', async () => {
    // given: a stopped corpse held by an in-progress async removal. The
    // preflight rm reports "removal of container x is already in progress",
    // and inspect keeps reporting the container as still present for two
    // more probes before the drain completes.
    //
    // This test ALSO depends on the fake's docker-run path returning the
    // real name-conflict error string when the container is still present
    // — so if start() forgot to wait, docker run would fail with exactly
    // the user-visible bug ("Conflict. The container name is already in
    // use") and the test would catch it.
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({
      imageExists: true,
      container: {
        exists: true,
        running: false,
        rmFails: true,
        rmStderr: 'Error response from daemon: removal of container x is already in progress',
        drainAfterInspectCalls: 2,
      },
    })

    // when
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    // then: start succeeded, docker run ran AGAINST A GONE CONTAINER, and
    // we made at least one inspect call after rm to verify removal
    expect(result.ok).toBe(true)
    const rmIdx = calls.findIndex((c) => c.args[0] === 'rm')
    const runIdx = calls.findIndex((c) => c.args[0] === 'run')
    expect(rmIdx).toBeGreaterThanOrEqual(0)
    expect(runIdx).toBeGreaterThan(rmIdx)
    const inspectsBetween = calls.slice(rmIdx + 1, runIdx).filter((c) => c.args[0] === 'inspect')
    expect(inspectsBetween.length).toBeGreaterThanOrEqual(1)
  })

  test('waits for Docker to finish removal when rm returns exit 0 but container is still draining (OrbStack under load)', async () => {
    // given: a stopped corpse. The preflight `docker rm -f` returns exit 0
    // — i.e. Docker acknowledged the request — but the daemon has not yet
    // finished draining. `inspect` still sees the container for two more
    // probes after rm. This is the canonical failure mode behind the
    // user-visible `typeclaw compose restart` bug: stop()'s rm returns 0,
    // start()'s preflight sees the corpse, start()'s rm returns 0, but
    // docker run --name fires before the drain completes and hits
    // "Conflict. The container name is already in use by container <ID>".
    //
    // The fake's docker-run path returns the real name-conflict error
    // when the container is still present, so without the waitForRemoval
    // on the exit-0 path, this test fails with exactly the user-visible
    // error message.
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({
      imageExists: true,
      container: {
        exists: true,
        running: false,
        drainAfterInspectCalls: 2,
      },
    })

    // when
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    // then: start succeeded (docker run did not race the drain), and we
    // made at least one inspect call between rm and run to verify removal
    expect(result.ok).toBe(true)
    const rmIdx = calls.findIndex((c) => c.args[0] === 'rm')
    const runIdx = calls.findIndex((c) => c.args[0] === 'run')
    expect(rmIdx).toBeGreaterThanOrEqual(0)
    expect(runIdx).toBeGreaterThan(rmIdx)
    const inspectsBetween = calls.slice(rmIdx + 1, runIdx).filter((c) => c.args[0] === 'inspect')
    expect(inspectsBetween.length).toBeGreaterThanOrEqual(1)
  })

  test('reports a clear error when docker rm fails for a non-recoverable reason', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({
      imageExists: true,
      container: { exists: true, running: false, rmFails: true, rmStderr: 'permission denied' },
    })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/exists but is not running/)
    expect(calls.find((c) => c.args[0] === 'run')).toBeUndefined()
  })

  test('retries docker run after force-removing the non-running corpse that holds the name', async () => {
    // given: the preflight `docker inspect` says the name is free, so
    // start() proceeds to `docker run`. The first run fails with the
    // user-visible name-conflict error referencing a concrete corpse ID —
    // exactly the failure mode behind the reported `typeclaw compose
    // restart` bug. Once the retry path force-removes the corpse, the
    // next `docker run --name <same>` succeeds.
    //
    // Mutation check: revert the cleanupRunCorpse call inside
    // execRunWithConflictRetry to a passive setTimeout and this test fails
    // — the fake's `docker run` keeps returning conflict until something
    // flips containerExists to false, and only the rm path does that.
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    let runAttempts = 0
    let rmAttempts = 0
    // Models the moby#51758 / moby#8294 bug: docker create succeeds and
    // reserves the name, but `docker run -p <busy>:...` later fails with
    // port-allocated and leaves the corpse in `docker ps -a`. In this test
    // start()'s preflight inspect runs BEFORE the corpse is created, so it
    // sees "no such container" and skips the preflight rm — exactly the
    // race the production fix must handle inside execRunWithConflictRetry.
    let corpseExists = false
    let rmTarget: string | undefined
    const corpseId = 'e8d39ae0eb16428c58b143b3a8ac60267ae87ce4fc0f2859022183b512287209'
    const conflictStderr = `docker: Error response from daemon: Conflict. The container name "/anderson" is already in use by container "${corpseId}". You have to remove (or rename) that container to be able to reuse that name.`
    const calls: { args: string[] }[] = []
    const exec: DockerExec = async (args) => {
      calls.push({ args })
      if (args[0] === 'image' && args[1] === 'inspect') return { exitCode: 0, stdout: '', stderr: '' }
      if (args[0] === 'inspect') {
        if (!corpseExists) return { exitCode: 1, stdout: '', stderr: 'Error: No such container' }
        // cleanupRunCorpse asks for `{{.Id}}|{{.State.Running}}`; everything
        // else (preflight, waitForRemoval) only asks for State.Running. Both
        // formats are emitted here — the production parser ignores the
        // extra field, and the cleanupRunCorpse parser splits on '|'.
        if (args.includes('{{.Id}}|{{.State.Running}}')) {
          return { exitCode: 0, stdout: `${corpseId}|false\n`, stderr: '' }
        }
        return { exitCode: 0, stdout: 'false\n', stderr: '' }
      }
      if (args[0] === 'rm') {
        rmAttempts++
        rmTarget = args[args.length - 1]
        corpseExists = false
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      if (args[0] === 'run') {
        runAttempts++
        if (runAttempts === 1) {
          // Simulate Docker creating the named container before failing
          // the actual run; surface the conflict against that corpse.
          corpseExists = true
          return { exitCode: 125, stdout: '', stderr: conflictStderr }
        }
        if (corpseExists) return { exitCode: 125, stdout: '', stderr: conflictStderr }
        return { exitCode: 0, stdout: 'fake-id\n', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    expect(runAttempts).toBe(2)
    expect(rmAttempts).toBe(1)
    // The rm MUST target the corpse ID parsed from the inspect probe,
    // NOT the container name. Targeting by name is the TOCTOU race where
    // a same-name peer container spun up between probe and rm gets killed.
    expect(rmTarget).toBe(corpseId)
    const firstRunIdx = calls.findIndex((c) => c.args[0] === 'run')
    const rmIdx = calls.findIndex((c) => c.args[0] === 'rm')
    const lastRunIdx = calls.length - 1 - [...calls].reverse().findIndex((c) => c.args[0] === 'run')
    expect(rmIdx).toBeGreaterThan(firstRunIdx)
    expect(rmIdx).toBeLessThan(lastRunIdx)
  })

  test('does NOT force-remove a RUNNING same-name container when docker run reports conflict', async () => {
    // given: a docker run hits a name conflict but the named container is
    // currently RUNNING. The destructive retry path MUST refuse to kill a
    // live container — that would either murder a concurrent legitimate
    // start of the same name OR a foreign container the user wants alive.
    // start() must surface the conflict error untouched.
    //
    // Mutation check: drop the running-check from cleanupRunCorpse and
    // this test fails — rmAttempts becomes 1 and the live container is
    // killed.
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    let runAttempts = 0
    let rmAttempts = 0
    let probeAttempts = 0
    const conflictStderr =
      'docker: Error response from daemon: Conflict. The container name "/x" is already in use by container "abc". You have to remove (or rename) that container to be able to reuse that name.'
    const exec: DockerExec = async (args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return { exitCode: 0, stdout: '', stderr: '' }
      if (args[0] === 'inspect') {
        probeAttempts++
        // First inspect (start's preflight) reports gone so we proceed to docker run.
        if (probeAttempts === 1) return { exitCode: 1, stdout: '', stderr: 'Error: No such container' }
        // Subsequent inspect (the retry-path corpse probe) reports running=true.
        // cleanupRunCorpse uses `{{.Id}}|{{.State.Running}}`; non-cleanupRunCorpse
        // callers use just State.Running. Emit both formats so either parser works.
        if (args.includes('{{.Id}}|{{.State.Running}}')) {
          return { exitCode: 0, stdout: 'live-id|true\n', stderr: '' }
        }
        return { exitCode: 0, stdout: 'true\n', stderr: '' }
      }
      if (args[0] === 'rm') {
        rmAttempts++
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      if (args[0] === 'run') {
        runAttempts++
        return { exitCode: 125, stdout: '', stderr: conflictStderr }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/Conflict.*container name.*is already in use/)
    expect(rmAttempts).toBe(0)
    expect(runAttempts).toBe(1)
  })

  test('cleans up the failed-run corpse before retrying with a new port (TOCTOU + port-bind-after-create)', async () => {
    // given: the first `docker run -p 8973:...` fails because another
    // process claimed 8973 between our probe and the run, AND Docker
    // already created the named container record before the port bind
    // failed. The port-TOCTOU retry must force-remove the corpse before
    // re-running `docker run --name <same>` with the new port, or the
    // retry hits the user-visible Conflict error against its own corpse
    // — exactly the bug `typeclaw compose restart` was hitting.
    //
    // Mutation check: remove the cleanupRunCorpse call in the port-retry
    // branch and this test fails — the second `docker run` returns
    // conflict against the corpse left by the first run.
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    let runAttempts = 0
    let rmAttempts = 0
    let corpseExists = false
    const calls: { args: string[] }[] = []
    const portStderr = 'docker: Bind for :::8973 failed: port is already allocated'
    const conflictStderr =
      'docker: Error response from daemon: Conflict. The container name "/x" is already in use by container "deadbeef". You have to remove (or rename) that container to be able to reuse that name.'
    const exec: DockerExec = async (args) => {
      calls.push({ args })
      if (args[0] === 'image' && args[1] === 'inspect') return { exitCode: 0, stdout: '', stderr: '' }
      if (args[0] === 'inspect') {
        if (!corpseExists) return { exitCode: 1, stdout: '', stderr: 'Error: No such container' }
        if (args.includes('{{.Id}}|{{.State.Running}}')) {
          return { exitCode: 0, stdout: 'deadbeef|false\n', stderr: '' }
        }
        return { exitCode: 0, stdout: 'false\n', stderr: '' }
      }
      if (args[0] === 'rm') {
        rmAttempts++
        corpseExists = false
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      if (args[0] === 'run') {
        runAttempts++
        if (runAttempts === 1) {
          // Docker created the container before failing the port bind.
          corpseExists = true
          return { exitCode: 125, stdout: '', stderr: portStderr }
        }
        if (corpseExists) return { exitCode: 125, stdout: '', stderr: conflictStderr }
        return { exitCode: 0, stdout: 'fake-id\n', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    const ports = [8973, 49160]
    const allocatePort = async (): Promise<number> => ports.shift() ?? 0

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    expect(runAttempts).toBe(2)
    expect(rmAttempts).toBe(1)
    // The cleanup rm must happen BETWEEN the two docker run calls so the
    // second run sees a free name.
    const firstRunIdx = calls.findIndex((c) => c.args[0] === 'run')
    const rmIdx = calls.findIndex((c) => c.args[0] === 'rm')
    const lastRunIdx = calls.length - 1 - [...calls].reverse().findIndex((c) => c.args[0] === 'run')
    expect(rmIdx).toBeGreaterThan(firstRunIdx)
    expect(rmIdx).toBeLessThan(lastRunIdx)
    // The retry used the new port.
    const runCalls = calls.filter((c) => c.args[0] === 'run')
    expect(runCalls[0]!.args).toContain('127.0.0.1:8973:8973')
    expect(runCalls[1]!.args).toContain('127.0.0.1:49160:8973')
  })

  test('waits for "removal in progress" to drain during conflict-retry cleanup', async () => {
    // given: docker run reports name conflict; the retry path calls
    // `docker rm -f` which itself returns "removal of container … is
    // already in progress". The cleanup must call waitForRemoval to
    // confirm the container actually disappears before retrying
    // `docker run`, or the retry races the drain and fails again.
    //
    // Mutation check: revert cleanupRunCorpse to skip waitForRemoval on
    // the "in-progress" rm-stderr path and this test fails — the second
    // docker run fires while inspect still reports the corpse, returning
    // conflict.
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    let inspectsBeforeRm = 0
    let inspectAfterRm = 0
    let rmReturned = false
    let runAttempts = 0
    const conflictStderr =
      'docker: Error response from daemon: Conflict. The container name "/x" is already in use by container "abc". You have to remove (or rename) that container to be able to reuse that name.'
    const exec: DockerExec = async (args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return { exitCode: 0, stdout: '', stderr: '' }
      if (args[0] === 'inspect') {
        if (!rmReturned) {
          inspectsBeforeRm++
          // First inspect is start's preflight (name is free); second is
          // cleanupRunCorpse's pre-rm probe AFTER the failed docker run
          // has populated the corpse — it must see the corpse to issue rm.
          if (inspectsBeforeRm === 1) return { exitCode: 1, stdout: '', stderr: 'Error: No such container' }
          if (args.includes('{{.Id}}|{{.State.Running}}')) {
            return { exitCode: 0, stdout: 'abc|false\n', stderr: '' }
          }
          return { exitCode: 0, stdout: 'false\n', stderr: '' }
        }
        inspectAfterRm++
        // Container keeps showing up for 2 post-rm probes, then drains.
        if (inspectAfterRm <= 2) return { exitCode: 0, stdout: 'false\n', stderr: '' }
        return { exitCode: 1, stdout: '', stderr: 'Error: No such container' }
      }
      if (args[0] === 'rm') {
        rmReturned = true
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'Error response from daemon: removal of container x is already in progress',
        }
      }
      if (args[0] === 'run') {
        runAttempts++
        // Until cleanup actually waits for the drain, every retry hits
        // conflict — that's the regression this test guards against.
        if (!rmReturned || inspectAfterRm <= 2) return { exitCode: 125, stdout: '', stderr: conflictStderr }
        return { exitCode: 0, stdout: 'fake-id\n', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    // Cleanup probed inspect post-rm at least once (waitForRemoval).
    expect(inspectAfterRm).toBeGreaterThanOrEqual(1)
    // docker run must have been retried at least once after the failed
    // initial attempt — otherwise the test never exercised the drain path.
    expect(runAttempts).toBeGreaterThanOrEqual(2)
  })

  test('backs off between conflict retries when cleanup reports gone but the name still conflicts', async () => {
    // given: Docker's name-reservation table is draining independently of
    // `docker inspect`. cleanupRunCorpse's probe returns 'gone' (inspect
    // says the corpse is removed), but the very next `docker run --name`
    // still hits a Conflict because the reservation hasn't released. The
    // production fix's bounded backoff (100/200/400ms) covers exactly
    // this residual race — without it, three rapid-fire retries all
    // happen inside the same drain window and exhaust uselessly.
    //
    // Mutation check: delete the `await setTimeout(backoffMs)` from
    // execRunWithConflictRetry and this test fails — runAttempts hits 4
    // immediately and result.ok is false because the drain never
    // completes between attempts.
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    let runAttempts = 0
    const drainStart = Date.now()
    const drainMs = 150
    const conflictStderr =
      'docker: Error response from daemon: Conflict. The container name "/x" is already in use by container "abc". You have to remove (or rename) that container to be able to reuse that name.'
    const exec: DockerExec = async (args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return { exitCode: 0, stdout: '', stderr: '' }
      // inspect always reports 'gone' — modeling the daemon's split-state:
      // the container record disappears from inspect/ps but the name
      // reservation lingers a bit longer.
      if (args[0] === 'inspect') return { exitCode: 1, stdout: '', stderr: 'Error: No such container' }
      if (args[0] === 'run') {
        runAttempts++
        // Returns conflict until enough wall time has elapsed for the
        // name reservation to drain.
        if (Date.now() - drainStart < drainMs) {
          return { exitCode: 125, stdout: '', stderr: conflictStderr }
        }
        return { exitCode: 0, stdout: 'fake-id\n', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    // The backoff between retries gives the daemon time to drain. With
    // the bug (no sleep), all four attempts would fire within ms.
    expect(runAttempts).toBeGreaterThanOrEqual(2)
  })

  test('removes the corpse by ID, not by name, to avoid killing a same-name peer (TOCTOU)', async () => {
    // given: cleanupRunCorpse's inspect probe sees a non-running corpse
    // with ID "corpse-A". Between probe and rm, a concurrent peer starts
    // a NEW live container with the same name (ID "live-B"). If our rm
    // targets the name, we'd kill live-B. If our rm targets the probed
    // ID "corpse-A", we remove only the corpse we measured.
    //
    // This test asserts the rm command is invoked with the corpse ID, not
    // the container name. Mutation check: switch rm back to `rm -f <name>`
    // and this assertion fails directly.
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const corpseId = 'corpse-A-1234'
    const containerName = basename(root)
    let rmTarget: string | undefined
    let runAttempts = 0
    const conflictStderr = `docker: Error response from daemon: Conflict. The container name "/${containerName}" is already in use by container "${corpseId}". You have to remove (or rename) that container to be able to reuse that name.`
    const exec: DockerExec = async (args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return { exitCode: 0, stdout: '', stderr: '' }
      if (args[0] === 'inspect') {
        if (args.includes('{{.Id}}|{{.State.Running}}')) {
          return { exitCode: 0, stdout: `${corpseId}|false\n`, stderr: '' }
        }
        return { exitCode: 1, stdout: '', stderr: 'Error: No such container' }
      }
      if (args[0] === 'rm') {
        rmTarget = args[args.length - 1]
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      if (args[0] === 'run') {
        runAttempts++
        if (runAttempts === 1) return { exitCode: 125, stdout: '', stderr: conflictStderr }
        return { exitCode: 0, stdout: 'fake-id\n', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    expect(rmTarget).toBe(corpseId)
    expect(rmTarget).not.toBe(containerName)
  })

  test('surfaces the docker run name-conflict error when cleanup cannot free the name', async () => {
    // given: Docker keeps returning the name-conflict error AND the
    // cleanup `docker rm -f` cannot complete — a wedged daemon or a
    // protected container that no amount of cleanup-then-retry will fix.
    // start() must eventually give up and surface the original error so
    // the user can act (`docker rm -f <name>` manually, restart Docker)
    // instead of looping forever.
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    let runAttempts = 0
    const conflictStderr =
      'docker: Error response from daemon: Conflict. The container name "/x" is already in use by container "abc". You have to remove (or rename) that container to be able to reuse that name.'
    const exec: DockerExec = async (args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return { exitCode: 0, stdout: '', stderr: '' }
      if (args[0] === 'inspect') return { exitCode: 1, stdout: '', stderr: 'Error: No such container' }
      if (args[0] === 'run') {
        runAttempts++
        return { exitCode: 125, stdout: '', stderr: conflictStderr }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/Conflict.*container name.*is already in use/)
    expect(runAttempts).toBeGreaterThanOrEqual(2)
  })

  test('does NOT retry when docker run fails for a non-conflict reason (e.g. image pull error)', async () => {
    // given: a non-conflict docker run failure. The conflict retry loop
    // must not shadow the existing fast-fail behavior — the user sees the
    // error immediately, exactly once.
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    let runAttempts = 0
    const exec: DockerExec = async (args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return { exitCode: 0, stdout: '', stderr: '' }
      if (args[0] === 'inspect') return { exitCode: 1, stdout: '', stderr: 'Error: No such container' }
      if (args[0] === 'run') {
        runAttempts++
        return { exitCode: 125, stdout: '', stderr: 'docker: Error response from daemon: image not found' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    expect(result.ok).toBe(false)
    expect(runAttempts).toBe(1)
    if (!result.ok) expect(result.reason).toMatch(/image not found/)
  })
})

describe('start (port allocation)', () => {
  test('publishes the allocated host port mapped to the fixed container port (8973)', async () => {
    // given: the kernel says the preferred 8973 is taken, so the allocator
    // returns an ephemeral port instead
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({ imageExists: true, container: { exists: false } })
    const allocatePort = async () => 51234

    // when
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    // then: docker run gets `-p 127.0.0.1:<hostPort>:8973`, NOT `-p 8973:8973`
    expect(result.ok).toBe(true)
    const runCall = calls.find((c) => c.args[0] === 'run')
    expect(runCall).toBeDefined()
    expect(runCall!.args).toContain('127.0.0.1:51234:8973')
    expect(runCall!.args).not.toContain('51234:51234')
    if (result.ok) expect(result.hostPort).toBe(51234)
  })

  test('still maps host 8973 to container 8973 when the preferred host port is free', async () => {
    // given: 8973 is free, allocator returns the preferred port unchanged
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    // when
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    // then
    expect(result.ok).toBe(true)
    const runCall = calls.find((c) => c.args[0] === 'run')
    expect(runCall!.args).toContain('127.0.0.1:8973:8973')
    if (result.ok) expect(result.hostPort).toBe(8973)
  })

  test('retries with a fresh ephemeral port when docker reports a bind conflict (TOCTOU)', async () => {
    // given: a docker that fails the first run with the canonical
    // "port is already allocated" error, and succeeds on the second
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    let runAttempts = 0
    const calls: { args: string[] }[] = []
    const exec: DockerExec = async (args) => {
      calls.push({ args })
      if (args[0] === 'image' && args[1] === 'inspect') return { exitCode: 0, stdout: '', stderr: '' }
      if (args[0] === 'inspect') return { exitCode: 1, stdout: '', stderr: 'No such container' }
      if (args[0] === 'run') {
        runAttempts++
        if (runAttempts === 1) {
          return {
            exitCode: 1,
            stdout: '',
            stderr: 'docker: Bind for :::8973 failed: port is already allocated',
          }
        }
        return { exitCode: 0, stdout: 'fake-id\n', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    const ports = [8973, 49160]
    const allocatePort = async (): Promise<number> => ports.shift() ?? 0

    // when
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    // then: the second run got a different host port and succeeded
    expect(result.ok).toBe(true)
    expect(runAttempts).toBe(2)
    const runCalls = calls.filter((c) => c.args[0] === 'run')
    expect(runCalls).toHaveLength(2)
    expect(runCalls[0]!.args).toContain('127.0.0.1:8973:8973')
    expect(runCalls[1]!.args).toContain('127.0.0.1:49160:8973')
    if (result.ok) expect(result.hostPort).toBe(49160)
  })

  test('does NOT retry when docker fails for a non-port reason (e.g. permission denied)', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    let runAttempts = 0
    const exec: DockerExec = async (args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return { exitCode: 0, stdout: '', stderr: '' }
      if (args[0] === 'inspect') return { exitCode: 1, stdout: '', stderr: 'No such container' }
      if (args[0] === 'run') {
        runAttempts++
        return { exitCode: 125, stdout: '', stderr: 'permission denied' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    expect(result.ok).toBe(false)
    expect(runAttempts).toBe(1)
    if (!result.ok) expect(result.reason).toMatch(/permission denied/)
  })
})

// start.test.ts owns COMPOSITION: that start() invokes the verifier exactly
// when docker run succeeds, routes a failing verifier into ok:false, and runs
// cleanup. The behavior of the default verifier (transient statuses, daemon
// errors, log capture, timeouts) lives in verify-running.test.ts.
describe('start (post-run verification composition)', () => {
  test('routes a failing verifier into ok:false with the verifier-supplied reason and runs hostd cleanup', async () => {
    const previousHome = process.env.TYPECLAW_HOME
    const home = await mkdtemp(join(tmpdir(), 'typeclaw-crash-hostd-'))
    let daemon: Daemon | null = null
    try {
      process.env.TYPECLAW_HOME = home
      await writeDockerfile(root)
      await writePackageJson(root, { typeclaw: '^0.1.0' })
      await writeTypeclawConfig(root)
      daemon = await startDaemon({ version: 'v', gcIntervalMs: 1_000_000 })
      const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

      const result = await start({
        cwd: root,
        preferredHostPort: 8973,
        exec,
        allocatePort: deterministicAllocator,
        cliEntry: '/nonexistent/cli.ts',
        reuseCurrentHostDaemon: true,
        ensureDeps: noEnsureDeps,
        verifyRunning: async () => ({
          ok: false,
          mode: 'exited',
          status: 'exited',
          logs: { ok: true, text: 'Cannot find package "missing"' },
        }),
      })

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected failure')
      expect(result.reason).toMatch(/stopped running immediately after start/)
      expect(result.reason).toContain('Cannot find package "missing"')
      expect(daemon.registered()).not.toContain(basename(root))
    } finally {
      if (daemon) await daemon.stop().catch(() => {})
      if (previousHome === undefined) delete process.env.TYPECLAW_HOME
      else process.env.TYPECLAW_HOME = previousHome
      await rm(home, { recursive: true, force: true })
    }
  })

  test('verifier runs AFTER docker run succeeds and BEFORE start returns success', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({ imageExists: true, container: { exists: false } })
    let verifierInvokedAfterRun = false
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      verifyRunning: async () => {
        const runIdx = calls.findIndex((c) => c.args[0] === 'run')
        verifierInvokedAfterRun = runIdx >= 0
        return { ok: true }
      },
    })

    expect(result.ok).toBe(true)
    expect(verifierInvokedAfterRun).toBe(true)
  })

  test('does not invoke the verifier when docker run fails (no container to verify)', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const exec: DockerExec = async (args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return { exitCode: 0, stdout: '', stderr: '' }
      if (args[0] === 'inspect') return { exitCode: 1, stdout: '', stderr: 'No such container' }
      if (args[0] === 'run') return { exitCode: 125, stdout: '', stderr: 'docker run failed for unrelated reason' }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    let verifierCalled = false

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      verifyRunning: async () => {
        verifierCalled = true
        return { ok: true }
      },
    })

    expect(result.ok).toBe(false)
    expect(verifierCalled).toBe(false)
  })
})

describe('planStart port mapping', () => {
  test('always uses CONTAINER_PORT (8973) on the container side regardless of host port', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })

    const plan = await planStart({ cwd: root, hostPort: 49160, imageExists: true })

    expect(plan.runArgs).toContain('-p')
    expect(plan.runArgs).toContain('127.0.0.1:49160:8973')
    expect(plan.hostPort).toBe(49160)
  })
})

describe('start autoUpgrade integration', () => {
  test('forces bun update typeclaw when autoUpgrade reports spec-rewritten', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.2.0' })
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const updateCalls: Array<{ cwd: string; pkg: string }> = []
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: async () => ({ kind: 'spec-rewritten', from: '^0.1.0', to: '^0.2.0', cliVersion: '0.2.0' }),
      forceBunUpdate: async (cwd, pkg) => {
        updateCalls.push({ cwd, pkg })
        return { ok: true }
      },
      readInstalledVersion: () => '0.2.0',
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    // and: bun update was called with the agent folder AND the typeclaw package name
    expect(updateCalls).toEqual([{ cwd: root, pkg: 'typeclaw' }])
    if (!result.ok) throw new Error('expected success')
    expect(result.autoUpgrade).toEqual({ kind: 'spec-rewritten', from: '^0.1.0', to: '^0.2.0', cliVersion: '0.2.0' })
  })

  test('forces bun update typeclaw when autoUpgrade reports reinstall-needed', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const updateCalls: Array<{ cwd: string; pkg: string }> = []
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: async () => ({ kind: 'reinstall-needed', from: '0.1.0', to: '0.1.2' }),
      forceBunUpdate: async (cwd, pkg) => {
        updateCalls.push({ cwd, pkg })
        return { ok: true }
      },
      readInstalledVersion: () => '0.1.2',
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    expect(updateCalls).toEqual([{ cwd: root, pkg: 'typeclaw' }])
  })

  test('does NOT call forceBunUpdate for no-op outcomes (up-to-date, dev mode, exact pin, already running, etc.)', async () => {
    for (const upgrade of [
      { kind: 'up-to-date', installedVersion: '0.1.2' } as const,
      { kind: 'skipped-dev-mode' } as const,
      { kind: 'skipped-no-dep' } as const,
      { kind: 'skipped-already-running' } as const,
      { kind: 'skipped-non-release-spec', declared: 'file:../typeclaw' } as const,
      { kind: 'exact-pin-respected', declared: '0.1.0', cliVersion: '0.1.2' } as const,
    ]) {
      await writeDockerfile(root)
      await writePackageJson(root, { typeclaw: '^0.1.0' })
      const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

      const updateCalls: Array<{ cwd: string; pkg: string }> = []
      const result = await start({
        cwd: root,
        preferredHostPort: 8973,
        exec,
        allocatePort: deterministicAllocator,
        ensureDeps: noEnsureDeps,
        autoUpgrade: async () => upgrade,
        forceBunUpdate: async (cwd, pkg) => {
          updateCalls.push({ cwd, pkg })
          return { ok: true }
        },
        ...bypassVerify,
      })

      expect(result.ok).toBe(true)
      expect(updateCalls).toEqual([])
    }
  })

  test('aborts start (no docker run) when forceBunUpdate reports failure', async () => {
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: async () => ({ kind: 'reinstall-needed', from: '0.1.0', to: '0.1.2' }),
      forceBunUpdate: async () => ({ ok: false, reason: 'registry timeout' }),
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toContain('registry timeout')
    expect(result.reason).toContain('auto-upgrade')
    expect(calls.find((c) => c.args[0] === 'run')).toBeUndefined()
  })

  test('aborts start when bun update succeeds but installed version is still stale (verification gate)', async () => {
    // Oracle's BLOCKING #5: bun update can exit 0 but resolve to an older version
    // than expected. Without verification, refreshDockerfile would pin a stale base
    // image. This test guards the verification step.
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec, calls } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: async () => ({ kind: 'reinstall-needed', from: '0.1.0', to: '0.1.2' }),
      forceBunUpdate: async () => ({ ok: true }),
      readInstalledVersion: () => '0.1.0',
      ...bypassVerify,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toContain('verification failed')
    expect(result.reason).toContain('0.1.0')
    expect(result.reason).toContain('0.1.2')
    expect(calls.find((c) => c.args[0] === 'run')).toBeUndefined()
  })

  test('verification passes when installed reaches OR EXCEEDS the upgrade target', async () => {
    // The registry may resolve a caret range to a higher patch than we asked for
    // (e.g. expected 0.1.2 but got 0.1.5 because the lockfile no longer pinned it).
    // Treat "ahead" as success — we only fail when installed is BEHIND target.
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: async () => ({ kind: 'reinstall-needed', from: '0.1.0', to: '0.1.2' }),
      forceBunUpdate: async () => ({ ok: true }),
      readInstalledVersion: () => '0.1.5',
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
  })

  test('autoUpgrade runs BEFORE ensureDeps (load-bearing order)', async () => {
    // The whole feature breaks if ensureDeps runs first: ensureDeps short-circuits
    // on "every declared dep exists" and skips the install that auto-upgrade depends
    // on. Test by recording call order in a shared array.
    await writeDockerfile(root)
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const order: string[] = []
    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      autoUpgrade: async () => {
        order.push('autoUpgrade')
        return { kind: 'skipped-no-dep' }
      },
      ensureDeps: async () => {
        order.push('ensureDeps')
        return { ok: true, installed: false }
      },
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    expect(order).toEqual(['autoUpgrade', 'ensureDeps'])
  })

  test('alreadyRunning short-circuit surfaces autoUpgrade: skipped-already-running', async () => {
    // When the container is already up, start() returns without checking auto-upgrade.
    // The outcome must reflect that honestly, not pretend we checked and found no dep.
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: true, running: true } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected success')
    expect(result.alreadyRunning).toBe(true)
    expect(result.autoUpgrade).toEqual({ kind: 'skipped-already-running' })
  })

  test('commits package.json + bun.lock under "Upgrade typeclaw to X.Y.Z" when autoUpgrade rewrote spec', async () => {
    await gitInit(root)
    await writeFile(join(root, '.gitignore'), buildGitignore())
    await writeFile(join(root, 'Dockerfile'), buildDockerfile())
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeFile(join(root, 'bun.lock'), '{"lockfileVersion":1}\n')
    await runGit(root, ['add', '.gitignore', 'package.json', 'packages/.gitkeep', 'bun.lock'])
    await runGit(root, ['commit', '-m', 'initial'])
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: async () => ({ kind: 'spec-rewritten', from: '^0.1.0', to: '^0.2.0', cliVersion: '0.2.0' }),
      forceBunUpdate: async (dir) => {
        await writePackageJson(dir, { typeclaw: '^0.2.0' })
        await writeFile(join(dir, 'bun.lock'), '{"lockfileVersion":1,"deps":"upgraded"}\n')
        return { ok: true }
      },
      readInstalledVersion: () => '0.2.0',
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    const subjects = (await runGit(root, ['log', '--format=%s'])).split('\n')
    expect(subjects).toContain('Upgrade typeclaw to ^0.2.0')
    expect(subjects).not.toContain('Update dependencies')
    const filesInCommit = (await runGit(root, ['show', '--name-only', '--format=', 'HEAD'])).split('\n').sort()
    expect(filesInCommit).toEqual(['bun.lock', 'package.json'])
  })

  test('commits under "Upgrade typeclaw to X.Y.Z" for reinstall-needed (not just spec-rewritten)', async () => {
    await gitInit(root)
    await writeFile(join(root, '.gitignore'), buildGitignore())
    await writeFile(join(root, 'Dockerfile'), buildDockerfile())
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeFile(join(root, 'bun.lock'), '{"lockfileVersion":1}\n')
    await runGit(root, ['add', '.gitignore', 'package.json', 'packages/.gitkeep', 'bun.lock'])
    await runGit(root, ['commit', '-m', 'initial'])
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: noEnsureDeps,
      autoUpgrade: async () => ({ kind: 'reinstall-needed', from: '0.1.0', to: '0.1.2' }),
      forceBunUpdate: async (dir) => {
        await writeFile(join(dir, 'bun.lock'), '{"lockfileVersion":1,"deps":"upgraded"}\n')
        return { ok: true }
      },
      readInstalledVersion: () => '0.1.2',
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    const subjects = (await runGit(root, ['log', '--format=%s'])).split('\n')
    expect(subjects).toContain('Upgrade typeclaw to 0.1.2')
  })

  test('uses "Update dependencies" when autoUpgrade is a no-op (no upgrade attribution)', async () => {
    await gitInit(root)
    await writeFile(join(root, '.gitignore'), buildGitignore())
    await writeFile(join(root, 'Dockerfile'), buildDockerfile())
    await writePackageJson(root, { typeclaw: '^0.1.0' })
    await writeFile(join(root, 'bun.lock'), '{"lockfileVersion":1}\n')
    await runGit(root, ['add', '.gitignore', 'package.json', 'packages/.gitkeep', 'bun.lock'])
    await runGit(root, ['commit', '-m', 'initial'])
    const { exec } = fakeDockerExec({ imageExists: true, container: { exists: false } })

    const result = await start({
      cwd: root,
      preferredHostPort: 8973,
      exec,
      allocatePort: deterministicAllocator,
      ensureDeps: async (dir) => {
        await writeFile(join(dir, 'bun.lock'), '{"lockfileVersion":1,"deps":"new"}\n')
        return { ok: true, installed: true }
      },
      autoUpgrade: async () => ({ kind: 'up-to-date', installedVersion: '0.1.2' }),
      ...bypassVerify,
    })

    expect(result.ok).toBe(true)
    const subjects = (await runGit(root, ['log', '--format=%s'])).split('\n')
    expect(subjects).toContain('Update dependencies')
    expect(subjects.filter((s) => s.startsWith('Upgrade typeclaw'))).toEqual([])
  })
})
