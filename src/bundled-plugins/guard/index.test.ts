import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { buildInternalGuards } from '@/agent/guards'
import { noopPermissionService } from '@/permissions'
import { createHookBus } from '@/plugin'
import type { ContentPart, HookContext, PluginContext, ToolAfterEvent, ToolBeforeEvent, ToolResult } from '@/plugin'

import guardPlugin from './index'

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} }

describe('guard plugin', () => {
  test('blocks write calls outside workspace until nonWorkspaceWrite is acknowledged', async () => {
    const hook = await toolBeforeHook()

    const blocked = await hook(toolEvent('write', { path: 'notes.md', content: '{}' }), hookContext('/agent'))
    const acknowledged = await hook(
      toolEvent('write', {
        path: 'notes.md',
        content: '{}',
        acknowledgeGuards: { guard: { nonWorkspaceWrite: true } },
      }),
      hookContext('/agent'),
    )

    expect(blocked).toEqual({
      block: true,
      reason: expect.stringMatching(
        /Guard `nonWorkspaceWrite` blocked write outside the workspace: (?:[A-Z]:)?[\\/]agent[\\/]notes\.md\. The free-write zone is (?:[A-Z]:)?[\\/]agent[\\/]workspace\. Retry with `acknowledgeGuards\.guard\.nonWorkspaceWrite: true` only if this write is intentional\./,
      ),
    })
    expect(acknowledged).toBeUndefined()
  })

  test('allows write and edit calls inside workspace', async () => {
    const hook = await toolBeforeHook()

    const writeResult = await hook(
      toolEvent('write', { path: 'workspace/file.txt', content: 'x' }),
      hookContext('/agent'),
    )
    const editResult = await hook(
      toolEvent('edit', { path: '/agent/workspace/file.txt', edits: [{ oldText: 'x', newText: 'y' }] }),
      hookContext('/agent'),
    )

    expect(writeResult).toBeUndefined()
    expect(editResult).toBeUndefined()
  })

  test('blocks lexical workspace escapes and workspace-like sibling paths', async () => {
    const hook = await toolBeforeHook()

    const dotDotResult = await hook(
      toolEvent('write', { path: 'workspace/../notes.md', content: '{}' }),
      hookContext('/agent'),
    )
    const siblingResult = await hook(
      toolEvent('write', { path: 'workspace2/file.txt', content: 'x' }),
      hookContext('/agent'),
    )
    const absoluteResult = await hook(toolEvent('write', { path: '/etc/passwd', content: 'x' }), hookContext('/agent'))

    expect(dotDotResult?.block).toBe(true)
    expect(siblingResult?.block).toBe(true)
    expect(absoluteResult?.block).toBe(true)
  })

  test('allows known writable files at the agent root', async () => {
    const hook = await toolBeforeHook()

    const cases: Array<[string, string]> = [
      ['AGENTS.md', 'x'],
      ['IDENTITY.md', 'x'],
      ['SOUL.md', 'x'],
      ['USER.md', 'x'],
      ['cron.json', JSON.stringify({ jobs: [] })],
      ['typeclaw.json', JSON.stringify({})],
    ]
    for (const [file, content] of cases) {
      const result = await hook(toolEvent('write', { path: file, content }), hookContext('/agent'))
      expect(result).toBeUndefined()
    }
  })

  test('blocks the operator-owned package.json at the agent root', async () => {
    const hook = await toolBeforeHook()

    const result = await hook(
      toolEvent('write', {
        path: 'package.json',
        content: '{}',
        acknowledgeGuards: { guard: { nonWorkspaceWrite: true } },
      }),
      hookContext('/agent'),
    )

    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('operator-owned package manifest')
  })

  test('blocks MEMORY.md for tui origin now that it is off the root allowlist', async () => {
    const hook = await toolBeforeHook()

    const result = await hook(toolEvent('write', { path: 'MEMORY.md', content: 'x' }), hookContext('/agent'))
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('nonWorkspaceWrite')
  })

  test('allows dreaming subagent to write memory/topics/foo.md', async () => {
    const hook = await toolBeforeHook()

    const result = await hook(
      toolEvent(
        'write',
        { path: 'memory/topics/foo.md', content: 'x' },
        { kind: 'subagent', subagent: 'dreaming', parentSessionId: 's1' },
      ),
      hookContext('/agent'),
    )
    expect(result).toBeUndefined()
  })

  test('blocks tui origin from writing memory/topics/foo.md', async () => {
    const hook = await toolBeforeHook()

    const result = await hook(
      toolEvent('write', { path: 'memory/topics/foo.md', content: 'x' }, { kind: 'tui', sessionId: 's1' }),
      hookContext('/agent'),
    )
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('nonWorkspaceWrite')
  })

  test('rejects write to typeclaw.json with malformed JSON via managedConfig', async () => {
    const hook = await toolBeforeHook()
    const result = await hook(
      toolEvent('write', { path: 'typeclaw.json', content: '{ not json' }),
      hookContext('/agent'),
    )
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('managedConfig')
    expect(result?.reason).toContain('not valid JSON')
  })

  test('rejects write to cron.json with an invalid schedule via managedConfig', async () => {
    const hook = await toolBeforeHook()
    const content = JSON.stringify({
      jobs: [{ id: 'j', schedule: 'bogus', kind: 'prompt', prompt: 'x', scheduledByRole: 'owner' }],
    })
    const result = await hook(toolEvent('write', { path: 'cron.json', content }), hookContext('/agent'))
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('managedConfig')
  })

  test('allows writes under the agent root mounts directory', async () => {
    const hook = await toolBeforeHook()

    const relativeResult = await hook(
      toolEvent('write', { path: 'mounts/data/file.txt', content: 'x' }),
      hookContext('/agent'),
    )
    const absoluteResult = await hook(
      toolEvent('edit', { path: '/agent/mounts/config.json', edits: [{ oldText: 'x', newText: 'y' }] }),
      hookContext('/agent'),
    )

    expect(relativeResult).toBeUndefined()
    expect(absoluteResult).toBeUndefined()
  })

  test('allows writes under the agent root packages directory (bun workspace root)', async () => {
    const hook = await toolBeforeHook()

    const newPackageFile = await hook(
      toolEvent('write', { path: 'packages/my-plugin/index.ts', content: 'export {}' }),
      hookContext('/agent'),
    )
    const newPackageJson = await hook(
      toolEvent('write', { path: 'packages/my-plugin/package.json', content: '{}' }),
      hookContext('/agent'),
    )
    const editAbsolute = await hook(
      toolEvent('edit', {
        path: '/agent/packages/my-plugin/index.ts',
        edits: [{ oldText: 'export {}', newText: 'export const x = 1' }],
      }),
      hookContext('/agent'),
    )

    expect(newPackageFile).toBeUndefined()
    expect(newPackageJson).toBeUndefined()
    expect(editAbsolute).toBeUndefined()
  })

  test('still blocks unknown files and nested paths under allowed root names', async () => {
    const hook = await toolBeforeHook()

    const unknownRoot = await hook(toolEvent('write', { path: 'notes.md', content: 'x' }), hookContext('/agent'))
    const nestedUnderAllowedName = await hook(
      toolEvent('write', { path: 'AGENTS.md/nested.txt', content: 'x' }),
      hookContext('/agent'),
    )

    expect(unknownRoot?.block).toBe(true)
    expect(nestedUnderAllowedName?.block).toBe(true)
  })

  test('blocks workspace symlinks that escape the real workspace directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'typeclaw-guard-'))
    const agentDir = path.join(root, 'agent')
    const workspaceDir = path.join(agentDir, 'workspace')
    const outsideDir = path.join(root, 'outside')
    await mkdir(workspaceDir, { recursive: true })
    await mkdir(outsideDir)
    await symlink(outsideDir, path.join(workspaceDir, 'outside-link'))
    const hook = await toolBeforeHook()

    const result = await hook(
      toolEvent('write', { path: 'workspace/outside-link/file.txt', content: 'x' }),
      hookContext(agentDir),
    )

    expect(result?.block).toBe(true)
  })

  test('allows valid skill writes under memory and user-installed skill roots without acknowledgement', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'typeclaw-guard-'))
    const agentDir = path.join(root, 'agent')
    await mkdir(path.join(agentDir, 'memory', 'skills'), { recursive: true })
    await mkdir(path.join(agentDir, '.agents', 'skills'), { recursive: true })
    const hook = await toolBeforeHook()

    const memoryResult = await hook(
      toolEvent('write', {
        path: 'memory/skills/release-checklist/SKILL.md',
        content: skillFile('release-checklist'),
      }),
      hookContext(agentDir),
    )
    const userResult = await hook(
      toolEvent('write', {
        path: '.agents/skills/review_flow/SKILL.md',
        content: skillFile('review_flow'),
      }),
      hookContext(agentDir),
    )

    expect(memoryResult).toBeUndefined()
    expect(userResult).toBeUndefined()
  })

  test('validates skill authoring path and frontmatter for write calls', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'typeclaw-guard-'))
    const agentDir = path.join(root, 'agent')
    await mkdir(path.join(agentDir, 'memory', 'skills'), { recursive: true })
    const hook = await toolBeforeHook()

    const wrongFile = await hook(
      toolEvent('write', {
        path: 'memory/skills/release-checklist/README.md',
        content: skillFile('release-checklist'),
      }),
      hookContext(agentDir),
    )
    const wrongName = await hook(
      toolEvent('write', { path: 'memory/skills/release-checklist/SKILL.md', content: skillFile('other-name') }),
      hookContext(agentDir),
    )
    const reservedName = await hook(
      toolEvent('write', { path: 'memory/skills/typeclaw-secret/SKILL.md', content: skillFile('typeclaw-secret') }),
      hookContext(agentDir),
    )

    expect(wrongFile?.reason).toContain('skillAuthoring')
    expect(wrongName?.reason).toContain('frontmatter name must match')
    expect(reservedName?.reason).toContain('reserved')
  })

  test('validates edited final skill content before allowing edit calls', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'typeclaw-guard-'))
    const agentDir = path.join(root, 'agent')
    const skillPath = path.join(agentDir, 'memory', 'skills', 'release-checklist', 'SKILL.md')
    await mkdir(path.dirname(skillPath), { recursive: true })
    await writeFile(skillPath, skillFile('release-checklist', 'Old description'))
    const hook = await toolBeforeHook()

    const validEdit = await hook(
      toolEvent('edit', {
        path: 'memory/skills/release-checklist/SKILL.md',
        edits: [{ oldText: 'Old description', newText: 'New description' }],
      }),
      hookContext(agentDir),
    )
    const invalidEdit = await hook(
      toolEvent('edit', {
        path: 'memory/skills/release-checklist/SKILL.md',
        edits: [{ oldText: 'name: release-checklist', newText: 'name: other-name' }],
      }),
      hookContext(agentDir),
    )

    expect(validEdit).toBeUndefined()
    expect(invalidEdit?.reason).toContain('frontmatter name must match')
  })

  test('blocks skill writes through symlinks that escape the skill root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'typeclaw-guard-'))
    const agentDir = path.join(root, 'agent')
    const skillsDir = path.join(agentDir, 'memory', 'skills')
    const outsideDir = path.join(root, 'outside')
    await mkdir(skillsDir, { recursive: true })
    await mkdir(outsideDir)
    await symlink(outsideDir, path.join(skillsDir, 'outside-link'))
    const hook = await toolBeforeHook()

    const result = await hook(
      toolEvent('write', { path: 'memory/skills/outside-link/SKILL.md', content: skillFile('outside-link') }),
      hookContext(agentDir),
    )

    expect(result?.block).toBe(true)
  })

  test('ignores non-mutating tools and invalid paths', async () => {
    const hook = await toolBeforeHook()

    const readResult = await hook(toolEvent('read', { path: 'typeclaw.json' }), hookContext('/agent'))
    const invalidPathResult = await hook(toolEvent('write', { path: 42, content: 'x' }), hookContext('/agent'))

    expect(readResult).toBeUndefined()
    expect(invalidPathResult).toBeUndefined()
  })

  test('appends an uncommitted-changes advisory to write/edit/bash results when the worktree is dirty', async () => {
    const agentDir = await initDirtyGitRepo()
    const hook = await toolAfterHook()

    for (const tool of ['write', 'edit', 'bash']) {
      const result = textResult('tool ok')
      await hook(afterEvent(tool, result), hookContext(agentDir))
      expect(textOf(result)).toContain('tool ok')
      expect(textOf(result)).toContain('uncommittedChanges')
    }
  })

  test('does not append an advisory after non-file-touching tools', async () => {
    const agentDir = await initDirtyGitRepo()
    const hook = await toolAfterHook()

    const result = textResult('read output')
    await hook(afterEvent('read', result), hookContext(agentDir))

    expect(textOf(result)).toBe('read output')
  })

  test('does not append an advisory when the worktree is clean', async () => {
    const agentDir = await initCleanGitRepo()
    const hook = await toolAfterHook()

    const result = textResult('wrote ok')
    await hook(afterEvent('write', result), hookContext(agentDir))

    expect(textOf(result)).toBe('wrote ok')
  })

  test('does not append an advisory when only runtime-owned (sessions/, memory/) files are dirty', async () => {
    const agentDir = await initCleanGitRepo()
    await mkdir(path.join(agentDir, 'sessions'), { recursive: true })
    await mkdir(path.join(agentDir, 'memory'), { recursive: true })
    await writeFile(path.join(agentDir, 'sessions', 'a.jsonl'), '{}')
    await writeFile(path.join(agentDir, 'memory', 'b.md'), '#')
    const hook = await toolAfterHook()

    const result = textResult('wrote ok')
    await hook(afterEvent('write', result), hookContext(agentDir))

    expect(textOf(result)).toBe('wrote ok')
  })
})

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}

function textOf(result: ToolResult): string {
  const part = result.content.find((p): p is ContentPart & { type: 'text' } => p.type === 'text')
  return part ? part.text : ''
}

function afterEvent(tool: string, result: ToolResult): ToolAfterEvent {
  return { tool, sessionId: 's', callId: 'c', result }
}

async function toolAfterHook(): Promise<
  NonNullable<NonNullable<Awaited<ReturnType<typeof guardPlugin.plugin>>['hooks']>['tool.after']>
> {
  const exports = await guardPlugin.plugin(pluginContext('/agent'))
  const hook = exports.hooks?.['tool.after']
  if (!hook) throw new Error('guard plugin did not register tool.after')
  return hook
}

async function initCleanGitRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'typeclaw-guard-after-'))
  const agentDir = path.join(root, 'agent')
  await mkdir(agentDir, { recursive: true })
  await runGit(agentDir, ['init', '-b', 'main'])
  await writeFile(path.join(agentDir, 'README.md'), 'seed\n')
  await runGit(agentDir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', 'README.md'])
  await runGit(agentDir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'seed'])
  return agentDir
}

async function initDirtyGitRepo(): Promise<string> {
  const agentDir = await initCleanGitRepo()
  await writeFile(path.join(agentDir, 'dirty.txt'), 'hi\n')
  return agentDir
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
  const exit = await proc.exited
  if (exit !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`git ${args.join(' ')} failed (${exit}): ${stderr.trim() || '<no stderr>'}`)
  }
}

async function toolBeforeHook() {
  return async (event: ToolBeforeEvent, ctx: HookContext) => {
    const exports = await guardPlugin.plugin(pluginContext(ctx.agentDir))
    const hooks = createHookBus()
    hooks.registerAll('guard', ctx.agentDir, ctx.logger, exports.hooks ?? {})
    const args = { ...event.args }
    const acknowledgements = args.acknowledgeGuards as Record<string, Record<string, boolean>> | undefined
    delete args.acknowledgeGuards
    return hooks.runToolBefore({ ...event, args }, buildInternalGuards(ctx.agentDir), acknowledgements)
  }
}

function toolEvent(tool: string, args: Record<string, unknown>, origin?: ToolBeforeEvent['origin']): ToolBeforeEvent {
  return { tool, sessionId: 's', callId: 'c', args, origin }
}

function hookContext(agentDir: string): HookContext {
  return { agentDir, pluginName: 'guard', logger: noopLogger }
}

function pluginContext(agentDir: string): PluginContext<undefined> {
  return {
    name: 'guard',
    version: undefined,
    agentDir,
    config: undefined,
    logger: noopLogger,
    permissions: noopPermissionService,
    github: {
      resolveTokenForRepo: async () => ({ kind: 'unavailable', reason: 'test' }),
      hasAppTokenResolver: () => false,
    },
    spawnSubagent: async () => {},
  }
}

function skillFile(name: string, description = 'Use when shipping a release.'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`
}
