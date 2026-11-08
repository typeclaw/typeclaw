import { CHANNEL_FIELD_ENV } from '@/secrets/defaults'

type ActionAllowlist = Readonly<Record<string, readonly string[] | null>>

const AUTH_READ_ONLY = ['status', 'list'] as const

// Bot-token agent-messenger CLIs whose credential TypeClaw already holds as a
// channel adapter token in secrets.json. User-account platforms carry refresh
// and session state the CLI would write back, so they are not minted here.
//
// `actions` lists, per command group, the verified actions that never read a
// local path (null = the group itself is the action). Everything else is
// absent on purpose: the `file` groups and Telegram's `message upload` read
// the path they are given, so they could upload the minted profile; config
// mutators (`auth set`, `server switch`) cannot write the read-only mount.
export const BOT_PLATFORMS = {
  slackbot: {
    tokenEnv: CHANNEL_FIELD_ENV['slack-bot'].botToken,
    globalValueOptions: ['--bot'],
    actions: {
      auth: AUTH_READ_ONLY,
      channel: ['list', 'info'],
      message: ['send', 'list', 'get', 'edit', 'delete', 'typing', 'replies'],
      reaction: ['add', 'remove'],
      user: ['list', 'info'],
      whoami: null,
    },
  },
  discordbot: {
    tokenEnv: CHANNEL_FIELD_ENV['discord-bot'].token,
    globalValueOptions: ['--bot', '--server'],
    actions: {
      auth: AUTH_READ_ONLY,
      channel: ['list', 'info'],
      message: ['send', 'list', 'get', 'edit', 'delete', 'replies'],
      reaction: ['list', 'add', 'remove'],
      server: ['list', 'current', 'info'],
      snapshot: null,
      thread: ['list', 'create', 'archive'],
      user: ['list', 'info'],
      whoami: null,
    },
  },
  telegrambot: {
    tokenEnv: CHANNEL_FIELD_ENV['telegram-bot'].token,
    globalValueOptions: ['--bot'],
    actions: {
      auth: AUTH_READ_ONLY,
      chat: ['info', 'member'],
      message: ['send', 'edit', 'delete', 'forward'],
      reaction: ['set', 'clear'],
      whoami: null,
    },
  },
  webexbot: {
    tokenEnv: CHANNEL_FIELD_ENV['webex-bot'].token,
    globalValueOptions: ['--bot'],
    actions: {
      auth: AUTH_READ_ONLY,
      listen: null,
      member: ['list'],
      message: ['send', 'reply', 'replies', 'dm', 'list', 'get', 'delete', 'edit'],
      snapshot: null,
      space: ['list', 'info'],
      user: ['list', 'info'],
      whoami: null,
    },
  },
} as const satisfies Record<
  string,
  { tokenEnv: string; globalValueOptions: readonly string[]; actions: ActionAllowlist }
>

export type BotPlatform = keyof typeof BOT_PLATFORMS

export type AgentMessengerCommandDecision =
  | { kind: 'mint'; platform: BotPlatform; args: string[] }
  | { kind: 'refuse'; platform: BotPlatform; reason: string }
  | { kind: 'ignore'; platform?: BotPlatform }

const GLOBAL_FLAGS = new Set(['--pretty'])
const CREDENTIAL_MUTATING_AUTH = new Set(['set', 'clear', 'use', 'remove'])

// The minted profile is readable by every process in the sandbox, so it may only
// reach ONE CLI process (which the broker launches itself) whose argv cannot name
// a local file to read. Anything else is refused or left alone.
export function analyzeAgentMessengerCommand(command: string): AgentMessengerCommandDecision {
  const scanned = scanWords(command)
  const invocation = resolveInvocation(scanned.words)
  if (invocation === undefined) return { kind: 'ignore' }
  const { platform, args } = invocation
  if (!scanned.safe) {
    return {
      kind: 'refuse',
      platform,
      reason:
        `TypeClaw can lend this agent's ${platform} channel token to agent-${platform} only as a single bare command. ` +
        'Pipes, `&&`, `;`, redirections, `$(...)`, and backslash escapes are not allowed because another process in the same command could read the lent credential. ' +
        `Run \`agent-${platform} ...\` on its own, then process its output in a separate command.`,
    }
  }

  const spec = BOT_PLATFORMS[platform]
  const valueOptions = new Set<string>(spec.globalValueOptions)
  let index = 0
  while (index < args.length && (args[index] as string).startsWith('-')) {
    const arg = args[index] as string
    const name = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg
    if (GLOBAL_FLAGS.has(arg)) index += 1
    else if (valueOptions.has(name) && name !== arg) index += 1
    else if (valueOptions.has(arg) && index + 1 < args.length) index += 2
    else if (arg === '--help' || arg === '-h' || arg === '--version' || arg === '-V')
      return { kind: 'ignore', platform }
    else return refuseShape(platform, `the leading option \`${arg}\` is not one TypeClaw can verify`)
  }

  const group = args[index]
  if (group === undefined || group === 'help') return { kind: 'ignore', platform }
  const actions = (spec.actions as ActionAllowlist)[group]
  if (group === 'auth' && CREDENTIAL_MUTATING_AUTH.has(args[index + 1] ?? '')) return { kind: 'ignore', platform }
  if (actions === undefined) return refuseShape(platform, `\`${group}\` is not an allowed command group`)
  if (actions === null) return { kind: 'mint', platform, args }
  const action = args[index + 1]
  if (action === undefined || action.startsWith('-')) return { kind: 'ignore', platform }
  if (!actions.includes(action)) return refuseShape(platform, `\`${group} ${action}\` can read a local file`)
  return { kind: 'mint', platform, args }
}

function refuseShape(platform: BotPlatform, detail: string): AgentMessengerCommandDecision {
  const allowed = Object.entries(BOT_PLATFORMS[platform].actions as ActionAllowlist)
    .map(([group, actions]) => (actions === null ? group : `${group} ${actions.join('|')}`))
    .join(', ')
  return {
    kind: 'refuse',
    platform,
    reason:
      `TypeClaw lends this agent's ${platform} channel token only to agent-${platform} commands that cannot read local files, ` +
      `and ${detail}. Allowed: ${allowed}. Leading options may only be ${['--pretty', ...BOT_PLATFORMS[platform].globalValueOptions].join(', ')}.`,
  }
}

function resolveInvocation(words: readonly string[]): { platform: BotPlatform; args: string[] } | undefined {
  let index = 0
  if (words[0] === 'bunx') index = 1
  else if (words[0] === 'bun' && words[1] === 'x') index = 2
  const bin = words[index]
  if (bin === undefined) return undefined
  // `bunx agent-<platform>` resolves an npm package of that name, not the
  // agent-messenger package, so only the umbrella package is accepted there.
  if (index === 0 && bin.startsWith('agent-')) {
    const platform = bin.slice('agent-'.length)
    if (isBotPlatform(platform)) return { platform, args: words.slice(1) }
  }
  if (bin === 'agent-messenger' || (index === 0 && bin === 'amsg')) {
    const platform = words[index + 1]
    if (isBotPlatform(platform)) return { platform, args: words.slice(index + 2) }
  }
  return undefined
}

function isBotPlatform(value: string | undefined): value is BotPlatform {
  return value !== undefined && Object.hasOwn(BOT_PLATFORMS, value)
}

const UNQUOTED_UNSAFE = new Set([';', '&', '|', '<', '>', '(', ')', '$', '`', '\\', '\n', '\r'])
const DOUBLE_QUOTED_UNSAFE = new Set(['$', '`', '\\'])

// A conservative word splitter: it does not emulate bash, it only proves the
// command has no shell construct that could start a second process or feed the
// CLI a file. Any doubt marks the command unsafe. Unquoted globs are rejected
// too, because the broker re-quotes argv and bash would otherwise expand them.
function scanWords(command: string): { words: string[]; safe: boolean } {
  const words: string[] = []
  let current = ''
  let inWord = false
  let quote: "'" | '"' | undefined
  let safe = true
  for (const char of command.trim()) {
    if (quote === "'") {
      if (char === "'") quote = undefined
      else current += char
      continue
    }
    if (quote === '"') {
      if (char === '"') quote = undefined
      else {
        if (DOUBLE_QUOTED_UNSAFE.has(char)) safe = false
        current += char
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      inWord = true
      continue
    }
    if (char === ' ' || char === '\t') {
      if (inWord) words.push(current)
      current = ''
      inWord = false
      continue
    }
    if (UNQUOTED_UNSAFE.has(char) || char === '*' || char === '?' || char === '[') safe = false
    if (char === '#' && !inWord) break
    current += char
    inWord = true
  }
  if (quote !== undefined) safe = false
  if (inWord) words.push(current)
  return { words, safe }
}
