// ============================================================
// clinicOS — loop de tool-use del agente de Atención (Anthropic).
//
// A diferencia de generateReply() (una sola completación de texto),
// aquí corremos la Messages API en modo herramientas: el modelo puede
// pedir tool_use, ejecutamos la herramienta (execute.ts), devolvemos el
// tool_result y repetimos hasta que el modelo cierra el turno con texto
// para el paciente. Acotado por un número máximo de rondas.
//
// Reusa el manejo de errores/red de los providers existentes y el
// parseo del centinela de handoff para mantener el mismo contrato
// { text, handoff } que consume auto-reply.ts.
// ============================================================

import type { ChatMessage } from '../types'
import { MAX_OUTPUT_TOKENS, aiRequestTimeoutMs } from '../defaults'
import { parseGeneration } from '../generate'
import { providerHttpError, toNetworkError } from '../providers/shared'
import {
  CLINICAL_TOOLS,
  type RunClinicalAgentArgs,
  type RunClinicalAgentResult,
} from './tools'
import { executeClinicalTool } from './execute'
import { runOpenAiAgent } from './loop-openai'

// Re-export para no romper importadores previos (index.ts, tests).
export type { RunClinicalAgentArgs, RunClinicalAgentResult } from './tools'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

/** Tope de rondas modelo↔herramientas por inbound (evita loops). */
const MAX_TOOL_ROUNDS = 6

// ------------------------------------------------------------
// Formas mínimas de la Messages API que usamos.
// ------------------------------------------------------------

interface TextBlock {
  type: 'text'
  text: string
}
interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}
type ContentBlock = TextBlock | ToolUseBlock | { type: string; [k: string]: unknown }

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

interface AnthropicResponse {
  content?: ContentBlock[]
  stop_reason?: string
}

/**
 * Anthropic exige roles alternados que empiecen en `user`. Fusiona
 * turnos consecutivos del contexto inicial y descarta saludos del
 * asistente antes del primer mensaje del paciente. (Igual criterio que
 * el provider de una-sola-completación.)
 */
function normalizeInitial(messages: ChatMessage[]): AnthropicMessage[] {
  const merged: AnthropicMessage[] = []
  for (const m of messages) {
    const last = merged[merged.length - 1]
    if (last && last.role === m.role && typeof last.content === 'string') {
      last.content = `${last.content}\n\n${m.content}`
    } else {
      merged.push({ role: m.role, content: m.content })
    }
  }
  while (merged.length > 0 && merged[0].role === 'assistant') merged.shift()
  if (merged.length === 0) {
    return [{ role: 'user', content: '(El paciente aún no ha escrito.)' }]
  }
  return merged
}

async function callAnthropic(
  args: RunClinicalAgentArgs,
  messages: AnthropicMessage[],
  timeoutMs: number,
): Promise<AnthropicResponse> {
  let res: Response
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': args.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: args.model,
        system: args.systemPrompt,
        max_tokens: MAX_OUTPUT_TOKENS,
        tools: args.tools ?? CLINICAL_TOOLS,
        messages,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }
  if (!res.ok) throw await providerHttpError('Anthropic', res)
  return (await res.json().catch(() => ({}))) as AnthropicResponse
}

function collectText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is TextBlock => b.type === 'text' && typeof (b as TextBlock).text === 'string')
    .map((b) => b.text)
    .join('')
    .trim()
}

/**
 * Corre el agente clínico sobre el inbound actual, despachando al loop
 * del proveedor configurado. Lanza AiError en fallo de red/proveedor
 * (igual que generateReply) — auto-reply.ts lo captura y no rompe el
 * 200 del webhook.
 */
export async function runClinicalAgent(
  args: RunClinicalAgentArgs,
): Promise<RunClinicalAgentResult> {
  if (args.provider === 'openai') return runOpenAiAgent(args)
  return runAnthropicAgent(args)
}

/** Loop de tool-use contra la Messages API de Anthropic. */
async function runAnthropicAgent(
  args: RunClinicalAgentArgs,
): Promise<RunClinicalAgentResult> {
  const timeoutMs = aiRequestTimeoutMs()
  const messages = normalizeInitial(args.messages)
  let escalated = false

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const data = await callAnthropic(args, messages, timeoutMs)
    const blocks = data.content ?? []
    messages.push({ role: 'assistant', content: blocks })

    const toolUses = blocks.filter(
      (b): b is ToolUseBlock => b.type === 'tool_use',
    )

    if (data.stop_reason !== 'tool_use' || toolUses.length === 0) {
      const { text, handoff } = parseGeneration(collectText(blocks))
      return { text, handoff, escalated }
    }

    const executeTool = args.executeTool ?? executeClinicalTool
    const results: ContentBlock[] = []
    for (const tu of toolUses) {
      const r = await executeTool(tu.name, tu.input, args.ctx)
      if (r.escalated) escalated = true
      results.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: r.content,
        is_error: r.isError ?? false,
      })
    }
    messages.push({ role: 'user', content: results })
  }

  // Se agotaron las rondas sin cerrar. Devuelve el último texto (si lo
  // hubo) o vacío → auto-reply.ts lo tratará como no-op/handoff.
  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m.role === 'assistant' && Array.isArray(m.content))
  const text = lastAssistant ? collectText(lastAssistant.content as ContentBlock[]) : ''
  return { text, handoff: false, escalated }
}
