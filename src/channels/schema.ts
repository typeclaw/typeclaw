import { z } from 'zod'

// Allow-rule grammar:
//   "*"                      — all guilds + all DMs (FIXME: too broad as a single
//                              token; consider splitting into "guild:*" + "dm:*"
//                              before v0.1 ships, since accidental "*" sweeps in
//                              private 1:1 conversations).
//   "guild:*"                — every channel of every guild the bot is in.
//   "guild:GUILD_ID"         — every channel of that one guild.
//   "guild:GUILD_ID/CHANNEL_ID" — one specific channel inside that guild.
//   "channel:CHANNEL_ID"     — that channel id in any guild it appears in.
//                              Works because Discord channel IDs are globally
//                              unique snowflakes.
//   "dm:*"                   — every DM channel the bot has open.
//   "dm:CHANNEL_ID"          — one specific DM channel.
const idPattern = String.raw`\d+`
const allowRuleSchema = z.union([
  z.literal('*'),
  z
    .string()
    .regex(
      new RegExp(`^guild:(\\*|${idPattern}(/${idPattern})?)$`),
      'guild rule must be "guild:*", "guild:<id>", or "guild:<id>/<id>"',
    ),
  z.string().regex(new RegExp(`^channel:${idPattern}$`), 'channel rule must be "channel:<id>"'),
  z.string().regex(new RegExp(`^dm:(\\*|${idPattern})$`), 'dm rule must be "dm:*" or "dm:<id>"'),
])

export type AllowRule = z.infer<typeof allowRuleSchema>

const discordBotConfigSchema = z.object({
  allow: z.array(allowRuleSchema).default([]),
  enabled: z.boolean().default(true),
})

export type DiscordBotConfig = z.infer<typeof discordBotConfigSchema>

export const channelsSchema = z
  .object({
    'discord-bot': discordBotConfigSchema.optional(),
  })
  .strict()
  .default({})

export type Channels = z.infer<typeof channelsSchema>

// Match an inbound event against an allow list. The event is described by the
// (guildId, channelId) pair from the SDK; guildId is null for DMs.
export function isAllowed(rules: AllowRule[], guildId: string | null, channelId: string): boolean {
  for (const rule of rules) {
    if (matchesRule(rule, guildId, channelId)) return true
  }
  return false
}

function matchesRule(rule: AllowRule, guildId: string | null, channelId: string): boolean {
  if (rule === '*') return true
  if (rule.startsWith('guild:')) {
    if (guildId === null) return false
    const tail = rule.slice('guild:'.length)
    if (tail === '*') return true
    const slash = tail.indexOf('/')
    if (slash === -1) return tail === guildId
    return tail.slice(0, slash) === guildId && tail.slice(slash + 1) === channelId
  }
  if (rule.startsWith('channel:')) {
    return rule.slice('channel:'.length) === channelId
  }
  if (rule.startsWith('dm:')) {
    if (guildId !== null) return false
    const tail = rule.slice('dm:'.length)
    return tail === '*' || tail === channelId
  }
  return false
}
