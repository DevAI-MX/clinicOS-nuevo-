// ============================================================
// clinicOS — loop de tool-use del agente de Atención (OpenAI).
//
// Variante OpenAI del loop clínico (ver loop.ts para el de Anthropic).
// Reusa EXACTAMENTE el mismo ejecutor (execute.ts) y las mismas
// herramientas (tools.ts); solo cambia el protocolo del proveedor:
// Chat Completions con `tools` en formato function, y los resultados
// vuelven como mensajes `role: 'tool'` referenciando el tool_call_id.
//
// Funciona con modelos de razonamiento (o4-mini): usa
// max_completion_tokens y no fija temperature, igual que el provider
// de una-sola-completación.
// ============================================================

import { mergeConsecutive, providerHttpError, toNetworkError } from '../providers/shared'
import { aiRequestTimeoutMs } from '../defaults'
import { parseGeneration } from '../generate'
import {
  CLINICAL_TOOLS,
  type RunClinicalAgentArgs,
  type RunClinicalAgentResult,
  type ToolDefinition,
} from './tools'
import { executeClinicalTool } from './execute'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const MAX_TOOL_ROUNDS = 6

// Los modelos de razonamiento (o3/o4-mini) gastan tokens de razonamiento
// que cuentan contra max_completion_tokens; un tope bajo (p. ej. 1024)
// se consume razonando y devuelve contenido vacío (finish_reason
// 'length'). Damos holgura: la respuesta al paciente sigue siendo corta,
// pero el planeo de herramientas + razonamiento necesitan espacio.
const OPENAI_AGENT_MAX_TOKENS = 4096

// El input recibido está en formato Anthropic (input_schema); OpenAI usa
// { type:'function', function:{ name, description, parameters } }. El
// JSON Schema es el mismo, solo cambia el envoltorio.
function toOpenAiTools(tools: readonly ToolDefinition[]) {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }))
}

interface OpenAiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}
interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: OpenAiToolCall[]
  tool_call_id?: string
}
interface OpenAiResponse {
  choices?: { message?: OpenAiMessage; finish_reason?: string }[]
}

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw || '{}')
  } catch {
    // Argumentos malformados → objeto vacío; el ejecutor devolverá un
    // error de validación que el modelo puede corregir.
    return {}
  }
}

async function callOpenAi(
  args: RunClinicalAgentArgs,
  messages: OpenAiMessage[],
  timeoutMs: number,
): Promise<OpenAiResponse> {
  let res: Response
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: args.model,
        messages,
        tools: toOpenAiTools(args.tools ?? CLINICAL_TOOLS),
        tool_choice: 'auto',
        max_completion_tokens: OPENAI_AGENT_MAX_TOKENS,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }
  if (!res.ok) throw await providerHttpError('OpenAI', res)
  return (await res.json().catch(() => ({}))) as OpenAiResponse
}

export async function runOpenAiAgent(
  args: RunClinicalAgentArgs,
): Promise<RunClinicalAgentResult> {
  const timeoutMs = aiRequestTimeoutMs()
  const messages: OpenAiMessage[] = [
    { role: 'system', content: args.systemPrompt },
    ...mergeConsecutive(args.messages).map((m) => ({
      role: m.role,
      content: m.content,
    })),
  ]
  let escalated = false

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const data = await callOpenAi(args, messages, timeoutMs)
    const choice = data.choices?.[0]
    const msg = choice?.message
    if (!msg) return { text: '', handoff: true, escalated }

    // Reenvía el turno del asistente tal cual (incluye tool_calls).
    messages.push({
      role: 'assistant',
      content: msg.content ?? null,
      ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
    })

    const toolCalls = msg.tool_calls ?? []
    if (choice.finish_reason !== 'tool_calls' || toolCalls.length === 0) {
      const { text, handoff } = parseGeneration(msg.content?.trim() ?? '')
      return { text, handoff, escalated }
    }

    const executeTool = args.executeTool ?? executeClinicalTool
    for (const tc of toolCalls) {
      const r = await executeTool(
        tc.function.name,
        parseArgs(tc.function.arguments),
        args.ctx,
      )
      if (r.escalated) escalated = true
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: r.content,
      })
    }
  }

  // Se agotaron las rondas: devuelve el último texto del asistente si lo hay.
  const lastText = [...messages]
    .reverse()
    .find((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim())
  return { text: (lastText?.content as string)?.trim() ?? '', handoff: false, escalated }
}
