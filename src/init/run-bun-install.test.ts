import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runBunInstall, runBunUpdate } from './run-bun-install'

// Capture the argv a runner hands to `spawn` while still returning a real,
// fast-exiting process so `runTimedBunProcess` can await `exited`/`stderr`.
function capturingSpawn(): { spawn: typeof Bun.spawn; cmds: string[][] } {
  const cmds: string[][] = []
  const spawn: typeof Bun.spawn = (options) => {
    cmds.push([...((options as { cmd: string[] }).cmd ?? [])])
    return Bun.spawn({ cmd: ['bun', '-e', ''], stdout: 'pipe', stderr: 'pipe' })
  }
  return { spawn, cmds }
}

describe('runBunInstall', () => {
  test('times out a hung install process', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tc-bun-install-timeout-'))
    try {
      const spawnHungProcess: typeof Bun.spawn = () =>
        Bun.spawn({ cmd: ['bun', '-e', 'setInterval(() => {}, 1000)'], cwd, stdout: 'pipe', stderr: 'pipe' })
      await writeFile(join(cwd, 'package.json'), '{}\n')

      const result = await runBunInstall(cwd, { timeoutMs: 50, spawn: spawnHungProcess })

      expect(result).toEqual({ ok: false, reason: 'bun install timed out after 0.05s' })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('adds --backend=copyfile on Windows', async () => {
    const { spawn, cmds } = capturingSpawn()

    await runBunInstall('/agent', { spawn, platform: 'win32' })

    expect(cmds[0]).toEqual(['bun', 'install', '--linker=hoisted', '--backend=copyfile'])
  })

  test('keeps the default backend on POSIX', async () => {
    const { spawn, cmds } = capturingSpawn()

    await runBunInstall('/agent', { spawn, platform: 'linux' })

    expect(cmds[0]).toEqual(['bun', 'install', '--linker=hoisted'])
  })

  test('orders --backend=copyfile before --force on Windows', async () => {
    const { spawn, cmds } = capturingSpawn()

    await runBunInstall('/agent', { spawn, platform: 'win32', force: true })

    expect(cmds[0]).toEqual(['bun', 'install', '--linker=hoisted', '--backend=copyfile', '--force'])
  })
})

describe('runBunUpdate', () => {
  test('times out a hung update process', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tc-bun-update-timeout-'))
    try {
      const spawnHungProcess: typeof Bun.spawn = () =>
        Bun.spawn({ cmd: ['bun', '-e', 'setInterval(() => {}, 1000)'], cwd, stdout: 'pipe', stderr: 'pipe' })
      await writeFile(join(cwd, 'package.json'), '{}\n')

      const result = await runBunUpdate(cwd, 'typeclaw', { timeoutMs: 50, spawn: spawnHungProcess })

      expect(result).toEqual({ ok: false, reason: 'bun update typeclaw timed out after 0.05s' })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
