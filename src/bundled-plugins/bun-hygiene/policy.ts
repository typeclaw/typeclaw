import type { InternalGuardResult } from '@/agent/guard-types'

import { GUARD_GLOBAL_INSTALL, GUARD_NON_BUN_PACKAGE_MANAGER, GUARD_NON_BUN_PACKAGE_RUNNER } from '../guard/keys'

export { GUARD_GLOBAL_INSTALL, GUARD_NON_BUN_PACKAGE_MANAGER, GUARD_NON_BUN_PACKAGE_RUNNER } from '../guard/keys'

// Install managers write competing lockfiles and install trees, so they are
// steered to bun.
const NON_BUN_MANAGERS = new Set(['npm', 'pnpm', 'yarn'])
// The runners were previously allowed on the argument that they leave no
// lockfile or install tree behind. True, but that argument only covers
// dependency-tree pollution — it says nothing about which command word runs,
// and in practice "allowed" became "default": the vendored agent-messenger
// skills instruct the agent to use `npx -y` and explicitly not to deliberate
// about the runner, so nothing downstream ever got to prefer bunx. They stay
// reachable through their own acknowledgement rather than being allowed
// outright. `pnpm dlx` and `bun x` are two-word forms: the former already
// blocks as a manager, the latter is bun and is fine.
const NON_BUN_RUNNERS = new Set(['npx', 'pnpx'])
const INSTALL_SUBCOMMANDS = new Set(['install', 'i', 'add'])

export function checkBunHygieneGuard(options: {
  tool: string
  args: Readonly<Record<string, unknown>>
}): InternalGuardResult {
  const { tool, args } = options
  if (tool !== 'bash') return undefined

  const command = args.command
  if (typeof command !== 'string') return undefined

  const verdict = classify(command)[0]
  return verdict === undefined ? undefined : blockFor(verdict)
}

export function checkGlobalInstallGuard(options: {
  tool: string
  args: Readonly<Record<string, unknown>>
}): InternalGuardResult {
  return checkVerdict(options, 'global-install')
}

export function checkNonBunPackageManagerGuard(options: {
  tool: string
  args: Readonly<Record<string, unknown>>
}): InternalGuardResult {
  return checkVerdict(options, 'non-bun')
}

export function checkNonBunPackageRunnerGuard(options: {
  tool: string
  args: Readonly<Record<string, unknown>>
}): InternalGuardResult {
  return checkVerdict(options, 'non-bun-runner')
}

function checkVerdict(
  options: { tool: string; args: Readonly<Record<string, unknown>> },
  kind: Verdict['kind'],
): InternalGuardResult {
  if (options.tool !== 'bash' || typeof options.args.command !== 'string') return undefined
  const verdict = classify(options.args.command).find((candidate) => candidate.kind === kind)
  return verdict === undefined ? undefined : blockFor(verdict)
}

function blockFor(verdict: Verdict): Exclude<InternalGuardResult, undefined> {
  if (verdict.kind === 'global-install') return blockGlobalInstall(verdict.label)
  if (verdict.kind === 'non-bun') return blockNonBunManager(verdict.manager)
  return blockNonBunRunner(verdict.runner)
}

type Verdict =
  | { kind: 'global-install'; label: string }
  | { kind: 'non-bun'; manager: string }
  | { kind: 'non-bun-runner'; runner: string }

// Why a segment model instead of one big regex: every gap in a raw-string match
// is a shell-structure gap. Splitting into segments first means a global flag on
// a *different* command (`npm install\n-g x` — two commands) can never combine
// with an install on another, leading assignment words (`FOO=bar npm ...`) are
// stripped uniformly, and `--global=false` is inspected as a real token. The
// global-install verdict wins over the plain non-bun verdict (it's the more
// specific violation, and acknowledging it is meant to let the whole thing run).
// Verdicts come back in precedence order and the caller stops at the first one
// that is not acknowledged. Falling through matters: `npm install && npx tsc`
// has two independent problems, so acknowledging the manager must still leave
// the runner blocked rather than clearing the whole command.
function classify(command: string): Verdict[] {
  let globalVerdict: Verdict | undefined
  let managerVerdict: Verdict | undefined
  let runnerVerdict: Verdict | undefined
  for (const segment of splitSegments(command)) {
    const words = segment.map(normalizeWord)
    const commandWord = leadingCommandWord(words)
    if (commandWord === undefined) continue

    if (NON_BUN_RUNNERS.has(commandWord)) {
      runnerVerdict ??= { kind: 'non-bun-runner', runner: commandWord }
      continue
    }

    // `bun` is the allowed manager, but a `bun add -g` still installs to ~/.bun
    // (outside /agent) and is wiped on restart, so it is a global install too —
    // just never a plain non-bun violation.
    const isBun = commandWord === 'bun'
    if (!isBun && !NON_BUN_MANAGERS.has(commandWord)) continue

    // A global install subsumes the manager verdict for ITS OWN segment only:
    // acknowledging `npm install -g x` is meant to let that install run without
    // demanding a second acknowledgement for the same words. Scoping it to the
    // segment is what stops it from clearing violations elsewhere in the
    // command — an early return here let `bun add -g foo && npx tsc` through on
    // a lone globalInstall acknowledgement.
    const label = globalInstallLabel(commandWord, words)
    if (label !== undefined) {
      globalVerdict ??= { kind: 'global-install', label }
      continue
    }
    if (!isBun) managerVerdict ??= { kind: 'non-bun', manager: commandWord }
  }
  return [globalVerdict, managerVerdict, runnerVerdict].filter((verdict): verdict is Verdict => verdict !== undefined)
}

// Split on real command separators (`;`, `&&`, `||`, `|`, `&`, newline, `\r`)
// and on subshell / command-substitution openers (`(`, `$(`, backtick), then
// tokenize each segment into whitespace-separated words. Quote-aware so a
// separator inside quotes stays literal; backslash escapes the next character
// (so `\;` and `\ ` are literal, not separators/breaks). Word-level only — it
// does not interpret redirections or expansions beyond boundary marking.
function splitSegments(command: string): string[][] {
  const segments: string[][] = []
  let words: string[] = []
  let current = ''
  let hasWord = false
  let quote: '"' | "'" | null = null
  // Tracks a command substitution entered from inside a double quote, so the
  // outer double-quote mode is restored when the substitution closes. Bash runs
  // `$(...)` and backtick substitutions inside double quotes (but not single),
  // so `echo "$(npm install)"` must be scanned for a manager.
  let commandSub: { kind: '`' | '$('; depth: number; resumeQuote: '"' } | null = null

  const flushWord = (): void => {
    if (hasWord) {
      words.push(current)
      current = ''
      hasWord = false
    }
  }
  const flushSegment = (): void => {
    flushWord()
    if (words.length > 0) {
      segments.push(words)
      words = []
    }
  }

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote !== null) {
      // A `$(` or backtick inside a double quote opens a command substitution
      // that Bash executes; scan its body as a fresh segment, remembering to
      // resume double-quote mode when it closes.
      if (quote === '"' && ch === '`') {
        flushSegment()
        commandSub = { kind: '`', depth: 0, resumeQuote: '"' }
        quote = null
        continue
      }
      if (quote === '"' && ch === '$' && command[i + 1] === '(') {
        flushSegment()
        commandSub = { kind: '$(', depth: 1, resumeQuote: '"' }
        quote = null
        i++
        continue
      }
      if (ch === quote) quote = null
      else {
        current += ch
        hasWord = true
      }
      continue
    }
    // Close of a command substitution opened from inside a double quote:
    // restore the outer double-quote mode so the rest of the string (and any
    // trailing `&&`/`;`) is parsed correctly rather than re-quoted.
    if (commandSub?.kind === '`' && ch === '`') {
      flushSegment()
      quote = commandSub.resumeQuote
      commandSub = null
      continue
    }
    if (commandSub?.kind === '$(' && ch === '$' && command[i + 1] === '(') {
      flushSegment()
      commandSub.depth++
      i++
      continue
    }
    if (commandSub?.kind === '$(' && ch === '(') {
      flushSegment()
      commandSub.depth++
      continue
    }
    if (commandSub?.kind === '$(' && ch === ')') {
      flushSegment()
      commandSub.depth--
      if (commandSub.depth === 0) {
        quote = commandSub.resumeQuote
        commandSub = null
      }
      continue
    }
    if (ch === '\\') {
      const next = command[i + 1]
      if (next === undefined) break
      // `\<newline>` (and `\<CR><newline>`) is a shell line continuation: the
      // shell removes it entirely, joining the surrounding text. Dropping it
      // here keeps `npm install \<nl>-g x` tokenized as `install`,`-g` (a global
      // install) instead of producing a malformed `install\n-g` token.
      if (next === '\n') {
        i++
        continue
      }
      if (next === '\r' && command[i + 2] === '\n') {
        i += 2
        continue
      }
      current += next
      hasWord = true
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      hasWord = true
      continue
    }
    if (ch === ' ' || ch === '\t') {
      flushWord()
      continue
    }
    if (ch === '\n' || ch === '\r' || ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === '`') {
      flushSegment()
      continue
    }
    if (ch === '$' && command[i + 1] === '(') {
      flushSegment()
      i++
      continue
    }
    current += ch
    hasWord = true
  }
  flushSegment()
  return segments
}

// A word is already quote/escape-collapsed by splitSegments (quotes consumed,
// backslash-escapes literalized), so the only residue to strip is leftover
// quote characters that appeared mid-token via concatenation. Keeping this
// explicit makes `"npm"`, `n\px`, `'npm'` all resolve to their bare binary.
function normalizeWord(word: string): string {
  return word.replaceAll('"', '').replaceAll("'", '')
}

// Preamble wrappers that prefix a real command (`sudo npm …`, `env FOO=bar npm
// …`, `nice -n 10 npm …`). The value is the set of SHORT option letters that
// consume the FOLLOWING word as their argument, so `sudo -u nobody npm` skips
// `nobody` too. Long `--opt=value` forms are self-contained (one token); bare
// long `--opt` and unknown short flags are skipped as a single token (the safe
// default — at worst we skip one extra token and still find the manager later).
const PREAMBLE_WRAPPERS: Record<string, ReadonlySet<string>> = {
  sudo: new Set(['u', 'g', 'h', 'p', 'C', 'r', 't', 'T', 'U']),
  env: new Set(['u', 'C', 'S']),
  nice: new Set(['n']),
  command: new Set([]),
  exec: new Set(['a']),
  nohup: new Set([]),
  stdbuf: new Set(['i', 'o', 'e']),
  setsid: new Set([]),
  time: new Set(['o', 'f']),
  xargs: new Set([]),
}

// The command word is the first token that is not a shell preamble: a known
// wrapper (with its options consumed), or a `VAR=val` assignment. This is what
// makes `FOO=bar npm install` and `env -i npm install` / `sudo -u nobody pnpm
// add` resolve to the real manager instead of evading the guard.
function leadingCommandWord(words: string[]): string | undefined {
  let i = 0
  while (i < words.length) {
    const word = words[i]
    if (word === undefined) break
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      i++
      continue
    }
    const argTakingShortOpts = PREAMBLE_WRAPPERS[word]
    if (argTakingShortOpts !== undefined) {
      i = skipWrapperOptions(words, i + 1, argTakingShortOpts)
      continue
    }
    return word
  }
  return undefined
}

// From the token after a wrapper, skip its option tokens. A long `--opt` is one
// token. A short `-x` (or bundled `-xy`) consumes the next word only when its
// LAST letter is in `argTaking` (e.g. `-n 10`, `-u nobody`). `VAR=val` between a
// wrapper and its command (as `env` allows) is also skipped. Stops at the first
// non-option, non-assignment token — that is the wrapped command word.
function skipWrapperOptions(words: string[], start: number, argTaking: ReadonlySet<string>): number {
  let i = start
  while (i < words.length) {
    const word = words[i]
    if (word === undefined) break
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      i++
      continue
    }
    if (word.startsWith('--')) {
      i++
      continue
    }
    if (word.startsWith('-') && word.length > 1) {
      const lastLetter = word[word.length - 1]
      i++
      if (lastLetter !== undefined && argTaking.has(lastLetter) && i < words.length) i++
      continue
    }
    break
  }
  return i
}

function globalInstallLabel(manager: string, words: string[]): string | undefined {
  if (manager === 'yarn') {
    // Real syntax is `yarn global add <pkg>` — `global` immediately followed by
    // `add` as a consecutive sequence. Checking for both tokens anywhere would
    // false-positive on `yarn add global foo` (a local install of a package
    // literally named `global`), which is not a global install at all.
    return hasAdjacentSequence(words, 'global', 'add') ? 'yarn global add' : undefined
  }
  const hasInstall = words.some((w) => INSTALL_SUBCOMMANDS.has(w))
  const hasGlobal = words.some(isGlobalFlag)
  if (!hasInstall || !hasGlobal) return undefined
  return manager === 'bun' ? 'bun global install (-g / --global)' : 'npm/pnpm global install (-g / --global)'
}

function hasAdjacentSequence(words: string[], first: string, second: string): boolean {
  for (let i = 0; i + 1 < words.length; i++) {
    if (words[i] === first && words[i + 1] === second) return true
  }
  return false
}

// `-g` / `--global`, including bundled short flags like `-gD` / `-Dg`. An
// explicit falsy value (`--global=false|0|no|off`) is NOT a global install —
// it disables the flag — so it must not match.
function isGlobalFlag(word: string): boolean {
  if (/^--global=(?:false|0|no|off)$/i.test(word)) return false
  if (/^--global(?:=|$)/.test(word)) return true
  return /^-[A-Za-z]*g[A-Za-z]*$/.test(word)
}

function blockGlobalInstall(label: string): Exclude<InternalGuardResult, undefined> {
  return {
    kind: 'acknowledgement-required',
    reason: [
      `Guard \`${GUARD_GLOBAL_INSTALL}\` blocked a global install: ${label}.`,
      'Global installs live outside the bind-mounted /agent folder and are wiped on every container restart, so they never persist.',
      'Use `bun add <pkg>` to add a dependency that survives restarts (it writes package.json), or `bunx <pkg>` to run a tool once without installing.',
      `Retry with \`acknowledgeGuards.bun-hygiene.${GUARD_GLOBAL_INSTALL}: true\` only if a throwaway global install is genuinely what you want.`,
    ].join(' '),
  }
}

function blockNonBunManager(manager: string): Exclude<InternalGuardResult, undefined> {
  return {
    kind: 'acknowledgement-required',
    reason: [
      `Guard \`${GUARD_NON_BUN_PACKAGE_MANAGER}\` blocked \`${manager}\`. This container standardizes on bun for dependency management.`,
      'Use `bun install` / `bun add <pkg>` instead of npm/pnpm/yarn, and use `bunx <pkg>` for one-off tool execution.',
      `Retry with \`acknowledgeGuards.bun-hygiene.${GUARD_NON_BUN_PACKAGE_MANAGER}: true\` if this package manager is genuinely required (e.g. a project pinned to a different lockfile).`,
    ].join(' '),
  }
}

function blockNonBunRunner(runner: string): Exclude<InternalGuardResult, undefined> {
  return {
    kind: 'acknowledgement-required',
    reason: [
      `Guard \`${GUARD_NON_BUN_PACKAGE_RUNNER}\` blocked \`${runner}\`.`,
      'This container standardizes on bun for package execution: `bunx` is the Bun-native equivalent and the package runner the image actually ships. `npx`/`pnpx` are absent from the default image, and where a custom image supplies them they carry npm/pnpm semantics rather than bun ones.',
      'Use `bunx <pkg>` for one-off package binaries.',
      `Retry with \`acknowledgeGuards.bun-hygiene.${GUARD_NON_BUN_PACKAGE_RUNNER}: true\` only if this non-bun runner is genuinely required.`,
    ].join(' '),
  }
}
