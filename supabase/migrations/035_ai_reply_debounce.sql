-- ============================================================
-- 035_ai_reply_debounce.sql — debounce AI auto-reply across
-- message bursts.
--
-- Problem: WhatsApp delivers each inbound message as its own webhook
-- call, and each call runs in its own serverless invocation. A patient
-- typing 3-5 messages in a row today triggers 3-5 concurrent, isolated
-- runs of the AI reply — fragmented, incoherent answers instead of one
-- reply once the patient is done typing.
--
-- Design: same compare-and-swap pattern as `claim_ai_reply_slot`
-- (029_ai_reply.sql), just no cron/queue needed. Every inbound message
-- reschedules `ai_dispatch_due_at` forward; the app waits (inside the
-- same serverless invocation, via a short poll loop — see
-- `auto-reply.ts`) and, once the window elapses, atomically claims the
-- dispatch via `claim_ai_dispatch_slot`. Whichever invocation still
-- sees the `due_at` it expects wins; the rest see a changed/cleared
-- value and stand down. `buildConversationContext` already rereads the
-- full recent transcript on every call, so the single winning dispatch
-- naturally answers the whole accumulated burst — no batching of
-- message content is needed here.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_dispatch_due_at timestamptz;

-- ============================================================
-- Atomic debounce claim.
--
-- Called once the caller's observed wait window has elapsed. Clears
-- `ai_dispatch_due_at` back to NULL only if it still matches what the
-- caller last saw (`expected_due_at`) — if another inbound message
-- reprogrammed it in the meantime, or another invocation already
-- claimed it, this returns false and the caller stands down instead of
-- double-dispatching the agent.
-- ============================================================
CREATE OR REPLACE FUNCTION public.claim_ai_dispatch_slot(
  conversation_id uuid,
  expected_due_at timestamptz
)
RETURNS boolean AS $$
  WITH claimed AS (
    UPDATE conversations
    SET ai_dispatch_due_at = NULL
    WHERE id = conversation_id
      AND ai_dispatch_due_at = expected_due_at
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;
