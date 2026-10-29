import { config } from '@/config/config'
import { canMountRealProc, getProcBindSafetyVerdict, resolveProcBindSafetyWithRetry } from '@/sandbox'
// Picks the /proc strategy for a sandboxed bash call. The branch order is:
// 'real-proc' ONLY when the operator explicitly opted in (sandbox.realProc) AND
// the kernel permits the mount (canMountRealProc) — it adds PID isolation but
// needs CAP_SYS_ADMIN (unshare --mount-proc), so it is a deliberate, narrow
// opt-in; else 'proc-bind' (--ro-bind /proc, NO CAP_SYS_ADMIN) when its userns
// leak-block is verified safe; else 'tmpfs'. Because sandbox.realProc DEFAULTS
// FALSE, the first branch is normally skipped and proc-bind is the de-facto
// default — which is the point: the common path needs no broad outer capability.
// 'tmpfs' is the last-resort degraded mode where external packages can't run;
// reached only when proc-bind is DEFINITIVELY unavailable (a real cross-userns
// environ leak → fail closed) or its safety stays unverifiable after retries.
//
// Read from the boot-time `config` snapshot, NOT live getConfig(): sandbox is
// restart-required, and the strategy MUST track the boot-time CAP_SYS_ADMIN
// grant. A `typeclaw reload` flipping realProc would otherwise emit `unshare
// --mount-proc` in a container booted WITHOUT the cap (or vice versa). Both
// probes are cached process-globally, so this resolves to one spawn per
// container lifetime regardless of how many bash calls hit it.
// A tmpfs degrade carries WHY it happened so the caller can pick a permanent vs
// retryable error. 'definitive': the probe returned a real cross-userns leak
// ('unsafe') — the ONLY verdict proven permanent, so it fails closed for good.
// 'unverified': the safety probe never reached a definitive verdict within its
// retry budget. That covers BOTH a transient load spike AND a durable
// incapability (no usable namespaces, a bwrap that starts but cannot set up its
// sandbox): the probe cannot prove a NEGATIVE capability — only a leak is
// definitive — so a genuinely incapable host also lands here and simply keeps
// re-degrading on each call. Since 'inconclusive' is never cached, that costs a
// re-probe but is correct: the only false case is "capable but briefly
// saturated", which recovers; an incapable host stays degraded either way.
// Absent when the strategy is not tmpfs.
export type ProcStrategyResolution =
  | { strategy: 'real-proc' | 'proc-bind'; degradeReason?: undefined }
  | { strategy: 'tmpfs'; degradeReason: 'definitive' | 'unverified' }

export async function resolveProcStrategy(): Promise<ProcStrategyResolution> {
  if (config.sandbox.realProc && (await canMountRealProc())) return { strategy: 'real-proc' }
  // Retry an 'inconclusive' proc-bind probe (transient under load) before
  // degrading — a single such hiccup must not break external-package runs on a
  // capable host. 'unsafe' still fails closed with no retry.
  const verdict = await resolveProcBindSafetyWithRetry(
    () => getProcBindSafetyVerdict(),
    (ms) => Bun.sleep(ms),
  )
  if (verdict === 'safe') return { strategy: 'proc-bind' }
  // Degraded last resort: no working /proc strategy. External package runners
  // (bunx/bun run <pkg-bin>) will fail with Bun's opaque "NotDir" because
  // /proc/self/{fd,maps} are absent. Only a proven 'unsafe' (a real cross-userns
  // leak) is DEFINITIVE — warn once (a real operator-facing limit). An
  // 'inconclusive' is reported as retryable upstream and NOT warned (it would cry
  // wolf every boot storm); a durably-incapable host re-degrades quietly here,
  // since the probe cannot distinguish it from transient load.
  if (verdict === 'unsafe') {
    warnTmpfsProcFallbackOnce()
    return { strategy: 'tmpfs', degradeReason: 'definitive' }
  }
  return { strategy: 'tmpfs', degradeReason: 'unverified' }
}

let tmpfsProcFallbackWarned = false
function warnTmpfsProcFallbackOnce(): void {
  if (tmpfsProcFallbackWarned) return
  tmpfsProcFallbackWarned = true
  console.warn(
    '[sandbox] degraded /proc mode: neither real-proc nor proc-bind is available on this host, ' +
      'so sandboxed external package runners (bunx / bun run <pkg-bin>) will fail. ' +
      'This needs a runtime with working user namespaces.',
  )
}
