import { expect, test } from 'bun:test'
import { openSync, writeSync, closeSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { readValidatedConfigFileSync, recordConfigCommitSync } from '@/config/config-commits'

import {
  enforceAndPinToolFiles,
  enforceCanonicalSecretDenial,
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
async function freshStart(agentDir: string): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      '-e',
      `import { loadConfigSync } from './src/config/config.ts'
import { markRuntimeOwnsConfigWindows, reconcileLeftoverConfigWindowsSync } from './src/config/config-commits.ts'
const dir = ${JSON.stringify(agentDir)}
console.log('host:' + JSON.stringify(loadConfigSync(dir).alias))
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
