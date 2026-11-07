import { describe, expect, it } from 'bun:test'

import { remediateToolErrorMessage } from './tool-error-remediation'

describe('remediateToolErrorMessage', () => {
  it('appends a read-first hint to an edit oldText-mismatch error', () => {
    const message =
      'Could not find edits[0] in src/foo.ts. The oldText must match exactly including all whitespace and newlines.'

    const result = remediateToolErrorMessage('edit', message)

    expect(result.startsWith(message)).toBe(true)
    expect(result).toContain('Re-read the file with the `read` tool')
  })

  it('appends a no-op hint to an identical-content edit error', () => {
    const message =
      'No changes made to src/foo.ts. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.'

    const result = remediateToolErrorMessage('edit', message)

    expect(result).toContain('the edit is a no-op')
  })

  it('appends a path hint to the file-safety authorization error the wrapper actually surfaces', () => {
    // enforceAndPinToolFiles throws THIS (not upstream `File not found:`) for a
    // missing input path, before tool.execute runs — the common missing-path case.
    const message = 'tool input did not exist while being authorized: src/missing.ts'

    expect(remediateToolErrorMessage('read', message)).toContain('the path does not exist')
    expect(remediateToolErrorMessage('grep', message)).toContain('the path does not exist')
    expect(remediateToolErrorMessage('find', message)).toContain('the path does not exist')
    expect(remediateToolErrorMessage('ls', message)).toContain('the path does not exist')
  })

  it('still appends a path-verification hint to the raw upstream not-found fallback', () => {
    expect(remediateToolErrorMessage('read', 'File not found: src/missing.ts')).toContain(
      'verify the path before retrying',
    )
    expect(remediateToolErrorMessage('ls', 'Path not found: src/missing/')).toContain('verify the path before retrying')
    expect(remediateToolErrorMessage('grep', 'Path not found: src/missing/')).toContain(
      'verify the path before retrying',
    )
    expect(remediateToolErrorMessage('find', 'Path not found: src/missing/')).toContain(
      'verify the path before retrying',
    )
  })

  it('appends an offset hint to a read beyond-end-of-file error', () => {
    const result = remediateToolErrorMessage('read', 'Offset 5000 is beyond end of file (120 lines total)')

    expect(result).toContain('fewer lines than the offset')
  })

  it('does not fire a rule for a tool it is not scoped to', () => {
    // the offset rule is `read`-only: the same text under another tool is left alone
    const offset = 'Offset 5000 is beyond end of file (120 lines total)'
    expect(remediateToolErrorMessage('edit', offset)).toBe(offset)

    // the edit not-found rule must not fire for `read`
    const editNotFound = 'Could not find edits[0] in src/foo.ts. The oldText must match exactly.'
    expect(remediateToolErrorMessage('read', editNotFound)).toBe(editNotFound)
  })

  it('leaves unrecognized errors untouched', () => {
    const message = 'Some entirely unrelated failure that has no remediation rule'

    expect(remediateToolErrorMessage('edit', message)).toBe(message)
  })

  it('tells bash that a timeout after printed output means the command never exited', () => {
    // given: the upstream bash timeout status after the command already printed its result
    const message = '- textbox "아이디" [ref=e20]\n- button "로그인" [ref=e22]\n\nCommand timed out after 15 seconds'

    const result = remediateToolErrorMessage('bash', message)

    expect(result.startsWith(message)).toBe(true)
    expect(result).toContain('did not exit')
  })

  it('leaves a bash timeout with no output undecorated', () => {
    // nothing was printed, so there is no evidence the work finished
    const message = 'Command timed out after 15 seconds'

    expect(remediateToolErrorMessage('bash', message)).toBe(message)
  })

  it('does not decorate bash sandbox / subagent-policy errors', () => {
    // given: bash-only internal control errors (bash is in no rule's tool set)
    const sandbox = 'model-driven bash has no permission service; refusing unsandboxed execution'
    const subagentPolicy = 'blocked: command `rm` is not permitted for a read-only subagent'

    // then: never decorated
    expect(remediateToolErrorMessage('bash', sandbox)).toBe(sandbox)
    expect(remediateToolErrorMessage('bash', subagentPolicy)).toBe(subagentPolicy)
  })

  it('does not decorate an abort error on a file tool', () => {
    const abort = 'Operation aborted'

    expect(remediateToolErrorMessage('edit', abort)).toBe(abort)
    expect(remediateToolErrorMessage('read', abort)).toBe(abort)
  })

  it('is idempotent — a message already carrying the hint is not double-decorated', () => {
    const once = remediateToolErrorMessage('read', 'File not found: src/missing.ts')
    const twice = remediateToolErrorMessage('read', once)

    expect(twice).toBe(once)
  })

  it('preserves a non-ASCII path in the decorated message', () => {
    // typeclaw is multi-language: paths may be non-Latin. The original message
    // (including its path) must survive verbatim ahead of the hint.
    const message = 'File not found: 문서/보고서.txt'

    const result = remediateToolErrorMessage('read', message)

    expect(result.startsWith('File not found: 문서/보고서.txt')).toBe(true)
    expect(result).toContain('verify the path before retrying')
  })

  it('returns an empty string unchanged', () => {
    expect(remediateToolErrorMessage('read', '')).toBe('')
  })
})
