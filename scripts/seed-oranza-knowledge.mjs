// ============================================================
// seed-oranza-knowledge.mjs — puebla la base de conocimiento (RAG)
// de Clínica Oranza con la información REAL proporcionada por el
// negocio (Clinica_Oranza.md, 2026-07). Complementa a
// setup-oranza.mjs: el catálogo/horarios/pagos viven en sus tablas
// y el agente los lee con tools; aquí va lo que las tools NO cubren
// (quiénes somos, credenciales del doctor, qué es la valoración ATM,
// hipnoterapia, ubicación exacta, políticas explicadas).
//
// Qué hace (idempotente — upsert por título, re-ingesta reemplaza
// los chunks del documento):
//   1. Si la cuenta no tiene embeddings_api_key y hay OPENAI_API_KEY
//      en .env.local, la registra cifrada (AES-256-GCM, mismo formato
//      que src/lib/whatsapp/encryption.ts) para activar la búsqueda
//      semántica del RAG.
//   2. Upsert de los documentos en ai_knowledge_documents.
//   3. Chunking + embeddings idénticos a la app (src/lib/ai/chunk.ts
//      y src/lib/ai/embeddings.ts: párrafos empacados a 1200 chars,
//      text-embedding-3-small 1536 dims) e inserta en
//      ai_knowledge_chunks. Sin OPENAI_API_KEY siembra sin vectores
//      (la búsqueda léxica FTS sigue funcionando) y avisa.
//
// Requisitos: migración 030 aplicada. Node 22+.
// Uso:
//   ~/.nvm/versions/node/v22.23.1/bin/node scripts/seed-oranza-knowledge.mjs
// Opcional (env): DEMO_EMAIL.
// ============================================================

import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

// --- Cargar .env.local a mano (mismo patrón que setup-oranza) ---
const envFile = readFileSync(resolve(ROOT, '.env.local'), 'utf8')
const env = Object.fromEntries(
  envFile
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY
const OPENAI_KEY = env.OPENAI_API_KEY || process.env.OPENAI_API_KEY
const ENCRYPTION_KEY = env.ENCRYPTION_KEY
const EMAIL = process.env.DEMO_EMAIL || 'covarrubiasmataemiliano@gmail.com'

const die = (m) => {
  console.error(`\x1b[31m✗ ${m}\x1b[0m`)
  process.exit(1)
}
const ok = (m) => console.log(`\x1b[32m✓ ${m}\x1b[0m`)
const info = (m) => console.log(`\x1b[36m▸ ${m}\x1b[0m`)
const warn = (m) => console.log(`\x1b[33m⚠ ${m}\x1b[0m`)

if (!SUPABASE_URL || !SERVICE_ROLE) die('Faltan credenciales de Supabase en .env.local')

// --- Cifrado GCM idéntico a src/lib/whatsapp/encryption.ts ---
function encrypt(text) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY, 'hex'), iv)
  let enc = cipher.update(text, 'utf8', 'hex')
  enc += cipher.final('hex')
  const tag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${enc}:${tag.toString('hex')}`
}

// --- Chunking idéntico a src/lib/ai/chunk.ts ---
const MAX_CHARS = 1200
function chunkText(content) {
  const text = content.replace(/\r\n/g, '\n').trim()
  if (!text) return []
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
  const chunks = []
  let current = ''
  const flush = () => {
    const trimmed = current.trim()
    if (trimmed) chunks.push(trimmed)
    current = ''
  }
  for (const para of paragraphs) {
    if (para.length > MAX_CHARS) {
      flush()
      for (let i = 0; i < para.length; i += MAX_CHARS) {
        const slice = para.slice(i, i + MAX_CHARS).trim()
        if (slice) chunks.push(slice)
      }
      continue
    }
    if (current && current.length + 2 + para.length > MAX_CHARS) flush()
    current = current ? `${current}\n\n${para}` : para
  }
  flush()
  return chunks
}

// --- Embeddings idénticos a src/lib/ai/embeddings.ts ---
const EMBEDDING_MODEL = 'text-embedding-3-small'
const BATCH_SIZE = 96
async function embedTexts(apiKey, inputs) {
  if (inputs.length === 0) return []
  const out = []
  for (let start = 0; start < inputs.length; start += BATCH_SIZE) {
    const batch = inputs.slice(start, start + BATCH_SIZE)
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: batch }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`OpenAI embeddings ${res.status}: ${body.slice(0, 300)}`)
    }
    const data = await res.json()
    const rows = data?.data
    if (!rows || rows.length !== batch.length) throw new Error('Respuesta de embeddings malformada')
    const ordered = [...rows].sort((a, b) => a.index - b.index)
    for (const r of ordered) {
      if (!Array.isArray(r.embedding)) throw new Error('Embedding faltante en la respuesta')
      out.push(r.embedding)
    }
  }
  return out
}
const toVectorLiteral = (e) => `[${e.join(',')}]`

// ------------------------------------------------------------
// Documentos de conocimiento de Oranza. Escritos por PÁRRAFOS
// autocontenidos (cada párrafo repite "Clínica Oranza" y el tema)
// porque el retrieval devuelve chunks sueltos, no el documento:
// un chunk debe entenderse sin leer el resto.
// Fuente: Clinica_Oranza.md e informacion_ventas_agentes.md
// (solo la sección de Oranza; lo del Dr. Becerril es otro cliente).
// ------------------------------------------------------------
const ORANZA_KNOWLEDGE = [
  {
    title: 'Quiénes somos: Clínica Oranza y equipo médico',
    content: `Clínica Dental Oranza es una clínica odontológica con más de 25 años de experiencia en Chiapas. Su lema es "Aliviando el dolor". Su enfoque principal es la atención de trastornos temporomandibulares (ATM), además de odontología integral y estética.

El Dr. Ángel Zavala Díaz es el especialista principal de Clínica Oranza (cédula profesional 2506798). Tiene más de 30 años de experiencia y está enfocado en trastornos temporomandibulares (ATM).

El equipo de Clínica Oranza también incluye a la Dra. Angélica Zavala (odontóloga) y a la Dra. Ana (odontóloga). La clínica trabaja además con colegas especialistas: un endodoncista y un cirujano maxilofacial. Karen Jiménez es la asistente y auxiliar de recepción.`,
  },
  {
    title: 'Ubicación y cómo llegar',
    content: `¿Dónde está Clínica Oranza? ¿Cuál es la dirección? La clínica está ubicada en Tuxtla Gutiérrez, Chiapas. La dirección es Av. Rosa del Sur No. 2, Mz. 69, Inf. El Rosario.

¿Cómo llego a Clínica Oranza? La ubicación exacta en Google Maps es: https://maps.app.goo.gl/EZK7ezS6aWauj5RG8 — con ese enlace puedes llegar en coche o pedir un taxi o Uber directo a la clínica.`,
  },
  {
    title: 'Horarios de atención y contacto',
    content: `¿A qué hora abren? ¿Cuál es el horario? El horario de atención de Clínica Oranza es de lunes a viernes de 4:00 a 8:00 de la tarde (16:00 a 20:00 hrs).

¿Atienden los sábados o domingos? Los sábados, domingos y días festivos no hay consulta regular en Clínica Oranza: solo se atienden emergencias con autorización previa del doctor, y no está garantizado.

¿Atienden en línea, por videollamada o por WhatsApp? No: la atención de Clínica Oranza es 100% presencial. No se ofrecen valoraciones virtuales ni diagnósticos a distancia, porque el doctor necesita revisar al paciente en persona para darle una respuesta confiable.

¿Qué pasa si llego tarde a mi cita? En Clínica Oranza hay una tolerancia de aproximadamente 15 minutos en la llegada; si el paciente llega más tarde, la cita podría acortarse o reagendarse.

¿Cómo contacto a la clínica? La línea de atención principal de Clínica Oranza es WhatsApp: +52 961 200 3344.`,
  },
  {
    title: 'Valoración y tratamiento ATM (bruxismo, dolor de mandíbula)',
    content: `El trastorno temporomandibular (ATM) afecta la articulación que conecta la mandíbula con el cráneo. Señales frecuentes: dolor de mandíbula, bruxismo (rechinar o apretar los dientes), tronidos o chasquidos al abrir y cerrar la boca, dolor de cabeza crónico y dolor de oído sin causa aparente. Si un paciente describe estos síntomas, el paso indicado en Clínica Oranza es la valoración ATM con el Dr. Zavala.

La Valoración ATM de Clínica Oranza cuesta $700 MXN y se aparta con un anticipo de $350 que se abona al total. Dura aproximadamente 1 hora y es presencial. Es la entrevista y exploración primaria para evaluar el trastorno temporomandibular y definir el plan de tratamiento.

El Tratamiento Integral ATM de Clínica Oranza se cotiza después de la valoración, porque depende de lo que el doctor encuentre. Incluye el abordaje del trastorno, ajustes cada 8 a 10 días y el uso de guardas.

La guarda rígida (guarda oclusal para bruxismo) cuesta $800 MXN en Clínica Oranza. Se indica después de la valoración y se paga después, aparte de la consulta.

La Hipnoterapia Clínica de Clínica Oranza es psicoterapia ericksoniana. Se usa como segunda fase del tratamiento ATM cuando el apretamiento dental tiene causas emocionales (por ejemplo estrés o ansiedad). Se cotiza después de la valoración.`,
  },
  {
    title: 'Servicios dentales y política de cotización',
    content: `En Clínica Oranza la valoración presencial es obligatoria: no se dan precios definitivos de tratamientos por WhatsApp. Todo plan y costo exacto se define en la valoración con el doctor.

La Consulta Odontológica General de Clínica Oranza cuesta $700 MXN y se aparta con un anticipo de $350 que se abona al total. Incluye valoración, diagnóstico y plan de tratamiento general.

Servicios de Clínica Oranza que se cotizan después de la valoración (sin precio fijo por WhatsApp): limpieza dental (profilaxis), curaciones y resinas, coronas y carillas (Emax / Zirconia), endodoncia, extracciones y prótesis, y diseño de sonrisa.

La endodoncia en Clínica Oranza la realiza un colega endodoncista especialista.

La cirugía maxilofacial (por ejemplo terceros molares, las muelas del juicio) la realiza un colega cirujano maxilofacial y se cotiza tras la valoración. Para apartar la fecha de una cirugía ya indicada por el doctor se requiere un anticipo de $5,000 MXN. Ese anticipo de $5,000 NO aplica para la valoración inicial: la valoración se aparta con $350.`,
  },
  {
    title: 'Pagos, anticipos, reagendas y facturación',
    content: `Anticipos en Clínica Oranza: ninguna cita de valoración se confirma sin el pago del anticipo de $350 MXN. No es un cobro extra: funciona como apartado del lugar y se descuenta del total de la consulta o del tratamiento posterior. El resto se paga al acudir.

Política de reagenda de Clínica Oranza: si el paciente avisa con al menos 24 horas de anticipación, su anticipo se conserva y es válido por 6 meses. Si no se presenta a su cita sin avisar (primera inasistencia), el anticipo alcanza para reagendar una sola vez más. A la segunda inasistencia el anticipo se pierde. No hay reembolsos: el anticipo funciona como apartado.

Formas de pago en Clínica Oranza: se aceptan todas las formas de pago (efectivo, tarjeta y transferencia). Hay Meses Sin Intereses (MSI) únicamente en tratamientos integrales mayores a $12,000 MXN.

Facturación en Clínica Oranza: sí se factura, únicamente si la factura se solicita el mismo día del pago.

Clínica Oranza no acepta seguros médicos ni convenios empresariales, y no ofrece descuentos ni promociones, aunque el paciente los pida.`,
  },
]

// Títulos de versiones anteriores de ESTE script que ya no existen en
// ORANZA_KNOWLEDGE — se eliminan para no dejar documentos huérfanos
// duplicando contenido. Solo títulos sembrados por este script; nunca
// tocamos documentos creados a mano en el dashboard.
const OBSOLETE_TITLES = ['Ubicación, horarios y contacto']

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
  const { account_id: accountId, user_id: userId } = profile
  ok(`Cuenta ${accountId}`)

  // 2. Llave de embeddings: sin ella el RAG queda solo léxico. Solo la
  //    escribimos si NO hay una ya configurada (no pisar una manual).
  if (OPENAI_KEY && ENCRYPTION_KEY) {
    const { data: cfg, error: cfgErr } = await db
      .from('ai_configs')
      .select('id, embeddings_api_key')
      .eq('account_id', accountId)
      .maybeSingle()
    if (cfgErr) die(`No pude leer ai_configs: ${cfgErr.message}`)
    if (!cfg) die('La cuenta no tiene ai_configs. Corre primero scripts/setup-clinic-agent.mjs')
    if (!cfg.embeddings_api_key) {
      info('Registrando la llave de embeddings (búsqueda semántica)…')
      const { error } = await db
        .from('ai_configs')
        .update({ embeddings_api_key: encrypt(OPENAI_KEY) })
        .eq('account_id', accountId)
      if (error) die(`No pude guardar la llave de embeddings: ${error.message}`)
      ok('Búsqueda semántica activada (embeddings_api_key)')
    } else {
      ok('La cuenta ya tiene llave de embeddings — no la toco')
    }
  } else {
    warn('Sin OPENAI_API_KEY o ENCRYPTION_KEY: la KB quedará solo con búsqueda léxica (FTS)')
  }

  // 3. Limpiar títulos de versiones anteriores de este script (los
  //    chunks caen en cascada por FK).
  for (const title of OBSOLETE_TITLES) {
    const { data: stale, error } = await db
      .from('ai_knowledge_documents')
      .delete()
      .eq('account_id', accountId)
      .eq('title', title)
      .select('id')
    if (error) die(`No pude limpiar el documento obsoleto "${title}": ${error.message}`)
    if (stale?.length) ok(`Documento obsoleto eliminado: "${title}"`)
  }

  // 4. Documentos: upsert por título + re-ingesta de chunks.
  for (const doc of ORANZA_KNOWLEDGE) {
    info(`Documento: "${doc.title}"…`)
    const { data: existing, error: selErr } = await db
      .from('ai_knowledge_documents')
      .select('id')
      .eq('account_id', accountId)
      .eq('title', doc.title)
      .maybeSingle()
    if (selErr) die(`No pude buscar el documento: ${selErr.message}`)

    let documentId
    if (existing) {
      documentId = existing.id
      const { error } = await db
        .from('ai_knowledge_documents')
        .update({ content: doc.content })
        .eq('id', documentId)
      if (error) die(`No pude actualizar "${doc.title}": ${error.message}`)
    } else {
      const { data: inserted, error } = await db
        .from('ai_knowledge_documents')
        .insert({
          account_id: accountId,
          created_by: userId,
          title: doc.title,
          content: doc.content,
        })
        .select('id')
        .single()
      if (error || !inserted) die(`No pude crear "${doc.title}": ${error?.message}`)
      documentId = inserted.id
    }

    // Re-ingesta idempotente: reemplaza los chunks del documento
    // (mismo contrato que ingestDocument en src/lib/ai/knowledge.ts).
    const chunks = chunkText(doc.content)
    const { error: delErr } = await db
      .from('ai_knowledge_chunks')
      .delete()
      .eq('document_id', documentId)
    if (delErr) die(`No pude limpiar los chunks de "${doc.title}": ${delErr.message}`)

    let embeddings = null
    if (OPENAI_KEY) {
      try {
        embeddings = await embedTexts(OPENAI_KEY, chunks)
      } catch (e) {
        warn(`Embeddings fallaron para "${doc.title}" (${e.message}) — siembro sin vectores; usa Reindex en /agents para reintentar`)
      }
    }

    const rows = chunks.map((content, i) => ({
      document_id: documentId,
      account_id: accountId,
      chunk_index: i,
      content,
      embedding: embeddings ? toVectorLiteral(embeddings[i]) : null,
    }))
    const { error: insErr } = await db.from('ai_knowledge_chunks').insert(rows)
    if (insErr) die(`No pude insertar chunks de "${doc.title}": ${insErr.message}`)
    ok(`"${doc.title}" — ${chunks.length} chunk(s)${embeddings ? ' con embeddings' : ' SIN embeddings'}`)
  }

  console.log(`
\x1b[32m✓ Base de conocimiento de Oranza sembrada (${ORANZA_KNOWLEDGE.length} documentos).\x1b[0m
  Los documentos son editables en /agents → Knowledge.
  Pruébala: "quién es el doctor?", "dónde están ubicados?",
  "qué es la hipnoterapia?", "aceptan seguros?", "hasta qué hora abren?"
`)
}

main().catch((e) => die(e.message))
