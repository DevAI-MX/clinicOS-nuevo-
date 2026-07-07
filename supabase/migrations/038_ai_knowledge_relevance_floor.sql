-- ============================================================
-- Anti-hallucination hardening for the knowledge-base RAG (migration
-- 030): match_ai_knowledge_semantic had no relevance floor — it always
-- returned the k nearest chunks by cosine distance, even when every
-- chunk in the account's KB was topically unrelated to the query
-- (e.g. a KB with only "horario de verano" content, queried about
-- "efectos secundarios de la anestesia"). Those distant chunks were
-- then handed to the model as "estos extractos" to answer with,
-- which invites confidently-wrong answers built on irrelevant text —
-- RAG doesn't stop hallucination if the retrieved "grounding" itself
-- isn't actually relevant.
--
-- Fix: only return chunks within a cosine-distance cutoff of the
-- query embedding. 0.65 is a conservative starting point for
-- text-embedding-3-small (topically related passages typically land
-- well under this; unrelated text typically lands above it) — tune it
-- once there's real query traffic to look at.
--
-- match_ai_knowledge_fts is untouched: its `fts @@ plainto_tsquery(...)`
-- clause already requires at least one shared lexeme, so it can't
-- return zero-overlap junk the way the unfiltered semantic path could.
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
    AND (c.embedding <=> p_query_embedding::vector(1536)) < 0.65
  ORDER BY c.embedding <=> p_query_embedding::vector(1536)
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
