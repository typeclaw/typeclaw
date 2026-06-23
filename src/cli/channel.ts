import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { cancel, confirm, intro, isCancel, log, note, password, select, spinner, text } from '@clack/prompts'
import { defineCommand } from 'citty'
import QRCode from 'qrcode'

import { isMultiInstanceAdapter, isUserModeAdapter } from '@/channels/instances'
import { config } from '@/config'
import {
  listChannels,
  removeChannel,
  type ChannelListEntry,
  type GithubConfigCleanup,
} from '@/config/channels-mutation'
import { start, status, stop } from '@/container'
import {
  CHANNEL_KINDS,
  appendOrReplaceEnvKey,
  findAgentDir,
  formatEagerGithubWebhookInstallResult,
  hasEnvKey,
  isInitialized,
  readConfiguredChannels,
  readGithubAuthType,
  runAddChannel,
  setChannelSecrets,
  setGithubSecrets,
  type AddChannelStepEvent,
  type ChannelKind,
  type DiscordAuthResult,
  type GithubCredentialPatch,
  type GithubTunnelProvider,
  type KakaotalkAuthResult,
  type LineAuthResult,
  type SlackAuthResult,
  type WebexAuthResult,
} from '@/init'
import { runDiscordBootstrap } from '@/init/discord-auth'
import { runKakaotalkBootstrap } from '@/init/kakaotalk-auth'
import { runLineBootstrap } from '@/init/line-auth'
import { runSlackBootstrap } from '@/init/slack-auth'
import { runWebexBootstrap } from '@/init/webex-auth'
import { SecretsKakaoCredentialStore } from '@/secrets/kakao-store'
import { SecretsWebexCredentialStore } from '@/secrets/webex-store'

import { CANCEL_SYMBOL, promptPrivateKeyPem } from './prompt-pem'
import { displayQR } from './qr'
import { c, done, errorLine, printDiscordInviteHint, printSlackAppManifestSetup, successLine } from './ui'

const CHANNEL_LABELS: Record<ChannelKind, string> = {
  'slack-bot': 'Slack',
  slack: 'Slack (User)',
  discord: 'Discord (User)',
  'discord-bot': 'Discord',
  'telegram-bot': 'Telegram',
  webex: 'Webex (User)',
  'webex-bot': 'Webex',
  line: 'LINE',
  kakaotalk: 'KakaoTalk',
  github: 'GitHub',
}

const addSub = defineCommand({
  meta: {
    name: 'add',
    description: 'add a new channel adapter to an existing agent (run this from inside the agent folder)',
  },
  args: {
    adapter: {
      type: 'positional',
      description: `which adapter to add (${CHANNEL_KINDS.join(' | ')}); omit to pick interactively`,
      required: false,
    },
    id: {
      type: 'string',
      description: 'instance id for user-mode adapters (required when adding another instance)',
      required: false,
    },
    account: {
      type: 'string',
      description: 'account id to bind to the new user-mode adapter instance',
      required: false,
    },
  },
  async run({ args }) {
    const cwd = findAgentDir(process.cwd()) ?? process.cwd()

    if (!isInitialized(cwd)) {
      console.error(errorLine('TypeClaw config file not found. Run `typeclaw init` first, or cd into an agent folder.'))
      process.exit(1)
    }

    const configured = await readConfiguredChannels(cwd)
    const requested = args.adapter
    const channel = requested === undefined ? await pickChannel(configured) : validateAdapterArg(requested, configured)
    const instanceId = await resolveAddInstanceId({ cwd, channel, configured, requested: args.id })
    const accountId = resolveAddAccountId(channel, args.account)

    intro(`Adding channel: ${CHANNEL_LABELS[channel]}`)

    const lineSpinnerHolder: LineAuthSpinnerHolder = { current: null }
    const credentials = await collectCredentials(channel, cwd, lineSpinnerHolder)

    const events: AddChannelStepEvent[] = []
    try {
      await runAddChannel({
        cwd,
        ...credentials,
        ...(instanceId !== undefined ? { instanceId } : {}),
        ...(accountId !== undefined ? { accountId } : {}),
        onProgress: reportProgress(events, lineSpinnerHolder),
      })
      if (credentials.channel === 'github' && credentials.tunnelProvider === 'none') {
        log.warn(
          'Webhook delivery is disabled until you add a `tunnels[]` entry or set `channels.github.webhookUrl` manually.',
        )
      }
    } catch (error) {
      console.error(errorLine(error instanceof Error ? error.message : String(error)))
      process.exit(1)
    }

    await maybePromptRestart(cwd, channel)
  },
})

// Adapters whose credentials are rotated via the generic `channel set` flow:
// one or more named token fields, no passcode-on-phone, no encryption envelope.
// KakaoTalk is excluded by design — it has its own `channel reauth` flow that
// replays the full interactive login (see REAUTHABLE_ADAPTERS below). GitHub
// is included here but routed through its own prompt path because it has
// three independent secrets (PAT or App private key + webhook secret) and a
// structural auth-type flip is forbidden during rotation.
const SETTABLE_ADAPTERS = ['slack-bot', 'discord-bot', 'telegram-bot', 'webex-bot', 'github'] as const
type SettableAdapter = (typeof SETTABLE_ADAPTERS)[number]

const setSub = defineCommand({
  meta: {
    name: 'set',
    description: 'rotate credentials of an already-configured channel adapter (symmetric with `typeclaw provider set`)',
  },
  args: {
    adapter: {
      type: 'positional',
      description: `which adapter to rotate (${SETTABLE_ADAPTERS.join(' | ')}); omit to pick interactively`,
      required: false,
    },
  },
  async run({ args }) {
    const cwd = findAgentDir(process.cwd()) ?? process.cwd()

    if (!isInitialized(cwd)) {
      console.error(errorLine('TypeClaw config file not found. Run `typeclaw init` first, or cd into an agent folder.'))
      process.exit(1)
    }

    const configured = await readConfiguredChannels(cwd)

    if (args.adapter === 'kakaotalk') {
      console.error(
        errorLine(
          'KakaoTalk uses an interactive auth flow (phone passcode + device_uuid). Use `typeclaw channel reauth kakaotalk` to rotate its credentials.',
        ),
      )
      process.exit(1)
    }

    if (args.adapter === 'line') {
      console.error(
        errorLine(
          'LINE uses an interactive auth flow (QR or email + PIN). Use `typeclaw channel reauth line` to rotate its credentials.',
        ),
      )
      process.exit(1)
    }

    const adapter =
      args.adapter === undefined
        ? await pickSettableAdapter(configured)
        : validateSetAdapterArg(args.adapter, configured)

    intro(`Rotating channel: ${CHANNEL_LABELS[adapter]}`)

    await runSet(cwd, adapter)
  },
})

const REAUTHABLE_ADAPTERS = ['line', 'kakaotalk', 'webex'] as const
type ReauthableAdapter = (typeof REAUTHABLE_ADAPTERS)[number]

const reauthSub = defineCommand({
  meta: {
    name: 'reauth',
    description: `re-authenticate a channel adapter (${REAUTHABLE_ADAPTERS.join(', ')}). Use after a stale-token 401 or to rotate the saved password.`,
  },
  args: {
    adapter: {
      type: 'positional',
      description: `which adapter to re-authenticate (${REAUTHABLE_ADAPTERS.join(' | ')})`,
      required: false,
    },
  },
  async run({ args }) {
    const cwd = findAgentDir(process.cwd()) ?? process.cwd()

    if (!isInitialized(cwd)) {
      console.error(errorLine('TypeClaw config file not found. Run `typeclaw init` first, or cd into an agent folder.'))
      process.exit(1)
    }

    const configured = await readConfiguredChannels(cwd)
    const adapter = await resolveReauthableAdapter(args.adapter, configured)

    intro(`Re-authenticating channel: ${CHANNEL_LABELS[adapter]}`)

    await runReauth(cwd, adapter)
  },
})

const listSub = defineCommand({
  meta: {
    name: 'list',
    description: 'list channel adapters configured for this agent',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'emit channels as JSON',
      default: false,
    },
  },
  async run({ args }) {
    const cwd = findAgentDir(process.cwd()) ?? process.cwd()
    if (!isInitialized(cwd)) {
      console.error(errorLine('TypeClaw config file not found. Run `typeclaw init` first, or cd into an agent folder.'))
      process.exit(1)
    }
    const channels = listChannels(cwd)
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ channels }, null, 2)}\n`)
      return
    }
    process.stdout.write(`${formatChannelList(channels)}\n`)
  },
})

const removeSub = defineCommand({
  meta: {
    name: 'remove',
    description: 'remove a channel adapter from typeclaw.json and secrets.json',
  },
  args: {
    adapter: {
      type: 'positional',
      description: `which adapter to remove (${CHANNEL_KINDS.join(' | ')}); omit to pick interactively`,
      required: false,
    },
    yes: {
      type: 'boolean',
      description: 'skip the confirmation prompt',
      default: false,
    },
    id: {
      type: 'string',
      description: 'remove only this user-mode adapter instance id',
      required: false,
    },
  },
  async run({ args }) {
    const cwd = findAgentDir(process.cwd()) ?? process.cwd()
    if (!isInitialized(cwd)) {
      console.error(errorLine('TypeClaw config file not found. Run `typeclaw init` first, or cd into an agent folder.'))
      process.exit(1)
    }

    const present = presentChannels(listChannels(cwd))
    if (present.length === 0) {
      console.error(errorLine('No channels are configured. Nothing to remove.'))
      process.exit(1)
    }

    const adapter =
      args.adapter === undefined ? await pickChannelToRemove(present) : validateRemoveAdapterArg(args.adapter, present)
    const instanceId = validateRemoveInstanceArg(adapter, args.id)

    if (args.yes !== true) {
      const confirmed = await confirm({
        message:
          instanceId === undefined
            ? `Remove the ${CHANNEL_LABELS[adapter]} channel? This deletes its config and credentials.`
            : `Remove the ${CHANNEL_LABELS[adapter]} instance "${instanceId}"? This deletes its config and credentials.`,
        initialValue: false,
      })
      if (isCancel(confirmed) || !confirmed) {
        cancel('Aborted.')
        process.exit(0)
      }
    }

    const result = removeChannel(cwd, adapter, instanceId)
    if (!result.ok) {
      console.error(errorLine(result.reason))
      process.exit(1)
    }

    process.stdout.write(
      `${successLine(
        instanceId === undefined
          ? `Removed ${CHANNEL_LABELS[adapter]} channel.`
          : `Removed ${CHANNEL_LABELS[adapter]} instance "${instanceId}".`,
      )}\n`,
    )
    if (result.githubCleanup !== undefined) printGithubCleanup(result.githubCleanup)
    if (result.hadRemoteWebhooks) {
      log.warn(
        'GitHub webhooks registered on your repositories were NOT deleted. Remove them by hand at https://github.com/<owner>/<repo>/settings/hooks.',
      )
    }

    await maybePromptRestart(cwd, adapter, 'removed')
  },
})

export const channelCommand = defineCommand({
  meta: {
    name: 'channel',
    description: 'manage channel adapters wired into the agent',
  },
  subCommands: {
    add: addSub,
    set: setSub,
    reauth: reauthSub,
    list: listSub,
    remove: removeSub,
  },
})

function presentChannels(entries: ChannelListEntry[]): ChannelKind[] {
  return [...new Set(entries.map((entry) => entry.kind))]
}

async function pickChannelToRemove(present: ChannelKind[]): Promise<ChannelKind> {
  if (present.length === 1) return present[0]!
  const selected = await select<ChannelKind>({
    message: 'Pick a channel to remove',
    options: present.map((kind) => ({ value: kind, label: CHANNEL_LABELS[kind] })),
    initialValue: present[0],
  })
  if (isCancel(selected)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return selected
}

function validateRemoveAdapterArg(adapter: string, present: ChannelKind[]): ChannelKind {
  if (!isChannelKind(adapter)) {
    console.error(errorLine(`Unknown adapter "${adapter}". Expected one of: ${CHANNEL_KINDS.join(', ')}.`))
    process.exit(1)
  }
  if (!present.includes(adapter)) {
    console.error(
      errorLine(
        `${CHANNEL_LABELS[adapter]} ("${adapter}") is not configured. Run \`typeclaw channel list\` to see what is.`,
      ),
    )
    process.exit(1)
  }
  return adapter
}

function validateRemoveInstanceArg(adapter: ChannelKind, instanceId: string | undefined): string | undefined {
  if (instanceId === undefined) return undefined
  if (isMultiInstanceAdapter(adapter)) return instanceId
  console.error(errorLine(`${CHANNEL_LABELS[adapter]} ("${adapter}") does not support multiple instances; omit --id.`))
  process.exit(1)
}

function formatChannelList(channels: ChannelListEntry[]): string {
  if (channels.length === 0) return c.dim('No channels configured.')

  const kindWidth = Math.max(4, ...channels.map((ch) => displayChannelKind(ch).length))
  const statusWidth = Math.max(6, ...channels.map((ch) => channelStatusText(ch).length))
  const lines: string[] = []
  lines.push(c.dim(`${'KIND'.padEnd(kindWidth)}  ${'STATUS'.padEnd(statusWidth)}  DETAIL`))
  for (const ch of channels) {
    const statusText = channelStatusText(ch)
    const status = channelStatusOk(ch)
      ? c.green(statusText.padEnd(statusWidth))
      : c.yellow(statusText.padEnd(statusWidth))
    const detail = ch.detail ?? ''
    const kind = displayChannelKind(ch)
    lines.push(`${kind.padEnd(kindWidth)}  ${status}  ${c.dim(detail)}`)
  }
  return lines.join('\n')
}

function displayChannelKind(ch: ChannelListEntry): string {
  return ch.instanceId === undefined ? ch.kind : `${ch.kind}:${ch.instanceId}`
}

function channelStatusOk(ch: ChannelListEntry): boolean {
  return ch.configured && ch.hasSecrets && ch.enabled
}

function channelStatusText(ch: ChannelListEntry): string {
  if (!ch.configured) return 'secrets-only'
  if (!ch.hasSecrets) return 'no-secrets'
  if (!ch.enabled) return 'disabled'
  return 'ready'
}

function printGithubCleanup(cleanup: GithubConfigCleanup): void {
  const parts: string[] = []
  if (cleanup.tunnelsRemoved > 0) {
    parts.push(`removed ${cleanup.tunnelsRemoved} GitHub webhook tunnel${cleanup.tunnelsRemoved === 1 ? '' : 's'}`)
  }
  if (cleanup.matchRulesRemoved.length > 0) {
    parts.push(
      `removed ${cleanup.matchRulesRemoved.length} repo match rule${cleanup.matchRulesRemoved.length === 1 ? '' : 's'}`,
    )
  }
  if (parts.length > 0) process.stdout.write(`${c.dim(`Also ${parts.join(', ')}.`)}\n`)
  if (cleanup.matchRulesKept.length > 0) {
    log.warn(
      `Left ${cleanup.matchRulesKept.length} other \`github:\` match rule(s) in roles.member untouched: ${cleanup.matchRulesKept.join(', ')}.`,
    )
  }
}

async function resolveReauthableAdapter(
  requested: string | undefined,
  configured: Set<ChannelKind>,
): Promise<ReauthableAdapter> {
  if (requested !== undefined) {
    if (!isReauthableAdapter(requested)) {
      console.error(
        errorLine(`Adapter "${requested}" does not support reauth. Supported: ${REAUTHABLE_ADAPTERS.join(', ')}.`),
      )
      process.exit(1)
    }
    if (!configured.has(requested)) {
      console.error(
        errorLine(
          `${CHANNEL_LABELS[requested]} ("${requested}") is not configured in typeclaw.json. Run \`typeclaw channel add ${requested}\` first.`,
        ),
      )
      process.exit(1)
    }
    return requested
  }

  const available = REAUTHABLE_ADAPTERS.filter((kind) => configured.has(kind))
  if (available.length === 0) {
    console.error(
      errorLine(
        `No reauth-capable channels are configured. Run \`typeclaw channel add ${REAUTHABLE_ADAPTERS[0]}\` first.`,
      ),
    )
    process.exit(1)
  }
  if (available.length === 1) return available[0]!

  const selected = await select<ReauthableAdapter>({
    message: 'Pick a channel to re-authenticate',
    options: available.map((kind) => ({ value: kind, label: CHANNEL_LABELS[kind] })),
    initialValue: available[0],
  })
  if (isCancel(selected)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return selected
}

function isReauthableAdapter(value: string): value is ReauthableAdapter {
  return (REAUTHABLE_ADAPTERS as ReadonlyArray<string>).includes(value)
}

async function runReauth(cwd: string, adapter: ReauthableAdapter): Promise<void> {
  switch (adapter) {
    case 'line':
      await runLineReauth(cwd)
      return
    case 'kakaotalk':
      await runKakaotalkReauth(cwd)
      return
    case 'webex':
      await runWebexReauth(cwd)
      return
  }
}

async function runLineReauth(cwd: string): Promise<void> {
  const holder: LineAuthSpinnerHolder = { current: null }
  const login = await promptLineLogin(holderSpinnerControl(holder))
  const s = spinner()
  s.start('Logging in to LINE...')
  holder.current = s
  const result = await runLineBootstrap({ ...login, agentDir: cwd })
  holder.current = null
  if (!result.ok) {
    s.stop(`LINE login failed: ${result.reason}`)
    process.exit(1)
  }
  s.stop('LINE credentials refreshed in secrets.json.')

  await maybePromptReauthRefresh(cwd, 'line')
}

async function runKakaotalkReauth(cwd: string): Promise<void> {
  const existingEmail = await readExistingKakaotalkEmail(cwd)
  const creds = await promptKakaotalkCredentials({ defaultEmail: existingEmail })

  const s = spinner()
  s.start('Logging in to KakaoTalk...')
  const result = await runKakaotalkBootstrap({
    email: creds.email,
    password: creds.password,
    agentDir: cwd,
    callbacks: {
      onPasscode: (code) => log.info(`Confirm this passcode on your phone: ${code}`),
    },
  })
  if (!result.ok) {
    s.stop(`KakaoTalk login failed: ${result.reason}`)
    process.exit(1)
  }
  s.stop('KakaoTalk credentials refreshed in secrets.json.')

  await maybePromptReauthRefresh(cwd, 'kakaotalk')
}

async function runWebexReauth(cwd: string): Promise<void> {
  const existingEmail = await readExistingWebexEmail(cwd)
  const creds = await promptWebexCredentials({ defaultEmail: existingEmail })

  const s = spinner()
  s.start('Logging in to Webex...')
  const result = await runWebexBootstrap({ email: creds.email, password: creds.password, agentDir: cwd })
  if (!result.ok) {
    s.stop(`Webex login failed: ${result.reason}`)
    process.exit(1)
  }
  s.stop('Webex credentials refreshed in secrets.json.')

  await maybePromptReauthRefresh(cwd, 'webex')
}

async function readExistingKakaotalkEmail(cwd: string): Promise<string | undefined> {
  try {
    const store = new SecretsKakaoCredentialStore({ mode: 'host', secretsPath: `${cwd}/secrets.json` })
    const account = await store.getAccountWithRenewalFields()
    return account?.email ?? undefined
  } catch {
    // First-time reauth or a brand-new agent dir: no account yet, prompt from scratch.
    return undefined
  }
}

async function readExistingWebexEmail(cwd: string): Promise<string | undefined> {
  try {
    const store = new SecretsWebexCredentialStore({ mode: 'host', secretsPath: `${cwd}/secrets.json` })
    const account = await store.getAccountWithRenewalFields()
    return account?.email ?? undefined
  } catch {
    return undefined
  }
}

// The renewed tokens are already on disk via secrets.json. What still needs
// to happen depends on the running adapter's state:
//   - Container NOT running → nothing to do; next `typeclaw start` picks them up.
//   - Container running, adapter previously 401'd → `typeclaw reload` re-runs
//     startAdapter, which loads the fresh tokens.
//   - Container running, adapter currently live (e.g. proactive rotation) →
//     reload will report `restart-required` because tokens are captured at
//     start time; `typeclaw restart` is needed to actually pick them up.
// We can't reliably distinguish the last two cases from outside the container
// without calling reload first, so the next-step hints surface both paths.
async function maybePromptReauthRefresh(cwd: string, adapter: ReauthableAdapter): Promise<void> {
  await maybePromptCredentialRefresh(cwd, CHANNEL_LABELS[adapter], 're-authenticated')
}

async function maybePromptCredentialRefresh(
  cwd: string,
  label: string,
  verbPast: 're-authenticated' | 'credentials updated',
): Promise<void> {
  const current = await status({ cwd }).catch(() => null)
  if (current === null || current.kind !== 'running') {
    done({
      title: c.green(`${label} ${verbPast}.`),
      hints: [
        { label: 'Start the agent:', command: 'typeclaw start' },
        { label: 'Then check status:', command: 'typeclaw status' },
      ],
    })
    return
  }

  const restartNow = await confirm({
    message:
      'The agent container is running. Restart it now so the adapter picks up the fresh credentials (recommended)?',
    initialValue: true,
  })
  if (isCancel(restartNow) || !restartNow) {
    done({
      title: c.green(`${label} ${verbPast}.`),
      hints: [
        { label: 'Try a live reload first:', command: 'typeclaw reload' },
        { label: 'If reload reports restart-required:', command: 'typeclaw restart' },
      ],
    })
    return
  }

  const stopped = await stop({ cwd })
  if (!stopped.ok) {
    console.error(errorLine(`Restart failed during stop: ${stopped.reason}`))
    process.exit(1)
  }
  const started = await start({ cwd, preferredHostPort: config.port, cliEntry: process.argv[1] })
  if (!started.ok) {
    console.error(errorLine(`Restart failed during start: ${started.reason}`))
    process.exit(1)
  }
  done({
    title: c.green(`${label} ${verbPast}. Restarted ${started.plan.containerName} on host port ${started.hostPort}.`),
    hints: [
      { label: 'Attach TUI:', command: 'typeclaw tui' },
      { label: 'Follow logs:', command: 'typeclaw logs -f' },
    ],
  })
}

function validateAdapterArg(adapter: string, configured: Set<ChannelKind>): ChannelKind {
  if (!isChannelKind(adapter)) {
    console.error(errorLine(`Unknown adapter "${adapter}". Expected one of: ${CHANNEL_KINDS.join(', ')}.`))
    process.exit(1)
  }
  if (configured.has(adapter) && !isMultiInstanceAdapter(adapter)) {
    console.error(
      errorLine(
        `${CHANNEL_LABELS[adapter]} ("${adapter}") is already configured in typeclaw.json. Edit the file directly to change its configuration.`,
      ),
    )
    process.exit(1)
  }
  return adapter
}

function isChannelKind(value: string): value is ChannelKind {
  return (CHANNEL_KINDS as ReadonlyArray<string>).includes(value)
}

async function pickChannel(configured: Set<ChannelKind>): Promise<ChannelKind> {
  const available = addableChannelKinds(configured)
  if (available.length === 0) {
    console.error(errorLine('All supported channel adapters are already configured in typeclaw.json. Nothing to add.'))
    process.exit(0)
  }

  type FamilyValue = 'webex-family' | 'slack-family' | 'discord-family'
  type FlatKind = Exclude<ChannelKind, 'webex' | 'webex-bot' | 'slack' | 'slack-bot' | 'discord' | 'discord-bot'>
  type PickerValue = FlatKind | FamilyValue
  const options: Array<{ value: PickerValue; label: string }> = []
  for (const kind of available) {
    const family = FAMILY_OF[kind]
    if (family !== undefined) {
      if (!options.some((option) => option.value === family.value))
        options.push({ value: family.value, label: family.label })
      continue
    }
    options.push({ value: kind as FlatKind, label: CHANNEL_LABELS[kind] })
  }

  const selected = await select<PickerValue>({
    message: 'Pick a channel to add',
    options,
    initialValue: options[0]?.value,
  })
  if (isCancel(selected)) {
    cancel('Aborted.')
    process.exit(0)
  }
  if (selected === 'webex-family') return pickWebexMode(available)
  if (selected === 'slack-family') return pickSlackMode(available)
  if (selected === 'discord-family') return pickDiscordMode(available)
  return selected
}

export function addableChannelKinds(configured: ReadonlySet<ChannelKind>): ChannelKind[] {
  return CHANNEL_KINDS.filter((kind) => isMultiInstanceAdapter(kind) || !configured.has(kind))
}

async function resolveAddInstanceId(options: {
  cwd: string
  channel: ChannelKind
  configured: Set<ChannelKind>
  requested: string | undefined
}): Promise<string | undefined> {
  if (!isMultiInstanceAdapter(options.channel)) {
    const error = singleInstanceArgError(options.channel, options.requested, undefined)
    if (error !== undefined) {
      console.error(errorLine(error))
      process.exit(1)
    }
    return undefined
  }

  const existingIds = readConfiguredInstanceIds(options.cwd, options.channel)
  if (options.requested !== undefined) {
    validateInstanceId(options.requested, existingIds)
    return options.requested
  }
  if (!options.configured.has(options.channel)) return undefined

  const entered = await text({
    message: `Add another ${CHANNEL_LABELS[options.channel]} workspace? Enter an id for the new instance:`,
    validate: (value) => validateInstanceIdInput(value ?? '', existingIds),
  })
  if (isCancel(entered)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return entered
}

function resolveAddAccountId(channel: ChannelKind, account: string | undefined): string | undefined {
  if (account === undefined) return undefined
  if (isMultiInstanceAdapter(channel)) return account
  console.error(errorLine(singleInstanceArgError(channel, undefined, account) ?? 'Invalid account argument'))
  process.exit(1)
}

export function singleInstanceArgError(
  channel: ChannelKind,
  id: string | undefined,
  account: string | undefined,
): string | undefined {
  if (isMultiInstanceAdapter(channel)) return undefined
  if (id !== undefined) return `${CHANNEL_LABELS[channel]} ("${channel}") is single-instance; omit --id.`
  if (account !== undefined) return `${CHANNEL_LABELS[channel]} ("${channel}") is single-instance; omit --account.`
  return undefined
}

function validateInstanceId(id: string, existingIds: ReadonlySet<string>): void {
  const error = validateInstanceIdInput(id, existingIds)
  if (error !== undefined) {
    console.error(errorLine(error))
    process.exit(1)
  }
}

function validateInstanceIdInput(id: string, existingIds: ReadonlySet<string>): string | undefined {
  if (id.trim().length === 0) return 'Instance id is required'
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return 'Instance id may contain only letters, numbers, _ and -'
  if (existingIds.has(id)) return `Instance id "${id}" is already configured for this adapter`
  return undefined
}

function readConfiguredInstanceIds(cwd: string, channel: ChannelKind): Set<string> {
  const config = readTypeclawConfig(cwd)
  const channels = isRecord(config.channels) ? config.channels : {}
  const channelConfig = channels[channel]
  if (!isUserModeAdapter(channel) || channelConfig === undefined) return new Set()
  if (isRecord(channelConfig) && Array.isArray(channelConfig.instances)) {
    return new Set(channelConfig.instances.map((entry) => (isRecord(entry) ? entry.id : undefined)).filter(isString))
  }
  return new Set(['default'])
}

function readTypeclawConfig(cwd: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(cwd, 'typeclaw.json'), 'utf8')) as Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

const FAMILY_OF: Partial<Record<ChannelKind, { value: FamilyValue; label: string }>> = {
  webex: { value: 'webex-family', label: 'Webex' },
  'webex-bot': { value: 'webex-family', label: 'Webex' },
  slack: { value: 'slack-family', label: 'Slack' },
  'slack-bot': { value: 'slack-family', label: 'Slack' },
  discord: { value: 'discord-family', label: 'Discord' },
  'discord-bot': { value: 'discord-family', label: 'Discord' },
}

type FamilyValue = 'webex-family' | 'slack-family' | 'discord-family'

type FamilyMode<K extends ChannelKind> = { value: K; label: string }

export const WEBEX_MODES: ReadonlyArray<FamilyMode<'webex' | 'webex-bot'>> = [
  { value: 'webex', label: 'User (ID/PW) — receives all messages, no @mention needed (recommended)' },
  { value: 'webex-bot', label: 'Bot (Token) — only sees @mentions in group spaces' },
]

export const SLACK_MODES: ReadonlyArray<FamilyMode<'slack' | 'slack-bot'>> = [
  { value: 'slack-bot', label: 'Bot (Token) — posts as a Slack app/bot user (recommended)' },
  { value: 'slack', label: 'User (QR) — posts as your own Slack account; unofficial session, may need re-auth' },
]

export const DISCORD_MODES: ReadonlyArray<FamilyMode<'discord' | 'discord-bot'>> = [
  { value: 'discord-bot', label: 'Bot (Token) — posts as a Discord app/bot user (recommended)' },
  { value: 'discord', label: 'User (QR) — posts as your own Discord account; unofficial session, may need re-auth' },
]

// Keep the displayed order (recommended/User first), dropping already-configured
// modes. The caller defaults the selection to options[0], so this order — NOT
// CHANNEL_KINDS order — decides which mode is preselected.
export function familyModeOptions<K extends ChannelKind>(
  modes: ReadonlyArray<FamilyMode<K>>,
  available: ReadonlyArray<ChannelKind>,
): Array<FamilyMode<K>> {
  return modes.filter((mode) => available.includes(mode.value))
}

async function pickWebexMode(available: ReadonlyArray<ChannelKind>): Promise<'webex' | 'webex-bot'> {
  const options = familyModeOptions(WEBEX_MODES, available)
  if (options.length === 1) return options[0]!.value
  const mode = await select<'webex' | 'webex-bot'>({
    message: 'Which Webex mode?',
    options: options.map((o) => ({ value: o.value, label: o.label })),
    initialValue: options[0]?.value,
  })
  if (isCancel(mode)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return mode
}

async function pickSlackMode(available: ReadonlyArray<ChannelKind>): Promise<'slack' | 'slack-bot'> {
  const options = familyModeOptions(SLACK_MODES, available)
  if (options.length === 1) return options[0]!.value
  const mode = await select<'slack' | 'slack-bot'>({
    message: 'Which Slack mode?',
    options: options.map((o) => ({ value: o.value, label: o.label })),
    initialValue: options[0]?.value,
  })
  if (isCancel(mode)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return mode
}

async function pickDiscordMode(available: ReadonlyArray<ChannelKind>): Promise<'discord' | 'discord-bot'> {
  const options = familyModeOptions(DISCORD_MODES, available)
  if (options.length === 1) return options[0]!.value
  const mode = await select<'discord' | 'discord-bot'>({
    message: 'Which Discord mode?',
    options: options.map((o) => ({ value: o.value, label: o.label })),
    initialValue: options[0]?.value,
  })
  if (isCancel(mode)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return mode
}

function isSettableAdapter(value: string): value is SettableAdapter {
  return (SETTABLE_ADAPTERS as ReadonlyArray<string>).includes(value)
}

function validateSetAdapterArg(adapter: string, configured: Set<ChannelKind>): SettableAdapter {
  if (!isSettableAdapter(adapter)) {
    if (isChannelKind(adapter)) {
      console.error(
        errorLine(
          `Adapter "${adapter}" does not support \`channel set\`. Use \`typeclaw channel reauth ${adapter}\` instead.`,
        ),
      )
    } else {
      console.error(errorLine(`Unknown adapter "${adapter}". Expected one of: ${SETTABLE_ADAPTERS.join(', ')}.`))
    }
    process.exit(1)
  }
  if (!configured.has(adapter)) {
    console.error(
      errorLine(
        `${CHANNEL_LABELS[adapter]} ("${adapter}") is not configured in typeclaw.json. Run \`typeclaw channel add ${adapter}\` first.`,
      ),
    )
    process.exit(1)
  }
  return adapter
}

async function pickSettableAdapter(configured: Set<ChannelKind>): Promise<SettableAdapter> {
  const available = SETTABLE_ADAPTERS.filter((kind) => configured.has(kind))
  if (available.length === 0) {
    console.error(
      errorLine(
        'No rotatable channels are configured. Run `typeclaw channel add <adapter>` first, or use `typeclaw channel reauth kakaotalk` for KakaoTalk.',
      ),
    )
    process.exit(1)
  }
  if (available.length === 1) return available[0]!

  const selected = await select<SettableAdapter>({
    message: 'Pick a channel to rotate credentials for',
    options: available.map((kind) => ({ value: kind, label: CHANNEL_LABELS[kind] })),
    initialValue: available[0],
  })
  if (isCancel(selected)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return selected
}

async function runSet(cwd: string, adapter: SettableAdapter): Promise<void> {
  switch (adapter) {
    case 'discord-bot':
      await runSetDiscord(cwd)
      break
    case 'telegram-bot':
      await runSetTelegram(cwd)
      break
    case 'webex-bot':
      await runSetWebex(cwd)
      break
    case 'slack-bot':
      await runSetSlack(cwd)
      break
    case 'github':
      await runSetGithub(cwd)
      break
  }
}

async function runSetDiscord(cwd: string): Promise<void> {
  const token = await promptDiscordToken()
  const result = await setChannelSecrets(cwd, 'discord-bot', { token })
  if (!result.ok) {
    console.error(errorLine(result.reason))
    process.exit(1)
  }
  await maybePromptCredentialRefresh(cwd, CHANNEL_LABELS['discord-bot'], 'credentials updated')
}

async function runSetTelegram(cwd: string): Promise<void> {
  const token = await promptTelegramToken()
  const result = await setChannelSecrets(cwd, 'telegram-bot', { token })
  if (!result.ok) {
    console.error(errorLine(result.reason))
    process.exit(1)
  }
  await maybePromptCredentialRefresh(cwd, CHANNEL_LABELS['telegram-bot'], 'credentials updated')
}

async function runSetWebex(cwd: string): Promise<void> {
  const token = await promptWebexToken()
  const result = await setChannelSecrets(cwd, 'webex-bot', { token })
  if (!result.ok) {
    console.error(errorLine(result.reason))
    process.exit(1)
  }
  await maybePromptCredentialRefresh(cwd, CHANNEL_LABELS['webex-bot'], 'credentials updated')
}

type SlackSetChoice = 'bot' | 'app' | 'both'

async function runSetSlack(cwd: string): Promise<void> {
  note(
    [
      'Rotate at https://api.slack.com/apps → your app:',
      '  Bot token  (xoxb-...) — OAuth & Permissions → Reset Token.',
      '  App-level token (xapp-...) — Basic Information → App-Level Tokens → Revoke and regenerate.',
      'Slack only shows the app-level token once on screen — copy it before closing.',
    ].join('\n'),
    'Rotate the Slack tokens',
  )
  const choice = await select<SlackSetChoice>({
    message: 'Which Slack token do you want to rotate?',
    options: [
      { value: 'bot', label: 'Bot user token (xoxb-...) — used to post messages as the bot (recommended)' },
      { value: 'app', label: 'App-level token (xapp-...) — required for Socket Mode' },
      { value: 'both', label: 'Both tokens — rotate the bot token and the app-level token' },
    ],
    initialValue: 'bot',
  })
  if (isCancel(choice)) {
    cancel('Aborted.')
    process.exit(0)
  }

  const tokens: Record<string, string> = {}
  if (choice === 'bot' || choice === 'both') tokens.botToken = await promptSlackBotToken()
  if (choice === 'app' || choice === 'both') tokens.appToken = await promptSlackAppToken()

  const result = await setChannelSecrets(cwd, 'slack-bot', tokens)
  if (!result.ok) {
    console.error(errorLine(result.reason))
    process.exit(1)
  }
  await maybePromptCredentialRefresh(cwd, CHANNEL_LABELS['slack-bot'], 'credentials updated')
}

type GithubSetChoice = 'auth' | 'webhook' | 'both'

async function runSetGithub(cwd: string): Promise<void> {
  const authType = readGithubAuthType(cwd)
  if (authType === null) {
    console.error(
      errorLine(
        'GitHub auth block is missing or malformed in secrets.json. Run `typeclaw channel add github` first, or fix the file by hand.',
      ),
    )
    process.exit(1)
  }
  const authLabel =
    authType === 'pat'
      ? 'Auth credential — rotate the PAT, or switch to GitHub App auth (recommended)'
      : 'Auth credential — rotate the App private key, or switch to PAT auth (recommended)'
  const choice = await select<GithubSetChoice>({
    message: 'Which GitHub secret do you want to update?',
    options: [
      { value: 'auth', label: authLabel },
      { value: 'webhook', label: 'Webhook secret — shared secret for verifying GitHub payloads' },
      { value: 'both', label: 'Both secrets — update the auth credential and the webhook secret' },
    ],
    initialValue: 'auth',
  })
  if (isCancel(choice)) {
    cancel('Aborted.')
    process.exit(0)
  }

  const patch: GithubCredentialPatch = {}

  if (choice === 'auth' || choice === 'both') {
    patch.auth = await promptGithubAuthUpdate(authType)
  }

  if (choice === 'webhook' || choice === 'both') {
    const secret = await password({
      message: 'New webhook secret (leave blank to auto-generate)',
    })
    if (isCancel(secret)) {
      cancel('Aborted.')
      process.exit(0)
    }
    const enteredSecret = typeof secret === 'string' ? secret : ''
    patch.webhookSecret = enteredSecret.length > 0 ? enteredSecret : randomBytes(32).toString('hex')
  }

  const result = await setGithubSecrets(cwd, patch)
  if (!result.ok) {
    console.error(errorLine(result.reason))
    process.exit(1)
  }
  await maybePromptCredentialRefresh(cwd, CHANNEL_LABELS.github, 'credentials updated')
}

type CollectedCredentials =
  | { channel: 'discord'; runDiscordAuth: (options: { cwd: string }) => Promise<DiscordAuthResult> }
  | { channel: 'discord-bot'; discordBotToken: string }
  | {
      channel: 'slack'
      slackQrDataUrl: string
      runSlackAuth: (options: { cwd: string; qrDataUrl: string }) => Promise<SlackAuthResult>
    }
  | { channel: 'slack-bot'; slackBotToken: string; slackAppToken: string }
  | { channel: 'telegram-bot'; telegramBotToken: string }
  | { channel: 'webex'; runWebexAuth: (options: { cwd: string }) => Promise<WebexAuthResult> }
  | { channel: 'webex-bot'; webexBotToken: string }
  | { channel: 'line'; runLineAuth: (options: { cwd: string }) => Promise<LineAuthResult> }
  | { channel: 'kakaotalk'; runKakaotalkAuth: (options: { cwd: string }) => Promise<KakaotalkAuthResult> }
  | {
      channel: 'github'
      webhookSecret: string
      tunnelProvider: GithubTunnelProvider
      webhookUrl?: string
      webhookPort?: number
      repos: string[]
      auth: { type: 'pat'; pat: string } | { type: 'app'; appId: number; privateKey: string; installationId?: number }
    }

async function collectCredentials(
  channel: ChannelKind,
  cwd: string,
  lineSpinnerHolder?: LineAuthSpinnerHolder,
): Promise<CollectedCredentials> {
  switch (channel) {
    case 'discord':
      return { channel, runDiscordAuth: ({ cwd: agentDir }) => runDiscordQrAuth(agentDir) }
    case 'discord-bot':
      return { channel, discordBotToken: await promptDiscordToken() }
    case 'slack-bot': {
      const slack = await promptSlackTokens()
      return { channel, slackBotToken: slack.bot, slackAppToken: slack.app }
    }
    case 'slack': {
      const qrDataUrl = await promptSlackQrDataUrl()
      return {
        channel,
        slackQrDataUrl: qrDataUrl,
        runSlackAuth: ({ cwd: agentDir, qrDataUrl }) => runSlackBootstrap({ qrDataUrl, agentDir }),
      }
    }
    case 'telegram-bot':
      return { channel, telegramBotToken: await promptTelegramToken() }
    case 'webex': {
      const creds = await promptWebexCredentials()
      return {
        channel,
        runWebexAuth: ({ cwd: agentDir }) =>
          runWebexBootstrap({ email: creds.email, password: creds.password, agentDir }),
      }
    }
    case 'webex-bot':
      return { channel, webexBotToken: await promptWebexToken() }
    case 'line': {
      const login = await promptLineLogin(lineSpinnerHolder ? holderSpinnerControl(lineSpinnerHolder) : undefined)
      return {
        channel,
        runLineAuth: ({ cwd: agentDir }) => runLineBootstrap({ ...login, agentDir }),
      }
    }
    case 'kakaotalk': {
      const creds = await promptKakaotalkCredentials()
      return {
        channel,
        runKakaotalkAuth: ({ cwd: agentDir }) =>
          runKakaotalkBootstrap({
            email: creds.email,
            password: creds.password,
            agentDir,
            callbacks: { onPasscode: (code) => log.info(`Confirm this passcode on your phone: ${code}`) },
          }),
      }
    }
    case 'github': {
      const creds = await promptGithubCredentials(cwd)
      return { channel, ...creds }
    }
  }
}

async function runDiscordQrAuth(agentDir: string): Promise<DiscordAuthResult> {
  return await runDiscordBootstrap({ agentDir, onQrUrl: renderDiscordQrToTerminal })
}

async function renderDiscordQrToTerminal(url: string): Promise<void> {
  const qr = await QRCode.toString(url, { type: 'terminal', small: true })
  note(
    [`Open Discord mobile app → Settings → scan QR.`, '', qr, '', 'Approve the login on your phone to continue.'].join(
      '\n',
    ),
    'Discord QR login',
  )
}

async function promptGithubCredentials(cwd: string): Promise<{
  webhookSecret: string
  tunnelProvider: GithubTunnelProvider
  webhookUrl?: string
  webhookPort?: number
  hostname?: string
  tokenEnv?: string
  repos: string[]
  auth: { type: 'pat'; pat: string } | { type: 'app'; appId: number; privateKey: string; installationId?: number }
}> {
  note(
    [
      'Choose PAT auth for a quick setup, or GitHub App auth for expiring installation tokens.',
      'Required permissions: Issues read/write, Pull requests read/write, Discussions read/write (if used),',
      'Metadata read, and Webhooks read/write (TypeClaw will create and manage the repository webhooks for you).',
    ].join('\n'),
    'Get GitHub credentials',
  )
  const authType = await select({
    message: 'GitHub authentication type',
    options: [
      { value: 'pat', label: 'Fine-grained personal access token' },
      { value: 'app', label: 'GitHub App installation token (recommended)' },
    ],
    initialValue: 'app',
  })
  if (isCancel(authType)) {
    cancel('Aborted.')
    process.exit(0)
  }
  const auth = authType === 'pat' ? await promptGithubPatAuth() : await promptGithubAppAuth()
  note('GitHub webhooks need a public URL. TypeClaw can manage a tunnel for you.', 'GitHub webhook tunnel')
  const tunnelProvider = await select<GithubTunnelProvider>({
    message: 'Tunnel provider',
    options: [
      {
        value: 'cloudflare-quick',
        label: 'Cloudflare Quick Tunnel — no signup, URL rotates on restart (recommended)',
      },
      {
        value: 'cloudflare-named',
        label: 'Cloudflare Named Tunnel — stable URL, needs Cloudflare account + domain',
      },
      { value: 'external', label: 'External URL — I have my own reverse proxy / tunnel' },
      { value: 'none', label: 'None — configure later by hand-editing typeclaw.json' },
    ],
    initialValue: 'cloudflare-quick',
  })
  if (isCancel(tunnelProvider)) {
    cancel('Aborted.')
    process.exit(0)
  }
  const webhookUrl =
    tunnelProvider === 'external'
      ? await text({
          message: 'Public webhook URL (GitHub will POST events here)',
          validate: (value) => validateUrl(value ?? '', 'Webhook URL is required'),
        })
      : undefined
  if (isCancel(webhookUrl)) {
    cancel('Aborted.')
    process.exit(0)
  }
  const namedCreds = tunnelProvider === 'cloudflare-named' ? await promptCloudflareNamedTunnel(cwd) : undefined
  const port = await text({
    message: 'Local webhook port inside the agent container',
    initialValue: '8975',
    validate: (value) => {
      const parsed = Number(value)
      return Number.isInteger(parsed) && parsed > 0 ? undefined : 'Port must be a positive integer'
    },
  })
  if (isCancel(port)) {
    cancel('Aborted.')
    process.exit(0)
  }
  const secret = await password({
    message: 'Webhook secret (leave blank to auto-generate)',
  })
  if (isCancel(secret)) {
    cancel('Aborted.')
    process.exit(0)
  }
  // clack's password() returns `undefined` on an empty submission (it has no
  // validate guard and never coerces to ''), so we normalize before the
  // length checks below to avoid a TypeError on the "leave blank" path.
  const enteredSecret = typeof secret === 'string' ? secret : ''
  const reposRaw = await text({
    message: 'Repositories to allow (comma-separated owner/repo)',
    validate: (value) => (parseRepos(value ?? '').length > 0 ? undefined : 'At least one owner/repo is required'),
  })
  if (isCancel(reposRaw)) {
    cancel('Aborted.')
    process.exit(0)
  }
  const resolvedSecret = enteredSecret.length > 0 ? enteredSecret : randomBytes(32).toString('hex')
  return {
    webhookSecret: resolvedSecret,
    tunnelProvider,
    ...(webhookUrl !== undefined ? { webhookUrl } : {}),
    webhookPort: Number(port),
    ...(namedCreds !== undefined ? namedCreds : {}),
    repos: parseRepos(reposRaw),
    auth,
  }
}

async function promptCloudflareNamedTunnel(cwd: string): Promise<{ hostname: string; tokenEnv: string }> {
  const tokenEnv = 'CLOUDFLARE_TUNNEL_TOKEN'
  note(
    [
      'Cloudflare Named Tunnel needs a tunnel you created in the Zero Trust dashboard:',
      '  1. Networks → Tunnels → Create a tunnel → Cloudflared. Copy the token shown on the install screen.',
      '  2. Public Hostname tab → Add: subdomain + your-domain, service type HTTP, URL localhost:<webhook port>.',
      `  3. Paste the token below when prompted — TypeClaw will write it to .env as ${tokenEnv}.`,
      'A tunnel without a Public Hostname registers but routes nothing.',
    ].join('\n'),
    'Cloudflare named tunnel',
  )
  const hostname = await text({
    message: 'Public hostname configured in the dashboard (https://...)',
    validate: (value) => validateUrl(value ?? '', 'Hostname is required'),
  })
  if (isCancel(hostname)) {
    cancel('Aborted.')
    process.exit(0)
  }
  if (!hasEnvKey(cwd, tokenEnv)) {
    const token = await password({
      message: `Cloudflare tunnel token (will be written to .env as ${tokenEnv})`,
      validate: (value) => (value && value.length > 0 ? undefined : 'Token is required'),
    })
    if (isCancel(token)) {
      cancel('Aborted.')
      process.exit(0)
    }
    appendOrReplaceEnvKey(cwd, tokenEnv, token)
  }
  return { hostname, tokenEnv }
}

type GithubAuthUpdateAction = 'rotate' | 'switch'

async function promptGithubAuthUpdate(currentType: 'pat' | 'app'): Promise<GithubCredentialPatch['auth']> {
  const rotateLabel =
    currentType === 'pat'
      ? 'Rotate the PAT (replace the current personal access token)'
      : 'Rotate the App private key (replace the current GitHub App private key)'
  const switchLabel =
    currentType === 'pat'
      ? 'Switch to GitHub App auth (replace the PAT with App credentials)'
      : 'Switch to PAT auth (replace the App credentials with a personal access token)'
  const action = await select<GithubAuthUpdateAction>({
    message: 'Update the GitHub auth credential',
    options: [
      { value: 'rotate', label: rotateLabel },
      { value: 'switch', label: switchLabel },
    ],
    initialValue: 'rotate',
  })
  if (isCancel(action)) {
    cancel('Aborted.')
    process.exit(0)
  }

  const nextType: 'pat' | 'app' = action === 'rotate' ? currentType : currentType === 'pat' ? 'app' : 'pat'

  if (nextType === 'pat') {
    if (action === 'rotate') {
      note(
        [
          'Rotate at https://github.com/settings/personal-access-tokens.',
          'Required permissions: Issues read/write, Pull requests read/write, Discussions read/write (if used),',
          'Metadata read, and Webhooks read/write.',
        ].join('\n'),
        'Rotate the GitHub PAT',
      )
    } else {
      note(
        [
          'Create a fine-grained PAT at https://github.com/settings/personal-access-tokens.',
          'Required permissions: Issues read/write, Pull requests read/write, Discussions read/write (if used),',
          'Metadata read, and Webhooks read/write.',
        ].join('\n'),
        'Switch to GitHub PAT auth',
      )
    }
    return await promptGithubPatAuth()
  }

  if (action === 'rotate') {
    note(
      [
        'Rotate at https://github.com/settings/apps/<your-app> → Private keys → Generate a private key.',
        'GitHub immediately downloads the new .pem. The previous key keeps working until you delete it,',
        'so it is safe to rotate without downtime.',
      ].join('\n'),
      'Rotate the GitHub App private key',
    )
    const privateKey = await promptPrivateKeyPem('New GitHub App private key PEM, escaped PEM, or path to .pem file')
    if (privateKey === CANCEL_SYMBOL) {
      cancel('Aborted.')
      process.exit(0)
    }
    return { type: 'app', privateKey }
  }

  note(
    [
      'Create a GitHub App at https://github.com/settings/apps/new and install it on your repositories.',
      'Required permissions: Issues read/write, Pull requests read/write, Discussions read/write (if used),',
      'Metadata read, and Webhooks read/write.',
      'Then collect the App ID, generate a private key (.pem), and grab the Installation ID from the URL',
      'of the installation page (https://github.com/settings/installations/<installation-id>).',
    ].join('\n'),
    'Switch to GitHub App auth',
  )
  return await promptGithubAppAuth()
}

async function promptGithubPatAuth(): Promise<{ type: 'pat'; pat: string }> {
  const pat = await password({
    message: 'GitHub fine-grained PAT',
    validate: (value) => (value && value.length > 0 ? undefined : 'PAT is required'),
  })
  if (isCancel(pat)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return { type: 'pat', pat }
}

async function promptGithubAppAuth(): Promise<{
  type: 'app'
  appId: number
  privateKey: string
}> {
  const appId = await text({
    message: 'GitHub App ID',
    validate: (value) => validatePositiveInteger(value ?? '', 'App ID is required'),
  })
  if (isCancel(appId)) {
    cancel('Aborted.')
    process.exit(0)
  }
  const privateKey = await promptPrivateKeyPem('GitHub App private key PEM, escaped PEM, or path to .pem file')
  if (privateKey === CANCEL_SYMBOL) {
    cancel('Aborted.')
    process.exit(0)
  }
  return {
    type: 'app',
    appId: Number(appId),
    privateKey,
  }
}

function parseRepos(input: string): string[] {
  return input
    .split(',')
    .map((v) => v.trim())
    .filter((v) => /^[^\s/]+\/[^\s/]+$/.test(v))
}

function validateUrl(value: string, requiredMessage: string): string | undefined {
  if (!value || value.length === 0) return requiredMessage
  try {
    new URL(value)
    return undefined
  } catch {
    return 'Must be a valid URL'
  }
}

function validatePositiveInteger(value: string, requiredMessage: string): string | undefined {
  if (!value || value.length === 0) return requiredMessage
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? undefined : 'Must be a positive integer'
}

async function promptDiscordToken(): Promise<string> {
  note(
    [
      'https://discord.com/developers/applications',
      'New Application → Bot tab → Reset Token.',
      'Under Privileged Gateway Intents, enable MESSAGE CONTENT and GUILD MEMBERS.',
    ].join('\n'),
    'Get a Discord bot token',
  )
  const token = await password({
    message: 'Discord bot token',
    validate: (value) => (value && value.length > 0 ? undefined : 'Token is required'),
  })
  if (isCancel(token)) {
    cancel('Aborted.')
    process.exit(0)
  }
  printDiscordInviteHint(token)
  return token
}

async function promptSlackTokens(): Promise<{ bot: string; app: string }> {
  printSlackAppManifestSetup()
  const bot = await promptSlackBotToken()
  note(
    [
      'Slack does not accept connections:write inside the manifest, so',
      'this token has to be generated by hand:',
      '',
      '1. Basic Information → App-Level Tokens → Generate Token and Scopes.',
      '2. Token Name: anything (e.g. "socket-mode").',
      '3. Add Scope → connections:write → Generate.',
      '4. Copy the xapp-... token shown once on screen.',
      '   (You cannot retrieve it later — only revoke and regenerate.)',
    ].join('\n'),
    'Generate the Slack app-level token',
  )
  const app = await promptSlackAppToken()
  return { bot, app }
}

async function promptSlackQrDataUrl(): Promise<string> {
  note(
    [
      'Slack user mode signs in as your own account — messages are sent and',
      'received as this Slack user, not a bot.',
      '',
      'Copy the QR image data URL from the Slack desktop app:',
      '',
      '1. Click your name (top-left) → "Sign in on mobile".',
      '2. Right-click the QR code → "Copy Image Address".',
      '3. Paste it below (a long data:image/png;base64,... string).',
      '',
      'Generate a fresh QR each time — the sign-in link expires quickly.',
    ].join('\n'),
    'Sign in to Slack (user account)',
  )
  const qrDataUrl = await text({
    message: 'Slack QR data URL (data:image/png;base64,...)',
    validate: (value) =>
      value && value.startsWith('data:image/') ? undefined : 'QR data URL must start with "data:image/"',
  })
  if (isCancel(qrDataUrl)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return qrDataUrl
}

async function promptSlackBotToken(): Promise<string> {
  const botToken = await password({
    message: 'Slack bot token (xoxb-...)',
    validate: (value) =>
      value && value.length > 0
        ? value.startsWith('xoxb-')
          ? undefined
          : 'Bot token must start with "xoxb-"'
        : 'Token is required',
  })
  if (isCancel(botToken)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return botToken
}

async function promptSlackAppToken(): Promise<string> {
  const appToken = await password({
    message: 'Slack app-level token (xapp-...) — Socket Mode requires this',
    validate: (value) =>
      value && value.length > 0
        ? value.startsWith('xapp-')
          ? undefined
          : 'App-level token must start with "xapp-"'
        : 'Token is required',
  })
  if (isCancel(appToken)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return appToken
}

async function promptTelegramToken(): Promise<string> {
  note(
    [
      'Open Telegram and message @BotFather.',
      '/newbot → pick a name and username, copy the HTTP API token',
      '  (looks like 1234567890:ABCdef...).',
      'In @BotFather: /setprivacy → Disable, so the bot can see group messages.',
    ].join('\n'),
    'Get a Telegram bot token',
  )
  const token = await password({
    message: 'Telegram bot token',
    validate: (value) =>
      value && value.length > 0
        ? /^\d+:/.test(value)
          ? undefined
          : 'Bot token must look like "<digits>:<secret>" (from @BotFather)'
        : 'Token is required',
  })
  if (isCancel(token)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return token
}

async function promptWebexToken(): Promise<string> {
  note(
    [
      'Create a bot at https://developer.webex.com/my-apps/new/bot.',
      'Copy the Bot Access Token from the bot settings page.',
    ].join('\n'),
    'Get a Webex bot token',
  )
  const token = await password({
    message: 'Webex bot access token',
    validate: (value) => (value && value.length > 0 ? undefined : 'Token is required'),
  })
  if (isCancel(token)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return token
}

async function promptKakaotalkCredentials(
  opts: { defaultEmail?: string } = {},
): Promise<{ email: string; password: string }> {
  note(
    [
      'KakaoTalk authentication uses a personal account, registered as a',
      'tablet sub-device. Messages will be sent and received under this',
      'account. Use a non-primary account if possible.',
      '',
      'On reauth, the existing device_uuid is preserved automatically, so',
      'subsequent logins for the same account typically skip the phone',
      'passcode confirmation.',
    ].join('\n'),
    'About to log in to KakaoTalk',
  )
  const email = await text({
    message: 'KakaoTalk email',
    ...(opts.defaultEmail !== undefined ? { initialValue: opts.defaultEmail, placeholder: opts.defaultEmail } : {}),
    validate: (value) => (value && value.length > 0 ? undefined : 'Email is required'),
  })
  if (isCancel(email)) {
    cancel('Aborted.')
    process.exit(0)
  }
  const pwd = await password({
    message: 'KakaoTalk password',
    validate: (value) => (value && value.length > 0 ? undefined : 'Password is required'),
  })
  if (isCancel(pwd)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return { email, password: pwd }
}

async function promptWebexCredentials(
  opts: { defaultEmail?: string } = {},
): Promise<{ email: string; password: string }> {
  note(
    [
      'Logs in headlessly with your Webex email/password.',
      'SSO/MFA accounts are not supported. Messages will be sent and received under this account.',
    ].join('\n'),
    'About to log in to Webex',
  )
  const email = await text({
    message: 'Webex email',
    ...(opts.defaultEmail !== undefined ? { initialValue: opts.defaultEmail, placeholder: opts.defaultEmail } : {}),
    validate: (value) => (value && value.length > 0 ? undefined : 'Email is required'),
  })
  if (isCancel(email)) {
    cancel('Aborted.')
    process.exit(0)
  }
  const pwd = await password({
    message: 'Webex password',
    validate: (value) => (value && value.length > 0 ? undefined : 'Password is required'),
  })
  if (isCancel(pwd)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return { email, password: pwd }
}

type LinePromptResult =
  | { method: 'qr'; callbacks: { onQRUrl: (url: string) => Promise<void>; onPincode: (pin: string) => void } }
  | {
      method: 'email'
      email: string
      password: string
      callbacks: { onPincode: (pin: string) => void }
    }

// LINE's interactive logins block while the SDK waits on the phone: QR
// long-polls for a scan, email/password waits for the user to enter a PIN. The
// add-flow spinner ('Logging in to LINE...') keeps animating during that wait
// and would otherwise repaint over the multi-line QR or the PIN, garbling both.
// This control lets the QR/PIN callbacks pause the live spinner, print legibly,
// then resume it with a "waiting for you" message so output stays readable.
export type LineAuthSpinnerControl = {
  pause: () => void
  resume: (message: string) => void
}

async function promptLineLogin(spinnerControl?: LineAuthSpinnerControl): Promise<LinePromptResult> {
  note(
    [
      'LINE authentication uses a personal account registered as a sub-device.',
      'Messages will be sent and received under this account — use a',
      'non-primary account if possible.',
      '',
      'QR login is recommended: it works even when the account has no',
      'email/password set (social-login accounts).',
    ].join('\n'),
    'About to log in to LINE',
  )
  const method = await select<'qr' | 'email'>({
    message: 'How do you want to log in to LINE?',
    options: [
      { value: 'qr', label: 'QR code — scan with the LINE app on your phone (recommended)' },
      { value: 'email', label: 'Email + password — for accounts with email login enabled' },
    ],
    initialValue: 'qr',
  })
  if (isCancel(method)) {
    cancel('Aborted.')
    process.exit(0)
  }

  const onPincode = (pin: string): void => {
    spinnerControl?.pause()
    printLinePincode(pin)
    spinnerControl?.resume('Waiting for you to confirm the PIN in the LINE app...')
  }

  if (method === 'qr') {
    return {
      method: 'qr',
      callbacks: {
        onQRUrl: (url) => presentLineQr(url, spinnerControl),
        onPincode,
      },
    }
  }

  const email = await text({
    message: 'LINE email',
    validate: (value) => (value && value.length > 0 ? undefined : 'Email is required'),
  })
  if (isCancel(email)) {
    cancel('Aborted.')
    process.exit(0)
  }
  const pwd = await password({
    message: 'LINE password',
    validate: (value) => (value && value.length > 0 ? undefined : 'Password is required'),
  })
  if (isCancel(pwd)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return { method: 'email', email, password: pwd, callbacks: { onPincode } }
}

async function presentLineQr(url: string, spinnerControl?: LineAuthSpinnerControl): Promise<void> {
  spinnerControl?.pause()
  const presentation = await displayQR(url, {
    title: 'LINE login',
    scanInstruction: 'Scan with the LINE app on your phone',
  })

  const lines: string[] = []
  if (presentation.terminal !== null) {
    lines.push(presentation.terminal)
    lines.push('Scan the QR code above with the LINE app on your phone.')
    lines.push('If it is too small to scan, enlarge the terminal (or zoom out) and re-run.')
    if (presentation.opened) {
      lines.push('A browser window with a larger QR code was also opened.')
    }
  } else if (presentation.opened) {
    lines.push('A browser window with the QR code was opened. Scan it with the LINE app on your phone.')
  } else if (presentation.htmlPath !== null) {
    lines.push(`Open this file in a browser and scan it with the LINE app: ${presentation.htmlPath}`)
  }
  if (lines.length > 0) note(lines.join('\n'), 'Scan to log in to LINE')

  if (presentation.terminal === null && !presentation.opened && presentation.htmlPath === null) {
    printLineQrUrl(url)
  }

  spinnerControl?.resume('Waiting for you to scan the QR code with the LINE app...')
}

// Last-resort fallback when no QR could be rendered. The raw URL stays OUT of
// note(): clack wraps long lines with a `│` gutter that corrupts the login URL
// (it carries `?secret=...&e2eeVersion=...`). Same constraint as
// src/cli/oauth-callbacks.ts.
export function printLineQrUrl(url: string, output: NodeJS.WritableStream = process.stdout): void {
  note('Open this URL on a device that can render it as a QR code:', 'Log in to LINE')
  output.write(`${url}\n\n`)
}

// PIN stays OUT of the note() gutter (same `│`-splitting reason as
// printLineQrUrl) and must stand out: the SDK blocks on phone confirmation and
// throws if its window lapses, so a PIN scrolled past unnoticed leaves nothing
// in secrets.json — the root cause of the runtime "No account found" error. The
// "waiting" line is emitted by the resumed spinner, not here.
export function printLinePincode(pin: string, output: NodeJS.WritableStream = process.stdout): void {
  note('Open the LINE app on your phone and enter this PIN to authorize this device:', 'Confirm LINE login')
  output.write(`\n  PIN: ${pin}\n\n`)
}

type Spinner = ReturnType<typeof spinner>

// `current` is the live `line-auth` spinner, shared between `reportProgress`
// (which owns its lifecycle) and the QR/PIN callbacks (which must pause it to
// print legibly). It is null whenever no LINE login spinner is active.
export type LineAuthSpinnerHolder = { current: Spinner | null }

export function holderSpinnerControl(holder: LineAuthSpinnerHolder): LineAuthSpinnerControl {
  return {
    pause: () => holder.current?.stop(),
    resume: (message) => holder.current?.start(message),
  }
}

function reportProgress(
  events: AddChannelStepEvent[],
  lineSpinnerHolder?: LineAuthSpinnerHolder,
): (event: AddChannelStepEvent) => void {
  const spinners: Partial<Record<AddChannelStepEvent['step'], Spinner>> = {}

  return (event) => {
    events.push(event)
    if (event.phase === 'start') {
      const s = spinner()
      s.start(START_MESSAGES[event.step])
      spinners[event.step] = s
      if (event.step === 'line-auth' && lineSpinnerHolder) lineSpinnerHolder.current = s
      return
    }

    const s = spinners[event.step]
    if (!s) return

    switch (event.step) {
      case 'line-auth':
        if (lineSpinnerHolder) lineSpinnerHolder.current = null
        s.stop(reportLineAuth(event.result))
        break
      case 'kakaotalk-auth':
        s.stop(reportKakaotalkAuth(event.result))
        break
      case 'webex-auth':
        s.stop(reportWebexAuth(event.result))
        break
      case 'discord-auth':
        s.stop(reportDiscordAuth(event.result))
        break
      case 'slack-auth':
        s.stop(reportSlackAuth(event.result))
        break
      case 'config':
        s.stop('Updated typeclaw.json.')
        break
      case 'secrets':
        s.stop('Saved credentials to secrets.json.')
        break
      case 'github-webhooks':
        s.stop(formatEagerGithubWebhookInstallResult(event.result))
        break
    }
  }
}

const START_MESSAGES: Record<AddChannelStepEvent['step'], string> = {
  'line-auth': 'Logging in to LINE...',
  'kakaotalk-auth': 'Logging in to KakaoTalk...',
  'webex-auth': 'Logging in to Webex...',
  'discord-auth': 'Logging in to Discord...',
  'slack-auth': 'Logging in to Slack...',
  config: 'Updating typeclaw.json...',
  secrets: 'Saving credentials to secrets.json...',
  'github-webhooks': 'Installing GitHub repository webhooks...',
}

function reportKakaotalkAuth(result: KakaotalkAuthResult): string {
  if (result.ok) return 'KakaoTalk credentials saved to secrets.json.'
  return `KakaoTalk login failed: ${result.reason}`
}

function reportSlackAuth(result: SlackAuthResult): string {
  if (result.ok) return 'Slack credentials saved to secrets.json.'
  return `Slack login failed: ${result.reason}`
}

function reportDiscordAuth(result: DiscordAuthResult): string {
  if (result.ok) return 'Discord credentials saved to secrets.json.'
  return `Discord login failed: ${result.reason}`
}

function reportWebexAuth(result: WebexAuthResult): string {
  if (result.ok) return 'Webex credentials saved to secrets.json.'
  return `Webex login failed: ${result.reason}`
}

function reportLineAuth(result: LineAuthResult): string {
  if (result.ok) return 'LINE credentials saved to secrets.json.'
  return `LINE login failed: ${result.reason}`
}

async function maybePromptRestart(
  cwd: string,
  channel: ChannelKind,
  verb: 'added' | 'removed' = 'added',
): Promise<void> {
  const label = CHANNEL_LABELS[channel]
  const current = await status({ cwd }).catch(() => null)
  if (current === null || current.kind !== 'running') {
    done({
      title: c.green(`${label} channel ${verb}.`),
      hints: [
        { label: 'Start the agent:', command: 'typeclaw start' },
        { label: 'Then check status:', command: 'typeclaw status' },
      ],
    })
    return
  }

  const restartNow = await confirm({
    message: `Channel config is restart-required and the agent container is running. Restart it now to apply the ${verb} channel?`,
    initialValue: true,
  })
  if (isCancel(restartNow) || !restartNow) {
    done({
      title: c.green(`${label} channel ${verb}.`),
      hints: [
        { label: 'Apply later:', command: 'typeclaw restart' },
        { label: 'Check status:', command: 'typeclaw status' },
      ],
    })
    return
  }

  const stopped = await stop({ cwd })
  if (!stopped.ok) {
    console.error(errorLine(`Restart failed during stop: ${stopped.reason}`))
    process.exit(1)
  }
  const started = await start({ cwd, preferredHostPort: config.port, cliEntry: process.argv[1] })
  if (!started.ok) {
    console.error(errorLine(`Restart failed during start: ${started.reason}`))
    process.exit(1)
  }
  done({
    title: c.green(
      `${label} channel ${verb}. Restarted ${started.plan.containerName} on host port ${started.hostPort}.`,
    ),
    hints: [
      { label: 'Attach TUI:', command: 'typeclaw tui' },
      { label: 'Follow logs:', command: 'typeclaw logs -f' },
    ],
  })
}
