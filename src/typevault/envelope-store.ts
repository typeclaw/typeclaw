import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { typevaultDir } from './vault'

// secrets.json while the envelope lives in the vault. Its `version` is not 2,
// so a TypeClaw build without vault support refuses the file loudly instead of
// booting with an empty credential store.
export const TYPEVAULT_SECRETS_MARKER = {
  $comment:
    'TypeClaw keeps this agent\'s secrets in its TypeVault vault (.typevault/). Set typevault.enabled to false in typeclaw.json and run "typeclaw restart" to restore this file.',
  version: 'typevault',
} as const

export function typevaultMarkerText(): string {
  return `${JSON.stringify(TYPEVAULT_SECRETS_MARKER, null, 2)}\n`
}

export function isTypevaultMarker(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw)
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { version?: unknown }).version === TYPEVAULT_SECRETS_MARKER.version
    )
  } catch {
    return false
  }
}

export function isTypevaultMarkerFile(secretsPath: string): boolean {
  return existsSync(secretsPath) && isTypevaultMarker(readFileSync(secretsPath, 'utf8'))
}

type CachedEnvelope = { text: string; stamp: string }

const cache = new Map<string, CachedEnvelope>()

// SecretsBackend's contract is synchronous, while typevault's SDK is async, so
// reads and writes cross into a short-lived helper process. Reads are cached
// per agent and refetched only when the vault's entries changed, which also
// picks up writes made by another process. Reads are lock-free, so a snapshot
// is cached only when no write landed while it was being fetched; otherwise an
// old envelope could be labelled with a newer write's stamp and later
// overwrite that write.
export function readEnvelopeTextSync(
  agentDir: string,
  fetch: (agentDir: string) => string = (dir) => runHelperSync(dir, 'read'),
): string {
  const before = entriesStamp(agentDir)
  const cached = cache.get(agentDir)
  if (cached !== undefined && cached.stamp === before) return cached.text
  const text = fetch(agentDir)
  if (entriesStamp(agentDir) === before) cache.set(agentDir, { text, stamp: before })
  else cache.delete(agentDir)
  return text
}

export function writeEnvelopeTextSync(agentDir: string, text: string): void {
  cache.delete(agentDir)
  runHelperSync(agentDir, 'write', text)
  cache.set(agentDir, { text, stamp: entriesStamp(agentDir) })
}

// Every entry file's name, size and mtime, not just the directory's mtime, so
// a rewrite within one coarse directory timestamp still changes the stamp.
export function entriesStamp(agentDir: string): string {
  const entries = join(typevaultDir(agentDir), 'entries')
  if (!existsSync(entries)) return 'absent'
  return readdirSync(entries)
    .sort()
    .map((name) => {
      const stat = statSync(join(entries, name), { throwIfNoEntry: false })
      return stat === undefined ? `${name}:gone` : `${name}:${stat.size}:${stat.mtimeMs}:${stat.ino}`
    })
    .join('|')
}

// A synchronous spawn cannot be interrupted from JavaScript, so a helper that
// never exits would block the caller's thread for good.
const HELPER_TIMEOUT_MS = 30_000

export function runHelperSync(agentDir: string, op: 'read' | 'write', input?: string): string {
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, 'envelope-helper.ts'), op, agentDir], {
    stdin: input === undefined ? 'ignore' : Buffer.from(input, 'utf8'),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: HELPER_TIMEOUT_MS,
  })
  if (result.exitCode !== 0) {
    const reason = result.exitedDueToTimeout
      ? `timed out after ${HELPER_TIMEOUT_MS}ms`
      : result.stderr.toString().trim() || `exit code ${result.exitCode}`
    throw new Error(`TypeVault ${op} of the secrets envelope failed: ${reason}`)
  }
  return result.stdout.toString()
}
