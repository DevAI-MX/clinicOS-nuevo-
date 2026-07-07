// ============================================================
// Zernio inbound pipeline.
//
// Maps Zernio webhook events onto the SAME wacrm pipeline the Meta
// webhook drives: find-or-create contact (shared dedupe helper) →
// find-or-create conversation → insert message → automations → AI
// auto-reply → public webhook fan-out. The Zernio webhook route is
// just another front door; nothing downstream knows (or cares) which
// transport delivered the message.
//
// Where the Meta route's helpers are module-private
// (src/app/api/whatsapp/webhook/route.ts — findOrCreateContact,
// handleStatusUpdate ladder, reaction upsert), the equivalent logic
// is mirrored here 1:1 with pointers back to the original, and the
// shared building blocks (dedupe, engines, dispatchers) are imported
// from their canonical modules.
//
// Deliberate divergences from the Meta pipeline (see docs/ZERNIO.md):
//   * Flows are NOT dispatched. Zernio's message.received payload
//     carries no interactive button/list reply ids, and flow prompts
//     send interactive messages that have no Zernio mapping yet, so a
//     run could never advance. Automations + AI auto-reply run for
//     every inbound instead (no flow-consumption suppression).
//   * Media attachments store Zernio's URL directly (no media proxy);
//     those URLs may expire for Meta-hosted files.
// ============================================================

import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { resolveZernioWacrmAccount } from './config'

// ============================================================
// Zernio payload shapes (from https://zernio.com/openapi.yaml)
// ============================================================

export interface ZernioAttachment {
  /** image | video | file | sticker | audio */
  type: string
  url: string
  payload?: Record<string, unknown>
}

export interface ZernioSender {
  /** WhatsApp: phone without leading `+` when available, else a BSUID. */
  id: string
  contactId?: string
  name?: string
  /** WhatsApp only: E.164 with leading `+`. Nullable post-BSUID rollout. */
  phoneNumber?: string | null
}

export interface ZernioInboundMessage {
  /** Zernio's internal message id. */
  id: string
  conversationId?: string
  platform: string
  /** The platform-native id (WhatsApp wamid). */
  platformMessageId?: string
  direction: 'incoming' | 'outgoing'
  text?: string | null
  attachments?: ZernioAttachment[]
  sender?: ZernioSender
  sentAt?: string
  isRead?: boolean
}

export interface ZernioReaction {
  emoji: string
  action?: 'added' | 'removed'
  /** Zernio's internal id of the reacted-to message, when resolvable. */
  messageId?: string
  /** Platform-native id of the reacted-to message (wamid). */
  platformMessageId?: string
  sender?: ZernioSender
  reactedAt?: string
}

export interface ZernioWebhookEvent {
  id?: string
  event: string
  message?: ZernioInboundMessage
  reaction?: ZernioReaction
  account?: { id?: string; platform?: string; username?: string }
  timestamp?: string
}

// ============================================================
// Pure mapping — exported for tests
// ============================================================

/**
 * Zernio attachment type → wacrm messages.content_type (the CHECK
 * constraint allows text, image, document, audio, video, location,
 * template, interactive). Mirrors the Meta route's mapping, including
 * sticker → image.
 */
export function mapZernioAttachmentType(type: string): 'image' | 'video' | 'document' | 'audio' {
  switch (type) {
    case 'image':
    case 'sticker':
      return 'image'
    case 'video':
      return 'video'
    case 'audio':
      return 'audio'
    case 'file':
    default:
      return 'document'
  }
}

export interface MappedZernioInbound {
  /** Digits-only phone, same normal form as the Meta webhook stores. */
  senderPhone: string
  senderName: string
  /** Value persisted to messages.message_id (used for idempotency + status matching). */
  storedMessageId: string
  contentType: 'text' | 'image' | 'video' | 'document' | 'audio'
  contentText: string | null
  mediaUrl: string | null
  createdAtIso: string
  /** Zernio's inbox conversation id — needed to REPLY (freeform sends go
   *  to /v1/inbox/conversations/{id}/messages, not by phone). */
  zernioConversationId: string | null
}

/**
 * Map a Zernio `message.received` payload to the wacrm message shape.
 * Returns null when the message can't be attributed to a phone number
 * (e.g. a BSUID-only sender during Meta's username rollout) — wacrm's
 * contact identity is phone-based, so those are skipped with a log.
 */
export function mapZernioInbound(message: ZernioInboundMessage): MappedZernioInbound | null {
  const rawPhone = message.sender?.phoneNumber || message.sender?.id || ''
  const senderPhone = normalizePhone(rawPhone)
  if (!senderPhone) return null

  const firstAttachment = message.attachments?.[0]
  const contentType = firstAttachment ? mapZernioAttachmentType(firstAttachment.type) : 'text'

  const text = typeof message.text === 'string' && message.text !== '' ? message.text : null

  return {
    senderPhone,
    senderName: message.sender?.name || senderPhone,
    // Prefer the wamid so ids stay comparable with the Meta-direct
    // path; Zernio's internal id is the fallback.
    storedMessageId: message.platformMessageId || message.id,
    contentType,
    contentText: text,
    mediaUrl: firstAttachment?.url || null,
    createdAtIso: message.sentAt
      ? new Date(message.sentAt).toISOString()
      : new Date().toISOString(),
    zernioConversationId: message.conversationId || null,
  }
}

export interface MappedZernioOutboundEcho {
  /** Value persisted to messages.message_id (wamid preferred). */
  storedMessageId: string
  contentType: 'text' | 'image' | 'video' | 'document' | 'audio'
  contentText: string | null
  mediaUrl: string | null
  createdAtIso: string
  /** Zernio inbox conversation id — the only key we have to map the
   *  echo back to a wacrm conversation (outbound payloads carry the
   *  business as sender, not the customer's phone). */
  zernioConversationId: string
  /** Both ids the send-time persistence could have stored (client.ts
   *  prefers the wamid but falls back to Zernio's internal id) — used
   *  to dedupe against messages already inserted by panel/bot sends. */
  candidateIds: string[]
}

/**
 * Map a Zernio `message.sent` echo (a send made from ANY surface —
 * wacrm panel, bot, the phone's WhatsApp, Zernio's dashboard) to the
 * wacrm agent-message shape. Returns null when the echo can't or
 * shouldn't be persisted: wrong direction, no conversation id to map
 * it back, or no content (status-only echoes).
 */
export function mapZernioOutboundEcho(
  message: ZernioInboundMessage,
): MappedZernioOutboundEcho | null {
  if (message.direction !== 'outgoing') return null
  if (!message.conversationId) return null

  const firstAttachment = message.attachments?.[0]
  const contentType = firstAttachment
    ? mapZernioAttachmentType(firstAttachment.type)
    : 'text'
  const text = typeof message.text === 'string' && message.text !== '' ? message.text : null
  if (!text && !firstAttachment) return null

  return {
    storedMessageId: message.platformMessageId || message.id,
    contentType,
    contentText: text,
    mediaUrl: firstAttachment?.url || null,
    createdAtIso: message.sentAt
      ? new Date(message.sentAt).toISOString()
      : new Date().toISOString(),
    zernioConversationId: message.conversationId,
    candidateIds: [message.platformMessageId, message.id].filter(
      (v): v is string => Boolean(v),
    ),
  }
}

/** Zernio status event name → wacrm messages.status value. */
export function mapZernioStatusEvent(event: string): 'delivered' | 'read' | 'failed' | null {
  switch (event) {
    case 'message.delivered':
      return 'delivered'
    case 'message.read':
      return 'read'
    case 'message.failed':
      return 'failed'
    default:
      return null
  }
}

// ============================================================
// Status ladder — mirror of the Meta webhook's forward-only ladder
// (src/app/api/whatsapp/webhook/route.ts, module-private there).
// pending → sent → delivered → read → replied; `failed` is a terminal
// side branch only reachable from pending/sent.
// ============================================================

const RECIPIENT_STATUS_LADDER = ['pending', 'sent', 'delivered', 'read', 'replied'] as const

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s)
  return idx < 0 ? -1 : idx
}

export function isValidStatusTransition(current: string, incoming: string): boolean {
  if (incoming === 'failed') {
    return current === 'pending' || current === 'sent'
  }
  if (current === 'failed') return false
  const ci = ladderLevel(current)
  const ii = ladderLevel(incoming)
  if (ii < 0) return false
  if (ci < 0) return true
  return ii > ci
}

// ============================================================
// Event dispatcher — called from the route's after() block
// ============================================================

/**
 * Process one Zernio webhook event. Never throws — the route has
 * already acked 200 and errors here must only log.
 */
export async function processZernioEvent(payload: ZernioWebhookEvent): Promise<void> {
  try {
    switch (payload.event) {
      case 'message.received':
        await processZernioInboundMessage(payload)
        return
      case 'message.delivered':
      case 'message.read':
      case 'message.failed':
        await applyZernioStatusUpdate(payload)
        return
      case 'reaction.received':
        await handleZernioReaction(payload)
        return
      case 'message.sent':
        // Un humano puede responder por FUERA de wacrm (el teléfono con
        // WhatsApp, el dashboard de Zernio). Ese echo se persiste como
        // mensaje de agente para que el hilo — y el contexto que lee el
        // agente IA al retomar — quede completo. Los envíos hechos desde
        // wacrm (panel o bot) ya se guardaron al mandarse y se
        // deduplican por message_id.
        await processZernioOutboundEcho(payload)
        return
      case 'webhook.test':
        console.log('[zernio] webhook.test received — endpoint reachable')
        return
      default:
        console.log(`[zernio] ignoring unhandled event "${payload.event}"`)
    }
  } catch (error) {
    console.error('[zernio] error processing event:', error)
  }
}

// ============================================================
// message.received
// ============================================================

async function processZernioInboundMessage(payload: ZernioWebhookEvent): Promise<void> {
  const message = payload.message
  if (!message) {
    console.warn('[zernio] message.received without a message object — skipping')
    return
  }
  if (message.platform !== 'whatsapp') {
    // Zernio is multi-platform; wacrm only speaks WhatsApp.
    console.log(`[zernio] ignoring ${message.platform} message (WhatsApp only)`)
    return
  }
  if (message.direction !== 'incoming') return

  const mapped = mapZernioInbound(message)
  if (!mapped) {
    console.warn(
      '[zernio] inbound message has no resolvable phone number (BSUID-only sender?) — skipping',
      message.id,
    )
    return
  }

  const db = supabaseAdmin()
  const account = await resolveZernioWacrmAccount(db)
  if (!account) return
  const { accountId, userId } = account

  // Find or create contact — same shared dedupe helper the Meta
  // webhook, manual form, and CSV import use (issue #212).
  const contactOutcome = await findOrCreateContact(
    accountId,
    userId,
    mapped.senderPhone,
    mapped.senderName,
  )
  if (!contactOutcome) return
  const contact = contactOutcome.contact

  const convResult = await findOrCreateConversation(accountId, userId, contact.id)
  if (!convResult) return
  const conversation = convResult.conversation

  if (convResult.created) {
    await dispatchWebhookEvent(db, accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contact.id,
    })
  }

  // Idempotency — Zernio retries undelivered webhooks, and we ack-200
  // before processing (same as the Meta route), so replays are
  // expected. The Meta path relies on the fast ack alone; here the
  // stable platformMessageId lets us dedupe explicitly, scoped to the
  // conversation (messages.message_id is not globally unique —
  // migration 009).
  const { data: existing } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversation.id)
    .eq('message_id', mapped.storedMessageId)
    .limit(1)
    .maybeSingle()
  if (existing) {
    console.log('[zernio] duplicate delivery of', mapped.storedMessageId, '— skipping')
    return
  }

  // First-inbound detection BEFORE inserting — mirrors the Meta route.
  const { count: priorCustomerMsgCount } = await db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  const { error: msgError } = await db.from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'customer',
    content_type: mapped.contentType,
    content_text: mapped.contentText,
    media_url: mapped.mediaUrl,
    message_id: mapped.storedMessageId,
    status: 'delivered',
    created_at: mapped.createdAtIso,
  })
  if (msgError) {
    console.error('[zernio] error inserting message:', msgError)
    return
  }

  const { error: convError } = await db
    .from('conversations')
    .update({
      last_message_text: mapped.contentText || `[${mapped.contentType}]`,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
      // Persistimos (y refrescamos) el id de conversación de Zernio para
      // que un humano en el panel pueda responder por la vía de inbox —
      // el webhook es la única fuente de este id. Ver send-message.ts.
      ...(mapped.zernioConversationId
        ? { zernio_conversation_id: mapped.zernioConversationId }
        : {}),
    })
    .eq('id', conversation.id)
  if (convError) {
    console.error('[zernio] error updating conversation:', convError)
  }

  await flagBroadcastReplyIfAny(accountId, contact.id)

  // Flows are intentionally NOT dispatched (see module header). That
  // means no flow can consume the message, so the content-level
  // automation triggers always fire — matching the Meta route's
  // flowConsumed=false branch.
  const inboundText = mapped.contentText ?? ''
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
  )[] = ['new_message_received', 'keyword_match']
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  for (const triggerType of automationTriggers) {
    runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contact.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
      },
    }).catch((err) => console.error('[zernio] automations dispatch failed:', err))
  }

  // AI auto-reply for plain-text inbound — same gate as the Meta
  // route minus the flow-consumption check. Its outbound send goes
  // through meta-api's sendTextMessage, which routes back through
  // Zernio when the adapter is enabled.
  if (mapped.contentType === 'text' && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contact.id,
      configOwnerUserId: userId,
      // La respuesta debe volver a ESTA conversación de Zernio (envío por
      // inbox, no por teléfono). Ver zernioSendToConversation.
      zernioConversationId: mapped.zernioConversationId,
    })
  }

  await dispatchWebhookEvent(db, accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contact.id,
    whatsapp_message_id: mapped.storedMessageId,
    content_type: mapped.contentType,
    text: mapped.contentText,
  })
}

// ============================================================
// message.sent — echo de envíos hechos fuera de wacrm
// ============================================================

/**
 * Persist an outbound echo as an `agent` message. Covers replies the
 * team sends from the phone's WhatsApp or from Zernio's own dashboard —
 * without this, those messages never reach `messages` and the AI agent
 * resumes the thread blind to what the human said. Sends made through
 * wacrm (panel or bot) were already persisted at send time and are
 * skipped via the message_id dedupe.
 */
async function processZernioOutboundEcho(payload: ZernioWebhookEvent): Promise<void> {
  const message = payload.message
  if (!message) return
  if (message.platform && message.platform !== 'whatsapp') return

  const mapped = mapZernioOutboundEcho(message)
  if (!mapped) return

  const db = supabaseAdmin()
  const account = await resolveZernioWacrmAccount(db)
  if (!account) return

  // Solo conversaciones que ya conocemos: el id de inbox de Zernio se
  // persiste al recibir inbounds (processZernioInboundMessage). Un echo
  // hacia una conversación sin espejo en wacrm se ignora.
  const { data: conversation } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', account.accountId)
    .eq('zernio_conversation_id', mapped.zernioConversationId)
    .maybeSingle()
  if (!conversation) {
    console.log(
      '[zernio] message.sent for unmapped conversation — skipping',
      mapped.zernioConversationId,
    )
    return
  }

  const { data: existing } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversation.id)
    .in('message_id', mapped.candidateIds)
    .limit(1)
    .maybeSingle()
  if (existing) return // persisted at send time (panel/bot) or a replay

  const { error: msgError } = await db.from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'agent',
    content_type: mapped.contentType,
    content_text: mapped.contentText,
    media_url: mapped.mediaUrl,
    message_id: mapped.storedMessageId,
    status: 'sent',
    created_at: mapped.createdAtIso,
  })
  if (msgError) {
    console.error('[zernio] error inserting outbound echo:', msgError)
    return
  }

  // Refleja el envío en la lista del inbox (sin tocar unread_count —
  // es un mensaje nuestro, no del paciente).
  const { error: convError } = await db
    .from('conversations')
    .update({
      last_message_text: mapped.contentText || `[${mapped.contentType}]`,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)
  if (convError) {
    console.error('[zernio] error updating conversation after echo:', convError)
  }
}

// ============================================================
// message.delivered / message.read / message.failed
// ============================================================

/**
 * Apply a Zernio delivery-status event. Mirrors the Meta route's
 * handleStatusUpdate: (1) mirror onto messages, (2) forward-only
 * ladder update on broadcast_recipients, (3) public webhook fan-out.
 *
 * Outbound rows persisted messageId = platformMessageId when Zernio
 * returned one, else Zernio's internal id — so we match on both.
 */
export async function applyZernioStatusUpdate(payload: ZernioWebhookEvent): Promise<void> {
  const status = mapZernioStatusEvent(payload.event)
  const message = payload.message
  if (!status || !message) return
  if (message.platform && message.platform !== 'whatsapp') return

  const db = supabaseAdmin()
  const candidateIds = [message.platformMessageId, message.id].filter(
    (v): v is string => Boolean(v),
  )
  if (candidateIds.length === 0) return

  // 1) Mirror onto messages. 0..N rows, like the Meta path.
  const { error: msgErr } = await db
    .from('messages')
    .update({ status })
    .in('message_id', candidateIds)
  if (msgErr) {
    console.error('[zernio] error updating message status:', msgErr)
  }

  // 2) Broadcast recipients — forward-only ladder.
  const tsIso = payload.timestamp
    ? new Date(payload.timestamp).toISOString()
    : new Date().toISOString()

  const { data: recipient, error: recFetchErr } = await db
    .from('broadcast_recipients')
    .select('id, status')
    .in('whatsapp_message_id', candidateIds)
    .limit(1)
    .maybeSingle()

  if (recFetchErr) {
    console.error('[zernio] error fetching broadcast recipient:', recFetchErr)
  } else if (recipient && isValidStatusTransition(recipient.status, status)) {
    const update: Record<string, unknown> = { status }
    if (status === 'delivered') update.delivered_at = tsIso
    if (status === 'read') update.read_at = tsIso
    const { error: recUpdateErr } = await db
      .from('broadcast_recipients')
      .update(update)
      .eq('id', recipient.id)
    if (recUpdateErr) {
      console.error('[zernio] error updating broadcast recipient status:', recUpdateErr)
    }
  }

  // 3) Public webhook fan-out — resolve owning account via the message row.
  const { data: msgRow } = await db
    .from('messages')
    .select('conversation_id, message_id, conversations(account_id)')
    .in('message_id', candidateIds)
    .limit(1)
    .maybeSingle()

  if (msgRow) {
    // Supabase types an embedded relation as an array; at runtime a
    // to-one join comes back as a single object. Normalise both.
    const rawConv = msgRow.conversations as
      | { account_id: string }
      | { account_id: string }[]
      | null
    const conv = Array.isArray(rawConv) ? rawConv[0] : rawConv
    if (conv?.account_id) {
      await dispatchWebhookEvent(db, conv.account_id, 'message.status_updated', {
        whatsapp_message_id: msgRow.message_id,
        conversation_id: msgRow.conversation_id,
        status,
      })
    }
  }
}

// ============================================================
// reaction.received
// ============================================================

/**
 * Persist an inbound reaction. Same model as the Meta route: reactions
 * are per-(target, actor) state on `message_reactions` — never a row
 * in `messages`. Best-effort: missing contact/target is logged+skipped.
 */
export async function handleZernioReaction(payload: ZernioWebhookEvent): Promise<void> {
  const reaction = payload.reaction
  if (!reaction) return

  const targetPlatformId = reaction.platformMessageId || reaction.messageId
  if (!targetPlatformId) {
    console.warn('[zernio] reaction without a target message id — skipping')
    return
  }

  const senderPhone = normalizePhone(
    reaction.sender?.phoneNumber || reaction.sender?.id || '',
  )
  if (!senderPhone) {
    console.warn('[zernio] reaction sender has no resolvable phone — skipping')
    return
  }

  const db = supabaseAdmin()
  const account = await resolveZernioWacrmAccount(db)
  if (!account) return

  // Reactions only make sense on a message we already have — resolve
  // the existing contact (no auto-create) and the target row.
  const contact = await findExistingContact(db, account.accountId, senderPhone)
  if (!contact) {
    console.warn('[zernio] reaction from unknown contact — skipping', senderPhone)
    return
  }

  const { data: conversation } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', account.accountId)
    .eq('contact_id', contact.id)
    .maybeSingle()
  if (!conversation) {
    console.warn('[zernio] reaction with no conversation for contact — skipping')
    return
  }

  const { data: target, error: targetErr } = await db
    .from('messages')
    .select('id')
    .eq('message_id', targetPlatformId)
    .eq('conversation_id', conversation.id)
    .maybeSingle()
  if (targetErr || !target) {
    console.warn('[zernio] reaction target message not found — skipping', targetPlatformId)
    return
  }

  // action=removed (or an empty emoji, Meta's removal signal) → delete.
  if (reaction.action === 'removed' || !reaction.emoji) {
    const { error: delError } = await db
      .from('message_reactions')
      .delete()
      .eq('message_id', target.id)
      .eq('actor_type', 'customer')
      .eq('actor_id', contact.id)
    if (delError) {
      console.error('[zernio] reaction delete failed:', delError.message)
    }
    return
  }

  const { error: upsertError } = await db.from('message_reactions').upsert(
    {
      message_id: target.id,
      conversation_id: conversation.id,
      actor_type: 'customer',
      actor_id: contact.id,
      emoji: reaction.emoji,
    },
    { onConflict: 'message_id,actor_type,actor_id' },
  )
  if (upsertError) {
    console.error('[zernio] reaction upsert failed:', upsertError.message)
  }
}

// ============================================================
// Contact / conversation find-or-create — mirrors the Meta route's
// module-private helpers (same race handling via the unique index
// from migration 022).
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

interface ContactOutcome {
  contact: ContactRow
  wasCreated: boolean
}

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string,
): Promise<ContactOutcome | null> {
  const db = supabaseAdmin()
  const existingContact = await findExistingContact(db, accountId, phone)

  if (existingContact) {
    if (name && name !== phone && name !== existingContact.name) {
      await db
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
    }
    return { contact: existingContact, wasCreated: false }
  }

  const { data: newContact, error: createError } = await db
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(db, accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('[zernio] error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
) {
  const db = supabaseAdmin()
  const { data: existing, error: findError } = await db
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .single()

  if (!findError && existing) {
    return { conversation: existing, created: false }
  }

  const { data: newConv, error: createError } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    console.error('[zernio] error creating conversation:', createError)
    return null
  }

  return { conversation: newConv, created: true }
}

/**
 * Mirror of the Meta route's flagBroadcastReplyIfAny — flips the
 * sender's most recent unreplied broadcast_recipients row to `replied`
 * so the parent broadcast's reply count advances. Best-effort.
 */
async function flagBroadcastReplyIfAny(accountId: string, contactId: string): Promise<void> {
  const db = supabaseAdmin()
  try {
    const { data: recs, error } = await db
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !recs || recs.length === 0) return

    const { error: updErr } = await db
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', recs[0].id)

    if (updErr) {
      console.error('[zernio] error marking broadcast recipient replied:', updErr)
    }
  } catch (err) {
    console.error('[zernio] flagBroadcastReplyIfAny failed:', err)
  }
}
