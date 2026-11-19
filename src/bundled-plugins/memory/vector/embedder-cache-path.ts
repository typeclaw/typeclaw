import { resolve } from 'node:path'

import { modelsDir } from '@/hostd/paths'

export function modelCachePath(): string {
  return resolve(process.env.TYPECLAW_MODEL_CACHE || modelsDir())
}
