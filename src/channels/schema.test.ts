import { describe, expect, test } from 'bun:test'

import { channelsSchema, DEFAULT_GITHUB_EVENT_ALLOWLIST, STICKY_DEFAULT_WINDOW_MS } from './schema'

describe('channelsSchema', () => {
  test('parses an empty channels record', () => {
    const parsed = channelsSchema.parse({})
    expect(parsed['discord-bot']).toBeUndefined()
    expect(parsed['slack-bot']).toBeUndefined()
    expect(parsed['telegram-bot']).toBeUndefined()
    expect(parsed['webex-bot']).toBeUndefined()
    expect(parsed.kakaotalk).toBeUndefined()
  })

  test('parses adapter blocks with engagement defaults applied', () => {
    const parsed = channelsSchema.parse({
      'discord-bot': {},
      'slack-bot': {},
      'telegram-bot': {},
      'webex-bot': {},
      line: {},
      kakaotalk: {},
    })
    for (const id of ['discord-bot', 'slack-bot', 'telegram-bot', 'webex-bot', 'line', 'kakaotalk'] as const) {
      const block = parsed[id]
      if (block === undefined || 'instances' in block) throw new Error(`expected flat config for ${id}`)
      expect(block.enabled).toBe(true)
      expect(block.engagement.trigger).toEqual(['mention', 'reply', 'dm'])
      expect(block.engagement.stickiness).toEqual({
        perReply: { window: STICKY_DEFAULT_WINDOW_MS },
      })
    }
  })

  test('silently strips legacy `allow` field on parse (migration is upstream)', () => {
    const parsed = channelsSchema.parse({
      'slack-bot': { allow: ['team:T0123'] },
    } as unknown as Parameters<typeof channelsSchema.parse>[0])
    expect(parsed['slack-bot']).toBeDefined()
    expect((parsed['slack-bot'] as Record<string, unknown>).allow).toBeUndefined()
  })

  test('accepts engagement.stickiness=off', () => {
    const parsed = channelsSchema.parse({
      'discord-bot': { engagement: { stickiness: 'off' } },
    })
    expect(parsed['discord-bot']?.engagement.stickiness).toBe('off')
  })

  test('clamps engagement.trigger to known triggers', () => {
    expect(() =>
      channelsSchema.parse({ 'discord-bot': { engagement: { trigger: ['username'] } } } as unknown as Parameters<
        typeof channelsSchema.parse
      >[0]),
    ).toThrow()
  })

  test('allows enabled: false', () => {
    const parsed = channelsSchema.parse({ 'discord-bot': { enabled: false } })
    expect(parsed['discord-bot']?.enabled).toBe(false)
  })

  test('parses legacy flat user-mode adapter configs unchanged', () => {
    const parsed = channelsSchema.parse({ slack: { enabled: false } })
    expect(parsed.slack).toEqual({
      enabled: false,
      engagement: {
        trigger: ['mention', 'reply', 'dm'],
        stickiness: { perReply: { window: STICKY_DEFAULT_WINDOW_MS } },
      },
      history: { prefetch: { thread: { head: 3, tail: 10 }, channel: { tail: 10 } } },
      quotedReply: { enabled: true, queueDelayMs: 10_000 },
    })
  })

  test('parses user-mode instances configs with per-entry defaults', () => {
    const parsed = channelsSchema.parse({ slack: { instances: [{ id: 'team-a', account: 'T_A' }, { id: 'team-b' }] } })
    expect(parsed.slack).toEqual({
      instances: [
        {
          id: 'team-a',
          account: 'T_A',
          enabled: true,
          engagement: {
            trigger: ['mention', 'reply', 'dm'],
            stickiness: { perReply: { window: STICKY_DEFAULT_WINDOW_MS } },
          },
          history: { prefetch: { thread: { head: 3, tail: 10 }, channel: { tail: 10 } } },
          quotedReply: { enabled: true, queueDelayMs: 10_000 },
        },
        {
          id: 'team-b',
          enabled: true,
          engagement: {
            trigger: ['mention', 'reply', 'dm'],
            stickiness: { perReply: { window: STICKY_DEFAULT_WINDOW_MS } },
          },
          history: { prefetch: { thread: { head: 3, tail: 10 }, channel: { tail: 10 } } },
          quotedReply: { enabled: true, queueDelayMs: 10_000 },
        },
      ],
    })
  })

  test('keeps bot-token adapters flat only', () => {
    const parsed = channelsSchema.parse({ 'slack-bot': { instances: [{ id: 'ignored' }] } })
    expect((parsed['slack-bot'] as Record<string, unknown>).instances).toBeUndefined()
  })

  test('accepts github channel config with webhookUrl omitted', () => {
    const parsed = channelsSchema.parse({ github: { repos: ['owner/repo'] } })
    expect(parsed.github?.webhookUrl).toBeUndefined()
    expect(parsed.github?.repos).toEqual(['owner/repo'])
  })

  test('accepts github channel config with webhookUrl present', () => {
    const parsed = channelsSchema.parse({
      github: { webhookUrl: 'https://agent.example.com/github', repos: ['owner/repo'] },
    })
    expect(parsed.github?.webhookUrl).toBe('https://agent.example.com/github')
  })

  test('github review.approve defaults to true', () => {
    const parsed = channelsSchema.parse({ github: { repos: ['owner/repo'] } })
    expect(parsed.github?.review.approve).toBe(true)
  })

  test('github review.approve accepts false', () => {
    const parsed = channelsSchema.parse({ github: { repos: ['owner/repo'], review: { approve: false } } })
    expect(parsed.github?.review.approve).toBe(false)
  })

  test('github review defaults to { on: review_requested, approve: true } when omitted', () => {
    const parsed = channelsSchema.parse({ github: { repos: ['owner/repo'] } })
    expect(parsed.github?.review).toEqual({ on: 'review_requested', approve: true })
  })

  test('github review.on defaults to review_requested', () => {
    const parsed = channelsSchema.parse({ github: { repos: ['owner/repo'] } })
    expect(parsed.github?.review.on).toBe('review_requested')
  })

  test('github review.on accepts off', () => {
    const parsed = channelsSchema.parse({ github: { repos: ['owner/repo'], review: { on: 'off' } } })
    expect(parsed.github?.review.on).toBe('off')
  })

  test('github review.on accepts opened', () => {
    const parsed = channelsSchema.parse({ github: { repos: ['owner/repo'], review: { on: 'opened' } } })
    expect(parsed.github?.review.on).toBe('opened')
  })

  test('github review.on rejects unknown values', () => {
    expect(() =>
      channelsSchema.parse({
        github: { repos: ['owner/repo'], review: { on: 'closed' } },
      } as unknown as Parameters<typeof channelsSchema.parse>[0]),
    ).toThrow()
  })

  test('github default eventAllowlist admits pull_request.synchronize (PR-push recheck)', () => {
    const parsed = channelsSchema.parse({ github: { repos: ['owner/repo'] } })
    expect(parsed.github?.eventAllowlist).toEqual([...DEFAULT_GITHUB_EVENT_ALLOWLIST])
    expect(parsed.github?.eventAllowlist).toContain('pull_request.synchronize')
  })
})
