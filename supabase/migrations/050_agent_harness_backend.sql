-- ============================================================
-- 050 — Puerto AgentHarness: backend agéntico por cuenta.
--
-- La IA de cada cuenta puede atender el turno con distintos arneses:
--   * 'native'   = los loops de tool-use in-app (default; comportamiento
--                  actual, sin cambio para ninguna cuenta existente).
--   * 'openclaw' | 'hermes' | 'custom' = un gateway externo OpenAI-compat.
--                  Requiere agent_base_url. Los tres corren el mismo código
--                  (el base_url manda); 'custom' es para uno arbitrario.
--
-- agent_auth_token se guarda CIFRADO (AES-256-GCM at rest, igual que
-- api_key / embeddings_api_key) — la app lo descifra en loadAiConfig.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS.
-- ============================================================

ALTER TABLE public.ai_configs
  ADD COLUMN IF NOT EXISTS agent_backend text NOT NULL DEFAULT 'native',
  ADD COLUMN IF NOT EXISTS agent_base_url text,
  ADD COLUMN IF NOT EXISTS agent_auth_token text;

-- Solo los backends soportados. DROP+ADD para que sea re-ejecutable.
ALTER TABLE public.ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_agent_backend_check;
ALTER TABLE public.ai_configs
  ADD CONSTRAINT ai_configs_agent_backend_check
  CHECK (agent_backend IN ('native', 'openclaw', 'hermes', 'custom'));

COMMENT ON COLUMN public.ai_configs.agent_backend IS
  'Arnés agéntico: native (loops in-app, default) | openclaw | hermes | custom (gateway externo OpenAI-compat).';
COMMENT ON COLUMN public.ai_configs.agent_base_url IS
  'Base URL del gateway externo (incluye /v1). Requerida cuando agent_backend <> native.';
COMMENT ON COLUMN public.ai_configs.agent_auth_token IS
  'Bearer token del gateway externo, CIFRADO AES-256-GCM (como api_key). NULL si no requiere auth.';
