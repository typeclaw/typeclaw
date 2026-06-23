import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { isMultiInstanceAdapter, isUserModeAdapter } from '@/channels/instances'
import {
  config,
  configSchema,
  GWS_MULTI_ACCOUNT_PLUGIN_PACKAGE,
  GWS_MULTI_ACCOUNT_PLUGIN_VERSION,
  migrateLegacyConfigShape,
  type Config,
  type CustomModelMeta,
} from '@/config'
import {
  DEFAULT_MODEL_REF,
  KNOWN_PROVIDERS,
  isKnownModelRef,
  providerForModelRef,
  type KnownProviderId,
  type ModelRef,
} from '@/config/providers'
import {
  checkDockerAvailable,
  type DockerAvailability,
  type DockerExec,
  start,
  type StartResult,
  stop,
} from '@/container'
import { commitSystemFile } from '@/git/system-commit'
import { createSecretsStoreForAgent, type Channels, type Secret, SecretsBackend } from '@/secrets'
import { hostLocaleIsCjk } from '@/shared/host-locale'
import { isWindows } from '@/shared/platform'
import { createTui } from '@/tui'

import { resolveBaseImageVersion, resolveTypeclawSpec, typeclawCheckoutRoot } from './cli-version'
import { buildDockerfile, DOCKERFILE } from './dockerfile'
import { CONFIG_FILE, findAgentDir, isInitialized } from './find-agent-dir'
import { installGithubWebhooksEagerly, type EagerGithubWebhookInstallResult } from './github-webhook-install'
import { buildGitignore, GITIGNORE_FILE } from './gitignore'
import { buildHatchingPrompt } from './hatching'
import type { OAuthLoginRunner, OAuthLoginResult } from './oauth-login'
import { GITKEEP_FILE, PACKAGES_DIR, PUBLIC_DIR } from './paths'
import { type InstallResult, type InstallRunner, runBunInstall } from './run-bun-install'
import { linkWindowsDevTypeclaw, type RunBunLink } from './windows-dev-link'

export { type InstallResult, type InstallRunner, runBunInstall } from './run-bun-install'

export type { EagerGithubWebhookInstallResult } from './github-webhook-install'
export { formatEagerGithubWebhookInstallResult, installGithubWebhooksEagerly } from './github-webhook-install'

export { GITKEEP_FILE, PACKAGES_DIR, PUBLIC_DIR } from './paths'

export { appendOrReplaceEnvKey, hasEnvKey, readEnvFile } from './env-file'

export { CONFIG_FILE, findAgentDir, isInitialized }

const CRON_FILE = 'cron.json'
const PACKAGE_FILE = 'package.json'

const MARKDOWN_FILES = ['AGENTS.md', 'IDENTITY.md', 'SOUL.md', 'USER.md'] as const

// `packages/` is a bun workspace root (see `workspaces` in buildPackageJson).
// Reusable systems the agent builds — including custom plugins wired into
// typeclaw.json — live there as standalone packages, while one-off scripts
// stay in `workspace/`. The directory is scaffolded empty so the layout is
// discoverable on day one; a `.gitkeep` is written below so it survives the
// initial commit.
//
// `public/` is a top-level sibling, NOT `workspace/public/`, on purpose:
// role-based path hiding (src/sandbox/hidden-paths.ts) masks `workspace/` from
// the guest tier but never masks `public/`, so `public/` is the one place a
// guest turn can read and write. `workspace/` is an arbitrary free-write zone
// with no reserved subdir names; a magic `workspace/public/` would silently
// expose any subdir an agent happened to name `public`. A root sibling keeps
// the deny-list flat (no carve-out) and the public/private split legible.
const DIRECTORIES = ['workspace', 'public', 'sessions', '.agents/skills', 'mounts', 'packages'] as const

export type GitInitResult = { ok: true; skipped: boolean } | { ok: false; reason: string }
export type DockerAssetsResult = { ok: true; devMode: boolean } | { ok: false; reason: string }
export type HatchingResult = { ok: true } | { ok: false; reason: string }

export type InitStep =
  | 'preflight'
  | 'oauth-login'
  | 'scaffold'
  | 'slack-auth'
  | 'discord-auth'
  | 'kakaotalk-auth'
  | 'webex-auth'
  | 'github-webhooks'
  | 'install'
  | 'dockerfile'
  | 'git'
  | 'hatching'

export type KakaotalkAuthResult = { ok: true } | { ok: false; reason: string }
export type WebexAuthResult = { ok: true } | { ok: false; reason: string }
export type SlackAuthResult = { ok: true } | { ok: false; reason: string }
export type DiscordAuthResult = { ok: true } | { ok: false; reason: string }

// Structured credential block for the GitHub channel adapter. Mirrors the
// shape `runAddChannel({ channel: 'github', ... })` consumes so the wizard
// can hand off without re-encoding the auth union or webhook fields.
export type GithubInitCredentials = {
  webhookSecret: string
  tunnelProvider: GithubTunnelProvider
  // Set when `tunnelProvider === 'external'`. The user-supplied https URL
  // that GitHub POSTs to and that lands in `channels.github.webhookUrl`.
  webhookUrl?: string
  webhookPort?: number
  // Set when `tunnelProvider === 'cloudflare-named'`. The Public Hostname
  // configured in the Cloudflare dashboard; also used as the webhook URL for
  // eager registration (GitHub POSTs through the named tunnel to the in-
  // container webhook server). Kept distinct from `webhookUrl` so the
  // wizard's branching stays readable and the resulting `tunnels[].hostname`
  // ends up in the right field rather than being smuggled through
  // `externalUrl`.
  hostname?: string
  tokenEnv?: string
  repos: string[]
  auth: { type: 'pat'; pat: string } | { type: 'app'; appId: number; privateKey: string }
}

export type GithubTunnelProvider = 'cloudflare-quick' | 'cloudflare-named' | 'external' | 'none'

export type InitStepEvent =
  | { step: 'preflight'; phase: 'start' }
  | { step: 'preflight'; phase: 'done'; result: DockerAvailability }
  | { step: 'oauth-login'; phase: 'start' }
  | { step: 'oauth-login'; phase: 'done'; result: OAuthLoginResult }
  | { step: 'scaffold'; phase: 'start' }
  | { step: 'scaffold'; phase: 'done' }
  | { step: 'kakaotalk-auth'; phase: 'start' }
  | { step: 'kakaotalk-auth'; phase: 'done'; result: KakaotalkAuthResult }
  | { step: 'webex-auth'; phase: 'start' }
  | { step: 'webex-auth'; phase: 'done'; result: WebexAuthResult }
  | { step: 'discord-auth'; phase: 'start' }
  | { step: 'discord-auth'; phase: 'done'; result: DiscordAuthResult }
  | { step: 'github-webhooks'; phase: 'start' }
  | { step: 'github-webhooks'; phase: 'done'; result: EagerGithubWebhookInstallResult }
  | { step: 'install'; phase: 'start' }
  | { step: 'install'; phase: 'done'; result: InstallResult }
  | { step: 'dockerfile'; phase: 'start' }
  | { step: 'dockerfile'; phase: 'done'; result: DockerAssetsResult }
  | { step: 'git'; phase: 'start' }
  | { step: 'git'; phase: 'done'; result: GitInitResult }
  | { step: 'hatching'; phase: 'start' }
  | { step: 'hatching'; phase: 'done'; result: HatchingResult }

// `cliEntry` is the path to the running CLI module (typically `process.argv[1]`).
// When provided, the hatching step threads it into `start()`, which spawns the
// host daemon and registers the freshly-hatched container with the supervisor +
// portbroker — same path `typeclaw start` takes. When omitted (test fixtures,
// programmatic callers that never want a daemon), `start()` skips the daemon
// path entirely and the container runs unmanaged.
export type HatchRunner = (options: {
  cwd: string
  port: number
  cliEntry?: string
  // Set when the wizard wired at least one channel adapter, so the runner
  // can offer to run `typeclaw role claim` after the container is ready.
  // Empty / undefined means "no channels — skip the claim flow".
  configuredChannels?: readonly ChannelKind[]
}) => Promise<HatchingResult>

export type KakaotalkAuthRunner = (options: { cwd: string }) => Promise<KakaotalkAuthResult>
export type WebexAuthRunner = (options: { cwd: string }) => Promise<WebexAuthResult>

export type LineAuthResult = { ok: true } | { ok: false; reason: string }
export type LineAuthRunner = (options: { cwd: string }) => Promise<LineAuthResult>

// Discriminated by `kind` so the type system enforces "you can't pass an
// API key to an OAuth provider, and you can't pass an OAuth runner to an
// API-key provider". Optional model defaults to DEFAULT_MODEL_REF, which is
// an OpenAI api-key provider — so test fixtures that omit both fields keep
// working under the api-key path.
//
// `oauth-completed` is the CLI wizard's signal that the browser login already
// happened up-front (right after the user picked the auth method) and the
// resulting credentials are already in `secrets.json`. `runInit` then skips
// the `oauth-login` step but still treats this as an OAuth provider (no API
// key written, etc.). The wizard runs OAuth eagerly so the browser opens the
// moment the user picks "OAuth (browser login)" instead of waiting until the
// end of the wizard — see `collectWizardInputs` in `src/cli/init.ts`.
export type LLMAuth =
  | { kind: 'api-key'; apiKey: string }
  | { kind: 'oauth'; runLogin: OAuthLoginRunner }
  | { kind: 'oauth-completed' }

export type InitOptions = {
  cwd: string
  // Selected `provider/model` ref written into typeclaw.json. Defaults to
  // DEFAULT_MODEL_REF when callers (or older test fixtures) omit it.
  model?: ModelRef | string
  modelMeta?: CustomModelMeta
  // How the agent will authenticate to the LLM provider. When omitted,
  // defaults to the api-key path with `apiKey` (legacy field, still
  // supported for backwards compat with the old `runInit` signature).
  llmAuth?: LLMAuth
  // Optional second model + auth, written as `models.vision` when the
  // default model is text-only. Auth is reused from the default path
  // when both refer to the same provider; the wizard enforces this
  // pairing rule, so by the time we get here `visionAuth` is either
  // (a) absent, or (b) the right auth for `visionModel`'s provider.
  visionModel?: ModelRef | string
  visionModelMeta?: CustomModelMeta
  visionAuth?: LLMAuth
  apiKey?: string
  discordBotToken?: string
  slackBotToken?: string
  slackAppToken?: string
  telegramBotToken?: string
  webexBotToken?: string
  // When reusing existing channel credentials from a pre-init `secrets.json`,
  // the CLI passes `with<Adapter>: true` without a corresponding token so the
  // scaffolded `typeclaw.json` wires the adapter while `writeSecrets` leaves
  // the existing slot in `secrets.json#channels` untouched. Defaults below
  // mirror the legacy derivation (`<token> !== undefined && !== ''`).
  withDiscord?: boolean
  withDiscordUser?: boolean
  withSlack?: boolean
  withTelegram?: boolean
  withWebex?: boolean
  withWebexUser?: boolean
  withKakaotalk?: boolean
  withGithub?: boolean
  runKakaotalkAuth?: KakaotalkAuthRunner
  runWebexAuth?: WebexAuthRunner
  runDiscordAuth?: DiscordAuthRunner
  // Structured GitHub credentials collected by the wizard. When omitted and
  // `withGithub` is true, the existing secrets.json#channels.github block is
  // reused as-is (the wizard's "reuse existing credentials" path).
  githubCredentials?: GithubInitCredentials
  // Test seam for the eager-webhook-install path that fires after the github
  // channel block is written. Production callers leave this undefined so the
  // global `fetch` is used.
  githubFetchImpl?: typeof fetch
  onProgress?: (event: InitStepEvent) => void
  runHatching?: HatchRunner
  runBunInstall?: InstallRunner
  dockerExec?: DockerExec
  // Test seams for the native-Windows dev-mode `bun link` flow. `platform`
  // defaults to `process.platform`; `runBunLink` defaults to spawning
  // `bun link` in the typeclaw checkout.
  platform?: NodeJS.Platform
  runBunLink?: RunBunLink
  // Production CLI callers (src/cli/init.ts) pass `process.argv[1]` so the
  // hatching step's `start()` call spawns the host daemon and registers the
  // freshly-hatched container — same path `typeclaw start` takes. Tests omit
  // this to skip the daemon entirely (matching the existing seam in
  // src/container/start.ts).
  cliEntry?: string
}

export async function runInit({
  cwd,
  apiKey,
  llmAuth,
  model = DEFAULT_MODEL_REF,
  modelMeta,
  visionModel,
  visionModelMeta,
  visionAuth,
  discordBotToken,
  slackBotToken,
  slackAppToken,
  telegramBotToken,
  webexBotToken,
  withDiscord,
  withDiscordUser = false,
  withSlack,
  withTelegram,
  withWebex,
  withWebexUser = false,
  withKakaotalk = false,
  withGithub = false,
  runKakaotalkAuth,
  runWebexAuth,
  runDiscordAuth,
  githubCredentials,
  githubFetchImpl,
  onProgress,
  runHatching = defaultRunHatching,
  runBunInstall: installRunner = runBunInstall,
  dockerExec,
  cliEntry,
  platform = process.platform,
  runBunLink,
}: InitOptions): Promise<void> {
  const emit = onProgress ?? (() => {})

  // Docker preflight runs BEFORE any scaffolding so a missing-binary or
  // daemon-down failure leaves the user's directory untouched. Without this
  // gate, init would lay the egg, write the Dockerfile, init git, and then
  // fail at hatching with a raw "Executable not found in $PATH: docker" —
  // leaving a half-initialized agent folder the user has to clean up by hand.
  emit({ step: 'preflight', phase: 'start' })
  const preflight = await checkDockerAvailable(dockerExec)
  emit({ step: 'preflight', phase: 'done', result: preflight })
  if (!preflight.ok) return

  // Resolve the auth contract: explicit `llmAuth` wins; otherwise, fall back
  // to the legacy `apiKey` field (api-key path). Throwing here instead of
  // proceeding with bad data prevents writing a half-initialized agent
  // folder for a doomed config.
  const resolvedAuth = resolveLLMAuth(llmAuth, apiKey)

  // OAuth login runs BEFORE scaffold so a failed/aborted browser flow leaves
  // the user's directory untouched (same rationale as the docker preflight).
  // Same trap as kakaotalk-auth: scaffold-then-fail-auth would leave
  // typeclaw.json without working credentials and the runtime would silently
  // refuse to boot. The login itself doesn't need the agent folder to exist
  // — pi-ai's OAuth helper just needs a writable path for secrets.json, and
  // the `mkdir` below creates it on demand before the login runs.
  if (resolvedAuth.kind === 'oauth') {
    emit({ step: 'oauth-login', phase: 'start' })
    await mkdir(cwd, { recursive: true })
    const result = await resolvedAuth.runLogin({ cwd, model })
    emit({ step: 'oauth-login', phase: 'done', result })
    if (!result.ok) {
      throw new Error(`OAuth login failed: ${result.reason}`)
    }
  }

  // When the vision profile uses a different provider than the default, its
  // OAuth login runs here too, before any file write. Same-provider vision
  // reuses the default auth (no separate login). API-key vision auth is
  // captured in memory and persisted by writeSecrets() below.
  if (
    visionAuth !== undefined &&
    visionAuth.kind === 'oauth' &&
    visionModel !== undefined &&
    providerForModelRef(visionModel) !== providerForModelRef(model)
  ) {
    emit({ step: 'oauth-login', phase: 'start' })
    await mkdir(cwd, { recursive: true })
    const result = await visionAuth.runLogin({ cwd, model: visionModel })
    emit({ step: 'oauth-login', phase: 'done', result })
    if (!result.ok) {
      throw new Error(`OAuth login failed: ${result.reason}`)
    }
  }

  const wantsDiscord = withDiscord ?? (discordBotToken !== undefined && discordBotToken !== '')
  const wantsSlack = withSlack ?? (slackBotToken !== undefined && slackBotToken !== '')
  const wantsTelegram = withTelegram ?? (telegramBotToken !== undefined && telegramBotToken !== '')
  const wantsWebex = withWebex ?? (webexBotToken !== undefined && webexBotToken !== '')
  emit({ step: 'scaffold', phase: 'start' })
  await scaffold(cwd, {
    model,
    ...(modelMeta !== undefined ? { modelMeta } : {}),
    ...(visionModel !== undefined ? { visionModel } : {}),
    ...(visionModelMeta !== undefined ? { visionModelMeta } : {}),
    withDiscord: wantsDiscord,
    withDiscordUser,
    withSlack: wantsSlack,
    withTelegram: wantsTelegram,
    withWebex: wantsWebex,
    withWebexUser,
    withKakaotalk,
    platform,
  })
  // Only write the LLM API key on the api-key path. OAuth providers persist
  // their credentials to secrets.json (via the OAuth login step above); writing
  // an empty FIREWORKS_API_KEY/OPENAI_API_KEY would just confuse users.
  await writeSecrets(cwd, {
    model,
    apiKey: resolvedAuth.kind === 'api-key' ? resolvedAuth.apiKey : undefined,
    ...(visionModel !== undefined && visionAuth?.kind === 'api-key'
      ? { visionModel, visionApiKey: visionAuth.apiKey }
      : {}),
    discordBotToken,
    slackBotToken,
    slackAppToken,
    telegramBotToken,
    webexBotToken,
  })
  emit({ step: 'scaffold', phase: 'done' })

  if (withKakaotalk && runKakaotalkAuth !== undefined) {
    emit({ step: 'kakaotalk-auth', phase: 'start' })
    const result = await runKakaotalkAuth({ cwd })
    emit({ step: 'kakaotalk-auth', phase: 'done', result })
    if (!result.ok) {
      // Abort the rest of the pipeline. Continuing would leave the agent
      // folder with `channels.kakaotalk` in typeclaw.json but no credentials
      // file, which `typeclaw start` later treats as "missing credentials,
      // skip adapter" — confusing the user about whether KakaoTalk works.
      // The user can re-run `typeclaw init` after fixing the auth issue;
      // the scaffold/Dockerfile work above is idempotent.
      throw new Error(`KakaoTalk authentication failed: ${result.reason}`)
    }
  }

  if (withWebexUser && runWebexAuth !== undefined) {
    emit({ step: 'webex-auth', phase: 'start' })
    const result = await runWebexAuth({ cwd })
    emit({ step: 'webex-auth', phase: 'done', result })
    if (!result.ok) {
      throw new Error(`Webex authentication failed: ${result.reason}`)
    }
  }

  if (withDiscordUser) {
    emit({ step: 'discord-auth', phase: 'start' })
    const runner = runDiscordAuth ?? defaultDiscordAuthRunner
    const result = await runner({ cwd })
    emit({ step: 'discord-auth', phase: 'done', result })
    if (!result.ok) {
      throw new Error(`Discord authentication failed: ${result.reason}`)
    }
  }

  // Write the structured github channel block alongside scaffold's bot-token
  // blocks. We do NOT delegate to runAddChannel because that's the `channel
  // add` semantics — strict no-overwrite, throws when secrets.json#channels
  // .github already exists. Init is a different contract: re-running it
  // regenerates config from the wizard's current inputs (scaffold() already
  // overwrites typeclaw.json wholesale on every run), so failing on an
  // existing secret block here would brick the re-init recovery path the
  // bot-token adapters all support.
  if (withGithub && githubCredentials !== undefined) {
    await writeGithubChannelForInit(cwd, githubCredentials)
    if (githubCredentials.webhookUrl !== undefined && githubCredentials.repos.length > 0) {
      emit({ step: 'github-webhooks', phase: 'start' })
      const result = await installGithubWebhooksEagerly({
        webhookUrl: githubCredentials.webhookUrl,
        webhookSecret: githubCredentials.webhookSecret,
        repos: githubCredentials.repos,
        auth: githubCredentials.auth,
        agentDir: cwd,
        ...(githubFetchImpl !== undefined ? { fetchImpl: githubFetchImpl } : {}),
      })
      emit({ step: 'github-webhooks', phase: 'done', result })
    }
  }

  emit({ step: 'install', phase: 'start' })
  // Native-Windows dev-mode emits `link:typeclaw` (see resolveTypeclawSpec);
  // register the checkout with `bun link` first so the subsequent install
  // resolves it to a symlink bun SKIPS copying, instead of `file:` copying the
  // checkout (incl `.git/`) and EPERMing — the #899 path. Registry deps still
  // install normally. No-op on POSIX / registry installs.
  await maybeLinkWindowsDevTypeclaw(platform, runBunLink)
  const install = await installRunner(cwd)
  emit({ step: 'install', phase: 'done', result: install })
  if (!install.ok) throw new Error(`Dependency install failed: ${install.reason}`)

  emit({ step: 'dockerfile', phase: 'start' })
  const docker = await writeDockerAssets(cwd)
  emit({ step: 'dockerfile', phase: 'done', result: docker })
  if (!docker.ok) throw new Error(`Dockerfile generation failed: ${docker.reason}`)

  emit({ step: 'git', phase: 'start' })
  const git = await initGitRepo(cwd)
  emit({ step: 'git', phase: 'done', result: git })

  const configuredChannels: ChannelKind[] = []
  if (wantsDiscord) configuredChannels.push('discord-bot')
  if (withDiscordUser) configuredChannels.push('discord')
  if (wantsSlack) configuredChannels.push('slack-bot')
  if (wantsTelegram) configuredChannels.push('telegram-bot')
  if (wantsWebex) configuredChannels.push('webex-bot')
  if (withWebexUser) configuredChannels.push('webex')
  if (withKakaotalk) configuredChannels.push('kakaotalk')
  if (withGithub) configuredChannels.push('github')

  emit({ step: 'hatching', phase: 'start' })
  const hatching = await runHatching({
    cwd,
    port: config.port,
    ...(cliEntry !== undefined ? { cliEntry } : {}),
    ...(configuredChannels.length > 0 ? { configuredChannels } : {}),
  })
  emit({ step: 'hatching', phase: 'done', result: hatching })
}

// Exported for the composition test in index.test.ts: the seam that the
// hatching-hostd fix turns on (passing `cliEntry` into `start()`) is the bug
// site itself, so a guard test that proves `defaultRunHatching` forwards
// `cliEntry` to `start()` is what blocks the regression from coming back.
// Tests inject `startContainer` and `tui` to avoid Docker / TUI side effects;
// production callers omit both and get the real `start` + `createTui`.
export async function defaultRunHatching({
  cwd,
  port,
  cliEntry,
  configuredChannels,
  startContainer = start,
  tui: tuiFactory = createTui,
  waitForAgent: waitForAgentFn = waitForAgent,
  runClaim = defaultRunClaim,
  stopContainer = stop,
}: {
  cwd: string
  port: number
  cliEntry?: string
  configuredChannels?: readonly ChannelKind[]
  startContainer?: typeof start
  tui?: typeof createTui
  waitForAgent?: typeof waitForAgent
  runClaim?: ClaimRunner
  stopContainer?: typeof stop
}): Promise<HatchingResult> {
  let launch: Extract<StartResult, { ok: true }> | null = null
  try {
    const startResult = await startContainer({
      cwd,
      preferredHostPort: port,
      ...(cliEntry !== undefined ? { cliEntry } : {}),
    })
    if (!startResult.ok) return { ok: false, reason: startResult.reason }
    launch = startResult

    // start() may have allocated a different host port (the preferred one was
    // bound). Use the actually-published port for the TUI handshake instead of
    // the preferred port, otherwise we'd connect to the wrong service.
    const hostPort = launch.hostPort

    await waitForAgentFn(`http://127.0.0.1:${hostPort}`, { timeoutMs: hatchingReadinessTimeoutMs() })

    if (configuredChannels !== undefined && configuredChannels.length > 0) {
      const url = buildTuiUrl(hostPort, launch.tuiToken)
      await runClaim({ url, configuredChannels })
    }

    const typeclawJsonContent = await readTypeclawJsonRaw(cwd)
    const tui = tuiFactory({
      url: buildTuiUrl(hostPort, launch.tuiToken),
      initialPrompt: buildHatchingPrompt(typeclawJsonContent !== undefined ? { typeclawJsonContent } : undefined),
    })
    await tui.run()
    return { ok: true }
  } catch (error) {
    if (launch !== null && !launch.alreadyRunning) {
      await stopContainer({ cwd }).catch(() => {})
    }
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

// Read the raw bytes of `typeclaw.json` to inline into the hatching prompt.
// Returns `undefined` on any failure so the agent falls back to reading the
// file itself — hatching must not abort just because we couldn't pre-fetch.
async function readTypeclawJsonRaw(cwd: string): Promise<string | undefined> {
  try {
    return await readFile(join(cwd, CONFIG_FILE), 'utf8')
  } catch {
    return undefined
  }
}

export type ClaimRunner = (options: { url: string; configuredChannels: readonly ChannelKind[] }) => Promise<void>

const defaultRunClaim: ClaimRunner = async ({ url, configuredChannels }) => {
  const { runOwnerClaim } = await import('./run-owner-claim')
  await runOwnerClaim({ url, configuredChannels })
}

function buildTuiUrl(hostPort: number, token: string | null): string {
  const url = new URL(`ws://127.0.0.1:${hostPort}`)
  if (token !== null) url.searchParams.set('token', token)
  return url.toString()
}

// Cold-boot readiness budget for the first `typeclaw init`. The image was just
// unpacked and the agent folder (incl. a large node_modules) is bind-mounted
// into the container, so the very first server boot is markedly slower than
// subsequent `typeclaw start`s — plugin loading reads hundreds of files off a
// cold mount before Bun.serve() binds the port. On Windows Docker Desktop that
// mount crosses into the WSL2 VM and is slower still; during the warmup window
// Docker Desktop's port proxy may accept then immediately reset connections
// ("socket connection was closed unexpectedly"), which is why a too-short budget
// fails the first run even though an immediate retry (warm caches) succeeds.
// Give Windows a generous budget; keep other platforms tighter.
export function hatchingReadinessTimeoutMs(platform: NodeJS.Platform = process.platform): number {
  return isWindows(platform) ? 120_000 : 60_000
}

// Probe the server's plain HTTP fallback (non-upgrade requests get a 200 with
// body "typeclaw agent") instead of opening a WebSocket. Opening a WS here
// would trigger createSession on the server and burn an LLM session just to
// learn the port is up.
async function waitForAgent(httpUrl: string, { timeoutMs }: { timeoutMs: number }): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const res = await fetch(httpUrl)
      if (res.status === 200) return
      lastError = new Error(`unexpected status ${res.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`timed out waiting for agent at ${httpUrl}: ${lastError instanceof Error ? lastError.message : ''}`)
}

export function isDirectoryNonEmpty(dir: string): boolean {
  try {
    return readdirSync(dir).some((entry) => !entry.startsWith('.'))
  } catch {
    return false
  }
}

const HATCHED_COMMIT_SUBJECT = 'Hatched 🐣'

export async function isHatched(dir: string): Promise<boolean> {
  if (!existsSync(join(dir, '.git'))) return false
  const bun = (globalThis as { Bun?: { spawn: typeof Bun.spawn } }).Bun
  if (!bun) return false
  try {
    const proc = bun.spawn({ cmd: ['git', 'log', '--format=%s'], cwd: dir, stdout: 'pipe', stderr: 'pipe' })
    if ((await proc.exited) !== 0) return false
    const subjects = (await new Response(proc.stdout).text()).split('\n')
    return subjects.includes(HATCHED_COMMIT_SUBJECT)
  } catch {
    return false
  }
}

export type ScaffoldOptions = {
  model?: ModelRef | string
  modelMeta?: CustomModelMeta
  visionModel?: ModelRef | string
  visionModelMeta?: CustomModelMeta
  withDiscord?: boolean
  withDiscordUser?: boolean
  withSlack?: boolean
  withTelegram?: boolean
  withWebex?: boolean
  withWebexUser?: boolean
  withKakaotalk?: boolean
  // Defaults to `process.platform`; controls the dev-mode typeclaw spec
  // (`link:` on Windows, `file:` on POSIX). Tests inject it.
  platform?: NodeJS.Platform
}

export async function scaffold(root: string, options: ScaffoldOptions = {}): Promise<void> {
  await Promise.all(DIRECTORIES.map((dir) => mkdir(join(root, dir), { recursive: true })))

  // git does not track empty directories, so without these files the empty
  // `packages/` (a bun workspace root) and `public/` (the guest-visible zone)
  // would silently disappear from the initial commit. The other DIRECTORIES are
  // either gitignored (workspace, sessions, mounts) or immediately populated.
  await Promise.all([
    writeFile(join(root, PACKAGES_DIR, GITKEEP_FILE), '', { flag: 'wx' }).catch(ignoreExists),
    writeFile(join(root, PUBLIC_DIR, GITKEEP_FILE), '', { flag: 'wx' }).catch(ignoreExists),
  ])

  // Only fields without sensible defaults elsewhere are emitted. Everything
  // with a schema-provided default (e.g. `network.blockInternal`, `mounts`,
  // `memory.*`) is omitted to keep the scaffold minimal — duplicating defaults
  // here would mean every schema change has to be mirrored in two places, and
  // users would feel obligated to maintain values they never set.
  const models: Record<string, string> = { default: options.model ?? DEFAULT_MODEL_REF }
  if (options.visionModel !== undefined) models.vision = options.visionModel
  const config: Record<string, unknown> = {
    $schema: './node_modules/typeclaw/typeclaw.schema.json',
    models,
  }
  const customModels = collectCustomModels(options)
  if (Object.keys(customModels).length > 0) config.customModels = customModels
  const channels: Record<string, Record<string, never>> = {}
  if (options.withDiscord) channels['discord-bot'] = {}
  if (options.withDiscordUser) channels.discord = {}
  if (options.withSlack) channels['slack-bot'] = {}
  if (options.withTelegram) channels['telegram-bot'] = {}
  if (options.withWebex) channels['webex-bot'] = {}
  if (options.withWebexUser) channels.webex = {}
  if (options.withKakaotalk) channels.kakaotalk = {}
  if (Object.keys(channels).length > 0) config.channels = channels
  // No default `member` match is seeded. A fresh chat agent starts with every
  // inbound author resolving to `guest` (dropped) until the operator claims
  // `owner` (runOwnerClaim, post-hatch) and explicitly grants others. GitHub is
  // wired separately and seeds per-repo `member.match` entries scoped to the
  // opted-in repos. See runOwnerClaim for the mute-until-claimed warning.
  await writeFile(join(root, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`)

  const cron = {
    $schema: './node_modules/typeclaw/cron.schema.json',
    jobs: [],
  }
  await writeFile(join(root, CRON_FILE), `${JSON.stringify(cron, null, 2)}\n`, { flag: 'wx' }).catch(ignoreExists)

  const pkg = buildPackageJson(root, basename(root), options.platform ?? process.platform)
  await writeFile(join(root, PACKAGE_FILE), `${JSON.stringify(pkg, null, 2)}\n`, { flag: 'wx' }).catch(ignoreExists)

  await Promise.all(MARKDOWN_FILES.map((file) => writeFile(join(root, file), '', { flag: 'wx' }).catch(ignoreExists)))

  await writeFile(join(root, GITIGNORE_FILE), buildGitignore(), { flag: 'wx' }).catch(ignoreExists)
}

function collectCustomModels(options: ScaffoldOptions): Record<string, CustomModelMeta> {
  const customModels: Record<string, CustomModelMeta> = {}
  addCustomModel(customModels, options.model ?? DEFAULT_MODEL_REF, options.modelMeta)
  if (options.visionModel !== undefined) addCustomModel(customModels, options.visionModel, options.visionModelMeta)
  return customModels
}

function addCustomModel(
  customModels: Record<string, CustomModelMeta>,
  ref: string,
  meta: CustomModelMeta | undefined,
): void {
  if (isKnownModelRef(ref)) return
  customModels[ref] = meta ?? {}
}

// agent-browser ships in every agent: the bundled SKILL.md (src/skills/
// agent-browser/SKILL.md) is a discovery stub that calls `agent-browser
// skills get core` at runtime, so the CLI must be installed for the skill
// to function. The Dockerfile pre-downloads Chromium too, so the agent
// can drive a browser without any first-run setup.
//
// Must match the Dockerfile Layer 4 global install (dockerfile.ts); they are
// two installs of the same CLI and a skew is silent. Enforced by a guard test
// in packagejson.test.ts.
export const AGENT_BROWSER_VERSION = '^0.27.0'
function buildPackageJson(root: string, name: string, platform: NodeJS.Platform): Record<string, unknown> {
  return {
    name,
    private: true,
    type: 'module',
    workspaces: [`${PACKAGES_DIR}/*`],
    dependencies: {
      typeclaw: resolveTypeclawSpec(root, platform),
      'agent-browser': AGENT_BROWSER_VERSION,
      [GWS_MULTI_ACCOUNT_PLUGIN_PACKAGE]: GWS_MULTI_ACCOUNT_PLUGIN_VERSION,
    },
    typeclaw: {
      managedPlugins: {
        [GWS_MULTI_ACCOUNT_PLUGIN_PACKAGE]: GWS_MULTI_ACCOUNT_PLUGIN_VERSION,
      },
    },
  }
}

async function maybeLinkWindowsDevTypeclaw(
  platform: NodeJS.Platform,
  runBunLink: RunBunLink | undefined,
): Promise<void> {
  const typeclawRoot = typeclawCheckoutRoot()
  if (typeclawRoot === null) return
  await linkWindowsDevTypeclaw(typeclawRoot, { platform, ...(runBunLink !== undefined ? { runBunLink } : {}) })
}

export async function writeDockerAssets(root: string): Promise<DockerAssetsResult> {
  try {
    const pkg = await readPackageJson(root)
    const typeclawSpec = pkg.dependencies?.typeclaw ?? ''
    // Both `file:` (POSIX dev) and `link:` (native-Windows dev, see
    // resolveTypeclawSpec) are locally-linked checkouts that must inline the
    // heavy stack on the slim base, since the matching GHCR base tag for an
    // unreleased dev build does not exist. Mirrors hasLocallyLinkedTypeclawDep.
    const devMode = typeclawSpec.startsWith('file:') || typeclawSpec.startsWith('link:')

    const typeclawConfig = await readTypeclawConfig(root)
    await writeFile(
      join(root, DOCKERFILE),
      buildDockerfile(typeclawConfig.docker.file, {
        // A local-spec dev install must inline the heavy stack: its unreleased
        // version has no published `typeclaw-base` tag, so resolving a base
        // image version would pin a nonexistent `FROM ghcr.io/...:<version>`.
        // `null` selects the inline `oven/bun:1-slim` path in buildDockerfile.
        baseImageVersion: devMode ? null : resolveBaseImageVersion(root),
        cjkFontsAuto: hostLocaleIsCjk(),
      }),
      { flag: 'wx' },
    ).catch(ignoreExists)

    return { ok: true, devMode }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

async function readPackageJson(root: string): Promise<{ name?: string; dependencies?: Record<string, string> }> {
  const raw = await readFile(join(root, PACKAGE_FILE), 'utf8')
  return JSON.parse(raw) as { name?: string; dependencies?: Record<string, string> }
}

async function readTypeclawConfig(root: string): Promise<Config> {
  try {
    const raw = await readFile(join(root, CONFIG_FILE), 'utf8')
    return configSchema.parse(migrateLegacyConfigShape(JSON.parse(raw)).json)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return configSchema.parse({})
    throw error
  }
}

export async function initGitRepo(cwd: string): Promise<GitInitResult> {
  const bun = (globalThis as { Bun?: { spawn: typeof Bun.spawn } }).Bun
  if (!bun) return { ok: false, reason: 'bun runtime not available' }

  const hasGit = existsSync(join(cwd, '.git'))

  // Author the initial commit as TypeClaw itself. The agent is still unnamed
  // (IDENTITY.md is empty and hatching hasn't run), so the agent identity will
  // take over from the hatching commit onward. This also avoids depending on
  // the user's global `user.name`/`user.email`.
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'TypeClaw',
    GIT_AUTHOR_EMAIL: 'hello@typeclaw.dev',
    GIT_COMMITTER_NAME: 'TypeClaw',
    GIT_COMMITTER_EMAIL: 'hello@typeclaw.dev',
  }

  try {
    if (hasGit) {
      const head = bun.spawn({
        cmd: ['git', 'rev-parse', '--verify', 'HEAD'],
        cwd,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      if ((await head.exited) === 0) return { ok: true, skipped: true }
    } else {
      const init = bun.spawn({ cmd: ['git', 'init', '-b', 'main'], cwd, env, stdout: 'pipe', stderr: 'pipe' })
      if ((await init.exited) !== 0) {
        const stderr = await new Response(init.stderr).text()
        return { ok: false, reason: `git init failed: ${stderr.trim() || 'no stderr'}` }
      }
    }

    const add = bun.spawn({ cmd: ['git', 'add', '.'], cwd, env, stdout: 'pipe', stderr: 'pipe' })
    if ((await add.exited) !== 0) {
      const stderr = await new Response(add.stderr).text()
      return { ok: false, reason: `git add failed: ${stderr.trim() || 'no stderr'}` }
    }

    const commit = bun.spawn({
      cmd: ['git', 'commit', '-m', 'Initial commit 🥚'],
      cwd,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if ((await commit.exited) !== 0) {
      const stderr = await new Response(commit.stderr).text()
      return { ok: false, reason: `git commit failed: ${stderr.trim() || 'no stderr'}` }
    }

    return { ok: true, skipped: false }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

// Writes LLM provider API keys to `secrets.json#providers` and channel adapter
// tokens to `secrets.json#channels`. Both paths go through the structured
// v2 secrets envelope so reruns can reuse existing values without depending on
// host-stage env files.
export async function writeSecrets(
  root: string,
  {
    model = DEFAULT_MODEL_REF,
    apiKey,
    visionModel,
    visionApiKey,
    discordBotToken,
    slackBotToken,
    slackAppToken,
    telegramBotToken,
    webexBotToken,
  }: {
    model?: ModelRef | string
    // Omitted on the OAuth path — credentials live in secrets.json via the OAuth runner.
    apiKey?: string
    visionModel?: ModelRef | string
    visionApiKey?: string
    discordBotToken?: string
    slackBotToken?: string
    slackAppToken?: string
    telegramBotToken?: string
    webexBotToken?: string
  },
): Promise<void> {
  const providerId = providerForModelRef(model)
  const apiKeyEnv = KNOWN_PROVIDERS[providerId].apiKeyEnv
  const wantsDefaultKey = apiKey !== undefined && apiKeyEnv !== null
  const visionProviderId = visionModel !== undefined ? providerForModelRef(visionModel) : null
  const wantsVisionKey =
    visionModel !== undefined &&
    visionApiKey !== undefined &&
    visionProviderId !== providerId &&
    visionProviderId !== null &&
    KNOWN_PROVIDERS[visionProviderId].apiKeyEnv !== null
  if (wantsDefaultKey || wantsVisionKey) {
    const secretsStore = createSecretsStoreForAgent(join(root, 'secrets.json'))
    if (wantsDefaultKey) secretsStore.set(providerId, { type: 'api_key', key: apiKey! })
    if (wantsVisionKey) {
      secretsStore.set(visionProviderId, { type: 'api_key', key: visionApiKey! })
    }
  }

  const channelTokens: Record<string, Record<string, Secret>> = {}
  if (discordBotToken !== undefined && discordBotToken !== '') {
    channelTokens['discord-bot'] = { token: { value: discordBotToken } }
  }
  if (slackBotToken !== undefined && slackBotToken !== '') {
    channelTokens['slack-bot'] = { ...channelTokens['slack-bot'], botToken: { value: slackBotToken } }
  }
  if (slackAppToken !== undefined && slackAppToken !== '') {
    channelTokens['slack-bot'] = { ...channelTokens['slack-bot'], appToken: { value: slackAppToken } }
  }
  if (telegramBotToken !== undefined && telegramBotToken !== '') {
    channelTokens['telegram-bot'] = { token: { value: telegramBotToken } }
  }
  if (webexBotToken !== undefined && webexBotToken !== '') {
    channelTokens['webex-bot'] = { token: { value: webexBotToken } }
  }
  if (Object.keys(channelTokens).length === 0) return

  const backend = new SecretsBackend(join(root, 'secrets.json'))
  const existing = backend.readChannelsSync()
  const merged: Channels = { ...existing }
  for (const [adapterId, fields] of Object.entries(channelTokens)) {
    const priorSlot = isObjectRecord(merged[adapterId]) ? { ...(merged[adapterId] as Record<string, unknown>) } : {}
    for (const [k, v] of Object.entries(fields)) priorSlot[k] = v
    merged[adapterId] = priorSlot as Channels[string]
  }
  backend.writeChannelsSync(merged)
}

export async function readExistingProviderApiKey(root: string, providerId: KnownProviderId): Promise<string | null> {
  const provider = KNOWN_PROVIDERS[providerId]
  if (provider.apiKeyEnv === null) return null
  return new SecretsBackend(join(root, 'secrets.json')).tryReadProviderApiKeySync(providerId)
}

// Detects whether the requested provider has usable OAuth credentials already
// written to `secrets.json#providers.<oauthProviderId>`. Used by the init
// wizard's auto-resume path: when the user picks an OAuth-capable provider
// and credentials already exist on disk from a prior partial run, skip the
// browser login entirely instead of dragging them through a second OAuth
// flow.
//
// Mirrors `readExistingProviderApiKey`'s contract — returns `false` when the
// provider has no OAuth support, the file is missing, the slot is api-key
// shaped, or the access token is absent/blank.
//
// The token lives under `access` — pi-ai's secrets.json shape (`{ type:
// 'oauth', access, refresh, expires, accountId }`), the same field
// `export-codex-auth-file.ts` reads. NOT `access_token`: that key belongs to
// the unrelated `~/.codex/auth.json` export (`{ tokens: { access_token } }`).
// Reading `access_token` here silently returned false for every real
// credential, re-running the browser login on resume instead of reusing it.
//
// Freshness is intentionally not checked: pi-ai refreshes on first use, and a
// network call mid-wizard isn't worth it.
export async function hasExistingOAuthCredentials(root: string, providerId: KnownProviderId): Promise<boolean> {
  const provider = KNOWN_PROVIDERS[providerId]
  if (provider.oauthProviderId === null) return false
  const backend = new SecretsBackend(join(root, 'secrets.json'))
  const providers = backend.tryReadProvidersSync()
  const credential = providers[provider.oauthProviderId]
  if (credential === undefined) return false
  if (credential.type !== 'oauth') return false
  const access = (credential as { access?: unknown }).access
  return typeof access === 'string' && access.trim().length > 0
}

// Detects whether the requested channel already has usable credentials in
// `secrets.json#channels`, so the init wizard can offer to reuse them
// instead of re-prompting for tokens. Mirrors `readExistingProviderApiKey`:
// returns `true` only when ALL fields the adapter needs are present in a
// shape `hydrateChannelEnvFromSecrets` would inject at runtime — both the
// `{ value }` form and the `{ env }` env-binding form count, matching the
// runtime resolution rules in `src/secrets/resolve.ts`. Partial slots (e.g.
// `slack-bot` with `botToken` but no `appToken`) return `false` so the
// missing field gets filled in by the normal prompt.
//
// KakaoTalk reuse is stricter: a usable block requires both a complete
// account (currentAccount + matching entry in accounts) AND the renewal
// fields (email + encryptedPassword) the hostd renewal cron needs to mint
// fresh tokens unattended (`src/secrets/kakao-renewal.ts`). Without those,
// the saved `oauth_token` will work only until KakaoTalk's ~7-day TTL
// expires, after which the user has to run `typeclaw channel reauth
// kakaotalk` anyway — better to re-auth now during init.
export async function hasExistingChannelSecrets(
  root: string,
  channel: 'discord' | 'slack' | 'telegram' | 'webex' | 'line' | 'kakaotalk' | 'github',
): Promise<boolean> {
  const channels = new SecretsBackend(join(root, 'secrets.json')).tryReadChannelsSync()
  if (channels === null) return false
  switch (channel) {
    case 'discord':
      return hasSecretField(channels['discord-bot'], 'token')
    case 'slack':
      return hasSecretField(channels['slack-bot'], 'botToken') && hasSecretField(channels['slack-bot'], 'appToken')
    case 'telegram':
      return hasSecretField(channels['telegram-bot'], 'token')
    case 'webex':
      return hasCurrentWebexAccount(channels.webex)
    case 'github':
      // GitHub credentials alone are not enough to scaffold a working
      // channel: typeclaw.json#channels.github also needs webhookUrl and
      // webhookPort, which only the user can supply. Always force a fresh
      // prompt in the wizard so those fields end up in typeclaw.json. The
      // existing `secrets.json#channels.github` (if any) is detected and
      // surfaced as a hard error inside `runAddChannel` to prevent silent
      // overwrites.
      return false
    case 'line': {
      // A usable LINE block needs a current account whose record carries an
      // auth_token. Unlike KakaoTalk there are no renewal fields (email +
      // encrypted password) to require — LINE has no unattended renewal cron.
      const block = channels.line
      if (!isObjectRecord(block)) return false
      const current = (block as { currentAccount?: unknown }).currentAccount
      if (typeof current !== 'string' || current.length === 0) return false
      const accounts = (block as { accounts?: unknown }).accounts
      if (!isObjectRecord(accounts)) return false
      const account = accounts[current]
      if (!isObjectRecord(account)) return false
      const authToken = (account as { auth_token?: unknown }).auth_token
      return typeof authToken === 'string' && authToken.length > 0
    }
    case 'kakaotalk': {
      const block = channels.kakaotalk
      if (!isObjectRecord(block)) return false
      const current = (block as { currentAccount?: unknown }).currentAccount
      if (typeof current !== 'string' || current.length === 0) return false
      const accounts = (block as { accounts?: unknown }).accounts
      if (!isObjectRecord(accounts)) return false
      const account = accounts[current]
      if (!isObjectRecord(account)) return false
      const email = (account as { email?: unknown }).email
      const encryptedPassword = (account as { encryptedPassword?: unknown }).encryptedPassword
      return typeof email === 'string' && email.length > 0 && isObjectRecord(encryptedPassword)
    }
  }
}

// Accepts either the `{ value }` form (resolves to a literal at runtime) or
// the `{ env }` form (resolves at runtime by reading `process.env[<env>]`).
// String shorthand is sugar for `{ value }`. The schema already rejects
// empty strings via `z.string().min(1)`, so the length checks here are
// defense-in-depth against forward-compat shape drift.
function hasSecretField(slot: unknown, field: string): boolean {
  if (!isObjectRecord(slot)) return false
  const secret = slot[field]
  if (typeof secret === 'string') return secret.length > 0
  if (isObjectRecord(secret)) {
    const value = (secret as { value?: unknown }).value
    if (typeof value === 'string' && value.length > 0) return true
    const env = (secret as { env?: unknown }).env
    if (typeof env === 'string' && env.length > 0) return true
  }
  return false
}

function hasCurrentWebexAccount(block: unknown): boolean {
  if (!isObjectRecord(block)) return false
  const current = (block as { currentAccount?: unknown }).currentAccount
  if (typeof current !== 'string' || current.length === 0) return false
  const accounts = (block as { accounts?: unknown }).accounts
  if (!isObjectRecord(accounts)) return false
  const account = accounts[current]
  if (!isObjectRecord(account)) return false
  const token = (account as { access_token?: unknown }).access_token
  const email = (account as { email?: unknown }).email
  const encryptedPassword = (account as { encryptedPassword?: unknown }).encryptedPassword
  return typeof token === 'string' && token.length > 0 && typeof email === 'string' && isObjectRecord(encryptedPassword)
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function resolveLLMAuth(llmAuth: LLMAuth | undefined, apiKey: string | undefined): LLMAuth {
  if (llmAuth) return llmAuth
  if (apiKey !== undefined) return { kind: 'api-key', apiKey }
  throw new Error('runInit requires either `llmAuth` or `apiKey`')
}

function ignoreExists(error: NodeJS.ErrnoException): void {
  if (error.code !== 'EEXIST') throw error
}

// ----------------------------------------------------------------------------
// `typeclaw channel add`
//
// `runAddChannel` is the post-init counterpart to `runInit`'s channel-related
// steps. It is intentionally a separate pipeline rather than a mode switch on
// `runInit` because the two have opposite file semantics:
//
//   - `runInit` creates a fresh agent folder. Writes overwrite by design
//     (typeclaw.json, .env), and idempotency comes from `wx`-flag guards on
//     never-rewritten files (markdown stubs, cron.json, package.json).
//
//   - `runAddChannel` mutates an already-initialized agent folder. It MUST
//     preserve the user's existing channel config and existing .env values.
//     The only writes are an additive merge of one new channel adapter and
//     an append of that adapter's env vars.
//
// Sharing one function would pile mode flags on every helper and turn the
// "is this overwrite or merge?" question into a runtime branch the test
// suite would have to cover for both behaviors. The mass of independent
// scaffold-test cases above demonstrates how easy it is to lose a single
// behavior under a mode flag.

export type ChannelKind =
  | 'discord'
  | 'discord-bot'
  | 'slack'
  | 'slack-bot'
  | 'telegram-bot'
  | 'webex'
  | 'webex-bot'
  | 'line'
  | 'kakaotalk'
  | 'github'

// Public adapter names match the typeclaw.json `channels.*` keys exactly.
// The CLI takes these as the optional positional arg, the picker shows
// these labels, and they're the keys we use to detect "already configured"
// when reading typeclaw.json.
export const CHANNEL_KINDS: ReadonlyArray<ChannelKind> = [
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
]

export type AddChannelStep =
  | 'line-auth'
  | 'kakaotalk-auth'
  | 'webex-auth'
  | 'discord-auth'
  | 'slack-auth'
  | 'config'
  | 'secrets'
  | 'github-webhooks'

export type AddChannelStepEvent =
  | { step: 'config'; phase: 'start' }
  | { step: 'config'; phase: 'done' }
  | { step: 'line-auth'; phase: 'start' }
  | { step: 'line-auth'; phase: 'done'; result: LineAuthResult }
  | { step: 'kakaotalk-auth'; phase: 'start' }
  | { step: 'kakaotalk-auth'; phase: 'done'; result: KakaotalkAuthResult }
  | { step: 'webex-auth'; phase: 'start' }
  | { step: 'webex-auth'; phase: 'done'; result: WebexAuthResult }
  | { step: 'discord-auth'; phase: 'start' }
  | { step: 'discord-auth'; phase: 'done'; result: DiscordAuthResult }
  | { step: 'slack-auth'; phase: 'start' }
  | { step: 'slack-auth'; phase: 'done'; result: SlackAuthResult }
  | { step: 'secrets'; phase: 'start' }
  | { step: 'secrets'; phase: 'done' }
  | { step: 'github-webhooks'; phase: 'start' }
  | { step: 'github-webhooks'; phase: 'done'; result: EagerGithubWebhookInstallResult }

// Discriminated union per channel so the type system enforces "you must pass
// the right credentials for the channel you're adding". The CLI builds these
// from prompts; tests build them inline.
export type AddChannelOptions = {
  cwd: string
  instanceId?: string
  accountId?: string
  onProgress?: (event: AddChannelStepEvent) => void
} & (
  | { channel: 'discord-bot'; discordBotToken: string }
  | { channel: 'discord'; runDiscordAuth: DiscordAuthRunner }
  | { channel: 'slack'; slackQrDataUrl: string; runSlackAuth?: SlackAuthRunner }
  | { channel: 'slack-bot'; slackBotToken: string; slackAppToken: string }
  | { channel: 'telegram-bot'; telegramBotToken: string }
  | { channel: 'webex-bot'; webexBotToken: string }
  | { channel: 'webex'; runWebexAuth: WebexAuthRunner }
  | { channel: 'line'; runLineAuth: LineAuthRunner }
  | { channel: 'kakaotalk'; runKakaotalkAuth: KakaotalkAuthRunner }
  | {
      channel: 'github'
      webhookSecret: string
      tunnelProvider: GithubTunnelProvider
      webhookUrl?: string
      webhookPort?: number
      hostname?: string
      tokenEnv?: string
      repos: string[]
      auth: { type: 'pat'; pat: string } | { type: 'app'; appId: number; privateKey: string }
      fetchImpl?: typeof fetch
    }
)

export type SlackAuthRunner = (options: { cwd: string; qrDataUrl: string }) => Promise<SlackAuthResult>
export type DiscordAuthRunner = (options: { cwd: string }) => Promise<DiscordAuthResult>

export async function runAddChannel(options: AddChannelOptions): Promise<void> {
  const emit = options.onProgress ?? (() => {})
  const priorAccountIds = isUserModeAdapter(options.channel)
    ? readChannelAccountIds(options.cwd, options.channel)
    : new Set<string>()
  const priorCurrentAccountId = isUserModeAdapter(options.channel)
    ? readCurrentChannelAccountId(options.cwd, options.channel)
    : undefined

  // Order: kakaotalk-auth (if applicable) -> config -> secrets.
  //
  // We run KakaoTalk auth FIRST so a failed login leaves typeclaw.json and
  // .env untouched. The runtime treats `channels.kakaotalk` without a
  // secrets.json#channels.kakaotalk block as "missing credentials, skip adapter", which silently
  // drops messages — the same trap `runInit` already guards against. Aborting
  // before any file write means the user's next `typeclaw channel add
  // kakaotalk` retry has no half-applied state to clean up.
  if (options.channel === 'line') {
    emit({ step: 'line-auth', phase: 'start' })
    const result = await options.runLineAuth({ cwd: options.cwd })
    emit({ step: 'line-auth', phase: 'done', result })
    if (!result.ok) throw new Error(`LINE authentication failed: ${result.reason}`)
  }

  if (options.channel === 'kakaotalk') {
    emit({ step: 'kakaotalk-auth', phase: 'start' })
    const result = await options.runKakaotalkAuth({ cwd: options.cwd })
    emit({ step: 'kakaotalk-auth', phase: 'done', result })
    if (!result.ok) throw new Error(`KakaoTalk authentication failed: ${result.reason}`)
  }

  if (options.channel === 'webex') {
    emit({ step: 'webex-auth', phase: 'start' })
    const result = await options.runWebexAuth({ cwd: options.cwd })
    emit({ step: 'webex-auth', phase: 'done', result })
    if (!result.ok) throw new Error(`Webex authentication failed: ${result.reason}`)
  }

  if (options.channel === 'discord') {
    emit({ step: 'discord-auth', phase: 'start' })
    const result = await options.runDiscordAuth({ cwd: options.cwd })
    emit({ step: 'discord-auth', phase: 'done', result })
    if (!result.ok) throw new Error(`Discord authentication failed: ${result.reason}`)
  }

  if (options.channel === 'slack') {
    emit({ step: 'slack-auth', phase: 'start' })
    const runner = options.runSlackAuth ?? defaultSlackAuthRunner
    const result = await runner({ cwd: options.cwd, qrDataUrl: options.slackQrDataUrl })
    emit({ step: 'slack-auth', phase: 'done', result })
    if (!result.ok) throw new Error(`Slack authentication failed: ${result.reason}`)
  }

  const instanceAccountId = isUserModeAdapter(options.channel)
    ? resolveInstanceAccountId(options.cwd, options.channel, priorAccountIds, options.accountId)
    : undefined

  emit({ step: 'config', phase: 'start' })
  await mergeChannelIntoConfig(options.cwd, options, instanceAccountId, priorCurrentAccountId)
  emit({ step: 'config', phase: 'done' })

  emit({ step: 'secrets', phase: 'start' })
  const tokens = channelSecretsFromOptions(options)
  if (Object.keys(tokens).length > 0) {
    await appendChannelSecrets(options.cwd, options.channel, tokens)
  }
  if (options.channel === 'github') {
    await appendGithubSecrets(options.cwd, options)
  }
  emit({ step: 'secrets', phase: 'done' })

  if (options.channel === 'github') {
    await appendGithubMatchRules(options.cwd, options.repos)
    await maybeInstallGithubWebhooks(options, emit)
  }

  // Commit the typeclaw.json change so the agent folder isn't silently
  // dirty after `typeclaw channel add`. Same `commitSystemFile` contract as
  // every other host-side rewrite: no-op outside a git repo, when Bun is
  // unavailable, or when the file is clean. secrets.json is gitignored, so
  // only typeclaw.json is named here.
  await commitSystemFile(options.cwd, CONFIG_FILE, `channel: add ${options.channel}`)
}

// Eager webhook registration is best-effort: a failure here MUST NOT roll
// back the typeclaw.json / secrets.json writes. The container-side adapter
// re-runs registration on every start, so a missing PAT scope or a transient
// 5xx today gets retried automatically on the next `typeclaw start`. We
// surface the per-repo outcome as a structured event so the CLI can render
// it, but we never throw.
async function maybeInstallGithubWebhooks(
  options: Extract<AddChannelOptions, { channel: 'github' }>,
  emit: (event: AddChannelStepEvent) => void,
): Promise<void> {
  // For `external` and `cloudflare-named` we know the public URL up front
  // (user-supplied `webhookUrl` or dashboard-configured `hostname`), so we
  // can register the webhook on GitHub's side eagerly. For `cloudflare-quick`
  // the URL only exists once cloudflared has emitted it on stderr inside the
  // container, which hasn't happened yet at host-stage init/channel-add
  // time — registration is deferred to the adapter's first `start()`.
  const eagerUrl = resolveEagerWebhookUrl(options)
  if (eagerUrl === undefined) return
  if (options.repos.length === 0) return
  emit({ step: 'github-webhooks', phase: 'start' })
  const result = await installGithubWebhooksEagerly({
    webhookUrl: eagerUrl,
    webhookSecret: options.webhookSecret,
    repos: options.repos,
    auth: options.auth,
    agentDir: options.cwd,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  })
  emit({ step: 'github-webhooks', phase: 'done', result })
}

function resolveEagerWebhookUrl(options: Extract<AddChannelOptions, { channel: 'github' }>): string | undefined {
  if (options.tunnelProvider === 'external') return options.webhookUrl
  if (options.tunnelProvider === 'cloudflare-named') return options.hostname
  return undefined
}

function channelSecretsFromOptions(options: AddChannelOptions): ChannelSecrets {
  switch (options.channel) {
    case 'discord-bot':
      return { token: options.discordBotToken }
    case 'discord':
      return {}
    case 'slack-bot':
      return { botToken: options.slackBotToken, appToken: options.slackAppToken }
    case 'slack':
      return {}
    case 'telegram-bot':
      return { token: options.telegramBotToken }
    case 'webex-bot':
      return { token: options.webexBotToken }
    case 'webex':
      return {}
    case 'line':
      // LINE auth writes its structured account block directly to
      // secrets.json#channels.line before config mutation.
      return {}
    case 'kakaotalk':
      // KakaoTalk auth writes its structured multi-account block directly to
      // secrets.json#channels.kakaotalk before config mutation.
      return {}
    case 'github':
      // GitHub stores a structured PAT + webhook secret block directly.
      return {}
  }
}

async function defaultSlackAuthRunner(options: { cwd: string; qrDataUrl: string }): Promise<SlackAuthResult> {
  const { runSlackBootstrap } = await import('./slack-auth')
  return await runSlackBootstrap({ agentDir: options.cwd, qrDataUrl: options.qrDataUrl })
}

async function defaultDiscordAuthRunner(options: { cwd: string }): Promise<DiscordAuthResult> {
  const [{ runDiscordBootstrap }, QRCode] = await Promise.all([import('./discord-auth'), import('qrcode')])
  return await runDiscordBootstrap({
    agentDir: options.cwd,
    onQrUrl: async (url) => {
      const qr = await QRCode.default.toString(url, { type: 'terminal', small: true })
      console.log(
        ['Open Discord mobile app → Settings → scan QR.', '', qr, '', 'Approve the login on your phone.'].join('\n'),
      )
    },
  })
}

type ChannelSecrets = Record<string, string>

// Returns the set of channel keys already present in typeclaw.json. Used by
// the CLI's picker to hide already-configured adapters and to reject explicit
// re-adds with a clear error rather than silently merging.
export async function readConfiguredChannels(cwd: string): Promise<Set<ChannelKind>> {
  const path = join(cwd, CONFIG_FILE)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
    throw error
  }
  const parsed = JSON.parse(raw) as { channels?: Record<string, unknown> }
  const channels = parsed.channels ?? {}
  const present = new Set<ChannelKind>()
  for (const kind of CHANNEL_KINDS) {
    if (kind in channels) present.add(kind)
  }
  return present
}

async function mergeChannelIntoConfig(
  cwd: string,
  options: AddChannelOptions,
  instanceAccountId: string | undefined,
  priorCurrentAccountId: string | undefined,
): Promise<void> {
  const path = join(cwd, CONFIG_FILE)
  let parsed: Record<string, unknown>
  try {
    const raw = await readFile(path, 'utf8')
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `${CONFIG_FILE} not found at ${cwd}. Run \`typeclaw init\` before adding channels, or run this command from inside an agent folder.`,
      )
    }
    throw error
  }

  const existingChannels =
    typeof parsed.channels === 'object' && parsed.channels !== null && !Array.isArray(parsed.channels)
      ? (parsed.channels as Record<string, unknown>)
      : {}

  if (options.channel in existingChannels && !isMultiInstanceAdapter(options.channel)) {
    // Defense in depth — the CLI already filters configured channels out of
    // the picker and rejects them as the positional arg. Hitting this branch
    // means a programmatic caller passed a duplicate; better to fail loudly
    // than silently overwrite the user's existing config.
    throw new Error(`Channel "${options.channel}" is already configured in ${CONFIG_FILE}.`)
  }

  const nextChannelConfig = buildNextChannelConfig(
    existingChannels[options.channel],
    options,
    instanceAccountId,
    priorCurrentAccountId,
  )

  parsed.channels = {
    ...existingChannels,
    [options.channel]: nextChannelConfig,
  }

  if (options.channel === 'github') mergeGithubTunnelConfig(parsed, options)

  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`)
}

function buildNextChannelConfig(
  existing: unknown,
  options: AddChannelOptions,
  instanceAccountId: string | undefined,
  priorCurrentAccountId: string | undefined,
): Record<string, unknown> {
  if (options.channel === 'github') return buildGithubChannelConfig(options)
  if (!isUserModeAdapter(options.channel)) return {}

  if (existing === undefined) {
    if (options.instanceId === undefined) return {}
    return { instances: [buildInstanceEntry(options.instanceId, {}, instanceAccountId)] }
  }

  if (options.instanceId === undefined) {
    throw new Error(`Adding another ${options.channel} instance requires an instance id.`)
  }

  if (hasInstanceEntries(existing)) {
    if (existing.instances.some((entry) => entry.id === options.instanceId)) {
      throw new Error(`Channel "${options.channel}" already has an instance with id "${options.instanceId}".`)
    }
    return {
      ...existing,
      instances: [...existing.instances, buildInstanceEntry(options.instanceId, {}, instanceAccountId)],
    }
  }

  const existingConfig = isObjectRecord(existing) ? existing : {}
  return {
    instances: [
      buildInstanceEntry('default', existingConfig, priorCurrentAccountId),
      buildInstanceEntry(options.instanceId, {}, instanceAccountId),
    ],
  }
}

function buildInstanceEntry(
  id: string,
  config: Record<string, unknown>,
  account: string | undefined,
): Record<string, unknown> {
  return { id, ...config, ...(account !== undefined ? { account } : {}) }
}

function hasInstanceEntries(value: unknown): value is { instances: Array<{ id: string; account?: string }> } {
  return isObjectRecord(value) && Array.isArray(value.instances) && value.instances.every(isInstanceEntry)
}

function isInstanceEntry(value: unknown): value is { id: string; account?: string } {
  return isObjectRecord(value) && typeof value.id === 'string'
}

function resolveInstanceAccountId(
  cwd: string,
  channel: ChannelKind,
  priorAccountIds: ReadonlySet<string>,
  requestedAccountId: string | undefined,
): string | undefined {
  if (requestedAccountId !== undefined) return requestedAccountId
  const nextAccountIds = readChannelAccountIds(cwd, channel)
  const added = [...nextAccountIds].filter((id) => !priorAccountIds.has(id))
  if (added.length === 1) return added[0]
  return readCurrentChannelAccountId(cwd, channel)
}

function readCurrentChannelAccountId(cwd: string, channel: ChannelKind): string | undefined {
  const block = readChannelSecretsBlock(cwd, channel)
  if (!isObjectRecord(block)) return undefined
  return typeof block.currentAccount === 'string' && block.currentAccount.length > 0 ? block.currentAccount : undefined
}

function readChannelAccountIds(cwd: string, channel: ChannelKind): Set<string> {
  const block = readChannelSecretsBlock(cwd, channel)
  if (!isObjectRecord(block) || !isObjectRecord(block.accounts)) return new Set()
  return new Set(Object.keys(block.accounts))
}

function readChannelSecretsBlock(cwd: string, channel: ChannelKind): unknown {
  const channels = new SecretsBackend(join(cwd, 'secrets.json')).tryReadChannelsSync()
  return channels?.[channel]
}

function buildGithubChannelConfig(options: Extract<AddChannelOptions, { channel: 'github' }>): Record<string, unknown> {
  // Do NOT write eventAllowlist: the schema defaults it at parse time, so
  // omitting it lets the user's config track the shipped default across
  // releases instead of freezing the list captured at `channel add` time.
  return {
    ...(options.webhookUrl !== undefined ? { webhookUrl: options.webhookUrl } : {}),
    webhookPort: options.webhookPort ?? 8975,
    repos: options.repos,
  }
}

function mergeGithubTunnelConfig(
  parsed: Record<string, unknown>,
  options: Extract<AddChannelOptions, { channel: 'github' }>,
): void {
  if (options.tunnelProvider === 'none') return
  if (options.tunnelProvider === 'external' && options.webhookUrl === undefined) {
    throw new Error('GitHub external tunnel requires webhookUrl')
  }
  if (options.tunnelProvider === 'cloudflare-named') {
    if (options.hostname === undefined || options.hostname.trim() === '') {
      throw new Error('GitHub cloudflare-named tunnel requires hostname')
    }
    if (options.tokenEnv === undefined || options.tokenEnv.trim() === '') {
      throw new Error('GitHub cloudflare-named tunnel requires tokenEnv')
    }
  }

  const existingTunnels = Array.isArray(parsed.tunnels) ? parsed.tunnels : []
  const tunnel = buildGithubTunnelEntry(options)
  parsed.tunnels = [...existingTunnels, tunnel]

  if (options.tunnelProvider === 'cloudflare-quick' || options.tunnelProvider === 'cloudflare-named') {
    const docker = isObjectRecord(parsed.docker) ? { ...parsed.docker } : {}
    const file = isObjectRecord(docker.file) ? { ...docker.file } : {}
    file.cloudflared = true
    docker.file = file
    parsed.docker = docker
  }
}

function buildGithubTunnelEntry(options: Extract<AddChannelOptions, { channel: 'github' }>): Record<string, unknown> {
  switch (options.tunnelProvider) {
    case 'external':
      return {
        name: 'github-webhook',
        provider: 'external',
        externalUrl: options.webhookUrl,
        for: { kind: 'channel', name: 'github' },
      }
    case 'cloudflare-quick':
      return {
        name: 'github-webhook',
        provider: 'cloudflare-quick',
        for: { kind: 'channel', name: 'github' },
      }
    case 'cloudflare-named':
      return {
        name: 'github-webhook',
        provider: 'cloudflare-named',
        for: { kind: 'channel', name: 'github' },
        hostname: options.hostname,
        tokenEnv: options.tokenEnv,
      }
    case 'none':
      throw new Error('buildGithubTunnelEntry called with tunnelProvider=none')
  }
}

// Init-side counterpart of runAddChannel's github branch. Same three writes
// (typeclaw.json#channels.github, secrets.json#channels.github, roles.member
// .match[]) but with overwrite semantics on the secrets/config side so a
// re-run of `typeclaw init` after a partial failure works the same way it
// does for the bot-token adapters. The match-rule writer is reused as-is
// because its set-union is already idempotent.
async function writeGithubChannelForInit(cwd: string, credentials: GithubInitCredentials): Promise<void> {
  const configPath = join(cwd, CONFIG_FILE)
  const parsed = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
  const existingChannels = isObjectRecord(parsed.channels) ? { ...parsed.channels } : {}
  existingChannels.github = {
    ...(credentials.webhookUrl !== undefined ? { webhookUrl: credentials.webhookUrl } : {}),
    webhookPort: credentials.webhookPort ?? 8975,
    repos: credentials.repos,
  }
  parsed.channels = existingChannels
  mergeGithubTunnelConfig(parsed, { channel: 'github', ...credentials, cwd })
  await writeFile(configPath, `${JSON.stringify(parsed, null, 2)}\n`)

  const backend = new SecretsBackend(join(cwd, 'secrets.json'))
  const channels: Record<string, unknown> = backend.readChannelsSync()
  channels.github = {
    auth:
      credentials.auth.type === 'pat'
        ? { type: 'pat', token: { value: credentials.auth.pat } satisfies Secret }
        : {
            type: 'app',
            appId: credentials.auth.appId,
            privateKey: { value: credentials.auth.privateKey } satisfies Secret,
          },
    webhookSecret: { value: credentials.webhookSecret } satisfies Secret,
  }
  backend.writeChannelsSync(channels as Channels)

  await appendGithubMatchRules(cwd, credentials.repos)
}

async function appendGithubSecrets(
  cwd: string,
  options: Extract<AddChannelOptions, { channel: 'github' }>,
): Promise<void> {
  if (!existsSync(join(cwd, CONFIG_FILE))) {
    throw new Error(
      `${CONFIG_FILE} not found at ${cwd}. Run \`typeclaw init\` before adding channels, or run this command from inside an agent folder.`,
    )
  }
  const backend = new SecretsBackend(join(cwd, 'secrets.json'))
  const channels: Record<string, unknown> = backend.readChannelsSync()
  if (channels.github !== undefined) {
    throw new Error(
      'github is already set in secrets.json. Remove it before re-adding the channel, or edit it by hand.',
    )
  }
  channels.github = {
    auth:
      options.auth.type === 'pat'
        ? { type: 'pat', token: { value: options.auth.pat } satisfies Secret }
        : {
            type: 'app',
            appId: options.auth.appId,
            privateKey: { value: options.auth.privateKey } satisfies Secret,
          },
    webhookSecret: { value: options.webhookSecret } satisfies Secret,
  }
  backend.writeChannelsSync(channels as Channels)
}

async function appendGithubMatchRules(cwd: string, repos: readonly string[]): Promise<void> {
  const path = join(cwd, CONFIG_FILE)
  const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  const roles = isObjectRecord(parsed.roles) ? { ...parsed.roles } : {}
  const member = isObjectRecord(roles.member) ? { ...roles.member } : {}
  const existing = Array.isArray(member.match) ? member.match.filter((v): v is string => typeof v === 'string') : []
  const merged = new Set(existing)
  for (const repo of repos) merged.add(`github:${repo}`)
  member.match = Array.from(merged)
  roles.member = member
  parsed.roles = roles
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`)
}

// Writes per-adapter field values into `secrets.json#channels.<adapter>`.
// Refuses to overwrite existing fields: if the user already has e.g.
// `botToken` recorded (from a prior `channel add` whose follow-up steps
// failed, or a hand-edit), we surface that as a hard error rather than
// silently displace it. Same trap the original .env-append path guarded
// against, applied to the field-keyed destination.
async function appendChannelSecrets(cwd: string, channel: ChannelKind, tokens: ChannelSecrets): Promise<void> {
  if (Object.keys(tokens).length === 0) return

  if (!existsSync(join(cwd, CONFIG_FILE))) {
    throw new Error(
      `${CONFIG_FILE} not found at ${cwd}. Run \`typeclaw init\` before adding channels, or run this command from inside an agent folder.`,
    )
  }

  const backend = new SecretsBackend(join(cwd, 'secrets.json'))
  const channels: Record<string, unknown> = backend.readChannelsSync()
  const slot: Record<string, unknown> = isObjectRecord(channels[channel])
    ? { ...(channels[channel] as Record<string, unknown>) }
    : {}

  for (const field of Object.keys(tokens)) {
    if (slot[field] !== undefined) {
      throw new Error(
        `${field} is already set in secrets.json under "${channel}". Remove it before re-adding the channel, or edit the value by hand.`,
      )
    }
  }
  for (const [k, v] of Object.entries(tokens)) slot[k] = { value: v } satisfies Secret
  channels[channel] = slot
  backend.writeChannelsSync(channels as Channels)
}

// ----------------------------------------------------------------------------
// `typeclaw channel set`
//
// Rotate credentials of an already-configured channel. Symmetric with
// `typeclaw provider set` (see `setProvider` in src/config/providers-mutation.ts):
// `add` is "add for the first time, refuse if already present", `set` is
// "rotate the value, refuse if NOT yet present". Two separate verbs keep the
// "add by mistake" footgun and the "rotate by mistake" footgun on opposite
// sides of the CLI namespace.
//
// Per the env-wins / file-never-auto-mutated rule in AGENTS.md#secrets, these
// helpers only touch the fields the user explicitly asked to rotate. Any
// untouched field — including a sibling field bound to a custom env var —
// keeps its existing Secret envelope verbatim.
//
// Kakaotalk has its own auth flow (encryption envelope + device_uuid + phone
// passcode) and is rotated via `typeclaw channel reauth kakaotalk`, NOT via
// these helpers. Trying to set('kakaotalk') would bypass the encryption
// bridge and corrupt the per-account block; the CLI layer rejects it before
// reaching here.

export type SetChannelTokensResult = { ok: true } | { ok: false; reason: string }

type BotTokenAdapter = 'discord-bot' | 'slack-bot' | 'telegram-bot' | 'webex-bot'

// Required credential fields per adapter. Used post-merge to refuse a
// rotation that would leave the adapter half-configured — e.g. rotating
// only `botToken` when the on-disk slot was `{}` would silently leave
// `appToken` missing and the Slack adapter would fail to start. Listing
// the contract explicitly here keeps it close to the writer.
const REQUIRED_CHANNEL_FIELDS: Record<BotTokenAdapter, readonly string[]> = {
  'discord-bot': ['token'],
  'slack-bot': ['botToken', 'appToken'],
  'telegram-bot': ['token'],
  'webex-bot': ['token'],
}

// Preserve a user-authored `{ env: 'CUSTOM_NAME' }` rebinding when rotating
// the value behind it. Mirrors `buildSecret` in providers-mutation.ts for
// the case where the prior credential had an explicit env-name binding —
// the rotated value is written as `{ value, env }` so env-wins still works
// at runtime. Without this, every `channel set` would silently strip the
// rebinding and `process.env[<custom>]` would no longer override.
function rotatedSecret(previous: unknown, value: string): Secret {
  if (isObjectRecord(previous)) {
    const env = (previous as { env?: unknown }).env
    if (typeof env === 'string' && env.length > 0) {
      return { value, env }
    }
  }
  return { value }
}

// Rotate one or more credential fields on an already-configured bot-token
// adapter (discord-bot, slack-bot, telegram-bot). Refuses when the adapter
// has no existing entry in secrets.json — callers must use `runAddChannel`
// for first-time setup, so a typo in the adapter name can't silently create
// a half-configured channel. Also refuses when the rotation would leave any
// required field for the adapter unset (e.g. rotating only Slack's
// `botToken` when `appToken` is missing from disk).
export async function setChannelSecrets(
  cwd: string,
  channel: BotTokenAdapter,
  tokens: ChannelSecrets,
): Promise<SetChannelTokensResult> {
  if (!existsSync(join(cwd, CONFIG_FILE))) {
    return {
      ok: false,
      reason: `${CONFIG_FILE} not found at ${cwd}. Run \`typeclaw init\` before rotating channel credentials, or run this command from inside an agent folder.`,
    }
  }

  if (Object.keys(tokens).length === 0) return { ok: true }

  return await runChannelMutation(cwd, async (current) => {
    const existingSlot = current[channel]
    if (!isObjectRecord(existingSlot)) {
      return {
        result: {
          ok: false,
          reason: `${channel} is not configured in secrets.json. Run \`typeclaw channel add ${channel}\` first.`,
        },
      }
    }
    const slot: Record<string, unknown> = { ...existingSlot }
    for (const [k, v] of Object.entries(tokens)) {
      slot[k] = rotatedSecret(existingSlot[k], v)
    }
    const missing = REQUIRED_CHANNEL_FIELDS[channel].filter((field) => !isSecretFieldSet(slot[field]))
    if (missing.length > 0) {
      return {
        result: {
          ok: false,
          reason: `${channel} would be left half-configured after this rotation: missing required field(s) ${missing.join(', ')} in secrets.json. Run \`typeclaw channel add ${channel}\` to re-add the channel, or fix secrets.json by hand.`,
        },
      }
    }
    const next: Record<string, unknown> = { ...current, [channel]: slot }
    return { result: { ok: true }, next }
  })
}

// Discriminated union of what GitHub credentials the user wants to update.
// The three secrets (PAT/private-key, webhook secret) update independently,
// so the CLI lets the user pick which one(s) to touch in a single call.
// `auth.type` may differ from the on-disk auth type — switching between PAT
// and App auth replaces the entire auth block (no field carryover from the
// previous auth type, since the two shapes share no fields beyond `type`).
export type GithubCredentialPatch = {
  webhookSecret?: string
  auth?: { type: 'pat'; pat: string } | { type: 'app'; privateKey: string; appId?: number }
}

// Update one or more credential fields on an already-configured GitHub
// channel. Like setChannelSecrets, refuses when secrets.json has no
// existing github entry. Supports both same-type rotation (preserves env
// bindings, carries appId forward when not supplied) and
// auth-type switching (replaces the entire auth block — see
// `GithubCredentialPatch` above).
export async function setGithubSecrets(cwd: string, patch: GithubCredentialPatch): Promise<SetChannelTokensResult> {
  if (!existsSync(join(cwd, CONFIG_FILE))) {
    return {
      ok: false,
      reason: `${CONFIG_FILE} not found at ${cwd}. Run \`typeclaw init\` before rotating channel credentials, or run this command from inside an agent folder.`,
    }
  }

  if (patch.webhookSecret === undefined && patch.auth === undefined) return { ok: true }

  return await runChannelMutation(cwd, async (current) => {
    const existing = current.github
    if (!isObjectRecord(existing)) {
      return {
        result: {
          ok: false,
          reason: 'github is not configured in secrets.json. Run `typeclaw channel add github` first.',
        },
      }
    }
    const block: Record<string, unknown> = { ...existing }

    if (patch.auth !== undefined) {
      const existingAuth = block.auth
      const existingAuthType = readGithubAuthTypeFromObject(existingAuth)
      const isSameType = existingAuthType === patch.auth.type
      if (patch.auth.type === 'pat') {
        const previousToken =
          isSameType && isObjectRecord(existingAuth) ? (existingAuth as { token?: unknown }).token : undefined
        block.auth = { type: 'pat', token: rotatedSecret(previousToken, patch.auth.pat) }
      } else {
        const existingApp = isSameType && isObjectRecord(existingAuth) ? (existingAuth as Record<string, unknown>) : {}
        const appId = patch.auth.appId ?? (existingApp.appId as number | undefined)
        if (typeof appId !== 'number') {
          return {
            result: {
              ok: false,
              reason: isSameType
                ? 'github App auth requires appId, but it is missing from secrets.json. Re-run `typeclaw channel add github` to re-establish the App auth block.'
                : 'github App auth requires appId when switching from PAT to App auth.',
            },
          }
        }
        block.auth = {
          type: 'app',
          appId,
          privateKey: rotatedSecret(existingApp.privateKey, patch.auth.privateKey),
        }
      }
    }

    if (patch.webhookSecret !== undefined) {
      block.webhookSecret = rotatedSecret(block.webhookSecret, patch.webhookSecret)
    }

    const next: Record<string, unknown> = { ...current, github: block }
    return { result: { ok: true }, next }
  })
}

// Wrapper that converts a thrown schema-validation error (from a hand-edited
// malformed secrets.json) into a structured `{ ok: false }` result, so CLI
// callers can render a clean message instead of a stack trace. The
// `updateChannelsAsync` path itself is atomic; this wrapper only catches the
// READ stage (envelope parse) failures.
async function runChannelMutation(
  cwd: string,
  fn: (current: Record<string, unknown>) => Promise<{ result: SetChannelTokensResult; next?: Record<string, unknown> }>,
): Promise<SetChannelTokensResult> {
  const backend = new SecretsBackend(join(cwd, 'secrets.json'))
  try {
    return await backend.updateChannelsAsync<SetChannelTokensResult>(fn)
  } catch (err) {
    return {
      ok: false,
      reason: `secrets.json is malformed: ${err instanceof Error ? err.message : String(err)}. Fix it by hand, then retry.`,
    }
  }
}

function isSecretFieldSet(slot: unknown): boolean {
  if (typeof slot === 'string') return slot.length > 0
  if (isObjectRecord(slot)) {
    const value = (slot as { value?: unknown }).value
    if (typeof value === 'string' && value.length > 0) return true
    const env = (slot as { env?: unknown }).env
    if (typeof env === 'string' && env.length > 0) return true
  }
  return false
}

function readGithubAuthTypeFromObject(auth: unknown): 'pat' | 'app' | undefined {
  if (!isObjectRecord(auth)) return undefined
  const type = (auth as { type?: unknown }).type
  if (type === 'pat' || type === 'app') return type
  return undefined
}

// Lightweight read-only probe used by the `channel set` CLI to drive its
// "which secret do you want to rotate?" menu for GitHub. Returns the
// current auth type ('pat' | 'app') so the prompt knows whether to ask for
// a PAT or an App private key, without forcing the user to re-select auth
// type when they're rotating a credential of the same kind. Returns `null`
// when secrets.json is missing, malformed, or has no github entry — the
// CLI surfaces that as a single user-facing "fix the file by hand" error.
export function readGithubAuthType(cwd: string): 'pat' | 'app' | null {
  let channels: Channels | null
  try {
    channels = new SecretsBackend(join(cwd, 'secrets.json')).tryReadChannelsSync()
  } catch {
    return null
  }
  if (channels === null) return null
  const github = channels.github
  if (!isObjectRecord(github)) return null
  const auth = (github as { auth?: unknown }).auth
  return readGithubAuthTypeFromObject(auth) ?? null
}
