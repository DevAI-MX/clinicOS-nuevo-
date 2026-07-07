import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Re-hospedaje server-side de media entrante.
//
// Las URLs de adjuntos que entrega Zernio son efímeras (archivos
// hosteados por Meta expiran — ver docs/ZERNIO.md), así que guardarlas
// tal cual en messages.media_url deja el panel con imágenes rotas en
// cuanto la URL caduca: el agente sí alcanzó a leerlas (visión corre
// segundos después del webhook) pero el humano que abre la conversación
// horas después ve el placeholder gris. La copia en nuestro bucket
// también preserva el comprobante como evidencia permanente del pago.
//
// Es el complemento server-side de upload-media.ts (que usa el cliente
// browser + sesión del usuario): aquí sube el admin client del webhook,
// que brinca el RLS pero respeta file_size_limit y allowed_mime_types
// del bucket. Se conserva la convención de path account-<id>/... de la
// migración 023 para que la retención/limpieza futura no distinga
// origen.
// ============================================================

const BUCKET = 'chat-media'
/** Igual al file_size_limit del bucket (migración 023). */
const MAX_BYTES = 16 * 1024 * 1024
const TIMEOUT_MS = 15_000

/**
 * mime → extensión del objeto. Solo tipos del allow-list del bucket
 * (migración 023); cualquier otro mime NO se sube y el caller conserva
 * la URL original en vez de pelear con el rechazo del bucket.
 */
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/plain': 'txt',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/aac': 'aac',
  'audio/mp4': 'm4a',
  'audio/amr': 'amr',
}

/**
 * Firma mágica → media type. Manda sobre el Content-Type declarado: los
 * CDNs de media suelen responder application/octet-stream. (Mismo
 * criterio que agent/vision.ts.)
 */
function sniffMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) return 'image/png'
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return 'application/pdf'
  }
  if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
    return 'audio/ogg'
  }
  if (
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  return null
}

export interface RehostInboundMediaArgs {
  /** Admin client (service role) — el webhook no tiene sesión de usuario. */
  db: SupabaseClient
  accountId: string
  /** URL efímera del proveedor (Zernio/Meta). */
  url: string
  /** Inyectable para tests; default Date.now(). */
  now?: number
}

/**
 * Descarga el adjunto y lo sube al bucket público `chat-media`,
 * devolviendo nuestra URL permanente. Devuelve null ante CUALQUIER
 * falla (descarga, tamaño, mime fuera del allow-list, upload) — el
 * caller conserva entonces la URL original como mejor esfuerzo, que es
 * exactamente el comportamiento previo a este módulo. Nunca lanza.
 */
export async function rehostInboundMedia(
  args: RehostInboundMediaArgs,
): Promise<string | null> {
  try {
    const res = await fetch(args.url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) return null

    const declaredLength = Number(res.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) return null

    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) return null

    const declared = (res.headers.get('content-type') ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase()
    const mime = sniffMime(buf) ?? (EXT_BY_MIME[declared] ? declared : null)
    if (!mime || !EXT_BY_MIME[mime]) return null

    const path = `account-${args.accountId}/${args.now ?? Date.now()}-inbound-${crypto
      .randomUUID()
      .slice(0, 8)}.${EXT_BY_MIME[mime]}`

    const { error } = await args.db.storage.from(BUCKET).upload(path, buf, {
      contentType: mime,
      cacheControl: '3600',
      upsert: false,
    })
    if (error) {
      console.error('[rehost-media] upload failed:', error.message)
      return null
    }

    const { data } = args.db.storage.from(BUCKET).getPublicUrl(path)
    return data.publicUrl || null
  } catch (err) {
    console.error('[rehost-media] failed:', err instanceof Error ? err.message : err)
    return null
  }
}
