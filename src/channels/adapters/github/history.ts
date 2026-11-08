import type { ChannelHistoryMessage, FetchHistoryArgs, FetchHistoryResult, HistoryCallback } from '@/channels/types'

import { describeError } from '../../describe-error'
import type { GithubAuthContext } from './auth'
import { GITHUB_API_BASE, githubJsonHeaders } from './auth-pat'
import { parseChat, parseRepo } from './outbound'

// Repos that have delivered an inbound, per chat id. A chat id like `pr:12`
// exists in every repo, so a read names its repo explicitly; without one it
// resolves only when a single repo is known for that chat, never by recency,
// so one conversation's read can't land in another repo's thread.
export function createChatWorkspaceIndex() {
  const workspacesByChat = new Map<string, Set<string>>()
  return {
    remember(workspace: string, chat: string): void {
      const known = workspacesByChat.get(chat)
      if (known === undefined) workspacesByChat.set(chat, new Set([workspace]))
      else known.add(workspace)
    },
    resolve(chat: string, workspace?: string): string | null {
      const known = workspacesByChat.get(chat)
      if (known === undefined) return null
      if (workspace !== undefined) return known.has(workspace) ? workspace : null
      return known.size === 1 ? [...known][0]! : null
    },
  }
}

export function createGithubHistoryCallback(options: {
  token: (context?: GithubAuthContext) => Promise<string>
  workspaceForChat: (chat: string, workspace?: string) => string | null
  fetchImpl?: typeof fetch
}): HistoryCallback {
  const fetchImpl = options.fetchImpl ?? fetch
  return async (args: FetchHistoryArgs): Promise<FetchHistoryResult> => {
    const workspace = options.workspaceForChat(args.chat, args.workspace)
    if (workspace === null)
      return { ok: false, error: 'github history unavailable until this chat receives an inbound' }
    const repo = parseRepo(workspace)
    const chat = parseChat(args.chat)
    if (repo === null || chat === null) return { ok: false, error: 'invalid github history target' }
    if (chat.kind === 'discussion') return { ok: false, error: 'github discussion history not supported yet' }
    const endpoint =
      chat.kind === 'pr' && args.thread !== null
        ? `${GITHUB_API_BASE}/repos/${repo.owner}/${repo.name}/pulls/${chat.number}/comments`
        : `${GITHUB_API_BASE}/repos/${repo.owner}/${repo.name}/issues/${chat.number}/comments`
    try {
      const cursor = args.cursor !== undefined && args.cursor !== '' ? `&page=${encodeURIComponent(args.cursor)}` : ''
      const response = await fetchImpl(
        `${endpoint}?per_page=${Math.min(Math.max(args.limit, 1), 100)}&direction=desc${cursor}`,
        {
          headers: githubJsonHeaders(await options.token({ repoSlug: workspace })),
        },
      )
      if (!response.ok) return { ok: false, error: `GitHub history ${response.status}` }
      const raw = (await response.json()) as GithubComment[]
      const link = response.headers.get('link') ?? ''
      const nextCursor = /[?&]page=(\d+)[^>]*>; rel="next"/.exec(link)?.[1]
      return nextCursor !== undefined
        ? { ok: true, messages: raw.map(mapComment), nextCursor }
        : { ok: true, messages: raw.map(mapComment) }
    } catch (err) {
      return { ok: false, error: describeError(err) }
    }
  }
}

type GithubComment = {
  id: number
  body?: string
  created_at?: string
  user?: { id?: number; login?: string; type?: string }
}

function mapComment(comment: GithubComment): ChannelHistoryMessage {
  const login = comment.user?.login ?? 'unknown'
  return {
    externalMessageId: String(comment.id),
    authorId: String(comment.user?.id ?? login),
    authorName: login,
    text: comment.body ?? '',
    ts: comment.created_at !== undefined ? Date.parse(comment.created_at) || 0 : 0,
    isBot: comment.user?.type === 'Bot',
    replyToBotMessageId: null,
  }
}
