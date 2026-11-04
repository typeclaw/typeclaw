import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { isTypevaultMarker, readEnvelopeTextSync } from '@/typevault/envelope-store'

import { channelFieldDefaultEnv } from './defaults'
import { resolveSecret, secretFieldSchema, type Secret } from './resolve'
import { parseSecretsFile } from './schema'

// hydrateChannelEnvFromSecrets is the seam that lets channel adapters keep
// reading `process.env[TOKEN_ENV]` (in `src/channels/manager.ts`) without
// knowing about the new per-adapter Secret-typed config shape. Boot flow:
//
//   1. Read secrets.json#channels. Each field is a Secret (string shorthand
//      or `{ value?, env? }` object).
//   2. For each (adapter, field) pair, look up the default env-var name via
//      CHANNEL_FIELD_ENV (e.g. slack-bot.botToken -> SLACK_BOT_TOKEN).
//   3. Resolve the Secret via env-wins: if the target env var is already
//      set, do nothing (env wins, intentional, by design). Otherwise inject
//      the resolved file value into process.env under the default env name.
//
// Three explicit non-behaviors versus the pre-v2 implementation:
//   - We DO NOT strip `.env` after injecting. Env values stay in `.env`; the
//     boot-time file mutation that previously erased migrated keys is gone.
//     The user's `.env` is treated as a first-class source, not a one-way
//     migration channel.
//   - We DO NOT promote env values into secrets.json. The old
//     `promoteChannelEnvIntoSecrets` step has been deleted as part of the
//     env-wins reshape. If the user wants the value in the file, they put it
//     there explicitly (init writes it, or a manual edit).
//   - We DO NOT touch unknown adapter ids (no entry in CHANNEL_FIELD_ENV)
//     or unknown field names. Skipped silently. A future plugin adapter
//     would need its own injection mechanism; the field-name-keyed shape is
//     reserved for the curated set in CHANNEL_FIELD_ENV.
//
// Errors are non-fatal: a missing or malformed `secrets.json` returns an
// empty result rather than throwing, so an agent that hasn't run init yet
// can still boot.
export function hydrateChannelEnvFromSecrets(options: { agentDir: string; env?: NodeJS.ProcessEnv }): {
  applied: string[]
  skipped: string[]
} {
  const env = options.env ?? process.env
  const secretsPath = join(options.agentDir, 'secrets.json')
  const channels = readChannelSecrets(secretsPath)

  const applied: string[] = []
  const skipped: string[] = []

  for (const [adapterId, fields] of Object.entries(channels)) {
    for (const [fieldName, secret] of Object.entries(fields)) {
      const envName = channelFieldDefaultEnv(adapterId, fieldName)
      if (envName === undefined) continue

      const existing = env[envName]
      if (existing !== undefined && existing !== '') {
        skipped.push(envName)
        continue
      }

      const resolved = resolveSecret(secret, envName, env)
      if (resolved === undefined) continue

      env[envName] = resolved
      applied.push(envName)
    }
  }

  return { applied, skipped }
}

function readChannelSecrets(secretsPath: string): Record<string, Record<string, Secret>> {
  let raw: string
  try {
    raw = readFileSync(secretsPath, 'utf8')
    if (isTypevaultMarker(raw)) raw = readEnvelopeTextSync(dirname(secretsPath))
  } catch {
    return {}
  }
  if (raw.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  const result = parseSecretsFile(parsed)
  if (!result.ok) return {}

  const out: Record<string, Record<string, Secret>> = {}
  for (const [adapterId, slot] of Object.entries(result.file.channels)) {
    if (typeof slot !== 'object' || slot === null || Array.isArray(slot)) continue
    const slotRecord = slot as Record<string, unknown>
    const fields: Record<string, Secret> = {}
    for (const [fieldName, value] of Object.entries(slotRecord)) {
      const ok = secretFieldSchema.safeParse(value)
      if (ok.success) fields[fieldName] = ok.data
    }
    if (Object.keys(fields).length > 0) out[adapterId] = fields
  }
  return out
}
