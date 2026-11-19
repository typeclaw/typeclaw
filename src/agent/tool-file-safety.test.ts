import { expect, test } from 'bun:test'
import { openSync, writeSync, closeSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
    const snapshot = snapshotManagedConfigFiles(agentDir, async () => 'Guard `aliasLock` blocked write')
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
