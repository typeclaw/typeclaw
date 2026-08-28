import { describe, expect, test } from 'bun:test'

import { normalizeWebexHtmlFallbackText, resolveWebexBodyText, splitWebexFiles } from './webex-format'

describe('normalizeWebexHtmlFallbackText', () => {
  test('decodes named and numeric entities', () => {
    expect(normalizeWebexHtmlFallbackText('You&apos;re paired')).toBe("You're paired")
    expect(normalizeWebexHtmlFallbackText('You&#39;re paired')).toBe("You're paired")
    expect(normalizeWebexHtmlFallbackText('a &amp; b &lt; c &gt; d &quot;e&quot;')).toBe('a & b < c > d "e"')
  })

  test('converts <br/> to newlines and strips other tags', () => {
    expect(normalizeWebexHtmlFallbackText('line 1<br/>line 2')).toBe('line 1\nline 2')
    expect(normalizeWebexHtmlFallbackText('para 1<br/><br/>para 2')).toBe('para 1\n\npara 2')
    expect(normalizeWebexHtmlFallbackText('<p>para 1</p><p>para 2</p>')).toBe('para 1\n\npara 2')
    expect(normalizeWebexHtmlFallbackText('a <strong>bold</strong> b')).toBe('a bold b')
  })

  test('preserves non-Latin content while decoding entities and breaks', () => {
    expect(normalizeWebexHtmlFallbackText('확인해볼게요<br/>안녕하세요')).toBe('확인해볼게요\n안녕하세요')
    expect(normalizeWebexHtmlFallbackText('日本語&amp;テスト')).toBe('日本語&テスト')
  })

  test('combined real-world fallback', () => {
    expect(normalizeWebexHtmlFallbackText('You&apos;re paired<br/><br/>혹시 맥락 있으면 알려주세요')).toBe(
      "You're paired\n\n혹시 맥락 있으면 알려주세요",
    )
  })
})

describe('resolveWebexBodyText', () => {
  test('prefers raw plain text without normalizing literal entities', () => {
    expect(resolveWebexBodyText({ text: 'a & b < c', markdown: 'x', html: 'y' })).toBe('a & b < c')
  })

  test('falls back to raw markdown without normalizing', () => {
    expect(resolveWebexBodyText({ text: undefined, markdown: '**bold** & raw', html: 'y' })).toBe('**bold** & raw')
    expect(resolveWebexBodyText({ text: '', markdown: '**bold** & raw', html: 'y' })).toBe('**bold** & raw')
  })

  test('normalizes only the html fallback', () => {
    expect(resolveWebexBodyText({ text: undefined, markdown: undefined, html: 'You&apos;re here<br/>line 2' })).toBe(
      "You're here\nline 2",
    )
  })

  test('returns empty string when no body present', () => {
    expect(resolveWebexBodyText({ text: undefined, markdown: undefined, html: undefined })).toBe('')
    expect(resolveWebexBodyText({ text: '', markdown: '', html: '' })).toBe('')
  })
})

describe('splitWebexFiles', () => {
  test('numbers every file so each one is separately addressable', () => {
    const { text, attachments } = splitWebexFiles('two files', [
      'https://webexapis.com/v1/contents/AAA/photo.png',
      'https://webexapis.com/v1/contents/BBB/report.pdf',
    ])

    expect(text).toBe(
      'two files\n[Webex attachment #1: file name=photo.png]\n[Webex attachment #2: file name=report.pdf]',
    )
    expect(attachments.map((a) => [a.id, a.ref])).toEqual([
      [1, 'https://webexapis.com/v1/contents/AAA/photo.png'],
      [2, 'https://webexapis.com/v1/contents/BBB/report.pdf'],
    ])
  })

  test('a captionless file becomes the whole body', () => {
    expect(splitWebexFiles('', ['https://webexapis.com/v1/contents/AAA/photo.png']).text).toBe(
      '[Webex attachment #1: file name=photo.png]',
    )
  })

  test('falls back to a positional filename when the ref has no usable path', () => {
    expect(splitWebexFiles('', ['not-a-url']).attachments).toEqual([
      { id: 1, kind: 'file', ref: 'not-a-url', filename: 'webex-file-1' },
    ])
  })

  test('leaves text untouched when there are no files', () => {
    expect(splitWebexFiles('hello', undefined)).toEqual({ text: 'hello', attachments: [] })
    expect(splitWebexFiles('hello', [])).toEqual({ text: 'hello', attachments: [] })
  })
})
