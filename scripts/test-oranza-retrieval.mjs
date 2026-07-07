// Prueba de SOLO LECTURA del retrieval RAG de Oranza: embebe preguntas
// típicas de paciente y llama los RPCs de retrieval (semántico con piso
// de relevancia + léxico FTS). Úsalo como smoke test después de editar
// la KB o recalibrar el piso.
// Uso: ~/.nvm/versions/node/v22.23.1/bin/node scripts/test-oranza-retrieval.mjs
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const envFile = readFileSync(resolve(ROOT, '.env.local'), 'utf8')
const env = Object.fromEntries(
  envFile
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)

const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})
const EMAIL = process.env.DEMO_EMAIL || 'covarrubiasmataemiliano@gmail.com'
const { data: profiles } = await db
  .from('profiles')
  .select('account_id')
  .eq('email', EMAIL)
  .eq('account_role', 'owner')
  .limit(1)
const ACCOUNT = profiles?.[0]?.account_id
if (!ACCOUNT) {
  console.error(`No encontré un perfil owner con email ${EMAIL}`)
  process.exit(1)
}

const QUERIES = [
  'quién es el doctor? cuántos años de experiencia tiene?',
  'dónde están ubicados? cómo llego?',
  'cuál es la dirección?',
  'a qué hora abren?',
  'atienden los sábados?',
  'qué es la hipnoterapia clínica?',
  'aceptan seguros o hay descuentos?',
  'me truena la mandíbula y me duele la cabeza, qué puede ser?',
  'si no puedo ir a mi cita pierdo mi anticipo?',
  'cuánto cuesta una rinoplastia?', // fuera de dominio — debe regresar poco o nada relevante
]

async function embed(q) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: [q] }),
  })
  if (!res.ok) throw new Error(`embeddings ${res.status}`)
  const data = await res.json()
  return `[${data.data[0].embedding.join(',')}]`
}

for (const q of QUERIES) {
  console.log(`\n=== "${q}"`)
  const vec = await embed(q)
  const { data: sem, error: semErr } = await db.rpc('match_ai_knowledge_semantic', {
    p_account_id: ACCOUNT,
    p_query_embedding: vec,
    p_match_count: 3,
  })
  if (semErr) console.log('  semantic ERROR:', semErr.message)
  else if (!sem?.length) console.log('  semantic: (nada sobre el piso 0.65)')
  else
    for (const r of sem)
      console.log(`  semantic d=${r.distance.toFixed(3)}: ${r.content.slice(0, 90).replace(/\n/g, ' ')}…`)

  const { data: fts, error: ftsErr } = await db.rpc('match_ai_knowledge_fts', {
    p_account_id: ACCOUNT,
    p_query: q,
    p_match_count: 2,
  })
  if (ftsErr) console.log('  fts ERROR:', ftsErr.message)
  else if (!fts?.length) console.log('  fts: (sin matches)')
  else
    for (const r of fts)
      console.log(`  fts rank=${r.rank.toFixed(3)}: ${r.content.slice(0, 90).replace(/\n/g, ' ')}…`)
}
