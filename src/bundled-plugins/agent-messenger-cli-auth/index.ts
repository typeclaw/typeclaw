import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix, sep } from 'node:path'

import {
  type DeferredBashPreparation,
  type DeferredBashPreparationResult,
  TYPECLAW_INTERNAL_BASH_ENV,
  TYPECLAW_INTERNAL_BASH_PREPARE,
} from '@/agent/plugin-tools'
import type { SessionOrigin } from '@/agent/session-origin'
import { CORE_PERMISSIONS } from '@/permissions/builtins'
import type { PermissionService } from '@/permissions/permissions'
import { definePlugin, type Hooks } from '@/plugin'
import { resolveHiddenPaths } from '@/sandbox/hidden-paths'

import { analyzeAgentMessengerCommand, BOT_PLATFORMS, type BotPlatform } from './command'

// Fixed and outside every agent/tmp bind: each bwrap call gets its own mount
// namespace, so a command without a minted profile never sees this path.
export const MINTED_PROFILE_SANDBOX_DIR = '/run/typeclaw/agent-messenger'

const PROFILE_ID = 'typeclaw'
const PROFILE_NAME = 'TypeClaw channel bot'

export default definePlugin({
  plugin: async (ctx) => ({
    hooks: {
      'tool.before': agentMessengerMintHook({
        agentDir: ctx.agentDir,
        permissions: ctx.permissions,
        env: process.env,
      }),
    },
  }),
})

export function agentMessengerMintHook(options: {
  agentDir: string
  permissions: PermissionService
  env: NodeJS.ProcessEnv
  cliEntrypoint?: (platform: BotPlatform) => string
}): NonNullable<Hooks['tool.before']> {
  return async (event) => {
    if (event.tool !== 'bash') return
    const command = event.args.command
    if (typeof command !== 'string') return
    const decision = analyzeAgentMessengerCommand(command)
    if (decision.platform === undefined) return
    const token = options.env[BOT_PLATFORMS[decision.platform].tokenEnv]
    if (token === undefined || token === '') return
    if (!canUseChannelToken(options.permissions, event.origin)) return
    const operatorProfileDir = visibleOperatorProfileDir(options, event.origin, decision.platform)
    if (operatorProfileDir !== undefined) {
      // The container-level AGENT_MESSENGER_CONFIG_DIR is not inherited by
      // sandboxed bash, so point the CLI at the profile this role can see.
      const existing = event.args[TYPECLAW_INTERNAL_BASH_ENV]
      event.args[TYPECLAW_INTERNAL_BASH_ENV] = {
        ...(existing !== null && typeof existing === 'object' ? (existing as Record<string, string>) : {}),
        AGENT_MESSENGER_CONFIG_DIR: operatorProfileDir,
      }
      return
    }
    if (decision.kind === 'refuse') return { block: true, reason: decision.reason }
    if (decision.kind !== 'mint') return
    // One deferred preparation per call; never clobber another broker's.
    if (event.args[TYPECLAW_INTERNAL_BASH_PREPARE] !== undefined) return
    const entrypoint = (options.cliEntrypoint ?? resolveCliEntrypoint)(decision.platform)
    event.args[TYPECLAW_INTERNAL_BASH_PREPARE] = mintProfilePreparation(
      decision.platform,
      decision.args,
      token,
      entrypoint,
    )
  }
}

// Two gates, both required. The credential gate is the one github-cli-auth uses
// to lend a long-lived PAT, since a channel bot token is equally broad. The
// private-surface gate is channel_read's gate for reading another conversation,
// since the token reads any chat the bot is in.
function canUseChannelToken(permissions: PermissionService, origin: SessionOrigin | undefined): boolean {
  const has = (permission: string): boolean => permissions.has(origin, permission)
  const canUseCredential = has(CORE_PERMISSIONS.fsSeeSecrets) || has('security.bypass.medium')
  const canReadOtherConversations =
    has(CORE_PERMISSIONS.fsSeePrivate) || has('security.bypass.low') || has('security.bypass.medium')
  return canUseCredential && canReadOtherConversations
}

// An operator who authenticated the CLI themselves keeps their profile (and any
// extra bots in it); minting would hide it behind a single-bot profile.
function visibleOperatorProfileDir(
  options: { agentDir: string; permissions: PermissionService; env: NodeJS.ProcessEnv },
  origin: SessionOrigin | undefined,
  platform: BotPlatform,
): string | undefined {
  const configDir = options.env.AGENT_MESSENGER_CONFIG_DIR
  if (configDir === undefined || configDir === '') return undefined
  if (configDir !== options.agentDir && !configDir.startsWith(`${options.agentDir}${sep}`)) return undefined
  const hidden = resolveHiddenPaths(options.permissions, origin, options.agentDir).dirs
  if (hidden.some((dir) => configDir === dir || configDir.startsWith(`${dir}${sep}`))) return undefined
  return existsSync(join(configDir, `${platform}-credentials.json`)) ? configDir : undefined
}

export function resolveCliEntrypoint(platform: BotPlatform): string {
  const packageJson = Bun.resolveSync('agent-messenger/package.json', import.meta.dir)
  return join(dirname(packageJson), 'dist', 'src', 'platforms', platform, 'cli.js')
}

// The CLI is launched by the broker, not through PATH or a dependency-bin
// wrapper: the runtime's own bun runs the resolved agent-messenger entrypoint
// (under the read-only node_modules) from an empty read-only cwd and HOME, so a
// model-written bunfig.toml preload, .env, or PATH shim cannot run inside the
// process that holds the minted profile.
export function buildCliLaunch(
  root: string,
  entrypoint: string,
  args: readonly string[],
): { command: string; env: Record<string, string> } {
  // posix: the sandbox is always Linux, even when the host stage is Windows.
  const home = posix.join(root, 'home')
  return {
    command: `cd ${shellQuote(home)} && exec ${[process.execPath, entrypoint, ...args].map(shellQuote).join(' ')}`,
    env: {
      AGENT_MESSENGER_CONFIG_DIR: posix.join(root, 'config'),
      HOME: home,
      XDG_CONFIG_HOME: home,
      BUN_OPTIONS: '',
      NODE_OPTIONS: '',
    },
  }
}

function mintProfilePreparation(
  platform: BotPlatform,
  args: readonly string[],
  token: string,
  entrypoint: string,
): DeferredBashPreparation {
  return async (): Promise<DeferredBashPreparationResult> => {
    if (!existsSync(entrypoint)) {
      throw new Error(`agent-messenger ${platform} CLI entrypoint not found at ${entrypoint}`)
    }
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-agent-messenger-'))
    try {
      await mkdir(join(dir, 'home'), { mode: 0o700 })
      await mkdir(join(dir, 'config'), { mode: 0o700 })
      await writeFile(
        join(dir, 'config', `${platform}-credentials.json`),
        JSON.stringify(buildProfile(platform, token)),
        { mode: 0o600, flag: 'wx' },
      )
    } catch (error) {
      await rm(dir, { recursive: true, force: true })
      throw error
    }
    return {
      ...buildCliLaunch(MINTED_PROFILE_SANDBOX_DIR, entrypoint, args),
      mount: { type: 'ro-bind', source: dir, dest: MINTED_PROFILE_SANDBOX_DIR },
      cleanup: () => rm(dir, { recursive: true, force: true }),
    }
  }
}

export function buildProfile(platform: BotPlatform, token: string): Record<string, unknown> {
  const bot = { bot_id: PROFILE_ID, bot_name: PROFILE_NAME, token }
  switch (platform) {
    case 'slackbot':
      return {
        current: { workspace_id: PROFILE_ID, bot_id: PROFILE_ID },
        workspaces: {
          [PROFILE_ID]: { workspace_id: PROFILE_ID, workspace_name: PROFILE_NAME, bots: { [PROFILE_ID]: bot } },
        },
      }
    case 'discordbot':
      return { current: { bot_id: PROFILE_ID }, bots: { [PROFILE_ID]: bot }, current_server: null, servers: {} }
    case 'telegrambot':
    case 'webexbot':
      return { current: { bot_id: PROFILE_ID }, bots: { [PROFILE_ID]: bot } }
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}
