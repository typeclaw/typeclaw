import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export class SecretEnvRefsError extends Error {
  constructor(reason: string) {
    super(`could not read secrets.json for secret env-name withholding: ${reason}`)
    this.name = 'SecretEnvRefsError'
  }
}

// Every env var NAME a `secrets.json` Secret can resolve its value from. A Secret
// is `{ value?, env? }` and `resolveSecret` gives an explicit `env` name
// precedence, so a provider/channel credential can be sourced from an
// operator-chosen env var (e.g. providers.openai.key.env = "PRODUCTION"). Those
// names carry credential values and must be withheld from sandboxed bash even
// when declared in `.env`, yet they are absent from the static provider/channel
// tables. A conservative schema-agnostic walk collecting every string-valued
// `env` property is deliberate: over-withholding a non-secret name only removes
// it from bash, while missing one leaks a credential — so the walk favors the
// safe direction and is resilient to secrets.json schema changes.
export function collectSecretEnvRefs(agentDir: string): string[] {
  let raw: string
  try {
    raw = readFileSync(join(agentDir, 'secrets.json'), 'utf8')
  } catch (err) {
    // Absent file → no refs. Any OTHER read failure (permissions, IO) must FAIL
    // CLOSED: a secret name referenced by an unreadable secrets.json would
    // otherwise slip through and be inherited into bash.
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return []
    throw new SecretEnvRefsError(err instanceof Error ? err.message : String(err))
  }
  // Empty/whitespace-only file → no refs. A NON-empty malformed file fails
  // closed: silently returning [] would disable configured-secret withholding.
  if (raw.trim().length === 0) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new SecretEnvRefsError(err instanceof Error ? err.message : 'invalid JSON')
  }
  const out = new Set<string>()
  walk(parsed, out)
  return [...out]
}

function walk(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, out)
    return
  }
  if (node === null || typeof node !== 'object') return
  for (const [key, value] of Object.entries(node)) {
    if (key === 'env' && typeof value === 'string' && value.length > 0) out.add(value)
    else walk(value, out)
  }
}
