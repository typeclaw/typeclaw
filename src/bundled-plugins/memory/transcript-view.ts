// This is an extractor view only. The source transcript and its replay
// signatures remain authoritative and are never rewritten.
export function projectTranscriptLine(line: string): string {
  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch (error) {
    if (error instanceof SyntaxError) return line
    throw error
  }
  if (!isRecord(entry) || !isRecord(entry.message)) return line
  if (entry.message.role !== 'assistant') return line

  const message = { ...entry.message }
  for (const key of ['usage', 'api', 'provider', 'model', 'responseId']) delete message[key]
  if (Array.isArray(message.content)) {
    message.content = message.content.map((block: unknown) => {
      if (!isRecord(block)) return block
      if (block.type === 'toolCall') {
        const content = { ...block }
        delete content.thoughtSignature
        return content
      }
      if (block.type !== 'text' && block.type !== 'thinking') return block
      const content = { ...block }
      delete content.thinkingSignature
      delete content.textSignature
      return content
    })
  }
  return JSON.stringify({ ...entry, message })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
