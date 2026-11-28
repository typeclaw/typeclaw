import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isPackageNotFound, reconcilePluginDeps, resolveLatestFromRegistry } from './reconcile-plugin-deps'

async function makeAgentDir(pkg: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-reconcile-'))
  await writeFile(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  return dir
}

async function readPkg(dir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
}

const neverResolve = async (name: string): Promise<string> => {
  throw new Error(`unexpected registry resolution for ${name}`)
}

describe('reconcilePluginDeps registry lookup', () => {
  test('pins an unpinned plugin from the operator registry on a cold start without leaking host values', async () => {
    // given: an agent folder whose .npmrc names its own registry and asks for a host secret
    const requests: { path: string; authorization: string | null }[] = []
    const operatorRegistry = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        requests.push({ path: url.pathname, authorization: request.headers.get('authorization') })
        if (url.pathname !== '/probe-plugin') return new Response('{}', { status: 404 })
        return Response.json({
          name: 'probe-plugin',
          'dist-tags': { latest: '2.3.4' },
          versions: { '2.3.4': { name: 'probe-plugin', version: '2.3.4', dist: { tarball: `${url.origin}/x.tgz` } } },
        })
      },
    })
    const home = await mkdtemp(join(tmpdir(), 'typeclaw-reconcile-home-'))
    const dir = await makeAgentDir({ name: 'agent', dependencies: {} })
    try {
      await writeFile(join(dir, '.npmrc'), 'registry=http://127.0.0.1:9/\n_authToken=${TC_PROBE_SECRET}\n')
      const env = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: home,
        NPM_CONFIG_REGISTRY: `http://127.0.0.1:${operatorRegistry.port}/`,
        TC_PROBE_SECRET: 'host-secret-value',
      }

      // when
      const result = await reconcilePluginDeps({
        cwd: dir,
        plugins: ['probe-plugin'],
        resolveLatest: (name) => resolveLatestFromRegistry(name, { env }),
      })

      // then: the operator registry answered, and no request carried the host value
      expect(result.changed).toBe(true)
      expect(((await readPkg(dir)).dependencies as Record<string, string>)['probe-plugin']).toBe('2.3.4')
      expect(requests.map((request) => request.path)).toContain('/probe-plugin')
      expect(requests.some((request) => request.authorization?.includes('host-secret-value'))).toBe(false)
    } finally {
      operatorRegistry.stop(true)
      await rm(dir, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  test('runs the lookup outside the agent folder with only the install env allowlist', async () => {
    const seen: { cwd?: string; env?: Record<string, string | undefined> }[] = []
    const spawn = ((options: { cwd?: string; env?: Record<string, string | undefined> }) => {
      seen.push(options)
      const text = (value: string) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(value))
            controller.close()
          },
        })
      return { exited: Promise.resolve(0), stdout: text('"1.0.0"\n'), stderr: text(''), kill() {} }
    }) as unknown as typeof Bun.spawn

    const version = await resolveLatestFromRegistry('probe-plugin', {
      spawn,
      env: { PATH: '/usr/bin', HOME: '/home/agent', OPENAI_API_KEY: 'host-secret-value' },
    })

    expect(version).toBe('1.0.0')
    expect(seen[0]?.cwd).not.toBe(process.cwd())
    expect(seen[0]?.env).toEqual({ PATH: '/usr/bin', HOME: '/home/agent' })
  })
})

describe('reconcilePluginDeps', () => {
  test('adds a versioned npm plugin to dependencies and records provenance', async () => {
    const dir = await makeAgentDir({ name: 'agent', dependencies: { typeclaw: '0.35.0' } })
    try {
      const result = await reconcilePluginDeps({
        cwd: dir,
        plugins: ['typeclaw-plugin-foo@1.2.3'],
        resolveLatest: neverResolve,
      })
      expect(result.changed).toBe(true)
      const pkg = await readPkg(dir)
      expect((pkg.dependencies as Record<string, string>)['typeclaw-plugin-foo']).toBe('1.2.3')
      expect((pkg.dependencies as Record<string, string>).typeclaw).toBe('0.35.0')
      expect((pkg.typeclaw as Record<string, unknown>).managedPlugins).toEqual({ 'typeclaw-plugin-foo': '1.2.3' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('resolves a bare name to a pinned version once', async () => {
    const dir = await makeAgentDir({ name: 'agent', dependencies: {} })
    try {
      const result = await reconcilePluginDeps({
        cwd: dir,
        plugins: ['typeclaw-plugin-foo'],
        resolveLatest: async () => '4.5.6',
      })
      expect(result.changed).toBe(true)
      const pkg = await readPkg(dir)
      expect((pkg.dependencies as Record<string, string>)['typeclaw-plugin-foo']).toBe('4.5.6')
      expect((pkg.typeclaw as Record<string, unknown>).managedPlugins).toEqual({ 'typeclaw-plugin-foo': '4.5.6' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('reuses the existing pin for a bare name instead of re-resolving latest', async () => {
    const dir = await makeAgentDir({
      name: 'agent',
      dependencies: { 'typeclaw-plugin-foo': '1.0.0' },
      typeclaw: { managedPlugins: { 'typeclaw-plugin-foo': '1.0.0' } },
    })
    try {
      // resolveLatest must NOT be called: an unchanged bare entry stays pinned.
      const result = await reconcilePluginDeps({
        cwd: dir,
        plugins: ['typeclaw-plugin-foo'],
        resolveLatest: neverResolve,
      })
      expect(result.changed).toBe(false)
      const pkg = await readPkg(dir)
      expect((pkg.dependencies as Record<string, string>)['typeclaw-plugin-foo']).toBe('1.0.0')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('prunes a managed dep when the plugin is removed from config', async () => {
    const dir = await makeAgentDir({
      name: 'agent',
      dependencies: { typeclaw: '0.35.0', 'typeclaw-plugin-foo': '1.2.3' },
      typeclaw: { managedPlugins: { 'typeclaw-plugin-foo': '1.2.3' } },
    })
    try {
      const result = await reconcilePluginDeps({ cwd: dir, plugins: [], resolveLatest: neverResolve })
      expect(result.changed).toBe(true)
      const pkg = await readPkg(dir)
      expect((pkg.dependencies as Record<string, string>)['typeclaw-plugin-foo']).toBeUndefined()
      expect((pkg.dependencies as Record<string, string>).typeclaw).toBe('0.35.0')
      expect(pkg.typeclaw).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('never prunes a dep the user added that was not managed', async () => {
    const dir = await makeAgentDir({
      name: 'agent',
      dependencies: { typeclaw: '0.35.0', 'typeclaw-plugin-foo': '9.9.9' },
      typeclaw: {},
    })
    try {
      const result = await reconcilePluginDeps({ cwd: dir, plugins: [], resolveLatest: neverResolve })
      expect(result.changed).toBe(false)
      const pkg = await readPkg(dir)
      expect((pkg.dependencies as Record<string, string>)['typeclaw-plugin-foo']).toBe('9.9.9')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('updates the pinned version when a managed plugin spec changes', async () => {
    const dir = await makeAgentDir({
      name: 'agent',
      dependencies: { 'typeclaw-plugin-foo': '1.0.0' },
      typeclaw: { managedPlugins: { 'typeclaw-plugin-foo': '1.0.0' } },
    })
    try {
      const result = await reconcilePluginDeps({
        cwd: dir,
        plugins: ['typeclaw-plugin-foo@2.0.0'],
        resolveLatest: neverResolve,
      })
      expect(result.changed).toBe(true)
      const pkg = await readPkg(dir)
      expect((pkg.dependencies as Record<string, string>)['typeclaw-plugin-foo']).toBe('2.0.0')
      expect((pkg.typeclaw as Record<string, unknown>).managedPlugins).toEqual({ 'typeclaw-plugin-foo': '2.0.0' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('skips local-path plugin entries', async () => {
    const dir = await makeAgentDir({ name: 'agent', dependencies: {} })
    try {
      const result = await reconcilePluginDeps({
        cwd: dir,
        plugins: ['./plugins/local.ts', '../shared/plugin.ts', '/abs/plugin.ts'],
        resolveLatest: neverResolve,
      })
      expect(result.changed).toBe(false)
      const pkg = await readPkg(dir)
      expect(pkg.dependencies).toEqual({})
      expect(pkg.typeclaw).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('handles scoped versioned entries', async () => {
    const dir = await makeAgentDir({ name: 'agent', dependencies: {} })
    try {
      await reconcilePluginDeps({
        cwd: dir,
        plugins: ['@acme/typeclaw-plugin-foo@3.1.0'],
        resolveLatest: neverResolve,
      })
      const pkg = await readPkg(dir)
      expect((pkg.dependencies as Record<string, string>)['@acme/typeclaw-plugin-foo']).toBe('3.1.0')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('is idempotent when config already matches package.json', async () => {
    const dir = await makeAgentDir({
      name: 'agent',
      dependencies: { 'typeclaw-plugin-foo': '1.2.3' },
      typeclaw: { managedPlugins: { 'typeclaw-plugin-foo': '1.2.3' } },
    })
    try {
      const result = await reconcilePluginDeps({
        cwd: dir,
        plugins: ['typeclaw-plugin-foo@1.2.3'],
        resolveLatest: neverResolve,
      })
      expect(result.changed).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('returns unchanged when package.json is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-reconcile-'))
    try {
      const result = await reconcilePluginDeps({
        cwd: dir,
        plugins: ['typeclaw-plugin-foo@1.2.3'],
        resolveLatest: neverResolve,
      })
      expect(result.changed).toBe(false)
      expect(result.files).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('skips a bare-name plugin that does not exist in the registry and reports it', async () => {
    const dir = await makeAgentDir({ name: 'agent', dependencies: { typeclaw: '0.35.0' } })
    try {
      const result = await reconcilePluginDeps({
        cwd: dir,
        plugins: ['foo-bar'],
        resolveLatest: async () => null,
      })
      expect(result.skipped).toEqual(['foo-bar'])
      expect(result.changed).toBe(false)
      const pkg = await readPkg(dir)
      expect((pkg.dependencies as Record<string, string>)['foo-bar']).toBeUndefined()
      expect((pkg.dependencies as Record<string, string>).typeclaw).toBe('0.35.0')
      expect(pkg.typeclaw).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('still materializes resolvable plugins when a sibling plugin is not found', async () => {
    const dir = await makeAgentDir({ name: 'agent', dependencies: {} })
    try {
      const result = await reconcilePluginDeps({
        cwd: dir,
        plugins: ['foo-bar', 'typeclaw-plugin-ok'],
        resolveLatest: async (name) => (name === 'foo-bar' ? null : '2.0.0'),
      })
      expect(result.changed).toBe(true)
      expect(result.skipped).toEqual(['foo-bar'])
      const pkg = await readPkg(dir)
      expect((pkg.dependencies as Record<string, string>)['typeclaw-plugin-ok']).toBe('2.0.0')
      expect((pkg.dependencies as Record<string, string>)['foo-bar']).toBeUndefined()
      expect((pkg.typeclaw as Record<string, unknown>).managedPlugins).toEqual({ 'typeclaw-plugin-ok': '2.0.0' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('resolves multiple new bare names concurrently, not serially', async () => {
    const dir = await makeAgentDir({ name: 'agent', dependencies: {} })
    try {
      let inFlight = 0
      let maxInFlight = 0
      const resolveLatest = async (name: string): Promise<string> => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 20))
        inFlight -= 1
        return `1.0.0-${name}`
      }
      const result = await reconcilePluginDeps({
        cwd: dir,
        plugins: ['typeclaw-plugin-a', 'typeclaw-plugin-b', 'typeclaw-plugin-c'],
        resolveLatest,
      })
      expect(result.changed).toBe(true)
      // given three new bare names, a serial pass would peak at 1 in flight
      expect(maxInFlight).toBe(3)
      const pkg = await readPkg(dir)
      const deps = pkg.dependencies as Record<string, string>
      expect(deps['typeclaw-plugin-a']).toBe('1.0.0-typeclaw-plugin-a')
      expect(deps['typeclaw-plugin-b']).toBe('1.0.0-typeclaw-plugin-b')
      expect(deps['typeclaw-plugin-c']).toBe('1.0.0-typeclaw-plugin-c')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('skipped order is deterministic regardless of which probe settles first', async () => {
    const dir = await makeAgentDir({ name: 'agent', dependencies: {} })
    try {
      // "zed" resolves quickly, "abc" slowly: settle order is zed-then-abc, but
      // both are not-found, so skipped must come back sorted (abc before zed).
      const resolveLatest = async (name: string): Promise<string | null> => {
        await new Promise((resolve) => setTimeout(resolve, name === 'abc-missing' ? 30 : 5))
        return null
      }
      const result = await reconcilePluginDeps({
        cwd: dir,
        plugins: ['zed-missing', 'abc-missing'],
        resolveLatest,
      })
      expect(result.changed).toBe(false)
      expect(result.skipped).toEqual(['abc-missing', 'zed-missing'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('a later versioned entry wins over an earlier bare entry for the same name (positional last-wins)', async () => {
    const dir = await makeAgentDir({ name: 'agent', dependencies: {} })
    try {
      // The bare entry queues a registry resolve that settles AFTER the loop;
      // it must not clobber the explicit 1.2.3 set by the later versioned entry.
      const result = await reconcilePluginDeps({
        cwd: dir,
        plugins: ['typeclaw-plugin-foo', 'typeclaw-plugin-foo@1.2.3'],
        resolveLatest: async () => '9.9.9',
      })
      expect(result.changed).toBe(true)
      const pkg = await readPkg(dir)
      expect((pkg.dependencies as Record<string, string>)['typeclaw-plugin-foo']).toBe('1.2.3')
      expect((pkg.typeclaw as Record<string, unknown>).managedPlugins).toEqual({ 'typeclaw-plugin-foo': '1.2.3' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('a later bare entry wins over an earlier versioned entry for the same name (positional last-wins)', async () => {
    const dir = await makeAgentDir({ name: 'agent', dependencies: {} })
    try {
      const result = await reconcilePluginDeps({
        cwd: dir,
        plugins: ['typeclaw-plugin-foo@1.2.3', 'typeclaw-plugin-foo'],
        resolveLatest: async () => '9.9.9',
      })
      expect(result.changed).toBe(true)
      const pkg = await readPkg(dir)
      expect((pkg.dependencies as Record<string, string>)['typeclaw-plugin-foo']).toBe('9.9.9')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('a later versioned entry suppresses the skip of an earlier not-found bare entry', async () => {
    const dir = await makeAgentDir({ name: 'agent', dependencies: {} })
    try {
      // The earlier bare entry 404s, but the later versioned entry is the last
      // occurrence and wins: the name must NOT appear in skipped.
      const result = await reconcilePluginDeps({
        cwd: dir,
        plugins: ['typeclaw-plugin-foo', 'typeclaw-plugin-foo@1.2.3'],
        resolveLatest: async () => null,
      })
      expect(result.changed).toBe(true)
      expect(result.skipped).toEqual([])
      const pkg = await readPkg(dir)
      expect((pkg.dependencies as Record<string, string>)['typeclaw-plugin-foo']).toBe('1.2.3')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('propagates a hard resolver failure instead of skipping (network errors still block)', async () => {
    const dir = await makeAgentDir({ name: 'agent', dependencies: {} })
    try {
      await expect(
        reconcilePluginDeps({
          cwd: dir,
          plugins: ['typeclaw-plugin-foo'],
          resolveLatest: async () => {
            throw new Error('network down')
          },
        }),
      ).rejects.toThrow('network down')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('isPackageNotFound', () => {
  test('treats registry 404 signals as not-found', () => {
    for (const stderr of [
      'error: package "foo-bar" not found',
      'GET https://registry.npmjs.org/foo-bar - 404 Not Found',
      'npm error code E404',
      '404 Not Found - GET https://registry.npmjs.org/foo-bar',
    ]) {
      expect(isPackageNotFound(stderr)).toBe(true)
    }
  })

  test('does NOT treat transient/auth failures as not-found', () => {
    for (const stderr of [
      'error: getaddrinfo ENOTFOUND registry.npmjs.org',
      'connect ETIMEDOUT 1.2.3.4:443',
      'npm error code E401 Unauthorized',
      'error: socket hang up',
      '',
    ]) {
      expect(isPackageNotFound(stderr)).toBe(false)
    }
  })
})
