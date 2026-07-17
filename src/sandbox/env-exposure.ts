import { KNOWN_PROVIDERS } from '@/config/providers'
import { CHANNEL_FIELD_ENV } from '@/secrets/defaults'

import { DEFAULT_SANDBOX_ENV } from './policy'

// Names withheld from sandboxed bash even when declared in `.env`. `.env` is the
// operator's "expose to the agent" surface, but typeclaw's own secret names must
// never reach prompt-injectable bash: an operator rotating a key via `.env`
// (env-wins is supported) would otherwise hand OPENAI_API_KEY / GH_TOKEN /
// channel tokens to the model. Derived from the same source-of-truth tables the
// rest of the runtime uses, so a newly added provider/adapter is covered without
// editing this file.
function knownSecretEnvNames(): Set<string> {
  const names = new Set<string>(['GH_TOKEN', 'GITHUB_TOKEN'])
  for (const provider of Object.values(KNOWN_PROVIDERS)) {
    if (provider.apiKeyEnv) names.add(provider.apiKeyEnv)
  }
  for (const fields of Object.values(CHANNEL_FIELD_ENV)) {
    for (const envName of Object.values(fields)) names.add(envName)
  }
  return names
}

const KNOWN_SECRET_ENV_NAMES = knownSecretEnvNames()

// End-anchored secret-name backstop for names not in the known table (custom
// adapters, hand-named vars). Case-INSENSITIVE: `.env` names are operator text,
// so `my_token` / `session_cookie` must be caught as surely as `MY_TOKEN`. The
// suffix set covers the common credential/session material an operator might name
// by hand beyond the runtime's own tables.
const SECRET_ENV_NAME_PATTERN =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|PWD|API_?KEY|ACCESS_KEY(?:_ID)?|SECRET_KEY|PRIVATE_KEY|AUTH|CREDENTIALS?|COOKIE|SESSION|PASSPHRASE)$/i

// Single secret-name predicate shared by the .env exposure filter and the bash
// env-overlay transport chooser, so the two can never diverge (a name treated as
// non-secret by one and secret by the other would pick the wrong transport).
export function isSecretEnvName(name: string): boolean {
  return KNOWN_SECRET_ENV_NAMES.has(name) || SECRET_ENV_NAME_PATTERN.test(name)
}

// Process-hijack vectors: an inherited value here changes how the shell, loader,
// or a runtime interprets later commands (arbitrary code load, config override,
// credential-socket handoff). Never inherit these regardless of `.env` intent.
const EXECUTION_CONTROL_ENV_NAMES = new Set<string>([
  'BASH_ENV',
  'ENV',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'NODE_OPTIONS',
  'BUN_OPTIONS',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'RUBYOPT',
  'PERL5OPT',
  'SSH_AUTH_SOCK',
  'KUBECONFIG',
])

const EXECUTION_CONTROL_ENV_PREFIXES = ['GIT_CONFIG'] as const

// DEFAULT_SANDBOX_ENV names are sandbox-OWNED: build.ts renders them via
// --setenv, but an inherited name skips that --setenv (inherit keeps the parent
// value), so letting PATH/HOME/BUN_* pass through would let `.env` REPLACE the
// sandbox's safe fixed values — a PATH/loader hijack. Never expose them.
const RESERVED_SANDBOX_ENV_NAMES = new Set(Object.keys(DEFAULT_SANDBOX_ENV))

// EXACT curated allowlist of `.env` names that model-driven bash may read. This
// is an ALLOWLIST, not a denylist: `.env` is a documented credential store
// (secrets-policy.mdx — an operator may legitimately keep DATABASE_URL or a
// bearer token there), so exposing "everything that doesn't look secret" would
// widen the audience of existing credentials on upgrade. Only recognized,
// non-secret config POINTERS that supported integrations need at runtime are
// listed. No wildcards (`*_CONFIG_DIR`/`*_HOME` can point straight at a
// credential store), no value heuristics. Operators extend this per-agent via
// `sandbox.env.allow`; the secret/hijack deny rules still run afterward as
// defense in depth, and a pointer is exposed only when its target is masked
// (enforced by the caller).
const SAFE_CONFIG_POINTER_ENV_NAMES = new Set<string>([
  'AGENT_MESSENGER_CONFIG_DIR',
  'GWS_CONFIG_HOME',
  'OPENSOMA_CONFIG_DIR',
  'VIBE_NOTION_CONFIG_DIR',
])

function isWithheldEnvName(name: string, configuredSecretNames: ReadonlySet<string>): boolean {
  if (RESERVED_SANDBOX_ENV_NAMES.has(name)) return true
  if (configuredSecretNames.has(name)) return true
  if (name.startsWith('TYPECLAW_')) return true
  if (EXECUTION_CONTROL_ENV_NAMES.has(name)) return true
  if (EXECUTION_CONTROL_ENV_PREFIXES.some((prefix) => name === prefix || name.startsWith(`${prefix}_`))) return true
  return isSecretEnvName(name)
}

// The names an operator declared in `.env` that MAY be inherited into sandboxed
// bash: declared in `.env`, present in the container env with a non-empty value,
// on the safe-pointer allowlist (built-in ∪ operator `sandbox.env.allow`), and
// NOT caught by the unconditional secret/hijack deny rules (defense in depth,
// so an operator can't `allow` a name that also matches a secret pattern).
// Candidates come from the `.env` FILE, never all of `process.env` —
// `hydrateChannelEnvFromSecrets` injects secrets.json tokens into `process.env`
// at boot, so iterating live keys would leak them.
export function resolveExposableEnvNames(
  declaredEnvNames: Iterable<string>,
  containerEnv: NodeJS.ProcessEnv,
  operatorAllow: Iterable<string> = [],
  configuredSecretNames: Iterable<string> = [],
): string[] {
  const allowSet = new Set<string>([...SAFE_CONFIG_POINTER_ENV_NAMES, ...operatorAllow])
  const configuredSecretSet = new Set(configuredSecretNames)
  const out: string[] = []
  const seen = new Set<string>()
  for (const name of declaredEnvNames) {
    if (seen.has(name)) continue
    seen.add(name)
    const value = containerEnv[name]
    if (value === undefined || value.length === 0) continue
    if (!allowSet.has(name)) continue
    if (isWithheldEnvName(name, configuredSecretSet)) continue
    out.push(name)
  }
  return out
}
