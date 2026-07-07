// ============================================================
// clinicOS — ejecutor de las herramientas del agente de Atención.
//
// Traduce un `tool_use` del modelo en operaciones sobre las tablas de
// la migración 031, SIEMPRE filtrando por account_id/contact_id del
// contexto. Devuelve un `tool_result` (JSON) que el modelo lee para
// componer su respuesta.
//
// Invariantes de la regla de oro:
//   * agendar_cita     → appointments.status = 'pendiente', created_by NULL.
//   * prevalidar_anticipo → payments.status = 'pendiente' (nunca 'confirmado').
//   Un humano confirma en el panel; ninguna herramienta lo hace.
// ============================================================

import {
  APPOINTMENT_TYPES,
  LEAD_STAGES,
  PAYMENT_METHODS,
  RECORD_CATEGORIES,
  type AgentToolContext,
  type ClinicalToolName,
  type ToolExecResult,
} from './tools'
import {
  computeAvailableSlots,
  type BusyInterval,
  type ClinicHoursRow,
} from './availability'
import {
  formatSlotLabel,
  instantFromLocalDateTime,
  parseClockToMinutes,
  wallPartsInTz,
} from './clinic-time'
import { retrieveKnowledge } from '../knowledge'

// Estados de cita que ocupan un hueco (los demás liberan la agenda).
const ACTIVE_APPT_STATUSES = ['pendiente', 'confirmada', 'completada']

function ok(payload: Record<string, unknown>): ToolExecResult {
  return { content: JSON.stringify(payload) }
}
function fail(message: string): ToolExecResult {
  return { content: JSON.stringify({ ok: false, error: message }), isError: true }
}

function money(amount: number | null | undefined, currency = 'MXN'): string | null {
  if (amount == null || Number.isNaN(amount)) return null
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(amount)
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// ------------------------------------------------------------
// Parseo de fecha/hora que manda el modelo.
// ------------------------------------------------------------

/** Detecta si un string trae zona (Z u offset) → instante absoluto. */
function hasExplicitZone(raw: string): boolean {
  return /([zZ]|[+-]\d\d:?\d\d)$/.test(raw.trim())
}

/** Instante desde ISO absoluto, o desde hora local "YYYY-MM-DDTHH:MM". */
function parseStartInstant(raw: string, tz: string): Date | null {
  const s = raw.trim()
  if (hasExplicitZone(s)) {
    const d = new Date(s)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/)
  if (!m) return null
  return instantFromLocalDateTime(
    tz,
    { year: +m[1], month: +m[2], day: +m[3] },
    { hour: +m[4], minute: +m[5] },
  )
}

/** Instante de inicio de día local desde "YYYY-MM-DD"; clamp a `now`. */
function parseFromDate(raw: string | undefined, tz: string, now: Date): Date {
  if (!raw) return now
  const m = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return now
  const start = instantFromLocalDateTime(
    tz,
    { year: +m[1], month: +m[2], day: +m[3] },
    { hour: 0, minute: 0 },
  )
  return start.getTime() < now.getTime() ? now : start
}

// ------------------------------------------------------------
// Cargas compartidas
// ------------------------------------------------------------

async function loadClinicHours(ctx: AgentToolContext): Promise<ClinicHoursRow[]> {
  const { data } = await ctx.db
    .from('clinic_hours')
    .select('weekday, opens_at, closes_at, slot_minutes')
    .eq('account_id', ctx.accountId)
  return (data ?? []) as ClinicHoursRow[]
}

/** Bloqueos + citas activas como intervalos ocupados, desde `from`. */
async function loadBusy(
  ctx: AgentToolContext,
  from: Date,
  excludeApptId?: string,
): Promise<BusyInterval[]> {
  const fromIso = from.toISOString()
  const [blocks, appts] = await Promise.all([
    ctx.db
      .from('schedule_blocks')
      .select('starts_at, ends_at')
      .eq('account_id', ctx.accountId)
      .gt('ends_at', fromIso),
    ctx.db
      .from('appointments')
      .select('id, starts_at, ends_at, status')
      .eq('account_id', ctx.accountId)
      .in('status', ACTIVE_APPT_STATUSES)
      .gt('ends_at', fromIso),
  ])
  const busy: BusyInterval[] = []
  for (const b of blocks.data ?? []) {
    busy.push({ startsAt: new Date(b.starts_at), endsAt: new Date(b.ends_at) })
  }
  for (const a of appts.data ?? []) {
    if (excludeApptId && a.id === excludeApptId) continue
    busy.push({ startsAt: new Date(a.starts_at), endsAt: new Date(a.ends_at) })
  }
  return busy
}

/** Cita activa más próxima del contacto (para reagendar / asociar anticipo). */
async function findActiveAppointment(ctx: AgentToolContext) {
  const { data } = await ctx.db
    .from('appointments')
    .select('id, starts_at, ends_at, status, deposit_status, deposit_amount, procedure_id')
    .eq('account_id', ctx.accountId)
    .eq('contact_id', ctx.contactId)
    .in('status', ['pendiente', 'confirmada'])
    .order('starts_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  return data
}

async function loadProcedure(ctx: AgentToolContext, procedureId: string) {
  const { data } = await ctx.db
    .from('procedures')
    .select('id, name, duration_minutes, deposit_amount, price_min, currency, is_active')
    .eq('account_id', ctx.accountId)
    .eq('id', procedureId)
    .maybeSingle()
  return data
}

/**
 * Procedimiento de valoración/consulta del catálogo (con anticipo
 * definido). Es el respaldo de la regla de oro: TODA valoración lleva
 * anticipo aunque el modelo agende sin procedure_id o con un
 * procedimiento de interés que no tiene anticipo propio (p. ej.
 * "Carillas: se cotiza tras valoración").
 */
async function findValoracionProcedure(ctx: AgentToolContext) {
  const { data } = await ctx.db
    .from('procedures')
    .select('id, name, duration_minutes, deposit_amount, price_min, currency')
    .eq('account_id', ctx.accountId)
    .eq('is_active', true)
    .or('name.ilike.%valoraci%,name.ilike.%consulta%')
    .not('deposit_amount', 'is', null)
    .order('price_min', { ascending: true })
    .limit(1)
    .maybeSingle()
  return data
}

/** Cuentas bancarias activas de la clínica (para compartir el anticipo). */
async function loadActivePaymentAccounts(ctx: AgentToolContext) {
  const { data } = await ctx.db
    .from('payment_accounts')
    .select('bank, holder, clabe, account_number, instructions')
    .eq('account_id', ctx.accountId)
    .eq('is_active', true)
    .order('created_at', { ascending: true })
  return (data ?? []).map((c) => ({
    banco: c.bank,
    titular: c.holder,
    clabe: c.clabe ?? null,
    cuenta: c.account_number ?? null,
    indicaciones: c.instructions ?? null,
  }))
}

async function dropNotification(
  ctx: AgentToolContext,
  type: string,
  title: string,
  body: string,
): Promise<void> {
  await ctx.db.from('notifications').insert({
    account_id: ctx.accountId,
    user_id: ctx.userId,
    type,
    conversation_id: ctx.conversationId,
    contact_id: ctx.contactId,
    actor_user_id: null,
    title,
    body,
  })
}

// ------------------------------------------------------------
// Embudo → pipeline visual (/pipelines)
//
// El embudo del agente (tags `lead:*`) y el tablero de deals eran dos
// mundos separados: un lead calificado por la IA no aparecía en el
// tablero de ventas. Estos helpers reflejan cada hito en un pipeline
// dedicado ("Embudo IA") que se crea solo la primera vez — mismo
// patrón self-healing que las tags de clasificar_lead.
// ------------------------------------------------------------

export const FUNNEL_PIPELINE_NAME = 'Embudo IA'

// Etapas espejo del embudo legacy: preguntón → interesado →
// seguimiento → cita apartada → anticipo en revisión → agendado →
// paciente. "Agendado" la mueve el equipo al confirmar el anticipo en
// el panel; "Paciente" la mueve el trigger de la BD cuando una cita se
// marca completada (migración 036) — segmenta a quienes ya pasaron por
// la clínica.
const FUNNEL_STAGES = [
  { name: 'Preguntón', color: '#94a3b8' },
  { name: 'Interesado', color: '#3b82f6' },
  { name: 'Seguimiento futuro', color: '#f59e0b' },
  { name: 'Cita apartada', color: '#8b5cf6' },
  { name: 'Anticipo en revisión', color: '#f97316' },
  { name: 'Agendado', color: '#22c55e' },
  { name: 'Paciente', color: '#14b8a6' },
] as const
type FunnelStageName = (typeof FUNNEL_STAGES)[number]['name']

const STAGE_BY_LEAD: Record<string, FunnelStageName> = {
  pregunton: 'Preguntón',
  interesado: 'Interesado',
  seguimiento_futuro: 'Seguimiento futuro',
}

async function ensureFunnelPipeline(
  ctx: AgentToolContext,
): Promise<string | null> {
  const { data: existing } = await ctx.db
    .from('pipelines')
    .select('id')
    .eq('account_id', ctx.accountId)
    .eq('name', FUNNEL_PIPELINE_NAME)
    .maybeSingle()
  if (existing) return existing.id

  const { data: created } = await ctx.db
    .from('pipelines')
    .insert({
      account_id: ctx.accountId,
      user_id: ctx.userId,
      name: FUNNEL_PIPELINE_NAME,
    })
    .select('id')
    .single()
  if (!created) return null

  await ctx.db.from('pipeline_stages').insert(
    FUNNEL_STAGES.map((s, i) => ({
      pipeline_id: created.id,
      name: s.name,
      color: s.color,
      position: i,
    })),
  )
  return created.id
}

/**
 * Refleja el avance del lead en el tablero de deals. Best-effort: un
 * tablero roto no debe tumbar la herramienta que lo invoca (el embudo
 * con tags sigue siendo la fuente de verdad del agente), así que
 * cualquier fallo aquí se traga en silencio.
 */
async function syncFunnelDeal(
  ctx: AgentToolContext,
  stageName: FunnelStageName,
  opts: { title?: string | null; value?: number | null } = {},
): Promise<void> {
  try {
    const pipelineId = await ensureFunnelPipeline(ctx)
    if (!pipelineId) return

    let { data: stages } = await ctx.db
      .from('pipeline_stages')
      .select('id, name, position')
      .eq('pipeline_id', pipelineId)
    let target = (stages ?? []).find((s) => s.name === stageName)
    if (!target) {
      // Self-healing: pipelines creados antes de que existiera una etapa
      // nueva (p. ej. "Paciente") la reciben al final la primera vez que
      // se necesita — mismo espíritu que ensureFunnelPipeline.
      const have = new Set((stages ?? []).map((s) => s.name))
      const maxPos = (stages ?? []).reduce((m, s) => Math.max(m, s.position), -1)
      const missing = FUNNEL_STAGES.filter((s) => !have.has(s.name))
      if (missing.length === 0) return
      await ctx.db.from('pipeline_stages').insert(
        missing.map((s, i) => ({
          pipeline_id: pipelineId,
          name: s.name,
          color: s.color,
          position: maxPos + 1 + i,
        })),
      )
      const refreshed = await ctx.db
        .from('pipeline_stages')
        .select('id, name, position')
        .eq('pipeline_id', pipelineId)
      stages = refreshed.data
      target = (stages ?? []).find((s) => s.name === stageName)
      if (!target) return
    }

    const { data: deal } = await ctx.db
      .from('deals')
      .select('id, stage_id')
      .eq('account_id', ctx.accountId)
      .eq('contact_id', ctx.contactId)
      .eq('pipeline_id', pipelineId)
      .eq('status', 'open')
      .limit(1)
      .maybeSingle()

    const title = opts.title?.trim() || ctx.contactName || 'Lead WhatsApp'
    if (deal) {
      // El embudo solo avanza: no regreses una tarjeta que ya va adelante.
      const current = (stages ?? []).find((s) => s.id === deal.stage_id)
      if (current && current.position > target.position) return
      const patch: Record<string, unknown> = { stage_id: target.id, title }
      if (opts.value != null && opts.value > 0) patch.value = opts.value
      await ctx.db
        .from('deals')
        .update(patch)
        .eq('id', deal.id)
        .eq('account_id', ctx.accountId)
    } else {
      await ctx.db.from('deals').insert({
        account_id: ctx.accountId,
        user_id: ctx.userId,
        pipeline_id: pipelineId,
        stage_id: target.id,
        contact_id: ctx.contactId,
        conversation_id: ctx.conversationId,
        title,
        value: opts.value != null && opts.value > 0 ? opts.value : 0,
        currency: 'MXN',
        status: 'open',
      })
    }
  } catch {
    // best-effort — el embudo con tags sigue siendo la fuente de verdad.
  }
}

/** Cierra como perdido el deal del embudo (spam). Best-effort. */
async function closeFunnelDeal(ctx: AgentToolContext): Promise<void> {
  try {
    const { data: pipeline } = await ctx.db
      .from('pipelines')
      .select('id')
      .eq('account_id', ctx.accountId)
      .eq('name', FUNNEL_PIPELINE_NAME)
      .maybeSingle()
    if (!pipeline) return
    await ctx.db
      .from('deals')
      .update({ status: 'lost' })
      .eq('account_id', ctx.accountId)
      .eq('contact_id', ctx.contactId)
      .eq('pipeline_id', pipeline.id)
      .eq('status', 'open')
  } catch {
    // best-effort
  }
}

// ------------------------------------------------------------
// Herramientas
// ------------------------------------------------------------

async function consultarCatalogo(
  ctx: AgentToolContext,
  input: { categoria?: string },
): Promise<ToolExecResult> {
  let q = ctx.db
    .from('procedures')
    .select('id, name, description, category, price_min, price_max, currency, deposit_amount, duration_minutes, sales_notes')
    .eq('account_id', ctx.accountId)
    .eq('is_active', true)
    .order('name', { ascending: true })
  if (input.categoria) q = q.ilike('category', `%${input.categoria}%`)

  const { data, error } = await q
  if (error) return fail(`No pude leer el catálogo: ${error.message}`)

  const items = (data ?? []).map((p) => {
    const min = num(p.price_min)
    const max = num(p.price_max)
    let precio: string
    if (min != null && max != null && min !== max) {
      precio = `${money(min, p.currency)}–${money(max, p.currency)}`
    } else if (min != null || max != null) {
      precio = money((min ?? max)!, p.currency)!
    } else {
      precio = 'se define en la valoración'
    }
    const dep = num(p.deposit_amount)
    return {
      id: p.id,
      nombre: p.name,
      categoria: p.category ?? null,
      descripcion: p.description ?? null,
      precio,
      anticipo: dep != null ? money(dep, p.currency) : 'sin anticipo',
      duracion_minutos: p.duration_minutes,
      notas_venta: p.sales_notes ?? null,
    }
  })

  return ok({
    ok: true,
    total: items.length,
    procedimientos: items,
    recordatorio:
      'Los precios son rangos; el costo exacto se define en la valoración con el doctor.',
  })
}

async function consultarDisponibilidad(
  ctx: AgentToolContext,
  input: {
    desde?: string
    dias?: number
    duracion_minutos?: number
    procedure_id?: string
  },
): Promise<ToolExecResult> {
  const hours = await loadClinicHours(ctx)
  if (hours.length === 0) {
    return ok({
      ok: true,
      huecos: [],
      nota: 'No hay horario de atención configurado. Escala para que el equipo te dé fechas.',
    })
  }

  let duration = input.duracion_minutos ?? 0
  if (!duration && input.procedure_id) {
    const proc = await loadProcedure(ctx, input.procedure_id)
    if (proc) duration = proc.duration_minutes
  }
  if (!duration) duration = 30 // valoración corta por defecto

  const days = Math.min(Math.max(input.dias ?? 7, 1), 30)
  const from = parseFromDate(input.desde, ctx.timezone, ctx.now)
  const busy = await loadBusy(ctx, from)

  const slots = computeAvailableSlots({
    timezone: ctx.timezone,
    hours,
    busy,
    durationMinutes: duration,
    from,
    days,
    limit: 8,
  })

  return ok({
    ok: true,
    duracion_minutos: duration,
    huecos: slots.map((s) => ({
      inicio: s.startsAt.toISOString(),
      etiqueta: formatSlotLabel(s.startsAt, ctx.timezone),
    })),
    nota:
      slots.length === 0
        ? `No hay huecos libres en los próximos ${days} días. Ofrece otra fecha o escala.`
        : 'Ofrece al paciente máximo dos opciones (una en la mañana y una en la tarde).',
  })
}

async function consultarDatosPago(ctx: AgentToolContext): Promise<ToolExecResult> {
  const { data, error } = await ctx.db
    .from('payment_accounts')
    .select('bank, holder, clabe, account_number, instructions')
    .eq('account_id', ctx.accountId)
    .eq('is_active', true)
    .order('created_at', { ascending: true })
  if (error) return fail(`No pude leer los datos de pago: ${error.message}`)

  if (!data || data.length === 0) {
    return ok({
      ok: true,
      cuentas: [],
      nota:
        'La clínica no tiene datos bancarios configurados. NO inventes una cuenta: dile al paciente que en un momento el equipo le comparte los datos por aquí, y deja el aviso con avisar_equipo.',
    })
  }

  return ok({
    ok: true,
    cuentas: data.map((c) => ({
      banco: c.bank,
      titular: c.holder,
      clabe: c.clabe ?? null,
      cuenta: c.account_number ?? null,
      indicaciones: c.instructions ?? null,
    })),
    instruccion_para_paciente:
      'Comparte SOLO estos datos, tal cual, y pídele el comprobante (imagen) para prevalidar su anticipo. Nunca dictes datos bancarios distintos a estos.',
  })
}

const APPT_STATUS_LABEL: Record<string, string> = {
  pendiente: 'pendiente de confirmar',
  confirmada: 'confirmada',
  completada: 'completada',
  cancelada: 'cancelada',
  no_asistio: 'no asistió',
}

async function consultarMisCitas(ctx: AgentToolContext): Promise<ToolExecResult> {
  const { data, error } = await ctx.db
    .from('appointments')
    .select('id, starts_at, status, deposit_status, deposit_amount, appointment_type')
    .eq('account_id', ctx.accountId)
    .eq('contact_id', ctx.contactId)
    .order('starts_at', { ascending: false })
    .limit(5)
  if (error) return fail(`No pude leer las citas: ${error.message}`)

  if (!data || data.length === 0) {
    return ok({
      ok: true,
      citas: [],
      nota: 'El paciente no tiene citas registradas. Ofrécele agendar una valoración.',
    })
  }

  const citas = data.map((a) => {
    const dep = num(a.deposit_amount)
    return {
      id: a.id,
      cuando: formatSlotLabel(new Date(a.starts_at), ctx.timezone),
      estado: APPT_STATUS_LABEL[a.status] ?? a.status,
      tipo: a.appointment_type,
      anticipo:
        a.deposit_status === 'pendiente'
          ? `pendiente${dep != null ? ` (${money(dep)})` : ''}`
          : a.deposit_status === 'pagado'
            ? 'pagado'
            : 'no aplica',
      ya_paso: new Date(a.starts_at).getTime() < ctx.now.getTime(),
    }
  })

  return ok({
    ok: true,
    citas,
    recordatorio:
      'Una cita "pendiente de confirmar" NO está confirmada: el equipo la confirma al validar el anticipo. No le digas al paciente que ya quedó en firme si sigue pendiente.',
  })
}

async function consultarConocimiento(
  ctx: AgentToolContext,
  args: { pregunta?: string },
): Promise<ToolExecResult> {
  const pregunta = typeof args.pregunta === 'string' ? args.pregunta.trim() : ''
  if (!pregunta) return fail('Falta la pregunta a buscar.')

  const excerpts = await retrieveKnowledge(
    ctx.db,
    ctx.accountId,
    { embeddingsApiKey: ctx.embeddingsApiKey },
    pregunta,
    5,
  )

  if (excerpts.length === 0) {
    return ok({
      ok: true,
      resultados: [],
      nota:
        'No encontré nada en la base de conocimiento sobre esto. NO inventes la respuesta: dile al paciente que lo confirmas y usa avisar_equipo o escalar_a_humano según la urgencia.',
    })
  }

  return ok({
    ok: true,
    resultados: excerpts,
    instruccion_para_paciente:
      'Usa estos extractos SOLO si de verdad responden lo que preguntó el paciente. Si no aplican o no cubren su duda, NO los fuerces ni inventes con ellos: dilo con naturalidad y usa avisar_equipo o escalar_a_humano según la urgencia. Si sí aplican, respóndele sin citarlos textualmente ni mencionar que consultaste una base de datos.',
  })
}

// Expediente clínico ligero (migración 041). Aislamiento duro: ambas
// herramientas operan SOLO sobre el contacto de la conversación — ni
// siquiera aceptan un contact_id como parámetro (lección Acerotech:
// jamás mezclar datos médicos entre pacientes).

const RECORD_CATEGORY_LABEL: Record<string, string> = {
  motivo_consulta: 'motivo de consulta',
  sintoma: 'síntoma',
  alergia: 'alergia',
  medicamento: 'medicamento',
  antecedente: 'antecedente',
  tratamiento_previo: 'tratamiento previo',
  nota: 'nota',
}

async function consultarExpediente(ctx: AgentToolContext): Promise<ToolExecResult> {
  const { data, error } = await ctx.db
    .from('patient_records')
    .select('category, content, source, created_at')
    .eq('account_id', ctx.accountId)
    .eq('contact_id', ctx.contactId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(30)
  if (error) return fail(`No pude leer el expediente: ${error.message}`)

  if (!data || data.length === 0) {
    return ok({
      ok: true,
      expediente: [],
      nota: 'Este paciente aún no tiene expediente (primera vez o no ha compartido datos clínicos). Atiéndelo normal y registra con registrar_dato_clinico lo que vaya contando.',
    })
  }

  return ok({
    ok: true,
    expediente: data.map((r) => ({
      categoria: RECORD_CATEGORY_LABEL[r.category] ?? r.category,
      dato: r.content,
      registrado: formatSlotLabel(new Date(r.created_at), ctx.timezone),
      origen: r.source === 'equipo' ? 'equipo' : 'conversación',
    })),
    instruccion_para_paciente:
      'Usa esto como contexto para atender con continuidad ("me contabas que..."). NO le recites el expediente ni menciones que llevas un registro. Es información de ESTE paciente únicamente.',
  })
}

async function registrarDatoClinico(
  ctx: AgentToolContext,
  input: { categoria: string; dato: string },
): Promise<ToolExecResult> {
  if (!RECORD_CATEGORIES.includes(input.categoria as never)) {
    return fail(`categoria inválida. Usa una de: ${RECORD_CATEGORIES.join(', ')}.`)
  }
  const dato = typeof input.dato === 'string' ? input.dato.trim() : ''
  if (!dato) return fail('Falta el dato a registrar.')
  if (dato.length > 500) {
    return fail('El dato es demasiado largo. Resúmelo en una entrada corta (máx 500 caracteres) o divídelo en varios hechos.')
  }

  // El modelo tiende a re-registrar lo mismo en cada conversación
  // (p. ej. la misma alergia): un duplicado exacto no ensucia la BD.
  const { data: dup } = await ctx.db
    .from('patient_records')
    .select('id')
    .eq('account_id', ctx.accountId)
    .eq('contact_id', ctx.contactId)
    .eq('category', input.categoria)
    .eq('content', dato)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle()
  if (dup) {
    return ok({
      ok: true,
      duplicado: true,
      nota: 'Ese dato ya estaba en el expediente. Sigue la conversación con naturalidad.',
    })
  }

  const { error } = await ctx.db.from('patient_records').insert({
    account_id: ctx.accountId,
    contact_id: ctx.contactId,
    conversation_id: ctx.conversationId,
    category: input.categoria,
    content: dato,
    source: 'agente',
    is_active: true,
    created_by: null, // NULL = registrada por el agente IA
  })
  if (error) return fail(`No pude registrar el dato: ${error.message}`)

  return ok({
    ok: true,
    categoria: input.categoria,
    nota: 'Registrado en el expediente. No se lo anuncies al paciente; sigue la conversación con naturalidad.',
  })
}

/** ¿La cita cae dentro de alguna ventana de `clinic_hours` de su día? */
function withinClinicHours(
  start: Date,
  end: Date,
  hours: ClinicHoursRow[],
  tz: string,
): boolean {
  const ws = wallPartsInTz(start, tz)
  const we = wallPartsInTz(end, tz)
  const startMin = ws.hour * 60 + ws.minute
  const endMin = we.hour * 60 + we.minute + (we.day !== ws.day ? 24 * 60 : 0)
  return hours.some(
    (h) =>
      h.weekday === ws.weekday &&
      parseClockToMinutes(h.opens_at) <= startMin &&
      endMin <= parseClockToMinutes(h.closes_at),
  )
}

async function agendarCita(
  ctx: AgentToolContext,
  input: {
    inicio: string
    tipo?: string
    procedure_id?: string
    notas?: string
  },
): Promise<ToolExecResult> {
  const start = parseStartInstant(input.inicio, ctx.timezone)
  if (!start) {
    return fail(
      'No entendí la fecha/hora. Usa un hueco de consultar_disponibilidad (ISO) o "YYYY-MM-DDTHH:MM".',
    )
  }
  if (start.getTime() <= ctx.now.getTime()) {
    return fail('Ese horario ya pasó. Propón una fecha futura.')
  }

  const proc = input.procedure_id
    ? await loadProcedure(ctx, input.procedure_id)
    : null
  if (input.procedure_id && !proc) {
    return fail('Ese procedure_id no existe. Consulta el catálogo primero.')
  }
  const duration = proc?.duration_minutes ?? 60
  const end = new Date(start.getTime() + duration * 60 * 1000)

  const hours = await loadClinicHours(ctx)
  if (hours.length > 0 && !withinClinicHours(start, end, hours, ctx.timezone)) {
    return fail(
      'Ese horario está fuera del horario de atención. Usa consultar_disponibilidad.',
    )
  }

  // ¿Reagendar la cita activa del contacto en vez de crear otra?
  const existing = await findActiveAppointment(ctx)
  const busy = await loadBusy(ctx, ctx.now, existing?.id)
  const clash = busy.some(
    (b) => start.getTime() < b.endsAt.getTime() && b.startsAt.getTime() < end.getTime(),
  )
  if (clash) {
    return fail('Ese hueco ya no está libre. Vuelve a consultar_disponibilidad.')
  }

  const tipo = APPOINTMENT_TYPES.includes(input.tipo as never)
    ? input.tipo
    : 'valoracion'

  // Regla de oro del anticipo: toda VALORACIÓN se aparta con anticipo.
  // Si el procedimiento de interés no define uno (o no se pasó
  // procedure_id), el anticipo sale del procedimiento de valoración/
  // consulta del catálogo — sin este respaldo, el agente apartaba
  // valoraciones sin pedir un peso (incidente Acerotech).
  let depositAmount = num(proc?.deposit_amount)
  let depositCurrency = proc?.currency ?? 'MXN'
  let valoracionRef: string | null = null
  if (
    depositAmount == null &&
    (tipo === 'valoracion' || tipo === 'valoracion_virtual')
  ) {
    const valoracion = await findValoracionProcedure(ctx)
    if (valoracion) {
      depositAmount = num(valoracion.deposit_amount)
      depositCurrency = valoracion.currency ?? 'MXN'
      valoracionRef = valoracion.name
    }
  }
  const depositStatus = depositAmount != null ? 'pendiente' : 'no_aplica'

  const row = {
    account_id: ctx.accountId,
    contact_id: ctx.contactId,
    conversation_id: ctx.conversationId,
    procedure_id: proc?.id ?? null,
    appointment_type: tipo,
    // Regla de oro: el agente SIEMPRE deja la cita pendiente.
    status: 'pendiente',
    deposit_status: depositStatus,
    deposit_amount: depositAmount,
    starts_at: start.toISOString(),
    ends_at: end.toISOString(),
    notes: input.notas ?? null,
    created_by: null, // NULL = creada por el agente IA
  }

  let appointmentId: string
  let reagendada = false
  if (existing) {
    const { data, error } = await ctx.db
      .from('appointments')
      .update(row)
      .eq('id', existing.id)
      .eq('account_id', ctx.accountId)
      .select('id')
      .single()
    if (error) return fail(`No pude reagendar la cita: ${error.message}`)
    appointmentId = data.id
    reagendada = true
  } else {
    const { data, error } = await ctx.db
      .from('appointments')
      .insert(row)
      .select('id')
      .single()
    if (error) return fail(`No pude apartar la cita: ${error.message}`)
    appointmentId = data.id
  }

  const label = formatSlotLabel(start, ctx.timezone)
  await dropNotification(
    ctx,
    'ai_appointment_created',
    reagendada ? 'El agente reagendó una cita' : 'El agente apartó una cita',
    `${ctx.contactName ?? 'Un paciente'} — ${label}${
      proc ? ` · ${proc.name}` : ''
    }. Pendiente de confirmar${
      depositAmount != null ? ` (anticipo ${money(depositAmount, depositCurrency)})` : ''
    }.`,
  )

  // Hito del embudo: la cita apartada mueve el deal en el tablero.
  await syncFunnelDeal(ctx, 'Cita apartada', { value: num(proc?.price_min) })

  // Con anticipo requerido, los datos de pago van en el MISMO resultado:
  // el modelo los comparte de inmediato en vez de depender de que
  // recuerde llamar consultar_datos_pago en otra ronda.
  const cuentas = depositAmount != null ? await loadActivePaymentAccounts(ctx) : []

  return ok({
    ok: true,
    appointment_id: appointmentId,
    reagendada,
    inicio: start.toISOString(),
    etiqueta: label,
    estado: 'pendiente',
    anticipo_requerido: depositAmount != null ? money(depositAmount, depositCurrency) : null,
    ...(valoracionRef ? { anticipo_de: valoracionRef } : {}),
    ...(depositAmount != null ? { datos_pago: cuentas } : {}),
    instruccion_para_paciente:
      depositAmount != null
        ? cuentas.length > 0
          ? `Dile que le APARTAS el lugar para ${label} y que solo queda ASEGURADO al recibir su anticipo de ${money(depositAmount, depositCurrency)}. En el MISMO mensaje comparte los datos_pago tal cual (nunca otros) y pídele el comprobante (imagen). NO digas que la cita ya quedó confirmada.`
          : `Dile que le APARTAS el lugar para ${label} y que requiere un anticipo de ${money(depositAmount, depositCurrency)}, pero la clínica NO tiene datos bancarios configurados: NO inventes una cuenta; dile que en un momento el equipo le comparte los datos por aquí y deja el aviso con avisar_equipo.`
        : `Dile que le APARTAS el lugar para ${label} y que el equipo se lo confirma por aquí. NO digas que ya quedó confirmada en firme.`,
  })
}

/**
 * Última imagen/documento que el paciente envió en ESTA conversación —
 * el comprobante real. Se adjunta al pago desde la BD en vez de confiar
 * en que el modelo copie una URL larga sin mutilarla.
 */
async function findLatestReceiptUrl(ctx: AgentToolContext): Promise<string | null> {
  const { data } = await ctx.db
    .from('messages')
    .select('media_url')
    .eq('conversation_id', ctx.conversationId)
    .eq('sender_type', 'customer')
    .in('content_type', ['image', 'document'])
    .not('media_url', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data?.media_url as string | null) ?? null
}

async function prevalidarAnticipo(
  ctx: AgentToolContext,
  input: {
    appointment_id?: string
    monto?: number
    metodo?: string
    concepto?: string
    comprobante_url?: string
    referencia?: string
  },
): Promise<ToolExecResult> {
  let appointment = null as Awaited<ReturnType<typeof findActiveAppointment>>
  if (input.appointment_id) {
    const { data } = await ctx.db
      .from('appointments')
      .select('id, deposit_amount, deposit_status, procedure_id')
      .eq('account_id', ctx.accountId)
      .eq('contact_id', ctx.contactId)
      .eq('id', input.appointment_id)
      .maybeSingle()
    appointment = data as never
  } else {
    appointment = await findActiveAppointment(ctx)
  }
  if (!appointment) {
    return fail(
      'No encontré una cita para asociar el anticipo. Aparta la cita primero con agendar_cita.',
    )
  }

  let amount = num(input.monto) ?? num(appointment.deposit_amount)
  let currency = 'MXN'
  if (amount == null && appointment.procedure_id) {
    const proc = await loadProcedure(ctx, appointment.procedure_id)
    amount = num(proc?.deposit_amount)
    currency = proc?.currency ?? 'MXN'
  }
  if (amount == null || amount <= 0) {
    return fail(
      'No sé el monto del anticipo. Pídeselo al paciente o pásalo en "monto".',
    )
  }

  const metodo = PAYMENT_METHODS.includes(input.metodo as never)
    ? input.metodo
    : 'transferencia'

  const referencia =
    typeof input.referencia === 'string' && input.referencia.trim()
      ? input.referencia.trim()
      : null

  // Comprobante: la URL del modelo si es válida; si no, la última
  // imagen/documento del paciente en esta conversación.
  const inputUrl =
    typeof input.comprobante_url === 'string' &&
    /^https?:\/\//i.test(input.comprobante_url.trim())
      ? input.comprobante_url.trim()
      : null
  const receiptUrl = inputUrl ?? (await findLatestReceiptUrl(ctx))

  const concept = [input.concepto ?? 'Anticipo', referencia ? `ref ${referencia}` : null]
    .filter(Boolean)
    .join(' · ')

  const { data: payment, error } = await ctx.db
    .from('payments')
    .insert({
      account_id: ctx.accountId,
      contact_id: ctx.contactId,
      appointment_id: appointment.id,
      amount,
      currency,
      method: metodo,
      // Regla de oro: prevalidado, NUNCA 'confirmado'. Un humano confirma.
      status: 'pendiente',
      concept,
      receipt_url: receiptUrl,
    })
    .select('id')
    .single()
  if (error) return fail(`No pude registrar el anticipo: ${error.message}`)

  // La cita sigue 'pendiente'; solo marcamos el anticipo en revisión.
  await ctx.db
    .from('appointments')
    .update({ deposit_status: 'pendiente' })
    .eq('id', appointment.id)
    .eq('account_id', ctx.accountId)

  await dropNotification(
    ctx,
    'ai_deposit_prevalidated',
    'Anticipo por confirmar',
    `${ctx.contactName ?? 'Un paciente'} envió un anticipo de ${money(
      amount,
      currency,
    )} (${metodo}${referencia ? `, ref ${referencia}` : ''}). ${
      receiptUrl
        ? 'Revisa el comprobante y confírmalo en el panel.'
        : 'OJO: sin comprobante adjunto — pídelo o revisa la conversación antes de confirmar en el panel.'
    }`,
  )

  // Hito del embudo: comprobante recibido → el deal avanza a revisión.
  await syncFunnelDeal(ctx, 'Anticipo en revisión')

  return ok({
    ok: true,
    payment_id: payment.id,
    monto: money(amount, currency),
    estado: 'en_revision',
    comprobante_adjunto: receiptUrl != null,
    instruccion_para_paciente:
      'Dile TEXTUALMENTE que recibiste su comprobante y quedó EN REVISIÓN del equipo, y que le avisas por aquí en cuanto quede confirmado. NUNCA digas que el pago o la cita quedaron confirmados.',
  })
}

async function cancelarCita(
  ctx: AgentToolContext,
  input: { appointment_id?: string; motivo?: string },
): Promise<ToolExecResult> {
  let appointment = null as Awaited<ReturnType<typeof findActiveAppointment>>
  if (input.appointment_id) {
    const { data } = await ctx.db
      .from('appointments')
      .select('id, starts_at, ends_at, status, deposit_status, deposit_amount, procedure_id')
      .eq('account_id', ctx.accountId)
      .eq('contact_id', ctx.contactId)
      .eq('id', input.appointment_id)
      .in('status', ['pendiente', 'confirmada'])
      .maybeSingle()
    appointment = data as never
  } else {
    appointment = await findActiveAppointment(ctx)
  }
  if (!appointment) {
    return fail('El paciente no tiene una cita activa que cancelar.')
  }

  const { error } = await ctx.db
    .from('appointments')
    .update({ status: 'cancelada' })
    .eq('id', appointment.id)
    .eq('account_id', ctx.accountId)
  if (error) return fail(`No pude cancelar la cita: ${error.message}`)

  const label = formatSlotLabel(new Date(appointment.starts_at), ctx.timezone)
  await dropNotification(
    ctx,
    'ai_appointment_cancelled',
    'El agente canceló una cita',
    `${ctx.contactName ?? 'Un paciente'} canceló su cita del ${label}${
      input.motivo ? ` — ${input.motivo}` : ''
    }.`,
  )

  return ok({
    ok: true,
    appointment_id: appointment.id,
    estado: 'cancelada',
    instruccion_para_paciente:
      'Confírmale la cancelación con calidez y aplica la política de anticipos de la clínica tal como está en tu contexto (no inventes reembolsos). Déjale la puerta abierta a reagendar cuando guste.',
  })
}

async function clasificarLead(
  ctx: AgentToolContext,
  input: { etapa: string; nombre?: string; ciudad?: string; notas?: string },
): Promise<ToolExecResult> {
  if (!LEAD_STAGES.includes(input.etapa as never)) {
    return fail(`etapa inválida. Usa una de: ${LEAD_STAGES.join(', ')}.`)
  }

  // Actualiza el nombre del contacto si lo capturamos y aún no lo teníamos.
  if (input.nombre && input.nombre.trim()) {
    await ctx.db
      .from('contacts')
      .update({ name: input.nombre.trim(), updated_at: new Date().toISOString() })
      .eq('id', ctx.contactId)
      .eq('account_id', ctx.accountId)
  }

  // Etiqueta de embudo: una sola vigente por contacto. tags.account_id
  // es NOT NULL desde la migración 017 — omitirlo hacía fallar el
  // insert en silencio y el CRM nunca mostraba la calificación
  // (incidente Acerotech). user_id sigue siendo el dueño de la cuenta.
  const tagName = `lead:${input.etapa}`
  const { data: tag } = await ctx.db
    .from('tags')
    .select('id')
    .eq('account_id', ctx.accountId)
    .eq('name', tagName)
    .maybeSingle()
  let tagId = tag?.id
  if (!tagId) {
    const { data: created, error: tagErr } = await ctx.db
      .from('tags')
      .insert({
        user_id: ctx.userId,
        account_id: ctx.accountId,
        name: tagName,
        color: '#0ea5e9',
      })
      .select('id')
      .single()
    if (tagErr) {
      console.error('[clinical agent] clasificar_lead: tag insert failed:', tagErr.message)
    }
    tagId = created?.id
  }

  if (tagId) {
    // Quita otras etiquetas de embudo del contacto (el embudo se
    // representa con una sola etapa vigente).
    const { data: funnelTags } = await ctx.db
      .from('tags')
      .select('id')
      .eq('account_id', ctx.accountId)
      .like('name', 'lead:%')
    const otherIds = (funnelTags ?? []).map((t) => t.id).filter((id) => id !== tagId)
    if (otherIds.length > 0) {
      await ctx.db
        .from('contact_tags')
        .delete()
        .eq('contact_id', ctx.contactId)
        .in('tag_id', otherIds)
    }
    await ctx.db
      .from('contact_tags')
      .upsert(
        { contact_id: ctx.contactId, tag_id: tagId },
        { onConflict: 'contact_id,tag_id' },
      )
  }

  // Refleja la etapa en el tablero de deals; spam cierra el deal.
  if (input.etapa === 'spam') {
    await closeFunnelDeal(ctx)
  } else {
    await syncFunnelDeal(ctx, STAGE_BY_LEAD[input.etapa], {
      title: input.nombre?.trim() || null,
    })
  }

  return ok({
    ok: true,
    etapa: input.etapa,
    etiqueta_crm: tagId ? 'actualizada' : 'no_actualizada',
    nombre_guardado: input.nombre?.trim() || null,
    nota: 'CRM actualizado. No se lo menciones al paciente; sigue la conversación con naturalidad.',
  })
}

async function avisarEquipo(
  ctx: AgentToolContext,
  input: { nota: string },
): Promise<ToolExecResult> {
  if (!input.nota || !input.nota.trim()) return fail('Falta la nota para el equipo.')
  await dropNotification(
    ctx,
    'ai_escalation',
    'Aviso del agente al equipo',
    `${ctx.contactName ?? 'Un paciente'}: ${input.nota.trim()}`,
  )
  return ok({
    ok: true,
    instruccion_para_paciente:
      'El equipo ya tiene el aviso. Puedes seguir atendiendo lo general; solo di que ya lo notificaste si es natural.',
  })
}

async function escalarAHumano(
  ctx: AgentToolContext,
  input: { motivo: string; urgente?: boolean },
): Promise<ToolExecResult> {
  // Decisión de producto (2026-07-07): el modo IA↔humano NUNCA cambia
  // solo — ni siquiera al escalar. Antes esto apagaba
  // ai_autoreply_disabled y el chat quedaba mudo sin señal en la UI;
  // ahora la notificación es la señal para que una persona tome el
  // hilo y, si quiere, apague la IA desde el panel.
  await dropNotification(
    ctx,
    'ai_escalation',
    input.urgente ? '🔴 Escalación urgente del agente' : 'El agente escaló una conversación',
    `${ctx.contactName ?? 'Un paciente'} — ${input.motivo}`,
  )

  return {
    content: JSON.stringify({
      ok: true,
      escalado: true,
      instruccion_para_paciente:
        'Despídete con UNA línea breve: dile que en un momento le contacta el equipo. No sigas resolviendo el tema.',
    }),
    escalated: true,
  }
}

// ------------------------------------------------------------
// Dispatch
// ------------------------------------------------------------

/**
 * Ejecuta una herramienta por nombre. Nunca lanza: cualquier fallo se
 * devuelve como `tool_result` de error para que el modelo pueda
 * reaccionar (o cerrar con gracia) en vez de tumbar el turno.
 */
export async function executeClinicalTool(
  name: string,
  input: unknown,
  ctx: AgentToolContext,
): Promise<ToolExecResult> {
  const args = (input ?? {}) as never
  try {
    switch (name as ClinicalToolName) {
      case 'consultar_catalogo':
        return await consultarCatalogo(ctx, args)
      case 'consultar_disponibilidad':
        return await consultarDisponibilidad(ctx, args)
      case 'consultar_datos_pago':
        return await consultarDatosPago(ctx)
      case 'consultar_mis_citas':
        return await consultarMisCitas(ctx)
      case 'consultar_conocimiento':
        return await consultarConocimiento(ctx, args)
      case 'consultar_expediente':
        return await consultarExpediente(ctx)
      case 'registrar_dato_clinico':
        return await registrarDatoClinico(ctx, args)
      case 'agendar_cita':
        return await agendarCita(ctx, args)
      case 'prevalidar_anticipo':
        return await prevalidarAnticipo(ctx, args)
      case 'cancelar_cita':
        return await cancelarCita(ctx, args)
      case 'clasificar_lead':
        return await clasificarLead(ctx, args)
      case 'avisar_equipo':
        return await avisarEquipo(ctx, args)
      case 'escalar_a_humano':
        return await escalarAHumano(ctx, args)
      default:
        return fail(`Herramienta desconocida: ${name}`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return fail(`Error ejecutando ${name}: ${msg}`)
  }
}
