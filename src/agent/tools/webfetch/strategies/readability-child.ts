import { writeFileSync } from 'node:fs'

import { applyReadabilityDetailed } from './readability'
import type { ReadabilityChildRequest, ReadabilityChildResponse } from './readability-process'

// If memory runs out before the parent's watchdog fires, the kernel must pick
// this disposable parser over the agent runtime. Raising one's own score needs
// no privilege.
if (process.platform === 'linux') {
  try {
    writeFileSync('/proc/self/oom_score_adj', '1000')
  } catch (error) {
    console.error(`[webfetch] readability parser could not raise its OOM score: ${String(error)}`)
  }
}

const request = JSON.parse(await Bun.stdin.text()) as ReadabilityChildRequest
let response: ReadabilityChildResponse
try {
  response = { ok: true, result: await applyReadabilityDetailed(request.html, request.url) }
} catch (error) {
  response = { ok: false, message: error instanceof Error ? error.message : String(error) }
}
await Bun.write(Bun.stdout, JSON.stringify(response))
process.exit(0)
