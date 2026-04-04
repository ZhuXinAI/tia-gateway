import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildOnboardCompletionMessages,
  listOnboardChannelOptions
} from '../src/cli/onboard.js'

test('listOnboardChannelOptions includes HTTP and WebSocket choices', () => {
  const { defaultSelection, options } = listOnboardChannelOptions(null)

  assert.equal(defaultSelection, 'wechat')
  assert.deepEqual(
    options.map((option) => option.type),
    ['wechat', 'whatsapp', 'telegram', 'lark', 'http', 'websocket']
  )
})

test('listOnboardChannelOptions defaults to the existing channel type when supported', () => {
  const { defaultSelection } = listOnboardChannelOptions({
    channels: [
      {
        type: 'websocket',
        port: 4312
      }
    ]
  })

  assert.equal(defaultSelection, 'websocket')
})

test('buildOnboardCompletionMessages tells standalone HTTP onboarding how to start and connect', () => {
  const messages = buildOnboardCompletionMessages({
    channelType: 'http',
    config: {
      channels: [
        {
          type: 'http',
          host: '127.0.0.1',
          port: 4311,
          serveWebApp: true
        }
      ]
    }
  })

  assert.deepEqual(messages, [
    'Onboarding complete.',
    'Start the gateway with "npx tia-gateway" to make this channel reachable.',
    'After it starts, open http://127.0.0.1:4311/.'
  ])
})

test('buildOnboardCompletionMessages reflects automatic post-onboard startup', () => {
  const messages = buildOnboardCompletionMessages({
    channelType: 'http',
    config: null,
    willStartGatewayAfterCompletion: true
  })

  assert.deepEqual(messages, ['Onboarding complete. Starting gateway...'])
})
