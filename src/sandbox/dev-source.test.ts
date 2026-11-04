import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildSandboxedCommand } from './build'
import { resolveDevSourceMounts } from './dev-source'

const bwrapPresent = (() => {
  try {
    return Bun.spawnSync(['bwrap', '--version'], { stdout: 'ignore', stderr: 'ignore' }).success
  } catch {
    return false
  }
})()

let root: string
let agentDir: string
let checkout: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'typeclaw-dev-source-')))
  agentDir = join(root, 'agent')
  checkout = join(root, 'checkout')
  await mkdir(join(checkout, 'src', 'sandbox'), { recursive: true })
  await mkdir(join(checkout, 'src', 'skills', 'demo'), { recursive: true })
  await writeFile(join(checkout, 'src', 'sandbox', 'dev-source.ts'), '')
  await writeFile(join(checkout, 'src', 'skills', 'demo', 'SKILL.md'), 'SKILL_BODY')
  await writeFile(join(checkout, '.env'), 'CHECKOUT_SECRET')
  // typeclaw's own dependencies, e.g. the runtime-provided `typevault` CLI.
  await mkdir(join(checkout, 'node_modules', 'runtime-cli'), { recursive: true })
  await writeFile(join(checkout, 'node_modules', 'runtime-cli', 'cli.js'), 'RUNTIME_CLI_BODY')
  // A `file:` install: real dirs under node_modules/typeclaw, files symlinked into the checkout.
  const installed = join(agentDir, 'node_modules', 'typeclaw')
  await mkdir(join(installed, 'src', 'sandbox'), { recursive: true })
  await mkdir(join(installed, 'src', 'skills', 'demo'), { recursive: true })
  await symlink(join(checkout, 'src', 'sandbox', 'dev-source.ts'), join(installed, 'src', 'sandbox', 'dev-source.ts'))
  await symlink(
    join(checkout, 'src', 'skills', 'demo', 'SKILL.md'),
    join(installed, 'src', 'skills', 'demo', 'SKILL.md'),
  )
  await mkdir(join(installed, 'node_modules', 'runtime-cli'), { recursive: true })
  await symlink(
    join(checkout, 'node_modules', 'runtime-cli', 'cli.js'),
    join(installed, 'node_modules', 'runtime-cli', 'cli.js'),
  )
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const devModuleFile = () => join(agentDir, 'node_modules', 'typeclaw', 'src', 'sandbox', 'dev-source.ts')

describe('resolveDevSourceMounts', () => {
  test('binds the checkout src and node_modules dirs when the running module resolves outside the agent folder', async () => {
    // when
    const mounts = await resolveDevSourceMounts(agentDir, devModuleFile())

    // then
    const src = join(checkout, 'src')
    const nodeModules = join(checkout, 'node_modules')
    expect(mounts).toEqual([
      { type: 'ro-bind', source: src, dest: src },
      { type: 'ro-bind', source: nodeModules, dest: nodeModules },
    ])
  })

  test('binds only src when the checkout has no node_modules dir', async () => {
    // given
    await rm(join(checkout, 'node_modules'), { recursive: true, force: true })

    // when
    const mounts = await resolveDevSourceMounts(agentDir, devModuleFile())

    // then
    const src = join(checkout, 'src')
    expect(mounts).toEqual([{ type: 'ro-bind', source: src, dest: src }])
  })

  test('adds no mount for a registry install that resolves inside the agent folder', async () => {
    // given
    const registryFile = join(agentDir, 'node_modules', 'registry-typeclaw', 'src', 'sandbox', 'dev-source.ts')
    await mkdir(join(registryFile, '..'), { recursive: true })
    await writeFile(registryFile, '')

    // when
    const mounts = await resolveDevSourceMounts(agentDir, registryFile)

    // then
    expect(mounts).toEqual([])
  })

  test.skipIf(!bwrapPresent)(
    'model bash reads dev skill and dependency symlinks but not the checkout root',
    async () => {
      // given
      const mounts = await resolveDevSourceMounts(agentDir, devModuleFile())
      const run = async (command: string) => {
        const { commandString } = buildSandboxedCommand(command, {
          mounts: [{ type: 'ro-bind', source: agentDir, dest: agentDir }, ...mounts],
        })
        const proc = Bun.spawn(['bash', '-c', commandString], { stdout: 'pipe', stderr: 'pipe' })
        const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
        return { stdout, exitCode }
      }

      // when
      const skill = await run(`cat ${join(agentDir, 'node_modules', 'typeclaw', 'src', 'skills', 'demo', 'SKILL.md')}`)
      const dependency = await run(
        `cat ${join(agentDir, 'node_modules', 'typeclaw', 'node_modules', 'runtime-cli', 'cli.js')}`,
      )
      const secret = await run(`cat ${join(checkout, '.env')}`)

      // then
      expect(skill).toEqual({ stdout: 'SKILL_BODY', exitCode: 0 })
      expect(dependency).toEqual({ stdout: 'RUNTIME_CLI_BODY', exitCode: 0 })
      expect(secret.exitCode).not.toBe(0)
      expect(secret.stdout).not.toContain('CHECKOUT_SECRET')
    },
  )
})
