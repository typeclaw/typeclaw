import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createClient, parseEntryName } from 'typevault'

import { hydrateChannelEnvFromSecrets } from '@/secrets/hydrate'
import { parseSecretsFile } from '@/secrets/schema'
import { SecretsBackend } from '@/secrets/storage'

import { isTypevaultMarker, typevaultMarkerText } from './envelope-store'
import { reconcileTypevault } from './lifecycle'
import { readSecretsEntry, TYPEVAULT_STATE_RELATIVE_DIR, typevaultDir, typevaultEnv } from './vault'

const ORIGINAL = `${JSON.stringify(
  {
    version: 2,
    providers: { fireworks: { type: 'api_key', key: { value: 'fw-original' } } },
    channels: { 'discord-bot': { token: { value: 'discord-token' } } },
    mcp: {},
  },
  null,
  2,
)}\n`

const dirs: string[] = []

async function agentWith(secrets?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-typevault-'))
  dirs.push(dir)
  if (secrets !== undefined) writeFileSync(join(dir, 'secrets.json'), secrets)
  return dir
}

const secretsText = (dir: string) => readFileSync(join(dir, 'secrets.json'), 'utf8')

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else files[path.slice(root.length)] = readFileSync(path, 'base64')
    }
  }
  walk(root)
  return files
}

function entryFile(dir: string): string {
  const entries = join(typevaultDir(dir), 'entries')
  const [name] = readdirSync(entries)
  if (name === undefined) throw new Error('no entry file')
  return join(entries, name)
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('reconcileTypevault', () => {
  test('enabling moves secrets.json into the vault and leaves the marker behind', async () => {
    const dir = await agentWith(ORIGINAL)

    expect(await reconcileTypevault(dir, true)).toEqual({ action: 'enabled' })

    expect(isTypevaultMarker(secretsText(dir))).toBe(true)
    expect(secretsText(dir)).not.toContain('fw-original')
    expect(await readSecretsEntry(dir)).toBe(ORIGINAL)
  })

  test('SecretsBackend reads and writes through the marker into the vault', async () => {
    const dir = await agentWith(ORIGINAL)
    await reconcileTypevault(dir, true)
    const backend = new SecretsBackend(join(dir, 'secrets.json'))

    backend.writeProviderCredentialSync('xai', { type: 'api_key', key: { value: 'xai-key' } })

    expect(isTypevaultMarker(secretsText(dir))).toBe(true)
    expect(Object.keys(backend.tryReadProvidersSync()).sort()).toEqual(['fireworks', 'xai'])
    expect(new SecretsBackend(join(dir, 'secrets.json')).tryReadChannelsSync()).toEqual({
      'discord-bot': { token: { value: 'discord-token' } },
    })
    expect(JSON.parse((await readSecretsEntry(dir)) ?? '').providers.xai.key.value).toBe('xai-key')
  })

  test('channel tokens are hydrated into the environment from the vault', async () => {
    const dir = await agentWith(ORIGINAL)
    await reconcileTypevault(dir, true)
    const env: NodeJS.ProcessEnv = {}

    hydrateChannelEnvFromSecrets({ agentDir: dir, env })

    expect(env.DISCORD_BOT_TOKEN).toBe('discord-token')
  })

  test('disabling restores the vault copy, including changes made while enabled', async () => {
    const dir = await agentWith(ORIGINAL)
    await reconcileTypevault(dir, true)
    new SecretsBackend(join(dir, 'secrets.json')).writeProviderCredentialSync('xai', {
      type: 'api_key',
      key: { value: 'xai-key' },
    })

    expect(await reconcileTypevault(dir, false)).toEqual({ action: 'restored' })

    const restored = JSON.parse(secretsText(dir))
    expect(parseSecretsFile(restored).ok).toBe(true)
    expect(restored.providers.fireworks.key.value).toBe('fw-original')
    expect(restored.providers.xai.key.value).toBe('xai-key')
  })

  test('re-enabling resumes the dormant vault: other entries survive and the file wins', async () => {
    const dir = await agentWith(ORIGINAL)
    await reconcileTypevault(dir, true)
    const vault = await createClient({ direct: true, global: true, dir: typevaultDir(dir), env: typevaultEnv(dir) })
    await vault.set({
      name: parseEntryName('tv://example/login'),
      tier: 'runtime',
      fields: { $default: { type: 'secret', value: 'kept' } },
    })
    await reconcileTypevault(dir, false)
    const edited = ORIGINAL.replace('fw-original', 'fw-edited-while-disabled')
    writeFileSync(join(dir, 'secrets.json'), edited)

    expect(await reconcileTypevault(dir, true)).toEqual({ action: 'resumed' })

    expect(await readSecretsEntry(dir)).toBe(edited)
    expect((await vault.get(parseEntryName('tv://example/login'), 'test')).fields['$default']).toMatchObject({
      value: 'kept',
    })
  })

  test('an already-enabled agent is left as is', async () => {
    const dir = await agentWith(ORIGINAL)
    await reconcileTypevault(dir, true)

    expect(await reconcileTypevault(dir, true)).toEqual({ action: 'unchanged' })
    expect(await readSecretsEntry(dir)).toBe(ORIGINAL)
  })

  test('a vault whose key is missing is not replaced, and secrets.json stays the store', async () => {
    const dir = await agentWith(ORIGINAL)
    await reconcileTypevault(dir, true)
    await reconcileTypevault(dir, false)
    renameSync(join(dir, TYPEVAULT_STATE_RELATIVE_DIR), join(dir, 'moved-key'))

    const result = await reconcileTypevault(dir, true)

    expect(result.action).toBe('skipped')
    expect(secretsText(dir)).toBe(ORIGINAL)
    expect(existsSync(join(typevaultDir(dir), 'owner.json'))).toBe(true)
  })

  test('a lost owner.json never re-initializes the vault, enabled or not', async () => {
    const dir = await agentWith(ORIGINAL)
    await reconcileTypevault(dir, true)
    rmSync(join(typevaultDir(dir), 'owner.json'))
    const identityFile = join(dir, TYPEVAULT_STATE_RELATIVE_DIR, 'config', 'typevault', 'identity.json')
    const before = { vault: snapshot(typevaultDir(dir)), identity: readFileSync(identityFile, 'utf8') }

    const whileEnabled = await reconcileTypevault(dir, true)
    await reconcileTypevault(dir, false)
    writeFileSync(join(dir, 'secrets.json'), ORIGINAL)
    const afterDisable = await reconcileTypevault(dir, true)

    expect(whileEnabled.action).toBe('skipped')
    expect(afterDisable.action).toBe('skipped')
    expect(snapshot(typevaultDir(dir))).toEqual(before.vault)
    expect(existsSync(join(typevaultDir(dir), 'owner.json'))).toBe(false)
    expect(readFileSync(identityFile, 'utf8')).toBe(before.identity)
  })

  test.each(['missing', 'tampered'])(
    'a %s secrets entry is an error, never an empty store, and disabling keeps the marker',
    async (damage) => {
      const dir = await agentWith(ORIGINAL)
      await reconcileTypevault(dir, true)
      const file = entryFile(dir)
      if (damage === 'missing') rmSync(file)
      else writeFileSync(file, readFileSync(file, 'utf8').replace('"rev": 1', '"rev": 7'))

      expect(() => new SecretsBackend(join(dir, 'secrets.json')).tryReadProvidersSync()).toThrow(
        /no readable secrets entry/,
      )
      expect((await reconcileTypevault(dir, false)).action).toBe('skipped')
      expect(isTypevaultMarker(secretsText(dir))).toBe(true)
    },
  )

  test('an invalid secrets.json is not migrated', async () => {
    const dir = await agentWith('{"version":1}')

    const result = await reconcileTypevault(dir, true)

    expect(result.action).toBe('skipped')
    expect(secretsText(dir)).toBe('{"version":1}')
  })

  test('disabling an agent that never enabled the vault changes nothing', async () => {
    const dir = await agentWith(ORIGINAL)

    expect(await reconcileTypevault(dir, false)).toEqual({ action: 'unchanged' })
    expect(secretsText(dir)).toBe(ORIGINAL)
    expect(existsSync(typevaultDir(dir))).toBe(false)
  })
})

test('the marker is rejected by the plain secrets.json parser, so builds without vault support fail loudly', () => {
  expect(parseSecretsFile(JSON.parse(typevaultMarkerText())).ok).toBe(false)
})
