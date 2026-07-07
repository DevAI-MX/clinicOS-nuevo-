-- ============================================================
-- Fix: every bot/panel reply sent via Zernio was being persisted TWICE
-- (once by the send path, once by the message.sent webhook echo).
--
-- processZernioOutboundEcho (src/lib/zernio/inbound.ts) dedupes with a
-- SELECT-then-INSERT on message_id — but Zernio fires the message.sent
-- webhook the moment it processes the send, independently of the send
-- API call still in flight. In a real conversation (Acerotech,
-- 2026-07-07) the echo consistently landed 0.2-0.7s BEFORE the send
-- path's own INSERT: the echo's SELECT saw nothing, both sides
-- inserted, and every outbound ended up duplicated ('agent' echo row +
-- 'bot' send row). Worse than cosmetic: buildConversationContext maps
-- both to role 'assistant', so the agent saw all its replies doubled —
-- which is how it ended up emitting literally concatenated repeats.
--
-- No SELECT-then-INSERT ordering can close a race between two
-- independent HTTP requests; only an atomic constraint can. Add
-- UNIQUE (conversation_id, message_id): the loser of the race gets a
-- 23505, which the writers now treat as "already persisted" (see
-- inbound.ts / auto-reply.ts / send-message.ts). NULL message_ids
-- never conflict (Postgres default NULLS DISTINCT), so rows without a
-- provider id are unaffected.
--
-- Scoped per-conversation on purpose: migration 009 already noted
-- Meta message ids aren't globally unique, and every existing dedupe
-- (inbound + echo) checks message_id within one conversation.
--
-- Clean existing duplicates first or the index can't build. Keeper
-- per duplicate group: prefer the 'bot' row (correct authorship — the
-- echo mislabels bot sends as 'agent'), then the earliest row.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

DELETE FROM messages m
USING messages k
WHERE m.message_id IS NOT NULL
  AND k.conversation_id = m.conversation_id
  AND k.message_id = m.message_id
  AND k.id <> m.id
  AND (
    (k.sender_type = 'bot')::int > (m.sender_type = 'bot')::int
    OR (
      (k.sender_type = 'bot')::int = (m.sender_type = 'bot')::int
      AND (
        k.created_at < m.created_at
        OR (k.created_at = m.created_at AND k.id < m.id)
      )
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS messages_conversation_message_id_key
  ON messages (conversation_id, message_id);
