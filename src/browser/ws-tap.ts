// Watches one direction of a WebSocket byte stream that is forwarded unchanged
// and reports each complete text message no larger than `maxMessageBytes`.
// Bigger messages (screenshots, DOM snapshots) are skipped without being
// buffered, so the tap holds at most one small message plus a frame header.
// Assumes no permessage-deflate: the relay strips the extension offer.
export function createTextMessageTap(onText: (text: string) => void, maxMessageBytes: number): (chunk: Buffer) => void {
  let pending: Buffer = Buffer.alloc(0)
  let skipBytes = 0
  let message: 'none' | 'collecting' | 'skipping' = 'none'
  let fragments: Buffer[] = []
  let collectedBytes = 0

  const finishMessage = (): void => {
    if (message === 'collecting') onText(Buffer.concat(fragments).toString('utf8'))
    message = 'none'
    fragments = []
    collectedBytes = 0
  }

  return (chunk) => {
    const data = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
    pending = Buffer.alloc(0)
    let offset = 0
    while (offset < data.length) {
      if (skipBytes > 0) {
        const skipped = Math.min(skipBytes, data.length - offset)
        skipBytes -= skipped
        offset += skipped
        continue
      }
      const header = readFrameHeader(data, offset)
      if (header === undefined) {
        pending = Buffer.from(data.subarray(offset))
        return
      }
      const payloadStart = offset + header.headerBytes
      const isControl = header.opcode >= 8
      const startsText = header.opcode === 1
      const continues = header.opcode === 0
      if (!isControl && !continues) {
        message = startsText && header.length <= maxMessageBytes ? 'collecting' : 'skipping'
        fragments = []
        collectedBytes = 0
      } else if (continues && message === 'collecting' && collectedBytes + header.length > maxMessageBytes) {
        message = 'skipping'
        fragments = []
      }
      const wanted = !isControl && message === 'collecting'
      if (!wanted) {
        skipBytes = header.length
        offset = payloadStart
        if (!isControl && header.fin) finishMessage()
        continue
      }
      if (data.length - payloadStart < header.length) {
        pending = Buffer.from(data.subarray(offset))
        return
      }
      const payload = Buffer.from(data.subarray(payloadStart, payloadStart + header.length))
      if (header.mask !== undefined) {
        for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ header.mask[i % 4]!
      }
      fragments.push(payload)
      collectedBytes += payload.length
      offset = payloadStart + header.length
      if (header.fin) finishMessage()
    }
  }
}

type FrameHeader = { fin: boolean; opcode: number; length: number; mask: Buffer | undefined; headerBytes: number }

function readFrameHeader(data: Buffer, offset: number): FrameHeader | undefined {
  if (data.length - offset < 2) return undefined
  const first = data[offset]!
  const second = data[offset + 1]!
  const masked = (second & 0x80) !== 0
  let length = second & 0x7f
  let headerBytes = 2
  if (length === 126) {
    if (data.length - offset < 4) return undefined
    length = data.readUInt16BE(offset + 2)
    headerBytes = 4
  } else if (length === 127) {
    if (data.length - offset < 10) return undefined
    length = Number(data.readBigUInt64BE(offset + 2))
    headerBytes = 10
  }
  let mask: Buffer | undefined
  if (masked) {
    if (data.length - offset < headerBytes + 4) return undefined
    mask = Buffer.from(data.subarray(offset + headerBytes, offset + headerBytes + 4))
    headerBytes += 4
  }
  return { fin: (first & 0x80) !== 0, opcode: first & 0x0f, length, mask, headerBytes }
}
