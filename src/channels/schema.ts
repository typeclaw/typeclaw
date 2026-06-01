import { z } from 'zod'

export const ADAPTER_IDS = ['discord-bot', 'github', 'kakaotalk', 'slack-bot', 'telegram-bot'] as const

export type AdapterId = (typeof ADAPTER_IDS)[number]

const engagementTriggerSchema = z.enum(['mention', 'reply', 'dm'])

const stickinessSchema = z.union([
  z.literal('off'),
  z.object({
    perReply: z.object({
      window: z
        .number()
        .int()
        .min(1)
        .max(24 * 60 * 60_000),
    }),
  }),
])

export const STICKY_DEFAULT_WINDOW_MS = 15 * 60 * 1000

const engagementSchema = z
  .object({
    trigger: z.array(engagementTriggerSchema).default(['mention', 'reply', 'dm']),
    stickiness: stickinessSchema.default({ perReply: { window: STICKY_DEFAULT_WINDOW_MS } }),
  })
  .default({
    trigger: ['mention', 'reply', 'dm'],
    stickiness: { perReply: { window: STICKY_DEFAULT_WINDOW_MS } },
  })

// Cold-start prefetch windows. The router seeds `contextBuffer` once when a
// brand-new channel session is created (no persisted sessionId for the
// (workspace, chat, thread) tuple). Set any field to 0 to disable that side
// of the prefetch. Non-fatal: if the upstream history fetch fails (missing
// scopes, network error, adapter doesn't expose history), the session still
// starts and the agent can call `channel_history` on demand.
//
// Reload semantics: `channels` is `applied` in FIELD_EFFECTS, but prefetch
// only fires at session creation, so changes here only affect the *next*
// cold start; in-flight live sessions are unaffected.
export const PREFETCH_DEFAULTS = {
  thread: { head: 3, tail: 10 },
  channel: { tail: 10 },
} as const

export function defaultHistoryConfig(): {
  prefetch: { thread: { head: number; tail: number }; channel: { tail: number } }
} {
  return {
    prefetch: {
      thread: { head: PREFETCH_DEFAULTS.thread.head, tail: PREFETCH_DEFAULTS.thread.tail },
      channel: { tail: PREFETCH_DEFAULTS.channel.tail },
    },
  }
}

const prefetchWindowSchema = z.number().int().min(0).max(200)

const historySchema = z
  .object({
    prefetch: z
      .object({
        thread: z
          .object({
            head: prefetchWindowSchema.default(PREFETCH_DEFAULTS.thread.head),
            tail: prefetchWindowSchema.default(PREFETCH_DEFAULTS.thread.tail),
          })
          .default({ head: PREFETCH_DEFAULTS.thread.head, tail: PREFETCH_DEFAULTS.thread.tail }),
        channel: z
          .object({
            tail: prefetchWindowSchema.default(PREFETCH_DEFAULTS.channel.tail),
          })
          .default({ tail: PREFETCH_DEFAULTS.channel.tail }),
      })
      .default({
        thread: { head: PREFETCH_DEFAULTS.thread.head, tail: PREFETCH_DEFAULTS.thread.tail },
        channel: { tail: PREFETCH_DEFAULTS.channel.tail },
      }),
  })
  .default({
    prefetch: {
      thread: { head: PREFETCH_DEFAULTS.thread.head, tail: PREFETCH_DEFAULTS.thread.tail },
      channel: { tail: PREFETCH_DEFAULTS.channel.tail },
    },
  })

// Legacy quote-delay knob retained for config compatibility. Quote anchors
// are now driven by channel ordering instead: when another live-observed
// message lands between the inbound and the agent's first reply, the router
// prepends a platform-specific `> author: ...` blockquote line referencing
// the inbound. If nothing intervened, the reply is adjacent enough in the
// channel timeline that it needs no anchor regardless of elapsed wall time.
export const DEFAULT_QUOTED_REPLY_QUEUE_DELAY_MS = 10_000

// Long enough to disambiguate; short enough that a multi-paragraph user
// message doesn't visually dominate the reply.
export const QUOTED_REPLY_EXCERPT_MAX_CHARS = 100

const quotedReplySchema = z
  .object({
    enabled: z.boolean().default(true),
    queueDelayMs: z.number().int().min(0).default(DEFAULT_QUOTED_REPLY_QUEUE_DELAY_MS),
  })
  .default({ enabled: true, queueDelayMs: DEFAULT_QUOTED_REPLY_QUEUE_DELAY_MS })

// Deliberately non-strict: a stale on-disk file may still carry the
// legacy `allow` field (`migrateLegacyConfigShape` lifts it into
// `roles.member.match[]` on load, but a between-reload window can
// briefly contain both). Zod silently drops unknown keys here, which is
// exactly what we want — a hard `.strict()` reject would brick recovery
// for any user mid-migration.
const adapterSchema = z.object({
  engagement: engagementSchema,
  history: historySchema,
  enabled: z.boolean().default(true),
  quotedReply: quotedReplySchema.optional(),
})

export const DEFAULT_GITHUB_EVENT_ALLOWLIST = [
  'issue_comment.created',
  'pull_request_review_comment.created',
  'discussion_comment.created',
  'issues.opened',
  'pull_request.opened',
  'pull_request.review_requested',
  'pull_request.review_request_removed',
  'pull_request.assigned',
  'discussion.created',
  'pull_request_review.submitted',
] as const

const githubChannelSchema = adapterSchema.extend({
  // Optional now (PR 2): when omitted and a `tunnels[]` entry with
  // `for: { kind: 'channel', name: 'github' }` exists, the runtime resolves
  // the URL from the tunnel manager via the adapter's `tunnelUrl` callback.
  // The github adapter skips webhook registration when no effective URL is available.
  webhookUrl: z.string().url().optional(),
  webhookPort: z.number().int().positive().default(8975),
  eventAllowlist: z.array(z.string()).default([...DEFAULT_GITHUB_EVENT_ALLOWLIST]),
  // Repositories whose webhooks the adapter manages. Each entry is an
  // `owner/name` slug. On adapter start(), TypeClaw registers a webhook
  // pointing at webhookUrl for every repo here (idempotent: existing hooks
  // at the same URL are updated). On stop(), every hook TypeClaw created
  // this session is deleted so a restart with a different webhookUrl (e.g.
  // a tunnel reassigning a URL) doesn't leave orphaned hooks on GitHub.
  repos: z.array(z.string()).default([]),
})

// KakaoTalk uses the same shape as every other adapter. There used to be an
// `autoMarkRead` opt-in here; the adapter now fires a LOCO NOTIREAD ack on
// every inbound MSG event unconditionally (see kakaotalk.ts) so the sender's
// unread "1" (노란숫자) clears as soon as the agent observes the message.
// Existing configs with `autoMarkRead: <bool>` continue to parse — Zod's
// default `.object()` strips unknown keys silently — but the field has no
// effect. Risk note: auto-acking every received message is a distinct
// behavioral fingerprint vs a human, so KakaoTalk's abuse detection may
// flag accounts that ack rapidly and unconditionally. Run typeclaw with the
// kakaotalk adapter only on dedicated agent accounts you can afford to lose.
export const channelsSchema = z
  .object({
    'discord-bot': adapterSchema.optional(),
    github: githubChannelSchema.optional(),
    kakaotalk: adapterSchema.optional(),
    'slack-bot': adapterSchema.optional(),
    'telegram-bot': adapterSchema.optional(),
  })
  .default({})

export type EngagementConfig = z.infer<typeof engagementSchema>
export type ChannelAdapterConfig = z.infer<typeof adapterSchema>
type ParsedGithubAdapterConfig = z.infer<typeof githubChannelSchema>
export type GithubAdapterConfig = ParsedGithubAdapterConfig
export type ChannelsConfig = z.infer<typeof channelsSchema>
