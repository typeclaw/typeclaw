// Discord rejects the gateway IDENTIFY with close code 4014 when the bot asks
// for a privileged intent the application hasn't enabled in the Developer
// Portal. The adapter always requests MESSAGE CONTENT, so a missed portal
// toggle leaves a freshly hatched agent silently offline. The application's
// public flags carry the toggle state, and a bot token can read its own
// application, so onboarding can catch this before the container ever starts.

const DISCORD_API_BASE = 'https://discord.com/api/v10'

// https://discord.com/developers/docs/resources/application#application-object-application-flags
// The un-suffixed bit is set for verified apps (100+ servers); the _LIMITED
// bit is the Bot-page toggle for everyone else. Either one means enabled.
const GATEWAY_GUILD_MEMBERS = 1 << 14
const GATEWAY_GUILD_MEMBERS_LIMITED = 1 << 15
const GATEWAY_MESSAGE_CONTENT = 1 << 18
const GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 19

export type DiscordPrivilegedIntent = 'MESSAGE CONTENT' | 'SERVER MEMBERS'

export type DiscordBotIntentCheck =
  | { status: 'ok' }
  | { status: 'missing'; intents: DiscordPrivilegedIntent[] }
  | { status: 'unchecked'; reason: string }

export async function checkDiscordBotIntents(
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<DiscordBotIntentCheck> {
  let flags: unknown
  try {
    const response = await fetchFn(`${DISCORD_API_BASE}/applications/@me`, {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      return {
        status: 'unchecked',
        reason:
          response.status === 401
            ? 'Discord rejected the bot token (401 Unauthorized)'
            : `Discord returned HTTP ${response.status}`,
      }
    }
    flags = ((await response.json()) as { flags?: unknown }).flags
  } catch (err) {
    return { status: 'unchecked', reason: err instanceof Error ? err.message : String(err) }
  }
  if (typeof flags !== 'number') return { status: 'unchecked', reason: 'Discord response had no application flags' }

  const intents: DiscordPrivilegedIntent[] = []
  if ((flags & (GATEWAY_MESSAGE_CONTENT | GATEWAY_MESSAGE_CONTENT_LIMITED)) === 0) intents.push('MESSAGE CONTENT')
  if ((flags & (GATEWAY_GUILD_MEMBERS | GATEWAY_GUILD_MEMBERS_LIMITED)) === 0) intents.push('SERVER MEMBERS')
  return intents.length === 0 ? { status: 'ok' } : { status: 'missing', intents }
}
