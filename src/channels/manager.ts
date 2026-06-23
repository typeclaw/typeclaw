import { createHash } from 'node:crypto'
import { join } from 'node:path'

import type { PermissionService } from '@/permissions'
import type { GithubSecretsBlock } from '@/secrets'
import { SecretsDiscordCredentialStore } from '@/secrets/discord-store'
import { SecretsKakaoCredentialStore } from '@/secrets/kakao-store'
import { SecretsLineCredentialStore } from '@/secrets/line-store'
import { SecretsSlackCredentialStore } from '@/secrets/slack-store'
import { SecretsBackend } from '@/secrets/storage'
import { SecretsWebexCredentialStore } from '@/secrets/webex-store'
import type { Stream } from '@/stream'

import { createDiscordAdapter, type DiscordAdapter } from './adapters/discord'
import { createDiscordBotAdapter, type DiscordBotAdapter } from './adapters/discord-bot'
import { createGithubAdapter, type GithubAdapter } from './adapters/github'
import { createKakaotalkAdapter, type KakaotalkAdapter } from './adapters/kakaotalk'
import { createLineAdapter, type LineAdapter } from './adapters/line'
import { createSlackAdapter, type SlackAdapter } from './adapters/slack'
import { createSlackBotAdapter, type SlackBotAdapter } from './adapters/slack-bot'
import { createTelegramBotAdapter, type TelegramBotAdapter } from './adapters/telegram-bot'
import { createWebexAdapter, type WebexAdapter } from './adapters/webex'
import { createWebexBotAdapter, type WebexBotAdapter } from './adapters/webex-bot'
import type { GithubTokenBridge } from './github-token-bridge'
import {
  createChannelRouter,
  type ChannelRouter,
  type ClaimHandler,
  type CreateSessionForChannel,
  type RestartCommandContext,
} from './router'
import {
  ADAPTER_IDS,
  type AdapterId,
  type ChannelAdapterConfig,
  type ChannelsConfig,
  type GithubAdapterConfig,
} from './schema'

export type ChannelManagerLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

const consoleLogger: ChannelManagerLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export type ChannelManagerOptions = {
  agentDir: string
  channelsConfigRef: () => ChannelsConfig
  // Plain-text names the agent answers to in channel engagement (the
  // `alias` field in `typeclaw.json`), forwarded to the router as
  // `configuredAliases`. Read live on every inbound so an `applied`-class
  // reload of `alias` takes effect without a container restart. Omitted
  // means alias-based engagement is off — `basename(agentDir)` is still
  // implicit. This MUST be wired up in production (`src/run/index.ts`)
  // or the configured aliases are silently orphaned: parsed by the
  // schema, never read by anyone. See `manager.test.ts` for the
  // end-to-end engagement assertion that guards this wiring.
  aliasesRef?: () => readonly string[]
  logger?: ChannelManagerLogger
  env?: NodeJS.ProcessEnv
  // Production wiring passes a factory that builds sessions with the full
  // runtime plumbing (channelRouter, stream, plugins, reloadRegistry). When
  // omitted, the router falls back to a hollow factory that creates sessions
  // without a channelRouter — the agent then has no `channel_send` tool and
  // cannot reply, which is fine for tests but a bug in production. See
  // src/run/index.ts where this is wired.
  createSessionForChannel?: CreateSessionForChannel
  // Test seams: let fake adapters replace the real adapter wiring per id.
  createDiscordAdapter?: typeof createDiscordBotAdapter
  createDiscordUserAdapter?: typeof createDiscordAdapter
  createGithubAdapter?: typeof createGithubAdapter
  createKakaotalkAdapter?: typeof createKakaotalkAdapter
  createLineAdapter?: typeof createLineAdapter
  createSlackAdapter?: typeof createSlackBotAdapter
  createSlackUserAdapter?: typeof createSlackAdapter
  createTelegramAdapter?: typeof createTelegramBotAdapter
  createWebexAdapter?: typeof createWebexAdapter
  createWebexBotAdapter?: typeof createWebexBotAdapter
  // Wake-up gate: forwarded to the router, which calls
  // `permissions.has(origin, 'channel.respond')` BEFORE creating a
  // session for any inbound. Optional here to keep direct manager-level
  // tests easy to spin up; production wiring in src/run/index.ts always
  // passes `pluginsLoaded.permissions`. Omitting it falls through to the
  // router's grant-all default — see CreateChannelRouterOptions.
  permissions?: PermissionService
  // Forwarded to the router; intercepts DM inbounds carrying a role-claim
  // code. Production wiring sets this from the role-claim subsystem (see
  // src/run/index.ts). Tests typically omit it.
  claimHandler?: ClaimHandler
  tunnelUrlForChannel?: (channelName: string) => string | null
  // Whether the user declared a `tunnels[]` entry bound to this channel.
  // Lets channel-bound adapters distinguish "operator opted out of public
  // webhook delivery" from "operator opted in but the tunnel never produced
  // a URL" so error logs can be precise. Same shape as
  // `tunnelUrlForChannel` for consistency. Optional for tests.
  tunnelConfiguredForChannel?: (channelName: string) => boolean
  // Forwarded to the router as `stream`. When set, every inbound the
  // router sees is published as a tagged broadcast for inspect surfacing.
  // Production wiring (`src/run/index.ts`) always passes the agent's
  // Stream; tests typically omit it.
  stream?: Stream
  // Write-side of the GithubTokenBridge. The github adapter publishes its
  // per-repo App token minter here on start (App auth only) so plugin hooks
  // can resolve a token for ad-hoc `gh` commands. Tests omit it.
  githubTokenBridge?: GithubTokenBridge
  // Forwarded to the router as the /reload and /restart command handlers.
  // Production wiring (src/run/index.ts) supplies the reload-registry and
  // container-restart bindings; tests omit them so the commands stay
  // unregistered. See CreateChannelRouterOptions.onReload/onRestart.
  onReload?: () => Promise<string>
  onRestart?: (ctx?: RestartCommandContext) => Promise<string>
  // Forwarded to the router so idle GC and stale-rollover can pin a channel
  // session whose background subagent is still running (the next inbound would
  // otherwise spawn a duplicate child). Production wiring (src/run/index.ts)
  // supplies it from the LiveSubagentRegistry; tests omit it.
  newestRunningChildSubagentStartedAt?: (sessionId: string) => number | null
  // Persistent messenger SDKs usually reconnect themselves, but a host sleep/offline
  // cycle can leave a socket half-dead forever. The manager watches live adapters
  // and restarts one that stays disconnected past this grace period. Test seams are
  // optional so production uses normal timers/time.
  connectionRecovery?: {
    checkIntervalMs?: number
    disconnectedGraceMs?: number
    now?: () => number
    setInterval?: (fn: () => void, ms: number) => unknown
    clearInterval?: (handle: unknown) => void
  }
}

export type ChannelManager = {
  router: ChannelRouter
  start: () => Promise<void>
  stop: () => Promise<void>
  restartAdapter: (name: AdapterId) => Promise<void>
  reload: () => Promise<{ started: string[]; stopped: string[]; restartRequired: string[] }>
}

type AnyAdapter =
  | DiscordAdapter
  | DiscordBotAdapter
  | GithubAdapter
  | LineAdapter
  | KakaotalkAdapter
  | SlackAdapter
  | SlackBotAdapter
  | TelegramBotAdapter
  | WebexAdapter
  | WebexBotAdapter

// Credential signature is the comparison key for credential-rotation
// detection on reload. Discord and Telegram each use a single bot token;
// Slack needs both a bot token and an app-level token (Socket Mode);
// KakaoTalk authenticates via a structured multi-account block in
// secrets.json#channels.kakaotalk, so its signature is that block's content
// hash. The "credential" naming (vs "token") generalizes across the
// env-var-based adapters and KakaoTalk's account credential pathway.
type AdapterEntry = {
  adapter: AnyAdapter
  credentialSignature: string
  disconnectedSinceMs: number | null
  recoveryRestartQueued: boolean
}

export function createChannelManager(options: ChannelManagerOptions): ChannelManager {
  const logger = options.logger ?? consoleLogger
  const env = options.env ?? process.env
  const router = createChannelRouter({
    agentDir: options.agentDir,
    configForAdapter: (adapter) => options.channelsConfigRef()[adapter],
    logger,
    ...(options.aliasesRef ? { configuredAliases: options.aliasesRef } : {}),
    ...(options.createSessionForChannel ? { createSessionForChannel: options.createSessionForChannel } : {}),
    ...(options.permissions ? { permissions: options.permissions } : {}),
    ...(options.claimHandler ? { claimHandler: options.claimHandler } : {}),
    ...(options.stream ? { stream: options.stream } : {}),
    ...(options.onReload ? { onReload: options.onReload } : {}),
    ...(options.onRestart ? { onRestart: options.onRestart } : {}),
    ...(options.newestRunningChildSubagentStartedAt
      ? { newestRunningChildSubagentStartedAt: options.newestRunningChildSubagentStartedAt }
      : {}),
  })
  const createDiscordBot = options.createDiscordAdapter ?? createDiscordBotAdapter
  const createDiscordUser = options.createDiscordUserAdapter ?? createDiscordAdapter
  const createGithub = options.createGithubAdapter ?? createGithubAdapter
  const createKakaotalk = options.createKakaotalkAdapter ?? createKakaotalkAdapter
  const createLine = options.createLineAdapter ?? createLineAdapter
  const createSlackBot = options.createSlackAdapter ?? createSlackBotAdapter
  const createSlackUser = options.createSlackUserAdapter ?? createSlackAdapter
  const createTelegramAdapter = options.createTelegramAdapter ?? createTelegramBotAdapter
  const createWebex = options.createWebexAdapter ?? createWebexAdapter
  const createWebexBot = options.createWebexBotAdapter ?? createWebexBotAdapter

  const live = new Map<AdapterId, AdapterEntry>()
  const perAdapterSerial = new Map<AdapterId, Promise<unknown>>()
  const recovery = options.connectionRecovery ?? {}
  const recoveryCheckIntervalMs = recovery.checkIntervalMs ?? 30_000
  const recoveryDisconnectedGraceMs = recovery.disconnectedGraceMs ?? 90_000
  const recoveryNow = recovery.now ?? (() => Date.now())
  const recoverySetInterval = recovery.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
  const recoveryClearInterval =
    recovery.clearInterval ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>))
  let recoveryTimer: unknown = null

  const runSerially = <T>(name: AdapterId, op: () => Promise<T>): Promise<T> => {
    const prev = perAdapterSerial.get(name) ?? Promise.resolve()
    const next = prev.then(op, op)
    perAdapterSerial.set(
      name,
      next.catch(() => {}),
    )
    return next
  }

  const buildCredentialSignature = (name: AdapterId): { signature: string; missing: string[] } => {
    if (name === 'line') return buildLineSignature(options.agentDir)
    if (name === 'kakaotalk') return buildKakaotalkSignature(options.agentDir)
    if (name === 'webex') return buildWebexSignature(options.agentDir)
    if (name === 'slack') return buildSlackSignature(options.agentDir)
    if (name === 'discord') return buildDiscordSignature(options.agentDir)
    if (name === 'github') return buildGithubSignature(options.agentDir)
    const requiredEnvs = TOKEN_ENV[name]
    const parts: string[] = []
    const missing: string[] = []
    for (const key of requiredEnvs) {
      const value = env[key]
      if (value === undefined || value.trim() === '') missing.push(key)
      else parts.push(`${key}=${value}`)
    }
    return { signature: parts.join('|'), missing }
  }

  const buildAdapter = (name: AdapterId, cfg: ChannelAdapterConfig): AnyAdapter | null => {
    if (name === 'discord-bot') {
      const token = env.DISCORD_BOT_TOKEN
      if (token === undefined || token.trim() === '') return null
      return createDiscordBot({
        router,
        configRef: () => options.channelsConfigRef()[name] ?? cfg,
        token,
        logger,
      })
    }
    if (name === 'slack-bot') {
      const token = env.SLACK_BOT_TOKEN
      const appToken = env.SLACK_APP_TOKEN
      if (token === undefined || token.trim() === '') return null
      if (appToken === undefined || appToken.trim() === '') return null
      return createSlackBot({
        router,
        configRef: () => options.channelsConfigRef()[name] ?? cfg,
        token,
        appToken,
        logger,
        selfAliasesRef: () => router.getSelfAliases(),
      })
    }
    if (name === 'line') {
      return createLine({
        router,
        configRef: () => options.channelsConfigRef()[name] ?? cfg,
        logger,
        selfAliasesRef: () => router.getSelfAliases(),
        credentialsStore: createContainerLineCredentialStore(options.agentDir, env),
      })
    }
    if (name === 'kakaotalk') {
      return createKakaotalk({
        router,
        configRef: () => options.channelsConfigRef()[name] ?? cfg,
        logger,
        selfAliasesRef: () => router.getSelfAliases(),
        credentialsStore: createContainerKakaoCredentialStore(options.agentDir, env),
      })
    }
    if (name === 'slack') {
      return createSlackUser({
        router,
        configRef: () => options.channelsConfigRef()[name] ?? cfg,
        logger,
        selfAliasesRef: () => router.getSelfAliases(),
        credentialsStore: createContainerSlackCredentialStore(options.agentDir, env),
      })
    }
    if (name === 'discord') {
      return createDiscordUser({
        router,
        configRef: () => options.channelsConfigRef()[name] ?? cfg,
        logger,
        selfAliasesRef: () => router.getSelfAliases(),
        credentialsStore: createContainerDiscordCredentialStore(options.agentDir, env),
      })
    }
    if (name === 'webex') {
      return createWebex({
        router,
        configRef: () => options.channelsConfigRef()[name] ?? cfg,
        logger,
        selfAliasesRef: () => router.getSelfAliases(),
        credentialsStore: createContainerWebexCredentialStore(options.agentDir, env),
      })
    }
    if (name === 'github') {
      const secrets = readGithubSecrets(options.agentDir)
      if (secrets === null) return null
      return createGithub({
        router,
        configRef: () => (options.channelsConfigRef()[name] ?? cfg) as ChannelAdapterConfig & GithubAdapterConfig,
        secrets,
        agentDir: options.agentDir,
        logger,
        tunnelUrl: () => options.tunnelUrlForChannel?.('github') ?? null,
        tunnelConfiguredForChannel: () => options.tunnelConfiguredForChannel?.('github') ?? false,
        ...(options.githubTokenBridge !== undefined ? { githubTokenBridge: options.githubTokenBridge } : {}),
      })
    }
    if (name === 'telegram-bot') {
      const token = env.TELEGRAM_BOT_TOKEN
      if (token === undefined || token.trim() === '') return null
      return createTelegramAdapter({
        router,
        configRef: () => options.channelsConfigRef()[name] ?? cfg,
        token,
        logger,
      })
    }
    if (name === 'webex-bot') {
      const token = env.WEBEX_BOT_TOKEN
      if (token === undefined || token.trim() === '') return null
      return createWebexBot({
        router,
        configRef: () => options.channelsConfigRef()[name] ?? cfg,
        token,
        logger,
        selfAliasesRef: () => router.getSelfAliases(),
      })
    }
    return null
  }

  const startAdapter = async (name: AdapterId, cfg: ChannelAdapterConfig): Promise<boolean> => {
    if (cfg.enabled === false) {
      logger.info(`[channels] adapter "${name}" is disabled; skipping`)
      return false
    }
    const { signature, missing } = buildCredentialSignature(name)
    if (missing.length > 0) {
      logger.error(`[channels] adapter "${name}" missing credentials: ${missing.join(', ')}; skipping`)
      return false
    }
    const adapter = buildAdapter(name, cfg)
    if (adapter === null) {
      logger.error(`[channels] adapter "${name}" could not be constructed; skipping`)
      return false
    }
    try {
      await adapter.start()
      live.set(name, {
        adapter,
        credentialSignature: signature,
        disconnectedSinceMs: adapter.isConnected() ? null : recoveryNow(),
        recoveryRestartQueued: false,
      })
      logger.info(`[channels] adapter "${name}" started`)
      return true
    } catch (err) {
      logger.error(`[channels] adapter "${name}" failed to start: ${describe(err)}`)
      return false
    }
  }

  const stopAdapter = async (name: AdapterId): Promise<void> => {
    const entry = live.get(name)
    if (!entry) return
    try {
      await entry.adapter.stop()
      live.delete(name)
      logger.info(`[channels] adapter "${name}" stopped`)
    } catch (err) {
      logger.error(`[channels] adapter "${name}" failed to stop: ${describe(err)}`)
    }
  }

  const checkConnectionRecovery = (): void => {
    const now = recoveryNow()
    for (const [name, entry] of live) {
      if (entry.adapter.isConnected()) {
        entry.disconnectedSinceMs = null
        entry.recoveryRestartQueued = false
        continue
      }
      if (entry.disconnectedSinceMs === null) {
        entry.disconnectedSinceMs = now
        logger.warn(`[channels] adapter "${name}" is disconnected; waiting for SDK recovery`)
        continue
      }
      const disconnectedForMs = now - entry.disconnectedSinceMs
      if (disconnectedForMs < recoveryDisconnectedGraceMs || entry.recoveryRestartQueued) continue
      entry.recoveryRestartQueued = true
      logger.warn(
        `[channels] adapter "${name}" disconnected for ${Math.round(disconnectedForMs)}ms; restarting adapter`,
      )
      void runSerially(name, async () => {
        try {
          const current = live.get(name)
          if (current !== entry) return
          const currentCfg = options.channelsConfigRef()[name]
          if (currentCfg === undefined || currentCfg.enabled === false) {
            logger.info(`[channels] recovery restart for "${name}" skipped; adapter no longer enabled`)
            return
          }
          await stopAdapter(name)
          await startAdapter(name, currentCfg)
        } finally {
          if (live.get(name) === entry) entry.recoveryRestartQueued = false
        }
      })
    }
  }

  const startRecoveryTimer = (): void => {
    if (recoveryTimer !== null) return
    recoveryTimer = recoverySetInterval(checkConnectionRecovery, recoveryCheckIntervalMs)
  }

  const stopRecoveryTimer = (): void => {
    if (recoveryTimer === null) return
    recoveryClearInterval(recoveryTimer)
    recoveryTimer = null
  }

  return {
    router,

    async start(): Promise<void> {
      const cfg = options.channelsConfigRef()
      // Safe to fan out: router registries are keyed by route key
      // (adapter:workspace), so different instances do not collide. Serial start
      // would otherwise pay the sum of each adapter's connect latency.
      const starts = ADAPTER_IDS.flatMap((name) => {
        const adapterCfg = cfg[name]
        return adapterCfg === undefined ? [] : [runSerially(name, () => startAdapter(name, adapterCfg))]
      })
      // Await every launched start to settle BEFORE surfacing a failure.
      // `startAdapter` converts expected per-adapter failures to `false`, so a
      // rejection is an unexpected throw (e.g. `buildAdapter`) that must still
      // fail-fast. But bailing on the first rejection (plain `Promise.all`) would
      // leave sibling starts in flight, letting a late `live.set` orphan an adapter
      // that the caller's subsequent `stop()` never sees. Settle all, then rethrow.
      const results = await Promise.allSettled(starts)
      const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
      if (failure !== undefined) throw failure.reason
      startRecoveryTimer()
    },

    async stop(): Promise<void> {
      stopRecoveryTimer()
      for (const name of Array.from(live.keys())) await runSerially(name, () => stopAdapter(name))
      await router.stop()
    },

    async restartAdapter(name: AdapterId): Promise<void> {
      await runSerially(name, async () => {
        if (!live.has(name)) {
          logger.info(`[channels] restartAdapter('${name}'): adapter not live, skipping`)
          return
        }
        const currentCfg = options.channelsConfigRef()[name]
        if (currentCfg === undefined) {
          logger.info(`[channels] restartAdapter('${name}'): adapter config missing, skipping`)
          return
        }
        await stopAdapter(name)
        await startAdapter(name, currentCfg)
      })
    },

    async reload(): Promise<{ started: string[]; stopped: string[]; restartRequired: string[] }> {
      const cfg = options.channelsConfigRef()
      const started: string[] = []
      const stopped: string[] = []
      const restartRequired: string[] = []

      for (const name of ADAPTER_IDS) {
        const desired = cfg[name]
        const current = live.get(name)
        if (desired === undefined || desired.enabled === false) {
          if (current) {
            await runSerially(name, () => stopAdapter(name))
            stopped.push(name)
          }
        } else if (!current) {
          const ok = await runSerially(name, () => startAdapter(name, desired))
          if (ok) started.push(name)
        } else {
          const { signature, missing } = buildCredentialSignature(name)
          if (missing.length > 0) {
            // Required credentials disappeared (env vars removed from .env, or
            // KakaoTalk credentials removed from secrets.json). Continuing to use the
            // in-memory credentials would silently honor a credential the
            // operator explicitly removed, so stop the adapter instead of
            // waiting for a manual restart.
            logger.warn(
              `[channels] adapter "${name}" missing credentials after reload (${missing.join(', ')}); stopping`,
            )
            await runSerially(name, () => stopAdapter(name))
            stopped.push(name)
          } else if (signature !== current.credentialSignature) {
            const reason =
              name === 'kakaotalk' || name === 'line' || name === 'webex' || name === 'slack' || name === 'discord'
                ? 'credential rotation'
                : 'token rotation'
            restartRequired.push(`${name} (${reason})`)
          }
        }
      }

      return { started, stopped, restartRequired }
    },
  }
}

// Token-based adapters only. Personal-account credentials live in
// secrets.json#channels.<adapter>, not in env, so they go through
// structured-block signatures instead.
const TOKEN_ENV: Record<
  Exclude<AdapterId, 'kakaotalk' | 'line' | 'github' | 'webex' | 'slack' | 'discord'>,
  readonly string[]
> = {
  'discord-bot': ['DISCORD_BOT_TOKEN'],
  'slack-bot': ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'],
  'telegram-bot': ['TELEGRAM_BOT_TOKEN'],
  'webex-bot': ['WEBEX_BOT_TOKEN'],
}

function createContainerDiscordCredentialStore(
  agentDir: string,
  env: NodeJS.ProcessEnv,
): SecretsDiscordCredentialStore {
  const hostdUrl = env.TYPECLAW_HOSTD_URL
  const restartToken = env.TYPECLAW_HOSTD_TOKEN
  const containerName = env.TYPECLAW_CONTAINER_NAME
  if (!hostdUrl || !restartToken || !containerName) {
    throw new Error('Discord credentials require TYPECLAW_HOSTD_URL, TYPECLAW_HOSTD_TOKEN, and TYPECLAW_CONTAINER_NAME')
  }
  return new SecretsDiscordCredentialStore({
    mode: 'container',
    secretsPath: join(agentDir, 'secrets.json'),
    hostdUrl,
    restartToken,
    containerName,
  })
}

function buildDiscordSignature(agentDir: string): { signature: string; missing: string[] } {
  const path = join(agentDir, 'secrets.json')
  try {
    const block = new SecretsBackend(path).tryReadChannelsSync()?.discord
    if (!isDiscordCredentialBlock(block)) {
      return { signature: '', missing: ['secrets.json#channels.discord'] }
    }
    const digest = createHash('sha256').update(JSON.stringify(block)).digest('hex')
    return { signature: `secrets.json#channels.discord@sha256:${digest}`, missing: [] }
  } catch (err) {
    return { signature: '', missing: [`secrets.json#channels.discord (${describe(err)})`] }
  }
}

function createContainerSlackCredentialStore(agentDir: string, env: NodeJS.ProcessEnv): SecretsSlackCredentialStore {
  const hostdUrl = env.TYPECLAW_HOSTD_URL
  const restartToken = env.TYPECLAW_HOSTD_TOKEN
  const containerName = env.TYPECLAW_CONTAINER_NAME
  if (!hostdUrl || !restartToken || !containerName) {
    throw new Error('Slack credentials require TYPECLAW_HOSTD_URL, TYPECLAW_HOSTD_TOKEN, and TYPECLAW_CONTAINER_NAME')
  }
  return new SecretsSlackCredentialStore({
    mode: 'container',
    secretsPath: join(agentDir, 'secrets.json'),
    hostdUrl,
    restartToken,
    containerName,
  })
}

function buildSlackSignature(agentDir: string): { signature: string; missing: string[] } {
  const path = join(agentDir, 'secrets.json')
  try {
    const block = new SecretsBackend(path).tryReadChannelsSync()?.slack
    if (!isSlackCredentialBlock(block)) {
      return { signature: '', missing: ['secrets.json#channels.slack'] }
    }
    const digest = createHash('sha256').update(JSON.stringify(block)).digest('hex')
    return { signature: `secrets.json#channels.slack@sha256:${digest}`, missing: [] }
  } catch (err) {
    return { signature: '', missing: [`secrets.json#channels.slack (${describe(err)})`] }
  }
}

function createContainerWebexCredentialStore(agentDir: string, env: NodeJS.ProcessEnv): SecretsWebexCredentialStore {
  const hostdUrl = env.TYPECLAW_HOSTD_URL
  const restartToken = env.TYPECLAW_HOSTD_TOKEN
  const containerName = env.TYPECLAW_CONTAINER_NAME
  if (!hostdUrl || !restartToken || !containerName) {
    throw new Error('Webex credentials require TYPECLAW_HOSTD_URL, TYPECLAW_HOSTD_TOKEN, and TYPECLAW_CONTAINER_NAME')
  }
  return new SecretsWebexCredentialStore({
    mode: 'container',
    secretsPath: join(agentDir, 'secrets.json'),
    hostdUrl,
    restartToken,
    containerName,
  })
}

function buildWebexSignature(agentDir: string): { signature: string; missing: string[] } {
  const path = join(agentDir, 'secrets.json')
  try {
    const block = new SecretsBackend(path).tryReadChannelsSync()?.webex
    if (!isWebexCredentialBlock(block)) {
      return { signature: '', missing: ['secrets.json#channels.webex'] }
    }
    const digest = createHash('sha256').update(JSON.stringify(block)).digest('hex')
    return { signature: `secrets.json#channels.webex@sha256:${digest}`, missing: [] }
  } catch (err) {
    return { signature: '', missing: [`secrets.json#channels.webex (${describe(err)})`] }
  }
}

function createContainerKakaoCredentialStore(agentDir: string, env: NodeJS.ProcessEnv): SecretsKakaoCredentialStore {
  const hostdUrl = env.TYPECLAW_HOSTD_URL
  const restartToken = env.TYPECLAW_HOSTD_TOKEN
  const containerName = env.TYPECLAW_CONTAINER_NAME
  if (!hostdUrl || !restartToken || !containerName) {
    throw new Error(
      'KakaoTalk credentials require TYPECLAW_HOSTD_URL, TYPECLAW_HOSTD_TOKEN, and TYPECLAW_CONTAINER_NAME',
    )
  }
  return new SecretsKakaoCredentialStore({
    mode: 'container',
    secretsPath: join(agentDir, 'secrets.json'),
    hostdUrl,
    restartToken,
    containerName,
  })
}

function buildKakaotalkSignature(agentDir: string): { signature: string; missing: string[] } {
  const path = join(agentDir, 'secrets.json')
  try {
    const block = new SecretsBackend(path).tryReadChannelsSync()?.kakaotalk
    if (!isKakaoCredentialBlock(block)) {
      return { signature: '', missing: ['secrets.json#channels.kakaotalk'] }
    }
    const digest = createHash('sha256').update(JSON.stringify(block)).digest('hex')
    return { signature: `secrets.json#channels.kakaotalk@sha256:${digest}`, missing: [] }
  } catch (err) {
    return { signature: '', missing: [`secrets.json#channels.kakaotalk (${describe(err)})`] }
  }
}

function createContainerLineCredentialStore(agentDir: string, env: NodeJS.ProcessEnv): SecretsLineCredentialStore {
  const hostdUrl = env.TYPECLAW_HOSTD_URL
  const restartToken = env.TYPECLAW_HOSTD_TOKEN
  const containerName = env.TYPECLAW_CONTAINER_NAME
  if (!hostdUrl || !restartToken || !containerName) {
    throw new Error('LINE credentials require TYPECLAW_HOSTD_URL, TYPECLAW_HOSTD_TOKEN, and TYPECLAW_CONTAINER_NAME')
  }
  return new SecretsLineCredentialStore({
    mode: 'container',
    secretsPath: join(agentDir, 'secrets.json'),
    hostdUrl,
    restartToken,
    containerName,
  })
}

function buildLineSignature(agentDir: string): { signature: string; missing: string[] } {
  const path = join(agentDir, 'secrets.json')
  try {
    const block = new SecretsBackend(path).tryReadChannelsSync()?.line
    if (!isLineCredentialBlock(block)) {
      return { signature: '', missing: ['secrets.json#channels.line'] }
    }
    const digest = createHash('sha256').update(JSON.stringify(block)).digest('hex')
    return { signature: `secrets.json#channels.line@sha256:${digest}`, missing: [] }
  } catch (err) {
    return { signature: '', missing: [`secrets.json#channels.line (${describe(err)})`] }
  }
}

function buildGithubSignature(agentDir: string): { signature: string; missing: string[] } {
  const block = readGithubSecrets(agentDir)
  if (block === null) return { signature: '', missing: ['secrets.json#channels.github'] }
  const digest = createHash('sha256').update(JSON.stringify(block)).digest('hex')
  return { signature: `secrets.json#channels.github@sha256:${digest}`, missing: [] }
}

function readGithubSecrets(agentDir: string): GithubSecretsBlock | null {
  const path = join(agentDir, 'secrets.json')
  try {
    const block = new SecretsBackend(path).tryReadChannelsSync()?.github
    return isGithubSecretsBlock(block) ? block : null
  } catch {
    return null
  }
}

function isGithubSecretsBlock(value: unknown): value is GithubSecretsBlock {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const auth = record.auth
  if (typeof auth !== 'object' || auth === null || Array.isArray(auth)) return false
  const authType = (auth as Record<string, unknown>).type
  return authType === 'pat' || authType === 'app'
}

function isKakaoCredentialBlock(value: unknown): value is { accounts: Record<string, unknown> } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (!('accounts' in value)) return false
  const accounts = value.accounts
  return (
    typeof accounts === 'object' && accounts !== null && !Array.isArray(accounts) && Object.keys(accounts).length > 0
  )
}

function isLineCredentialBlock(value: unknown): value is { accounts: Record<string, unknown> } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (!('accounts' in value)) return false
  const accounts = value.accounts
  return (
    typeof accounts === 'object' && accounts !== null && !Array.isArray(accounts) && Object.keys(accounts).length > 0
  )
}

function isSlackCredentialBlock(value: unknown): value is { accounts: Record<string, unknown> } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (!('accounts' in value)) return false
  const accounts = value.accounts
  return (
    typeof accounts === 'object' && accounts !== null && !Array.isArray(accounts) && Object.keys(accounts).length > 0
  )
}

function isDiscordCredentialBlock(value: unknown): value is { accounts: Record<string, unknown> } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (!('accounts' in value)) return false
  const accounts = value.accounts
  return (
    typeof accounts === 'object' && accounts !== null && !Array.isArray(accounts) && Object.keys(accounts).length > 0
  )
}

function isWebexCredentialBlock(value: unknown): value is { accounts: Record<string, unknown> } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (!('accounts' in value)) return false
  const accounts = value.accounts
  return (
    typeof accounts === 'object' && accounts !== null && !Array.isArray(accounts) && Object.keys(accounts).length > 0
  )
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
