import { describe, expect, it } from 'vitest'
import {
  isValidStatusTransition,
  mapZernioAttachmentType,
  mapZernioInbound,
  mapZernioOutboundEcho,
  mapZernioStatusEvent,
  type ZernioInboundMessage,
} from './inbound'

// A realistic message.received payload's `message` object, per
// Zernio's OpenAPI spec (InboxWebhookMessage).
function baseMessage(overrides: Partial<ZernioInboundMessage> = {}): ZernioInboundMessage {
  return {
    id: 'zm_100',
    conversationId: 'zc_1',
    platform: 'whatsapp',
    platformMessageId: 'wamid.INBOUND1',
    direction: 'incoming',
    text: 'Hola, quiero una cita',
    attachments: [],
    sender: {
      id: '34600111222',
      contactId: 'zct_9',
      name: 'Ana Pérez',
      phoneNumber: '+34600111222',
    },
    sentAt: '2026-07-06T10:15:30.000Z',
    isRead: false,
    ...overrides,
  }
}

describe('mapZernioInbound — text messages', () => {
  it('maps a plain text message to the wacrm message shape', () => {
    const mapped = mapZernioInbound(baseMessage())
    expect(mapped).toEqual({
      senderPhone: '34600111222', // digits-only, like the Meta webhook stores
      senderName: 'Ana Pérez',
      storedMessageId: 'wamid.INBOUND1', // wamid preferred over Zernio's id
      contentType: 'text',
      contentText: 'Hola, quiero una cita',
      mediaUrl: null,
      createdAtIso: '2026-07-06T10:15:30.000Z',
      zernioConversationId: 'zc_1',
    })
  })

  it('normalizes the sender phone from the +E.164 phoneNumber field', () => {
    const mapped = mapZernioInbound(
      baseMessage({ sender: { id: 'bsuid:xyz', phoneNumber: '+52 (155) 1234-5678' } }),
    )
    expect(mapped?.senderPhone).toBe('5215512345678')
  })

  it('falls back to sender.id when phoneNumber is absent', () => {
    const mapped = mapZernioInbound(
      baseMessage({ sender: { id: '34600111222', phoneNumber: null } }),
    )
    expect(mapped?.senderPhone).toBe('34600111222')
  })

  it('falls back to the phone as display name when the sender has none', () => {
    const mapped = mapZernioInbound(
      baseMessage({ sender: { id: '34600111222', phoneNumber: '+34600111222' } }),
    )
    expect(mapped?.senderName).toBe('34600111222')
  })

  it('returns null for a BSUID-only sender (no phone to anchor the contact)', () => {
    const mapped = mapZernioInbound(
      baseMessage({ sender: { id: 'bsuid:no-digits-here', phoneNumber: null } }),
    )
    expect(mapped).toBeNull()
  })

  it('falls back to Zernio internal id when platformMessageId is missing', () => {
    const mapped = mapZernioInbound(baseMessage({ platformMessageId: undefined }))
    expect(mapped?.storedMessageId).toBe('zm_100')
  })
})

describe('mapZernioInbound — media messages', () => {
  it('maps an image attachment (URL stored directly, caption as text)', () => {
    const mapped = mapZernioInbound(
      baseMessage({
        text: 'mira esta foto',
        attachments: [{ type: 'image', url: 'https://cdn.zernio.test/img.jpg' }],
      }),
    )
    expect(mapped?.contentType).toBe('image')
    expect(mapped?.mediaUrl).toBe('https://cdn.zernio.test/img.jpg')
    expect(mapped?.contentText).toBe('mira esta foto')
  })

  it('maps file → document, sticker → image, audio → audio, video → video', () => {
    expect(mapZernioAttachmentType('file')).toBe('document')
    expect(mapZernioAttachmentType('sticker')).toBe('image')
    expect(mapZernioAttachmentType('audio')).toBe('audio')
    expect(mapZernioAttachmentType('video')).toBe('video')
    expect(mapZernioAttachmentType('image')).toBe('image')
    // Unknown attachment types degrade to document (safest renderer).
    expect(mapZernioAttachmentType('whatever')).toBe('document')
  })

  it('maps an audio note with no text to contentText null', () => {
    const mapped = mapZernioInbound(
      baseMessage({
        text: null,
        attachments: [{ type: 'audio', url: 'https://cdn.zernio.test/nota.ogg' }],
      }),
    )
    expect(mapped?.contentType).toBe('audio')
    expect(mapped?.contentText).toBeNull()
    expect(mapped?.mediaUrl).toBe('https://cdn.zernio.test/nota.ogg')
  })
})

describe('mapZernioOutboundEcho — sends made outside wacrm', () => {
  function outboundMessage(
    overrides: Partial<ZernioInboundMessage> = {},
  ): ZernioInboundMessage {
    return baseMessage({
      direction: 'outgoing',
      platformMessageId: 'wamid.OUTBOUND1',
      text: 'Claro, te confirmo tu cita mañana',
      ...overrides,
    })
  }

  it('maps an outgoing text echo to the agent-message shape', () => {
    const mapped = mapZernioOutboundEcho(outboundMessage())
    expect(mapped).toEqual({
      storedMessageId: 'wamid.OUTBOUND1',
      contentType: 'text',
      contentText: 'Claro, te confirmo tu cita mañana',
      mediaUrl: null,
      createdAtIso: '2026-07-06T10:15:30.000Z',
      zernioConversationId: 'zc_1',
      // Both ids: send-time persistence may have stored either one.
      candidateIds: ['wamid.OUTBOUND1', 'zm_100'],
    })
  })

  it('maps an outgoing media echo (attachment URL + caption)', () => {
    const mapped = mapZernioOutboundEcho(
      outboundMessage({
        text: 'te mando la ubicación',
        attachments: [{ type: 'image', url: 'https://cdn.zernio.test/mapa.png' }],
      }),
    )
    expect(mapped?.contentType).toBe('image')
    expect(mapped?.mediaUrl).toBe('https://cdn.zernio.test/mapa.png')
    expect(mapped?.contentText).toBe('te mando la ubicación')
  })

  it('falls back to Zernio internal id when the echo has no wamid', () => {
    const mapped = mapZernioOutboundEcho(
      outboundMessage({ platformMessageId: undefined }),
    )
    expect(mapped?.storedMessageId).toBe('zm_100')
    expect(mapped?.candidateIds).toEqual(['zm_100'])
  })

  it('returns null for incoming messages (those go through mapZernioInbound)', () => {
    expect(mapZernioOutboundEcho(baseMessage())).toBeNull()
  })

  it('returns null when the echo carries no conversation id to map back', () => {
    expect(
      mapZernioOutboundEcho(outboundMessage({ conversationId: undefined })),
    ).toBeNull()
  })

  it('returns null for content-less echoes (nothing to persist)', () => {
    expect(
      mapZernioOutboundEcho(outboundMessage({ text: null, attachments: [] })),
    ).toBeNull()
  })
})

describe('mapZernioStatusEvent', () => {
  it('maps the three delivery events onto messages.status values', () => {
    expect(mapZernioStatusEvent('message.delivered')).toBe('delivered')
    expect(mapZernioStatusEvent('message.read')).toBe('read')
    expect(mapZernioStatusEvent('message.failed')).toBe('failed')
  })

  it('returns null for non-status events', () => {
    expect(mapZernioStatusEvent('message.received')).toBeNull()
    expect(mapZernioStatusEvent('reaction.received')).toBeNull()
  })
})

describe('isValidStatusTransition — mirror of the Meta webhook ladder', () => {
  it('allows only forward moves along the ladder', () => {
    expect(isValidStatusTransition('sent', 'delivered')).toBe(true)
    expect(isValidStatusTransition('delivered', 'read')).toBe(true)
    expect(isValidStatusTransition('read', 'replied')).toBe(true)
    // Replays must never regress.
    expect(isValidStatusTransition('read', 'delivered')).toBe(false)
    expect(isValidStatusTransition('delivered', 'sent')).toBe(false)
  })

  it('accepts failed only from pending/sent; failed is terminal', () => {
    expect(isValidStatusTransition('pending', 'failed')).toBe(true)
    expect(isValidStatusTransition('sent', 'failed')).toBe(true)
    expect(isValidStatusTransition('delivered', 'failed')).toBe(false)
    expect(isValidStatusTransition('read', 'failed')).toBe(false)
    expect(isValidStatusTransition('failed', 'delivered')).toBe(false)
  })

  it('rejects unknown incoming statuses', () => {
    expect(isValidStatusTransition('sent', 'exploded')).toBe(false)
  })
})
