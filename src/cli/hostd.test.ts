import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import { configSchema } from '@/config'
import type { RestartOptions, RestartResult, StartOptions, StartResult } from '@/container'

import { buildHostdRestart, buildHostdRestartPreflight } from './hostd'

describe('buildHostdRestart', () => {
  test('restarts through the already-running hostd instead of triggering drift respawn', async () => {
    const starts: RestartOptions[] = []
    const restart = buildHostdRestart('/repo/src/cli/index.ts', {
      validateConfig: () => ({ ok: true }),
      loadConfigSync: () => configSchema.parse({ port: 61234 }),
      restart: async (opts) => {
        starts.push(opts)
        return restartOk(opts)
      },
    })

    const result = await restart({ containerName: 'agent', cwd: '/agent-dir' })

    expect(result.ok).toBe(true)
    expect(starts).toHaveLength(1)
    expect(starts[0]).toMatchObject({
      cwd: '/agent-dir',
      preferredHostPort: 61234,
      cliEntry: '/repo/src/cli/index.ts',
      reuseCurrentHostDaemon: true,
      forceBuild: false,
    })
  })

  test('forwards build:true to start() as forceBuild', async () => {
    const starts: RestartOptions[] = []
    const restart = buildHostdRestart('/repo/src/cli/index.ts', {
      validateConfig: () => ({ ok: true }),
      loadConfigSync: () => configSchema.parse({ port: 61234 }),
      restart: async (opts) => {
        starts.push(opts)
        return restartOk(opts)
      },
    })

    const result = await restart({ containerName: 'agent', cwd: '/agent-dir', build: true })

    expect(result.ok).toBe(true)
    expect(starts).toHaveLength(1)
    expect(starts[0]?.forceBuild).toBe(true)
  })

  test('refuses daemon-owned restart when hostd source has drifted', async () => {
    const starts: RestartOptions[] = []
    const restart = buildHostdRestart(
      join(process.cwd(), 'src/cli/index.ts'),
      {
        validateConfig: () => ({ ok: true }),
        loadConfigSync: () => configSchema.parse({ port: 61234 }),
        restart: async (opts) => {
          starts.push(opts)
          return restartOk(opts)
        },
      },
      'stale-version',
    )

    const result = await restart({ containerName: 'agent', cwd: '/agent-dir', build: true })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('host daemon source has drifted')
    expect(starts).toHaveLength(0)
  })

  test('restart preflight rejects source drift before ACK', async () => {
    const preflight = buildHostdRestartPreflight(join(process.cwd(), 'src/cli/index.ts'), 'stale-version')

    const result = await preflight({ containerName: 'agent', cwd: '/agent-dir', build: true })

    expect(result).toEqual({
      ok: false,
      reason:
        'host daemon source has drifted from the current typeclaw source; run `typeclaw restart --build` from the host-stage agent folder so the daemon respawns before rebuilding the Docker image',
    })
  })

  test('restart preflight refuses when dependency validation fails', async () => {
    const preflight = buildHostdRestartPreflight('/repo/src/cli/index.ts', 'unversioned', {
      loadConfigSync: () => configSchema.parse({ port: 8973, plugins: [] }),
      validateRestartDeps: async () => ({ ok: false, reason: 'workspace:* failed to resolve' }),
    })

    const result = await preflight({ containerName: 'agent', cwd: '/agent-dir', build: false })

    expect(result).toEqual({
      ok: false,
      reason: 'restart refused for agent: workspace:* failed to resolve',
    })
  })

  test('restart preflight passes plugins from config into the dependency validator', async () => {
    const seen: Array<{ cwd: string; plugins: readonly string[] }> = []
    const preflight = buildHostdRestartPreflight('/repo/src/cli/index.ts', 'unversioned', {
      loadConfigSync: () => configSchema.parse({ port: 8973, plugins: ['./packages/foo'] }),
      validateRestartDeps: async (opts) => {
        seen.push(opts)
        return { ok: true }
      },
    })

    const result = await preflight({ containerName: 'agent', cwd: '/agent-dir', build: false })

    expect(result).toBeNull()
    expect(seen).toEqual([{ cwd: '/agent-dir', plugins: ['./packages/foo'] }])
  })

  test('restart preflight proceeds when config cannot be read (start stays the fail-closed gate)', async () => {
    const preflight = buildHostdRestartPreflight('/repo/src/cli/index.ts', 'unversioned', {
      loadConfigSync: () => {
        throw new Error('typeclaw.json unreadable')
      },
      validateRestartDeps: async () => ({ ok: false, reason: 'should not be called' }),
    })

    const result = await preflight({ containerName: 'agent', cwd: '/agent-dir', build: false })

    expect(result).toBeNull()
  })

  test('forwards the daemon-supplied currentHostDaemon into start()', async () => {
    const starts: RestartOptions[] = []
    const register = async (): Promise<{ ok: true }> => ({ ok: true })
    const deregister = async (): Promise<void> => {}
    const restart = buildHostdRestart('/repo/src/cli/index.ts', {
      validateConfig: () => ({ ok: true }),
      loadConfigSync: () => configSchema.parse({ port: 61234 }),
      restart: async (opts) => {
        starts.push(opts)
        return restartOk(opts)
      },
    })

    const result = await restart({
      containerName: 'agent',
      cwd: '/agent-dir',
      currentHostDaemon: { httpPort: 8974, register, deregister },
    })

    expect(result.ok).toBe(true)
    expect(starts[0]?.currentHostDaemon).toEqual({ httpPort: 8974, register, deregister })
  })

  test('omits currentHostDaemon when the daemon does not supply one', async () => {
    const starts: RestartOptions[] = []
    const restart = buildHostdRestart('/repo/src/cli/index.ts', {
      validateConfig: () => ({ ok: true }),
      loadConfigSync: () => configSchema.parse({ port: 61234 }),
      restart: async (opts) => {
        starts.push(opts)
        return restartOk(opts)
      },
    })

    await restart({ containerName: 'agent', cwd: '/agent-dir' })

    expect(starts[0]).not.toHaveProperty('currentHostDaemon')
  })

  test('omitted build defaults to forceBuild:false', async () => {
    const starts: RestartOptions[] = []
    const restart = buildHostdRestart('/repo/src/cli/index.ts', {
      validateConfig: () => ({ ok: true }),
      loadConfigSync: () => configSchema.parse({ port: 61234 }),
      restart: async (opts) => {
        starts.push(opts)
        return restartOk(opts)
      },
    })

    const result = await restart({ containerName: 'agent', cwd: '/agent-dir' })

    expect(result.ok).toBe(true)
    expect(starts[0]?.forceBuild).toBe(false)
  })
})

function startOk(opts: StartOptions): Extract<StartResult, { ok: true }> {
  return {
    ok: true,
    plan: {
      containerName: 'agent',
      imageTag: 'typeclaw-agent',
      buildContext: opts.cwd,
      dockerfile: `${opts.cwd}/Dockerfile`,
      runArgs: ['run'],
      needsBuild: false,
      hostPort: opts.preferredHostPort,
      tuiToken: 'fake-tui-token',
    },
    containerId: 'container-id',
    built: false,
    hostPort: opts.preferredHostPort,
    tuiToken: 'fake-tui-token',
    hostd: { state: 'registered' },
    alreadyRunning: false,
    autoUpgrade: { kind: 'skipped-no-dep' },
    skippedPlugins: [],
    dockerfileWarnings: [],
  }
}

function restartOk(opts: RestartOptions): RestartResult {
  return {
    ok: true,
    stop: { ok: true, containerName: 'agent', running: true },
    start: startOk({ cwd: opts.cwd, preferredHostPort: opts.preferredHostPort }),
  }
}
