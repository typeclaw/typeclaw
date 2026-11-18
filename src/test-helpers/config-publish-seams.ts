import { writeFileSync } from 'node:fs'

import type { PublishSeams } from '@/init/staged-write'

export const INJECTED_CONFIG_PUBLISH_FAILURE = 'injected config publish failure'

// Seams that fail typeclaw.json's publication: its first in-place write, which
// truncates first like a write that dies part-way (the in-place restore that
// follows goes through). .env writes go through for real, except the listed
// in-place .env calls (1-based), which fail the same way. `onConfigPublish`
// runs just before the publication fails. `platform` selects the .env path
// (Windows keeps no staged copies).
export function failingConfigPublish(
  hooks: { platform?: NodeJS.Platform; onConfigPublish?: () => void; envFailCalls?: number[] } = {},
): PublishSeams {
  let envCalls = 0
  let configWrites = 0
  return {
    ...(hooks.platform !== undefined ? { platform: hooks.platform } : {}),
    writeInPlace: (path, content) => {
      if (path.endsWith('typeclaw.json')) {
        configWrites += 1
        if (configWrites > 1) return writeFileSync(path, content, { flag: 'w' })
        hooks.onConfigPublish?.()
        writeFileSync(path, '', { flag: 'w' })
        throw new Error(INJECTED_CONFIG_PUBLISH_FAILURE)
      }
      envCalls += 1
      const fails = hooks.envFailCalls?.includes(envCalls) === true
      writeFileSync(path, fails ? '' : content, { flag: 'w' })
      if (fails) throw new Error(`injected in-place write failure ${envCalls}`)
    },
  }
}
