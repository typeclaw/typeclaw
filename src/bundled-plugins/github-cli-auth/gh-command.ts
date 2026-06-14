export type GhCommandDecision =
  | { kind: 'pass-through' }
  | { kind: 'block'; reason: string }
  // `rewrittenCommand`, when present, MUST replace the executed command: `gh api`
  // rejects `-R/--repo` ("unknown shorthand flag"), so for a graphql endpoint the
  // flag is consumed as our repo hint and stripped before exec. Other inject paths
  // (REST, non-`api` subcommands) leave the command unchanged and omit it.
  | { kind: 'inject'; repoSlug: string; rewrittenCommand?: string }

const MISSING_REPO_REASON =
  'This GitHub App spans multiple owners, so `gh` has no single correct token. ' +
  'Re-run with an explicit repo: `gh <cmd> -R owner/repo` (or `gh api /repos/owner/repo/...`) ' +
  'so the right installation token can be injected.'

const MULTI_OWNER_REASON =
  'This command targets repos under more than one owner; a single GH_TOKEN cannot ' +
  'authenticate all of them. Split it into separate commands, one owner each.'

const API_REPO_CONFLICT_REASON =
  'This `gh api` call names a repo in its endpoint path that differs from its ' +
  '`-R/--repo` flag. `gh api` ignores `-R` for a literal `/repos/{owner}/{repo}` ' +
  'endpoint — the path is where the request actually goes — so the flag cannot be ' +
  'used to mint a token for one repo while hitting another. Drop the mismatched ' +
  '`-R`, or target the repo named in the path.'

// A gh segment can legitimately touch more than one repo (a `gh api` compare
// endpoint references both the base repo and a cross-fork head). The classifier
// returns EVERY effective target so analyzeGhCommand can allowlist-check and
// same-owner-check all of them — a single-slug return is what let a literal
// `gh api /repos/x/y` path slip past an `-R`-derived check.
type GhSegmentDecision =
  | { kind: 'pass-through' }
  | { kind: 'block'; reason: string }
  // `stripRepoFlag` marks a graphql inject whose `-R/--repo` is a TypeClaw-only
  // hint that `gh api` would reject, so it must be removed from the command.
  | { kind: 'inject'; repoSlugs: readonly string[]; stripRepoFlag?: boolean }

const COMPOSITION_REASON =
  'A repo-targeting `gh` command receives a minted GitHub App token in its process ' +
  'environment, so it must run as a single bare `gh` command — no `;`, `&&`, `||`, `&`, ' +
  'newlines, redirections, command/process substitution, subshells, heredocs, or unquoted ' +
  '`$` expansion (any sibling process or expansion would inherit the token and could ' +
  'exfiltrate it). One exception is allowed: a trailing reader pipeline `gh … | <reader>` ' +
  'where every downstream stage is a stdin-only reader (`jq`, `cat`, `wc`, `sort`, `uniq`) ' +
  'with no file operand — e.g. `gh api repos/o/r | jq .`. jq/JSON metacharacters are also ' +
  "fine INSIDE single quotes, e.g. `gh api repos/o/r --jq '.[] | {id}'`. To feed JSON to " +
  '`gh api`, write it to a temp file and use `gh api --input <file>`.'

// Shell-active metacharacters that, OUTSIDE single quotes, either spawn another
// process sharing the shell env (where the minted GH_TOKEN lives) or expand
// shell state into an argument. `|;&` = pipeline/sequence/background; newline/CR
// = command separators; `()` `{}` = subshell/group; `<>` = redirection
// (incl. bash /dev/tcp networking and heredocs); backtick + `$` = command/
// parameter/arithmetic substitution (covers `$(`, `${`, `$((`, and a bare
// `$GH_TOKEN`). Single quotes make all of these literal, so jq pipes and JSON
// braces are allowed when single-quoted. Double quotes do NOT neutralize `$`
// or backticks, so they are treated as active.
const SHELL_ACTIVE_METACHARS = new Set(['|', ';', '&', '\n', '\r', '(', ')', '{', '}', '<', '>', '`', '$'])

// Returns true iff `command` is a single simple `gh ...` command: the first
// non-whitespace word is `gh`, and no shell-active metachar appears outside
// single quotes. This is the gate for token injection — see COMPOSITION_REASON.
function isSingleBareGhCommand(command: string): boolean {
  const trimmed = command.trimStart()
  if (!/^gh(\s|$)/.test(trimmed)) return false

  let quote: '"' | "'" | null = null
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (ch === undefined) continue
    if (quote === "'") {
      if (ch === "'") quote = null
      continue
    }
    if (quote === '"') {
      // Inside double quotes `$` and backtick still expand; only `"` closes.
      if (ch === '"') quote = null
      else if (ch === '$' || ch === '`') return false
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (SHELL_ACTIVE_METACHARS.has(ch)) return false
  }
  return quote === null
}

// GENUINELY repo-less subcommands (account/global, no -R/--repo): they need no
// token injection and pass through. The set is intentionally minimal —
// anything not listed (label, ruleset, secret, variable, cache, run, workflow,
// release, browse, pr, issue, repo, ...) is repo-scoped and falls through to
// the block-unless-explicit-repo rule, so an App-auth `gh label list` cannot
// silently run with the wrong installation token. Classification verified
// against gh source (commands using cmdutil.EnableRepoOverride are repo-scoped).
// `gh api` is handled separately (path-based repo extraction).
const REPO_LESS_SUBCOMMANDS = new Set([
  'auth',
  'config',
  'extension',
  'alias',
  'completion',
  'gpg-key',
  'ssh-key',
  'status',
  'org',
  'gist',
  'codespace',
  'search',
  'preview',
  'accessibility',
  'attestation',
])

// A single GH_TOKEN is injected into the whole bash command's env, so every
// `gh` in a compound command shares it. That is correct only when all
// repo-targeting `gh` invocations resolve to the same owner (one App
// installation). We therefore inspect EVERY `gh` invocation, not just the
// first: a repo-targeting `gh` with no resolvable repo blocks (missing-repo),
// and invocations spanning more than one owner block (multi-owner).
export function analyzeGhCommand(command: string): GhCommandDecision {
  const tokens = tokenize(command)
  const ghStarts = findGhInvocations(tokens)
  if (ghStarts.length === 0) return { kind: 'pass-through' }

  const repoSlugs: string[] = []
  let stripRepoFlag = false
  for (let i = 0; i < ghStarts.length; i++) {
    const start = ghStarts[i] as number
    const end = ghStarts[i + 1] ?? tokens.length
    const args = tokens.slice(start + 1, end)
    const segment = classifyGhSegment(args)
    if (segment.kind === 'block') return segment
    if (segment.kind === 'inject') {
      repoSlugs.push(...segment.repoSlugs)
      if (segment.stripRepoFlag === true) stripRepoFlag = true
    }
  }

  if (repoSlugs.length === 0) return { kind: 'pass-through' }
  const owners = new Set(repoSlugs.map((slug) => slug.split('/')[0]))
  if (owners.size > 1) return { kind: 'block', reason: MULTI_OWNER_REASON }

  const repoSlug = repoSlugs[0] as string

  // We would inject a token. The token lands in the shell env, so any sibling/
  // upstream/downstream process or shell expansion would inherit it. The single-
  // bare-`gh` shape is the safe baseline; a trailing reader pipeline (`gh | jq`)
  // is the one exception we allow, under strict conditions (see analyzeReaderPipeline).
  if (isSingleBareGhCommand(command)) {
    if (stripRepoFlag) return { kind: 'inject', repoSlug, rewrittenCommand: stripRepoFlagFromCommand(command) }
    return { kind: 'inject', repoSlug }
  }

  const piped = analyzeReaderPipeline(command, stripRepoFlag)
  if (piped !== null) return { kind: 'inject', repoSlug, rewrittenCommand: piped }

  return { kind: 'block', reason: COMPOSITION_REASON }
}

// True for a `gh pr create` invocation — the canonical credential-requiring
// write the misconfig block targets. Scans every gh invocation (an `&&` chain
// could carry it) for the `pr` subcommand followed by `create`, skipping flags
// and their values so `gh pr create --title x` still matches. Read-only `gh`
// (pr view/list, auth status) returns false and is never blocked.
export function isGhCredentialRequiringWrite(command: string): boolean {
  const tokens = tokenize(command)
  const ghStarts = findGhInvocations(tokens)
  for (let i = 0; i < ghStarts.length; i++) {
    const start = ghStarts[i] as number
    const end = ghStarts[i + 1] ?? tokens.length
    const args = tokens.slice(start + 1, end)
    // `gh pr create --help`/`-h` only prints docs and needs no credential, so it
    // must not trigger the misconfig block.
    if (args.includes('--help') || args.includes('-h')) continue
    const positionals = args.filter((t) => !t.startsWith('-'))
    if (positionals[0] === 'pr' && positionals[1] === 'create') return true
  }
  return false
}

// stdin-only readers whose only sink is stdout (back to the agent, who already
// has gh's output) — they cannot open their own network/file/process sink, so a
// `gh <repo> | <reader>` pipeline cannot exfiltrate the minted token to a third
// party. EXCLUDED on purpose: awk (system()/getline|cmd/inet), sed (GNU `e`
// shell-exec), tee/xargs (write/spawn), less (`!cmd`), and grep/head/tail (their
// file-operand forms are too easy to abuse and not worth the parser risk yet).
const READER_ALLOWLIST = new Set(['jq', 'cat', 'wc', 'sort', 'uniq'])

// STRICT per-command flag allowlists. We allow ONLY flags known to be pure
// stdin-shaping (no file/program operand). This is allow-known-good, not
// deny-known-bad: coreutils exposes file reads AND code execution as FLAGS, not
// just operands — `wc --files0-from=F` and `sort --files0-from=F` open a file
// with no positional, and `sort --compress-program=PROG` execs a helper. Any
// such flag would let a downstream "reader" open `/proc/<pid>/environ` and
// recover the sibling token. So an unrecognized flag REJECTS the whole stage.
// jq is excluded here (its filter is a positional, handled separately).
const READER_BOOLEAN_FLAGS: Record<string, ReadonlySet<string>> = {
  cat: new Set(['-n', '--number', '-b', '--number-nonblank', '-s', '--squeeze-blank', '-A', '--show-all', '-E', '-T']),
  wc: new Set(['-l', '--lines', '-c', '--bytes', '-m', '--chars', '-w', '--words', '-L', '--max-line-length']),
  sort: new Set(['-r', '--reverse', '-n', '--numeric-sort', '-u', '--unique', '-f', '--ignore-case', '-b', '-g', '-h']),
  uniq: new Set(['-c', '--count', '-d', '--repeated', '-u', '--unique', '-i', '--ignore-case']),
}

// jq is validated allow-known-good, exactly like the coreutils readers: only
// known stdin-shaping flags pass; anything else rejects the stage. Exact-token
// deny-listing was unsound — `-f/proc/self/environ`, `-L/proc`, and clustered
// `-rf/proc/...` short forms slipped past a `Set.has(token)` check and reopened
// the file-read path. jq accepts NO `--flag=value` form (value flags take the
// value as a SEPARATE token), so long flags are matched as whole tokens.

// Safe boolean LONG flags: output/parse shaping only, no value, no file/module.
const JQ_SAFE_BOOLEAN_LONG = new Set([
  '--raw-output',
  '--raw-output0',
  '--compact-output',
  '--slurp',
  '--null-input',
  '--exit-status',
  '--ascii-output',
  '--sort-keys',
  '--raw-input',
  '--join-output',
  '--color-output',
  '--monochrome-output',
  '--binary',
  '--tab',
  '--unbuffered',
  '--stream',
  '--stream-errors',
  '--seq',
])

// Safe LONG flags that consume a fixed number of FOLLOWING tokens, none a file:
// --arg/--argjson take 2 (name, value), --indent takes 1 (a number).
const JQ_SAFE_VALUE_LONG: Record<string, number> = {
  '--arg': 2,
  '--argjson': 2,
  '--indent': 1,
}

// Safe boolean SHORT flags (single chars). A clustered short token like `-rc`
// is allowed iff EVERY char is in this set. `f` (filter-from-file) and `L`
// (module path) are the fatal ones — and any unknown char also rejects.
const JQ_SAFE_BOOLEAN_SHORT = new Set(['r', 'c', 's', 'n', 'e', 'a', 'S', 'R', 'j', 'C', 'M', 'b'])

// A reader stage is safe only if it is an allowlisted command using ONLY its
// known stdin-shaping flags, with no file operand. Backslashes are rejected
// outright: our tokenizer does not model shell backslash escaping, so a
// `jq \--from-file=…` would be seen as a harmless positional here but reach bash
// as the forbidden flag — an allowlist-bypass. Rejecting `\` closes that gap.
function isStdinOnlyReaderStage(stage: string): boolean {
  if (containsShellActiveMetachar(stage)) return false
  if (stage.includes('\\')) return false
  const tokens = splitStageTokens(stage)
  const cmd = tokens[0]
  if (cmd === undefined || !READER_ALLOWLIST.has(cmd)) return false

  if (cmd === 'jq') return isStdinOnlyJqStage(tokens)

  const allowedFlags = READER_BOOLEAN_FLAGS[cmd]
  if (allowedFlags === undefined) return false
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i] as string
    if (!tok.startsWith('-')) return false
    if (!allowedFlags.has(tok)) return false
  }
  return true
}

// jq must run pure-stdin: only known stdin-shaping flags, and EXACTLY one
// positional (the filter). A second positional is an input FILE jq would open
// (`jq . /proc/self/environ` reads that file), so it is rejected. The filter is
// additionally screened for `import`/`include`, which load modules from jq's
// default search path even without `-L` — another file-read vector.
function isStdinOnlyJqStage(tokens: readonly string[]): boolean {
  let sawFilter = false
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i] as string
    if (tok === '--') return false
    if (tok.startsWith('--')) {
      if (JQ_SAFE_BOOLEAN_LONG.has(tok)) continue
      const consume = JQ_SAFE_VALUE_LONG[tok]
      if (consume === undefined) return false
      i += consume
      continue
    }
    if (tok.startsWith('-') && tok.length > 1) {
      for (const ch of tok.slice(1)) {
        if (!JQ_SAFE_BOOLEAN_SHORT.has(ch)) return false
      }
      continue
    }
    if (sawFilter) return false
    sawFilter = true
    if (jqFilterLoadsModules(tok)) return false
  }
  return true
}

// jq `import`/`include` directives pull a module file from the search path, a
// file-read vector that `-L` rejection alone does not cover (the default path
// still applies). Match them as leading directives in the untrusted filter.
function jqFilterLoadsModules(filter: string): boolean {
  return /(^|[;\s])(import|include)\s/.test(filter)
}

// Splits a single bare `gh ... | reader | reader` pipeline into its stages on
// TOP-LEVEL `|` only (quote-aware, so a `|` inside a single-quoted jq filter is
// not a stage boundary), rewriting each downstream reader to run under
// `/usr/bin/env -u GH_TOKEN`. Returns the rewritten command, or null if the
// shape is not a leading-`gh` + allowlisted-stdin-readers pipeline. Absolute
// `/usr/bin/env` (not bare `env`) so the strip can't be defeated by a PATH-
// shadowed `env`; a missing binary exits 127, failing closed.
function analyzeReaderPipeline(command: string, stripRepoFlag: boolean): string | null {
  const stages = splitTopLevelPipeStages(command)
  if (stages === null || stages.length < 2) return null

  const ghStage = (stages[0] as string).trim()
  if (!isSingleBareGhCommand(ghStage)) return null

  for (let i = 1; i < stages.length; i++) {
    if (!isStdinOnlyReaderStage((stages[i] as string).trim())) return null
  }

  const rewrittenGh = stripRepoFlag ? stripRepoFlagFromCommand(ghStage) : ghStage
  const rewrittenReaders = stages.slice(1).map((s) => `/usr/bin/env -u GH_TOKEN ${s.trim()}`)
  return [rewrittenGh, ...rewrittenReaders].join(' | ')
}

// Quote-aware split on top-level `|`. Returns null if any OTHER shell-active
// metachar appears outside single quotes (`;` `&` `<` `>` backtick `$` `(` `)`
// `{` `}` newline) or if a `||`/`|&` is seen — those are not simple pipelines.
function splitTopLevelPipeStages(command: string): string[] | null {
  const stages: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string
    if (quote === "'") {
      if (ch === "'") quote = null
      current += ch
      continue
    }
    if (quote === '"') {
      if (ch === '$' || ch === '`') return null
      if (ch === '"') quote = null
      current += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      continue
    }
    if (ch === '|') {
      const next = command[i + 1]
      if (next === '|' || next === '&') return null
      stages.push(current)
      current = ''
      continue
    }
    if (SHELL_ACTIVE_METACHARS.has(ch) && ch !== '|') return null
    current += ch
  }
  if (quote !== null) return null
  stages.push(current)
  return stages
}

function containsShellActiveMetachar(stage: string): boolean {
  let quote: '"' | "'" | null = null
  for (let i = 0; i < stage.length; i++) {
    const ch = stage[i] as string
    if (quote === "'") {
      if (ch === "'") quote = null
      continue
    }
    if (quote === '"') {
      if (ch === '$' || ch === '`') return true
      if (ch === '"') quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (SHELL_ACTIVE_METACHARS.has(ch)) return true
  }
  return false
}

// Whitespace-splits a single stage into argv-ish tokens, stripping surrounding
// quotes so a quoted filter like `'.[] | {id}'` becomes one token. Quote-aware
// so whitespace inside quotes does not split.
function splitStageTokens(stage: string): string[] {
  const tokens: string[] = []
  let current = ''
  let has = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < stage.length; i++) {
    const ch = stage[i] as string
    if (quote !== null) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      has = true
      continue
    }
    if (ch === ' ' || ch === '\t') {
      if (has) {
        tokens.push(current)
        current = ''
        has = false
      }
      continue
    }
    current += ch
    has = true
  }
  if (has) tokens.push(current)
  return tokens
}

// Removes an unquoted `-R`/`--repo` flag (and its repo-slug value) from a single
// bare command, preserving everything else byte-for-byte. Quote-aware so a `-R`
// inside a quoted `-f query='...'` value is never touched; a repo slug is
// owner/name (no whitespace), so the value is always a single unquoted token.
// Used only for graphql, where `gh api` rejects the flag we consumed as a hint.
function stripRepoFlagFromCommand(command: string): string {
  let out = ''
  let i = 0
  while (i < command.length) {
    const ch = command[i] as string
    if (ch === '"' || ch === "'") {
      const endQuote = findClosingQuote(command, i)
      out += command.slice(i, endQuote + 1)
      i = endQuote + 1
      continue
    }
    const removed = matchRepoFlagAt(command, i)
    if (removed !== null) {
      out = out.replace(/[ \t]+$/, '')
      i = removed
      while (command[i] === ' ' || command[i] === '\t') i += 1
      if (out !== '' && i < command.length) out += ' '
      continue
    }
    out += ch
    i += 1
  }
  return out
}

// Index of the quote that closes the one at `open`. Double quotes honor `\"` as
// a literal (bash processes backslash escapes inside "..."), so a `-R o/r` buried
// in a `-f body="{\"x\":\"-R o/r\"}"` value is not mistaken for an unquoted flag.
// Single quotes take everything literally — no escapes — so the next `'` closes.
// Unterminated quote returns the last index (strip nothing past it).
function findClosingQuote(command: string, open: number): number {
  const quote = command[open]
  for (let i = open + 1; i < command.length; i++) {
    const ch = command[i]
    if (quote === '"' && ch === '\\') {
      i += 1
      continue
    }
    if (ch === quote) return i
  }
  return command.length - 1
}

// If `command` has an unquoted `-R`/`--repo` repo-flag token starting at `start`
// (at a word boundary), returns the index just past the flag and its value;
// otherwise null. Handles `-R o/r`, `--repo o/r`, `-R=o/r`, `--repo=o/r`.
function matchRepoFlagAt(command: string, start: number): number | null {
  const before = start === 0 ? '' : (command[start - 1] as string)
  if (before !== '' && before !== ' ' && before !== '\t') return null

  for (const flag of ['--repo', '-R']) {
    if (!command.startsWith(flag, start)) continue
    let i = start + flag.length
    const sep = command[i]
    // Both value forms validate the slug before stripping: the flag is only a
    // repo flag if its value parses as owner/repo. Without this, the `=` form
    // could strip a non-slug value the detection path would have rejected,
    // diverging detection from rewrite.
    if (sep === '=') {
      const valueStart = i + 1
      let j = valueStart
      while (j < command.length && command[j] !== ' ' && command[j] !== '\t') j += 1
      if (!isRepoSlug(command.slice(valueStart, j))) return null
      return j
    }
    if (sep === ' ' || sep === '\t') {
      let j = i
      while (command[j] === ' ' || command[j] === '\t') j += 1
      const valueStart = j
      while (j < command.length && command[j] !== ' ' && command[j] !== '\t') j += 1
      if (!isRepoSlug(command.slice(valueStart, j))) return null
      return j
    }
  }
  return null
}

function classifyGhSegment(args: readonly string[]): GhSegmentDecision {
  const subcommand = args.find((t) => !t.startsWith('-'))
  if (subcommand === undefined) return { kind: 'pass-through' }

  // `gh api` is resolved BEFORE the generic -R extraction: for a literal
  // `/repos/{owner}/{repo}` endpoint the request goes to the PATH repo and `gh`
  // ignores -R, so trusting -R here would mint a token for one repo while the
  // call hits another (the allowlist-bypass this guards against).
  if (subcommand === 'api') return classifyGhApiSegment(args)

  const explicit = extractRepoFlag(args)
  if (explicit !== null) return { kind: 'inject', repoSlugs: [explicit] }

  if (REPO_LESS_SUBCOMMANDS.has(subcommand)) return { kind: 'pass-through' }

  return { kind: 'block', reason: MISSING_REPO_REASON }
}

// Repo authority for `gh api`: the literal endpoint path wins. A `-R/--repo`
// that names a DIFFERENT repo than the path is a mint-for-X-but-hit-Y attempt
// and blocks. A placeholder endpoint (`repos/{owner}/{repo}`) has no literal
// target, so -R fills it and is authoritative. A non-repo endpoint without a
// `-R` (`graphql`, `/user`) passes through — the flag is what makes it
// repo-scoped, so absent one there is nothing to mint for.
function classifyGhApiSegment(args: readonly string[]): GhSegmentDecision {
  const pathRepos = extractReposFromApiPath(args)
  const flagRepo = extractRepoFlag(args)

  if (pathRepos.length > 0) {
    // Check EVERY repo flag, not just the first: the strip removes all of them,
    // so a single non-redundant flag anywhere is a mint-for-X-hit-Y attempt and
    // must block even when an earlier flag matches the path and would otherwise
    // mask it.
    const flagRepos = extractAllRepoFlags(args)
    if (flagRepos.some((slug) => !pathRepos.includes(slug))) {
      return { kind: 'block', reason: API_REPO_CONFLICT_REASON }
    }
    // Every `-R` here is redundant: it matches the repo already named in the
    // literal path, which is authoritative. `gh api` rejects `-R` outright, so
    // strip the flag rather than let `gh` fail with "unknown shorthand flag".
    // Distinct from graphql (no path, -R IS the hint) — here the path mints the
    // token and the flag is pure noise we remove for syntax.
    if (flagRepos.length > 0) return { kind: 'inject', repoSlugs: pathRepos, stripRepoFlag: true }
    return { kind: 'inject', repoSlugs: pathRepos }
  }

  if (flagRepo !== null && apiEndpointHasOwnerRepoPlaceholder(args)) {
    return { kind: 'inject', repoSlugs: [flagRepo] }
  }

  // graphql encodes its repo in the query body / opaque node IDs, never an
  // inspectable path, so `-R` is taken as the mint hint. Safe because there is
  // no literal path to conflict with (cf. the API_REPO_CONFLICT_REASON guard
  // above): the minted token's installation scope, not the flag, bounds reach.
  // `gh api` rejects `-R`, so the flag must be stripped from the command.
  if (flagRepo !== null && isGraphqlEndpoint(args)) {
    return { kind: 'inject', repoSlugs: [flagRepo], stripRepoFlag: true }
  }

  return { kind: 'pass-through' }
}

function isGraphqlEndpoint(args: readonly string[]): boolean {
  return findApiEndpoint(args) === 'graphql'
}

export type GhAuthEnv = {
  GH_TOKEN?: string | undefined
  GITHUB_TOKEN?: string | undefined
}

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/

// The effective token `gh` would use for EACH `gh api` invocation that targets the
// authenticated-user endpoint (`/user`, `user`, or a `/user/...` descendant). The
// caller classifies each: an App installation token is not a user identity, so
// GitHub rejects `/user` for it (token-CLASS mismatch, not an auth failure) — but a
// PAT IS a user identity and works, so the guard must respect a command-local
// `GH_TOKEN=…`/`GITHUB_TOKEN=…` override on that invocation, not just process env.
// Precedence mirrors gh: local GH_TOKEN > process GH_TOKEN > local GITHUB_TOKEN >
// process GITHUB_TOKEN. Narrow endpoint scope: `/users/{username}`, `/meta`,
// `/rate_limit` are not user-identity endpoints and never match.
export function effectiveGhTokensForAuthenticatedUserEndpoint(
  command: string,
  env: GhAuthEnv,
): Array<string | undefined> {
  const tokens = tokenize(command)
  const ghStarts = findGhInvocations(tokens)
  const result: Array<string | undefined> = []
  for (let i = 0; i < ghStarts.length; i++) {
    const start = ghStarts[i] as number
    const end = ghStarts[i + 1] ?? tokens.length
    if (!isAuthenticatedUserEndpointArgs(tokens.slice(start + 1, end))) continue
    result.push(effectiveGhTokenForInvocation(tokens, start, env))
  }
  return result
}

export function usesGhApiAuthenticatedUserEndpoint(command: string): boolean {
  return effectiveGhTokensForAuthenticatedUserEndpoint(command, {}).length > 0
}

function isAuthenticatedUserEndpointArgs(args: readonly string[]): boolean {
  if (args[0] !== 'api') return false
  const endpoint = findApiEndpoint(args)
  if (endpoint === null) return false
  const normalized = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint
  return normalized === 'user' || normalized.startsWith('user/')
}

// Walks the contiguous `VAR=val` assignments immediately before `gh` (the same
// shape findGhInvocations skips) and applies gh's token precedence over env.
function effectiveGhTokenForInvocation(tokens: readonly string[], ghStart: number, env: GhAuthEnv): string | undefined {
  const local: GhAuthEnv = {}
  for (let i = ghStart - 1; i >= 0 && ENV_ASSIGNMENT_RE.test(tokens[i] as string); i--) {
    const token = tokens[i] as string
    const name = token.slice(0, token.indexOf('='))
    const value = token.slice(token.indexOf('=') + 1)
    // Iterating right-to-left, so only record the first (leftmost wins on dup).
    if (name === 'GH_TOKEN' && local.GH_TOKEN === undefined) local.GH_TOKEN = value
    if (name === 'GITHUB_TOKEN' && local.GITHUB_TOKEN === undefined) local.GITHUB_TOKEN = value
  }
  const ghToken = local.GH_TOKEN ?? env.GH_TOKEN
  if (ghToken !== undefined && ghToken !== '') return ghToken
  return local.GITHUB_TOKEN ?? env.GITHUB_TOKEN
}

function findGhInvocations(tokens: readonly string[]): number[] {
  const starts: number[] = []
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== 'gh') continue
    // Skip leading `FOO=bar` env assignments; a `gh` is an invocation only at
    // the start of a simple command (command position).
    if (i === 0 || isCommandBoundaryBefore(tokens, i)) starts.push(i)
  }
  return starts
}

function isCommandBoundaryBefore(tokens: readonly string[], index: number): boolean {
  let cursor = index - 1
  while (cursor >= 0) {
    const prev = tokens[cursor]
    if (prev === undefined) return false
    if (prev === '&&' || prev === '||' || prev === '|' || prev === ';' || prev === '\n') return true
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(prev)) {
      cursor -= 1
      continue
    }
    return false
  }
  return true
}

function extractRepoFlag(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined) continue
    if (arg === '-R' || arg === '--repo') {
      const value = args[i + 1]
      if (value !== undefined && isRepoSlug(value)) return value
    }
    if (arg.startsWith('--repo=')) {
      const value = arg.slice('--repo='.length)
      if (isRepoSlug(value)) return value
    }
    if (arg.startsWith('-R=')) {
      const value = arg.slice('-R='.length)
      if (isRepoSlug(value)) return value
    }
  }
  return null
}

// Every valid `-R`/`--repo` slug in `args`, not just the first. The strip removes
// ALL unquoted repo flags, so the conflict check must see ALL of them: a command
// like `... -R path/repo -R victim/private` is a mint-for-X-hit-Y attempt where
// the redundant first flag would otherwise mask the malicious second one.
function extractAllRepoFlags(args: readonly string[]): string[] {
  const slugs: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined) continue
    if (arg === '-R' || arg === '--repo') {
      const value = args[i + 1]
      if (value !== undefined && isRepoSlug(value)) slugs.push(value)
    } else if (arg.startsWith('--repo=')) {
      const value = arg.slice('--repo='.length)
      if (isRepoSlug(value)) slugs.push(value)
    } else if (arg.startsWith('-R=')) {
      const value = arg.slice('-R='.length)
      if (isRepoSlug(value)) slugs.push(value)
    }
  }
  return slugs
}

// `gh api` flags that consume the FOLLOWING token as their value. The endpoint
// is the first positional arg that is neither a flag nor a flag's value; only
// THAT arg is parsed for owner/repo. Scanning every arg (as before) would let a
// `-f q=/repos/a/b` field value or `--jq` expression masquerade as the target.
const GH_API_VALUE_FLAGS = new Set([
  '-X',
  '--method',
  '-f',
  '--raw-field',
  '-F',
  '--field',
  '-H',
  '--header',
  '-q',
  '--jq',
  '-t',
  '--template',
  '--input',
  '--cache',
  '-i',
  '--include',
  '--hostname',
])

// `-R`/`--repo` are not real `gh api` flags, but TypeClaw accepts them as a repo
// hint that can appear BEFORE the endpoint (`gh api -R o/r graphql`). They consume
// the following token, so findApiEndpoint must skip both — otherwise the slug is
// misread as the endpoint and the graphql path never runs.
const REPO_HINT_VALUE_FLAGS = new Set(['-R', '--repo'])

// The `gh api` endpoint is the first positional arg after `api` (skipping flags
// and the tokens that bare value-flags consume). Returns null if there is none.
function findApiEndpoint(args: readonly string[]): string | null {
  const apiIndex = args.indexOf('api')
  if (apiIndex === -1) return null
  for (let i = apiIndex + 1; i < args.length; i++) {
    const arg = args[i] as string
    if (arg.startsWith('-')) {
      if (!arg.includes('=') && (GH_API_VALUE_FLAGS.has(arg) || REPO_HINT_VALUE_FLAGS.has(arg))) i += 1
      continue
    }
    return arg
  }
  return null
}

// Every LITERAL repo the endpoint path targets. Normally one (`/repos/{o}/{r}/…`),
// but a compare endpoint `/repos/{o}/{r}/compare/{base}...{owner}:{branch}` also
// reaches the cross-fork head repo `{owner}/{r}`, so both are returned and must
// be allowlisted. `{owner}/{repo}` placeholder segments are NOT literal targets
// (see apiEndpointHasOwnerRepoPlaceholder) and yield nothing here.
function extractReposFromApiPath(args: readonly string[]): string[] {
  const endpoint = findApiEndpoint(args)
  if (endpoint === null) return []
  const normalized = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint
  const segments = normalized.split('/')
  if (segments[0] !== 'repos') return []
  const owner = segments[1]
  const name = segments[2]
  if (owner === undefined || name === undefined) return []
  // A `{owner}`/`{repo}` placeholder is not a literal target; -R fills it.
  if (isPlaceholderSegment(owner) || isPlaceholderSegment(name)) return []
  const baseSlug = `${owner}/${name}`
  if (!isRepoSlug(baseSlug)) return []

  const repos = [baseSlug]
  // compare/{base}...{headOwner}:{headBranch} reaches headOwner's fork.
  const compareIndex = segments.indexOf('compare', 3)
  if (compareIndex !== -1) {
    const spec = segments.slice(compareIndex + 1).join('/')
    const head = spec.split('...')[1]
    const headOwner = head?.includes(':') ? head.split(':')[0] : undefined
    if (headOwner !== undefined && headOwner !== '' && headOwner !== owner) {
      const headSlug = `${headOwner}/${name}`
      if (isRepoSlug(headSlug)) repos.push(headSlug)
    }
  }
  return repos
}

// True when the endpoint uses gh's `{owner}`/`{repo}` template placeholders,
// which `-R/--repo` fills at runtime — so for these, -R is the authoritative
// target rather than a conflicting literal.
function apiEndpointHasOwnerRepoPlaceholder(args: readonly string[]): boolean {
  const endpoint = findApiEndpoint(args)
  if (endpoint === null) return false
  return endpoint.includes('{owner}') || endpoint.includes('{repo}')
}

function isRepoSlug(value: string): boolean {
  const [owner, name, ...rest] = value.split('/')
  return owner !== undefined && owner !== '' && name !== undefined && name !== '' && rest.length === 0
}

function isPlaceholderSegment(segment: string): boolean {
  return segment.includes('{') || segment.includes('}')
}

// Splits on whitespace AND shell control operators (newline ; | & && ||) so a
// boundary like `true; gh ...` (no surrounding spaces) or a `gh` on its own line
// yields a standalone separator token. A newline ends a simple command in bash,
// so it must be a boundary too — otherwise a `gh` on a later line (e.g. after a
// heredoc) is not seen at command position and escapes classification. Quote-
// aware: operators inside quotes are literal. This is a command-position
// detector, not a full shell parser — it does not interpret redirections,
// subshells, heredoc bodies, or backgrounding semantics beyond boundary marking.
function tokenize(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let hasContent = false

  const flush = (): void => {
    if (hasContent) {
      tokens.push(current)
      current = ''
      hasContent = false
    }
  }

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (ch === undefined) continue
    if (quote !== null) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      hasContent = true
      continue
    }
    if (ch === ' ' || ch === '\t') {
      flush()
      continue
    }
    if (ch === '\n') {
      flush()
      tokens.push('\n')
      continue
    }
    if (ch === ';' || ch === '|' || ch === '&') {
      flush()
      const next = command[i + 1]
      if ((ch === '|' && next === '|') || (ch === '&' && next === '&')) {
        tokens.push(ch + ch)
        i += 1
      } else {
        tokens.push(ch)
      }
      continue
    }
    current += ch
    hasContent = true
  }
  flush()
  return tokens
}
