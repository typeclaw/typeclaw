import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ChannelRouter } from '@/channels/router'
import type { AdapterId } from '@/channels/schema'
import type { FetchAttachmentArgs, FetchAttachmentResult, InboundAttachment } from '@/channels/types'

import { createChannelFetchAttachmentTool } from './channel-fetch-attachment'

const origin = { adapter: 'slack-bot' as const, workspace: 'T0ACME', chat: 'C0CHANNEL', thread: null }
const fakeCtx = {} as Parameters<ReturnType<typeof createChannelFetchAttachmentTool>['execute']>[4]

type FakeRouterOptions = {
  attachments?: readonly InboundAttachment[]
  fetch?: (adapter: AdapterId, workspace: string, args: FetchAttachmentArgs) => Promise<FetchAttachmentResult>
}

function makeRouter(options: FakeRouterOptions = {}): ChannelRouter {
  const attachments = options.attachments ?? []
  return {
    route: async () => {},
    send: async () => ({ ok: true }),
    getConsecutiveSendCount: () => 0,
    getSendRate: () => ({ count: 0, windowMs: 0 }),
    registerOutbound: () => {},
    unregisterOutbound: () => {},
    registerConfig: () => {},
    unregisterConfig: () => {},
    registerReaction: () => {},
    unregisterReaction: () => {},
    react: async () => ({ ok: true }),
    registerRemoveReaction: () => {},
    unregisterRemoveReaction: () => {},
    removeReaction: async () => ({ ok: true }),
    registerTyping: () => {},
    unregisterTyping: () => {},
    setTypingCapability: () => {},
    registerChannelNameResolver: () => {},
    unregisterChannelNameResolver: () => {},
    registerSelfIdentity: () => {},
    unregisterSelfIdentity: () => {},
    registerMembership: () => {},
    unregisterMembership: () => {},
    registerHistory: () => {},
    unregisterHistory: () => {},
    fetchHistory: async () => ({ ok: true, messages: [] }),
    registerFetchAttachment: () => {},
    unregisterFetchAttachment: () => {},
    fetchAttachment: options.fetch ?? (async () => ({ ok: false, error: 'not implemented' })),
    registerReviewThreadResolver: () => {},
    unregisterReviewThreadResolver: () => {},
    resolveReviewThread: async () => ({ ok: true }),
    registerReviewStateResolver: () => {},
    unregisterReviewStateResolver: () => {},
    getReviewState: async () => ({ ok: true, selfBlocking: false, approve: true }),
    lookupInboundAttachment: (args) => attachments.find((attachment) => attachment.id === args.id) ?? null,
    listInboundAttachmentIds: () => attachments.map((attachment) => attachment.id),
    registerHistoryAttachments: () => {},
    executeCommand: async () => ({ kind: 'no-live-session' }),
    getSelfAliases: () => [],
    injectSubagentCompletionReminder: () => ({ kind: 'no-live-session' }),
    injectPrVerdictActivity: () => ({ kind: 'delivered', count: 0 }),
    markTurnSkipped: () => ({ kind: 'no-live-session' }),
    clearSticky: () => ({ keyId: '', cleared: 0 }),
    reserveRestartHandoff: () => null,
    resumeRestartHandoff: async () => {},
    stop: async () => {},
    tearDownAllLive: async () => {},
    liveCount: () => 0,
  }
}

async function runTool(
  tool: ReturnType<typeof createChannelFetchAttachmentTool>,
  params: Parameters<ReturnType<typeof createChannelFetchAttachmentTool>['execute']>[1],
) {
  return tool.execute('id', params, undefined, undefined, fakeCtx)
}

describe('channel_fetch_attachment', () => {
  let inboxDir: string

  beforeEach(() => {
    inboxDir = mkdtempSync(join(tmpdir(), 'typeclaw-fetch-attachment-'))
  })

  afterEach(() => {
    rmSync(inboxDir, { recursive: true, force: true })
  })

  test('downloads a looked-up attachment via the adapter callback and writes it to the inbox dir', async () => {
    const calls: Array<{ adapter: AdapterId; args: FetchAttachmentArgs }> = []
    const router = makeRouter({
      attachments: [{ id: 1, kind: 'file', ref: 'F12345', filename: 'diagram.png', mimetype: 'image/png' }],
      fetch: async (adapter, _workspace, args) => {
        calls.push({ adapter, args })
        return {
          ok: true,
          buffer: Buffer.from('hello-bytes'),
          filename: 'diagram.png',
          mimetype: 'image/png',
          size: 11,
        }
      },
    })

    const tool = createChannelFetchAttachmentTool({ router, origin, inboxDir })

    const result = await runTool(tool, { attachment_id: 1 })

    expect(calls).toEqual([{ adapter: 'slack-bot', args: { ref: 'F12345', filename: 'diagram.png' } }])
    expect(result.details).toMatchObject({ ok: true, mimetype: 'image/png', size: 11 })
    const expectedPath = join(inboxDir, 'slack-bot', 'F12345', 'diagram.png')
    expect(result.details?.path).toBe(expectedPath)
    expect(readFileSync(expectedPath, 'utf8')).toBe('hello-bytes')
  })

  test('uses an explicit filename override instead of attachment metadata', async () => {
    const calls: FetchAttachmentArgs[] = []
    const router = makeRouter({
      attachments: [{ id: 1, kind: 'file', ref: 'F1', filename: 'original.bin' }],
      fetch: async (_adapter, _workspace, args) => {
        calls.push(args)
        return { ok: true, buffer: Buffer.from('z'), filename: args.filename ?? 'fallback.bin', size: 1 }
      },
    })

    const tool = createChannelFetchAttachmentTool({ router, origin, inboxDir })
    const result = await runTool(tool, { attachment_id: 1, filename: 'renamed.bin' })

    expect(calls).toEqual([{ ref: 'F1', filename: 'renamed.bin' }])
    expect(result.details?.path).toMatch(/[/\\]renamed\.bin$/)
  })

  test('rejects hallucinated attachment ids with a valid id list', async () => {
    const router = makeRouter({ attachments: [{ id: 2, kind: 'file', ref: 'F2', filename: 'two.txt' }] })
    const tool = createChannelFetchAttachmentTool({ router, origin, inboxDir })

    const result = await runTool(tool, { attachment_id: 1 })

    expect(result.details).toEqual({
      ok: false,
      error:
        'no attachment with id=1 (resolvable attachment_ids: 2). For an attachment from an earlier message, call channel_history first to make it resolvable; otherwise do not invent ids that are not in the inbound message.',
    })
  })

  test('rejects empty-ref attachments with a clear unfetchable-media error', async () => {
    const router = makeRouter({ attachments: [{ id: 1, kind: 'sticker', ref: '', filename: 'party.webp' }] })
    const tool = createChannelFetchAttachmentTool({ router, origin, inboxDir })

    const result = await runTool(tool, { attachment_id: 1 })

    expect(result.details).toEqual({
      ok: false,
      error:
        'attachment #1 (sticker) has no fetchable ref — likely a sticker or an upstream payload without a public URL. Acknowledge the user but do not promise to view it.',
    })
  })

  test('returns the upstream error verbatim when the adapter rejects the resolved ref', async () => {
    const router = makeRouter({
      attachments: [{ id: 1, kind: 'file', ref: 'F-bogus' }],
      fetch: async () => ({ ok: false, error: 'invalid Slack file id: F-bogus' }),
    })

    const tool = createChannelFetchAttachmentTool({ router, origin, inboxDir })
    const result = await runTool(tool, { attachment_id: 1 })

    expect(result.details).toEqual({ ok: false, error: 'invalid Slack file id: F-bogus' })
  })
})
