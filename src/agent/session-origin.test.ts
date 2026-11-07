import { describe, expect, test } from 'bun:test'

import {
  MAX_SUBAGENT_DEPTH,
  renderSessionOrigin,
  subagentDepth,
  type ChannelParticipant,
  type SessionOrigin,
} from './session-origin'

describe('subagentDepth', () => {
  test('non-subagent origins are depth 0', () => {
    expect(subagentDepth(undefined)).toBe(0)
    expect(subagentDepth({ kind: 'tui', sessionId: 'ses_root' })).toBe(0)
    expect(subagentDepth({ kind: 'channel', adapter: 'slack-bot', workspace: 'T0', chat: 'C0', thread: null })).toBe(0)
  })

  test('a subagent spawned by a root session is depth 1', () => {
    const origin: SessionOrigin = {
      kind: 'subagent',
      subagent: 'operator',
      parentSessionId: 'ses_root',
      spawnedByOrigin: { kind: 'tui', sessionId: 'ses_root' },
    }
    expect(subagentDepth(origin)).toBe(1)
  })

  test('a subagent spawned by another subagent is depth 2', () => {
    const origin: SessionOrigin = {
      kind: 'subagent',
      subagent: 'operator',
      parentSessionId: 'ses_child',
      spawnedByOrigin: {
        kind: 'subagent',
        subagent: 'reviewer',
        parentSessionId: 'ses_root',
        spawnedByOrigin: { kind: 'tui', sessionId: 'ses_root' },
      },
    }
    expect(subagentDepth(origin)).toBe(MAX_SUBAGENT_DEPTH)
  })

  test('a truncated chain (serialized origin dropped spawnedByOrigin) fails closed at the cap', () => {
    // A subagent origin with no ancestry could be a root-spawned child OR a
    // truncated grandchild; since we cannot tell, fail closed at the cap so it
    // cannot earn an extra spawn it may not be entitled to.
    const origin: SessionOrigin = {
      kind: 'subagent',
      subagent: 'operator',
      parentSessionId: 'ses_child',
    }
    expect(subagentDepth(origin)).toBe(MAX_SUBAGENT_DEPTH)
  })

  test('a cyclic ancestry is capped instead of looping forever', () => {
    const origin = { kind: 'subagent', subagent: 'loop', parentSessionId: 'ses_x' } as SessionOrigin & {
      spawnedByOrigin?: SessionOrigin
    }
    origin.spawnedByOrigin = origin
    expect(subagentDepth(origin)).toBeLessThanOrEqual(MAX_SUBAGENT_DEPTH + 2)
  })
})

describe('renderSessionOrigin', () => {
  test('cron origin includes job id and kind, and tells the agent no human is watching', () => {
    const out = renderSessionOrigin({ kind: 'cron', jobId: 'job-42', jobKind: 'prompt' })
    expect(out).toContain('unattended cron job')
    expect(out).toContain('job-42')
    expect(out).toContain('Job kind: prompt')
    expect(out).toContain('No human is watching this turn')
  })

  test('subagent origin names the subagent', () => {
    const out = renderSessionOrigin({
      kind: 'subagent',
      subagent: 'memory-logger',
      parentSessionId: 'ses_parent',
    })
    expect(out).toContain('`memory-logger` subagent')
    expect(out).toContain('Stay narrowly within')
  })

  test('system origin names the component and shows honest trigger provenance (not a fake TUI)', () => {
    const out = renderSessionOrigin({
      kind: 'system',
      component: 'memory-logger',
      triggeredBy: { kind: 'channel', adapter: 'slack-bot', workspace: 'T0', chat: 'C0', thread: null },
    })
    expect(out).toContain('`memory-logger` system process')
    expect(out).toContain('Triggered by: a Slack channel turn')
    expect(out).not.toContain('TUI session that the operator')
  })

  test('channel origin shows the addressing fields and points at channel_reply by default', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'discord-bot',
      workspace: '111',
      chat: '222',
      thread: null,
    })
    expect(out).toContain('Discord channel session')
    expect(out).toContain('"adapter": "discord-bot"')
    expect(out).toContain('"workspace": "111"')
    expect(out).toContain('"chat": "222"')
    expect(out).toContain('channel_reply')
    expect(out).toContain('channel_send')
    expect(out).toContain('<@USER_ID>')
    expect(out).toContain('Be concise')
  })

  test('channel origin renders thread:null verbatim for channel-root sessions', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'discord-bot',
      workspace: '@dm',
      chat: '999',
      thread: null,
    })
    expect(out).toContain('"thread": null')
    expect(out).toContain('channel-root session')
  })

  test('channel origin includes thread field with the actual id when origin.thread is set', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'discord-bot',
      workspace: '111',
      chat: '222',
      thread: 't-1',
    })
    expect(out).toContain('"thread": "t-1"')
  })

  test('github review-thread origin tells the bot to resolve the thread in the same reply', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'github',
      workspace: 'acme/project',
      chat: 'pr:7',
      thread: '12345',
    })
    // guards the real failure: agent addresses review-comment feedback and ends
    // the turn without resolving, leaving threads open forever
    expect(out).toMatch(/resolve_review_thread: true/)
    expect(out).toMatch(/same call/i)
    expect(out).toMatch(/leaves the thread open|open forever/i)
  })

  test('github top-level (no-thread) origin omits the resolve-thread instruction', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'github',
      workspace: 'acme/project',
      chat: 'pr:7',
      thread: null,
    })
    // a top-level PR/issue comment has no thread to resolve; the flag is a no-op
    expect(out).not.toContain('resolve_review_thread')
  })

  test('plain-text response contract precedes volatile channel addressing and participant data', () => {
    const now = 100_000
    const out = renderSessionOrigin(
      {
        kind: 'channel',
        adapter: 'kakaotalk',
        workspace: 'workspace-1',
        chat: 'chat-1',
        chatName: 'General',
        thread: null,
        membership: { humans: 2, bots: 1, fetchedAt: now, truncated: false },
        participants: [
          {
            authorId: 'user-1',
            authorName: 'Alice',
            firstMessageAt: now - 1000,
            lastMessageAt: now - 1000,
            messageCount: 1,
          },
        ],
      },
      now,
    )
    const contractIndex = out.indexOf('This platform renders messages as PLAIN TEXT')
    expect(contractIndex).toBeGreaterThan(-1)
    expect(contractIndex).toBeLessThan(out.indexOf('Conversation:'))
    expect(contractIndex).toBeLessThan(out.indexOf('"chat": "chat-1"'))
    expect(contractIndex).toBeLessThan(out.indexOf('This channel has 3 members'))
    expect(contractIndex).toBeLessThan(out.indexOf('## Recent participants'))
  })

  test('plain-text response contract reflects outbound attachment support', () => {
    const render = (adapter: 'kakaotalk' | 'line' | 'instagram') =>
      renderSessionOrigin({ kind: 'channel', adapter, workspace: 'workspace-1', chat: 'chat-1', thread: null })

    const kakaotalk = render('kakaotalk')
    expect(kakaotalk).toContain('Attachments can be passed via `attachments[]` on `channel_send`/`channel_reply`.')
    expect(kakaotalk).toContain('Outbound stickers/emoticons are not supported.')
    for (const adapter of ['line', 'instagram'] as const) {
      expect(render(adapter)).toContain(
        'Outbound attachments and stickers are unsupported; send text or a link instead.',
      )
    }
  })

  test.each(['telegram-bot', 'kakaotalk'] as const)(
    'channel origin without reaction support (%s) omits the proactive-reaction guidance',
    (adapter) => {
      const out = renderSessionOrigin({
        kind: 'channel',
        adapter,
        workspace: 'W0',
        chat: 'C0',
        thread: null,
        reactionRef: { adapter, value: 'target' },
      })
      expect(out).not.toMatch(/React like a teammate/i)
      expect(out).not.toMatch(/channel_react/)
    },
  )

  test('channel origin includes reply and send tool references', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'slack-bot',
      workspace: 'T0',
      chat: 'C0',
      thread: '1700000000.000100',
    })
    expect(out).toContain('channel_reply({ text, continue_after_reply })')
    const replyIdx = out.indexOf('`channel_reply`')
    const sendIdx = out.indexOf('`channel_send`')
    expect(replyIdx).toBeGreaterThan(-1)
    expect(sendIdx).toBeGreaterThan(-1)
  })

  test('channel origin renders @dm sentinel verbatim', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'discord-bot',
      workspace: '@dm',
      chat: '999',
      thread: null,
    })
    expect(out).toContain('"workspace": "@dm"')
  })

  test('channel origin includes participants block when participants are fresh', () => {
    const now = Date.now()
    const participants: ChannelParticipant[] = [
      { authorId: '1', authorName: 'alice', firstMessageAt: now - 1000, lastMessageAt: now - 1000, messageCount: 5 },
      { authorId: '2', authorName: 'bob', firstMessageAt: now - 60_000, lastMessageAt: now - 60_000, messageCount: 2 },
    ]
    const out = renderSessionOrigin(
      { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: '999', thread: null, participants },
      now,
    )
    expect(out).toContain('Recent participants')
    expect(out).toContain('alice')
    expect(out).toContain('bob')
    // Format is `<@id> (name)` so the model copies the leading `<@id>` token
    // verbatim when addressing a peer. The old `name (id: 123)` format
    // trained the model that `<@id>` was just rendering chrome.
    expect(out).toContain('<@1> (alice)')
    expect(out).toContain('<@2> (bob)')
    expect(out).not.toContain('alice  (id: 1)')
  })

  test('channel origin includes a concrete worked example for mention syntax', () => {
    // given: a peer bot in the channel
    const now = Date.now()
    const participants: ChannelParticipant[] = [
      {
        authorId: '999',
        authorName: 'Momo',
        firstMessageAt: now - 1000,
        lastMessageAt: now - 1000,
        messageCount: 5,
        isBot: true,
      },
      {
        authorId: '111',
        authorName: 'alice',
        firstMessageAt: now - 1000,
        lastMessageAt: now - 1000,
        messageCount: 5,
      },
    ]

    // when
    const out = renderSessionOrigin(
      { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: '222', thread: null, participants },
      now,
    )

    // then: the example uses the peer bot's real id and name
    expect(out).toContain('<@999> hello')
    expect(out).toContain('Momo')
    expect(out).toContain('Plain-text names do not notify')
  })

  test('channel origin mention example falls back to a placeholder when no participants exist', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'discord-bot',
      workspace: '@dm',
      chat: '999',
      thread: null,
      participants: [],
    })
    expect(out).toContain('<@123456789> hello')
    expect(out).toContain('PeerBot')
  })

  test('channel origin mention example prefers a peer bot over a human participant', () => {
    // The example needs to demonstrate the failure mode — peer-bot addressing —
    // not the human-addressing case which is forgiving in practice.
    const now = Date.now()
    const participants: ChannelParticipant[] = [
      {
        authorId: '111',
        authorName: 'alice',
        firstMessageAt: now - 1000,
        lastMessageAt: now - 1000,
        messageCount: 5,
      },
      {
        authorId: '999',
        authorName: 'Momo',
        firstMessageAt: now - 60_000,
        lastMessageAt: now - 60_000,
        messageCount: 2,
        isBot: true,
      },
    ]
    const out = renderSessionOrigin(
      { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: '222', thread: null, participants },
      now,
    )
    expect(out).toContain('<@999> hello')
    expect(out).not.toContain('<@111> hello')
  })

  test('channel origin sorts participants by recency descending', () => {
    const now = Date.now()
    const participants: ChannelParticipant[] = [
      {
        authorId: '1',
        authorName: 'older',
        firstMessageAt: now - 100_000,
        lastMessageAt: now - 100_000,
        messageCount: 1,
      },
      { authorId: '2', authorName: 'newer', firstMessageAt: now - 1000, lastMessageAt: now - 1000, messageCount: 1 },
    ]
    const out = renderSessionOrigin(
      { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: '999', thread: null, participants },
      now,
    )
    const newerIdx = out.indexOf('newer')
    const olderIdx = out.indexOf('older')
    expect(newerIdx).toBeGreaterThan(-1)
    expect(olderIdx).toBeGreaterThan(-1)
    expect(newerIdx).toBeLessThan(olderIdx)
  })

  test('channel origin caps participants at 10 in the rendered output', () => {
    const now = Date.now()
    const participants: ChannelParticipant[] = []
    for (let i = 0; i < 25; i++) {
      participants.push({
        authorId: String(i),
        authorName: `user${i}`,
        firstMessageAt: now - i * 1000,
        lastMessageAt: now - i * 1000,
        messageCount: 1,
      })
    }
    const out = renderSessionOrigin(
      { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: '999', thread: null, participants },
      now,
    )
    expect(out).toContain('user0')
    expect(out).toContain('user9')
    expect(out).not.toContain('user10')
    expect(out).not.toContain('user24')
  })

  test('channel origin drops participants older than 7 days', () => {
    const now = Date.now()
    const old = now - 8 * 24 * 60 * 60 * 1000
    const participants: ChannelParticipant[] = [
      { authorId: '1', authorName: 'staleuser', firstMessageAt: old, lastMessageAt: old, messageCount: 99 },
    ]
    const out = renderSessionOrigin(
      { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: '999', thread: null, participants },
      now,
    )
    expect(out).not.toContain('staleuser')
    expect(out).not.toContain('Recent participants')
  })

  test('channel origin omits participants block entirely when none are fresh', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'discord-bot',
      workspace: '@dm',
      chat: '999',
      thread: null,
      participants: [],
    })
    expect(out).not.toContain('Recent participants')
    expect(out).toContain('Be concise')
  })

  test('channel origin shows human-readable workspace and chat names alongside raw IDs', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'slack-bot',
      workspace: 'T0ACME',
      workspaceName: 'Acme Corp',
      chat: 'C0DEPLOY',
      chatName: 'deploy',
      thread: null,
    })
    expect(out).toContain('Acme Corp')
    expect(out).toContain('T0ACME')
    expect(out).toContain('#deploy')
    expect(out).toContain('C0DEPLOY')
    expect(out).toContain('"workspace": "T0ACME"')
    expect(out).toContain('"chat": "C0DEPLOY"')
  })

  test('webex channel origin decodes the room ref in prose but keeps the raw id in the origin JSON', () => {
    // base64url of ciscospark://us/ROOM/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
    const roomId = 'Y2lzY29zcGFyazovL3VzL1JPT00vYWFhYWFhYWEtYmJiYi1jY2NjLWRkZGQtZWVlZWVlZWVlZWVl'
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'webex',
      workspace: roomId,
      workspaceName: 'Engineering',
      chat: roomId,
      chatName: 'Standup',
      thread: null,
    })
    // prose conversation line shows the decoded ref, not the base64 blob
    expect(out).toContain('**Standup** (aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee)')
    expect(out).toContain('**Engineering** (aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee)')
    // the canonical origin JSON block keeps the raw base64 id the model copies into tool calls
    expect(out).toContain(`"chat": ${JSON.stringify(roomId)}`)
    expect(out).toContain(`"workspace": ${JSON.stringify(roomId)}`)
  })

  test('webex prose decodes the room ref even when no chatName is resolved', () => {
    // base64url of ciscospark://us/ROOM/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
    const roomId = 'Y2lzY29zcGFyazovL3VzL1JPT00vYWFhYWFhYWEtYmJiYi1jY2NjLWRkZGQtZWVlZWVlZWVlZWVl'
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'webex',
      workspace: roomId,
      workspaceName: 'Engineering',
      chat: roomId,
      thread: null,
    })
    expect(out).toContain('`aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`')
    expect(out).toContain(`"chat": ${JSON.stringify(roomId)}`)
  })

  test('channel origin uses # prefix for Slack channels, bare name for Discord', () => {
    const slackOut = renderSessionOrigin({
      kind: 'channel',
      adapter: 'slack-bot',
      workspace: 'T0',
      workspaceName: 'Acme',
      chat: 'C0',
      chatName: 'general',
      thread: null,
    })
    expect(slackOut).toContain('#general')

    const discordOut = renderSessionOrigin({
      kind: 'channel',
      adapter: 'discord-bot',
      workspace: '111',
      workspaceName: 'Acme Guild',
      chat: '222',
      chatName: 'general',
      thread: null,
    })
    expect(discordOut).toContain('general')
    expect(discordOut).not.toContain('#general')
  })

  test('channel origin renders even when chatName is missing (workspace name only)', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'slack-bot',
      workspace: 'T0',
      workspaceName: 'Acme',
      chat: 'C0',
      thread: null,
    })
    expect(out).toContain('Acme')
    expect(out).toContain('C0')
  })

  test('channel origin emits no malformed name prose when both names are absent', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'discord-bot',
      workspace: '@dm',
      chat: '999',
      thread: null,
    })
    expect(out).not.toMatch(/in \*\*\*\*/)
    expect(out).not.toContain('undefined')
  })

  test('channel origin keeps the @dm workspace sentinel in the JSON block', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'slack-bot',
      workspace: '@dm',
      chat: 'D0DMID',
      thread: null,
    })
    expect(out).toContain('"workspace": "@dm"')
  })

  test('channel origin renders exact Slack membership summary', () => {
    const now = 100_000
    const out = renderSessionOrigin(
      {
        kind: 'channel',
        adapter: 'slack-bot',
        workspace: 'T0',
        chat: 'C0',
        thread: null,
        membership: { humans: 12, bots: 35, fetchedAt: now, truncated: false },
      },
      now,
    )

    expect(out).toContain('This channel has 47 members: 12 humans, 35 bots.')
    expect(out).toContain('The 10 most recent speakers are listed below.')
    expect(out).not.toContain('guild members')
  })

  test('channel origin renders Discord channel-scoped caveat for exact counts', () => {
    const now = 100_000
    const out = renderSessionOrigin(
      {
        kind: 'channel',
        adapter: 'discord-bot',
        workspace: 'G0',
        chat: 'C0',
        thread: null,
        membership: { humans: 12, bots: 35, fetchedAt: now, truncated: false },
      },
      now,
    )

    expect(out).toContain('This channel has 47 members: 12 humans, 35 bots.')
    expect(out).toContain('counts only members who can view this channel')
  })

  test('channel origin renders large-channel truncated summary', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'slack-bot',
      workspace: 'T0',
      chat: 'C0',
      thread: null,
      membership: { humans: 195, bots: 5, fetchedAt: 0, truncated: true },
    })

    expect(out).toContain('approximately 200 members (about 195 humans, 5 bots')
    expect(out).toContain('exceeds the 50-member cap')
  })

  test('channel origin omits the channel-scoped caveat on truncated (history-derived) summaries', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'discord-bot',
      workspace: 'G0',
      chat: 'C0',
      thread: null,
      membership: { humans: 195, bots: 5, fetchedAt: 0, truncated: true },
    })

    expect(out).toContain('approximately 200 members')
    expect(out).not.toContain('counts only members who can view this channel')
  })

  test('channel origin omits member summary when membership is missing', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'slack-bot',
      workspace: 'T0',
      chat: 'C0',
      thread: null,
    })

    expect(out).not.toContain('This channel has')
    expect(out).not.toContain('members:')
  })

  test('TUI origin renders the role block when role context is passed (caller decides when to omit it for owner)', () => {
    const out = renderSessionOrigin({ kind: 'tui', sessionId: 'ses_abc' }, undefined, {
      role: 'guest',
      permissions: [],
    })

    expect(out).toContain('## Your role in this session')
    expect(out).toContain('`guest`')
  })

  test('TUI origin without role context preserves the prior bare rendering', () => {
    const out = renderSessionOrigin({ kind: 'tui', sessionId: 'ses_abc' })

    expect(out).not.toContain('Your role in this session')
    expect(out).toContain('## Session origin')
  })

  test('cron origin appends the role block when role context is provided', () => {
    const out = renderSessionOrigin({ kind: 'cron', jobId: 'job-42', jobKind: 'prompt' }, undefined, {
      role: 'trusted',
      permissions: ['channel.respond', 'cron.schedule', 'security.bypass.secretExfilBash'],
    })

    expect(out).toContain('## Your role in this session')
    expect(out).toContain('`trusted`')
    expect(out).toContain('`channel.respond`')
    expect(out).toContain('`security.bypass.secretExfilBash`')
    expect(out).toContain('typeclaw-permissions')
    expect(out.indexOf('## Session origin')).toBeLessThan(out.indexOf('## Your role in this session'))
  })

  test('channel origin renders the multi-speaker policy block, not the opener’s concrete role', () => {
    const out = renderSessionOrigin(
      {
        kind: 'channel',
        adapter: 'slack-bot',
        workspace: 'T0123',
        chat: 'C0ABCDE',
        thread: null,
      },
      undefined,
      { role: 'member', permissions: ['channel.respond'] },
    )

    expect(out).toContain('## Session origin')
    expect(out).toContain('## Your role in this session')
    expect(out).toContain('multiple speakers')
    expect(out).toContain('<your-role>')
    expect(out.indexOf('Be concise')).toBeLessThan(out.indexOf('## Your role in this session'))
  })

  test('channel role policy does NOT leak the opener’s concrete role or permission list', () => {
    const out = renderSessionOrigin(
      {
        kind: 'channel',
        adapter: 'slack-bot',
        workspace: 'T0123',
        chat: 'C0ABCDE',
        thread: null,
      },
      undefined,
      { role: 'owner', permissions: ['channel.respond', 'cron.schedule', 'security.bypass.secretExfilBash'] },
    )

    expect(out).not.toContain('Role: `owner`')
    expect(out).not.toContain('`security.bypass.secretExfilBash`')
  })

  test('subagent origin renders identically across parent sessions so siblings share a cached prefix', () => {
    const first = renderSessionOrigin({ kind: 'subagent', subagent: 'explorer', parentSessionId: 'ses_a' })
    const second = renderSessionOrigin({ kind: 'subagent', subagent: 'explorer', parentSessionId: 'ses_b' })

    expect(first).toBe(second)
  })

  test('subagent origin appends the role block', () => {
    const out = renderSessionOrigin(
      { kind: 'subagent', subagent: 'memory-logger', parentSessionId: 'ses_parent' },
      undefined,
      { role: 'owner', permissions: ['channel.respond', 'cron.schedule', 'cron.modify'] },
    )

    expect(out).toContain('## Your role in this session')
    expect(out).toContain('`owner`')
  })

  test('non-channel role block renders "none" when the resolved role has no permissions (guest)', () => {
    const out = renderSessionOrigin({ kind: 'cron', jobId: 'job-9', jobKind: 'prompt' }, undefined, {
      role: 'guest',
      permissions: [],
    })

    expect(out).toContain('Role: `guest`. Permissions: none.')
  })

  test('omitting roleContext preserves the pre-existing rendering (no role block)', () => {
    const withoutCtx = renderSessionOrigin({ kind: 'cron', jobId: 'job-x', jobKind: 'prompt' })
    expect(withoutCtx).not.toContain('Your role in this session')
  })

  test('Slack channel origin names Slack as the platform and teaches angle-id mention syntax', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'slack-bot',
      workspace: 'T0',
      chat: 'C0',
      thread: null,
    })
    expect(out).toContain('Slack channel session')
    expect(out).toContain('Slack syntax `<@USER_ID>`')
    expect(out).not.toContain('Discord channel session')
    expect(out).not.toContain('Telegram syntax')
    expect(out).not.toContain('KakaoTalk has no in-band')
  })

  test('Discord channel origin names Discord and teaches angle-id mention syntax', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'discord-bot',
      workspace: '111',
      chat: '222',
      thread: null,
    })
    expect(out).toContain('Discord channel session')
    expect(out).toContain('Discord syntax `<@USER_ID>`')
    expect(out).not.toContain('Slack channel session')
  })

  test('Telegram channel origin names Telegram and teaches @username mention syntax (NOT angle-id)', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'telegram-bot',
      workspace: '-100123',
      chat: '-100123',
      thread: null,
    })
    expect(out).toContain('Telegram channel session')
    expect(out).toContain('Telegram syntax `@username`')
    expect(out).not.toContain('Discord channel session')
    expect(out).not.toContain('Slack syntax')
    expect(out).not.toContain('Discord syntax')
    expect(out).toContain('do not echo them back as outbound mentions')
  })

  test('KakaoTalk channel origin names KakaoTalk and teaches @display-name mention (NOT angle-id)', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'kakaotalk',
      workspace: '@kakao-group',
      chat: '123',
      thread: null,
    })
    expect(out).toContain('KakaoTalk channel session')
    expect(out).toContain('followed by their exact KakaoTalk display name')
    expect(out).not.toContain('Discord channel session')
    expect(out).not.toContain('Slack syntax')
    expect(out).not.toContain('Discord syntax')
    expect(out).not.toContain('Telegram syntax')
    expect(out).toContain('do not echo them back as outbound mentions')
  })

  test.each([
    ['instagram', 'Instagram'],
    ['line', 'LINE'],
  ] as const)('%s channel origin uses its own platform name in alias mention guidance', (adapter, displayName) => {
    const now = Date.now()
    const out = renderSessionOrigin(
      {
        kind: 'channel',
        adapter,
        workspace: 'workspace-1',
        chat: 'chat-1',
        thread: null,
        participants: [
          {
            authorId: 'user-1',
            authorName: 'Alice',
            firstMessageAt: now - 1000,
            lastMessageAt: now - 1000,
            messageCount: 1,
          },
        ],
      },
      now,
    )
    expect(out).toContain(`${displayName} has no in-band mention syntax`)
    expect(out).not.toContain('KakaoTalk')
  })

  test('Slack participants block renders `<@id> (name)` addressing per line (angle-id)', () => {
    const now = Date.now()
    const participants: ChannelParticipant[] = [
      {
        authorId: 'U_ALICE',
        authorName: 'alice',
        firstMessageAt: now - 1000,
        lastMessageAt: now - 1000,
        messageCount: 5,
      },
    ]
    const out = renderSessionOrigin(
      { kind: 'channel', adapter: 'slack-bot', workspace: 'T0', chat: 'C0', thread: null, participants },
      now,
    )
    expect(out).toContain('- <@U_ALICE> (alice) —')
    expect(out).toContain('`<@authorId>` works for any author you have seen')
  })

  test('Telegram participants block renders `name (id)` addressing per line and trailing prose uses `@username`', () => {
    const now = Date.now()
    const participants: ChannelParticipant[] = [
      {
        authorId: '12345',
        authorName: 'alice',
        firstMessageAt: now - 1000,
        lastMessageAt: now - 1000,
        messageCount: 5,
      },
    ]
    const out = renderSessionOrigin(
      { kind: 'channel', adapter: 'telegram-bot', workspace: '-100', chat: '-100', thread: null, participants },
      now,
    )
    expect(out).toContain('- alice (12345) —')
    expect(out).not.toContain('<@12345>')
    expect(out).toContain('`@username`')
    expect(out).toContain('SEPARATE field')
    expect(out).not.toContain('`<@authorId>` works for any author')
  })

  test('KakaoTalk participants block renders `name (id)` addressing per line and trailing prose teaches @display-name addressing', () => {
    const now = Date.now()
    const participants: ChannelParticipant[] = [
      { authorId: 'k_42', authorName: 'alice', firstMessageAt: now - 1000, lastMessageAt: now - 1000, messageCount: 5 },
    ]
    const out = renderSessionOrigin(
      { kind: 'channel', adapter: 'kakaotalk', workspace: '@kakao-group', chat: '123', thread: null, participants },
      now,
    )
    expect(out).toContain('- alice (k_42) —')
    expect(out).not.toContain('<@k_42>')
    expect(out).toContain('mention them as `@` + their display name')
    expect(out).toContain('must not be echoed back')
    expect(out).not.toContain('`<@authorId>` works for any author')
  })

  test('Discord participants block keeps `<@id> (name)` addressing (regression guard for angle-id behavior)', () => {
    const now = Date.now()
    const participants: ChannelParticipant[] = [
      {
        authorId: '999',
        authorName: 'Momo',
        firstMessageAt: now - 1000,
        lastMessageAt: now - 1000,
        messageCount: 5,
        isBot: true,
      },
    ]
    const out = renderSessionOrigin(
      { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: '222', thread: null, participants },
      now,
    )
    expect(out).toContain('- <@999> (Momo) —')
    expect(out).toContain('`<@authorId>` works for any author you have seen')
  })

  test('non-angle-id adapters do not include the angle-id worked example anchored on a real participant', () => {
    // given: a real peer bot participant whose authorId would otherwise be
    // rendered as `<@999> hello` for angle-id adapters
    const now = Date.now()
    const participants: ChannelParticipant[] = [
      {
        authorId: '999',
        authorName: 'Momo',
        firstMessageAt: now - 1000,
        lastMessageAt: now - 1000,
        messageCount: 5,
        isBot: true,
      },
    ]

    // when: KakaoTalk session with the same participant set
    const kakao = renderSessionOrigin(
      { kind: 'channel', adapter: 'kakaotalk', workspace: '@kakao-group', chat: '123', thread: null, participants },
      now,
    )

    // then: the model is told NOT to emit `<@999> hello` and is given KakaoTalk-specific guidance
    expect(kakao).not.toContain('<@999> hello')
    expect(kakao).toContain('`@Momo hello`')

    // when: Telegram session with the same participant set
    const telegram = renderSessionOrigin(
      { kind: 'channel', adapter: 'telegram-bot', workspace: '-100', chat: '-100', thread: null, participants },
      now,
    )

    // then: the model is told NOT to emit `<@999> hello` and is given Telegram-specific guidance
    expect(telegram).not.toContain('<@999> hello')
    expect(telegram).toContain('@username')
  })
})

describe('renderSessionOrigin channel self-identity', () => {
  // Regression: a message addressed to the bot's own id (`<@U0ABFG8TYN7>`)
  // was skipped by the model as "addressed to someone else" because the
  // prompt never told it its own platform id. These assert the self-mention
  // line is present so the model recognizes mentions of itself.
  test('slack origin tells the bot its own <@id> so it recognizes self-mentions', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'slack-bot',
      workspace: 'T0',
      chat: 'C0',
      thread: null,
      self: { id: 'U0ABFG8TYN7' },
    })
    expect(out).toContain('<@U0ABFG8TYN7>')
    expect(out).toMatch(/You are `<@U0ABFG8TYN7>` on this Slack workspace/)
    expect(out).toMatch(/addressed to YOU/)
  })

  test('discord origin surfaces both <@id> and <@!id> self-mention forms', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'discord-bot',
      workspace: '111',
      chat: '222',
      thread: null,
      self: { id: '987654321' },
    })
    expect(out).toContain('<@987654321>')
    expect(out).toContain('<@!987654321>')
  })

  test('telegram origin tells the bot its own @username', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'telegram-bot',
      workspace: '-100',
      chat: '-100',
      thread: null,
      self: { id: '42', username: 'acme_bot' },
    })
    expect(out).toMatch(/You are `@acme_bot` on Telegram/)
    expect(out).toContain('addressed to YOU')
  })

  test('github origin tells the bot its own @login', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'github',
      workspace: 'acme',
      chat: 'acme/repo#1',
      thread: null,
      self: { id: '555', username: 'acme' },
    })
    expect(out).toMatch(/You are `@acme` on GitHub/)
  })

  test('kakaotalk origin renders no self-mention line (tags are by display name, not id)', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'kakaotalk',
      workspace: 'ws',
      chat: 'room',
      thread: null,
      self: { id: 'kakao-self-id' },
    })
    expect(out).not.toContain('addressed to YOU')
    expect(out).not.toContain('kakao-self-id')
  })

  test('omits the self-mention line entirely when identity is unresolved', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'slack-bot',
      workspace: 'T0',
      chat: 'C0',
      thread: null,
    })
    expect(out).not.toContain('addressed to YOU')
  })

  test('telegram with no username omits the self-mention line', () => {
    const out = renderSessionOrigin({
      kind: 'channel',
      adapter: 'telegram-bot',
      workspace: '-100',
      chat: '-100',
      thread: null,
      self: { id: '42' },
    })
    expect(out).not.toContain('addressed to YOU')
  })
})
