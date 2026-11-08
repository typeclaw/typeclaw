import { analyzeAgentMessengerCommand } from '@/bundled-plugins/agent-messenger-cli-auth/command'

const CHANNEL_TEXT_KEYS = ['text', 'message', 'content', 'body']

// The texts a tool call would post to a chat. A bot CLI command that
// agent-messenger-cli-auth would lend a channel token to posts its argv as the
// agent, so the audience-leak guards scan those arguments exactly as they scan
// channel_send text; otherwise that bash path would bypass them.
export function outboundTexts(tool: string, args: Record<string, unknown>): string[] {
  if (tool === 'channel_send' || tool === 'channel_reply') {
    return CHANNEL_TEXT_KEYS.map((key) => args[key]).filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    )
  }
  if (tool === 'bash' && typeof args.command === 'string') {
    const decision = analyzeAgentMessengerCommand(args.command)
    if (decision.kind === 'mint') return decision.args.filter((arg) => arg.length > 0)
  }
  return []
}
