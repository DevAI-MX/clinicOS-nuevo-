# Puerto AgentHarness — arneses agénticos intercambiables

La IA de atención de wacrm puede atender un turno con distintos **arneses**
(backends) sin tocar la plomería que la rodea. Es un patrón puerto/adaptador
(hexagonal): un solo contrato, varios adaptadores detrás.

## El puerto

```ts
// src/lib/ai/agent/harness.ts
export interface AgentHarness {
  runTurn(args: RunClinicalAgentArgs): Promise<RunClinicalAgentResult>
}
```

Todo pasa por **`runClinicalAgent`** (`src/lib/ai/agent/loop.ts`), que resuelve el
arnés según `args.backend` (default `native`) y delega. Los 3 callers (Atención,
Concierge, Asistente interno) no cambian.

## Los adaptadores

| Backend | Adaptador | Qué hace |
|---|---|---|
| `native` (default) | `loop.ts` / `loop-openai.ts` | Loops de tool-use in-app (Anthropic/OpenAI). **Sin cambio.** Corre los `CLINICAL_TOOLS` scoped a Supabase. |
| `openclaw` | `loop-external.ts` | Delega a un gateway OpenAI-compat externo (OpenClaw). |
| `hermes` | `loop-external.ts` | Idem, otra base URL (Hermes). |

**Lo que NO cambia según el backend** (vive arriba del puerto, en `auto-reply.ts`):
guardrail determinista + reparación, `claim_ai_reply_slot`, candado humano
(`assigned_agent_id`/`ai_autoreply_disabled`), buffer/debounce y envío. `runTurn`
es una función pura *transcript + tools → reply*.

## Configurar un backend externo (por cuenta)

Es config **por cuenta** en `ai_configs` (migración `050`), mismo patrón BYO-key
que el resto:

| Columna | Uso |
|---|---|
| `agent_backend` | `native` \| `openclaw` \| `hermes` (default `native`) |
| `agent_base_url` | Base URL del gateway, **incluye `/v1`** (p. ej. `http://openclaw:18789/v1`) |
| `agent_auth_token` | Bearer del gateway, **cifrado AES-256-GCM** como `api_key` (NULL si no requiere auth) |

El adaptador externo POSTea a `<agent_base_url>/chat/completions` con
`{ model, messages }` (system + transcript) y toma `choices[0].message.content`,
parseando el mismo centinela de handoff que los loops nativos.

## ⚠️ Gap de datos (v1)

OpenClaw/Hermes son **runtimes agénticos completos**: corren su propio loop de
tools, memoria y persona. El adaptador externo es por eso **brain-only** — el
arnés externo **redacta**, pero sus acciones (agendar/cobrar) **NO escriben en el
Supabase de wacrm** (usa sus propias tools, no `CLINICAL_TOOLS`).

Para que las acciones del arnés externo impacten los datos de wacrm hace falta
**exponerle las tools de wacrm** (su config apunta a la API pública de wacrm, o un
callback) — **fase siguiente, no construida en v1.** Mientras tanto, un backend
externo sirve como redactor; las escrituras deterministas siguen siendo del
adaptador `native`.
