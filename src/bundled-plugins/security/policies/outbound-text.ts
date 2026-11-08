const CHANNEL_TEXT_KEYS = ['text', 'message', 'content', 'body']

export function outboundTexts(tool: string, args: Record<string, unknown>): string[] {
  if (tool === 'channel_send' || tool === 'channel_reply') {
    return CHANNEL_TEXT_KEYS.map((key) => args[key]).filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    )
  }
  return []
}
