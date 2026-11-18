import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { parseConfigJson } from '@/config'

import type { SecuritySeverity } from '../permissions'
import type { SecurityBlock } from '../policy'
import { intendedContent, pathIsTypeclawJson, refuseRiskyEdit } from './plugin-addition'

export const GUARD_NOTICE_TARGET = 'noticeTarget'
// Classified `medium`, same tier and rationale as `rolePromotion` and
// `pluginAddition`. `lastWords.notice` decides who is told, outside any
// conversation, that the agent died and what kind of work it was doing. A
// prompt-injected session that enables or retargets it would quietly route
// that operator alert elsewhere, and disabling it would silence the operator.
// So any change to the target (enable, retarget, disable) is reserved for
// owner and trusted; member and guest are blocked. typeclaw.json is
// force-committed by auto-backup, so the operator can review every change.
export const GUARD_NOTICE_TARGET_SEVERITY: SecuritySeverity = 'medium'

export async function checkNoticeTargetGuard(options: {
  tool: string
  args: Record<string, unknown>
  agentDir: string
}): Promise<SecurityBlock | undefined> {
  const { tool, args, agentDir } = options
  if (tool !== 'write' && tool !== 'edit') return undefined

  const rawPath = args.path
  if (typeof rawPath !== 'string') return undefined

  const targetPath = path.resolve(agentDir, rawPath)
  if (!(await pathIsTypeclawJson(agentDir, targetPath))) return undefined

  const editRefusal = refuseRiskyEdit(tool, args, targetPath, GUARD_NOTICE_TARGET)
  if (editRefusal) return editRefusal

  const newContent = await intendedContent(tool, args, targetPath)
  if (newContent === undefined) return undefined
  const after = noticeIn(newContent)
  if (after === undefined) return undefined

  // An unreadable or unparseable existing file reads as "no notice", so any
  // proposed target looks new and is blocked: the safe direction.
  const before = noticeIn(await readFile(targetPath, 'utf8').catch(() => '{}')) ?? null
  if (JSON.stringify(before) === JSON.stringify(after)) return undefined

  return {
    block: true,
    reason: [
      `Guard \`${GUARD_NOTICE_TARGET}\` blocked ${tool} on typeclaw.json: it changes \`lastWords.notice\`, the destination of the operator's unexpected-death alert.`,
      'Enabling, retargeting, or disabling that alert is reserved for the operator. Make the change from a session that resolves to `owner` or `trusted` (TUI, or a role granted `security.bypass.medium`), or edit typeclaw.json on the host.',
    ].join(' '),
  }
}

function noticeIn(content: string): unknown {
  const result = parseConfigJson(content, { migrate: false })
  if (!result.ok) return undefined
  return result.config.lastWords?.notice ?? null
}
