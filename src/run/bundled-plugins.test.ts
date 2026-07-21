import { describe, expect, test } from 'bun:test'

import { BUNDLED_PLUGINS } from './bundled-plugins'

describe('BUNDLED_PLUGINS', () => {
  test('contains exactly the expected plugins in hook-precedence order', () => {
    // Order is load-bearing: `security` must run before `guard` so its
    // `tool.before` hook gets first refusal on overlapping policy.
    // `tool-result-cap` must run before `guard` so guard's `tool.after`
    // advice appends to already-capped content (reversing the order would
    // make the cap clobber guard's advice text). `memory` must run before
    // `backup` because dreaming commits memory snapshots and any future
    // overlap on git lock contention should be resolved in memory's favor
    // (memory commits are smaller and more frequent). `explorer` lands at
    // the end: it has no hooks and no cron, so its position is irrelevant
    // for hook precedence — it's grouped with `agent-browser` (also no
    // hooks) at the tail. See the header comment in bundled-plugins.ts.
    expect(BUNDLED_PLUGINS.map((p) => p.name)).toEqual([
      'security',
      'tool-result-cap',
      'guard',
      'bun-hygiene',
      'github-cli-auth',
      'memory',
      'backup',
      'agent-browser',
      'doc-render',
      'explorer',
      'scout',
      'reviewer',
      'researcher',
      'planner',
      'operator',
    ])
  })

  test('security precedes github-cli-auth so validated gh token minting never runs on a blocked command', () => {
    const names = BUNDLED_PLUGINS.map((p) => p.name)
    expect(names.indexOf('security')).toBeLessThan(names.indexOf('github-cli-auth'))
  })
})
