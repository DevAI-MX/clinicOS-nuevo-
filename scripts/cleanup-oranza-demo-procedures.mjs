// ============================================================
// cleanup-oranza-demo-procedures.mjs — desactiva los procedimientos de
// la demo genérica original ("Clínica Demo clinicOS", seed-demo.mjs)
// que quedaron activos en la cuenta real de Oranza.
//
// setup-oranza.mjs sembró el catálogo real de Oranza por upsert-por-
// nombre (Valoración ATM, Consulta odontológica general, Guarda
// rígida, Limpieza dental, Resinas, Endodoncia, Coronas, Diseño de
// sonrisa) pero NUNCA desactivó los 4 procedimientos que seed-demo.mjs
// había sembrado antes con nombres distintos:
//   - Valoración presencial ($500 / anticipo $300)
//   - Valoración virtual ($800 / anticipo $800)
//   - Rinoplastia ($65,000-95,000 / anticipo $8,000)
//   - Limpieza dental profunda ($1,200-1,800)
// consultar_catalogo lee todo lo que tenga is_active=true, así que el
// agente los mezcla con el catálogo real y cotiza rinoplastia a
// pacientes de una clínica dental/ATM que no la ofrece — confirmado en
// una conversación real (Acerotech, 2026-07-07).
//
// No los borra (podrían tener valor de referencia/auditoría): solo
// pone is_active=false, igual que ya hace el resto del catálogo para
// modelar "no ofrecido actualmente". Idempotente.
//
// Uso:
//   ~/.nvm/versions/node/v22.23.1/bin/node scripts/cleanup-oranza-demo-procedures.mjs
// ============================================================

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

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY
const EMAIL = process.env.DEMO_EMAIL || 'covarrubiasmataemiliano@gmail.com'

const die = (m) => {
  console.error(`\x1b[31m✗ ${m}\x1b[0m`)
  process.exit(1)
}
const ok = (m) => console.log(`\x1b[32m✓ ${m}\x1b[0m`)
const info = (m) => console.log(`\x1b[36m▸ ${m}\x1b[0m`)

if (!SUPABASE_URL || !SERVICE_ROLE) die('Faltan credenciales de Supabase en .env.local')

const STALE_DEMO_NAMES = [
  'Valoración presencial',
  'Valoración virtual',
  'Rinoplastia',
  'Limpieza dental profunda',
]

const db = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
})

async function main() {
  info(`Buscando la cuenta de ${EMAIL}…`)
  const { data: profiles, error: pErr } = await db
    .from('profiles')
    .select('account_id')
    .eq('email', EMAIL)
    .eq('account_role', 'owner')
    .limit(1)
  if (pErr) die(`No pude leer profiles: ${pErr.message}`)
  const accountId = profiles?.[0]?.account_id
  if (!accountId) die(`No encontré un perfil owner con email ${EMAIL}.`)
  ok(`Cuenta ${accountId}`)

  const { data: existing, error: selErr } = await db
    .from('procedures')
    .select('id, name, is_active')
    .eq('account_id', accountId)
    .in('name', STALE_DEMO_NAMES)
  if (selErr) die(`No pude leer procedures: ${selErr.message}`)

  if (!existing || existing.length === 0) {
    ok('Nada que limpiar: no quedan procedimientos de la demo genérica en esta cuenta.')
    return
  }

  for (const proc of existing) {
    if (!proc.is_active) {
      info(`"${proc.name}" ya estaba desactivado, se deja igual.`)
      continue
    }
    const { error } = await db
      .from('procedures')
      .update({ is_active: false })
      .eq('id', proc.id)
    if (error) die(`No pude desactivar "${proc.name}": ${error.message}`)
    ok(`Desactivado: "${proc.name}"`)
  }

  console.log(`
\x1b[32m✓ Catálogo de Oranza limpio.\x1b[0m
  consultar_catalogo ya no debería mezclar rinoplastia/valoración
  virtual/presencial/limpieza profunda con el catálogo real.
`)
}

main().catch((e) => die(e.message))
