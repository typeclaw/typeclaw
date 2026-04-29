import { describe, expect, test } from 'bun:test'

import { channelsSchema, isAllowed } from './schema'

describe('channelsSchema', () => {
  test('empty object is the default', () => {
    expect(channelsSchema.parse({})).toEqual({})
    expect(channelsSchema.parse(undefined)).toEqual({})
  })

  test('discord-bot with explicit allow list parses cleanly', () => {
    expect(channelsSchema.parse({ 'discord-bot': { allow: ['*'] } })).toEqual({
      'discord-bot': { allow: ['*'], enabled: true },
    })
  })

  test('discord-bot with no allow list defaults to empty (admit nothing)', () => {
    expect(channelsSchema.parse({ 'discord-bot': {} })).toEqual({
      'discord-bot': { allow: [], enabled: true },
    })
  })

  test('discord-bot with enabled: false', () => {
    expect(channelsSchema.parse({ 'discord-bot': { enabled: false } })).toEqual({
      'discord-bot': { allow: [], enabled: false },
    })
  })

  test('accepts every supported rule shape', () => {
    const parsed = channelsSchema.parse({
      'discord-bot': {
        allow: [
          '*',
          'guild:*',
          'guild:1234567890',
          'guild:1234567890/9876543210',
          'channel:9876543210',
          'dm:*',
          'dm:5555555555',
        ],
      },
    })
    expect(parsed['discord-bot']?.allow).toHaveLength(7)
  })

  test('rejects malformed rules', () => {
    const cases = [
      'guild:',
      'guild:foo',
      'guild:1234/foo',
      'channel:',
      'channel:abc',
      'dm:',
      'dm:abc',
      'thread:1234',
      'random',
    ]
    for (const rule of cases) {
      expect(() => channelsSchema.parse({ 'discord-bot': { allow: [rule] } })).toThrow()
    }
  })

  test('rejects unknown adapter keys', () => {
    expect(() => channelsSchema.parse({ 'slack-bot': { allow: [] } })).toThrow()
  })
})

describe('isAllowed', () => {
  test('"*" admits everything (guilds and DMs)', () => {
    expect(isAllowed(['*'], 'G1', 'C1')).toBe(true)
    expect(isAllowed(['*'], null, 'D1')).toBe(true)
  })

  test('"guild:*" admits any guild channel but no DMs', () => {
    expect(isAllowed(['guild:*'], 'G1', 'C1')).toBe(true)
    expect(isAllowed(['guild:*'], 'G2', 'C2')).toBe(true)
    expect(isAllowed(['guild:*'], null, 'D1')).toBe(false)
  })

  test('"guild:G1" admits any channel of that guild only', () => {
    expect(isAllowed(['guild:G1'], 'G1', 'C1')).toBe(true)
    expect(isAllowed(['guild:G1'], 'G1', 'C2')).toBe(true)
    expect(isAllowed(['guild:G1'], 'G2', 'C1')).toBe(false)
    expect(isAllowed(['guild:G1'], null, 'D1')).toBe(false)
  })

  test('"guild:G1/C1" admits only that pair', () => {
    expect(isAllowed(['guild:G1/C1'], 'G1', 'C1')).toBe(true)
    expect(isAllowed(['guild:G1/C1'], 'G1', 'C2')).toBe(false)
    expect(isAllowed(['guild:G1/C1'], 'G2', 'C1')).toBe(false)
  })

  test('"channel:C1" admits that channel id regardless of guild', () => {
    expect(isAllowed(['channel:C1'], 'G1', 'C1')).toBe(true)
    expect(isAllowed(['channel:C1'], 'G2', 'C1')).toBe(true)
    expect(isAllowed(['channel:C1'], 'G1', 'C2')).toBe(false)
  })

  test('"dm:*" admits any DM but no guild channels', () => {
    expect(isAllowed(['dm:*'], null, 'D1')).toBe(true)
    expect(isAllowed(['dm:*'], null, 'D2')).toBe(true)
    expect(isAllowed(['dm:*'], 'G1', 'C1')).toBe(false)
  })

  test('"dm:D1" admits only that DM channel', () => {
    expect(isAllowed(['dm:D1'], null, 'D1')).toBe(true)
    expect(isAllowed(['dm:D1'], null, 'D2')).toBe(false)
    expect(isAllowed(['dm:D1'], 'G1', 'D1')).toBe(false)
  })

  test('rule list is OR — any match admits', () => {
    const rules = ['guild:G1', 'dm:*']
    expect(isAllowed(rules, 'G1', 'C1')).toBe(true)
    expect(isAllowed(rules, null, 'D1')).toBe(true)
    expect(isAllowed(rules, 'G2', 'C1')).toBe(false)
  })

  test('empty rule list admits nothing', () => {
    expect(isAllowed([], 'G1', 'C1')).toBe(false)
    expect(isAllowed([], null, 'D1')).toBe(false)
  })
})
