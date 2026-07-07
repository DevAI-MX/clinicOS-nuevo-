import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadAiConfig } from '@/lib/ai/config'
import { retrieveKnowledge } from '@/lib/ai/knowledge'
import { generateReply } from '@/lib/ai/generate'
import { buildSystemPrompt } from '@/lib/ai/defaults'
import { latestUserMessage } from '@/lib/ai/query'
import { AiError, type ChatMessage } from '@/lib/ai/types'
import {
  runClinicalAgent,
  buildClinicalSystemPrompt,
  clinicTimezone,
} from '@/lib/ai/agent'
import { executeClinicalTool } from '@/lib/ai/agent/execute'
import type { AgentToolContext, ToolExecResult } from '@/lib/ai/agent'

// Keep the tested transcript bounded, mirroring the live context window.
const MAX_TURNS = 20

// Tools account-scoped de solo lectura: en el playground corren de
// verdad (catálogo, agenda, datos de pago y base de conocimiento
// reales). Las demás operan sobre un contacto/conversación que aquí no
// existe — se SIMULAN para que el flujo conversacional se pueda probar
// completo sin escribir citas/pagos/leads falsos en producción.
const PLAYGROUND_REAL_TOOLS = new Set([
  'consultar_catalogo',
  'consultar_disponibilidad',
  'consultar_datos_pago',
  'consultar_conocimiento',
])

async function playgroundExecuteTool(
  name: string,
  input: unknown,
  ctx: AgentToolContext,
): Promise<ToolExecResult> {
  if (PLAYGROUND_REAL_TOOLS.has(name)) {
    return executeClinicalTool(name, input, ctx)
  }
  return {
    content: JSON.stringify({
      ok: true,
      simulado: true,
      nota: `Modo prueba: ${name} se simuló sin tocar datos reales. Continúa la conversación como si la acción hubiera funcionado.`,
    }),
  }
}

/**
 * POST /api/ai/playground  (agent+)
 *
 * Test-chat with the account's agent WITHOUT touching WhatsApp. Mirrors
 * the auto-reply dispatch: when `clinical_agent_enabled` is on it runs
 * the same tool-calling clinical agent a patient would get (read-only
 * tools live, mutations simulated — no test appointments/payments land
 * in real tables); otherwise the legacy single-completion path with
 * knowledge-base retrieval. Reads the config even when the master
 * switch is off (requireActive:false) so you can try it before going
 * live. Stateless: the client sends the running transcript each turn.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`ai-playground:${userId}`, RATE_LIMITS.aiDraft)
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
        { error: 'Send a message to test the agent.' },
        { status: 400 },
      )
    }

    const config = await loadAiConfig(supabase, accountId, {
      requireActive: false,
    }).catch((err) => {
      console.error('[ai/playground] loadAiConfig error:', err)
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

    if (config.clinicalAgentEnabled) {
      // Mismo agente clínico que atiende WhatsApp (ver auto-reply.ts),
      // con las mutaciones simuladas (playgroundExecuteTool).
      const timezone = clinicTimezone()
      const now = new Date()
      const { text, handoff } = await runClinicalAgent({
        provider: config.provider,
        apiKey: config.apiKey,
        model: config.model,
        systemPrompt: buildClinicalSystemPrompt({
          userPrompt: config.systemPrompt,
          contactName: null,
          timezone,
          now,
        }),
        messages,
        executeTool: playgroundExecuteTool,
        ctx: {
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
      return NextResponse.json({ reply: text, handoff })
    }

    const knowledge = await retrieveKnowledge(
      supabase,
      accountId,
      config,
      latestUserMessage(messages),
    )
    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
    })

    const { text, handoff } = await generateReply({ config, systemPrompt, messages })
    return NextResponse.json({ reply: text, handoff })
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
