import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { agentManifestsChanged, writeAgentManifestStamp } from './manifest-stamp'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-manifest-stamp-'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'agent', workspaces: ['packages/*'] }))
  await mkdir(join(root, 'node_modules'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('agentManifestsChanged', () => {
  test('treats an installed tree with no recorded manifests as unverified', async () => {
    expect(await agentManifestsChanged(root)).toBe(true)
  })

  test('reports no change when nothing is installed yet', async () => {
    await rm(join(root, 'node_modules'), { recursive: true, force: true })

    expect(await agentManifestsChanged(root)).toBe(false)
  })

  test('reports a workspace package added or edited after the last recorded start', async () => {
    // given: a recorded start
    await writeAgentManifestStamp(root)
    expect(await agentManifestsChanged(root)).toBe(false)

    // when: a workspace package appears
    await mkdir(join(root, 'packages', 'tool'), { recursive: true })
    await writeFile(join(root, 'packages', 'tool', 'package.json'), JSON.stringify({ name: 'tool' }))

    // then
    expect(await agentManifestsChanged(root)).toBe(true)

    // when: recorded again, then only its dependencies change
    await writeAgentManifestStamp(root)
    await writeFile(
      join(root, 'packages', 'tool', 'package.json'),
      JSON.stringify({ name: 'tool', dependencies: { zod: '^4' } }),
    )

    // then
    expect(await agentManifestsChanged(root)).toBe(true)
  })

  test('follows every workspace root the agent package declares', async () => {
    // given: a second workspace root, recorded
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'agent', workspaces: ['packages/*', 'tools/*'] }),
    )
    await mkdir(join(root, 'tools', 'my-tool'), { recursive: true })
    await writeFile(join(root, 'tools', 'my-tool', 'package.json'), JSON.stringify({ name: 'my-tool' }))
    await writeAgentManifestStamp(root)

    // when: only a dependency under the second root changes
    await writeFile(
      join(root, 'tools', 'my-tool', 'package.json'),
      JSON.stringify({ name: 'my-tool', dependencies: { zod: '^4' } }),
    )

    // then
    expect(await agentManifestsChanged(root)).toBe(true)
  })

  test('ignores files outside the manifests', async () => {
    await writeAgentManifestStamp(root)
    await mkdir(join(root, 'packages', 'tool'), { recursive: true })
    await writeFile(join(root, 'packages', 'tool', 'index.ts'), 'export {}')

    expect(await agentManifestsChanged(root)).toBe(false)
  })
})
