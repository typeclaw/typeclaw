import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { embed } from '@/bundled-plugins/memory/vector/embedder'
import { EmbedderProcess } from '@/bundled-plugins/memory/vector/embedder-process'
import { rmTempDir } from '@/test-helpers/rm-temp-dir'

import { startAgent } from './index'

test('an up-to-date vector index boots without loading the embedding model', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-vector-startup-'))
  const attemptedEmbedding = spyOn(EmbedderProcess.prototype, 'embed').mockImplementation(async () => {
    throw new Error('model unavailable in startup fixture')
  })

  try {
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({ models: { default: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' } }),
    )
    const running = await startAgent({
      cwd,
      port: 0,
      attachTui: false,
      exportGithubCliStore: () => ({ action: 'skipped', reason: 'no-github-cli-credential' }),
      refreshProviderOAuth: async () => undefined,
    })
    try {
      expect(attemptedEmbedding).not.toHaveBeenCalled()
      await expect(embed(['a vector query'], 'query')).rejects.toThrow('model unavailable in startup fixture')
    } finally {
      await running.stop()
    }
  } finally {
    attemptedEmbedding.mockRestore()
    await rmTempDir(cwd)
  }
})
