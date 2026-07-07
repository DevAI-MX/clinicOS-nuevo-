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
  state: {
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: unknown }[],
    dispatchDueAt: null as string | null,
    // messages table (Zernio branch): rows the echo-relabel UPDATE
    // matches, inserts attempted, and a forced insert error.
    messagesEchoRows: [] as { id: string }[],
    messagesUpdates: [] as Record<string, unknown>[],
    messagesInserts: [] as Record<string, unknown>[],
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
          return { eq: () => Promise.resolve({ error: null }) }
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
  // Debounce is off by default in these tests — see the dedicated
  // "debounce" describe block below for the window itself.
  process.env.AI_DEBOUNCE_WINDOW_MS = '0'
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
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

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    // It still attempts the claim, but the send is skipped.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
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

  it('skips when the per-conversation cap is reached', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
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
  it('disables auto-reply and does not send on handoff', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toEqual({ ai_autoreply_disabled: true })
    expect(h.state.rpcCalls).toHaveLength(0)
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

  it('inserts the bot row when no echo landed first', async () => {
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
  })

  it("relabels the echo's 'agent' row to 'bot' instead of inserting a duplicate", async () => {
    h.state.messagesEchoRows = [{ id: 'echo-row-1' }]
    await dispatchInboundToAiReply(ZARGS)
    expect(h.state.messagesUpdates).toContainEqual({ sender_type: 'bot' })
    expect(h.state.messagesInserts).toHaveLength(0)
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
