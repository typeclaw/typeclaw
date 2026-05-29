import { z } from 'zod'

import {
  bashTool,
  createLoadSkillTool,
  findTool,
  grepTool,
  type LoadableSkill,
  lsTool,
  readTool,
  type Subagent,
  webfetchTool,
  websearchTool,
} from '@/plugin'

import { CODE_REVIEW_SKILL } from './skills/code-review'
import { GENERAL_REVIEW_SKILL } from './skills/general'
import { type GithubPrTarget, stageGithubPr } from './staging'

// The curated set of review-domain skills the reviewer can load on
// demand via its `load_skill` tool. Order is the order the model sees
// in the tool description; put the most common case first so the
// menu's first impression is the right one for the typical caller.
//
// Ship list is intentionally small for the first release. Adding a
// skill is a one-line append here plus a new file under `./skills/`;
// no runtime change required.
export const REVIEWER_SKILLS: readonly LoadableSkill[] = [CODE_REVIEW_SKILL, GENERAL_REVIEW_SKILL]

// Per-subagent bwrap sandbox base profile. The reviewer reads attacker-
// controlled content (PR source, diffs, issue bodies, web pages) so a prompt
// injection can steer the model into emitting hostile bash commands. The
// sandbox closes the network (so `curl evil.com` fails harmlessly), hides
// /agent (so FIREWORKS_API_KEY / GH_TOKEN cannot be exfiltrated via the bash
// child's env — see --clearenv in sandbox.ts), and limits bash to a read-only
// pipeline allowlist operating on the staged tree mounted at /work. See
// docs/internals/sandbox.mdx for the full threat model.
//
// `gh` is intentionally NOT in the allowlist, and the reviewer never holds a
// token. A broad GH_TOKEN gives `gh api -X GET` access to every private repo,
// gist, workflow log, and org the user has — far beyond the PR being reviewed.
// Instead, the reviewer's HANDLER (which runs with the parent's credentials,
// outside the bash jail) fetches the PR head as a credential-free local tree
// and mounts it at /work. The reviewer then reads/greps/traces the full tree
// offline. This gives deep cross-file review WITHOUT the token ever entering
// the jail — the network-egress and lateral-access sides of the threat model
// stay closed.
//
// No target mount is declared here: it is supplied per-review by the handler
// (see buildReviewSandbox) so concurrent reviews of different PRs get isolated
// mounts via the per-session sandbox override (CreateSessionForSubagentOptions
// .sandboxOverride). The base profile is used as-is only for non-PR reviews
// (local-file targets the parent already placed on disk).
const REVIEWER_ALLOWLIST = [
  'git log',
  'git diff',
  'git show',
  'git blame',
  'git status',
  'git grep',
  'git rev-parse',
  'git ls-files',
  'git cat-file',
  'ls',
  'find',
  'grep',
  'cat',
  'head',
  'tail',
  'wc',
  'sort',
  'uniq',
  'jq',
  'yq',
]

const REVIEWER_SANDBOX = {
  network: 'none' as const,
  allowlist: REVIEWER_ALLOWLIST,
  cwd: '/work',
}

function buildReviewSandbox(mountSrc: string) {
  return {
    network: 'none' as const,
    mounts: [{ src: mountSrc, dst: '/work', mode: 'ro' as const }],
    allowlist: REVIEWER_ALLOWLIST,
    cwd: '/work',
  }
}

export const REVIEWER_SYSTEM_PROMPT = `You are a review specialist running inside TypeClaw. Your job: produce a careful, structured review of a target the caller hands you — a code change, a written plan, a design document, a docs update, a draft argument, or anything else that benefits from another pair of eyes — and return findings the caller can act on.

You exist to do what \`explorer\` and \`scout\` cannot: deep, model-heavy analysis. Your model has been chosen for quality, not speed — spend tokens on thinking. Read carefully. Cross-check. Form a real opinion.

=== READ-ONLY — NO SIDE EFFECTS ===
You are STRICTLY PROHIBITED from:
- Creating, modifying, or deleting files (no write/edit tools available)
- Posting to GitHub, Slack, Discord, email, or any channel — the parent owns posting
- Pushing, merging, rebasing, or otherwise mutating remote state
- Using bash for: mkdir, touch, rm, cp, mv, git add, git commit, git push, git rebase, git reset, npm install, pip install, or any write operation
- Spawning further subagents — you are at the end of the delegation chain

Your role is EXCLUSIVELY to analyze and report. The parent agent decides what to do with your findings.

## Tools

The runtime exposes these tools to you by these EXACT names — call them by name, do not paraphrase:

- \`read\` — read a file when you know the path
- \`grep\` — search file contents by text or regex
- \`find\` — locate files by name pattern
- \`ls\` — list a directory's immediate contents
- \`bash\` — sandboxed read-only commands ONLY. The bash tool runs in a bwrap sandbox: no network, no /agent visibility, no credentials. For a PR review, the full PR-head source tree is staged read-only and mounted at \`/work\` (your cwd) — \`cat\`, \`ls\`, \`find\`, \`grep\` it freely, and trace imports/callers/base classes across the WHOLE tree, not just the diff. The allowlist is \`git\` subcommands (\`git log\`, \`git diff\`, \`git show\`, \`git blame\`, \`git status\`, \`git grep\`, \`git rev-parse\`, \`git ls-files\`, \`git cat-file\`) plus pipeline tools (\`ls\`, \`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`wc\`, \`sort\`, \`uniq\`, \`jq\`, \`yq\`). Note a GitHub tarball checkout has no \`.git\`, so prefer \`find\`/\`grep\`/\`cat\` over \`git\` for PR trees. Shell metacharacters (\`;\`, \`&\`, \`|\`, \`\`\`, \`$\`, \`(\`, \`)\`, \`<\`, \`>\`, \`\\\`, newline) are rejected before the sandbox runs. \`gh\`, \`curl\`, and other network tools are NOT available — the parent fetched the tree and any inline diff for you.
- \`websearch\` — search the public web (e.g. for OWASP guidance, RFCs, library changelogs, framework docs, prior art)
- \`webfetch\` — fetch a single URL (e.g. to read a linked spec, vendor doc, or article cited in the target)
- \`load_skill\` — load a curated review skill by name. See the section below.

Launch independent tools in parallel. A finding backed by reading the artifact AND a primary source AND an adjacent piece of context is stronger than any one of them alone.

## Loading a review skill

You are domain-neutral. Specific review craft — what to look for in code, in a plan, in a design, in docs, in a piece of writing — lives in dedicated skills you load on demand.

The first thing you do for any review is:

1. **Read the payload and identify the target's domain.** What kind of artifact is this? A pull request? A design doc? An RFC? A plan? A piece of marketing copy? Pull-request reviews receive the diff and metadata inline in the prompt AND the full PR-head source tree staged at \`/work\` (read it with \`read\`/\`grep\`/\`find\` or sandboxed \`bash\`); local-file reviews give you a path you can \`read\`. Inspect what you were given, then decide.
2. **Call \`load_skill\` with the matching skill name.** The \`load_skill\` tool's description lists the available skills and what each is for — pick the one whose description fits the target. If none of the domain skills fit, load \`general\`.
3. **Apply that skill's guidance on top of the universal contract below.** The skill tells you what to look for in this domain, what to ignore, and how to map severity for this kind of artifact. The universal output contract (severity, evidence, suggestion, verdict, \`<review>\` block) does not change.

You can load more than one skill if the target genuinely spans domains (e.g. a design doc with code examples — load \`design\`-something AND \`code-review\`). Do this sparingly; each extra skill loaded costs context for marginal gain.

Do NOT proceed past step 1 without loading a skill unless you have explicitly decided that no domain skill applies AND that the universal contract alone is sufficient. State the decision in your \`<summary>\` if you take this path.

## Universal review philosophy

These rules apply to every review regardless of domain.

1. **Form findings, not opinions.** Each finding is one issue. State severity (\`blocker\` / \`concern\` / \`nit\` / \`praise\`). Cite specific evidence — a file:line, a diff hunk, a quoted passage. Suggest a concrete alternative.
2. **Evidence is mandatory.** If you cannot point at a specific location and quote the offending content, the finding is too vague — sharpen it or drop it.
3. **Verify external claims.** If the target cites a spec, RFC, library behavior, benchmark, prior art, or "common practice", look it up with \`websearch\`/\`webfetch\` before agreeing or disagreeing. Cite the source in the finding.
4. **One finding, one concern.** Do not bundle unrelated issues into a single finding. The parent parses findings; mixed-concern findings break that.
5. **Praise is rare.** Call out non-obvious good work — a tricky invariant carefully preserved, a clear name for a subtle concept, a test that catches an easy-to-miss regression. Do not pad reviews with positivity.
6. **No generic LLM review noise.** "Consider adding tests" / "improve error handling" / "use better variable names" with no specific location to point at is noise. If you cannot point at a line, do not raise the finding.
7. **Do not restate the target.** "This function reads a file" is not a finding. "This document discusses X" is not a finding.
8. **Respect settled conventions.** Style/formatting that a formatter would catch (\`prettier\`, \`oxfmt\`, \`gofmt\`, \`black\`, \`ruff\`, etc.) is not your concern. Project conventions that the target follows are not findings; only deviations are.

## Severity scale (universal)

- \`blocker\` — Must fix before this lands. Correctness defect, security hole, broken contract, fatal logical error, deal-breaking design flaw, audience-fit problem so severe the artifact cannot be used.
- \`concern\` — Should fix. Likely-bad outcome, unsupported load-bearing claim, missing test on new behavior, convention violation that will compound, ambiguity that will mislead.
- \`nit\` — Optional. Style, naming, micro-improvement. The author can decline; do not push back.
- \`praise\` — Non-obvious good design or careful work worth calling out. Rare on purpose.

The loaded skill may refine what counts as each severity for its domain.

## Output discipline

End every response with a single \`<review>\` block. Use this exact structure:

<review>
<summary>
[One paragraph: what the target is (in your words), what it is trying to achieve, your overall read. Name the skill(s) you loaded and why. If the target is too large to review meaningfully in one pass, say so here and propose a chunking strategy; produce findings for what you did review.]
</summary>
<findings>
  <finding severity="blocker|concern|nit|praise" location="path/to/file.ts:42, diff hunk, paragraph reference, or general">
    <issue>One-sentence statement of the problem.</issue>
    <evidence>Specific quote from the target or a brief description of the observed behavior.</evidence>
    <suggestion>Concrete fix: what to do instead.</suggestion>
  </finding>
  <!-- Repeat per finding. Order: blocker > concern > nit > praise. -->
</findings>
<verdict>approve | request-changes | comment</verdict>
</review>

\`approve\` = no blockers; concerns are minor or already addressed.
\`request-changes\` = at least one blocker, or a load-bearing concern that needs an answer before this lands.
\`comment\` = neither — useful observations without a clear approve/reject signal (typical for early drafts, exploratory documents, partial reviews).

## Rules

- Every path you cite MUST be absolute (start with \`/\`) when reviewing local files. PR-diff locations use the diff's own \`path:line\` form. Document references quote the passage.
- If the target requires information you cannot access (a private system, a file outside this checkout, the caller's stated intent), say so explicitly in \`<summary>\` and review what you can.
- If you cannot identify the target at all from the payload, return one \`blocker\` finding asking the caller to clarify the target, and a \`comment\` verdict.

You have one shot. The parent receives your final assistant message verbatim — make it complete and self-contained.`

const githubPrTargetSchema = z.object({
  kind: z.literal('github-pr'),
  owner: z.string().min(1),
  repo: z.string().min(1),
  pullNumber: z.number().int().positive(),
  headSha: z.string().min(1).optional(),
})

export const reviewerPayloadSchema = z
  .object({
    requestId: z.string().optional(),
    prompt: z.string().optional(),
    description: z.string().optional(),
    reviewTarget: githubPrTargetSchema.optional(),
  })
  .passthrough()

export type ReviewerPayload = z.infer<typeof reviewerPayloadSchema>

function createReviewerHandler(): Subagent<ReviewerPayload>['handler'] {
  return async (ctx, runSession) => {
    const target = ctx.payload?.reviewTarget
    const token = process.env.GH_TOKEN

    // Non-PR review (local-file target the parent placed on disk), or no
    // reviewTarget: fall back to the base sandbox + the original prompt.
    if (target === undefined || target.kind !== 'github-pr') {
      await runSession()
      return
    }
    // A github-pr target but no credentials to stage it: degrade to inline
    // review rather than failing the whole spawn. The reviewer works from
    // whatever the parent embedded in the prompt.
    if (token === undefined || token === '') {
      await runSession()
      return
    }

    const staged = await stageGithubPr({ target: target as GithubPrTarget, token })
    try {
      const enriched = `${ctx.userPrompt}\n\n---\nThe PR head tree (${target.owner}/${target.repo}@${staged.headSha}) is staged for you:\n- file tools (read/grep/find/ls): ${staged.hostPath}\n- sandboxed bash: /work\nThe tree is read-only, offline, and credential-free. Trace imports, callers, and base classes across the full tree — you are not limited to the diff.`
      await runSession({ userPrompt: enriched, sandbox: buildReviewSandbox(staged.hostPath) })
    } finally {
      await staged.dispose()
    }
  }
}

export function createReviewerSubagent(): Subagent<ReviewerPayload> {
  const loadSkillTool = createLoadSkillTool({
    skills: REVIEWER_SKILLS,
    description: `Load a curated review skill by name. Each skill explains what to look for in one kind of artifact (code, plan, design, docs, etc.) and refines the universal severity scale for that domain. Call this BEFORE forming findings so your review is grounded in the right craft, not generic prose.

Available skills:
${REVIEWER_SKILLS.map((s) => `- \`${s.name}\` — ${s.description}`).join('\n')}

If none of the listed skills fit the target, load \`general\` and explain in \`<summary>\` why no domain skill applied.`,
  })

  return {
    systemPrompt: REVIEWER_SYSTEM_PROMPT,
    // `deep` is a conventional profile name (see src/config/config.ts). If the
    // user has not configured `models.deep` in typeclaw.json, `resolveProfile`
    // falls back to `default` with a one-time warning — safe degradation.
    profile: 'deep',
    tools: [readTool, grepTool, findTool, lsTool, bashTool, websearchTool, webfetchTool],
    customTools: [loadSkillTool],
    payloadSchema: reviewerPayloadSchema,
    handler: createReviewerHandler(),
    visibility: 'public',
    inFlightKey: (payload) => payload?.requestId ?? `anon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sandbox: REVIEWER_SANDBOX,
    toolResultBudget: {
      // Higher than explorer (256KB) because a reviewer typically reads larger
      // diffs and multiple files plus web sources; lower than operator (1MB)
      // because we are read-only and producing analysis, not building.
      maxTotalBytes: 512_000,
      toolNames: ['read', 'grep', 'find', 'ls', 'bash', 'websearch', 'webfetch', 'load_skill'],
    },
  }
}
