-- ============================================================
-- Fix: deleting a conversation (or a contact) fails when a deal in
-- "Embudo IA" references it.
--
-- deals.conversation_id was declared REFERENCES conversations(id)
-- with no ON DELETE action, so Postgres defaults to NO ACTION. Since
-- clasificar_lead() (src/lib/ai/agent/execute.ts) stamps
-- conversation_id on nearly every deal it creates, deleting the
-- conversation that spawned a deal raises:
--
--   ERROR 23503: update or delete on table "conversations" violates
--   foreign key constraint "deals_conversation_id_fkey" on table "deals"
--
-- which the DELETE /api/inbox/conversations/[id] route surfaces as a
-- generic 500 — the conversation (and, transitively, the contact that
-- owns it) becomes impossible to delete.
--
-- Same fix as migration 004 for deals.contact_id: SET NULL, not
-- CASCADE. The deal (Embudo IA card / pipeline history) survives;
-- only its dangling link to the deleted conversation is cleared. The
-- UI already treats a missing linked conversation as absent (see
-- deal-form.tsx, which re-resolves "linked conversation" by contact_id
-- rather than trusting this column).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'deals_conversation_id_fkey'
      AND conrelid = 'deals'::regclass
  ) THEN
    ALTER TABLE deals
      DROP CONSTRAINT deals_conversation_id_fkey;
  END IF;
END $$;

ALTER TABLE deals
  ADD CONSTRAINT deals_conversation_id_fkey
    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    ON DELETE SET NULL;
