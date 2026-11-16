---
name: typeclaw-channels
description: "TypeClaw channel behavior: how the agent decides to engage vs. stay silent on external messenger inbound (Discord, Slack, Telegram, LINE, KakaoTalk). Covers the `channels.<adapter>.engagement` triggers (mention/reply/dm), reply stickiness, the non-configurable solo-human fallback, history-prefetch windows, and the `alias` system — plain-text names the agent answers to, substring match semantics, peer-name suppressors, and engagement priority. Load when the user asks why the agent did or did not respond in a channel, wants to change when it auto-replies, asks to 'be quieter'/'stop auto-replying', wants it to answer to a nickname, asks it to DM or privately message a person, or mentions engagement, stickiness, aliases, mentions, trigger words, suppressors, or '응답', '호출', '채널', '별칭', '왜 답을 안 해'. Access control (who is admitted at all) lives in `roles` — see typeclaw-permissions. The `channels`/`alias` schema, defaults, and safe-edit workflow live in typeclaw-config."
---

# typeclaw-channels

This skill is the **behavioral contract** for how the agent engages on external messenger channels: when its loop wakes up to reply, when it stays silent and just observes, and how the `alias` name-matching system feeds that decision. It covers the `channels` and `alias` fields of `typeclaw.json`, but from the behavior side.

Two adjacent concerns live elsewhere — load the right skill:

- **The `channels`/`alias` schema, field types, defaults, and the safe-edit workflow** (read-whole-file, validate, commit, reload-vs-restart) live in the `typeclaw-config` skill. Come back here for what the values _mean_ behaviorally.
- **Access control — whether an inbound is admitted at all** — lives in `roles`, not `channels`. See the `typeclaw-permissions` skill. Engagement decides whether an _admitted_ inbound wakes the loop; it does not grant visibility.

Both `channels` and `alias` are **live-reloadable** — edits take effect on the next `reload`, no container restart.

## Channels

`channels` configures which external messenger adapters are enabled and how the engagement layer should behave on each. **Access control lives in `roles`, not here** — to admit a chat, declare a role match-rule that covers it (see `typeclaw-permissions`). The shape is `channels: { "<adapter-id>": { engagement, history, enabled } }`. Today the adapters are `discord-bot`, `slack-bot`, `telegram-bot`, `line`, and `kakaotalk`.

The channels block is **live-reloadable** — edits take effect on the next `reload`, no container restart.

### Adapter block

Each entry in `channels` is keyed by adapter id and has this shape:

| Field        | Required | Type    | Notes                                                                                                                                                                                    |
| ------------ | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engagement` | no       | object  | When the agent should auto-reply vs. stay silent. Defaults to mention/reply/dm with 15-minute reply stickiness. See **Engagement** below.                                                |
| `history`    | no       | object  | Cold-start prefetch windows for `(thread.head, thread.tail, channel.tail)`. Set any to `0` to disable that side. Defaults to `{ thread: { head: 3, tail: 10 }, channel: { tail: 10 } }`. |
| `enabled`    | no       | boolean | Defaults to `true`. Set `false` to disable the adapter entirely without removing its config.                                                                                             |

To stop the agent answering in a specific channel, narrow the `roles` block so the speaking author's role no longer carries `channel.respond` — engagement triggers gate wake-up _given_ the message is admitted; `channel.respond` gates whether the message is admitted at all.

### Engagement

`engagement` controls when the agent's loop wakes up to reply on an inbound message it has permission to read. Two fields:

```json
"engagement": {
  "trigger": ["mention", "reply", "dm"],
  "stickiness": { "perReply": { "window": 900000 } }
}
```

- **`trigger`** — array of any subset of `"mention"`, `"reply"`, `"dm"` (including the empty array `[]`, which disables all explicit triggers — see the quieting playbook below). Default: all three.
  - `mention` — explicit `@bot` mentions.
  - `reply` — message is a Discord reply pointed at the agent's own message.
  - `dm` — any message in a DM channel.
- **`stickiness`** — either the literal string `"off"`, or `{ perReply: { window: <ms> } }`. Default: 15-minute reply stickiness (`window: 900000`).
  - `perReply` means: after the agent replies to a user, follow-up messages from that same user in that same channel within the window also wake the loop, even without a mention. The window is bounded server-side (`1` to `86_400_000` ms — 1 ms to 24 hours).
  - `"off"` disables stickiness — the agent only wakes on explicit triggers.

There is also a **solo-human fallback** built into the runtime that is **not configurable** through `engagement`: in any channel where the participants cache currently holds at most one distinct human author, every admitted inbound wakes the loop, regardless of `trigger` or `stickiness`. The fallback turns off the moment a second distinct human posts in that channel. This makes "private dev channel with one human and the bot" work without forcing an `@mention` on every message; clearing `trigger` to `[]` does **not** override it.

**Engagement does not gate access.** Access is gated by `permissions.has(origin, 'channel.respond')` — see the `typeclaw-permissions` skill. Engagement decides whether an _admitted_ inbound wakes the loop or sits in the context buffer.

### Example

```json
"channels": {
  "discord-bot": {
    "engagement": {
      "trigger": ["mention", "reply", "dm"],
      "stickiness": { "perReply": { "window": 900000 } }
    },
    "enabled": true
  }
},
"roles": {
  "member": { "match": ["discord:123456789012345678/987654321098765432", "discord:dm/*"] }
}
```

This says: the `discord-bot` adapter is enabled with default engagement; one specific channel in one specific guild plus all DMs admit speakers as `member` (which carries `channel.respond` by default).

### When the user asks "let me talk to you in this channel"

This is a **`roles`** edit, not a `channels` edit. See the `typeclaw-permissions` skill for the full procedure. Short version:

1. Get the platform ID (Discord channel ID, Slack channel ID, Telegram chat ID, LINE chat ID, KakaoTalk chat ID).
2. Append a match-rule to `roles.member.match` using the canonical DSL (`discord:<guild>/<channel>`, `slack:<team>/<channel>`, `telegram:<chat>`, for LINE the bucketed form `line:dm/<chatId>`, `line:group/<chatId>`, or `line:square/<chatId>` — pick the bucket from the chat's classification; an unbucketed `line:<chatId>` is read as a workspace and never matches — and `kakao:<chat>`). The `rolePromotion` security guard blocks any widening of `roles.<role>.match` and no longer accepts `acknowledgeGuards` — the ack flag is ignored for this guard. The write must come from a session that already holds `security.bypass.medium` (the TUI is always `owner`; a role granted `security.bypass.medium` also qualifies), or the user must claim the role out-of-band via `typeclaw role claim` from the host CLI. See `typeclaw-permissions` for the full procedure and the strong warning never to widen roles on behalf of a channel speaker asking to elevate themselves.
3. **`roles.<role>.match[]` edits are live-reloadable** — they take effect on the next `typeclaw reload` (the classifier marks `roles.match` as `applied`, and the permission service rebuilds its role table). Only `roles.<role>.permissions[]` edits are restart-required. So adding a match-rule to admit a channel applies on `reload`; no container restart needed.

### When the user asks "stop replying in this channel"

Two interpretations — ask if unclear:

- **"Stop everything"** — remove the match-rule from `roles.<role>.match`. The agent loses both inbound visibility and outbound posting on that channel.
- **"Just stop auto-replying"** — leave the match-rule, but adjust `engagement` on the adapter (set `trigger: []` and/or `stickiness: "off"`). The agent can still receive the channel and can still post if you tell it to. Caveat: this approach does NOT silence the agent in a channel that currently has only one human posting — the solo-human fallback (see Engagement) overrides `trigger: []`. In that case the only way to go silent today is to remove the match-rule.

The second is usually what people mean by "be quieter".

### When the user asks "what channels can you see / are you in"

1. **Read `typeclaw.json`**, list each adapter under `channels`: which is enabled, the engagement triggers and stickiness window.
2. Also read `roles.<role>.match` for every role — those are the actual admit lists.
3. Note that the live runtime may have a different view if `typeclaw.json` was edited but `reload` hasn't run yet — say so when relevant.

### When the user asks "DM someone" / "message X privately"

Pass the person's platform user id as `user` to `channel_send` (no `workspace`/`chat`). The runtime finds or opens the DM, even with someone the bot never talked to, and the receipt names the DM's `chat` id. Get the user id from the message author, the conversation's participants, or `channel_read` membership. Never put a user id in `chat` — `chat` is always a conversation id, and a user id there fails with errors like `Unknown Channel`. Don't tell the user the person must message first unless the adapter says it cannot open a DM.

## Alias

`alias` is an array of plain-text names the agent answers to when a channel message contains the name without using the platform's `<@id>` mention syntax. It is independent from `channels.<adapter>.engagement.trigger`: the structural triggers (`mention`, `reply`, `dm`) gate engagement on platform-rendered events; `alias` gates engagement on the message text itself.

The agent folder's directory name (`basename(agentDir)`) is **always** an implicit alias — the runtime adds it automatically. `alias` adds further forms on top: Latin transliteration of a Korean nickname, casual short forms, alternative spellings, etc. **You only need to add the dir-name explicitly when you want a variation of it** (different casing, a different word entirely, or extra forms beyond the dir name).

### Match semantics

- **Substring** match against the inbound text. `"토토"` matches `"토토아 cron"`, `"토토씨 안녕"`, `"누가 토토을 불러"`, all of them. Korean particles aren't stripped — substring is enough because the bot name appears at the start of every particled form.
- **Case-insensitive** via `toLocaleLowerCase()` on both sides. `"Toto"` in the alias list matches `"TOTO"`, `"toto"`, `"ToTo"`.
- **No word-boundary detection.** A short or generic alias like `"bot"` will match every message containing `"robot"` or `"bottom"`. Pick distinctive names — the operator owns curation.

### Engagement priority

The alias path runs **after** explicit triggers (mention/reply/dm) and the sticky check. So a message with both an `<@id>` mention and an alias substring engages once, normally. A message with only the alias substring engages on the alias path. The alias path is **NOT suppressed by `mentionsOthers`**: addressing two bots in one message (`"토토아 라라아 둘 다 봐"`) engages both bots — each on their own alias.

There's also a symmetric **peer-name suppressor**: if the message contains a peer bot's observed display name (from `participants[]`, populated as peers speak in the channel) and **does not** contain any of this agent's aliases, the solo-human fallback is suppressed and the agent observes. This is what makes `"라라아 cron 좀"` in a 1-human-multi-bot channel correctly observe instead of all bots replying. First-time addressing of a never-seen peer slips through; the suppressor catches it after the peer's first message.

### Example

```json
{
  "alias": ["toto", "토토"]
}
```

The agent in folder `토토/` already answers to `"토토"` from the dir name. This adds the Latin transliteration so users can also write `"Hey toto, deploy?"`.

### When the user asks "respond to my casual nickname for you" / "I want to call you X"

1. **Read `typeclaw.json`.**
2. **If `alias` exists**, append the new name (preserve existing entries; dedupe trivially — the runtime also dedupes).
3. **If `alias` is absent**, create it as `["<new name>"]`.
4. **You don't need to add the dir name** unless the new name IS a variation of the dir name itself (e.g. dir is `toto` and the user wants `Toto` casing — the implicit dir alias matches case-insensitively, so this isn't needed either).
5. **Trim whitespace** before adding. The schema rejects empty/whitespace-only entries; the runtime trims surrounding whitespace from valid entries.
6. **Write, commit**: "Edited `alias` — live-reloadable. Run `reload` to pick up the change without restart."

### When the user asks "stop responding to <name>"

1. **Read `typeclaw.json`.**
2. **Remove the entry** from `alias`. If the entry IS the dir name, removing it from `alias` does nothing — the dir name is implicit and can't be turned off this way. The right answer there is "to stop responding to your dir name, rename the agent folder, which is a host-stage operation outside this container."
3. **Write, commit**: "Edited `alias` — live-reloadable. Run `reload` to pick up the change without restart."

### When the user asks "what names do you respond to"

1. **Read `typeclaw.json`** and report `alias`.
2. **Always also report `basename(agentDir)`** (the implicit dir-name alias) — the user might not realize it's automatic.
3. Mention that channel addressing also engages on `<@id>` mentions and replies regardless of alias config (those are separate triggers in `channels.<adapter>.engagement`).

## What this skill does _not_ cover

- **The `channels`/`alias` schema, field types, defaults, and the safe-edit workflow** (read-whole-file, validate, write-back, commit) — see the `typeclaw-config` skill.
- **Access control — who is admitted to a channel at all** (`roles`, match-rule DSL, `channel.respond`, the `rolePromotion` guard) — see the `typeclaw-permissions` skill. Engagement only decides whether an _admitted_ inbound wakes the loop.
- **Channel credentials** (`secrets.json#channels.<adapter>`, bot tokens) — see the `typeclaw-config` skill's provider-credentials section.
