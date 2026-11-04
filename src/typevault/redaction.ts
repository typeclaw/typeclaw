import { entriesStamp } from './envelope-store'
import { openVault, RUNTIME_TIER } from './vault'

const READ_REASON = 'redact tool output'

const cache = new Map<string, { stamp: string; values: readonly string[] }>()
// Every value ever seen, per agent, for the life of the process (which outlives
// every session in it): a secret that was overwritten or deleted can still sit
// in a log or artifact, so it stays redacted.
const observed = new Map<string, Set<string>>()

// Every secret value stored in the vault outside the runtime tier, read with
// the agent's own key. Redacting by what the vault holds, rather than by what
// a grant reports it handed out, covers derived grants, a bash command still
// running when another tool finishes, and grants that expired or were revoked
// before their history could be read. Public `text` fields are left alone.
// Cached until the vault's entries change.
export async function vaultSecretValues(agentDir: string): Promise<readonly string[]> {
  const stamp = entriesStamp(agentDir)
  const cached = cache.get(agentDir)
  if (cached !== undefined && cached.stamp === stamp) return cached.values
  const vault = await openVault(agentDir)
  const values = observed.get(agentDir) ?? new Set<string>()
  observed.set(agentDir, values)
  for (const summary of await vault.list()) {
    if (summary.tier === RUNTIME_TIER) continue
    const entry = await vault.get(summary.name, READ_REASON)
    for (const field of Object.values(entry.fields)) {
      if (field.type === 'text') continue
      if (field.type === 'oauth') for (const part of Object.values(field.value)) values.add(part)
      else values.add(field.value)
    }
  }
  const snapshot = [...values]
  if (entriesStamp(agentDir) === stamp) cache.set(agentDir, { stamp, values: snapshot })
  return snapshot
}
