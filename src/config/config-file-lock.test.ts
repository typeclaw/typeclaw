import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { configFileLockPath, withConfigFileLock, withConfigFileLockSync } from './config-file-lock'

let dir: string
let file: string
let lock: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'typeclaw-config-lock-'))
  file = join(dir, 'typeclaw.json')
  lock = configFileLockPath(file)
  writeFileSync(file, '{}\n')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

// Releases the lock from another process, after writing `content` under it, so
// a synchronous waiter (which blocks this event loop) can be released.
function releaseFromOtherProcess(content: string) {
  return Bun.spawn({
    cmd: [
      process.execPath,
      '-e',
      `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(content)}); fs.unlinkSync(${JSON.stringify(lock)})`,
    ],
    stdout: 'ignore',
    stderr: 'inherit',
  })
}

describe('withConfigFileLock', () => {
  test('a second acquirer waits until the holder releases', async () => {
    // given: another holder has the lock
    writeFileSync(lock, '')
    let ran = false

    // when: an acquirer starts, then the holder writes and releases
    const acquirer = withConfigFileLock(file, async () => {
      ran = true
      return readFileSync(file, 'utf8')
    })
    expect(ran).toBe(false)
    writeFileSync(file, '{"alias":["atlas"]}\n')
    unlinkSync(lock)

    // then: the acquirer runs after release and sees the holder's write
    expect(await acquirer).toBe('{"alias":["atlas"]}\n')
    expect(existsSync(lock)).toBe(false)
  })

  test('serializes two holders in the same process', async () => {
    const events: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = withConfigFileLock(file, async () => {
      events.push('first:start')
      await gate
      events.push('first:end')
    })
    const second = withConfigFileLock(file, async () => {
      events.push('second')
    })

    release()
    await Promise.all([first, second])

    expect(events).toEqual(['first:start', 'first:end', 'second'])
  })

  test('never reclaims an old lock, and times out naming the manual recovery', async () => {
    // given: a lock long past any write's duration, as a stalled holder leaves it
    writeFileSync(lock, '')
    const past = new Date(Date.now() - 60 * 60_000)
    utimesSync(lock, past, past)
    let ran = false

    const acquirer = withConfigFileLock(
      file,
      async () => {
        ran = true
      },
      { timeoutMs: 50 },
    )

    await expect(acquirer).rejects.toThrow(
      `Another typeclaw process may be writing typeclaw.json; if none is (stop the agent container and any typeclaw CLI), remove the lock with \`rm "${lock}"\`.`,
    )
    expect(ran).toBe(false)
    expect(existsSync(lock)).toBe(true)
  })

  test('releases the lock when the holder throws', async () => {
    await expect(
      withConfigFileLock(file, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(existsSync(lock)).toBe(false)
  })

  test('a sync writer nested inside the holder re-enters instead of waiting on itself', async () => {
    const result = await withConfigFileLock(file, async () => withConfigFileLockSync(file, () => 'nested'))

    expect(result).toBe('nested')
    expect(existsSync(lock)).toBe(false)
  })

  test('a sync writer outside the holder fails fast instead of blocking the holder', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const holder = withConfigFileLock(file, () => gate)

    expect(() => withConfigFileLockSync(file, () => 'ran')).toThrow('another operation in this process')

    release()
    await holder
  })
})

describe('withConfigFileLockSync', () => {
  test('a second acquirer waits until the holder releases', async () => {
    // given: another process holds the lock and will write before releasing
    writeFileSync(lock, '')
    const holder = releaseFromOtherProcess('{"alias":["atlas"]}\n')

    // when: a sync acquirer waits for it
    const seen = withConfigFileLockSync(file, () => readFileSync(file, 'utf8'))

    // then: it ran after the release and saw the holder's write
    expect(seen).toBe('{"alias":["atlas"]}\n')
    expect(await holder.exited).toBe(0)
    expect(existsSync(lock)).toBe(false)
  })

  test('never reclaims an old lock, and times out naming the manual recovery', () => {
    writeFileSync(lock, '')
    const past = new Date(Date.now() - 60 * 60_000)
    utimesSync(lock, past, past)
    let ran = false

    expect(() =>
      withConfigFileLockSync(
        file,
        () => {
          ran = true
        },
        { timeoutMs: 50 },
      ),
    ).toThrow(`if none is (stop the agent container and any typeclaw CLI), remove the lock with \`rm "${lock}"\`.`)
    expect(ran).toBe(false)
    expect(existsSync(lock)).toBe(true)
  })

  test('releases the lock when the holder throws', () => {
    expect(() =>
      withConfigFileLockSync(file, () => {
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(existsSync(lock)).toBe(false)
  })
})
