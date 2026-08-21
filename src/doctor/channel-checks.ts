import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { type AdapterId, type ChannelsConfig } from '@/channels'
import { loadConfigSync, validateConfig } from '@/config'
import { readEnvFile } from '@/init'
import { SecretsBackend } from '@/secrets'
import { channelFieldDefaultEnv } from '@/secrets/defaults'

import type { CheckContext, CheckResult, DoctorCheck } from './types'

// Host-stage channel adapter health checks. These cannot talk to Slack /
// Discord / Telegram / KakaoTalk / GitHub APIs — that work belongs to the
// container-stage `start()` preflight on each adapter (see
// `src/channels/manager.ts` and individual adapters). What doctor CAN do
// from the host is verify that the credentials the container will look for
// are actually present and resolvable, so the operator gets a clear,
// before-`typeclaw start` signal instead of a silent skip in the runtime
// logs.
//
// Every check is gated on `ctx.hasAgentFolder` (typeclaw.json is required to
// read the channels config) and additionally on the adapter being declared
// AND enabled in typeclaw.json. A missing or `enabled: false` adapter
// reports `skipped` so the operator can see the check ran without it
// turning into noise on minimal setups.

export function buildChannelChecks(): DoctorCheck[] {
  return [
    slackBotCredentials(),
    discordBotCredentials(),
    telegramBotCredentials(),
    webexBotCredentials(),
    discordUserCredentials(),
    slackUserCredentials(),
    webexUserCredentials(),
    teamsCredentials(),
    instagramCredentials(),
    lineCredentials(),
    kakaotalkCredentials(),
    githubCredentials(),
    githubWebhookDelivery(),
    githubEventAllowlist(),
  ]
}

function slackBotCredentials(): DoctorCheck {
  return {
    name: 'channel.slack-bot.credentials',
    category: 'channels',
    description: 'slack-bot adapter has SLACK_BOT_TOKEN and SLACK_APP_TOKEN',
    applies: (ctx) => ctx.hasAgentFolder,
    run: (ctx) => runTokenAdapterCheck(ctx, 'slack-bot', ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']),
  }
}

function slackUserCredentials(): DoctorCheck {
  return {
    name: 'channel.slack.credentials',
    category: 'channels',
    description: 'slack adapter has a current account with a token in secrets.json',
    applies: (ctx) => ctx.hasAgentFolder,
    async run(ctx) {
      const channels = readDeclaredChannels(ctx)
      if (channels === null) return configInvalidResult()
      if (!isAdapterActive(channels, 'slack')) {
        return { status: 'skipped', message: 'slack not configured' }
      }
      const block = readChannelsSecrets(ctx)?.slack
      if (!hasCurrentAccountTokenField(block, 'token')) {
        return {
          status: 'warning',
          message: 'slack has no current account token in secrets.json',
          details: ['Adapter will start but fail authentication and stay disconnected.'],
          fix: { description: 'Run `typeclaw channel add slack` to log in an account.' },
        }
      }
      return { status: 'ok', message: 'slack has a current account token' }
    },
  }
}

function discordBotCredentials(): DoctorCheck {
  return {
    name: 'channel.discord-bot.credentials',
    category: 'channels',
    description: 'discord-bot adapter has DISCORD_BOT_TOKEN',
    applies: (ctx) => ctx.hasAgentFolder,
    run: (ctx) => runTokenAdapterCheck(ctx, 'discord-bot', ['DISCORD_BOT_TOKEN']),
  }
}

function discordUserCredentials(): DoctorCheck {
  return {
    name: 'channel.discord.credentials',
    category: 'channels',
    description: 'discord adapter has a current account with a token in secrets.json',
    applies: (ctx) => ctx.hasAgentFolder,
    async run(ctx) {
      const channels = readDeclaredChannels(ctx)
      if (channels === null) return configInvalidResult()
      if (!isAdapterActive(channels, 'discord')) {
        return { status: 'skipped', message: 'discord not configured' }
      }
      const block = readChannelsSecrets(ctx)?.discord
      if (!hasCurrentAccountTokenField(block, 'token')) {
        return {
          status: 'warning',
          message: 'discord has no current account token in secrets.json',
          details: ['Adapter will start but fail authentication and stay disconnected.'],
          fix: { description: 'Run `typeclaw channel add discord` to log in an account.' },
        }
      }
      return { status: 'ok', message: 'discord has a current account token' }
    },
  }
}

function telegramBotCredentials(): DoctorCheck {
  return {
    name: 'channel.telegram-bot.credentials',
    category: 'channels',
    description: 'telegram-bot adapter has TELEGRAM_BOT_TOKEN',
    applies: (ctx) => ctx.hasAgentFolder,
    run: (ctx) => runTokenAdapterCheck(ctx, 'telegram-bot', ['TELEGRAM_BOT_TOKEN']),
  }
}

function webexBotCredentials(): DoctorCheck {
  return {
    name: 'channel.webex-bot.credentials',
    category: 'channels',
    description: 'webex-bot adapter has WEBEX_BOT_TOKEN',
    applies: (ctx) => ctx.hasAgentFolder,
    run: (ctx) => runTokenAdapterCheck(ctx, 'webex-bot', ['WEBEX_BOT_TOKEN']),
  }
}

function webexUserCredentials(): DoctorCheck {
  return {
    name: 'channel.webex.credentials',
    category: 'channels',
    description: 'webex adapter has a current account with an access token in secrets.json',
    applies: (ctx) => ctx.hasAgentFolder,
    async run(ctx) {
      const channels = readDeclaredChannels(ctx)
      if (channels === null) return configInvalidResult()
      if (!isAdapterActive(channels, 'webex')) {
        return { status: 'skipped', message: 'webex not configured' }
      }
      const block = readChannelsSecrets(ctx)?.webex
      if (!hasCurrentAccountTokenField(block, 'access_token')) {
        return {
          status: 'warning',
          message: 'webex has no current account access_token in secrets.json',
          details: ['Adapter will start but fail authentication and stay disconnected.'],
          fix: { description: 'Run `typeclaw channel add webex` to log in an account.' },
        }
      }
      return { status: 'ok', message: 'webex has a current account access_token' }
    },
  }
}

function teamsCredentials(): DoctorCheck {
  return {
    name: 'channel.teams.credentials',
    category: 'channels',
    description: 'teams adapter has a current account with an access token in secrets.json',
    applies: (ctx) => ctx.hasAgentFolder,
    async run(ctx) {
      const channels = readDeclaredChannels(ctx)
      if (channels === null) return configInvalidResult()
      if (!isAdapterActive(channels, 'teams')) {
        return { status: 'skipped', message: 'teams not configured' }
      }
      const block = readChannelsSecrets(ctx)?.teams
      if (!hasCurrentAccountTokenField(block, 'access_token')) {
        return {
          status: 'warning',
          message: 'teams has no current account access_token in secrets.json',
          details: ['Adapter will start but fail authentication and stay disconnected.'],
          fix: { description: 'Populate secrets.json#channels.teams manually with an access token to authenticate.' },
        }
      }
      return { status: 'ok', message: 'teams has a current account access_token' }
    },
  }
}

function instagramCredentials(): DoctorCheck {
  return {
    name: 'channel.instagram.credentials',
    category: 'channels',
    description: 'instagram adapter has at least one account in secrets.json',
    applies: (ctx) => ctx.hasAgentFolder,
    async run(ctx) {
      const channels = readDeclaredChannels(ctx)
      if (channels === null) return configInvalidResult()
      if (!isAdapterActive(channels, 'instagram')) {
        return { status: 'skipped', message: 'instagram not configured' }
      }
      const block = readChannelsSecrets(ctx)?.instagram
      const accountCount = block?.accounts ? Object.keys(block.accounts).length : 0
      if (accountCount === 0) {
        return {
          status: 'warning',
          message: 'instagram has no accounts in secrets.json',
          details: ['Adapter will start but fail authentication and stay disconnected.'],
          fix: { description: 'Run `typeclaw channel add instagram` to log in an account.' },
        }
      }
      return { status: 'ok', message: `instagram has ${accountCount} account(s)` }
    },
  }
}

function lineCredentials(): DoctorCheck {
  return {
    name: 'channel.line.credentials',
    category: 'channels',
    description: 'line adapter has at least one account in secrets.json',
    applies: (ctx) => ctx.hasAgentFolder,
    async run(ctx) {
      const channels = readDeclaredChannels(ctx)
      if (channels === null) return configInvalidResult()
      if (!isAdapterActive(channels, 'line')) {
        return { status: 'skipped', message: 'line not configured' }
      }
      const block = readChannelsSecrets(ctx)?.line
      const accountCount = block?.accounts ? Object.keys(block.accounts).length : 0
      if (accountCount === 0) {
        return {
          status: 'warning',
          message: 'line has no accounts in secrets.json',
          details: ['Adapter will start but fail authentication and stay disconnected.'],
          fix: { description: 'Run `typeclaw channel add line` to log in an account.' },
        }
      }
      return { status: 'ok', message: `line has ${accountCount} account(s)` }
    },
  }
}

function kakaotalkCredentials(): DoctorCheck {
  return {
    name: 'channel.kakaotalk.credentials',
    category: 'channels',
    description: 'kakaotalk adapter has at least one account in secrets.json',
    applies: (ctx) => ctx.hasAgentFolder,
    async run(ctx) {
      const channels = readDeclaredChannels(ctx)
      if (channels === null) return configInvalidResult()
      if (!isAdapterActive(channels, 'kakaotalk')) {
        return { status: 'skipped', message: 'kakaotalk not configured' }
      }
      const block = readChannelsSecrets(ctx)?.kakaotalk
      const accountCount = block?.accounts ? Object.keys(block.accounts).length : 0
      if (accountCount === 0) {
        return {
          status: 'warning',
          message: 'kakaotalk has no accounts in secrets.json',
          details: ['Adapter will start but fail authentication and stay disconnected.'],
          fix: { description: 'Run `typeclaw channel add kakaotalk` to log in an account.' },
        }
      }
      return { status: 'ok', message: `kakaotalk has ${accountCount} account(s)` }
    },
  }
}

function githubCredentials(): DoctorCheck {
  return {
    name: 'channel.github.credentials',
    category: 'channels',
    description: 'github adapter has auth and webhookSecret in secrets.json',
    applies: (ctx) => ctx.hasAgentFolder,
    async run(ctx) {
      const channels = readDeclaredChannels(ctx)
      if (channels === null) return configInvalidResult()
      if (!isAdapterActive(channels, 'github')) {
        return { status: 'skipped', message: 'github not configured' }
      }
      const block = readChannelsSecrets(ctx)?.github
      if (!block) {
        return {
          status: 'error',
          message: 'github secrets missing from secrets.json',
          details: ['Adapter requires both `auth` and `webhookSecret`.'],
          fix: { description: 'Run `typeclaw channel set github` to configure GitHub auth.' },
        }
      }
      const dotEnv = safeReadEnvFile(ctx.cwd)
      const details: string[] = []
      const webhookSecret = resolveSecretHostStage(block.webhookSecret, dotEnv)
      if (webhookSecret === undefined || webhookSecret === '') {
        details.push('webhookSecret is unset (resolves to empty string)')
      }
      if (block.auth.type === 'pat') {
        const token = resolveSecretHostStage(block.auth.token, dotEnv)
        if (token === undefined || token === '') {
          details.push('auth.token (PAT) is unset (resolves to empty string)')
        }
      } else {
        const key = resolveSecretHostStage(block.auth.privateKey, dotEnv)
        if (key === undefined || key === '') {
          details.push('auth.privateKey (App) is unset (resolves to empty string)')
        }
      }
      if (details.length > 0) {
        return {
          status: 'error',
          message: 'github credentials present but some fields resolve to empty',
          details,
          fix: { description: 'Run `typeclaw channel set github` to repopulate the missing fields.' },
        }
      }
      return {
        status: 'ok',
        message: `github ${block.auth.type === 'pat' ? 'PAT' : 'App'} auth + webhookSecret resolved`,
      }
    },
  }
}

function githubWebhookDelivery(): DoctorCheck {
  return {
    name: 'channel.github.webhook-delivery',
    category: 'channels',
    description: 'github webhook delivery has a public URL (webhookUrl or tunnel)',
    applies: (ctx) => ctx.hasAgentFolder,
    async run(ctx) {
      const cfg = safeLoadConfig(ctx)
      if (cfg === null) return configInvalidResult()
      const github = cfg.channels.github
      if (github === undefined || github.enabled === false) {
        return { status: 'skipped', message: 'github not configured' }
      }
      const hasWebhookUrl = typeof github.webhookUrl === 'string' && github.webhookUrl.length > 0
      const hasTunnel = cfg.tunnels.some((t) => t.for.kind === 'channel' && t.for.name === 'github')
      if (hasWebhookUrl || hasTunnel) {
        const source = hasWebhookUrl ? 'webhookUrl' : 'tunnel'
        return { status: 'ok', message: `github webhook delivery configured via ${source}` }
      }
      if (github.repos.length === 0) {
        return {
          status: 'info',
          message: 'github has no webhookUrl or tunnel, and no repos to register',
          details: ['Webhooks will not be auto-registered until either webhookUrl or a tunnel binding is set.'],
        }
      }
      return {
        status: 'warning',
        message: `github lists ${github.repos.length} repo(s) but has no public URL to deliver webhooks to`,
        details: [
          'Either set `channels.github.webhookUrl` in typeclaw.json,',
          'or add a `tunnels[]` entry with `for: { kind: "channel", name: "github" }`.',
        ],
        fix: {
          description: 'Configure webhookUrl or a github tunnel; see `typeclaw tunnel add` for managed tunnels.',
        },
      }
    },
  }
}

function githubEventAllowlist(): DoctorCheck {
  return {
    name: 'channel.github.event-allowlist',
    category: 'channels',
    description: 'github eventAllowlist preserves push-triggered review followups',
    applies: (ctx) => ctx.hasAgentFolder,
    async run(ctx) {
      const cfg = safeLoadConfig(ctx)
      if (cfg === null) return configInvalidResult()
      const github = cfg.channels.github
      if (github === undefined || github.enabled === false) {
        return { status: 'skipped', message: 'github not configured' }
      }

      const pinned = readPinnedGithubEventAllowlist(ctx)
      if (pinned === null) {
        return { status: 'ok', message: 'github eventAllowlist tracks the shipped defaults' }
      }
      if (pinned.includes('pull_request.synchronize')) {
        return { status: 'ok', message: 'github pinned eventAllowlist includes pull_request.synchronize' }
      }
      return {
        status: 'warning',
        message: 'github pinned eventAllowlist omits pull_request.synchronize',
        details: [
          'An explicitly pinned array will not inherit future default events.',
          'With this omission, open review threads will never be rechecked on push.',
        ],
        fix: {
          description:
            'Remove channels.github.eventAllowlist to track defaults, or add `pull_request.synchronize` explicitly.',
        },
      }
    },
  }
}

async function runTokenAdapterCheck(
  ctx: CheckContext,
  adapter: Extract<AdapterId, 'slack-bot' | 'discord-bot' | 'telegram-bot' | 'webex-bot'>,
  envNames: readonly string[],
): Promise<CheckResult> {
  const channels = readDeclaredChannels(ctx)
  if (channels === null) return configInvalidResult()
  if (!isAdapterActive(channels, adapter)) {
    return { status: 'skipped', message: `${adapter} not configured` }
  }
  const dotEnv = safeReadEnvFile(ctx.cwd)
  const channelSecrets = readChannelsSecrets(ctx)
  const adapterSecrets = (channelSecrets?.[adapter] ?? {}) as Record<string, unknown>
  const missing: string[] = []
  for (const envName of envNames) {
    if (hasTokenForEnv(adapter, envName, dotEnv, adapterSecrets)) continue
    missing.push(envName)
  }
  if (missing.length > 0) {
    return {
      status: 'warning',
      message: `${adapter} missing credentials: ${missing.join(', ')}`,
      details: [
        'Adapter will be skipped at start until credentials are present.',
        'Resolution order: process.env wins over .env file value over secrets.json value.',
      ],
      fix: { description: 'Run `typeclaw channel set ' + adapter + '`, or add the env vars to .env.' },
    }
  }
  return { status: 'ok', message: `${adapter} credentials present` }
}

// hasTokenForEnv resolves a single env-var-style credential the same way the
// runtime does, plus one host-stage-specific source: process.env > .env file >
// secrets.json. Empty strings count as unset, matching `src/secrets/resolve.ts`.
function hasTokenForEnv(
  adapter: AdapterId,
  envName: string,
  dotEnv: Map<string, string>,
  adapterSecrets: Record<string, unknown>,
): boolean {
  const fromProcess = process.env[envName]
  if (fromProcess !== undefined && fromProcess !== '') return true
  const fromDotEnv = dotEnv.get(envName)
  if (fromDotEnv !== undefined && fromDotEnv !== '') return true
  const fieldName = fieldNameForEnv(adapter, envName)
  if (fieldName === undefined) return false
  const secret = adapterSecrets[fieldName]
  if (!isSecretShape(secret)) return false
  const resolved = resolveSecretHostStage(secret, dotEnv, envName)
  return resolved !== undefined && resolved !== ''
}

// resolveSecretHostStage mirrors `resolveSecret` precedence but adds a .env
// lookup before falling through to process.env. Doctor runs on the host and
// never executes the container, so .env values are not in process.env. For
// Secrets bound to a custom env var (e.g. `{ env: 'MY_TOKEN' }`), the runtime
// would resolve via process.env.MY_TOKEN inside the container — on the host
// that yields undefined even when the value is sitting in .env. So look up
// the custom env name in the parsed .env map first.
function resolveSecretHostStage(
  secret: { value?: string; env?: string },
  dotEnv: Map<string, string>,
  defaultEnv?: string,
): string | undefined {
  const envName = secret.env ?? defaultEnv
  if (envName !== undefined) {
    const fromProcess = process.env[envName]
    if (fromProcess !== undefined && fromProcess !== '') return fromProcess
    const fromDotEnv = dotEnv.get(envName)
    if (fromDotEnv !== undefined && fromDotEnv !== '') return fromDotEnv
  }
  return secret.value
}

function fieldNameForEnv(adapter: AdapterId, envName: string): string | undefined {
  // Reverse-lookup using channelFieldDefaultEnv: scan the small set of known
  // fields per adapter for the one whose default env matches. The set is
  // tiny (1-2 entries) so the linear scan is fine.
  const candidates: Record<string, readonly string[]> = {
    'slack-bot': ['botToken', 'appToken'],
    'discord-bot': ['token'],
    'telegram-bot': ['token'],
    'webex-bot': ['token'],
  }
  const fields = candidates[adapter]
  if (!fields) return undefined
  for (const field of fields) {
    if (channelFieldDefaultEnv(adapter, field) === envName) return field
  }
  return undefined
}

function isSecretShape(value: unknown): value is { value?: string; env?: string } {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  const hasValue = typeof obj['value'] === 'string'
  const hasEnv = typeof obj['env'] === 'string'
  return hasValue || hasEnv
}

function hasCurrentAccountTokenField(block: unknown, field: string): boolean {
  if (!isObjectRecord(block)) return false
  const current = (block as { currentAccount?: unknown }).currentAccount
  if (typeof current !== 'string' || current.length === 0) return false
  const accounts = (block as { accounts?: unknown }).accounts
  if (!isObjectRecord(accounts)) return false
  const account = accounts[current]
  if (!isObjectRecord(account)) return false
  const token = account[field]
  return typeof token === 'string' && token.length > 0
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readDeclaredChannels(ctx: CheckContext): ChannelsConfig | null {
  const cfg = safeLoadConfig(ctx)
  return cfg?.channels ?? null
}

function readPinnedGithubEventAllowlist(ctx: CheckContext): string[] | null {
  // The parsed config always contains the schema default, so it cannot tell an
  // operator-pinned array from an omitted key that tracks shipped defaults.
  // Re-read the raw host-stage file to preserve that distinction for this check.
  try {
    const parsed = JSON.parse(readFileSync(join(ctx.cwd, 'typeclaw.json'), 'utf8')) as unknown
    if (!isObjectRecord(parsed)) return null
    const channels = parsed.channels
    if (!isObjectRecord(channels)) return null
    const github = channels.github
    if (!isObjectRecord(github) || !Object.hasOwn(github, 'eventAllowlist')) return null
    const allowlist = github.eventAllowlist
    if (!Array.isArray(allowlist) || !allowlist.every((event): event is string => typeof event === 'string'))
      return null
    return allowlist
  } catch {
    return null
  }
}

function safeLoadConfig(ctx: CheckContext): ReturnType<typeof loadConfigSync> | null {
  const result = validateConfig(ctx.cwd)
  if (!result.ok) return null
  try {
    return loadConfigSync(ctx.cwd)
  } catch {
    return null
  }
}

function safeReadEnvFile(cwd: string): Map<string, string> {
  try {
    return readEnvFile(cwd)
  } catch {
    return new Map()
  }
}

function readChannelsSecrets(ctx: CheckContext): ReturnType<SecretsBackend['tryReadChannelsSync']> {
  try {
    return new SecretsBackend(join(ctx.cwd, 'secrets.json')).tryReadChannelsSync()
  } catch {
    return null
  }
}

function isAdapterActive(channels: ChannelsConfig, adapter: AdapterId): boolean {
  const slot = channels[adapter]
  if (slot === undefined) return false
  return slot.enabled !== false
}

function configInvalidResult(): CheckResult {
  return { status: 'skipped', message: 'config invalid (covered by config.valid)' }
}
