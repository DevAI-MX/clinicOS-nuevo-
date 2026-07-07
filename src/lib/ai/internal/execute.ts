// ============================================================
// clinicOS — ejecutor de las herramientas del asistente interno.
//
// Solo lectura: consulta agenda, anticipos pendientes y el embudo de
// IA para el equipo/doctor. Ninguna de estas herramientas confirma
// pagos ni citas — eso lo sigue haciendo el equipo desde el panel.
// ============================================================

import {
  FUNNEL_PIPELINE_NAME,
  formatSlotLabel,
  instantFromLocalDateTime,
  wallPartsInTz,
  type AgentToolContext,
  type ToolExecResult,
} from '../agent'
import type { InternalToolName } from './tools'

function ok(payload: Record<string, unknown>): ToolExecResult {
  return { content: JSON.stringify(payload) }
}
function fail(message: string): ToolExecResult {
  return { content: JSON.stringify({ ok: false, error: message }), isError: true }
}

const APPT_STATUS_LABEL: Record<string, string> = {
  pendiente: 'pendiente de confirmar',
  confirmada: 'confirmada',
  completada: 'completada',
  cancelada: 'cancelada',
  no_asistio: 'no asistió',
}

function fmtMoney(amount: unknown, currency = 'MXN'): string | null {
  const n = typeof amount === 'number' ? amount : Number(amount)
  return Number.isFinite(n) ? `$${n} ${currency}` : null
}

async function contactNamesById(
  ctx: AgentToolContext,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const { data } = await ctx.db.from('contacts').select('id, name, phone').in('id', ids)
  return new Map((data ?? []).map((c) => [c.id as string, (c.name as string) || (c.phone as string)]))
}

async function consultarAgendaDia(
  ctx: AgentToolContext,
  args: { fecha?: string },
): Promise<ToolExecResult> {
  const raw = typeof args.fecha === 'string' ? args.fecha.trim() : ''
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/)
  const wall = m
    ? { year: +m[1], month: +m[2], day: +m[3] }
    : wallPartsInTz(ctx.now, ctx.timezone)
  const dayStart = instantFromLocalDateTime(ctx.timezone, wall, { hour: 0, minute: 0 })
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000)

  const { data: appts, error } = await ctx.db
    .from('appointments')
    .select('id, contact_id, starts_at, status, appointment_type, deposit_status, deposit_amount')
    .eq('account_id', ctx.accountId)
    .gte('starts_at', dayStart.toISOString())
    .lt('starts_at', dayEnd.toISOString())
    .order('starts_at', { ascending: true })
  if (error) return fail(`No pude leer la agenda: ${error.message}`)

  if (!appts || appts.length === 0) {
    return ok({ ok: true, citas: [], nota: 'No hay citas agendadas ese día.' })
  }

  const nameById = await contactNamesById(ctx, [...new Set(appts.map((a) => a.contact_id as string))])

  const citas = appts.map((a) => ({
    paciente: nameById.get(a.contact_id as string) ?? 'Sin nombre',
    hora: formatSlotLabel(new Date(a.starts_at as string), ctx.timezone),
    tipo: a.appointment_type,
    estado: APPT_STATUS_LABEL[a.status as string] ?? a.status,
    anticipo:
      a.deposit_status === 'pendiente'
        ? `pendiente${a.deposit_amount != null ? ` (${fmtMoney(a.deposit_amount)})` : ''}`
        : a.deposit_status === 'pagado'
          ? 'pagado'
          : 'no aplica',
  }))

  return ok({ ok: true, total: citas.length, citas })
}

async function consultarAnticiposPendientes(ctx: AgentToolContext): Promise<ToolExecResult> {
  const { data: payments, error } = await ctx.db
    .from('payments')
    .select('id, contact_id, amount, currency, method, receipt_url, created_at')
    .eq('account_id', ctx.accountId)
    .eq('status', 'pendiente')
    .order('created_at', { ascending: true })
  if (error) return fail(`No pude leer los anticipos: ${error.message}`)

  if (!payments || payments.length === 0) {
    return ok({ ok: true, anticipos: [], nota: 'No hay anticipos pendientes de revisión.' })
  }

  const nameById = await contactNamesById(
    ctx,
    [...new Set(payments.map((p) => p.contact_id as string))],
  )

  const anticipos = payments.map((p) => ({
    paciente: nameById.get(p.contact_id as string) ?? 'Sin nombre',
    monto: fmtMoney(p.amount, (p.currency as string) ?? 'MXN'),
    metodo: p.method,
    comprobante: p.receipt_url ?? null,
    recibido: formatSlotLabel(new Date(p.created_at as string), ctx.timezone),
  }))

  return ok({
    ok: true,
    total: anticipos.length,
    anticipos,
    nota: 'Confírmalos desde el panel — este asistente no puede confirmarlos.',
  })
}

async function consultarEmbudo(ctx: AgentToolContext): Promise<ToolExecResult> {
  const { data: pipeline } = await ctx.db
    .from('pipelines')
    .select('id')
    .eq('account_id', ctx.accountId)
    .eq('name', FUNNEL_PIPELINE_NAME)
    .maybeSingle()

  if (!pipeline) {
    return ok({
      ok: true,
      etapas: [],
      nota: 'El embudo de IA todavía no tiene actividad — se crea solo en cuanto el agente clasifique al primer lead.',
    })
  }

  const { data: stages } = await ctx.db
    .from('pipeline_stages')
    .select('id, name, position')
    .eq('pipeline_id', pipeline.id)
    .order('position', { ascending: true })

  const { data: deals } = await ctx.db
    .from('deals')
    .select('stage_id, value')
    .eq('pipeline_id', pipeline.id)
    .eq('status', 'open')

  const etapas = (stages ?? []).map((s) => {
    const inStage = (deals ?? []).filter((d) => d.stage_id === s.id)
    const valorTotal = inStage.reduce((sum, d) => sum + (Number(d.value) || 0), 0)
    return { etapa: s.name, leads: inStage.length, valor_potencial: fmtMoney(valorTotal) }
  })

  return ok({ ok: true, etapas })
}

async function buscarPaciente(
  ctx: AgentToolContext,
  args: { query?: string },
): Promise<ToolExecResult> {
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (!query) return fail('Falta el nombre o teléfono a buscar.')

  const { data: byName, error: nameErr } = await ctx.db
    .from('contacts')
    .select('id, name, phone, email')
    .eq('account_id', ctx.accountId)
    .ilike('name', `%${query}%`)
    .limit(5)
  if (nameErr) return fail(`No pude buscar al paciente: ${nameErr.message}`)

  const { data: byPhone, error: phoneErr } = await ctx.db
    .from('contacts')
    .select('id, name, phone, email')
    .eq('account_id', ctx.accountId)
    .ilike('phone', `%${query}%`)
    .limit(5)
  if (phoneErr) return fail(`No pude buscar al paciente: ${phoneErr.message}`)

  const seen = new Map<string, Record<string, unknown>>()
  for (const c of [...(byName ?? []), ...(byPhone ?? [])]) seen.set(c.id as string, c)
  const contacts = [...seen.values()].slice(0, 5)

  if (contacts.length === 0) {
    return ok({ ok: true, pacientes: [], nota: 'No encontré ningún paciente con ese nombre o teléfono.' })
  }

  const ids = contacts.map((c) => c.id as string)
  const { data: appts } = await ctx.db
    .from('appointments')
    .select('contact_id, starts_at, status')
    .eq('account_id', ctx.accountId)
    .in('contact_id', ids)
    .order('starts_at', { ascending: false })
    .limit(20)

  const pacientes = contacts.map((c) => {
    const last = (appts ?? []).find((a) => a.contact_id === c.id)
    return {
      nombre: c.name ?? 'Sin nombre',
      telefono: c.phone,
      email: c.email ?? null,
      ultima_cita: last
        ? {
            cuando: formatSlotLabel(new Date(last.starts_at as string), ctx.timezone),
            estado: APPT_STATUS_LABEL[last.status as string] ?? last.status,
          }
        : null,
    }
  })

  return ok({ ok: true, pacientes })
}

/**
 * Ejecuta una herramienta interna por nombre. Nunca lanza: cualquier
 * fallo se devuelve como `tool_result` de error (mismo contrato que
 * `executeClinicalTool`).
 */
export async function executeInternalTool(
  name: string,
  input: unknown,
  ctx: AgentToolContext,
): Promise<ToolExecResult> {
  const args = (input ?? {}) as never
  try {
    switch (name as InternalToolName) {
      case 'consultar_agenda_dia':
        return await consultarAgendaDia(ctx, args)
      case 'consultar_anticipos_pendientes':
        return await consultarAnticiposPendientes(ctx)
      case 'consultar_embudo':
        return await consultarEmbudo(ctx)
      case 'buscar_paciente':
        return await buscarPaciente(ctx, args)
      default:
        return fail(`Herramienta desconocida: ${name}`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return fail(`Error ejecutando ${name}: ${msg}`)
  }
}
