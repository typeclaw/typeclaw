---
name: typeclaw-channel-github
description: Use this skill BEFORE every `channel_reply` or `channel_send` call whose adapter is `github`, AND before composing replies to GitHub-originated inbounds, AND before opening new issues or PRs with `gh`, AND ALWAYS when an inbound says "requested your review on PR #N" or "requested a review from team @… on PR #N" (the agent has been assigned as a reviewer and must delegate the analysis to the `reviewer` subagent, then translate its findings into line-by-line comments via `gh api`). GitHub renders **real markdown** — `**bold**`, `## headings`, `| tables |`, fenced code blocks, and `inline code` all render natively. Use rich markdown freely. GitHub cannot send file attachments via API — do not call `channel_send` with attachments on github chats. GitHub has no typing indicator. PR review threads use `thread` keyed on the root comment id; reply to a thread to stay in it, or omit `thread` to post a top-level issue/PR comment. To open new issues or PRs use the `gh` CLI — `GH_TOKEN` is pre-set by the adapter. Read this skill before composing anything on GitHub.
---

GitHub renders normal Markdown in issues, PRs, discussions, and review comments. Use headings, lists, tables, fenced code blocks, links, and inline code when they improve clarity.

- Do not send attachments on GitHub chats; the adapter rejects them.
- There is no typing indicator.
- For PR review threads, keep `thread` set to reply in-place. Omit `thread` for a top-level PR/issue comment.

## Opening new issues and PRs

The `gh` CLI is pre-authenticated via `GH_TOKEN` (injected by the adapter at startup). Use it to open new issues or PRs:

```sh
# Open a new issue
gh issue create --repo owner/repo --title "Bug: ..." --body "..."

# Open a new PR
gh pr create --repo owner/repo --title "Fix: ..." --head my-branch --base main --body "..."
```

For App auth, `GH_TOKEN` is an installation access token that refreshes automatically — it stays current as long as the adapter is running.

## Reviewing pull requests

When an incoming message says **"requested your review on PR #N"** (or "requested a review from team @… on PR #N"), you have been assigned as a reviewer. Do **not** review inline yourself and do **not** just reply in the channel — delegate the analysis to the bundled `reviewer` subagent, then translate its findings into line-by-line comments via `gh api`.

Why delegate: the `reviewer` subagent runs on the `deep` model profile, loads a curated `code-review` skill on demand, and produces a structured `<review>` block with severity-tagged findings. You are the integration layer between that output and GitHub's review API.

### Workflow

1. **Confirm the target.** Capture the PR number, the repo, and the head SHA — you'll need the SHA to read files at the revision the reviewer analyzed.

   ```sh
   gh pr view <N> --repo owner/repo --json title,body,baseRefName,headRefOid,files
   ```

2. **Fetch the diff and metadata, then spawn the `reviewer` with a structured `reviewTarget` payload.** The reviewer is sandboxed (no network, no credentials) and cannot call `gh` — YOU fetch the PR content, and the runtime stages the PR-head source tree for the reviewer. Use `run_in_background: true` so you stay responsive while the deep model works.

   ```sh
   gh pr diff <N> --repo owner/repo            # the unified diff to embed in the prompt
   ```

   Spawn with the structured payload so the runtime can stage the tree credential-blind:

   ```json
   {
     "subagent_type": "reviewer",
     "prompt": "<requester context + the gh pr diff output inline>",
     "payload": {
       "reviewTarget": { "kind": "github-pr", "owner": "owner", "repo": "repo", "pullNumber": <N>, "headSha": "<headRefOid>" }
     }
   }
   ```

   The runtime fetches the PR-head tarball and mounts it read-only at `/work` for the reviewer (no `gh`/network/token in the reviewer). The reviewer reads the inline diff for WHAT changed and traces the full staged tree for WHY, loads the matching skill (`code-review` for a code PR; `general` for a mixed-format change), and returns a `<review>` block.

3. **Wait for the completion `<system-reminder>`,** then call `subagent_output({ task_id })` to read the reviewer's final assistant message. The structured payload looks like:

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

4. **Translate findings into a `gh api` review payload.** Each `<finding>` with `severity` of `blocker`, `concern`, or `nit` and a `location="path:line"` becomes one entry in `comments[]`. Compose the inline `body` from the reviewer's `<issue>` + `<evidence>` + `<suggestion>` — preserve the reviewer's wording, do not paraphrase. Findings whose `location` is `general` (no file:line anchor) go into the top-level review `body` instead. **Skip `praise` findings when building `comments[]`** — they are not actionable, and inline praise comments are exactly the noise the reviewer is supposed to filter out at the source; if you want to surface them, weave them into the top-level review `body` alongside the summary. Map the reviewer's `<verdict>` to the GitHub `event`:

   | Reviewer verdict  | GitHub `event`    |
   | ----------------- | ----------------- |
   | `approve`         | `APPROVE`         |
   | `request-changes` | `REQUEST_CHANGES` |
   | `comment`         | `COMMENT`         |

   Then submit the review in one API call:

   ```sh
   cat <<'JSON' | gh api -X POST /repos/owner/repo/pulls/<N>/reviews --input -
   {
     "event": "COMMENT",
     "body": "<reviewer's <summary> goes here>",
     "comments": [
       { "path": "src/foo.ts", "line": 42, "side": "RIGHT", "body": "<issue + evidence + suggestion from the reviewer's finding>" },
       { "path": "src/bar.ts", "line": 10, "side": "RIGHT", "body": "..." }
     ]
   }
   JSON
   ```

   **Always use `--input -` with a quoted heredoc (`<<'JSON'`) for review bodies.** Do **not** use `-f body=...` or `-F 'comments[][body]=...'`: those go through shell argument parsing, so backticks (\`) trigger command substitution and have to be backslash-escaped, which leaks the literal `\` into the rendered comment. The quoted heredoc passes the JSON through untouched — backticks, newlines, and `${...}` all survive verbatim. The same applies to any other `gh api` POST whose body contains backticks, embedded newlines, or shell metacharacters.

5. **Post a one-line summary with `channel_reply`** so the conversation has a human-readable trace pointing at the review (e.g., "Posted review on PR #N: <verdict>, N findings.").

### Rules

- **Always delegate to the `reviewer` subagent.** Do not perform the review craft yourself. The reviewer is the source of truth for severity, evidence quality, and what counts as a finding. Your job is mechanics: spawn, wait, translate, post.
- **Trust the verdict.** Use the GitHub `event` mapped from the reviewer's `<verdict>`. Do not upgrade `comment` → `APPROVE` to seem agreeable, and do not downgrade `request-changes` → `COMMENT` to soften the tone. The reviewer chose deliberately.
- **No actionable findings → no inline review post.** A finding is "actionable" if its severity is `blocker`, `concern`, or `nit`. If the reviewer returns zero actionable findings:
  - `approve` verdict → post a plain `APPROVE` with the `<summary>` as the review body (no `comments[]` array).
  - `comment` verdict → post the summary as a top-level PR comment via `gh api -X POST /repos/.../issues/<N>/comments` instead of submitting an empty review.
  - `request-changes` verdict → submit `REQUEST_CHANGES` with the `<summary>` as the review body and no `comments[]` array. This combination is rare (the reviewer's contract says `request-changes` requires at least one blocker or load-bearing concern), so if it happens, faithfully encode the verdict and trust the reviewer's reasoning is in the summary.
- **Preserve the reviewer's wording.** Inline comment bodies should reflect the reviewer's `<issue>`, `<evidence>`, and `<suggestion>` verbatim (modulo markdown formatting). Paraphrasing dilutes the analysis — the deep-model reviewer chose those words on purpose.
- `line` is a line number **in the file**, not a position in the diff. `side: RIGHT` is the new revision (default for additions); `side: LEFT` is the old revision (use for comments on removed lines).
- For multi-line comments, also set `start_line` and `start_side` (same semantics).
- If you need to read whole files at the PR's head SHA, use `gh api /repos/owner/repo/contents/<path>?ref=<headRefOid>` — e.g., when validating a finding's `location` against the actual file before posting. The reviewer cannot do this (it has no `gh`/network); it reads the staged `/work` tree instead.
- The bundled `agent-browser` is **not** for PR reviews — `gh api` is faster and more reliable. Only use the browser when the API genuinely can't reach what you need.
- A `review_request_removed` event means the requester un-assigned you. Cancel any in-flight reviewer subagent (`subagent_cancel`) and do not post a partial review.

### Self-loop safety

The adapter will **not** wake you when you assign yourself as a reviewer (e.g., via `gh pr edit --add-reviewer`). It will only wake you when someone else requests your review.
