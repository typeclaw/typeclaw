import { describe, expect, test } from 'bun:test'

import { instanceKeyId, normalizeChannels } from './instances'
import { defaultHistoryConfig, type ChannelsConfig } from './schema'

const enabledAdapterCfg = () => ({
  enabled: true,
  engagement: {
    trigger: ['mention', 'reply', 'dm'] as Array<'mention' | 'reply' | 'dm'>,
    stickiness: { perReply: { window: 300_000 } },
  },
  history: defaultHistoryConfig(),
})

describe('channel instance normalization', () => {
  test('flat config yields one default instance per configured adapter in adapter order', () => {
    const discordConfig = enabledAdapterCfg()
    const githubConfig = {
      ...enabledAdapterCfg(),
      webhookPort: 0,
      eventAllowlist: ['issue_comment.created'],
      repos: [],
      review: { on: 'review_requested' as const, approve: true },
    }
    const slackConfig = enabledAdapterCfg()
    const cfg: ChannelsConfig = {
      'slack-bot': slackConfig,
      github: githubConfig,
      'discord-bot': discordConfig,
    }

    expect(normalizeChannels(cfg)).toEqual([
      { adapter: 'discord-bot', instanceId: 'default', config: discordConfig },
      { adapter: 'github', instanceId: 'default', config: githubConfig },
      { adapter: 'slack-bot', instanceId: 'default', config: slackConfig },
    ])
  })

  test('absent adapters produce no instances', () => {
    expect(normalizeChannels({})).toEqual([])
  })

  test('instances config yields one instance per entry with adapter config stripped', () => {
    const parsed: ChannelsConfig = {
      slack: {
        instances: [
          { ...enabledAdapterCfg(), id: 'primary', account: 'T_A' },
          { ...enabledAdapterCfg(), id: 'secondary', account: 'T_B', enabled: false },
        ],
      },
    }

    expect(normalizeChannels(parsed)).toEqual([
      { adapter: 'slack', instanceId: 'primary', account: 'T_A', config: enabledAdapterCfg() },
      { adapter: 'slack', instanceId: 'secondary', account: 'T_B', config: { ...enabledAdapterCfg(), enabled: false } },
    ])
  })

  test('duplicate instance ids for one adapter throw clearly', () => {
    const cfg: ChannelsConfig = {
      slack: {
        instances: [
          { ...enabledAdapterCfg(), id: 'same', account: 'T_A' },
          { ...enabledAdapterCfg(), id: 'same', account: 'T_B' },
        ],
      },
    }

    expect(() => normalizeChannels(cfg)).toThrow('Duplicate channel instance id for slack: same')
  })

  test('duplicate account ids for one adapter throw to avoid workspace collisions', () => {
    const cfg: ChannelsConfig = {
      slack: {
        instances: [
          { ...enabledAdapterCfg(), id: 'a', account: 'T_A' },
          { ...enabledAdapterCfg(), id: 'b', account: 'T_A' },
        ],
      },
    }

    expect(() => normalizeChannels(cfg)).toThrow('Duplicate channel account for slack: T_A')
  })

  test('multiple instances all require an explicit account (omitted account throws)', () => {
    const cfg: ChannelsConfig = {
      slack: {
        instances: [
          { ...enabledAdapterCfg(), id: 'a' },
          { ...enabledAdapterCfg(), id: 'b' },
        ],
      },
    }

    expect(() => normalizeChannels(cfg)).toThrow(/must specify "account"/)
  })

  test('an explicit account plus an omitted account throws (implicit current account is ambiguous)', () => {
    const cfg: ChannelsConfig = {
      slack: {
        instances: [
          { ...enabledAdapterCfg(), id: 'a', account: 'T_A' },
          { ...enabledAdapterCfg(), id: 'b' },
        ],
      },
    }

    expect(() => normalizeChannels(cfg)).toThrow(/instance "b" for slack must specify "account"/)
  })

  test('a single instance without account is allowed (resolves to current account)', () => {
    const cfg: ChannelsConfig = {
      slack: { instances: [{ ...enabledAdapterCfg(), id: 'only' }] },
    }

    expect(normalizeChannels(cfg)).toEqual([{ adapter: 'slack', instanceId: 'only', config: enabledAdapterCfg() }])
  })

  test('only slack supports multiple instances; other user-mode adapters reject 2+ entries', () => {
    for (const adapter of ['discord', 'webex', 'kakaotalk', 'line'] as const) {
      const cfg = {
        [adapter]: {
          instances: [
            { ...enabledAdapterCfg(), id: 'a', account: 'acct_a' },
            { ...enabledAdapterCfg(), id: 'b', account: 'acct_b' },
          ],
        },
      } as ChannelsConfig

      expect(() => normalizeChannels(cfg)).toThrow(
        new RegExp(`adapter "${adapter}" does not support multiple instances`),
      )
    }
  })

  test('non-slack user-mode adapters still accept a single instance entry (back-compat)', () => {
    const cfg: ChannelsConfig = {
      discord: { instances: [{ ...enabledAdapterCfg(), id: 'only', account: 'acct_a' }] },
    }

    expect(normalizeChannels(cfg)).toEqual([
      { adapter: 'discord', instanceId: 'only', account: 'acct_a', config: enabledAdapterCfg() },
    ])
  })

  test('non-slack user-mode adapters still accept flat config (back-compat)', () => {
    const flat = enabledAdapterCfg()
    const cfg: ChannelsConfig = { webex: flat }

    expect(normalizeChannels(cfg)).toEqual([{ adapter: 'webex', instanceId: 'default', config: flat }])
  })

  test('lifecycle instance key is adapter plus instance id', () => {
    expect(instanceKeyId('slack-bot', 'default')).toBe('slack-bot:default')
    expect(instanceKeyId('slack-bot', 'b')).toBe('slack-bot:b')
  })
})
