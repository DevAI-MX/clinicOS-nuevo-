// ============================================================
// clinicOS — guardrails deterministas de la respuesta de Sofía.
//
// Último candado antes de enviar al paciente (auto-reply.ts): valida
// SIN otra llamada al modelo que la respuesta final esté respaldada
// por hechos del turno — las tools que de verdad corrieron (traces del
// loop) o el snapshot de BD del prompt. Nació del incidente Acerotech:
// el modelo "narraba" precios, horarios y confirmaciones que ninguna
// herramienta le dio.
//
// Reglas (evidencia LITERAL, no "corrió la tool correcta"):
//   1. Precios/montos → cada monto de la respuesta debe aparecer como
//      patrón monetario real ($350 · 350 pesos · 350 MXN) en el
//      content de alguna tool exitosa del turno o en el snapshot de
//      BD. Que consultar_catalogo haya corrido NO autoriza cualquier
//      cifra: solo las que la tool devolvió. Los números sueltos del
//      snapshot (pasos, fechas, duraciones) no cuentan como montos.
//   2. Horarios ofrecidos → cada hora concreta de la respuesta debe
//      aparecer en el content de una tool exitosa o en el snapshot
//      (comparación por hora del día, tolerante a 16:30 ↔ 4:30 p.m.).
//      Haber corrido consultar_disponibilidad no basta.
//   3. Confirmaciones prohibidas ("tu pago quedó confirmado", "ya
//      quedó confirmada tu cita", "tu cita ya está en firme") →
//      bloqueadas salvo que la BD diga que ese estado ES real (cita
//      confirmada / anticipo pagado). La regla de oro: Sofía solo
//      prevalida; confirma el equipo.
//
// Si bloquea, el caller NO envía y avisa al equipo — nunca silencio.
// ============================================================

import type { ToolTrace } from './tools'

export interface ClinicalReplyGuardArgs {
  /** Respuesta final del modelo (lo que saldría por WhatsApp). */
  text: string
  /** Tools ejecutadas en el turno (RunClinicalAgentResult.traces). */
  traces: ToolTrace[]
  /** Snapshot de BD inyectado al prompt (stateLines + flowLines). */
  stateLines: string[]
}

/** Qué regla bloqueó — decide qué fallback de contención se manda. */
export type GuardrailBlockCategory =
  | 'precio'
  | 'horario'
  | 'pago_confirmado'
  | 'cita_confirmada'

export interface GuardrailVerdict {
  ok: boolean
  /** Motivos de bloqueo, legibles (sin PII) — van al aviso del equipo. */
  reasons: string[]
  /** Paralelo a `reasons` — lo consume buildClinicalFallbackReply. */
  categories?: GuardrailBlockCategory[]
}

// "$350", "$1,500.50", "350 pesos", "350 mxn" — SOLO patrones
// monetarios explícitos; un número suelto nunca cuenta como monto.
const MONEY_RE = /\$\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:pesos|mxn)\b/gi

// Horas concretas: "10:30", "4 pm", "11:00 a.m." (formato de
// formatSlotLabel es-MX). Un número suelto ("a las 4") no matchea —
// mismo criterio conservador de siempre.
const TIME_TOKEN_RE =
  /\b(\d{1,2}):(\d{2})(?:\s?([ap])\.?\s?m\b\.?)?|\b(\d{1,2})\s?([ap])\.?\s?m\b\.?/gi

// Timestamps ISO dentro de los tool results ("2026-07-08T16:30:00Z"):
// van en UTC, no en hora local de la clínica — se eliminan ANTES de
// extraer horarios permitidos para que una hora UTC no "autorice" una
// hora local que nadie ofreció.
const ISO_DATETIME_RE =
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g

// Afirmaciones de confirmación consumada (pasado/presente). El fraseo
// permitido ("en cuanto QUEDE confirmado", "quedó EN REVISIÓN") no
// matchea: exige el participio de confirmación justo después del verbo.
const PAGO_CONFIRMADO_RE =
  /\b(?:pago|anticipo|transferencia|dep[oó]sito)\b[^.!?\n]{0,60}\b(?:ya\s+)?(?:qued[oó]|quedaron|est[aá]n?|fue(?:ron)?|han?\s+sido)\s+(?:confirmad|acreditad|validad|registrad|pagad)/i
const CITA_CONFIRMADA_RE =
  /\bcita\b[^.!?\n]{0,60}\b(?:ya\s+)?(?:qued[oó]|quedaron|est[aá]n?|fue(?:ron)?|han?\s+sido)\s+(?:confirmad|agendad[ao]s?\s+en\s+firme|en\s+firme)/i
const YA_QUEDO_PAGADO_RE = /\bya\s+qued[oó]\s+(?:pagad|validad|acreditad)/i
// Orden invertido: participio ANTES del sustantivo ("ya quedó
// confirmado tu pago", "ya quedó validado el anticipo", "ya quedó
// confirmada tu cita"). Entre participio y sustantivo solo se admite
// un artículo/posesivo — un gap libre cruzaría cláusulas y bloquearía
// fraseos legítimos ("está confirmada; sobre tu anticipo…"). Captura
// el sustantivo para elegir categoría.
const CONFIRMACION_INVERTIDA_RE =
  /\b(?:ya\s+)?(?:qued[oó]|quedaron|est[aá]n?|fue(?:ron)?|han?\s+sido)\s+(?:confirmad|acreditad|validad|registrad|pagad)[oa]s?\s+(?:(?:el|la|los|las|tu|tus|su|sus|este|esta|ese|esa)\s+)?(pago|anticipo|transferencia|dep[oó]sito|cita)s?\b/i

/** "$1,500.00" / "1,500 pesos" → "1500" (forma canónica del monto). */
function canonicalAmount(raw: string): string | null {
  const digits = raw.replace(/[^0-9.]/g, '')
  const value = Number.parseFloat(digits)
  return Number.isFinite(value) ? String(value) : null
}

/** Montos monetarios canónicos presentes en las fuentes de evidencia. */
function extractAmounts(sources: string[]): Set<string> {
  const amounts = new Set<string>()
  for (const src of sources) {
    for (const raw of src.match(MONEY_RE) ?? []) {
      const canonical = canonicalAmount(raw)
      if (canonical) amounts.add(canonical)
    }
  }
  return amounts
}

/**
 * Minutos-del-día que puede significar una mención de hora. Sin
 * meridiano y con hora ≤ 12 es ambigua ("4:30" puede ser 16:30): se
 * devuelven ambas lecturas y basta que UNA esté respaldada.
 */
function timeCandidates(hour: number, minute: number, meridiem: string | null): number[] {
  if (hour > 23 || minute > 59) return []
  if (meridiem === 'p') return [((hour % 12) + 12) * 60 + minute]
  if (meridiem === 'a') return [(hour % 12) * 60 + minute]
  const candidates = [hour * 60 + minute]
  if (hour >= 1 && hour < 12) candidates.push((hour + 12) * 60 + minute)
  return candidates
}

interface TimeMention {
  raw: string
  candidates: number[]
}

function extractTimeMentions(text: string): TimeMention[] {
  const mentions: TimeMention[] = []
  for (const m of text.matchAll(TIME_TOKEN_RE)) {
    const hour = Number(m[1] ?? m[4])
    const minute = Number(m[2] ?? '0')
    const meridiem = (m[3] ?? m[5])?.toLowerCase() ?? null
    const candidates = timeCandidates(hour, minute, meridiem)
    if (candidates.length > 0) mentions.push({ raw: m[0], candidates })
  }
  return mentions
}

/** Horas del día (en minutos) respaldadas por las fuentes de evidencia. */
function extractAllowedTimes(sources: string[]): Set<number> {
  const allowed = new Set<number>()
  for (const src of sources) {
    const cleaned = src.replace(ISO_DATETIME_RE, ' ')
    for (const mention of extractTimeMentions(cleaned)) {
      for (const c of mention.candidates) allowed.add(c)
    }
  }
  return allowed
}

/**
 * Valida la respuesta final del agente clínico. Determinista y barato:
 * regex + las trazas del turno. `ok: false` significa NO ENVIAR.
 */
export function validateClinicalReply(
  args: ClinicalReplyGuardArgs,
): GuardrailVerdict {
  const text = args.text ?? ''
  const reasons: string[] = []
  const categories: GuardrailBlockCategory[] = []
  if (!text.trim()) return { ok: true, reasons, categories }

  // Fuentes de evidencia del turno: lo que las tools DEVOLVIERON (una
  // tool fallida no respalda nada) + el snapshot de BD del prompt.
  const evidence = [
    ...args.traces.filter((t) => !t.isError).map((t) => t.content ?? ''),
    ...args.stateLines,
  ]
  const snapshot = args.stateLines.join('\n')

  // 1) Precios/montos: cada monto debe aparecer tal cual (como patrón
  // monetario) en la evidencia. No hay tool que "autorice" cifras.
  const allowedAmounts = extractAmounts(evidence)
  const unjustifiedAmounts = (text.match(MONEY_RE) ?? []).filter((raw) => {
    const canonical = canonicalAmount(raw)
    return canonical != null && !allowedAmounts.has(canonical)
  })
  if (unjustifiedAmounts.length > 0) {
    reasons.push(
      'menciona un precio o monto que no aparece en los resultados de sus herramientas ni en el estado real del paciente',
    )
    categories.push('precio')
  }

  // 2) Horarios ofrecidos: cada hora concreta debe estar en la
  // evidencia (por hora del día, tolerante a 12h/24h).
  const allowedTimes = extractAllowedTimes(evidence)
  const unjustifiedTimes = extractTimeMentions(text).filter(
    (mention) => !mention.candidates.some((c) => allowedTimes.has(c)),
  )
  if (unjustifiedTimes.length > 0) {
    reasons.push(
      'ofrece horarios concretos que no aparecen en la disponibilidad ni en la agenda real consultadas',
    )
    categories.push('horario')
  }

  // 3) Confirmaciones que solo el equipo puede dar. La BD puede
  // legitimarlas: cita realmente confirmada / anticipo realmente pagado.
  const citaConfirmadaEnBd = /\bconfirmada\b/.test(snapshot)
  const anticipoPagadoEnBd = /anticipo\s*:?\s*pagado/i.test(snapshot)
  const invertida = text.match(CONFIRMACION_INVERTIDA_RE)
  const invertidaDeCita = invertida?.[1]?.toLowerCase() === 'cita'
  if (
    !anticipoPagadoEnBd &&
    (PAGO_CONFIRMADO_RE.test(text) ||
      YA_QUEDO_PAGADO_RE.test(text) ||
      (invertida != null && !invertidaDeCita))
  ) {
    reasons.push(
      'afirma que un pago quedó confirmado o registrado — la validación de pagos la hace el equipo en el panel',
    )
    categories.push('pago_confirmado')
  }
  if (
    !citaConfirmadaEnBd &&
    (CITA_CONFIRMADA_RE.test(text) || (invertida != null && invertidaDeCita))
  ) {
    reasons.push(
      'afirma que la cita quedó confirmada — las citas las confirma el equipo en el panel',
    )
    categories.push('cita_confirmada')
  }

  return { ok: reasons.length === 0, reasons, categories }
}

// ------------------------------------------------------------
// Fallback seguro de contención.
//
// Cuando el guardrail bloquea, el paciente NO debe quedarse en visto
// (lección Acerotech aplicada al propio guardrail): en vez del texto
// inseguro se le manda UNA respuesta neutra que no confirma nada, no
// cotiza nada y no promete horarios — solo contiene la conversación y
// deja el caso en manos del equipo. Determinista a propósito: textos
// fijos por categoría, sin otra llamada al modelo, y todos pasan el
// propio validateClinicalReply (hay test que lo garantiza).
// ------------------------------------------------------------

const FALLBACK_PAGO =
  'Gracias, recibí tu mensaje. Lo revisa el equipo y te confirmamos por aquí en cuanto quede validado.'
// Honesto a propósito: si llegamos aquí es porque el agendado NO
// aterrizó (ni siquiera tras el reintento de corrección). El texto
// viejo ("voy a revisar la agenda") se contradecía cuando el propio
// agente acababa de ofrecer la agenda — caso Acerotech: el paciente
// contestó "qué tienes que revisar si me acabas de ofrecer el horario?"
// y recibió el mismo texto en bucle. Este no promete revisar nada:
// dice qué pasó y qué sigue (el equipo, que YA recibió el aviso).
const FALLBACK_AGENDA =
  'Se me complicó apartar ese horario en el sistema ahora mismo. Ya le avisé al equipo para que lo aparte y te confirme por aquí — no necesitas hacer nada más.'
const FALLBACK_CITA =
  'La confirmación final de tu cita te la da el equipo por aquí en cuanto la revise — ya les avisé para que no se les pase.'
const FALLBACK_PRECIO =
  'Gracias por escribirme. Déjame revisarlo con el equipo para darte la información correcta por aquí.'
const FALLBACK_GENERICO =
  'Gracias por escribirme. Lo reviso con el equipo para darte una respuesta correcta por aquí.'

/**
 * Respuesta neutra que reemplaza a una bloqueada por el guardrail.
 * Prioridad: pago (lo más delicado — el paciente suele estar esperando
 * la validación de su comprobante) → horario (el paciente estaba
 * aceptando una cita que no se apartó) → cita dada por confirmada →
 * precio → genérico.
 */
export function buildClinicalFallbackReply(verdict: GuardrailVerdict): string {
  const cats = new Set(verdict.categories ?? [])
  if (cats.has('pago_confirmado')) return FALLBACK_PAGO
  if (cats.has('horario')) return FALLBACK_AGENDA
  if (cats.has('cita_confirmada')) return FALLBACK_CITA
  if (cats.has('precio')) return FALLBACK_PRECIO
  return FALLBACK_GENERICO
}

// ------------------------------------------------------------
// Nota de auto-corrección (una sola ronda de reparación).
//
// Antes de rendirse al fallback, auto-reply.ts re-corre el agente UNA
// vez con esta nota al final del hilo: le dice qué borrador se bloqueó,
// por qué, y qué herramienta debe llamar para respaldarlo. El caso que
// la motivó (Acerotech, 2026-07-08): el paciente ACEPTÓ un horario, el
// modelo "narró" el cierre sin llamar agendar_cita, el guardrail lo
// bloqueó (correctamente) y la conversación murió en un bucle de
// contención. La nota convierte ese bloqueo en la señal que al modelo
// le faltaba para actuar. La respuesta reparada pasa por el MISMO
// guardrail — esto no debilita ningún candado.
// ------------------------------------------------------------

const REPAIR_INSTRUCTION: Record<GuardrailBlockCategory, string> = {
  precio:
    'Mencionaste un precio o monto que ninguna herramienta te devolvió: llama consultar_catalogo (o la herramienta del anticipo si se trata del anticipo) y usa SOLO las cifras que te devuelva; si no obtienes la cifra, no menciones cifras.',
  horario:
    'Mencionaste un horario que tus herramientas no respaldan EN ESTE turno. Si el paciente ya aceptó o propuso un horario en la conversación (aunque fuera con condiciones como "si hay antes, mejor"), llama agendar_cita AHORA MISMO con esa fecha y hora exactas — la herramienta valida el hueco sola y, si está ocupado, te devuelve alternativas reales para ofrecerle. Si todavía no hay horario acordado, llama consultar_disponibilidad y ofrece únicamente los huecos que devuelva. No prometas "revisar la agenda": la agenda la consultas tú con tus herramientas en este mismo turno.',
  pago_confirmado:
    'Afirmaste que un pago quedó confirmado o registrado, y eso solo lo confirma el equipo en el panel: di que quedó EN REVISIÓN y que le confirmas por aquí en cuanto el equipo lo valide.',
  cita_confirmada:
    'Diste una cita por confirmada: una cita solo queda APARTADA cuando agendar_cita corre con éxito en este turno, y CONFIRMADA únicamente cuando el equipo valida el anticipo en el panel. Ajusta lo que dices a lo que tus herramientas de verdad hicieron.',
}

const REPAIR_GENERIC =
  'Tu respuesta afirmaba algo que tus herramientas no respaldan: reescríbela usando únicamente lo que tus herramientas devuelvan en este turno.'

/**
 * Nota de sistema (rol user, como las notas de imagen/retome) que se
 * anexa al hilo para la ronda de reparación. Incluye el borrador
 * bloqueado — el modelo necesita ver QUÉ intentaba decir para
 * respaldarlo con la tool correcta — y la instrucción por categoría.
 * Solo la ve el modelo; jamás viaja al paciente ni a los avisos.
 */
export function buildGuardrailRepairNote(
  verdict: GuardrailVerdict,
  blockedText: string,
): string {
  const cats = [...new Set(verdict.categories ?? [])]
  const instructions =
    cats.length > 0 ? cats.map((c) => REPAIR_INSTRUCTION[c]) : [REPAIR_GENERIC]
  return `[Nota automática del sistema — el paciente NO escribió esto y NO ha recibido nada: tu respuesta anterior fue BLOQUEADA por las verificaciones de seguridad y NO se envió. Motivos: ${verdict.reasons.join('; ')}. Tu borrador bloqueado fue: «${blockedText}». Corrígelo así: ${instructions.join(' ')} Vuelve a responder al último mensaje del paciente en un solo mensaje, llamando AHORA las herramientas necesarias para respaldar cada dato que menciones. No menciones esta nota ni que hubo un error.]`
}
