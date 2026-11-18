import { renameSync, writeFileSync } from 'node:fs'

import type { PublishSeams } from '@/init/staged-write'

// typeclaw.json is published by rename (POSIX) or written in place (Windows).
// Both paths run on every platform through the `platform` seam.
export const CONFIG_PUBLISH_PATHS = [
  { name: 'renamed into place', platform: 'linux' },
  { name: 'written in place (the Windows path)', platform: 'win32' },
] as const satisfies ReadonlyArray<{ name: string; platform: NodeJS.Platform }>

export const INJECTED_CONFIG_PUBLISH_FAILURE = 'injected config publish failure'

// Seams that fail typeclaw.json's publication on `platform`'s path: its rename,
// or its first in-place write (which truncates first, like a write that dies
// part-way; the in-place restore that follows goes through). .env writes go
// through for real, except the listed in-place .env calls (1-based), which fail
// the same way. `onConfigPublish` runs just before the publication fails.
export function failingConfigPublish(
  platform: NodeJS.Platform,
  hooks: { onConfigPublish?: () => void; envFailCalls?: number[] } = {},
): PublishSeams {
  const isConfig = (path: string) => path.endsWith('typeclaw.json')
  let envCalls = 0
  let configWrites = 0
  return {
    platform,
    rename: (from, to) => {
      if (isConfig(to)) {
        hooks.onConfigPublish?.()
        throw new Error(INJECTED_CONFIG_PUBLISH_FAILURE)
      }
      renameSync(from, to)
    },
    writeInPlace: (path, content) => {
      if (isConfig(path)) {
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
