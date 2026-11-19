import { EMBEDDING_DIMS } from '@/models/embedding-model'

import { type EmbedReply, embedRequest } from './embedder-wire'

const send = process.send?.bind(process)
if (send === undefined) process.exit(1)
process.on('disconnect', () => process.exit(0))

let releasePassage: (() => void) | undefined
process.on('message', async (message: unknown) => {
  const { id, type, texts } = embedRequest.parse(message)
  if (texts[0] === 'crash') process.exit(73)
  if (texts[0] === 'hang') return
  if (type === 'passage') {
    await new Promise<void>((resolve) => {
      releasePassage = resolve
    })
  }
  const vectors = texts.map((text) => {
    const vector = new Float32Array(EMBEDDING_DIMS)
    vector[0] = process.pid
    vector[1] = text.length
    vector[2] = Number(process.env.TYPECLAW_EMBED_TEST_SECRET !== undefined)
    return vector
  })
  send({ id, kind: 'result', vectors } satisfies EmbedReply)
  if (type === 'query') releasePassage?.()
})
