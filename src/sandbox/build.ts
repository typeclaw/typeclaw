import { posix } from 'node:path'

import { SandboxPolicyError } from './errors'
import {
  DEFAULT_SANDBOX_ENV,
  type SandboxCommandFilter,
  type SandboxEnvPolicy,
  type SandboxMount,
  type SandboxPolicy,
} from './policy'
import { formatCommand } from './quote'

const { dirname } = posix

export type SandboxedCommand = {
  argv: string[]
  commandString: string
  // Exact environment the bwrap PARENT process must run with. bwrap only drops
  // --clearenv when there are inherited names and then --unsetenv's the keys
  // present in process.env AT BUILD TIME — a secret added to the live env between
  // build and spawn would otherwise be inherited. The spawn must therefore start
  // from THIS snapshot (defaults + resolved set + snapshotted inherited values),
  // never the live process.env, so late-added keys can't reach the sandbox.
  spawnEnv: Record<string, string>
}

// Fixed fd the rendered commandString opens to /dev/null for --ro-bind-data
// file masks. 3 is the first fd above stdio; the bash tool's spawn does not
// inherit it, so the redirect is part of the command string itself.
const MASK_DATA_FD = 3

// Pure: no I/O, no bwrap availability probe (that is `ensureBwrapAvailable`'s
// job). Given a bash command and a policy, returns the bwrap-wrapped argv plus
// a shell-quoted rendering of it. Knows nothing about subagents, origins, or
// the agent runtime — a consumer resolves a policy from whatever context it
// has and calls this. Throws SandboxPolicyError only when the consumer opted
// into the command-filter knobs and the command violates them.
export function buildSandboxedCommand(command: string, policy: SandboxPolicy = {}): SandboxedCommand {
  if (policy.commandFilter !== undefined) {
    applyCommandFilter(command, policy.commandFilter)
  }
  const argv = buildArgv(command, policy)
  const needsMaskFd = (policy.masks?.files?.length ?? 0) > 0
  const commandString = needsMaskFd ? `${formatCommand(argv)} ${MASK_DATA_FD}</dev/null` : formatCommand(argv)
  return { argv, commandString, spawnEnv: resolveSpawnEnv(policy.env) }
}

function buildArgv(command: string, policy: SandboxPolicy): string[] {
  const bwrap = policy.bwrapPath ?? 'bwrap'
  const procStrategy = policy.proc ?? 'tmpfs'
  const realProc = procStrategy === 'real-proc'
  const procBind = procStrategy === 'proc-bind'

  // 'real-proc' splits PID-namespace ownership from bwrap. `unshare --pid
  // --fork --mount --mount-proc` (util-linux, baseline) creates the new PID +
  // mount namespaces as REAL root and mounts a fresh procfs scoped to that PID
  // namespace — which OrbStack permits only with CAP_SYS_ADMIN and NOT from
  // bwrap's user namespace (bwrap's --proc is blocked there). bwrap then runs
  // INSIDE that namespace and must NOT re-unshare pid (it would create a second
  // PID ns with no matching procfs and reintroduce the ENOTDIR crash), so we
  // unshare each namespace EXCEPT pid explicitly instead of --unshare-all. The
  // freshly mounted /proc contains only the sandbox subtree, so --ro-bind /proc
  // (below) binds that scoped procfs, never the agent runtime's /proc/N/environ.
  const argv: string[] = realProc
    ? ['unshare', '--pid', '--fork', '--mount', '--mount-proc', '--', bwrap]
    : [bwrap, '--unshare-all']
  if (realProc) {
    argv.push('--unshare-user', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup')
  }

  if (policy.network !== 'inherit') {
    // Default ('none' / undefined) isolates the net namespace — prompt-injected
    // bash cannot exfiltrate over the network unless the consumer opts in.
    // --unshare-all already covers this in the non-real-proc path; under
    // real-proc the explicit unshares above omit net, so add it here.
    if (realProc) argv.push('--unshare-net')
  } else if (!realProc) {
    // --unshare-all unshared the net namespace; --share-net rejoins the outer
    // container's network. Under real-proc we simply never add --unshare-net.
    argv.push('--share-net')
  }

  const proc = policy.process ?? {}
  if (proc.newSession !== false) {
    // Drops the controlling terminal so the contained process cannot push
    // input back into the agent's tty via TIOCSTI. Mandated by
    // docs/internals/sandbox.mdx. Harmless for a one-shot `bash -c`.
    argv.push('--new-session')
  }
  if (proc.dieWithParent !== false) {
    argv.push('--die-with-parent')
  }

  const inheritedNames = new Set(policy.env?.inherit ?? [])
  if (inheritedNames.size === 0) {
    argv.push('--clearenv')
  } else {
    const retained = new Set([
      ...inheritedNames,
      ...Object.keys(DEFAULT_SANDBOX_ENV),
      ...Object.keys(policy.env?.set ?? {}),
    ])
    for (const key of Object.keys(process.env).sort()) {
      if (!retained.has(key)) argv.push('--unsetenv', key)
    }
  }
  for (const [key, value] of Object.entries(resolveEnv(policy.env))) {
    if (inheritedNames.has(key)) continue
    argv.push('--setenv', key, value)
  }

  argv.push('--ro-bind', '/usr', '/usr', '--ro-bind', '/etc', '/etc', '--dev', '/dev', '--tmpfs', '/tmp')

  // Recreate the usr-merge root symlinks that --ro-bind /usr does NOT bring
  // along. On the Debian base (oven/bun:1-slim) /bin /sbin /lib /lib64 are
  // root-level symlinks into /usr; binding /usr exposes /usr/bin etc. but the
  // root entries themselves are absent in the sandbox. That breaks every
  // ABSOLUTE-path reference the kernel resolves WITHOUT consulting PATH:
  //   - ELF interpreter (the dynamic loader) baked into PT_INTERP:
  //     /lib/ld-linux-aarch64.so.1 (arm64) or /lib64/ld-linux-x86-64.so.2
  //     (amd64). Missing it makes bwrap report "execvp bash: No such file or
  //     directory" — the missing file is the loader, not bash.
  //   - shebang lines: /bin/sh and /bin/bash are the most common interpreters
  //     on earth; a script with "#!/bin/sh" fails "cannot execute: required
  //     file not found" without /bin, even though /usr/bin/sh exists, because
  //     the shebang path is literal and skips PATH.
  // --ro-bind-try, not --ro-bind: the set is arch- and base-dependent (arm64
  // oven/bun:1-slim ships /lib but no /lib64), and a hard bind of an absent
  // source aborts bwrap. -try binds each only when present, keeping this
  // builder pure (no host filesystem probe) and correct across arches/bases.
  argv.push(
    '--ro-bind-try',
    '/bin',
    '/bin',
    '--ro-bind-try',
    '/sbin',
    '/sbin',
    '--ro-bind-try',
    '/lib',
    '/lib',
    '--ro-bind-try',
    '/lib64',
    '/lib64',
  )

  if (realProc || procBind) {
    // --ro-bind /proc /proc gives the child a real /proc/self/{fd,maps,exe} so a
    // JS package runner's spawned bin stops aborting with Bun's ENOTDIR. The two
    // strategies differ only in WHICH procfs is bound:
    //   real-proc: the outer `unshare --mount-proc` already mounted a fresh
    //     procfs scoped to the new PID namespace, so this binds THAT — the agent
    //     runtime's pids are absent from the namespace entirely (full PID
    //     isolation), at the cost of CAP_SYS_ADMIN for the mount.
    //   proc-bind: no unshare/mount, so this binds the container's ALREADY-REAL
    //     procfs. The agent runtime's pids ARE present, but --unshare-all put
    //     this bash in a CHILD user namespace, so the kernel's
    //     PTRACE_MODE_READ_FSCREDS check blocks /proc/<agent>/environ (EACCES)
    //     and kill()/ptrace against them fail EPERM (no CAP_KILL in the parent
    //     userns). Only non-secret metadata (cmdline/status) stays visible.
    // No /proc/self/exe symlink is needed in either case: a real /proc/self/exe
    // resolves correctly.
    argv.push('--ro-bind', '/proc', '/proc')
  } else if (procStrategy === 'tmpfs') {
    // --tmpfs /proc, never --proc /proc (OrbStack's kernel blocks
    // mount("proc",...) from user namespaces) and never --dev-bind /proc /proc
    // (leaks the outer container's /proc/N/environ — including
    // OPENAI_API_KEY — into the sandbox). See sandbox.mdx.
    argv.push('--tmpfs', '/proc')

    // Re-expose ONLY the bun ELF at /proc/self/exe so sandboxed package runners
    // can self-locate; /proc/N/environ stays masked by the tmpfs above. The
    // caller passes bun's path (see resolveProcSelfExe): in this bun-centric
    // container bunx/npx/pnpx all resolve to bun, so bun IS the runtime reading
    // /proc/self/exe. --symlink (not --ro-bind /proc/self/exe): /proc/self at
    // setup time is bwrap's pid, so a bind would capture bwrap's own binary.
    // Must come AFTER --tmpfs /proc (last-op-wins) or the tmpfs erases it.
    // This restores only the runner's SELF-location; a spawned child still
    // reads /proc/self/fd + /proc/self/maps, which the empty tmpfs lacks, so
    // external-package execution requires the 'real-proc' strategy above.
    if (policy.procSelfExe !== undefined) {
      argv.push('--ro-bind', policy.procSelfExe, policy.procSelfExe)
      argv.push('--symlink', policy.procSelfExe, '/proc/self/exe')
    }
  }

  for (const mount of policy.mounts ?? []) {
    appendMount(argv, mount)
  }

  appendWritableRoot(argv, policy)
  appendWritable(argv, policy)
  appendMasks(argv, policy)
  appendProtected(argv, policy)
  appendSymlinks(argv, policy)

  if (policy.cwd !== undefined) {
    argv.push('--chdir', policy.cwd)
  }

  argv.push('bash', '-c', command)
  return argv
}

// Renders BEFORE appendMasks so the broad RW root is overridden by the secret
// masks and protected re-binds that follow (last-op-wins). See
// SandboxWritableRootPolicy for the full ordering contract.
function appendWritableRoot(argv: string[], policy: SandboxPolicy): void {
  if (policy.writableRoot !== undefined) {
    argv.push('--bind', policy.writableRoot.dir, policy.writableRoot.dir)
  }
}

function appendMasks(argv: string[], policy: SandboxPolicy): void {
  for (const dir of policy.masks?.dirs ?? []) {
    argv.push('--tmpfs', dir)
  }
  for (const file of policy.masks?.files ?? []) {
    argv.push('--ro-bind-data', String(MASK_DATA_FD), file)
  }
}

function appendWritable(argv: string[], policy: SandboxPolicy): void {
  for (const dir of policy.writable?.dirs ?? []) {
    argv.push('--bind', dir, dir)
  }
  for (const file of policy.writable?.files ?? []) {
    argv.push('--bind', file, file)
  }
}

function appendProtected(argv: string[], policy: SandboxPolicy): void {
  for (const dir of policy.protected?.dirs ?? []) {
    argv.push('--ro-bind', dir, dir)
  }
  for (const file of policy.protected?.files ?? []) {
    argv.push('--ro-bind', file, file)
  }
}

// Rendered after every bind (incl. the /tmp session bind in policy.mounts) so
// last-op-wins keeps the symlink: a `/tmp/.foo` dest emitted before the /tmp
// bind would be erased by it. `--dir` ensures the symlink's parent exists inside
// the jail (the sandbox HOME dir may not be present after --clearenv tmpfs
// scaffolding); `--symlink TARGET DEST` then creates `dest -> target`.
function appendSymlinks(argv: string[], policy: SandboxPolicy): void {
  for (const link of policy.symlinks ?? []) {
    argv.push('--dir', dirname(link.dest))
    argv.push('--symlink', link.target, link.dest)
  }
}

function appendMount(argv: string[], mount: SandboxMount): void {
  switch (mount.type) {
    case 'ro-bind':
      argv.push('--ro-bind', mount.source, mount.dest)
      return
    case 'bind':
      argv.push('--bind', mount.source, mount.dest)
      return
    case 'tmpfs':
      argv.push('--tmpfs', mount.dest)
      return
    case 'dev':
      argv.push('--dev', mount.dest)
      return
  }
}

function resolveEnv(env: SandboxEnvPolicy | undefined): Record<string, string> {
  const resolved: Record<string, string> = { ...DEFAULT_SANDBOX_ENV, ...env?.set }
  for (const key of env?.passthrough ?? []) {
    const value = process.env[key]
    if (value !== undefined) resolved[key] = value
  }
  return resolved
}

// The exact env for the bwrap parent process: the --setenv/passthrough values
// PLUS a one-shot snapshot of each inherited name's current value. Because the
// parent starts from exactly this map (and nothing else), a key added to the
// live process.env after this point cannot be inherited — closing the
// build-to-spawn TOCTOU on the --unsetenv enumeration.
function resolveSpawnEnv(env: SandboxEnvPolicy | undefined): Record<string, string> {
  const resolved = resolveEnv(env)
  for (const name of env?.inherit ?? []) {
    const value = process.env[name]
    if (value !== undefined) resolved[name] = value
  }
  return resolved
}

// Token-boundary match: the normalized command must equal a prefix exactly or
// start with `prefix + ' '`. Substring matching would let `git-evil ...` slip
// past a `git` prefix; this does not.
const ALLOWLIST_WHITESPACE = /\s+/g
const FORBIDDEN_METACHARS = /[;&|`$()<>\\\n]/

function applyCommandFilter(command: string, filter: SandboxCommandFilter): void {
  if (filter.rejectShellMetacharacters === true && FORBIDDEN_METACHARS.test(command)) {
    throw new SandboxPolicyError(
      'command contains a forbidden shell metacharacter. This policy only permits simple commands without ; & | ` $ ( ) < > \\ or newlines.',
    )
  }
  if (filter.allowPrefixes !== undefined) {
    const normalized = command.trim().replace(ALLOWLIST_WHITESPACE, ' ')
    const matched = filter.allowPrefixes.some((p) => normalized === p || normalized.startsWith(`${p} `))
    if (!matched) {
      throw new SandboxPolicyError(
        `command does not match any allowed prefix. Allowed: ${filter.allowPrefixes.join(', ')}`,
      )
    }
  }
}
