import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { checkManagedConfigGuard } from './managed-config'

async function makeAgentDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'typeclaw-managed-config-'))
}

describe('managedConfig guard — typeclaw.json', () => {
  test('accepts a valid typeclaw.json write', async () => {
    const agentDir = await makeAgentDir()
    const result = await checkManagedConfigGuard({
      tool: 'write',
      args: { path: 'typeclaw.json', content: JSON.stringify({ port: 9000 }) },
      agentDir,
    })
    expect(result).toBeUndefined()
  })

  test('rejects malformed JSON on write', async () => {
    const agentDir = await makeAgentDir()
    const result = await checkManagedConfigGuard({
      tool: 'write',
      args: { path: 'typeclaw.json', content: '{ not valid json' },
      agentDir,
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('not valid JSON')
  })

  test('rejects a write that violates the schema (port out of range)', async () => {
    const agentDir = await makeAgentDir()
    const result = await checkManagedConfigGuard({
      tool: 'write',
      args: { path: 'typeclaw.json', content: JSON.stringify({ port: 70000 }) },
      agentDir,
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('typeclaw.json is invalid')
  })

  test('accepts a valid legacy eval block, which the next load renames to codemode', async () => {
    const agentDir = await makeAgentDir()
    const result = await checkManagedConfigGuard({
      tool: 'write',
      args: { path: 'typeclaw.json', content: JSON.stringify({ eval: { enabled: true, origins: ['cron'] } }) },
      agentDir,
    })
    expect(result).toBeUndefined()
  })

  test('rejects an invalid legacy eval block the next load would reject as codemode', async () => {
    const agentDir = await makeAgentDir()
    const result = await checkManagedConfigGuard({
      tool: 'write',
      args: { path: 'typeclaw.json', content: JSON.stringify({ eval: { enabled: true, origins: ['nowhere'] } }) },
      agentDir,
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('codemode')
  })

  test('an explicit codemode block wins over an invalid leftover eval block', async () => {
    const agentDir = await makeAgentDir()
    const result = await checkManagedConfigGuard({
      tool: 'write',
      args: {
        path: 'typeclaw.json',
        content: JSON.stringify({ codemode: { enabled: true }, eval: { origins: ['nowhere'] } }),
      },
      agentDir,
    })
    expect(result).toBeUndefined()
  })

  test('rejects an empty-string write (parse error)', async () => {
    const agentDir = await makeAgentDir()
    const result = await checkManagedConfigGuard({
      tool: 'write',
      args: { path: 'typeclaw.json', content: '' },
      agentDir,
    })
    expect(result?.block).toBe(true)
  })

  test('accepts a valid edit that produces a schema-valid file', async () => {
    const agentDir = await makeAgentDir()
    await writeFile(path.join(agentDir, 'typeclaw.json'), JSON.stringify({ port: 9000 }, null, 2))

    const result = await checkManagedConfigGuard({
      tool: 'edit',
      args: {
        path: 'typeclaw.json',
        edits: [{ oldText: '"port": 9000', newText: '"port": 9001' }],
      },
      agentDir,
    })
    expect(result).toBeUndefined()
  })

  test('rejects an edit that produces an invalid file', async () => {
    const agentDir = await makeAgentDir()
    await writeFile(path.join(agentDir, 'typeclaw.json'), JSON.stringify({ port: 9000 }, null, 2))

    const result = await checkManagedConfigGuard({
      tool: 'edit',
      args: {
        path: 'typeclaw.json',
        edits: [{ oldText: '"port": 9000', newText: '"port": 70000' }],
      },
      agentDir,
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('typeclaw.json is invalid')
  })

  test('refuses multi-edit on managed files (Oracle PR #305 finding #4)', async () => {
    const agentDir = await makeAgentDir()
    await writeFile(path.join(agentDir, 'typeclaw.json'), JSON.stringify({ port: 9000 }, null, 2))

    const result = await checkManagedConfigGuard({
      tool: 'edit',
      args: {
        path: 'typeclaw.json',
        edits: [
          { oldText: '9000', newText: '9001' },
          { oldText: '"port"', newText: '"port"' },
        ],
      },
      agentDir,
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('multi-edit')
  })

  test('refuses single edit when oldText is non-unique in the existing file', async () => {
    const agentDir = await makeAgentDir()
    await writeFile(
      path.join(agentDir, 'typeclaw.json'),
      JSON.stringify(
        {
          port: 9000,
          mounts: [
            { name: 'a', host: '/a' },
            { name: 'b', host: '/b' },
          ],
        },
        null,
        2,
      ),
    )

    const result = await checkManagedConfigGuard({
      tool: 'edit',
      args: {
        path: 'typeclaw.json',
        edits: [{ oldText: '"name"', newText: '"name"' }],
      },
      agentDir,
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('not unique')
  })

  test('rejects an edit whose oldText does not match the file', async () => {
    const agentDir = await makeAgentDir()
    await writeFile(path.join(agentDir, 'typeclaw.json'), JSON.stringify({ port: 9000 }, null, 2))

    const result = await checkManagedConfigGuard({
      tool: 'edit',
      args: {
        path: 'typeclaw.json',
        edits: [{ oldText: 'NOT-IN-FILE', newText: 'x' }],
      },
      agentDir,
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('oldText was not found')
  })
})

describe('managedConfig guard — cron.json', () => {
  test('accepts a valid cron.json write', async () => {
    const agentDir = await makeAgentDir()
    const content = JSON.stringify({
      jobs: [
        {
          id: 'daily',
          schedule: '30 23 * * *',
          kind: 'prompt',
          prompt: 'summarize',
          scheduledByRole: 'owner',
        },
      ],
    })
    const result = await checkManagedConfigGuard({
      tool: 'write',
      args: { path: 'cron.json', content },
      agentDir,
    })
    expect(result).toBeUndefined()
  })

  test('rejects malformed JSON on write', async () => {
    const agentDir = await makeAgentDir()
    const result = await checkManagedConfigGuard({
      tool: 'write',
      args: { path: 'cron.json', content: 'not json' },
      agentDir,
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('cron.json is not valid JSON')
  })

  test('rejects an invalid cron schedule', async () => {
    const agentDir = await makeAgentDir()
    const content = JSON.stringify({
      jobs: [{ id: 'j', schedule: 'bogus', kind: 'prompt', prompt: 'x', scheduledByRole: 'owner' }],
    })
    const result = await checkManagedConfigGuard({
      tool: 'write',
      args: { path: 'cron.json', content },
      agentDir,
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('bogus')
  })

  test('rejects scheduling a one-shot reminder in the past', async () => {
    const agentDir = await makeAgentDir()
    const content = JSON.stringify({
      jobs: [{ id: 'remind', at: '2020-01-01T00:00:00Z', kind: 'prompt', prompt: 'x', scheduledByRole: 'owner' }],
    })
    const result = await checkManagedConfigGuard({
      tool: 'write',
      args: { path: 'cron.json', content },
      agentDir,
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('past')
  })

  test('accepts a future one-shot reminder', async () => {
    const agentDir = await makeAgentDir()
    const content = JSON.stringify({
      jobs: [{ id: 'remind', at: '2999-01-01T00:00:00Z', kind: 'prompt', prompt: 'x', scheduledByRole: 'owner' }],
    })
    const result = await checkManagedConfigGuard({
      tool: 'write',
      args: { path: 'cron.json', content },
      agentDir,
    })
    expect(result).toBeUndefined()
  })

  test('rejects duplicate job ids', async () => {
    const agentDir = await makeAgentDir()
    const content = JSON.stringify({
      jobs: [
        { id: 'dup', schedule: '* * * * *', kind: 'prompt', prompt: 'a', scheduledByRole: 'owner' },
        { id: 'dup', schedule: '* * * * *', kind: 'prompt', prompt: 'b', scheduledByRole: 'owner' },
      ],
    })
    const result = await checkManagedConfigGuard({
      tool: 'write',
      args: { path: 'cron.json', content },
      agentDir,
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('duplicate job id')
  })

  test('rejects a write missing scheduledByRole', async () => {
    const agentDir = await makeAgentDir()
    const content = JSON.stringify({
      jobs: [{ id: 'j', schedule: '* * * * *', kind: 'prompt', prompt: 'x' }],
    })
    const result = await checkManagedConfigGuard({
      tool: 'write',
      args: { path: 'cron.json', content },
      agentDir,
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('scheduledByRole')
  })

  test('accepts a valid edit', async () => {
    const agentDir = await makeAgentDir()
    const initial = JSON.stringify(
      {
        jobs: [{ id: 'j', schedule: '0 9 * * *', kind: 'prompt', prompt: 'x', scheduledByRole: 'owner' }],
      },
      null,
      2,
    )
    await writeFile(path.join(agentDir, 'cron.json'), initial)

    const result = await checkManagedConfigGuard({
      tool: 'edit',
      args: {
        path: 'cron.json',
        edits: [{ oldText: '"schedule": "0 9 * * *"', newText: '"schedule": "0 10 * * *"' }],
      },
      agentDir,
    })
    expect(result).toBeUndefined()
  })

  test('rejects an edit that produces an invalid cron file', async () => {
    const agentDir = await makeAgentDir()
    const initial = JSON.stringify(
      {
        jobs: [{ id: 'j', schedule: '0 9 * * *', kind: 'prompt', prompt: 'x', scheduledByRole: 'owner' }],
      },
      null,
      2,
    )
    await writeFile(path.join(agentDir, 'cron.json'), initial)

    const result = await checkManagedConfigGuard({
      tool: 'edit',
      args: {
        path: 'cron.json',
        edits: [{ oldText: '"schedule": "0 9 * * *"', newText: '"schedule": "bogus"' }],
      },
      agentDir,
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('bogus')
  })
})

// Delta-timing regression: a stale enabled job (expired `until` from the past)
// used to fail the whole file in strict edit mode, so it held the file hostage —
// the agent could not remove it, add a valid job, or touch any sibling. The
// guard now strict-checks timing only on newly-authored jobs, tolerating a stale
// boundary that is carried over unchanged.
describe('managedConfig guard — cron.json stale-job delta validation', () => {
  const staleJob = {
    id: 'expired',
    schedule: '0 9 * * *',
    until: '2020-01-01T00:00:00Z',
    kind: 'prompt',
    prompt: 'x',
    scheduledByRole: 'owner',
  }
  const freshJob = {
    id: 'fresh',
    schedule: '0 10 * * *',
    kind: 'prompt',
    prompt: 'y',
    scheduledByRole: 'owner',
  }

  async function withExisting(jobs: unknown[]): Promise<string> {
    const agentDir = await makeAgentDir()
    await writeFile(path.join(agentDir, 'cron.json'), JSON.stringify({ jobs }, null, 2))
    return agentDir
  }

  test('allows removing a stale pre-existing job', async () => {
    const agentDir = await withExisting([staleJob, freshJob])
    const result = await checkManagedConfigGuard({
      tool: 'write',
      args: { path: 'cron.json', content: JSON.stringify({ jobs: [freshJob] }) },
      agentDir,
    })
    expect(result).toBeUndefined()
  })

  test('allows editing an unrelated job while a stale job persists unchanged', async () => {
    const agentDir = await withExisting([staleJob, freshJob])
    const editedFresh = { ...freshJob, schedule: '0 11 * * *' }
    const result = await checkManagedConfigGuard({
      tool: 'write',
      args: { path: 'cron.json', content: JSON.stringify({ jobs: [staleJob, editedFresh] }) },
      agentDir,
    })
    expect(result).toBeUndefined()
  })

  test('still blocks adding a NEW job with a past until', async () => {
    const agentDir = await withExisting([freshJob])
    const newStale = { ...staleJob, id: 'new-expired' }
    const result = await checkManagedConfigGuard({
      tool: 'write',
      args: { path: 'cron.json', content: JSON.stringify({ jobs: [freshJob, newStale] }) },
      agentDir,
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('past')
  })

  test('still blocks re-timing an existing job into the past', async () => {
    const agentDir = await withExisting([freshJob])
    const reTimed = { ...freshJob, until: '2020-01-01T00:00:00Z' }
    const result = await checkManagedConfigGuard({
      tool: 'write',
      args: { path: 'cron.json', content: JSON.stringify({ jobs: [reTimed] }) },
      agentDir,
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('past')
  })

  test('still blocks re-enabling a stale disabled job (enabled flip re-arms the check)', async () => {
    const disabledStale = { ...staleJob, enabled: false }
    const agentDir = await withExisting([disabledStale])
    const reEnabled = { ...staleJob, enabled: true }
    const result = await checkManagedConfigGuard({
      tool: 'write',
      args: { path: 'cron.json', content: JSON.stringify({ jobs: [reEnabled] }) },
      agentDir,
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('past')
  })

  test('on first-init (no existing file) a past job is still blocked', async () => {
    const agentDir = await makeAgentDir()
    const result = await checkManagedConfigGuard({
      tool: 'write',
      args: { path: 'cron.json', content: JSON.stringify({ jobs: [staleJob] }) },
      agentDir,
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('past')
  })
})

describe('managedConfig guard — scope', () => {
  test('ignores tools other than write/edit', async () => {
    const agentDir = await makeAgentDir()
    const result = await checkManagedConfigGuard({
      tool: 'read',
      args: { path: 'typeclaw.json' },
      agentDir,
    })
    expect(result).toBeUndefined()
  })

  test('ignores writes to other files at the agent root', async () => {
    const agentDir = await makeAgentDir()
    const result = await checkManagedConfigGuard({
      tool: 'write',
      args: { path: 'AGENTS.md', content: 'anything' },
      agentDir,
    })
    expect(result).toBeUndefined()
  })

  test('ignores nested files that happen to share a basename', async () => {
    const agentDir = await makeAgentDir()
    const result = await checkManagedConfigGuard({
      tool: 'write',
      args: { path: 'workspace/typeclaw.json', content: 'not json at all' },
      agentDir,
    })
    expect(result).toBeUndefined()
  })

  test('accepts absolute paths that resolve to the managed file', async () => {
    const agentDir = await makeAgentDir()
    const result = await checkManagedConfigGuard({
      tool: 'write',
      args: { path: path.join(agentDir, 'typeclaw.json'), content: '{ broken' },
      agentDir,
    })
    expect(result?.block).toBe(true)
  })

  test('ignores non-string paths and non-string content', async () => {
    const agentDir = await makeAgentDir()
    const badPath = await checkManagedConfigGuard({
      tool: 'write',
      args: { path: 42, content: 'x' },
      agentDir,
    })
    const badContent = await checkManagedConfigGuard({
      tool: 'write',
      args: { path: 'typeclaw.json', content: 42 },
      agentDir,
    })
    expect(badPath).toBeUndefined()
    expect(badContent?.block).toBe(true)
  })

  test('catches lexical traversal that ends back at the managed file', async () => {
    const agentDir = await makeAgentDir()
    const result = await checkManagedConfigGuard({
      tool: 'write',
      args: { path: 'workspace/../typeclaw.json', content: '{ malformed' },
      agentDir,
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('typeclaw.json')
  })

  test('catches writes whose target is a symlink to typeclaw.json', async () => {
    const agentDir = await makeAgentDir()
    const realConfig = path.join(agentDir, 'typeclaw.json')
    await writeFile(realConfig, JSON.stringify({ port: 9000 }, null, 2))
    await symlink(realConfig, path.join(agentDir, 'alias.json'))

    const result = await checkManagedConfigGuard({
      tool: 'write',
      args: { path: 'alias.json', content: '{ malformed' },
      agentDir,
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('not valid JSON')
  })

  test('catches writes through a workspace symlink that escapes back to cron.json', async () => {
    const agentDir = await makeAgentDir()
    await mkdir(path.join(agentDir, 'workspace'), { recursive: true })
    const realCron = path.join(agentDir, 'cron.json')
    await writeFile(realCron, JSON.stringify({ jobs: [] }, null, 2))
    await symlink(realCron, path.join(agentDir, 'workspace', 'cron.json'))

    const result = await checkManagedConfigGuard({
      tool: 'write',
      args: { path: 'workspace/cron.json', content: '{ malformed' },
      agentDir,
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('not valid JSON')
  })

  test('Oracle PR #305 finding #5: catches a write through a typeclaw.json that is itself a symlink into workspace', async () => {
    const agentDir = await makeAgentDir()
    await mkdir(path.join(agentDir, 'workspace'), { recursive: true })
    const realConfigPath = path.join(agentDir, 'workspace', 'tc.json')
    await writeFile(realConfigPath, JSON.stringify({ port: 9000 }, null, 2))
    await symlink(realConfigPath, path.join(agentDir, 'typeclaw.json'))

    const result = await checkManagedConfigGuard({
      tool: 'write',
      args: { path: 'typeclaw.json', content: '{ malformed' },
      agentDir,
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('not valid JSON')
  })

  test('does NOT trigger on a sibling-agent absolute typeclaw.json', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'typeclaw-managed-config-sibling-'))
    const agentDir = path.join(root, 'agentA')
    const siblingDir = path.join(root, 'agentB')
    await mkdir(agentDir, { recursive: true })
    await mkdir(siblingDir, { recursive: true })

    const result = await checkManagedConfigGuard({
      tool: 'write',
      args: { path: path.join(siblingDir, 'typeclaw.json'), content: '{ malformed' },
      agentDir,
    })
    expect(result).toBeUndefined()
  })
})

describe('managedConfig guard — file: URI targets', () => {
  test('validates typeclaw.json addressed by a file: URI, including one with leading whitespace', async () => {
    const agentDir = await makeAgentDir()
    const uri = pathToFileURL(path.join(agentDir, 'typeclaw.json')).href

    for (const ref of [uri, `  ${uri}`]) {
      const result = await checkManagedConfigGuard({
        tool: 'write',
        args: { path: ref, content: '{ not json' },
        agentDir,
      })
      expect(result?.block).toBe(true)
    }
    expect(
      await checkManagedConfigGuard({
        tool: 'write',
        args: { path: uri, content: JSON.stringify({ port: 9000 }) },
        agentDir,
      }),
    ).toBeUndefined()
  })
})
