"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { nudgeCalendarSync } from "@/lib/integrations/google/nudge-client";
import { toast } from "sonner";
import { ContactCombobox } from "./contact-combobox";
import { formatCurrency } from "@/lib/currency";
import { toDateInputValue } from "@/lib/clinic/calendar";
import { APPOINTMENT_TYPE_LABEL } from "@/lib/clinic/status-maps";
import {
  CLINIC_CURRENCY,
  type AppointmentContact,
  type AppointmentType,
  type Doctor,
  type Procedure,
} from "@/lib/clinic/types";
import { cn } from "@/lib/utils";

const NO_PROCEDURE = "none";
const NO_DOCTOR = "none";
const TYPE_OPTIONS = Object.entries(APPOINTMENT_TYPE_LABEL) as [AppointmentType, string][];

interface NewAppointmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  procedures: Procedure[];
  doctors: Doctor[];
  defaultDate: Date;
  onCreated: () => void;
}

export function NewAppointmentDialog({
  open,
  onOpenChange,
  procedures,
  doctors,
  defaultDate,
  onCreated,
}: NewAppointmentDialogProps) {
  const supabase = createClient();
  const { accountId } = useAuth();

  const [contact, setContact] = useState<AppointmentContact | null>(null);
  const [procedureId, setProcedureId] = useState<string>(NO_PROCEDURE);
  const [doctorId, setDoctorId] = useState<string>(NO_DOCTOR);
  const [type, setType] = useState<AppointmentType>("valoracion");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("10:00");
  const [duration, setDuration] = useState(60);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setContact(null);
      setProcedureId(NO_PROCEDURE);
      setDoctorId(NO_DOCTOR);
      setType("valoracion");
      setDate(toDateInputValue(defaultDate));
      setTime("10:00");
      setDuration(60);
      setNotes("");
    }
  }, [open, defaultDate]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onOpenChange(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  const procedure = procedureId === NO_PROCEDURE ? null : (procedures.find((p) => p.id === procedureId) ?? null);
  const requiresDeposit = !!procedure?.deposit_amount;

  function handleProcedureChange(id: string) {
    setProcedureId(id);
    const proc = procedures.find((p) => p.id === id);
    if (proc) setDuration(proc.duration_minutes);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!contact) {
      toast.error("Selecciona un contacto");
      return;
    }
    if (!date || !time) {
      toast.error("Indica fecha y hora");
      return;
    }
    const starts = new Date(`${date}T${time}`);
    if (Number.isNaN(starts.getTime())) {
      toast.error("Fecha u hora inválidas");
      return;
    }
    if (!Number.isFinite(duration) || duration < 5 || duration > 720) {
      toast.error("La duración debe estar entre 5 y 720 minutos");
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

      const ends = new Date(starts.getTime() + duration * 60_000);

      const { error } = await supabase.from("appointments").insert({
        account_id: accountId,
        contact_id: contact.id,
        procedure_id: procedure?.id ?? null,
        doctor_id: doctorId === NO_DOCTOR ? null : doctorId,
        appointment_type: type,
        status: requiresDeposit ? "pendiente" : "confirmada",
        deposit_status: requiresDeposit ? "pendiente" : "no_aplica",
        deposit_amount: requiresDeposit ? procedure!.deposit_amount : null,
        starts_at: starts.toISOString(),
        ends_at: ends.toISOString(),
        notes: notes.trim() || null,
        created_by: user.id,
      });
      if (error) throw error;

      nudgeCalendarSync();
      toast.success(requiresDeposit ? "Cita creada — pendiente de anticipo" : "Cita creada y confirmada");
      onOpenChange(false);
      onCreated();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "No se pudo crear la cita";
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <>
      <div className={cn("drawer-backdrop", open && "open")} onClick={() => onOpenChange(false)}></div>
      <div className={cn("modal", open && "open")} role="dialog" aria-modal="true" aria-label="Nueva cita">
        <div className="modal-header">
          <h3 className="modal-title">Nueva cita</h3>
          <button className="drawer-close" onClick={() => onOpenChange(false)}>×</button>
        </div>
        
        <div className="modal-body">
          <div className="sheet-field" style={{ position: "relative", zIndex: 50 }}>
            <label>Paciente / Contacto <span style={{ color: "red" }}>*</span></label>
            <ContactCombobox value={contact} onSelect={setContact} />
          </div>

          <div className="sheet-field">
            <label>Procedimiento</label>
            <select 
              className="sheet-select"
              value={procedureId}
              onChange={(e) => handleProcedureChange(e.target.value)}
            >
              <option value={NO_PROCEDURE}>Sin procedimiento</option>
              {procedures.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            {procedure && (
              <p style={{ fontSize: 12, marginTop: 4, color: "var(--text-sub)" }}>
                {procedure.duration_minutes} min
                {procedure.deposit_amount
                  ? ` · anticipo ${formatCurrency(procedure.deposit_amount, procedure.currency || CLINIC_CURRENCY)}`
                  : " · sin anticipo"}
              </p>
            )}
          </div>

          {doctors.length > 0 && (
            <div className="sheet-field">
              <label>Doctor</label>
              <select 
                className="sheet-select"
                value={doctorId}
                onChange={(e) => setDoctorId(e.target.value)}
              >
                <option value={NO_DOCTOR}>Sin asignar</option>
                {doctors.map((d) => (
                  <option key={d.user_id} value={d.user_id}>{d.full_name || "Doctor sin nombre"}</option>
                ))}
              </select>
            </div>
          )}

          <div className="sheet-field">
            <label>Tipo de cita</label>
            <select 
              className="sheet-select"
              value={type}
              onChange={(e) => setType(e.target.value as AppointmentType)}
            >
              {TYPE_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>

          <div className="sheet-grid">
            <div className="sheet-field">
              <label>Fecha <span style={{ color: "red" }}>*</span></label>
              <input 
                type="date" 
                className="input nums" 
                style={{ width: "100%" }}
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <div className="sheet-field">
              <label>Hora <span style={{ color: "red" }}>*</span></label>
              <input 
                type="time" 
                className="input nums" 
                style={{ width: "100%" }}
                step={300}
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </div>
          </div>

          <div className="sheet-grid">
            <div className="sheet-field">
              <label>Duración (minutos)</label>
              <input 
                type="number" 
                className="input nums" 
                style={{ width: "100%" }}
                min={5}
                max={720}
                step={5}
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
              />
            </div>
          </div>

          <div className="sheet-field">
            <label>Notas</label>
            <textarea 
              className="sheet-textarea" 
              placeholder="Notas internas de la cita..."
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancelar</button>
          <button className="btn primary" onClick={handleSubmit} disabled={saving}>
            {saving ? "Agendando..." : "Agendar cita"}
          </button>
        </div>
      </div>
    </>
  );
}
