import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { SLACK_SLASH_COMMAND_NAMES } from '@/channels/adapters/slack-bot'
import type { DiscordBotIntentCheck } from '@/init/discord-bot-intents'
import { WORDMARK_LINES } from '@/shared/wordmark'

import {
  c,
  confirmDiscordBotIntents,
  cornflower,
  done,
  errorLine,
  link,
  prepareStdinForClack,
  printDiscordInviteHint,
  printSlackAppManifestSetup,
  renderHatchedFlourish,
  renderInitWelcome,
  renderStartSuccess,
  SLACK_APP_MANIFEST,
  spinner,
  successLine,
  type StartLikeResult,
} from './ui'

const CORNFLOWER_ESCAPE = '\x1b[38;2;91;127;212m'
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`)

const ENV_KEYS = ['NO_COLOR', 'FORCE_COLOR'] as const

function withForcedColor<T>(fn: () => T): T {
  const prev: Record<string, string | undefined> = {}
  for (const k of ENV_KEYS) prev[k] = process.env[k]
  process.env.NO_COLOR = ''
  process.env.FORCE_COLOR = '1'
  try {
    return fn()
  } finally {
    for (const k of ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  }
}

function withNoColor<T>(fn: () => T): T {
  const prev: Record<string, string | undefined> = {}
  for (const k of ENV_KEYS) prev[k] = process.env[k]
  process.env.NO_COLOR = '1'
  delete process.env.FORCE_COLOR
  try {
    return fn()
  } finally {
    for (const k of ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  }
}

describe('c.*', () => {
  test('wraps text with cyan ANSI when colors are forced', () => {
    const out = withForcedColor(() => c.cyan('hello'))
    expect(out).toContain('hello')
    expect(out).toContain('\u001b[36m')
  })

  test('returns the raw string when NO_COLOR is set', () => {
    const out = withNoColor(() => c.cyan('hello'))
    expect(out).toBe('hello')
  })

  test('every color helper preserves the input text', () => {
    withForcedColor(() => {
      for (const key of ['cyan', 'green', 'red', 'yellow', 'dim', 'gray', 'magenta', 'bold'] as const) {
        expect(c[key]('PAYLOAD')).toContain('PAYLOAD')
      }
    })
  })

  test('bold uses the bold ANSI code under forced color', () => {
    const out = withForcedColor(() => c.bold('X'))
    expect(out).toContain('\u001b[1m')
  })
})

describe('link', () => {
  test('emits OSC 8 sequence around the text when colors are on', () => {
    const out = withForcedColor(() => link('Docs', 'https://example.com'))
    expect(out).toContain('Docs')
    expect(out).toContain('https://example.com')
    expect(out).toContain('\u001b]8;;')
  })

  test('falls back to "text (url)" when NO_COLOR is set', () => {
    const out = withNoColor(() => link('Docs', 'https://example.com'))
    expect(out).toBe('Docs (https://example.com)')
  })
})

describe('cornflower', () => {
  test('wraps text in 24-bit cornflower SGR under forced color', () => {
    const out = withForcedColor(() => cornflower('●'))
    expect(out).toBe(`${CORNFLOWER_ESCAPE}●\x1b[0m`)
  })

  test('returns the raw string under NO_COLOR', () => {
    expect(withNoColor(() => cornflower('●'))).toBe('●')
  })
})

describe('renderInitWelcome', () => {
  test('emits the full 6-row art with cornflower color when colors are on', () => {
    const out = renderInitWelcome({ isTty: true, columns: 120, colorsEnabled: true })
    expect(out).toContain(CORNFLOWER_ESCAPE)
    expect(out).toContain(WORDMARK_LINES[0]!)
    expect(out).toContain('the TypeScript-native agent runtime')
  })

  test('emits plain art with ZERO escapes when colors are off (NO_COLOR)', () => {
    const out = renderInitWelcome({ isTty: true, columns: 120, colorsEnabled: false })
    expect(out).toContain(WORDMARK_LINES[0]!)
    expect(ANSI_PATTERN.test(out)).toBe(false)
  })

  test('falls back to the compact wordmark on a narrow terminal', () => {
    const out = renderInitWelcome({ isTty: true, columns: 40, colorsEnabled: true })
    expect(out).toContain('typeclaw')
    expect(out).not.toContain(WORDMARK_LINES[0]!)
  })

  test('narrow + NO_COLOR yields a plain single-line wordmark with no escapes', () => {
    const out = renderInitWelcome({ isTty: true, columns: 40, colorsEnabled: false })
    expect(out.split('\n')[0]).toBe('typeclaw')
    expect(ANSI_PATTERN.test(out)).toBe(false)
  })

  test('emits nothing when stdout is not a TTY (piped/CI)', () => {
    expect(renderInitWelcome({ isTty: false, columns: 120, colorsEnabled: true })).toBe('')
  })
})

describe('renderHatchedFlourish', () => {
  test('emits a single brand-colored line when colors are on', () => {
    const out = renderHatchedFlourish({ isTty: true, colorsEnabled: true })
    expect(out).toContain('hatched!')
    expect(out).toContain(CORNFLOWER_ESCAPE)
    expect(out).not.toContain('\n')
  })

  test('emits a plain line with no escapes under NO_COLOR', () => {
    const out = renderHatchedFlourish({ isTty: true, colorsEnabled: false })
    expect(out).toBe('✦ hatched!')
    expect(ANSI_PATTERN.test(out)).toBe(false)
  })

  test('emits nothing when stdout is not a TTY', () => {
    expect(renderHatchedFlourish({ isTty: false, colorsEnabled: true })).toBe('')
  })
})

describe('renderStartSuccess', () => {
  function baseResult(overrides: Partial<StartLikeResult> = {}): StartLikeResult {
    return {
      built: false,
      plan: { containerName: 'coder', imageTag: 'typeclaw-coder' },
      hostPort: 8973,
      containerId: 'abcdef0123456789',
      hostd: { state: 'registered' },
      ...overrides,
    }
  }

  test('renders the "started" path with container name, port, and short id', () => {
    const out = withNoColor(() => renderStartSuccess(baseResult()))
    expect(out).toContain('coder')
    expect(out).toContain('started on host port 8973')
    expect(out).toContain('abcdef012345')
    expect(out).not.toContain('abcdef0123456789')
  })

  test('renders the "already running" path with the same name + port', () => {
    const out = withNoColor(() => renderStartSuccess(baseResult({ alreadyRunning: true })))
    expect(out).toContain('coder')
    expect(out).toContain('is already running on host port 8973')
    expect(out).not.toContain('started on host port')
  })

  test('renders a "Built image" line only when built is true', () => {
    const builtOut = withNoColor(() => renderStartSuccess(baseResult({ built: true })))
    expect(builtOut).toContain('Built image typeclaw-coder.')

    const unbuiltOut = withNoColor(() => renderStartSuccess(baseResult({ built: false })))
    expect(unbuiltOut).not.toContain('Built image')
  })

  test('renders "Host daemon active." when hostd is registered', () => {
    const out = withNoColor(() => renderStartSuccess(baseResult()))
    expect(out).toContain('Host daemon active.')
  })

  test('renders a yellow warning line when hostd is unavailable', () => {
    const out = withForcedColor(() =>
      renderStartSuccess(baseResult({ hostd: { state: 'unavailable', reason: 'socket missing' } })),
    )
    expect(out).toContain('Host daemon unavailable:')
    expect(out).toContain('socket missing')
    expect(out).toContain('\u001b[33m')
  })

  test('omits the hostd line entirely when hostd is disabled', () => {
    const out = withNoColor(() => renderStartSuccess(baseResult({ hostd: { state: 'disabled' } })))
    expect(out).not.toContain('Host daemon')
  })

  test('always includes the three next-step command hints', () => {
    const out = withNoColor(() => renderStartSuccess(baseResult()))
    expect(out).toContain('typeclaw logs -f')
    expect(out).toContain('typeclaw tui')
    expect(out).toContain('typeclaw stop')
  })

  test('color-wraps the port number under forced color', () => {
    const out = withForcedColor(() => renderStartSuccess(baseResult()))
    expect(out).toContain('\u001b[32m8973')
    expect(out).toContain('\u001b[36mcoder')
  })

  test('omits any auto-upgrade line on no-op outcomes (silent on no-op)', () => {
    for (const upgrade of [
      { kind: 'up-to-date', installedVersion: '0.1.2' } as const,
      { kind: 'skipped-dev-mode' } as const,
      { kind: 'skipped-no-dep' } as const,
      { kind: 'skipped-already-running' } as const,
      { kind: 'skipped-non-release-spec', declared: 'latest' } as const,
    ]) {
      const out = withNoColor(() => renderStartSuccess(baseResult({ autoUpgrade: upgrade })))
      expect(out).not.toContain('Upgrading')
      expect(out).not.toContain('exact-pinned')
    }
  })

  test('renders the cyan upgrade line on spec-rewritten', () => {
    const out = withForcedColor(() =>
      renderStartSuccess(
        baseResult({ autoUpgrade: { kind: 'spec-rewritten', from: '^0.1.0', to: '^0.2.0', cliVersion: '0.2.0' } }),
      ),
    )
    expect(out).toContain('Upgrading agent typeclaw ^0.1.0')
    expect(out).toContain('^0.2.0')
    expect(out).toContain('\u001b[36m')
  })

  test('renders the cyan upgrade line on reinstall-needed', () => {
    const out = withForcedColor(() =>
      renderStartSuccess(baseResult({ autoUpgrade: { kind: 'reinstall-needed', from: '0.1.0', to: '0.1.2' } })),
    )
    expect(out).toContain('Upgrading agent typeclaw 0.1.0 → 0.1.2')
    expect(out).toContain('\u001b[36m')
  })

  test('renders the yellow warning line on exact-pin-respected', () => {
    const out = withForcedColor(() =>
      renderStartSuccess(
        baseResult({ autoUpgrade: { kind: 'exact-pin-respected', declared: '0.1.0', cliVersion: '0.1.2' } }),
      ),
    )
    expect(out).toContain('exact-pinned to 0.1.0')
    expect(out).toContain('CLI is 0.1.2')
    expect(out).toContain('\u001b[33m')
  })

  test('places the upgrade line ABOVE the "started on host port" line', () => {
    const out = withNoColor(() =>
      renderStartSuccess(
        baseResult({ autoUpgrade: { kind: 'spec-rewritten', from: '^0.1.0', to: '^0.2.0', cliVersion: '0.2.0' } }),
      ),
    )
    const upgradeIdx = out.indexOf('Upgrading')
    const startedIdx = out.indexOf('started on host port')
    expect(upgradeIdx).toBeGreaterThanOrEqual(0)
    expect(startedIdx).toBeGreaterThan(upgradeIdx)
  })

  test('renders a yellow warning listing plugins skipped as not found', () => {
    const out = withForcedColor(() =>
      renderStartSuccess(baseResult({ skippedPlugins: ['foo-bar', 'typeclaw-plugin-missing'] })),
    )
    expect(out).toContain('Skipped plugins not found in the registry:')
    expect(out).toContain('foo-bar')
    expect(out).toContain('typeclaw-plugin-missing')
    expect(out).toContain('\u001b[33m')
  })

  test('omits the skipped-plugins line when none were skipped', () => {
    const emptyOut = withNoColor(() => renderStartSuccess(baseResult({ skippedPlugins: [] })))
    const undefinedOut = withNoColor(() => renderStartSuccess(baseResult()))
    expect(emptyOut).not.toContain('Skipped plugins')
    expect(undefinedOut).not.toContain('Skipped plugins')
  })

  test('still reports start success even when a plugin was skipped', () => {
    const out = withNoColor(() => renderStartSuccess(baseResult({ skippedPlugins: ['foo-bar'] })))
    expect(out).toContain('started on host port 8973')
  })
})

describe('errorLine / successLine', () => {
  test('errorLine prefixes with a red ✖', () => {
    const out = withForcedColor(() => errorLine('something broke'))
    expect(out).toContain('something broke')
    expect(out).toContain('✖')
    expect(out).toContain('\u001b[31m')
  })

  test('successLine prefixes with a green ●', () => {
    const out = withForcedColor(() => successLine('did the thing'))
    expect(out).toContain('did the thing')
    expect(out).toContain('●')
    expect(out).toContain('\u001b[32m')
  })

  test('neither emits color escapes under NO_COLOR', () => {
    withNoColor(() => {
      expect(errorLine('x')).toBe('✖ x')
      expect(successLine('y')).toBe('● y')
    })
  })
})

describe('done', () => {
  const ANSI = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, 'g')

  function captureStdout<T>(fn: () => T): { result: T; output: string } {
    const original = process.stdout.write.bind(process.stdout)
    let buf = ''
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      return true
    }) as typeof process.stdout.write
    try {
      const result = fn()
      return { result, output: buf.replace(ANSI, '') }
    } finally {
      process.stdout.write = original
    }
  }

  test('renders a box whose width fits the terminal even when details is very long', () => {
    const { output } = captureStdout(() =>
      withNoColor(() =>
        done({
          title: 'Profile "default" set.',
          details: 'default → fireworks/accounts/fireworks/routers/kimi-k2p6-turbo',
          hints: [{ label: 'If the agent is running:', command: 'typeclaw reload' }],
        }),
      ),
    )

    const widths = [...output.matchAll(/^[│├└][^\n]*$/gm)].map((m) => m[0].length)
    const maxWidth = Math.max(0, ...widths)
    expect(maxWidth).toBeLessThanOrEqual(80)
    expect(output).toContain('Profile "default" set.')
    expect(output).toContain('default → fireworks/accounts/fireworks/routers/kimi-k2p6-turbo')
    expect(output).toContain('typeclaw reload')
  })

  test('renders only hints when details is omitted (back-compat)', () => {
    const { output } = captureStdout(() =>
      withNoColor(() =>
        done({
          title: 'Short title.',
          hints: [{ label: 'Next:', command: 'typeclaw start' }],
        }),
      ),
    )
    expect(output).toContain('Short title.')
    expect(output).toContain('typeclaw start')
  })

  test('places details ABOVE hints in the rendered body', () => {
    const { output } = captureStdout(() =>
      withNoColor(() =>
        done({
          title: 'Profile set.',
          details: 'DETAILS_MARKER',
          hints: [{ label: 'Hint:', command: 'HINTS_MARKER' }],
        }),
      ),
    )
    const detailsIdx = output.indexOf('DETAILS_MARKER')
    const hintsIdx = output.indexOf('HINTS_MARKER')
    expect(detailsIdx).toBeGreaterThanOrEqual(0)
    expect(hintsIdx).toBeGreaterThan(detailsIdx)
  })

  test('treats empty details as omitted (same shape as missing details)', () => {
    const withEmpty = captureStdout(() =>
      withNoColor(() =>
        done({
          title: 'Profile set.',
          details: '',
          hints: [{ label: 'Hint:', command: 'typeclaw reload' }],
        }),
      ),
    ).output
    const without = captureStdout(() =>
      withNoColor(() =>
        done({
          title: 'Profile set.',
          hints: [{ label: 'Hint:', command: 'typeclaw reload' }],
        }),
      ),
    ).output
    expect(withEmpty).toBe(without)
  })
})

describe('spinner', () => {
  const originalIsTTY = process.stdout.isTTY

  beforeEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
  })

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true })
  })

  test('start/stop/message/error do not throw on a non-TTY stdout', () => {
    const s = spinner()
    expect(() => {
      s.start('working...')
      s.message('still working')
      s.stop('done')
    }).not.toThrow()
  })

  test('error() finalizes the spinner with a non-zero code', () => {
    const s = spinner()
    expect(() => {
      s.start('working...')
      s.error('boom')
    }).not.toThrow()
  })
})

describe('prepareStdinForClack', () => {
  type FakeStdin = {
    isTTY: boolean
    resumed: number
    resume: () => void
  }

  function fakeStdin(opts: { isTTY: boolean }): FakeStdin {
    return {
      isTTY: opts.isTTY,
      resumed: 0,
      resume() {
        this.resumed += 1
      },
    }
  }

  test('arms readline keypress decoding on stdin so arrow bytes become keypress events', () => {
    // given: a TTY whose readline keypress decoder is not yet armed (SSH first-picker)
    const stdin = fakeStdin({ isTTY: true })
    const armed: unknown[] = []
    // when: handing stdin to clack
    prepareStdinForClack(stdin as unknown as NodeJS.ReadStream, {
      emitKeypressEvents: (stream) => armed.push(stream),
    })
    // then: the keypress decoder is installed on that exact stream
    expect(armed).toEqual([stdin])
  })

  test('pre-arms with clack 1.2.0 escapeCodeTimeout (50ms) so bare Esc stays fast', () => {
    // readline binds escapeCodeTimeout once, when the decoder is first installed,
    // and no-ops on clack's later createInterface — so the pre-arm MUST carry
    // clack's 50ms or a bare Esc falls back to readline's 500ms default.
    const stdin = fakeStdin({ isTTY: true })
    let ifaceArg: { escapeCodeTimeout?: number } | undefined
    prepareStdinForClack(stdin as unknown as NodeJS.ReadStream, {
      emitKeypressEvents: (_stream, iface) => {
        ifaceArg = iface
      },
    })
    expect(ifaceArg?.escapeCodeTimeout).toBe(50)
  })

  test('arms keypress decoding BEFORE resuming so no keystroke is missed', () => {
    const order: string[] = []
    const stdin = {
      isTTY: true,
      resume: () => order.push('resume'),
    }
    prepareStdinForClack(stdin as unknown as NodeJS.ReadStream, {
      emitKeypressEvents: () => order.push('emitKeypressEvents'),
    })
    expect(order).toEqual(['emitKeypressEvents', 'resume'])
  })

  test('resumes stdin so the flowing stream feeds clack the decoded keypresses', () => {
    const stdin = fakeStdin({ isTTY: true })
    prepareStdinForClack(stdin as unknown as NodeJS.ReadStream, { emitKeypressEvents: () => {} })
    expect(stdin.resumed).toBeGreaterThanOrEqual(1)
  })

  test('is a no-op on a non-TTY stdin (piped/redirected input)', () => {
    const stdin = fakeStdin({ isTTY: false })
    const armed: unknown[] = []
    prepareStdinForClack(stdin as unknown as NodeJS.ReadStream, {
      emitKeypressEvents: (stream) => armed.push(stream),
    })
    expect(stdin.resumed).toBe(0)
    expect(armed).toEqual([])
  })
})

describe('printSlackAppManifestSetup', () => {
  const ANSI = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, 'g')

  function captureStdout<T>(fn: () => T): { result: T; output: string } {
    const original = process.stdout.write.bind(process.stdout)
    let buf = ''
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      return true
    }) as typeof process.stdout.write
    try {
      const result = fn()
      return { result, output: buf.replace(ANSI, '') }
    } finally {
      process.stdout.write = original
    }
  }

  test('emits the JSON manifest flush-left so it is copy-pasteable', () => {
    const { output } = captureStdout(() => withNoColor(() => printSlackAppManifestSetup()))

    const jsonStart = output.indexOf('\n{\n')
    const jsonEnd = output.indexOf('\n}\n', jsonStart)
    expect(jsonStart).toBeGreaterThanOrEqual(0)
    expect(jsonEnd).toBeGreaterThan(jsonStart)

    const jsonBlock = output.slice(jsonStart + 1, jsonEnd + 2)
    for (const line of jsonBlock.split('\n')) {
      if (line === '') continue
      expect(line.startsWith('│')).toBe(false)
      expect(line.startsWith('|')).toBe(false)
    }

    expect(() => JSON.parse(jsonBlock) as unknown).not.toThrow()
    expect(JSON.parse(jsonBlock)).toEqual(SLACK_APP_MANIFEST)
  })

  test('manifest declares the scopes Socket Mode + Events + Web API need', () => {
    const scopes = SLACK_APP_MANIFEST.oauth_config.scopes.bot
    expect(scopes).toContain('app_mentions:read')
    expect(scopes).toContain('chat:write')
    expect(scopes).toContain('channels:history')
    expect(scopes).toContain('groups:history')
    expect(scopes).toContain('im:history')
    expect(scopes).toContain('mpim:history')

    const events = SLACK_APP_MANIFEST.settings.event_subscriptions.bot_events
    expect(events).toContain('app_mention')
    expect(events).toContain('message.channels')
    expect(events).toContain('message.im')

    expect(SLACK_APP_MANIFEST.settings.socket_mode_enabled).toBe(true)
  })

  test('manifest grants write scopes for replies, attachments, pins, and reactions', () => {
    const scopes = SLACK_APP_MANIFEST.oauth_config.scopes.bot
    expect(scopes).toContain('channels:join')
    expect(scopes).toContain('files:write')
    expect(scopes).toContain('groups:write')
    expect(scopes).toContain('im:write')
    expect(scopes).toContain('mpim:write')
    expect(scopes).toContain('pins:read')
    expect(scopes).toContain('pins:write')
    expect(scopes).toContain('reactions:read')
    expect(scopes).toContain('reactions:write')
    expect(scopes).toContain('emoji:read')
  })

  test('manifest slash commands stay in sync with the runtime allow-list', () => {
    const manifestNames = new Set(SLACK_APP_MANIFEST.features.slash_commands.map((c) => c.command.replace(/^\//, '')))
    expect(manifestNames).toEqual(new Set(SLACK_SLASH_COMMAND_NAMES))
  })

  test('manifest declares the app a Slack agent so the adapter can enter agent mode', () => {
    expect(SLACK_APP_MANIFEST.features.agent_view.agent_description.length).toBeLessThanOrEqual(300)
    expect(SLACK_APP_MANIFEST.oauth_config.scopes.bot).toContain('assistant:write')
    expect(SLACK_APP_MANIFEST.features.app_home.agent_tasks_enabled).toBe(false)
  })

  test('manifest subscribes to agent_session_stopped so Slack shows the stop button', () => {
    expect(SLACK_APP_MANIFEST.settings.event_subscriptions.bot_events).toContain('agent_session_stopped')
  })

  test('manifest grants the `commands` scope so slash_commands envelopes can route', () => {
    expect(SLACK_APP_MANIFEST.oauth_config.scopes.bot).toContain('commands')
  })

  test('slash command url is an invalid placeholder (Socket Mode ignores it; misconfigured deploys fail fast)', () => {
    const stop = SLACK_APP_MANIFEST.features.slash_commands.find((c) => c.command === '/stop')
    expect(stop).toBeDefined()
    expect(stop!.url).toContain('example.invalid')
  })
})

describe('printDiscordInviteHint', () => {
  const ANSI = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, 'g')

  function captureStdout<T>(fn: () => T): { result: T; output: string } {
    const original = process.stdout.write.bind(process.stdout)
    let buf = ''
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      return true
    }) as typeof process.stdout.write
    try {
      const result = fn()
      return { result, output: buf.replace(ANSI, '') }
    } finally {
      process.stdout.write = original
    }
  }

  function tokenForAppId(appId: string): string {
    const head = Buffer.from(appId, 'utf-8').toString('base64').replace(/=+$/, '')
    return `${head}.G49NjP.pD8PLpKp-Xx8sr-8m1DCxSPTJZdcpcJZOExc1c`
  }

  test('emits the invite URL on its own flush-left line so it copy-pastes cleanly', () => {
    const { output } = captureStdout(() =>
      withNoColor(() => printDiscordInviteHint(tokenForAppId('968556348390391859'))),
    )

    const urlLine = output.split('\n').find((line) => line.includes('discord.com/oauth2/authorize'))
    expect(urlLine).toBeDefined()
    // flush-left: the URL line carries no clack box gutter that would corrupt a copy
    expect(urlLine!.startsWith('│')).toBe(false)
    expect(urlLine!.startsWith('|')).toBe(false)
    expect(urlLine).toContain('client_id=968556348390391859')

    expect(output).toContain('Invite the bot to a server')
    expect(output).toContain('pick a server')
  })

  test('writes nothing when the token is not a parseable Discord bot token', () => {
    const { output } = captureStdout(() => withNoColor(() => printDiscordInviteHint('not-a-token')))
    expect(output).toBe('')
  })
})

describe('confirmDiscordBotIntents', () => {
  async function run(
    results: DiscordBotIntentCheck[],
    choices: ('recheck' | 'continue' | 'cancel')[] = [],
  ): Promise<{ outcome: 'continue' | 'cancel'; checks: number; prompts: number }> {
    let checks = 0
    let prompts = 0
    const original = process.stdout.write.bind(process.stdout)
    process.stdout.write = (() => true) as typeof process.stdout.write
    try {
      const outcome = await confirmDiscordBotIntents('token', {
        check: async () => results[checks++]!,
        choose: async () => choices[prompts++]!,
      })
      return { outcome, checks, prompts }
    } finally {
      process.stdout.write = original
    }
  }

  const messageContentOff: DiscordBotIntentCheck = { status: 'missing', intents: ['MESSAGE CONTENT'] }

  test('continues without prompting when the intents are enabled', async () => {
    expect(await run([{ status: 'ok' }])).toEqual({ outcome: 'continue', checks: 1, prompts: 0 })
  })

  test('continues without prompting when only Server Members is off', async () => {
    expect(await run([{ status: 'missing', intents: ['SERVER MEMBERS'] }])).toEqual({
      outcome: 'continue',
      checks: 1,
      prompts: 0,
    })
  })

  test('continues without prompting when the check could not run', async () => {
    expect(await run([{ status: 'unchecked', reason: 'offline' }])).toEqual({
      outcome: 'continue',
      checks: 1,
      prompts: 0,
    })
  })

  test('check again reads fresh settings and continues once Message Content is on', async () => {
    expect(await run([messageContentOff, messageContentOff, { status: 'ok' }], ['recheck', 'recheck'])).toEqual({
      outcome: 'continue',
      checks: 3,
      prompts: 2,
    })
  })

  test('continue anyway proceeds while Message Content is still off', async () => {
    expect(await run([messageContentOff], ['continue'])).toEqual({ outcome: 'continue', checks: 1, prompts: 1 })
  })

  test('escape on the prompt cancels', async () => {
    expect(await run([messageContentOff], ['cancel'])).toEqual({ outcome: 'cancel', checks: 1, prompts: 1 })
  })
})
