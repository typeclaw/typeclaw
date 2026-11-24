// Preloaded by bunfig.toml `[test] preload` to deny `bun test` without
// --parallel. The default timeout belongs in scripts/test.ts, not this
// preload, so an explicit CLI --timeout keeps its normal precedence.
//
// Why deny serial runs: Serial runs are ~3.4x slower (44s → 13s, see commit
// 1c66d5e), and Bun has no bunfig knob for the flag yet (verified against
// bunfig.zig in oven-sh/bun main, May 2026). Without this guard, IDE test
// runners and ad-hoc shells silently fall back to the slow path.
//
// Detection: Bun strips CLI flags from `Bun.argv` before invoking the
// preload, so we can't scrape the flag directly. Instead we look for
// BUN_TEST_WORKER_ID, which Bun sets in the preload env exactly when
// `--parallel` is active (the variable carries the worker index for the
// IPC handshake between coordinator and workers). Empirically verified
// against bun 1.3.14: present under --parallel, absent under serial. If
// a future Bun version renames this var, the guard fails closed (treats
// every run as serial → always denies), which is the safe direction.
//
// Bypass with TYPECLAW_ALLOW_SERIAL_TESTS=1 when debugging a flaky test
// where worker contention obscures the failure.

const isParallelWorker = typeof process.env.BUN_TEST_WORKER_ID === 'string'

if (!isParallelWorker && process.env.TYPECLAW_ALLOW_SERIAL_TESTS === '1') {
  console.warn('[require-parallel] Running serially — TYPECLAW_ALLOW_SERIAL_TESTS=1 set.')
} else if (!isParallelWorker) {
  console.error('')
  console.error('  ✗ `bun test` without --parallel is denied in this repo.')
  console.error('')
  console.error('    Serial runs take ~46s; --parallel cuts that to ~14s on a multi-core')
  console.error('    machine and is what CI uses. Bun does not (yet) accept `[test] parallel`')
  console.error('    in bunfig.toml, so we enforce it via this preload.')
  console.error('')
  console.error('    Use one of:')
  console.error('      bun run test                              # preferred')
  console.error('      bun test --parallel                       # direct')
  console.error('      TYPECLAW_ALLOW_SERIAL_TESTS=1 bun test    # intentional serial run')
  console.error('')
  process.exit(1)
}
