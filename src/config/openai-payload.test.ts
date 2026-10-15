import { expect, test } from 'bun:test'

import { normalizeContext, type Model } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/api/openai-responses'

import { resolveModel } from './config'
import { KNOWN_PROVIDERS } from './providers'

for (const id of Object.keys(KNOWN_PROVIDERS.openai.models)) {
  test(`${id} preserves optional tool parameters in Responses requests`, async () => {
    const payload = await capturePayload(resolveModel(`openai/${id}`) as Model<'openai-responses'>)
    expect(payload).toMatchObject({
      tools: [
        {
          name: 'channel_reply',
          strict: false,
          parameters: { required: ['text'] },
        },
      ],
    })
  })
}

async function capturePayload(model: Model<'openai-responses'>): Promise<unknown> {
  let payload: unknown
  const stream = streamSimple(
    model,
    normalizeContext({
      messages: [{ role: 'user', content: 'Hello', timestamp: 0 }],
      tools: [
        {
          name: 'channel_reply',
          description: 'Reply with optional attachments',
          parameters: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              attachments: { type: 'array', items: { type: 'string' }, minItems: 1 },
            },
            required: ['text'],
          },
        },
      ],
    }),
    {
      apiKey: 'test-key',
      onPayload: (value) => {
        payload = value
        throw new Error('payload-captured')
      },
    },
  )
  await stream.result()
  expect(payload).toBeDefined()
  return payload
}
