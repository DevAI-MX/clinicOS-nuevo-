import { describe, it, expect } from 'vitest'
import {
  validateClinicalReply,
  buildClinicalFallbackReply,
  buildGuardrailRepairNote,
} from './guardrails'
import type { ToolTrace } from './tools'

function trace(name: string, overrides: Partial<ToolTrace> = {}): ToolTrace {
  return { name, input: {}, content: '{"ok":true}', isError: false, ...overrides }
}

describe('validateClinicalReply — precios', () => {
  it('bloquea un precio sin tool que lo respalde', () => {
    const v = validateClinicalReply({
      text: 'La limpieza cuesta $800 y la valoración $350!',
      traces: [],
      stateLines: [],
    })
    expect(v.ok).toBe(false)
    expect(v.reasons.some((r) => r.includes('precio'))).toBe(true)
  })

  it('permite el precio que consultar_catalogo DEVOLVIÓ en su resultado', () => {
    const v = validateClinicalReply({
      text: 'La valoración va de $500 a $800, el costo exacto se define con el doctor.',
      traces: [
        trace('consultar_catalogo', {
          content:
            '{"procedimientos":[{"nombre":"Valoración","precio":"$500–$800","anticipo":"$350"}]}',
        }),
      ],
      stateLines: [],
    })
    expect(v.ok).toBe(true)
  })

  it('bloquea un monto que la tool NO devolvió, aunque consultar_catalogo haya corrido', () => {
    const v = validateClinicalReply({
      text: 'La limpieza cuesta $950.',
      traces: [
        trace('consultar_catalogo', {
          content: '{"procedimientos":[{"nombre":"Limpieza","precio":"$500–$800"}]}',
        }),
      ],
      stateLines: [],
    })
    expect(v.ok).toBe(false)
    expect(v.categories).toContain('precio')
  })

  it('formatos monetarios equivalentes se reconocen ($350 ↔ 350 pesos ↔ 350 MXN)', () => {
    const v = validateClinicalReply({
      text: 'Tu anticipo es de $350.',
      traces: [trace('prevalidar_anticipo', { content: '{"monto":"350 MXN"}' })],
      stateLines: [],
    })
    expect(v.ok).toBe(true)

    const v2 = validateClinicalReply({
      text: 'Serían 350 pesos de anticipo.',
      traces: [trace('consultar_catalogo', { content: '{"anticipo":"$350"}' })],
      stateLines: [],
    })
    expect(v2.ok).toBe(true)
  })

  it('una tool que FALLÓ no respalda el precio', () => {
    const v = validateClinicalReply({
      text: 'Son $800 exactos.',
      traces: [trace('consultar_catalogo', { isError: true, content: '{"precio":"$800"}' })],
      stateLines: [],
    })
    expect(v.ok).toBe(false)
  })

  it('permite repetir un monto que viene del snapshot de BD', () => {
    const v = validateClinicalReply({
      text: 'Solo queda pendiente tu anticipo de $350 para confirmar el lugar.',
      traces: [],
      stateLines: ['Cita apartada: mié 8 jul, 16:30 — pendiente de confirmar, anticipo pendiente ($350).'],
    })
    expect(v.ok).toBe(true)
  })

  it('con separador de miles del snapshot ($1,500) también respalda', () => {
    const v = validateClinicalReply({
      text: 'Tu anticipo es de $1,500.',
      traces: [],
      stateLines: ['4. Anticipo: PENDIENTE ($1,500) — sin este paso la cita no se confirma.'],
    })
    expect(v.ok).toBe(true)
  })

  it('números sueltos del snapshot (paso/fecha/hora) NO respaldan un precio', () => {
    // Regresión: antes cualquier número del snapshot contaba como monto
    // — el "16" de "16:30" respaldaba un "$16" inventado.
    const v = validateClinicalReply({
      text: 'El anticipo es de $16.',
      traces: [],
      stateLines: [
        'Paso 3 de 5 — enviar datos de pago.',
        'Cita apartada: mié 8 jul, 16:30 — pendiente de confirmar.',
      ],
    })
    expect(v.ok).toBe(false)
    expect(v.categories).toContain('precio')

    const v2 = validateClinicalReply({
      text: 'Son 350 pesos.',
      traces: [],
      stateLines: ['Paso 350 del flujo, duración 350 minutos.'],
    })
    expect(v2.ok).toBe(false)
    expect(v2.categories).toContain('precio')
  })
})

describe('validateClinicalReply — horarios', () => {
  it('bloquea horarios ofrecidos sin consultar disponibilidad', () => {
    const v = validateClinicalReply({
      text: 'Tengo lugar mañana a las 10:30 o a las 4 pm, cuál te queda?',
      traces: [],
      stateLines: [],
    })
    expect(v.ok).toBe(false)
    expect(v.reasons.some((r) => r.includes('horarios'))).toBe(true)
  })

  it('permite los horarios que consultar_disponibilidad DEVOLVIÓ (tolerante 12h/24h)', () => {
    const v = validateClinicalReply({
      text: 'Tengo 10:30 por la mañana o 16:30 por la tarde.',
      traces: [
        trace('consultar_disponibilidad', {
          content:
            '{"huecos":[{"inicio":"2026-07-08T15:30:00.000Z","etiqueta":"miércoles 8 de julio, 10:30 a.m."},{"inicio":"2026-07-08T21:30:00.000Z","etiqueta":"miércoles 8 de julio, 4:30 p.m."}]}',
        }),
      ],
      stateLines: [],
    })
    expect(v.ok).toBe(true)
  })

  it('bloquea un horario que la tool NO devolvió, aunque consultar_disponibilidad haya corrido', () => {
    const v = validateClinicalReply({
      text: 'Te espero mañana a las 4 pm.',
      traces: [
        trace('consultar_disponibilidad', {
          content: '{"huecos":[{"etiqueta":"miércoles 8 de julio, 10:30 a.m."}]}',
        }),
      ],
      stateLines: [],
    })
    expect(v.ok).toBe(false)
    expect(v.categories).toContain('horario')
  })

  it('la hora UTC de los timestamps ISO del tool result NO respalda una hora local', () => {
    // "T21:30Z" es 15:30 local — el 21:30 crudo del ISO no debe
    // "autorizar" que Sofía ofrezca las 9:30 pm.
    const v = validateClinicalReply({
      text: 'Tengo lugar a las 21:30.',
      traces: [
        trace('consultar_disponibilidad', {
          content:
            '{"huecos":[{"inicio":"2026-07-08T21:30:00.000Z","etiqueta":"miércoles 8 de julio, 4:30 p.m."}]}',
        }),
      ],
      stateLines: [],
    })
    expect(v.ok).toBe(false)
    expect(v.categories).toContain('horario')
  })

  it('permite recordar la hora de la cita que YA está en el snapshot', () => {
    const v = validateClinicalReply({
      text: 'Tu cita quedó apartada para el miércoles a las 16:30.',
      traces: [],
      stateLines: ['Cita apartada: mié 8 jul, 16:30 — pendiente de confirmar, anticipo pendiente.'],
    })
    expect(v.ok).toBe(true)
  })
})

describe('validateClinicalReply — confirmaciones prohibidas', () => {
  it('bloquea "tu pago quedó confirmado" incluso tras prevalidar_anticipo', () => {
    const v = validateClinicalReply({
      text: 'Listo, tu pago quedó confirmado y tu cita agendada!',
      traces: [trace('prevalidar_anticipo')],
      stateLines: [],
    })
    expect(v.ok).toBe(false)
    expect(v.reasons.some((r) => r.includes('pago'))).toBe(true)
  })

  it('bloquea "tu cita quedó confirmada" cuando la BD dice pendiente', () => {
    const v = validateClinicalReply({
      text: 'Tu cita ya quedó confirmada, te esperamos!',
      traces: [trace('agendar_cita')],
      stateLines: ['Cita apartada: mié 8 jul, 16:30 — pendiente de confirmar, anticipo pendiente.'],
    })
    expect(v.ok).toBe(false)
  })

  it('bloquea las confirmaciones INVERTIDAS de pago (participio antes del sustantivo)', () => {
    for (const text of [
      'Listo! Ya quedó confirmado tu pago.',
      'Ya quedó validado el anticipo, te esperamos.',
      'Quedó registrada tu transferencia.',
    ]) {
      const v = validateClinicalReply({ text, traces: [], stateLines: [] })
      expect(v.ok, text).toBe(false)
      expect(v.categories, text).toContain('pago_confirmado')
    }
  })

  it('bloquea las confirmaciones INVERTIDAS de cita y el "ya está en firme"', () => {
    for (const text of [
      'Ya quedó confirmada tu cita, te esperamos!',
      'Tu cita ya está en firme.',
    ]) {
      const v = validateClinicalReply({ text, traces: [], stateLines: [] })
      expect(v.ok, text).toBe(false)
      expect(v.categories, text).toContain('cita_confirmada')
    }
  })

  it('la confirmación invertida NO cruza cláusulas ("está confirmada; sobre tu anticipo…")', () => {
    // La cita SÍ está confirmada en BD; el anticipo sigue en revisión.
    // Un gap libre entre participio y sustantivo bloquearía este fraseo
    // legítimo al "unir" confirmada + anticipo.
    const v = validateClinicalReply({
      text: 'Tu cita está confirmada. Sobre tu anticipo, sigue en revisión del equipo.',
      traces: [],
      stateLines: ['Cita: mié 8 jul — confirmada.'],
    })
    expect(v.ok).toBe(true)
  })

  it('permite el fraseo correcto: "quedó EN REVISIÓN" y "en cuanto quede confirmado"', () => {
    const v = validateClinicalReply({
      text: 'Recibí tu comprobante y quedó en revisión del equipo. Te aviso por aquí en cuanto quede confirmado!',
      traces: [trace('prevalidar_anticipo')],
      stateLines: [],
    })
    expect(v.ok).toBe(true)
  })

  it('permite afirmar la confirmación cuando la BD la respalda', () => {
    const v = validateClinicalReply({
      text: 'Sí, tu cita está confirmada y tu anticipo quedó pagado.',
      traces: [trace('consultar_mis_citas')],
      stateLines: ['Cita apartada: mié 8 jul, 16:30 — confirmada, anticipo pagado.'],
    })
    expect(v.ok).toBe(true)
  })
})

// El fallback de contención reemplaza a la respuesta bloqueada para
// que el paciente no quede en visto. Se elige por categoría del
// bloqueo y, por construcción, ningún fallback puede disparar el
// propio guardrail.
describe('buildClinicalFallbackReply — fallback seguro por categoría', () => {
  it('pago bloqueado → contención de "lo revisa el equipo y te confirmamos"', () => {
    const v = validateClinicalReply({
      text: 'Listo, tu pago quedó confirmado!',
      traces: [],
      stateLines: [],
    })
    expect(v.ok).toBe(false)
    expect(v.categories).toContain('pago_confirmado')
    expect(buildClinicalFallbackReply(v)).toBe(
      'Gracias, recibí tu mensaje. Lo revisa el equipo y te confirmamos por aquí en cuanto quede validado.',
    )
  })

  it('precio bloqueado → contención de "la información correcta"', () => {
    const v = validateClinicalReply({
      text: 'La limpieza cuesta $800.',
      traces: [],
      stateLines: [],
    })
    expect(v.categories).toContain('precio')
    expect(buildClinicalFallbackReply(v)).toBe(
      'Gracias por escribirme. Déjame revisarlo con el equipo para darte la información correcta por aquí.',
    )
  })

  it('horario bloqueado → contención honesta de agenda (sin "voy a revisar")', () => {
    // El texto viejo ("voy a revisar la agenda") se contradecía cuando
    // el agente acababa de ofrecer la agenda (caso Acerotech) — el
    // nuevo dice qué pasó (no se apartó) y qué sigue (el equipo, que
    // ya recibió el aviso).
    const v = validateClinicalReply({
      text: 'Tengo lugar mañana a las 10:30, te queda?',
      traces: [],
      stateLines: [],
    })
    expect(v.categories).toContain('horario')
    const fallback = buildClinicalFallbackReply(v)
    expect(fallback).toBe(
      'Se me complicó apartar ese horario en el sistema ahora mismo. Ya le avisé al equipo para que lo aparte y te confirme por aquí — no necesitas hacer nada más.',
    )
    expect(fallback).not.toContain('voy a revisar')
  })

  it('cita confirmada sin respaldo → contención de confirmación (no de apartado)', () => {
    // Distinto del bloqueo de horario: aquí la cita puede existir como
    // pendiente y lo inventado fue la CONFIRMACIÓN — decir "no pude
    // apartar tu cita" sería falso y alarmante.
    const v = validateClinicalReply({
      text: 'Tu cita ya quedó confirmada, te esperamos!',
      traces: [],
      stateLines: [],
    })
    expect(v.categories).toContain('cita_confirmada')
    expect(buildClinicalFallbackReply(v)).toBe(
      'La confirmación final de tu cita te la da el equipo por aquí en cuanto la revise — ya les avisé para que no se les pase.',
    )
  })

  it('horario + cita confirmada a la vez → gana la contención de agenda', () => {
    // "Tu cita quedó confirmada el jueves a las 4" sin respaldo: lo más
    // probable es que el paciente estaba aceptando un horario que no se
    // apartó — el fallback de apartado es el accionable.
    const v = validateClinicalReply({
      text: 'Tu cita quedó confirmada, te esperamos a las 4:30 pm.',
      traces: [],
      stateLines: [],
    })
    expect(v.categories).toEqual(
      expect.arrayContaining(['horario', 'cita_confirmada']),
    )
    expect(buildClinicalFallbackReply(v)).toContain('apartar ese horario')
  })

  it('pago gana la prioridad cuando hay varias categorías a la vez', () => {
    const v = validateClinicalReply({
      text: 'Tu pago quedó confirmado, son $800 y te espero a las 10:30.',
      traces: [],
      stateLines: [],
    })
    expect(v.categories).toEqual(
      expect.arrayContaining(['precio', 'horario', 'pago_confirmado']),
    )
    expect(buildClinicalFallbackReply(v)).toContain('quede validado')
  })

  it('verdict sin categorías (p. ej. de un mock viejo) → genérico', () => {
    expect(buildClinicalFallbackReply({ ok: false, reasons: ['motivo raro'] })).toBe(
      'Gracias por escribirme. Lo reviso con el equipo para darte una respuesta correcta por aquí.',
    )
  })

  it('NINGÚN fallback dispara el propio guardrail (sin tools ni snapshot)', () => {
    const verdicts = [
      { ok: false, reasons: [], categories: ['pago_confirmado' as const] },
      { ok: false, reasons: [], categories: ['cita_confirmada' as const] },
      { ok: false, reasons: [], categories: ['horario' as const] },
      { ok: false, reasons: [], categories: ['precio' as const] },
      { ok: false, reasons: [] },
    ]
    for (const verdict of verdicts) {
      const fallback = buildClinicalFallbackReply(verdict)
      const recheck = validateClinicalReply({
        text: fallback,
        traces: [],
        stateLines: [],
      })
      expect(recheck.ok).toBe(true)
      expect(recheck.reasons).toEqual([])
    }
  })
})

// La nota de auto-corrección: se anexa al hilo (solo para el modelo)
// cuando el guardrail bloquea, antes de rendirse al fallback. Debe
// decirle QUÉ se bloqueó, POR QUÉ y qué tool llamar para respaldarlo —
// el caso Acerotech: el paciente aceptó un horario, el modelo narró el
// cierre sin llamar agendar_cita y la conversación murió en bucle.
describe('buildGuardrailRepairNote — nota de la ronda de corrección', () => {
  it('horario bloqueado → la nota manda llamar agendar_cita con el horario aceptado', () => {
    const v = validateClinicalReply({
      text: 'Listo, te agendo mañana a las 4:00 p.m.',
      traces: [],
      stateLines: [],
    })
    expect(v.ok).toBe(false)
    const note = buildGuardrailRepairNote(v, 'Listo, te agendo mañana a las 4:00 p.m.')
    expect(note).toContain('agendar_cita AHORA MISMO')
    expect(note).toContain('si hay antes, mejor') // aceptación condicionada
    expect(note).toContain('No prometas "revisar la agenda"')
  })

  it('incluye el borrador bloqueado y los motivos (el modelo necesita ver qué corregir)', () => {
    const v = validateClinicalReply({
      text: 'Te espero a las 10:30 y son $800.',
      traces: [],
      stateLines: [],
    })
    const note = buildGuardrailRepairNote(v, 'Te espero a las 10:30 y son $800.')
    expect(note).toContain('«Te espero a las 10:30 y son $800.»')
    for (const reason of v.reasons) expect(note).toContain(reason)
    // Ambas categorías traen su instrucción.
    expect(note).toContain('consultar_catalogo')
    expect(note).toContain('agendar_cita')
  })

  it('pago confirmado inventado → la nota exige el lenguaje de EN REVISIÓN', () => {
    const v = validateClinicalReply({
      text: 'Tu pago quedó confirmado!',
      traces: [],
      stateLines: [],
    })
    const note = buildGuardrailRepairNote(v, 'Tu pago quedó confirmado!')
    expect(note).toContain('EN REVISIÓN')
  })

  it('verdict sin categorías (mock viejo) → instrucción genérica, sin crashear', () => {
    const note = buildGuardrailRepairNote(
      { ok: false, reasons: ['motivo raro'] },
      'texto bloqueado',
    )
    expect(note).toContain('motivo raro')
    expect(note).toContain('reescríbela')
  })

  it('la nota deja claro que el paciente ni la escribió ni recibió nada', () => {
    const v = validateClinicalReply({
      text: 'Nos vemos a las 5 pm',
      traces: [],
      stateLines: [],
    })
    const note = buildGuardrailRepairNote(v, 'Nos vemos a las 5 pm')
    expect(note).toContain('el paciente NO escribió esto')
    expect(note).toContain('NO se envió')
    expect(note).toContain('No menciones esta nota')
  })
})

describe('validateClinicalReply — casos neutros', () => {
  it('permite una respuesta normal sin datos sensibles y sin tools', () => {
    const v = validateClinicalReply({
      text: 'Claro! Con gusto te ayudo. Me compartes tu nombre completo?',
      traces: [],
      stateLines: [],
    })
    expect(v.ok).toBe(true)
    expect(v.reasons).toEqual([])
  })

  it('texto vacío pasa (el caller ya lo trata como no-op)', () => {
    const v = validateClinicalReply({ text: '', traces: [], stateLines: [] })
    expect(v.ok).toBe(true)
  })
})
