---
name: typeclaw-channel-github
description: Use this skill BEFORE every `channel_reply` or `channel_send` call whose adapter is `github`, AND before composing replies to GitHub-originated inbounds, AND before opening new issues or PRs with `gh`, AND ALWAYS when you are asked to review a PR — whether the inbound says "requested your review on PR #N" / "requested a review from team @… on PR #N", or a human asks for a review in plain language in an issue/PR body or comment ("@bot review this", "can you take a look at #123"). On a review request you delegate the analysis to the `reviewer` subagent, which produces line-anchored findings, then you post them as an inline review via `gh api`. GitHub renders **real markdown** — `**bold**`, `## headings`, `| tables |`, fenced code blocks, and `inline code` all render natively. Use rich markdown freely. GitHub cannot send file attachments via API — do not call `channel_send` with attachments on github chats. GitHub has no typing indicator. PR review threads use `thread` keyed on the root comment id; reply to a thread to stay in it, or omit `thread` to post a top-level issue/PR comment. When a review comment **you authored** gets addressed — the author pushed a fix or replied that resolves it — verify the fix at the PR's head SHA and then resolve the thread by acknowledging with `channel_reply({ …, resolve_review_thread: true })`, which resolves the thread before posting the reply (see "Resolving review threads you authored" below); resolving is the close-out that tells the author the concern is settled. To open new issues or PRs use the `gh` CLI — `GH_TOKEN` is pre-set by the adapter. Read this skill before composing anything on GitHub.
---

GitHub renders normal Markdown in issues, PRs, discussions, and review comments. Use headings, lists, tables, fenced code blocks, links, and inline code when they improve clarity.

- Do not send attachments on GitHub chats; the adapter rejects them.
- There is no typing indicator.
- For PR review threads, keep `thread` set to reply in-place. Omit `thread` for a top-level PR/issue comment.
- When a review comment **you authored** has been addressed, resolve its thread by replying with `channel_reply({ …, resolve_review_thread: true })` — see "Resolving review threads you authored" below. The base principle is **whoever opened the thread closes it**: you resolve only the threads you started, never a human's (the runtime enforces this).

## Mid-turn status replies need `continue: true`

A successful `channel_reply` ends your turn by default — the runtime stops the model right after the reply lands. That is correct for a final answer, but it will **silently truncate** a turn that still has work to do. If you post a status line like "Reviewing now, I'll be back with findings" and then expect to keep working (fetch the diff, spawn the reviewer, post the review) in the **same** turn, you must call `channel_reply({ text: "…", continue: true })`. Without `continue: true`, the turn ends at that status reply and the review never runs. Reserve `continue: true` for genuine multi-step turns; the final reply that wraps up the turn omits it.

## Inbound triage — do this first, every time

Before you pick an action, classify the inbound. Skipping this step is how a PR ends up with a "looks good" comment but no approval: the model pattern-matches on the prose ("they fixed it → resolve the thread") and never asks whether it owes the PR a formal review. Answer these in order; the **first** that matches decides your path. Do not skip ahead.

1. **Is this a PR, and do I have an unresolved blocking obligation on it?** On any `pr:N` inbound, before anything else, check whether you owe this PR a verdict you have not yet landed. Check **both** signals below — checking only formal review state misses the very failure this gate exists to catch, because a prior block may never have become formal state:
   - **Formal review state.** Run the step-1 re-review query in the PR review flow (`gh api --paginate --slurp /repos/owner/repo/pulls/<N>/reviews --jq '…'` filtered to `{CHANGES_REQUESTED, APPROVED}`). If your latest **blocking decision** is `CHANGES_REQUESTED`, you have a live sticky block.
   - **Flat-comment blockers you authored.** A prior "request changes" may have been posted as a plain PR/issue comment instead of a formal review — in which case **no `CHANGES_REQUESTED` row exists** and the query above returns empty even though you blocked the PR in prose. So also scan your own recent comments (`gh api /repos/owner/repo/issues/<N>/comments --jq '[.[] | select(.user.login == "<your-login>")]'`) for one that requested changes / raised blockers and has not since been superseded by a formal review or a clear retraction. For routing, a blocking comment you wrote is as binding as a formal `CHANGES_REQUESTED`.

   If **either** signal shows an unresolved blocker you raised, this inbound is a **re-review** — go to the **PR review flow** regardless of how it is phrased. An author commenting "fixed both issues" / "addressed your feedback" / "pushed a fix" is a re-review trigger, **not** a thread-resolve trigger. A re-review is closed by re-deciding the verdict and landing a **formal** review via `POST /pulls/<N>/reviews`: `APPROVE` clears a sticky `CHANGES_REQUESTED`; a comment or a flat reply clears neither a formal block nor a flat-comment blocker — it just strands the verdict again, which is the original bug.

2. **Am I being asked to review (first-time)?** Explicit `review_requested` inbound, or a human asking in plain language ("review this", "take a look at #N"). → **PR review flow** (see "When you are being asked to review").

3. **Is this a reply inside an inline review thread I authored** (`pr:N` with `thread` set, on a thread whose root comment is mine)? → verify the fix at head SHA and **resolve the thread** (see "Resolving review threads you authored"). `resolve_review_thread` only works when `thread` is set on the origin; if there is **no** `thread`, this branch does not apply — do not attempt it, fall through to the table below.

4. **None of the above** → use the routing table below.

> The decisive question is **#1**. A blocking verdict you owe a PR is never discharged by a `channel_reply` or an `issue_comment` — neither carries review state, and neither clears a sticky `CHANGES_REQUESTED`. This applies to an **unresolved blocking obligation** (a live `CHANGES_REQUESTED`, or an unretracted blocker you raised in a flat comment), not to a stale `APPROVED` or a past non-blocking comment — those impose no closeout duty. When you do owe a block, the close-out is always a formal review via `POST /pulls/<N>/reviews`.

## What to do, by inbound type

Every GitHub inbound lands on a `chat` keyed by its subject: `issue:N`, `pr:N`, or `discussion:N`. **Run the triage above first.** Only if no triage branch matched do you pick an action from this table. The default action for anything addressed to you is a normal `channel_reply` in that thread; the **PR review flow** is the exception that requires delegation.

| Inbound                                                  | Looks like                                                                           | What to do                                                                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **New issue** (`issue:N`)                                | A freshly opened issue body.                                                         | Triage or answer it. `channel_reply` on `issue:N`. Open follow-up issues/PRs with `gh` if needed.                                                 |
| **Issue comment** (`issue:N`)                            | A comment on an issue.                                                               | Reply in the issue thread with `channel_reply`.                                                                                                   |
| **PR conversation comment** (`pr:N`, no `thread`)        | A comment on a PR's main conversation (GitHub models PR comments as issue comments). | Reply on the PR with `channel_reply`. **If the text asks you to review → go to the PR review flow.**                                              |
| **PR review-thread reply** (`pr:N`, `thread` set)        | A reply on an existing inline review comment thread.                                 | Stay in the thread: `channel_reply` with `thread` kept as-is. **If it addresses a comment you authored → verify and resolve the thread (below).** |
| **A submitted review** (`pr:N`)                          | Someone submitted a formal review (approve / changes / comment) on a PR.             | React if a response is warranted (answer a question, acknowledge changes). `channel_reply` on `pr:N`.                                             |
| **New discussion / discussion comment** (`discussion:N`) | A discussion thread or a comment in one.                                             | Reply with `channel_reply` on `discussion:N`.                                                                                                     |
| **Review requested** (`pr:N`)                            | See "When you are being asked to review" below.                                      | **PR review flow.**                                                                                                                               |

### When you are being asked to review

You are being asked to review a PR in **either** of these cases — treat them identically:

- **(A) An explicit review-request inbound.** The message text says **"requested your review on PR #N"** or **"requested a review from team @… on PR #N"**. (You do not need to know how it was triggered — the adapter synthesizes this same text whether a human requested you as a reviewer directly or requested a decoy user account that impersonates you as a GitHub App. From your side it reads the same. See [GitHub decoy reviewer](/docs/internals/github-decoy-reviewer).)
- **(B) A human asks you to review in plain language** in a PR/issue body or any comment — "@bot review this PR", "can you take a look at #123", "review the changes when you get a chance". There is no synthetic request text here; you recognize the intent from the message.

Both → run the **PR review flow**. Do not review inline yourself and do not just reply with prose impressions: delegate to the `reviewer` subagent so the analysis runs on the `deep` model, then post its findings as an inline review.

A `review_request_removed` inbound ("removed your review request on PR #N") is the inverse: the requester un-assigned you. Cancel any in-flight reviewer subagent (`subagent_cancel`) and do not post a partial review.

## PR review flow

The `reviewer` subagent is the analyst; you are the integration layer between its output and GitHub's review API. It loads the `code-review` skill on demand and returns line-anchored findings inside a `<review>` block. Your job is mechanics: spawn, wait, translate, post.

**The reviewer's `<review>` block is the only source of the verdict and the findings.** You do not review the PR yourself. Between spawning the reviewer and reading its result you do **no analysis of this PR** — do not run `gh pr diff`, do not read the changed files to form an opinion, do not draft a verdict. The reviewer runs on the `deep` model precisely so this judgment is not yours to make on the parent model. If you analyze the diff and post your own assessment while the reviewer is still running, you will post one verdict now and the reviewer's (often different) verdict when it completes — **two contradictory reviews on the same PR**, the exact failure this flow exists to prevent. Wait for the reviewer; post what it returns; nothing before that.

**HARD RULE — a review with actionable findings is a formal review, never a flat comment.** If the reviewer returns **one or more** actionable findings (`blocker`/`concern`/`nit`), the ONLY acceptable way to deliver them is a formal review via `POST /pulls/<N>/reviews` (step 4) — `REQUEST_CHANGES`, `COMMENT`, or `APPROVE` per the verdict, with the line-anchored findings in `comments[]`. You may **never** flatten those findings into a `channel_reply` or a top-level issue comment, **even when** the `gh api` call fails. A 422 means an anchor is wrong (almost always a `line` not in the diff): re-anchor it or move that one finding into the top-level review `body`, then resubmit the formal review — do **not** abandon the formal review and post prose instead. A flat "## Review … two blockers" comment is a bug, not a fallback: it strands the findings without line anchors and is the exact failure this rule exists to prevent. The flat/issue-comment path is reserved for the **zero-actionable-findings** branch only (see below). If you genuinely cannot land a formal review after fixing anchors, say so plainly and post nothing that claims a review happened — silence beats a false receipt.

1. **Confirm the target, and check whether you already reviewed it.** Capture the PR number, the repo, and the head SHA — you may need the SHA to read files at the revision the reviewer analyzed.

   ```sh
   gh pr view <N> --repo owner/repo --json title,body,baseRefName,headRefOid,files
   ```

   Then check for an **unresolved blocking obligation of yours** — this is what makes the current request a _re-review_ (the author pushed fixes after you previously blocked the PR). As in triage #1, a block can live in **two** places, and you must check both:

   ```sh
   # (a) formal review state
   gh api --paginate --slurp /repos/owner/repo/pulls/<N>/reviews --jq 'add | [.[] | select(.user.login == "<your-login>" and (.state == "CHANGES_REQUESTED" or .state == "APPROVED"))] | last | .state'
   # (b) flat-comment blocker you authored (when (a) is empty)
   gh api --paginate /repos/owner/repo/issues/<N>/comments --jq '[.[] | select(.user.login == "<your-login>")]'
   ```

   If (a) prints `CHANGES_REQUESTED`, **or** (a) is empty but (b) surfaces a comment of yours that requested changes / raised blockers and has not since been superseded by a formal review or a clear retraction, treat the current request as a **re-review** and carry that fact — including which form the prior block took — into the spawn in step 2. Only when **neither** signal shows an unresolved block do you handle the request normally. (`<your-login>` is your GitHub App login, typically `name[bot]`.)

   Two things make the formal-review query load-bearing — both are bugs if you simplify it:
   - **Filter to _decision_ states, not the latest review row.** GitHub's sticky block is cleared only by a later `APPROVED` (or a dismissal) from the same reviewer — a later `COMMENTED` review does **not** clear it. So a history of `CHANGES_REQUESTED` → `COMMENTED` is _still blocked_, even though the latest row is `COMMENTED`. Selecting `last` over the raw review list would misread that as "not a re-review". Filtering to `{CHANGES_REQUESTED, APPROVED}` first, then taking `last`, asks the right question: "what is my latest _blocking decision_, ignoring non-deciding comments?" (Dismissed reviews surface as `state: "DISMISSED"`, so they're correctly excluded from the decision set too.)
   - **`--paginate --slurp` is mandatory.** GitHub returns reviews 30 per page; a bot on a long-lived PR can have its blocking `CHANGES_REQUESTED` past the first page. Without paginating, that review is invisible and a genuine re-review silently falls back to the plain-comment path. `--slurp` collects every page into one array of arrays; the `add` concatenates them before filtering.

2. **Spawn the `reviewer` subagent with the PR target.** Use `run_in_background: true` so you stay responsive while the deep model works. Pass the PR URL (or `owner/repo#N`) plus any context the requester gave you (focus areas, specific files, etc.). The reviewer fetches the diff itself (`gh pr diff`, `gh api /repos/.../pulls/<n>`), loads the `code-review` skill, and returns a `<review>` block whose code findings carry `location="path:line"`.

   **If step 1 found an unresolved blocking obligation — a formal `CHANGES_REQUESTED` _or_ an unretracted flat-comment blocker — say so in the spawn payload** — e.g. _"This is a re-review: you previously blocked this PR (the prior blockers were …; the block was a formal `CHANGES_REQUESTED` / a flat PR comment). Verify they are resolved and return `approve` or `request-changes` — a re-review must re-decide the blocking state, not return `comment`."_ The reviewer's `code-review` skill enforces the same rule, but telling it the prior blockers (and which form they took) is what lets it apply that rule; a fresh reviewer session has no memory of your earlier block. The flat-comment case especially must be passed through — the reviewer cannot recover it from review state, so omitting it would silently drop the re-review context the moment the flow starts.

   Do **not** post an "on it" acknowledgement comment before spawning the reviewer — the runtime already adds an :eyes: reaction to the PR the moment it engages, so a "looking into this" comment is redundant noise. Just spawn the reviewer with `run_in_background: true`; the formal review is your reply. If you want to acknowledge explicitly, use `channel_react({ emoji: "eyes" })`, which reacts without posting a comment.

   After spawning, **end your turn** — the background reviewer wakes you with a completion `<system-reminder>` (step 3). "Stay responsive" means you remain free to handle _other_ chats meanwhile; it does **not** license you to keep working _this_ PR. Do not poll `subagent_output` in a busy-wait, and do not fill the wait by reviewing the diff yourself (see the exclusivity rule at the top of this flow). The next thing you do on this PR is read the reviewer's `<review>` block when the reminder arrives.

3. **On the completion `<system-reminder>`, first check you have not already posted — then** call `subagent_output({ task_id })` to read the reviewer's final assistant message.

   **One verdict per PR per request — guard this before you read or post anything.** The completion reminder is not a license to post; it is a wake-up. The very first thing you do on this turn is ask: have I **already posted a review or verdict on this PR during this engagement**? If yes, stop here — do not fetch the reviewer output, do not translate, do not post. Call `skip_response({ reason: "review already posted for this PR" })` and end the turn. Posting the reminder's result on top of a verdict you already shipped is how a PR ends up with two reviews — and if the two disagree (because the earlier one was your own premature take), it contradicts you in public. Only when no review has gone out yet do you proceed to read and post below — which is the normal path, since you waited for the reviewer instead of reviewing it yourself.

   With that confirmed, read the reviewer's final assistant message. The structured payload looks like:

   ```xml
   <review>
   <summary>...</summary>
   <findings>
     <finding severity="blocker|concern|nit|praise" location="path:line">
       <issue>...</issue>
       <evidence>...</evidence>
       <suggestion>...</suggestion>
     </finding>
   </findings>
   <verdict>approve | request-changes | comment</verdict>
   </review>
   ```

4. **Translate findings into a `gh api` review payload.** Each `<finding>` with `severity` of `blocker`, `concern`, or `nit` and a `location="path:line"` becomes one entry in `comments[]`. Compose the inline `body` from the reviewer's `<issue>` + `<evidence>` + `<suggestion>` verbatim (modulo markdown). Findings whose `location` is `general` (no file:line anchor) go into the top-level review `body` instead. **Skip `praise` findings when building `comments[]`** — if you want to surface them, weave them into the top-level `body`.

   **The verdict and the inline comments are independent. The verdict sets only the `event` field; it never decides whether you post `comments[]`.** Whenever there is at least one actionable finding (`blocker`/`concern`/`nit`) with a `location="path:line"`, you MUST submit a formal review via `POST /pulls/<N>/reviews` carrying those findings in `comments[]` — including when the verdict is `approve`. An `approve` with three nits is still a formal `APPROVE` review with three inline comments, **not** a plain approval and **not** a flattened summary. Collapsing inline findings into a single `channel_reply` or issue comment loses the line anchors the reviewer worked to produce.

   Map the reviewer's `<verdict>` to the GitHub `event`, and trust it — do not upgrade `comment` → `APPROVE` to seem agreeable, or downgrade `request-changes` → `COMMENT` to soften the tone:

   | Reviewer verdict  | GitHub `event`    |
   | ----------------- | ----------------- |
   | `approve`         | `APPROVE`         |
   | `request-changes` | `REQUEST_CHANGES` |
   | `comment`         | `COMMENT`         |

   **Operator approval policy.** If the inbound carries a note that PR approval is disabled (`channels.github.review.approve: false` — the adapter appends "Operator policy: PR approval is disabled for this agent" to the message), you must **not** submit an `APPROVE`. Map an `approve` verdict to `COMMENT` instead: post the same `<summary>` and all inline `comments[]` as a `COMMENT` review, just without the formal approval. `request-changes` and `comment` verdicts are unaffected (they never approve). Absent that note, approval is enabled and the table above applies unchanged.

   **Re-review.** If step 1 established this is a re-review (an unresolved blocking obligation of yours — a formal `CHANGES_REQUESTED` **or** an unretracted flat-comment blocker), the result MUST clear or re-assert that block — never a top-level PR comment. The clearing mechanics depend on which form the prior block took:
   - **Prior block was a formal `CHANGES_REQUESTED`.** It is sticky: **only** a fresh `APPROVE` from you, or a dismissal of your prior review, clears it. A plain issue comment does **not** clear it, and — critically — **neither does a `COMMENT` review.**
   - **Prior block was a flat comment** (no formal `CHANGES_REQUESTED` exists). There is no sticky GitHub state to clear, but the obligation is still yours to discharge as a **formal** review so the verdict finally lands as review state: submit `APPROVE` (resolved, approval enabled) or `REQUEST_CHANGES` (not resolved). Do not discharge a flat-comment block with another flat comment — that re-strands the verdict, the original bug.

   So even if the reviewer returns zero actionable findings, do **not** take the `comment` → top-level-comment branch below for a re-review. The reviewer's skill is instructed not to return `comment` on a re-review; if it does anyway despite a reachable diff, prefer `approve` when the prior blockers are visibly resolved in the diff, otherwise `request-changes` — and say which in your reasoning. Resolve the re-review by verdict:
   - **`request-changes`** — submit a fresh `REQUEST_CHANGES` review (re-asserts the block with the new findings). Straightforward.
   - **`approve`, approval enabled** — submit `APPROVE`. This clears the block.
   - **`approve`, approval disabled (`channels.github.review.approve: false`)** — you cannot `APPROVE`. How you close out depends on the prior block's form. **If the prior block was a flat comment** (no formal `CHANGES_REQUESTED`), there is no sticky state to clear: submit a `COMMENT` review carrying the `<summary>` so the verdict lands as review state, and you are done — nothing to dismiss. **If the prior block was a formal `CHANGES_REQUESTED`**, a `COMMENT` review will **not** clear the sticky block, so the PR would stay blocked by your stale review; clear it explicitly by **dismissing your own prior `CHANGES_REQUESTED` review**. Grab that review's `id` by re-running the step-1 formal-review query with the trailing filter changed from `| .state` to `| {state, id}` (same `select`), take the entry whose `state` is `CHANGES_REQUESTED`, then:

     ```sh
     gh api -X PUT /repos/owner/repo/pulls/<N>/reviews/<review_id>/dismissals -f message="Blockers resolved; dismissing my prior changes request per operator approval-disabled policy." -f event=DISMISS
     ```

     This transitions your review to `DISMISSED` and unblocks the PR without an approval. It needs the bot's installation to have **write** access (or to be on the branch's "who can dismiss reviews" list); if the dismissal returns 403, the block cannot be cleared under this policy — post the `<summary>` as a `COMMENT` review and say plainly in the body that the prior changes-request stands until a human dismisses it, rather than implying the PR is unblocked.

   Then submit the review. **Write the JSON payload to a file with the `write` tool, then run a single bare `gh api --input <file>`** — two steps:

   First write the payload to `workspace/review-<owner>-<repo>-<N>.json` (via the `write` tool, not bash). Use `workspace/`, **not** `/tmp` — the `write` tool's `nonWorkspaceWrite` guard blocks paths outside the agent's free-write zone, so a `/tmp` write is rejected. The PR-scoped filename (`<owner>-<repo>-<N>`) avoids collisions when you review several PRs at once. `workspace/` is gitignored, so the throwaway payload never lands in a commit:

   ```json
   {
     "event": "COMMENT",
     "body": "<reviewer's <summary> goes here>",
     "comments": [
       {
         "path": "src/foo.ts",
         "line": 42,
         "side": "RIGHT",
         "body": "<issue + evidence + suggestion from the reviewer's finding>"
       },
       { "path": "src/bar.ts", "line": 10, "side": "RIGHT", "body": "..." }
     ]
   }
   ```

   Then post it:

   ```sh
   gh api -X POST /repos/owner/repo/pulls/<N>/reviews --input workspace/review-<owner>-<repo>-<N>.json
   ```

   **A repo-targeting `gh` command must be a single bare `gh` invocation — no pipes, `;`, `&&`, heredocs, or command substitution.** The `github-cli-auth` plugin injects the GitHub App token into the command's environment, so any sibling/upstream stage in a pipeline would inherit a live token; the runtime blocks those shapes. That is why the old `cat <<'JSON' | gh api --input -` heredoc-pipe no longer works: write the JSON to a file and feed it with `--input <file>` instead. Do **not** use `-f body=...` or `-F 'comments[][body]=...'`: those go through shell argument parsing, so backticks trigger command substitution. The file passes the JSON through untouched — backticks, newlines, and `${...}` all survive verbatim. The same file-then-`--input` pattern applies to any `gh api` POST whose body contains backticks, embedded newlines, or shell metacharacters.

   Anchor mechanics: `line` is a line number **in the file**, not a position in the diff. `side: RIGHT` is the new revision (default for additions); `side: LEFT` is the old revision (use for comments on removed lines). For multi-line comments, also set `start_line` and `start_side` (same semantics). If you need to read whole files at the PR's head SHA to validate an anchor before posting, use `gh api /repos/owner/repo/contents/<path>?ref=<headRefOid>`.

5. **Verify the review actually landed before announcing it.** The `gh api` call can fail silently from the model's perspective — a permission denial, a bad `line` anchor, or a malformed payload returns an error you must not paper over. After submitting, confirm the review exists:

   ```sh
   gh api /repos/owner/repo/pulls/<N>/reviews --jq '.[-1] | {id, state, user: .user.login}'
   ```

   The returned `id`/`state` is your proof the formal review posted. If the call errored or the review is absent, do **not** fall back to a top-level `channel_reply` that _claims_ a review was posted — fix the payload (most often a `line` that isn't part of the diff; re-anchor it or move that finding to the top-level `body`) and resubmit. A trace reply that says "Posted review" when no review exists is worse than silence.

6. **The decoy reviewer is dropped for you — no action needed.** Under **GitHub App** auth, the adapter automatically removes the decoy reviewer from the PR's requested-reviewers list the moment your formal review lands (it reacts to your own `pull_request_review.submitted` webhook). Why this matters: GitHub auto-adds **you** (the App account) to the PR's reviewers when your review posts, but the **decoy** account would otherwise stay pinned as a perpetual "review requested", as if the review never happened. You do **not** need to issue a `DELETE /requested_reviewers` yourself — and you should not, since it would race the adapter's own cleanup. The removal is self-loop-safe: the adapter's `DELETE` is authenticated as the App, so the `review_request_removed` webhook carries your bot actor (`slug[bot]`) as `sender`, which the classifier drops (see "Self-loop safety" below). This is a no-op under **PAT** auth (no decoy) and for **plain-language**/**team** requests (no decoy user was placed). See [GitHub decoy reviewer](/docs/internals/github-decoy-reviewer).

7. **End the turn with `skip_response`, not a trace reply.** The formal review from step 4 already landed _in this PR_ — it carries the summary, the verdict, and the inline comments. A `channel_reply` here does **not** go to a separate operator channel; on GitHub it posts another public comment on the same PR. A one-line "Posted review on PR #N: …" narrated into the PR thread is meta-commentary addressed to a phantom operator, and it reads absurdly next to the review it claims to point at. So once step 5 confirms the review exists, call `skip_response({ reason: "review posted via gh api" })` to close the turn silently. Only fall back to `channel_reply` when there was **no** formal review to post — the zero-actionable-findings branch below uses `channel_reply`/issue comments _as_ the substantive reply.

### Zero actionable findings

A finding is "actionable" if its severity is `blocker`, `concern`, or `nit`. The inline-review post in step 4 applies whenever the actionable count is **at least one**. When the reviewer returns **exactly zero** actionable findings (only `praise`, or none), there is nothing to anchor inline — handle by verdict:

- `approve` → post a plain `APPROVE` with the `<summary>` as the review body (no `comments[]` array). **If the operator approval policy above disabled approval, submit a `COMMENT` review instead — same `<summary>` as the review body, `event: "COMMENT"`, no `comments[]` array. Keep it a formal review, not a top-level issue comment, so the review metadata and flow are preserved.** (Re-review caveat: a `COMMENT` review does **not** clear a sticky `CHANGES_REQUESTED` block. If this is a re-review under approval-disabled policy, follow the step-4 re-review branch — dismiss your prior review — instead of relying on this `COMMENT`.)
- `comment` → post the summary as a top-level PR comment via `gh api -X POST /repos/.../issues/<N>/comments` instead of submitting an empty review. **Exception — re-reviews:** if this is a re-review (you have an unresolved blocking obligation — a formal `CHANGES_REQUESTED` **or** an unretracted flat-comment blocker), a top-level comment discharges neither. Do not use this branch; resolve it via the step-4 re-review branch (`APPROVE` if resolved and approval is enabled, the dismissal endpoint if a formal block is resolved but approval is disabled, `REQUEST_CHANGES` if not resolved).
- `request-changes` → submit `REQUEST_CHANGES` with the `<summary>` as the review body and no `comments[]` array. This combination is rare (the reviewer's contract says `request-changes` requires at least one blocker or load-bearing concern); if it happens, faithfully encode the verdict and trust the reviewer's reasoning is in the summary.

The bundled `agent-browser` is **not** for PR reviews — `gh api` is faster and more reliable. Only use the browser when the API genuinely can't reach what you need.

## Resolving review threads you authored

A review you posted leaves inline comment threads open on the PR. When one of **your** threads is addressed — the author pushed a fix, or replied that they handled it — close it out by **resolving the thread**. Leaving it open after the concern is settled reads as if you never noticed; a resolved thread is the signal that the loop is closed.

**The base principle: whoever opened the thread closes it.** Resolve only threads whose root comment **you** authored. Never resolve a human reviewer's thread on your behalf — that erases their open question. The thread you can resolve is the one you started; the inbound that brings you here is a **review-thread reply on `pr:N` with `thread` set**, replying inside a thread you opened.

### When a thread counts as addressed

Do not resolve on a bare "done" claim. A reply that says "fixed" is a prompt to check, not proof. Before resolving, **verify the fix at the PR's current head SHA**:

1. Re-read the PR head: `gh pr view <N> --repo owner/repo --json headRefOid` gives you the SHA the author's latest push landed on.
2. Read the lines your comment anchored to, at that SHA: `gh api /repos/owner/repo/contents/<path>?ref=<headRefOid>` (or `gh pr diff <N>` to see what the new push changed). Confirm the change actually addresses the concern your comment raised — not a different line, not a partial fix.
3. Only when the code at head genuinely resolves the finding do you resolve the thread. If the fix is partial or misses the point, **reply in the thread** explaining what's still open and leave it unresolved.

If the author merely **replied** without pushing (e.g. "this is intentional because …") and their reasoning settles it, that is also "addressed". If their reasoning does **not** settle it, keep the thread open and answer instead.

### How to resolve — `channel_reply({ resolve_review_thread: true })`

Once you have verified the fix, **acknowledge and resolve in one call**: pass `resolve_review_thread: true` to your `channel_reply`. The runtime resolves the thread you're replying in **before** it posts your acknowledgement, then posts the reply:

```
channel_reply({ text: "Verified — the fix addresses the concern. Thanks!", resolve_review_thread: true })
```

This is the correct path and it removes a footgun. A bare `channel_reply` ends your turn the moment it lands, so a resolve attempted _after_ the acknowledgement would never run — the thread would stay open even though you "handled" it. The flag resolves first, so a normal final reply still closes the thread. You do **not** need `continue: true` for this: resolution happens inside the same call, before the turn ends.

Two guarantees make the flag safe to use as your default:

- **Author check is enforced in code.** The runtime only resolves a thread whose root comment **you** authored; a request to resolve a human reviewer's thread is refused, and the reply is **not** posted. You cannot accidentally close someone else's open question.
- **A failed resolve blocks the reply.** If the resolve fails (permission denied, wrong author, the fix doesn't verify on the API side), `channel_reply` is denied and posts nothing — so you never end up with a cheerful "looks resolved" comment sitting next to a still-open thread. Read the denial, fix the cause, and retry.

The flag is valid only on a github session replying inside a thread (`thread` set on the origin). It is ignored — and denied — elsewhere. If the thread is already resolved or already gone, the reply still posts (nothing left to close).

### Fallback — the raw `resolveReviewThread` GraphQL mutation

Prefer the flag above. Reach for the raw mutation only when you need to resolve a thread you are **not** currently replying in, or to debug. There is no REST endpoint for this. Resolution is a GraphQL mutation that takes the thread's **node id** (`PRRT_…`), not the comment's numeric id. Two steps: find the thread id, then resolve it.

1. **Find the node id of the thread you authored.** Query the PR's review threads and pick the one whose root comment is yours and matches the `thread` you're replying in:

   ```sh
   gh api graphql -f query='query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{id isResolved comments(first:1){nodes{databaseId author{login}}}}}}}}' -F owner=OWNER -F name=REPO -F number=N
   ```

   Match on the root comment: its `comments.nodes[0].databaseId` equals the root comment id (the `thread` value the inbound carried), and `author.login` is you. Skip threads already `isResolved: true`.

   **Paginate until you find the match — `first:100` is one page, not all threads.** A busy PR can carry more than 100 review threads, and yours may sit past the first page; stopping at page one would silently miss it and leave your thread open. Omit `-F after=…` on the first call, then while `pageInfo.hasNextPage` is true and you have not yet matched the `databaseId`, re-run the same query with `-F after=<endCursor>` from the previous page. Stop the moment the target thread is found (no need to walk the rest) or when `hasNextPage` is false (the thread is genuinely absent — don't fabricate a node id).

2. **Resolve it** with the node id from step 1:

   ```sh
   gh api graphql -f query='mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}' -F threadId=PRRT_xxx
   ```

   The returned `isResolved: true` is your proof it landed. As with every repo-targeting `gh` call, this is a **single bare `gh` invocation** — no pipes, `;`, `&&`, heredocs, or command substitution (the `github-cli-auth` plugin injects the App token into the command's environment; a pipeline would leak it). `-F` passes the id as a typed variable, so there is no shell-metacharacter hazard for the simple id/number values here.

### Self-loop safety — resolving never wakes you

Resolving your own thread is safe from the self-response loop. The `pull_request_review_thread.resolved` webhook that GitHub emits carries **you** as its `sender`, and the inbound classifier maps `pull_request_review_thread` events to their `sender` (not the PR opener) for the self-author drop — so the bot resolving a thread is recognized as self-authored and dropped, exactly like the decoy-reviewer cleanup in the PR review flow. You will not be re-woken by your own resolution. See "Self-loop safety" below.

## Opening new issues and PRs

The `gh` CLI is pre-authenticated via `GH_TOKEN` (injected by the adapter at startup). Use it to open new issues or PRs:

```sh
# Open a new issue
gh issue create --repo owner/repo --title "Bug: ..." --body "..."

# Open a new PR
gh pr create --repo owner/repo --title "Fix: ..." --head my-branch --base main --body "..."
```

For App auth, `GH_TOKEN` is an installation access token that refreshes automatically — it stays current as long as the adapter is running.

## Self-loop safety

The adapter will **not** wake you when you assign yourself as a reviewer (e.g., via `gh pr edit --add-reviewer`). It will only wake you when someone else requests your review.

The same guard covers **removing** a reviewer: when the adapter drops the decoy after your review lands (step 6 of the PR review flow), the `DELETE` is authenticated as the App, so the `review_request_removed` webhook GitHub emits carries your bot actor (`slug[bot]`) as its `sender`, which the classifier drops. So the cleanup never echoes back as a fresh wake. Both directions — add and remove — are matched on `sender.login` (against either the bot actor or its decoy), so any reviewer-list mutation made under your identity stays silent.
