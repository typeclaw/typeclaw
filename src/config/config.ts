import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Model } from '@mariozechner/pi-ai'
import { CronExpressionParser } from 'cron-parser'
import { z } from 'zod'

import { KNOWN_PROVIDERS, listKnownModelRefs, type KnownModelRef, type KnownProviderId } from './providers'

const CONFIG_FILE = 'typeclaw.json'

const knownModelRefs = listKnownModelRefs() as [KnownModelRef, ...KnownModelRef[]]

// T9 keypad: T=8, Y=9, P=7, E=3
const DEFAULT_PORT = 8973
const DEFAULT_MEMORY_IDLE_MS = 30_000
// 4 AM: late enough that the previous day's session activity has settled,
// early enough that the consolidation is ready before the user's morning.
const DEFAULT_DREAMING_SCHEDULE = '0 4 * * *'

// Mount names land on disk as `mounts/<name>` inside the agent folder, so they
// share a namespace with regular filenames. Restricting to lowercase
// alphanumerics + `-`/`_` keeps them shell-safe and avoids accidental shadowing
// of files like `mounts/.git` or `mounts/Hello`.
const MOUNT_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]*$/

export const mountSchema = z.object({
  name: z.string().regex(MOUNT_NAME_PATTERN, 'mount name must be lowercase alphanumeric with - or _'),
  path: z.string().min(1),
  readOnly: z.boolean().default(false),
  description: z.string().optional(),
})

export type Mount = z.infer<typeof mountSchema>

const dreamingSchema = z
  .object({
    schedule: z
      .string()
      .min(1)
      .default(DEFAULT_DREAMING_SCHEDULE)
      .refine(isValidCronExpression, { message: 'memory.dreaming.schedule must be a valid cron expression' }),
  })
  .default({ schedule: DEFAULT_DREAMING_SCHEDULE })

export const pluginEntrySchema = z.union([
  z.string().min(1),
  z.tuple([z.string().min(1), z.unknown()]),
  z.object({ source: z.string().min(1), options: z.unknown().optional() }),
])

export type PluginEntry = z.infer<typeof pluginEntrySchema>

export const configSchema = z.object({
  $schema: z.string().optional(),
  port: z.number().int().min(1).max(65535).default(DEFAULT_PORT),
  model: z.enum(knownModelRefs).default('fireworks/accounts/fireworks/routers/kimi-k2p6-turbo'), // FIXME: TEMP default
  memory: z
    .object({
      idleMs: z.number().int().min(1000).default(DEFAULT_MEMORY_IDLE_MS),
      dreaming: dreamingSchema.optional(),
    })
    .default({ idleMs: DEFAULT_MEMORY_IDLE_MS }),
  // Defaults to `[]` so configs predating the field still load. `typeclaw init`
  // writes `"mounts": []` explicitly, but a missing field is treated the same
  // way (no host paths exposed) rather than failing the whole config load.
  mounts: z.array(mountSchema).default([]),
  plugins: z.array(pluginEntrySchema).default([]),
})

function isValidCronExpression(schedule: string): boolean {
  try {
    CronExpressionParser.parse(schedule).next()
    return true
  } catch {
    return false
  }
}

export type Config = z.infer<typeof configSchema>

export function resolveModel(ref: KnownModelRef): Model<'openai-completions'> {
  // Model IDs can contain '/', so split only on the first separator.
  const slash = ref.indexOf('/')
  const providerId = ref.slice(0, slash) as KnownProviderId
  const modelId = ref.slice(slash + 1)
  return KNOWN_PROVIDERS[providerId].models[modelId as never]
}

// Loaded eagerly from process.cwd()/typeclaw.json at module-import time so
// citty arg defaults (e.g. config.port in src/cli/*.ts) see real values, not
// hardcoded fallbacks. Missing file → schema defaults; malformed file → throw,
// which surfaces during CLI startup instead of silently reverting to defaults
// and confusing the user.
//
// `config` is a module-import-time snapshot. Container-stage code that must
// observe `typeclaw run` reloads should call `getConfig()` instead, which
// returns the current swapped-in value. Host-stage CLI processes are
// short-lived, so they keep using `config` directly.
export const config: Config = loadConfigSync(process.cwd())

let current: Config = config

export function getConfig(): Config {
  return current
}

// Test-only: restore the live pointer to the module-import-time snapshot. Lets
// reload-aware tests run without leaking a swapped pointer into other test
// files that still mutate the eager `config` export directly.
export function __resetConfigForTesting(): void {
  current = config
}

export type ConfigChange = {
  path: string
  before: unknown
  after: unknown
}

export type ConfigReloadDiff = {
  applied: ConfigChange[]
  restartRequired: ConfigChange[]
  ignored: ConfigChange[]
}

// Reloads typeclaw.json from disk and atomically swaps the live config pointer
// on success. Throws (and leaves `current` untouched) when the file is
// malformed or schema-invalid — callers translate that into a `Reloadable`
// failure result.
export function reloadConfig(cwd: string): ConfigReloadDiff {
  const next = loadConfigSync(cwd)
  const diff = diffConfig(current, next)
  current = next
  return diff
}

// Field classification. The fence is intentional: only fields that are read
// fresh on each session/subagent/cron-reload land in `applied`. Boot-only
// fields (port, mounts, container/server bind) are reported as
// `restartRequired` so the user knows the reload landed but the change won't
// take effect until restart.
export type FieldEffect = 'applied' | 'restart-required' | 'ignored'

export const FIELD_EFFECTS: Record<string, FieldEffect> = {
  $schema: 'ignored',
  model: 'applied',
  port: 'restart-required',
  mounts: 'restart-required',
  'memory.idleMs': 'restart-required',
  'memory.dreaming': 'applied',
  plugins: 'restart-required',
}

// Stable JSON for value comparison. Fields are small JSON-shaped objects, so
// JSON.stringify with sorted keys is sufficient and avoids a deep-equal dep.
function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined'
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k]
      }
      return sorted
    }
    return v
  })
}

function diffConfig(before: Config, after: Config): ConfigReloadDiff {
  const diff: ConfigReloadDiff = { applied: [], restartRequired: [], ignored: [] }
  const keys = new Set<string>([...Object.keys(FIELD_EFFECTS)])

  for (const path of keys) {
    const b = readPath(before, path)
    const a = readPath(after, path)
    if (stableStringify(b) === stableStringify(a)) continue

    const change: ConfigChange = { path, before: b, after: a }
    const effect = FIELD_EFFECTS[path] ?? 'applied'
    if (effect === 'applied') diff.applied.push(change)
    else if (effect === 'restart-required') diff.restartRequired.push(change)
    else diff.ignored.push(change)
  }

  return diff
}

function readPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

export function loadConfigSync(cwd: string): Config {
  let raw: string
  try {
    raw = readFileSync(join(cwd, CONFIG_FILE), 'utf8')
  } catch {
    return configSchema.parse({})
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${detail}`)
  }

  const result = configSchema.safeParse(json)
  if (!result.success) {
    throw new Error(`${CONFIG_FILE} is invalid: ${formatZodError(result.error)}`)
  }
  return result.data
}

export type ValidateConfigResult = { ok: true } | { ok: false; reason: string }

// Missing file → ok (matches `loadMounts` in src/container/up.ts; `isInitialized`
// is the dedicated check for "not initialized"). Present but invalid → fail, so
// `restart` doesn't stop the container before discovering the config is broken.
export function validateConfig(cwd: string): ValidateConfigResult {
  let raw: string
  try {
    raw = readFileSync(join(cwd, CONFIG_FILE), 'utf8')
  } catch {
    return { ok: true }
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `${CONFIG_FILE} is not valid JSON: ${detail}` }
  }

  const result = configSchema.safeParse(json)
  if (!result.success) {
    return { ok: false, reason: `${CONFIG_FILE} is invalid: ${formatZodError(result.error)}` }
  }

  return { ok: true }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>'
      return `${path}: ${issue.message}`
    })
    .join('; ')
}
