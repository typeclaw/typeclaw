import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runBunInstall, runBunUpdate } from './run-bun-install'

// A child whose stdout drain rejects and whose exit only settles after kill(),
// so the test can prove the drain-failure path reaps the process instead of
// disarming the timeout and leaking it.
function spawnRejectingDrain(): {
  spawn: typeof Bun.spawn
  killed: () => boolean
} {
  let resolveExited: (code: number) => void = () => {}
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve
  })
  let killed = false
  const proc = {
    exited,
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('stdout drain failed'))
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    }),
    kill() {
      killed = true
      resolveExited(137)
    },
  }
  return { spawn: (() => proc) as unknown as typeof Bun.spawn, killed: () => killed }
}

describe('runBunInstall', () => {
  test('times out a hung install process', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tc-bun-install-timeout-'))
    try {
      const spawnHungProcess: typeof Bun.spawn = () =>
        Bun.spawn({ cmd: ['bun', '-e', 'setInterval(() => {}, 1000)'], cwd, stdout: 'pipe', stderr: 'pipe' })
      await writeFile(join(cwd, 'package.json'), '{}\n')

      const result = await runBunInstall(cwd, { timeoutMs: 50, spawn: spawnHungProcess })

      expect(result).toEqual({ ok: false, reason: 'bun install timed out after 0.05s' })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('kills and reaps the child when a pipe drain rejects', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tc-bun-install-drain-'))
    try {
      await writeFile(join(cwd, 'package.json'), '{}\n')
      const { spawn, killed } = spawnRejectingDrain()

      const result = await runBunInstall(cwd, { timeoutMs: 10_000, spawn })

      expect(result).toEqual({ ok: false, reason: 'stdout drain failed' })
      expect(killed()).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('installs the agent folder without running any lifecycle script it declares', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tc-bun-install-scripts-'))
    try {
      // given: root and workspace packages whose install scripts would run on the host
      const marker = (name: string) => `bun -e "require('fs').writeFileSync('${join(cwd, name)}', '')"`
      await writeFile(
        join(cwd, 'package.json'),
        JSON.stringify({
          name: 'agent',
          private: true,
          workspaces: ['packages/*'],
          dependencies: { tool: 'workspace:*' },
          scripts: { preinstall: marker('root-preinstall'), postinstall: marker('root-postinstall') },
        }),
      )
      await mkdir(join(cwd, 'packages', 'tool'), { recursive: true })
      await writeFile(
        join(cwd, 'packages', 'tool', 'package.json'),
        JSON.stringify({ name: 'tool', version: '0.0.0', scripts: { postinstall: marker('workspace-postinstall') } }),
      )

      // when
      const result = await runBunInstall(cwd)

      // then: dependencies are installed, but nothing the folder declares executed
      expect(result).toEqual({ ok: true })
      expect(existsSync(join(cwd, 'node_modules', 'tool', 'package.json'))).toBe(true)
      expect(existsSync(join(cwd, 'root-preinstall'))).toBe(false)
      expect(existsSync(join(cwd, 'root-postinstall'))).toBe(false)
      expect(existsSync(join(cwd, 'workspace-postinstall'))).toBe(false)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('does not expand host environment values into registry config the agent folder declares', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tc-bun-install-registry-'))
    const authorizations: (string | null)[] = []
    const registry = Bun.serve({
      port: 0,
      fetch(request) {
        authorizations.push(request.headers.get('authorization'))
        return new Response('{}', { status: 404 })
      },
    })
    try {
      // given: bunfig.toml and .npmrc that send host env values to an agent-chosen registry
      const url = `http://127.0.0.1:${registry.port}/`
      await writeFile(
        join(cwd, 'package.json'),
        JSON.stringify({ name: 'agent', private: true, dependencies: { '@probe/pkg': '1.0.0', 'probe-pkg': '1.0.0' } }),
      )
      await writeFile(
        join(cwd, 'bunfig.toml'),
        `[install.scopes]\n"@probe" = { url = "${url}", token = "$TC_PROBE_SECRET" }\n`,
      )
      await writeFile(
        join(cwd, '.npmrc'),
        `registry=${url}\n//127.0.0.1:${registry.port}/:_authToken=\${TC_PROBE_SECRET}\n`,
      )

      // when
      await runBunInstall(cwd, { env: { ...process.env, TC_PROBE_SECRET: 'host-secret-value' } })

      // then: the registry was contacted without the host value
      expect(authorizations.length).toBeGreaterThan(0)
      expect(authorizations.some((value) => value?.includes('host-secret-value'))).toBe(false)
    } finally {
      registry.stop(true)
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('reports stderr (not stdout) in the failure reason on a non-zero exit', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tc-bun-install-fail-'))
    try {
      await writeFile(join(cwd, 'package.json'), '{}\n')
      const spawnFailing: typeof Bun.spawn = () =>
        Bun.spawn({
          cmd: [
            'bun',
            '-e',
            'process.stdout.write("STDOUT_MARKER"); process.stderr.write("STDERR_MARKER"); process.exit(3)',
          ],
          cwd,
          stdout: 'pipe',
          stderr: 'pipe',
        })

      const result = await runBunInstall(cwd, { timeoutMs: 10_000, spawn: spawnFailing })

      expect(result.ok).toBe(false)
      const reason = result.ok ? '' : result.reason
      expect(reason).toContain('STDERR_MARKER')
      expect(reason).not.toContain('STDOUT_MARKER')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('runBunUpdate', () => {
  test('times out a hung update process', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tc-bun-update-timeout-'))
    try {
      const spawnHungProcess: typeof Bun.spawn = () =>
        Bun.spawn({ cmd: ['bun', '-e', 'setInterval(() => {}, 1000)'], cwd, stdout: 'pipe', stderr: 'pipe' })
      await writeFile(join(cwd, 'package.json'), '{}\n')

      const result = await runBunUpdate(cwd, 'typeclaw', { timeoutMs: 50, spawn: spawnHungProcess })

      expect(result).toEqual({ ok: false, reason: 'bun update typeclaw timed out after 0.05s' })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
