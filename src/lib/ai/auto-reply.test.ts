import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  zernioSendToConversation: vi.fn(),
  runClinicalAgent: vi.fn(),
  buildRecentImageNotes: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: unknown }[],
    dispatchDueAt: null as string | null,
    // Avisos al equipo (retireConversationToHumans).
    notifications: [] as Record<string, unknown>[],
    // messages table (Zernio branch): rows the echo-relabel UPDATE
    // matches, inserts attempted, deletes (barrido anti-duplicados) and
    // a forced insert error.
    messagesEchoRows: [] as { id: string }[],
    messagesUpdates: [] as Record<string, unknown>[],
    messagesInserts: [] as Record<string, unknown>[],
    messagesDeletes: 0,
    messagesInsertError: null as { code?: string; message?: string } | null,
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))
vi.mock('@/lib/zernio/client', () => ({
  zernioSendToConversation: h.zernioSendToConversation,
}))
// Rama clínica: el loop de tool-use y el paso de visión tienen sus
// propios tests (loop*.test.ts, vision.test.ts); aquí solo importa el
// wiring de dispatchInboundToAiReply.
vi.mock('./agent', () => ({
  runClinicalAgent: h.runClinicalAgent,
  buildClinicalSystemPrompt: () => 'sys-prompt',
  buildPatientStateLines: async () => [],
  buildRecentImageNotes: h.buildRecentImageNotes,
  clinicTimezone: () => 'America/Mexico_City',
}))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'messages') {
        return {
          update: (payload: Record<string, unknown>) => {
            h.state.messagesUpdates.push(payload)
            const chain = {
              eq: () => chain,
              gte: () => chain,
              select: () =>
                Promise.resolve({ data: h.state.messagesEchoRows, error: null }),
            }
            return chain
          },
          insert: (payload: Record<string, unknown>) => {
            h.state.messagesInserts.push(payload)
            return Promise.resolve({ error: h.state.messagesInsertError })
          },
          delete: () => {
            h.state.messagesDeletes += 1
            const chain = {
              eq: () => chain,
              gte: () => chain,
              then: (resolve: (v: { error: null }) => void) =>
                resolve({ error: null }),
            }
            return chain
          },
        }
      }
      if (table === 'notifications') {
        return {
          insert: (row: Record<string, unknown>) => {
            h.state.notifications.push(row)
            return Promise.resolve({ error: null })
          },
          // Dedupe de notifySendFailureOnce: ¿ya hay un aviso con este
          // título para la conversación? El mock filtra por el eq('title').
          select: () => {
            let titleFilter: unknown = null
            const chain = {
              eq: (col: string, val: unknown) => {
                if (col === 'title') titleFilter = val
                return chain
              },
              gte: () => chain,
              limit: () => chain,
              maybeSingle: () =>
                Promise.resolve({
                  data: h.state.notifications.some((n) => n.title === titleFilter)
                    ? { id: 'notif-1' }
                    : null,
                  error: null,
                }),
            }
            return chain
          },
        }
      }
      if (table === 'contacts') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: { name: 'Acerotech', phone: '5214444220456' },
                  error: null,
                }),
            }),
          }),
        }
      }
      if (table === 'automations') {
        // .select().eq().eq().in().limit() → active auto-responders
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.autoResponders, error: null }),
        }
        return chain
      }
      // conversations
      return {
        select: (cols?: string) => ({
          eq: () => ({
            maybeSingle: () => {
              if (cols === 'ai_dispatch_due_at') {
                return Promise.resolve({
                  data: { ai_dispatch_due_at: h.state.dispatchDueAt },
                  error: null,
                })
              }
              return Promise.resolve({ data: h.state.conv, error: null })
            },
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          if (Object.prototype.hasOwnProperty.call(payload, 'ai_dispatch_due_at')) {
            h.state.dispatchDueAt = payload.ai_dispatch_due_at as string | null
            return {
              eq: () => ({
                select: () => ({
                  maybeSingle: () =>
                    Promise.resolve({
                      data: { ai_dispatch_due_at: h.state.dispatchDueAt },
                      error: null,
                    }),
                }),
              }),
            }
          }
          h.state.updatePayload = payload
          // Soporta ambos consumidores: `await update().eq()` (updates
          // simples) y `update().eq().eq().select()` (el flip condicionado
          // de retireConversationToHumans, que solo "flippea" si el flag
          // estaba apagado).
          const isRetireFlip = payload.ai_autoreply_disabled === true
          const chain = {
            eq: () => chain,
            select: () => {
              const wasOff = h.state.conv?.ai_autoreply_disabled === false
              if (isRetireFlip && h.state.conv) {
                h.state.conv.ai_autoreply_disabled = true
              }
              return Promise.resolve({
                data: wasOff ? [{ id: 'conv-1' }] : [],
                error: null,
              })
            },
            then: (resolve: (v: { error: null }) => void) =>
              resolve({ error: null }),
          }
          return chain
        },
      }
    },
    rpc: (name: string, args: { expected_due_at?: string }) => {
      h.state.rpcCalls.push({ name, args })
      if (name === 'claim_ai_dispatch_slot') {
        const won = h.state.dispatchDueAt === args.expected_due_at
        if (won) h.state.dispatchDueAt = null
        return Promise.resolve({ data: won, error: null })
      }
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

import { dispatchInboundToAiReply } from './auto-reply'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    embeddingsApiKey: null,
    clinicalAgentEnabled: false,
    ...overrides,
  }
}

beforeEach(() => {
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  }
  h.state.autoResponders = []
  h.state.claim = true
  h.state.updatePayload = null
  h.state.rpcCalls = []
  h.state.dispatchDueAt = null
  h.state.notifications = []
  h.state.messagesDeletes = 0
  // Debounce is off by default in these tests — see the dedicated
  // "debounce" describe block below for the window itself.
  process.env.AI_DEBOUNCE_WINDOW_MS = '0'
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
  h.runClinicalAgent.mockResolvedValue({ text: 'Hola!', handoff: false, escalated: false })
  h.buildRecentImageNotes.mockResolvedValue([])
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ])
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.'])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('Returns accepted within 30 days.')
  })

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('does not send when the atomic slot claim loses the race — notifica SIN tocar el modo IA', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    // It still attempts the claim, but the send is skipped.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
    // El claim perdido significa tope alcanzado: aviso al equipo, pero
    // el modo IA↔humano solo cambia a mano desde el panel.
    expect(h.state.conv?.ai_autoreply_disabled).toBe(false)
    expect(h.state.notifications).toHaveLength(1)
    expect(h.state.notifications[0].type).toBe('ai_escalation')
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('cap alcanzado: no responde y avisa al equipo SIN tocar el modo IA (nunca fantasma)', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.generateReply).not.toHaveBeenCalled()
    // Incidente Acerotech: antes esto era un return silencioso. Y el
    // modo IA↔humano nunca cambia solo: únicamente el panel lo escribe.
    expect(h.state.conv?.ai_autoreply_disabled).toBe(false)
    expect(h.state.notifications).toHaveLength(1)
    expect(h.state.notifications[0].title).toContain('tope')
    expect(String(h.state.notifications[0].body)).toContain('Acerotech')
  })

  it('el aviso de tope no se repite dentro de la ventana anti-spam', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.notifications).toHaveLength(1)
    // Siguiente inbound: mismo título dentro de la ventana → dedupe.
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.notifications).toHaveLength(1)
  })

  it('tope 0 = sin tope: responde aunque el contador vaya alto (decisión de producto)', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyMaxPerConversation: 0 }))
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 500,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    expect(h.state.notifications).toHaveLength(0)
    // El claim corre igual (métricas), contra un máximo inalcanzable.
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 2147483647 },
      },
    ])
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('drops the reply if a human switched the thread to human mode mid-generation', async () => {
    // El humano apaga la IA MIENTRAS el modelo genera: el gate final
    // (justo antes del claim/envío) debe descartar la respuesta.
    h.generateReply.mockImplementation(async () => {
      h.state.conv = {
        assigned_agent_id: null,
        ai_autoreply_disabled: true,
        ai_reply_count: 0,
      }
      return { text: 'Hello!', handoff: false }
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0) // ni siquiera intenta el claim
  })

  it('drops the reply if an agent took the thread mid-generation', async () => {
    h.generateReply.mockImplementation(async () => {
      h.state.conv = {
        assigned_agent_id: 'agent-9',
        ai_autoreply_disabled: false,
        ai_reply_count: 0,
      }
      return { text: 'Hello!', handoff: false }
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — debounce', () => {
  beforeEach(() => {
    process.env.AI_DEBOUNCE_WINDOW_MS = '30'
    process.env.AI_DEBOUNCE_MAX_WAIT_MS = '2000'
  })

  it('waits out the debounce window before sending', async () => {
    const started = Date.now()
    await dispatchInboundToAiReply(ARGS)
    expect(Date.now() - started).toBeGreaterThanOrEqual(25)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('a message that arrives mid-burst reschedules — exactly one dispatch fires for the burst', async () => {
    const p1 = dispatchInboundToAiReply(ARGS)
    await new Promise((r) => setTimeout(r, 10)) // let p1 schedule and start waiting
    const p2 = dispatchInboundToAiReply(ARGS) // "second message" — pushes the window out
    await Promise.all([p1, p2])
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('a message after a prior dispatch already sent starts a fresh window (no deadlock)', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledTimes(2)
  })
})

describe('dispatchInboundToAiReply — handoff', () => {
  it('notifies the team and does not send on handoff — SIN tocar el modo IA', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    // El modo IA↔humano solo cambia a mano: el handoff ya no escribe
    // en conversations (antes apagaba ai_autoreply_disabled).
    expect(h.state.updatePayload).toBeNull()
    expect(h.state.conv?.ai_autoreply_disabled).toBe(false)
    expect(h.state.rpcCalls).toHaveLength(0)
    // El handoff silencioso dejaba al paciente esperando sin que el
    // equipo se enterara: ahora siempre hay aviso.
    expect(h.state.notifications).toHaveLength(1)
    expect(h.state.notifications[0].type).toBe('ai_escalation')
  })
})

// El webhook message.sent de Zernio compite con el propio insert del
// bot y puede persistir la respuesta primero (como 'agent'). Ver
// migración 039 y processZernioOutboundEcho.
describe('dispatchInboundToAiReply — zernio echo dedupe', () => {
  const ZARGS = { ...ARGS, zernioConversationId: 'zconv-1' }

  beforeEach(() => {
    h.zernioSendToConversation.mockResolvedValue({ messageId: 'wamid.1' })
    h.state.messagesEchoRows = []
    h.state.messagesUpdates = []
    h.state.messagesInserts = []
    h.state.messagesInsertError = null
  })

  it('inserts the bot row when no echo landed first, then sweeps stray echo twins', async () => {
    await dispatchInboundToAiReply(ZARGS)
    expect(h.zernioSendToConversation).toHaveBeenCalledWith({
      conversationId: 'zconv-1',
      text: 'Hello!',
    })
    expect(h.state.messagesInserts).toHaveLength(1)
    expect(h.state.messagesInserts[0]).toMatchObject({
      sender_type: 'bot',
      content_text: 'Hello!',
      message_id: 'wamid.1',
    })
    // Barrido post-insert: si el eco aterrizó entre el relabel y el
    // insert, su fila 'agent' gemela se borra (duplicados del panel).
    expect(h.state.messagesDeletes).toBe(1)
  })

  it("relabels the echo's 'agent' row to 'bot' instead of inserting a duplicate", async () => {
    h.state.messagesEchoRows = [{ id: 'echo-row-1' }]
    await dispatchInboundToAiReply(ZARGS)
    expect(h.state.messagesUpdates).toContainEqual({ sender_type: 'bot' })
    expect(h.state.messagesInserts).toHaveLength(0)
    expect(h.state.messagesDeletes).toBe(0) // el relabel ya resolvió
  })

  it('treats a unique violation on insert as "already persisted", not an error', async () => {
    h.state.messagesInsertError = { code: '23505', message: 'duplicate key' }
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await dispatchInboundToAiReply(ZARGS)
      expect(h.state.messagesInserts).toHaveLength(1)
      expect(errSpy).not.toHaveBeenCalled()
    } finally {
      errSpy.mockRestore()
    }
  })
})

// El envío puede fallar aunque la respuesta se haya generado (la API
// key de Zernio revocada fue el caso real: 401 en cada send y el
// agente "contestaba" al vacío sin que nadie se enterara).
describe('dispatchInboundToAiReply — envío fallido', () => {
  beforeEach(() => {
    h.state.messagesEchoRows = []
    h.state.messagesUpdates = []
    h.state.messagesInserts = []
    h.state.messagesInsertError = null
  })

  it('meta: notifica al equipo cuando el envío falla, SIN apagar el modo IA', async () => {
    h.engineSendText.mockRejectedValue(new Error('Zernio API error: 401'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await dispatchInboundToAiReply(ARGS)
    } finally {
      errSpy.mockRestore()
    }
    expect(h.state.notifications).toHaveLength(1)
    expect(h.state.notifications[0].title).toBe(
      'No se pudo enviar la respuesta del agente',
    )
    expect(h.state.notifications[0].type).toBe('ai_escalation')
    // La IA queda encendida: un fallo transitorio se recupera solo en
    // el siguiente inbound (a diferencia del tope/handoff).
    expect(h.state.conv?.ai_autoreply_disabled).toBe(false)
  })

  it('zernio: el 401 del envío por inbox también avisa', async () => {
    h.zernioSendToConversation.mockRejectedValue(new Error('Zernio API error: 401'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await dispatchInboundToAiReply({ ...ARGS, zernioConversationId: 'zconv-1' })
    } finally {
      errSpy.mockRestore()
    }
    expect(h.state.notifications).toHaveLength(1)
    expect(h.state.notifications[0].title).toBe(
      'No se pudo enviar la respuesta del agente',
    )
    // No se persistió ningún mensaje del bot: el envío nunca salió.
    expect(h.state.messagesInserts).toHaveLength(0)
  })

  it('anti-spam: una ráfaga de fallos genera UN solo aviso por conversación', async () => {
    h.engineSendText.mockRejectedValue(new Error('boom'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await dispatchInboundToAiReply(ARGS)
      await dispatchInboundToAiReply(ARGS)
      await dispatchInboundToAiReply(ARGS)
    } finally {
      errSpy.mockRestore()
    }
    expect(h.state.notifications).toHaveLength(1)
  })
})

// El comprobante del anticipo llega como IMAGEN. El disparo multimedia
// solo tiene sentido con el agente clínico (paso de visión); sin él se
// conserva el comportamiento previo (las imágenes no se auto-responden).
describe('dispatchInboundToAiReply — multimedia (comprobantes)', () => {
  it('ignora un disparo multimedia cuando la cuenta no corre el agente clínico', async () => {
    await dispatchInboundToAiReply({ ...ARGS, inboundContentType: 'image' })
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.runClinicalAgent).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('clinical: inyecta las notas de visión como último turno del transcript', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ clinicalAgentEnabled: true }))
    h.buildConversationContext.mockResolvedValue([
      { role: 'user', content: '[El paciente envió una imagen]' },
    ])
    h.buildRecentImageNotes.mockResolvedValue([
      '[Nota automática del sistema] Es comprobante de pago: sí\nMonto: 350 MXN',
    ])
    await dispatchInboundToAiReply({ ...ARGS, inboundContentType: 'image' })
    expect(h.runClinicalAgent).toHaveBeenCalledTimes(1)
    const call = h.runClinicalAgent.mock.calls[0][0]
    expect(call.messages).toEqual([
      { role: 'user', content: '[El paciente envió una imagen]' },
      {
        role: 'user',
        content: '[Nota automática del sistema] Es comprobante de pago: sí\nMonto: 350 MXN',
      },
    ])
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('clinical: sin imágenes recientes el transcript va intacto', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ clinicalAgentEnabled: true }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.runClinicalAgent).toHaveBeenCalledTimes(1)
    expect(h.runClinicalAgent.mock.calls[0][0].messages).toEqual([
      { role: 'user', content: 'hi' },
    ])
  })
})
