import { describe, expect, it, vi, beforeEach } from 'vitest'

// Fake mínimo del admin-client para probar processZernioOutboundEcho
// (el eco de message.sent) contra un store en memoria. Los tests de
// mapeo puro de abajo no lo tocan.
const h = vi.hoisted(() => ({
  store: {} as Record<string, Record<string, unknown>[]>,
  inserts: [] as { table: string; row: Record<string, unknown> }[],
}))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      const filters: ((r: Record<string, unknown>) => boolean)[] = []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        select: () => chain,
        eq: (c: string, v: unknown) => {
          filters.push((r) => r[c] === v)
          return chain
        },
        in: (c: string, vs: unknown[]) => {
          filters.push((r) => vs.includes(r[c]))
          return chain
        },
        gte: (c: string, v: string) => {
          filters.push((r) => String(r[c]) >= v)
          return chain
        },
        limit: () => chain,
        maybeSingle: () =>
          Promise.resolve({
            data:
              (h.store[table] ?? []).find((r) => filters.every((f) => f(r))) ??
              null,
            error: null,
          }),
        insert: (row: Record<string, unknown>) => {
          h.inserts.push({ table, row })
          ;(h.store[table] ??= []).push(row)
          return Promise.resolve({ error: null })
        },
        update: () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const uc: any = {
            eq: () => uc,
            then: (resolve: (v: { error: null }) => void) =>
              resolve({ error: null }),
          }
          return uc
        },
      }
      return chain
    },
  }),
}))
vi.mock('./config', () => ({
  resolveZernioWacrmAccount: () =>
    Promise.resolve({ accountId: 'acc-1', userId: 'user-1' }),
}))

// Re-hospedaje de media: se prueba a fondo en
// storage/rehost-inbound-media.test.ts; aquí solo el cableado.
const rehostMock = vi.hoisted(() => ({
  fn: vi.fn(() => Promise.resolve<string | null>('https://supa.example/rehosted.jpg')),
}))
vi.mock('@/lib/storage/rehost-inbound-media', () => ({
  rehostInboundMedia: rehostMock.fn,
}))

import {
  isValidStatusTransition,
  mapZernioAttachmentType,
  mapZernioInbound,
  mapZernioOutboundEcho,
  mapZernioStatusEvent,
  processZernioEvent,
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

describe('processZernioOutboundEcho — dedupe contra envíos del bot', () => {
  const CONV = { id: 'conv-1', account_id: 'acc-1', zernio_conversation_id: 'zc_1' }

  function sentEvent(overrides: Partial<ZernioInboundMessage> = {}) {
    return {
      event: 'message.sent',
      message: baseMessage({
        direction: 'outgoing' as const,
        platformMessageId: 'wamid.OUT9',
        text: 'Te aparto el lugar para mañana a las 4:30 pm',
        sentAt: new Date().toISOString(),
        ...overrides,
      }),
    }
  }

  beforeEach(() => {
    h.store.conversations = [{ ...CONV }]
    h.store.messages = []
    h.inserts = []
  })

  it('descarta el eco cuando el bot ya persistió el MISMO texto con OTRO message_id', async () => {
    // El send devolvió el id interno de Zernio; el eco trae el wamid.
    // Sin dedupe por contenido, cada respuesta del bot quedaba doble
    // en el panel (incidente Acerotech).
    h.store.messages = [
      {
        id: 'm-bot',
        conversation_id: 'conv-1',
        sender_type: 'bot',
        content_text: 'Te aparto el lugar para mañana a las 4:30 pm',
        message_id: 'zernio-internal-123',
        created_at: new Date().toISOString(),
      },
    ]
    await processZernioEvent(sentEvent())
    expect(h.inserts.filter((i) => i.table === 'messages')).toHaveLength(0)
  })

  it('sí persiste un eco humano (texto que el bot no mandó)', async () => {
    await processZernioEvent(sentEvent({ text: 'Aquí el doctor, nos vemos mañana' }))
    const inserted = h.inserts.filter((i) => i.table === 'messages')
    expect(inserted).toHaveLength(1)
    expect(inserted[0].row.sender_type).toBe('agent')
    expect(inserted[0].row.content_text).toBe('Aquí el doctor, nos vemos mañana')
  })

  it('sigue deduplicando por message_id cuando los ids sí coinciden', async () => {
    h.store.messages = [
      {
        id: 'm-bot',
        conversation_id: 'conv-1',
        sender_type: 'bot',
        content_text: 'otro texto distinto',
        message_id: 'wamid.OUT9',
        created_at: new Date().toISOString(),
      },
    ]
    await processZernioEvent(sentEvent())
    expect(h.inserts.filter((i) => i.table === 'messages')).toHaveLength(0)
  })

  it('persiste la URL re-hospedada del adjunto (la de Zernio expira)', async () => {
    rehostMock.fn.mockResolvedValueOnce('https://supa.example/rehosted.jpg')
    await processZernioEvent(
      sentEvent({
        text: null,
        attachments: [{ type: 'image', url: 'https://cdn.zernio.example/efimera.jpg' }],
      }),
    )
    const inserted = h.inserts.filter((i) => i.table === 'messages')
    expect(inserted).toHaveLength(1)
    expect(inserted[0].row.media_url).toBe('https://supa.example/rehosted.jpg')
    expect(rehostMock.fn).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acc-1',
        url: 'https://cdn.zernio.example/efimera.jpg',
      }),
    )
  })

  it('conserva la URL original cuando el re-hospedaje falla', async () => {
    rehostMock.fn.mockResolvedValueOnce(null)
    await processZernioEvent(
      sentEvent({
        text: null,
        attachments: [{ type: 'image', url: 'https://cdn.zernio.example/efimera.jpg' }],
      }),
    )
    const inserted = h.inserts.filter((i) => i.table === 'messages')
    expect(inserted).toHaveLength(1)
    expect(inserted[0].row.media_url).toBe('https://cdn.zernio.example/efimera.jpg')
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
