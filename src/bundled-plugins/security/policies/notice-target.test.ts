import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { checkNoticeTargetGuard, GUARD_NOTICE_TARGET } from './notice-target'

const MODEL = { models: { default: 'openai/gpt-5.4-nano' } }
const DM = { adapter: 'slack-bot', user: 'U0OWNER' }

async function agentWith(config: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-notice-guard-'))
  await writeFile(join(dir, 'typeclaw.json'), `${JSON.stringify(config, null, 2)}\n`)
  return dir
}

function write(config: unknown): Record<string, unknown> {
  return { path: 'typeclaw.json', content: `${JSON.stringify(config, null, 2)}\n` }
}

describe('checkNoticeTargetGuard', () => {
  test.each([
    ['enabling', MODEL, { ...MODEL, lastWords: { notice: DM } }],
    [
      'retargeting',
      { ...MODEL, lastWords: { notice: DM } },
      { ...MODEL, lastWords: { notice: { ...DM, user: 'U0OTHER' } } },
    ],
    ['disabling', { ...MODEL, lastWords: { notice: DM } }, MODEL],
  ])('blocks %s the notice', async (_label, before, after) => {
    const agentDir = await agentWith(before)

    const result = await checkNoticeTargetGuard({ tool: 'write', args: write(after), agentDir })

    expect(result?.block).toBe(true)
    expect(result?.reason).toContain(GUARD_NOTICE_TARGET)
  })

  test('allows edits that leave the notice target unchanged', async () => {
    const agentDir = await agentWith({ ...MODEL, lastWords: { notice: DM } })

    const result = await checkNoticeTargetGuard({
      tool: 'write',
      args: write({ ...MODEL, alias: ['dobby'], lastWords: { notice: DM } }),
      agentDir,
    })

    expect(result).toBeUndefined()
  })

  test('ignores files other than typeclaw.json', async () => {
    const agentDir = await agentWith(MODEL)

    const result = await checkNoticeTargetGuard({
      tool: 'write',
      args: { path: 'workspace/notes.json', content: JSON.stringify({ lastWords: { notice: DM } }) },
      agentDir,
    })

    expect(result).toBeUndefined()
  })
})
