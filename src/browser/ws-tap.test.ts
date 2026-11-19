import { describe, expect, test } from 'bun:test'

import { createTextMessageTap } from './ws-tap'

type FrameOptions = { opcode?: number; fin?: boolean; mask?: boolean }

function frame(payload: string | Buffer, { opcode = 1, fin = true, mask = false }: FrameOptions = {}): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload) : payload
  const lengthBytes =
    body.length < 126
      ? Buffer.from([(mask ? 0x80 : 0) | body.length])
      : body.length < 65536
        ? Buffer.concat([Buffer.from([(mask ? 0x80 : 0) | 126]), u16(body.length)])
        : Buffer.concat([Buffer.from([(mask ? 0x80 : 0) | 127]), u64(body.length)])
  const head = Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode]), lengthBytes])
  if (!mask) return Buffer.concat([head, body])
  const key = Buffer.from([0x12, 0x34, 0x56, 0x78])
  return Buffer.concat([head, key, Buffer.from(body.map((byte, i) => byte ^ key[i % 4]!))])
}

function u16(value: number): Buffer {
  const out = Buffer.alloc(2)
  out.writeUInt16BE(value)
  return out
}

function u64(value: number): Buffer {
  const out = Buffer.alloc(8)
  out.writeBigUInt64BE(BigInt(value))
  return out
}

function collect(maxMessageBytes = 1024) {
  const seen: string[] = []
  return { seen, tap: createTextMessageTap((text) => seen.push(text), maxMessageBytes) }
}

describe('WebSocket text message tap', () => {
  test('reads masked client frames and unmasked server frames', () => {
    const { seen, tap } = collect()

    tap(frame('{"id":1}', { mask: true }))
    tap(frame('{"id":2}'))

    expect(seen).toEqual(['{"id":1}', '{"id":2}'])
  })

  test('reassembles frames split across arbitrary chunk boundaries', () => {
    const { seen, tap } = collect()
    const bytes = Buffer.concat([frame('first', { mask: true }), frame('한글 두번째', { mask: true })])

    for (const byte of bytes) tap(Buffer.from([byte]))

    expect(seen).toEqual(['first', '한글 두번째'])
  })

  test('joins a fragmented text message across an interleaved ping', () => {
    const { seen, tap } = collect()

    tap(frame('hel', { fin: false }))
    tap(frame('ping', { opcode: 9 }))
    tap(frame('lo', { opcode: 0 }))

    expect(seen).toEqual(['hello'])
  })

  test('skips binary and oversized messages and keeps reading after them', () => {
    const { seen, tap } = collect(100)

    tap(frame(Buffer.alloc(300, 1), { opcode: 2 }))
    tap(frame('x'.repeat(70_000)))
    tap(frame('small', { fin: false }))
    tap(frame('y'.repeat(200), { opcode: 0 }))
    tap(frame('after'))

    expect(seen).toEqual(['after'])
  })
})
