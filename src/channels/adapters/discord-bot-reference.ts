import type { InboundReferenceContext, QuoteAnchorSource } from '@/channels/types'

export type DiscordResolvedReference = {
  authorId: string
  authorName: string
  text: string
}

export type DiscordReferenceFetch = (channelId: string, messageId: string) => Promise<DiscordResolvedReference | null>

export type DiscordMessagePointer = {
  channelId: string
  messageId: string
}

export async function enrichDiscordMessageReferences(args: {
  adapter: 'discord' | 'discord-bot'
  text: string
  reply?: DiscordMessagePointer
  fetchMessage: DiscordReferenceFetch
  linkLimit?: number
}): Promise<{ text: string; referenceContext?: InboundReferenceContext }> {
  const sources: QuoteAnchorSource[] = []
  let hasReply = false

  if (args.reply !== undefined) {
    const parent = await fetchSafely(args.fetchMessage, args.reply)
    if (parent !== null) {
      sources.push(toSource(args.adapter, parent))
      hasReply = true
    }
  }

  const links = extractDiscordMessageLinks(args.text).slice(0, args.linkLimit ?? 3)
  for (const link of links) {
    const message = await fetchSafely(args.fetchMessage, link)
    if (message !== null) sources.push(toSource(args.adapter, message))
  }

  if (sources.length === 0) return { text: args.text }
  return { text: args.text, referenceContext: { kind: hasReply ? 'reply' : 'link', sources } }
}

const DISCORD_MESSAGE_LINK = /https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\/(\d+|@me)\/(\d+)\/(\d+)/g

function extractDiscordMessageLinks(text: string): DiscordMessagePointer[] {
  const seen = new Set<string>()
  const links: DiscordMessagePointer[] = []
  for (const match of text.matchAll(DISCORD_MESSAGE_LINK)) {
    const channelId = match[2]
    const messageId = match[3]
    if (channelId === undefined || messageId === undefined) continue
    const key = `${channelId}:${messageId}`
    if (seen.has(key)) continue
    seen.add(key)
    links.push({ channelId, messageId })
  }
  return links
}

async function fetchSafely(
  fetchMessage: DiscordReferenceFetch,
  pointer: DiscordMessagePointer,
): Promise<DiscordResolvedReference | null> {
  try {
    return await fetchMessage(pointer.channelId, pointer.messageId)
  } catch {
    return null
  }
}

function toSource(adapter: 'discord' | 'discord-bot', message: DiscordResolvedReference): QuoteAnchorSource {
  return {
    adapter,
    authorId: message.authorId,
    authorName: message.authorName,
    text: message.text,
  }
}
