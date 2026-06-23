import { describe, expect, test } from 'bun:test'

import { runStartupVectorBoot } from './startup-vector-boot'

describe('runStartupVectorBoot', () => {
  test('runs the index build and warm-up once each on success', async () => {
    let builds = 0
    let warms = 0

    await runStartupVectorBoot({
      buildIndex: async () => {
        builds += 1
      },
      warmEmbedder: async () => {
        warms += 1
      },
    })

    expect(builds).toBe(1)
    expect(warms).toBe(1)
  })

  test('retries the warm-up once when the shared embedder load fails transiently', async () => {
    // given: a warm-up that fails on its first (concurrent) call and recovers on the retry
    let warms = 0

    await runStartupVectorBoot({
      buildIndex: async () => {},
      warmEmbedder: async () => {
        warms += 1
        if (warms === 1) throw new Error('embedder load raced the model mount')
      },
    })

    // then: the follow-up warm-up ran, mirroring the old sequential recovery
    expect(warms).toBe(2)
  })

  test('does not retry when the warm-up succeeds even if the index build fails', async () => {
    let warms = 0

    await runStartupVectorBoot({
      buildIndex: async () => {
        throw new Error('index build failed')
      },
      warmEmbedder: async () => {
        warms += 1
      },
    })

    expect(warms).toBe(1)
  })

  test('a permanent warm-up failure retries once then degrades without throwing', async () => {
    let warms = 0

    await runStartupVectorBoot({
      buildIndex: async () => {},
      warmEmbedder: async () => {
        warms += 1
        throw new Error('model genuinely missing')
      },
    })

    expect(warms).toBe(2)
  })
})
