import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { isMultiInstanceAdapter, isUserModeAdapter } from '@/channels/instances'
import { commitSystemFileSync } from '@/git/system-commit'
import { SecretsBackend } from '@/secrets'

const CONFIG_FILE = 'typeclaw.json'
const SECRETS_FILE = 'secrets.json'

export const CHANNEL_KINDS = [
  'slack-bot',
  'slack',
  'discord',
  'discord-bot',
  'telegram-bot',
  'webex',
  'webex-bot',
  'line',
  'kakaotalk',
  'github',
] as const

export type ChannelKind = (typeof CHANNEL_KINDS)[number]

export type ChannelListEntry = {
  kind: ChannelKind
  instanceId?: string
  account?: string
  configured: boolean
  hasSecrets: boolean
  enabled: boolean
  detail?: string
}

export type GithubConfigCleanup = {
  tunnelsRemoved: number
  matchRulesRemoved: string[]
  matchRulesKept: string[]
}

export type RemoveChannelResult =
  | {
      ok: true
      configRemoved: boolean
      secretsRemoved: boolean
      githubCleanup?: GithubConfigCleanup
      hadRemoteWebhooks: boolean
    }
  | { ok: false; reason: string }

export function isChannelKind(value: string): value is ChannelKind {
  return (CHANNEL_KINDS as ReadonlyArray<string>).includes(value)
}

export function listChannels(cwd: string): ChannelListEntry[] {
  const config = readConfigRecordOrEmpty(cwd)
  const configuredChannels = isObjectRecord(config.channels) ? config.channels : {}
  const secrets = channelSecretsOrEmpty(readChannelSecrets(cwd))

  return CHANNEL_KINDS.flatMap((kind) => {
    const channelConfig = configuredChannels[kind]
    const configured = kind in configuredChannels
    const hasSecrets = kind in secrets
    if (isUserModeAdapter(kind) && hasInstanceEntries(channelConfig)) {
      return channelConfig.instances.map((instance) => ({
        kind,
        instanceId: instance.id,
        ...(instance.account !== undefined ? { account: instance.account } : {}),
        configured,
        hasSecrets: hasSecrets && instanceHasSecret(secrets[kind], instance.account),
        enabled: readEnabled(instance),
        ...buildDetail(kind, instance, secrets[kind]),
      }))
    }
    return {
      kind,
      configured,
      hasSecrets,
      enabled: readEnabled(channelConfig),
      ...buildDetail(kind, channelConfig, secrets[kind]),
    }
  }).filter((entry) => entry.configured || entry.hasSecrets)
}

export function removeChannel(cwd: string, kind: ChannelKind, instanceId?: string): RemoveChannelResult {
  const config = readConfigRecord(cwd)
  if (!config.ok) return config

  const channels = isObjectRecord(config.value.channels) ? { ...config.value.channels } : {}

  // Bail BEFORE touching typeclaw.json when secrets.json exists but cannot be
  // read. Otherwise the config write below would strip `channels.<kind>` while
  // the credential block stays on disk yet unreachable — `removeChannelSync`
  // would throw on the same parse error, and the next invocation would no
  // longer see the channel in config OR (the swallowed) secrets, stranding the
  // credentials with no CLI path to clean them. Failing first keeps the retry
  // able to target both once the file is fixed.
  const secretsRead = readChannelSecrets(cwd)
  if (secretsRead.kind === 'unreadable') {
    return {
      ok: false,
      reason: `${SECRETS_FILE} is unreadable (${secretsRead.reason}). Fix it by hand, then retry \`typeclaw channel remove ${kind}\`.`,
    }
  }
  const secrets = channelSecretsOrEmpty(secretsRead)

  const inConfig = kind in channels
  const inSecrets = kind in secrets
  if (!inConfig && !inSecrets) {
    return { ok: false, reason: `Channel "${kind}" is not configured in ${CONFIG_FILE} or ${SECRETS_FILE}.` }
  }

  if (instanceId !== undefined) {
    if (!isMultiInstanceAdapter(kind)) return { ok: false, reason: `Channel "${kind}" does not support instances.` }
    return removeChannelInstance({ cwd, kind, instanceId, config: config.value, channels, secrets })
  }

  const githubRepos = kind === 'github' ? readGithubRepos(channels.github) : []
  const hadRemoteWebhooks = githubRepos.length > 0

  delete channels[kind]
  config.value.channels = channels

  const githubCleanup = kind === 'github' ? cleanGithubConfig(config.value, githubRepos) : undefined

  const write = writeConfig(cwd, config.value, `channel: remove ${kind}`)
  if (!write.ok) return write

  const secretsRemoved = new SecretsBackend(join(cwd, SECRETS_FILE)).removeChannelSync(kind)

  return {
    ok: true,
    configRemoved: inConfig,
    secretsRemoved,
    ...(githubCleanup !== undefined ? { githubCleanup } : {}),
    hadRemoteWebhooks,
  }
}

function removeChannelInstance(options: {
  cwd: string
  kind: ChannelKind
  instanceId: string
  config: Record<string, unknown>
  channels: Record<string, unknown>
  secrets: Record<string, unknown>
}): RemoveChannelResult {
  const existing = options.channels[options.kind]
  if (!hasInstanceEntries(existing)) {
    return { ok: false, reason: `Channel "${options.kind}" is not configured with instances.` }
  }

  const target = existing.instances.find((instance) => instance.id === options.instanceId)
  if (target === undefined) {
    return { ok: false, reason: `Channel "${options.kind}" has no instance "${options.instanceId}".` }
  }

  const remaining = existing.instances.filter((instance) => instance.id !== options.instanceId)
  if (remaining.length === 0) delete options.channels[options.kind]
  else options.channels[options.kind] = { ...existing, instances: remaining }
  options.config.channels = options.channels

  const write = writeConfig(options.cwd, options.config, `channel: remove ${options.kind}:${options.instanceId}`)
  if (!write.ok) return write

  const secretsRemoved = removeInstanceSecretAccount(options.cwd, options.kind, target.account)
  return {
    ok: true,
    configRemoved: true,
    secretsRemoved,
    hadRemoteWebhooks: false,
  }
}

function removeInstanceSecretAccount(cwd: string, kind: ChannelKind, account: string | undefined): boolean {
  if (account === undefined) return false
  const backend = new SecretsBackend(join(cwd, SECRETS_FILE))
  const channels = backend.tryReadChannelsSync()
  if (channels === null) return false
  const block = channels[kind]
  if (!isObjectRecord(block) || !isObjectRecord(block.accounts) || !(account in block.accounts)) return false
  const accounts = { ...block.accounts }
  delete accounts[account]
  const currentAccount = block.currentAccount === account ? (Object.keys(accounts)[0] ?? null) : block.currentAccount
  backend.writeChannelsSync({ ...channels, [kind]: { ...block, currentAccount, accounts } })
  return true
}

// GitHub `add` writes three config artifacts beyond `channels.github`: a
// `tunnels[]` entry marked `for: { kind: 'channel', name: 'github' }`,
// `roles.member.match[]` rules `github:<owner>/<repo>`, and the
// `docker.file.cloudflared` enablement flag. Removal strips the first two
// (both channel-owned) but intentionally leaves `docker.file.cloudflared`: it
// is a shared enablement flag a remaining tunnel may still need. Match-rule
// stripping is scoped to the configured repos so hand-authored `github:`
// identities survive.
function cleanGithubConfig(config: Record<string, unknown>, repos: string[]): GithubConfigCleanup {
  const tunnelsRemoved = removeGithubTunnels(config)
  const { removed, kept } = removeGithubMatchRules(config, repos)
  return { tunnelsRemoved, matchRulesRemoved: removed, matchRulesKept: kept }
}

function removeGithubTunnels(config: Record<string, unknown>): number {
  if (!Array.isArray(config.tunnels)) return 0
  const before = config.tunnels.length
  config.tunnels = config.tunnels.filter((entry) => !isGithubChannelTunnel(entry))
  return before - (config.tunnels as unknown[]).length
}

function isGithubChannelTunnel(entry: unknown): boolean {
  if (!isObjectRecord(entry)) return false
  const target = entry.for
  if (!isObjectRecord(target)) return false
  return target.kind === 'channel' && target.name === 'github'
}

function readGithubRepos(githubConfig: unknown): string[] {
  if (!isObjectRecord(githubConfig) || !Array.isArray(githubConfig.repos)) return []
  return githubConfig.repos.filter((repo): repo is string => typeof repo === 'string')
}

function removeGithubMatchRules(
  config: Record<string, unknown>,
  repos: string[],
): { removed: string[]; kept: string[] } {
  const roles = isObjectRecord(config.roles) ? { ...config.roles } : undefined
  const member = roles !== undefined && isObjectRecord(roles.member) ? { ...roles.member } : undefined
  if (roles === undefined || member === undefined || !Array.isArray(member.match)) {
    return { removed: [], kept: [] }
  }

  const toRemove = new Set(repos.map((repo) => `github:${repo}`))
  const removed: string[] = []
  const kept: string[] = []
  const next = member.match
    .filter((rule): rule is string => typeof rule === 'string')
    .filter((rule) => {
      if (toRemove.has(rule)) {
        removed.push(rule)
        return false
      }
      if (rule.startsWith('github:')) kept.push(rule)
      return true
    })

  if (removed.length === 0) return { removed: [], kept }

  member.match = next
  roles.member = member
  config.roles = roles
  return { removed, kept }
}

function buildDetail(kind: ChannelKind, channelConfig: unknown, secretsBlock: unknown): { detail?: string } {
  if (kind === 'github') {
    const repos = isObjectRecord(channelConfig) && Array.isArray(channelConfig.repos) ? channelConfig.repos.length : 0
    return { detail: `${repos} repo${repos === 1 ? '' : 's'}` }
  }
  if (isUserModeAdapter(kind)) {
    if (isObjectRecord(channelConfig) && typeof channelConfig.id === 'string') {
      const account = typeof channelConfig.account === 'string' ? channelConfig.account : undefined
      const parts = [`id: ${channelConfig.id}`]
      if (account !== undefined) parts.push(`account: ${account}${accountLabelSuffix(secretsBlock, account)}`)
      return { detail: parts.join(', ') }
    }
    if (!isObjectRecord(secretsBlock)) return {}
    const accounts = isObjectRecord(secretsBlock.accounts) ? Object.keys(secretsBlock.accounts).length : 0
    const current = typeof secretsBlock.currentAccount === 'string' ? secretsBlock.currentAccount : undefined
    const accountLabel = `${accounts} account${accounts === 1 ? '' : 's'}`
    return { detail: current !== undefined ? `${accountLabel} (active: ${current})` : accountLabel }
  }
  return {}
}

function accountLabelSuffix(secretsBlock: unknown, accountId: string): string {
  if (!isObjectRecord(secretsBlock) || !isObjectRecord(secretsBlock.accounts)) return ''
  const account = secretsBlock.accounts[accountId]
  if (!isObjectRecord(account)) return ''
  const label = readAccountLabel(account)
  return label === undefined ? '' : ` (${label})`
}

function readAccountLabel(account: Record<string, unknown>): string | undefined {
  for (const key of ['workspace_name', 'username', 'email', 'account_id', 'user_id']) {
    const value = account[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function instanceHasSecret(secretsBlock: unknown, accountId: string | undefined): boolean {
  if (accountId === undefined) return isObjectRecord(secretsBlock)
  return isObjectRecord(secretsBlock) && isObjectRecord(secretsBlock.accounts) && accountId in secretsBlock.accounts
}

function hasInstanceEntries(value: unknown): value is { instances: Array<{ id: string; account?: string }> } {
  return isObjectRecord(value) && Array.isArray(value.instances) && value.instances.every(isInstanceEntry)
}

function isInstanceEntry(value: unknown): value is { id: string; account?: string } {
  return isObjectRecord(value) && typeof value.id === 'string'
}

function readEnabled(channelConfig: unknown): boolean {
  if (isObjectRecord(channelConfig) && typeof channelConfig.enabled === 'boolean') return channelConfig.enabled
  return true
}

function readConfigRecord(cwd: string): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  try {
    const raw = readFileSync(join(cwd, CONFIG_FILE), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!isObjectRecord(parsed)) return { ok: false, reason: `${CONFIG_FILE} must contain a JSON object.` }
    return { ok: true, value: parsed }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, reason: `${CONFIG_FILE} not found at ${cwd}. Run \`typeclaw init\` first.` }
    }
    return { ok: false, reason: `Failed to read ${CONFIG_FILE}: ${(error as Error).message}` }
  }
}

function readConfigRecordOrEmpty(cwd: string): Record<string, unknown> {
  const result = readConfigRecord(cwd)
  return result.ok ? result.value : {}
}

type ChannelSecretsRead =
  | { kind: 'ok'; channels: Record<string, unknown> }
  | { kind: 'missing' }
  | { kind: 'unreadable'; reason: string }

function readChannelSecrets(cwd: string): ChannelSecretsRead {
  try {
    const channels = new SecretsBackend(join(cwd, SECRETS_FILE)).tryReadChannelsSync()
    if (channels === null) return { kind: 'missing' }
    return { kind: 'ok', channels: channels as Record<string, unknown> }
  } catch (error) {
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) }
  }
}

function channelSecretsOrEmpty(read: ChannelSecretsRead): Record<string, unknown> {
  return read.kind === 'ok' ? read.channels : {}
}

function writeConfig(
  cwd: string,
  record: Record<string, unknown>,
  commitMessage: string,
): { ok: true } | { ok: false; reason: string } {
  try {
    writeFileSync(join(cwd, CONFIG_FILE), `${JSON.stringify(record, null, 2)}\n`)
  } catch (error) {
    return { ok: false, reason: `Failed to write ${CONFIG_FILE}: ${(error as Error).message}` }
  }
  commitSystemFileSync(cwd, CONFIG_FILE, commitMessage)
  return { ok: true }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
