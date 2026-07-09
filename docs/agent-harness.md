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
| `openclaw` | `loop-openai.ts` (endpoint externo) | **El mismo tool-loop OpenAI-compat**, contra el gateway. El gateway **honra `tools`** → devuelve `tool_calls` que **wacrm ejecuta** contra Supabase. |
| `hermes` | `loop-openai.ts` (endpoint externo) | Idem, otra base URL. |

**Lo que NO cambia según el backend** (vive arriba del puerto, en `auto-reply.ts`):
guardrail determinista + reparación, `claim_ai_reply_slot`, candado humano
(`assigned_agent_id`/`ai_autoreply_disabled`), buffer/debounce y envío. `runTurn`
es una función pura *transcript + tools → reply*.

## Configurar un backend externo (por cuenta)

Es config **por cuenta** en `ai_configs` (migración `050`), mismo patrón BYO-key
que el resto:

| Columna | Uso |
|---|---|
| `agent_backend` | `native` (default) \| `openclaw` \| `hermes` \| `custom` (gateway arbitrario). Los externos corren el mismo código; el nombre es etiqueta, el `base_url` manda. |
| `agent_base_url` | Base URL del gateway, **incluye `/v1`** (p. ej. `http://openclaw:18789/v1`) |
| `agent_auth_token` | Bearer del gateway, **cifrado AES-256-GCM** como `api_key` (NULL si no requiere auth) |

El backend externo corre **el mismo tool-loop** que el path OpenAI nativo
(`loop-openai.ts`), solo que apuntando al gateway (`agent_base_url` + `agent_auth_token`
en vez de `api.openai.com` + `apiKey`). Le mandamos los `CLINICAL_TOOLS` de wacrm;
el gateway planea, devuelve `tool_calls`, y **nosotros los ejecutamos**
(`executeClinicalTool`, scoped a `account_id`/`contact_id`).

## Sin gap de datos ✅

Verificado en vivo (2026-07-08): OpenClaw honra el parámetro `tools` de OpenAI
(`finish_reason: 'tool_calls'`). Por eso el backend externo **no** es un redactor
ciego: el "brain" externo aporta razonamiento/persona/memoria, pero **las tools son
las de wacrm y las ejecuta wacrm** contra su propio Supabase, con la misma tenencia
y la misma "regla de oro" (la IA solo pre-valida; un humano confirma). No hay dos
mundos: los datos siempre son de wacrm.

> Alternativa descartada — *brain-only* (delegar 100% al agente externo con SUS
> tools/memoria): tendría gap de datos (sus acciones vivirían en su mundo). Se
> prefirió el tool-loop justo para no fragmentar la fuente de verdad.
