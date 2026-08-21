import type { ReviewOutputState, ReviewVerdict } from '@/channels/github-review-turn-ledger'

// Extracts the formal-review verdict a successful `gh` command landed, so the
// false-receipt ledger can credit it. Covers the three vectors the agent uses to
// post a review: REST create-review via `--input <file>`, REST create-review via
// inline `-f/-F event=...`, and the `gh pr review` porcelain. Returns null when
// the command is not a verdict-bearing review submission (incl. COMMENT reviews,
// which carry no false-receipt risk and are not tracked).
//
// The `gh` invocation does NOT have to lead the command. The observed duplicate-
// approval incident used four different shapes — `cd /agent && gh api …`,
// `tmp=$(mktemp); … ; gh api --input "$tmp"`, a heredoc-then-`gh` two-stager, and
// the canonical bare `gh api …`. Only the bare shape was detected, so the
// idempotency guard never armed for the other three and the duplicates landed.
// Detection therefore scans every shell-separated segment for a `gh` invocation,
// independent of `analyzeGhCommand` (which is a token-injection-safety gate, not a
// proxy for "will this command execute" — a classic PAT skips that block).

// `source` drives success detection downstream: the REST endpoints echo the
// created review JSON, while the `gh pr review` porcelain prints a plain
// confirmation line — so each needs its own success markers (see review-recorder).
export type DetectedReview = {
  workspace: string
  prNumber: number
  verdict: ReviewVerdict
  source: 'api' | 'pr-review'
}

export type GhReviewDetectInput = {
  command: string
  // Contents of the file named by `--input <file>`, when the caller resolved it.
  // Kept as an injected value so this module does no I/O and stays sync+pure.
  inputFileContents?: string | null
}

// `gh api` accepts the endpoint with or without a leading slash
// (`repos/o/r/pulls/N/reviews` and `/repos/…` both work), so the match is
// anchored on a `repos/` boundary, not a slash. The observed compound shape
// `cd /agent && gh api -X POST repos/o/r/pulls/224/reviews …` used the
// slash-less form and was missed by the slash-anchored pattern.
const REVIEWS_ENDPOINT = /(?:^|\/)repos\/([^/\s]+)\/([^/\s]+)\/pulls\/(\d+)\/reviews\b/

export function detectReviewSubmission(input: GhReviewDetectInput): DetectedReview | null {
  const fileContents = input.inputFileContents ?? null
  for (const segment of ghSegments(input.command)) {
    const detected = detectInGhSegment(segment, fileContents)
    if (detected !== null) return detected
  }
  return null
}

// A landed review of ANY state — the two decisive verdicts PLUS a COMMENT. Feeds
// the router's empty-turn guard (a COMMENT is real user-facing output, so an empty
// completion afterward must not fire the "I got stuck" fallback). Deliberately
// SEPARATE from detectReviewSubmission, which stays verdict-only for the
// false-receipt ledger: a COMMENT carries no verdict-claim risk and must never be
// credited there. A bare create-review with no event (a PENDING draft, not a
// submitted review) returns null — only a submitted state counts as output.
export type DetectedReviewOutput = {
  workspace: string
  prNumber: number
  state: ReviewOutputState
  source: 'api' | 'pr-review'
}

export function detectReviewOutput(input: GhReviewDetectInput): DetectedReviewOutput | null {
  const fileContents = input.inputFileContents ?? null
  for (const args of ghSegments(input.command)) {
    const sub = args[1]
    if (sub === 'api') {
      const out = detectApiReviewOutput(args, fileContents)
      if (out !== null) return out
    } else if (sub === 'pr' && args[2] === 'review') {
      const out = detectPrReviewOutput(args)
      if (out !== null) return out
    }
  }
  return null
}

function detectApiReviewOutput(args: readonly string[], fileContents: string | null): DetectedReviewOutput | null {
  const endpoint = args.find((a) => REVIEWS_ENDPOINT.test(a))
  if (endpoint === undefined) return null
  const m = REVIEWS_ENDPOINT.exec(endpoint)
  if (m === null) return null
  const prNumber = Number(m[3])
  if (!Number.isSafeInteger(prNumber)) return null
  const state = reviewStateFromInlineFields(args) ?? reviewStateFromFile(fileContents)
  if (state === null) return null
  return { workspace: `${m[1]}/${m[2]}`, prNumber, state, source: 'api' }
}

function detectPrReviewOutput(args: readonly string[]): DetectedReviewOutput | null {
  const state: ReviewOutputState | null = args.includes('--approve')
    ? 'APPROVE'
    : args.includes('--request-changes')
      ? 'REQUEST_CHANGES'
      : args.includes('--comment') || args.includes('-c')
        ? 'COMMENT'
        : null
  if (state === null) return null
  const workspace = repoFromFlag(args)
  const prNumber = prNumberArg(args)
  if (workspace === null || prNumber === null) return null
  return { workspace, prNumber, state, source: 'pr-review' }
}

function reviewStateFromInlineFields(args: readonly string[]): ReviewOutputState | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === undefined) continue
    if (a === '-f' || a === '-F' || a === '--field' || a === '--raw-field') {
      const v = parseEventState(args[i + 1])
      if (v !== null) return v
    }
    if (a.startsWith('-f=') || a.startsWith('-F=') || a.startsWith('--field=') || a.startsWith('--raw-field=')) {
      const v = parseEventState(a.slice(a.indexOf('=') + 1))
      if (v !== null) return v
    }
  }
  return null
}

function parseEventState(token: string | undefined): ReviewOutputState | null {
  if (token === undefined) return null
  const eq = token.indexOf('=')
  if (eq === -1) return null
  if (token.slice(0, eq).trim().toLowerCase() !== 'event') return null
  return normalizeReviewState(token.slice(eq + 1))
}

function reviewStateFromFile(contents: string | null): ReviewOutputState | null {
  if (contents === null || contents === '') return null
  try {
    const parsed = JSON.parse(contents) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    const event = (parsed as Record<string, unknown>).event
    return typeof event === 'string' ? normalizeReviewState(event) : null
  } catch {
    return null
  }
}

function normalizeReviewState(value: string): ReviewOutputState | null {
  const v = value.trim().toUpperCase()
  if (v === 'APPROVE') return 'APPROVE'
  if (v === 'REQUEST_CHANGES') return 'REQUEST_CHANGES'
  if (v === 'COMMENT') return 'COMMENT'
  return null
}

// Each segment is the argv of one `gh` invocation found anywhere in the command.
function detectInGhSegment(args: readonly string[], fileContents: string | null): DetectedReview | null {
  const sub = args[1]
  if (sub === 'api') return detectApiReview(args, fileContents)
  if (sub === 'pr' && args[2] === 'review') return detectPrReview(args)
  return null
}

export type ReviewSubmissionAttempt = { workspace: string; prNumber: number }

// Submission INTENT, verdict aside: a `gh api .../pulls/N/reviews` with a POST
// method, or a `gh pr review N` carrying a verdict flag. Gates the post-execution
// backstop so it only fires for a command that actually tried to CREATE a review.
// A bare `gh api .../pulls/N/reviews` is a GET that LISTS existing reviews; its
// response array can contain `"state":"APPROVED"` and a pulls URL, which would
// otherwise make the backstop credit a review that never landed this turn. A read
// is not an attempt and returns null here.
export function detectReviewSubmissionAttempt(command: string): ReviewSubmissionAttempt | null {
  for (const args of ghSegments(command)) {
    const attempt = attemptInGhSegment(args)
    if (attempt !== null) return attempt
  }
  return null
}

function attemptInGhSegment(args: readonly string[]): ReviewSubmissionAttempt | null {
  const sub = args[1]
  if (sub === 'api') {
    if (!isPostMethod(args)) return null
    const endpoint = args.find((a) => REVIEWS_ENDPOINT.test(a))
    if (endpoint === undefined) return null
    const m = REVIEWS_ENDPOINT.exec(endpoint)
    if (m === null) return null
    const prNumber = Number(m[3])
    if (!Number.isSafeInteger(prNumber)) return null
    return { workspace: `${m[1]}/${m[2]}`, prNumber }
  }
  if (sub === 'pr' && args[2] === 'review') {
    const detected = detectPrReview(args)
    return detected === null ? null : { workspace: detected.workspace, prNumber: detected.prNumber }
  }
  return null
}

// `gh api` defaults to GET; creating a review is a POST. Accept `-X POST` /
// `--method POST` in both `flag value` and `flag=value` shapes, case-insensitive.
function isPostMethod(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === undefined) continue
    if ((a === '-X' || a === '--method') && (args[i + 1] ?? '').toUpperCase() === 'POST') return true
    if ((a.startsWith('-X=') || a.startsWith('--method=')) && a.slice(a.indexOf('=') + 1).toUpperCase() === 'POST') {
      return true
    }
  }
  return false
}

function detectApiReview(args: readonly string[], fileContents: string | null): DetectedReview | null {
  const endpoint = args.find((a) => REVIEWS_ENDPOINT.test(a))
  if (endpoint === undefined) return null
  const m = REVIEWS_ENDPOINT.exec(endpoint)
  if (m === null) return null
  const workspace = `${m[1]}/${m[2]}`
  const prNumber = Number(m[3])
  if (!Number.isSafeInteger(prNumber)) return null

  const verdict = verdictFromInlineFields(args) ?? verdictFromFile(fileContents)
  if (verdict === null) return null
  return { workspace, prNumber, verdict, source: 'api' }
}

// Inline `-f event=APPROVE` / `--field event=REQUEST_CHANGES` (and `-F` raw).
// gh accepts both `flag value` and `flag=value` shapes; cover both.
function verdictFromInlineFields(args: readonly string[]): ReviewVerdict | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === undefined) continue
    if (a === '-f' || a === '-F' || a === '--field' || a === '--raw-field') {
      const v = parseEventAssignment(args[i + 1])
      if (v !== null) return v
    }
    if (a.startsWith('-f=') || a.startsWith('-F=') || a.startsWith('--field=') || a.startsWith('--raw-field=')) {
      const v = parseEventAssignment(a.slice(a.indexOf('=') + 1))
      if (v !== null) return v
    }
  }
  return null
}

function parseEventAssignment(token: string | undefined): ReviewVerdict | null {
  if (token === undefined) return null
  const eq = token.indexOf('=')
  if (eq === -1) return null
  if (token.slice(0, eq).trim().toLowerCase() !== 'event') return null
  return normalizeVerdict(token.slice(eq + 1))
}

function verdictFromFile(contents: string | null): ReviewVerdict | null {
  if (contents === null || contents === '') return null
  try {
    const parsed = JSON.parse(contents) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    const event = (parsed as Record<string, unknown>).event
    return typeof event === 'string' ? normalizeVerdict(event) : null
  } catch {
    return null
  }
}

function detectPrReview(args: readonly string[]): DetectedReview | null {
  const verdict =
    args.includes('--approve') || args.includes('-a')
      ? 'APPROVE'
      : args.includes('--request-changes') || args.includes('-r')
        ? 'REQUEST_CHANGES'
        : null
  if (verdict === null) return null
  const urlTarget = prUrlTarget(args)
  const workspace = repoFromFlag(args) ?? urlTarget?.workspace ?? null
  const prNumber = prNumberArg(args) ?? urlTarget?.prNumber ?? null
  if (workspace === null || prNumber === null) return null
  return { workspace, prNumber, verdict, source: 'pr-review' }
}

function prUrlTarget(args: readonly string[]): { workspace: string; prNumber: number } | null {
  for (const arg of args) {
    const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(arg)
    if (match === null) continue
    const prNumber = Number(match[3])
    if (!Number.isSafeInteger(prNumber)) return null
    return { workspace: `${match[1]}/${match[2]}`, prNumber }
  }
  return null
}

function repoFromFlag(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === undefined) continue
    if ((a === '-R' || a === '--repo') && isRepoSlug(args[i + 1])) return args[i + 1] as string
    if (a.startsWith('--repo=') && isRepoSlug(a.slice('--repo='.length))) return a.slice('--repo='.length)
    if (a.startsWith('-R=') && isRepoSlug(a.slice('-R='.length))) return a.slice('-R='.length)
  }
  return null
}

function prNumberArg(args: readonly string[]): number | null {
  const start = args.indexOf('review') + 1
  for (let i = start; i < args.length; i++) {
    const a = args[i]
    if (a === undefined) continue
    if (a.startsWith('-')) continue
    if (/^\d+$/.test(a)) {
      const n = Number(a)
      return Number.isSafeInteger(n) ? n : null
    }
  }
  return null
}

function normalizeVerdict(value: string): ReviewVerdict | null {
  const v = value.trim().toUpperCase()
  if (v === 'APPROVE') return 'APPROVE'
  if (v === 'REQUEST_CHANGES') return 'REQUEST_CHANGES'
  return null
}

function isRepoSlug(value: string | undefined): boolean {
  if (value === undefined) return false
  const [owner, name, ...rest] = value.split('/')
  return owner !== undefined && owner !== '' && name !== undefined && name !== '' && rest.length === 0
}

// Yields the argv of every `gh` invocation in the command, one per shell-
// separated segment. A segment runs from one command separator (`&&`, `||`, `;`,
// `|`, newline) to the next; within it we strip leading `VAR=value` assignments
// (so `tmp=$(mktemp) gh …` and a `VAR=…` prefix both still see `gh` first) and
// recognise `gh` as the segment's command word. Quote-aware so an embedded `;`
// or `gh` inside a quoted body (e.g. a review `-f body='…'`) is not mistaken for
// a separator or a second invocation.
function* ghSegments(command: string): Generator<readonly string[]> {
  for (const segment of splitSegments(command)) {
    const args = stripLeadingAssignments(segment)
    if (args[0] === 'gh') yield args
  }
}

// Drop leading `NAME=value` tokens (env-var prefixes) so the command word that
// follows them is the one we classify. `tmp=$(mktemp)` tokenises to a single
// `tmp=$(mktemp)` token here (the `$(…)` stays attached), which this skips.
function stripLeadingAssignments(args: readonly string[]): readonly string[] {
  let i = 0
  while (i < args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[i] as string)) i++
  return args.slice(i)
}

// Quote-aware split into shell segments AND tokens. Segments break on top-level
// `&&`, `||`, `;`, `|`, and newlines (outside quotes). Heredoc bodies are NOT
// modelled — a heredoc writes a payload file consumed by a later `gh … --input`
// segment, and that file's contents are resolved separately (review-recorder
// reads it off disk); detection here only needs the `gh` segment itself.
function splitSegments(command: string): string[][] {
  const segments: string[][] = []
  let cur: string[] = []
  let tok = ''
  let quote: '"' | "'" | null = null
  let hasTok = false
  const endTok = () => {
    if (hasTok) {
      cur.push(tok)
      tok = ''
      hasTok = false
    }
  }
  const endSeg = () => {
    endTok()
    if (cur.length > 0) {
      segments.push(cur)
      cur = []
    }
  }
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string
    if (quote !== null) {
      if (ch === quote) quote = null
      else tok += ch
      hasTok = true
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      hasTok = true
      continue
    }
    const next = command[i + 1]
    if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
      endSeg()
      i++
      continue
    }
    if (ch === ';' || ch === '|' || ch === '\n') {
      endSeg()
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      endTok()
      continue
    }
    tok += ch
    hasTok = true
  }
  endSeg()
  return segments
}
