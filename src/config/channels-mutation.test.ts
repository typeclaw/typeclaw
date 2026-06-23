import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listChannels, removeChannel } from './channels-mutation'

const SECRETS_HEADER = { $schema: './node_modules/typeclaw/secrets.schema.json', version: 2 as const }

describe('channels mutation', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'typeclaw-channels-'))
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  async function writeConfig(value: Record<string, unknown>): Promise<void> {
    await writeFile(join(cwd, 'typeclaw.json'), `${JSON.stringify(value, null, 2)}\n`)
  }

  async function writeSecrets(channels: Record<string, unknown>): Promise<void> {
    await writeFile(
      join(cwd, 'secrets.json'),
      `${JSON.stringify({ ...SECRETS_HEADER, providers: {}, channels }, null, 2)}\n`,
    )
  }

  async function readConfig(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(join(cwd, 'typeclaw.json'), 'utf8')) as Record<string, unknown>
  }

  async function readSecretsChannels(): Promise<Record<string, unknown>> {
    const raw = JSON.parse(await readFile(join(cwd, 'secrets.json'), 'utf8')) as { channels: Record<string, unknown> }
    return raw.channels
  }

  describe('listChannels', () => {
    test('reports only channels present in config or secrets', async () => {
      await writeConfig({ channels: { 'discord-bot': {}, github: { repos: ['a/b', 'c/d'] } } })
      await writeSecrets({
        'discord-bot': { token: { value: 't' } },
        github: { auth: { type: 'pat', token: { value: 'p' } }, webhookSecret: { value: 's' } },
      })

      const list = listChannels(cwd)

      expect(list.map((c) => c.kind).sort()).toEqual(['discord-bot', 'github'])
    })

    test('flags a configured channel missing its secrets', async () => {
      await writeConfig({ channels: { 'telegram-bot': {} } })
      await writeSecrets({})

      const [entry] = listChannels(cwd)

      expect(entry).toMatchObject({ kind: 'telegram-bot', configured: true, hasSecrets: false })
    })

    test('surfaces secrets-only drift (secrets present, config absent)', async () => {
      await writeConfig({ channels: {} })
      await writeSecrets({ 'slack-bot': { botToken: { value: 'b' }, appToken: { value: 'a' } } })

      const [entry] = listChannels(cwd)

      expect(entry).toMatchObject({ kind: 'slack-bot', configured: false, hasSecrets: true })
    })

    test('reports enabled=false when the channel is disabled in config', async () => {
      await writeConfig({ channels: { 'discord-bot': { enabled: false } } })
      await writeSecrets({ 'discord-bot': { token: { value: 't' } } })

      const list = listChannels(cwd)

      expect(list).toHaveLength(1)
      expect(list[0]?.enabled).toBe(false)
    })

    test('returns an empty list when nothing is configured', async () => {
      await writeConfig({ channels: {} })

      expect(listChannels(cwd)).toEqual([])
    })

    test('includes a repo-count detail for github', async () => {
      await writeConfig({ channels: { github: { repos: ['a/b'] } } })
      await writeSecrets({ github: { auth: { type: 'pat', token: { value: 'p' } }, webhookSecret: { value: 's' } } })

      const list = listChannels(cwd)

      expect(list).toHaveLength(1)
      expect(list[0]?.detail).toBe('1 repo')
    })

    test('lists each configured user-mode instance with its account label', async () => {
      await writeConfig({
        channels: {
          slack: {
            instances: [
              { id: 'acme', account: 'T1' },
              { id: 'personal', account: 'T2' },
            ],
          },
        },
      })
      await writeSecrets({
        slack: {
          currentAccount: 'T2',
          accounts: {
            T1: slackAccount('T1', 'Acme'),
            T2: slackAccount('T2', 'Personal'),
          },
        },
      })

      const list = listChannels(cwd)

      expect(list).toMatchObject([
        { kind: 'slack', instanceId: 'acme', account: 'T1', detail: 'id: acme, account: T1 (Acme)' },
        { kind: 'slack', instanceId: 'personal', account: 'T2', detail: 'id: personal, account: T2 (Personal)' },
      ])
    })
  })

  describe('removeChannel', () => {
    test('removes a bot adapter from both config and secrets', async () => {
      await writeConfig({ channels: { 'discord-bot': {}, 'telegram-bot': {} } })
      await writeSecrets({ 'discord-bot': { token: { value: 't' } }, 'telegram-bot': { token: { value: 'u' } } })

      const result = removeChannel(cwd, 'discord-bot')

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result).toMatchObject({ configRemoved: true, secretsRemoved: true })
      expect(await readConfig()).toEqual({ channels: { 'telegram-bot': {} } })
      expect(await readSecretsChannels()).toEqual({ 'telegram-bot': { token: { value: 'u' } } })
    })

    test('refuses to remove a channel that is configured nowhere', async () => {
      await writeConfig({ channels: { 'discord-bot': {} } })
      await writeSecrets({ 'discord-bot': { token: { value: 't' } } })

      const result = removeChannel(cwd, 'slack-bot')

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toContain('not configured')
    })

    test('removes a secrets-only channel even when absent from config', async () => {
      await writeConfig({ channels: {} })
      await writeSecrets({ 'slack-bot': { botToken: { value: 'b' }, appToken: { value: 'a' } } })

      const result = removeChannel(cwd, 'slack-bot')

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result).toMatchObject({ configRemoved: false, secretsRemoved: true })
      expect(await readSecretsChannels()).toEqual({})
    })

    test('removes one user-mode instance and its scoped account secret', async () => {
      await writeConfig({
        channels: {
          slack: {
            instances: [
              { id: 'acme', account: 'T1' },
              { id: 'personal', account: 'T2' },
            ],
          },
        },
      })
      await writeSecrets({
        slack: {
          currentAccount: 'T1',
          accounts: {
            T1: slackAccount('T1', 'Acme'),
            T2: slackAccount('T2', 'Personal'),
          },
        },
      })

      const result = removeChannel(cwd, 'slack', 'acme')

      expect(result.ok).toBe(true)
      expect(await readConfig()).toEqual({
        channels: { slack: { instances: [{ id: 'personal', account: 'T2' }] } },
      })
      expect(await readSecretsChannels()).toEqual({
        slack: {
          currentAccount: 'T2',
          accounts: { T2: slackAccount('T2', 'Personal') },
        },
      })
    })

    test('removes the whole user-mode kind when removing its last instance', async () => {
      await writeConfig({ channels: { slack: { instances: [{ id: 'personal', account: 'T2' }] } } })
      await writeSecrets({
        slack: { currentAccount: 'T2', accounts: { T2: slackAccount('T2', 'Personal') } },
      })

      const result = removeChannel(cwd, 'slack', 'personal')

      expect(result.ok).toBe(true)
      expect(await readConfig()).toEqual({ channels: {} })
      expect(await readSecretsChannels()).toEqual({ slack: { currentAccount: null, accounts: {} } })
    })

    test('github removal strips its tunnel and repo-derived match rules but keeps cloudflared and unrelated rules', async () => {
      await writeConfig({
        channels: { github: { webhookPort: 8975, repos: ['acme/app'] } },
        tunnels: [
          { name: 'github-webhook', provider: 'cloudflare-quick', for: { kind: 'channel', name: 'github' } },
          { name: 'devserver', provider: 'cloudflare-quick', for: { kind: 'port', name: '3000' } },
        ],
        docker: { file: { cloudflared: true } },
        roles: { member: { match: ['github:acme/app', 'github:manual/repo', 'slack:U123'] } },
      })
      await writeSecrets({ github: { auth: { type: 'pat', token: { value: 'p' } }, webhookSecret: { value: 's' } } })

      const result = removeChannel(cwd, 'github')

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.githubCleanup).toMatchObject({
        tunnelsRemoved: 1,
        matchRulesRemoved: ['github:acme/app'],
        matchRulesKept: ['github:manual/repo'],
      })
      expect(result.hadRemoteWebhooks).toBe(true)

      const config = await readConfig()
      expect(config.channels).toEqual({})
      expect(config.tunnels).toEqual([
        { name: 'devserver', provider: 'cloudflare-quick', for: { kind: 'port', name: '3000' } },
      ])
      expect(config.docker).toEqual({ file: { cloudflared: true } })
      expect((config.roles as { member: { match: string[] } }).member.match).toEqual([
        'github:manual/repo',
        'slack:U123',
      ])
    })

    test('github removal with no repos leaves match rules untouched and reports no remote webhooks', async () => {
      await writeConfig({
        channels: { github: { webhookPort: 8975, repos: [] } },
        roles: { member: { match: ['github:manual/repo'] } },
      })
      await writeSecrets({ github: { auth: { type: 'pat', token: { value: 'p' } }, webhookSecret: { value: 's' } } })

      const result = removeChannel(cwd, 'github')

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.hadRemoteWebhooks).toBe(false)
      expect(result.githubCleanup).toMatchObject({
        tunnelsRemoved: 0,
        matchRulesRemoved: [],
        matchRulesKept: ['github:manual/repo'],
      })
      expect((await readConfig()).roles).toEqual({ member: { match: ['github:manual/repo'] } })
    })

    test('is idempotent on secrets when the channel exists only in config', async () => {
      await writeConfig({ channels: { 'discord-bot': {} } })
      await writeSecrets({})

      const result = removeChannel(cwd, 'discord-bot')

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result).toMatchObject({ configRemoved: true, secretsRemoved: false })
    })

    test('refuses without touching typeclaw.json when secrets.json is unreadable', async () => {
      await writeConfig({ channels: { 'discord-bot': {} } })
      await writeFile(join(cwd, 'secrets.json'), '{ this is not valid json')

      const result = removeChannel(cwd, 'discord-bot')

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toContain('unreadable')
      // The channel must survive in config so a retry can still clean both
      // sides once the user fixes secrets.json.
      expect(await readConfig()).toEqual({ channels: { 'discord-bot': {} } })
    })
  })
})

function slackAccount(accountId: string, workspaceName: string): Record<string, string> {
  return {
    account_id: accountId,
    token: `token-${accountId}`,
    cookie: `cookie-${accountId}`,
    workspace_id: accountId,
    workspace_name: workspaceName,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }
}
