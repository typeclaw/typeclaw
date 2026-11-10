import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { parseEntryName } from 'typevault'

import { bashVaultAccess } from '@/bundled-plugins/typevault/grants'

import { typevaultBashCliPath, typevaultCliPath } from './cli-path'
import { reconcileTypevault } from './lifecycle'
import {
  ensureProjectIdentity,
  ensureRoleTiers,
  openVault,
  projectIdentityPath,
  runtimeConfigRoot,
  typevaultDir,
  typevaultEnv,
  vaultAdmin,
} from './vault'

// Each test runs several real typevault CLI processes.
setDefaultTimeout(30_000)

const dirs: string[] = []
const agents: string[] = []
afterEach(async () => {
  for (const agent of agents.splice(0)) {
    await Bun.spawn([process.execPath, typevaultCliPath(), 'daemon', 'stop'], {
      env: typevaultEnv(agent),
      stdout: 'ignore',
      stderr: 'ignore',
    }).exited
  }
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

// HOME stays out of the agent folder: typevault takes ~/.typevault for the
// global vault and never for a project's.
async function cli(entrypoint: string, args: string[], cwd: string, env: Record<string, string>, input?: string) {
  const child = Bun.spawn([process.execPath, entrypoint, ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? '', HOME: tmpdir(), ...env },
    stdin: input === undefined ? 'ignore' : new Blob([input]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, code }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'typeclaw-typevault-project-'))
  dirs.push(root)
  const agent = join(root, 'agent')
  const project = join(agent, 'workspace', 'project')
  const owner = { XDG_CONFIG_HOME: join(root, 'owner-config') }
  await mkdir(project, { recursive: true })
  await writeFile(join(agent, 'secrets.json'), '{"version":2,"providers":{},"channels":{},"mcp":{}}\n')
  await reconcileTypevault(agent, true)
  expect((await cli(typevaultCliPath(), ['init', '--machine', '--name', 'alice'], project, owner)).code).toBe(0)
  await ensureProjectIdentity(agent, 'bot')
  // Model bash: the agent vault's grant env, and the project identity where
  // the sandbox HOME's typevault config lives.
  const bash: Record<string, string> = {
    ...bashVaultAccess(agent, 'tvl1.unused').env,
    XDG_CONFIG_HOME: dirname(dirname(projectIdentityPath(agent))),
  }
  return { agent, project, owner, bash }
}

test("a project's own CLI in model bash joins and reads the project's vault without a password", async () => {
  // given
  const { project, owner, bash } = await setup()

  // when
  const joined = await cli(typevaultCliPath(), ['join'], project, bash)
  const line = joined.stdout.trim().split(' ')
  await cli(typevaultCliPath(), ['tier', 'add', 'ci'], project, owner)
  await cli(typevaultCliPath(), ['member', 'add', 'bot', line[4] ?? '', '--tier', 'ci'], project, owner)
  await cli(
    typevaultCliPath(),
    ['set', 'typevault://deploy', '--tier', 'ci', '--preset', 'api_key', '--stdin'],
    project,
    owner,
    'deploy-key-value',
  )
  const listed = await cli(typevaultCliPath(), ['ls'], project, bash)

  // then
  expect(joined.code).toBe(0)
  expect(joined.stdout).toStartWith('typevault member add bot tvp1:')
  expect(listed.stderr).toBe('')
  expect(listed.stdout).toContain('deploy')
})

test("the `typevault` command in model bash still opens the agent's vault from inside a project", async () => {
  // given
  const { agent, project, bash } = await setup()

  // when: the agent's own key stands in for the session grant (grants need the daemon)
  const owned = await cli(typevaultBashCliPath(), ['tier', 'ls'], project, {
    TYPECLAW_VAULT_DIR: bash.TYPECLAW_VAULT_DIR ?? '',
    XDG_CONFIG_HOME: runtimeConfigRoot(agent),
  })

  // then
  expect(bash.TYPECLAW_VAULT_DIR).toBe(typevaultDir(agent))
  expect(owned.stderr).toBe('')
  expect(owned.stdout).toContain('runtime')
})

test("the project identity model bash holds cannot open the agent's vault", async () => {
  // given
  const { project, bash } = await setup()

  // when
  const denied = await cli(typevaultBashCliPath(), ['get', 'typevault://typeclaw/secrets'], project, {
    TYPECLAW_VAULT_DIR: bash.TYPECLAW_VAULT_DIR ?? '',
    XDG_CONFIG_HOME: bash.XDG_CONFIG_HOME ?? '',
  })

  // then
  expect(denied.code).not.toBe(0)
  expect(denied.stdout).toBe('')
})

// Grants need the typevault daemon, which does not run on the Windows CI runner.
test.skipIf(process.platform === 'win32')(
  "a command launched by `typevault run` never receives the session's grant",
  async () => {
    // given: a live member grant, as model bash holds it
    const { agent, project } = await setup()
    agents.push(agent)
    await ensureRoleTiers(agent, ['member'])
    const vault = await openVault(agent)
    await vault.set({
      name: parseEntryName('typevault://deploy'),
      tier: 'member',
      fields: { $default: { type: 'secret', value: 'deploy-key-value' } },
    })
    const token = await vaultAdmin(agent).grant({ tiers: ['member'], ttl: '5m', label: 'test:run-child' })

    // when
    const ran = await cli(
      typevaultBashCliPath(),
      ['run', '--only', 'typevault://deploy', '--reason', 'test', '--', 'env'],
      project,
      { ...bashVaultAccess(agent, token).env, XDG_CONFIG_HOME: runtimeConfigRoot(agent) },
    )

    // then
    expect(ran.stderr).toBe('')
    expect(ran.stdout).toContain('DEPLOY=')
    expect(ran.stdout).not.toContain(token)
    expect(ran.stdout).not.toMatch(/^(TYPEVAULT_|TYPECLAW_VAULT_)/m)
  },
)
