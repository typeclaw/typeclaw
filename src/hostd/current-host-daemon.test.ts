import { describe, expect, test } from 'bun:test'

import type { CurrentHostDaemon } from '@/container'

import { createCurrentHostDaemonHolder } from './current-host-daemon'

describe('createCurrentHostDaemonHolder', () => {
  test('ready() resolves with the value once set, even when awaited before set', async () => {
    // given: a caller awaits ready() before the daemon has booted
    const holder = createCurrentHostDaemonHolder()
    const value: CurrentHostDaemon = {
      httpPort: 8974,
      register: async () => ({ ok: true }),
      deregister: async () => {},
    }
    const pending = holder.ready()

    // when: the daemon populates the holder after boot
    holder.set(value)

    // then: the earlier awaiter receives the populated value
    expect(await pending).toBe(value)
  })

  test('ready() resolves immediately when set has already happened', async () => {
    const holder = createCurrentHostDaemonHolder()
    const value: CurrentHostDaemon = {
      httpPort: 49999,
      register: async () => ({ ok: true }),
      deregister: async () => {},
    }
    holder.set(value)

    expect(await holder.ready()).toBe(value)
  })
})
