import { describe, expect, test } from 'bun:test'
import { PassThrough, Writable } from 'node:stream'

import { parsePastedManifestCode } from '@/init/github-app-manifest'

import { waitForManifestCode } from './github-app-auth'

const SECRET_CODE = 'c0ffee1234567890'
const PASTED_URL = `http://127.0.0.1:5000/callback?code=${SECRET_CODE}&state=st`

function terminal(): {
  input: PassThrough
  output: Writable
  rendered: () => string
  renders: (text: string) => Promise<void>
} {
  const chunks: string[] = []
  const waiters: Array<{ text: string; resolve: () => void }> = []
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk))
      const all = chunks.join('')
      for (const waiter of waiters.filter((w) => all.includes(w.text))) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve()
      }
      callback()
    },
  })
  const rendered = () => chunks.join('')
  const renders = (text: string) =>
    rendered().includes(text) ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ text, resolve }))
  return { input: new PassThrough(), output, rendered, renders }
}

function session(code: Promise<string>) {
  return { code, parsePastedInput: (input: string) => parsePastedManifestCode(input, 'st') }
}

function typeInto(input: PassThrough, text: string): void {
  for (const char of text) input.write(char)
}

describe('waitForManifestCode', () => {
  test('accepts a pasted redirect URL without ever rendering it', async () => {
    const io = terminal()
    const waiting = waitForManifestCode(session(new Promise(() => undefined)), io)

    typeInto(io.input, `${PASTED_URL}\r`)

    expect(await waiting).toBe(SECRET_CODE)
    expect(io.rendered()).not.toContain(SECRET_CODE)
  })

  test('keeps a rejected paste hidden and still takes the code from the callback', async () => {
    const io = terminal()
    let deliver!: (code: string) => void
    const waiting = waitForManifestCode(
      session(
        new Promise((resolve) => {
          deliver = resolve
        }),
      ),
      io,
    )

    typeInto(io.input, `http://127.0.0.1:5000/callback?code=${SECRET_CODE}&state=other\r`)
    await io.renders('Paste the full URL')
    deliver('fromcallback')

    expect(await waiting).toBe('fromcallback')
    expect(io.rendered()).not.toContain(SECRET_CODE)
  })

  test('returns null on cancel without rendering what was typed', async () => {
    const io = terminal()
    const waiting = waitForManifestCode(session(new Promise(() => undefined)), io)

    typeInto(io.input, `${PASTED_URL}\u0003`)

    expect(await waiting).toBeNull()
    expect(io.rendered()).not.toContain(SECRET_CODE)
  })
})
