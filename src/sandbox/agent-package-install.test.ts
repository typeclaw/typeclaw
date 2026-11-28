import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { prepareBashSandbox } from '@/agent/bash-sandbox'
import type { SessionOrigin } from '@/agent/session-origin'
import { COPYFILE_INSTALL_MARKER, runBunInstall } from '@/init/run-bun-install'
import { createPermissionService } from '@/permissions/permissions'

const owner: SessionOrigin = { kind: 'tui', sessionId: 'agent-package-install' }

// Serves one package the way the npm registry does, so typeclaw arrives as a
// registry dependency, as in production, rather than a re-copied file: link.
async function localRegistry(root: string, name: string, version: string): Promise<{ url: string; stop: () => void }> {
  const packageDir = join(root, 'registry-src', 'package')
  await mkdir(packageDir, { recursive: true })
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name, version }))
  const tarball = join(root, `${name}-${version}.tgz`)
  const tar = Bun.spawn(['tar', '-czf', tarball, '-C', join(root, 'registry-src'), 'package'])
  if ((await tar.exited) !== 0) throw new Error('tar failed')
  const bytes = new Uint8Array(await Bun.file(tarball).arrayBuffer())
  const integrity = `sha512-${new Bun.CryptoHasher('sha512').update(bytes).digest('base64')}`
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === `/${name}`) {
        return Response.json({
          name,
          'dist-tags': { latest: version },
          versions: { [version]: { name, version, dist: { tarball: `${url.origin}/${name}.tgz`, integrity } } },
        })
      }
      if (url.pathname === `/${name}.tgz`) return new Response(bytes)
      return new Response('{}', { status: 404 })
    },
  })
  return { url: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true) }
}

// Runs one command the way model bash does: through the real bwrap profile
// for the session's role, as a fresh process per call.
async function sandboxedBash(agentDir: string, command: string): Promise<{ code: number; output: string }> {
  const prepared = await prepareBashSandbox({
    command,
    permissions: createPermissionService(),
    origin: owner,
    agentDir,
    sessionId: `agent-package-install-${process.pid}`,
  })
  try {
    await prepared.verify()
    const proc = Bun.spawn(['/bin/sh', '-c', prepared.commandString], {
      cwd: agentDir,
      env: prepared.spawnEnv ?? process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { code, output: stdout + stderr }
  } finally {
    await prepared.cleanup()
  }
}

// Dependency-bin wrappers run `bun` from the sandbox PATH, as in the TypeClaw
// image; runners that install bun only under a home directory cannot host this.
const sandboxHasBun = Bun.which('bun', { PATH: '/usr/local/bin:/usr/bin:/bin' }) !== null

describe.skipIf(process.platform !== 'linux' || !Bun.which('bwrap') || !sandboxHasBun)(
  'agent package installs in the bash sandbox',
  () => {
    test('a root-writable role installs a package, runs its command next call, and cannot touch runtime code', async () => {
      const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-agent-package-'))
      const registry = await localRegistry(await mkdtemp(join(tmpdir(), 'typeclaw-registry-')), 'typeclaw', '0.0.0')
      try {
        // given: a host-installed agent package whose runtime closure is typeclaw
        await writeFile(join(agentDir, '.npmrc'), `registry=${registry.url}\n`)
        await writeFile(
          join(agentDir, 'package.json'),
          JSON.stringify({
            name: 'agent',
            private: true,
            dependencies: { typeclaw: '0.0.0' },
            trustedDependencies: ['fixture-cli'],
          }),
        )
        await mkdir(join(agentDir, 'vendor', 'fixture-cli'), { recursive: true })
        await writeFile(
          join(agentDir, 'vendor', 'fixture-cli', 'package.json'),
          JSON.stringify({
            name: 'fixture-cli',
            version: '1.0.0',
            bin: { 'fixture-cli': 'cli.js' },
            scripts: { postinstall: 'touch postinstall-ran' },
          }),
        )
        await writeFile(join(agentDir, 'vendor', 'fixture-cli', 'cli.js'), 'console.log("fixture-cli works")\n')
        expect(await runBunInstall(agentDir)).toEqual({ ok: true })
        expect(await Bun.file(join(agentDir, 'node_modules', COPYFILE_INSTALL_MARKER)).exists()).toBe(true)

        // when: the agent installs the package, then calls its command in a second bash call
        const install = await sandboxedBash(agentDir, 'bun add ./vendor/fixture-cli --linker=hoisted')
        const run = await sandboxedBash(agentDir, 'fixture-cli && test -e node_modules/fixture-cli/postinstall-ran')
        const tamper = await sandboxedBash(agentDir, 'echo injected > node_modules/typeclaw/package.json')

        // then
        expect(install).toMatchObject({ code: 0 })
        expect(run.code).toBe(0)
        expect(run.output).toContain('fixture-cli works')
        expect(tamper.code).not.toBe(0)
        expect(await Bun.file(join(agentDir, 'node_modules', 'typeclaw', 'package.json')).json()).toEqual({
          name: 'typeclaw',
          version: '0.0.0',
        })
      } finally {
        registry.stop()
        await rm(agentDir, { recursive: true, force: true })
      }
    })
  },
)
