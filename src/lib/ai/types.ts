// ============================================================
// Shared types for the AI reply assistant (bring-your-own-key).
//
// One small provider-agnostic surface so the inbox draft route and the
// inbound auto-reply bot both talk to `generateReply` without caring
// whether the account is on OpenAI or Anthropic.
// ============================================================

export type AiProvider = 'openai' | 'anthropic'

/** Arnés agéntico de la cuenta. 'native' = los loops in-app (default).
 *  'openclaw'/'hermes' = un gateway externo OpenAI-compat. Mismo union que
 *  `AgentBackend` en agent/tools.ts (se mantiene aquí para no acoplar la
 *  superficie de config al módulo del agente). */
export type AiAgentBackend = 'native' | 'openclaw' | 'hermes' | 'custom'

/**
 * Account AI setup, decrypted and ready to use. Produced by
 * `loadAiConfig` — `apiKey` is the plaintext BYO provider key
 * (stored AES-256-GCM-encrypted at rest).
 */
export interface AiConfig {
  provider: AiProvider
  model: string
  apiKey: string
  systemPrompt: string | null
  isActive: boolean
  autoReplyEnabled: boolean
  autoReplyMaxPerConversation: number
  /** Optional OpenAI-compatible key for embeddings. When set, the
   *  knowledge base is embedded and semantic retrieval turns on; when
   *  null, retrieval falls back to lexical full-text search. */
  embeddingsApiKey: string | null
  /** clinicOS (migration 032): when true and `provider === 'anthropic'`,
   *  the inbound auto-reply runs the clinical Attention agent (tool-use
   *  loop over the scheduling tables) instead of a single text
   *  completion. Ignored for OpenAI / non-clinic accounts. */
  clinicalAgentEnabled: boolean
  /** Arnés agéntico que atiende el turno. Default 'native' (loops in-app).
   *  'openclaw'/'hermes' delegan a un gateway externo OpenAI-compat. */
  agentBackend: AiAgentBackend
  /** Base URL del gateway externo (incluye `/v1`). Requerida cuando
   *  `agentBackend !== 'native'`; null en cuentas nativas. */
  agentBaseUrl: string | null
  /** Bearer token del gateway externo, descifrado (AES-256-GCM at rest,
   *  como `apiKey`). null si el gateway no requiere auth. */
  agentAuthToken: string | null
}

/** A single conversation turn in the shape both providers accept. */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/** Outcome of a generation call. */
export interface GenerateResult {
  /** The reply text, with any handoff sentinel stripped. */
  text: string
  /** True when the model asked to hand off to a human (auto-reply mode). */
  handoff: boolean
}

/**
 * Typed error for every AI failure mode. `status` maps cleanly to an
 * HTTP response in the draft route; `code` lets the UI/tests branch
 * (invalid_key vs rate_limited vs timeout, etc.).
 */
export class AiError extends Error {
  readonly code: string
  readonly status: number
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message)
    this.name = 'AiError'
    this.code = opts.code ?? 'ai_error'
    this.status = opts.status ?? 502
  }
}
