import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { autocomplete, cancel, intro, isCancel, log, select } from '@clack/prompts'
import { defineCommand } from 'citty'

import { type CustomModelMeta, type ThinkingLevel, thinkingLevelSchema } from '@/config'
import {
  addProfile,
  listModelProfiles,
  listRegisteredModelRefs,
  removeProfile,
  setProfile,
  setProfileThinkingLevel,
} from '@/config/models-mutation'
import {
  isKnownModelRef,
  isModelRef,
  KNOWN_PROVIDERS,
  providerForModelRef,
  type KnownModelRef,
  type KnownProviderId,
} from '@/config/providers'
import { findAgentDir, isInitialized } from '@/init'
import { customModelMetaFromOption, fetchModelOptions, type ModelOption } from '@/init/models-dev'

import { fuzzyMatch } from './fuzzy-filter'
import { runProviderAddFlow } from './provider'
import { c, done, errorLine } from './ui'

const ADD_PROVIDER_SENTINEL = '__add-provider__'

type PickedModelRef = {
  ref: string
  meta?: CustomModelMeta
}

const setSub = defineCommand({
  meta: {
    name: 'set',
    description: 'set or update a model profile (default | fast | deep | vision | <custom>)',
  },
  args: {
    profile: {
      type: 'positional',
      description: 'profile name (typically `default`); omit to pick interactively',
      required: false,
    },
    ref: {
      type: 'positional',
      description: '<provider>/<model> ref; omit to pick interactively',
      required: false,
    },
    force: {
      type: 'boolean',
      description: 'write even when the target provider has no credentials configured',
      required: false,
    },
    thinking: {
      type: 'string',
      description:
        "reasoning effort for THIS profile (off|minimal|low|medium|high|xhigh|max|default); the `default` profile's level is the de-facto global default",
      required: false,
    },
  },
  async run({ args }) {
    const cwd = ensureAgentDir()
    // `model set <ref>` shorthand targets the `default` profile; a shorthand ref
    // is resolved as an explicit ref (so its errors surface via resolvePickedRef's
    // exit-1 path), and a bare/named-profile invocation falls back to the picker.
    const shorthandRef = resolveShorthandRef(args.profile, args.ref)
    const profile = shorthandRef !== undefined ? 'default' : (args.profile ?? (await pickProfileName()))
    const picked = await resolvePickedRef(shorthandRef ?? args.ref, cwd)

    intro(`Setting model profile: ${profile} → ${picked.ref}`)

    // Gather every interactive/flag input BEFORE any write, so cancelling a
    // later prompt (e.g. the thinking-level select) aborts the whole command
    // without having already mutated typeclaw.json.
    const interactive = shouldPromptThinkingLevel(shorthandRef, args.ref, args.thinking)
    let thinking: { level: ThinkingLevel | undefined } | undefined
    if (args.thinking !== undefined) {
      const parsed = parseThinkingArg(args.thinking)
      if (!parsed.ok) {
        console.error(errorLine(parsed.reason))
        process.exit(1)
      }
      thinking = { level: parsed.level }
    } else if (interactive) {
      thinking = await pickProfileThinkingLevel(cwd, profile)
    }

    const result = setProfile(cwd, profile, picked.ref, {
      force: args.force === true,
      ...(picked.meta !== undefined ? { meta: picked.meta } : {}),
      ...(thinking !== undefined ? { thinkingLevel: thinking.level } : {}),
    })
    if (!result.ok) {
      console.error(errorLine(result.reason))
      process.exit(1)
    }

    done({
      title: c.green(`Profile "${profile}" set.`),
      details: `${profile} → ${picked.ref}`,
      hints: [{ label: 'If the agent is running:', command: 'typeclaw reload' }],
    })
  },
})

const thinkingSub = defineCommand({
  meta: {
    name: 'thinking',
    description: "set the default profile's reasoning effort (the de-facto global default for new sessions)",
  },
  args: {
    level: {
      type: 'positional',
      description:
        'reasoning effort (off|minimal|low|medium|high|xhigh|max); or "default" to clear and defer to the SDK default',
      required: false,
    },
  },
  async run({ args }) {
    const cwd = ensureAgentDir()
    let level: ThinkingLevel | undefined
    if (args.level !== undefined) {
      const parsed = parseThinkingArg(args.level)
      if (!parsed.ok) {
        console.error(errorLine(parsed.reason))
        process.exit(1)
      }
      level = parsed.level
    } else {
      const picked = await pickProfileThinkingLevel(cwd, 'default')
      if (picked === undefined) return
      level = picked.level
    }
    const result = setProfileThinkingLevel(cwd, 'default', level)
    if (!result.ok) {
      console.error(errorLine(result.reason))
      process.exit(1)
    }
    done({
      title: c.green(
        level === undefined
          ? "default profile's thinkingLevel cleared."
          : `default profile's thinkingLevel set to "${level}".`,
      ),
      hints: [{ label: 'If the agent is running:', command: 'typeclaw reload' }],
    })
  },
})

const addSub = defineCommand({
  meta: {
    name: 'add',
    description: 'create a new (non-default) model profile; refuses when the profile already exists',
  },
  args: {
    profile: {
      type: 'positional',
      description: 'profile name (must not already exist)',
      required: true,
    },
    ref: {
      type: 'positional',
      description: '<provider>/<model> ref; omit to pick interactively',
      required: false,
    },
    force: {
      type: 'boolean',
      description: 'write even when the target provider has no credentials configured',
      required: false,
    },
  },
  async run({ args }) {
    const cwd = ensureAgentDir()
    const picked = await resolvePickedRef(args.ref, cwd)

    intro(`Adding model profile: ${args.profile} → ${picked.ref}`)

    const result = addProfile(cwd, args.profile, picked.ref, {
      force: args.force === true,
      ...(picked.meta !== undefined ? { meta: picked.meta } : {}),
    })
    if (!result.ok) {
      console.error(errorLine(result.reason))
      process.exit(1)
    }
    done({
      title: c.green(`Profile "${args.profile}" added.`),
      details: `${args.profile} → ${picked.ref}`,
      hints: [{ label: 'If the agent is running:', command: 'typeclaw reload' }],
    })
  },
})

const removeSub = defineCommand({
  meta: {
    name: 'remove',
    description: 'remove a non-default model profile (cannot remove `default`)',
  },
  args: {
    profile: {
      type: 'positional',
      description: 'profile name to remove',
      required: true,
    },
  },
  async run({ args }) {
    const cwd = ensureAgentDir()
    intro(`Removing model profile: ${args.profile}`)
    const result = removeProfile(cwd, args.profile)
    if (!result.ok) {
      console.error(errorLine(result.reason))
      process.exit(1)
    }
    done({
      title: c.green(`Profile "${args.profile}" removed.`),
      hints: [{ label: 'If the agent is running:', command: 'typeclaw reload' }],
    })
  },
})

const listSub = defineCommand({
  meta: {
    name: 'list',
    description: 'list configured model profiles (or all known model refs with --available)',
  },
  args: {
    available: {
      type: 'boolean',
      description: 'list every <provider>/<model> ref typeclaw recognizes (not just configured profiles)',
      required: false,
    },
  },
  async run({ args }) {
    if (args.available === true) {
      await printAvailableRefs()
      return
    }
    const cwd = ensureAgentDir()
    const entries = listModelProfiles(cwd)
    if (entries.length === 0) {
      console.log(c.dim('No models configured.'))
      return
    }

    const profileWidth = Math.max(7, ...entries.map((e) => e.profile.length))
    const refDisplay = (e: (typeof entries)[number]): string =>
      e.refs.length > 1 ? `${e.ref} ${c.dim(`(+${e.refs.length - 1} fallback)`)}` : e.ref
    const refWidth = Math.max(3, ...entries.map((e) => e.ref.length + (e.refs.length > 1 ? 14 : 0)))
    // An explicit per-profile level shows as-is; a profile without one inherits
    // the default profile's level (or the SDK default for `default` itself).
    const thinkingDisplay = (e: (typeof entries)[number]): string =>
      e.thinkingLevel !== undefined ? e.thinkingLevel : c.dim(e.isDefault ? 'sdk-default' : 'inherit')
    const thinkingWidth = Math.max(
      5,
      ...entries.map((e) => (e.thinkingLevel ?? (e.isDefault ? 'sdk-default' : 'inherit')).length),
    )

    const header = `${'PROFILE'.padEnd(profileWidth)}  ${'REF'.padEnd(refWidth)}  ${'THINK'.padEnd(thinkingWidth)}  PROVIDER  STATUS`
    console.log(c.dim(header))
    for (const e of entries) {
      const star = e.isDefault ? c.cyan('*') : ' '
      const status = e.credentialStatus === 'available' ? c.green('ok') : c.yellow('missing-credentials')
      const line = `${star}${e.profile.padEnd(profileWidth - 1)}  ${refDisplay(e).padEnd(refWidth)}  ${thinkingDisplay(e).padEnd(thinkingWidth)}  ${e.providerId.padEnd(12)}  ${status}`
      console.log(line)
      if (e.refs.length > 1) {
        for (let i = 1; i < e.refs.length; i++) {
          const fb = e.refs[i]!
          console.log(`${' '.padEnd(profileWidth + 2)}↳ ${c.dim(fb)}`)
        }
      }
    }
  },
})

export const modelCommand = defineCommand({
  meta: {
    name: 'model',
    description: 'manage model profiles in typeclaw.json (models.default, ...)',
  },
  subCommands: {
    set: setSub,
    add: addSub,
    remove: removeSub,
    list: listSub,
    thinking: thinkingSub,
  },
})

function ensureAgentDir(): string {
  const cwd = findAgentDir(process.cwd()) ?? process.cwd()
  if (!isInitialized(cwd)) {
    console.error(errorLine('TypeClaw config file not found. Run `typeclaw init` first, or cd into an agent folder.'))
    process.exit(1)
  }
  return cwd
}

async function pickProfileName(): Promise<string> {
  const choice = await select<string>({
    message: 'Pick a profile to set',
    options: [
      { value: 'default', label: 'default', hint: 'active model for new sessions' },
      { value: 'fast', label: 'fast', hint: 'optional alias used by some subagents' },
      { value: 'deep', label: 'deep', hint: 'optional alias used by some subagents' },
      { value: 'vision', label: 'vision', hint: 'optional alias used by some subagents' },
    ],
    initialValue: 'default',
  })
  if (isCancel(choice)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return choice
}

// The config schema is the single source of truth, so `--thinking` and the
// picker accept exactly the levels typeclaw.json accepts (including `max`).
const THINKING_LEVELS: readonly ThinkingLevel[] = thinkingLevelSchema.options
const KEEP_THINKING_SENTINEL = '__keep__'

export type ParsedThinkingArg = { ok: true; level: ThinkingLevel | undefined } | { ok: false; reason: string }

export function parseThinkingArg(raw: string): ParsedThinkingArg {
  const value = raw.trim().toLowerCase()
  if (value === 'default' || value === 'unset' || value === 'none') return { ok: true, level: undefined }
  if ((THINKING_LEVELS as readonly string[]).includes(value)) return { ok: true, level: value as ThinkingLevel }
  return {
    ok: false,
    reason: `Invalid --thinking "${raw}". Use one of: ${THINKING_LEVELS.join(', ')}, or "default" to clear.`,
  }
}

async function pickProfileThinkingLevel(
  cwd: string,
  profile: string,
): Promise<{ level: ThinkingLevel | undefined } | undefined> {
  const current = readProfileThinkingLevel(cwd, profile)
  const clearedHint = profile === 'default' ? 'defer to the SDK default' : "inherit the default profile's level"
  const choice = await select<string>({
    message: `Reasoning effort for profile "${profile}"`,
    options: [
      { value: KEEP_THINKING_SENTINEL, label: 'keep current', hint: current ?? clearedHint },
      ...THINKING_LEVELS.map((level) => ({ value: level, label: level })),
      { value: 'default', label: 'clear', hint: clearedHint },
    ],
    initialValue: KEEP_THINKING_SENTINEL,
  })
  if (isCancel(choice)) {
    cancel('Aborted.')
    process.exit(0)
  }
  if (choice === KEEP_THINKING_SENTINEL) return undefined
  if (choice === 'default') return { level: undefined }
  return { level: choice as ThinkingLevel }
}

// Reads a profile's own thinkingLevel straight from disk (rich-object form
// only — a bare string/array profile has no level). Used to seed the
// interactive picker's "keep current" hint.
function readProfileThinkingLevel(cwd: string, profile: string): ThinkingLevel | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(cwd, 'typeclaw.json'), 'utf8')) as {
      models?: Record<string, unknown>
    }
    const entry = parsed.models?.[profile]
    if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
      return (entry as { thinkingLevel?: ThinkingLevel }).thinkingLevel
    }
    return undefined
  } catch {
    return undefined
  }
}

async function pickModelRef(cwd: string): Promise<PickedModelRef> {
  while (true) {
    const refs = listRegisteredModelRefs(cwd)
    if (refs.length === 0) {
      log.info("No provider credentials found. Let's add one first.")
      const added = await runProviderAddFlow(cwd, {})
      if (!added.ok) {
        console.error(errorLine(added.reason))
        process.exit(1)
      }
      continue
    }
    // select<string>, not the KnownModelRef union: clack's Option<Value> is a
    // distributive conditional type and a large ref union breaks `value: ref`
    // assignability. Values are ref strings (+ the sentinel) and stay correct
    // at runtime — the sentinel check and `return choice` below are unaffected.
    const modelOptions = await listCredentialedModelOptions(refs)
    const choice = await autocomplete<string>({
      message: 'Pick a model',
      placeholder: 'Type to search…',
      filter: fuzzyMatch,
      options: [
        ...modelOptions.map((option) => ({
          value: option.ref,
          label: describeRef(option.ref),
          hint: option.ref,
        })),
        {
          value: ADD_PROVIDER_SENTINEL,
          label: c.cyan('+ add provider'),
          hint: 'configure a new provider',
        },
      ],
      initialValue: modelOptions[0]?.ref ?? refs[0],
    })
    if (isCancel(choice)) {
      cancel('Aborted.')
      process.exit(0)
    }
    if (choice !== ADD_PROVIDER_SENTINEL) {
      const option = modelOptions.find((candidate) => candidate.ref === choice)
      if (option === undefined) return { ref: choice }
      const meta = customModelMetaFromOption(option)
      return { ref: option.ref, ...(meta !== undefined ? { meta } : {}) }
    }
    const added = await runProviderAddFlow(cwd, {})
    if (!added.ok) {
      console.error(errorLine(added.reason))
      process.exit(1)
    }
  }
}

// One-positional shorthand for `set`: `typeclaw model set <ref>` targets the
// `default` profile without repeating its name. It's shorthand ONLY when a
// single positional was given (no `<ref>` arg) and that positional parses as a
// model ref — so `model set fast` (a NAMED profile, not a ref) is NOT shorthand
// and still selects the `fast` profile interactively. Returns the ref when the
// invocation is shorthand, else undefined.
export function resolveShorthandRef(profile: string | undefined, ref: string | undefined): string | undefined {
  return ref === undefined && profile !== undefined && isModelRef(profile) ? profile : undefined
}

// Whether `set` should OFFER the interactive thinking-level prompt. It should
// only when the ref itself was chosen interactively — i.e. no ref came from the
// command line (neither the explicit `<ref>` arg nor the shorthand) and no
// `--thinking` flag pinned the level. A named profile with no ref (e.g.
// `model set fast`) picks its ref interactively, so it MUST still prompt; keying
// this on `args.profile` instead of `shorthandRef` would wrongly suppress it.
export function shouldPromptThinkingLevel(
  shorthandRef: string | undefined,
  ref: string | undefined,
  thinking: string | undefined,
): boolean {
  return shorthandRef === undefined && ref === undefined && thinking === undefined
}

// Non-interactive `<ref>` path. Curated refs resolve from KNOWN_PROVIDERS, so
// they need no metadata. Non-curated refs are looked up in the live catalog so
// `customModels[ref]` carries the same metadata the interactive picker would
// persist; without it `resolveModel` silently falls back to defaults. A
// catalog miss (offline / unknown id) still writes the ref, but warns first.
export async function resolveExplicitRef(
  ref: string,
  loadCatalog: () => Promise<{ options: ModelOption[] }> = fetchModelOptions,
): Promise<PickedModelRef> {
  if (isKnownModelRef(ref)) return { ref }
  // Intentionally NOT rejecting refs that miss our shipped registry — not even
  // for a closed-set provider like openai-codex. The registry is a snapshot, not
  // an authoritative catalog: OpenAI ships new Codex models (e.g. the gpt-5.6
  // line) before we can update it, and a definite "this model doesn't exist" is
  // only knowable from the backend's own 400, which the runtime path now
  // classifies (see provider-error.ts). Blocking here would instead stop users
  // from selecting a real, newly-shipped model. So an unknown closed-provider ref
  // takes the same forward-compatible warning path as any other non-curated ref.
  const { options } = await loadCatalog()
  const option = options.find((candidate) => candidate.ref === ref)
  if (option === undefined) {
    log.warn(
      `"${ref}" isn't in the live catalog; saving the ref without metadata. ` +
        `The agent will use fallback defaults (reasoning off, text-only input, zero cost, provider-default context).`,
    )
    return { ref }
  }
  const meta = customModelMetaFromOption(option)
  return { ref, ...(meta !== undefined ? { meta } : {}) }
}

// Resolve the model ref for `set`/`add`: an explicit `<ref>` arg is resolved
// (and enriched with catalog metadata) by `resolveExplicitRef`, while a bare
// invocation opens the interactive picker. Any resolution error surfaces via the
// standard CLI error line + non-zero exit instead of an unhandled-rejection
// stack trace. (Ref *shape*/support is validated downstream by set/addProfile.)
async function resolvePickedRef(ref: string | undefined, cwd: string): Promise<PickedModelRef> {
  if (ref === undefined) return pickModelRef(cwd)
  try {
    return await resolveExplicitRef(ref)
  } catch (e) {
    console.error(errorLine(e instanceof Error ? e.message : String(e)))
    process.exit(1)
  }
}

export type { PickedModelRef }

async function listCredentialedModelOptions(refs: KnownModelRef[]): Promise<ModelOption[]> {
  const credentialedProviders = new Set<KnownProviderId>(refs.map((ref) => providerForModelRef(ref)))
  const catalog = await fetchModelOptions()
  const options = catalog.options.filter((option) => credentialedProviders.has(option.providerId))
  if (options.length > 0) return options
  return refs.map((ref) => {
    const providerId = providerForModelRef(ref)
    const modelId = ref.slice(providerId.length + 1)
    const model = (
      KNOWN_PROVIDERS[providerId].models as Record<
        string,
        { name: string; reasoning?: boolean; contextWindow?: number; input?: ReadonlyArray<string> }
      >
    )[modelId]
    return {
      ref,
      providerId,
      providerName: KNOWN_PROVIDERS[providerId].name,
      modelId,
      modelName: model?.name ?? modelId,
      reasoning: model?.reasoning ?? false,
      contextWindow: model?.contextWindow ?? null,
      curated: true,
      supportsVision: model?.input?.includes('image') ?? false,
    }
  })
}

function describeRef(ref: string): string {
  try {
    const providerId = providerForModelRef(ref)
    const modelId = ref.slice(providerId.length + 1)
    const provider = KNOWN_PROVIDERS[providerId]
    const model = (provider.models as Record<string, { name: string }>)[modelId]
    return `${provider.name} · ${model?.name ?? modelId}`
  } catch {
    return ref
  }
}

async function printAvailableRefs(): Promise<void> {
  const { options, sources, warnings } = await fetchModelOptions()
  if (options.length === 0) {
    console.log(c.dim('No models registered.'))
    return
  }
  console.log(c.dim('Use `typeclaw model set <profile> <ref>` to apply.'))
  if (sources.modelsDev === 'unavailable') console.log(c.dim('Using built-in models for native providers.'))
  if (sources.openGatewayCatalog === 'unavailable') console.log(c.dim('Using the built-in OpenGateway anchor.'))
  else if (sources.openGatewayPrices === 'unavailable') {
    console.log(c.dim('OpenGateway models loaded without live pricing.'))
  }
  if (warnings.length > 0) console.log(c.dim(`Catalog warnings: ${warnings.join('; ')}`))
  for (const providerId of Object.keys(KNOWN_PROVIDERS) as KnownProviderId[]) {
    const providerOptions = options.filter((option) => option.providerId === providerId)
    if (providerOptions.length === 0) continue
    console.log('')
    console.log(c.cyan(KNOWN_PROVIDERS[providerId].name))
    for (const option of providerOptions) {
      console.log(`  ${option.ref}`)
    }
  }
}
