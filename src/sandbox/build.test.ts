import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

import { buildSandboxedCommand } from './build'
import { SandboxPolicyError } from './errors'
import type { SandboxPolicy } from './policy'

function argvOf(command: string, policy?: SandboxPolicy): string[] {
  return buildSandboxedCommand(command, policy).argv
}

// Returns the value bwrap would receive for a `--flag value`-style option,
// i.e. the token immediately after the first occurrence of `flag`.
function valueAfter(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i === -1 ? undefined : argv[i + 1]
}

describe('buildSandboxedCommand base argv', () => {
  test('wraps the command in bwrap and ends with bash -c <command>', () => {
    const argv = argvOf('git status')
    expect(argv[0]).toBe('bwrap')
    expect(argv.slice(-3)).toEqual(['bash', '-c', 'git status'])
  })

  test('passes the original command verbatim, even with shell operators', () => {
    const argv = argvOf('git log | head -5 && echo done')
    expect(argv.slice(-3)).toEqual(['bash', '-c', 'git log | head -5 && echo done'])
  })

  test('unshares all namespaces and clears the environment by default', () => {
    const argv = argvOf('true')
    expect(argv).toContain('--unshare-all')
    expect(argv).toContain('--clearenv')
  })

  test('mounts a strict read-only rootfs view', () => {
    const argv = argvOf('true')
    expect(argv.join(' ')).toContain('--ro-bind /usr /usr')
    expect(argv.join(' ')).toContain('--ro-bind /etc /etc')
    expect(argv).toContain('--dev')
    expect(argv).toContain('--tmpfs')
  })

  test('binds the usr-merge root symlinks with --ro-bind-try so loaders and shebangs resolve on both arches', () => {
    const joined = argvOf('true').join(' ')
    // loaders: ELF PT_INTERP paths (/lib/ld-*, /lib64/ld-*) the kernel resolves without PATH
    expect(joined).toContain('--ro-bind-try /lib /lib')
    expect(joined).toContain('--ro-bind-try /lib64 /lib64')
    // shebangs: literal #!/bin/sh and #!/bin/bash interpreter paths that skip PATH
    expect(joined).toContain('--ro-bind-try /bin /bin')
    expect(joined).toContain('--ro-bind-try /sbin /sbin')
  })

  test('uses --tmpfs /proc and never --proc or --dev-bind for /proc', () => {
    const argv = argvOf('true')
    const joined = argv.join(' ')
    expect(joined).toContain('--tmpfs /proc')
    expect(joined).not.toContain('--proc /proc')
    expect(joined).not.toContain('--dev-bind /proc')
  })

  test('honours a custom bwrap path', () => {
    const argv = argvOf('true', { bwrapPath: '/usr/local/bin/bwrap' })
    expect(argv[0]).toBe('/usr/local/bin/bwrap')
  })
})

describe('buildSandboxedCommand process hardening', () => {
  test('adds --new-session and --die-with-parent by default', () => {
    const argv = argvOf('true')
    expect(argv).toContain('--new-session')
    expect(argv).toContain('--die-with-parent')
  })

  test('omits --new-session when explicitly disabled', () => {
    const argv = argvOf('true', { process: { newSession: false } })
    expect(argv).not.toContain('--new-session')
    expect(argv).toContain('--die-with-parent')
  })

  test('omits --die-with-parent when explicitly disabled', () => {
    const argv = argvOf('true', { process: { dieWithParent: false } })
    expect(argv).not.toContain('--die-with-parent')
    expect(argv).toContain('--new-session')
  })
})

describe('buildSandboxedCommand network policy', () => {
  test('isolates the network by default', () => {
    expect(argvOf('true')).not.toContain('--share-net')
  })

  test("isolates the network for network: 'none'", () => {
    expect(argvOf('true', { network: 'none' })).not.toContain('--share-net')
  })

  test("rejoins the outer network for network: 'inherit'", () => {
    expect(argvOf('true', { network: 'inherit' })).toContain('--share-net')
  })
})

describe('buildSandboxedCommand env policy', () => {
  test('re-introduces only the default allowlist after --clearenv', () => {
    const argv = argvOf('true')
    expect(valueAfter(argv, '--setenv')).toBe('PATH')
    const setenvKeys = argv.filter((_, i) => argv[i - 1] === '--setenv')
    expect(setenvKeys).toEqual(['PATH', 'HOME', 'LANG', 'BUN_TMPDIR', 'BUN_INSTALL'])
  })

  test('gives bun a writable temp/install dir under /tmp so bunx does not abort', () => {
    const joined = argvOf('true').join(' ')
    expect(joined).toContain('--setenv BUN_TMPDIR /tmp')
    expect(joined).toContain('--setenv BUN_INSTALL /tmp/.bun')
  })

  test('applies explicit env.set entries', () => {
    const argv = argvOf('true', { env: { set: { GIT_PAGER: 'cat' } } })
    const joined = argv.join(' ')
    expect(joined).toContain('--setenv GIT_PAGER cat')
  })

  test('passthrough copies only named vars that are present in process.env', () => {
    const present = 'TYPECLAW_SANDBOX_TEST_PRESENT'
    const absent = 'TYPECLAW_SANDBOX_TEST_ABSENT'
    process.env[present] = 'yes'
    delete process.env[absent]
    try {
      const argv = argvOf('true', { env: { passthrough: [present, absent] } })
      const setenvKeys = argv.filter((_, i) => argv[i - 1] === '--setenv')
      expect(setenvKeys).toContain(present)
      expect(setenvKeys).not.toContain(absent)
    } finally {
      delete process.env[present]
    }
  })

  test('does not leak arbitrary host env into the sandbox', () => {
    process.env.TYPECLAW_SANDBOX_SECRET = 'leak-me'
    try {
      const argv = argvOf('true')
      expect(argv).not.toContain('leak-me')
    } finally {
      delete process.env.TYPECLAW_SANDBOX_SECRET
    }
  })

  test('preserves an approved env name without placing its value in bwrap argv', () => {
    const name = 'TYPECLAW_SANDBOX_INHERITED_SECRET'
    const value = 'secret-value-that-must-not-enter-cmdline'
    process.env[name] = value
    try {
      const argv = argvOf('true', { env: { inherit: [name] } })
      expect(argv).not.toContain('--clearenv')
      expect(argv).not.toContain(value)
      expect(argv).not.toEqual(expect.arrayContaining(['--setenv', name, value]))
      expect(argv).not.toEqual(expect.arrayContaining(['--unsetenv', name]))
    } finally {
      delete process.env[name]
    }
  })

  test('keeps an inherited secret out of /proc cmdline while the child receives it', async () => {
    if (process.platform !== 'linux') return
    const name = 'TYPECLAW_SANDBOX_PROC_SECRET'
    const value = 'proc-secret-value'
    process.env[name] = value
    try {
      const argv = argvOf('true', { env: { inherit: [name] } })
      const child = Bun.spawn(
        [
          process.execPath,
          '-e',
          `process.stdout.write(process.env.${name} ?? ''); setTimeout(() => {}, 250)`,
          '--',
          ...argv,
        ],
        { env: process.env, stdout: 'pipe', stderr: 'pipe' },
      )
      const cmdline = await readFile(`/proc/${child.pid}/cmdline`, 'utf8')
      expect(cmdline).not.toContain(value)
      expect(await new Response(child.stdout).text()).toBe(value)
      expect(await child.exited).toBe(0)
    } finally {
      delete process.env[name]
    }
  })
})

describe('buildSandboxedCommand spawnEnv (bwrap parent env snapshot)', () => {
  test('snapshots inherited values so a late-added secret cannot be inherited', () => {
    const name = 'TYPECLAW_SANDBOX_SPAWN_INHERIT'
    const late = 'GH_TOKEN'
    process.env[name] = 'inherited-value'
    delete process.env[late]
    try {
      const { spawnEnv } = buildSandboxedCommand('true', { env: { inherit: [name] } })
      // late secret added AFTER the build must not appear in the frozen snapshot
      process.env[late] = 'late-secret'
      expect(spawnEnv[name]).toBe('inherited-value')
      expect(spawnEnv[late]).toBeUndefined()
      expect(Object.keys(spawnEnv)).not.toContain(late)
    } finally {
      delete process.env[name]
      delete process.env[late]
    }
  })

  test('spawnEnv contains only defaults + set + inherited names', () => {
    const { spawnEnv } = buildSandboxedCommand('true', { env: { set: { GIT_PAGER: 'cat' } } })
    expect(spawnEnv.PATH).toBe('/usr/local/bin:/usr/bin:/bin')
    expect(spawnEnv.GIT_PAGER).toBe('cat')
  })
})

describe('buildSandboxedCommand mounts', () => {
  test('renders ro-bind, bind, tmpfs and dev mounts', () => {
    const argv = argvOf('true', {
      mounts: [
        { type: 'ro-bind', source: '/agent/.git', dest: '/work/.git' },
        { type: 'bind', source: '/agent/out', dest: '/work/out' },
        { type: 'tmpfs', dest: '/scratch' },
        { type: 'dev', dest: '/dev/extra' },
      ],
    })
    const joined = argv.join(' ')
    expect(joined).toContain('--ro-bind /agent/.git /work/.git')
    expect(joined).toContain('--bind /agent/out /work/out')
    expect(joined).toContain('--tmpfs /scratch')
    expect(joined).toContain('--dev /dev/extra')
  })

  test('applies --chdir for cwd', () => {
    const argv = argvOf('true', { cwd: '/work' })
    expect(valueAfter(argv, '--chdir')).toBe('/work')
  })

  test('omits --chdir when no cwd is given', () => {
    expect(argvOf('true')).not.toContain('--chdir')
  })
})

describe('buildSandboxedCommand masks', () => {
  test('hides a directory with --tmpfs', () => {
    const argv = argvOf('true', { masks: { dirs: ['/agent/workspace'] } })
    expect(argv.join(' ')).toContain('--tmpfs /agent/workspace')
  })

  test('hides a file with --ro-bind-data over fd 3', () => {
    const argv = argvOf('true', { masks: { files: ['/agent/.env'] } })
    expect(argv.join(' ')).toContain('--ro-bind-data 3 /agent/.env')
  })

  test('appends a `3< /dev/null` redirect to commandString when files are masked', () => {
    const { commandString } = buildSandboxedCommand('true', { masks: { files: ['/agent/.env'] } })
    expect(commandString.endsWith('3</dev/null')).toBe(true)
  })

  test('does NOT append the mask-fd redirect when only dirs are masked', () => {
    const { commandString } = buildSandboxedCommand('true', { masks: { dirs: ['/agent/workspace'] } })
    expect(commandString).not.toContain('3</dev/null')
  })

  test('renders all masks AFTER the broad parent bind so the last op wins', () => {
    const argv = argvOf('true', {
      mounts: [{ type: 'bind', source: '/agent', dest: '/agent' }],
      masks: { dirs: ['/agent/workspace'], files: ['/agent/.env'] },
    })
    const parentBindDest = argv.indexOf('/agent')
    const dirMask = argv.indexOf('/agent/workspace')
    const fileMask = argv.indexOf('/agent/.env')
    expect(parentBindDest).toBeLessThan(dirMask)
    expect(parentBindDest).toBeLessThan(fileMask)
  })

  test('emits nothing when masks are empty', () => {
    const argv = argvOf('true', { masks: { dirs: [], files: [] } })
    expect(argv).not.toContain('--ro-bind-data')
  })
})

describe('buildSandboxedCommand writable overlays', () => {
  test('re-binds writable dirs and files RW with --bind <p> <p>', () => {
    const joined = argvOf('true', {
      writable: { dirs: ['/agent/workspace'], files: ['/agent/AGENTS.md'] },
    }).join(' ')
    expect(joined).toContain('--bind /agent/workspace /agent/workspace')
    expect(joined).toContain('--bind /agent/AGENTS.md /agent/AGENTS.md')
  })

  test('renders writable overlays after the root but before nested masks', () => {
    const argv = argvOf('true', {
      mounts: [{ type: 'ro-bind', source: '/agent', dest: '/agent' }],
      masks: { dirs: ['/agent/workspace/.agent-messenger'], files: ['/agent/workspace/.env'] },
      writable: { dirs: ['/agent/workspace'], files: ['/agent/AGENTS.md'] },
    })
    const roRootDest = argv.indexOf('/agent')
    const messengerMask = argv.indexOf('/agent/workspace/.agent-messenger')
    const envMask = argv.indexOf('/agent/workspace/.env')
    const writableDir = argv.indexOf('/agent/workspace')
    const writableFile = argv.indexOf('/agent/AGENTS.md')
    expect(roRootDest).toBeLessThan(writableDir)
    expect(writableDir).toBeLessThan(messengerMask)
    expect(writableDir).toBeLessThan(envMask)
    expect(writableFile).toBeLessThan(messengerMask)
  })

  test('emits no writable binds when the policy omits them', () => {
    const argv = argvOf('true', { mounts: [{ type: 'ro-bind', source: '/agent', dest: '/agent' }] })
    expect(argv).not.toContain('--bind')
  })
})

describe('buildSandboxedCommand writableRoot (trusted-role compatibility)', () => {
  test('RW-binds the project root with --bind <root> <root>', () => {
    const joined = argvOf('printf safe > ordinary.txt', { writableRoot: { dir: '/agent' } }).join(' ')
    expect(joined).toContain('--bind /agent /agent')
  })

  test('renders the RW root BEFORE masks so secret masks override it (no re-expose)', () => {
    const argv = argvOf('printf safe > ordinary.txt', {
      mounts: [{ type: 'ro-bind', source: '/agent', dest: '/agent' }],
      writableRoot: { dir: '/agent' },
      masks: { dirs: ['/agent/memory'], files: ['/agent/.env'] },
    })
    const rwRoot = argv.indexOf('--bind')
    const memoryMask = argv.indexOf('/agent/memory')
    const envMask = argv.indexOf('/agent/.env')
    expect(rwRoot).toBeGreaterThanOrEqual(0)
    expect(rwRoot).toBeLessThan(memoryMask)
    expect(rwRoot).toBeLessThan(envMask)
  })

  test('renders the RW root BEFORE protected re-binds so executable surfaces stay RO', () => {
    const argv = argvOf('printf safe > ordinary.txt', {
      writableRoot: { dir: '/agent' },
      protected: { dirs: ['/agent/.git/hooks'], files: ['/agent/.git/config'] },
    })
    const rwRoot = argv.indexOf('--bind')
    const hooks = argv.indexOf('/agent/.git/hooks')
    const config = argv.indexOf('/agent/.git/config')
    expect(rwRoot).toBeLessThan(hooks)
    expect(rwRoot).toBeLessThan(config)
  })

  test('emits no RW root bind when the policy omits writableRoot', () => {
    expect(argvOf('true', { mounts: [{ type: 'ro-bind', source: '/agent', dest: '/agent' }] })).not.toContain('--bind')
  })
})

describe('buildSandboxedCommand protected re-binds', () => {
  test('re-binds protected dirs and files read-only with --ro-bind <p> <p>', () => {
    const joined = argvOf('true', {
      protected: { dirs: ['/agent/.git/hooks'], files: ['/agent/.git/config'] },
    }).join(' ')
    expect(joined).toContain('--ro-bind /agent/.git/hooks /agent/.git/hooks')
    expect(joined).toContain('--ro-bind /agent/.git/config /agent/.git/config')
  })

  test('renders protected RO re-binds AFTER the writable .git bind so last-op-wins keeps hooks/config EROFS', () => {
    const argv = argvOf('true', {
      mounts: [{ type: 'ro-bind', source: '/agent', dest: '/agent' }],
      writable: { dirs: ['/agent/.git'], files: [] },
      protected: { dirs: ['/agent/.git/hooks'], files: ['/agent/.git/config'] },
    })
    const writableGit = argv.lastIndexOf('/agent/.git')
    const hooksProtect = argv.indexOf('/agent/.git/hooks')
    const configProtect = argv.indexOf('/agent/.git/config')
    expect(writableGit).toBeGreaterThanOrEqual(0)
    expect(hooksProtect).toBeGreaterThan(writableGit)
    expect(configProtect).toBeGreaterThan(writableGit)
  })

  test('renders node_modules read-only after a trusted root bind while confined policy remains valid', () => {
    const trusted = argvOf('printf safe > ordinary.txt', {
      writableRoot: { dir: '/agent' },
      protected: { dirs: ['/agent/node_modules'], files: [] },
    })
    const confined = argvOf('printf safe > workspace/output.txt', {
      writable: { dirs: ['/agent/workspace'], files: [] },
      protected: { dirs: ['/agent/node_modules'], files: [] },
    })

    expect(trusted.indexOf('/agent')).toBeLessThan(trusted.indexOf('/agent/node_modules'))
    expect(trusted.join(' ')).toContain('--ro-bind /agent/node_modules /agent/node_modules')
    expect(confined.join(' ')).toContain('--bind /agent/workspace /agent/workspace')
    expect(confined.join(' ')).toContain('--ro-bind /agent/node_modules /agent/node_modules')
    expect(confined.join(' ')).not.toContain('--bind /agent /agent')
  })

  test('emits no protected re-binds when the policy omits them', () => {
    const joined = argvOf('true', { writable: { dirs: ['/agent/.git'] } }).join(' ')
    expect(joined).not.toContain('/agent/.git/hooks')
    expect(joined).not.toContain('/agent/.git/config')
  })
})

describe('buildSandboxedCommand has no package-install path-occupancy mode', () => {
  test('does not emit /dev/null path occupancy for a trusted ordinary write', () => {
    const joined = argvOf('printf safe > ordinary.txt', { writableRoot: { dir: '/agent' } }).join(' ')
    expect(joined).not.toContain('--ro-bind /dev/null')
  })

  test('still renders protected Git controls after the trusted RW root', () => {
    const argv = argvOf('printf safe > ordinary.txt', {
      writableRoot: { dir: '/agent' },
      protected: { dirs: ['/agent/.git/hooks'], files: ['/agent/.git/config'] },
    })
    const rwRoot = argv.indexOf('--bind')
    const protectedPath = argv.indexOf('/agent/.git/hooks')
    expect(rwRoot).toBeGreaterThanOrEqual(0)
    expect(protectedPath).toBeGreaterThan(rwRoot)
  })

  test('emits no hidden path-occupancy bind when the root is read-only', () => {
    const argv = argvOf('true', {})
    expect(argv.join(' ')).not.toContain('/dev/null /agent')
  })
})

describe('buildSandboxedCommand symlinks', () => {
  test('emits --dir <parent> then --symlink <target> <dest> for each op', () => {
    const joined = argvOf('true', {
      symlinks: [{ target: '/agent/workspace/.metabase-cli', dest: '/tmp/.metabase-cli' }],
    }).join(' ')
    expect(joined).toContain('--dir /tmp')
    expect(joined).toContain('--symlink /agent/workspace/.metabase-cli /tmp/.metabase-cli')
  })

  test('renders the symlink AFTER the /tmp bind so last-op-wins keeps it', () => {
    const argv = argvOf('true', {
      mounts: [
        { type: 'ro-bind', source: '/agent', dest: '/agent' },
        { type: 'bind', source: '/session/tmp', dest: '/tmp' },
      ],
      symlinks: [{ target: '/agent/workspace/.metabase-cli', dest: '/tmp/.metabase-cli' }],
    })
    const tmpBind = argv.lastIndexOf('/tmp')
    const symlinkDest = argv.lastIndexOf('/tmp/.metabase-cli')
    expect(tmpBind).toBeGreaterThanOrEqual(0)
    expect(symlinkDest).toBeGreaterThan(tmpBind)
  })

  test('emits nothing when the policy omits symlinks', () => {
    const argv = argvOf('true', {})
    expect(argv).not.toContain('--symlink')
  })

  test('emits one --symlink per op', () => {
    const argv = argvOf('true', {
      symlinks: [
        { target: '/agent/.a', dest: '/tmp/.a' },
        { target: '/agent/.b', dest: '/root/.b' },
      ],
    })
    expect(argv.filter((t) => t === '--symlink')).toHaveLength(2)
  })
})

describe('buildSandboxedCommand proc strategy', () => {
  test("omits the /proc tmpfs for proc: 'none'", () => {
    const argv = argvOf('true', { proc: 'none' })
    expect(argv.join(' ')).not.toContain('--tmpfs /proc')
  })

  test('re-exposes the interpreter at /proc/self/exe via symlink when procSelfExe is set', () => {
    const joined = argvOf('true', { procSelfExe: '/usr/local/bin/bun' }).join(' ')
    expect(joined).toContain('--ro-bind /usr/local/bin/bun /usr/local/bin/bun')
    expect(joined).toContain('--symlink /usr/local/bin/bun /proc/self/exe')
  })

  // A bare --ro-bind /proc/self/exe at bwrap setup time captures bwrap's own
  // binary (it runs as the pid /proc/self points at), so the fix must symlink a
  // resolved concrete path. /proc/self/exe may only appear as the --symlink
  // DESTINATION, never as a bind SOURCE.
  test('uses /proc/self/exe only as a symlink target, never as a bind source', () => {
    const argv = argvOf('true', { procSelfExe: '/usr/local/bin/bun' })
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--ro-bind' || argv[i] === '--bind') {
        expect(argv[i + 1]).not.toBe('/proc/self/exe')
      }
    }
    expect(valueAfter(argv, '--symlink')).toBe('/usr/local/bin/bun')
  })

  test('renders the /proc/self/exe re-expose AFTER --tmpfs /proc so the tmpfs does not erase it', () => {
    const argv = argvOf('true', { procSelfExe: '/usr/local/bin/bun' })
    const procTmpfs = argv.indexOf('/proc')
    const symlinkDest = argv.indexOf('/proc/self/exe')
    expect(procTmpfs).toBeGreaterThanOrEqual(0)
    expect(symlinkDest).toBeGreaterThan(procTmpfs)
  })

  test('omits the /proc/self/exe re-expose when procSelfExe is unset', () => {
    const argv = argvOf('true')
    expect(argv).not.toContain('--symlink')
    expect(argv.join(' ')).not.toContain('/proc/self/exe')
  })

  test("omits the /proc/self/exe re-expose for proc: 'none' even with procSelfExe set", () => {
    const argv = argvOf('true', { proc: 'none', procSelfExe: '/usr/local/bin/bun' })
    expect(argv.join(' ')).not.toContain('/proc/self/exe')
  })
})

describe("buildSandboxedCommand proc: 'proc-bind'", () => {
  test('binds the real /proc read-only with NO unshare prefix and NO CAP_SYS_ADMIN dependency', () => {
    const argv = argvOf('bunx cowsay hi', { proc: 'proc-bind' })
    expect(argv[0]).toBe('bwrap')
    expect(argv).not.toContain('unshare')
    expect(argv).not.toContain('--mount-proc')
    expect(argv.join(' ')).toContain('--ro-bind /proc /proc')
    expect(argv.slice(-3)).toEqual(['bash', '-c', 'bunx cowsay hi'])
  })

  test('keeps --unshare-all (the user-namespace that blocks cross-userns /proc/<agent>/environ reads)', () => {
    const argv = argvOf('true', { proc: 'proc-bind' })
    expect(argv).toContain('--unshare-all')
  })

  test('does not mask /proc with a tmpfs or fake the /proc/self/exe symlink', () => {
    const joined = argvOf('true', { proc: 'proc-bind', procSelfExe: '/usr/local/bin/bun' }).join(' ')
    expect(joined).not.toContain('--tmpfs /proc')
    expect(joined).not.toContain('/proc/self/exe')
  })

  test('isolates the net namespace by default via --unshare-all (no --share-net)', () => {
    const argv = argvOf('true', { proc: 'proc-bind' })
    expect(argv).not.toContain('--share-net')
  })

  test("rejoins the container network for network 'inherit' via --share-net", () => {
    const argv = argvOf('true', { proc: 'proc-bind', network: 'inherit' })
    expect(argv).toContain('--share-net')
  })
})

describe("buildSandboxedCommand proc: 'real-proc'", () => {
  test('prefixes the command with unshare to own a new pid ns + fresh procfs, then bwrap', () => {
    const argv = argvOf('bunx cowsay hi', { proc: 'real-proc' })
    expect(argv.slice(0, 6)).toEqual(['unshare', '--pid', '--fork', '--mount', '--mount-proc', '--'])
    expect(argv[6]).toBe('bwrap')
    expect(argv.slice(-3)).toEqual(['bash', '-c', 'bunx cowsay hi'])
  })

  test('honors a non-default bwrapPath after the unshare prefix', () => {
    const argv = argvOf('true', { proc: 'real-proc', bwrapPath: '/opt/bwrap' })
    expect(argv[6]).toBe('/opt/bwrap')
  })

  test('does NOT pass --unshare-all (it would re-create a pid ns with no matching procfs)', () => {
    const argv = argvOf('true', { proc: 'real-proc' })
    expect(argv).not.toContain('--unshare-all')
    expect(argv).not.toContain('--unshare-pid')
  })

  test('unshares user/ipc/uts/cgroup explicitly so only the pid ns is owned by the outer unshare', () => {
    const argv = argvOf('true', { proc: 'real-proc' })
    expect(argv).toContain('--unshare-user')
    expect(argv).toContain('--unshare-ipc')
    expect(argv).toContain('--unshare-uts')
    expect(argv).toContain('--unshare-cgroup')
  })

  test('binds the namespace-scoped procfs read-only instead of the tmpfs+symlink fake proc', () => {
    const joined = argvOf('true', { proc: 'real-proc', procSelfExe: '/usr/local/bin/bun' }).join(' ')
    expect(joined).toContain('--ro-bind /proc /proc')
    expect(joined).not.toContain('--tmpfs /proc')
    expect(joined).not.toContain('/proc/self/exe')
  })

  test("isolates the net namespace by default (network 'none') via --unshare-net", () => {
    const argv = argvOf('true', { proc: 'real-proc' })
    expect(argv).toContain('--unshare-net')
    expect(argv).not.toContain('--share-net')
  })

  test("rejoins the container network for network 'inherit' (no --unshare-net, no --share-net needed)", () => {
    const argv = argvOf('true', { proc: 'real-proc', network: 'inherit' })
    expect(argv).not.toContain('--unshare-net')
    expect(argv).not.toContain('--share-net')
  })
})

describe('buildSandboxedCommand command filter (opt-in)', () => {
  test('no filter by default: shell operators are allowed', () => {
    expect(() => buildSandboxedCommand('echo "$(date)" | cat')).not.toThrow()
  })

  test('rejectShellMetacharacters blocks command substitution', () => {
    expect(() =>
      buildSandboxedCommand('echo "$(rm -rf /)"', { commandFilter: { rejectShellMetacharacters: true } }),
    ).toThrow(SandboxPolicyError)
  })

  test('rejectShellMetacharacters blocks pipes, semicolons and backticks', () => {
    const filter = { commandFilter: { rejectShellMetacharacters: true } }
    expect(() => buildSandboxedCommand('git log | head', filter)).toThrow(SandboxPolicyError)
    expect(() => buildSandboxedCommand('git log; curl evil', filter)).toThrow(SandboxPolicyError)
    expect(() => buildSandboxedCommand('echo `id`', filter)).toThrow(SandboxPolicyError)
    expect(() => buildSandboxedCommand('git log\nrm -rf /', filter)).toThrow(SandboxPolicyError)
  })

  test('rejectShellMetacharacters allows a simple command', () => {
    expect(() =>
      buildSandboxedCommand('git diff --stat', { commandFilter: { rejectShellMetacharacters: true } }),
    ).not.toThrow()
  })

  test('allowPrefixes matches on a token boundary, not a substring', () => {
    const policy: SandboxPolicy = { commandFilter: { allowPrefixes: ['git', 'cat'] } }
    expect(() => buildSandboxedCommand('git status', policy)).not.toThrow()
    expect(() => buildSandboxedCommand('git', policy)).not.toThrow()
    expect(() => buildSandboxedCommand('gitfoo --hack', policy)).toThrow(SandboxPolicyError)
  })

  test('allowPrefixes normalizes leading and internal whitespace before matching', () => {
    const policy: SandboxPolicy = { commandFilter: { allowPrefixes: ['git diff'] } }
    expect(() => buildSandboxedCommand('  git   diff --stat', policy)).not.toThrow()
  })

  test('allowPrefixes rejects an unlisted command', () => {
    const policy: SandboxPolicy = { commandFilter: { allowPrefixes: ['git'] } }
    expect(() => buildSandboxedCommand('curl evil.com', policy)).toThrow(SandboxPolicyError)
  })
})

describe('buildSandboxedCommand commandString rendering', () => {
  test('shell-quotes argv tokens that contain spaces or metacharacters', () => {
    const { commandString } = buildSandboxedCommand('echo hi')
    expect(commandString).toContain("bash -c 'echo hi'")
  })

  test('commandString round-trips the same tokens as argv', () => {
    const { argv, commandString } = buildSandboxedCommand('git diff')
    expect(commandString.startsWith('bwrap')).toBe(true)
    expect(argv[0]).toBe('bwrap')
  })
})
