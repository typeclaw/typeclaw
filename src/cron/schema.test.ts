import { describe, expect, test } from 'bun:test'

import { z } from 'zod'

import type { Subagent, SubagentRegistry } from '@/agent/subagents'

import { buildCronMigrationCommitMessage, cronFileSchema, migrateLegacyCronShape, parseCronFile } from './schema'

describe('cronFileSchema', () => {
  test('accepts an empty jobs list', () => {
    expect(() => cronFileSchema.parse({ jobs: [] })).not.toThrow()
  })

  test('accepts a prompt-kind job with required fields only', () => {
    const parsed = cronFileSchema.parse({
      jobs: [{ id: 'daily-summary', schedule: '30 23 * * *', kind: 'prompt', prompt: 'Summarize today.' }],
    })
    const job = parsed.jobs[0]
    if (!job) throw new Error('expected a job')
    expect(job.enabled).toBe(true)
    expect(job.timezone).toBeUndefined()
  })

  test('accepts an exec-kind job with a shell command', () => {
    const parsed = cronFileSchema.parse({
      jobs: [{ id: 'backup', schedule: '0 * * * *', kind: 'exec', command: ['git', 'commit', '-am', 'backup'] }],
    })
    const job = parsed.jobs[0]
    if (!job || job.kind !== 'exec') throw new Error('expected an exec job')
    expect(job.command).toEqual(['git', 'commit', '-am', 'backup'])
  })

  test('defaults enabled to true when omitted', () => {
    const parsed = cronFileSchema.parse({
      jobs: [{ id: 'j', schedule: '* * * * *', kind: 'prompt', prompt: 'x' }],
    })
    expect(parsed.jobs[0]?.enabled).toBe(true)
  })

  test('respects enabled: false', () => {
    const parsed = cronFileSchema.parse({
      jobs: [{ id: 'j', schedule: '* * * * *', kind: 'prompt', prompt: 'x', enabled: false }],
    })
    expect(parsed.jobs[0]?.enabled).toBe(false)
  })

  test('rejects missing id', () => {
    expect(() => cronFileSchema.parse({ jobs: [{ schedule: '* * * * *', kind: 'prompt', prompt: 'x' }] })).toThrow()
  })

  test('rejects an id with whitespace', () => {
    expect(() =>
      cronFileSchema.parse({ jobs: [{ id: 'bad id', schedule: '* * * * *', kind: 'prompt', prompt: 'x' }] }),
    ).toThrow()
  })

  test('rejects unknown kind', () => {
    expect(() =>
      cronFileSchema.parse({
        jobs: [{ id: 'j', schedule: '* * * * *', kind: 'weird', prompt: 'x' }],
      }),
    ).toThrow()
  })

  test('rejects subagent kind (internal-only — must not be writable from cron.json)', () => {
    expect(() =>
      cronFileSchema.parse({
        jobs: [{ id: 'j', schedule: '* * * * *', kind: 'subagent', subagent: 'dreaming', payload: {} }],
      }),
    ).toThrow()
  })

  test('rejects prompt job missing prompt', () => {
    expect(() => cronFileSchema.parse({ jobs: [{ id: 'j', schedule: '* * * * *', kind: 'prompt' }] })).toThrow()
  })

  test('rejects exec job with empty command array', () => {
    expect(() =>
      cronFileSchema.parse({ jobs: [{ id: 'j', schedule: '* * * * *', kind: 'exec', command: [] }] }),
    ).toThrow()
  })

  test('accepts a prompt job with subagent and payload fields', () => {
    const parsed = cronFileSchema.parse({
      jobs: [
        {
          id: 'consolidate',
          schedule: '30 23 * * *',
          kind: 'prompt',
          prompt: 'unused',
          subagent: 'dreaming',
          payload: { agentDir: '/agent' },
        },
      ],
    })
    const job = parsed.jobs[0]
    if (!job || job.kind !== 'prompt') throw new Error('expected a prompt job')
    expect(job.subagent).toBe('dreaming')
    expect(job.payload).toEqual({ agentDir: '/agent' })
  })

  test('rejects empty-string subagent name', () => {
    expect(() =>
      cronFileSchema.parse({
        jobs: [{ id: 'j', schedule: '* * * * *', kind: 'prompt', prompt: 'x', subagent: '' }],
      }),
    ).toThrow()
  })

  test('accepts a prompt job with an `exec` pre-LLM command', () => {
    const parsed = cronFileSchema.parse({
      jobs: [
        {
          id: 'morning-summary',
          schedule: '0 9 * * *',
          kind: 'prompt',
          prompt: 'Summarize yesterday.',
          exec: ['git', 'log', '--oneline', '--since=yesterday'],
        },
      ],
    })
    const job = parsed.jobs[0]
    if (!job || job.kind !== 'prompt') throw new Error('expected a prompt job')
    expect(job.exec).toEqual(['git', 'log', '--oneline', '--since=yesterday'])
    expect(job.execMaxOutputBytes).toBeUndefined()
  })

  test('rejects a prompt job with an empty `exec` array', () => {
    expect(() =>
      cronFileSchema.parse({
        jobs: [{ id: 'j', schedule: '* * * * *', kind: 'prompt', prompt: 'x', exec: [] }],
      }),
    ).toThrow()
  })

  test('rejects a prompt job with an empty string inside `exec`', () => {
    expect(() =>
      cronFileSchema.parse({
        jobs: [{ id: 'j', schedule: '* * * * *', kind: 'prompt', prompt: 'x', exec: ['ls', ''] }],
      }),
    ).toThrow()
  })

  test('accepts `execMaxOutputBytes` as a positive integer', () => {
    const parsed = cronFileSchema.parse({
      jobs: [
        {
          id: 'capped',
          schedule: '* * * * *',
          kind: 'prompt',
          prompt: 'x',
          exec: ['echo', 'hi'],
          execMaxOutputBytes: 1024,
        },
      ],
    })
    const job = parsed.jobs[0]
    if (!job || job.kind !== 'prompt') throw new Error('expected a prompt job')
    expect(job.execMaxOutputBytes).toBe(1024)
  })

  test('rejects `execMaxOutputBytes <= 0`', () => {
    expect(() =>
      cronFileSchema.parse({
        jobs: [
          {
            id: 'j',
            schedule: '* * * * *',
            kind: 'prompt',
            prompt: 'x',
            exec: ['echo', 'hi'],
            execMaxOutputBytes: 0,
          },
        ],
      }),
    ).toThrow()
  })
})

describe('parseCronFile', () => {
  test('rejects invalid cron expressions with a helpful error', () => {
    const result = parseCronFile({
      jobs: [{ id: 'j', schedule: 'not-a-cron-expression', kind: 'prompt', prompt: 'x' }],
    })
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/not-a-cron-expression/)
    expect(result.reason).toMatch(/j/)
  })

  test('rejects invalid timezone', () => {
    const result = parseCronFile({
      jobs: [{ id: 'j', schedule: '* * * * *', kind: 'prompt', prompt: 'x', timezone: 'Not/A_Zone' }],
    })
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/timezone/i)
  })

  test('rejects duplicate job ids', () => {
    const result = parseCronFile({
      jobs: [
        { id: 'same', schedule: '* * * * *', kind: 'prompt', prompt: 'a', scheduledByRole: 'owner' },
        { id: 'same', schedule: '0 * * * *', kind: 'prompt', prompt: 'b', scheduledByRole: 'owner' },
      ],
    })
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/duplicate/i)
    expect(result.reason).toMatch(/same/)
  })

  test('rejects a job without scheduledByRole (boot-time legacy detection)', () => {
    const result = parseCronFile({
      jobs: [{ id: 'j', schedule: '* * * * *', kind: 'prompt', prompt: 'x' }],
    })
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/scheduledByRole/)
  })

  test('accepts an empty file', () => {
    const result = parseCronFile({ jobs: [] })
    expect(result.ok).toBe(true)
  })

  test('accepts a valid mixed file', () => {
    const result = parseCronFile({
      jobs: [
        {
          id: 'a',
          schedule: '30 23 * * *',
          kind: 'prompt',
          prompt: 'x',
          timezone: 'Asia/Seoul',
          scheduledByRole: 'owner',
        },
        { id: 'b', schedule: '0 * * * *', kind: 'exec', command: ['echo', 'hi'], scheduledByRole: 'owner' },
      ],
    })
    if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`)
    expect(result.file.jobs).toHaveLength(2)
  })
})

describe('parseCronFile with subagents registry', () => {
  const greeter: Subagent = { systemPrompt: 'X' }
  const memoryLogger: Subagent<{ id: string }> = {
    systemPrompt: 'X',
    payloadSchema: z.object({ id: z.string() }),
  }
  const registry: SubagentRegistry = { greeter, 'memory-logger': memoryLogger }

  test('accepts a prompt job referencing a registered subagent with no payload', () => {
    const result = parseCronFile(
      {
        jobs: [
          {
            id: 'j',
            schedule: '* * * * *',
            kind: 'prompt',
            prompt: 'x',
            subagent: 'greeter',
            scheduledByRole: 'owner',
          },
        ],
      },
      { subagents: registry },
    )
    expect(result.ok).toBe(true)
  })

  test('rejects a prompt job referencing an unknown subagent', () => {
    const result = parseCronFile(
      {
        jobs: [
          {
            id: 'j',
            schedule: '* * * * *',
            kind: 'prompt',
            prompt: 'x',
            subagent: 'no-such-thing',
            scheduledByRole: 'owner',
          },
        ],
      },
      { subagents: registry },
    )
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/unknown subagent/)
  })

  test('rejects a prompt job whose payload does not match the subagent payloadSchema', () => {
    const result = parseCronFile(
      {
        jobs: [
          {
            id: 'j',
            schedule: '* * * * *',
            kind: 'prompt',
            prompt: 'x',
            subagent: 'memory-logger',
            payload: { id: 42 },
            scheduledByRole: 'owner',
          },
        ],
      },
      { subagents: registry },
    )
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/invalid payload/)
  })

  test('rejects a prompt job that supplies a payload to a subagent without a schema', () => {
    const result = parseCronFile(
      {
        jobs: [
          {
            id: 'j',
            schedule: '* * * * *',
            kind: 'prompt',
            prompt: 'x',
            subagent: 'greeter',
            payload: { extra: 1 },
            scheduledByRole: 'owner',
          },
        ],
      },
      { subagents: registry },
    )
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/does not accept a payload/)
  })

  test('skips registry validation when no subagents option is provided (raw parse path)', () => {
    const result = parseCronFile({
      jobs: [
        {
          id: 'j',
          schedule: '* * * * *',
          kind: 'prompt',
          prompt: 'x',
          subagent: 'no-such-thing',
          scheduledByRole: 'owner',
        },
      ],
    })
    expect(result.ok).toBe(true)
  })
})

describe('migrateLegacyCronShape', () => {
  test('returns changed=false on canonical input (every job has scheduledByRole)', () => {
    const input = {
      jobs: [
        { id: 'a', schedule: '* * * * *', kind: 'prompt', prompt: 'x', scheduledByRole: 'owner' },
        { id: 'b', schedule: '0 * * * *', kind: 'exec', command: ['echo', 'hi'], scheduledByRole: 'trusted' },
      ],
    }
    const result = migrateLegacyCronShape(input)
    expect(result.changed).toBe(false)
    expect(result.applied).toEqual([])
    expect(result.json).toBe(input)
  })

  test('stamps scheduledByRole: "owner" on jobs missing it', () => {
    const input = {
      jobs: [{ id: 'minute-status-log', schedule: '* * * * *', kind: 'prompt', prompt: 'x' }],
    }
    const result = migrateLegacyCronShape(input)
    expect(result.changed).toBe(true)
    expect(result.applied).toEqual([{ kind: 'stamp-scheduled-by-role-owner', jobIds: ['minute-status-log'] }])
    const job = (result.json as { jobs: Array<{ scheduledByRole: string }> }).jobs[0]
    expect(job?.scheduledByRole).toBe('owner')
  })

  test('leaves existing scheduledByRole values untouched (does not coerce non-owner to owner)', () => {
    const input = {
      jobs: [
        { id: 'a', schedule: '* * * * *', kind: 'prompt', prompt: 'x', scheduledByRole: 'trusted' },
        { id: 'b', schedule: '0 * * * *', kind: 'prompt', prompt: 'y' },
      ],
    }
    const result = migrateLegacyCronShape(input)
    expect(result.changed).toBe(true)
    const jobs = (result.json as { jobs: Array<{ id: string; scheduledByRole: string }> }).jobs
    expect(jobs[0]?.scheduledByRole).toBe('trusted')
    expect(jobs[1]?.scheduledByRole).toBe('owner')
    expect(result.applied[0]).toEqual({ kind: 'stamp-scheduled-by-role-owner', jobIds: ['b'] })
  })

  test('produces output that survives parseCronFile (round-trip)', () => {
    const legacy = {
      jobs: [
        { id: 'a', schedule: '* * * * *', kind: 'prompt', prompt: 'x' },
        { id: 'b', schedule: '0 0 * * *', kind: 'exec', command: ['echo', 'hi'] },
      ],
    }
    const migrated = migrateLegacyCronShape(legacy)
    const parsed = parseCronFile(migrated.json)
    expect(parsed.ok).toBe(true)
  })

  test('is idempotent: a second pass over migrated output reports changed=false', () => {
    const first = migrateLegacyCronShape({
      jobs: [{ id: 'a', schedule: '* * * * *', kind: 'prompt', prompt: 'x' }],
    })
    const second = migrateLegacyCronShape(first.json)
    expect(second.changed).toBe(false)
  })

  test('no-ops on non-object input (defensive — JSON.parse can return arrays/primitives)', () => {
    expect(migrateLegacyCronShape(null).changed).toBe(false)
    expect(migrateLegacyCronShape([]).changed).toBe(false)
    expect(migrateLegacyCronShape('x').changed).toBe(false)
    expect(migrateLegacyCronShape(42).changed).toBe(false)
  })

  test('no-ops when `jobs` is missing or not an array', () => {
    expect(migrateLegacyCronShape({}).changed).toBe(false)
    expect(migrateLegacyCronShape({ jobs: 'oops' }).changed).toBe(false)
    expect(migrateLegacyCronShape({ jobs: null }).changed).toBe(false)
  })

  test('preserves $schema and other top-level fields when rewriting', () => {
    const input = {
      $schema: 'https://example.com/cron.schema.json',
      jobs: [{ id: 'a', schedule: '* * * * *', kind: 'prompt', prompt: 'x' }],
    }
    const result = migrateLegacyCronShape(input)
    expect((result.json as { $schema: string }).$schema).toBe('https://example.com/cron.schema.json')
  })
})

describe('buildCronMigrationCommitMessage', () => {
  test('returns null when no steps applied (do-not-commit signal)', () => {
    expect(buildCronMigrationCommitMessage([])).toBe(null)
  })

  test('produces a single-step subject naming the job count', () => {
    const msg = buildCronMigrationCommitMessage([{ kind: 'stamp-scheduled-by-role-owner', jobIds: ['a', 'b', 'c'] }])
    expect(msg).toContain('cron.json:')
    expect(msg).toContain('3 legacy jobs')
    expect(msg).toContain('a, b, c')
  })

  test('singularizes "job" when only one id', () => {
    const msg = buildCronMigrationCommitMessage([{ kind: 'stamp-scheduled-by-role-owner', jobIds: ['only-one'] }])
    expect(msg).toContain('1 legacy job')
    expect(msg).not.toContain('1 legacy jobs')
  })
})
