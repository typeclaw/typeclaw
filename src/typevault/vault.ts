import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { type Access, createClient, parseEntryName, TypeVaultError } from 'typevault'
import { type AdminClient, createAdmin } from 'typevault/admin'

import { typevaultCliPath } from './cli-path'

// The agent's vault and its private state both live inside the agent folder,
// so copying the folder moves the whole vault. `.typevault/` holds only
// ciphertext and signed manifests (force-committed by the backup plugin);
// `.typeclaw/typevault/` holds the agent's own machine key and typevault's
// per-checkout state (trust pin, audit log, locks), gitignored and masked
// from every role.
export const TYPEVAULT_VAULT_RELATIVE_DIR = '.typevault'
export const TYPEVAULT_STATE_RELATIVE_DIR = '.typeclaw/typevault'

// The vault's single owner: a machine identity, so nothing ever waits for a
// human to unlock it.
const MEMBER_NAME = 'typeclaw'

// Holds the whole secrets.json envelope. No grant issued to a model session
// ever reaches this tier.
export const RUNTIME_TIER = 'runtime'

const SECRETS_ENTRY = parseEntryName('typevault://typeclaw/secrets')
const READ_REASON = 'typeclaw runtime credentials'

export function typevaultDir(agentDir: string): string {
  return join(agentDir, TYPEVAULT_VAULT_RELATIVE_DIR)
}

export function vaultExists(agentDir: string): boolean {
  return existsSync(join(typevaultDir(agentDir), 'owner.json'))
}

// typevault lets one machine at a time use a vault's private state, and names
// the machine that holds it in a `daemon.holder` claim that survives the
// daemon. Its default name comes from the machine ID or hostname, but for TypeClaw the host-stage CLI
// and every container recreated for this agent are one owner: a new container
// can get a new name, so a claim left by the previous one (or held by the live
// container while the host CLI writes secrets) would refuse every vault open
// with `in_use`. One stable identity per agent lets typevault replace a claim
// its own flock proves stale; a claim from any other identity is still refused.
export const TYPEVAULT_HOST_ID = 'typeclaw-agent'

// typevault 0.4 requires `name` in `daemon.holder` and refuses every vault open
// on a claim without one. The runtime never stops its detached daemon, so each
// container stop under 0.3 leaves such a claim behind. typevault keys a checkout
// by the vault's absolute path, so the container's claim sits under the hash of
// /agent/.typevault, not the host path: scan every checkout in this agent's
// config root. Call this only while the container is down: a claim under this
// agent's identity then has no live owner. Any other claim stays, for typevault
// to refuse with its own error.
export function clearLegacyDaemonClaims(agentDir: string): void {
  const checkouts = join(runtimeConfigRoot(agentDir), 'typevault', 'checkouts')
  if (!existsSync(checkouts)) return
  for (const checkout of readdirSync(checkouts)) {
    const path = join(checkouts, checkout, 'run', 'daemon.holder')
    if (!existsSync(path)) continue
    let claim: { host?: unknown; name?: unknown } | null
    try {
      claim = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      continue
    }
    if (claim?.host === TYPEVAULT_HOST_ID && claim.name === undefined) rmSync(path, { force: true })
  }
}

// The environment every typevault call runs under. The agent's vault is opened
// as typevault's "global" vault at an explicit TYPEVAULT_DIR, so nothing
// depends on the process cwd, and every ambient TYPEVAULT_* variable is
// dropped so an operator's own grant or key can never leak in.
export function typevaultEnv(agentDir: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !key.startsWith('TYPEVAULT_')) env[key] = value
  }
  env.XDG_CONFIG_HOME = runtimeConfigRoot(agentDir)
  env.TYPEVAULT_DIR = typevaultDir(agentDir)
  env.TYPEVAULT_GLOBAL = '1'
  env.TYPEVAULT_HOST_ID = TYPEVAULT_HOST_ID
  return env
}

// Owner operations have no SDK export yet, so they go through typevault's CLI.
// `init` mints a new owner key and rewrites the manifests, so it only ever runs
// on an empty directory: anything left behind is ciphertext that only the old
// keys can open.
export async function provisionVault(agentDir: string): Promise<void> {
  if (!vaultExists(agentDir)) {
    const dir = typevaultDir(agentDir)
    if (existsSync(dir) && readdirSync(dir).length > 0) {
      throw new Error(`${dir} is not empty but has no owner.json; refusing to create a new vault over it`)
    }
    await runTypevaultCli(agentDir, ['init', '--machine', '--name', MEMBER_NAME])
  }
  await ensureTier(agentDir, RUNTIME_TIER)
}

// `undefined` only means "not stored yet". Once secrets.json points at the
// vault, use requireSecretsEntry: typevault skips entries it cannot verify, so
// a missing entry can be corruption and must never read as an empty store.
export async function readSecretsEntry(agentDir: string): Promise<string | undefined> {
  const vault = await openVault(agentDir)
  let fields: Awaited<ReturnType<Access['get']>>['fields']
  try {
    fields = (await vault.get(SECRETS_ENTRY, READ_REASON)).fields
  } catch (error) {
    if (error instanceof TypeVaultError && error.code === 'not_found') return undefined
    throw error
  }
  const value = fields['$default']
  if (value?.type !== 'secret') throw new Error('the TypeVault secrets entry has no secret field')
  return value.value
}

export async function requireSecretsEntry(agentDir: string): Promise<string> {
  const text = await readSecretsEntry(agentDir)
  if (text === undefined) {
    throw new Error(
      'the TypeVault vault has no readable secrets entry (typevault://typeclaw/secrets); restore .typevault/ from the agent repo history',
    )
  }
  return text
}

export async function writeSecretsEntry(agentDir: string, text: string): Promise<void> {
  const vault = await openVault(agentDir)
  await vault.set({
    name: SECRETS_ENTRY,
    tier: RUNTIME_TIER,
    fields: { $default: { type: 'secret', value: text } },
  })
}

// The built-in role tower as tier includes: a grant for a role's tier reaches
// every tier below it, so a secret stored at `member` is usable by member,
// trusted and owner sessions, and never by guest.
export const ROLE_TIER_TOWER = ['owner', 'trusted', 'member', 'guest'] as const

const TIER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

// A role reaches the tier of the same name, except the runtime tier: it holds
// the whole secrets.json envelope, so a custom role named `runtime` must never
// map onto it.
export function isRoleTier(name: string): boolean {
  return TIER_NAME.test(name) && name !== RUNTIME_TIER
}

// Creates a tier per role and wires the built-in tower. Returns the roles that
// get no tier (and so no grant), for the operator log.
export async function ensureRoleTiers(agentDir: string, roles: readonly string[]): Promise<string[]> {
  const tiers = await listTiers(agentDir)
  const skipped: string[] = []
  for (const role of new Set([...ROLE_TIER_TOWER, ...roles])) {
    if (!isRoleTier(role)) {
      skipped.push(role)
      continue
    }
    if (tiers.has(role)) continue
    await ensureTier(agentDir, role)
    tiers.set(role, new Set())
  }
  for (let i = 0; i < ROLE_TIER_TOWER.length - 1; i++) {
    const upper = ROLE_TIER_TOWER[i]!
    const lower = ROLE_TIER_TOWER[i + 1]!
    if (!tiers.get(upper)?.has(lower)) await runTypevaultCli(agentDir, ['tier', 'include', upper, lower])
  }
  return skipped
}

// `promptPort` reaches the daemon only when this call is what starts it; the
// runtime's first grant does, so the daemon serves `request` pages there.
export function vaultAdmin(agentDir: string, options: { promptPort?: number } = {}): AdminClient {
  const env = typevaultEnv(agentDir)
  if (options.promptPort !== undefined) env.TYPEVAULT_PROMPT_PORT = String(options.promptPort)
  return createAdmin({ env, global: true, dir: typevaultDir(agentDir) })
}

export function grantAccess(agentDir: string, grant: string): Promise<Access> {
  return createClient({ grant, global: true, dir: typevaultDir(agentDir), env: typevaultEnv(agentDir) })
}

// typevault keys a vault's private state by the hash of its directory path, so
// a client with a different config root still finds the socket for the same
// TYPEVAULT_DIR under `<configRoot>/typevault/checkouts/<hash>/run/`.
export function agentSocketPath(agentDir: string, configRoot: string): string {
  const checkout = createHash('sha256')
    .update(resolve(typevaultDir(agentDir)), 'utf8')
    .digest('hex')
    .slice(0, 16)
  return join(configRoot, 'typevault', 'checkouts', checkout, 'run', 'agent.sock')
}

export function runtimeConfigRoot(agentDir: string): string {
  return join(agentDir, TYPEVAULT_STATE_RELATIVE_DIR, 'config')
}

// The agent's member identity for other projects' vaults, apart from the key
// that owns its own vault: model bash gets this one, so it must never open
// the agent's vault. An owner adds it with the line `typevault join` prints.
export function projectIdentityPath(agentDir: string): string {
  return join(projectConfigRoot(agentDir), 'typevault', 'identity.json')
}

export async function ensureProjectIdentity(agentDir: string, name: string): Promise<void> {
  if (existsSync(projectIdentityPath(agentDir))) return
  // `join` is typevault's only way to mint a machine identity. It needs some
  // vault to name; the agent's own is opened public-only and left unchanged.
  await runTypevaultCli(agentDir, ['join', '--machine', '--name', name], {
    XDG_CONFIG_HOME: projectConfigRoot(agentDir),
  })
}

// A typevault member name ([a-z0-9-]) for this agent, from its container name.
export function projectMemberName(containerName: string | undefined): string {
  const name = (containerName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return name === '' ? MEMBER_NAME : name
}

function projectConfigRoot(agentDir: string): string {
  return join(agentDir, TYPEVAULT_STATE_RELATIVE_DIR, 'project-member')
}

async function listTiers(agentDir: string): Promise<Map<string, Set<string>>> {
  const tiers = new Map<string, Set<string>>()
  const lines = (await runTypevaultCli(agentDir, ['tier', 'ls'])).split('\n').slice(1)
  for (const line of lines) {
    const [name, , ...rest] = line.trim().split(/\s+/)
    if (name === undefined || name === '') continue
    tiers.set(
      name,
      new Set(
        rest
          .join(' ')
          .split(/[,\s]+/)
          .filter(Boolean),
      ),
    )
  }
  return tiers
}

export function openVault(agentDir: string): Promise<Access> {
  return createClient({ direct: true, global: true, dir: typevaultDir(agentDir), env: typevaultEnv(agentDir) })
}

async function ensureTier(agentDir: string, tier: string): Promise<void> {
  try {
    await runTypevaultCli(agentDir, ['tier', 'add', tier])
  } catch (error) {
    if (!(error instanceof Error && error.message.includes(`tier "${tier}" already exists`))) throw error
  }
}

async function runTypevaultCli(
  agentDir: string,
  args: string[],
  envOverride: Record<string, string> = {},
): Promise<string> {
  const child = Bun.spawn([process.execPath, typevaultCliPath(), ...args], {
    cwd: agentDir,
    env: { ...typevaultEnv(agentDir), ...envOverride },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(`typevault ${args.join(' ')} failed: ${stderr.trim() || `exit code ${exitCode}`}`)
  }
  return stdout
}
