import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import lockfile from 'proper-lockfile'

import { parseSecretsFile, SECRETS_FILE_VERSION } from '@/secrets/schema'
import { isTypevaultMarker } from '@/typevault/envelope-store'

// PR #638 removed the in-memory v1->v2 upgrade that `parseSecretsFile` used to
// perform, so a `secrets.json` still in v1 now fails to parse:
// `hydrateChannelEnvFromSecrets` swallows the failure as `{}`, no token env vars
// are injected, and channel adapters (Discord, Slack, Telegram) never connect.
// This is the one-shot on-disk replacement, run once at boot rather than on
// every parse, so the v2-only runtime keeps working without a read-time shim.

const SCHEMA_REL = './node_modules/typeclaw/secrets.schema.json'
const FILE_MODE = 0o600

const LEGACY_FILENAME = 'auth.json'
const TARGET_FILENAME = 'secrets.json'

// Frozen, migration-local reverse map (env-var name -> { adapterId, field }).
// Intentionally a private copy rather than an inversion of
// `CHANNEL_FIELD_ENV` in src/secrets/defaults.ts: re-importing live runtime
// defaults would (a) re-couple current code to deleted legacy surface area,
// and (b) let a future change to the runtime env-var names silently rewrite
// the semantics of this historical migration. A v1 file written years ago must
// migrate the same way regardless of what the live adapters key off today.
const LEGACY_CHANNEL_ENV_TO_FIELD: Record<string, { adapterId: string; field: string }> = {
  DISCORD_BOT_TOKEN: { adapterId: 'discord-bot', field: 'token' },
  SLACK_BOT_TOKEN: { adapterId: 'slack-bot', field: 'botToken' },
  SLACK_APP_TOKEN: { adapterId: 'slack-bot', field: 'appToken' },
  TELEGRAM_BOT_TOKEN: { adapterId: 'telegram-bot', field: 'token' },
}

export const MIGRATION_ID = '0001-secrets-v1-to-v2'

export type SecretsMigrationResult = { changed: boolean; summary: string }

// Idempotent: a folder already at v2 (or with no legacy file) returns
// `changed: false`. Errors that indicate ambiguous/unsafe state throw with an
// actionable message rather than guessing.
//
// Concurrency: secrets.json is the lock resource SecretsBackend (provider add,
// OAuth refresh, channel add) and credential exporters use, so we hold ITS lock
// across the entire precedence resolution AND upgrade. The lock requires the
// file to exist, so when only auth.json is present we first seed secrets.json
// with exclusive create-if-absent semantics (never overwriting a file a
// concurrent writer may have just written), then lock, then re-read precedence
// from fresh on-disk state under the lock.
export function migrateSecretsV1ToV2(agentDir: string): SecretsMigrationResult {
  const legacyPath = join(agentDir, LEGACY_FILENAME)
  const targetPath = join(agentDir, TARGET_FILENAME)

  if (!existsSync(legacyPath) && !existsSync(targetPath)) {
    return { changed: false, summary: 'no secrets file to migrate' }
  }

  seedTargetIfAbsent(targetPath)

  return withFileLock(targetPath, () => {
    resolvePrecedenceUnderLock(legacyPath, targetPath)
    return upgradeFileInPlace(targetPath)
  })
}

// Creates an empty v2 envelope at secrets.json only if it does not already
// exist, using exclusive create ('wx') so a concurrent writer that wrote real
// credentials between our existsSync check and here is never clobbered — the
// EEXIST is swallowed because the file we need to lock now exists, which is all
// we required. A freshly-seeded empty envelope is indistinguishable from "no
// target" to resolvePrecedenceUnderLock (isEmptyEnvelope returns true), so
// "only auth.json" collapses into the "secrets.json empty -> auth wins" branch.
function seedTargetIfAbsent(targetPath: string): void {
  if (existsSync(targetPath)) return
  try {
    writeFileSync(targetPath, stringifyEmptyEnvelope(), { encoding: 'utf8', mode: FILE_MODE, flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
}

// auth.json precedence, run ENTIRELY under the secrets.json lock so the read,
// the rename/unlink decision, and the rename itself can't interleave with a
// concurrent secrets.json writer. Preserves the deleted migrateLegacyAuthJson
// semantics so no credential is ever silently dropped:
//   - no auth.json              -> operate on secrets.json as-is
//   - droppable auth.json       -> unlink auth.json, operate on secrets.json
//   - secrets.json empty seed   -> auth.json wins (rename over the empty seed)
//   - both non-empty            -> hard error (can't pick a source of truth)
function resolvePrecedenceUnderLock(legacyPath: string, targetPath: string): void {
  if (!existsSync(legacyPath)) return

  if (isDroppableLegacyFile(legacyPath)) {
    unlinkSync(legacyPath)
    return
  }

  if (isEmptyEnvelope(targetPath)) {
    renameWithRaceFallback(legacyPath, targetPath)
    chmodSync(targetPath, FILE_MODE)
    return
  }

  throw new Error(
    `Both ${LEGACY_FILENAME} and a non-empty ${TARGET_FILENAME} exist in the agent folder. ` +
      `Inspect manually and remove the stale file before re-running.`,
  )
}

function upgradeFileInPlace(path: string): SecretsMigrationResult {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { changed: false, summary: 'secrets file unreadable; skipped' }
  }
  if (raw.trim() === '') return { changed: false, summary: 'secrets file empty; skipped' }
  if (isTypevaultMarker(raw)) return { changed: false, summary: 'secrets kept in TypeVault; skipped' }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`secrets file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Already current: parseSecretsFile only accepts v2 post-#638, so a successful
  // parse means there is nothing to do.
  if (parseSecretsFile(parsed).ok) return { changed: false, summary: 'already v2; no change' }

  const upgraded = upgradeToV2(parsed)
  if (upgraded === null) {
    throw new Error(
      'secrets file is neither a valid v2 envelope nor a recognized legacy (v1 / pre-envelope) shape; ' +
        'leaving it untouched for manual inspection',
    )
  }

  // Re-validate the product of our own transform before persisting. A transform
  // that emitted an invalid v2 file would brick the next read; failing here is
  // strictly safer than writing garbage.
  const check = parseSecretsFile(upgraded)
  if (!check.ok) {
    throw new Error(`internal: migrated secrets file failed v2 validation: ${check.reason}`)
  }

  writeEnvelopeAtomic(path, check.file)
  return { changed: true, summary: `upgraded secrets file to v${SECRETS_FILE_VERSION}` }
}

// Recognizes the two pre-v2 shapes the deleted parseSecretsFile branches used
// to accept and returns a v2-shaped object. Returns null when the input matches
// neither (caller turns that into a loud, no-write error).
//
//   v1 envelope:      { version: 1, llm: {...}, channels: { adapter: { ENV: value } } }
//   pre-envelope flat: { providerId: { type, key } } at the top level
function upgradeToV2(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>

  if (obj.version === 1) {
    return upgradeV1Envelope(obj)
  }

  if (looksLikeFlatProviders(obj)) {
    return upgradeV1Envelope({ version: 1, llm: obj, channels: {} })
  }

  return null
}

function upgradeV1Envelope(obj: Record<string, unknown>): Record<string, unknown> {
  const llm = isPlainObject(obj.llm) ? obj.llm : {}
  const legacyChannels = isPlainObject(obj.channels) ? obj.channels : {}

  const providers: Record<string, unknown> = {}
  for (const [providerId, cred] of Object.entries(llm)) {
    if (!isPlainObject(cred)) continue
    if (cred.type === 'api_key' && typeof cred.key === 'string') {
      providers[providerId] = { type: 'api_key', key: { value: cred.key } }
    } else {
      // OAuth and any unknown credential type pass through verbatim — they are
      // not env-injectable and the v2 schema accepts them via catchall.
      providers[providerId] = cred
    }
  }

  const channels: Record<string, Record<string, unknown>> = {}
  for (const [adapterId, slot] of Object.entries(legacyChannels)) {
    if (!isPlainObject(slot)) continue
    const upgradedSlot: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(slot)) {
      if (typeof value !== 'string') {
        // A non-string value means this isn't the flat env-keyed v1 channel
        // shape (e.g. a kakaotalk block, which is structured). Preserve it
        // verbatim so the catchall keeps it valid; do not try to reshape.
        upgradedSlot[key] = value
        continue
      }
      const mapping = LEGACY_CHANNEL_ENV_TO_FIELD[key]
      if (mapping && mapping.adapterId === adapterId) {
        upgradedSlot[mapping.field] = { value }
      } else {
        // Unknown env-var key on a known adapter, or an unknown adapter:
        // preserve under the original key but still wrap as a v2 Secret so the
        // resulting file is valid v2.
        upgradedSlot[key] = { value }
      }
    }
    channels[adapterId] = upgradedSlot
  }

  const result: Record<string, unknown> = {
    $schema: typeof obj.$schema === 'string' ? obj.$schema : SCHEMA_REL,
    version: SECRETS_FILE_VERSION,
    providers,
    channels,
  }
  return result
}

// A flat pre-envelope file is a top-level record of provider credentials. Every
// value must be a credential object with a `type` field; anything else means we
// don't recognize the shape and should not guess.
function looksLikeFlatProviders(obj: Record<string, unknown>): boolean {
  const entries = Object.entries(obj).filter(([k]) => k !== '$schema')
  if (entries.length === 0) return false
  return entries.every(([, value]) => isPlainObject(value) && typeof value.type === 'string')
}

function isEmptyEnvelope(path: string): boolean {
  const parsed = readJsonOrNull(path)
  if (parsed === undefined) return true
  if (parsed === null) return false
  const result = parseSecretsFile(parsed)
  if (!result.ok) return false
  return Object.keys(result.file.providers).length === 0 && Object.keys(result.file.channels).length === 0
}

// True only when a legacy auth.json carries nothing worth keeping, so dropping
// it in favor of an existing secrets.json is safe: a missing/blank file, or a
// valid-but-empty v2 envelope. Anything else parseable — a legacy shape with
// credentials OR a parseable-but-unrecognized object — returns false so
// resolveLegacyFilename falls through to the both-non-empty hard error rather
// than silently deleting a file whose contents we can't account for.
function isDroppableLegacyFile(path: string): boolean {
  const parsed = readJsonOrNull(path)
  if (parsed === undefined) return true
  if (parsed === null) return false
  const v2 = parseSecretsFile(parsed)
  if (!v2.ok) return false
  return Object.keys(v2.file.providers).length === 0 && Object.keys(v2.file.channels).length === 0
}

// undefined = file missing/blank (treat as empty); null = present but invalid
// JSON (treat as "has content we can't safely drop").
function readJsonOrNull(path: string): unknown {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  if (raw.trim() === '') return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function stringifyEmptyEnvelope(): string {
  return `${JSON.stringify({ $schema: SCHEMA_REL, version: SECRETS_FILE_VERSION, providers: {}, channels: {} }, null, 2)}\n`
}

function writeEnvelopeAtomic(path: string, envelope: unknown): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: 'utf8', mode: FILE_MODE })
  try {
    renameSync(tmp, path)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // best-effort cleanup of the temp file when rename fails
    }
    throw err
  }
  chmodSync(path, FILE_MODE)
}

// renameSync is atomic per syscall, but two concurrent migration runs can both
// observe auth.json exists and secrets.json does not, then race on the rename.
// One wins; the loser gets ENOENT because the source is already gone — that is
// a successful migration from its POV, so recheck the target and swallow it.
function renameWithRaceFallback(from: string, to: string): void {
  try {
    renameSync(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' && existsSync(to)) return
    throw err
  }
}

// Mirror SecretsBackend's lock discipline so a concurrent credential write
// (provider add, OAuth refresh, channel add) can't interleave with the
// read-transform-write. proper-lockfile needs the target to exist; the target
// always exists by the time we lock (resolveLegacyFilename guarantees it).
function withFileLock<T>(path: string, fn: () => T): T {
  let release: (() => void) | undefined
  try {
    release = acquireSyncLockWithRetry(path)
    return fn()
  } finally {
    release?.()
  }
}

const SYNC_LOCK_RETRIES = 10
const SYNC_LOCK_DELAY_MS = 20

function acquireSyncLockWithRetry(path: string): () => void {
  let lastError: unknown
  for (let attempt = 1; attempt <= SYNC_LOCK_RETRIES; attempt++) {
    try {
      return lockfile.lockSync(path, { realpath: false })
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code: unknown }).code)
          : undefined
      if (code !== 'ELOCKED' || attempt === SYNC_LOCK_RETRIES) throw error
      lastError = error
      const start = Date.now()
      while (Date.now() - start < SYNC_LOCK_DELAY_MS) {
        // intentionally empty: synchronous busy-wait to match SecretsBackend
      }
    }
  }
  throw (lastError as Error | undefined) ?? new Error('Failed to acquire secrets store lock')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
