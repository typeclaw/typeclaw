// Plain-`git` analog of analyzeGhCommand. Git names its target indirectly, so
// this analyzer resolves configured remotes before selecting a per-repo token.

import { spawn, type ChildProcess } from 'node:child_process'

import { mapVirtualTmpPath } from '@/sandbox'

import { GIT_CREDENTIAL_ENV_KEYS } from './git-credential-env'

// GitHub refuses anonymous writes, so a `write` decision the broker cannot fund
// is already doomed — the caller turns that into a block with guidance rather
// than letting git die on a credential prompt. Reads stay fundable-but-optional:
// public clone/fetch/ls-remote succeed with no token at all.
export type GitRemoteAccess = 'read' | 'write'

export type GitPushProvenance =
  | { kind: 'explicit-url'; complete: true }
  | {
      kind: 'configured-remote'
      remote: string
      pushUrls: string[]
      repoSlugs: string[]
      worktreeTopLevel: string | null
      sourceCwd: string
      refspecs: string[]
      setUpstream: boolean
      complete: boolean
    }

export type GitCommandDecision =
  | { kind: 'pass-through' }
  | { kind: 'block'; reason: string }
  | {
      kind: 'inject'
      repoSlug: string
      access: GitRemoteAccess
      pushProvenance?: GitPushProvenance
      rewrittenCommand?: string
    }

export type GitRemoteResolver = (cwd: string, remote: string, forPush: boolean) => Promise<string | null>
export type GitConfigResolver = (cwd: string, key: string) => Promise<string | null>
export type GitBranchResolver = (cwd: string) => Promise<string | null>

export type GitResolvers = {
  resolveRemoteUrl: GitRemoteResolver
  resolveConfig: GitConfigResolver
  resolveCurrentBranch: GitBranchResolver
  resolvePushUrls?: (cwd: string, remote: string) => Promise<string[] | null>
  resolveTopLevel?: (cwd: string) => Promise<string | null>
}

const GIT_RESOLVER_TIMEOUT_MS = 2_000
const GIT_RESOLVER_STDOUT_LIMIT = 64 * 1024
const GIT_RESOLVER_KILL_SETTLE_MS = 250

async function runGit(cwd: string, args: string[]): Promise<string | null> {
  return await new Promise((resolveResult) => {
    const child = spawn('git', ['-C', cwd, ...args], {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    })
    const chunks: Buffer[] = []
    let bytes = 0
    let settled = false
    let settleTimer: ReturnType<typeof setTimeout> | undefined
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
      if (settleTimer !== undefined) clearTimeout(settleTimer)
      resolveResult(value)
    }
    const terminate = (): void => {
      if (settleTimer !== undefined || settled) return
      killChildProcessGroup(child)
      settleTimer = setTimeout(() => finish(null), GIT_RESOLVER_KILL_SETTLE_MS)
    }
    timeoutTimer = setTimeout(terminate, GIT_RESOLVER_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > GIT_RESOLVER_STDOUT_LIMIT) {
        terminate()
        return
      }
      chunks.push(chunk)
    })
    child.on('error', () => finish(null))
    child.on('close', (code) => {
      if (code !== 0 || bytes > GIT_RESOLVER_STDOUT_LIMIT) return finish(null)
      const output = Buffer.concat(chunks).toString('utf8').trim()
      finish(output === '' ? null : output)
    })
  })
}

function killChildProcessGroup(child: ChildProcess): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL')
      return
    } catch {
      child.kill('SIGKILL')
      return
    }
  }
  child.kill('SIGKILL')
}

export const defaultGitResolvers: GitResolvers = {
  resolveRemoteUrl: (cwd, remote, forPush) =>
    runGit(cwd, forPush ? ['remote', 'get-url', '--push', remote] : ['remote', 'get-url', remote]),
  resolveConfig: (cwd, key) => runGit(cwd, ['config', '--get', key]),
  resolveCurrentBranch: (cwd) => runGit(cwd, ['symbolic-ref', '--short', 'HEAD']),
  resolvePushUrls: async (cwd, remote) => {
    const output = await runGit(cwd, ['remote', 'get-url', '--push', '--all', remote])
    return output === null ? null : output.split(/\r?\n/).filter((line) => line !== '')
  },
  resolveTopLevel: (cwd) => runGit(cwd, ['rev-parse', '--show-toplevel']),
}

// Sandboxed bash sees the per-session scratch dir bound over `/tmp`
// (applyBashSandbox), but these resolvers spawn `git` from the runtime process
// against the REAL container `/tmp` — so a repo the model cloned to `/tmp/foo`
// resolves to nothing here and the command falls through UNBROKERED, leaving git
// to die on a credential prompt it can never answer. Same class of bug the file
// tools solve with TMP_REDIRECT_TOOLS. Only the filesystem probe is redirected:
// the analyzer must keep reasoning in model-facing paths so `rewrittenCommand`
// stays valid inside the sandbox.
export function createSessionTmpGitResolvers(
  agentDir: string,
  sessionId: string,
  base: GitResolvers = defaultGitResolvers,
): GitResolvers {
  const backing = (cwd: string): string => mapVirtualTmpPath(agentDir, sessionId, cwd) ?? cwd
  const mapped: GitResolvers = {
    resolveRemoteUrl: (cwd, remote, forPush) => base.resolveRemoteUrl(backing(cwd), remote, forPush),
    resolveConfig: (cwd, key) => base.resolveConfig(backing(cwd), key),
    resolveCurrentBranch: (cwd) => base.resolveCurrentBranch(backing(cwd)),
  }
  if (base.resolvePushUrls !== undefined) {
    mapped.resolvePushUrls = (cwd, remote) => base.resolvePushUrls?.(backing(cwd), remote) ?? Promise.resolve(null)
  }
  if (base.resolveTopLevel !== undefined) {
    mapped.resolveTopLevel = (cwd) => base.resolveTopLevel?.(backing(cwd)) ?? Promise.resolve(null)
  }
  return mapped
}

const MULTI_OWNER_REASON =
  'This git command targets more than one repository; a single minted GitHub App ' +
  'token is scoped to one repo and cannot authenticate all of them. Split it into ' +
  'separate commands, one repository each.'

const MIXED_PUSH_URLS_REASON =
  'This remote mixes GitHub push destinations with a malformed or non-GitHub push URL. ' +
  'TypeClaw cannot safely bind credentials to every destination, so the push is blocked.'

const COMPOSITION_REASON =
  'A repo-targeting `git` command receives a minted GitHub App token via ' +
  'GIT_ASKPASS in its process environment, so it must run as a single bare ' +
  '`git` command — no `;`, `&&`, `||`, `&`, newlines, pipes, redirections, ' +
  'command/parameter substitution, or subshells (any sibling process would ' +
  'inherit the token). The one accepted prefix is `cd <simple-path> && git …`, ' +
  'which is rewritten to `git -C <path> …`. Run local Git commands separately, ' +
  'then retry the remote operation as a standalone `git -C <path> …` command.'

const AMBIENT_GITHUB_TOKEN_ENV_KEYS = ['GH_TOKEN', 'GITHUB_TOKEN'] as const
const TAIL_STRIP_ENV_KEYS = GIT_CREDENTIAL_ENV_KEYS.flatMap((key) =>
  key === 'GIT_ASKPASS' ? [key, ...AMBIENT_GITHUB_TOKEN_ENV_KEYS] : [key],
)
const TAIL_STRIP_PREFIX = `exec /usr/bin/env ${TAIL_STRIP_ENV_KEYS.map((key) => `-u ${key}`).join(' ')} /bin/bash -c`

type RemoteSubcommand = 'push' | 'fetch' | 'pull' | 'clone' | 'ls-remote'

type TargetSpec =
  | { kind: 'default-push'; refspecs: []; setUpstream: false }
  | { kind: 'single'; value: string; forPush: boolean; refspecs?: string[]; setUpstream?: boolean }
  | { kind: 'multiple'; values: string[] }

type MintableInvocation = {
  subcommand: RemoteSubcommand
  cwd: string
  dashCCount: number
  target: TargetSpec
}

type RepoEvidence = {
  slugs: string[]
  complete: boolean
  blockReason?: string
  pushProvenance?: GitPushProvenance
}

const EVIDENCE_GLOBAL_VALUE_OPTIONS = new Set([
  '--config-env',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
])
const EVIDENCE_GLOBAL_INLINE_PREFIXES = ['--config-env=', '--git-dir=', '--work-tree=', '--namespace=', '--exec-path=']

function noEvidence(complete = true): RepoEvidence {
  return { slugs: [], complete }
}

export async function analyzeGitCommand(
  command: string,
  options: { cwd: string; resolvers: GitResolvers },
): Promise<GitCommandDecision> {
  // clone-then-inspect is the established exception: the clone head is rebuilt
  // from a tiny grammar and the tail runs only after exec strips every token var.
  if (!containsEscapeOrComment(command)) {
    const cloneThenInspect = analyzeCloneThenInspect(command)
    if (cloneThenInspect !== null) return cloneThenInspect
  }

  const safeCd = parseSafeCdPrefix(command, options.cwd)
  if (safeCd.kind === 'unsafe') return { kind: 'pass-through' }
  if (safeCd.kind === 'safe') {
    const invocation = parseMintableGitInvocation(safeCd.rest, safeCd.cwd)
    if (invocation !== null) {
      const decision = await decideStandalone(invocation, options.resolvers)
      if (invocation.dashCCount > 0) {
        return decision.kind === 'inject' ? { kind: 'block', reason: COMPOSITION_REASON } : decision
      }
      if (decision.kind !== 'inject') return decision
      return {
        ...decision,
        rewrittenCommand: safeCd.rest.replace(/^git\b/, `git -C ${posixSingleQuote(safeCd.cwd)}`),
      }
    }

    if (!hasShellComposition(safeCd.rest)) return { kind: 'pass-through' }
    const evidence = await discoverCompoundEvidence(safeCd.rest, safeCd.cwd, options.resolvers)
    return evidence.slugs.length > 0 ? { kind: 'block', reason: COMPOSITION_REASON } : { kind: 'pass-through' }
  }

  const invocation = parseMintableGitInvocation(command, options.cwd)
  if (invocation !== null) return decideStandalone(invocation, options.resolvers)

  if (!hasShellComposition(command)) return { kind: 'pass-through' }

  const evidence = await discoverCompoundEvidence(command, options.cwd, options.resolvers)
  return evidence.slugs.length > 0 ? { kind: 'block', reason: COMPOSITION_REASON } : { kind: 'pass-through' }
}

async function decideStandalone(invocation: MintableInvocation, resolvers: GitResolvers): Promise<GitCommandDecision> {
  const evidence = await resolveMintableEvidence(invocation, resolvers)
  const repos = new Set(evidence.slugs)

  if (evidence.blockReason !== undefined) return { kind: 'block', reason: evidence.blockReason }
  // The order is deliberate: partial evidence may justify blocking a compound,
  // but it can never justify minting for a standalone command.
  if (repos.size === 0) return { kind: 'pass-through' }
  if (!evidence.complete) return { kind: 'pass-through' }
  if (repos.size > 1 && evidence.pushProvenance?.kind !== 'configured-remote') {
    return { kind: 'block', reason: MULTI_OWNER_REASON }
  }
  return {
    kind: 'inject',
    repoSlug: [...repos][0] as string,
    access: remoteAccess(invocation.subcommand),
    ...(evidence.pushProvenance === undefined ? {} : { pushProvenance: evidence.pushProvenance }),
  }
}

function remoteAccess(subcommand: RemoteSubcommand): GitRemoteAccess {
  return subcommand === 'push' ? 'write' : 'read'
}

function parseMintableGitInvocation(command: string, baseCwd: string): MintableInvocation | null {
  const words = tokenizeStandalone(command)
  if (words === null || words[0] !== 'git') return null

  let cursor = 1
  let cwd = baseCwd
  let dashCCount = 0
  while (words[cursor] === '-C') {
    const dir = words[cursor + 1]
    if (dir === undefined || !isLiteralDirectory(dir)) return null
    cwd = resolveCwd(cwd, dir)
    dashCCount += 1
    cursor += 2
  }

  const subcommand = words[cursor]
  if (!isRemoteSubcommand(subcommand)) return null
  const args = words.slice(cursor + 1)
  const target = parseMintableTarget(subcommand, args)
  return target === null ? null : { subcommand, cwd, dashCCount, target }
}

function parseMintableTarget(subcommand: RemoteSubcommand, args: readonly string[]): TargetSpec | null {
  if (subcommand === 'push') return parseMintablePush(args)
  if (subcommand === 'fetch') return parseMintableFetch(args)
  if (subcommand === 'pull') return parseSimpleRemote(args, false)
  if (subcommand === 'clone') return parseCloneTarget(args)
  return parseExplicitUrl(args, Number.POSITIVE_INFINITY)
}

// Value-less clone flags that cannot redirect the fetch to another repo/host, run a
// command, or read/write a path outside the destination. Deliberately EXCLUDES
// --recurse-submodules (fetches other repos with the token live), --upload-pack and
// -c/--config (command execution / url.insteadOf rewriting), and --template,
// --reference, --separate-git-dir (arbitrary path read/write).
const SAFE_CLONE_FLAGS = new Set([
  '-q',
  '--quiet',
  '--progress',
  '-n',
  '--no-checkout',
  '--single-branch',
  '--no-single-branch',
  '--no-tags',
  '--bare',
  '--sparse',
])

// Clone flags that consume the NEXT argv word as their value.
const SAFE_CLONE_VALUE_FLAGS = new Set(['--depth', '-b', '--branch'])

// `--flag=value` forms whose value is inert (a count, ref, date, or filter spec).
const SAFE_CLONE_INLINE_PREFIXES = ['--depth=', '--branch=', '--filter=', '--shallow-since=', '--shallow-exclude=']

// git clone's URL is a POSITIONAL, so the previous fixed-index parse rejected every
// flagged clone — `--depth 1`, the most common shape in code-analysis workflows, got
// no credential and failed on a private repo with git's opaque "could not read
// Username". Skipping a conservative flag allowlist finds the same positional while
// any unrecognized flag still falls through to no-credential (fails safe).
function parseCloneTarget(args: readonly string[]): TargetSpec | null {
  const positionals: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (SAFE_CLONE_FLAGS.has(arg)) continue
    if (SAFE_CLONE_VALUE_FLAGS.has(arg)) {
      const value = args[++i]
      if (value === undefined || !isOptionValue(value)) return null
      continue
    }
    if (SAFE_CLONE_INLINE_PREFIXES.some((prefix) => arg.startsWith(prefix))) continue
    if (!isOptionValue(arg)) return null
    positionals.push(arg)
  }
  if (positionals.length === 0 || positionals.length > 2) return null
  const url = positionals[0] as string
  return looksLikeUrl(url) ? { kind: 'single', value: url, forPush: false } : null
}

function parseMintablePush(args: readonly string[]): TargetSpec | null {
  const positionals: string[] = []
  let repository: string | null = null
  let upstream = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '-u' || arg === '--set-upstream') {
      if (upstream) return null
      upstream = true
      continue
    }
    if (arg === '--repo' || arg === '--repository') {
      const value = args[++i]
      if (value === undefined || repository !== null || !isOptionValue(value)) return null
      repository = value
      continue
    }
    if (arg.startsWith('--repo=') || arg.startsWith('--repository=')) {
      const value = arg.slice(arg.indexOf('=') + 1)
      if (repository !== null || !isOptionValue(value)) return null
      repository = value
      continue
    }
    if (!isOptionValue(arg)) return null
    positionals.push(arg)
  }

  if (repository !== null) {
    return { kind: 'single', value: repository, forPush: true, refspecs: positionals, setUpstream: upstream }
  }
  if (positionals.length > 0) {
    return {
      kind: 'single',
      value: positionals[0] as string,
      forPush: true,
      refspecs: positionals.slice(1),
      setUpstream: upstream,
    }
  }
  return upstream ? null : { kind: 'default-push', refspecs: [], setUpstream: false }
}

function parseMintableFetch(args: readonly string[]): TargetSpec | null {
  let multiple = false
  const positionals: string[] = []
  for (const arg of args) {
    if (arg === '--multiple') {
      if (multiple) return null
      multiple = true
    } else if (!isOptionValue(arg)) {
      return null
    } else {
      positionals.push(arg)
    }
  }
  if (positionals.length === 0) return null
  return multiple
    ? { kind: 'multiple', values: positionals }
    : { kind: 'single', value: positionals[0] as string, forPush: false }
}

function parseSimpleRemote(args: readonly string[], forPush: boolean): TargetSpec | null {
  if (args.length === 0 || args.some((arg) => !isOptionValue(arg))) return null
  return { kind: 'single', value: args[0] as string, forPush }
}

function parseExplicitUrl(args: readonly string[], maxPositionals: number): TargetSpec | null {
  if (args.length === 0 || args.length > maxPositionals || args.some((arg) => !isOptionValue(arg))) return null
  const url = args[0] as string
  return looksLikeUrl(url) ? { kind: 'single', value: url, forPush: false } : null
}

function tokenizeStandalone(command: string): string[] | null {
  if (containsEscapeOrComment(command)) return null
  const words: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let hasContent = false

  const flush = (): void => {
    if (!hasContent) return
    words.push(current)
    current = ''
    hasContent = false
  }

  for (const ch of command) {
    if (quote === "'") {
      if (ch === "'") quote = null
      else current += ch
      continue
    }
    if (quote === '"') {
      if (ch === '$' || ch === '`') return null
      if (ch === '"') quote = null
      else current += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      hasContent = true
      continue
    }
    if (ch === ' ' || ch === '\t') {
      flush()
      continue
    }
    if (';&|\n\r(){}<>`$*?[]'.includes(ch)) return null
    current += ch
    hasContent = true
  }
  if (quote !== null) return null
  flush()
  return words
}

function isRemoteSubcommand(value: string | undefined): value is RemoteSubcommand {
  return value === 'push' || value === 'fetch' || value === 'pull' || value === 'clone' || value === 'ls-remote'
}

function isLiteralDirectory(value: string): boolean {
  return value !== '' && value !== '-' && value !== '~' && !value.startsWith('~/') && !value.startsWith('-')
}

function isOptionValue(value: string): boolean {
  return value !== '' && !value.startsWith('-') && !value.startsWith('~')
}

async function resolveMintableEvidence(invocation: MintableInvocation, resolvers: GitResolvers): Promise<RepoEvidence> {
  if (invocation.target.kind === 'multiple') {
    return resolveFetchMultiple(invocation.target.values, invocation.cwd, resolvers)
  }
  if (invocation.target.kind === 'default-push') {
    try {
      const remote = await resolveDefaultPushRemote(invocation.cwd, resolvers)
      return resolveOneTarget(remote, invocation.cwd, true, resolvers, false, invocation.target)
    } catch {
      return noEvidence(false)
    }
  }
  return resolveOneTarget(
    invocation.target.value,
    invocation.cwd,
    invocation.target.forPush,
    resolvers,
    false,
    invocation.target,
  )
}

async function resolveFetchMultiple(
  targets: readonly string[],
  cwd: string,
  resolvers: GitResolvers,
): Promise<RepoEvidence> {
  const slugs: string[] = []
  let complete = targets.length > 0

  for (const target of targets) {
    const evidence = await resolveOneTarget(target, cwd, false, resolvers, true)
    slugs.push(...evidence.slugs)
    complete &&= evidence.complete
  }
  return { slugs, complete }
}

async function resolveOneTarget(
  target: string | null,
  cwd: string,
  forPush: boolean,
  resolvers: GitResolvers,
  nonGithubIsIncomplete: boolean,
  targetSpec?: TargetSpec,
): Promise<RepoEvidence> {
  if (target === null) return noEvidence(false)
  const explicitUrl = looksLikeUrl(target)
  if (forPush && explicitUrl) {
    const slug = parseGithubRepoFromGitUrl(target)
    return slug === null
      ? { ...noEvidence(!nonGithubIsIncomplete), pushProvenance: { kind: 'explicit-url', complete: true } }
      : { slugs: [slug], complete: true, pushProvenance: { kind: 'explicit-url', complete: true } }
  }

  if (forPush && !explicitUrl && resolvers.resolvePushUrls !== undefined) {
    let pushUrls: string[] | null
    try {
      pushUrls = await resolvers.resolvePushUrls(cwd, target)
    } catch {
      return noEvidence(false)
    }
    if (pushUrls === null || pushUrls.length === 0) return noEvidence(false)
    const parsedSlugs = pushUrls.map((url) => parseGithubRepoFromGitUrl(url))
    const githubSlugs = parsedSlugs.filter((slug): slug is string => slug !== null)
    if (githubSlugs.length === 0) return noEvidence(!nonGithubIsIncomplete && pushUrls.length === 1)
    if (githubSlugs.length !== pushUrls.length) {
      return { slugs: orderedCanonicalSlugs(githubSlugs), complete: false, blockReason: MIXED_PUSH_URLS_REASON }
    }
    const repoSlugs = orderedCanonicalSlugs(githubSlugs)
    let worktreeTopLevel: string | null = null
    if (resolvers.resolveTopLevel !== undefined) {
      try {
        worktreeTopLevel = await resolvers.resolveTopLevel(cwd)
      } catch {
        worktreeTopLevel = null
      }
    }
    return {
      slugs: repoSlugs,
      complete: true,
      pushProvenance: {
        kind: 'configured-remote',
        remote: target,
        pushUrls,
        repoSlugs,
        worktreeTopLevel,
        sourceCwd: cwd,
        refspecs: targetSpec?.kind === 'single' ? (targetSpec.refspecs ?? []) : [],
        setUpstream: targetSpec?.kind === 'single' ? (targetSpec.setUpstream ?? false) : false,
        complete: worktreeTopLevel !== null,
      },
    }
  }
  let url: string | null
  try {
    url = explicitUrl ? target : await resolvers.resolveRemoteUrl(cwd, target, forPush)
  } catch {
    return noEvidence(false)
  }
  if (url === null) return noEvidence(false)

  const slug = parseGithubRepoFromGitUrl(url)
  if (slug !== null) return { slugs: [slug], complete: true }
  return { slugs: [], complete: !nonGithubIsIncomplete }
}

function orderedCanonicalSlugs(slugs: readonly string[]): string[] {
  return [...new Set(slugs.map((slug) => slug.toLocaleLowerCase()))]
}

async function resolveDefaultPushRemote(cwd: string, resolvers: GitResolvers): Promise<string> {
  const branch = await resolvers.resolveCurrentBranch(cwd)
  if (branch !== null && branch !== '') {
    const perBranch = await resolvers.resolveConfig(cwd, `branch.${branch}.pushRemote`)
    if (perBranch !== null && perBranch !== '') return perBranch
  }
  const pushDefault = await resolvers.resolveConfig(cwd, 'remote.pushDefault')
  if (pushDefault !== null && pushDefault !== '') return pushDefault
  if (branch !== null && branch !== '') {
    const branchRemote = await resolvers.resolveConfig(cwd, `branch.${branch}.remote`)
    if (branchRemote !== null && branchRemote !== '') return branchRemote
  }
  return 'origin'
}

// Evidence discovery is intentionally not a shell parser. It recognizes only a
// literal git at a few review-relevant boundaries, narrow redirection/wrapper
// prefixes, and one immediately preceding literal `cd`. Misses run tokenless.
async function discoverCompoundEvidence(command: string, cwd: string, resolvers: GitResolvers): Promise<RepoEvidence> {
  const combined = noEvidence()
  for (const segment of extractEvidenceGitSegments(command)) {
    if (segment.cwd.kind === 'ambiguous') continue
    const effectiveCwd = segment.cwd.kind === 'relative' ? resolveCwd(cwd, segment.cwd.dir) : cwd
    const evidence = await discoverInvocationEvidence(segment.command, effectiveCwd, resolvers)
    combined.slugs.push(...evidence.slugs)
    combined.complete &&= evidence.complete
  }
  return combined
}

type EvidenceCwd = { kind: 'base' } | { kind: 'relative'; dir: string } | { kind: 'ambiguous' }
type EvidenceGitSegment = { command: string; cwd: EvidenceCwd }

function extractEvidenceGitSegments(command: string): EvidenceGitSegment[] {
  const segments: EvidenceGitSegment[] = []
  const assignment = '[A-Za-z_][A-Za-z0-9_]*=[^ \\t;&|(){}<>`\\r\\n]+'
  const startRe = new RegExp(
    `(?:^|&&|\\|\\||[;|&({\`\\n\\r])[ \\t]*` +
      `(?:[0-9]*(?:>{1,2}|<)[ \\t]*[^ \\t;&|(){}<>\`\\r\\n]+[ \\t]+)*` +
      `(?:(?:exec|command)[ \\t]+|env[ \\t]+(?:${assignment}[ \\t]+)*|(?:${assignment}[ \\t]+)+)?` +
      'git(?=[ \\t]|$)',
    'g',
  )
  for (const match of command.matchAll(startRe)) {
    const matchText = match[0]
    if (matchText === undefined || match.index === undefined) continue
    const start = match.index + matchText.lastIndexOf('git')
    let end = start + 3
    while (end < command.length && !';|&(){}<>`#\n\r'.includes(command[end] as string)) end += 1
    segments.push({
      command: command.slice(start, end).trim(),
      cwd: classifyEvidenceCwd(command.slice(0, match.index), matchText),
    })
  }
  return segments
}

function classifyEvidenceCwd(prefix: string, matchText: string): EvidenceCwd {
  const boundary = matchText.trimStart()
  const direct = /(^|&&|\|\||[;|&({`\n\r])[ \t]*cd[ \t]+("[^"]*"|'[^']*'|[^\s'"]+)[ \t]*$/
  const beforeGroup = /(^|&&|\|\||[;|&({`\n\r])[ \t]*cd[ \t]+("[^"]*"|'[^']*'|[^\s'"]+)[ \t]+&&[ \t]*$/
  const match = boundary.startsWith('&&')
    ? direct.exec(prefix)
    : boundary.startsWith('(') || boundary.startsWith('{')
      ? beforeGroup.exec(prefix)
      : null
  const containsPriorCd = /(?:^|&&|\|\||[;|&({`\n\r])[ \t]*cd(?:[ \t]|$)/
  if (match === null) return containsPriorCd.test(prefix) ? { kind: 'ambiguous' } : { kind: 'base' }
  if (containsPriorCd.test(prefix.slice(0, match.index))) return { kind: 'ambiguous' }

  const dir = stripPairedQuotes(match[2] as string)
  return isSafeCdDirectory(dir) ? { kind: 'relative', dir } : { kind: 'ambiguous' }
}

async function discoverInvocationEvidence(
  segment: string,
  baseCwd: string,
  resolvers: GitResolvers,
): Promise<RepoEvidence> {
  const words = segment.split(/[ \t]+/).map(stripPairedQuotes)
  if (words[0] !== 'git') return noEvidence()

  let cursor = 1
  let cwd = baseCwd
  while (cursor < words.length) {
    const arg = words[cursor] as string
    if (arg === '-C') {
      const dir = words[cursor + 1]
      if (dir === undefined || !isLiteralDirectory(dir)) return noEvidence()
      cwd = resolveCwd(cwd, dir)
      cursor += 2
      continue
    }
    if (arg === '-c' || EVIDENCE_GLOBAL_VALUE_OPTIONS.has(arg)) {
      if (words[cursor + 1] === undefined) return noEvidence()
      cursor += 2
      continue
    }
    if (arg.startsWith('-c') && arg.length > 2) {
      cursor += 1
      continue
    }
    if (EVIDENCE_GLOBAL_INLINE_PREFIXES.some((prefix) => arg.startsWith(prefix))) {
      cursor += 1
      continue
    }
    break
  }

  const subcommand = words[cursor]
  if (!isRemoteSubcommand(subcommand)) return noEvidence()
  const target = parseEvidenceTarget(subcommand, words.slice(cursor + 1))
  if (target === null) return noEvidence()
  if (target.kind === 'multiple') return resolveFetchMultiple(target.values, cwd, resolvers)
  if (target.kind === 'default-push') {
    try {
      return resolveOneTarget(await resolveDefaultPushRemote(cwd, resolvers), cwd, true, resolvers, false)
    } catch {
      return noEvidence(false)
    }
  }
  return resolveOneTarget(target.value, cwd, target.forPush, resolvers, false)
}

function parseEvidenceTarget(subcommand: RemoteSubcommand, args: readonly string[]): TargetSpec | null {
  if (subcommand === 'push') {
    let repository: string | null = null
    const positionals: string[] = []
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] as string
      if (arg === '-u' || arg === '--set-upstream') continue
      if (arg === '--repo' || arg === '--repository') {
        const value = args[++i]
        if (value === undefined || repository !== null || !isOptionValue(value)) return null
        repository = value
        continue
      }
      if (arg.startsWith('--repo=') || arg.startsWith('--repository=')) {
        const value = arg.slice(arg.indexOf('=') + 1)
        if (repository !== null || !isOptionValue(value)) return null
        repository = value
        continue
      }
      if (!isOptionValue(arg)) return null
      positionals.push(arg)
    }
    if (repository !== null) return { kind: 'single', value: repository, forPush: true }
    return positionals.length === 0
      ? { kind: 'default-push', refspecs: [], setUpstream: false }
      : { kind: 'single', value: positionals[0] as string, forPush: true }
  }

  if (subcommand === 'fetch') {
    let multiple = false
    const positionals: string[] = []
    for (const arg of args) {
      if (arg === '--multiple') multiple = true
      else if (!isOptionValue(arg)) return null
      else positionals.push(arg)
    }
    if (positionals.length === 0) return null
    return multiple
      ? { kind: 'multiple', values: positionals }
      : { kind: 'single', value: positionals[0] as string, forPush: false }
  }

  if (subcommand === 'pull' || subcommand === 'ls-remote') {
    if (args.length === 0 || args.some((arg) => !isOptionValue(arg))) return null
    return { kind: 'single', value: args[0] as string, forPush: false }
  }

  const positionals: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (
      arg === '--depth' ||
      arg === '--branch' ||
      arg === '-b' ||
      arg === '--origin' ||
      arg === '-o' ||
      arg === '--config'
    ) {
      if (args[++i] === undefined) return null
      continue
    }
    if (arg.startsWith('--config=')) continue
    if (arg.startsWith('-')) return null
    positionals.push(arg)
  }
  if (positionals.length === 0 || !looksLikeUrl(positionals[0] as string)) return null
  return { kind: 'single', value: positionals[0] as string, forPush: false }
}

function hasShellComposition(command: string): boolean {
  if (containsEscapeOrComment(command)) return true
  let quote: '"' | "'" | null = null
  for (const ch of command) {
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
    if (';&|\n\r(){}<>`$*?[]'.includes(ch)) return true
  }
  return quote !== null
}

function containsEscapeOrComment(command: string): boolean {
  return command.includes('\\') || command.includes('#')
}

type SafeCd = { kind: 'none' } | { kind: 'unsafe' } | { kind: 'safe'; cwd: string; rest: string }

function parseSafeCdPrefix(command: string, baseCwd: string): SafeCd {
  const match = command.match(/^\s*cd\s+("[^"]*"|'[^']*'|[^\s'"]+)\s+&&\s*(\S[\s\S]*?)\s*$/)
  if (match === null) return { kind: 'none' }
  const dir = stripPairedQuotes(match[1] as string)
  if (!isSafeCdDirectory(dir)) return { kind: 'unsafe' }
  return { kind: 'safe', cwd: resolveCwd(baseCwd, dir), rest: match[2] as string }
}

function isSafeCdDirectory(dir: string): boolean {
  return isLiteralDirectory(dir) && !dir.includes("'") && !/[;|&<>(){}$`\\#]/.test(dir)
}

function resolveCwd(base: string, dir: string): string {
  if (dir.startsWith('/')) return dir
  return `${base.replace(/\/$/, '')}/${dir}`
}

function stripPairedQuotes(value: string): string {
  if (value.length < 2) return value
  const first = value[0]
  const last = value[value.length - 1]
  return first === last && (first === '"' || first === "'") ? value.slice(1, -1) : value
}

// The token-bearing clone head is deliberately much smaller than Git's grammar.
// The tail is opaque and runs only in a new token-stripped shell.
function analyzeCloneThenInspect(command: string): GitCommandDecision | null {
  const split = splitCloneHeadAndTail(command)
  if (split === null) return null
  if (split.tail === '') return { kind: 'block', reason: COMPOSITION_REASON }
  if (tailContainsGitInvocation(split.tail)) return null

  const parsed = parseStrictCloneHead(split.head)
  if (parsed === null) return isNonGithubCloneHead(split.head) ? { kind: 'pass-through' } : null

  const flagPart = parsed.flags.map(posixSingleQuote).join(' ')
  const canonicalHead =
    `/usr/bin/git clone ${flagPart === '' ? '' : `${flagPart} `}` +
    `${posixSingleQuote(parsed.url)} ${posixSingleQuote(parsed.destination)}`
  return {
    kind: 'inject',
    repoSlug: parsed.repoSlug,
    access: 'read',
    rewrittenCommand: `${canonicalHead} && ${TAIL_STRIP_PREFIX} ${posixSingleQuote(split.tail)}`,
  }
}

function tailContainsGitInvocation(tail: string): boolean {
  return extractEvidenceGitSegments(tail).length > 0
}

type StrictCloneHead = { repoSlug: string; url: string; destination: string; flags: string[] }

const STRICT_CLONE_URL_RE = /^(https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?)$/
const STRICT_CLONE_DESTINATION_RE = /^[A-Za-z0-9._/-]+$/
const SAFE_CLONE_FLAG_VALUE_RE = /^[A-Za-z0-9._:@/-]+$/

// The executed head is REBUILT from these parts rather than passed through, so the
// grammar stays tiny even though it now admits flags: every accepted token comes from
// the SAFE_CLONE_* allowlists, every value is charset-constrained, and each is
// re-emitted single-quoted. Without this a plain `git clone --depth 1 <url> <dir> &&
// <inspect>` — the natural code-analysis command — blocks outright.
function parseStrictCloneHead(head: string): StrictCloneHead | null {
  const words = tokenizeStandalone(head)
  if (words === null || words[0] !== 'git' || words[1] !== 'clone') return null

  const flags: string[] = []
  const positionals: string[] = []
  for (let i = 2; i < words.length; i++) {
    const word = words[i] as string
    if (SAFE_CLONE_FLAGS.has(word)) {
      flags.push(word)
      continue
    }
    if (SAFE_CLONE_VALUE_FLAGS.has(word)) {
      const value = words[++i]
      if (value === undefined || !SAFE_CLONE_FLAG_VALUE_RE.test(value)) return null
      flags.push(word, value)
      continue
    }
    const prefix = SAFE_CLONE_INLINE_PREFIXES.find((candidate) => word.startsWith(candidate))
    if (prefix !== undefined) {
      if (!SAFE_CLONE_FLAG_VALUE_RE.test(word.slice(prefix.length))) return null
      flags.push(word)
      continue
    }
    if (word.startsWith('-')) return null
    positionals.push(word)
  }

  if (positionals.length !== 2) return null
  const [rawUrl, destination] = positionals as [string, string]
  const match = STRICT_CLONE_URL_RE.exec(rawUrl)
  if (match === null) return null
  const repoSlug = match[2] as string
  if (!STRICT_CLONE_DESTINATION_RE.test(destination)) return null
  if (destination.startsWith('-') || repoSlug.startsWith('/') || repoSlug.endsWith('/')) return null
  return { repoSlug, url: match[1] as string, destination, flags }
}

function isNonGithubCloneHead(head: string): boolean {
  if (!/^[ \t]*git[ \t]+clone[ \t]/.test(head)) return false
  const url = /(?:^|[ \t])((?:https?:\/\/|git@|ssh:\/\/)[^ \t]+)/.exec(head)?.[1]
  return url !== undefined && parseGithubRepoFromGitUrl(url) === null
}

function splitCloneHeadAndTail(command: string): { head: string; tail: string } | null {
  let quote: '"' | "'" | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string
    if (quote !== null) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === '&' && command[i + 1] === '&') {
      return { head: command.slice(0, i), tail: command.slice(i + 2).trim() }
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n' || ch === '\r') return null
  }
  return null
}

function posixSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

const HTTPS_GITHUB_RE = /^https:\/\/github\.com\/([^/\s:@]+)\/([^/\s?#]+?)(?:\.git)?\/?(?:[?#].*)?$/i
const SCP_GITHUB_RE = /^git@github\.com:([^/\s:?#]+)\/([^/\s?#]+?)(?:\.git)?$/i
const SSH_GITHUB_RE = /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s?#]+?)(?:\.git)?\/?(?:[?#].*)?$/i

export function parseGithubRepoFromGitUrl(raw: string): string | null {
  const url = raw.trim()
  for (const re of [HTTPS_GITHUB_RE, SCP_GITHUB_RE, SSH_GITHUB_RE]) {
    const match = url.match(re)
    if (match === null) continue
    const owner = match[1]
    const name = match[2]
    if (owner === undefined || name === undefined || owner === '' || name === '') return null
    return `${owner}/${name}`
  }
  return null
}

function looksLikeUrl(token: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(token) || /^[^@\s]+@[^:\s]+:/.test(token)
}

export async function resolveGhDefaultRepoFromCwd(cwd: string, resolvers: GitResolvers): Promise<string | null> {
  const url = await resolvers.resolveRemoteUrl(cwd, 'origin', false)
  return url === null ? null : parseGithubRepoFromGitUrl(url)
}
