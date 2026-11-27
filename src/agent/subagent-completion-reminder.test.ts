import { describe, expect, test } from 'bun:test'

import {
  formatReminderDuration,
  parseSubagentCompletedPayload,
  renderSubagentCompletionReminder,
} from './subagent-completion-reminder'

describe('renderSubagentCompletionReminder', () => {
  test('ok=true renders <system-reminder> with subagent name, task id, duration, and subagent_output hint', () => {
    const text = renderSubagentCompletionReminder({
      subagent: 'explorer',
      taskId: 'bg_xyz',
      ok: true,
      durationMs: 5_000,
    })
    expect(text.startsWith('<system-reminder>')).toBe(true)
    expect(text.endsWith('</system-reminder>')).toBe(true)
    expect(text).toContain('explorer')
    expect(text).toContain('bg_xyz')
    expect(text).toContain('5s')
    expect(text).toContain('completed')
    expect(text).toContain('subagent_output')
  })

  test('ok=false renders FAILED marker, error message, and subagent_output hint', () => {
    const text = renderSubagentCompletionReminder({
      subagent: 'scout',
      taskId: 'bg_err',
      ok: false,
      durationMs: 1_500,
      error: 'provider rate limit',
    })
    expect(text).toContain('FAILED')
    expect(text).toContain('provider rate limit')
    expect(text).toContain('subagent_output')
    expect(text).toContain('todo_write')
  })

  test('ok=false without error string falls back to "unknown error"', () => {
    const text = renderSubagentCompletionReminder({
      subagent: 'scout',
      taskId: 'bg_err',
      ok: false,
      durationMs: 1_500,
    })
    expect(text).toContain('unknown error')
  })

  test('cancelled renders a close-out instead of recovery or a review verdict', () => {
    const cancelled = renderSubagentCompletionReminder({
      subagent: 'reviewer',
      taskId: 'bg_rev',
      ok: false,
      durationMs: 30_000,
      error: 'cancelled: pull request converted to draft',
      cancelled: true,
      channel: true,
      adapter: 'github',
    })
    expect(cancelled).toContain('was cancelled')
    expect(cancelled).toContain('pull request converted to draft')
    expect(cancelled).toContain('cancelled via todo_write')
    expect(cancelled).toContain('skip_response')
    expect(cancelled).not.toContain('FAILED')
    expect(cancelled).not.toContain('keep the item pending')
    expect(cancelled).not.toContain('formal review')
  })

  test('ok=false with hasRecoverableOutput steers the parent to recover, not redo, the work', () => {
    const recoverable = renderSubagentCompletionReminder({
      subagent: 'researcher',
      taskId: 'bg_to',
      ok: false,
      durationMs: 600_000,
      error: 'spawn timed out after 1800000ms',
      hasRecoverableOutput: true,
    })
    expect(recoverable).toContain('produced output before failing')
    expect(recoverable).toContain('subagent_output')
    expect(recoverable).toContain('partial recovery data')
    expect(recoverable).toContain('not a completed verdict')

    // when the flag is absent, the wording stays the plain "inspect" guidance
    const plain = renderSubagentCompletionReminder({
      subagent: 'researcher',
      taskId: 'bg_to',
      ok: false,
      durationMs: 600_000,
      error: 'spawn timed out after 1800000ms',
    })
    expect(plain).not.toContain('produced output before failing')
    expect(plain).toContain('subagent_output to inspect')
  })

  test('channel=true appends the channel_reply nudge so a channel-session reminder steers the model to surface via tool, not plain text', () => {
    const text = renderSubagentCompletionReminder({
      subagent: 'explorer',
      taskId: 'bg_xyz',
      ok: true,
      durationMs: 5_000,
      channel: true,
    })
    expect(text).toContain('channel_reply')
    expect(text).toContain('channel_send')
    expect(text).toContain('NO_REPLY')
    expect(text).toContain('invisible')
  })

  test('channel=true on a FAILED reminder also appends the nudge (failure still needs surfacing)', () => {
    const text = renderSubagentCompletionReminder({
      subagent: 'scout',
      taskId: 'bg_err',
      ok: false,
      durationMs: 1_500,
      error: 'rate limit',
      channel: true,
    })
    expect(text).toContain('FAILED')
    expect(text).toContain('rate limit')
    expect(text).toContain('channel_reply')
  })

  test('channel undefined / false: no channel_reply nudge (TUI/cron paths keep the existing wording)', () => {
    const tuiText = renderSubagentCompletionReminder({
      subagent: 'explorer',
      taskId: 'bg_xyz',
      ok: true,
      durationMs: 5_000,
    })
    expect(tuiText).not.toContain('channel_reply')
    expect(tuiText).not.toContain('invisible')

    const explicitFalse = renderSubagentCompletionReminder({
      subagent: 'explorer',
      taskId: 'bg_xyz',
      ok: true,
      durationMs: 5_000,
      channel: false,
    })
    expect(explicitFalse).not.toContain('channel_reply')
  })

  test('channel=true + adapter=github appends the formal-review carve-out so a finished reviewer is posted via gh api, not a channel_reply', () => {
    const text = renderSubagentCompletionReminder({
      subagent: 'reviewer',
      taskId: 'bg_rev',
      ok: true,
      durationMs: 73_000,
      channel: true,
      adapter: 'github',
    })
    expect(text).toContain('channel_reply')
    // Conditional phrasing ("if this was a PR review") is load-bearing: this
    // reminder fires on EVERY subagent completion in a github session, not
    // just review turns, so an imperative carve-out would misdirect a
    // non-review completion into the review API.
    expect(text).toMatch(/if this was a pr review/i)
    expect(text).toContain('/reviews')
    expect(text).toMatch(/formal review/i)
    expect(text).toMatch(/not a (plain )?`?channel_reply`?/i)
  })

  test('adapter=github WITHOUT channel=true does not add the github carve-out (TUI github sessions are not a thing, but guard against accidental injection)', () => {
    const text = renderSubagentCompletionReminder({
      subagent: 'reviewer',
      taskId: 'bg_rev',
      ok: true,
      durationMs: 1_000,
      adapter: 'github',
    })
    expect(text).not.toContain('/reviews')
    expect(text).not.toContain('channel_reply')
  })

  test('channel=true + non-github adapter keeps only the base nudge (no gh api leakage into slack/discord/telegram/kakaotalk)', () => {
    for (const adapter of ['slack-bot', 'discord-bot', 'telegram-bot', 'kakaotalk']) {
      const text = renderSubagentCompletionReminder({
        subagent: 'reviewer',
        taskId: 'bg_rev',
        ok: true,
        durationMs: 1_000,
        channel: true,
        adapter,
      })
      expect(text).toContain('channel_reply')
      expect(text).not.toContain('/reviews')
      expect(text).not.toContain('gh api')
    }
  })

  test('channel=true + adapter=github on a FAILED reminder still appends the carve-out', () => {
    const text = renderSubagentCompletionReminder({
      subagent: 'reviewer',
      taskId: 'bg_rev',
      ok: false,
      durationMs: 1_000,
      error: 'reviewer crashed',
      channel: true,
      adapter: 'github',
    })
    expect(text).toContain('FAILED')
    expect(text).toContain('/reviews')
  })
})

describe('formatReminderDuration', () => {
  test('sub-second values render in ms', () => {
    expect(formatReminderDuration(0)).toBe('0ms')
    expect(formatReminderDuration(999)).toBe('999ms')
  })

  test('sub-minute values render in s', () => {
    expect(formatReminderDuration(1_000)).toBe('1s')
    expect(formatReminderDuration(59_999)).toBe('59s')
  })

  test('values >= 1 minute render as Xm Ys', () => {
    expect(formatReminderDuration(60_000)).toBe('1m0s')
    expect(formatReminderDuration(90_500)).toBe('1m30s')
    expect(formatReminderDuration(3_600_000)).toBe('60m0s')
  })
})

describe('parseSubagentCompletedPayload', () => {
  test('valid payload narrows to SubagentCompletedPayload with all fields preserved', () => {
    const parsed = parseSubagentCompletedPayload({
      kind: 'subagent.completed',
      taskId: 'bg_xyz',
      subagent: 'explorer',
      parentSessionId: 'ses_abc',
      ok: true,
      durationMs: 5_000,
    })
    expect(parsed).not.toBeNull()
    expect(parsed!.taskId).toBe('bg_xyz')
    expect(parsed!.subagent).toBe('explorer')
    expect(parsed!.parentSessionId).toBe('ses_abc')
    expect(parsed!.ok).toBe(true)
    expect(parsed!.durationMs).toBe(5_000)
    expect(parsed!.error).toBeUndefined()
  })

  test('failed-completion payload preserves error string', () => {
    const parsed = parseSubagentCompletedPayload({
      kind: 'subagent.completed',
      taskId: 'bg_err',
      subagent: 'scout',
      parentSessionId: 'ses_abc',
      ok: false,
      durationMs: 1_500,
      error: 'provider rate limit',
    })
    expect(parsed?.ok).toBe(false)
    expect(parsed?.error).toBe('provider rate limit')
  })

  test('cancelled payload keeps its cancellation flag', () => {
    const parsed = parseSubagentCompletedPayload({
      kind: 'subagent.completed',
      taskId: 'bg_rev',
      subagent: 'reviewer',
      parentSessionId: 'ses_abc',
      ok: false,
      durationMs: 1_500,
      error: 'cancelled: pull request converted to draft',
      cancelled: true,
    })
    expect(parsed?.cancelled).toBe(true)
  })

  test('failed-completion payload preserves recoverability metadata but drops output bodies', () => {
    const parsed = parseSubagentCompletedPayload({
      kind: 'subagent.completed',
      taskId: 'bg_review',
      subagent: 'reviewer',
      parentSessionId: 'ses_abc',
      ok: false,
      durationMs: 600_000,
      error: 'timeout',
      hasRecoverableOutput: true,
      finalMessage: '<review>secret body</review>',
    })

    expect(parsed?.hasRecoverableOutput).toBe(true)
    expect(parsed).not.toHaveProperty('finalMessage')
  })

  test('preserves a valid channelKey (with null thread)', () => {
    const parsed = parseSubagentCompletedPayload({
      kind: 'subagent.completed',
      taskId: 'bg_rev',
      subagent: 'reviewer',
      parentSessionId: 'ses_abc',
      ok: true,
      durationMs: 1,
      channelKey: { adapter: 'github', workspace: 'acme', chat: 'acme/repo#1', thread: null },
    })
    expect(parsed!.channelKey).toEqual({ adapter: 'github', workspace: 'acme', chat: 'acme/repo#1', thread: null })
  })

  test('drops a malformed channelKey but keeps the rest of the payload', () => {
    const parsed = parseSubagentCompletedPayload({
      kind: 'subagent.completed',
      taskId: 'bg_rev',
      subagent: 'reviewer',
      parentSessionId: 'ses_abc',
      ok: true,
      durationMs: 1,
      channelKey: { adapter: 'github', workspace: 'acme' },
    })
    expect(parsed).not.toBeNull()
    expect(parsed!.channelKey).toBeUndefined()
  })

  test('non-completion kind returns null', () => {
    expect(parseSubagentCompletedPayload({ kind: 'tunnel-url-changed', parentSessionId: 'ses_abc' })).toBeNull()
    expect(parseSubagentCompletedPayload({ kind: 'noise' })).toBeNull()
  })

  test("missing parentSessionId returns null (can't route without it)", () => {
    expect(
      parseSubagentCompletedPayload({
        kind: 'subagent.completed',
        taskId: 'bg_xyz',
        subagent: 'explorer',
        ok: true,
        durationMs: 0,
      }),
    ).toBeNull()
  })

  test('non-object payloads return null', () => {
    expect(parseSubagentCompletedPayload(null)).toBeNull()
    expect(parseSubagentCompletedPayload(undefined)).toBeNull()
    expect(parseSubagentCompletedPayload('string')).toBeNull()
    expect(parseSubagentCompletedPayload(42)).toBeNull()
  })

  test('malformed fields fall back to defaults (taskId="<unknown>", subagent="subagent", durationMs=0, ok=false)', () => {
    const parsed = parseSubagentCompletedPayload({
      kind: 'subagent.completed',
      parentSessionId: 'ses_abc',
    })
    expect(parsed?.taskId).toBe('<unknown>')
    expect(parsed?.subagent).toBe('subagent')
    expect(parsed?.durationMs).toBe(0)
    expect(parsed?.ok).toBe(false)
  })
})
