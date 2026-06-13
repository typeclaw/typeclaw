import { describe, expect, mock, test } from 'bun:test'

// Guards the onnxruntime cpuid-warning suppression: configureTransformers must
// drop the onnx backend log level to 'error' BEFORE pipeline() creates the
// inference session (where onnxruntime-node reads the level and runs the cpuid
// probe). The mock captures the env onnxruntime sees at session-creation time.
let onnxAtPipeline: { logLevel?: string; setLogLevelArg?: number } | undefined

const onnx: { logLevel?: string; setLogLevel: (level: number) => void; setLogLevelArg?: number } = {
  setLogLevel(level: number) {
    this.setLogLevelArg = level
  },
}

mock.module('@huggingface/transformers', () => ({
  env: { backends: { onnx } },
  pipeline: async () => {
    onnxAtPipeline = { logLevel: onnx.logLevel, setLogLevelArg: onnx.setLogLevelArg }
    return () => ({ data: new Float32Array(768) })
  },
}))

describe('onnxruntime log-level suppression', () => {
  test("lowers the onnx backend to 'error' and mirrors via setLogLevel before the session is created", async () => {
    const { getEmbedder } = await import('./embedder')

    await getEmbedder()

    expect(onnxAtPipeline?.logLevel).toBe('error')
    expect(onnxAtPipeline?.setLogLevelArg).toBe(3)
  })
})
