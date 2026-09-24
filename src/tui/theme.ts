import type { EditorTheme, MarkdownTheme } from '@earendil-works/pi-tui'

const wrap = (code: string) => (text: string) => `\x1b[${code}m${text}\x1b[0m`
const wrapRgb = (r: number, g: number, b: number) => (text: string) => `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`

const dim = wrap('2')
const bold = wrap('1')
const red = wrap('31')
const green = wrap('32')
const yellow = wrap('33')
const cyan = wrap('36')
const gray = wrap('90')
const brightGreen = wrap('92')
const brightCyan = wrap('96')
const brightMagenta = wrap('95')

// Sampled from the typeey mascot. True navy (#182A5B) is too dark to read on
// dark terminals, so `accent` is a lifted cornflower of the same hue; amber is
// the mascot's beak/feet highlight.
const cornflower = wrapRgb(0x5b, 0x7f, 0xd4)
const amber = wrapRgb(0xe7, 0x8f, 0x37)
const accent = cornflower

export const colors = {
  dim,
  bold,
  red,
  green,
  yellow,
  cyan,
  gray,
  brightGreen,
  brightCyan,
  brightMagenta,
  cornflower,
  amber,
  accent,
}

export const editorTheme: EditorTheme = {
  borderColor: dim,
  selectList: {
    selectedPrefix: cyan,
    selectedText: bold,
    description: dim,
    scrollInfo: dim,
    noMatch: dim,
  },
}

export const markdownTheme: MarkdownTheme = {
  heading: bold,
  link: cyan,
  linkUrl: (text) => dim(`(${text})`),
  code: yellow,
  codeBlock: yellow,
  codeBlockBorder: dim,
  quote: dim,
  quoteBorder: dim,
  hr: dim,
  listBullet: cyan,
  bold,
  italic: (text) => `\x1b[3m${text}\x1b[23m`,
  strikethrough: (text) => `\x1b[9m${text}\x1b[29m`,
  underline: (text) => `\x1b[4m${text}\x1b[24m`,
}
