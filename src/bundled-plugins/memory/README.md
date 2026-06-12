# typeclaw-plugin-memory

The bundled memory plugin. Owns `memory/topics/` (sharded long-term memory) and `memory/streams/yyyy-MM-dd.jsonl` (daily fragment streams) plus three subagents that read and write them: `memory-logger`, `dreaming`, `memory-retrieval`.

Auto-loaded by every TypeClaw agent. No `plugins[]` entry to add and no opt-out. Configure via the `memory` block in `typeclaw.json`.

## Config

```json
{
  "memory": {
    "idleMs": 60000,
    "bufferBytes": 500000,
    "injectionBudgetBytes": 16384,
    "minIdleDeltaLines": 3,
    "dreaming": { "schedule": "*/30 * * * *" }
  }
}
```

| Field                         | Default          | Effect                                                                                                                                                                                                                                         |
| ----------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.idleMs`               | `60000`          | Debounce window before `memory-logger` spawns after a prompt completes. Minimum `1000`.                                                                                                                                                        |
| `memory.bufferBytes`          | `500000`         | Size-based ceiling: spawns `memory-logger` when the transcript grows by this many bytes since the last run. `0` disables. Minimum `10000` when non-zero.                                                                                       |
| `memory.injectionBudgetBytes` | `16384`          | Total shard-body budget for direct-mode memory injection. Above this, `loadMemory` switches to index-mode (headings + metadata only) and the agent must call `memory_search` to fetch specific topics or recent stream events. Minimum `4096`. |
| `memory.minIdleDeltaLines`    | `3`              | Minimum JSONL line growth since the last `memory-logger` run required to fire an idle spawn. Below this, the idle timer ticks but no spawn fires. `0` disables (legacy always-fire-on-idle behavior). Independent of `bufferBytes`.            |
| `memory.dreaming.schedule`    | `"*/30 * * * *"` | Five-field cron expression for the dreaming subagent.                                                                                                                                                                                          |

All fields are **restart-required** — the plugin reads them once at boot.

## What it contributes

| Kind     | Name                       | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subagent | `memory-logger`            | Reads a parent transcript past a watermark and appends fragments to `memory/streams/<today>.jsonl`. Coalesced per `agentDir`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Subagent | `dreaming`                 | Reads shards under `memory/topics/` plus undreamed daily-stream events and rebalances the topic shards. Coalesced per `agentDir`. Citation-superset invariant enforced on every run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Subagent | `memory-retrieval`         | On `session.turn.start` when injection plan is `index` mode, reads the user's actual prompt for this turn + shard listing, writes a focused summary to `memory/.retrieval-cache/<sessionId>.md`. Coalesced per `parentSessionId`. Declares `profile: 'fast'` (retrieval is "≤3 keyword searches + 1 write", no reasoning required) and `timeoutMs: 30_000` so a wedged provider call releases the coalescing key instead of poisoning the cache for every subsequent turn.                                                                                                                                                                                                                                                            |
| Tool     | `memory_search`            | Main-agent tool. Substring/regex search across BOTH topic shards (slugs, frontmatter, bodies) and undreamed daily-stream events (fragment topic/body, legacy prose). Plain queries are phrase-first: the whole query is tried as one substring, and if that finds nothing the query is split on whitespace and the distinct words are OR-matched, ranked by how many words each hit contains (regex queries never fall back). Results are discriminated by `source: "topic" \| "stream"`; exact-phrase (and regex) results list topics first, then streams newest-first, while word-fallback results are ranked by matched-word count with that order as the tiebreak (so a higher-scoring stream can precede a lower-scoring topic). |
| Tool     | `delete_topic_shard`       | Subagent-only (dreaming). Deletes a topic shard at `memory/topics/<slug>.md`. Path-guarded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Cron     | `__plugin_memory_dreaming` | `kind: 'prompt'`, `subagent: 'dreaming'`, scheduled per `memory.dreaming.schedule`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Hook     | `session.idle`             | Per-session debouncer with size-based ceiling. Spawns `memory-logger` on idle or buffer-trip.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Hook     | `session.end`              | Spawns `memory-logger` immediately; also unlinks the retrieval-cache file for this session.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Hook     | `session.turn.start`       | **Vector on:** renders the per-turn user-prompt memory block into `event.retrievalContext.results` (all shards under budget, top-K `hybridSearch` over budget); runs for every origin that supplies a `retrievalContext`, including subagents. **Vector off:** when `buildInjectionPlan` returns `mode: 'index'` and origin is not a subagent, spawns `memory-retrieval` (detached) with the turn's `userPrompt` so the cache reflects the user's current question. Fire-and-forget; failures route through the plugin logger.                                                                                                                                                                                                        |

## Memory injection (two-tier, topic shards only)

Default budget is 16 KB. Direct mode when shard bytes sum ≤ budget: all shard bodies are injected verbatim. Index mode when sum > budget: only heading + `cites=N, days=N, lastReinforced=YYYY-MM-DD` per shard, plus a directive for the agent to call `memory_search` to fetch specific topics or recent stream events.

**Where the section is injected depends on `memory.vector.enabled`:**

- **Vector off (default): system prompt.** `loadMemory` renders the `# Memory` section once at session creation; it lives in the cacheable system-prompt prefix (ordered last, since it's the most volatile block). The two-tier direct/index split above applies, and the index-mode `memory-retrieval` subagent (below) covers the over-budget case lag-by-one.
- **Vector on: user prompt, per turn.** The system-prompt `# Memory` section is suppressed entirely (`createSession`'s `suppressSystemMemory`, derived once at boot in `src/run/index.ts`). The `session.turn.start` hook instead renders memory into `event.retrievalContext.results`, which the turn-drivers append to the user message. Under budget it injects **all** shard bodies (faithful to direct mode, so nothing the agent "always had" vanishes on an off-topic turn); over budget it runs `hybridSearch` and injects the **top-K** most relevant shards/fragments for the current message. Both paths share `renderMemorySection`/`renderRetrievedMemorySection` (`load-memory.ts`), so the channel-bleed boundary is applied identically. This keeps the system-prompt cache prefix stable across a session and lets retrieval track the live topic instead of a stale session-start snapshot.

The invariant `suppressSystemMemory === memory.vector.enabled` is load-bearing: a session must never carry memory in both the system prompt and the user turn.

### Vector retrieval is parent-child, not a flat pool

When `memory.vector.enabled` is true, `hybridSearch` does **not** rank topic vectors and stream-fragment vectors together in one flat cosine pool. It uses a parent-child collapse so the result set is always topic-level current truth:

- **Match surface.** Only **topics** are embedded into the vector index. The vector lane matches topic-belief vectors; the keyword lane (`searchAll`, which reads the daily-stream JSONL directly) matches undreamed fragments. Both fuse by RRF. Fragments are fine-grained keyword hooks; topics are the returned unit.
- **Collapse to parent.** A matched fragment resolves to the topic that cites it (via the shard's `fragments:` list — the citation IS the parent foreign key) and contributes its score to that topic. It never appears as a standalone result. An **undreamed** fragment (no topic cites it yet) resolves to itself, preserving the ~30-min freshness window before dreaming consolidates it.
- **Stream fragments are not embedded.** Stream-fragment vectors were dropped: a fragment's embedding bought only ~30 min of paraphrase recall on the write hot path for content the keyword lane already covers, and once dreaming consolidates the fragment its parent topic's vector carries durable semantic recall. The vector index is topic-only; the `source` discriminator survives because the keyword lane still yields `stream` results. Legacy stream rows from before this change are pruned by the startup index build / doctor on the next boot.
- **MAX-child ranking.** A collapsed topic takes the **maximum** of its members' RRF scores, never the sum. Sum would over-rank often-revised topics purely for accumulating more citations to match (the PARADE result: max beats sum when relevance is concentrated).
- **Superseded fragments are excluded from the match surface.** When dreaming overturns a belief on contradiction, the old fragment id moves from `fragments:` to a `superseded:` list (see below). Superseded ids stay cited — so the citation-superset GC invariant keeps the fragment alive and history is auditable — but `passages.ts` does not embed them, so a stale "uses bun" fragment can never resurface as a hook for the current "uses pnpm" belief. `parseCitations` stays section-blind so GC and frontmatter recompute still see both sections; `splitCitationsBySection` is the status-aware view the retrieval layer reads (`parent-link.ts`).

**Undreamed daily-stream events are NOT injected into the system prompt.** They are reachable only via `memory_search`, which discriminates results by `source: "topic" | "stream"`. The agent now decides per-query whether recent observations are relevant, instead of carrying every undreamed fragment in the cached prompt prefix. Three reasons this is the right shape:

1. PR #314 made `memory_search` cover the stream surface, so the duplicate copy in the system prompt no longer earns its bytes.
2. Streams grow unboundedly with usage (~360 KB at 30 days in the typical case, more under heavy use). The previous per-file 12 KB cap silently dropped each day's tail with no signal to the agent; on-demand search returns the relevant slice instead of "the first 12 KB by date".
3. Streams sat inside the cached system-prompt prefix and appended new fragments on every memory-logger run, breaking cache reuse across prompts. Without injection, the prefix is stable until topic shards change.

**Channel-origin always uses index mode regardless of total shard size** — defends against memory bleed into channel responses (the agent treats injected memory as instructions when channel users see it).

When index mode is active, the `memory-retrieval` subagent fires on `session.turn.start` — the hook that brackets every actual `session.prompt(text)` call with the user's literal text — reads that user prompt, decides what's relevant across BOTH topic shards and undreamed stream events, pulls them via `memory_search`/`read`, and writes a focused ≤8 KB summary to `memory/.retrieval-cache/<sessionId>.md`. The NEXT `loadMemory` call for the same session reads and appends that cache file (lag-by-one-prompt). The cache file is unlinked on `session.end`.

The hook trigger matters: `SessionPromptEvent.prompt` (`session.prompt`) carries the assembling system prompt (`basePrompt + IDENTITY + SOUL`) at session-creation time, NOT the user's message. Reading that field as if it were the user's prompt — which this plugin did before PR #340 — caused the retrieval subagent to keyword-mine TypeClaw's own framing prose (`TypeClaw`, `subagent`, `AGENTS.md`, `systemPromptLeak`, etc.) on every session. `session.turn.start` is the correct hook for "what is the user asking right now."

## Memory saturation

The dreaming subagent treats topic shards like human long-term memory: **repetition strengthens, lack of repetition saturates**. On every run the runtime computes per-shard strength signals from each shard's frontmatter (`cites`, `days`, `lastReinforced`) and renders them as a table at the top of the dreaming subagent's user prompt.

The subagent uses these signals to:

1. **Promote strong topics.** `days = 1` → tentative ("the user mentioned"). `days >= 3` → confident ("the user consistently"). `days >= 7` → declarative ("the user always"). Promotion is gated on distinct days, not raw citation count.
2. **Merge near-duplicates.** Topics that overlap get folded into one. The merged topic's citation set is the union.
3. **Demote decayed topics.** A weak/decayed topic stays as its own shard but the body should be trimmed to a single line. When index-mode injection is in effect, demoted shards' bodies don't enter the system prompt at all — the index plus `memory_search` retrieval cover them on demand.

There is no `## Historical observations` bucket. Demoted topics live as their own shards; injection-time filtering (the index/direct split) handles the prompt-budget pressure.

## Citation-superset safety net

`checkCitationSupersetAcrossShards` checks that the union of fragment ids cited in NEW shards is a superset of the union cited in OLD shards. Violation triggers:

1. `restoreShardSnapshot` restores every pre-run shard to byte-identical bytes AND deletes any new shards created during the run.
2. Daily-stream fragment GC is skipped.
3. Dreamed-ids ADVANCE anyway — the **conscious anti-loop tradeoff**: orphaned fragments survive in the daily JSONL (force-committed) but won't be re-shown to a future dreaming run. The alternative (don't advance) would infinite-loop if the LLM keeps making the same mistake.
4. The commit is skipped.

A `[dreaming] citation-superset violation: …` warning logs the dropped ids and explicitly names the orphaning tradeoff.

## Files on disk

- **`memory/topics/<slug>.md`** — per-topic shards with YAML frontmatter (`heading`, `cites`, `days`, `lastReinforced`, `tags?`) + body markdown. Runtime owns the frontmatter (recomputed after every dreaming run from the body's citations); dreaming subagent writes body only. The body cites fragments under a `fragments:` list (active evidence behind the current belief) and an optional `superseded:` list (evidence overturned by a later contradiction — kept cited for GC/history but excluded from vector retrieval).
- **`memory/streams/yyyy-MM-dd.jsonl`** — daily fragment streams. One event per line, discriminated union of `fragment | watermark | legacy_prose`. Force-committed alongside the shards.
- **`memory/MEMORY.md.pre-shard.bak`** — legacy pre-shard backup left by older TypeClaw versions. Safe to delete after verifying.
- **`memory/skills/<name>/SKILL.md`** — muscle memory. Skills the dreaming subagent distills from repeated procedures. Auto-loaded as first-class skills.
- **`memory/.dreaming-state.json`** — per-day dreamed-id sets.
- **`memory/.retrieval-cache/<sessionId>.md`** — ephemeral retrieval summaries. Written by `memory-retrieval`, read by `loadMemory` on the next prompt of the same session, unlinked on `session.end`.

## How `session.idle` works

Core fires `session.idle` immediately after every `session.prompt()` completion. The plugin owns the debounce: a `Map<sessionId, Timeout>` reset on every event. When the timer fires, the plugin spawns `memory-logger` for that session — unless the min-delta gate suppresses the spawn (see below).

If the user starts a new prompt before the timer fires, the next `session.idle` resets it. If the user disconnects, `session.end` cancels the timer and fires `memory-logger` immediately (unless the byte-equality skip suppresses it; see below).

In busy channel sessions the agent rarely goes idle long enough to trip the timer. The size-based ceiling handles this: on every `session.idle` the plugin `fs.stat`s the transcript and compares against the size at the last memory-logger run. Once growth reaches `memory.bufferBytes`, the timer is cancelled and `memory-logger` spawns immediately.

### Min-delta gate (idle)

The `session.idle` hook fires after every prompt completion. A chatty channel session that briefly quiets four times in seven minutes would otherwise pay the per-spawn floor (system-prompt prefill + stream-file read + several decision-making turns) on each tick — even when only a handful of new transcript lines have arrived, almost certainly containing nothing memorable.

`memory.minIdleDeltaLines` (default `3`) gates the idle-timer spawn: when the timer fires, if the transcript grew by fewer than this many JSONL lines since the last memory-logger run for the session, the spawn is skipped. The skip is logged as `memory-logger idle skip ses_X (delta below minIdleDeltaLines=N)`. The buffer-trip path is unaffected — sessions that grow `bufferBytes` of unread transcript still spawn regardless of line delta.

### Byte-equality skip (session.end)

When `session.end` arrives and an earlier idle/buffer-trip spawn already drained the transcript to its current size, the session-end spawn is skipped. The skip is logged as `memory-logger session-end skip ses_X (no new bytes since last spawn at N)`. The skip only applies when a real baseline was recorded (`bytesAtLastRun > 0`); sessions that ended before any spawn ran still fire on close.

### Daily-stream cursor (memory-logger payload)

Each `memory-logger` spawn captures the line count of `memory/streams/<today>.jsonl` at the END of its run and stamps it on a per-`parentSessionId` cursor keyed by today's date. The NEXT spawn for the same session on the same day receives `streamLineCursor: N` in its payload — the subagent uses it to skip ahead to `offset=N+1` if it does the optional local-dedup read of today's stream. The cursor is dropped on cross-day rollover (yesterday's cursor points into yesterday's file, which is no longer the spawn's target) and on `session.end`.

## Tests

Test files in this directory (kebab-case, `.test.ts` neighbors): `paths`, `slug`, `frontmatter`, `topics`, `shard-snapshot`, `delete-tool`, `citations`, `citation-superset`, `load-shards`, `load-memory`, `injection-plan`, `search-tool`, `memory-retrieval`, `memory-logger`, `dreaming`, `index`, `integration`. Plus guard policies in `../guard/policies/`: `memory-topics-delete`, `memory-topics-write`, `memory-retrieval-cache-write`.

## Notes from before the plugin existed

- `memory.idleMs` and `memory.dreaming.schedule` already existed in core's `typeclaw.json` schema and moved into this plugin's `configSchema` verbatim.
- `memory.dreaming.schedule` is now **restart-required** because plugin config is read once at boot.
- The cron job ID is `__plugin_memory_dreaming` (previously `__internal_dreaming`).
