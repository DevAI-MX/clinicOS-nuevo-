-- ============================================================
-- 036 — Segmento "Paciente" en el Embudo IA
--
-- El embudo segmentaba solo el camino del lead (Preguntón →
-- Interesado → Seguimiento futuro → Cita apartada → Anticipo en
-- revisión → Agendado) pero no distinguía a quienes YA son pacientes
-- de la clínica. Regla de negocio: un contacto se vuelve paciente
-- cuando su cita se marca 'completada'. El trigger de abajo mueve su
-- deal abierto del Embudo IA a la etapa 'Paciente' y etiqueta al
-- contacto con la tag 'paciente' (para segmentar en contactos y
-- difusiones), sin importar desde qué superficie se completó la cita.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Etapa 'Paciente' al final de los pipelines 'Embudo IA' que ya
--    existen. Los que se creen después la reciben desde código
--    (FUNNEL_STAGES en src/lib/ai/agent/execute.ts, con backfill
--    self-healing si faltara).
-- ------------------------------------------------------------
INSERT INTO pipeline_stages (pipeline_id, name, color, position)
SELECT
  p.id,
  'Paciente',
  '#14b8a6',
  COALESCE(
    (SELECT MAX(ps.position) FROM pipeline_stages ps WHERE ps.pipeline_id = p.id),
    -1
  ) + 1
FROM pipelines p
WHERE p.name = 'Embudo IA'
  AND NOT EXISTS (
    SELECT 1 FROM pipeline_stages ps
    WHERE ps.pipeline_id = p.id AND ps.name = 'Paciente'
  );

-- ------------------------------------------------------------
-- 2) Cita completada → el contacto es paciente.
--    Best-effort por diseño: si la cuenta no tiene Embudo IA (o el
--    contacto no tiene deal abierto) solo se aplica la tag; nada de
--    esto debe impedir que la cita quede marcada como completada.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.appointment_completed_mark_paciente()
RETURNS trigger AS $$
DECLARE
  v_pipeline uuid;
  v_stage    uuid;
  v_owner    uuid;
  v_tag      uuid;
BEGIN
  -- Deal abierto del Embudo IA → etapa 'Paciente'.
  SELECT id INTO v_pipeline
  FROM pipelines
  WHERE account_id = NEW.account_id AND name = 'Embudo IA'
  LIMIT 1;

  IF v_pipeline IS NOT NULL THEN
    SELECT id INTO v_stage
    FROM pipeline_stages
    WHERE pipeline_id = v_pipeline AND name = 'Paciente'
    LIMIT 1;

    IF v_stage IS NOT NULL THEN
      UPDATE deals
      SET stage_id = v_stage
      WHERE account_id = NEW.account_id
        AND contact_id = NEW.contact_id
        AND pipeline_id = v_pipeline
        AND status = 'open';
    END IF;
  END IF;

  -- Tag 'paciente' (las tags son por-usuario, modelo wacrm pre-017:
  -- se cuelgan del dueño de la cuenta, igual que las lead:* del agente).
  SELECT owner_user_id INTO v_owner FROM accounts WHERE id = NEW.account_id;
  IF v_owner IS NOT NULL THEN
    SELECT id INTO v_tag
    FROM tags
    WHERE user_id = v_owner AND name = 'paciente'
    LIMIT 1;

    IF v_tag IS NULL THEN
      INSERT INTO tags (user_id, name, color)
      VALUES (v_owner, 'paciente', '#14b8a6')
      RETURNING id INTO v_tag;
    END IF;

    INSERT INTO contact_tags (contact_id, tag_id)
    VALUES (NEW.contact_id, v_tag)
    ON CONFLICT (contact_id, tag_id) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_appointment_completed_paciente ON appointments;
CREATE TRIGGER trg_appointment_completed_paciente
  AFTER UPDATE OF status ON appointments
  FOR EACH ROW
  WHEN (NEW.status = 'completada' AND OLD.status IS DISTINCT FROM 'completada')
  EXECUTE FUNCTION public.appointment_completed_mark_paciente();
