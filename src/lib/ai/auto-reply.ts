import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt, aiDebounceWindowMs, aiDebounceMaxWaitMs } from './defaults'
import { latestUserMessage } from './query'
import {
  runClinicalAgent,
  buildClinicalSystemPrompt,
  clinicTimezone,
} from './agent'
import { engineSendText } from '@/lib/flows/meta-send'
import { zernioSendToConversation } from '@/lib/zernio/client'

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
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
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
    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound).
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) return

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

      const systemPrompt = buildClinicalSystemPrompt({
        userPrompt: config.systemPrompt,
        contactName,
        timezone,
        now,
      })

      const result = await runClinicalAgent({
        provider: config.provider,
        apiKey: config.apiKey,
        model: config.model,
        systemPrompt,
        messages,
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
      })
      text = result.text
      handoff = result.handoff
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
      // The model can't (or shouldn't) answer — stop auto-replying on
      // this thread and leave the inbound unanswered so it surfaces in
      // the inbox for a human. Sticky until an admin re-enables.
      await db
        .from('conversations')
        .update({ ai_autoreply_disabled: true })
        .eq('id', conversationId)
      return
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
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr || claimed !== true) return

    if (zernioConversationId) {
      // Vino por Zernio: responde en la MISMA conversación de inbox
      // (texto libre dentro de la ventana de 24h) y persiste el mensaje
      // del bot nosotros mismos — engineSendText es por-teléfono y la
      // API de Zernio no acepta ese modo para WhatsApp.
      const { messageId } = await zernioSendToConversation({
        conversationId: zernioConversationId,
        text,
      })
      const { error: msgErr } = await db.from('messages').insert({
        conversation_id: conversationId,
        sender_type: 'bot',
        content_type: 'text',
        content_text: text,
        message_id: messageId,
        status: 'sent',
      })
      if (msgErr) {
        console.error('[ai auto-reply] zernio reply sent but DB insert failed:', msgErr)
      }
      await db
        .from('conversations')
        .update({
          last_message_text: text,
          last_message_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', conversationId)
    } else {
      await engineSendText({
        accountId,
        userId: configOwnerUserId,
        conversationId,
        contactId,
        text,
      })
    }
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
