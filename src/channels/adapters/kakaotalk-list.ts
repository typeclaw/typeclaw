import { classifyKakaoChat, type KakaoChat } from 'agent-messenger/kakaotalk'

import type { ChannelListEntry, ListCallback, ListChannelsArgs, ListChannelsResult } from '@/channels/types'

import { describeError } from '../describe-error'
import type { KakaoTalkClient } from './kakaotalk'
import { kakaoWorkspaceForType, type KakaoWorkspace } from './kakaotalk-channel-resolver'

const KAKAO_WORKSPACES: readonly KakaoWorkspace[] = ['@kakao-dm', '@kakao-group', '@kakao-open']

// KakaoTalk has no server-side workspace: typeclaw buckets every chat into one
// of three synthetic workspaces by chat kind, and a later channel_send must
// name the same bucket. So the list is scoped to one bucket — returning every
// chat under an arbitrary workspace would hand back chat ids the agent cannot
// address. getChats has no paging, so the cursor is an offset into its result.
export function createKakaoListCallback(deps: {
  client: Pick<KakaoTalkClient, 'getChats'>
  logger: { warn: (msg: string) => void }
}): ListCallback {
  return async (args: ListChannelsArgs): Promise<ListChannelsResult> => {
    if (!isKakaoWorkspace(args.workspace)) {
      return {
        ok: false,
        error: `unknown kakaotalk workspace "${args.workspace}"; use one of ${KAKAO_WORKSPACES.join(', ')}`,
      }
    }
    let chats: KakaoChat[]
    try {
      // Without resolveTitles the SDK leaves `title` null, and a named room
      // would only show its member names, so the agent couldn't find it by name.
      chats = await deps.client.getChats({ all: true, resolveTitles: true })
    } catch (err) {
      const message = describeError(err)
      deps.logger.warn(`[kakaotalk] chat list failed: ${message}`)
      return { ok: false, error: message }
    }
    const inWorkspace = chats.filter((c) => kakaoWorkspaceForType(classifyKakaoChat(c)) === args.workspace)
    const offset = parseOffset(args.cursor)
    const end = offset + Math.max(1, args.limit)
    const entries = inWorkspace.slice(offset, end).map(toListEntry)
    return end < inWorkspace.length ? { ok: true, entries, nextCursor: String(end) } : { ok: true, entries }
  }
}

function isKakaoWorkspace(workspace: string): workspace is KakaoWorkspace {
  return (KAKAO_WORKSPACES as readonly string[]).includes(workspace)
}

function parseOffset(cursor: string | undefined): number {
  const n = cursor === undefined ? 0 : Number.parseInt(cursor, 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function toListEntry(chat: KakaoChat): ChannelListEntry {
  const kind = classifyKakaoChat(chat)
  return {
    chat: chat.chat_id,
    name: chat.title ?? chat.display_name ?? chat.chat_id,
    kind: kind === 'dm' ? 'dm' : 'group',
    isMember: true,
  }
}
