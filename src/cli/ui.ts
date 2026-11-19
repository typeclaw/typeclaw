import { emitKeypressEvents as nodeEmitKeypressEvents } from 'node:readline'

import { cancel, intro, isCancel, log, note, outro, select, spinner as clackSpinner } from '@clack/prompts'

import { buildDiscordInviteUrl, deriveAppIdFromBotToken } from '@/channels/adapters/discord-bot-invite'
import { type AutoUpgradeOutcome, describeAutoUpgrade } from '@/init/auto-upgrade'
import { checkDiscordBotIntents, type DiscordBotIntentCheck } from '@/init/discord-bot-intents'
import { styled, type StyleFormat } from '@/shared'
import { COMPACT_WORDMARK, WORDMARK_LINES, WORDMARK_WIDTH } from '@/shared/wordmark'

export { cancel, intro, isCancel, log, note, outro }

type ClackInput = Pick<NodeJS.ReadStream, 'isTTY' | 'resume'>

type KeypressInterface = { escapeCodeTimeout?: number }

type PrepareStdinDeps = {
  emitKeypressEvents?: (stream: NodeJS.ReadableStream, iface: KeypressInterface) => void
}

// @clack/core@1.2.0 builds its readline interface with escapeCodeTimeout: 50 so
// a bare Esc (the cancel key) resolves fast. readline's keypress decoder binds
// that timeout ONCE, when emitKeypressEvents first installs it on the stream, and
// is a no-op on every later call — so pre-arming here without it would lock in
// readline's 500ms default and clack's own 50ms could never take effect.
const CLACK_ESCAPE_CODE_TIMEOUT_MS = 50

// Arm readline's keypress decoder on stdin before a clack picker reads it. Over
// an SSH pseudo-TTY, arrow keys arrive as raw `\x1b[A`/`\x1b[B` bytes and only
// become the `{ name: 'up' }` keypress events clack navigates on once that
// decoder is installed on THIS stream. After a prior raw-mode 'data' consumer or
// a pi-tui detach (ProcessTerminal.stop() pauses stdin), Bun does NOT re-arm the
// decoder when clack later calls createInterface({ terminal: true }), so the
// picker renders but arrows echo as `^[[A` and never advance. We pass clack's
// own escapeCodeTimeout so the pre-arm matches what clack would have set; raw
// mode is left to clack. Never pause() — a paused process.stdin does not
// reliably re-flow under Bun.
export function prepareStdinForClack(input: ClackInput = process.stdin, deps: PrepareStdinDeps = {}): void {
  if (!input.isTTY) return
  const emitKeypressEvents =
    deps.emitKeypressEvents ??
    ((stream: NodeJS.ReadableStream, iface: KeypressInterface) =>
      nodeEmitKeypressEvents(stream, iface as unknown as Parameters<typeof nodeEmitKeypressEvents>[1]))
  emitKeypressEvents(input as unknown as NodeJS.ReadableStream, { escapeCodeTimeout: CLACK_ESCAPE_CODE_TIMEOUT_MS })
  input.resume()
}

function colorize(modifier: StyleFormat, s: string): string {
  if (!colorsEnabled()) return s
  return styled(modifier, s)
}

// Re-evaluated per call so tests can mutate NO_COLOR / FORCE_COLOR between
// cases without stale module-load caching.
function colorsEnabled(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false
  if (process.env.FORCE_COLOR === '0') return false
  if (process.env.FORCE_COLOR) return true
  return Boolean(process.stdout.isTTY)
}

export const c = {
  cyan: (s: string) => colorize('cyan', s),
  green: (s: string) => colorize('green', s),
  red: (s: string) => colorize('red', s),
  yellow: (s: string) => colorize('yellow', s),
  dim: (s: string) => colorize('dim', s),
  gray: (s: string) => colorize('gray', s),
  magenta: (s: string) => colorize('magenta', s),
  bold: (s: string) => colorize('bold', s),
}

// OSC 8 hyperlink with plain fallback when colors are off so piped output
// and non-OSC-8 terminals stay readable.
export function link(text: string, url: string): string {
  if (!colorsEnabled()) return `${text} (${url})`
  return `\u001b]8;;${url}\u0007${text}\u001b]8;;\u0007`
}

// Brand truecolor sampled from the typeey mascot, matching src/tui/theme.ts.
// `c`/styled only carry the 16 named colors, so the cornflower/amber accents
// are emitted as raw 24-bit SGR — gated on colorsEnabled() so NO_COLOR and
// piped output never see an escape.
const CORNFLOWER_FG = '\x1b[38;2;91;127;212m'
const AMBER_FG = '\x1b[38;2;231;143;55m'
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'

const INIT_TAGLINE = 'the TypeScript-native agent runtime'

export function cornflower(s: string): string {
  if (!colorsEnabled()) return s
  return `${CORNFLOWER_FG}${s}${RESET}`
}

export type InitWelcomeOptions = {
  isTty: boolean
  columns: number
  colorsEnabled: boolean
}

export function renderInitWelcome(opts: InitWelcomeOptions): string {
  // Non-TTY (piped/CI): emit nothing so captured/redirected output stays clean.
  if (!opts.isTty) return ''
  const tagline = opts.colorsEnabled ? `${DIM}${INIT_TAGLINE}${RESET}` : INIT_TAGLINE
  if (opts.columns < WORDMARK_WIDTH + 2) {
    const mark = opts.colorsEnabled ? `${BOLD}${CORNFLOWER_FG}${COMPACT_WORDMARK}${RESET}` : COMPACT_WORDMARK
    return `${mark}\n${tagline}`
  }
  const art = opts.colorsEnabled
    ? WORDMARK_LINES.map((line) => `${CORNFLOWER_FG}${line}${RESET}`).join('\n')
    : WORDMARK_LINES.join('\n')
  return `${art}\n${tagline}`
}

export function printInitWelcome(output: NodeJS.WritableStream = process.stdout): void {
  const banner = renderInitWelcome({
    isTty: Boolean(process.stdout.isTTY),
    columns: process.stdout.columns ?? 80,
    colorsEnabled: colorsEnabled(),
  })
  if (banner === '') return
  // Pad above (clear the shell prompt) and below (separate from clack's intro).
  output.write(`\n${banner}\n\n`)
}

export function renderHatchedFlourish(opts: { isTty: boolean; colorsEnabled: boolean }): string {
  if (!opts.isTty) return ''
  if (!opts.colorsEnabled) return '✦ hatched!'
  return `${AMBER_FG}✦${RESET} ${CORNFLOWER_FG}hatched!${RESET}`
}

export function printHatchedFlourish(output: NodeJS.WritableStream = process.stdout): void {
  const line = renderHatchedFlourish({
    isTty: Boolean(process.stdout.isTTY),
    colorsEnabled: colorsEnabled(),
  })
  if (line === '') return
  output.write(`${line}\n`)
}

export type Spinner = {
  start: (msg?: string) => void
  stop: (msg?: string) => void
  error: (msg?: string) => void
  cancel: (msg?: string) => void
  message: (msg?: string) => void
}

export function spinner(): Spinner {
  const s = clackSpinner()
  return {
    start: (msg) => s.start(msg),
    stop: (msg) => s.stop(msg),
    error: (msg) => s.error(msg),
    cancel: (msg) => s.cancel(msg),
    message: (msg) => s.message(msg),
  }
}

export type StartLikeResult = {
  alreadyRunning?: boolean
  built: boolean
  plan: { containerName: string; imageTag: string }
  hostPort: number
  containerId: string
  hostd: { state: 'registered' } | { state: 'unavailable'; reason: string } | { state: 'disabled' }
  autoUpgrade?: AutoUpgradeOutcome
  skippedPlugins?: string[]
}

export function renderStartSuccess(result: StartLikeResult): string {
  const lines: string[] = []
  const name = c.cyan(result.plan.containerName)
  const port = c.green(String(result.hostPort))

  if (result.autoUpgrade) {
    const message = describeAutoUpgrade(result.autoUpgrade)
    if (message.length > 0) {
      const tint = result.autoUpgrade.kind === 'exact-pin-respected' ? c.yellow : c.cyan
      lines.push(tint(message))
    }
  }

  if (result.skippedPlugins && result.skippedPlugins.length > 0) {
    const list = result.skippedPlugins.join(', ')
    lines.push(`${c.yellow('Skipped plugins not found in the registry:')} ${list}`)
  }

  if (result.alreadyRunning) {
    lines.push(`${c.green('●')} ${name} is already running on host port ${port}.`)
  } else {
    if (result.built) {
      lines.push(`Built image ${c.cyan(result.plan.imageTag)}.`)
    }
    const shortId = result.containerId.slice(0, 12)
    lines.push(`${c.green('●')} ${name} started on host port ${port} ${c.dim(`(${shortId})`)}.`)
  }

  if (result.hostd.state === 'registered') {
    lines.push(c.dim('Host daemon active.'))
  } else if (result.hostd.state === 'unavailable') {
    lines.push(`${c.yellow('Host daemon unavailable:')} ${result.hostd.reason}`)
  }

  lines.push('')
  lines.push(`${c.dim('Follow logs:')}  ${c.cyan('typeclaw logs -f')}`)
  lines.push(`${c.dim('Attach TUI:')}   ${c.cyan('typeclaw tui')}`)
  lines.push(`${c.dim('Stop:')}         ${c.cyan('typeclaw stop')}`)

  return lines.join('\n')
}

export type NextStepHint = { label: string; command: string }

// `details` goes into the body, not the title: clack's `note()` sizes the
// box to the title's visual width and never wraps titles, so a long title
// breaks the layout on narrow terminals. Body content is wrapped to fit.
export function done(opts: { title: string; details?: string; hints: NextStepHint[] }): void {
  const lines: string[] = []
  if (opts.details !== undefined && opts.details !== '') lines.push(opts.details)
  for (const h of opts.hints) lines.push(`${c.dim(h.label)}  ${c.cyan(h.command)}`)
  note(lines.join('\n'), opts.title)
  outro(c.green('Done.'))
}

export function errorLine(reason: string): string {
  return `${c.red('✖')} ${reason}`
}

export function successLine(message: string): string {
  return `${c.green('●')} ${message}`
}

export function warnLine(message: string): string {
  return `${c.yellow('⚠')} ${message}`
}

// Single host-side sink for non-fatal validateConfig warnings (e.g. a
// curl|bash docker.file.append line). Every CLI gate that calls validateConfig
// before a start/rebuild routes through this so no path silently drops them.
export function reportConfigWarnings(warnings: string[] | undefined): void {
  for (const warning of warnings ?? []) {
    console.warn(warnLine(warning))
  }
}

// The exact JSON manifest a user pastes into
// https://api.slack.com/apps → From a manifest. Kept as a typed object so
// the file stays a single source of truth and `JSON.stringify` guarantees
// the rendered text is always valid JSON — no risk of a stray comma or
// quote slipping in through hand-formatting.
export const SLACK_APP_MANIFEST = {
  display_information: { name: 'TypeClaw' },
  features: {
    bot_user: { display_name: 'TypeClaw', always_online: true },
    // Enable the Messages tab so users can DM the bot from its app profile,
    // and disable the Home tab — TypeClaw does not publish a custom App Home
    // view, and leaving it enabled would surface an empty default tab.
    app_home: {
      home_tab_enabled: false,
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: false,
    },
    // Slash commands listed here appear in Slack's compose-box picker with
    // their description as a tooltip. `url` is required by Slack's manifest
    // schema even for Socket Mode bots, but is ignored at runtime when the
    // app is in Socket Mode — Slack delivers `slash_commands` envelopes
    // over the same WebSocket as message events. We point it at a
    // deliberately-invalid placeholder (RFC 6761 reserved .invalid TLD)
    // so a misconfigured (non-Socket-Mode) deployment fails fast rather
    // than silently routing real slash invocations to a third-party URL.
    slash_commands: [
      {
        command: '/help',
        description: 'List available commands',
        url: 'https://example.invalid/typeclaw-uses-socket-mode',
        should_escape: false,
      },
      {
        command: '/stop',
        description: 'Abort the current turn in this channel',
        // usage_hint is intentionally omitted. Slack's manifest validator
        // rejects an empty string ("Must be more than 0 characters") but
        // the field is optional, so the cleanest answer is to leave it out
        // rather than invent placeholder text for a command that takes no
        // arguments.
        url: 'https://example.invalid/typeclaw-uses-socket-mode',
        should_escape: false,
      },
      {
        command: '/reload',
        description: 'Reload typeclaw config and subsystems from disk',
        url: 'https://example.invalid/typeclaw-uses-socket-mode',
        should_escape: false,
      },
      {
        command: '/restart',
        description: 'Restart the typeclaw container',
        url: 'https://example.invalid/typeclaw-uses-socket-mode',
        should_escape: false,
      },
    ],
  },
  oauth_config: {
    scopes: {
      // Ordered alphabetically so the manifest stays a stable diff target.
      // Read scopes cover every conversation type the agent might observe;
      // write scopes (chat, files, im/mpim/groups, pins, reactions) let the
      // agent post replies, upload attachments, open DMs, pin messages, and
      // react to messages. `channels:join` lets the bot self-join public
      // channels it's invited to discuss in. `commands` is required for
      // Slack to deliver `slash_commands` envelopes — without it, slash
      // commands registered in `features` would silently fail to route.
      bot: [
        'app_mentions:read',
        'channels:history',
        'channels:join',
        'channels:read',
        'chat:write',
        'commands',
        'emoji:read',
        'files:read',
        'files:write',
        'groups:history',
        'groups:read',
        'groups:write',
        'im:history',
        'im:read',
        'im:write',
        'mpim:history',
        'mpim:read',
        'mpim:write',
        'pins:read',
        'pins:write',
        'reactions:read',
        'reactions:write',
        'users:read',
      ],
    },
  },
  settings: {
    event_subscriptions: {
      bot_events: ['app_mention', 'message.channels', 'message.groups', 'message.im', 'message.mpim'],
    },
    socket_mode_enabled: true,
  },
} as const

// Prints the "create a Slack app from a manifest" walkthrough so the JSON
// payload is **flush-left and copy-pasteable**. Clack's `note()` wraps
// content inside a box with `│` borders on both sides, and `log.message()`
// still prefixes every line with a `│  ` guide column — neither survives a
// click-and-drag copy. This helper splits the walkthrough into three
// segments: a boxed prose intro, a raw-stdout JSON block, and a boxed
// follow-up. The JSON block is emitted via `process.stdout.write` so it
// carries zero terminal decoration.
export function printSlackAppManifestSetup(output: NodeJS.WritableStream = process.stdout): void {
  note(
    [
      '1. https://api.slack.com/apps → Create New App → From a manifest.',
      '   Pick your workspace, then paste the JSON manifest printed below',
      `   (it is rendered flush-left so you can ${c.bold('click-drag and copy')} cleanly).`,
    ].join('\n'),
    'Get a Slack bot',
  )
  output.write('\n')
  output.write(`${JSON.stringify(SLACK_APP_MANIFEST, null, 2)}\n`)
  output.write('\n')
  note(
    [
      '2. Install to Workspace, then OAuth & Permissions →',
      '   copy the Bot User OAuth Token (xoxb-...).',
      '3. Basic Information → App-Level Tokens → Generate Token and',
      '   Scopes, add the connections:write scope, and copy the',
      '   token (xapp-...). Socket Mode needs this; the manifest',
      '   cannot grant it.',
      '4. Invite the bot to any private channel or DM you want it in:',
      '   /invite @TypeClaw',
    ].join('\n'),
    'Finish Slack setup',
  )
}

// Discord's portal hands out a bot token but no invite URL — operators have to
// hunt down Application ID → OAuth2 Generator → tick scopes → tick permissions
// → copy. We short-circuit all of that: the application id is encoded in the
// token's first base64 segment, so we can hand back a click-ready URL with
// the exact permission bitfield the adapter uses. No-ops when the token isn't
// parseable as a Discord bot token so we never block onboarding on best-effort
// guidance.
export function printDiscordInviteHint(token: string, output: NodeJS.WritableStream = process.stdout): void {
  const appId = deriveAppIdFromBotToken(token)
  if (appId === null) return
  // URL stays OUT of note(): clack wraps long lines with a `│` gutter that
  // corrupts copy-pasted URLs. Same fix as src/cli/oauth-callbacks.ts.
  note(
    [
      'Open the URL below, pick a server, click Authorize.',
      "The bot won't receive messages until it's in at least one server.",
    ].join('\n'),
    'Invite the bot to a server',
  )
  output.write(`${buildDiscordInviteUrl(appId)}\n`)
  output.write('\n')
}

// The adapter always requests MESSAGE CONTENT, so a missing toggle means the
// gateway refuses the bot (close 4014) and the agent never comes up. Hold the
// operator here until it is enabled or they explicitly move on. A failed check
// (network, unexpected response) only warns: it must never block onboarding.
export async function confirmDiscordBotIntents(
  token: string,
  {
    check = checkDiscordBotIntents,
    choose = chooseAfterMissingMessageContent,
  }: {
    check?: (token: string) => Promise<DiscordBotIntentCheck>
    choose?: () => Promise<'recheck' | 'continue' | 'cancel'>
  } = {},
): Promise<'continue' | 'cancel'> {
  for (;;) {
    const s = spinner()
    s.start('Checking the Discord bot settings')
    const result = await check(token)
    if (result.status === 'ok') {
      s.stop('Discord privileged intents are enabled.')
      return 'continue'
    }
    if (result.status === 'unchecked') {
      s.stop(`Couldn't verify Discord privileged intents: ${result.reason}`)
      return 'continue'
    }
    s.error(`Discord privileged intents are off: ${result.intents.join(', ')}`)
    const appId = deriveAppIdFromBotToken(token)
    note(
      [
        'Open the Bot page below, then under Privileged Gateway Intents',
        `enable ${result.intents.join(' and ')} and click Save Changes.`,
        ...(result.intents.includes('MESSAGE CONTENT')
          ? ["Without MESSAGE CONTENT, Discord refuses the bot's connection and the agent stays offline."]
          : []),
      ].join('\n'),
      'Enable Discord privileged intents',
    )
    process.stdout.write(
      `${appId === null ? 'https://discord.com/developers/applications' : `https://discord.com/developers/applications/${appId}/bot`}\n\n`,
    )
    if (!result.intents.includes('MESSAGE CONTENT')) return 'continue'
    const next = await choose()
    if (next !== 'recheck') return next
  }
}

async function chooseAfterMissingMessageContent(): Promise<'recheck' | 'continue' | 'cancel'> {
  const next = await select<'recheck' | 'continue'>({
    message: 'Message Content intent is required',
    options: [
      { value: 'recheck', label: "I've enabled it, check again" },
      { value: 'continue', label: 'Continue anyway (the bot will not connect)' },
    ],
  })
  return isCancel(next) ? 'cancel' : next
}
