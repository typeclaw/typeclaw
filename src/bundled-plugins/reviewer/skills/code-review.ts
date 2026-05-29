import type { LoadableSkill } from '@/plugin'

export const CODE_REVIEW_SKILL_NAME = 'code-review'

export const CODE_REVIEW_SKILL_DESCRIPTION =
  'Review code: a pull request, a commit, a single file, or a module. Covers correctness, security, architecture fit, test coverage, performance, error handling, API surface, naming, and project conventions.'

export const CODE_REVIEW_SKILL_CONTENT = `# code-review

You have been asked to review code. Apply this guidance on top of the reviewer's neutral output contract (severity-tagged findings, evidence quotes, suggestions, verdict).

## How to acquire the target

- **PR review** — the parent fetched the diff, title, body, labels, and linked issues before spawning you and embedded them in the prompt, AND staged the full PR-head source tree read-only at \`/work\` (your bash cwd; also readable via \`read\`/\`grep\`/\`find\` at the absolute path named in the prompt). Use the diff to see WHAT changed; use the staged tree to trace WHY — follow imports, read the callers of a changed function, open the base class a changed method overrides. You are NOT limited to the diff. The bash tool runs sandboxed without network access and without credentials; \`gh\` is not available. A GitHub tarball checkout has no \`.git\`, so use \`find\`/\`grep\`/\`cat\` (not \`git log\`/\`git diff\`) to explore the staged tree. If you need PR context that is neither in the prompt nor in the staged tree, ask the parent to fetch it; do not attempt to call \`gh\` yourself.
- **File path / module path** — \`read\` the file directly; \`ls\` the parent directory to understand its neighbors; \`grep\` for callers of any function the file exports.

## How to build context

A finding without context is noise. Before forming findings:

1. **Read the change description.** PR body, commit messages, linked issues. The author told you what they intended — verify the code matches.
2. **Read adjacent code.** A change to one function means reading callers and callees. A change to a class means reading the rest of the class and its subclasses.
3. **Read the project's conventions.** \`AGENTS.md\`, \`CONTRIBUTING.md\`, \`CLAUDE.md\`, \`README.md\`, the test layout, the linter config. Deviation from established convention is a finding worth raising; following convention is not worth praising.
4. **Read the tests.** Existing tests show what the project considers important to verify. New tests show what the author considers important to lock in. The gap between them is often where the bugs hide.

## What to look for

Prioritize in this order:

1. **Correctness.** Does the change do what its description claims? Off-by-one errors, missing null/undefined handling, race conditions, incorrect error propagation, broken invariants.
2. **Security.** Injection vectors (SQL, shell, HTML), missing authz/authn checks, secret leakage in logs or error messages, unsafe deserialization, SSRF, path traversal, time-of-check-time-of-use. Cite OWASP / CWE / RFC by number when relevant; verify with \`websearch\` or \`webfetch\` before asserting.
3. **Architecture fit.** Does the change respect existing layering? Does it introduce a new dependency where the existing pattern would have worked? Does it duplicate logic that already exists elsewhere in the repo?
4. **Test coverage.** New behavior should have new tests. Edge cases the description names should be tested. If existing tests were deleted or skipped, that is a blocker absent a stated reason.
5. **Error handling.** Empty catch blocks, swallowed errors, errors converted to silent fallbacks, retry loops without bounded backoff, missing timeouts on external calls.
6. **Performance.** Quadratic loops in hot paths, missing indexes, unbounded memory accumulation, N+1 queries, blocking I/O in async hot paths. Performance findings need evidence: cite the loop, the data scale, the actual hot path. "Could be slow" without evidence is not a finding.
7. **API surface.** Breaking changes to exported types, function signatures, CLI flags, env vars, on-disk schemas. Are they documented? Versioned? Migration noted in CHANGELOG / release notes?
8. **Naming.** Names that lie (a function called \`getUser\` that mutates), names that hide intent (\`data\`, \`info\`, \`tmp\`), names that don't match the project's vocabulary.

## What NOT to find

- **Formatter / linter territory.** If the project has \`prettier\`, \`oxfmt\`, \`gofmt\`, \`black\`, \`ruff\`, \`eslint\`, etc., assume it ran. Do not raise spacing, trailing commas, single-vs-double quotes, line length, or import order.
- **Settled convention objections.** If the project uses tabs, four-space indent, camelCase vs snake_case, etc., and the change matches, that is not a finding. Only the deviation is.
- **Generic best-practice essays.** "Consider adding more tests" without naming a specific untested branch is noise. "Improve error handling" without pointing at a specific swallowed error is noise.
- **Restating the code.** "This function reads the file and returns its contents" is not a finding.

## Severity hints specific to code

- **blocker** — Correctness bug that will misbehave for users. Security vulnerability. Broken backward compatibility without migration. Crashing path on common input. Deleted tests without justification.
- **concern** — Likely-bad outcome that hasn't bitten yet (missing timeout, unbounded retry, edge case ignored). Test gap on the new behavior. Architectural deviation that compounds.
- **nit** — Naming, micro-readability, suboptimal-but-correct code. Optional. The author can decline and you should not push back.
- **praise** — Non-obvious good design: a tricky invariant carefully preserved, a test that catches a subtle regression, a name that captures the domain precisely. Rare on purpose.

## Verdict mapping

- **approve** — Zero blockers. Concerns are minor, isolated, or already discussed.
- **request-changes** — At least one blocker, OR a load-bearing concern that needs an answer before this lands.
- **comment** — Mixed signal: useful observations without a clear approve/reject. Common on large refactors where you reviewed part of the change, or on early-draft PRs where the author asked for direction more than approval.

## Final output

Return findings inside the reviewer's neutral \`<review>\` block. Do NOT invent your own output format. The parent agent parses the structured shape.
`

export const CODE_REVIEW_SKILL: LoadableSkill = {
  name: CODE_REVIEW_SKILL_NAME,
  description: CODE_REVIEW_SKILL_DESCRIPTION,
  content: CODE_REVIEW_SKILL_CONTENT,
}
