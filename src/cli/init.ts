import { randomBytes } from 'node:crypto'

import {
  autocomplete,
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  note,
  password,
  select,
  spinner,
  text,
} from '@clack/prompts'
import { defineCommand } from 'citty'

import { githubRequiredPermissionsNote } from '@/channels/adapters/github/permission-guidance'
import {
  KNOWN_PROVIDER_VENDORS,
  KNOWN_PROVIDERS,
  isKnownModelRef,
  listKnownProviderVendorIds,
  providerIdsForVendor,
  supportsApiKey as providerSupportsApiKey,
  supportsOAuth as providerSupportsOAuth,
  variantHint,
  variantLabel,
  type KnownModelRef,
  type KnownProviderId,
  type KnownProviderVendorId,
} from '@/config/providers'
import {
  checkDockerAvailable,
  detectInstalledDockerApps,
  pickRuntimeToNudge,
  renderDockerUnavailableGuidance,
  type DockerAvailability,
} from '@/container'
import {
  findAgentDir,
  formatEagerGithubWebhookInstallResult,
  hasEnvKey,
  hasExistingChannelSecrets,
  hasExistingOAuthCredentials,
  isDirectoryNonEmpty,
  isHatched,
  isInitialized,
  readExistingProviderApiKey,
  runInit,
  storeEnvKeyUnlessPresent,
  type GithubInitCredentials,
  type GithubTunnelProvider,
  type InitStep,
  type InitStepEvent,
  type KakaotalkAuthResult,
  type LLMAuth,
} from '@/init'
import {
  checkpointFromSelections,
  createLocalWizardCheckpointStore,
  sanitizeCheckpointAgainstCatalog,
  type WizardAnswerCheckpointV1,
  type WizardCheckpointStore,
} from '@/init/checkpoint'
import { runKakaotalkBootstrap } from '@/init/kakaotalk-auth'
import {
  customModelMetaFromOption,
  fetchModelOptions,
  type FetchModelsResult,
  type ModelOption,
} from '@/init/models-dev'
import { makeOAuthLoginRunner, type OAuthLoginResult } from '@/init/oauth-login'
import { detectInitProgress } from '@/init/progress'
import { runTeamsBootstrap } from '@/init/teams-auth'
import {
  API_KEY_DASHBOARD_URL,
  MINIMAX_TOKEN_PLAN_DASHBOARD_URL,
  validateApiKey,
  type KeyValidationResult,
} from '@/init/validate-api-key'
import { runWebexBootstrap } from '@/init/webex-auth'
import type { TeamsAccountType } from '@/secrets/schema'

import { teamsDeviceCodeCallbacks } from './channel'
import { fuzzyMatch } from './fuzzy-filter'
import { buildOAuthCallbacks } from './oauth-callbacks'
import { CANCEL_SYMBOL, promptPrivateKeyPem } from './prompt-pem'
import {
  c,
  cornflower,
  done,
  errorLine,
  printDiscordInviteHint,
  printHatchedFlourish,
  printInitWelcome,
  printSlackAppManifestSetup,
} from './ui'

// ESC and Ctrl+C both produce clack's cancel symbol (the keypress layer
// aliases both to the same "cancel" action — there's no way to tell them
// apart through @clack/prompts). The wizard treats every cancel as "go
// back to the previous step": each step that runs an interactive prompt
// either advances with a value or rewinds.
//
// Two cancel patterns must not trap the user:
//   1. Single-prompt cancel-loop. On the first step (pick-provider) there
//      is no previous step, so `back` re-displays the same prompt. Two
//      consecutive cancels on that same prompt = the user wants out.
//   2. Auto-advance round-trip. `back` from `enter-api-key` routes to
//      `pick-auth-method`, which for single-method providers (e.g.
//      Fireworks, api-key only) returns its value without prompting and
//      sends the wizard straight back to `enter-api-key`. The user only
//      ever sees the same api-key prompt and has no way to escape.
//
// Both patterns are detected in `collectWizardInputs` and surfaced as
// `WizardAbortedError`, which the `init` command catches and turns into
// a clean exit. Inside an active clack prompt Ctrl+C is still aliased to
// cancel, so the abort hotkey is "cancel twice in a row".
export class WizardAbortedError extends Error {
  // When the wizard ran a successful eager OAuth login before aborting, the
  // resulting credentials are already on disk at `<cwd>/secrets.json`. The
  // CLI surfaces this on abort so the user knows to either re-run init in
  // the same directory (the credentials will be reused) or delete the file.
  readonly oauthCredentialsSaved: boolean
  constructor(options: { oauthCredentialsSaved?: boolean } = {}) {
    super('Wizard aborted by user')
    this.name = 'WizardAbortedError'
    this.oauthCredentialsSaved = options.oauthCredentialsSaved === true
  }
}

export type StepResult<T> = { kind: 'value'; value: T; auto?: boolean } | { kind: 'back' }
const back = <T>(): StepResult<T> => ({ kind: 'back' })
const value = <T>(v: T): StepResult<T> => ({ kind: 'value', value: v })
const autoValue = <T>(v: T): StepResult<T> => ({ kind: 'value', value: v, auto: true })

export const init = defineCommand({
  meta: {
    name: 'init',
    description: 'initialize a new typeclaw agent in the current directory',
  },
  args: {
    reset: {
      type: 'boolean',
      description:
        'ignore any partial secrets.json state from an earlier aborted run and re-prompt for every credential',
      default: false,
    },
  },
  async run({ args }) {
    const cwd = process.cwd()
    const reset = args.reset === true

    const existingAgent = findAgentDir(cwd)
    if (existingAgent !== null && existingAgent !== cwd) {
      console.error(
        errorLine(
          `Refusing to init: a TypeClaw agent already exists at ${existingAgent}. Nested agents are not supported. Run init from a directory that is not inside an existing agent.`,
        ),
      )
      process.exit(1)
    }

    if (await isHatched(cwd)) {
      console.error(
        errorLine(
          `TypeClaw has already hatched in ${cwd}. Use \`typeclaw tui\` to attach or \`typeclaw start\` to run it; init in a different directory to create another agent.`,
        ),
      )
      process.exit(1)
    }

    if (shouldConfirmNonEmptyDirectory(cwd)) {
      const proceed = await confirm({
        message: `You're at ${cwd}. The directory is not empty. Do you want to proceed?`,
        initialValue: false,
      })
      if (isCancel(proceed) || !proceed) {
        cancel('Aborted.')
        process.exit(0)
      }
    }

    printInitWelcome()
    intro('Initializing TypeClaw...')
    log.info('Press ESC at any prompt to go back. Press ESC twice in a row to abort.')

    // Docker preflight runs BEFORE the wizard so an OAuth login (which the
    // wizard fires the moment the user picks "OAuth (browser login)") doesn't
    // burn a real browser flow on an agent folder we can't actually start.
    // `runInit` re-runs the preflight as a defense-in-depth gate, but
    // surfacing the failure here lets the user fix Docker without re-doing
    // every wizard step.
    const preflightSpinner = spinner()
    preflightSpinner.start('Checking Docker...')
    const preflight = await checkDockerAvailable()
    if (!preflight.ok) {
      preflightSpinner.error(preflightFailureSummary(preflight))
      note(preflightFailureGuidance(preflight).join('\n'), 'Docker check failed')
      process.exit(1)
    }
    preflightSpinner.stop('Docker is reachable.')

    const checkpointStore = createLocalWizardCheckpointStore()
    let collected: CollectedInputs
    try {
      collected = await collectWizardInputs(cwd, defaultWizardPrompts, { reset, checkpointStore })
    } catch (error) {
      if (error instanceof WizardAbortedError) {
        if (error.oauthCredentialsSaved) {
          note(
            [
              'OAuth credentials were saved to `secrets.json` before you aborted.',
              'Re-run `typeclaw init` here to pick up where you left off (the credentials',
              'will be reused), or run `typeclaw init --reset` to start fresh.',
            ].join('\n'),
            'Saved OAuth credentials',
          )
        }
        cancel('Aborted.')
        process.exit(0)
      }
      throw error
    }
    const { model, llmAuth, vision, channelChoice, reuseExistingChannel, channelSecrets } = collected
    const {
      discordBotToken,
      slackBotToken,
      slackAppToken,
      telegramBotToken,
      kakaotalkEmail,
      kakaotalkPassword,
      webexEmail,
      webexPassword,
      teamsAccountType,
      github: githubCredentials,
    } = channelSecrets
    const modelMeta = customModelMetaFromOption(model)
    const visionModelMeta = vision !== undefined ? customModelMetaFromOption(vision.model) : undefined

    // TODO: add remaining wizard steps from TypeClaw.md once their runtime lands:
    //   - git backup (url + PAT) — Phase 10
    //   - cron.json scaffolding — Phase 9
    //   - compose.yml registration in $HOME/.typeclaw — Phase 12

    // Reuse means: wire the adapter in typeclaw.json but skip the prompt for
    // fresh tokens / fresh kakaotalk login. `with<Adapter>` flags carry that
    // intent down to scaffold(); writeSecrets / runKakaotalkAuth see no new
    // input and leave the existing secrets.json slot untouched.
    const reuseDiscord = reuseExistingChannel && channelChoice === 'discord'
    const reuseSlack = reuseExistingChannel && channelChoice === 'slack'
    const reuseTelegram = reuseExistingChannel && channelChoice === 'telegram'
    const reuseKakaotalk = reuseExistingChannel && channelChoice === 'kakaotalk'
    const reuseWebex = reuseExistingChannel && channelChoice === 'webex'
    const reuseTeams = reuseExistingChannel && channelChoice === 'teams'
    const reuseGithub = reuseExistingChannel && channelChoice === 'github'
    const wantsKakaotalk = (kakaotalkEmail !== undefined && kakaotalkPassword !== undefined) || reuseKakaotalk
    const wantsWebex = (webexEmail !== undefined && webexPassword !== undefined) || reuseWebex
    const wantsTeams = teamsAccountType !== undefined || reuseTeams
    const wantsGithub = githubCredentials !== undefined || reuseGithub
    let hatchingOk = false
    let preflightFailure: Extract<DockerAvailability, { ok: false }> | null = null
    try {
      await runInit({
        cwd,
        llmAuth,
        model: model.ref,
        ...(modelMeta !== undefined ? { modelMeta } : {}),
        ...(vision !== undefined
          ? {
              visionModel: vision.model.ref,
              ...(visionModelMeta !== undefined ? { visionModelMeta } : {}),
              visionAuth: vision.llmAuth,
            }
          : {}),
        cliEntry: process.argv[1],
        ...(discordBotToken !== undefined ? { discordBotToken } : {}),
        ...(slackBotToken !== undefined ? { slackBotToken, slackAppToken } : {}),
        ...(telegramBotToken !== undefined ? { telegramBotToken } : {}),
        ...(reuseDiscord ? { withDiscord: true } : {}),
        ...(reuseSlack ? { withSlack: true } : {}),
        ...(reuseTelegram ? { withTelegram: true } : {}),
        ...(wantsKakaotalk
          ? {
              withKakaotalk: true,
              ...(reuseKakaotalk
                ? {}
                : {
                    runKakaotalkAuth: ({ cwd: agentDir }) =>
                      runKakaotalkBootstrap({
                        email: kakaotalkEmail!,
                        password: kakaotalkPassword!,
                        agentDir,
                        callbacks: {
                          onPasscode: (code) => log.info(`Confirm this passcode on your phone: ${code}`),
                        },
                      }),
                  }),
            }
          : {}),
        ...(wantsWebex
          ? {
              withWebexUser: true,
              ...(reuseWebex
                ? {}
                : {
                    runWebexAuth: ({ cwd: agentDir }) =>
                      runWebexBootstrap({ email: webexEmail!, password: webexPassword!, agentDir }),
                  }),
            }
          : {}),
        ...(wantsTeams
          ? {
              withTeams: true,
              ...(reuseTeams
                ? {}
                : {
                    runTeamsAuth: ({ cwd: agentDir }) =>
                      runTeamsBootstrap({
                        agentDir,
                        accountType: teamsAccountType!,
                        callbacks: teamsDeviceCodeCallbacks(),
                      }),
                  }),
            }
          : {}),
        ...(wantsGithub
          ? {
              withGithub: true,
              ...(reuseGithub || githubCredentials === undefined ? {} : { githubCredentials }),
            }
          : {}),
        onProgress: reportProgress(
          (ok) => {
            hatchingOk = ok
          },
          (result) => {
            preflightFailure = result
          },
        ),
      })
    } catch (error) {
      console.error(errorLine(error instanceof Error ? error.message : String(error)))
      note(
        [
          'Your answers are saved.',
          'Re-run `typeclaw init` here to resume, or `typeclaw init --reset` to start fresh.',
          'Run `typeclaw doctor` to diagnose host/Docker issues.',
        ].join('\n'),
        'init failed',
      )
      process.exit(1)
    }

    if (preflightFailure !== null) {
      note(preflightFailureGuidance(preflightFailure).join('\n'), 'Docker check failed')
      process.exit(1)
    }

    if (!hatchingOk) {
      note(
        [
          'The container was built but the agent did not come up.',
          'Check logs: `typeclaw logs`',
          'Diagnose: `typeclaw doctor`',
          'Retry once fixed: `typeclaw start` (your setup is saved).',
        ].join('\n'),
        'Hatching failed',
      )
      process.exit(1)
    }

    if (githubCredentials?.tunnelProvider === 'none') {
      log.warn(
        'Webhook delivery is disabled until you add a `tunnels[]` entry or set `channels.github.webhookUrl` manually.',
      )
    }

    if (hatchingOk) {
      // Clear the resume checkpoint only on full success (hatching ok). A
      // failed install/dockerfile/git/hatching leaves it in place so the next
      // `typeclaw init` — or `typeclaw start` (PR2) — can resume.
      await checkpointStore.clear(cwd).catch(() => {})
      const claimableChannel =
        channelChoice !== 'none' && channelChoice !== 'github' ? channelDisplayName(channelChoice) : null
      const hints: Array<{ label: string; command: string }> = []
      if (claimableChannel !== null) {
        hints.push({ label: 'Claim your agent:', command: 'typeclaw role claim' })
      }
      hints.push(
        { label: 'Attach TUI:', command: 'typeclaw tui' },
        { label: 'Follow logs:', command: 'typeclaw logs -f' },
        { label: 'Stop:', command: 'typeclaw stop' },
        { label: 'Diagnose issues:', command: 'typeclaw doctor' },
      )
      if (claimableChannel !== null) {
        note(
          [
            `Your agent will not respond on ${claimableChannel} until you claim ownership.`,
            `This prevents strangers from talking to it.`,
            `Run \`typeclaw role claim\` to finish setup.`,
          ].join('\n'),
          'Claim ownership before chatting',
        )
      }
      printHatchedFlourish()
      done({ title: `${cornflower('✓')} ${c.bold('Hatched.')} Your agent is ready.`, hints })
    }
  },
})

export function shouldConfirmNonEmptyDirectory(cwd: string): boolean {
  return isDirectoryNonEmpty(cwd) && !isInitialized(cwd)
}

interface WizardState {
  catalog?: { options: ModelOption[]; source: 'models.dev' | 'curated'; warning?: string }
  vendorId?: KnownProviderVendorId
  providerId?: KnownProviderId
  model?: ModelOption
  reuseExisting?: boolean
  authMethod?: 'api-key' | 'oauth'
  llmAuth?: LLMAuth
  visionVendorId?: KnownProviderVendorId
  visionProviderId?: KnownProviderId
  visionModel?: ModelOption
  visionReuseExisting?: boolean
  visionAuthMethod?: 'api-key' | 'oauth'
  visionLlmAuth?: LLMAuth
  channelChoice?: ChannelChoice
  channelReuseOffered?: boolean
  channelReuseExisting?: boolean
}

type ChannelChoice = 'slack' | 'discord' | 'telegram' | 'webex' | 'teams' | 'kakaotalk' | 'github' | 'none'

interface CollectedInputs {
  model: ModelOption
  llmAuth: LLMAuth
  // Set only when the default model is text-only and the user picked a
  // vision-capable model for the `vision` profile. `llmAuth` is reused from
  // the default provider's credentials when the vision provider matches, so
  // tests can still mint a single auth object and have it cover both.
  vision?: {
    model: ModelOption
    llmAuth: LLMAuth
  }
  channelChoice: ChannelChoice
  reuseExistingChannel: boolean
  channelSecrets: {
    discordBotToken?: string
    slackBotToken?: string
    slackAppToken?: string
    telegramBotToken?: string
    webexEmail?: string
    webexPassword?: string
    teamsAccountType?: TeamsAccountType
    kakaotalkEmail?: string
    kakaotalkPassword?: string
    // Structured (auth union + webhook + repo allowlist) rather than flat
    // tokens, so it rides as one sub-object instead of sibling fields.
    // `runInit` delegates to `runAddChannel` for GitHub to keep the github
    // config-writing in one place.
    github?: GithubInitCredentials
  }
}

type StepId =
  | 'pick-vendor'
  | 'pick-provider-variant'
  | 'reuse-existing-key'
  | 'pick-auth-method'
  | 'pick-model'
  | 'enter-api-key'
  | 'pick-vision-vendor'
  | 'pick-vision-provider-variant'
  | 'pick-vision-auth-method'
  | 'pick-vision-model'
  | 'enter-vision-api-key'
  | 'pick-channel'
  | 'reuse-existing-channel'
  | 'channel-flow'

export interface WizardPrompts {
  loadCatalog: () => Promise<NonNullable<WizardState['catalog']>>
  readExistingApiKey: (cwd: string, providerId: KnownProviderId) => Promise<string | null>
  hasExistingOAuthCredentials: (cwd: string, providerId: KnownProviderId) => Promise<boolean>
  pickVendor: (
    options: ModelOption[],
    initial: KnownProviderVendorId | undefined,
  ) => Promise<StepResult<KnownProviderVendorId>>
  pickProviderVariant: (
    vendorId: KnownProviderVendorId,
    options: ModelOption[],
    initial: KnownProviderId | undefined,
  ) => Promise<StepResult<KnownProviderId>>
  pickModel: (
    options: ModelOption[],
    providerId: KnownProviderId,
    initial: string | undefined,
  ) => Promise<StepResult<ModelOption>>
  pickAuthMethod: (
    provider: (typeof KNOWN_PROVIDERS)[KnownProviderId],
    initial: 'api-key' | 'oauth' | undefined,
  ) => Promise<StepResult<'api-key' | 'oauth'>>
  askApiKey: (provider: (typeof KNOWN_PROVIDERS)[KnownProviderId]) => Promise<StepResult<string>>
  validateApiKey: (providerId: KnownProviderId, key: string) => Promise<KeyValidationResult>
  pickVisionVendor: (
    options: ModelOption[],
    initial: KnownProviderVendorId | undefined,
  ) => Promise<StepResult<KnownProviderVendorId | 'skip'>>
  pickVisionProviderVariant: (
    vendorId: KnownProviderVendorId,
    options: ModelOption[],
    initial: KnownProviderId | undefined,
  ) => Promise<StepResult<KnownProviderId>>
  pickVisionModel: (
    options: ModelOption[],
    providerId: KnownProviderId,
    initial: string | undefined,
  ) => Promise<StepResult<ModelOption>>
  pickChannel: (initial: ChannelChoice | undefined) => Promise<StepResult<ChannelChoice>>
  hasExistingChannelSecrets: (cwd: string, channel: Exclude<ChannelChoice, 'none'>) => Promise<boolean>
  runChannelFlow: (choice: ChannelChoice, cwd: string) => Promise<StepResult<CollectedInputs['channelSecrets']>>
  runOAuthLogin: (
    provider: (typeof KNOWN_PROVIDERS)[KnownProviderId],
    cwd: string,
    model: string,
  ) => Promise<OAuthLoginResult>
  askOAuthFailureRecovery: (
    provider: (typeof KNOWN_PROVIDERS)[KnownProviderId],
    reason: string,
    apiKeyAvailable: boolean,
  ) => Promise<OAuthFailureRecovery>
  confirmResumeCheckpoint: (checkpoint: WizardAnswerCheckpointV1) => Promise<'resume' | 'start-over'>
}

export type CollectWizardInputsOptions = {
  reset?: boolean
  checkpointStore?: WizardCheckpointStore
}

export type OAuthFailureRecovery = 'retry' | 'api-key' | 'abort'

export const defaultWizardPrompts: WizardPrompts = {
  loadCatalog,
  readExistingApiKey: readExistingProviderApiKey,
  hasExistingOAuthCredentials,
  pickVendor,
  pickProviderVariant,
  pickModel: pickModelForProvider,
  pickAuthMethod,
  askApiKey,
  validateApiKey,
  pickVisionVendor,
  pickVisionProviderVariant,
  pickVisionModel,
  pickChannel,
  hasExistingChannelSecrets,
  runChannelFlow,
  runOAuthLogin: async (provider, cwd, model) => {
    const { callbacks, dispose } = buildOAuthCallbacks(provider.name)
    try {
      return await makeOAuthLoginRunner(callbacks)({ cwd, model })
    } finally {
      dispose()
    }
  },
  askOAuthFailureRecovery,
  confirmResumeCheckpoint,
}

export async function collectWizardInputs(
  cwd: string,
  prompts: WizardPrompts,
  options: CollectWizardInputsOptions = {},
): Promise<CollectedInputs> {
  const reset = options.reset === true
  const checkpointStore = options.checkpointStore
  const catalog = await prompts.loadCatalog()
  const state: WizardState = { catalog }
  let step: StepId = 'pick-vendor'
  let pendingBackOrigin: StepId | null = null
  let oauthCredentialsSaved = false

  // One-shot replay of checkpoint answers: while active, choice steps whose
  // answer was seeded auto-advance (running their normal tail) instead of
  // re-prompting. The first interactive prompt or any Back ends the replay
  // (cleared in `onResult`), so back-navigation behaves like a fresh wizard.
  // Secret-entry steps are never in `resumeCovered`, so a checkpointed
  // `authMethod` still drops to its key/login prompt when nothing is on disk.
  const resumeReplay = { active: false }
  const resumeCovered = new Set<StepId>()

  // Resume saved wizard answers from a prior unfinished init. `--reset` skips
  // this entirely (the user asked to re-answer everything). Route through the
  // shared detectInitProgress() predicate so init/start/restart classify a
  // checkpoint identically: only an `incomplete` init (checkpoint + not
  // hatched) offers resume; a `complete-stale-checkpoint` (checkpoint that
  // outlived a hatched agent) is cleared and ignored, matching the contract.
  if (!reset && checkpointStore !== undefined) {
    const progress = await detectInitProgress({ cwd, checkpointStore })
    if (progress.kind === 'complete-stale-checkpoint') {
      await checkpointStore.clear(cwd).catch(() => {})
    } else if (progress.kind === 'incomplete') {
      // Sanitize against the freshly-loaded catalog BEFORE showing the resume
      // prompt. `load` only validates version/cwd/updatedAt, so a checkpoint
      // with a since-removed provider/model id reaches here intact; describing
      // or seeding it raw would crash on `KNOWN_PROVIDERS[providerId]`. Pruning
      // first means the prompt, the seed, and any partial answers all see only
      // catalog-valid fields.
      const catalogRefs = new Set(catalog.options.map((option) => option.ref))
      const sanitized = sanitizeCheckpointAgainstCatalog(progress.checkpoint, catalogRefs)
      const decision = await prompts.confirmResumeCheckpoint(sanitized)
      if (decision === 'resume') {
        seedWizardState(state, sanitized)
        step = resumeStep(state)
        resumeReplay.active = true
        for (const covered of resumeCoveredSteps(state)) resumeCovered.add(covered)
      } else {
        await checkpointStore.clear(cwd)
      }
    }
  }

  const persistCheckpoint = async (): Promise<void> => {
    if (reset || checkpointStore === undefined) return
    await checkpointStore.save(cwd, projectCheckpoint(cwd, state)).catch(() => {})
  }

  const abort = (): never => {
    throw new WizardAbortedError({ oauthCredentialsSaved })
  }

  const onResult = <T>(currentStep: StepId, result: StepResult<T>): StepResult<T> => {
    // Any Back, or any non-auto (interactive) answer, ends the resume replay:
    // from here on the user is driving, so downstream seeded steps prompt
    // normally. Synthesized auto-skips keep replay alive and, as before, leave
    // `pendingBackOrigin` untouched so they never affect double-back abort.
    if (result.kind === 'back' || !result.auto) resumeReplay.active = false
    if (result.kind === 'back') {
      if (pendingBackOrigin === currentStep) abort()
      pendingBackOrigin = currentStep
    } else if (!result.auto) {
      pendingBackOrigin = null
    }
    return result
  }

  // Synthesize a step's seeded answer as an auto-advance result during resume
  // replay, so the step runs its normal tail (state assignment, on-disk
  // credential reconstruction, routing) without re-prompting. Returns
  // undefined when replay is off, this step isn't checkpoint-covered, or the
  // value is unset — callers fall back to the real prompt.
  const resumeSkip = <T>(currentStep: StepId, value: T | undefined): StepResult<T> | undefined => {
    if (!resumeReplay.active || !resumeCovered.has(currentStep) || value === undefined) return undefined
    return { kind: 'value', value, auto: true }
  }

  const readExistingApiKey = async (providerId: KnownProviderId): Promise<string | null> => {
    if (reset) return null
    return await prompts.readExistingApiKey(cwd, providerId)
  }

  const hasExistingOAuth = async (providerId: KnownProviderId): Promise<boolean> => {
    if (reset) return false
    return await prompts.hasExistingOAuthCredentials(cwd, providerId)
  }

  const hasExistingChannel = async (channel: Exclude<ChannelChoice, 'none'>): Promise<boolean> => {
    if (reset) return false
    return await prompts.hasExistingChannelSecrets(cwd, channel)
  }

  while (true) {
    // Persist the cumulative selections at the top of every iteration so a
    // mid-wizard abort keeps everything answered so far. Running it here (not
    // per-case) means back-navigation — which clears downstream fields before
    // looping — overwrites the projection too, so stale answers never linger.
    await persistCheckpoint()
    switch (step) {
      case 'pick-vendor': {
        const result = onResult(step, await prompts.pickVendor(catalog.options, state.vendorId))
        if (result.kind === 'back') {
          break
        }
        if (state.vendorId !== result.value) {
          state.providerId = undefined
          state.model = undefined
          state.reuseExisting = undefined
          state.authMethod = undefined
          state.llmAuth = undefined
        }
        state.vendorId = result.value
        step = 'pick-provider-variant'
        break
      }

      case 'pick-provider-variant': {
        const result = onResult(
          step,
          await prompts.pickProviderVariant(state.vendorId!, catalog.options, state.providerId),
        )
        if (result.kind === 'back') {
          step = 'pick-vendor'
          break
        }
        if (state.providerId !== result.value) {
          state.model = undefined
          state.reuseExisting = undefined
          state.authMethod = undefined
          state.llmAuth = undefined
        }
        state.providerId = result.value
        step = 'reuse-existing-key'
        break
      }

      case 'reuse-existing-key': {
        const provider = KNOWN_PROVIDERS[state.providerId!]
        // Auto-resume: if `secrets.json` already has a usable api-key for
        // this provider, reuse it silently. Issue #330: re-running init
        // after a partial abort should pick up where the user left off
        // without re-prompting for credentials they already supplied.
        // `--reset` bypasses this by making `readExistingApiKey` return
        // null, falling through to the normal auth-method flow.
        const existingApiKey = await readExistingApiKey(state.providerId!)
        if (existingApiKey !== null) {
          log.info(`Reusing existing ${provider.name} API key from secrets.json.`)
          state.llmAuth = { kind: 'api-key', apiKey: existingApiKey }
          state.reuseExisting = true
          step = 'pick-model'
          break
        }
        state.reuseExisting = false
        state.llmAuth = undefined
        step = 'pick-auth-method'
        break
      }

      case 'pick-auth-method': {
        const provider = KNOWN_PROVIDERS[state.providerId!]
        const result = onResult(step, await prompts.pickAuthMethod(provider, state.authMethod))
        if (result.kind === 'back') {
          // Skip past `reuse-existing-key` — it is a silent auto-resume
          // step with no user prompt, so unwind directly to the prior
          // user-visible step (the variant picker when it was interactive,
          // else the vendor picker). This only fires when pickAuthMethod was
          // an interactive choice (dual-auth providers); single-method
          // providers return autoValue and never reach the back branch.
          step = stepBeforeAuthMethod(state)
          break
        }
        state.authMethod = result.value
        if (result.value === 'oauth') {
          // Auto-resume: skip the browser flow when OAuth credentials are
          // already on disk from a prior partial run. The fresh-tokens path
          // and the resume path both leave `state.llmAuth = oauth-completed`,
          // so downstream steps (model, vision, channel, scaffold) can't tell
          // the difference. `--reset` short-circuits this by making
          // `hasExistingOAuth` return false.
          if (await hasExistingOAuth(state.providerId!)) {
            log.info(`Reusing existing ${provider.name} OAuth credentials from secrets.json.`)
            state.llmAuth = { kind: 'oauth-completed' }
            step = 'pick-model'
            break
          }
          // Run the browser login eagerly so the user sees the OAuth URL the
          // moment they pick "OAuth (browser login)" — not at the end of the
          // wizard. The model isn't picked yet at this point, so we hand the
          // login the provider's first model ref purely to resolve its
          // `oauthProviderId` (login ignores the model otherwise). On failure
          // we ask the user how to recover (retry / fall back to API key /
          // abort) instead of dumping them back into the auth method picker
          // with no guidance.
          const login = await runOAuthLoginSafely(prompts, provider, cwd, oauthDiscoveryRef(state.providerId!))
          if (!login.ok) {
            const recovery = await prompts.askOAuthFailureRecovery(
              provider,
              login.reason,
              providerSupportsApiKey(provider),
            )
            // The recovery prompt is a fresh user decision, so it must clear
            // any back-token left over from an earlier step. Without this, a
            // sequence like `enter-api-key → back → autoValue('oauth') →
            // OAuth fails → recovery=api-key → enter-api-key` would treat the
            // user's NEXT back press as a double-back and abort the wizard.
            pendingBackOrigin = null
            if (recovery === 'abort') abort()
            state.authMethod = recovery === 'api-key' ? 'api-key' : undefined
            state.llmAuth = undefined
            step = recovery === 'api-key' ? 'pick-model' : 'pick-auth-method'
            break
          }
          oauthCredentialsSaved = true
          state.llmAuth = { kind: 'oauth-completed' }
          step = 'pick-model'
        } else {
          step = 'pick-model'
        }
        break
      }

      case 'pick-model': {
        const result = onResult(
          step,
          resumeSkip(step, state.model) ??
            (await prompts.pickModel(catalog.options, state.providerId!, state.model?.ref)),
        )
        if (result.kind === 'back') {
          step = stepBeforeModel(state)
          break
        }
        state.model = result.value
        // OAuth and reused api-key already minted `state.llmAuth`; only a
        // freshly-chosen api-key still needs the key prompt.
        step =
          state.authMethod === 'api-key' && state.reuseExisting !== true ? 'enter-api-key' : stepAfterDefaultAuth(state)
        break
      }

      case 'enter-api-key': {
        const providerId = state.providerId!
        const provider = KNOWN_PROVIDERS[providerId]
        const result = onResult(step, await prompts.askApiKey(provider))
        if (result.kind === 'back') {
          step = 'pick-model'
          break
        }
        const verdict = await runApiKeyValidation(prompts, providerId, result.value)
        if (verdict === 'retry') {
          step = 'enter-api-key'
          break
        }
        state.llmAuth = { kind: 'api-key', apiKey: result.value }
        step = stepAfterDefaultAuth(state)
        break
      }

      case 'pick-vision-vendor': {
        const visionOptions = catalog.options.filter((o) => o.supportsVision)
        const result: StepResult<KnownProviderVendorId | 'skip'> = onResult(
          step,
          resumeSkip<KnownProviderVendorId | 'skip'>(step, state.visionVendorId) ??
            (await prompts.pickVisionVendor(visionOptions, state.visionVendorId)),
        )
        if (result.kind === 'back') {
          step = stepBeforeVision(state)
          break
        }
        if (result.value === 'skip') {
          state.visionVendorId = undefined
          state.visionProviderId = undefined
          state.visionModel = undefined
          state.visionLlmAuth = undefined
          state.visionReuseExisting = undefined
          state.visionAuthMethod = undefined
          step = 'pick-channel'
          break
        }
        if (state.visionVendorId !== result.value) {
          state.visionProviderId = undefined
          state.visionModel = undefined
          state.visionReuseExisting = undefined
          state.visionAuthMethod = undefined
          state.visionLlmAuth = undefined
        }
        state.visionVendorId = result.value
        step = 'pick-vision-provider-variant'
        break
      }

      case 'pick-vision-provider-variant': {
        const visionOptions = catalog.options.filter((o) => o.supportsVision)
        const result = onResult(
          step,
          resumeSkip(step, state.visionProviderId) ??
            (await prompts.pickVisionProviderVariant(state.visionVendorId!, visionOptions, state.visionProviderId)),
        )
        if (result.kind === 'back') {
          step = 'pick-vision-vendor'
          break
        }
        if (state.visionProviderId !== result.value) {
          state.visionModel = undefined
          state.visionReuseExisting = undefined
          state.visionAuthMethod = undefined
          state.visionLlmAuth = undefined
        }
        state.visionProviderId = result.value
        step = 'pick-vision-model'
        break
      }

      case 'pick-vision-model': {
        const visionOptions = catalog.options.filter((o) => o.supportsVision)
        const result = onResult(
          step,
          resumeSkip(step, state.visionModel) ??
            (await prompts.pickVisionModel(visionOptions, state.visionProviderId!, state.visionModel?.ref)),
        )
        if (result.kind === 'back') {
          step = 'pick-vision-provider-variant'
          break
        }
        state.visionModel = result.value
        if (state.visionProviderId === state.providerId) {
          log.info(`Using ${KNOWN_PROVIDERS[state.providerId!].name} credentials for the vision profile.`)
          state.visionLlmAuth = state.llmAuth
          state.visionReuseExisting = true
          step = 'pick-channel'
          break
        }
        const existingVisionKey = await readExistingApiKey(state.visionProviderId!)
        if (existingVisionKey !== null) {
          log.info(`Reusing existing ${KNOWN_PROVIDERS[state.visionProviderId!].name} API key from secrets.json.`)
          state.visionLlmAuth = { kind: 'api-key', apiKey: existingVisionKey }
          state.visionReuseExisting = true
          step = 'pick-channel'
          break
        }
        state.visionReuseExisting = false
        state.visionLlmAuth = undefined
        step = 'pick-vision-auth-method'
        break
      }

      case 'pick-vision-auth-method': {
        const provider = KNOWN_PROVIDERS[state.visionProviderId!]
        const result = onResult(step, await prompts.pickAuthMethod(provider, state.visionAuthMethod))
        if (result.kind === 'back') {
          step = 'pick-vision-model'
          break
        }
        state.visionAuthMethod = result.value
        if (result.value === 'oauth') {
          // Auto-resume mirror of the default-provider branch above: skip
          // the browser flow when vision OAuth credentials are already on
          // disk. The same `--reset` short-circuit applies via
          // `hasExistingOAuth`.
          if (await hasExistingOAuth(state.visionProviderId!)) {
            log.info(`Reusing existing ${provider.name} OAuth credentials from secrets.json.`)
            state.visionLlmAuth = { kind: 'oauth-completed' }
            step = 'pick-channel'
            break
          }
          // Same eager-login + recovery-prompt rationale as the default-provider branch above.
          const login = await runOAuthLoginSafely(prompts, provider, cwd, state.visionModel!.ref)
          if (!login.ok) {
            const recovery = await prompts.askOAuthFailureRecovery(
              provider,
              login.reason,
              providerSupportsApiKey(provider),
            )
            // See the matching pendingBackOrigin reset in the default-provider
            // branch above — same reasoning applies to vision auth recovery.
            pendingBackOrigin = null
            if (recovery === 'abort') abort()
            state.visionAuthMethod = recovery === 'api-key' ? 'api-key' : undefined
            state.visionLlmAuth = undefined
            step = recovery === 'api-key' ? 'enter-vision-api-key' : 'pick-vision-auth-method'
            break
          }
          oauthCredentialsSaved = true
          state.visionLlmAuth = { kind: 'oauth-completed' }
          step = 'pick-channel'
        } else {
          step = 'enter-vision-api-key'
        }
        break
      }

      case 'enter-vision-api-key': {
        const providerId = state.visionProviderId!
        const provider = KNOWN_PROVIDERS[providerId]
        const result = onResult(step, await prompts.askApiKey(provider))
        if (result.kind === 'back') {
          step = 'pick-vision-auth-method'
          break
        }
        const verdict = await runApiKeyValidation(prompts, providerId, result.value)
        if (verdict === 'retry') {
          step = 'enter-vision-api-key'
          break
        }
        state.visionLlmAuth = { kind: 'api-key', apiKey: result.value }
        step = 'pick-channel'
        break
      }

      case 'pick-channel': {
        const result: StepResult<ChannelChoice> = onResult(
          step,
          resumeSkip(step, state.channelChoice) ?? (await prompts.pickChannel(state.channelChoice)),
        )
        if (result.kind === 'back') {
          step = stepBeforePickChannel(state)
          break
        }
        if (state.channelChoice !== result.value) {
          state.channelReuseOffered = undefined
          state.channelReuseExisting = undefined
        }
        state.channelChoice = result.value
        step = result.value === 'none' ? 'channel-flow' : 'reuse-existing-channel'
        break
      }

      case 'reuse-existing-channel': {
        const choice = state.channelChoice as Exclude<ChannelChoice, 'none'>
        // Auto-resume: when usable channel credentials already exist on
        // disk, reuse them silently — mirrors the api-key and OAuth
        // resume paths above. `--reset` short-circuits via
        // `hasExistingChannel` returning false, falling through to the
        // normal channel-flow prompts.
        const present = await hasExistingChannel(choice)
        if (!present) {
          state.channelReuseOffered = false
          state.channelReuseExisting = false
          step = 'channel-flow'
          break
        }
        log.info(`Reusing existing ${channelDisplayName(choice)} credentials from secrets.json.`)
        state.channelReuseOffered = true
        state.channelReuseExisting = true
        return finalize(state, {})
      }

      case 'channel-flow': {
        const result = onResult(step, await prompts.runChannelFlow(state.channelChoice!, cwd))
        if (result.kind === 'back') {
          step = state.channelReuseOffered === true ? 'reuse-existing-channel' : 'pick-channel'
          break
        }
        return finalize(state, result.value)
      }
    }
  }
}

// Belt-and-suspenders wrapper: `makeOAuthLoginRunner` already catches the
// upstream pi-ai login flow and returns `{ ok: false, reason }`, but the
// wizard cannot afford ANY uncaught throw from a custom runner (test seam,
// future plugin-contributed runner) — it would bubble out of
// `collectWizardInputs` and exit the whole init. Coerce unexpected throws to
// the normal failure path so the recovery prompt always fires.
async function runOAuthLoginSafely(
  prompts: WizardPrompts,
  provider: (typeof KNOWN_PROVIDERS)[KnownProviderId],
  cwd: string,
  model: string,
): Promise<OAuthLoginResult> {
  try {
    return await prompts.runOAuthLogin(provider, cwd, model)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

function finalize(state: WizardState, channelSecrets: CollectedInputs['channelSecrets']): CollectedInputs {
  return {
    model: state.model!,
    llmAuth: state.llmAuth!,
    ...(state.visionModel !== undefined && state.visionLlmAuth !== undefined
      ? { vision: { model: state.visionModel, llmAuth: state.visionLlmAuth } }
      : {}),
    channelChoice: state.channelChoice ?? 'none',
    reuseExistingChannel: state.channelReuseExisting === true,
    channelSecrets,
  }
}

async function confirmResumeCheckpoint(checkpoint: WizardAnswerCheckpointV1): Promise<'resume' | 'start-over'> {
  const summary = describeCheckpoint(checkpoint)
  const choice = await select({
    message: 'Found answers from a previous, unfinished init. Resume from them?',
    options: [
      { value: 'resume' as const, label: 'Resume', hint: summary },
      { value: 'start-over' as const, label: 'Start over', hint: 'discard saved answers and pick everything again' },
    ],
    initialValue: 'resume' as const,
  })
  if (isCancel(choice)) return 'start-over'
  return choice
}

function describeCheckpoint(checkpoint: WizardAnswerCheckpointV1): string {
  const parts: string[] = []
  // Defense-in-depth: callers sanitize before describing, but a raw provider id
  // missing from KNOWN_PROVIDERS must degrade to the id string, never throw.
  if (checkpoint.modelRef !== undefined) parts.push(checkpoint.modelRef)
  else if (checkpoint.providerId !== undefined) {
    parts.push(KNOWN_PROVIDERS[checkpoint.providerId]?.name ?? checkpoint.providerId)
  }
  if (checkpoint.visionModelRef !== undefined) parts.push(`vision: ${checkpoint.visionModelRef}`)
  if (checkpoint.channelChoice !== undefined && checkpoint.channelChoice !== 'none') {
    parts.push(`channel: ${checkpoint.channelChoice}`)
  }
  return parts.length > 0 ? parts.join(', ') : 'partial selections'
}

// Pre-populate wizard state from a sanitized checkpoint so each prompt's
// `initial` argument fast-forwards the user to their prior choice. Only seeds
// fields whose upstream selections are all present and catalog-valid; the
// sanitize pass already dropped stale refs, so a missing field here just means
// that step prompts fresh.
function seedWizardState(state: WizardState, checkpoint: WizardAnswerCheckpointV1): void {
  state.vendorId = checkpoint.vendorId
  state.providerId = checkpoint.providerId
  state.model = resolveModelOption(state.catalog, checkpoint.modelRef)
  state.authMethod = checkpoint.authMethod
  state.visionVendorId = checkpoint.visionVendorId
  state.visionProviderId = checkpoint.visionProviderId
  state.visionModel = resolveModelOption(state.catalog, checkpoint.visionModelRef)
  state.visionAuthMethod = checkpoint.visionAuthMethod
  state.channelChoice = checkpoint.channelChoice
}

function resolveModelOption(catalog: WizardState['catalog'], ref: string | undefined): ModelOption | undefined {
  if (catalog === undefined || ref === undefined) return undefined
  return catalog.options.find((option) => option.ref === ref)
}

function resumeStep(state: WizardState): StepId {
  if (state.providerId !== undefined) return 'reuse-existing-key'
  if (state.vendorId !== undefined) return 'pick-provider-variant'
  return 'pick-vendor'
}

// Choice steps whose seeded answer lets resume replay auto-advance them. Only
// non-secret picks the checkpoint actually carries — never `enter-api-key` /
// `enter-vision-api-key` (key values aren't checkpointed) and never the
// reuse-* / channel-flow steps (those reconstruct from disk or collect secrets,
// so they must run their own logic, not replay a stored answer).
function resumeCoveredSteps(state: WizardState): StepId[] {
  const covered: StepId[] = []
  if (state.model !== undefined) covered.push('pick-model')
  if (state.visionVendorId !== undefined) covered.push('pick-vision-vendor')
  if (state.visionProviderId !== undefined) covered.push('pick-vision-provider-variant')
  if (state.visionModel !== undefined) covered.push('pick-vision-model')
  if (state.channelChoice !== undefined) covered.push('pick-channel')
  return covered
}

function projectCheckpoint(cwd: string, state: WizardState): WizardAnswerCheckpointV1 {
  return checkpointFromSelections({
    cwd,
    ...(state.vendorId !== undefined ? { vendorId: state.vendorId } : {}),
    ...(state.providerId !== undefined ? { providerId: state.providerId } : {}),
    ...(state.model?.ref !== undefined ? { modelRef: state.model.ref } : {}),
    ...(state.authMethod !== undefined ? { authMethod: state.authMethod } : {}),
    ...(state.visionVendorId !== undefined ? { visionVendorId: state.visionVendorId } : {}),
    ...(state.visionProviderId !== undefined ? { visionProviderId: state.visionProviderId } : {}),
    ...(state.visionModel?.ref !== undefined ? { visionModelRef: state.visionModel.ref } : {}),
    ...(state.visionAuthMethod !== undefined ? { visionAuthMethod: state.visionAuthMethod } : {}),
    ...(state.channelChoice !== undefined ? { channelChoice: state.channelChoice } : {}),
  })
}

function channelDisplayName(choice: Exclude<ChannelChoice, 'none'>): string {
  switch (choice) {
    case 'slack':
      return 'Slack'
    case 'discord':
      return 'Discord'
    case 'telegram':
      return 'Telegram'
    case 'webex':
      return 'Webex (User)'
    case 'teams':
      return 'Teams (User)'
    case 'kakaotalk':
      return 'KakaoTalk'
    case 'github':
      return 'GitHub'
  }
}

// Model is the last default-track step before the vision/channel branch, so
// vendor/variant/auth all sit upstream of it. Reached after `pick-model`
// (api-key path also passes through `enter-api-key` first).
function stepAfterDefaultAuth(state: WizardState): StepId {
  return state.model?.supportsVision === false ? 'pick-vision-vendor' : 'pick-channel'
}

// Back-target when leaving `pick-auth-method`: the variant picker when it was
// interactive (multi-provider vendor), else the vendor picker. The
// `reuse-existing-key` step in between is a silent auto-resume with no prompt.
function stepBeforeAuthMethod(state: WizardState): StepId {
  return providerIdsForVendor(state.vendorId!).length > 1 ? 'pick-provider-variant' : 'pick-vendor'
}

// Back-target when leaving `pick-model`: the auth picker when it was
// interactive (dual-auth provider), else fall back past the silent
// auto-resume/auth steps to the prior user-visible picker.
function stepBeforeModel(state: WizardState): StepId {
  const provider = KNOWN_PROVIDERS[state.providerId!]
  if (providerSupportsApiKey(provider) && providerSupportsOAuth(provider)) return 'pick-auth-method'
  return stepBeforeAuthMethod(state)
}

// Back-target when leaving the vision track to the default track. With model
// now the final default-track step, that is always `pick-model`.
function stepBeforeVision(_state: WizardState): StepId {
  return 'pick-model'
}

function stepBeforePickChannel(state: WizardState): StepId {
  if (state.visionModel !== undefined) {
    if (state.visionProviderId === state.providerId) return 'pick-vision-model'
    if (state.visionReuseExisting === true) return 'pick-vision-model'
    if (state.visionAuthMethod === 'api-key') return 'enter-vision-api-key'
    if (state.visionAuthMethod === 'oauth') return 'pick-vision-auth-method'
    return 'pick-vision-model'
  }
  if (state.model?.supportsVision === false) return 'pick-vision-vendor'
  return stepBeforeVision(state)
}

function oauthDiscoveryRef(providerId: KnownProviderId): KnownModelRef {
  // OAuth login only reads the provider's `oauthProviderId` from the ref, so
  // any registered model for the provider works as the discovery handle.
  const modelId = Object.keys(KNOWN_PROVIDERS[providerId].models)[0]
  if (modelId === undefined) throw new Error(`Provider ${providerId} has no registered models for OAuth discovery`)
  return `${providerId}/${modelId}` as KnownModelRef
}

async function loadCatalog(): Promise<NonNullable<WizardState['catalog']>> {
  const s = spinner()
  s.start('Loading model catalogs...')
  const result = await fetchModelOptions()
  const unavailable = catalogFallbackLabels(result)
  if (unavailable.length > 0) {
    s.stop(`Loaded model catalog with fallback for ${unavailable.join(', ')}.`)
  } else {
    s.stop('Loaded model catalogs.')
  }
  return result
}

function catalogFallbackLabels(result: FetchModelsResult): string[] {
  const labels: string[] = []
  if (result.sources.modelsDev === 'unavailable') labels.push('native providers')
  if (result.sources.openGatewayCatalog === 'unavailable') labels.push('OpenGateway models')
  else if (result.sources.openGatewayPrices === 'unavailable') labels.push('OpenGateway prices')
  return labels
}

async function pickVendor(
  options: ModelOption[],
  initial: KnownProviderVendorId | undefined,
): Promise<StepResult<KnownProviderVendorId>> {
  const vendors = uniqueVendors(options)
  const choice = await autocomplete({
    message: 'Pick an LLM provider',
    placeholder: 'Type to search…',
    filter: fuzzyMatch,
    options: vendors.map((id) => ({
      value: id,
      label: KNOWN_PROVIDER_VENDORS[id].name,
      hint: vendorHint(id, options),
    })),
    initialValue: initial ?? vendors[0],
  })
  if (isCancel(choice)) return back()
  return value(choice)
}

async function pickProviderVariant(
  vendorId: KnownProviderVendorId,
  options: ModelOption[],
  initial: KnownProviderId | undefined,
): Promise<StepResult<KnownProviderId>> {
  const variants = providersForVendorInCatalog(vendorId, options)
  if (variants.length === 0) throw new Error(`Internal error: vendor ${vendorId} has no providers in the catalog`)
  if (variants.length === 1) return autoValue(variants[0]!)
  const choice = await autocomplete<KnownProviderId>({
    message: `Pick a ${KNOWN_PROVIDER_VENDORS[vendorId].name} option`,
    placeholder: 'Type to search…',
    filter: fuzzyMatch,
    options: variants.map((id) => {
      const hint = variantHint(vendorId, id)
      return hint !== undefined
        ? { value: id, label: variantLabel(vendorId, id), hint }
        : { value: id, label: variantLabel(vendorId, id) }
    }),
    initialValue: initial ?? variants[0],
  })
  if (isCancel(choice)) return back()
  return value(choice)
}

async function pickModelForProvider(
  options: ModelOption[],
  providerId: KnownProviderId,
  initial: string | undefined,
): Promise<StepResult<ModelOption>> {
  const candidates = sortRecommendedFirst(options.filter((o) => o.providerId === providerId))
  // select<string>, not select<KnownModelRef>: clack's Option<Value> is a
  // distributive conditional type, so a large KnownModelRef union explodes into
  // a per-literal option union that no longer accepts `value: ref`. The runtime
  // value is the ref string and is re-narrowed via `candidates.find` below.
  const choice = await autocomplete<string>({
    message: `Pick a ${KNOWN_PROVIDERS[providerId].name} model`,
    placeholder: 'Type to search…',
    filter: fuzzyMatch,
    options: candidates.map((o) => ({
      value: o.ref,
      label: formatModelLabel(o),
      hint: formatModelHint(o),
    })),
    initialValue: initial ?? candidates[0]?.ref,
  })
  if (isCancel(choice)) return back()
  const picked = candidates.find((o) => o.ref === choice)
  if (!picked) throw new Error(`Internal error: picked model ${choice} not in candidates`)
  return value(picked)
}

async function pickAuthMethod(
  provider: (typeof KNOWN_PROVIDERS)[KnownProviderId],
  initial: 'api-key' | 'oauth' | undefined,
): Promise<StepResult<'api-key' | 'oauth'>> {
  const supportsApiKey = providerSupportsApiKey(provider)
  const supportsOAuth = providerSupportsOAuth(provider)
  if (supportsApiKey && supportsOAuth) {
    const choice = await select<'api-key' | 'oauth'>({
      message: `How do you want to authenticate to ${provider.name}?`,
      options: [
        { value: 'api-key', label: 'API key', hint: 'saved to secrets.json' },
        { value: 'oauth', label: 'OAuth (browser login)', hint: 'saved to secrets.json' },
      ],
      initialValue: initial ?? 'api-key',
    })
    if (isCancel(choice)) return back()
    return value(choice)
  }
  return autoValue(supportsOAuth ? 'oauth' : 'api-key')
}

async function pickVisionVendor(
  options: ModelOption[],
  initial: KnownProviderVendorId | undefined,
): Promise<StepResult<KnownProviderVendorId | 'skip'>> {
  const vendors = uniqueVendors(options)
  if (vendors.length === 0) {
    log.warn('No vision-capable models available; skipping vision profile.')
    return autoValue('skip')
  }
  const choice = await autocomplete<KnownProviderVendorId | 'skip'>({
    message: 'Your model is text-only. Pick a provider for the `vision` profile (used for image input)',
    placeholder: 'Type to search…',
    filter: fuzzyMatch,
    options: [
      ...vendors.map((id) => ({
        value: id as KnownProviderVendorId | 'skip',
        label: KNOWN_PROVIDER_VENDORS[id].name,
        hint: vendorHint(id, options),
      })),
      { value: 'skip', label: 'Skip — no vision support', hint: 'add later with `typeclaw model set vision <ref>`' },
    ],
    initialValue: initial ?? vendors[0],
  })
  if (isCancel(choice)) return back()
  return value(choice)
}

async function pickVisionProviderVariant(
  vendorId: KnownProviderVendorId,
  options: ModelOption[],
  initial: KnownProviderId | undefined,
): Promise<StepResult<KnownProviderId>> {
  return pickProviderVariant(vendorId, options, initial)
}

async function pickVisionModel(
  options: ModelOption[],
  providerId: KnownProviderId,
  initial: string | undefined,
): Promise<StepResult<ModelOption>> {
  const candidates = sortRecommendedFirst(options.filter((o) => o.providerId === providerId))
  // select<string> for the same distributive-Option reason as pickModelForProvider.
  const choice = await autocomplete<string>({
    message: `Pick a vision-capable ${KNOWN_PROVIDERS[providerId].name} model`,
    placeholder: 'Type to search…',
    filter: fuzzyMatch,
    options: candidates.map((o) => ({
      value: o.ref,
      label: formatModelLabel(o),
      hint: formatModelHint(o),
    })),
    initialValue: initial ?? candidates[0]?.ref,
  })
  if (isCancel(choice)) return back()
  const picked = candidates.find((o) => o.ref === choice)
  if (!picked) throw new Error(`Internal error: picked vision model ${choice} not in candidates`)
  return value(picked)
}

async function runApiKeyValidation(
  prompts: WizardPrompts,
  providerId: KnownProviderId,
  key: string,
): Promise<'accepted' | 'retry'> {
  const provider = KNOWN_PROVIDERS[providerId]
  const s = spinner()
  s.start(`Checking your ${provider.name} key...`)
  let result: KeyValidationResult
  try {
    result = await prompts.validateApiKey(providerId, key)
  } catch {
    s.stop(`Couldn't reach ${provider.name} to verify the key. Saving it anyway.`)
    return 'accepted'
  }
  if (result.kind === 'ok') {
    s.stop(`${provider.name} key looks good.`)
    return 'accepted'
  }
  if (result.kind === 'skipped') {
    s.stop(`Couldn't reach ${provider.name} to verify the key. Saving it anyway.`)
    return 'accepted'
  }
  s.error(`${provider.name} rejected the key (HTTP ${result.status}).`)
  const dashboardUrl = API_KEY_DASHBOARD_URL[providerId]
  const lines = [
    'The provider says this key is not valid.',
    'Common causes: typo, expired key, wrong account, or pasting a project-scoped key.',
  ]
  if (dashboardUrl) {
    lines.push('', `Get a fresh one at ${dashboardUrl}`)
  }
  note(lines.join('\n'), `${provider.name} key rejected`)
  const choice = await select<'retry' | 'accept'>({
    message: 'What do you want to do?',
    options: [
      { value: 'retry', label: 'Try a different key' },
      { value: 'accept', label: 'Save this key anyway', hint: 'init continues, but the agent may fail to start' },
    ],
    initialValue: 'retry',
  })
  if (isCancel(choice) || choice === 'retry') return 'retry'
  return 'accepted'
}

async function askApiKey(provider: (typeof KNOWN_PROVIDERS)[KnownProviderId]): Promise<StepResult<string>> {
  const providerId = provider.id as KnownProviderId
  const keySurface = await pickMinimaxKeySurface(providerId)
  if (keySurface.kind === 'back') return back()
  const label = keySurface.kind === 'chosen' ? keySurface.label : `${provider.name} API`
  const dashboardUrl = keySurface.kind === 'chosen' ? keySurface.dashboardUrl : API_KEY_DASHBOARD_URL[providerId]
  if (dashboardUrl) {
    note(
      [`Don't have a key yet?`, `Get one at ${dashboardUrl}`, `Then come back and paste it below.`].join('\n'),
      `Get a ${label} key`,
    )
  }
  const apiKey = await password({
    message: `Put your ${label} key (will be saved to secrets.json)`,
    validate: (v) => (v && v.length > 0 ? undefined : 'API key is required'),
  })
  if (isCancel(apiKey)) return back()
  return value(apiKey)
}

type MinimaxKeySurface =
  | { kind: 'back' }
  | { kind: 'default' }
  | { kind: 'chosen'; label: string; dashboardUrl: string }

// MiniMax issues keys on two billing surfaces (pay-as-you-go vs Token Plan
// subscription) that store in the same provider slot but live on different
// dashboard pages. For the `minimax` provider, let the user say which one they
// have so the deep-link points at the right page; every other provider skips
// straight to the paste prompt. The picked surface only changes the label and
// dashboard URL — the pasted key is stored identically either way.
async function pickMinimaxKeySurface(providerId: KnownProviderId): Promise<MinimaxKeySurface> {
  if (providerId !== 'minimax') return { kind: 'default' }
  const choice = await select<'paygo' | 'token-plan'>({
    message: 'Which MiniMax key do you have?',
    options: [
      { value: 'paygo', label: 'Pay-as-you-go API key', hint: 'billed per token' },
      { value: 'token-plan', label: 'Token Plan API key', hint: 'subscription / Credits (sk-cp-…)' },
    ],
    initialValue: 'paygo',
  })
  if (isCancel(choice)) return { kind: 'back' }
  if (choice === 'token-plan') {
    return { kind: 'chosen', label: 'MiniMax Token Plan', dashboardUrl: MINIMAX_TOKEN_PLAN_DASHBOARD_URL }
  }
  return { kind: 'chosen', label: 'MiniMax pay-as-you-go API', dashboardUrl: API_KEY_DASHBOARD_URL.minimax! }
}

async function askOAuthFailureRecovery(
  provider: (typeof KNOWN_PROVIDERS)[KnownProviderId],
  reason: string,
  apiKeyAvailable: boolean,
): Promise<OAuthFailureRecovery> {
  note(reason, `${provider.name} OAuth login failed`)
  const options: Array<{ value: OAuthFailureRecovery; label: string; hint?: string }> = [
    { value: 'retry', label: 'Retry OAuth login' },
  ]
  if (apiKeyAvailable) {
    options.push({ value: 'api-key', label: `Use a ${provider.name} API key instead` })
  }
  options.push({ value: 'abort', label: 'Abort init', hint: 'you can re-run `typeclaw init` later' })
  const choice = await select<OAuthFailureRecovery>({
    message: 'What next?',
    options,
    initialValue: 'retry',
  })
  if (isCancel(choice)) return 'abort'
  return choice
}

async function pickChannel(initial: ChannelChoice | undefined): Promise<StepResult<ChannelChoice>> {
  const choice = await select<ChannelChoice>({
    message: 'Pick a channel to wire (you can add more later by editing typeclaw.json + secrets.json)',
    options: [
      { value: 'slack', label: 'Slack' },
      { value: 'discord', label: 'Discord' },
      { value: 'telegram', label: 'Telegram' },
      { value: 'webex', label: 'Webex (User)' },
      { value: 'teams', label: 'Teams (User)' },
      { value: 'kakaotalk', label: 'KakaoTalk' },
      { value: 'github', label: 'GitHub' },
      { value: 'none', label: 'Skip — no channel right now' },
    ],
    initialValue: initial ?? 'slack',
  })
  if (isCancel(choice)) return back()
  return value(choice)
}

async function runChannelFlow(
  choice: ChannelChoice,
  cwd: string,
): Promise<StepResult<CollectedInputs['channelSecrets']>> {
  switch (choice) {
    case 'none':
      return value({})
    case 'discord':
      return runDiscordFlow()
    case 'kakaotalk':
      return runKakaotalkFlow()
    case 'slack':
      return runSlackFlow()
    case 'telegram':
      return runTelegramFlow()
    case 'webex':
      return runWebexUserFlow()
    case 'teams':
      return runTeamsFlow()
    case 'github':
      return runGithubFlow(cwd)
  }
}

async function runTeamsFlow(): Promise<StepResult<CollectedInputs['channelSecrets']>> {
  note(
    [
      'Teams signs in as your own Microsoft account via device-code login —',
      'you get a short code to enter at microsoft.com/devicelogin, then approve.',
      'The sign-in itself runs after scaffolding, not now.',
    ].join('\n'),
    'About to log in to Teams',
  )
  const accountType = await select<TeamsAccountType>({
    message: 'Which kind of Microsoft account?',
    options: [
      { value: 'work', label: 'Work or school (Microsoft 365 / Azure AD)' },
      { value: 'personal', label: 'Personal Microsoft account (outlook.com, live.com, …)' },
    ],
    initialValue: 'work',
  })
  if (isCancel(accountType)) return back()
  return value({ teamsAccountType: accountType })
}

async function runDiscordFlow(): Promise<StepResult<CollectedInputs['channelSecrets']>> {
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
    validate: (v) => (v && v.length > 0 ? undefined : 'Token is required'),
  })
  if (isCancel(token)) return back()
  printDiscordInviteHint(token)
  return value({ discordBotToken: token })
}

async function runKakaotalkFlow(): Promise<StepResult<CollectedInputs['channelSecrets']>> {
  // Sub-flow with its own back-aware loop: ESC on the password prompt
  // returns to the email prompt; ESC on the email prompt unwinds to the
  // channel picker.
  type SubStep = 'email' | 'password'
  let sub: SubStep = 'email'
  let email: string | undefined
  let pwd: string | undefined

  note(
    [
      'KakaoTalk authentication uses a personal account, registered as a',
      'tablet sub-device. Messages will be sent and received under this',
      'account. Use a non-primary account if possible.',
      '',
      'After you submit the password, KakaoTalk may ask you to confirm a',
      'passcode on your phone. Watch the screen for the code.',
    ].join('\n'),
    'About to log in to KakaoTalk',
  )

  while (true) {
    if (sub === 'email') {
      const input = await text({
        message: 'KakaoTalk email',
        ...(email !== undefined ? { initialValue: email } : {}),
        validate: (v) => (v && v.length > 0 ? undefined : 'Email is required'),
      })
      if (isCancel(input)) return back()
      email = input
      sub = 'password'
      continue
    }
    const input = await password({
      message: 'KakaoTalk password',
      validate: (v) => (v && v.length > 0 ? undefined : 'Password is required'),
    })
    if (isCancel(input)) {
      sub = 'email'
      continue
    }
    pwd = input
    return value({ kakaotalkEmail: email, kakaotalkPassword: pwd })
  }
}

async function runWebexUserFlow(): Promise<StepResult<CollectedInputs['channelSecrets']>> {
  type SubStep = 'email' | 'password'
  let sub: SubStep = 'email'
  let email: string | undefined

  note(
    [
      'Logs in headlessly with your Webex email/password.',
      'SSO/MFA accounts are not supported. Messages will be sent and received under this account.',
    ].join('\n'),
    'About to log in to Webex',
  )

  while (true) {
    if (sub === 'email') {
      const input = await text({
        message: 'Webex email',
        ...(email !== undefined ? { initialValue: email } : {}),
        validate: (v) => (v && v.length > 0 ? undefined : 'Email is required'),
      })
      if (isCancel(input)) return back()
      email = input
      sub = 'password'
      continue
    }
    const input = await password({
      message: 'Webex password',
      validate: (v) => (v && v.length > 0 ? undefined : 'Password is required'),
    })
    if (isCancel(input)) {
      sub = 'email'
      continue
    }
    return value({ webexEmail: email, webexPassword: input })
  }
}

async function runSlackFlow(): Promise<StepResult<CollectedInputs['channelSecrets']>> {
  type SubStep = 'bot' | 'app'
  let sub: SubStep = 'bot'
  let botToken: string | undefined

  printSlackAppManifestSetup()

  while (true) {
    if (sub === 'bot') {
      const input = await password({
        message: 'Slack bot token (xoxb-...)',
        validate: (v) =>
          v && v.length > 0
            ? v.startsWith('xoxb-')
              ? undefined
              : 'Bot token must start with "xoxb-"'
            : 'Token is required',
      })
      if (isCancel(input)) return back()
      botToken = input
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
      sub = 'app'
      continue
    }
    const input = await password({
      message: 'Slack app-level token (xapp-...) — Socket Mode requires this',
      validate: (v) =>
        v && v.length > 0
          ? v.startsWith('xapp-')
            ? undefined
            : 'App-level token must start with "xapp-"'
          : 'Token is required',
    })
    if (isCancel(input)) {
      sub = 'bot'
      continue
    }
    return value({ slackBotToken: botToken!, slackAppToken: input })
  }
}

async function runGithubFlow(cwd: string): Promise<StepResult<CollectedInputs['channelSecrets']>> {
  note(
    [
      'Choose PAT auth for a quick setup, or GitHub App auth for expiring installation tokens.',
      githubRequiredPermissionsNote(true),
    ].join('\n'),
    'Get GitHub credentials',
  )
  const authType = await select<'pat' | 'app'>({
    message: 'GitHub authentication type',
    options: [
      { value: 'pat', label: 'Fine-grained personal access token' },
      { value: 'app', label: 'GitHub App installation token (recommended)' },
    ],
    initialValue: 'app',
  })
  if (isCancel(authType)) return back()
  const auth = authType === 'pat' ? await promptGithubPatAuth() : await promptGithubAppAuth()
  if (auth === null) return back()
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
  if (isCancel(tunnelProvider)) return back()
  const webhookUrl =
    tunnelProvider === 'external'
      ? await text({
          message: 'Public webhook URL (GitHub will POST events here)',
          validate: (v) => validateGithubUrl(v ?? '', 'Webhook URL is required'),
        })
      : undefined
  if (isCancel(webhookUrl)) return back()
  const namedCreds = tunnelProvider === 'cloudflare-named' ? await promptGithubCloudflareNamedTunnel(cwd) : undefined
  if (namedCreds === null) return back()
  const port = await text({
    message: 'Local webhook port inside the agent container',
    initialValue: '8975',
    validate: (v) => {
      const parsed = Number(v)
      return Number.isInteger(parsed) && parsed > 0 ? undefined : 'Port must be a positive integer'
    },
  })
  if (isCancel(port)) return back()
  const secret = await password({
    message: 'Webhook secret (leave blank to auto-generate)',
  })
  if (isCancel(secret)) return back()
  // clack's password() returns `undefined` on an empty submission (it has no
  // validate guard and never coerces to ''), so we normalize before the
  // length checks below to avoid a TypeError on the "leave blank" path.
  const enteredSecret = typeof secret === 'string' ? secret : ''
  const reposRaw = await text({
    message: 'Repositories to allow (comma-separated owner/repo, leave blank to skip)',
  })
  if (isCancel(reposRaw)) return back()
  const resolvedSecret = enteredSecret.length > 0 ? enteredSecret : randomBytes(32).toString('hex')
  return value({
    github: {
      webhookSecret: resolvedSecret,
      tunnelProvider,
      ...(webhookUrl !== undefined ? { webhookUrl } : {}),
      webhookPort: Number(port),
      ...(namedCreds !== undefined ? namedCreds : {}),
      repos: parseGithubRepos(reposRaw ?? ''),
      auth,
    },
  })
}

async function promptGithubCloudflareNamedTunnel(cwd: string): Promise<{ hostname: string; tokenEnv: string } | null> {
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
    validate: (v) => validateGithubUrl(v ?? '', 'Hostname is required'),
  })
  if (isCancel(hostname)) return null
  if (!hasEnvKey(cwd, tokenEnv)) {
    const token = await password({
      message: `Cloudflare tunnel token (will be written to .env as ${tokenEnv})`,
      validate: (v) => (v && v.length > 0 ? undefined : 'Token is required'),
    })
    if (isCancel(token)) return null
    const stored = storeEnvKeyUnlessPresent(cwd, tokenEnv, token)
    if (!stored.ok) {
      log.error(stored.reason)
      return null
    }
  }
  return { hostname, tokenEnv }
}

async function promptGithubPatAuth(): Promise<{ type: 'pat'; pat: string } | null> {
  const pat = await password({
    message: 'GitHub fine-grained PAT',
    validate: (v) => (v && v.length > 0 ? undefined : 'PAT is required'),
  })
  if (isCancel(pat)) return null
  return { type: 'pat', pat }
}

async function promptGithubAppAuth(): Promise<{
  type: 'app'
  appId: number
  privateKey: string
} | null> {
  const appId = await text({
    message: 'GitHub App ID',
    validate: (v) => validatePositiveInteger(v ?? '', 'App ID is required'),
  })
  if (isCancel(appId)) return null
  const privateKey = await promptPrivateKeyPem('GitHub App private key PEM, escaped PEM, or path to .pem file')
  if (privateKey === CANCEL_SYMBOL) return null
  return {
    type: 'app',
    appId: Number(appId),
    privateKey,
  }
}

function parseGithubRepos(input: string): string[] {
  return input
    .split(',')
    .map((v) => v.trim())
    .filter((v) => /^[^\s/]+\/[^\s/]+$/.test(v))
}

function validateGithubUrl(v: string, requiredMessage: string): string | undefined {
  if (!v || v.length === 0) return requiredMessage
  try {
    new URL(v)
    return undefined
  } catch {
    return 'Must be a valid URL'
  }
}

function validatePositiveInteger(v: string, requiredMessage: string): string | undefined {
  if (!v || v.length === 0) return requiredMessage
  const parsed = Number(v)
  return Number.isInteger(parsed) && parsed > 0 ? undefined : 'Must be a positive integer'
}

async function runTelegramFlow(): Promise<StepResult<CollectedInputs['channelSecrets']>> {
  note(
    [
      'Open Telegram and message @BotFather or visit https://t.me/BotFather.',
      '/newbot → pick a name and username, copy the HTTP API token',
      '  (looks like 1234567890:ABCdef...).',
      'In @BotFather: /setprivacy → Disable, so the bot can see group messages.',
    ].join('\n'),
    'Get a Telegram bot token',
  )
  const token = await password({
    message: 'Telegram bot token',
    validate: (v) =>
      v && v.length > 0
        ? /^\d+:/.test(v)
          ? undefined
          : 'Bot token must look like "<digits>:<secret>" (from @BotFather)'
        : 'Token is required',
  })
  if (isCancel(token)) return back()
  note(
    [
      'Open https://t.me/<your_bot_username> (the username you picked in /newbot, ends in "bot").',
      'Tap Start in the chat — the agent will reply once it hatches.',
      'For groups: add the bot to the group, then @mention it or reply to its messages.',
    ].join('\n'),
    'Send your first message',
  )
  return value({ telegramBotToken: token })
}

function reportProgress(
  onHatchingDone: (ok: boolean) => void,
  onPreflightFail: (result: Extract<DockerAvailability, { ok: false }>) => void,
): (event: InitStepEvent) => void {
  const spinners: Partial<Record<InitStepEvent['step'], ReturnType<typeof spinner>>> = {}

  return (event) => {
    if (event.step === 'hatching') {
      reportHatching(event)
      if (event.phase === 'done') onHatchingDone(event.result.ok)
      return
    }

    if (event.phase === 'start') {
      const s = spinner()
      s.start(START_MESSAGES[event.step])
      spinners[event.step] = s
      return
    }

    const s = spinners[event.step]
    if (!s) return

    switch (event.step) {
      case 'preflight':
        if (event.result.ok) {
          s.stop('Docker is reachable.')
        } else {
          s.error(preflightFailureSummary(event.result))
          onPreflightFail(event.result)
        }
        break
      case 'scaffold':
        s.stop('Egg laid. 🥚')
        break
      case 'kakaotalk-auth':
        s.stop(reportKakaotalkAuth(event.result))
        break
      case 'webex-auth':
        s.stop(reportWebexAuth(event.result))
        break
      case 'teams-auth':
        s.stop(reportTeamsAuth(event.result))
        break
      case 'github-webhooks':
        s.stop(formatEagerGithubWebhookInstallResult(event.result))
        break
      case 'oauth-login':
        s.stop(event.result.ok ? 'Logged in.' : `OAuth login failed: ${event.result.reason}`)
        break
      case 'install':
        if (event.result.ok) {
          s.stop('Dependencies installed.')
        } else {
          s.error(`Dependency install failed: ${event.result.reason}`)
        }
        break
      case 'dockerfile':
        if (event.result.ok) {
          s.stop(event.result.devMode ? 'Dockerfile written (dev mode).' : 'Dockerfile written.')
        } else {
          s.error(`Dockerfile generation failed: ${event.result.reason}`)
        }
        break
      case 'git':
        if (event.result.ok) {
          s.stop(event.result.skipped ? 'Git repository already exists.' : 'Git repository initialized.')
        } else {
          s.error(`git init failed — continuing without a repo: ${event.result.reason}`)
        }
        break
    }
  }
}

function renderPreflightFailure(result: Extract<DockerAvailability, { ok: false }>): {
  summary: string
  lines: string[]
} {
  const detail = result.reason === 'daemon-down' ? result.detail : undefined
  const installed = detectInstalledDockerApps()
  const nudge = pickRuntimeToNudge(process.env, detail, installed)
  return renderDockerUnavailableGuidance(result, {
    platform: process.platform,
    nudge,
    installed,
    retryHint: 'Then re-run `typeclaw init`.',
  })
}

function preflightFailureSummary(result: Extract<DockerAvailability, { ok: false }>): string {
  return renderPreflightFailure(result).summary
}

function preflightFailureGuidance(result: Extract<DockerAvailability, { ok: false }>): string[] {
  return renderPreflightFailure(result).lines
}

function reportKakaotalkAuth(result: KakaotalkAuthResult): string {
  if (result.ok) return 'KakaoTalk credentials saved to secrets.json.'
  return `KakaoTalk login failed: ${result.reason}`
}

function reportWebexAuth(result: { ok: true } | { ok: false; reason: string }): string {
  if (result.ok) return 'Webex credentials saved to secrets.json.'
  return `Webex login failed: ${result.reason}`
}

function reportTeamsAuth(result: { ok: true } | { ok: false; reason: string }): string {
  if (result.ok) return 'Teams credentials saved to secrets.json.'
  return `Teams login failed: ${result.reason}`
}

// Hatching launches the container and foregrounds the TUI, so it steals stdin
// and cannot share the spinner lifecycle with the other steps. Print plain
// lines instead.
function reportHatching(event: Extract<InitStepEvent, { step: 'hatching' }>): void {
  if (event.phase === 'start') {
    console.log('Hatching...')
    return
  }
  if (event.result.ok) {
    console.log('Hatched. 🐣')
  } else {
    console.error(errorLine(`Hatching failed: ${event.result.reason}`))
  }
}

function providersInCatalog(options: ModelOption[]): Set<KnownProviderId> {
  return new Set(options.map((o) => o.providerId))
}

// Vendors with at least one provider present in the catalog, ordered by the
// product priority encoded in `KNOWN_PROVIDER_VENDORS` declaration order (not
// catalog iteration order).
function uniqueVendors(options: ModelOption[]): KnownProviderVendorId[] {
  const present = providersInCatalog(options)
  return listKnownProviderVendorIds().filter((vendorId) =>
    providerIdsForVendor(vendorId).some((providerId) => present.has(providerId)),
  )
}

function providersForVendorInCatalog(vendorId: KnownProviderVendorId, options: ModelOption[]): KnownProviderId[] {
  const present = providersInCatalog(options)
  return providerIdsForVendor(vendorId).filter((providerId) => present.has(providerId))
}

// Per-provider recommended model refs. Surfaces a "(Recommended)" suffix in
// the picker label and floats the entry to the top of the list (which also
// makes it the default `initialValue` when the caller has no prior choice).
// Kept narrow on purpose: one recommendation per provider. gpt-5.4-mini is
// listed under both `openai` and `openai-codex` because the same model is
// the right default whether the user authenticates with an API key or with
// a ChatGPT Plus/Pro subscription. claude-sonnet-4-6 follows Anthropic's
// own current-tier guidance (see the model lineup notes in providers.ts).
const RECOMMENDED_MODEL_REFS: ReadonlySet<KnownModelRef> = new Set<KnownModelRef>([
  'openai/gpt-5.4-mini',
  'openai-codex/gpt-5.4-mini',
  'anthropic/claude-sonnet-4-6',
])

export function formatModelLabel(o: ModelOption): string {
  return isKnownModelRef(o.ref) && RECOMMENDED_MODEL_REFS.has(o.ref) ? `${o.modelName} (Recommended)` : o.modelName
}

export function sortRecommendedFirst(options: ModelOption[]): ModelOption[] {
  const recommended = options.filter((o) => isKnownModelRef(o.ref) && RECOMMENDED_MODEL_REFS.has(o.ref))
  const rest = options.filter((o) => !isKnownModelRef(o.ref) || !RECOMMENDED_MODEL_REFS.has(o.ref))
  return [...recommended, ...rest]
}

function formatModelHint(o: ModelOption): string {
  const parts: string[] = []
  if (o.contextWindow !== null) parts.push(`${(o.contextWindow / 1000).toFixed(0)}K ctx`)
  if (o.reasoning) parts.push('reasoning')
  return parts.join(' · ')
}

function vendorHint(vendorId: KnownProviderVendorId, options: ModelOption[]): string {
  const providers = providersForVendorInCatalog(vendorId, options)
  const apiKey = providers.some((id) => providerSupportsApiKey(KNOWN_PROVIDERS[id]))
  const oauth = providers.some((id) => providerSupportsOAuth(KNOWN_PROVIDERS[id]))
  if (apiKey && oauth) return 'API key or OAuth'
  if (oauth) return 'OAuth login'
  return 'API key'
}

const START_MESSAGES: Record<Exclude<InitStep, 'hatching'>, string> = {
  preflight: 'Checking Docker...',
  'oauth-login': 'Waiting for browser login...',
  scaffold: 'Laying the egg...',
  'slack-auth': 'Logging in to Slack...',
  'discord-auth': 'Logging in to Discord...',
  'instagram-auth': 'Logging in to Instagram...',
  'kakaotalk-auth': 'Logging in to KakaoTalk...',
  'webex-auth': 'Logging in to Webex...',
  'teams-auth': 'Logging in to Teams...',
  'github-webhooks': 'Installing GitHub repository webhooks...',
  install: 'Installing dependencies with bun...',
  dockerfile: 'Writing Dockerfile...',
  git: 'Initializing git repository...',
}
