import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  COPYFILE_INSTALL_MARKER,
  recoverHiddenOperatorDotenv,
  runBunInstall,
  runBunPmViewVersion,
  runBunUpdate,
} from './run-bun-install'

// A host env with the operator's own Bun/npm config moved to an empty home, so
// only the agent folder's config files can steer the install.
async function isolatedHostEnv(extra: Record<string, string>): Promise<Record<string, string | undefined>> {
  const home = await mkdtemp(join(tmpdir(), 'tc-bun-install-home-'))
  return { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, ...extra }
}

function recordingRegistry(): {
  url: string
  requests: { path: string; authorization: string | null }[]
  stop: () => void
} {
  const requests: { path: string; authorization: string | null }[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      requests.push({ path: new URL(request.url).pathname, authorization: request.headers.get('authorization') })
      return new Response('{}', { status: 404 })
    },
  })
  return { url: `http://127.0.0.1:${server.port}/`, requests, stop: () => server.stop(true) }
}

function spawnCapturingEnv(): { spawn: typeof Bun.spawn; calls: Record<string, string | undefined>[] } {
  const calls: Record<string, string | undefined>[] = []
  const spawn = ((options: { env?: Record<string, string | undefined> }) => {
    calls.push(options.env ?? {})
    const empty = () => new ReadableStream<Uint8Array>({ start: (controller) => controller.close() })
    return { exited: Promise.resolve(0), stdout: empty(), stderr: empty(), kill() {} }
  }) as unknown as typeof Bun.spawn
  return { spawn, calls }
}

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

  test('ignores agent bunfig.toml registry config and sends no host env value through .npmrc', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tc-bun-install-registry-'))
    const bunfigRegistry = recordingRegistry()
    const npmrcRegistry = recordingRegistry()
    try {
      // given: a bunfig.toml scope and an .npmrc default registry, each asking for a host env value
      await writeFile(
        join(cwd, 'package.json'),
        JSON.stringify({ name: 'agent', private: true, dependencies: { '@probe/pkg': '1.0.0' } }),
      )
      await writeFile(
        join(cwd, 'bunfig.toml'),
        `[install.scopes]\n"@probe" = { url = "${bunfigRegistry.url}", token = "$TC_PROBE_SECRET" }\n`,
      )
      const npmrcHost = new URL(npmrcRegistry.url).host
      await writeFile(
        join(cwd, '.npmrc'),
        `registry=${npmrcRegistry.url}\n//${npmrcHost}/:_authToken=\${TC_PROBE_SECRET}\n`,
      )

      // when
      await runBunInstall(cwd, { env: await isolatedHostEnv({ TC_PROBE_SECRET: 'host-secret-value' }) })

      // then: the bunfig route was never used, and the .npmrc route got no host value
      expect(bunfigRegistry.requests).toEqual([])
      expect(npmrcRegistry.requests.map((request) => request.path)).toContain('/@probe%2fpkg')
      expect(npmrcRegistry.requests.some((request) => request.authorization?.includes('host-secret-value'))).toBe(false)
    } finally {
      bunfigRegistry.stop()
      npmrcRegistry.stop()
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('never loads a security scanner module the agent bunfig.toml declares', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tc-bun-install-scanner-'))
    try {
      // given: a scanner module that would run as the operator during install
      const marker = join(cwd, 'scanner-ran')
      await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'agent', private: true }))
      await writeFile(
        join(cwd, 'scanner.ts'),
        `require('fs').writeFileSync(${JSON.stringify(marker)}, '')\nexport const scanner = { version: '1', scan: async () => [] }\n`,
      )
      await writeFile(join(cwd, 'bunfig.toml'), '[install.security]\nscanner = "./scanner.ts"\n')

      // when
      const result = await runBunInstall(cwd, { env: await isolatedHostEnv({}) })

      // then
      expect(result).toEqual({ ok: true })
      expect(existsSync(marker)).toBe(false)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('refuses a credentialed proxy or registry URL but passes credential-free ones', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tc-bun-install-proxy-'))
    try {
      await writeFile(join(cwd, 'package.json'), '{}\n')
      const refused = spawnCapturingEnv()
      const passed = spawnCapturingEnv()

      const withCredentials = await runBunInstall(cwd, {
        spawn: refused.spawn,
        env: { PATH: '/usr/bin', HTTPS_PROXY: 'http://user:pass@proxy.example:8080' },
      })
      const registryWithCredentials = await runBunInstall(cwd, {
        spawn: refused.spawn,
        env: { PATH: '/usr/bin', NPM_CONFIG_REGISTRY: 'https://user:token@registry.example/' },
      })
      const withoutCredentials = await runBunInstall(cwd, {
        spawn: passed.spawn,
        env: {
          PATH: '/usr/bin',
          HTTPS_PROXY: 'http://proxy.example:8080',
          NPM_CONFIG_REGISTRY: 'https://registry.example/',
          NPM_TOKEN: 'host-token',
        },
      })

      expect(withCredentials.ok ? '' : withCredentials.reason).toContain('HTTPS_PROXY carries credentials in its URL')
      expect(registryWithCredentials.ok ? '' : registryWithCredentials.reason).toContain(
        'NPM_CONFIG_REGISTRY carries credentials in its URL',
      )
      expect(refused.calls).toEqual([])
      expect(withoutCredentials).toEqual({ ok: true })
      expect(passed.calls[0]?.HTTPS_PROXY).toBe('http://proxy.example:8080')
      expect(passed.calls[0]?.NPM_CONFIG_REGISTRY).toBe('https://registry.example/')
      expect(passed.calls[0]?.NPM_TOKEN).toBeUndefined()
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('marks a tree it extracted in full and leaves an older tree unmarked', async () => {
    const fresh = await mkdtemp(join(tmpdir(), 'tc-bun-install-marker-'))
    const older = await mkdtemp(join(tmpdir(), 'tc-bun-install-marker-older-'))
    try {
      // given: an empty folder, and one whose node_modules predates the copyfile backend
      for (const cwd of [fresh, older]) {
        await writeFile(
          join(cwd, 'package.json'),
          JSON.stringify({ name: 'agent', private: true, dependencies: { dep: 'file:./dep' } }),
        )
        await mkdir(join(cwd, 'dep'))
        await writeFile(join(cwd, 'dep', 'package.json'), JSON.stringify({ name: 'dep', version: '1.0.0' }))
      }
      await mkdir(join(older, 'node_modules'))

      // when
      const env = await isolatedHostEnv({})
      await runBunInstall(fresh, { env })
      await runBunInstall(older, { env })

      // then
      expect(existsSync(join(fresh, 'node_modules', COPYFILE_INSTALL_MARKER))).toBe(true)
      expect(existsSync(join(older, 'node_modules', COPYFILE_INSTALL_MARKER))).toBe(false)

      // when: the older tree is reinstalled in place, even with --force
      await runBunInstall(older, { env, force: true })

      // then: an in-place install proves nothing about leftover entries
      expect(existsSync(join(older, 'node_modules', COPYFILE_INSTALL_MARKER))).toBe(false)
    } finally {
      await rm(fresh, { recursive: true, force: true })
      await rm(older, { recursive: true, force: true })
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

describe('operator .env during host Bun runs', () => {
  test('keeps on-disk .env values out of registry requests and restores the file unchanged', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tc-bun-install-dotenv-'))
    const registry = recordingRegistry()
    try {
      // given: the operator's .env holds a value that agent-written .npmrc and .env.local reference
      const dotenv = 'TC_DOTENV_SECRET=dotenv-secret-value\n'
      await writeFile(join(cwd, '.env'), dotenv)
      await writeFile(join(cwd, '.env.local'), 'TC_LOCAL_COPY=${TC_DOTENV_SECRET}\n')
      await writeFile(
        join(cwd, 'package.json'),
        JSON.stringify({ name: 'agent', private: true, dependencies: { 'probe-pkg': '1.0.0' } }),
      )
      const host = new URL(registry.url).host
      await writeFile(
        join(cwd, '.npmrc'),
        `registry=${registry.url}\n//${host}/:_authToken=x\${TC_DOTENV_SECRET}\${TC_LOCAL_COPY}\n`,
      )

      // when
      await runBunInstall(cwd, { env: await isolatedHostEnv({}) })

      // then
      expect(registry.requests.length).toBeGreaterThan(0)
      expect(registry.requests.some((request) => request.authorization?.includes('dotenv-secret-value'))).toBe(false)
      expect(await readFile(join(cwd, '.env'), 'utf8')).toBe(dotenv)
      expect(existsSync(join(cwd, '.typeclaw', 'credential-staging', 'host-bun.env'))).toBe(false)
    } finally {
      registry.stop()
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('puts back a .env that an interrupted run left in credential staging', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tc-bun-install-dotenv-recover-'))
    try {
      await mkdir(join(cwd, '.typeclaw', 'credential-staging'), { recursive: true })
      await writeFile(join(cwd, '.typeclaw', 'credential-staging', 'host-bun.env'), 'KEY=value\n')

      recoverHiddenOperatorDotenv(cwd)

      expect(await readFile(join(cwd, '.env'), 'utf8')).toBe('KEY=value\n')
      expect(existsSync(join(cwd, '.typeclaw', 'credential-staging', 'host-bun.env'))).toBe(false)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('runBunPmViewVersion', () => {
  test('refuses a credentialed proxy URL before contacting any registry', async () => {
    const result = await runBunPmViewVersion('typeclaw', {
      env: { PATH: process.env.PATH, ALL_PROXY: 'socks5://user:pass@proxy.example:1080' },
    })

    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.stderr).toContain('ALL_PROXY carries credentials in its URL')
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
