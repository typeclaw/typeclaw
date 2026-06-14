// Plain-`git` analog of analyzeGhCommand. `gh` names its repo in argv (`-R`);
// `git` only implies it via a remote, so this RESOLVES the target repo:
// explicit github.com URL -> remote name via `git remote get-url` -> the
// branch.<cur>.pushRemote/remote.pushDefault/origin fallback chain. The slug
// feeds the same per-repo mint the `gh` path uses; the token is injected via
// GIT_ASKPASS env, never into the command string.

export type GitCommandDecision =
  | { kind: 'pass-through' }
  | { kind: 'block'; reason: string }
  // rewrittenCommand replaces the executed command: `cd <dir> && git …` becomes
  // `git -C <dir> …` so the token-bearing command stays a single bare `git`
  // (no sibling process inherits the askpass env).
  | { kind: 'inject'; repoSlug: string; rewrittenCommand?: string }

// Returns null when the remote/config is absent or git fails — the analyzer
// then passes through so git fails honestly rather than us guessing a repo.
// forPush selects the PUSH url (`git remote get-url --push`), which differs from
// the fetch url when a remote sets `pushurl`; minting against the fetch url for a
// push would scope the token to the wrong repo/owner.
export type GitRemoteResolver = (cwd: string, remote: string, forPush: boolean) => Promise<string | null>
export type GitConfigResolver = (cwd: string, key: string) => Promise<string | null>
export type GitBranchResolver = (cwd: string) => Promise<string | null>

export type GitResolvers = {
  resolveRemoteUrl: GitRemoteResolver
  resolveConfig: GitConfigResolver
  resolveCurrentBranch: GitBranchResolver
}

async function runGit(cwd: string, args: string[]): Promise<string | null> {
  const bun = (globalThis as { Bun?: { spawn: typeof Bun.spawn } }).Bun
  if (!bun) return null
  try {
    const proc = bun.spawn({
      cmd: ['git', '-C', cwd, ...args],
      stdout: 'pipe',
      stderr: 'ignore',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    })
    const exitCode = await proc.exited
    if (exitCode !== 0) return null
    const out = (await new Response(proc.stdout).text()).trim()
    return out === '' ? null : out
  } catch {
    return null
  }
}

export const defaultGitResolvers: GitResolvers = {
  resolveRemoteUrl: (cwd, remote, forPush) =>
    runGit(cwd, forPush ? ['remote', 'get-url', '--push', remote] : ['remote', 'get-url', remote]),
  resolveConfig: (cwd, key) => runGit(cwd, ['config', '--get', key]),
  resolveCurrentBranch: (cwd) => runGit(cwd, ['symbolic-ref', '--short', 'HEAD']),
}

const REMOTE_SUBCOMMANDS = new Set(['push', 'fetch', 'pull', 'clone', 'ls-remote'])

const MULTI_OWNER_REASON =
  'This git command targets repos under more than one owner; a single minted ' +
  'GitHub App token cannot authenticate all of them. Split it into separate ' +
  'commands, one owner each.'

const COMPOSITION_REASON =
  'A repo-targeting `git` command receives a minted GitHub App token via ' +
  'GIT_ASKPASS in its process environment, so it must run as a single bare ' +
  '`git` command — no `;`, `&&`, `||`, `&`, newlines, pipes, redirections, ' +
  'command/parameter substitution, or subshells (any sibling process would ' +
  'inherit the token). The one accepted prefix is `cd <simple-path> && git …`, ' +
  'which is rewritten to `git -C <path> …`.'

const DANGEROUS_CONFIG_REASON =
  'A repo-targeting `git` command that would receive a minted GitHub App token ' +
  'cannot carry a leading environment assignment or `-c`/`--config-env`/' +
  '`--git-dir`/`--work-tree`/`--namespace`/`--exec-path`: those can redirect ' +
  "git's authentication or destination away from the resolved repo (e.g. " +
  '`-c url.https://evil/.insteadOf=…` or `-c core.askPass=…`), which would leak ' +
  'the token. Remove them and re-run, or run without the minted token.'

const FETCH_ALL_REASON =
  '`git fetch --all` / `git pull --all` contacts every configured remote, which ' +
  'cannot be enumerated safely here — a minted token scoped to one remote could ' +
  'be sent to another. Fetch a specific remote instead.'

// OUTSIDE single quotes these spawn a sibling process (which would inherit the
// askpass token) or expand shell state. `$`/backtick stay active inside double
// quotes too, so they are screened separately. Mirrors gh-command.ts.
const SHELL_ACTIVE_METACHARS = new Set(['|', ';', '&', '\n', '\r', '(', ')', '{', '}', '<', '>', '`', '$'])

export async function analyzeGitCommand(
  command: string,
  options: { cwd: string; resolvers: GitResolvers },
): Promise<GitCommandDecision> {
  // The single permitted `cd <simple-path> && git …` shortcut is rewritten to a
  // bare `git -C …` before any chain parsing, so a chain never has to reason
  // about a `cd` segment changing cwd for the gits that follow it. Multi-git
  // chains must use explicit `git -C` per segment instead.
  const stripped = stripSafeCdPrefix(command)
  if (stripped.unsafe) return { kind: 'pass-through' }
  if (stripped.cdDir !== null) return analyzeSingleCdGit(stripped, options)

  // Split the command into `&&`-joined git segments. null = not a pure
  // git-only `&&` chain (a non-git segment, a forbidden shell operator, a
  // leading env assignment, or no git at all).
  const chain = extractGitInvocationChain(command)
  if (chain === null) {
    // Distinguish "no git here at all" (pass-through) from "git is present but
    // the composition is unsafe" (block). A bare `ls`/`echo` is not our concern;
    // a `git push … | tee` or `git … && curl evil` must be blocked, never run
    // tokenless (which is what silently passing through used to do — the bug).
    return containsGitInvocation(command) ? { kind: 'block', reason: COMPOSITION_REASON } : { kind: 'pass-through' }
  }

  const remoteSegments = chain.filter((s) => {
    const sub = findSubcommand(s.args)
    return sub !== undefined && REMOTE_SUBCOMMANDS.has(sub)
  })
  // No segment talks to a remote (e.g. `git status && git log`): nothing to
  // authenticate, so pass through and let git run with no token.
  if (remoteSegments.length === 0) return { kind: 'pass-through' }

  // Every segment — even non-remote ones like `git status` that ride along in
  // the chain — must pass the redirect screen: a token lives in the shared env
  // the whole chain inherits, so a `-c`/env-assignment on ANY git could steer
  // auth or destination.
  for (const seg of chain) {
    if (seg.hasLeadingEnvAssignment || hasDangerousGitConfig(seg.args)) {
      return { kind: 'block', reason: DANGEROUS_CONFIG_REASON }
    }
    const sub = findSubcommand(seg.args)
    if ((sub === 'fetch' || sub === 'pull') && seg.args.includes('--all')) {
      return { kind: 'block', reason: FETCH_ALL_REASON }
    }
  }

  const owners = new Set<string>()
  let representativeSlug: string | null = null
  for (const seg of remoteSegments) {
    const sub = findSubcommand(seg.args) as string
    const effectiveCwd = resolveCwd(options.cwd, extractDashCDir(seg.args))
    // A resolver that throws is treated as "couldn't resolve" → pass-through, so
    // a git/subprocess failure never crashes the hook or guesses a repo.
    let slugs: string[]
    try {
      slugs = await resolveRepoSlugs(sub, seg.args, effectiveCwd, options.resolvers)
    } catch {
      return { kind: 'pass-through' }
    }
    for (const slug of slugs) {
      owners.add(slug.split('/')[0] as string)
      representativeSlug ??= slug
    }
  }

  // A GitHub remote subcommand whose target owner we could not resolve: we must
  // not mint a possibly-wrong-owner token, and silently passing through would
  // reproduce the credential-less failure. Block with an actionable reason.
  if (representativeSlug === null) return { kind: 'pass-through' }
  if (owners.size > 1) return { kind: 'block', reason: MULTI_OWNER_REASON }

  return { kind: 'inject', repoSlug: representativeSlug }
}

// True when any `git` invocation in the command is a `push` — the credential-
// requiring write the misconfig block targets. analyzeGitCommand has already
// confirmed the command resolves to a github.com repo, so this only narrows the
// remote subcommand to push (clone/fetch/pull/ls-remote return false). Reuses
// the same cd-prefix-strip and `&&`-chain split so `cd x && git push` and
// `git status && git push origin main` both match.
export function isGitPushCommand(command: string): boolean {
  const stripped = stripSafeCdPrefix(command)
  if (stripped.unsafe) return commandHasGitPush(command)
  const rest = stripped.cdDir !== null ? stripped.rest : command
  return commandHasGitPush(rest)
}

function commandHasGitPush(command: string): boolean {
  const chain = extractGitInvocationChain(command)
  if (chain !== null) return chain.some((seg) => isPushInvocation(seg.args))
  const single = extractSingleGitInvocation(command)
  return single !== null && isPushInvocation(single.args)
}

// A `push` that actually contacts the remote — NOT `git push --help`/`-h`, which
// only prints docs and needs no credential, so it must not trigger the misconfig
// block. `git --help push` also resolves its subcommand to a help page.
function isPushInvocation(args: readonly string[]): boolean {
  if (findSubcommand(args) !== 'push') return false
  return !args.includes('--help') && !args.includes('-h')
}

// The single-git `cd <path> && git …` shortcut. Kept separate (and single-git
// only) so the cwd rewrite stays simple: the token-bearing command becomes one
// bare `git -C <path> …`, with no sibling inheriting the env. A `cd` in a
// multi-git chain is rejected (callers use explicit `git -C` per segment).
async function analyzeSingleCdGit(
  stripped: StrippedCd,
  options: { cwd: string; resolvers: GitResolvers },
): Promise<GitCommandDecision> {
  const segment = extractSingleGitInvocation(stripped.rest)
  if (segment === null) return { kind: 'pass-through' }
  const args = segment.args
  const subcommand = findSubcommand(args)
  if (subcommand === undefined || !REMOTE_SUBCOMMANDS.has(subcommand)) return { kind: 'pass-through' }
  if (segment.hasLeadingEnvAssignment || hasDangerousGitConfig(args)) {
    return { kind: 'block', reason: DANGEROUS_CONFIG_REASON }
  }
  if ((subcommand === 'fetch' || subcommand === 'pull') && args.includes('--all')) {
    return { kind: 'block', reason: FETCH_ALL_REASON }
  }
  const dashCDir = extractDashCDir(args)
  const effectiveCwd = resolveCwd(resolveCwd(options.cwd, stripped.cdDir), dashCDir)
  let slugs: string[]
  try {
    slugs = await resolveRepoSlugs(subcommand, args, effectiveCwd, options.resolvers)
  } catch {
    return { kind: 'pass-through' }
  }
  if (slugs.length === 0) return { kind: 'pass-through' }
  const owners = new Set(slugs.map((s) => s.split('/')[0]))
  if (owners.size > 1) return { kind: 'block', reason: MULTI_OWNER_REASON }
  const repoSlug = slugs[0] as string
  // The rewrite cannot stack two `-C` (the git part must not already carry one)
  // and the rest must be a single bare git (no further composition).
  if (containsShellActiveMetachar(stripped.rest) || dashCDir !== null) {
    return { kind: 'block', reason: COMPOSITION_REASON }
  }
  return { kind: 'inject', repoSlug, rewrittenCommand: rewriteCdToDashC(effectiveCwd, stripped.rest) }
}

// Global flags that can redirect git's auth or destination. `-c`/`--config-env`
// inject arbitrary config (url.insteadOf, core.askPass, credential.*, http.*);
// `--git-dir`/`--work-tree`/`--namespace`/`--exec-path` point git at a different
// repo or helper than the one we resolved. Any of these on a token-bearing
// command means we cannot vouch for where the token goes — block.
function hasDangerousGitConfig(args: readonly string[]): boolean {
  for (const arg of args) {
    // git accepts both `--config-env <name>=<envvar>` and the inline
    // `--config-env=<name>=<envvar>`; both must be caught. (`-c` has no inline
    // `-c=…` form — git always takes the next token.)
    if (arg === '-c' || arg === '--config-env' || arg.startsWith('--config-env=')) return true
    if (arg === '--git-dir' || arg.startsWith('--git-dir=')) return true
    if (arg === '--work-tree' || arg.startsWith('--work-tree=')) return true
    if (arg === '--namespace' || arg.startsWith('--namespace=')) return true
    if (arg === '--exec-path' || arg.startsWith('--exec-path=')) return true
  }
  return false
}

async function resolveRepoSlugs(
  subcommand: string,
  args: readonly string[],
  cwd: string,
  resolvers: GitResolvers,
): Promise<string[]> {
  const explicitUrl = extractExplicitUrl(subcommand, args)
  if (explicitUrl !== null) {
    const slug = parseGithubRepoFromGitUrl(explicitUrl)
    return slug === null ? [] : [slug]
  }

  // clone needs an explicit URL; it has no configured-remote fallback.
  if (subcommand === 'clone') return []

  // Only `push` consults the push url; fetch/pull/ls-remote use the fetch url.
  const forPush = subcommand === 'push'

  // EVERY named remote must be resolved, not just the first: `git fetch
  // --multiple origin upstream` touches both, and feeding only one to the
  // multi-owner guard would let a second-owner remote slip past and still mint.
  const remoteNames = extractRemoteNames(args)
  // The branch.pushRemote/pushDefault/origin chain is a PUSH default; applying it
  // to a bare `fetch`/`pull`/`ls-remote` could mint for the wrong (push) remote,
  // so only push falls back. Other subcommands with no explicit remote pass through.
  const remotes =
    remoteNames.length > 0 ? remoteNames : subcommand === 'push' ? [await resolveDefaultPushRemote(cwd, resolvers)] : []
  if (remotes.length === 0) return []

  const slugs: string[] = []
  for (const remote of remotes) {
    if (remote === null) continue
    const url = looksLikeUrl(remote) ? remote : await resolvers.resolveRemoteUrl(cwd, remote, forPush)
    if (url === null) continue
    const slug = parseGithubRepoFromGitUrl(url)
    if (slug !== null) slugs.push(slug)
  }
  return slugs
}

// Mirrors git's own push-remote resolution order for a bare `git push`.
async function resolveDefaultPushRemote(cwd: string, resolvers: GitResolvers): Promise<string | null> {
  const branch = await resolvers.resolveCurrentBranch(cwd)
  if (branch !== null && branch !== '') {
    const perBranch = await resolvers.resolveConfig(cwd, `branch.${branch}.pushRemote`)
    if (perBranch !== null && perBranch !== '') return perBranch
  }
  const pushDefault = await resolvers.resolveConfig(cwd, 'remote.pushDefault')
  if (pushDefault !== null && pushDefault !== '') return pushDefault
  return 'origin'
}

const HTTPS_GITHUB_RE = /^https:\/\/github\.com\/([^/\s:@]+)\/([^/\s?#]+?)(?:\.git)?\/?(?:[?#].*)?$/i
const SCP_GITHUB_RE = /^git@github\.com:([^/\s:?#]+)\/([^/\s?#]+?)(?:\.git)?$/i
const SSH_GITHUB_RE = /^ssh:\/\/git@github\.com(?::\d+)?\/([^/\s]+)\/([^/\s?#]+?)(?:\.git)?\/?(?:[?#].*)?$/i

// Parses a github.com remote URL into an `owner/name` slug. Returns null for
// non-github.com hosts, credential-bearing https URLs (https://tok@github.com/…
// — we never reuse an embedded credential), local paths, or malformed input.
export function parseGithubRepoFromGitUrl(raw: string): string | null {
  const url = raw.trim()
  for (const re of [HTTPS_GITHUB_RE, SCP_GITHUB_RE, SSH_GITHUB_RE]) {
    const m = url.match(re)
    if (m === null) continue
    const owner = m[1]
    const name = m[2]
    if (owner === undefined || name === undefined || owner === '' || name === '') return null
    return `${owner}/${name}`
  }
  return null
}

function looksLikeUrl(token: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return true
  if (/^[^@\s]+@[^:\s]+:/.test(token)) return true
  return false
}

// Flags that consume the FOLLOWING token, so a positional after them (the
// subcommand or a remote/URL) is not mistaken for the flag's value. Includes the
// dangerous-config flags in their separate-arg form (`--config-env <v>`) so the
// real subcommand is still located and hasDangerousGitConfig can fire.
const GIT_VALUE_FLAGS = new Set([
  '-C',
  '-c',
  '--config-env',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '-o',
  '--origin',
  '-b',
  '--branch',
  '-u',
])

function extractExplicitUrl(subcommand: string, args: readonly string[]): string | null {
  // `git push --repo <url>` / `--repo=<url>`
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--repo' || arg === '--repository') {
      const v = args[i + 1]
      if (v !== undefined && looksLikeUrl(v)) return v
    }
    if (arg.startsWith('--repo=')) return arg.slice('--repo='.length)
    if (arg.startsWith('--repository=')) return arg.slice('--repository='.length)
  }
  // First positional after the subcommand that looks like a URL.
  for (const pos of positionalsAfterSubcommand(subcommand, args)) {
    if (looksLikeUrl(pos)) return pos
  }
  return null
}

// The git subcommand is the first positional that is NOT consumed by a global
// value-flag (`git -C <dir> push`, `git -c k=v push`). A naive first-non-flag
// scan would pick the flag's value (e.g. `<dir>`) as the subcommand.
function findSubcommand(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg.startsWith('-')) {
      if (!arg.includes('=') && GIT_VALUE_FLAGS.has(arg)) i += 1
      continue
    }
    return arg
  }
  return undefined
}

// The remote name(s) a command targets. Normally just the first positional —
// later positionals are refspecs (`git push origin main` -> remote `origin`,
// refspec `main`). With `--multiple` (fetch), EVERY positional is a remote, so
// all are returned to feed the multi-owner guard. URL positionals are excluded
// here; resolveRepoSlugs handles a bare-URL target directly.
function extractRemoteNames(args: readonly string[]): string[] {
  const sub = findSubcommand(args)
  if (sub === undefined) return []
  const positionals = positionalsAfterSubcommand(sub, args).filter((p) => !looksLikeUrl(p))
  if (positionals.length === 0) return []
  if (args.includes('--multiple')) return positionals
  return [positionals[0] as string]
}

function positionalsAfterSubcommand(subcommand: string, args: readonly string[]): string[] {
  const out: string[] = []
  let seenSub = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg.startsWith('-')) {
      if (!arg.includes('=') && GIT_VALUE_FLAGS.has(arg)) i += 1
      continue
    }
    if (!seenSub) {
      if (arg === subcommand) seenSub = true
      continue
    }
    out.push(arg)
  }
  return out
}

function extractDashCDir(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-C') {
      const v = args[i + 1]
      if (v !== undefined) return stripQuotes(v)
    }
  }
  return null
}

type GitInvocation = { args: string[]; hasLeadingEnvAssignment: boolean }

// Null unless there is exactly one `git` at command position. Composition is NOT
// rejected here — it is screened later against the original command so the block
// reason stays accurate. hasLeadingEnvAssignment flags `FOO=bar git …`: such an
// assignment lands in git's env (where a `GIT_ASKPASS=…` override would receive
// the token), so the caller blocks it for token-bearing commands.
function extractSingleGitInvocation(command: string): GitInvocation | null {
  const tokens = tokenize(command)
  const gitStarts: number[] = []
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== 'git') continue
    if (i === 0 || isCommandBoundaryBefore(tokens, i)) gitStarts.push(i)
  }
  if (gitStarts.length !== 1) return null
  const start = gitStarts[0] as number
  const hasLeadingEnvAssignment = start > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start - 1] ?? '')
  const args = tokens.slice(start + 1).filter((t) => t !== '\n' && t !== ';' && t !== '|' && t !== '&')
  return { args, hasLeadingEnvAssignment }
}

// True if `git` appears at any command boundary. Used to decide block-vs-pass:
// a command with no git at all is none of our business (pass-through), but one
// that DOES contain git yet is not a clean git-only `&&` chain must be blocked,
// not run tokenless.
function containsGitInvocation(command: string): boolean {
  const tokens = tokenize(command)
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === 'git' && (i === 0 || isCommandBoundaryBefore(tokens, i))) return true
  }
  return false
}

// Splits a command into `&&`-joined segments and accepts it ONLY when EVERY
// segment is a single bare `git` invocation. Returns null (caller blocks or
// passes through) when any segment is non-git, the chain uses any operator other
// than `&&` (`;`, `|`, `||`, `&`, newline) at top level, or a segment carries a
// shell-active metachar (`$`, backtick, redirection, subshell) that could spawn
// or feed a NON-git process — which would inherit the shared token env. The
// all-git invariant is load-bearing: the token rides in a plain inherited env
// var, so a single non-git sibling could read it directly.
function extractGitInvocationChain(command: string): GitInvocation[] | null {
  // Quote-aware screen on the ORIGINAL command: every shell-active metachar
  // except the `&&` chain operator must be absent. This rejects `;`, `|`, `||`,
  // single `&`, redirection, subshells, and `$`/backtick (active outside single
  // quotes) — anything that could spawn or feed a non-git process that would
  // inherit the shared token env. Screening the original (not dequoted tokens)
  // keeps a safely single-quoted `$` from being a false positive.
  if (containsUnsafeMetacharOutsideAndAnd(command)) return null

  const tokens = tokenize(command)
  if (tokens.length === 0) return null

  const segments: string[][] = [[]]
  for (const token of tokens) {
    if (token === '&&') {
      segments.push([])
      continue
    }
    // The metachar screen above already rejected every other operator; this is
    // belt-and-suspenders in case the tokenizer ever emits one we missed.
    if (token === ';' || token === '|' || token === '||' || token === '&' || token === '\n') return null
    ;(segments[segments.length - 1] as string[]).push(token)
  }

  const invocations: GitInvocation[] = []
  for (const seg of segments) {
    if (seg.length === 0) return null
    let start = 0
    while (start < seg.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[start] ?? '')) start += 1
    const hasLeadingEnvAssignment = start > 0
    if (seg[start] !== 'git') return null
    invocations.push({ args: seg.slice(start + 1), hasLeadingEnvAssignment })
  }
  return invocations
}

// Quote-aware: true if any shell-active metachar appears outside quotes EXCEPT
// the `&&` operator (a lone `&` IS unsafe — backgrounding). `$`/backtick are
// active inside double quotes too, so they trip even there; single-quoted
// content is inert. Companion to containsShellActiveMetachar, which forbids ALL
// of them (no `&&` exception) for the single-git path.
function containsUnsafeMetacharOutsideAndAnd(command: string): boolean {
  let quote: '"' | "'" | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string
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
    if (ch === '&') {
      // `&&` is the one allowed composer; a single `&` is backgrounding.
      if (command[i + 1] === '&') {
        i += 1
        continue
      }
      return true
    }
    if (SHELL_ACTIVE_METACHARS.has(ch)) return true
  }
  return false
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

function containsShellActiveMetachar(command: string): boolean {
  let quote: '"' | "'" | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string
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

// unsafe=true when the command LOOKS like a `cd … && git …` but the cd target is
// not a plain path we can faithfully turn into `git -C` (shell `~`/`-` expansion,
// metachars). The caller then passes through rather than rewrite wrong cwd.
type StrippedCd = { cdDir: string | null; rest: string; unsafe: boolean }

// Accepts ONLY `cd <simple-path> && git …`. <simple-path> must be a single
// token (optionally quoted) free of metachars and of a literal single quote
// (rewriteCdToDashC single-quotes it), and not a shell-expanded `~`/`-`. A plain
// command (no `cd` prefix) returns cdDir=null, unsafe=false.
function stripSafeCdPrefix(command: string): StrippedCd {
  const m = command.match(/^\s*cd\s+("[^"]*"|'[^']*'|[^\s'"]+)\s+&&\s+(git\b[\s\S]*)$/)
  if (m === null) return { cdDir: null, rest: command, unsafe: false }
  const rawDir = m[1] as string
  const rest = m[2] as string
  const dir = stripQuotes(rawDir)
  const shellExpands = dir === '-' || dir === '~' || dir.startsWith('~/')
  if (dir.includes('$') || dir.includes('`') || dir.includes("'") || /[;|&<>()]/.test(dir) || shellExpands) {
    return { cdDir: null, rest: command, unsafe: true }
  }
  return { cdDir: dir, rest, unsafe: false }
}

function rewriteCdToDashC(dir: string, gitCommand: string): string {
  return gitCommand.replace(/^git\b/, `git -C '${dir}'`)
}

function resolveCwd(base: string, dir: string | null): string {
  if (dir === null || dir === '') return base
  if (dir.startsWith('/')) return dir
  return `${base.replace(/\/$/, '')}/${dir}`
}

function stripQuotes(token: string): string {
  if (token.length < 2) return token
  const first = token[0]
  const last = token[token.length - 1]
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) return token.slice(1, -1)
  return token
}

// Quote-aware; emits shell control operators as standalone tokens so
// command-boundary detection works. Mirrors gh-command.ts's tokenize.
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
