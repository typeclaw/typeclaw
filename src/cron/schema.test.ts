import { describe, expect, test } from 'bun:test'

import { z } from 'zod'

import type { Subagent, SubagentRegistry } from '@/agent/subagents'

import { cronFileSchema, parseCronFile, validateCronEdit } from './schema'

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

  test('accepts a positive per-job timeoutMs override', () => {
    const parsed = cronFileSchema.parse({
      jobs: [{ id: 'j', schedule: '* * * * *', kind: 'prompt', prompt: 'x', timeoutMs: 7_200_000 }],
    })
    expect(parsed.jobs[0]?.timeoutMs).toBe(7_200_000)
  })

  test('rejects a non-positive or fractional timeoutMs', () => {
    expect(() =>
      cronFileSchema.parse({ jobs: [{ id: 'j', schedule: '* * * * *', kind: 'prompt', prompt: 'x', timeoutMs: 0 }] }),
    ).toThrow()
    expect(() =>
      cronFileSchema.parse({ jobs: [{ id: 'j', schedule: '* * * * *', kind: 'prompt', prompt: 'x', timeoutMs: 1.5 }] }),
    ).toThrow()
  })

  test('accepts the largest safe timer delay and rejects an overflowing timeoutMs', () => {
    const maximum = 2_147_483_647
    expect(() =>
      cronFileSchema.parse({
        jobs: [{ id: 'j', schedule: '* * * * *', kind: 'prompt', prompt: 'x', timeoutMs: maximum }],
      }),
    ).not.toThrow()
    expect(() =>
      cronFileSchema.parse({
        jobs: [{ id: 'j', schedule: '* * * * *', kind: 'prompt', prompt: 'x', timeoutMs: maximum + 1 }],
      }),
    ).toThrow(/timeoutMs must be at most 2147483647/)
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

  test("rejects kind: 'handler' in user-authored cron.json (handlers are plugin-only)", () => {
    const result = parseCronFile({
      jobs: [
        {
          id: 'j',
          schedule: '* * * * *',
          kind: 'handler',
          scheduledByRole: 'owner',
        },
      ],
    })
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/kind/)
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

describe('parseCronFile timing boundaries (until / at / count)', () => {
  const NOW = new Date('2026-06-08T00:00:00Z').getTime()
  const FUTURE = '2026-06-12T00:00:00Z'
  const PAST = '2020-01-01T00:00:00Z'

  const job = (extra: Record<string, unknown>) => ({
    id: 'j',
    kind: 'prompt' as const,
    prompt: 'x',
    scheduledByRole: 'owner',
    ...extra,
  })

  test('accepts a recurring job with a future "until"', () => {
    const result = parseCronFile({ jobs: [job({ schedule: '0 9 * * *', until: FUTURE })] }, { now: NOW })
    if (!result.ok) throw new Error(result.reason)
    expect(result.file.jobs[0]?.until).toBe(FUTURE)
  })

  test('accepts a recurring job with a positive "count"', () => {
    const result = parseCronFile({ jobs: [job({ schedule: '0 9 * * *', count: 3 })] }, { now: NOW })
    if (!result.ok) throw new Error(result.reason)
    expect(result.file.jobs[0]?.count).toBe(3)
  })

  test('accepts a one-shot "at" job', () => {
    const result = parseCronFile({ jobs: [job({ at: FUTURE })] }, { now: NOW })
    if (!result.ok) throw new Error(result.reason)
    expect(result.file.jobs[0]?.at).toBe(FUTURE)
  })

  test('rejects a job with neither schedule nor at', () => {
    const result = parseCronFile({ jobs: [job({})] }, { now: NOW })
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/exactly one of "schedule".*"at"/)
  })

  test('rejects a job with both schedule and at', () => {
    const result = parseCronFile({ jobs: [job({ schedule: '0 9 * * *', at: FUTURE })] }, { now: NOW })
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/exactly one of/)
  })

  test('load mode accepts a past "at" so a fired one-shot does not brick cron.json on reload', () => {
    const enabled = parseCronFile({ jobs: [job({ at: PAST })] }, { now: NOW, mode: 'load' })
    if (!enabled.ok) throw new Error(enabled.reason)
    expect(enabled.file.jobs[0]?.at).toBe(PAST)

    const disabled = parseCronFile({ jobs: [job({ at: PAST, enabled: false })] }, { now: NOW, mode: 'load' })
    if (!disabled.ok) throw new Error(disabled.reason)
  })

  test('load is the default mode (a past "at" still parses)', () => {
    const result = parseCronFile({ jobs: [job({ at: PAST })] }, { now: NOW })
    if (!result.ok) throw new Error(result.reason)
  })

  test('edit mode rejects a newly-scheduled enabled past "at"', () => {
    const result = parseCronFile({ jobs: [job({ at: PAST })] }, { now: NOW, mode: 'edit' })
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/past/)
  })

  test('edit mode still accepts a disabled past "at" (an intentional tombstone)', () => {
    const result = parseCronFile({ jobs: [job({ at: PAST, enabled: false })] }, { now: NOW, mode: 'edit' })
    if (!result.ok) throw new Error(result.reason)
  })

  test('edit mode accepts a future "at"', () => {
    const result = parseCronFile({ jobs: [job({ at: FUTURE })] }, { now: NOW, mode: 'edit' })
    if (!result.ok) throw new Error(result.reason)
  })

  test('edit mode rejects "until" in the past for an enabled job', () => {
    const result = parseCronFile({ jobs: [job({ schedule: '0 9 * * *', until: PAST })] }, { now: NOW, mode: 'edit' })
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/past/)
  })

  test('load mode tolerates a past "until" so an expired recurring job does not brick cron.json on reload', () => {
    const result = parseCronFile({ jobs: [job({ schedule: '0 9 * * *', until: PAST })] }, { now: NOW, mode: 'load' })
    if (!result.ok) throw new Error(result.reason)
    expect(result.file.jobs[0]?.until).toBe(PAST)
  })

  test('load is the default mode (a past "until" still parses)', () => {
    const result = parseCronFile({ jobs: [job({ schedule: '0 9 * * *', until: PAST })] }, { now: NOW })
    if (!result.ok) throw new Error(result.reason)
  })

  test('edit mode rejects "until" before the first occurrence', () => {
    const result = parseCronFile(
      { jobs: [job({ schedule: '0 9 1 1 *', until: '2026-06-09T00:00:00Z' })] },
      { now: NOW, mode: 'edit' },
    )
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/no occurrence/)
  })

  test('load mode tolerates "until" before the first occurrence (job is inert, scheduler retires it)', () => {
    const result = parseCronFile(
      { jobs: [job({ schedule: '0 9 1 1 *', until: '2026-06-09T00:00:00Z' })] },
      { now: NOW, mode: 'load' },
    )
    if (!result.ok) throw new Error(result.reason)
  })

  test('edit mode still accepts a disabled past "until" (an intentional tombstone)', () => {
    const result = parseCronFile(
      { jobs: [job({ schedule: '0 9 * * *', until: PAST, enabled: false })] },
      { now: NOW, mode: 'edit' },
    )
    if (!result.ok) throw new Error(result.reason)
  })

  test('rejects an "at" without an explicit zone (local-time ambiguity)', () => {
    const result = parseCronFile({ jobs: [job({ at: '2026-06-12T09:00:00' })] }, { now: NOW })
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/explicit zone/)
  })

  test('accepts an "at" with a numeric offset', () => {
    const result = parseCronFile({ jobs: [job({ at: '2026-06-12T09:00:00+09:00' })] }, { now: NOW })
    if (!result.ok) throw new Error(result.reason)
  })

  test('rejects "until" or "timezone" on a one-shot "at" job', () => {
    const withUntil = parseCronFile({ jobs: [job({ at: FUTURE, until: FUTURE })] }, { now: NOW })
    if (withUntil.ok) throw new Error('expected failure')
    expect(withUntil.reason).toMatch(/"until" is only valid with "schedule"/)

    const withTz = parseCronFile({ jobs: [job({ at: FUTURE, timezone: 'UTC' })] }, { now: NOW })
    if (withTz.ok) throw new Error('expected failure')
    expect(withTz.reason).toMatch(/"timezone" is only valid with "schedule"/)
  })

  test('rejects count > 1 on a one-shot "at" job', () => {
    const result = parseCronFile({ jobs: [job({ at: FUTURE, count: 2 })] }, { now: NOW })
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toMatch(/only set "count": 1/)
  })

  test('rejects a non-positive or non-integer count via schema', () => {
    expect(parseCronFile({ jobs: [job({ schedule: '0 9 * * *', count: 0 })] }, { now: NOW }).ok).toBe(false)
    expect(parseCronFile({ jobs: [job({ schedule: '0 9 * * *', count: 1.5 })] }, { now: NOW }).ok).toBe(false)
  })

  test('accepts until + count together on one recurring job', () => {
    const result = parseCronFile({ jobs: [job({ schedule: '0 9 * * *', until: FUTURE, count: 5 })] }, { now: NOW })
    if (!result.ok) throw new Error(result.reason)
  })
})

describe('parseCronFile boot mode (per-job isolation)', () => {
  const good = (id: string) => ({
    id,
    schedule: '* * * * *',
    kind: 'prompt' as const,
    prompt: 'x',
    scheduledByRole: 'owner',
  })

  test('skips a job with an invalid cron expression and keeps the valid ones', () => {
    const result = parseCronFile(
      {
        jobs: [
          good('a'),
          { id: 'bad', schedule: 'not-a-cron', kind: 'prompt', prompt: 'x', scheduledByRole: 'owner' },
          good('b'),
        ],
      },
      { mode: 'boot' },
    )
    if (!result.ok) throw new Error('expected boot mode to isolate, not fail the whole file')
    expect(result.file.jobs.map((j) => j.id)).toEqual(['a', 'b'])
    expect(result.warnings?.map((w) => w.jobId)).toContain('bad')
    expect(result.warnings?.[0]?.reason).toMatch(/not-a-cron/)
  })

  test('skips a job missing scheduledByRole and keeps the valid ones', () => {
    const result = parseCronFile(
      { jobs: [good('a'), { id: 'legacy', schedule: '* * * * *', kind: 'prompt', prompt: 'x' }] },
      { mode: 'boot' },
    )
    if (!result.ok) throw new Error(result.reason)
    expect(result.file.jobs.map((j) => j.id)).toEqual(['a'])
    expect(result.warnings?.some((w) => w.jobId === 'legacy' && /scheduledByRole/.test(w.reason))).toBe(true)
  })

  test('keeps the first occurrence of a duplicate id and warns on the later one', () => {
    const result = parseCronFile(
      {
        jobs: [
          { id: 'dup', schedule: '* * * * *', kind: 'prompt', prompt: 'first', scheduledByRole: 'owner' },
          { id: 'dup', schedule: '0 * * * *', kind: 'prompt', prompt: 'second', scheduledByRole: 'owner' },
        ],
      },
      { mode: 'boot' },
    )
    if (!result.ok) throw new Error(result.reason)
    expect(result.file.jobs).toHaveLength(1)
    const kept = result.file.jobs[0]
    if (!kept || kept.kind !== 'prompt') throw new Error('expected a prompt job')
    expect(kept.prompt).toBe('first')
    expect(result.warnings?.some((w) => w.jobId === 'dup' && /duplicate/i.test(w.reason))).toBe(true)
  })

  test('tolerates an expired "until" job without a warning (inert, not invalid)', () => {
    const NOW = new Date('2026-06-08T00:00:00Z').getTime()
    const result = parseCronFile(
      { jobs: [{ ...good('expired'), schedule: '0 9 * * *', until: '2020-01-01T00:00:00Z' }] },
      { mode: 'boot', now: NOW },
    )
    if (!result.ok) throw new Error(result.reason)
    expect(result.file.jobs.map((j) => j.id)).toEqual(['expired'])
    expect(result.warnings ?? []).toHaveLength(0)
  })

  test('a fully valid file in boot mode produces no warnings', () => {
    const result = parseCronFile({ jobs: [good('a'), good('b')] }, { mode: 'boot' })
    if (!result.ok) throw new Error(result.reason)
    expect(result.file.jobs.map((j) => j.id)).toEqual(['a', 'b'])
    expect(result.warnings ?? []).toHaveLength(0)
  })

  test('still hard-fails on a top-level schema violation (not a per-job error)', () => {
    const result = parseCronFile(
      { jobs: [{ id: 'bad id with spaces', schedule: '* * * * *', kind: 'prompt', prompt: 'x' }] },
      { mode: 'boot' },
    )
    if (result.ok) throw new Error('expected top-level schema failure')
    expect(result.reason).toMatch(/id/i)
  })

  test('load mode stays strict: one bad job fails the whole file (unchanged contract)', () => {
    const result = parseCronFile(
      {
        jobs: [good('a'), { id: 'bad', schedule: 'not-a-cron', kind: 'prompt', prompt: 'x', scheduledByRole: 'owner' }],
      },
      { mode: 'load' },
    )
    if (result.ok) throw new Error('load mode must remain strict')
    expect(result.reason).toMatch(/not-a-cron/)
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

describe('validateCronEdit (authoring-delta timing)', () => {
  const NOW = new Date('2026-06-08T00:00:00Z').getTime()
  const PAST = '2020-01-01T00:00:00Z'

  const jobJson = (extra: Record<string, unknown>): Record<string, unknown> => ({
    id: 'j',
    kind: 'prompt',
    prompt: 'x',
    scheduledByRole: 'owner',
    ...extra,
  })
  const file = (...jobs: Record<string, unknown>[]): string => JSON.stringify({ jobs })

  test('tolerates a stale until carried over unchanged from the baseline', () => {
    const stale = jobJson({ id: 'expired', schedule: '0 9 * * *', until: PAST })
    const existing = file(stale)
    const result = validateCronEdit(existing, existing, { now: NOW })
    expect(result.ok).toBe(true)
  })

  test('allows removing a stale job (proposed omits it)', () => {
    const stale = jobJson({ id: 'expired', schedule: '0 9 * * *', until: PAST })
    const fresh = jobJson({ id: 'fresh', schedule: '0 10 * * *' })
    const result = validateCronEdit(file(fresh), file(stale, fresh), { now: NOW })
    expect(result.ok).toBe(true)
  })

  test('blocks a newly-added job with a past until', () => {
    const fresh = jobJson({ id: 'fresh', schedule: '0 10 * * *' })
    const newStale = jobJson({ id: 'new-expired', schedule: '0 9 * * *', until: PAST })
    const result = validateCronEdit(file(fresh, newStale), file(fresh), { now: NOW })
    if (result.ok) throw new Error('expected block')
    expect(result.reason).toContain('past')
  })

  test('blocks re-timing an existing job into the past', () => {
    const fresh = jobJson({ id: 'j', schedule: '0 10 * * *' })
    const reTimed = jobJson({ id: 'j', schedule: '0 10 * * *', until: PAST })
    const result = validateCronEdit(file(reTimed), file(fresh), { now: NOW })
    if (result.ok) throw new Error('expected block')
    expect(result.reason).toContain('past')
  })

  test('treats every job as new when no baseline is provided (fail closed)', () => {
    const stale = jobJson({ schedule: '0 9 * * *', until: PAST })
    const result = validateCronEdit(file(stale), undefined, { now: NOW })
    if (result.ok) throw new Error('expected block')
    expect(result.reason).toContain('past')
  })

  test('treats every job as new when the baseline is unparseable (fail closed)', () => {
    const stale = jobJson({ schedule: '0 9 * * *', until: PAST })
    const result = validateCronEdit(file(stale), 'not json', { now: NOW })
    if (result.ok) throw new Error('expected block')
    expect(result.reason).toContain('past')
  })

  test('still reports structural errors in the proposed content', () => {
    const bad = jobJson({ schedule: 'bogus' })
    const result = validateCronEdit(file(bad), undefined, { now: NOW })
    if (result.ok) throw new Error('expected block')
    expect(result.reason).toContain('bogus')
  })
})
