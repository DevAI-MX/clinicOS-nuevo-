// ============================================================
// POST /api/inbox/conversations/{id}/ai-resume
//
// Retome de contexto al reactivar el modo IA: el panel llama aquí
// justo después de apagar `ai_autoreply_disabled`. El agente relee el
// hilo (incluidos los mensajes que el equipo escribió en modo humano)
// y decide si quedó algo pendiente con el paciente; si no, no envía
// nada. El trabajo pesado corre en after() para responder de inmediato.
//
// Auth: sesión del dashboard. El cliente RLS solo ve conversaciones de
// la cuenta del usuario, así que un id ajeno → 404.
// ============================================================

import { NextResponse, after } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { dispatchAiResume } from '@/lib/ai/auto-reply'

// El retome espera el debounce compartido (~9s) y luego corre el agente
// completo (tools incluidas) — necesita más que los 10s default.
export const maxDuration = 60

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: conv, error: convErr } = await supabase
      .from('conversations')
      .select(
        'id, account_id, contact_id, zernio_conversation_id, ai_autoreply_disabled, assigned_agent_id',
      )
      .eq('id', id)
      .maybeSingle()
    if (convErr || !conv) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }
    if (conv.ai_autoreply_disabled || conv.assigned_agent_id || !conv.contact_id) {
      // Nada que retomar: la conversación sigue en modo humano (o no
      // tiene paciente). No es un error — el dispatch simplemente no corre.
      return NextResponse.json({ queued: false })
    }

    after(() =>
      dispatchAiResume({
        accountId: conv.account_id as string,
        conversationId: conv.id as string,
        contactId: conv.contact_id as string,
        configOwnerUserId: user.id,
        zernioConversationId:
          (conv.zernio_conversation_id as string | null) ?? null,
      }),
    )

    return NextResponse.json({ queued: true }, { status: 202 })
  } catch (error) {
    console.error('[inbox/ai-resume] unexpected error:', error)
    return NextResponse.json({ error: 'Failed to queue AI resume' }, { status: 500 })
  }
}
