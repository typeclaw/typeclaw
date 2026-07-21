import { readResponseBodyBounded } from '@/agent/network/response-body'
import { DEFAULT_MODEL_TOOL_LIMITS } from '@/config'

export const DEFAULT_ATTACHMENT_MAX_BYTES = DEFAULT_MODEL_TOOL_LIMITS.channelAttachmentMaxBytes

export async function readAttachmentResponse(response: Response, maxBytes: number): Promise<Buffer> {
  try {
    return await readResponseBodyBounded(response, maxBytes)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('response is too large')) {
      throw new Error(error.message.replace('response is too large', 'attachment is too large'))
    }
    throw error
  }
}

export async function discardAttachmentResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

export async function readAttachmentErrorSnippet(response: Response): Promise<string> {
  try {
    const buffer = await readAttachmentResponse(response, 1024)
    return buffer.toString('utf8').slice(0, 200)
  } catch {
    await discardAttachmentResponse(response)
    return ''
  }
}

export function enforceAttachmentMetadataSize(size: number | undefined, maxBytes: number): void {
  if (size === undefined || !Number.isSafeInteger(size) || size < 0) {
    throw new Error('attachment size is unknown; refusing an unbounded SDK download')
  }
  if (size > maxBytes) throw attachmentTooLarge(size, maxBytes)
}

export function enforceAttachmentBufferSize(buffer: Buffer, maxBytes: number): void {
  if (buffer.byteLength > maxBytes) throw attachmentTooLarge(buffer.byteLength, maxBytes)
}

function attachmentTooLarge(size: number, maxBytes: number): Error {
  return new Error(`attachment is too large (${size} bytes > ${maxBytes} byte limit)`)
}
