// ============================================================
// DELETE /api/inbox/conversations/{id}
//
// "Eliminar conversación": borra el CONTACTO completo, no solo la
// conversación — así el lead/paciente también desaparece del CRM
// (era el pedido explícito: antes sobrevivía como registro huérfano
// en /contacts). messages, message_reactions, contact_tags,
// contact_custom_values, contact_notes, appointments y payments caen
// por ON DELETE CASCADE (migraciones 001, 009, 031); deals y
// broadcast_recipients sobreviven con su contact_id/conversation_id
// en NULL (mismo patrón que la migración 004: preserva el historial
// del Embudo IA y de broadcasts en vez de borrarlo en silencio).
// Acción destructiva e irreversible — el panel la confirma con
// advertencia explícita de borrado permanente.
//
// Auth: sesión del dashboard. Verificamos pertenencia con el cliente
// RLS y borramos con service-role (borrado + cascada garantizados).
// ============================================================

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'

export async function DELETE(
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

    // RLS: sólo conversaciones de la cuenta del usuario. Id ajeno → 404.
    const { data: conv, error: convErr } = await supabase
      .from('conversations')
      .select('id, contact_id')
      .eq('id', id)
      .maybeSingle()
    if (convErr || !conv) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    // Borrado con service-role — borrar el contacto arrastra la
    // conversación (y todo lo demás) por ON DELETE CASCADE.
    const { error: delErr } = await supabaseAdmin()
      .from('contacts')
      .delete()
      .eq('id', conv.contact_id)
    if (delErr) {
      console.error('[inbox/delete] error deleting contact:', delErr)
      return NextResponse.json(
        { error: 'Failed to delete conversation' },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[inbox/delete] unexpected error:', error)
    return NextResponse.json({ error: 'Failed to delete conversation' }, { status: 500 })
  }
}
