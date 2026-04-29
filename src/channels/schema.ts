import { z } from 'zod'

// Four discriminated forms: "*" (any), bare string (chat in any workspace),
// "<workspace>/<chat>" (workspace-qualified), or a structured object that
// future-proofs additional fields (threads, senders) without re-parsing.
const chatRuleSchema = z.union([
  z.literal('*'),
  z.string().regex(/^[^/]+$/, 'bare chat rule must not contain "/"'),
  z.string().regex(/^[^/]+\/[^/]+$/, 'qualified chat rule must be "<workspace>/<chat>"'),
  z.object({
    workspace: z.string().min(1).optional(),
    chat: z.union([z.string().min(1), z.literal('*')]),
  }),
])

export type ChatRule = z.infer<typeof chatRuleSchema>

// Discord bot channel. v0.1 is discord-bot-only; other adapters land later.
// `bot` is the agent-messenger bot identifier (e.g. "main", "deploy") that
// resolves to a stored credential set. Workspaces (Discord servers/guilds)
// are discovered at runtime — one bot can be installed in N servers.
const discordBotChannelSchema = z.object({
  adapter: z.literal('discord-bot'),
  bot: z.string().min(1),
  chats: z.array(chatRuleSchema).default(['*']),
  enabled: z.boolean().default(true),
})

export type DiscordBotChannel = z.infer<typeof discordBotChannelSchema>

export const channelSchema = z.discriminatedUnion('adapter', [discordBotChannelSchema])

export type Channel = z.infer<typeof channelSchema>

export const channelsArraySchema = z.array(channelSchema).superRefine((channels, ctx) => {
  const seen = new Set<string>()
  for (let i = 0; i < channels.length; i++) {
    const channel = channels[i]
    if (channel === undefined) continue
    const key = `${channel.adapter}|${channel.bot}`
    if (seen.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [i, 'bot'],
        message: `duplicate channel for ${channel.adapter} bot "${channel.bot}"; each (adapter, bot) pair must appear at most once`,
      })
    }
    seen.add(key)
  }
})

// Match a (workspace, chat) tuple against a list of rules. At least one rule
// must match for the event to be admitted. Used at inbound time by the
// adapter, so a `chats: ["*"]` channel auto-subscribes to every workspace
// the bot is in (including ones added at runtime via GUILD_CREATE).
export function matchesAnyChatRule(rules: ChatRule[], workspace: string, chat: string): boolean {
  for (const rule of rules) {
    if (matchesChatRule(rule, workspace, chat)) return true
  }
  return false
}

function matchesChatRule(rule: ChatRule, workspace: string, chat: string): boolean {
  if (rule === '*') return true
  if (typeof rule === 'string') {
    if (rule.includes('/')) {
      const [ruleWorkspace, ruleChat] = rule.split('/', 2)
      return ruleWorkspace === workspace && ruleChat === chat
    }
    return rule === chat
  }
  if (rule.workspace !== undefined && rule.workspace !== workspace) return false
  return rule.chat === '*' || rule.chat === chat
}
