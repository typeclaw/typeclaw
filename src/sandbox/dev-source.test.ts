import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildSandboxedCommand } from './build'
import { resolveDevSourceMount } from './dev-source'

const bwrapPresent = (() => {
  try {
    return Bun.spawnSync(['bwrap', '--version'], { timeout: 30_000, stdout: 'ignore', stderr: 'ignore' }).success
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
  // A `file:` install: real dirs under node_modules/typeclaw, files symlinked into the checkout.
  const installed = join(agentDir, 'node_modules', 'typeclaw')
  await mkdir(join(installed, 'src', 'sandbox'), { recursive: true })
  await mkdir(join(installed, 'src', 'skills', 'demo'), { recursive: true })
  await symlink(join(checkout, 'src', 'sandbox', 'dev-source.ts'), join(installed, 'src', 'sandbox', 'dev-source.ts'))
  await symlink(
    join(checkout, 'src', 'skills', 'demo', 'SKILL.md'),
    join(installed, 'src', 'skills', 'demo', 'SKILL.md'),
  )
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('resolveDevSourceMount', () => {
  test('binds only the checkout src dir when the running module resolves outside the agent folder', async () => {
    // when
    const mount = await resolveDevSourceMount(
      agentDir,
      join(agentDir, 'node_modules', 'typeclaw', 'src', 'sandbox', 'dev-source.ts'),
    )

    // then
    const src = join(checkout, 'src')
    expect(mount).toEqual({ type: 'ro-bind', source: src, dest: src })
  })

  test('adds no mount for a registry install that resolves inside the agent folder', async () => {
    // given
    const registryFile = join(agentDir, 'node_modules', 'registry-typeclaw', 'src', 'sandbox', 'dev-source.ts')
    await mkdir(join(registryFile, '..'), { recursive: true })
    await writeFile(registryFile, '')

    // when
    const mount = await resolveDevSourceMount(agentDir, registryFile)

    // then
    expect(mount).toBeUndefined()
  })

  test.skipIf(!bwrapPresent)('model bash reads dev skill symlinks but not the checkout root', async () => {
    // given
    const mount = await resolveDevSourceMount(
      agentDir,
      join(agentDir, 'node_modules', 'typeclaw', 'src', 'sandbox', 'dev-source.ts'),
    )
    if (mount === undefined) throw new Error('expected a dev-source mount')
    const run = async (command: string) => {
      const { commandString } = buildSandboxedCommand(command, {
        mounts: [{ type: 'ro-bind', source: agentDir, dest: agentDir }, mount],
      })
      const proc = Bun.spawn(['bash', '-c', commandString], { stdout: 'pipe', stderr: 'pipe' })
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
      return { stdout, exitCode }
    }

    // when
    const skill = await run(`cat ${join(agentDir, 'node_modules', 'typeclaw', 'src', 'skills', 'demo', 'SKILL.md')}`)
    const secret = await run(`cat ${join(checkout, '.env')}`)

    // then
    expect(skill).toEqual({ stdout: 'SKILL_BODY', exitCode: 0 })
    expect(secret.exitCode).not.toBe(0)
    expect(secret.stdout).not.toContain('CHECKOUT_SECRET')
  })
})
