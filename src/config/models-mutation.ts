import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { commitSystemFileSync } from '@/git/system-commit'

import {
  configSchema,
  loadConfigSyncOrDefaults,
  modelOverrideRuleError,
  validateConfig,
  type CustomModelMeta,
  type ThinkingLevel,
} from './config'
import { readConfigForWriteSync, tryRecordConfigCommitSync } from './config-commits'
import { withConfigFileLockSync } from './config-file-lock'
import {
  KNOWN_PROVIDERS,
  isKnownModelRef,
  isModelRef,
  listKnownModelRefs,
  providerForModelRef,
  type KnownModelRef,
  type KnownProviderId,
  type ModelRef,
} from './providers'
import { isProviderConfigured, listConfiguredProviders } from './providers-mutation'

const CONFIG_FILE = 'typeclaw.json'

export type ModelProfileEntry = {
  profile: string
  // Head of the fallback chain. Kept under the legacy `ref` name so callers
  // that only care about the active model (the common case) don't need to
  // dereference `refs[0]`. The chain itself is exposed as `refs`.
  ref: ModelRef
  refs: ModelRef[]
  // The profile's own reasoning-effort override, or undefined when it inherits
  // the `default` profile's level (which is itself the de-facto global default).
  thinkingLevel?: ThinkingLevel
  providerId: KnownProviderId
  // Credential status for every provider referenced by the chain. The chain's
  // overall status is `available` only when every entry resolves; otherwise
  // it is `missing-credentials`, and `missingProviders` names which.
  missingProviders: KnownProviderId[]
  isDefault: boolean
  credentialStatus: 'available' | 'missing-credentials'
}

export type ModelMutationResult = { ok: true } | { ok: false; reason: string }

// `listModelProfiles` is the read-only path behind `typeclaw model list`, a
// diagnostic command. It routes through `loadConfigSyncOrDefaults` (same
// soft-fail pattern as `typeclaw status` / `doctor`, PR #288) so a broken
// `typeclaw.json` doesn't crash the command users reach for to see what
// model config the agent thinks it has. Mutation paths (`setProfile`,
// `addProfile`, `removeProfile`) stay on the strict gate via `validateConfig`
// in `writeModels`, because writing through a broken-on-disk file would
// silently land schema-invalid bytes.
export function listModelProfiles(cwd: string, env: NodeJS.ProcessEnv = process.env): ModelProfileEntry[] {
  const models = loadConfigSyncOrDefaults(cwd).models
  const out: ModelProfileEntry[] = []
  for (const [profile, entry] of Object.entries(models)) {
    const headRef = entry.refs[0]!
    const providerId = providerForModelRef(headRef)
    const missingProviders = uniqueProviders(entry.refs).filter((p) => !hasUsableCredential(cwd, p, env))
    out.push({
      profile,
      ref: headRef,
      refs: entry.refs,
      ...(entry.thinkingLevel !== undefined ? { thinkingLevel: entry.thinkingLevel } : {}),
      providerId,
      missingProviders,
      isDefault: profile === 'default',
      credentialStatus: missingProviders.length === 0 ? 'available' : 'missing-credentials',
    })
  }
  // `default` always first; remaining profiles alphabetical so output is stable.
  out.sort((a, b) => {
    if (a.isDefault) return -1
    if (b.isDefault) return 1
    return a.profile.localeCompare(b.profile)
  })
  return out
}

function uniqueProviders(refs: ReadonlyArray<ModelRef>): KnownProviderId[] {
  const seen = new Set<KnownProviderId>()
  const out: KnownProviderId[] = []
  for (const r of refs) {
    const p = providerForModelRef(r)
    if (!seen.has(p)) {
      seen.add(p)
      out.push(p)
    }
  }
  return out
}

export function listAvailableModelRefs(): KnownModelRef[] {
  return listKnownModelRefs()
}

// Subset of `listAvailableModelRefs()` filtered to providers with a usable
// credential in this agent folder — either a `secrets.json#providers.<id>`
// entry (api-key OR oauth) or a credential resolvable from the process env
// via the provider's canonical env-var name. Used by `typeclaw model set`'s
// interactive picker so users only see models they can actually run; the
// CLI surfaces an explicit "add provider" sentinel when the result is empty
// or when the user wants to wire a new one.
//
// Ordering preserves `listKnownModelRefs()` (provider-table declaration
// order, then per-provider model order) so the picker reads stably across
// invocations.
export function listRegisteredModelRefs(cwd: string, env: NodeJS.ProcessEnv = process.env): KnownModelRef[] {
  const registered = new Set<KnownProviderId>()
  for (const entry of listConfiguredProviders(cwd, env)) {
    if (entry.known) registered.add(entry.id as KnownProviderId)
  }
  return listKnownModelRefs().filter((ref) => registered.has(providerForModelRef(ref)))
}

export { isKnownModelRef }

// `set` is the canonical mutation for both creating a new profile and updating
// an existing one (mirrors how `models.<profile>` works in the schema).
// Refuses unknown model refs and providers without credentials (unless
// `force: true`) so a write can't leave the agent in a state where the next
// session start crashes with a missing-credential error.
export type SetProfileOptions = {
  force?: boolean
  env?: NodeJS.ProcessEnv
  meta?: CustomModelMeta
  // Present key = write this reasoning effort alongside the ref (an explicit
  // `undefined` clears any existing level). Omit the key entirely to leave an
  // existing per-profile level untouched. `setProfile` distinguishes the two
  // via `Object.hasOwn`, so `{ thinkingLevel: undefined }` is a clear, not a
  // no-op.
  thinkingLevel?: ThinkingLevel
}

export function setProfile(
  cwd: string,
  profile: string,
  ref: string,
  options: SetProfileOptions = {},
): ModelMutationResult {
  return underConfigLock(cwd, () => setProfileInLock(cwd, profile, ref, options))
}

// `add` is just `set` with a uniqueness guard; users who want "update" should
// reach for `set`. Keeping it separate so the CLI can route distinct error
// messages without leaking force-overwrite as a happy path.
export function addProfile(
  cwd: string,
  profile: string,
  ref: string,
  options: SetProfileOptions = {},
): ModelMutationResult {
  return underConfigLock(cwd, () => {
    const existing = readModelsRaw(cwd)
    if (existing !== null && profile in existing) {
      return {
        ok: false,
        reason: `Profile "${profile}" already exists. Use \`typeclaw model set ${profile} ${ref}\` to update it.`,
      }
    }
    return setProfileInLock(cwd, profile, ref, options)
  })
}

function setProfileInLock(cwd: string, profile: string, ref: string, options: SetProfileOptions): ConfigWrite {
  const trimmed = profile.trim()
  if (trimmed.length === 0) {
    return { ok: false, reason: 'Profile name cannot be empty.' }
  }
  if (!isModelRef(ref)) {
    return {
      ok: false,
      reason: `Unknown model "${ref}". Run \`typeclaw model list --available\` to see valid options.`,
    }
  }
  const providerId = providerForModelRef(ref)
  if (options.force !== true && !hasUsableCredential(cwd, providerId, options.env ?? process.env)) {
    return {
      ok: false,
      reason: `Provider "${providerId}" has no credentials. Run \`typeclaw provider add ${providerId}\` first, or pass --force to write anyway.`,
    }
  }

  const existingBefore = readModelsRaw(cwd)
  const verb = existingBefore !== null && trimmed in existingBefore ? 'set' : 'add'
  const customModel = !isKnownModelRef(ref) && options.meta !== undefined ? { ref, meta: options.meta } : undefined
  // An explicit `thinkingLevel` key (even `undefined`) overrides the existing
  // level; an omitted key preserves it. Pass the override as a single-element
  // tuple so `writeProfile` can tell "clear to undefined" from "don't touch".
  const thinkingOverride: [ThinkingLevel | undefined] | undefined = Object.hasOwn(options, 'thinkingLevel')
    ? [options.thinkingLevel]
    : undefined
  return writeProfile(cwd, trimmed, ref, `model: ${verb} ${trimmed} → ${ref}`, customModel, thinkingOverride)
}

// `default` is required by the schema (`modelsSchema.refine`). Removing it
// would make the file unparseable, so we reject with a precise hint instead of
// letting the next `validateConfig` failure confuse the user. To change the
// default model, the user runs `typeclaw model set default <ref>`.
export function removeProfile(cwd: string, profile: string): ModelMutationResult {
  return underConfigLock(cwd, () => {
    if (profile === 'default') {
      return {
        ok: false,
        reason:
          'Cannot remove the `default` profile. Use `typeclaw model set default <ref>` to change the default model.',
      }
    }
    const existing = readModelsRaw(cwd)
    if (existing === null) {
      return { ok: false, reason: `${CONFIG_FILE} not found at ${cwd}. Run \`typeclaw init\` first.` }
    }
    if (!(profile in existing)) {
      return { ok: false, reason: `Profile "${profile}" not found in ${CONFIG_FILE}.` }
    }
    const next = { ...existing }
    delete next[profile]
    return writeModels(cwd, next, `model: remove ${profile}`)
  })
}

// Sets (or clears) a profile's reasoning effort without touching its refs.
// `undefined` collapses the profile back to its bare string/array ref form.
// The `default` profile's level is the de-facto global default, so
// `setProfileThinkingLevel(cwd, 'default', level)` is the "global" knob.
// Rejects a profile that doesn't exist yet — the user must set its model first.
export function setProfileThinkingLevel(
  cwd: string,
  profile: string,
  level: ThinkingLevel | undefined,
): ModelMutationResult {
  return underConfigLock(cwd, () => {
    const trimmed = profile.trim()
    if (trimmed.length === 0) {
      return { ok: false, reason: 'Profile name cannot be empty.' }
    }
    const existing = readModelsRaw(cwd)
    if (existing === null) {
      return { ok: false, reason: `${CONFIG_FILE} not found at ${cwd}. Run \`typeclaw init\` first.` }
    }
    const current = existing[trimmed]
    if (current === undefined) {
      return {
        ok: false,
        reason: `Profile "${trimmed}" not found. Run \`typeclaw model set ${trimmed} <ref>\` to create it first.`,
      }
    }
    const refs = rawProfileRefs(current)
    if (refs === undefined) {
      return { ok: false, reason: `Profile "${trimmed}" has no model to attach a thinking level to.` }
    }
    const next: RawModels = { ...existing, [trimmed]: withRawProfileThinkingLevel(refs, level) }
    const message =
      level === undefined
        ? `model: clear thinkingLevel for ${trimmed}`
        : `model: set thinkingLevel ${level} for ${trimmed}`
    return writeModels(cwd, next, message)
  })
}

function writeProfile(
  cwd: string,
  profile: string,
  ref: ModelRef,
  message: string,
  customModel?: { ref: ModelRef; meta: CustomModelMeta },
  // `[level]` overrides (a wrapped `undefined` clears); `undefined` preserves
  // the existing level. The tuple is what lets an explicit clear win over a
  // pre-existing level instead of being swallowed by `??`.
  thinkingOverride?: [ThinkingLevel | undefined],
): ConfigWrite {
  const existing = readModelsRaw(cwd)
  // Setting refs keeps a bare ref bare; it only becomes a rich object once a
  // thinkingLevel is present. An override replaces the level (including a clear
  // to undefined); otherwise the existing per-profile level is preserved.
  const level = thinkingOverride !== undefined ? thinkingOverride[0] : rawProfileThinkingLevel(existing?.[profile])
  const value = withRawProfileThinkingLevel(ref, level)
  const next: RawModels = existing === null ? { default: value } : { ...existing, [profile]: value }
  if (existing === null && profile !== 'default') {
    next.default = ref
  }
  return writeModels(cwd, next, message, customModel)
}

function writeModels(
  cwd: string,
  models: RawModels,
  commitMessage: string,
  customModel?: { ref: ModelRef; meta: CustomModelMeta },
): ConfigWrite {
  return writeConfig(
    cwd,
    (parsed) => {
      parsed.models = models
    },
    commitMessage,
    customModel,
  )
}

function writeConfig(
  cwd: string,
  mutate: (parsed: Record<string, unknown>) => void,
  commitMessage: string,
  customModel?: { ref: ModelRef; meta: CustomModelMeta },
): ConfigWrite {
  const path = join(cwd, CONFIG_FILE)
  let parsed: Record<string, unknown>
  try {
    const raw = readConfigForWriteSync(path)
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, reason: `${CONFIG_FILE} not found at ${cwd}. Run \`typeclaw init\` first.` }
    }
    return { ok: false, reason: `Failed to read ${CONFIG_FILE}: ${(error as Error).message}` }
  }
  mutate(parsed)
  if (customModel !== undefined) {
    const existingCustomModels = isObjectRecord(parsed.customModels) ? parsed.customModels : {}
    parsed.customModels = { ...existingCustomModels, [customModel.ref]: customModel.meta }
  }
  const check = configSchema.safeParse(parsed)
  if (!check.success) {
    return {
      ok: false,
      reason: `config would be invalid: ${check.error.issues.map((i) => i.message).join('; ')}`,
    }
  }
  const bytes = `${JSON.stringify(parsed, null, 2)}\n`
  try {
    writeFileSync(path, bytes)
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code === 'EACCES' || code === 'EPERM') {
      return {
        ok: false,
        reason:
          `${CONFIG_FILE} is not writable by the current user. ` +
          `Inspect ownership with \`ls -ln "${path}"\`. If it is owned by another user and this agent folder belongs to you, repair it with \`sudo chown "$(id -u):$(id -g)" "${path}"\`.`,
      }
    }
    return {
      ok: false,
      reason: `Failed to write ${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  tryRecordConfigCommitSync(path, bytes)
  return { ok: true, commitMessage }
}

// A mutation that ran under the config lock; `commitMessage` is set when it wrote.
type ConfigWrite = { ok: true; commitMessage?: string } | { ok: false; reason: string }

// Runs a read-modify-write under the config lock, then validates and commits
// after releasing it, so the lock is never held across a git subprocess.
function underConfigLock(cwd: string, mutate: () => ConfigWrite): ModelMutationResult {
  const write = withConfigFileLockSync(join(cwd, CONFIG_FILE), mutate)
  if (!write.ok) return write
  if (write.commitMessage === undefined) return { ok: true }
  // Final schema-pass for parity with every other host-side mutation that runs
  // through validateConfig. Mount checks etc. should never fail here because
  // we only touched `models`, but if the file was already in a bad state we
  // want to surface that instead of leaving the user wondering why `reload`
  // fails.
  const validation = validateConfig(cwd)
  if (!validation.ok) {
    return { ok: false, reason: validation.reason }
  }
  // Auto-commit so the agent folder is never silently dirty after a CLI
  // config mutation. Same pattern as `persistMigratedConfig` and cron
  // migrations: `commitSystemFileSync` no-ops on non-git folders, missing
  // Bun, and clean files, so callers outside a git repo pay zero cost.
  commitSystemFileSync(cwd, CONFIG_FILE, write.commitMessage)
  return { ok: true }
}

export type ModelOverrideListing = {
  name: string
  match: string[]
  profiles: { profile: string; refs: ModelRef[]; thinkingLevel?: ThinkingLevel }[]
}

export function listModelOverrides(cwd: string): ModelOverrideListing[] {
  const overrides = loadConfigSyncOrDefaults(cwd).modelOverrides
  return Object.entries(overrides).map(([name, override]) => ({
    name,
    match: override.match,
    profiles: Object.entries(override.models).map(([profile, entry]) => ({
      profile,
      refs: entry.refs,
      ...(entry.thinkingLevel !== undefined ? { thinkingLevel: entry.thinkingLevel } : {}),
    })),
  }))
}

export type SetOverrideProfileOptions = SetProfileOptions & {
  // Rule added to the override's `match` (creating the override when it doesn't
  // exist yet). Required to create one; optional when it already exists.
  match?: string
}

export function setOverrideProfile(
  cwd: string,
  name: string,
  profile: string,
  ref: string,
  options: SetOverrideProfileOptions = {},
): ModelMutationResult {
  return underConfigLock(cwd, () => {
    const trimmed = profile.trim()
    if (trimmed.length === 0) return { ok: false, reason: 'Profile name cannot be empty.' }
    if (!isModelRef(ref)) {
      return {
        ok: false,
        reason: `Unknown model "${ref}". Run \`typeclaw model list --available\` to see valid options.`,
      }
    }
    if (options.match !== undefined) {
      const ruleError = modelOverrideRuleError(options.match)
      if (ruleError !== undefined) return { ok: false, reason: `Invalid match rule "${options.match}": ${ruleError}` }
    }
    const existing = readOverridesRaw(cwd)[name]
    if (existing === undefined && options.match === undefined) {
      return {
        ok: false,
        reason: `Override "${name}" does not exist. Pass --match <rule> to create it, e.g. --match 'slack:*'.`,
      }
    }
    const providerId = providerForModelRef(ref)
    if (options.force !== true && !hasUsableCredential(cwd, providerId, options.env ?? process.env)) {
      return {
        ok: false,
        reason: `Provider "${providerId}" has no credentials. Run \`typeclaw provider add ${providerId}\` first, or pass --force to write anyway.`,
      }
    }
    const match = existing?.match ?? []
    const models = existing?.models ?? {}
    const level = Object.hasOwn(options, 'thinkingLevel')
      ? options.thinkingLevel
      : rawProfileThinkingLevel(models[trimmed])
    const next: RawOverride = {
      match: options.match !== undefined && !match.includes(options.match) ? [...match, options.match] : match,
      models: { ...models, [trimmed]: withRawProfileThinkingLevel(ref, level) },
    }
    const customModel = !isKnownModelRef(ref) && options.meta !== undefined ? { ref, meta: options.meta } : undefined
    return writeOverride(cwd, name, next, `model: set ${trimmed} → ${ref} in override ${name}`, customModel)
  })
}

// Removing an override's last profile removes the override itself, since an
// entry with no profiles would be schema-invalid and has nothing to apply.
export function removeOverrideProfile(cwd: string, name: string, profile: string): ModelMutationResult {
  return underConfigLock(cwd, () => {
    const existing = readOverridesRaw(cwd)[name]
    if (existing === undefined) return { ok: false, reason: `Override "${name}" not found in ${CONFIG_FILE}.` }
    if (!(profile in existing.models)) {
      return { ok: false, reason: `Profile "${profile}" not found in override "${name}".` }
    }
    const models = { ...existing.models }
    delete models[profile]
    if (Object.keys(models).length === 0) return removeOverrideInLock(cwd, name)
    return writeOverride(cwd, name, { ...existing, models }, `model: remove ${profile} from override ${name}`)
  })
}

export function addOverrideMatch(cwd: string, name: string, rule: string): ModelMutationResult {
  return underConfigLock(cwd, () => {
    const ruleError = modelOverrideRuleError(rule)
    if (ruleError !== undefined) return { ok: false, reason: `Invalid match rule "${rule}": ${ruleError}` }
    const existing = readOverridesRaw(cwd)[name]
    if (existing === undefined) {
      return {
        ok: false,
        reason: `Override "${name}" not found. Create it with \`typeclaw model set <profile> <ref> --override ${name} --match '${rule}'\`.`,
      }
    }
    if (existing.match.includes(rule)) return { ok: true }
    return writeOverride(
      cwd,
      name,
      { ...existing, match: [...existing.match, rule] },
      `model: match ${rule} in override ${name}`,
    )
  })
}

export function removeOverrideMatch(cwd: string, name: string, rule: string): ModelMutationResult {
  return underConfigLock(cwd, () => {
    const existing = readOverridesRaw(cwd)[name]
    if (existing === undefined) return { ok: false, reason: `Override "${name}" not found in ${CONFIG_FILE}.` }
    if (!existing.match.includes(rule)) return { ok: false, reason: `Rule "${rule}" not found in override "${name}".` }
    if (existing.match.length === 1) {
      return {
        ok: false,
        reason: `"${rule}" is the last rule of override "${name}". Run \`typeclaw model override remove ${name}\` to delete the override.`,
      }
    }
    const match = existing.match.filter((r) => r !== rule)
    return writeOverride(cwd, name, { ...existing, match }, `model: unmatch ${rule} in override ${name}`)
  })
}

export function removeOverride(cwd: string, name: string): ModelMutationResult {
  return underConfigLock(cwd, () => removeOverrideInLock(cwd, name))
}

function removeOverrideInLock(cwd: string, name: string): ConfigWrite {
  if (readOverridesRaw(cwd)[name] === undefined) {
    return { ok: false, reason: `Override "${name}" not found in ${CONFIG_FILE}.` }
  }
  return writeConfig(
    cwd,
    (parsed) => {
      const overrides = { ...(isObjectRecord(parsed.modelOverrides) ? parsed.modelOverrides : {}) }
      delete overrides[name]
      parsed.modelOverrides = overrides
    },
    `model: remove override ${name}`,
  )
}

type RawOverride = { match: string[]; models: RawModels }

function writeOverride(
  cwd: string,
  name: string,
  override: RawOverride,
  commitMessage: string,
  customModel?: { ref: ModelRef; meta: CustomModelMeta },
): ConfigWrite {
  return writeConfig(
    cwd,
    (parsed) => {
      const overrides = isObjectRecord(parsed.modelOverrides) ? parsed.modelOverrides : {}
      parsed.modelOverrides = { ...overrides, [name]: override }
    },
    commitMessage,
    customModel,
  )
}

// On-disk `modelOverrides` so writers preserve hand-authored profile shapes.
function readOverridesRaw(cwd: string): Record<string, RawOverride> {
  try {
    const parsed = JSON.parse(readFileSync(join(cwd, CONFIG_FILE), 'utf8')) as {
      modelOverrides?: Record<string, RawOverride>
    }
    return parsed.modelOverrides ?? {}
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// The on-disk shape of a single `models.<profile>` value: a bare ref string, a
// fallback-chain array, or a rich object carrying a per-profile thinkingLevel.
// Mutators read-modify-write this shape so they preserve whichever form the
// user hand-authored (and the sibling field they aren't touching).
type RawProfileValue = string | string[] | { model?: string; models?: string | string[]; thinkingLevel?: ThinkingLevel }
type RawModels = Record<string, RawProfileValue>

function rawProfileRefs(value: RawProfileValue | undefined): string | string[] | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string' || Array.isArray(value)) return value
  return value.models ?? value.model
}

function rawProfileThinkingLevel(value: RawProfileValue | undefined): ThinkingLevel | undefined {
  return value !== undefined && typeof value === 'object' && !Array.isArray(value) ? value.thinkingLevel : undefined
}

// Re-attaches a thinkingLevel to a ref/chain, collapsing back to the bare
// string/array form when there's no level so configs stay minimal.
function withRawProfileThinkingLevel(refs: string | string[], level: ThinkingLevel | undefined): RawProfileValue {
  return level === undefined ? refs : { models: refs, thinkingLevel: level }
}

// Returns the raw `models` block from disk in its on-disk shape. Writers
// preserve whichever shape was already present for profiles they don't touch —
// converting a hand-authored fallback chain back to a single string, or
// dropping a per-profile thinkingLevel, would silently lose user intent.
function readModelsRaw(cwd: string): RawModels | null {
  try {
    const raw = readFileSync(join(cwd, CONFIG_FILE), 'utf8')
    const parsed = JSON.parse(raw) as { models?: RawModels }
    return parsed.models ?? null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function hasUsableCredential(cwd: string, providerId: KnownProviderId, env: NodeJS.ProcessEnv): boolean {
  const provider = KNOWN_PROVIDERS[providerId]
  if (provider.apiKeyEnv !== null) {
    const fromEnv = env[provider.apiKeyEnv]
    if (fromEnv !== undefined && fromEnv !== '') return true
  }
  return isProviderConfigured(cwd, providerId)
}
