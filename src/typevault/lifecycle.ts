import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import lockfile from 'proper-lockfile'

import { parseSecretsFile } from '@/secrets/schema'
import { ASYNC_LOCK_OPTIONS } from '@/secrets/storage'

import { isTypevaultMarker, typevaultMarkerText } from './envelope-store'
import { provisionVault, readSecretsEntry, requireSecretsEntry, vaultExists, writeSecretsEntry } from './vault'

export type TypevaultReconcileResult =
  | { action: 'unchanged' }
  | { action: 'enabled' }
  | { action: 'resumed' }
  | { action: 'restored' }
  | { action: 'skipped'; warning: string }

// Runs host-side in `typeclaw start` while the container is down, so it is
// the only writer. Whichever side was live before the toggle wins: enabling
// moves secrets.json into the vault (overwriting a dormant vault's stale copy),
// disabling writes the vault's copy back. A dormant vault is resumed, never
// re-initialized, so entries stored through the vault survive the round trip.
export async function reconcileTypevault(agentDir: string, enabled: boolean): Promise<TypevaultReconcileResult> {
  const secretsPath = join(agentDir, 'secrets.json')
  // The common case (never enabled) must not even take the lock: start runs
  // this on every launch, including agent folders it cannot write to.
  if (!enabled && !isMarkerFile(secretsPath)) return { action: 'unchanged' }
  const release = await lockfile.lock(secretsPath, ASYNC_LOCK_OPTIONS)
  try {
    return enabled ? await enable(agentDir, secretsPath) : await disable(agentDir, secretsPath)
  } finally {
    await release()
  }
}

async function enable(agentDir: string, secretsPath: string): Promise<TypevaultReconcileResult> {
  const raw = existsSync(secretsPath) ? readFileSync(secretsPath, 'utf8') : ''
  const markerPresent = isTypevaultMarker(raw)
  const resuming = vaultExists(agentDir)

  // Already enabled: the vault holds the only copy, so it is checked, never
  // provisioned. Provisioning could replace keys the ciphertext still needs.
  if (markerPresent) {
    try {
      await requireSecretsEntry(agentDir)
      return { action: 'unchanged' }
    } catch (error) {
      return skipped(
        `secrets.json points at the TypeVault vault, but its secrets cannot be read: ${describe(error)}. ` +
          'Nothing was changed. Restore .typevault/ and .typeclaw/typevault/ from a backup of this agent folder.',
      )
    }
  }

  try {
    await provisionVault(agentDir)
    await readSecretsEntry(agentDir)
  } catch (error) {
    return skipped(
      `${resuming ? "The agent's TypeVault vault (.typevault/) could not be opened" : 'Could not create the TypeVault vault'}: ${describe(error)}. ` +
        'Keeping secrets.json as the credential store. If the vault came from another copy of this agent without its key, move .typevault/ aside and restart.',
    )
  }

  const invalid = invalidEnvelope(raw)
  if (invalid !== null) {
    return skipped(
      `secrets.json is not a valid TypeClaw secrets file (${invalid}); fix it, then restart to move it into TypeVault.`,
    )
  }
  await writeSecretsEntry(agentDir, raw)
  if ((await requireSecretsEntry(agentDir)) !== raw) {
    return skipped(
      'The secrets copied into TypeVault did not read back identically; keeping secrets.json as the credential store.',
    )
  }
  writeAtomic(secretsPath, typevaultMarkerText())
  return { action: resuming ? 'resumed' : 'enabled' }
}

async function disable(agentDir: string, secretsPath: string): Promise<TypevaultReconcileResult> {
  if (!isMarkerFile(secretsPath)) return { action: 'unchanged' }
  let text: string
  try {
    text = await requireSecretsEntry(agentDir)
  } catch (error) {
    return skipped(
      `Could not read the secrets back out of TypeVault to restore secrets.json: ${describe(error)}. The agent keeps using the vault until this is fixed.`,
    )
  }
  writeAtomic(secretsPath, text)
  return { action: 'restored' }
}

function isMarkerFile(secretsPath: string): boolean {
  return existsSync(secretsPath) && isTypevaultMarker(readFileSync(secretsPath, 'utf8'))
}

function invalidEnvelope(raw: string): string | null {
  if (!raw.trim()) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return `not valid JSON: ${describe(error)}`
  }
  const result = parseSecretsFile(parsed)
  return result.ok ? null : result.reason
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.typevault.tmp`
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
}

function skipped(warning: string): TypevaultReconcileResult {
  return { action: 'skipped', warning }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
