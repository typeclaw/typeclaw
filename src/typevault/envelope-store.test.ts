import { afterEach, expect, test } from 'bun:test'
import { symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SecretsBackend } from '@/secrets/storage'

import { readEnvelopeTextSync, runHelperSync } from './envelope-store'
import { reconcileTypevault } from './lifecycle'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

// The host CLI and the container open one agent folder through different
// paths (/Users/.../agent vs /agent), so typevault sees two checkouts. Every
// envelope write is still serialized by SecretsBackend's lock on secrets.json,
// and each side must see the other's writes.
test('writes through two paths to one agent folder are both kept and seen by each side', async () => {
  // given: an enabled agent folder, opened directly and through a symlink
  const root = await mkdtemp(join(tmpdir(), 'typeclaw-typevault-paths-'))
  dirs.push(root)
  const agent = join(root, 'agent')
  const alias = join(root, 'alias')
  await Bun.write(join(agent, 'secrets.json'), '{"version":2,"providers":{},"channels":{},"mcp":{}}\n')
  symlinkSync(agent, alias)
  await reconcileTypevault(agent, true)
  const host = new SecretsBackend(join(agent, 'secrets.json'))
  const container = new SecretsBackend(join(alias, 'secrets.json'))
  expect(host.tryReadProvidersSync()).toEqual({})

  // when
  container.writeProviderCredentialSync('xai', { type: 'api_key', key: { value: 'from-container' } })
  host.writeProviderCredentialSync('fireworks', { type: 'api_key', key: { value: 'from-host' } })

  // then
  expect(Object.keys(host.tryReadProvidersSync()).sort()).toEqual(['fireworks', 'xai'])
  expect(Object.keys(container.tryReadProvidersSync()).sort()).toEqual(['fireworks', 'xai'])
})

test('a snapshot read while another process writes is not cached, so the newer write is never lost', async () => {
  // given: an enabled agent whose envelope another process rewrites mid-read
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-typevault-race-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'secrets.json'), '{"version":2,"providers":{},"channels":{},"mcp":{}}\n')
  await reconcileTypevault(dir, true)
  const newer = '{"version":2,"providers":{"xai":{"type":"api_key","key":{"value":"newer"}}},"channels":{},"mcp":{}}\n'

  // when: the write lands between the helper's read and the cache publication
  const stale = readEnvelopeTextSync(dir, (agentDir) => {
    const snapshot = runHelperSync(agentDir, 'read')
    runHelperSync(agentDir, 'write', newer)
    return snapshot
  })
  const backend = new SecretsBackend(join(dir, 'secrets.json'))
  backend.writeProviderCredentialSync('fireworks', { type: 'api_key', key: { value: 'later' } })

  // then
  expect(stale).not.toContain('newer')
  expect(Object.keys(backend.tryReadProvidersSync()).sort()).toEqual(['fireworks', 'xai'])
})

test('a plain secrets.json never touches typevault', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-typevault-plain-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'secrets.json'), '{"version":2,"providers":{},"channels":{},"mcp":{}}\n')

  new SecretsBackend(join(dir, 'secrets.json')).writeProviderCredentialSync('xai', {
    type: 'api_key',
    key: { value: 'k' },
  })

  expect(JSON.parse(await Bun.file(join(dir, 'secrets.json')).text()).providers.xai.key.value).toBe('k')
  expect(await Bun.file(join(dir, '.typevault', 'owner.json')).exists()).toBe(false)
})
