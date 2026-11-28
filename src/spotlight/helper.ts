// Child-process entry for the Spotlight Privacy list. Spawned by ./index.ts,
// never imported by the CLI process itself.
//
// The list is only reachable through private Metadata.framework symbols (the
// ones System Settings > Spotlight > Search Privacy calls). They are
// undocumented, absent on some macOS releases, and their signatures can change
// without notice, so every call runs here: a missing symbol, a changed
// signature that crashes the process, or an mds call that never returns costs
// this child, not the `typeclaw start` that spawned it.
//
// Protocol: argv is `check <dir>` or `ensure <dir>`; stdout is one JSON
// HelperResponse line.

import { dlopen, FFIType, ptr } from 'bun:ffi'

export type HelperResponse =
  | { ok: true; state: 'excluded' | 'not-excluded' | 'newly-excluded' }
  | { ok: false; code: 'unavailable' | 'not-applied' | 'bad-request'; detail: string }

export type ExclusionList = {
  list: () => string[]
  set: (path: string) => void
}

export const METADATA_FRAMEWORK =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/Metadata.framework/Metadata'
const CORE_FOUNDATION = '/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation'
const UTF8 = 0x08000100
const PATH_BUFFER_BYTES = 4096

// mds drops a request while it is busy purging or re-indexing a large folder;
// setting is idempotent, so retry and trust only what the list reports back.
export const RETRY_DELAYS_MS = [0, 500, 1000, 2000, 4000]

export async function ensureExcluded(
  dir: string,
  api: ExclusionList,
  sleep: (ms: number) => Promise<void> = Bun.sleep,
): Promise<HelperResponse> {
  if (api.list().includes(dir)) return { ok: true, state: 'excluded' }
  for (const delay of RETRY_DELAYS_MS) {
    if (delay > 0) await sleep(delay)
    api.set(dir)
    if (api.list().includes(dir)) return { ok: true, state: 'newly-excluded' }
  }
  return { ok: false, code: 'not-applied', detail: 'Spotlight did not record the exclusion' }
}

export function bindExclusionList(): ExclusionList {
  // dlopen throws when the framework or any listed symbol is missing.
  const md = dlopen(METADATA_FRAMEWORK, {
    _MDCopyExclusionList: { args: [], returns: FFIType.ptr },
    _MDSetExclusion: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
  }).symbols
  const cf = dlopen(CORE_FOUNDATION, {
    CFGetTypeID: { args: [FFIType.ptr], returns: FFIType.u64 },
    CFArrayGetTypeID: { args: [], returns: FFIType.u64 },
    CFStringGetTypeID: { args: [], returns: FFIType.u64 },
    CFArrayGetCount: { args: [FFIType.ptr], returns: FFIType.i64 },
    CFArrayGetValueAtIndex: { args: [FFIType.ptr, FFIType.i64], returns: FFIType.ptr },
    CFStringGetCString: { args: [FFIType.ptr, FFIType.ptr, FFIType.i64, FFIType.u32], returns: FFIType.bool },
    CFStringCreateWithCString: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
    CFRelease: { args: [FFIType.ptr], returns: FFIType.void },
  }).symbols
  const arrayType = cf.CFArrayGetTypeID()
  const stringType = cf.CFStringGetTypeID()

  return {
    list() {
      const array = md._MDCopyExclusionList()
      if (array === null) return []
      try {
        // A changed return type must read as "unavailable", not as a list.
        if (cf.CFGetTypeID(array) !== arrayType) throw new Error('_MDCopyExclusionList did not return a CFArray')
        const paths: string[] = []
        const count = Number(cf.CFArrayGetCount(array))
        const buffer = new Uint8Array(PATH_BUFFER_BYTES)
        for (let index = 0; index < count; index++) {
          const item = cf.CFArrayGetValueAtIndex(array, index)
          if (item === null || cf.CFGetTypeID(item) !== stringType) continue
          if (!cf.CFStringGetCString(item, ptr(buffer), PATH_BUFFER_BYTES, UTF8)) continue
          paths.push(new TextDecoder().decode(buffer.subarray(0, buffer.indexOf(0))))
        }
        return paths
      } finally {
        cf.CFRelease(array)
      }
    },
    set(path) {
      const encoded = new TextEncoder().encode(`${path}\0`)
      const string = cf.CFStringCreateWithCString(null, ptr(encoded), UTF8)
      if (string === null) throw new Error('could not encode the path as a CFString')
      try {
        // The return value is undocumented (null in practice); callers verify
        // by re-reading the list.
        md._MDSetExclusion(string, 1)
      } finally {
        cf.CFRelease(string)
      }
    },
  }
}

export async function runHelper(
  argv: string[],
  bind: () => ExclusionList = bindExclusionList,
): Promise<HelperResponse> {
  const [op, dir] = argv
  if ((op !== 'check' && op !== 'ensure') || dir === undefined || !dir.startsWith('/')) {
    return { ok: false, code: 'bad-request', detail: `usage: check|ensure <absolute dir>` }
  }
  let api: ExclusionList
  let listed: string[]
  try {
    api = bind()
    listed = api.list()
  } catch (error) {
    return { ok: false, code: 'unavailable', detail: error instanceof Error ? error.message : String(error) }
  }
  if (op === 'check') return { ok: true, state: listed.includes(dir) ? 'excluded' : 'not-excluded' }
  try {
    return await ensureExcluded(dir, api)
  } catch (error) {
    return { ok: false, code: 'unavailable', detail: error instanceof Error ? error.message : String(error) }
  }
}

if (import.meta.main) {
  process.stdout.write(`${JSON.stringify(await runHelper(process.argv.slice(2)))}\n`)
}
