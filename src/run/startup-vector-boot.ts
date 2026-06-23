type VectorBootDeps = {
  buildIndex: () => Promise<unknown>
  warmEmbedder: () => Promise<void>
}

// Builds the startup vector index and warms the embedder concurrently — both
// resolve the embedder through the same getEmbedder() memo, so the ONNX model
// loads exactly once and its ~2-5s init overlaps the build's disk/DB work.
//
// getEmbedder() clears its memo on a rejected load, so a transient failure (e.g.
// boot racing the host model mount) is recoverable by a later call. Running both
// concurrently means they observe the SAME first load: if it rejects, both fail
// and the in-boot recovery the old sequential order gave for free — where
// warmEmbedder() was the retrying "next call" after the build's embed() failed —
// is lost. Restore it with a single follow-up warm-up when the shared load
// failed; on a permanent failure it just logs again and the first turn lazy-loads.
export async function runStartupVectorBoot(deps: VectorBootDeps): Promise<void> {
  const [, warmedOk] = await Promise.all([
    deps.buildIndex().catch((err) => {
      console.warn(`[vector] startup index build failed: ${errorText(err)}`)
    }),
    deps
      .warmEmbedder()
      .then(() => true)
      .catch((err) => {
        console.warn(`[vector] embedder warm-up failed: ${errorText(err)}`)
        return false
      }),
  ])

  if (!warmedOk) {
    await deps.warmEmbedder().catch((err) => {
      console.warn(`[vector] embedder warm-up retry failed: ${errorText(err)}`)
    })
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
