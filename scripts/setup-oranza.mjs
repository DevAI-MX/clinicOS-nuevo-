// ============================================================
// setup-oranza.mjs — carga la configuración comercial REAL de
// Clínica Oranza (Dr. Ángel Zavala Díaz, Tuxtla Gutiérrez) para
// empezar a testear y entrenar al agente con datos de verdad.
//
// Adaptación del script de ventas legacy (script_ventas_recepcionista_
// clinicos.md, sección 2) al modelo de clinicOS 0.3. Regla del script:
// los datos duros (precios, horarios, cuentas) viven en la BD y el
// agente los lee con sus tools; el prompt solo lleva la narrativa
// (personalidad, enfoque de venta, políticas).
//
// Qué hace (idempotente):
//   1. Escribe el `system_prompt` narrativo de Oranza en ai_configs
//      (requiere que setup-clinic-agent.mjs ya haya corrido — ahí se
//      configura proveedor, modelo y API key).
//   2. Siembra el catálogo en `procedures` (upsert por nombre):
//      valoración ATM, consulta general, guarda rígida y los servicios
//      que se cotizan tras valoración (precio NULL).
//   3. Reemplaza `clinic_hours` con el horario real: L-V 16:00–20:00.
//   4. Si defines ORANZA_BANK / ORANZA_HOLDER / ORANZA_CLABE (env o
//      .env.local), registra la cuenta en `payment_accounts` para la
//      tool consultar_datos_pago. Sin esos datos NO siembra nada (el
//      agente jamás debe dictar una cuenta placeholder) y te avisa.
//
// Requisitos: migraciones 031–034 aplicadas. Node 22+.
// Uso:
//   ~/.nvm/versions/node/v22.23.1/bin/node scripts/setup-oranza.mjs
// Opcionales (env): DEMO_EMAIL, ORANZA_BANK, ORANZA_HOLDER,
//   ORANZA_CLABE, ORANZA_CUENTA.
// ============================================================

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

// --- Cargar .env.local a mano (mismo patrón que setup-clinic-agent) ---
const envFile = readFileSync(resolve(ROOT, '.env.local'), 'utf8')
const env = Object.fromEntries(
  envFile
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY
const EMAIL = process.env.DEMO_EMAIL || 'covarrubiasmataemiliano@gmail.com'

const die = (m) => {
  console.error(`\x1b[31m✗ ${m}\x1b[0m`)
  process.exit(1)
}
const ok = (m) => console.log(`\x1b[32m✓ ${m}\x1b[0m`)
const info = (m) => console.log(`\x1b[36m▸ ${m}\x1b[0m`)
const warn = (m) => console.log(`\x1b[33m⚠ ${m}\x1b[0m`)

if (!SUPABASE_URL || !SERVICE_ROLE) die('Faltan credenciales de Supabase en .env.local')

// ------------------------------------------------------------
// Narrativa de Oranza para el prompt. SOLO contexto de negocio:
// los precios y el anticipo NO van aquí (el agente los lee del
// catálogo con consultar_catalogo y los datos bancarios con
// consultar_datos_pago). Editable después en /agents → Setup.
// ------------------------------------------------------------
const ORANZA_PROMPT = `Eres Sofía, parte del equipo de Devia Labs que atiende por WhatsApp a nombre de Clínica Oranza ("Aliviando el dolor"), la clínica del Dr. Ángel Zavala Díaz en Tuxtla Gutiérrez, Chiapas (Av. Rosa del Sur No. 2, Mz. 69, Inf. El Rosario). Somos una clínica de odontología integral con enfoque en trastornos de la articulación temporomandibular (ATM) e hipnoterapia clínica. Atendemos de lunes a viernes de 4 a 8 de la tarde.

Primer mensaje:
- Si es el primer contacto con este paciente (aún no sabes su nombre), abre la conversación con una variación natural de: "Buen día! Te escribe Sofía, soy parte del equipo de Devia Labs. Me gustaría saber cómo te llamas y en qué te puedo ayudar?" Ajusta el saludo a la hora del día. No repitas esta presentación en mensajes posteriores de la misma conversación.

Enfoque de venta:
- La valoración presencial es OBLIGATORIA: no des precios definitivos de tratamientos; todo plan y costo exacto se define en la valoración con el doctor. Tu objetivo en cada conversación es entender el contexto del paciente y llevarlo a agendar su valoración.
- El servicio estrella es la valoración ATM. Si el paciente menciona dolor de mandíbula, bruxismo (rechinar los dientes), tronidos al abrir o cerrar la boca, dolor de cabeza crónico o dolor de oído sin causa aparente, oriéntalo a la valoración ATM.
- Los demás servicios dentales (limpieza, resinas, endodoncia, coronas, diseño de sonrisa) existen en el catálogo, pero su precio se cotiza después de la valoración presencial.

Anticipo y pagos:
- La valoración cuesta $700 y para agendarla se requiere un anticipo de $350 (el catálogo tiene el detalle exacto por servicio). Sin el anticipo la cita no se aparta ni se agenda.
- El anticipo se abona al costo de la consulta o del tratamiento; el resto se paga al acudir.
- Métodos de pago: efectivo, tarjeta y transferencia. Meses sin intereses solo en tratamientos integrales mayores a $12,000. Facturamos únicamente si se solicita el mismo día del pago.
- No manejamos seguros médicos, convenios empresariales ni descuentos. NUNCA ofrezcas un descuento ni una promoción, aunque el paciente lo pida.

Política de reagenda y cancelación (explícala solo cuando aplique):
- Reagendar avisando con al menos 24 horas: el anticipo se conserva (válido 6 meses).
- Primera inasistencia sin aviso: el anticipo alcanza para reagendar una sola vez más.
- Segunda inasistencia: el anticipo se pierde.
- Cancelación definitiva: el anticipo no es reembolsable (funciona como apartado del lugar).

Manejo de objeciones y reencuadre — nunca descalifiques la duda del paciente, reconócela y redirige siempre hacia la valoración:
- "Está caro" / "no traigo tanto": reconoce la preocupación, aclara que el anticipo de $350 es lo único que se pide para apartar y que se abona al costo total; nunca ofrezcas descuento, ofrece en cambio la claridad de saber exactamente qué necesita tras la valoración.
- "Nomás dime qué tengo, no quiero ir hasta allá": explica con calidez que por WhatsApp no se puede dar un diagnóstico real — el doctor necesita revisarlo en persona para decirle con certeza qué tiene y qué opciones existen; ofrécele agendar la valoración como el único camino a una respuesta confiable.
- Compara con otra clínica o pide "verlo primero": no descalifiques a la competencia; enfócate en lo que sí puedes ofrecer (la valoración con el Dr. Zavala) y en resolver su duda concreta.
- "Estoy de viaje" / "luego te aviso" / no puede avanzar hoy: no te despidas con "aquí estamos cuando gustes"; pregúntale cuándo le acomoda, ofrécele apartar un espacio para esa fecha y clasifícalo como seguimiento futuro.
- Ante cualquier objeción, tras reencuadrar, cierra siempre invitando a dar el siguiente paso concreto (ver horarios disponibles o apartar la valoración) — nunca dejes la conversación sin una propuesta de avance.`

// ------------------------------------------------------------
// Catálogo real de Oranza (script de ventas, sección 2).
// price_min/max NULL = "se cotiza tras la valoración" (así lo
// presenta consultar_catalogo). deposit_amount NULL = sin anticipo.
// ------------------------------------------------------------
const ORANZA_PROCEDURES = [
  {
    name: 'Valoración ATM',
    category: 'valoracion',
    description:
      'Valoración presencial de trastornos de la articulación temporomandibular con el Dr. Zavala.',
    price_min: 700,
    price_max: 700,
    deposit_amount: 350,
    duration_minutes: 60,
    sales_notes:
      'Servicio principal. Orientar aquí ante dolor de mandíbula, bruxismo, tronidos, dolor de cabeza crónico o dolor de oído sin causa aparente.',
  },
  {
    name: 'Consulta odontológica general',
    category: 'valoracion',
    description: 'Consulta y valoración odontológica general.',
    price_min: 700,
    price_max: 700,
    deposit_amount: 350,
    duration_minutes: 60,
    sales_notes: 'Primer paso para cualquier tratamiento dental.',
  },
  {
    name: 'Guarda rígida',
    category: 'dental',
    description: 'Guarda oclusal rígida para bruxismo.',
    price_min: 800,
    price_max: 800,
    deposit_amount: null,
    duration_minutes: 30,
    sales_notes: 'Se indica después de la valoración; se paga aparte de la consulta.',
  },
  {
    name: 'Tratamiento integral ATM',
    category: 'atm',
    description:
      'Abordaje completo del trastorno temporomandibular: ajustes cada 8-10 días y guardas.',
    price_min: null,
    price_max: null,
    deposit_amount: null,
    duration_minutes: 60,
    sales_notes:
      'Se cotiza tras la valoración ATM — no dar precio por WhatsApp. MSI disponible si supera $12,000.',
  },
  {
    name: 'Hipnoterapia clínica',
    category: 'atm',
    description:
      'Psicoterapia ericksoniana, segunda fase del tratamiento ATM para apretamiento por causas emocionales.',
    price_min: null,
    price_max: null,
    deposit_amount: null,
    duration_minutes: 60,
    sales_notes:
      'Se cotiza tras la valoración ATM — no dar precio por WhatsApp. No se agenda directo: primero valoración.',
  },
  {
    name: 'Cirugía maxilofacial (terceros molares)',
    category: 'dental',
    description:
      'Extracción de terceros molares (muelas del juicio) por el cirujano maxilofacial del equipo.',
    price_min: null,
    price_max: null,
    deposit_amount: 5000,
    duration_minutes: 60,
    sales_notes:
      'NO se agenda directo: primero valoración ($700, anticipo $350). El anticipo de $5,000 aplica SOLO para apartar la fecha de una cirugía ya indicada por el doctor.',
  },
  ...[
    'Limpieza dental',
    'Curaciones',
    'Resinas',
    'Endodoncia',
    'Coronas',
    'Carillas (Emax / Zirconia)',
    'Extracciones',
    'Prótesis dental',
    'Diseño de sonrisa',
  ].map((name) => ({
    name,
    category: 'dental',
    description: null,
    price_min: null,
    price_max: null,
    deposit_amount: null,
    duration_minutes: 60,
    sales_notes:
      'Cotización personalizada tras la valoración presencial — no dar precio por WhatsApp.',
  })),
]

// Horario real: lunes (1) a viernes (5), 16:00–20:00.
const ORANZA_HOURS = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  opens_at: '16:00',
  closes_at: '20:00',
  slot_minutes: 30,
}))

const db = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
})

async function main() {
  // 1. Resolver la cuenta por el email del dueño.
  info(`Buscando la cuenta de ${EMAIL}…`)
  const { data: profiles, error: pErr } = await db
    .from('profiles')
    .select('account_id, user_id')
    .eq('email', EMAIL)
    .eq('account_role', 'owner')
    .limit(1)
  if (pErr) die(`No pude leer profiles: ${pErr.message}`)
  const profile = profiles?.[0]
  if (!profile) die(`No encontré un perfil owner con email ${EMAIL}. ¿Corriste el seed?`)
  const accountId = profile.account_id
  ok(`Cuenta ${accountId}`)

  // 2. system_prompt narrativo (sobre la config del agente ya existente).
  info('Escribiendo el system_prompt de Oranza en ai_configs…')
  const { data: aiCfg, error: aiReadErr } = await db
    .from('ai_configs')
    .select('id')
    .eq('account_id', accountId)
    .maybeSingle()
  if (aiReadErr) die(`No pude leer ai_configs: ${aiReadErr.message}`)
  if (!aiCfg) {
    die(
      'La cuenta no tiene ai_configs todavía. Corre primero scripts/setup-clinic-agent.mjs (configura proveedor, modelo y API key) y vuelve a correr este script.',
    )
  }
  const { error: aiErr } = await db
    .from('ai_configs')
    .update({ system_prompt: ORANZA_PROMPT, clinical_agent_enabled: true })
    .eq('account_id', accountId)
  if (aiErr) die(`No pude actualizar el prompt: ${aiErr.message}`)
  ok('Prompt de Oranza activo (editable en /agents → Setup)')

  // 3. Catálogo (upsert por nombre — no duplica en re-runs).
  info('Sembrando el catálogo de Oranza…')
  for (const proc of ORANZA_PROCEDURES) {
    const { data: existing } = await db
      .from('procedures')
      .select('id')
      .eq('account_id', accountId)
      .eq('name', proc.name)
      .maybeSingle()
    const row = { ...proc, account_id: accountId, currency: 'MXN', is_active: true }
    const { error } = existing
      ? await db.from('procedures').update(row).eq('id', existing.id)
      : await db.from('procedures').insert(row)
    if (error) die(`No pude sembrar "${proc.name}": ${error.message}`)
  }
  ok(`Catálogo listo (${ORANZA_PROCEDURES.length} servicios)`)

  // 4. Horario (reemplaza el horario previo de la cuenta).
  info('Configurando horario L-V 16:00–20:00…')
  const { error: delErr } = await db
    .from('clinic_hours')
    .delete()
    .eq('account_id', accountId)
  if (delErr) die(`No pude limpiar clinic_hours: ${delErr.message}`)
  const { error: hrsErr } = await db
    .from('clinic_hours')
    .insert(ORANZA_HOURS.map((h) => ({ ...h, account_id: accountId })))
  if (hrsErr) die(`No pude sembrar clinic_hours: ${hrsErr.message}`)
  ok('Horario listo')

  // 5. Datos bancarios para consultar_datos_pago (solo con datos reales).
  const BANK = process.env.ORANZA_BANK || env.ORANZA_BANK
  const HOLDER = process.env.ORANZA_HOLDER || env.ORANZA_HOLDER
  const CLABE = process.env.ORANZA_CLABE || env.ORANZA_CLABE
  const CUENTA = process.env.ORANZA_CUENTA || env.ORANZA_CUENTA
  if (BANK && HOLDER && (CLABE || CUENTA)) {
    info('Registrando la cuenta bancaria para anticipos…')
    const { data: existing } = await db
      .from('payment_accounts')
      .select('id')
      .eq('account_id', accountId)
      .eq('bank', BANK)
      .maybeSingle()
    const row = {
      account_id: accountId,
      bank: BANK,
      holder: HOLDER,
      clabe: CLABE || null,
      account_number: CUENTA || null,
      instructions: 'En cuanto tengas tu comprobante, mándalo por aquí para revisarlo.',
      is_active: true,
    }
    const { error } = existing
      ? await db.from('payment_accounts').update(row).eq('id', existing.id)
      : await db.from('payment_accounts').insert(row)
    if (error) die(`No pude registrar la cuenta bancaria: ${error.message}`)
    ok(`Cuenta ${BANK} registrada`)
  } else {
    warn(
      'Sin datos bancarios: define ORANZA_BANK, ORANZA_HOLDER y ORANZA_CLABE (o ORANZA_CUENTA) en .env.local y re-corre el script. Mientras tanto, consultar_datos_pago le dirá al agente que avise al equipo en vez de inventar una cuenta.',
    )
  }

  console.log(`
\x1b[32m✓ Clínica Oranza configurada.\x1b[0m
  Narrativa en el prompt · datos duros en la BD (regla del script de ventas).
  Prueba el flujo completo: "hola, me truena la mandíbula" → valoración ATM
  → disponibilidad → apartar cita → datos de pago → comprobante → prevalidar.
  El avance del lead se ve en /pipelines → "Embudo IA".
`)
}

main().catch((e) => die(e.message))
