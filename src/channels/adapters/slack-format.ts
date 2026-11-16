// Convert the model's common-Markdown (GFM) output to Slack mrkdwn.
//
// Why this exists: the agent writes GitHub-Flavored Markdown the way a
// human types it (`**bold**`, `## heading`, `[text](url)`, tables). For a
// normal chat post the slack-bot adapter wraps that GFM in a Slack
// `markdown` block and Slack renders it natively — so no conversion is
// needed there. But some outbound fields cannot carry a `markdown` block:
// a file upload's `initial_comment` (files.uploadV2 has no `blocks`
// param) and the user-account adapter's plain `chat.postMessage` text.
// Those are parsed as Slack *mrkdwn*, where bold is a SINGLE `*`, so raw
// GFM `**bold**` renders as literal double asterisks. This converter
// bridges GFM -> mrkdwn for exactly those constrained fields.
//
// Slack mrkdwn is forgiving (unlike Telegram MarkdownV2, there is no
// escaping that can crash the parser), so this is a best-effort semantic
// translation, not a safety escape. Constructs mrkdwn cannot represent
// (headings, tables) degrade to the closest readable form.
//
// Slack mrkdwn spec (https://docs.slack.dev/messaging/formatting-message-text):
//   - bold:   *text*
//   - italic: _text_
//   - strike: ~text~
//   - link:   <url|label>
//   - code:   `code`, ```block```
//   - quote:  > line
//   No native heading or table syntax exists.

export function toSlackMrkdwn(input: string): string {
  if (input === '') return ''
  const lines = input.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!

    if (isFenceOpen(line)) {
      // Emit the fence and its body verbatim — a `*` inside a code block is
      // literal, never italic. Scan to the closing fence (or EOF).
      out.push(line)
      i++
      while (i < lines.length && !isFenceClose(lines[i]!)) {
        out.push(lines[i]!)
        i++
      }
      if (i < lines.length) {
        out.push(lines[i]!)
        i++
      }
      continue
    }

    if (isTableSeparatorRow(line) && out.length > 0 && isTableRow(lines[i - 1])) {
      // GFM alignment row (`| --- | :--: |`) has no mrkdwn equivalent; drop
      // it. The header row above and the data rows below stay as plain
      // pipe-separated text, which reads fine in monospace-free mrkdwn.
      i++
      continue
    }

    out.push(renderLine(line))
    i++
  }
  return out.join('\n')
}

function isFenceOpen(line: string): boolean {
  return /^\s*```/.test(line)
}

function isFenceClose(line: string): boolean {
  return /^\s*```\s*$/.test(line)
}

function isTableRow(line: string | undefined): boolean {
  if (line === undefined) return false
  return /^\s*\|.*\|\s*$/.test(line)
}

function isTableSeparatorRow(line: string): boolean {
  return /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(line)
}

// A heading line (`#`..`######` then space) has no mrkdwn equivalent, so
// render its inline-converted text as a bold line. A `#` that is not at the
// line start (e.g. `issue #42`) is not a heading and falls through. Inner
// bold is flattened to plain (`flattenBold`) because mrkdwn has no
// bold-inside-bold — the whole heading line is already bold, so a nested
// `*..*` would just emit a stray unbalanced `*`. Flattening happens INSIDE
// the tokenizer so code spans stay protected: a global post-pass regex
// would corrupt a `*` that lives inside a heading's inline code.
const HEADING = /^(#{1,6})\s+(.*)$/

function renderLine(line: string): string {
  const heading = HEADING.exec(line)
  if (heading !== null) {
    const body = renderInline(heading[2]!, { flattenBold: true })
    return body === '' ? '' : `*${body}*`
  }
  return renderInline(line)
}

type InlineOptions = { flattenBold: boolean }

// Inline tokenizer. Recognizes, in priority order:
//   1. inline code:  `code`
//   2. link:         [label](url)   -> <url|label>
//   3. bold:         **text** / __text__ -> *text*  (or plain when flattenBold)
//   4. strike:       ~~text~~       -> ~text~
//   5. italic:       *text* / _text_ -> _text_
//
// Italic is last so `**` is consumed as bold, not two italics. Everything
// unrecognized is emitted verbatim — Slack mrkdwn needs no escaping.
function renderInline(text: string, options: InlineOptions = { flattenBold: false }): string {
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]!

    if (ch === '`') {
      const close = text.indexOf('`', i + 1)
      if (close !== -1) {
        out.push(text.slice(i, close + 1))
        i = close + 1
        continue
      }
    }

    if (ch === '[') {
      const link = parseLink(text, i)
      if (link !== null) {
        out.push(`<${link.url}|${renderInline(link.label, options)}>`)
        i = link.end
        continue
      }
    }

    if (ch === '*' && text[i + 1] === '*') {
      const close = findClose(text, i + 2, '**')
      if (close > i + 2) {
        const inner = renderInline(text.slice(i + 2, close), options)
        out.push(options.flattenBold ? inner : `*${inner}*`)
        i = close + 2
        continue
      }
    }

    // `__bold__` only when not adjacent to a word char on either side, so a
    // snake_case identifier the model wrote (`my__var__name`) is left alone.
    if (ch === '_' && text[i + 1] === '_' && !isWordChar(text[i - 1])) {
      const close = findClose(text, i + 2, '__')
      if (close > i + 2 && !isWordChar(text[close + 2])) {
        const inner = renderInline(text.slice(i + 2, close), options)
        out.push(options.flattenBold ? inner : `*${inner}*`)
        i = close + 2
        continue
      }
    }

    if (ch === '~' && text[i + 1] === '~') {
      const close = findClose(text, i + 2, '~~')
      if (close > i + 2) {
        out.push(`~${renderInline(text.slice(i + 2, close), options)}~`)
        i = close + 2
        continue
      }
    }

    // Italic: word-boundary guard on both sides so `a*b*c` and identifiers
    // don't italicize. The guards are ASCII word chars by design — they
    // gate on the model's Latin identifier/math usage; CJK/Korean text has
    // no such tokens, so bold/italic markers around Korean still convert.
    if (ch === '*' && !isWordChar(text[i - 1])) {
      const close = findInlineClose(text, i + 1, '*')
      if (close !== -1 && !isWordChar(text[close + 1])) {
        const inner = text.slice(i + 1, close)
        if (inner !== '' && !/^\s|\s$/.test(inner)) {
          out.push(`_${renderInline(inner, options)}_`)
          i = close + 1
          continue
        }
      }
    }
    if (ch === '_' && !isWordChar(text[i - 1])) {
      const close = findInlineClose(text, i + 1, '_')
      if (close !== -1 && !isWordChar(text[close + 1])) {
        const inner = text.slice(i + 1, close)
        if (inner !== '' && !/^\s|\s$/.test(inner)) {
          out.push(`_${renderInline(inner, options)}_`)
          i = close + 1
          continue
        }
      }
    }

    out.push(ch)
    i++
  }
  return out.join('')
}

function findClose(text: string, from: number, marker: string): number {
  let i = from
  while (i <= text.length - marker.length) {
    if (text.slice(i, i + marker.length) === marker) return i
    i++
  }
  return -1
}

function findInlineClose(text: string, from: number, marker: string): number {
  let i = from
  while (i < text.length) {
    if (text[i] === '\n') return -1
    if (text[i] === marker) return i
    i++
  }
  return -1
}

function parseLink(text: string, start: number): { label: string; url: string; end: number } | null {
  let i = start + 1
  const labelStart = i
  while (i < text.length) {
    const c = text[i]!
    if (c === ']') break
    if (c === '\n') return null
    i++
  }
  if (text[i] !== ']' || text[i + 1] !== '(') return null
  const label = text.slice(labelStart, i)
  const urlStart = i + 2
  let j = urlStart
  while (j < text.length) {
    const c = text[j]!
    if (c === ')') break
    if (c === '(' || c === '\n') return null
    j++
  }
  if (text[j] !== ')') return null
  return { label, url: text.slice(urlStart, j), end: j + 1 }
}

function isWordChar(ch: string | undefined): boolean {
  if (ch === undefined) return false
  return /[A-Za-z0-9_]/.test(ch)
}
