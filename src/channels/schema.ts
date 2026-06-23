import { z } from 'zod'

export const ADAPTER_IDS = [
  'discord',
  'discord-bot',
  'github',
  'line',
  'kakaotalk',
  'slack',
  'slack-bot',
  'telegram-bot',
  'webex',
  'webex-bot',
] as const

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
// legacy `allow` field. Zod silently drops unknown keys here, which is
// exactly what we want — the field is ignored, not translated, and a hard
// `.strict()` reject would brick recovery for any user with an old config.
const adapterSchema = z.object({
  engagement: engagementSchema,
  history: historySchema,
  enabled: z.boolean().default(true),
  quotedReply: quotedReplySchema.optional(),
})

const instanceConfigSchema = adapterSchema.extend({
  id: z.string().min(1),
  account: z.string().optional(),
})

const multiInstanceSchema = z.object({
  instances: z.array(instanceConfigSchema),
})

const userModeAdapterSchema = z.union([multiInstanceSchema, adapterSchema])

export function defaultChannelAdapterConfig(): ChannelAdapterConfig {
  return adapterSchema.parse({})
}

export const DEFAULT_GITHUB_EVENT_ALLOWLIST = [
  'issue_comment.created',
  'pull_request_review_comment.created',
  'discussion_comment.created',
  'issues.opened',
  'pull_request.opened',
  'pull_request.ready_for_review',
  'pull_request.review_requested',
  'pull_request.review_request_removed',
  'pull_request.synchronize',
  'discussion.created',
  'pull_request_review.submitted',
] as const

// Prior values of DEFAULT_GITHUB_EVENT_ALLOWLIST that shipped in releases and
// were seeded verbatim into typeclaw.json. Kept as historical record so the
// migration can recognize and unfreeze configs created by those versions.
// NEVER edit these in place — they are snapshots of what was on disk.
//   - v1: 7-event default, shipped 0.5.1–0.10.0 (commit fe4f3a8)
const GITHUB_EVENT_ALLOWLIST_V1 = [
  'issue_comment.created',
  'pull_request_review_comment.created',
  'discussion_comment.created',
  'issues.opened',
  'pull_request.opened',
  'discussion.created',
  'pull_request_review.submitted',
] as const
//   - v2: added review_requested + review_request_removed, shipped 0.11.0+ (commit 4f365ce)
const GITHUB_EVENT_ALLOWLIST_V2 = [
  'issue_comment.created',
  'pull_request_review_comment.created',
  'discussion_comment.created',
  'issues.opened',
  'pull_request.opened',
  'pull_request.review_requested',
  'pull_request.review_request_removed',
  'discussion.created',
  'pull_request_review.submitted',
] as const
//   - v3: added ready_for_review, shipped 0.12.0+ (the default just before
//     synchronize was added). Snapshotted here so configs seeded with the
//     pre-synchronize default unfreeze and re-track the new default.
const GITHUB_EVENT_ALLOWLIST_V3 = [
  'issue_comment.created',
  'pull_request_review_comment.created',
  'discussion_comment.created',
  'issues.opened',
  'pull_request.opened',
  'pull_request.ready_for_review',
  'pull_request.review_requested',
  'pull_request.review_request_removed',
  'discussion.created',
  'pull_request_review.submitted',
] as const

// Every event-allowlist that `channel add` / `init` has ever seeded verbatim
// into typeclaw.json, oldest first, current default last. The legacy-shape
// migration uses this to tell a seeded default (safe to strip so the config
// re-tracks the shipped default) from a user's deliberate customization (must
// be preserved). Append the prior array here — never edit in place — whenever
// DEFAULT_GITHUB_EVENT_ALLOWLIST changes, or configs from the old version stay
// frozen and the migration starts eating user edits.
export const SEEDED_GITHUB_EVENT_ALLOWLISTS: readonly (readonly string[])[] = [
  GITHUB_EVENT_ALLOWLIST_V1,
  GITHUB_EVENT_ALLOWLIST_V2,
  GITHUB_EVENT_ALLOWLIST_V3,
  DEFAULT_GITHUB_EVENT_ALLOWLIST,
]

// Which pull_request webhook action triggers an agent code review. The two
// event values are GitHub's bare PR action names (the `pull_request.` event
// prefix is implied by this field living under the review config); `off` is the
// disable sentinel, matching the `engagement.stickiness: 'off'` convention:
//   - 'review_requested' — review only when the bot is requested (default)
//   - 'opened'           — review every non-draft PR as soon as it opens; a draft
//                          PR wakes no session and is reviewed once it turns ready
//                          (ready_for_review) or the bot is explicitly requested
//   - 'off'              — disable code review entirely
export const GITHUB_REVIEW_ON_VALUES = ['review_requested', 'opened', 'off'] as const

export type GithubReviewOn = (typeof GITHUB_REVIEW_ON_VALUES)[number]

export const DEFAULT_GITHUB_REVIEW_ON: GithubReviewOn = 'review_requested'

// PR-review policy knobs. Grouped under `review` so future toggles
// (`requestChanges`, severity thresholds) cluster here instead of flattening
// onto the channel root.
//
// `on` gates which pull_request action triggers a code review (see values above).
//
// `approve` gates *whether* the agent may submit a formal review with
// `event: APPROVE`. When `false`, the adapter appends an operator-policy note
// to inbounds and the `typeclaw-channel-github` skill downgrades an `approve`
// verdict to a `COMMENT` review (findings still posted, no formal approval).
// Enforced in the inbound text rather than at the bash layer because the
// review posts via `gh api --input <file>`, so the `event` value lives in a
// temp file the command interceptor never sees.
const githubReviewSchema = z
  .object({
    on: z.enum(GITHUB_REVIEW_ON_VALUES).default(DEFAULT_GITHUB_REVIEW_ON),
    approve: z.boolean().default(true),
  })
  .default({ on: DEFAULT_GITHUB_REVIEW_ON, approve: true })

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
  review: githubReviewSchema,
})

// KakaoTalk uses the same shape as every other adapter. There used to be an
// `autoMarkRead` opt-in here; the adapter now fires a LOCO NOTIREAD ack on
// every inbound MSG event unconditionally (see kakaotalk.ts) so the sender's
// unread "1" (the yellow unread badge) clears as soon as the agent observes the message.
// Existing configs with `autoMarkRead: <bool>` continue to parse — Zod's
// default `.object()` strips unknown keys silently — but the field has no
// effect. Risk note: auto-acking every received message is a distinct
// behavioral fingerprint vs a human, so KakaoTalk's abuse detection may
// flag accounts that ack rapidly and unconditionally. Run typeclaw with the
// kakaotalk adapter only on dedicated agent accounts you can afford to lose.
export const channelsSchema = z
  .object({
    discord: userModeAdapterSchema.optional(),
    'discord-bot': adapterSchema.optional(),
    github: githubChannelSchema.optional(),
    // LINE is a personal-account channel like KakaoTalk: plain-text only,
    // alias-only engagement (no native @-mention), credentials in
    // secrets.json#channels.line (not env). Unlike KakaoTalk it has no
    // token-renewal cron — it persists a long-lived auth token + certificate.
    line: userModeAdapterSchema.optional(),
    kakaotalk: userModeAdapterSchema.optional(),
    slack: userModeAdapterSchema.optional(),
    'slack-bot': adapterSchema.optional(),
    'telegram-bot': adapterSchema.optional(),
    webex: userModeAdapterSchema.optional(),
    // Webex bots receive messages in real time over a Mercury WebSocket
    // (agent-messenger's WebexBotListener), the same persistent-socket model
    // as slack-bot (Socket Mode) and discord-bot (Gateway) — no public
    // webhook URL required. Single bot-token auth; config shape is the
    // standard adapterSchema (engagement + history + enabled).
    'webex-bot': adapterSchema.optional(),
  })
  .default({})

export type EngagementConfig = z.infer<typeof engagementSchema>
export type ChannelAdapterConfig = z.infer<typeof adapterSchema>
export type ChannelInstanceEntry = z.infer<typeof instanceConfigSchema>
type ParsedGithubAdapterConfig = z.infer<typeof githubChannelSchema>
export type GithubAdapterConfig = ParsedGithubAdapterConfig
export type ChannelsConfig = z.infer<typeof channelsSchema>
