import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ACKNOWLEDGE_GUARDS } from '@/bundled-plugins/guard/policy'

import { checkPluginAdditionGuard, diffPlugins, GUARD_PLUGIN_ADDITION } from './plugin-addition'

async function makeAgentDir(config: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-plugin-guard-'))
  await writeFile(join(dir, 'typeclaw.json'), `${JSON.stringify(config, null, 2)}\n`)
  return dir
}

function writeArgs(config: unknown): Record<string, unknown> {
  return { path: 'typeclaw.json', content: `${JSON.stringify(config, null, 2)}\n` }
}

describe('diffPlugins', () => {
  test('flags a newly added plugin', () => {
    expect(diffPlugins([], ['typeclaw-plugin-foo@1.2.3'])).toEqual([
      { kind: 'plugin-added', name: 'typeclaw-plugin-foo', versionSpec: '1.2.3' },
    ])
  })

  test('flags a version change on an existing plugin', () => {
    expect(diffPlugins(['typeclaw-plugin-foo@1.0.0'], ['typeclaw-plugin-foo@2.0.0'])).toEqual([
      { kind: 'version-changed', name: 'typeclaw-plugin-foo', from: '1.0.0', to: '2.0.0' },
    ])
  })

  test('does not flag a removal', () => {
    expect(diffPlugins(['typeclaw-plugin-foo@1.0.0'], [])).toEqual([])
  })

  test('does not flag a reorder', () => {
    expect(diffPlugins(['a@1', 'b@2'], ['b@2', 'a@1'])).toEqual([])
  })

  test('ignores local-path entries entirely', () => {
    expect(diffPlugins([], ['./plugins/local.ts', '../x.ts', '/abs.ts'])).toEqual([])
  })
})

describe('checkPluginAdditionGuard', () => {
  test('blocks adding a plugin via write', async () => {
    const dir = await makeAgentDir({ plugins: [] })
    try {
      const result = await checkPluginAdditionGuard({
        tool: 'write',
        args: writeArgs({ plugins: ['typeclaw-plugin-foo@1.2.3'] }),
        agentDir: dir,
      })
      expect(result?.block).toBe(true)
      expect(result?.reason).toContain('typeclaw-plugin-foo')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('allows removing a plugin', async () => {
    const dir = await makeAgentDir({ plugins: ['typeclaw-plugin-foo@1.2.3'] })
    try {
      const result = await checkPluginAdditionGuard({
        tool: 'write',
        args: writeArgs({ plugins: [] }),
        agentDir: dir,
      })
      expect(result).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('blocks a version bump of an existing plugin', async () => {
    const dir = await makeAgentDir({ plugins: ['typeclaw-plugin-foo@1.0.0'] })
    try {
      const result = await checkPluginAdditionGuard({
        tool: 'write',
        args: writeArgs({ plugins: ['typeclaw-plugin-foo@2.0.0'] }),
        agentDir: dir,
      })
      expect(result?.block).toBe(true)
      expect(result?.reason).toContain('version changes')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('an ack flag does NOT bypass — the guard no longer honors acknowledgeGuards', async () => {
    const dir = await makeAgentDir({ plugins: [] })
    try {
      const result = await checkPluginAdditionGuard({
        tool: 'write',
        args: {
          ...writeArgs({ plugins: ['typeclaw-plugin-foo@1.2.3'] }),
          [ACKNOWLEDGE_GUARDS]: { [GUARD_PLUGIN_ADDITION]: true },
        },
        agentDir: dir,
      })
      expect(result?.block).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('ignores writes to files other than typeclaw.json', async () => {
    const dir = await makeAgentDir({ plugins: [] })
    try {
      const result = await checkPluginAdditionGuard({
        tool: 'write',
        args: { path: 'README.md', content: 'plugins: typeclaw-plugin-foo' },
        agentDir: dir,
      })
      expect(result).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('allows adding a local-path plugin without acknowledgement', async () => {
    const dir = await makeAgentDir({ plugins: [] })
    try {
      const result = await checkPluginAdditionGuard({
        tool: 'write',
        args: writeArgs({ plugins: ['./plugins/local.ts'] }),
        agentDir: dir,
      })
      expect(result).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('refuses multi-edit on typeclaw.json', async () => {
    const dir = await makeAgentDir({ plugins: [] })
    try {
      const result = await checkPluginAdditionGuard({
        tool: 'edit',
        args: {
          path: 'typeclaw.json',
          edits: [
            { oldText: 'a', newText: 'b' },
            { oldText: 'c', newText: 'd' },
          ],
        },
        agentDir: dir,
      })
      expect(result?.block).toBe(true)
      expect(result?.reason).toContain('refuses multi-edit')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
