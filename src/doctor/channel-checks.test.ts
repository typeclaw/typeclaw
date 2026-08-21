import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { saveChannelSessions } from '@/channels/persistence'
import { SecretsBackend } from '@/secrets'

import { buildChannelChecks } from './channel-checks'
import type { CheckContext, CheckResult, DoctorCheck } from './types'

const TOKEN_ENV_VARS = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'DISCORD_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN'] as const

function makeTmpAgentDir(channels: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'typeclaw-doctor-channels-'))
  writeFileSync(join(dir, 'typeclaw.json'), JSON.stringify({ channels }), 'utf8')
  return dir
}

function writeDotEnv(dir: string, entries: Record<string, string>): void {
  const body = Object.entries(entries)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
  writeFileSync(join(dir, '.env'), body, 'utf8')
}

function writeChannelsSecrets(dir: string, channels: Record<string, unknown>): void {
  new SecretsBackend(join(dir, 'secrets.json')).writeChannelsSync(channels)
}

function getCheck(name: string): DoctorCheck {
  const check = buildChannelChecks().find((c) => c.name === name)
  if (!check) throw new Error(`check not found: ${name}`)
  return check
}

async function runCheck(name: string, ctx: CheckContext): Promise<CheckResult> {
  const check = getCheck(name)
  if (check.applies && !check.applies(ctx)) return { status: 'skipped', message: 'not applicable' }
  return check.run(ctx)
}

function ctxFor(cwd: string): CheckContext {
  return { cwd, hasAgentFolder: true }
}

describe('buildChannelChecks', () => {
  const savedEnv = new Map<string, string | undefined>()

  beforeEach(() => {
    for (const k of TOKEN_ENV_VARS) {
      savedEnv.set(k, process.env[k])
      delete process.env[k]
    }
  })

  afterEach(() => {
    for (const k of TOKEN_ENV_VARS) {
      const prev = savedEnv.get(k)
      if (prev === undefined) delete process.env[k]
      else process.env[k] = prev
    }
    savedEnv.clear()
  })

  test('returns one check per known adapter plus github webhook delivery', () => {
    const names = buildChannelChecks().map((c) => c.name)
    expect(names).toEqual([
      'channel.slack-bot.credentials',
      'channel.discord-bot.credentials',
      'channel.telegram-bot.credentials',
      'channel.webex-bot.credentials',
      'channel.discord.credentials',
      'channel.slack.credentials',
      'channel.webex.credentials',
      'channel.teams.credentials',
      'channel.instagram.credentials',
      'channel.line.credentials',
      'channel.kakaotalk.credentials',
      'channel.github.credentials',
      'channel.github.webhook-delivery',
      'channel.github.event-allowlist',
      'channel.github.review-round',
    ])
  })

  test('every check is gated on hasAgentFolder', () => {
    const checks = buildChannelChecks()
    for (const check of checks) {
      expect(check.applies).toBeDefined()
      expect(check.applies?.({ cwd: '/nope', hasAgentFolder: false })).toBe(false)
    }
  })

  describe('token-based adapters', () => {
    test('skips when adapter is not declared in typeclaw.json', async () => {
      const cwd = makeTmpAgentDir({})
      const result = await runCheck('channel.slack-bot.credentials', ctxFor(cwd))
      expect(result.status).toBe('skipped')
    })

    test('skips when adapter is declared but disabled', async () => {
      const cwd = makeTmpAgentDir({ 'slack-bot': { enabled: false } })
      const result = await runCheck('channel.slack-bot.credentials', ctxFor(cwd))
      expect(result.status).toBe('skipped')
    })

    test('slack-bot warns when both tokens are missing', async () => {
      const cwd = makeTmpAgentDir({ 'slack-bot': {} })
      const result = await runCheck('channel.slack-bot.credentials', ctxFor(cwd))
      expect(result.status).toBe('warning')
      expect(result.message).toContain('SLACK_BOT_TOKEN')
      expect(result.message).toContain('SLACK_APP_TOKEN')
      expect(result.fix?.description).toContain('slack-bot')
    })

    test('slack-bot warns when only one token is present', async () => {
      const cwd = makeTmpAgentDir({ 'slack-bot': {} })
      writeDotEnv(cwd, { SLACK_BOT_TOKEN: 'xoxb-1' })
      const result = await runCheck('channel.slack-bot.credentials', ctxFor(cwd))
      expect(result.status).toBe('warning')
      expect(result.message).toContain('SLACK_APP_TOKEN')
      expect(result.message).not.toContain('SLACK_BOT_TOKEN')
    })

    test('slack-bot passes when both tokens come from .env', async () => {
      const cwd = makeTmpAgentDir({ 'slack-bot': {} })
      writeDotEnv(cwd, { SLACK_BOT_TOKEN: 'xoxb-1', SLACK_APP_TOKEN: 'xapp-1' })
      const result = await runCheck('channel.slack-bot.credentials', ctxFor(cwd))
      expect(result.status).toBe('ok')
    })

    test('slack-bot passes when both tokens come from process.env (override path)', async () => {
      const cwd = makeTmpAgentDir({ 'slack-bot': {} })
      process.env.SLACK_BOT_TOKEN = 'xoxb-shell'
      process.env.SLACK_APP_TOKEN = 'xapp-shell'
      const result = await runCheck('channel.slack-bot.credentials', ctxFor(cwd))
      expect(result.status).toBe('ok')
    })

    test('slack-bot passes when tokens live in secrets.json fields', async () => {
      const cwd = makeTmpAgentDir({ 'slack-bot': {} })
      writeChannelsSecrets(cwd, {
        'slack-bot': {
          botToken: { value: 'xoxb-from-secrets' },
          appToken: { value: 'xapp-from-secrets' },
        },
      })
      const result = await runCheck('channel.slack-bot.credentials', ctxFor(cwd))
      expect(result.status).toBe('ok')
    })

    test('discord-bot warns when DISCORD_BOT_TOKEN is missing', async () => {
      const cwd = makeTmpAgentDir({ 'discord-bot': {} })
      const result = await runCheck('channel.discord-bot.credentials', ctxFor(cwd))
      expect(result.status).toBe('warning')
      expect(result.message).toContain('DISCORD_BOT_TOKEN')
    })

    test('discord-bot passes when token lives in secrets.json', async () => {
      const cwd = makeTmpAgentDir({ 'discord-bot': {} })
      writeChannelsSecrets(cwd, { 'discord-bot': { token: { value: 'd-tok' } } })
      const result = await runCheck('channel.discord-bot.credentials', ctxFor(cwd))
      expect(result.status).toBe('ok')
    })

    test('telegram-bot warns when TELEGRAM_BOT_TOKEN is missing', async () => {
      const cwd = makeTmpAgentDir({ 'telegram-bot': {} })
      const result = await runCheck('channel.telegram-bot.credentials', ctxFor(cwd))
      expect(result.status).toBe('warning')
      expect(result.message).toContain('TELEGRAM_BOT_TOKEN')
    })

    test('webex-bot warns when WEBEX_BOT_TOKEN is missing', async () => {
      const cwd = makeTmpAgentDir({ 'webex-bot': {} })
      const result = await runCheck('channel.webex-bot.credentials', ctxFor(cwd))
      expect(result.status).toBe('warning')
      expect(result.message).toContain('WEBEX_BOT_TOKEN')
    })

    test('webex-bot passes when token lives in secrets.json', async () => {
      const cwd = makeTmpAgentDir({ 'webex-bot': {} })
      writeChannelsSecrets(cwd, { 'webex-bot': { token: { value: 'webex-tok' } } })
      const result = await runCheck('channel.webex-bot.credentials', ctxFor(cwd))
      expect(result.status).toBe('ok')
    })

    test('process.env wins over empty .env entry', async () => {
      const cwd = makeTmpAgentDir({ 'discord-bot': {} })
      writeDotEnv(cwd, { DISCORD_BOT_TOKEN: '' })
      process.env.DISCORD_BOT_TOKEN = 'real-token'
      const result = await runCheck('channel.discord-bot.credentials', ctxFor(cwd))
      expect(result.status).toBe('ok')
    })

    test('empty string in .env counts as missing', async () => {
      const cwd = makeTmpAgentDir({ 'discord-bot': {} })
      writeDotEnv(cwd, { DISCORD_BOT_TOKEN: '' })
      const result = await runCheck('channel.discord-bot.credentials', ctxFor(cwd))
      expect(result.status).toBe('warning')
    })

    test('discord-bot passes when secrets.json custom env binding resolves via .env', async () => {
      const cwd = makeTmpAgentDir({ 'discord-bot': {} })
      writeChannelsSecrets(cwd, { 'discord-bot': { token: { env: 'MY_DISCORD_TOKEN' } } })
      writeDotEnv(cwd, { MY_DISCORD_TOKEN: 'd-tok-from-dotenv' })
      const result = await runCheck('channel.discord-bot.credentials', ctxFor(cwd))
      expect(result.status).toBe('ok')
    })

    test('discord-bot warns when custom env binding has no value anywhere', async () => {
      const cwd = makeTmpAgentDir({ 'discord-bot': {} })
      writeChannelsSecrets(cwd, { 'discord-bot': { token: { env: 'MY_DISCORD_TOKEN' } } })
      const result = await runCheck('channel.discord-bot.credentials', ctxFor(cwd))
      expect(result.status).toBe('warning')
    })
  })

  describe('line', () => {
    test('skips when not configured', async () => {
      const cwd = makeTmpAgentDir({})
      const result = await runCheck('channel.line.credentials', ctxFor(cwd))
      expect(result.status).toBe('skipped')
    })

    test('warns when configured but secrets.json has no accounts', async () => {
      const cwd = makeTmpAgentDir({ line: {} })
      const result = await runCheck('channel.line.credentials', ctxFor(cwd))
      expect(result.status).toBe('warning')
      expect(result.message).toMatch(/no accounts/)
      expect(result.fix?.description).toContain('channel add line')
    })

    test('passes when at least one account exists', async () => {
      const cwd = makeTmpAgentDir({ line: {} })
      writeChannelsSecrets(cwd, {
        line: {
          currentAccount: 'a',
          accounts: {
            a: {
              account_id: 'a',
              auth_token: 't',
              device: 'DESKTOPMAC',
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
            },
          },
        },
      })
      const result = await runCheck('channel.line.credentials', ctxFor(cwd))
      expect(result.status).toBe('ok')
      expect(result.message).toContain('1 account')
    })
  })

  describe('kakaotalk', () => {
    test('skips when not configured', async () => {
      const cwd = makeTmpAgentDir({})
      const result = await runCheck('channel.kakaotalk.credentials', ctxFor(cwd))
      expect(result.status).toBe('skipped')
    })

    test('warns when configured but secrets.json has no accounts', async () => {
      const cwd = makeTmpAgentDir({ kakaotalk: {} })
      const result = await runCheck('channel.kakaotalk.credentials', ctxFor(cwd))
      expect(result.status).toBe('warning')
      expect(result.message).toMatch(/no accounts/)
      expect(result.fix?.description).toContain('channel add kakaotalk')
    })

    test('passes when at least one account exists', async () => {
      const cwd = makeTmpAgentDir({ kakaotalk: {} })
      writeChannelsSecrets(cwd, {
        kakaotalk: {
          currentAccount: 'a',
          accounts: {
            a: {
              account_id: 'a',
              oauth_token: 't',
              user_id: 'u',
              device_uuid: 'd',
              device_type: 'pc',
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
            },
          },
        },
      })
      const result = await runCheck('channel.kakaotalk.credentials', ctxFor(cwd))
      expect(result.status).toBe('ok')
      expect(result.message).toContain('1 account')
    })
  })

  describe('teams', () => {
    test('skips when not configured', async () => {
      const cwd = makeTmpAgentDir({})
      const result = await runCheck('channel.teams.credentials', ctxFor(cwd))
      expect(result.status).toBe('skipped')
    })

    test('warns when configured but current account has no access_token', async () => {
      const cwd = makeTmpAgentDir({ teams: {} })
      const result = await runCheck('channel.teams.credentials', ctxFor(cwd))
      expect(result.status).toBe('warning')
      expect(result.message).toMatch(/no current account access_token/)
      expect(result.fix?.description).toContain('secrets.json#channels.teams')
    })

    test('passes when the current account has an access_token', async () => {
      const cwd = makeTmpAgentDir({ teams: {} })
      writeChannelsSecrets(cwd, {
        teams: {
          currentAccount: 'a',
          accounts: {
            a: {
              account_id: 'a',
              access_token: 't',
              account_type: 'work',
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
            },
          },
        },
      })
      const result = await runCheck('channel.teams.credentials', ctxFor(cwd))
      expect(result.status).toBe('ok')
      expect(result.message).toContain('access_token')
    })
  })

  describe('github credentials', () => {
    test('skips when not configured', async () => {
      const cwd = makeTmpAgentDir({})
      const result = await runCheck('channel.github.credentials', ctxFor(cwd))
      expect(result.status).toBe('skipped')
    })

    test('errors when github is configured but no secrets block exists', async () => {
      const cwd = makeTmpAgentDir({ github: { webhookUrl: 'https://example.com/hook' } })
      const result = await runCheck('channel.github.credentials', ctxFor(cwd))
      expect(result.status).toBe('error')
      expect(result.message).toMatch(/missing/)
    })

    test('passes with PAT auth and webhookSecret', async () => {
      const cwd = makeTmpAgentDir({ github: { webhookUrl: 'https://example.com/hook' } })
      writeChannelsSecrets(cwd, {
        github: {
          auth: { type: 'pat', token: { value: 'ghp_xxx' } },
          webhookSecret: { value: 'wh-secret' },
        },
      })
      const result = await runCheck('channel.github.credentials', ctxFor(cwd))
      expect(result.status).toBe('ok')
      expect(result.message).toContain('PAT')
    })

    test('passes when PAT token env binding resolves via .env', async () => {
      const cwd = makeTmpAgentDir({ github: { webhookUrl: 'https://example.com/hook' } })
      writeChannelsSecrets(cwd, {
        github: {
          auth: { type: 'pat', token: { env: 'MY_GH_TOKEN' } },
          webhookSecret: { value: 'wh-secret' },
        },
      })
      writeDotEnv(cwd, { MY_GH_TOKEN: 'ghp_from_dotenv' })
      const result = await runCheck('channel.github.credentials', ctxFor(cwd))
      expect(result.status).toBe('ok')
    })

    test('errors when PAT token resolves empty (env binding to unset var)', async () => {
      const cwd = makeTmpAgentDir({ github: { webhookUrl: 'https://example.com/hook' } })
      writeChannelsSecrets(cwd, {
        github: {
          auth: { type: 'pat', token: { env: 'NEVER_SET_GH_TOKEN' } },
          webhookSecret: { value: 'wh-secret' },
        },
      })
      delete process.env.NEVER_SET_GH_TOKEN
      const result = await runCheck('channel.github.credentials', ctxFor(cwd))
      expect(result.status).toBe('error')
      expect(result.details?.some((d) => d.includes('auth.token'))).toBe(true)
    })

    test('passes with App auth', async () => {
      const cwd = makeTmpAgentDir({ github: { webhookUrl: 'https://example.com/hook' } })
      writeChannelsSecrets(cwd, {
        github: {
          auth: { type: 'app', appId: 123, privateKey: { value: '-----BEGIN-----' } },
          webhookSecret: { value: 'wh-secret' },
        },
      })
      const result = await runCheck('channel.github.credentials', ctxFor(cwd))
      expect(result.status).toBe('ok')
      expect(result.message).toContain('App')
    })
  })

  describe('github webhook delivery', () => {
    test('skips when github not configured', async () => {
      const cwd = makeTmpAgentDir({})
      const result = await runCheck('channel.github.webhook-delivery', ctxFor(cwd))
      expect(result.status).toBe('skipped')
    })

    test('ok when webhookUrl is set', async () => {
      const cwd = makeTmpAgentDir({ github: { webhookUrl: 'https://example.com/hook' } })
      const result = await runCheck('channel.github.webhook-delivery', ctxFor(cwd))
      expect(result.status).toBe('ok')
      expect(result.message).toContain('webhookUrl')
    })

    test('ok when a tunnel binding exists', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'typeclaw-doctor-channels-'))
      writeFileSync(
        join(cwd, 'typeclaw.json'),
        JSON.stringify({
          channels: { github: { repos: ['org/repo'] } },
          tunnels: [
            {
              name: 'gh',
              provider: 'cloudflare-quick',
              for: { kind: 'channel', name: 'github' },
              upstreamPort: 8975,
            },
          ],
        }),
        'utf8',
      )
      const result = await runCheck('channel.github.webhook-delivery', ctxFor(cwd))
      expect(result.status).toBe('ok')
      expect(result.message).toContain('tunnel')
    })

    test('warning when repos are listed but no URL or tunnel', async () => {
      const cwd = makeTmpAgentDir({ github: { repos: ['org/repo'] } })
      const result = await runCheck('channel.github.webhook-delivery', ctxFor(cwd))
      expect(result.status).toBe('warning')
      expect(result.message).toContain('no public URL')
    })

    test('info when no repos and no URL (not yet wired)', async () => {
      const cwd = makeTmpAgentDir({ github: {} })
      const result = await runCheck('channel.github.webhook-delivery', ctxFor(cwd))
      expect(result.status).toBe('info')
    })
  })

  describe('github event allowlist', () => {
    test('warns when a pinned allowlist omits pull_request.synchronize', async () => {
      const cwd = makeTmpAgentDir({ github: { eventAllowlist: ['issues.opened'] } })

      const result = await runCheck('channel.github.event-allowlist', ctxFor(cwd))

      expect(result.status).toBe('warning')
      expect(result.message).toContain('pull_request.synchronize')
      expect(result.details?.join(' ')).toContain('future default events')
      expect(result.details?.join(' ')).toContain('open review threads will never be rechecked on push')
    })

    test('does not warn when eventAllowlist is absent and tracks defaults', async () => {
      const cwd = makeTmpAgentDir({ github: {} })

      const result = await runCheck('channel.github.event-allowlist', ctxFor(cwd))

      expect(result.status).toBe('ok')
      expect(result.message).toContain('tracks the shipped defaults')
    })

    test('does not warn when a pinned allowlist includes pull_request.synchronize', async () => {
      const cwd = makeTmpAgentDir({
        github: { eventAllowlist: ['issues.opened', 'pull_request.synchronize'] },
      })

      const result = await runCheck('channel.github.event-allowlist', ctxFor(cwd))

      expect(result.status).toBe('ok')
    })
  })

  describe('github review round', () => {
    test('is ok when no review follow-up round is pending', async () => {
      const cwd = makeTmpAgentDir({ github: {} })

      const result = await runCheck('channel.github.review-round', ctxFor(cwd))

      expect(result.status).toBe('ok')
      expect(result.message).toContain('no pending')
    })

    test('warns with PR identity, age, and recovery when a round remains pending', async () => {
      const cwd = makeTmpAgentDir({ github: {} })
      await saveChannelSessions(cwd, [
        {
          adapter: 'github',
          workspace: 'acme/widgets',
          chat: 'pr:17',
          thread: '101',
          participants: [],
          githubReviewRound: {
            workspace: 'acme/widgets',
            prNumber: 17,
            headSha: 'sha-round',
            carrierThread: '101',
            status: 'pending',
            createdAt: Date.now() - 31 * 60_000,
            attemptedCarriers: ['101'],
          },
        },
      ])

      const result = await runCheck('channel.github.review-round', ctxFor(cwd))

      expect(result.status).toBe('warning')
      expect(result.details?.join(' ')).toContain('acme/widgets#17')
      expect(result.details?.join(' ')).toContain('age=31m')
      expect(result.fix?.description).toContain('retry after')
      expect(result.fix?.description).toContain('restart')
    })
  })
})
