import { describe, expect, test } from 'bun:test'

import { channelSchema, matchesAnyChatRule } from './schema'

describe('channelSchema', () => {
  test('parses a discord-bot channel with default chats and enabled', () => {
    const parsed = channelSchema.parse({ adapter: 'discord-bot', bot: 'main' })
    expect(parsed).toEqual({ adapter: 'discord-bot', bot: 'main', chats: ['*'], enabled: true })
  })

  test('accepts the four chat-rule shapes', () => {
    const parsed = channelSchema.parse({
      adapter: 'discord-bot',
      bot: 'main',
      chats: ['*', 'C012ABC', 'T0ABC1234/C012ABC', { workspace: 'W', chat: '*' }, { chat: 'X' }],
    })
    expect(parsed.chats).toHaveLength(5)
  })

  test('rejects a bare chat rule containing "/"', () => {
    expect(() => channelSchema.parse({ adapter: 'discord-bot', bot: 'main', chats: ['a/b/c'] })).toThrow()
  })

  test('rejects unknown adapter', () => {
    expect(() => channelSchema.parse({ adapter: 'slack-bot', bot: 'main' })).toThrow()
  })

  test('rejects empty bot id', () => {
    expect(() => channelSchema.parse({ adapter: 'discord-bot', bot: '' })).toThrow()
  })
})

describe('matchesAnyChatRule', () => {
  test('"*" matches any (workspace, chat)', () => {
    expect(matchesAnyChatRule(['*'], 'W1', 'C1')).toBe(true)
    expect(matchesAnyChatRule(['*'], 'W2', 'C2')).toBe(true)
  })

  test('bare string matches the chat in any workspace', () => {
    expect(matchesAnyChatRule(['C012ABC'], 'W1', 'C012ABC')).toBe(true)
    expect(matchesAnyChatRule(['C012ABC'], 'W2', 'C012ABC')).toBe(true)
    expect(matchesAnyChatRule(['C012ABC'], 'W1', 'OTHER')).toBe(false)
  })

  test('"<workspace>/<chat>" matches only that workspace+chat pair', () => {
    expect(matchesAnyChatRule(['W1/C1'], 'W1', 'C1')).toBe(true)
    expect(matchesAnyChatRule(['W1/C1'], 'W2', 'C1')).toBe(false)
    expect(matchesAnyChatRule(['W1/C1'], 'W1', 'C2')).toBe(false)
  })

  test('structured form with workspace restricts; without workspace matches any', () => {
    expect(matchesAnyChatRule([{ workspace: 'W1', chat: 'C1' }], 'W1', 'C1')).toBe(true)
    expect(matchesAnyChatRule([{ workspace: 'W1', chat: 'C1' }], 'W2', 'C1')).toBe(false)
    expect(matchesAnyChatRule([{ chat: 'C1' }], 'W2', 'C1')).toBe(true)
    expect(matchesAnyChatRule([{ workspace: 'W1', chat: '*' }], 'W1', 'whatever')).toBe(true)
    expect(matchesAnyChatRule([{ workspace: 'W1', chat: '*' }], 'W2', 'whatever')).toBe(false)
  })

  test('rule list is OR — any match admits', () => {
    const rules = ['W1/C1', 'C99']
    expect(matchesAnyChatRule(rules, 'W1', 'C1')).toBe(true)
    expect(matchesAnyChatRule(rules, 'W3', 'C99')).toBe(true)
    expect(matchesAnyChatRule(rules, 'W2', 'OTHER')).toBe(false)
  })

  test('empty rule list admits nothing', () => {
    expect(matchesAnyChatRule([], 'W1', 'C1')).toBe(false)
  })
})
