import type { SessionOrigin } from './session-origin'
import type { SandboxOptions, SubagentShared } from './subagents'

// Per-bash-call bubblewrap sandbox. Invoked by the bash-tool wrapper for
// subagents that declare `sandbox` on their `SubagentShared`. See
// docs/internals/sandbox.mdx for the rationale and the kernel-level details
// (why --tmpfs /proc instead of --proc /proc on OrbStack, why --clearenv,
// why bwrap rather than nested containers).

// Forbidden shell metacharacters. The allowlist check runs on the raw
// command BEFORE bwrap is invoked, so syntactic injection like
// `echo "$(rm -rf /)"` or `git log; curl evil.com` is rejected with a clear
// error the model can read and self-correct from. Without this gate, prefix
// matching on argv[0] is bypassable by command substitution and pipelines.
// Newline is included because bash treats newline as a command separator
// just like `;`.
const FORBIDDEN_METACHARS = /[;&|`$()<>\\\n]/

export class SandboxBlockedError extends Error {
  override readonly name = 'SandboxBlockedError'
  constructor(reason: string) {
    super(`sandboxed bash blocked: ${reason}`)
  }
}

export class SandboxUnavailableError extends Error {
  override readonly name = 'SandboxUnavailableError'
  constructor() {
    super(
      'sandboxed bash blocked: bwrap binary not found on PATH (this subagent declares sandbox; refusing to fall through to unsandboxed execution)',
    )
  }
}

export type ApplySandboxOptions = {
  tool: string
  args: Record<string, unknown>
  origin: SessionOrigin | undefined
  getSubagentByName: (name: string) => SubagentShared | undefined
}

// Rewrites args.command in place when the calling subagent declares a
// sandbox. No-op for non-bash tools, non-subagent origins, and resolved
// subagents that intentionally have no sandbox config. Throws
// SandboxBlockedError on allowlist or metachar rejection, on an unresolvable
// subagent name (fail-closed — see below), and on a non-string command.
// Throws SandboxUnavailableError if bwrap is missing (also fail-closed).
//
// The unresolvable-subagent path is deliberate. If `origin.kind === 'subagent'`
// but the registry lookup returns undefined, sandbox enforcement would
// otherwise depend on wiring being perfect — a typo, a registry-rebuild
// race during plugin reload, or a missing entry would silently bypass the
// sandbox for a subagent that should be running inside one. We fail closed
// instead: callers see a clear block, the model retries or escalates, and
// silent escape is impossible.
export async function applySubagentSandbox(opts: ApplySandboxOptions): Promise<void> {
  if (opts.tool !== 'bash') return
  if (opts.origin?.kind !== 'subagent') return
  const subagent = opts.getSubagentByName(opts.origin.subagent)
  if (subagent === undefined) {
    throw new SandboxBlockedError(
      `subagent "${opts.origin.subagent}" is not in the registry; refusing to execute bash for an unresolvable subagent origin`,
    )
  }
  if (!subagent.sandbox) return

  const cfg: SandboxOptions = subagent.sandbox === true ? {} : subagent.sandbox
  const command = opts.args.command
  if (typeof command !== 'string') {
    throw new SandboxBlockedError('command argument must be a string')
  }

  if (cfg.allowlist !== undefined) {
    checkAllowlist(command, cfg.allowlist)
  } else if (FORBIDDEN_METACHARS.test(command)) {
    // No allowlist declared, but sandbox is on. Still reject metachars so
    // `echo "$(rm -rf)"`-style injections inside the sandbox can't widen
    // their reach via shell features. The bwrap rootfs view contains it,
    // but the model also shouldn't be allowed to articulate the attempt.
    throw new SandboxBlockedError(
      'command contains forbidden shell metacharacter. Use a simple command without ; & | ` $ ( ) < > \\ or newlines.',
    )
  }

  await ensureBwrapAvailable()

  opts.args.command = buildBwrapCommand(command, cfg)
}

function checkAllowlist(command: string, allowlist: string[]): void {
  if (FORBIDDEN_METACHARS.test(command)) {
    throw new SandboxBlockedError(
      'command contains forbidden shell metacharacter. Use a simple command without ; & | ` $ ( ) < > \\ or newlines.',
    )
  }
  const normalized = command.trim().replace(/\s+/g, ' ')
  const matched = allowlist.some((p) => normalized === p || normalized.startsWith(`${p} `))
  if (!matched) {
    throw new SandboxBlockedError(`command does not match any allowlist prefix. Allowed: ${allowlist.join(', ')}`)
  }
}

function buildBwrapCommand(originalCommand: string, cfg: SandboxOptions): string {
  // The mount layout matches the OrbStack-compatible profile validated in
  // docs/internals/sandbox.mdx. The two non-obvious choices:
  //   --tmpfs /proc  : avoids the /proc/N/environ leak that
  //                    --dev-bind /proc /proc exposes (where the sandbox
  //                    can read the outer container's FIREWORKS_API_KEY
  //                    via cross-namespace /proc reads). Costs ps/top
  //                    inside the sandbox, which read-only subagents do
  //                    not use.
  //   --clearenv     : strips ALL env including FIREWORKS_API_KEY. Vars
  //                    must be re-introduced via --setenv on a name-by-name
  //                    basis (PATH/HOME/LANG are always re-added; the
  //                    subagent declares any others via envPassthrough).
  const args: string[] = [
    'bwrap',
    '--unshare-all',
    '--symlink',
    'usr/bin',
    '/bin',
    '--symlink',
    'usr/lib',
    '/lib',
    '--ro-bind',
    '/usr',
    '/usr',
    '--ro-bind',
    '/etc',
    '/etc',
    '--ro-bind',
    '/usr/local',
    '/usr/local',
    '--dev',
    '/dev',
    '--tmpfs',
    '/proc',
    '--tmpfs',
    '/tmp',
    '--clearenv',
    '--setenv',
    'PATH',
    '/usr/local/bin:/usr/bin:/bin',
    '--setenv',
    'HOME',
    '/tmp',
    '--setenv',
    'LANG',
    'C.UTF-8',
  ]
  if (cfg.network === 'inherit') {
    // --unshare-all already unshares the network namespace; --share-net
    // undoes that single share so the sandbox joins the outer container's
    // net namespace. We don't drop --unshare-all because we still want the
    // other namespaces (user, pid, mount, ipc, uts, cgroup) unshared.
    args.push('--share-net')
  }
  for (const m of cfg.mounts ?? []) {
    args.push(m.mode === 'ro' ? '--ro-bind' : '--bind', m.src, m.dst)
  }
  for (const k of cfg.envPassthrough ?? []) {
    const v = process.env[k]
    if (v !== undefined) args.push('--setenv', k, v)
  }
  if (cfg.cwd !== undefined) {
    args.push('--chdir', cfg.cwd)
  }
  // bwrap takes the user command verbatim via `bash -c`. The security
  // guards (secret-exfil-bash, git-exfil) already ran on the original
  // command BEFORE this rewrite, so their pattern-matching is unaffected.
  args.push('bash', '-c', originalCommand)
  return args.map(shellQuote).join(' ')
}

// Local copy of the shellQuote in src/update/index.ts. Inlined rather than
// extracted to src/shared/ to keep this PR a single behavior change; if a
// third call site appears it should be promoted to src/shared/shell.ts.
function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(arg)) return arg
  return `'${arg.replaceAll("'", "'\\''")}'`
}

// Cached bwrap availability check. The check is cheap (synchronous
// existsSync against /usr/bin/bwrap and /usr/local/bin/bwrap), but doing it
// every bash call is still wasteful — the binary cannot disappear and then
// reappear during a single process lifetime.
let bwrapAvailableCache: boolean | null = null

export async function ensureBwrapAvailable(): Promise<void> {
  if (bwrapAvailableCache === true) return
  if (bwrapAvailableCache === false) throw new SandboxUnavailableError()
  // Bun.spawn throws synchronously with ENOENT when the binary isn't on
  // PATH, rather than returning a non-zero exit code — so the
  // "not installed" case raises here, not via proc.exitCode.
  try {
    const proc = Bun.spawn(['bwrap', '--version'], { stdout: 'ignore', stderr: 'ignore' })
    await proc.exited
    bwrapAvailableCache = proc.exitCode === 0
  } catch {
    bwrapAvailableCache = false
  }
  if (!bwrapAvailableCache) throw new SandboxUnavailableError()
}

// Test-only hook so the unit test suite can force re-detection between
// tests. NOT exported through any index/barrel; importable only with an
// explicit path-import. Tested code paths never call this.
export function _resetBwrapCacheForTests(): void {
  bwrapAvailableCache = null
}
