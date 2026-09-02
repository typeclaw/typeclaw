export type SandboxMount =
  | { type: 'ro-bind'; source: string; dest: string }
  | { type: 'bind'; source: string; dest: string }
  | { type: 'tmpfs'; dest: string }
  | { type: 'dev'; dest: string }

export type SandboxNetwork = 'none' | 'inherit'

// 'proc-bind' (the runtime default): --ro-bind /proc /proc binds the container's
// ALREADY-REAL procfs straight into the sandbox — no `unshare --mount-proc`, no
// CAP_SYS_ADMIN. A JS package runner's child gets a real /proc/self/{fd,maps,exe}
// so allowed `bunx`/`bun run <pkg-bin>` calls stop aborting with Bun's ENOTDIR. The
// agent runtime's /proc/<agent>/environ (OPENAI_API_KEY, GH_TOKEN) is NOT
// leaked: build.ts always emits --unshare-user, so the sandboxed bash runs as
// mapped-root in a CHILD user namespace that is not an ancestor of the agent
// runtime's userns. The kernel's PTRACE_MODE_READ_FSCREDS check on
// /proc/<pid>/environ then fails (EACCES), and kill()/ptrace against those pids
// fail EPERM (no CAP_KILL in the parent userns) — both verified empirically on
// live OrbStack. The residual is non-secret metadata (other pids' cmdline/status
// are visible); accepted on the single-tenant boundary, since environ/mem/ptrace
// /signal — the API-key surface — stay blocked. Works on every host INCLUDING
// OrbStack (which denies `unshare --mount-proc` even with CAP_SYS_ADMIN), and is
// the default precisely because it needs no outer-container capability.
// 'real-proc' (opt-in, sandbox.realProc=true): mount a fresh procfs scoped to a
// NEW pid namespace via `unshare --pid --fork --mount --mount-proc`. Adds full
// PID isolation (the agent runtime's pids are absent from the namespace, not just
// unreadable) on top of the environ guard, but needs CAP_SYS_ADMIN (mount(2) of
// proc) — granted by start.ts only when realProc is set — and is rejected on
// OrbStack. Chosen only when the cap-mount probe confirms it actually works.
// 'tmpfs' (last-resort degraded fallback): empty /proc + a single /proc/self/exe
// symlink. Works on every host but gives no /proc/self/{fd,maps}, so a JS package
// runner's CHILD (the spawned bin) crashes with ENOTDIR reading /proc/self/fd —
// external packages can't run in the sandbox under this strategy. 'none': no
// /proc at all.
export type SandboxProcStrategy = 'tmpfs' | 'none' | 'real-proc' | 'proc-bind'

export type SandboxEnvPolicy = {
  set?: Record<string, string>
  passthrough?: string[]
  withhold?: string[]
  // Preserve these names from bwrap's parent environment without rendering
  // their values in argv. The builder switches from --clearenv to explicit
  // --unsetenv for every other inherited name. Reserved for command-scoped
  // secrets whose parent process is protected by the child-userns boundary.
  inherit?: string[]
}

export type SandboxCommandFilter = {
  allowPrefixes?: string[]
  rejectShellMetacharacters?: boolean
}

export type SandboxProcessPolicy = {
  newSession?: boolean
  dieWithParent?: boolean
}

// Role-derived deny-list overlaid on top of an already-visible tree. dirs are
// hidden with an empty tmpfs; files are hidden with --ro-bind-data, the only
// bwrap primitive that masks a single FILE (--tmpfs is dir-only). --ro-bind-data
// reads its empty content from a file descriptor, and the bash tool spawns with
// stdio ["ignore","pipe","pipe"] — no inherited extra fds — so the rendered
// commandString self-opens ONE fd PER masked file (counting up from
// FIRST_MASK_DATA_FD) via `<fd></dev/null` redirections appended after
// `bash -c <command>`. The fds cannot be shared: bwrap close()s each after
// copying it, so a reused fd aborts the entire invocation with EBADF and kills
// every sandboxed bash call. Masks MUST render after the broad parent
// mounts: bwrap applies mount ops in command-line order and the last op on a
// path wins, so a mask emitted before its parent bind would be re-exposed.
export type SandboxMaskPolicy = {
  dirs?: string[]
  files?: string[]
}

// Writable carve-outs re-exposed on top of a read-only project root AND its
// masks. Rendered last so "last op wins" makes these the only RW paths: an RW
// bind here overrides the broad --ro-bind parent, while anything not listed
// stays read-only (EROFS) or masked.
export type SandboxWritablePolicy = {
  dirs?: string[]
  files?: string[]
}

// Read-only re-protections carved back out of a writable parent. MUST render
// after `writable` so bwrap's last-op-wins keeps these EROFS despite the parent
// RW bind. Load-bearing: `.git` is writable so members can commit, but
// `.git/hooks` and `.git/config` stay RO here — otherwise a low-trust role
// plants a hook or sets core.hooksPath and gets code execution in the
// unsandboxed runtime git ops (backup/dreaming) that share the same .git.
export type SandboxProtectedPolicy = {
  dirs?: string[]
  files?: string[]
}

// Symlinks recreated INSIDE the jail so a CLI that reads a fixed path (e.g.
// `$HOME/.metabase-cli`) resolves to a writable target under /agent. `dest` is
// the symlink location resolved against the SANDBOX HOME (/tmp), `target` is the
// absolute /agent path it points at. Rendered last (after the /tmp bind and all
// writable binds) so last-op-wins keeps the symlink — a `/tmp/...` dest emitted
// before the /tmp bind would be erased by it.
export type SandboxSymlinkOp = {
  target: string
  dest: string
}

// A single RW bind that preserves ordinary agent-root writes for trusted/owner
// callers. Masks and protected zones overlay it; writableRoot provides no
// package-install isolation.
//
// CRITICAL ordering: unlike `writable` (rendered AFTER masks), `writableRoot`
// renders BEFORE masks so the broad RW root does not re-expose secrets. With
// last-op-wins the chain is: ro-bind root → writableRoot (RW root) → masks
// (re-hide .env/secrets.json/private dirs) → protected (.git/hooks/.git/config).
export type SandboxWritableRootPolicy = {
  dir: string
}

export type SandboxPolicy = {
  bwrapPath?: string
  cwd?: string
  // Concrete host interpreter ELF (the running bun binary) re-exposed at
  // /proc/self/exe over the --tmpfs /proc mask. JS runtimes self-locate via
  // /proc/self/exe; under the empty tmpfs /proc that read fails and bunx panics
  // in createFakeTemporaryNodeExecutable. A direct --ro-bind of /proc/self/exe
  // is wrong: at bwrap setup time /proc/self is bwrap's pid, so it captures the
  // bwrap binary, not the child runtime. The caller resolves this path (I/O);
  // the builder stays pure.
  procSelfExe?: string
  mounts?: SandboxMount[]
  writableRoot?: SandboxWritableRootPolicy
  masks?: SandboxMaskPolicy
  writable?: SandboxWritablePolicy
  protected?: SandboxProtectedPolicy
  symlinks?: SandboxSymlinkOp[]
  network?: SandboxNetwork
  env?: SandboxEnvPolicy
  commandFilter?: SandboxCommandFilter
  process?: SandboxProcessPolicy
  proc?: SandboxProcStrategy
}

// The env the sandbox always re-introduces after `--clearenv`. Anything not
// listed here (or explicitly named in `env.set` / `env.passthrough` by the
// consumer — including operator `.env` vars re-introduced via inherit) is
// invisible inside the sandbox. This is the load-bearing leak guard: the
// container env holds credentials the operator never declared in `.env` (e.g.
// OPENAI_API_KEY, host-injected TYPECLAW_* tokens), and env inheritance is the
// single highest-risk exfil path for prompt-injected bash.
// HOME points at /tmp because the sandbox mounts /tmp as a fresh tmpfs.
//
// BUN_TMPDIR / BUN_INSTALL both point under /tmp because `--clearenv` strips
// the host's TMPDIR, and bun refuses to run without a writable scratch dir it
// can discover: `bunx` and `bun run <pkg-bin>` abort with
// "Unexpected accessing temporary directory. Please set $BUN_TMPDIR or
// $BUN_INSTALL". /tmp is always writable inside the sandbox (fresh tmpfs, or
// the per-session bind that overrides it), so both are safe targets. Without
// these, every sandboxed bun invocation — the core subagent install path —
// fails before it starts.
export const DEFAULT_SANDBOX_ENV: Record<string, string> = {
  PATH: '/tmp/typeclaw-dependency-bin:/usr/local/bin:/usr/bin:/bin',
  HOME: '/tmp',
  LANG: 'C.UTF-8',
  BUN_TMPDIR: '/tmp',
  BUN_INSTALL: '/tmp/.bun',
}
