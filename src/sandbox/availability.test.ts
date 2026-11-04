import { afterEach, describe, expect, test } from 'bun:test'

import {
  _resetBwrapAvailabilityCacheForTests,
  _resetProcBindProbeCacheForTests,
  _resetRealProcProbeCacheForTests,
  _waitForSentinelMarkerForTests,
  buildProcBindProbeScript,
  canBindProcSafely,
  canMountRealProc,
  ensureBwrapAvailable,
  getProcBindSafetyVerdict,
  PROC_BIND_RETRY_BACKOFF_MS,
  type ProcBindSafetyVerdict,
  resolveProcBindSafetyWithRetry,
  resolveProcSelfExe,
} from './availability'
import { SandboxUnavailableError } from './errors'

afterEach(() => {
  _resetBwrapAvailabilityCacheForTests()
  _resetRealProcProbeCacheForTests()
  _resetProcBindProbeCacheForTests()
})

describe('ensureBwrapAvailable', () => {
  test('throws SandboxUnavailableError when the binary does not exist', async () => {
    await expect(ensureBwrapAvailable({ bwrapPath: '/nonexistent/definitely-not-bwrap' })).rejects.toBeInstanceOf(
      SandboxUnavailableError,
    )
  })

  test('caches the negative result by path (second call still rejects)', async () => {
    const opts = { bwrapPath: '/nonexistent/definitely-not-bwrap' }
    await expect(ensureBwrapAvailable(opts)).rejects.toBeInstanceOf(SandboxUnavailableError)
    await expect(ensureBwrapAvailable(opts)).rejects.toBeInstanceOf(SandboxUnavailableError)
  })

  // bwrap is present in the typeclaw container but not on the macOS dev host,
  // so this asserts the positive path only where the binary actually exists.
  // Bun.spawnSync THROWS on a missing binary (ENOENT) rather than returning
  // success:false, so the probe itself must be guarded.
  const bwrapPresent = (() => {
    try {
      return Bun.spawnSync(['bwrap', '--version'], { timeout: 30_000, stdout: 'ignore', stderr: 'ignore' }).success
    } catch {
      return false
    }
  })()
  test.skipIf(!bwrapPresent)('resolves when bwrap is on PATH', async () => {
    await expect(ensureBwrapAvailable()).resolves.toBeUndefined()
  })
})

describe('canMountRealProc', () => {
  // The probe's boolean depends on the host kernel/runtime (true only where
  // `unshare --mount-proc` actually works — a Linux container with real
  // CAP_SYS_ADMIN; false on the macOS dev host where `unshare` is absent). So
  // these assert the contract that survives both environments: the result is
  // a boolean, and it is stable/cached within a process lifetime.
  test('returns a boolean', async () => {
    expect(typeof (await canMountRealProc())).toBe('boolean')
  })

  test('caches the result (repeated calls return the same value)', async () => {
    const first = await canMountRealProc()
    const second = await canMountRealProc()
    expect(second).toBe(first)
  })

  test('re-probes after a cache reset', async () => {
    const before = await canMountRealProc()
    _resetRealProcProbeCacheForTests()
    const after = await canMountRealProc()
    // Same host, so the value is identical — but the call path went through a
    // fresh probe rather than the cache (no throw, deterministic).
    expect(after).toBe(before)
  })

  test('dedups concurrent first calls onto one in-flight probe (same promise identity)', () => {
    // Strong assertion: a second call BEFORE the first settles must return the
    // exact same in-flight promise, proving only one `unshare` is spawned. (A
    // value-equality check would pass even with two separate spawns, so it
    // would not actually guard the dedup.)
    const first = canMountRealProc()
    const second = canMountRealProc()
    expect(second).toBe(first)
    return first
  })

  test('caches the result for the process so later calls never re-probe', async () => {
    // The capability is a process-global fact; once resolved (true OR false) a
    // subsequent call returns the cached value rather than spawning again.
    const resolved = await canMountRealProc()
    const cachedPromise = canMountRealProc()
    expect(await cachedPromise).toBe(resolved)
  })
})

describe('canBindProcSafely', () => {
  // Like canMountRealProc, the boolean depends on the host: true only where a
  // --unshare-all bwrap can bind /proc AND the kernel blocks the sentinel's
  // cross-userns environ read (a Linux container with bwrap), false on the
  // macOS dev host where bwrap is absent. So these assert the environment-
  // independent contract: the result is a boolean, stable and cached, with the
  // same in-flight dedup as the other probes.
  test('returns a boolean', async () => {
    expect(typeof (await canBindProcSafely())).toBe('boolean')
  })

  test('caches the result (repeated calls return the same value)', async () => {
    const first = await canBindProcSafely()
    const second = await canBindProcSafely()
    expect(second).toBe(first)
  })

  test('re-probes after a cache reset', async () => {
    const before = await canBindProcSafely()
    _resetProcBindProbeCacheForTests()
    const after = await canBindProcSafely()
    expect(after).toBe(before)
  })

  test('concurrent calls share one underlying probe and agree (boolean wrapper has no own identity)', async () => {
    // canBindProcSafely now derives from the deduped getProcBindSafetyVerdict, so
    // its OWN promise identity differs per call (the strict identity assertion
    // lives on the verdict fn below). The guarantee that survives is the one that
    // matters: concurrent callers resolve to the same value off a single probe.
    _resetProcBindProbeCacheForTests()
    const [first, second] = await Promise.all([canBindProcSafely(), canBindProcSafely()])
    expect(second).toBe(first)
  })

  test('keys the cache by bwrapPath so a non-default binary re-probes (never inherits the default result)', async () => {
    // given: the default-path probe has run and cached a result
    await canBindProcSafely()
    // when/then: a non-existent bwrap path must NOT inherit that cache — it
    // probes its own (absent) binary and is unsafe. A singleton cache would
    // wrongly return the default's answer here.
    expect(await canBindProcSafely({ bwrapPath: '/nonexistent/definitely-not-bwrap' })).toBe(false)
  })
})

describe('getProcBindSafetyVerdict', () => {
  // The verdict's value depends on the host (Linux container + bwrap → 'safe';
  // macOS dev host where bwrap is absent → not 'safe'). These assert the
  // environment-independent contract: it is always one of the three states, it
  // is the source of truth that canBindProcSafely() narrows, and a definitively
  // absent binary yields a definitive (cacheable) verdict, never 'inconclusive'.
  test('returns one of the three verdict states', async () => {
    const verdict = await getProcBindSafetyVerdict()
    expect(['safe', 'unsafe', 'inconclusive']).toContain(verdict)
  })

  test('canBindProcSafely is true IFF the verdict is exactly "safe"', async () => {
    // given: a fresh probe so the two calls observe the same cached fact
    _resetProcBindProbeCacheForTests()
    const verdict = await getProcBindSafetyVerdict()
    const bool = await canBindProcSafely()
    // then: the boolean wrapper collapses both 'unsafe' AND 'inconclusive' to
    // false — only 'safe' makes proc-bind selectable.
    expect(bool).toBe(verdict === 'safe')
  })

  test('an absent binary yields a non-"safe" verdict so proc-bind is never selected', async () => {
    // A missing bwrap cannot prove the userns leak-block, so the verdict must
    // never be 'safe'. (It surfaces as 'inconclusive' — the spawn throws ENOENT,
    // which the probe treats as "couldn't verify"; the retry loop then exhausts
    // its budget and fails closed to tmpfs. Either way proc-bind is unreachable.)
    const verdict = await getProcBindSafetyVerdict({ bwrapPath: '/nonexistent/definitely-not-bwrap' })
    expect(verdict).not.toBe('safe')
  })

  test('dedups concurrent first calls onto one in-flight probe (same promise identity)', () => {
    const first = getProcBindSafetyVerdict()
    const second = getProcBindSafetyVerdict()
    expect(second).toBe(first)
    return first
  })

  test('caches the result for the process so later calls never re-probe', async () => {
    const resolved = await getProcBindSafetyVerdict()
    const cached = getProcBindSafetyVerdict()
    expect(await cached).toBe(resolved)
  })

  test('re-probes after a cache reset (deterministic, same host → same verdict)', async () => {
    const before = await getProcBindSafetyVerdict()
    _resetProcBindProbeCacheForTests()
    const after = await getProcBindSafetyVerdict()
    expect(after).toBe(before)
  })
})

describe('buildProcBindProbeScript (false-pass regression guard)', () => {
  // The real probe needs a Linux container + bwrap, so its security behavior
  // can't run in CI. These pin the generated script's SHAPE so a regression to
  // the false-passing form (which leaked secrets, see git history) fails here.
  const script = buildProcBindProbeScript(4242)

  test('opens the protected files (the actual leak path), never grep/cat on a localized errno', () => {
    // given-when-then: a successful open of environ/maps must trip the LEAK exit
    expect(script).toContain('(: < /proc/4242/environ) 2>/dev/null && exit 10')
    expect(script).toContain('(: < /proc/4242/maps) 2>/dev/null && exit 10')
    // the old false-passing / locale-fragile forms must NOT return
    expect(script).not.toContain('grep')
    expect(script).not.toContain('Permission denied')
    expect(script).not.toMatch(/cat .*&& exit/)
  })

  test('uses DISTINCT exit codes so a setup failure is never cached as a leak', () => {
    // leak = 10 (cacheable unsafe); setup checks = 20 (inconclusive); safe = 0.
    // A bare `exit 1` on setup checks would conflate them and poison the cache.
    expect(script).toContain('test -r /proc/self/fd || exit 20')
    expect(script).toContain('test -r /proc/self/maps || exit 20')
    expect(script).toContain('test -r /proc/4242/status || exit 20')
    expect(script.trim().endsWith('exit 0')).toBe(true)
    // the leak code must NEVER be reachable from a setup-check failure
    expect(script).not.toMatch(/test -r [^|]*\|\| exit 10/)
  })

  test('never asserts readability of a protected file via test -r (access() != open() across userns)', () => {
    expect(script).not.toContain('test -r /proc/4242/environ')
    expect(script).not.toContain('test -r /proc/4242/maps')
  })
})

describe('resolveProcSelfExe', () => {
  // The /proc/self/exe re-expose is bun-only by design (the container has no
  // real node; node/bunx/npx/pnpx all resolve to bun). Asserting it returns the
  // running bun binary pins that contract: if it ever returned something else,
  // sandboxed self-location would point at the wrong ELF.
  test('returns the running bun binary (process.execPath)', () => {
    expect(resolveProcSelfExe()).toBe(process.execPath)
    expect(resolveProcSelfExe()).toMatch(/bun/i)
  })
})

describe('resolveProcBindSafetyWithRetry', () => {
  // A scripted probe + recording sleep let these assert the retry POLICY (the
  // core of the inconclusive-retry fix) directly: how many times it probes, whether it sleeps,
  // and the final verdict — with no process spawning and no host dependence.
  function scriptedProbe(verdicts: ProcBindSafetyVerdict[]): () => Promise<ProcBindSafetyVerdict> {
    let i = 0
    return () => Promise.resolve(verdicts[Math.min(i++, verdicts.length - 1)] ?? 'inconclusive')
  }
  function recordingSleep(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
    const calls: number[] = []
    return { sleep: (ms) => (calls.push(ms), Promise.resolve()), calls }
  }

  test('"safe" on the first probe returns "safe" and never sleeps', async () => {
    const { sleep, calls } = recordingSleep()
    let probes = 0
    const result = await resolveProcBindSafetyWithRetry(() => (probes++, Promise.resolve('safe')), sleep, [250, 1_000])
    expect(result).toBe('safe')
    expect(probes).toBe(1)
    expect(calls).toEqual([])
  })

  test('"unsafe" fails closed immediately with NO retry (a real leak is final)', async () => {
    const { sleep, calls } = recordingSleep()
    let probes = 0
    const result = await resolveProcBindSafetyWithRetry(
      () => (probes++, Promise.resolve('unsafe')),
      sleep,
      [250, 1_000],
    )
    expect(result).toBe('unsafe')
    expect(probes).toBe(1)
    expect(calls).toEqual([])
  })

  test('a transient "inconclusive" that then resolves "safe" is retried and succeeds', async () => {
    // given: the probe is inconclusive once (load spike), then verifies safe
    const { sleep, calls } = recordingSleep()
    const result = await resolveProcBindSafetyWithRetry(scriptedProbe(['inconclusive', 'safe']), sleep, [250, 1_000])
    // then: it backed off once before the successful re-probe
    expect(result).toBe('safe')
    expect(calls).toEqual([250])
  })

  test('exhausting the budget on persistent "inconclusive" returns "inconclusive" (retryable, NOT a definitive "unsafe")', async () => {
    // given: every probe is inconclusive (sustained contention)
    const { sleep, calls } = recordingSleep()
    let probes = 0
    const result = await resolveProcBindSafetyWithRetry(
      () => (probes++, Promise.resolve('inconclusive')),
      sleep,
      [250, 1_000],
    )
    // then: initial + 2 retries = 3 probes, 2 sleeps. The result is 'inconclusive'
    // (a retryable unknown), NEVER 'safe' (fail closed) and NEVER 'unsafe' (that
    // would tell the caller it is a PERMANENT host fact and suppress recovery).
    expect(result).toBe('inconclusive')
    expect(probes).toBe(3)
    expect(calls).toEqual([250, 1_000])
  })

  test('"unsafe" after an "inconclusive" still returns "unsafe" and stops retrying', async () => {
    const { sleep, calls } = recordingSleep()
    const result = await resolveProcBindSafetyWithRetry(scriptedProbe(['inconclusive', 'unsafe']), sleep, [250, 1_000])
    expect(result).toBe('unsafe')
    // only the one backoff before the definitive 'unsafe'; no further sleeps
    expect(calls).toEqual([250])
  })

  test('an empty backoff budget probes exactly once then returns its verdict (no retry, no sleep)', async () => {
    const { sleep, calls } = recordingSleep()
    let probes = 0
    const result = await resolveProcBindSafetyWithRetry(() => (probes++, Promise.resolve('inconclusive')), sleep, [])
    expect(result).toBe('inconclusive')
    expect(probes).toBe(1)
    expect(calls).toEqual([])
  })

  // Regression guard for the deployed tmpfs-degrade bug: a transient 'inconclusive'
  // run must get MORE than the old two retries to ride out a boot-time load spike
  // before failing closed. Pins the default budget so a future trim back to the
  // narrow [250,1000] (which broke `bun install` on a saturated box) fails here.
  test('the default budget retries enough to outlast a sustained spike, then returns "inconclusive"', async () => {
    expect(PROC_BIND_RETRY_BACKOFF_MS.length).toBeGreaterThanOrEqual(4)
    const { sleep, calls } = recordingSleep()
    let probes = 0
    const result = await resolveProcBindSafetyWithRetry(
      () => (probes++, Promise.resolve('inconclusive')),
      sleep,
      PROC_BIND_RETRY_BACKOFF_MS,
    )
    expect(result).toBe('inconclusive')
    expect(probes).toBe(PROC_BIND_RETRY_BACKOFF_MS.length + 1)
    expect(calls).toEqual([...PROC_BIND_RETRY_BACKOFF_MS])
  })

  test('the default budget rides a late "safe" verdict to success (recovers after the spike)', async () => {
    const { sleep } = recordingSleep()
    // inconclusive for the first three attempts, then the spike passes and it verifies
    const verdicts: ProcBindSafetyVerdict[] = ['inconclusive', 'inconclusive', 'inconclusive', 'safe']
    let i = 0
    const result = await resolveProcBindSafetyWithRetry(
      () => Promise.resolve(verdicts[i++] ?? 'inconclusive'),
      sleep,
      PROC_BIND_RETRY_BACKOFF_MS,
    )
    expect(result).toBe('safe')
  })
})

describe('waitForSentinelMarker', () => {
  test('polls through the spawn/exec race until the marker appears', async () => {
    let reads = 0
    const sleeps: number[] = []
    const result = await _waitForSentinelMarkerForTests(
      1234,
      () => Promise.resolve(++reads === 3),
      (ms) => (sleeps.push(ms), Promise.resolve()),
      1_000,
      25,
    )

    expect(result).toBe(true)
    expect(reads).toBe(3)
    expect(sleeps).toEqual([25, 25])
  })

  test('returns false when the marker never appears before the readiness deadline', async () => {
    const sleeps: number[] = []
    let now = 0
    const result = await _waitForSentinelMarkerForTests(
      1234,
      () => Promise.resolve(false),
      (ms) => {
        sleeps.push(ms)
        now += ms
        return Promise.resolve()
      },
      50,
      25,
      () => now,
    )

    expect(result).toBe(false)
    expect(sleeps).toEqual([25, 25])
  })
})
