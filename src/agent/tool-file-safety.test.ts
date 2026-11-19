import { expect, test } from 'bun:test'
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { chmod, link, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  __failConfigEpochWritesForTests,
  __setConfigReadHookForTests,
  readValidatedConfigFileSync,
  recordConfigCommitSync,
  reconcileLeftoverConfigWindowsSync,
} from '@/config/config-commits'

import {
  enforceAndPinToolFiles,
  enforceCanonicalSecretDenial,
  readOnlyConfigNotice,
  recheckManagedConfigAfterBash,
  snapshotManagedConfigFiles,
} from './tool-file-safety'

test('enforceCanonicalSecretDenial ignores non-file declarations for canonical credentials', async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-canonical-denial-'))
  const options = {
    tool: 'mcp_call',
    args: { pattern: 'secrets.json' },
    agentDir,
    fileOperands: { nonFile: ['pattern'] },
  }

  try {
    expect(() => enforceCanonicalSecretDenial(options)).toThrow(/^blocked:/)
  } finally {
    await rm(agentDir, { recursive: true, force: true })
  }
})

test('enforceCanonicalSecretDenial trusts prose semantics only for first-party builtins', async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-canonical-prose-'))

  try {
    expect(() =>
      enforceCanonicalSecretDenial({
        tool: 'write',
        args: { path: 'public/report.md', content: 'x'.repeat(300) },
        agentDir,
        toolProvenance: 'first-party',
      }),
    ).not.toThrow()
    expect(() =>
      enforceCanonicalSecretDenial({
        tool: 'write',
        args: { path: 'public/report.md', content: 'secrets.json' },
        agentDir,
        toolProvenance: 'plugin',
      }),
    ).toThrow(/^blocked:/)
  } finally {
    await rm(agentDir, { recursive: true, force: true })
  }
})

test('plugin collisions cannot inherit first-party no-file-operand shortcuts', async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-canonical-collision-'))

  try {
    await expect(
      enforceAndPinToolFiles({
        tool: 'channel_read',
        args: { path: 'secrets.json' },
        agentDir,
        genericInputs: true,
        toolProvenance: 'plugin',
      }),
    ).rejects.toThrow(/blocked:|ambiguous local file operand/)
  } finally {
    await rm(agentDir, { recursive: true, force: true })
  }
})

test('plugin handoff lookalikes cannot exempt remote-looking or credential operands', async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-handoff-collision-'))

  try {
    for (const args of [{ thread: '1699999999.000100' }, { path: 'secrets.json' }]) {
      await expect(
        enforceAndPinToolFiles({
          tool: 'channel_handoff',
          args,
          agentDir,
          genericInputs: true,
          toolProvenance: 'plugin',
        }),
      ).rejects.toThrow(/blocked:|ambiguous local file operand/)
    }
  } finally {
    await rm(agentDir, { recursive: true, force: true })
  }
})

test('a blocked bash change whose restore fails partway is reported with its recovery', async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-restore-fault-'))
  const config = path.join(agentDir, 'typeclaw.json')
  try {
    // given: a blocked bash change, and a restore write that fails after writing half
    await writeFile(config, '{"alias":["atlas"]}\n')
    const snapshot = await snapshotManagedConfigFiles(agentDir, async () => 'Guard `aliasLock` blocked write')
    await writeFile(config, '{"alias":["blocked-change"]}\n')
    const failingWrite = (target: string, bytes: Buffer) => {
      const fd = openSync(target, 'r+')
      try {
        writeSync(fd, bytes, 0, Math.floor(bytes.length / 2), 0)
      } finally {
        closeSync(fd)
      }
      throw new Error('disk full')
    }

    // when: the post-call check blocks it
    const notices = await recheckManagedConfigAfterBash(snapshot, { writeInPlace: failingWrite })

    // then: the notice names the file, the block, the failure, and the recovery
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('blocked: Guard `aliasLock` blocked write')
    expect(notices[0]).toContain('typeclaw.json could not be restored to its state before this command (disk full)')
    expect(notices[0]).toContain('`git checkout -- typeclaw.json`')
    const damaged = await readFile(config, 'utf8')
    expect(damaged).not.toBe('')
    expect(damaged).not.toBe('{"alias":["atlas"]}\n')

    // and: with the call closed, runtime readers still get the last authorized bytes
    expect(readValidatedConfigFileSync(config)).toBe('{"alias":["atlas"]}\n')

    // when: an authorized commit puts the file back in a consistent state
    await writeFile(config, '{"alias":["fixed"]}\n')
    recordConfigCommitSync(config, '{"alias":["fixed"]}\n')

    // then: the recovery state is cleared and readers follow the file again
    expect(readValidatedConfigFileSync(config)).toBe('{"alias":["fixed"]}\n')
    await writeFile(config, '{"alias":["hand-edit"]}\n')
    expect(readValidatedConfigFileSync(config)).toBe('{"alias":["hand-edit"]}\n')
  } finally {
    await rm(agentDir, { recursive: true, force: true })
  }
})

// A fresh process, as `typeclaw start` on the host and then `typeclaw run` are:
// it reports the alias a host read sees, reconciles like runtime startup, and
// reports the alias the runtime then loads.
async function freshStart(
  agentDir: string,
  options: { hostRead?: boolean } = {},
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      '-e',
      `import { loadConfigSync } from './src/config/config.ts'
import { markRuntimeOwnsConfigWindows, reconcileLeftoverConfigWindowsSync } from './src/config/config-commits.ts'
const dir = ${JSON.stringify(agentDir)}
if (${options.hostRead !== false}) console.log('host:' + JSON.stringify(loadConfigSync(dir).alias))
reconcileLeftoverConfigWindowsSync(dir)
markRuntimeOwnsConfigWindows()
console.log('runtime:' + JSON.stringify(loadConfigSync(dir).alias))`,
    ],
    cwd: path.resolve(import.meta.dir, '../..'),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code, out, err }
}

async function leaveFailedRestore(agentDir: string, config: string): Promise<void> {
  await writeFile(config, '{"alias":["atlas"]}\n')
  const snapshot = await snapshotManagedConfigFiles(agentDir, async () => 'Guard `aliasLock` blocked write')
  await writeFile(config, '{"alias":["blocked-change"]}\n')
  await recheckManagedConfigAfterBash(snapshot, {
    writeInPlace: () => {
      throw new Error('disk full')
    },
  })
}

test('a fresh start never applies bytes a failed restore left behind', async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-restore-restart-'))
  const config = path.join(agentDir, 'typeclaw.json')
  try {
    // given: a blocked change whose restore failed, then the runtime stopped
    await leaveFailedRestore(agentDir, config)
    expect(await readFile(config, 'utf8')).toBe('{"alias":["blocked-change"]}\n')

    // when: the host reads the config and the runtime starts again
    const started = await freshStart(agentDir)

    // then: neither applies the blocked bytes, and startup reverted them first
    expect(started.code).toBe(0)
    expect(started.out).toContain('host:["atlas"]')
    expect(started.out).toContain('runtime:["atlas"]')
    expect(started.err).toContain('it was reverted to the last authorized typeclaw.json at startup')
    expect(await readFile(config, 'utf8')).toBe('{"alias":["atlas"]}\n')
    expect(await readdir(path.join(agentDir, '.typeclaw', 'credential-staging'))).not.toContain(
      'typeclaw.json.window.json',
    )
  } finally {
    await rm(agentDir, { recursive: true, force: true })
  }
})

test('a fresh start that cannot revert leftover blocked bytes refuses to load them', async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-restore-refuse-'))
  const config = path.join(agentDir, 'typeclaw.json')
  try {
    await leaveFailedRestore(agentDir, config)
    await rm(config)
    await mkdir(config)

    const started = await freshStart(agentDir)

    expect(started.code).not.toBe(0)
    expect(started.err).toContain('refusing to load it')
    expect(started.err).toContain('git checkout -- typeclaw.json')
  } finally {
    await rm(agentDir, { recursive: true, force: true })
  }
})

test('a call whose window cannot be published runs with the existing config files read-only', async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-readonly-decision-'))
  const config = path.join(agentDir, 'typeclaw.json')
  const staging = path.join(agentDir, '.typeclaw', 'credential-staging')
  try {
    // given: a normal call, then one whose window state path is occupied
    await writeFile(config, '{"alias":["atlas"]}\n')
    const normal = await snapshotManagedConfigFiles(agentDir, async () => undefined)
    await recheckManagedConfigAfterBash(normal)
    await mkdir(path.join(staging, 'typeclaw.json.window.json', 'occupied'), { recursive: true })

    // when: the second call opens its window
    const blocked = await snapshotManagedConfigFiles(agentDir, async () => undefined)
    await recheckManagedConfigAfterBash(blocked)

    // then: only that call gets typeclaw.json read-only (cron.json does not exist), with the reason
    expect(normal.readOnly).toBeUndefined()
    expect(readOnlyConfigNotice(normal)).toBeUndefined()
    expect(blocked.readOnly?.files).toEqual([config])
    const notice = readOnlyConfigNotice(blocked)
    expect(notice).toContain('typeclaw.json and cron.json were read-only for this command')
    expect(notice).toContain(path.join(staging, 'typeclaw.json.window.json'))
    expect(notice).toContain('make the change with the write or edit tool')
  } finally {
    await rm(agentDir, { recursive: true, force: true })
  }
})

test('a host read that races a rollback never returns the rolled-back bytes', async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-versioned-read-'))
  const config = path.join(agentDir, 'typeclaw.json')
  const staging = path.join(agentDir, '.typeclaw', 'credential-staging')
  const window = path.join(staging, 'typeclaw.json.window.json')
  const trusted = '{"alias":["atlas"]}\n'
  try {
    // given: an open window whose trusted bytes differ from the rejected bytes on disk
    await mkdir(staging, { recursive: true })
    await writeFile(
      window,
      JSON.stringify({
        generation: 0,
        content: Buffer.from(trusted).toString('base64'),
        entry: { kind: 'file', mode: 0o644 },
      }),
    )
    await writeFile(config, '{"alias":["rejected"]}\n')
    let interleaved = 0
    __setConfigReadHookForTests((stage) => {
      if (stage !== 'after-live' || interleaved > 0) return
      interleaved += 1
      // the runtime rolls the file back and drops the window between this read's steps
      writeFileSync(config, trusted)
      rmSync(window)
    })

    // when: a host process reads typeclaw.json across that rollback
    const read = readValidatedConfigFileSync(config)

    // then: it re-reads and returns the rolled-back file, never the rejected bytes
    expect(interleaved).toBe(1)
    expect(read).toBe(trusted)
  } finally {
    __setConfigReadHookForTests(undefined)
    await rm(agentDir, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'a fresh start restores a regular file without writing through a symlink bash swapped in',
  async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-restore-symlink-'))
    const config = path.join(agentDir, 'typeclaw.json')
    const decoy = path.join(agentDir, 'workspace', 'decoy.json')
    try {
      // given: bash swapped typeclaw.json for a link to a workspace file, and the restore failed
      await writeFile(config, '{"alias":["atlas"]}\n')
      await mkdir(path.dirname(decoy), { recursive: true })
      await writeFile(decoy, '{"alias":["decoy"]}\n')
      const snapshot = await snapshotManagedConfigFiles(agentDir, async () => 'Guard `aliasLock` blocked write')
      await rm(config)
      await symlink(decoy, config)
      await chmod(agentDir, 0o555)
      const notices = await recheckManagedConfigAfterBash(snapshot)
      await chmod(agentDir, 0o755)
      expect(notices.join('\n')).toContain('could not be restored')

      // when: the agent starts again
      const started = await freshStart(agentDir)

      // then: the workspace file is untouched and typeclaw.json is a regular file again
      expect(started.code).toBe(0)
      expect(await readFile(decoy, 'utf8')).toBe('{"alias":["decoy"]}\n')
      expect((await lstat(config)).isFile()).toBe(true)
      expect(await readFile(config, 'utf8')).toBe('{"alias":["atlas"]}\n')
    } finally {
      await chmod(agentDir, 0o755).catch(() => {})
      await rm(agentDir, { recursive: true, force: true })
    }
  },
)

test('a fresh start refuses invalid leftover window state', async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-restore-invalid-'))
  try {
    await writeFile(path.join(agentDir, 'typeclaw.json'), '{"alias":["atlas"]}\n')
    const staging = path.join(agentDir, '.typeclaw', 'credential-staging')
    await mkdir(staging, { recursive: true })
    await writeFile(path.join(staging, 'typeclaw.json.window.json'), 'null')

    const started = await freshStart(agentDir, { hostRead: false })

    expect(started.code).not.toBe(0)
    expect(started.err).toContain('refusing to load it')
    expect(started.err).toContain('is invalid')
  } finally {
    await rm(agentDir, { recursive: true, force: true })
  }
})

test('under coordination failure a symlinked or missing config refuses the call', async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-readonly-targets-'))
  const config = path.join(agentDir, 'typeclaw.json')
  const real = path.join(agentDir, 'workspace', 'tc.json')
  const staging = path.join(agentDir, '.typeclaw', 'credential-staging')
  try {
    // given: typeclaw.json links into workspace and its window cannot be published
    await mkdir(path.dirname(real), { recursive: true })
    await writeFile(real, '{"alias":["atlas"]}\n')
    await symlink(real, config)
    await writeFile(path.join(agentDir, 'cron.json'), '{"jobs":[]}\n')
    await mkdir(path.join(staging, 'typeclaw.json.window.json', 'occupied'), { recursive: true })

    // when / then: the link cannot be held read-only, so the call is refused
    await expect(snapshotManagedConfigFiles(agentDir, async () => undefined)).rejects.toThrow(
      /This command was not run: the agent could not coordinate config writes[\s\S]*typeclaw\.json is a symlink, so it cannot be made read-only/,
    )

    // given: typeclaw.json is a regular file again, but cron.json is missing and uncoordinated
    await rm(config)
    await writeFile(config, '{"alias":["atlas"]}\n')
    await rm(path.join(staging, 'typeclaw.json.window.json'), { recursive: true })
    await rm(path.join(agentDir, 'cron.json'))
    await mkdir(path.join(staging, 'cron.json.window.json', 'occupied'), { recursive: true })

    // when / then: the call is refused with the cause
    await expect(snapshotManagedConfigFiles(agentDir, async () => undefined)).rejects.toThrow(
      /cron\.json does not exist, so it cannot be made read-only/,
    )
    await expect(snapshotManagedConfigFiles(agentDir, async () => undefined)).rejects.toThrow(
      /cron\.json\.window\.json/,
    )
  } finally {
    await rm(agentDir, { recursive: true, force: true })
  }
})

test('a window whose epoch cannot advance on open is a coordination failure', async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-epoch-open-'))
  const config = path.join(agentDir, 'typeclaw.json')
  const cron = path.join(agentDir, 'cron.json')
  try {
    // given: both config files exist and epoch writes fail while other state writes succeed
    await writeFile(config, '{"alias":["atlas"]}\n')
    await writeFile(cron, '{"jobs":[]}\n')
    __failConfigEpochWritesForTests(true)

    // when: a call opens its windows
    const snapshot = await snapshotManagedConfigFiles(agentDir, async () => undefined)
    await recheckManagedConfigAfterBash(snapshot)

    // then: it takes the read-only fallback, naming the epoch problem
    expect(snapshot.readOnly?.files).toEqual([config, cron])
    expect(readOnlyConfigNotice(snapshot)).toContain('window epoch could not be advanced')
  } finally {
    __failConfigEpochWritesForTests(false)
    await rm(agentDir, { recursive: true, force: true })
  }
})

test('a close whose epoch cannot advance keeps the window record, so host reads stay on trusted bytes', async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-epoch-close-'))
  const config = path.join(agentDir, 'typeclaw.json')
  const window = path.join(agentDir, '.typeclaw', 'credential-staging', 'typeclaw.json.window.json')
  const trusted = '{"alias":["atlas"]}\n'
  try {
    // given: a coordinated window, then epoch writes start failing before it closes
    await writeFile(config, trusted)
    const snapshot = await snapshotManagedConfigFiles(agentDir, async () => undefined)
    expect(snapshot.readOnly).toBeUndefined()
    __failConfigEpochWritesForTests(true)

    // when: the call closes
    await recheckManagedConfigAfterBash(snapshot)

    // then: the record stays, and a host read uses its trusted bytes over unchecked ones on disk
    expect(existsSync(window)).toBe(true)
    const kept = await readFile(window, 'utf8')
    await writeFile(config, '{"alias":["unchecked"]}\n')
    expect(readValidatedConfigFileSync(config)).toBe(trusted)

    // when: a later window opens uncoordinated (its epoch cannot advance either) and closes
    await writeFile(config, trusted)
    await writeFile(path.join(agentDir, 'cron.json'), '{"jobs":[]}\n')
    const later = await snapshotManagedConfigFiles(agentDir, async () => undefined)
    expect(later.readOnly).toBeDefined()
    await recheckManagedConfigAfterBash(later)

    // then: its cleanup leaves the earlier record exactly as it was
    expect(await readFile(window, 'utf8')).toBe(kept)
  } finally {
    __failConfigEpochWritesForTests(false)
    await rm(agentDir, { recursive: true, force: true })
  }
})

test('a host read across a whole window lifecycle between its samples retries and returns trusted bytes', async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-epoch-read-'))
  const config = path.join(agentDir, 'typeclaw.json')
  const go = path.join(agentDir, 'go.fifo')
  const trusted = '{"alias":["atlas"]}\n'
  try {
    await writeFile(config, trusted)
    expect(await Bun.spawn(['mkfifo', go]).exited).toBe(0)
    // A runtime in its own process: on the first `go` it opens a window and
    // edits typeclaw.json as bash would; on the second its check blocks the edit,
    // rolls it back, and closes the window. Each step leaves a marker file.
    const runtime = Bun.spawn({
      cmd: [
        process.execPath,
        '-e',
        `import { readFileSync, writeFileSync } from 'node:fs'
import { recheckManagedConfigAfterBash, snapshotManagedConfigFiles } from './src/agent/tool-file-safety.ts'
const dir = ${JSON.stringify(agentDir)}
readFileSync(${JSON.stringify(go)})
const snapshot = await snapshotManagedConfigFiles(dir, async () => 'Guard \`aliasLock\` blocked write')
writeFileSync(${JSON.stringify(config)}, '{"alias":["rejected"]}\\n')
writeFileSync(dir + '/edited', '')
readFileSync(${JSON.stringify(go)})
await recheckManagedConfigAfterBash(snapshot)
writeFileSync(dir + '/closed', '')`,
      ],
      cwd: path.resolve(import.meta.dir, '../..'),
      stdout: 'ignore',
      stderr: 'inherit',
    })
    const step = (marker: string) => {
      writeFileSync(go, 'go\n')
      const deadline = Date.now() + 20_000
      while (!existsSync(path.join(agentDir, marker))) {
        if (Date.now() > deadline) throw new Error(`runtime did not reach ${marker}`)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
      }
    }
    let sawRejected = false
    __setConfigReadHookForTests((stage) => {
      if (stage === 'after-window' && !existsSync(path.join(agentDir, 'edited'))) step('edited')
      if (stage === 'after-live' && !existsSync(path.join(agentDir, 'closed'))) {
        sawRejected = readFileSync(config, 'utf8').includes('rejected')
        step('closed')
      }
    })

    // when: a host read samples, the whole window lifecycle runs between its samples
    const read = readValidatedConfigFileSync(config)

    // then: the epoch moved, so it re-read and returns the rolled-back file
    expect(sawRejected).toBe(true)
    expect(read).toBe(trusted)
    expect(await runtime.exited).toBe(0)
  } finally {
    __setConfigReadHookForTests(undefined)
    await rm(agentDir, { recursive: true, force: true })
  }
})

test("a newer commit's own entry wins at startup over the window's older symlink entry", async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-commit-entry-'))
  const config = path.join(agentDir, 'typeclaw.json')
  const oldTarget = path.join(agentDir, 'workspace', 'tc.json')
  try {
    // given: typeclaw.json was a link when the window opened; a blocked edit through it could not be reverted
    await mkdir(path.dirname(oldTarget), { recursive: true })
    await writeFile(oldTarget, '{"alias":["atlas"]}\n')
    await symlink(oldTarget, config)
    const snapshot = await snapshotManagedConfigFiles(agentDir, async () => 'Guard `aliasLock` blocked write')
    await writeFile(oldTarget, '{"alias":["rejected"]}\n')
    await recheckManagedConfigAfterBash(snapshot, {
      writeInPlace: () => {
        throw new Error('disk full')
      },
    })

    // when: a host grant then renames a regular file over the path, and the agent starts again
    const grant = Bun.spawn({
      cmd: [
        process.execPath,
        '-e',
        `import { grantRole } from './src/permissions/grant.ts'
const r = grantRole({ cwd: ${JSON.stringify(agentDir)}, roleName: 'trusted', matchRule: 'discord:user:9' })
if (!r.ok) { console.error(r.reason); process.exit(1) }`,
      ],
      cwd: path.resolve(import.meta.dir, '../..'),
      stdout: 'ignore',
      stderr: 'inherit',
    })
    expect(await grant.exited).toBe(0)
    const granted = await readFile(config, 'utf8')
    const started = await freshStart(agentDir, { hostRead: false })

    // then: the grant's regular file stays, and the old link target is untouched
    expect(started.code).toBe(0)
    expect((await lstat(config)).isFile()).toBe(true)
    expect(await readFile(config, 'utf8')).toBe(granted)
    expect(JSON.parse(granted)).toMatchObject({ alias: ['atlas'], roles: { trusted: { match: ['discord:user:9'] } } })
    expect(await readFile(oldTarget, 'utf8')).toBe('{"alias":["rejected"]}\n')
  } finally {
    await rm(agentDir, { recursive: true, force: true })
  }
})

test('startup recovery whose epoch cannot advance keeps the window record, so host reads stay on trusted bytes', async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-epoch-startup-'))
  const config = path.join(agentDir, 'typeclaw.json')
  const staging = path.join(agentDir, '.typeclaw', 'credential-staging')
  const window = path.join(staging, 'typeclaw.json.window.json')
  const trusted = '{"alias":["atlas"]}\n'
  try {
    // given: a leftover window over rejected bytes, and epoch writes that fail
    await mkdir(staging, { recursive: true })
    await writeFile(
      window,
      JSON.stringify({
        generation: 0,
        content: Buffer.from(trusted).toString('base64'),
        entry: { kind: 'file', mode: 0o644 },
      }),
    )
    await writeFile(config, '{"alias":["rejected"]}\n')
    __failConfigEpochWritesForTests(true)

    // when: startup reconciles
    reconcileLeftoverConfigWindowsSync(agentDir)

    // then: the file is restored, startup did not fail, the record stays, and a host read keeps trusted bytes
    expect(await readFile(config, 'utf8')).toBe(trusted)
    expect(existsSync(window)).toBe(true)
    await writeFile(config, '{"alias":["unchecked"]}\n')
    expect(readValidatedConfigFileSync(config)).toBe(trusted)
  } finally {
    __failConfigEpochWritesForTests(false)
    await rm(agentDir, { recursive: true, force: true })
  }
})

test('under coordination failure a hard-linked typeclaw.json refuses the call', async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-readonly-hardlink-'))
  const config = path.join(agentDir, 'typeclaw.json')
  try {
    // given: typeclaw.json has a second hard link and its window cannot be published
    await writeFile(config, '{"alias":["atlas"]}\n')
    await writeFile(path.join(agentDir, 'cron.json'), '{"jobs":[]}\n')
    await mkdir(path.join(agentDir, 'workspace'))
    await link(config, path.join(agentDir, 'workspace', 'alias.json'))
    await mkdir(path.join(agentDir, '.typeclaw', 'credential-staging', 'typeclaw.json.window.json', 'occupied'), {
      recursive: true,
    })

    // when / then: a read-only bind could not hold its bytes, so the call is refused
    await expect(snapshotManagedConfigFiles(agentDir, async () => undefined)).rejects.toThrow(
      /This command was not run: the agent could not coordinate config writes[\s\S]*typeclaw\.json has another hard link, so it cannot be made read-only/,
    )
  } finally {
    await rm(agentDir, { recursive: true, force: true })
  }
})

test('a close that times out on the lock keeps the window for a call still in flight', async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-close-lock-timeout-'))
  const config = path.join(agentDir, 'typeclaw.json')
  try {
    await writeFile(config, '{"alias":["atlas"]}\n')
    // The runtime, in its own process so it owns the in-memory windows. The first
    // call closes while a holder keeps the lock past its bound; the second joins
    // the window during that wait, then edits; a reload runs; then the second
    // closes normally.
    const runtime = Bun.spawn({
      cmd: [
        process.execPath,
        '-e',
        `import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { loadConfigSync } from './src/config/config.ts'
import { markRuntimeOwnsConfigWindows } from './src/config/config-commits.ts'
import { recheckManagedConfigAfterBash, snapshotManagedConfigFiles } from './src/agent/tool-file-safety.ts'
markRuntimeOwnsConfigWindows()
const dir = ${JSON.stringify(agentDir)}
const config = ${JSON.stringify(config)}
const block = async () => 'Guard \`aliasLock\` blocked write'
const first = await snapshotManagedConfigFiles(dir, block)
writeFileSync(config + '.lock', '')
const started = Date.now()
const closing = recheckManagedConfigAfterBash(first)
const second = await snapshotManagedConfigFiles(dir, block)
await closing
console.log('waited:' + (Date.now() - started >= 4000))
writeFileSync(config, '{"alias":["unchecked"]}\\n')
console.log('reload:' + JSON.stringify(loadConfigSync(dir).alias))
rmSync(config + '.lock')
const notices = await recheckManagedConfigAfterBash(second)
console.log('reverted:' + notices.some((notice) => notice.includes('was reverted')))
console.log('record:' + existsSync(dir + '/.typeclaw/credential-staging/typeclaw.json.window.json'))
console.log('file:' + JSON.stringify(readFileSync(config, 'utf8')))`,
      ],
      cwd: path.resolve(import.meta.dir, '../..'),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [code, out, err] = await Promise.all([
      runtime.exited,
      new Response(runtime.stdout).text(),
      new Response(runtime.stderr).text(),
    ])

    // then: the reload during the second call used the trusted bytes, and the
    // second call's close then checked, reverted, and settled the window
    expect({ code, err: code === 0 ? '' : err }).toEqual({ code: 0, err: '' })
    expect(out).toContain('waited:true')
    expect(out).toContain('reload:["atlas"]')
    expect(out).toContain('reverted:true')
    expect(out).toContain('record:false')
    expect(out).toContain(`file:${JSON.stringify('{"alias":["atlas"]}\n')}`)
  } finally {
    await rm(agentDir, { recursive: true, force: true })
  }
}, 30_000)
