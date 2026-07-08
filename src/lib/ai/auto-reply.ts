import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import {
  buildSystemPrompt,
  aiDebounceWindowMs,
  aiDebounceMaxWaitMs,
  HANDOFF_SENTINEL,
} from './defaults'
import { latestUserMessage } from './query'
import {
  runClinicalAgent,
  buildClinicalSystemPrompt,
  buildPatientStateLines,
  buildReceptionFlowLines,
  buildRecentImageNotes,
  clinicTimezone,
  validateClinicalReply,
  buildClinicalFallbackReply,
  buildGuardrailRepairNote,
} from './agent'
import type {
  GuardrailVerdict,
  RunClinicalAgentResult,
  ToolTrace,
} from './agent'
import { engineSendText } from '@/lib/flows/meta-send'
import { zernioSendToConversation } from '@/lib/zernio/client'
import { isUniqueViolation } from '@/lib/contacts/dedupe'

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
  /** Zernio inbox conversation id, when the inbound arrived via Zernio.
   *  Present → the reply is sent back into that Zernio conversation
   *  (freeform inbox send) instead of the phone-based Meta/engine path,
   *  which Zernio's API does not support for WhatsApp. */
  zernioConversationId?: string | null
  /** content_type del inbound que disparó el dispatch ('text', 'image',
   *  'document'...). Un disparo multimedia solo genera respuesta cuando
   *  la cuenta corre el agente clínico (que analiza la imagen con
   *  visión); sin agente clínico se conserva el comportamiento previo:
   *  las imágenes no se auto-responden. */
  inboundContentType?: string
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → no reply; the notable ones notify the team):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - modo humano activado A MANO en el panel (ai_autoreply_disabled)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * Decisión de producto (2026-07-07): el modo IA↔humano NUNCA se cambia
 * automáticamente. Antes el tope y el handoff apagaban
 * ai_autoreply_disabled y el hilo quedaba mudo sin señal en la UI (el
 * doctor asumía que el agente estaba roto). Ahora el único escritor de
 * ese flag es el interruptor del panel; estos caminos solo avisan al
 * equipo (notifyTeamOnce, con candado anti-spam por hora).
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args
  const zernioConversationId = args.zernioConversationId ?? null

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    // Disparo multimedia (imagen/documento): solo el agente clínico
    // sabe qué hacer con él (paso de visión + prevalidar el anticipo).
    // Para cuentas sin agente clínico se mantiene el comportamiento de
    // siempre: las imágenes no generan auto-respuesta.
    const mediaTrigger =
      args.inboundContentType != null && args.inboundContentType !== 'text'
    if (mediaTrigger && !config.clinicalAgentEnabled) return

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer. (Relationship triggers like
    // `first_inbound_message` don't count — they're not per-message
    // auto-responders.)
    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) return

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread
    if (conv.ai_autoreply_disabled) return // handed off / turned off here
    // Tope OPCIONAL (0 = sin tope, el default desde la migración 042 —
    // decisión de producto post-Acerotech: el agente no debe toparse).
    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound).
    const replyCap = config.autoReplyMaxPerConversation
    if (replyCap > 0 && conv.ai_reply_count >= replyCap) {
      // Tope alcanzado: NUNCA fantasmear al paciente en silencio
      // (incidente Acerotech: el bot enmudeció justo cuando el lead
      // aceptó la cita). El modo IA no se toca — solo se avisa al
      // equipo (máx. uno por hora) para que responda o suba el tope.
      await notifyTeamOnce(db, {
        accountId,
        conversationId,
        contactId,
        configOwnerUserId,
        title: 'El agente llegó a su tope de respuestas',
        body: 'sigue escribiendo, pero el agente alcanzó el máximo de respuestas automáticas de esta conversación y dejará de contestar aquí. Respóndele tú o ajusta el tope en la configuración de IA.',
      })
      return
    }

    // Debounce: if the patient is mid-burst (several messages in a row),
    // wait for it to go quiet so we answer once, coherently, instead of
    // once per message. Only the invocation that "wins" the burst
    // continues past this point.
    const wonDispatch = await debounceAndClaim(db, conversationId)
    if (!wonDispatch) return

    // The thread may have changed hands (or been switched off) while we
    // were waiting out the burst — re-check before doing any real work.
    const { data: fresh, error: freshErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled')
      .eq('id', conversationId)
      .maybeSingle()
    if (freshErr || !fresh || fresh.assigned_agent_id || fresh.ai_autoreply_disabled) return

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return

    let text: string
    let handoff: boolean
    // Contexto para el guardrail determinista (solo rama clínica): las
    // tools que corrieron + el snapshot de BD que respalda la respuesta.
    let guardContext: { traces: ToolTrace[]; stateLines: string[] } | null = null
    // Re-corre el agente con una nota de corrección al final del hilo
    // (misma config y mismo contexto) — lo usa la ronda de reparación
    // cuando el guardrail bloquea. Solo la rama clínica lo define.
    let rerunWithNote: ((note: string) => Promise<RunClinicalAgentResult>) | null =
      null

    if (config.clinicalAgentEnabled) {
      // clinicOS: agente de Atención con herramientas clínicas (catálogo,
      // agenda, anticipos) en vez de una sola completación. Corre con
      // Anthropic u OpenAI (tool-calling). Se apoya en las tools para los
      // hechos, así que no consulta la KB semántica.
      const { data: contact } = await db
        .from('contacts')
        .select('name')
        .eq('id', contactId)
        .maybeSingle()
      const contactName = (contact?.name as string | null) ?? null
      const timezone = clinicTimezone()
      const now = new Date()

      // Estado REAL del paciente (cita apartada, anticipo en revisión)
      // leído de la BD: las corridas no heredan los tool_results de
      // corridas previas y sin esto el modelo contradice o re-pregunta
      // lo que él mismo ya agendó. El checklist del flujo de recepción
      // (5 pasos) le marca además en qué paso va — no repite ni salta.
      const [stateLines, flowLines] = await Promise.all([
        buildPatientStateLines({ db, accountId, contactId, timezone, now }),
        buildReceptionFlowLines({
          db,
          accountId,
          contactId,
          contactName,
          timezone,
          now,
        }),
      ])

      // Imágenes de la ráfaga actual (p. ej. el comprobante del
      // anticipo): el transcript solo trae marcadores de texto, así que
      // un paso de visión extrae los datos y se inyectan como nota del
      // sistema al final del hilo. Best-effort: sin imágenes (o si la
      // visión falla) la corrida sigue igual.
      const imageNotes = await buildRecentImageNotes({
        db,
        conversationId,
        provider: config.provider,
        apiKey: config.apiKey,
        model: config.model,
        now,
      })
      const agentMessages =
        imageNotes.length > 0
          ? [...messages, { role: 'user' as const, content: imageNotes.join('\n\n') }]
          : messages

      const systemPrompt = buildClinicalSystemPrompt({
        userPrompt: config.systemPrompt,
        contactName,
        timezone,
        now,
        stateLines,
        flowLines,
      })

      const agentArgs = {
        provider: config.provider,
        apiKey: config.apiKey,
        model: config.model,
        systemPrompt,
        ctx: {
          db,
          accountId,
          contactId,
          conversationId,
          userId: configOwnerUserId,
          contactName,
          timezone,
          now,
          embeddingsApiKey: config.embeddingsApiKey,
        },
      }
      const result = await runClinicalAgent({ ...agentArgs, messages: agentMessages })
      text = result.text
      handoff = result.handoff
      guardContext = {
        traces: result.traces ?? [],
        stateLines: [...stateLines, ...flowLines],
      }
      rerunWithNote = (note) =>
        runClinicalAgent({
          ...agentArgs,
          messages: [...agentMessages, { role: 'user' as const, content: note }],
        })
    } else {
      // Ground the reply in the account's knowledge base (best-effort).
      const knowledge = await retrieveKnowledge(
        db,
        accountId,
        config,
        latestUserMessage(messages),
      )

      const systemPrompt = buildSystemPrompt({
        userPrompt: config.systemPrompt,
        mode: 'auto_reply',
        knowledge,
      })

      const gen = await generateReply({ config, systemPrompt, messages })
      text = gen.text
      handoff = gen.handoff
    }

    if (handoff || !text) {
      // The model can't (or shouldn't) answer — this inbound stays
      // unanswered and the team gets a notice (sin notificación, el
      // paciente quedaba esperando sin que nadie supiera que el hilo
      // era suyo). El modo IA queda intacto: el siguiente mensaje
      // vuelve a intentarse en automático.
      await notifyTeamOnce(db, {
        accountId,
        conversationId,
        contactId,
        configOwnerUserId,
        title: 'El agente pasó una conversación al equipo',
        body: 'escribió algo que el agente prefirió no responder en automático. Respóndele tú desde el panel.',
      })
      return
    }

    // Guardrail determinista (rama clínica): la respuesta debe estar
    // respaldada por las tools del turno o por el snapshot de BD. Si no
    // pasa, el texto inseguro NO se envía. Antes de rendirse, UNA ronda
    // de auto-reparación: se re-corre el agente con la nota de qué se
    // bloqueó y por qué — el caso típico (Acerotech) es que el modelo
    // "narró" un agendado sin llamar agendar_cita, y con la nota la
    // segunda pasada sí lo ejecuta (lo que además desbloquea el mensaje
    // del anticipo, que viene en el resultado de esa tool). La salida
    // reparada pasa por el MISMO guardrail; ningún candado se debilita.
    // Si tampoco pasa, el paciente no se queda en visto: sale el
    // fallback neutro de contención (sin precios, sin horarios, sin
    // confirmar nada) que respeta el mismo gate humano y el mismo claim
    // de slot que cualquier envío. El equipo recibe el aviso con el
    // motivo y con qué pasó con el fallback; el modo IA queda intacto
    // (el siguiente inbound se reintenta normal). El texto inseguro no
    // viaja en el aviso (puede traer datos del paciente) — solo los
    // motivos, que no llevan PII.
    if (guardContext) {
      let verdict = validateClinicalReply({
        text,
        traces: guardContext.traces,
        stateLines: guardContext.stateLines,
      })
      if (!verdict.ok && rerunWithNote) {
        console.error(
          `[ai auto-reply] guardrail bloqueó la respuesta: ${verdict.reasons.join('; ')} — reintentando con nota de corrección`,
        )
        const repair = await attemptGuardrailRepair({
          rerun: rerunWithNote,
          blockedText: text,
          verdict,
          priorTraces: guardContext.traces,
          stateLines: guardContext.stateLines,
          logTag: 'ai auto-reply',
        })
        if (repair.ok) {
          text = repair.text
          verdict = { ok: true, reasons: [] }
        } else {
          verdict = repair.verdict
        }
      }
      if (!verdict.ok) {
        const fallbackOutcome = await sendSafeFallback(db, {
          accountId,
          conversationId,
          contactId,
          configOwnerUserId,
          zernioConversationId,
          text: buildClinicalFallbackReply(verdict),
          maxReplies: config.autoReplyMaxPerConversation,
        })
        await notifyTeamOnce(db, {
          accountId,
          conversationId,
          contactId,
          configOwnerUserId,
          title: 'El agente generó una respuesta insegura',
          body: `escribió y el agente generó una respuesta que no pasó las validaciones (${verdict.reasons.join('; ')}), ni siquiera tras el reintento automático de corrección. ${FALLBACK_NOTICE[fallbackOutcome]}${agendaActionHint(verdict)}`,
        })
        return
      }
    }

    // El modo pudo cambiar mientras el modelo generaba (una corrida
    // tarda varios segundos): si un humano tomó el hilo o lo puso en
    // modo humano durante ese lapso, el mensaje ya no debe salir.
    const { data: gate, error: gateErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled')
      .eq('id', conversationId)
      .maybeSingle()
    if (gateErr || !gate || gate.assigned_agent_id || gate.ai_autoreply_disabled) {
      return
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    // Con tope 0 (sin tope) el claim sigue corriendo — mantiene el
    // contador ai_reply_count para métricas — pero contra un máximo
    // que nunca se alcanza (int4 máximo de Postgres).
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies:
          config.autoReplyMaxPerConversation > 0
            ? config.autoReplyMaxPerConversation
            : 2147483647,
      },
    )
    if (claimErr) return
    if (claimed !== true) {
      // Un inbound concurrente tomó el último slot: mismo tratamiento
      // que el tope — aviso al equipo, nunca silencio, modo IA intacto.
      await notifyTeamOnce(db, {
        accountId,
        conversationId,
        contactId,
        configOwnerUserId,
        title: 'El agente llegó a su tope de respuestas',
        body: 'sigue escribiendo, pero el agente alcanzó el máximo de respuestas automáticas de esta conversación y dejará de contestar aquí. Respóndele tú o ajusta el tope en la configuración de IA.',
      })
      return
    }

    try {
      await sendAgentReply(db, {
        accountId,
        conversationId,
        contactId,
        configOwnerUserId,
        zernioConversationId,
        text,
      })
    } catch (sendErr) {
      // El envío falló (API key de Zernio revocada, Meta caído, red…):
      // el agente ya "respondió" pero el paciente no recibió nada. La
      // lección Acerotech aplicada a la capa de transporte: nunca
      // silencio — el equipo recibe un aviso para tomar el hilo.
      console.error('[ai auto-reply] outbound send failed:', sendErr)
      await notifyTeamOnce(db, {
        accountId,
        conversationId,
        contactId,
        configOwnerUserId,
        title: 'No se pudo enviar la respuesta del agente',
        body: 'escribió y el agente generó su respuesta, pero el envío por WhatsApp falló. Revisa la conexión con Zernio (API key / suscripción) y respóndele tú desde el panel.',
      })
      return
    }
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}

interface SendAgentReplyArgs {
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  zernioConversationId: string | null
  text: string
}

/**
 * Envía la respuesta del agente al paciente (Meta/engine o Zernio) y la
 * persiste como mensaje del bot. Compartido por el auto-reply del
 * inbound y por el retome al reactivar el modo IA. Lanza si el envío
 * falla — el caller decide cómo avisar.
 */
async function sendAgentReply(
  db: SupabaseClient,
  args: SendAgentReplyArgs,
): Promise<void> {
  const {
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    zernioConversationId,
    text,
  } = args
  if (!zernioConversationId) {
    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
    })
    return
  }
  // Vino por Zernio: responde en la MISMA conversación de inbox
  // (texto libre dentro de la ventana de 24h) y persiste el mensaje
  // del bot nosotros mismos — engineSendText es por-teléfono y la
  // API de Zernio no acepta ese modo para WhatsApp.
  const { messageId } = await zernioSendToConversation({
    conversationId: zernioConversationId,
    text,
  })
  // El webhook message.sent de Zernio suele llegar ANTES de que este
  // insert corra, y su echo persiste la fila como 'agent' (ver
  // processZernioOutboundEcho). Si ya existe, corrige la autoría en
  // vez de duplicar; el eco puede haber guardado el wamid en vez del
  // id que nos devolvió el send, así que el match es por contenido
  // reciente, no por message_id.
  const echoWindowIso = new Date(Date.now() - 2 * 60_000).toISOString()
  const { data: echoRows } = await db
    .from('messages')
    .update({ sender_type: 'bot' })
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'agent')
    .eq('content_text', text)
    .gte('created_at', echoWindowIso)
    .select('id')
  if (!echoRows || echoRows.length === 0) {
    const { error: msgErr } = await db.from('messages').insert({
      conversation_id: conversationId,
      sender_type: 'bot',
      content_type: 'text',
      content_text: text,
      message_id: messageId,
      status: 'sent',
    })
    // 23505 = el eco ganó la carrera entre nuestro UPDATE y este
    // INSERT (UNIQUE de la migración 039) — la fila ya existe.
    if (msgErr && !isUniqueViolation(msgErr)) {
      console.error('[ai auto-reply] zernio reply sent but DB insert failed:', msgErr)
    }
    // Barrido final: si el eco aterrizó ENTRE el relabel de arriba y
    // este insert, quedó una fila 'agent' gemela con otro message_id
    // (el UNIQUE de 039 no la ve) y el panel mostraba cada respuesta
    // del bot dos veces. Nuestra fila 'bot' ya existe; la gemela
    // sobra. La otra dirección (eco DESPUÉS del insert) la corta el
    // dedupe por contenido de processZernioOutboundEcho.
    const { error: sweepErr } = await db
      .from('messages')
      .delete()
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'agent')
      .eq('content_text', text)
      .gte('created_at', echoWindowIso)
    if (sweepErr) {
      console.error('[ai auto-reply] duplicate-echo sweep failed:', sweepErr)
    }
  }
  await db
    .from('conversations')
    .update({
      last_message_text: text,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId)
}

/** Qué pasó con el fallback de contención — se refleja en el aviso.
 *  Estados operativos (skipped_mode, skipped_cap) separados de los
 *  errores técnicos (gate_error, claim_error, send_failed): el aviso
 *  al equipo debe decir la causa REAL, no un genérico. */
type SafeFallbackOutcome =
  | 'sent'
  | 'skipped_mode'
  | 'gate_error'
  | 'skipped_cap'
  | 'claim_error'
  | 'send_failed'

/** Cierre del aviso "respuesta insegura", según el destino del fallback. */
const FALLBACK_NOTICE: Record<SafeFallbackOutcome, string> = {
  sent: 'No se le envió esa respuesta; en su lugar recibió un mensaje neutro de contención (que el equipo lo está revisando). Dale seguimiento tú desde el panel.',
  skipped_mode:
    'No se le envió nada — el hilo ya está en modo humano o asignado a alguien del equipo. Respóndele tú desde el panel.',
  gate_error:
    'No se le envió nada — falló la lectura del estado de la conversación en la base de datos, así que no pude verificar si el hilo sigue en modo IA. Respóndele tú desde el panel.',
  skipped_cap:
    'No se le envió nada — el agente ya está en su tope de respuestas de esta conversación. Respóndele tú desde el panel.',
  claim_error:
    'No se le envió nada — falló el registro del turno de respuesta en la base de datos. Respóndele tú desde el panel.',
  send_failed:
    'Se intentó enviarle un mensaje neutro de contención, pero el envío por WhatsApp falló. Respóndele tú desde el panel.',
}

/**
 * Envía el fallback neutro que reemplaza a una respuesta bloqueada por
 * el guardrail. Pasa por los MISMOS candados que cualquier respuesta
 * del agente: el gate final de modo humano/asignación (el hilo pudo
 * cambiar de manos mientras el modelo generaba) y el claim atómico del
 * slot (el fallback también cuenta contra el tope). El slot se consume
 * antes del envío, igual que en el flujo normal — fail-safe: ante un
 * envío fallido preferimos sub-responder a sobre-responder. Nunca
 * lanza; devuelve qué pasó para que el aviso al equipo lo cuente.
 */
async function sendSafeFallback(
  db: SupabaseClient,
  args: SendAgentReplyArgs & { maxReplies: number },
): Promise<SafeFallbackOutcome> {
  const { data: gate, error: gateErr } = await db
    .from('conversations')
    .select('assigned_agent_id, ai_autoreply_disabled')
    .eq('id', args.conversationId)
    .maybeSingle()
  if (gateErr || !gate) {
    // No pudimos LEER el estado del hilo — eso no es "modo humano", es
    // un fallo técnico y el aviso debe decirlo tal cual.
    console.error('[ai auto-reply] safe fallback gate read failed:', gateErr)
    return 'gate_error'
  }
  if (gate.assigned_agent_id || gate.ai_autoreply_disabled) {
    return 'skipped_mode'
  }

  const { data: claimed, error: claimErr } = await db.rpc('claim_ai_reply_slot', {
    conversation_id: args.conversationId,
    max_replies: args.maxReplies > 0 ? args.maxReplies : 2147483647,
  })
  if (claimErr) {
    // Ídem: un RPC fallido no es "tope alcanzado".
    console.error('[ai auto-reply] safe fallback claim failed:', claimErr)
    return 'claim_error'
  }
  if (claimed !== true) return 'skipped_cap'

  try {
    await sendAgentReply(db, args)
    return 'sent'
  } catch (sendErr) {
    console.error('[ai auto-reply] safe fallback send failed:', sendErr)
    return 'send_failed'
  }
}

interface GuardrailRepairArgs {
  /** Re-corre el agente con la nota de corrección anexada al hilo. */
  rerun: (note: string) => Promise<RunClinicalAgentResult>
  /** El texto que el guardrail bloqueó (va en la nota, solo al modelo). */
  blockedText: string
  /** Veredicto del bloqueo original — motivos y categorías para la nota. */
  verdict: GuardrailVerdict
  /** Tools que SÍ corrieron en la primera pasada: siguen siendo
   *  evidencia legítima del turno para validar la respuesta reparada. */
  priorTraces: ToolTrace[]
  stateLines: string[]
  logTag: string
}

type GuardrailRepairResult =
  | { ok: true; text: string }
  | { ok: false; verdict: GuardrailVerdict }

/**
 * UNA ronda de auto-reparación tras un bloqueo del guardrail: re-corre
 * el agente con la nota de qué se bloqueó y por qué (la señal que le
 * faltaba para llamar la tool que no llamó — p. ej. agendar_cita cuando
 * el paciente ya aceptó un horario) y valida la nueva salida con el
 * MISMO guardrail, sumando las trazas de ambas pasadas como evidencia
 * del turno. Acotada a un intento: los bloqueos son raros y una segunda
 * corrida ya duplica costo/latencia. Nunca lanza — si la reparación
 * falla (verdict nuevo, texto vacío, handoff o error de proveedor), el
 * caller sigue con el veredicto más fresco que tengamos.
 */
async function attemptGuardrailRepair(
  args: GuardrailRepairArgs,
): Promise<GuardrailRepairResult> {
  try {
    const second = await args.rerun(
      buildGuardrailRepairNote(args.verdict, args.blockedText),
    )
    if (second.handoff || !second.text) return { ok: false, verdict: args.verdict }
    const verdict = validateClinicalReply({
      text: second.text,
      traces: [...args.priorTraces, ...(second.traces ?? [])],
      stateLines: args.stateLines,
    })
    if (verdict.ok) {
      console.log(`[${args.logTag}] la ronda de corrección pasó el guardrail`)
      return { ok: true, text: second.text }
    }
    console.error(
      `[${args.logTag}] el reintento de corrección tampoco pasó: ${verdict.reasons.join('; ')}`,
    )
    return { ok: false, verdict }
  } catch (err) {
    console.error(`[${args.logTag}] el reintento de corrección falló:`, err)
    return { ok: false, verdict: args.verdict }
  }
}

/**
 * Cierre accionable del aviso cuando el bloqueo fue de agenda: en el
 * caso típico el paciente estaba ACEPTANDO un horario que el agente no
 * logró apartar — el equipo debe apartarlo él, no solo "dar
 * seguimiento".
 */
function agendaActionHint(verdict: GuardrailVerdict): string {
  const cats = verdict.categories ?? []
  return cats.includes('horario') || cats.includes('cita_confirmada')
    ? ' Si el paciente estaba aceptando un horario, apártale tú la cita desde la agenda del panel.'
    : ''
}

export interface ResumeDispatchArgs {
  accountId: string
  conversationId: string
  contactId: string
  /** Usuario del panel que reactivó el modo IA — audita el envío. */
  configOwnerUserId: string
  zernioConversationId?: string | null
}

/**
 * Retome de contexto al reactivar el modo IA desde el panel.
 *
 * Cuando una conversación estuvo en modo humano y el equipo vuelve a
 * encender la IA, el agente relee el hilo completo (incluidos los
 * mensajes que el equipo escribió mientras la IA estaba en pausa) y
 * decide si quedó algo pendiente con el paciente: una duda a medias,
 * un comprobante sin atender, una cita sin cerrar. Si lo hay, manda UN
 * mensaje retomándolo; si no, contesta el centinela de handoff y aquí
 * se descarta en silencio — sin aviso al equipo, que acaba de soltar
 * el hilo y conoce su estado.
 *
 * Solo corre para cuentas con agente clínico. Reutiliza el debounce
 * compartido (ai_dispatch_due_at) para que un doble click del switch o
 * un inbound simultáneo no produzcan dos respuestas. Nunca lanza.
 */
export async function dispatchAiResume(args: ResumeDispatchArgs): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args
  const zernioConversationId = args.zernioConversationId ?? null

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled || !config.clinicalAgentEnabled) return

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id || conv.ai_autoreply_disabled) return

    const wonDispatch = await debounceAndClaim(db, conversationId)
    if (!wonDispatch) return

    const { data: fresh, error: freshErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled')
      .eq('id', conversationId)
      .maybeSingle()
    if (freshErr || !fresh || fresh.assigned_agent_id || fresh.ai_autoreply_disabled) return

    const messages = await buildConversationContext(db, conversationId)
    // Sin mensajes del paciente no hay nada que retomar.
    if (!messages.some((m) => m.role === 'user')) return

    const { data: contact } = await db
      .from('contacts')
      .select('name')
      .eq('id', contactId)
      .maybeSingle()
    const contactName = (contact?.name as string | null) ?? null
    const timezone = clinicTimezone()
    const now = new Date()

    const [stateLines, flowLines] = await Promise.all([
      buildPatientStateLines({ db, accountId, contactId, timezone, now }),
      buildReceptionFlowLines({
        db,
        accountId,
        contactId,
        contactName,
        timezone,
        now,
      }),
    ])

    // Una imagen sin atender (p. ej. un comprobante que llegó justo
    // antes de pasar a modo humano) también cuenta como pendiente: el
    // paso de visión la describe igual que en el flujo normal.
    const imageNotes = await buildRecentImageNotes({
      db,
      conversationId,
      provider: config.provider,
      apiKey: config.apiKey,
      model: config.model,
      now,
    })

    const resumeNote = `[Nota automática del sistema — el paciente NO escribió esto: la conversación estuvo en MODO HUMANO (la atendió el equipo desde el panel) y acaban de reactivar el modo IA. Relee los últimos mensajes del hilo — sobre todo los 3 más recientes, que pueden incluir respuestas escritas por el equipo. Si el último mensaje del paciente quedó sin respuesta o quedó un pendiente abierto (una duda a medias, un pago por confirmar, una cita sin cerrar), retómalo AHORA con un solo mensaje breve y cálido que continúe lo que el equipo ya le dijo — sin contradecirlo, sin repetir lo que ya le respondieron y sin saludar como si fuera una conversación nueva. Si no hay nada pendiente que retomar, responde exactamente ${HANDOFF_SENTINEL} y nada más: es una señal interna y al paciente no le llegará nada.]`

    const agentMessages = [
      ...messages,
      ...(imageNotes.length > 0
        ? [{ role: 'user' as const, content: imageNotes.join('\n\n') }]
        : []),
      { role: 'user' as const, content: resumeNote },
    ]

    const systemPrompt = buildClinicalSystemPrompt({
      userPrompt: config.systemPrompt,
      contactName,
      timezone,
      now,
      stateLines,
      flowLines,
    })

    const agentArgs = {
      provider: config.provider,
      apiKey: config.apiKey,
      model: config.model,
      systemPrompt,
      ctx: {
        db,
        accountId,
        contactId,
        conversationId,
        userId: configOwnerUserId,
        contactName,
        timezone,
        now,
        embeddingsApiKey: config.embeddingsApiKey,
      },
    }
    const result = await runClinicalAgent({ ...agentArgs, messages: agentMessages })

    // Handoff aquí significa "nada que retomar": descarte silencioso.
    if (result.handoff || !result.text) return

    // Mismo guardrail que el inbound, con la misma ronda de reparación:
    // un retome sin respaldo tampoco sale — y si tampoco la segunda
    // pasada lo respalda, aquí sí se avisa (a diferencia del handoff
    // silencioso, esto es una respuesta insegura, no una salida feliz).
    //
    // Decisión deliberada: en el retome NO se manda el fallback de
    // contención. Quien reactivó la IA acaba de estar en el hilo desde
    // el panel y no hay un mensaje nuevo del paciente esperando
    // respuesta inmediata; un "lo reviso con el equipo" automático
    // justo después de que el equipo atendió confunde más de lo que
    // contiene. Basta el aviso para que lo retome una persona.
    let replyText = result.text
    let verdict = validateClinicalReply({
      text: replyText,
      traces: result.traces ?? [],
      stateLines: [...stateLines, ...flowLines],
    })
    if (!verdict.ok) {
      console.error(
        `[ai resume] guardrail bloqueó la respuesta: ${verdict.reasons.join('; ')} — reintentando con nota de corrección`,
      )
      const repair = await attemptGuardrailRepair({
        rerun: (note) =>
          runClinicalAgent({
            ...agentArgs,
            messages: [...agentMessages, { role: 'user' as const, content: note }],
          }),
        blockedText: replyText,
        verdict,
        priorTraces: result.traces ?? [],
        stateLines: [...stateLines, ...flowLines],
        logTag: 'ai resume',
      })
      if (repair.ok) {
        replyText = repair.text
        verdict = { ok: true, reasons: [] }
      } else {
        verdict = repair.verdict
      }
    }
    if (!verdict.ok) {
      await notifyTeamOnce(db, {
        accountId,
        conversationId,
        contactId,
        configOwnerUserId,
        title: 'El agente generó una respuesta insegura',
        body: `tenía un pendiente al reactivar el modo IA, pero la respuesta del agente no pasó las validaciones (${verdict.reasons.join('; ')}), ni siquiera tras el reintento automático de corrección. No se le envió nada — acabas de tener el hilo en el panel; retómalo tú directamente.`,
      })
      return
    }

    // El modo pudo volver a cambiar mientras el modelo generaba.
    const { data: gate, error: gateErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled')
      .eq('id', conversationId)
      .maybeSingle()
    if (gateErr || !gate || gate.assigned_agent_id || gate.ai_autoreply_disabled) return

    const { data: claimed, error: claimErr } = await db.rpc('claim_ai_reply_slot', {
      conversation_id: conversationId,
      max_replies:
        config.autoReplyMaxPerConversation > 0
          ? config.autoReplyMaxPerConversation
          : 2147483647,
    })
    if (claimErr || claimed !== true) return

    try {
      await sendAgentReply(db, {
        accountId,
        conversationId,
        contactId,
        configOwnerUserId,
        zernioConversationId,
        text: replyText,
      })
    } catch (sendErr) {
      console.error('[ai resume] outbound send failed:', sendErr)
      await notifyTeamOnce(db, {
        accountId,
        conversationId,
        contactId,
        configOwnerUserId,
        title: 'No se pudo enviar la respuesta del agente',
        body: 'tenía un pendiente y el agente intentó retomarlo al reactivar el modo IA, pero el envío por WhatsApp falló. Revisa la conexión con Zernio (API key / suscripción) y respóndele tú desde el panel.',
      })
    }
  } catch (err) {
    console.error('[ai resume] dispatch failed:', err)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface NotifyArgs {
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  /** También es la llave del candado anti-spam. */
  title: string
  /** Se antepone el nombre del contacto: "<nombre> <body>". */
  body: string
}

/**
 * Aviso al equipo con candado anti-spam temporal: máximo un aviso por
 * conversación y por título por hora. Es el ÚNICO efecto de los caminos
 * degradados (tope, handoff, envío fallido) — el modo IA↔humano nunca
 * se cambia automáticamente; solo lo escribe el interruptor del panel.
 * Best-effort: nunca lanza.
 */
async function notifyTeamOnce(db: SupabaseClient, args: NotifyArgs): Promise<void> {
  try {
    const sinceIso = new Date(Date.now() - 60 * 60_000).toISOString()
    const { data: recent } = await db
      .from('notifications')
      .select('id')
      .eq('conversation_id', args.conversationId)
      .eq('type', 'ai_escalation')
      .eq('title', args.title)
      .gte('created_at', sinceIso)
      .limit(1)
      .maybeSingle()
    if (recent) return

    const { data: contact } = await db
      .from('contacts')
      .select('name, phone')
      .eq('id', args.contactId)
      .maybeSingle()
    const who = contact?.name || contact?.phone || 'Un paciente'

    await db.from('notifications').insert({
      account_id: args.accountId,
      user_id: args.configOwnerUserId,
      type: 'ai_escalation',
      conversation_id: args.conversationId,
      contact_id: args.contactId,
      actor_user_id: null,
      title: args.title,
      body: `${who} ${args.body}`,
    })
  } catch (err) {
    console.error('[ai auto-reply] team notice failed:', err)
  }
}

/**
 * Debounces the AI reply per conversation. Every call reschedules the
 * shared `ai_dispatch_due_at` column forward (last message in the burst
 * wins), then waits it out — polling in short sleeps inside this same
 * invocation, since the app is serverless with no persistent scheduler
 * to hand this off to. Once the window has genuinely elapsed without
 * being pushed further, it atomically claims the dispatch via
 * `claim_ai_dispatch_slot` (compare-and-swap, mirrors
 * `claim_ai_reply_slot`). Exactly one invocation per burst gets `true`;
 * the rest see the column change or clear underneath them and stand
 * down. `buildConversationContext` rereads the full recent transcript
 * regardless of which message triggered it, so the single winning
 * dispatch already answers the whole accumulated burst.
 */
async function debounceAndClaim(
  db: SupabaseClient,
  conversationId: string,
): Promise<boolean> {
  const windowMs = aiDebounceWindowMs()
  if (windowMs <= 0) return true // disabled (e.g. AI_DEBOUNCE_WINDOW_MS=0 in tests)

  const dueAt = new Date(Date.now() + windowMs)
  const { data: sched, error: schedErr } = await db
    .from('conversations')
    .update({ ai_dispatch_due_at: dueAt.toISOString() })
    .eq('id', conversationId)
    .select('ai_dispatch_due_at')
    .maybeSingle()
  if (schedErr || !sched?.ai_dispatch_due_at) return false

  let observed = new Date(sched.ai_dispatch_due_at as string).getTime()
  const deadline = Date.now() + aiDebounceMaxWaitMs()

  while (true) {
    const remaining = observed - Date.now()
    const budget = deadline - Date.now()
    if (remaining <= 0 || budget <= 0) break
    await sleep(Math.min(remaining, budget))

    const { data: row } = await db
      .from('conversations')
      .select('ai_dispatch_due_at')
      .eq('id', conversationId)
      .maybeSingle()
    if (!row?.ai_dispatch_due_at) return false // someone else already claimed it
    observed = new Date(row.ai_dispatch_due_at as string).getTime()
  }

  const { data: claimed, error: claimErr } = await db.rpc('claim_ai_dispatch_slot', {
    conversation_id: conversationId,
    expected_due_at: new Date(observed).toISOString(),
  })
  return !claimErr && claimed === true
}
