"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { toast } from "sonner";
import { toDateInputValue } from "@/lib/clinic/calendar";
import { cn } from "@/lib/utils";

interface BlockScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultDate: Date;
  onCreated: () => void;
}

export function BlockScheduleDialog({
  open,
  onOpenChange,
  defaultDate,
  onCreated,
}: BlockScheduleDialogProps) {
  const supabase = createClient();
  const { accountId } = useAuth();

  const [startDate, setStartDate] = useState("");
  const [startTime, setStartTime] = useState("09:00");
  const [endDate, setEndDate] = useState("");
  const [endTime, setEndTime] = useState("14:00");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      const day = toDateInputValue(defaultDate);
      setStartDate(day);
      setEndDate(day);
      setStartTime("09:00");
      setEndTime("14:00");
      setReason("");
    }
  }, [open, defaultDate]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const starts = new Date(`${startDate}T${startTime}`);
    const ends = new Date(`${endDate}T${endTime}`);
    if (Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime())) {
      toast.error("Fecha u hora inválidas");
      return;
    }
    if (ends <= starts) {
      toast.error("El fin del bloqueo debe ser después del inicio");
      return;
    }

    setSaving(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) throw new Error("Sesión no válida");
      if (!accountId) throw new Error("Tu perfil no está ligado a una cuenta");

      const { error } = await supabase.from("schedule_blocks").insert({
        account_id: accountId,
        starts_at: starts.toISOString(),
        ends_at: ends.toISOString(),
        reason: reason.trim() || null,
        created_by: user.id,
      });
      if (error) throw error;

      toast.success("Horario bloqueado");
      onOpenChange(false);
      onCreated();
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "No se pudo bloquear el horario";
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <div className="calendar-scope">
      <div className={cn("drawer-backdrop", open && "open")} onClick={() => onOpenChange(false)}></div>
      <div className={cn("modal", open && "open")}>
        <div className="modal-header">
          <h3 className="modal-title">Bloquear horario</h3>
          <button className="drawer-close" onClick={() => onOpenChange(false)}>×</button>
        </div>
        
        <div className="modal-body">
          <p style={{ color: "var(--text-sub)", fontSize: 13, marginBottom: 16 }}>
            El rango bloqueado se muestra rayado en el calendario (cirugías, comidas, vacaciones).
          </p>

          <div className="sheet-grid">
            <div className="sheet-field">
              <label>Desde (Fecha)</label>
              <input 
                type="date" 
                className="input nums" 
                style={{ width: "100%" }}
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div className="sheet-field">
              <label>Hora</label>
              <input 
                type="time" 
                className="input nums" 
                style={{ width: "100%" }}
                step={300}
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
              />
            </div>
          </div>

          <div className="sheet-grid">
            <div className="sheet-field">
              <label>Hasta (Fecha)</label>
              <input 
                type="date" 
                className="input nums" 
                style={{ width: "100%" }}
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
            <div className="sheet-field">
              <label>Hora</label>
              <input 
                type="time" 
                className="input nums" 
                style={{ width: "100%" }}
                step={300}
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
              />
            </div>
          </div>

          <div className="sheet-field">
            <label>Motivo</label>
            <input 
              type="text" 
              className="input" 
              placeholder="Cirugía, comida, vacaciones..."
              style={{ width: "100%" }}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancelar</button>
          <button className="btn primary" onClick={handleSubmit} disabled={saving}>
            {saving ? "Bloqueando..." : "Bloquear"}
          </button>
        </div>
      </div>
    </div>
  );
}
