import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { type Access, createClient, parseEntryName, TypeVaultError } from 'typevault'

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

const SECRETS_ENTRY = parseEntryName('tv://typeclaw/secrets')
const READ_REASON = 'typeclaw runtime credentials'

export function typevaultDir(agentDir: string): string {
  return join(agentDir, TYPEVAULT_VAULT_RELATIVE_DIR)
}

export function vaultExists(agentDir: string): boolean {
  return existsSync(join(typevaultDir(agentDir), 'owner.json'))
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
  env.XDG_CONFIG_HOME = join(agentDir, TYPEVAULT_STATE_RELATIVE_DIR, 'config')
  env.TYPEVAULT_DIR = typevaultDir(agentDir)
  env.TYPEVAULT_GLOBAL = '1'
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
      'the TypeVault vault has no readable secrets entry (tv://typeclaw/secrets); restore .typevault/ from the agent repo history',
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

function openVault(agentDir: string): Promise<Access> {
  return createClient({ direct: true, global: true, dir: typevaultDir(agentDir), env: typevaultEnv(agentDir) })
}

async function ensureTier(agentDir: string, tier: string): Promise<void> {
  try {
    await runTypevaultCli(agentDir, ['tier', 'add', tier])
  } catch (error) {
    if (!(error instanceof Error && error.message.includes(`tier "${tier}" already exists`))) throw error
  }
}

async function runTypevaultCli(agentDir: string, args: string[]): Promise<void> {
  const child = Bun.spawn([process.execPath, typevaultCliPath(), ...args], {
    cwd: agentDir,
    env: typevaultEnv(agentDir),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited])
  if (exitCode !== 0) {
    throw new Error(`typevault ${args.join(' ')} failed: ${stderr.trim() || `exit code ${exitCode}`}`)
  }
}
