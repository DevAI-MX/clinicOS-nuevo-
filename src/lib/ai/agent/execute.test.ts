import { describe, it, expect, beforeEach, vi } from 'vitest'
import { executeClinicalTool } from './execute'
import type { AgentToolContext } from './tools'
import { retrieveKnowledge } from '../knowledge'

// consultar_conocimiento delega en retrieveKnowledge, que ya tiene su
// propia cobertura (knowledge.test.ts) contra pgvector/FTS reales. Aquí
// solo nos importa que la tool la llame bien y dé forma al resultado.
vi.mock('../knowledge', () => ({ retrieveKnowledge: vi.fn() }))
const mockRetrieveKnowledge = vi.mocked(retrieveKnowledge)

// ------------------------------------------------------------
// Fake Supabase en memoria — soporta el subconjunto de la query API
// que usa el ejecutor (select/eq/in/gt/ilike/like/order/limit +
// maybeSingle/single/insert/update/delete/upsert y await directo).
// ------------------------------------------------------------

type Row = Record<string, unknown>
let idc = 1

class Builder {
  private filters: ((r: Row) => boolean)[] = []
  private op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select'
  private payload: Row | Row[] | null = null
  private conflict: string[] = []
  private _order: { col: string; asc: boolean } | null = null
  private _limit: number | null = null

  constructor(
    private store: Record<string, Row[]>,
    private table: string,
  ) {}

  select() {
    return this
  }
  eq(col: string, val: unknown) {
    this.filters.push((r) => r[col] === val)
    return this
  }
  in(col: string, vals: unknown[]) {
    this.filters.push((r) => vals.includes(r[col]))
    return this
  }
  gt(col: string, val: string) {
    this.filters.push((r) => String(r[col]) > val)
    return this
  }
  ilike(col: string, pat: string) {
    const needle = pat.replace(/%/g, '').toLowerCase()
    this.filters.push((r) => String(r[col] ?? '').toLowerCase().includes(needle))
    return this
  }
  like(col: string, pat: string) {
    const needle = pat.replace(/%/g, '')
    this.filters.push((r) => String(r[col] ?? '').includes(needle))
    return this
  }
  // Subconjunto que usa findValoracionProcedure: OR de ilikes.
  or(expr: string) {
    const branches = expr.split(',').map((b) => {
      const [col, op, ...rest] = b.split('.')
      const pat = rest.join('.')
      if (op !== 'ilike') throw new Error(`fake or(): op no soportado ${op}`)
      const needle = pat.replace(/%/g, '').toLowerCase()
      return (r: Row) => String(r[col] ?? '').toLowerCase().includes(needle)
    })
    this.filters.push((r) => branches.some((f) => f(r)))
    return this
  }
  not(col: string, op: string, val: unknown) {
    if (op !== 'is' || val !== null) throw new Error('fake not(): solo "is null"')
    this.filters.push((r) => r[col] != null)
    return this
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this._order = { col, asc: opts?.ascending !== false }
    return this
  }
  limit(n: number) {
    this._limit = n
    return this
  }
  insert(payload: Row | Row[]) {
    this.op = 'insert'
    this.payload = payload
    return this
  }
  update(patch: Row) {
    this.op = 'update'
    this.payload = patch
    return this
  }
  delete() {
    this.op = 'delete'
    return this
  }
  upsert(row: Row, opts?: { onConflict?: string }) {
    this.op = 'upsert'
    this.payload = row
    this.conflict = opts?.onConflict?.split(',') ?? []
    return this
  }

  private table_(): Row[] {
    if (!this.store[this.table]) this.store[this.table] = []
    return this.store[this.table]
  }
  private matched(): Row[] {
    let rows = this.table_().filter((r) => this.filters.every((f) => f(r)))
    if (this._order) {
      const { col, asc } = this._order
      rows = [...rows].sort((a, b) =>
        (String(a[col]) > String(b[col]) ? 1 : -1) * (asc ? 1 : -1),
      )
    }
    if (this._limit != null) rows = rows.slice(0, this._limit)
    return rows
  }
  private execute(): Row[] {
    if (this.op === 'insert') {
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload!]
      const inserted = rows.map((r) => ({ id: `id-${idc++}`, ...r }))
      this.table_().push(...inserted)
      return inserted
    }
    if (this.op === 'update') {
      const rows = this.matched()
      for (const r of rows) Object.assign(r, this.payload)
      return rows
    }
    if (this.op === 'delete') {
      const rows = this.matched()
      this.store[this.table] = this.table_().filter((r) => !rows.includes(r))
      return rows
    }
    if (this.op === 'upsert') {
      const row = this.payload as Row
      const found = this.table_().find((r) =>
        this.conflict.every((k) => r[k] === row[k]),
      )
      if (found) {
        Object.assign(found, row)
        return [found]
      }
      const inserted = { id: `id-${idc++}`, ...row }
      this.table_().push(inserted)
      return [inserted]
    }
    return this.matched()
  }

  maybeSingle() {
    return Promise.resolve({ data: this.execute()[0] ?? null, error: null })
  }
  single() {
    const r = this.execute()[0]
    return Promise.resolve(
      r ? { data: r, error: null } : { data: null, error: { message: 'no rows' } },
    )
  }
  // Awaitable: `await db.from(x).insert(...)` etc.
  then(resolve: (v: { data: Row[]; error: null }) => void) {
    resolve({ data: this.execute(), error: null })
  }
}

function fakeDb(seed: Record<string, Row[]> = {}) {
  const store: Record<string, Row[]> = JSON.parse(JSON.stringify(seed))
  return {
    store,
    from(table: string) {
      return new Builder(store, table)
    },
  }
}

const ACCOUNT = 'acc-1'
const CONTACT = 'contact-1'
const CONV = 'conv-1'
const USER = 'user-1'
const TZ = 'America/Mexico_City'
// Miércoles 8 de julio de 2026, 10:00 CDMX (16:00Z).
const NOW = new Date('2026-07-08T16:00:00Z')

function ctxWith(
  db: ReturnType<typeof fakeDb>,
  overrides: Partial<AgentToolContext> = {},
): AgentToolContext {
  return {
    db: db as never,
    accountId: ACCOUNT,
    contactId: CONTACT,
    conversationId: CONV,
    userId: USER,
    contactName: 'María López',
    timezone: TZ,
    now: NOW,
    embeddingsApiKey: null,
    ...overrides,
  }
}

const HOURS = [
  { account_id: ACCOUNT, weekday: 3, opens_at: '09:00', closes_at: '14:00', slot_minutes: 30 },
]
const PROC = {
  id: 'proc-1',
  account_id: ACCOUNT,
  name: 'Valoración presencial',
  description: null,
  category: 'valoracion',
  price_min: '500',
  price_max: '500',
  currency: 'MXN',
  deposit_amount: '300',
  duration_minutes: 30,
  sales_notes: 'Incluye revisión con el doctor.',
  is_active: true,
}

describe('executeClinicalTool', () => {
  beforeEach(() => {
    idc = 1
    mockRetrieveKnowledge.mockReset()
  })

  it('consultar_catalogo devuelve procedimientos activos formateados', async () => {
    const db = fakeDb({ procedures: [PROC] })
    const res = await executeClinicalTool('consultar_catalogo', {}, ctxWith(db))
    const out = JSON.parse(res.content)
    expect(out.ok).toBe(true)
    expect(out.total).toBe(1)
    expect(out.procedimientos[0].nombre).toBe('Valoración presencial')
    expect(out.procedimientos[0].anticipo).toContain('300')
    expect(out.procedimientos[0].notas_venta).toContain('doctor')
  })

  it('consultar_disponibilidad descuenta una cita ocupada', async () => {
    const db = fakeDb({
      clinic_hours: HOURS,
      appointments: [
        {
          id: 'a-existing',
          account_id: ACCOUNT,
          contact_id: 'otro',
          status: 'confirmada',
          starts_at: '2026-07-08T17:00:00Z', // 11:00 CDMX
          ends_at: '2026-07-08T17:30:00Z',
        },
      ],
    })
    const res = await executeClinicalTool(
      'consultar_disponibilidad',
      { duracion_minutos: 30, dias: 1 },
      ctxWith(db),
    )
    const out = JSON.parse(res.content)
    expect(out.ok).toBe(true)
    const etiquetas = out.huecos.map((h: { inicio: string }) => h.inicio)
    // El hueco de las 11:00 (17:00Z) está ocupado.
    expect(etiquetas).not.toContain('2026-07-08T17:00:00.000Z')
    // Pero las 10:30 (16:30Z) sí está libre.
    expect(etiquetas).toContain('2026-07-08T16:30:00.000Z')
  })

  it('agendar_cita crea la cita en pendiente, sin created_by, y notifica', async () => {
    const db = fakeDb({ clinic_hours: HOURS, procedures: [PROC] })
    const res = await executeClinicalTool(
      'agendar_cita',
      { inicio: '2026-07-08T12:00', procedure_id: 'proc-1' },
      ctxWith(db),
    )
    const out = JSON.parse(res.content)
    expect(out.ok).toBe(true)
    expect(out.estado).toBe('pendiente')
    const appt = db.store.appointments[0]
    expect(appt.status).toBe('pendiente') // regla de oro
    expect(appt.created_by).toBe(null) // NULL = agente
    expect(appt.deposit_status).toBe('pendiente') // proc con anticipo
    // 12:00 CDMX = 18:00Z
    expect(appt.starts_at).toBe('2026-07-08T18:00:00.000Z')
    // Debe dejar un aviso interno.
    expect(db.store.notifications?.[0]?.type).toBe('ai_appointment_created')
    // Nunca debe decir "confirmada".
    expect(out.instruccion_para_paciente.toLowerCase()).toContain('apartas')
  })

  it('agendar_cita reagenda la cita pendiente existente (no crea otra)', async () => {
    const db = fakeDb({
      clinic_hours: HOURS,
      procedures: [PROC],
      appointments: [
        {
          id: 'a-1',
          account_id: ACCOUNT,
          contact_id: CONTACT,
          status: 'pendiente',
          deposit_status: 'pendiente',
          deposit_amount: '300',
          procedure_id: 'proc-1',
          starts_at: '2026-07-08T17:00:00Z',
          ends_at: '2026-07-08T17:30:00Z',
        },
      ],
    })
    const res = await executeClinicalTool(
      'agendar_cita',
      { inicio: '2026-07-08T13:00', procedure_id: 'proc-1' },
      ctxWith(db),
    )
    const out = JSON.parse(res.content)
    expect(out.ok).toBe(true)
    expect(out.reagendada).toBe(true)
    expect(db.store.appointments).toHaveLength(1) // no segunda cita
    expect(db.store.appointments[0].starts_at).toBe('2026-07-08T19:00:00.000Z')
  })

  it('agendar_cita rechaza un horario fuera del horario de atención', async () => {
    const db = fakeDb({ clinic_hours: HOURS, procedures: [PROC] })
    const res = await executeClinicalTool(
      'agendar_cita',
      { inicio: '2026-07-08T22:00' }, // 10pm, fuera de 9-14
      ctxWith(db),
    )
    expect(res.isError).toBe(true)
    expect(db.store.appointments ?? []).toHaveLength(0)
  })

  // --- Regla de oro del anticipo (fallback a la valoración) ------

  it('agendar_cita sin procedure_id hereda el anticipo del procedimiento de valoración', async () => {
    const db = fakeDb({ clinic_hours: HOURS, procedures: [PROC] })
    const res = await executeClinicalTool(
      'agendar_cita',
      { inicio: '2026-07-08T12:00' }, // el modelo olvidó procedure_id
      ctxWith(db),
    )
    const out = JSON.parse(res.content)
    expect(out.ok).toBe(true)
    const appt = db.store.appointments[0]
    expect(appt.deposit_status).toBe('pendiente') // nunca sin anticipo
    expect(Number(appt.deposit_amount)).toBe(300)
    expect(out.anticipo_requerido).toContain('300')
    expect(out.anticipo_de).toBe('Valoración presencial')
  })

  it('agendar_cita para un procedimiento SIN anticipo propio (ej. carillas) también pide el de la valoración', async () => {
    const carillas = {
      ...PROC,
      id: 'proc-carillas',
      name: 'Carillas (Emax / Zirconia)',
      category: 'dental',
      price_min: null,
      price_max: null,
      deposit_amount: null,
      duration_minutes: 60,
    }
    const db = fakeDb({ clinic_hours: HOURS, procedures: [PROC, carillas] })
    const res = await executeClinicalTool(
      'agendar_cita',
      { inicio: '2026-07-08T12:00', procedure_id: 'proc-carillas' },
      ctxWith(db),
    )
    const out = JSON.parse(res.content)
    expect(out.ok).toBe(true)
    const appt = db.store.appointments[0]
    expect(appt.procedure_id).toBe('proc-carillas') // el interés se conserva
    expect(appt.deposit_status).toBe('pendiente')
    expect(Number(appt.deposit_amount)).toBe(300) // anticipo de la valoración
  })

  it('agendar_cita de seguimiento no exige anticipo', async () => {
    const db = fakeDb({ clinic_hours: HOURS, procedures: [PROC] })
    const res = await executeClinicalTool(
      'agendar_cita',
      { inicio: '2026-07-08T12:00', tipo: 'seguimiento' },
      ctxWith(db),
    )
    const out = JSON.parse(res.content)
    expect(out.ok).toBe(true)
    expect(db.store.appointments[0].deposit_status).toBe('no_aplica')
    expect(out.anticipo_requerido).toBe(null)
  })

  it('agendar_cita con anticipo incluye los datos de pago en el mismo resultado', async () => {
    const db = fakeDb({
      clinic_hours: HOURS,
      procedures: [PROC],
      payment_accounts: [
        {
          id: 'pa-1',
          account_id: ACCOUNT,
          bank: 'BBVA',
          holder: 'Dr. Ángel Zavala Díaz',
          clabe: '012345678901234567',
          account_number: null,
          instructions: null,
          is_active: true,
        },
      ],
    })
    const res = await executeClinicalTool(
      'agendar_cita',
      { inicio: '2026-07-08T12:00', procedure_id: 'proc-1' },
      ctxWith(db),
    )
    const out = JSON.parse(res.content)
    expect(out.ok).toBe(true)
    expect(out.datos_pago).toHaveLength(1)
    expect(out.datos_pago[0].banco).toBe('BBVA')
    expect(out.instruccion_para_paciente).toContain('MISMO mensaje')
  })

  it('agendar_cita con anticipo pero sin cuentas configuradas manda a avisar al equipo', async () => {
    const db = fakeDb({ clinic_hours: HOURS, procedures: [PROC] })
    const res = await executeClinicalTool(
      'agendar_cita',
      { inicio: '2026-07-08T12:00', procedure_id: 'proc-1' },
      ctxWith(db),
    )
    const out = JSON.parse(res.content)
    expect(out.ok).toBe(true)
    expect(out.datos_pago).toHaveLength(0)
    expect(out.instruccion_para_paciente).toContain('NO inventes')
  })

  it('prevalidar_anticipo registra el pago en pendiente y no confirma nada', async () => {
    const db = fakeDb({
      procedures: [PROC],
      appointments: [
        {
          id: 'a-1',
          account_id: ACCOUNT,
          contact_id: CONTACT,
          status: 'pendiente',
          deposit_status: 'pendiente',
          deposit_amount: '300',
          procedure_id: 'proc-1',
          starts_at: '2026-07-09T17:00:00Z',
          ends_at: '2026-07-09T17:30:00Z',
        },
      ],
    })
    const res = await executeClinicalTool(
      'prevalidar_anticipo',
      { comprobante_url: 'https://x/recibo.jpg' },
      ctxWith(db),
    )
    const out = JSON.parse(res.content)
    expect(out.ok).toBe(true)
    expect(out.estado).toBe('en_revision')
    const pay = db.store.payments[0]
    expect(pay.status).toBe('pendiente') // NUNCA 'confirmado'
    expect(Number(pay.amount)).toBe(300)
    // La cita sigue pendiente; solo el anticipo entra en revisión.
    expect(db.store.appointments[0].status).toBe('pendiente')
    expect(db.store.notifications[0].type).toBe('ai_deposit_prevalidated')
    expect(out.instruccion_para_paciente.toLowerCase()).toContain('revisión')
  })

  it('prevalidar_anticipo adjunta el comprobante desde la BD cuando el modelo no pasa URL', async () => {
    const db = fakeDb({
      procedures: [PROC],
      appointments: [
        {
          id: 'a-1',
          account_id: ACCOUNT,
          contact_id: CONTACT,
          status: 'pendiente',
          deposit_status: 'pendiente',
          deposit_amount: '300',
          procedure_id: 'proc-1',
          starts_at: '2026-07-09T17:00:00Z',
          ends_at: '2026-07-09T17:30:00Z',
        },
      ],
      messages: [
        {
          id: 'm-1',
          conversation_id: CONV,
          sender_type: 'customer',
          content_type: 'image',
          media_url: 'https://cdn.zernio.test/comprobante-viejo.jpg',
          created_at: '2026-07-08T15:00:00Z',
        },
        {
          id: 'm-2',
          conversation_id: CONV,
          sender_type: 'customer',
          content_type: 'image',
          media_url: 'https://cdn.zernio.test/comprobante.jpg',
          created_at: '2026-07-08T15:59:00Z',
        },
        // De OTRA conversación: jamás debe adjuntarse aquí.
        {
          id: 'm-3',
          conversation_id: 'conv-ajena',
          sender_type: 'customer',
          content_type: 'image',
          media_url: 'https://cdn.zernio.test/ajeno.jpg',
          created_at: '2026-07-08T16:30:00Z',
        },
      ],
    })
    const res = await executeClinicalTool(
      'prevalidar_anticipo',
      { referencia: 'MBAN123456' },
      ctxWith(db),
    )
    const out = JSON.parse(res.content)
    expect(out.ok).toBe(true)
    expect(out.comprobante_adjunto).toBe(true)
    const pay = db.store.payments[0]
    // La imagen más reciente del paciente en ESTA conversación.
    expect(pay.receipt_url).toBe('https://cdn.zernio.test/comprobante.jpg')
    expect(pay.concept).toContain('ref MBAN123456')
    expect(db.store.notifications[0].body).toContain('ref MBAN123456')
  })

  it('prevalidar_anticipo sin comprobante avisa al equipo que falta el adjunto', async () => {
    const db = fakeDb({
      procedures: [PROC],
      appointments: [
        {
          id: 'a-1',
          account_id: ACCOUNT,
          contact_id: CONTACT,
          status: 'pendiente',
          deposit_status: 'pendiente',
          deposit_amount: '300',
          procedure_id: 'proc-1',
          starts_at: '2026-07-09T17:00:00Z',
          ends_at: '2026-07-09T17:30:00Z',
        },
      ],
    })
    const res = await executeClinicalTool('prevalidar_anticipo', {}, ctxWith(db))
    const out = JSON.parse(res.content)
    expect(out.ok).toBe(true)
    expect(out.comprobante_adjunto).toBe(false)
    expect(db.store.payments[0].receipt_url).toBeNull()
    expect(db.store.notifications[0].body).toContain('sin comprobante')
  })

  it('clasificar_lead guarda etapa (tag) y actualiza el nombre', async () => {
    const db = fakeDb({ contacts: [{ id: CONTACT, account_id: ACCOUNT, name: '+525512345678' }] })
    const res = await executeClinicalTool(
      'clasificar_lead',
      { etapa: 'interesado', nombre: 'María López' },
      ctxWith(db),
    )
    const out = JSON.parse(res.content)
    expect(out.ok).toBe(true)
    expect(out.etiqueta_crm).toBe('actualizada')
    expect(db.store.contacts[0].name).toBe('María López')
    const tag = db.store.tags.find((t) => t.name === 'lead:interesado')
    expect(tag).toBeTruthy()
    // tags.account_id es NOT NULL (migración 017): sin él, el insert
    // fallaba en silencio y el CRM nunca mostraba la calificación.
    expect(tag?.account_id).toBe(ACCOUNT)
    expect(tag?.user_id).toBe(USER)
    expect(db.store.contact_tags).toHaveLength(1)
  })

  it('clasificar_lead reemplaza la etiqueta de embudo anterior (una sola vigente)', async () => {
    const db = fakeDb({ contacts: [{ id: CONTACT, account_id: ACCOUNT, name: 'María' }] })
    const ctx = ctxWith(db)
    await executeClinicalTool('clasificar_lead', { etapa: 'pregunton' }, ctx)
    await executeClinicalTool('clasificar_lead', { etapa: 'interesado' }, ctx)
    const activeTagIds = db.store.contact_tags.map((ct) => ct.tag_id)
    const activeNames = db.store.tags
      .filter((t) => activeTagIds.includes(t.id))
      .map((t) => t.name)
    expect(activeNames).toEqual(['lead:interesado'])
  })

  it('escalar_a_humano notifica al equipo SIN tocar el modo IA y marca escalated', async () => {
    const db = fakeDb({
      conversations: [{ id: CONV, account_id: ACCOUNT, ai_autoreply_disabled: false }],
    })
    const res = await executeClinicalTool(
      'escalar_a_humano',
      { motivo: 'pide hablar con el doctor' },
      ctxWith(db),
    )
    expect(res.escalated).toBe(true)
    // Decisión de producto: el modo IA↔humano solo cambia a mano desde
    // el panel — escalar avisa, no apaga.
    expect(db.store.conversations[0].ai_autoreply_disabled).toBe(false)
    expect(db.store.notifications[0].type).toBe('ai_escalation')
  })

  it('consultar_datos_pago devuelve solo las cuentas activas de la cuenta', async () => {
    const db = fakeDb({
      payment_accounts: [
        {
          id: 'pa-1',
          account_id: ACCOUNT,
          bank: 'BBVA',
          holder: 'Dr. Ángel Zavala Díaz',
          clabe: '012345678901234567',
          account_number: null,
          instructions: 'Envía tu comprobante por aquí',
          is_active: true,
        },
        { id: 'pa-2', account_id: ACCOUNT, bank: 'Santander', holder: 'X', is_active: false },
        { id: 'pa-3', account_id: 'otra-cuenta', bank: 'HSBC', holder: 'Y', is_active: true },
      ],
    })
    const res = await executeClinicalTool('consultar_datos_pago', {}, ctxWith(db))
    const out = JSON.parse(res.content)
    expect(out.ok).toBe(true)
    expect(out.cuentas).toHaveLength(1)
    expect(out.cuentas[0].banco).toBe('BBVA')
    expect(out.cuentas[0].clabe).toBe('012345678901234567')
    expect(out.instruccion_para_paciente).toContain('comprobante')
  })

  it('consultar_datos_pago sin cuentas manda a avisar al equipo, no a inventar', async () => {
    const db = fakeDb()
    const res = await executeClinicalTool('consultar_datos_pago', {}, ctxWith(db))
    const out = JSON.parse(res.content)
    expect(out.ok).toBe(true)
    expect(out.cuentas).toHaveLength(0)
    expect(out.nota).toContain('NO inventes')
  })

  it('consultar_conocimiento pasa la pregunta y la cuenta a retrieveKnowledge y regresa los extractos', async () => {
    mockRetrieveKnowledge.mockResolvedValue(['La clínica no maneja seguros médicos.'])
    const db = fakeDb()
    const res = await executeClinicalTool(
      'consultar_conocimiento',
      { pregunta: '¿aceptan seguro de gastos médicos?' },
      ctxWith(db, { embeddingsApiKey: 'key-123' }),
    )
    expect(mockRetrieveKnowledge).toHaveBeenCalledWith(
      db,
      ACCOUNT,
      { embeddingsApiKey: 'key-123' },
      '¿aceptan seguro de gastos médicos?',
      5,
    )
    const out = JSON.parse(res.content)
    expect(out.ok).toBe(true)
    expect(out.resultados).toEqual(['La clínica no maneja seguros médicos.'])
  })

  it('consultar_conocimiento sin resultados avisa que no invente y sugiere escalar', async () => {
    mockRetrieveKnowledge.mockResolvedValue([])
    const db = fakeDb()
    const res = await executeClinicalTool(
      'consultar_conocimiento',
      { pregunta: 'algo muy específico que no está documentado' },
      ctxWith(db),
    )
    const out = JSON.parse(res.content)
    expect(out.ok).toBe(true)
    expect(out.resultados).toHaveLength(0)
    expect(out.nota).toContain('NO inventes')
  })

  it('consultar_conocimiento sin pregunta devuelve error', async () => {
    const db = fakeDb()
    const res = await executeClinicalTool('consultar_conocimiento', {}, ctxWith(db))
    expect(res.isError).toBe(true)
    expect(mockRetrieveKnowledge).not.toHaveBeenCalled()
  })

  it('consultar_mis_citas lista solo las citas del contacto con su estado', async () => {
    const db = fakeDb({
      appointments: [
        {
          id: 'a-1',
          account_id: ACCOUNT,
          contact_id: CONTACT,
          status: 'pendiente',
          deposit_status: 'pendiente',
          deposit_amount: '350',
          appointment_type: 'valoracion',
          starts_at: '2026-07-10T22:00:00Z',
          ends_at: '2026-07-10T23:00:00Z',
        },
        {
          id: 'a-otro',
          account_id: ACCOUNT,
          contact_id: 'otro',
          status: 'confirmada',
          deposit_status: 'pagado',
          appointment_type: 'valoracion',
          starts_at: '2026-07-11T22:00:00Z',
          ends_at: '2026-07-11T23:00:00Z',
        },
      ],
    })
    const res = await executeClinicalTool('consultar_mis_citas', {}, ctxWith(db))
    const out = JSON.parse(res.content)
    expect(out.ok).toBe(true)
    expect(out.citas).toHaveLength(1)
    expect(out.citas[0].estado).toBe('pendiente de confirmar')
    expect(out.citas[0].anticipo).toContain('350')
    expect(out.recordatorio).toContain('NO está confirmada')
  })

  it('cancelar_cita cancela la cita activa y notifica al equipo', async () => {
    const db = fakeDb({
      appointments: [
        {
          id: 'a-1',
          account_id: ACCOUNT,
          contact_id: CONTACT,
          status: 'pendiente',
          deposit_status: 'pendiente',
          deposit_amount: '350',
          starts_at: '2026-07-10T22:00:00Z',
          ends_at: '2026-07-10T23:00:00Z',
        },
      ],
    })
    const res = await executeClinicalTool(
      'cancelar_cita',
      { motivo: 'ya no puede asistir' },
      ctxWith(db),
    )
    const out = JSON.parse(res.content)
    expect(out.ok).toBe(true)
    expect(db.store.appointments[0].status).toBe('cancelada')
    expect(db.store.notifications[0].type).toBe('ai_appointment_cancelled')
    expect(out.instruccion_para_paciente).toContain('anticipos')
  })

  it('cancelar_cita sin cita activa devuelve error corregible', async () => {
    const db = fakeDb()
    const res = await executeClinicalTool('cancelar_cita', {}, ctxWith(db))
    expect(res.isError).toBe(true)
  })

  // --- Expediente clínico ligero (migración 041) ----------------

  it('consultar_expediente devuelve solo las entradas activas de ESTE contacto', async () => {
    const db = fakeDb({
      patient_records: [
        {
          id: 'r-1',
          account_id: ACCOUNT,
          contact_id: CONTACT,
          category: 'sintoma',
          content: 'le truena la mandíbula al masticar',
          source: 'agente',
          is_active: true,
          created_at: '2026-07-01T18:00:00Z',
        },
        {
          id: 'r-viejo',
          account_id: ACCOUNT,
          contact_id: CONTACT,
          category: 'nota',
          content: 'entrada corregida por el equipo',
          source: 'equipo',
          is_active: false, // desactivada — no debe salir
          created_at: '2026-06-01T18:00:00Z',
        },
        {
          id: 'r-otro',
          account_id: ACCOUNT,
          contact_id: 'otro-paciente', // AISLAMIENTO: jamás mezclar
          category: 'alergia',
          content: 'alérgico a la penicilina',
          source: 'agente',
          is_active: true,
          created_at: '2026-07-02T18:00:00Z',
        },
      ],
    })
    const res = await executeClinicalTool('consultar_expediente', {}, ctxWith(db))
    const out = JSON.parse(res.content)
    expect(out.ok).toBe(true)
    expect(out.expediente).toHaveLength(1)
    expect(out.expediente[0].categoria).toBe('síntoma')
    expect(out.expediente[0].dato).toContain('mandíbula')
    expect(JSON.stringify(out)).not.toContain('penicilina')
    expect(out.instruccion_para_paciente).toContain('ESTE paciente')
  })

  it('consultar_expediente sin entradas explica que es la primera vez', async () => {
    const db = fakeDb()
    const res = await executeClinicalTool('consultar_expediente', {}, ctxWith(db))
    const out = JSON.parse(res.content)
    expect(out.ok).toBe(true)
    expect(out.expediente).toHaveLength(0)
    expect(out.nota).toContain('registrar_dato_clinico')
  })

  it('registrar_dato_clinico guarda el hecho ligado al contacto, como agente', async () => {
    const db = fakeDb()
    const res = await executeClinicalTool(
      'registrar_dato_clinico',
      { categoria: 'alergia', dato: 'alérgica a la penicilina' },
      ctxWith(db),
    )
    const out = JSON.parse(res.content)
    expect(out.ok).toBe(true)
    const row = db.store.patient_records[0]
    expect(row.account_id).toBe(ACCOUNT)
    expect(row.contact_id).toBe(CONTACT)
    expect(row.conversation_id).toBe(CONV)
    expect(row.category).toBe('alergia')
    expect(row.source).toBe('agente')
    expect(row.created_by).toBe(null) // NULL = agente IA
    expect(out.nota).toContain('No se lo anuncies')
  })

  it('registrar_dato_clinico no duplica un hecho exacto ya registrado', async () => {
    const db = fakeDb()
    const ctx = ctxWith(db)
    const input = { categoria: 'sintoma', dato: 'dolor de cabeza al despertar' }
    await executeClinicalTool('registrar_dato_clinico', input, ctx)
    const res = await executeClinicalTool('registrar_dato_clinico', input, ctx)
    const out = JSON.parse(res.content)
    expect(out.ok).toBe(true)
    expect(out.duplicado).toBe(true)
    expect(db.store.patient_records).toHaveLength(1)
  })

  it('registrar_dato_clinico rechaza categoría inválida o dato vacío', async () => {
    const db = fakeDb()
    const bad = await executeClinicalTool(
      'registrar_dato_clinico',
      { categoria: 'diagnostico', dato: 'bruxismo severo' },
      ctxWith(db),
    )
    expect(bad.isError).toBe(true)
    const empty = await executeClinicalTool(
      'registrar_dato_clinico',
      { categoria: 'sintoma', dato: '   ' },
      ctxWith(db),
    )
    expect(empty.isError).toBe(true)
    expect(db.store.patient_records ?? []).toHaveLength(0)
  })

  // --- Embudo → pipeline visual (deals) ------------------------

  it('clasificar_lead crea el pipeline "Embudo IA" con etapas y el deal del lead', async () => {
    const db = fakeDb({ contacts: [{ id: CONTACT, account_id: ACCOUNT, name: null }] })
    await executeClinicalTool(
      'clasificar_lead',
      { etapa: 'interesado', nombre: 'María López' },
      ctxWith(db),
    )
    expect(db.store.pipelines).toHaveLength(1)
    expect(db.store.pipelines[0].name).toBe('Embudo IA')
    expect(db.store.pipeline_stages.map((s) => s.name)).toContain('Anticipo en revisión')
    const deal = db.store.deals[0]
    expect(deal.title).toBe('María López')
    expect(deal.status).toBe('open')
    const stage = db.store.pipeline_stages.find((s) => s.id === deal.stage_id)
    expect(stage?.name).toBe('Interesado')
  })

  it('el embudo visual solo avanza: no regresa un deal que ya va adelante', async () => {
    const db = fakeDb({ contacts: [{ id: CONTACT, account_id: ACCOUNT, name: 'María López' }] })
    const ctx = ctxWith(db)
    await executeClinicalTool('clasificar_lead', { etapa: 'interesado' }, ctx)
    await executeClinicalTool('clasificar_lead', { etapa: 'pregunton' }, ctx)
    expect(db.store.deals).toHaveLength(1)
    const stage = db.store.pipeline_stages.find(
      (s) => s.id === db.store.deals[0].stage_id,
    )
    expect(stage?.name).toBe('Interesado')
  })

  it('agendar_cita avanza el deal a "Cita apartada" con el valor del procedimiento', async () => {
    const db = fakeDb({
      clinic_hours: HOURS,
      procedures: [PROC],
      contacts: [{ id: CONTACT, account_id: ACCOUNT, name: 'María López' }],
    })
    const ctx = ctxWith(db)
    await executeClinicalTool('clasificar_lead', { etapa: 'interesado' }, ctx)
    await executeClinicalTool(
      'agendar_cita',
      { inicio: '2026-07-08T12:00', procedure_id: 'proc-1' },
      ctx,
    )
    expect(db.store.deals).toHaveLength(1)
    const deal = db.store.deals[0]
    const stage = db.store.pipeline_stages.find((s) => s.id === deal.stage_id)
    expect(stage?.name).toBe('Cita apartada')
    expect(Number(deal.value)).toBe(500)
  })

  it('prevalidar_anticipo avanza el deal a "Anticipo en revisión"', async () => {
    const db = fakeDb({
      procedures: [PROC],
      contacts: [{ id: CONTACT, account_id: ACCOUNT, name: 'María López' }],
      appointments: [
        {
          id: 'a-1',
          account_id: ACCOUNT,
          contact_id: CONTACT,
          status: 'pendiente',
          deposit_status: 'pendiente',
          deposit_amount: '300',
          procedure_id: 'proc-1',
          starts_at: '2026-07-09T17:00:00Z',
          ends_at: '2026-07-09T17:30:00Z',
        },
      ],
    })
    await executeClinicalTool(
      'prevalidar_anticipo',
      { comprobante_url: 'https://x/recibo.jpg' },
      ctxWith(db),
    )
    const deal = db.store.deals[0]
    const stage = db.store.pipeline_stages.find((s) => s.id === deal.stage_id)
    expect(stage?.name).toBe('Anticipo en revisión')
  })

  it('clasificar_lead spam cierra el deal como perdido', async () => {
    const db = fakeDb({ contacts: [{ id: CONTACT, account_id: ACCOUNT, name: 'X' }] })
    const ctx = ctxWith(db)
    await executeClinicalTool('clasificar_lead', { etapa: 'interesado' }, ctx)
    await executeClinicalTool('clasificar_lead', { etapa: 'spam' }, ctx)
    expect(db.store.deals).toHaveLength(1)
    expect(db.store.deals[0].status).toBe('lost')
  })
})
