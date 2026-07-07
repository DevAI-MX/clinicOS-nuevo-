import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadAiConfig } from '@/lib/ai/config'
import { runClinicalAgent, clinicTimezone } from '@/lib/ai/agent'
import {
  INTERNAL_TOOLS,
  executeInternalTool,
  buildInternalAssistantSystemPrompt,
} from '@/lib/ai/internal'
import { AiError, type ChatMessage } from '@/lib/ai/types'

// Mismo tope de transcript que el playground.
const MAX_TURNS = 20

/**
 * POST /api/ai/internal-assistant  (agent+)
 *
 * Chat interno para el doctor/equipo dentro del dashboard: consulta la
 * agenda del día, los anticipos pendientes y el embudo de IA con
 * herramientas de SOLO lectura. Es el segundo agente del sistema,
 * separado del recepcionista de WhatsApp: mismo loop de tool-calling y
 * misma config de proveedor (`ai_configs`), pero prompt fijo (no
 * configurable) y catálogo de tools propio. Stateless: el cliente
 * reenvía el transcript completo en cada turno, nada se persiste.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`ai-internal:${userId}`, RATE_LIMITS.aiDraft)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const rawMessages = Array.isArray(body?.messages) ? body.messages : null
    if (!rawMessages) {
      return NextResponse.json({ error: 'messages is required' }, { status: 400 })
    }

    const messages: ChatMessage[] = rawMessages
      .filter(
        (m: unknown): m is ChatMessage =>
          !!m &&
          typeof m === 'object' &&
          ((m as ChatMessage).role === 'user' ||
            (m as ChatMessage).role === 'assistant') &&
          typeof (m as ChatMessage).content === 'string' &&
          (m as ChatMessage).content.trim().length > 0,
      )
      .slice(-MAX_TURNS)

    if (messages.length === 0) {
      return NextResponse.json(
        { error: 'Send a message to the assistant.' },
        { status: 400 },
      )
    }

    const config = await loadAiConfig(supabase, accountId, {
      requireActive: false,
    }).catch((err) => {
      console.error('[ai/internal-assistant] loadAiConfig error:', err)
      throw new AiError('Stored API key could not be decrypted.', {
        code: 'key_decrypt_failed',
        status: 400,
      })
    })
    if (!config) {
      return NextResponse.json(
        {
          error: 'No agent configured yet. Add your provider key in Setup.',
          code: 'ai_not_configured',
        },
        { status: 400 },
      )
    }

    const timezone = clinicTimezone()
    const now = new Date()

    const { text } = await runClinicalAgent({
      provider: config.provider,
      apiKey: config.apiKey,
      model: config.model,
      systemPrompt: buildInternalAssistantSystemPrompt({ timezone, now }),
      messages,
      tools: INTERNAL_TOOLS,
      executeTool: executeInternalTool,
      ctx: {
        // Las tools internas corren bajo el cliente del usuario logueado
        // (RLS activo) y filtran por cuenta; no operan sobre un contacto.
        db: supabase,
        accountId,
        contactId: '',
        conversationId: '',
        userId,
        contactName: null,
        timezone,
        now,
        embeddingsApiKey: config.embeddingsApiKey,
      },
    })

    return NextResponse.json({ reply: text })
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      )
    }
    return toErrorResponse(err)
  }
}
