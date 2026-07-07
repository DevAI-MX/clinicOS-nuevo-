-- ============================================================
-- Recalibrate the semantic relevance floor from 0.65 → 0.75.
--
-- Migration 038 introduced the floor at 0.65 as a conservative guess,
-- "tune it once there's real query traffic to look at". First real
-- calibration against the seeded Oranza KB (2026-07, Spanish,
-- text-embedding-3-small) showed 0.65 rejects correct answers to the
-- short, colloquial queries WhatsApp patients actually send:
--
--   "dónde están ubicados? cómo llego?"  → right chunk at d=0.691  ✗ filtered
--   "cuál es la dirección?"              → right chunk at d=0.689  ✗ filtered
--   "a qué hora abren?"                  → right chunk at d=0.699  ✗ filtered
--   "dónde queda la clínica?"            → right chunk at d=0.509  ✓
--   "qué es la hipnoterapia clínica?"    → right chunk at d=0.310  ✓
--
-- In every measured case the correct chunk still ranked FIRST — the
-- ordering is reliable; the absolute threshold was just too tight for
-- short Spanish queries, whose embeddings sit farther from paragraph-
-- length chunks. Measured off-topic matches landed at ≥ 0.76, so 0.75
-- keeps blocking genuinely unrelated "grounding" (the original purpose
-- of 038) while letting real answers through. The model-side guard
-- (consultar_conocimiento tells the agent to use excerpts only if they
-- truly answer the question) remains the filter for the gray band.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE OR REPLACE FUNCTION public.match_ai_knowledge_semantic(
  p_account_id      uuid,
  p_query_embedding text,
  p_match_count     integer
)
RETURNS TABLE (id uuid, content text, distance real) AS $$
  SELECT c.id,
         c.content,
         (c.embedding <=> p_query_embedding::vector(1536)) AS distance
  FROM ai_knowledge_chunks c
  WHERE c.account_id = p_account_id
    AND c.embedding IS NOT NULL
    AND (c.embedding <=> p_query_embedding::vector(1536)) < 0.75
  ORDER BY c.embedding <=> p_query_embedding::vector(1536)
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
