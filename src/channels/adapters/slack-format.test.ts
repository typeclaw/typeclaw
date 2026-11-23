import { describe, expect, it } from 'bun:test'

import { toSlackMrkdwn } from './slack-format'

describe('toSlackMrkdwn', () => {
  describe('bold', () => {
    it('converts **bold** to *bold*', () => {
      expect(toSlackMrkdwn('**bold**')).toBe('*bold*')
    })

    it('converts __bold__ to *bold*', () => {
      expect(toSlackMrkdwn('__bold__')).toBe('*bold*')
    })

    it('converts multiple bold spans on one line', () => {
      expect(toSlackMrkdwn('**a** and **b**')).toBe('*a* and *b*')
    })

    it('leaves an unbalanced ** as a literal', () => {
      expect(toSlackMrkdwn('a ** b')).toBe('a ** b')
    })

    it('does not treat snake_case __ as bold', () => {
      expect(toSlackMrkdwn('my__var__name')).toBe('my__var__name')
    })
  })

  describe('italic', () => {
    it('converts *italic* to _italic_', () => {
      expect(toSlackMrkdwn('*italic*')).toBe('_italic_')
    })

    it('keeps _italic_ as _italic_', () => {
      expect(toSlackMrkdwn('_italic_')).toBe('_italic_')
    })

    it('does not italicize a lone asterisk mid-word', () => {
      expect(toSlackMrkdwn('a*b*c')).toBe('a*b*c')
    })

    it('does not italicize inside identifiers', () => {
      expect(toSlackMrkdwn('var_name_here')).toBe('var_name_here')
    })

    it('converts bold+italic combination', () => {
      expect(toSlackMrkdwn('**bold** and *italic*')).toBe('*bold* and _italic_')
    })
  })

  describe('strikethrough', () => {
    it('converts ~~strike~~ to ~strike~', () => {
      expect(toSlackMrkdwn('~~strike~~')).toBe('~strike~')
    })
  })

  describe('links', () => {
    it('converts [label](url) to <url|label>', () => {
      expect(toSlackMrkdwn('[Docs](https://example.com)')).toBe('<https://example.com|Docs>')
    })

    it('converts a bold label inside a link', () => {
      expect(toSlackMrkdwn('[**Docs**](https://example.com)')).toBe('<https://example.com|*Docs*>')
    })

    it('drops the delimiters of an angle-bracket destination', () => {
      expect(toSlackMrkdwn('[Doc](<https://example.com/a?x=1&range=A1:B2>) · [Sheet](<https://example.com/b>)')).toBe(
        '<https://example.com/a?x=1&range=A1:B2|Doc> · <https://example.com/b|Sheet>',
      )
    })

    it('keeps parentheses inside an angle-bracket destination', () => {
      expect(toSlackMrkdwn('[Wiki](<https://example.com/Foo_(bar)>)')).toBe('<https://example.com/Foo_(bar)|Wiki>')
    })

    it('leaves an autolink-style bare url untouched', () => {
      expect(toSlackMrkdwn('see https://example.com now')).toBe('see https://example.com now')
    })
  })

  describe('headings', () => {
    it('renders # heading as bold line', () => {
      expect(toSlackMrkdwn('# Title')).toBe('*Title*')
    })

    it('renders ### heading as bold line', () => {
      expect(toSlackMrkdwn('### Deep')).toBe('*Deep*')
    })

    it('flattens inner bold inside a heading (no nested bold in mrkdwn)', () => {
      expect(toSlackMrkdwn('## Status **live**')).toBe('*Status live*')
    })

    it('keeps italic inside a heading', () => {
      expect(toSlackMrkdwn('## Report *(draft)*')).toBe('*Report _(draft)_*')
    })

    it('preserves inline code inside a heading (bold-flatten must not touch code spans)', () => {
      expect(toSlackMrkdwn('# Formula `a*b*c`')).toBe('*Formula `a*b*c`*')
    })

    it('flattens bold but preserves adjacent inline code in a heading', () => {
      expect(toSlackMrkdwn('## Run **now** with `x*y`')).toBe('*Run now with `x*y`*')
    })

    it('does not treat a mid-line hash as a heading', () => {
      expect(toSlackMrkdwn('issue #42 is open')).toBe('issue #42 is open')
    })
  })

  describe('code protection', () => {
    it('leaves inline code contents untouched', () => {
      expect(toSlackMrkdwn('`**not bold**`')).toBe('`**not bold**`')
    })

    it('leaves fenced code block contents untouched', () => {
      const input = '```\n**still literal** _here_\n```'
      expect(toSlackMrkdwn(input)).toBe(input)
    })

    it('preserves a fenced block with a language hint verbatim', () => {
      const input = '```ts\nconst x = a ** b\n```'
      expect(toSlackMrkdwn(input)).toBe(input)
    })

    it('converts markdown around a fenced block but not inside it', () => {
      const input = '**before**\n```\n**inside**\n```\n**after**'
      expect(toSlackMrkdwn(input)).toBe('*before*\n```\n**inside**\n```\n*after*')
    })
  })

  describe('blockquotes and lists', () => {
    it('preserves blockquote markers and converts inline markdown', () => {
      expect(toSlackMrkdwn('> **quoted**')).toBe('> *quoted*')
    })

    it('preserves list markers and converts inline markdown', () => {
      expect(toSlackMrkdwn('- **item**')).toBe('- *item*')
    })
  })

  describe('tables', () => {
    it('degrades a GFM table to plain pipe-separated rows without the alignment row', () => {
      const input = ['| A | B |', '| --- | --- |', '| 1 | 2 |'].join('\n')
      const out = toSlackMrkdwn(input)
      expect(out).not.toContain('---')
      expect(out).toContain('A')
      expect(out).toContain('B')
      expect(out).toContain('1')
      expect(out).toContain('2')
    })
  })

  describe('non-Latin script (CJK bold headers)', () => {
    it('converts bold markers wrapping CJK text', () => {
      const input = ['**状態の分布**', '- 予定: 235', '', '**スプリント W2**', '16 チケット'].join('\n')
      const out = toSlackMrkdwn(input)
      expect(out).toContain('*状態の分布*')
      expect(out).toContain('*スプリント W2*')
      expect(out).not.toContain('**')
    })
  })

  describe('idempotency-ish', () => {
    it('returns empty string for empty input', () => {
      expect(toSlackMrkdwn('')).toBe('')
    })
  })
})
