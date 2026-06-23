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

  test('lifecycle instance key is adapter plus instance id', () => {
    expect(instanceKeyId('slack-bot', 'default')).toBe('slack-bot:default')
    expect(instanceKeyId('slack-bot', 'b')).toBe('slack-bot:b')
  })
})
