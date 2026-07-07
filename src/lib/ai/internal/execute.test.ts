import { describe, it, expect } from 'vitest'
import { executeInternalTool } from './execute'
import type { AgentToolContext } from '../agent'

// ------------------------------------------------------------
// Fake Supabase en memoria — subconjunto de la query API que usan
// estas tools (todas de solo lectura): select/eq/in/gte/lt/ilike/
// order/limit + maybeSingle/await directo.
// ------------------------------------------------------------

type Row = Record<string, unknown>

class Builder {
  private filters: ((r: Row) => boolean)[] = []
  private _order: { col: string; asc: boolean } | null = null
  private _limit: number | null = null

  constructor(private rows: Row[]) {}

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
  gte(col: string, val: string) {
    this.filters.push((r) => String(r[col]) >= val)
    return this
  }
  lt(col: string, val: string) {
    this.filters.push((r) => String(r[col]) < val)
    return this
  }
  ilike(col: string, pat: string) {
    const needle = pat.replace(/%/g, '').toLowerCase()
    this.filters.push((r) => String(r[col] ?? '').toLowerCase().includes(needle))
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

  private matched(): Row[] {
    let rows = this.rows.filter((r) => this.filters.every((f) => f(r)))
    if (this._order) {
      const { col, asc } = this._order
      rows = [...rows].sort(
        (a, b) => (String(a[col]) > String(b[col]) ? 1 : -1) * (asc ? 1 : -1),
      )
    }
    if (this._limit != null) rows = rows.slice(0, this._limit)
    return rows
  }

  maybeSingle() {
    return Promise.resolve({ data: this.matched()[0] ?? null, error: null })
  }
  then(resolve: (v: { data: Row[]; error: null }) => void) {
    resolve({ data: this.matched(), error: null })
  }
}

function fakeDb(seed: Record<string, Row[]> = {}) {
  const store: Record<string, Row[]> = JSON.parse(JSON.stringify(seed))
  return {
    store,
    from(table: string) {
      return new Builder(store[table] ?? [])
    },
  }
}

const ACCOUNT = 'acc-1'
const TZ = 'America/Mexico_City'
// Miércoles 8 de julio de 2026, 10:00 CDMX (16:00Z).
const NOW = new Date('2026-07-08T16:00:00Z')

function ctxWith(db: ReturnType<typeof fakeDb>): AgentToolContext {
  return {
    db: db as never,
    accountId: ACCOUNT,
    // El asistente interno no opera sobre un contacto/conversación —
    // estos campos van vacíos porque sus tools nunca los leen.
    contactId: '',
    conversationId: '',
    userId: 'user-1',
    contactName: null,
    timezone: TZ,
    now: NOW,
    embeddingsApiKey: null,
  }
}

describe('consultar_agenda_dia', () => {
  it('devuelve solo las citas del día pedido, ordenadas, con nombre del paciente', async () => {
    const db = fakeDb({
      appointments: [
        {
          id: 'a-1',
          account_id: ACCOUNT,
          contact_id: 'c-1',
          starts_at: '2026-07-08T18:00:00Z', // 12pm local
          status: 'pendiente',
          appointment_type: 'valoracion',
          deposit_status: 'pendiente',
          deposit_amount: 350,
        },
        {
          id: 'a-2',
          account_id: ACCOUNT,
          contact_id: 'c-2',
          starts_at: '2026-07-08T16:00:00Z', // 10am local — antes que a-1
          status: 'confirmada',
          appointment_type: 'valoracion',
          deposit_status: 'pagado',
          deposit_amount: 350,
        },
        {
          id: 'a-3',
          account_id: ACCOUNT,
          contact_id: 'c-1',
          starts_at: '2026-07-09T16:00:00Z', // día siguiente — excluida
          status: 'pendiente',
          appointment_type: 'valoracion',
          deposit_status: 'pendiente',
          deposit_amount: 350,
        },
      ],
      contacts: [
        { id: 'c-1', name: 'María López', phone: '5551111111' },
        { id: 'c-2', name: null, phone: '5552222222' },
      ],
    })
    const res = await executeInternalTool('consultar_agenda_dia', {}, ctxWith(db))
    const out = JSON.parse(res.content)
    expect(out.ok).toBe(true)
    expect(out.total).toBe(2)
    // Orden cronológico: la de las 10am (c-2, sin nombre → teléfono) antes
    // que la de las 12pm (c-1).
    expect(out.citas.map((c: { paciente: string }) => c.paciente)).toEqual([
      '5552222222',
      'María López',
    ])
    expect(out.citas[0].estado).toBe('confirmada')
    expect(out.citas[0].anticipo).toBe('pagado')
    expect(out.citas[1].estado).toBe('pendiente de confirmar')
    expect(out.citas[1].anticipo).toContain('pendiente')
  })

  it('sin citas ese día devuelve nota, no error', async () => {
    const db = fakeDb()
    const res = await executeInternalTool('consultar_agenda_dia', {}, ctxWith(db))
    const out = JSON.parse(res.content)
    expect(out.ok).toBe(true)
    expect(out.citas).toHaveLength(0)
  })

  it('respeta una fecha explícita distinta a "hoy"', async () => {
    const db = fakeDb({
      appointments: [
        {
          id: 'a-1',
          account_id: ACCOUNT,
          contact_id: 'c-1',
          starts_at: '2026-07-09T16:00:00Z',
          status: 'pendiente',
          appointment_type: 'valoracion',
          deposit_status: 'pendiente',
          deposit_amount: 350,
        },
      ],
      contacts: [{ id: 'c-1', name: 'Juan Pérez', phone: '5550000000' }],
    })
    const res = await executeInternalTool(
      'consultar_agenda_dia',
      { fecha: '2026-07-09' },
      ctxWith(db),
    )
    const out = JSON.parse(res.content)
    expect(out.total).toBe(1)
    expect(out.citas[0].paciente).toBe('Juan Pérez')
  })
})

describe('consultar_anticipos_pendientes', () => {
  it('lista solo los anticipos en status pendiente, del más antiguo al más nuevo', async () => {
    const db = fakeDb({
      payments: [
        {
          id: 'p-1',
          account_id: ACCOUNT,
          contact_id: 'c-1',
          amount: 350,
          currency: 'MXN',
          method: 'transferencia',
          receipt_url: 'https://example.com/r1.jpg',
          status: 'pendiente',
          created_at: '2026-07-08T12:00:00Z',
        },
        {
          id: 'p-2',
          account_id: ACCOUNT,
          contact_id: 'c-2',
          amount: 700,
          currency: 'MXN',
          method: 'tarjeta',
          receipt_url: null,
          status: 'confirmado',
          created_at: '2026-07-08T10:00:00Z',
        },
      ],
      contacts: [{ id: 'c-1', name: 'María López', phone: '5551111111' }],
    })
    const res = await executeInternalTool('consultar_anticipos_pendientes', {}, ctxWith(db))
    const out = JSON.parse(res.content)
    expect(out.ok).toBe(true)
    expect(out.total).toBe(1)
    expect(out.anticipos[0].paciente).toBe('María López')
    expect(out.anticipos[0].monto).toBe('$350 MXN')
    expect(out.nota).toContain('panel')
  })

  it('sin pendientes devuelve nota, no error', async () => {
    const db = fakeDb()
    const res = await executeInternalTool('consultar_anticipos_pendientes', {}, ctxWith(db))
    const out = JSON.parse(res.content)
    expect(out.ok).toBe(true)
    expect(out.anticipos).toHaveLength(0)
  })
})

describe('consultar_embudo', () => {
  it('sin pipeline creado todavía, avisa sin error', async () => {
    const db = fakeDb()
    const res = await executeInternalTool('consultar_embudo', {}, ctxWith(db))
    const out = JSON.parse(res.content)
    expect(out.ok).toBe(true)
    expect(out.etapas).toHaveLength(0)
  })

  it('agrupa leads abiertos por etapa con su valor potencial', async () => {
    const db = fakeDb({
      pipelines: [{ id: 'pipe-1', account_id: ACCOUNT, name: 'Embudo IA' }],
      pipeline_stages: [
        { id: 'st-1', pipeline_id: 'pipe-1', name: 'Preguntón', position: 0 },
        { id: 'st-2', pipeline_id: 'pipe-1', name: 'Cita apartada', position: 3 },
      ],
      deals: [
        { id: 'd-1', pipeline_id: 'pipe-1', stage_id: 'st-1', value: 0, status: 'open' },
        { id: 'd-2', pipeline_id: 'pipe-1', stage_id: 'st-2', value: 700, status: 'open' },
        { id: 'd-3', pipeline_id: 'pipe-1', stage_id: 'st-2', value: 700, status: 'open' },
        // perdido — no debe contar
        { id: 'd-4', pipeline_id: 'pipe-1', stage_id: 'st-1', value: 0, status: 'lost' },
      ],
    })
    const res = await executeInternalTool('consultar_embudo', {}, ctxWith(db))
    const out = JSON.parse(res.content)
    expect(out.etapas).toEqual([
      { etapa: 'Preguntón', leads: 1, valor_potencial: '$0 MXN' },
      { etapa: 'Cita apartada', leads: 2, valor_potencial: '$1400 MXN' },
    ])
  })
})

describe('buscar_paciente', () => {
  const CONTACTS = [
    { id: 'c-1', account_id: ACCOUNT, name: 'María López', phone: '5551111111', email: null },
    { id: 'c-2', account_id: ACCOUNT, name: 'Mariana Ruiz', phone: '5559999999', email: null },
  ]

  it('busca por nombre parcial e incluye la última cita', async () => {
    const db = fakeDb({
      contacts: CONTACTS,
      appointments: [
        {
          contact_id: 'c-1',
          account_id: ACCOUNT,
          starts_at: '2026-07-08T16:00:00Z',
          status: 'pendiente',
        },
      ],
    })
    const res = await executeInternalTool('buscar_paciente', { query: 'maría' }, ctxWith(db))
    const out = JSON.parse(res.content)
    expect(out.pacientes).toHaveLength(1)
    expect(out.pacientes[0].nombre).toBe('María López')
    expect(out.pacientes[0].ultima_cita.estado).toBe('pendiente de confirmar')
  })

  it('busca por teléfono', async () => {
    const db = fakeDb({ contacts: CONTACTS })
    const res = await executeInternalTool(
      'buscar_paciente',
      { query: '5559999999' },
      ctxWith(db),
    )
    const out = JSON.parse(res.content)
    expect(out.pacientes).toHaveLength(1)
    expect(out.pacientes[0].nombre).toBe('Mariana Ruiz')
  })

  it('sin resultados avisa en vez de fallar', async () => {
    const db = fakeDb({ contacts: CONTACTS })
    const res = await executeInternalTool(
      'buscar_paciente',
      { query: 'nadie-existe' },
      ctxWith(db),
    )
    const out = JSON.parse(res.content)
    expect(out.ok).toBe(true)
    expect(out.pacientes).toHaveLength(0)
  })

  it('sin query devuelve error', async () => {
    const db = fakeDb()
    const res = await executeInternalTool('buscar_paciente', {}, ctxWith(db))
    expect(res.isError).toBe(true)
  })
})
