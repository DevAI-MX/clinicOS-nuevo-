# Conectar WhatsApp por Zernio + activar el agente de Atención

Dos cosas independientes:

- **Zernio** conecta tu número de WhatsApp real (envío + recepción).
- **El agente de Atención (Fase 2)** es el cerebro que responde con
  herramientas (catálogo, agenda, anticipos). Funciona en dry-run sin
  Zernio; con Zernio, contesta directo en WhatsApp.

Puedes activar el agente hoy (dry-run) y conectar Zernio después.

---

## Parte A — Activar el agente de Atención (Fase 2)

### A.1 Aplicar la migración 032

Añade el interruptor `ai_configs.clinical_agent_enabled` y los tipos de
notificación del agente. En tu terminal (la contraseña queda solo en tu
shell, no en el repo):

```bash
supabase db push \
  --db-url "postgresql://postgres:TU_DB_PASSWORD@db.azirttjiqdfbwvzrgbzo.supabase.co:5432/postgres" \
  --include-all
```

> Usa `%2B` en lugar de `+` si tu contraseña lo contiene (URL-encoding).
> Es idempotente: solo aplicará la 032 (las 001–031 ya están puestas).

### A.2 Cargar tu API key de Anthropic (el cerebro del agente)

El agente usa Claude con **tu** API key (bring-your-own-key), guardada
cifrada por cuenta. Sácala en <https://console.anthropic.com> → API Keys.

```bash
ANTHROPIC_API_KEY=sk-ant-... \
  ~/.nvm/versions/node/v22.23.1/bin/node scripts/setup-clinic-agent.mjs
```

Esto activa `provider=anthropic`, `is_active`, `auto_reply_enabled` y
`clinical_agent_enabled` para la cuenta demo, y siembra un
`whatsapp_config` placeholder para que el envío funcione en dry-run.
Modelo por defecto: `claude-sonnet-5` (override con `AGENT_MODEL`).

### A.3 Qué hace el agente

Ante cada mensaje entrante de un paciente, el agente puede:

| Herramienta | Efecto |
|---|---|
| `consultar_catalogo` | Lee precios/anticipos/duración VIVOS (nunca inventa) |
| `consultar_disponibilidad` | Huecos libres reales (horario − bloqueos − citas) |
| `agendar_cita` | **Aparta** la cita en `pendiente` (reagenda si ya hay una) |
| `prevalidar_anticipo` | Registra el anticipo en `pendiente` (en revisión) |
| `clasificar_lead` | Etapa del embudo + nombre en el CRM |
| `avisar_equipo` / `escalar_a_humano` | Avisos en Notificaciones; el modo IA↔humano solo cambia a mano desde el panel |

**Regla de oro:** el agente **solo prevalida**. Citas y pagos quedan
`pendiente`; el equipo confirma en el panel (Calendario / ficha de cita),
y solo entonces la cita pasa a `confirmada`. El agente nunca dice "tu
cita/pago quedó confirmado".

---

## Parte B — Conectar Zernio (WhatsApp real)

Hoy el sistema corre en **dry-run** (`ZERNIO_DRY_RUN=true`): las
respuestas se guardan en la conversación pero no salen por WhatsApp.

### B.1 Variables de entorno (`.env.local`)

```
ZERNIO_API_KEY=<API key de tu dashboard de Zernio>
ZERNIO_ACCOUNT_ID=<id de la cuenta de WhatsApp conectada en Zernio>
ZERNIO_WEBHOOK_SECRET=<un secreto que tú eliges>
# ZERNIO_BASE_URL=https://zernio.com/api   # solo si tu tenant vive en otro host
# ZERNIO_DRY_RUN=true   ← COMENTA o borra esta línea al conectar de verdad
```

Con `ZERNIO_API_KEY` + `ZERNIO_ACCOUNT_ID` presentes (y sin
`ZERNIO_DRY_RUN=true`), TODO el WhatsApp saliente se enruta por Zernio y
el entrante llega a `/api/zernio/webhook`.

### B.2 Registrar el webhook

Zernio necesita una **URL pública** que apunte a:

```
https://<tu-dominio-o-túnel>/api/zernio/webhook
```

En local, expón el puerto 3000 con un túnel (elige uno):

```bash
cloudflared tunnel --url http://localhost:3000
# o:  ngrok http 3000
```

Registra esa URL en el dashboard de Zernio (o su API de webhooks) con el
mismo `ZERNIO_WEBHOOK_SECRET`. El endpoint valida la firma
`X-Zernio-Signature` (HMAC del cuerpo) y responde 200 de inmediato.

Eventos que consumimos: `message.received`, `message.delivered`,
`message.read`, `message.failed`, `reaction.received`, `message.sent`,
`webhook.test`.

### B.3 Reiniciar

El dev server lee `.env.local` al arrancar — reinícialo tras editar env:

```bash
npm run dev
```

---

## Límites conocidos (V1)

- **Una clínica por instalación.** Todo el tráfico de Zernio se ancla a
  una cuenta wacrm (`ZERNIO_WACRM_ACCOUNT_ID` o la primera `whatsapp_config`).
- Los mensajes interactivos (botones/listas) y el reply-quoting no tienen
  mapeo en Zernio: se envían como texto/plano.
- Media entrante usa la URL de Zernio directo (puede expirar en archivos
  hospedados por Meta).
