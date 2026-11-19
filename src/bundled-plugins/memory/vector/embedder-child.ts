import { embed } from './embedder-inference'
import { type EmbedReply, embedRequest } from './embedder-wire'

const send = process.send
// Also covers the race where the parent died before Linux setpriv armed
// PR_SET_PDEATHSIG. On other platforms, IPC close handles later parent exit.
if (send === undefined || Number(process.argv[2]) !== process.ppid || !process.connected) process.exit(1)
process.on('disconnect', () => process.exit(0))

process.on('message', async (message: unknown) => {
  const request = embedRequest.safeParse(message)
  if (!request.success) process.exit(1)
  const { id, texts, type } = request.data
  const sendReply = (reply: EmbedReply) =>
    send.call(process, reply, (error) => {
      if (error) process.exit(1)
    })
  let reply: EmbedReply
  try {
    const vectors = await embed(
      texts,
      type,
      type === 'passage' ? (completed) => sendReply({ id, kind: 'progress', completed }) : undefined,
    )
    reply = { id, kind: 'result', vectors }
  } catch (error) {
    reply = { id, kind: 'error', message: error instanceof Error ? error.message : String(error) }
  }
  sendReply(reply)
})
