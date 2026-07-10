"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { nudgeCalendarSync } from "@/lib/integrations/google/nudge-client";
import {
  confirmDepositRequest,
  confirmDepositToast,
} from "@/lib/clinic/confirm-deposit-client";
import { toast } from "sonner";
import { useCan } from "@/hooks/use-can";
import { formatCurrency } from "@/lib/currency";
import { formatDayLong, formatTime } from "@/lib/clinic/calendar";
import {
  APPOINTMENT_TYPE_LABEL,
} from "@/lib/clinic/status-maps";
import {
  CLINIC_CURRENCY,
  type AppointmentStatus,
  type AppointmentWithRelations,
  type Doctor,
} from "@/lib/clinic/types";
import { cn } from "@/lib/utils";

const NO_DOCTOR = "none";

interface AppointmentSheetProps {
  appointment: AppointmentWithRelations | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doctors: Doctor[];
  onChanged: () => void;
}

export function AppointmentSheet({
  appointment,
  open,
  onOpenChange,
  doctors,
  onChanged,
}: AppointmentSheetProps) {
  const supabase = createClient();
  const canAct = useCan("send-messages");
  const [pending, setPending] = useState<string | null>(null);

  // States for edit
  const [draftDoctor, setDraftDoctor] = useState<string | null>(null);
  const [draftStatus, setDraftStatus] = useState<AppointmentStatus | null>(null);
  const [draftNotes, setDraftNotes] = useState<string | null>(null);

  const currentDoctorId = draftDoctor !== null ? draftDoctor : (appointment?.doctor_id || NO_DOCTOR);
  const currentStatus = draftStatus !== null ? draftStatus : appointment?.status;
  const currentNotes = draftNotes !== null ? draftNotes : (appointment?.notes || "");

  async function updateStatus(status: AppointmentStatus, message: string) {
    if (!appointment) return;
    setPending(status);
    const { error } = await supabase
      .from("appointments")
      .update({ status })
      .eq("id", appointment.id);
    if (error) {
      toast.error("No se pudo actualizar la cita");
    } else {
      toast.success(message);
      onChanged();
      nudgeCalendarSync();
    }
    setPending(null);
  }

  async function saveChanges() {
    if (!appointment) return;
    setPending("save");
    
    const updates: any = {};
    if (draftDoctor !== null) {
      updates.doctor_id = draftDoctor === NO_DOCTOR ? null : draftDoctor;
    }
    if (draftStatus !== null) {
      updates.status = draftStatus;
    }
    if (draftNotes !== null) {
      updates.notes = draftNotes;
    }

    if (Object.keys(updates).length > 0) {
      const { error } = await supabase
        .from("appointments")
        .update(updates)
        .eq("id", appointment.id);
      
      if (error) {
        toast.error("No se pudieron guardar los cambios");
      } else {
        toast.success("Cambios guardados");
        onChanged();
        nudgeCalendarSync();
      }
    }
    setPending(null);
    onOpenChange(false);
  }

  async function markDepositPaid() {
    if (!appointment) return;
    setPending("deposit");
    try {
      const result = await confirmDepositRequest(appointment.id);
      toast.success(confirmDepositToast(result.whatsapp));
      onChanged();
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "No se pudo confirmar el anticipo";
      toast.error(message);
    } finally {
      setPending(null);
    }
  }

  if (!appointment) return null;

  const starts = new Date(appointment.starts_at);
  const ends = new Date(appointment.ends_at);
  const isActive = appointment.status === "pendiente" || appointment.status === "confirmada";

  const isCompleted = appointment.status === "completada";
  const isPending = appointment.status === "pendiente" || appointment.deposit_status === "pendiente";
  const isPaid = appointment.deposit_status === "pagado" || appointment.status === "confirmada" || isCompleted;

  return (
    <div className="calendar-scope">
      <div className={cn("drawer-backdrop", open && "open")} onClick={() => onOpenChange(false)}></div>
      <aside className={cn("drawer", open && "open")} aria-label="Detalle de cita">
        <div className="drawer-header">
          <div>
            <h2 className="drawer-title">{appointment.contact?.name || appointment.contact?.phone || "Cita"}</h2>
            <p className="drawer-sub">
              {APPOINTMENT_TYPE_LABEL[appointment.appointment_type]} · {formatDayLong(starts)}, {formatTime(starts)}–{formatTime(ends)}
            </p>
            <div className="status-row">
              <span className={cn("status-pill", isPending ? "deposit pending" : "confirmed")}>
                <span className="pill-dot"></span>
                <span>{isCompleted ? "Completada" : isPending ? "Pendiente" : "Confirmada"}</span>
              </span>
              <span className={cn("status-pill deposit", !isPaid && "pending")}>
                <span className="pill-dot"></span>
                <span>{isPaid ? "Anticipo pagado" : "Anticipo pendiente"}</span>
              </span>
            </div>
          </div>
          <button className="drawer-close" onClick={() => onOpenChange(false)} aria-label="Cerrar">×</button>
        </div>

        <div className="drawer-body">
          <section className="sheet-card">
            <div className="sheet-card-header">
              <div className="sheet-label">Contacto</div>
              <Link href="/contacts" className="crm-chip">Ver CRM ↗</Link>
            </div>
            <div className="contact-row">
              <div className="sheet-icon">◌</div>
              <div>
                <div className="sheet-main">{appointment.contact?.name || "Sin nombre"}</div>
                <div className="sheet-sub">Paciente</div>
              </div>
            </div>
            {appointment.contact?.phone && (
              <div className="contact-row">
                <div className="sheet-icon">◔</div>
                <div>
                  <div className="sheet-value">{appointment.contact.phone}</div>
                  <div className="sheet-sub">WhatsApp / Teléfono</div>
                </div>
              </div>
            )}
            {canAct && appointment.contact?.phone && (
              <button 
                className="wa-btn full" 
                onClick={() => toast.success("Abriendo WhatsApp...")}
              >
                ◔ Enviar WhatsApp
              </button>
            )}
          </section>

          <section className="sheet-card">
            <div className="sheet-card-header"><div className="sheet-label">Procedimiento</div></div>
            <div className="contact-row" style={{ marginBottom: 0 }}>
              <div className="sheet-icon">⚕</div>
              <div>
                <div className="sheet-main">{appointment.procedure?.name ?? <span className="italic text-muted-foreground">Sin procedimiento</span>}</div>
                {appointment.procedure && (appointment.procedure.price_min != null || appointment.procedure.price_max != null) && (
                  <div className="sheet-sub">
                    <span>
                      {formatPriceRange(
                        appointment.procedure.price_min,
                        appointment.procedure.price_max,
                        appointment.procedure.currency
                      )}
                    </span> precio base
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className="sheet-card">
            <div className="sheet-card-header"><div className="sheet-label">Anticipo y estado</div></div>
            <div className="price-row">
              <div>
                <div className="amount hero">
                  {appointment.deposit_amount ? formatCurrency(appointment.deposit_amount, appointment.procedure?.currency || CLINIC_CURRENCY) : "—"}
                </div>
                <div className="amount-sub">{appointment.deposit_amount ? (isPaid ? "Anticipo registrado" : "Pendiente por registrar") : "Sin anticipo requerido"}</div>
              </div>
              <span className={cn("mini-pill", !isPaid && "warning")}>
                {isPaid ? "Anticipo pagado" : "Anticipo pendiente"}
              </span>
            </div>
            {appointment.deposit_status === "pendiente" && isActive && canAct && (
              <button
                onClick={markDepositPaid}
                disabled={pending !== null}
                className="btn outline-strong full mt-3"
              >
                {pending === "deposit" ? "Cargando..." : "Marcar anticipo pagado"}
              </button>
            )}
          </section>

          <section className="sheet-card">
            <div className="sheet-card-header"><div className="sheet-label">Configuración interna</div></div>
            <div className="sheet-grid">
              <div className="sheet-field">
                <label>Doctor / equipo</label>
                <select 
                  className="sheet-select" 
                  value={currentDoctorId as string}
                  onChange={(e) => setDraftDoctor(e.target.value)}
                >
                  <option value={NO_DOCTOR}>Sin asignar</option>
                  {doctors.map(d => (
                    <option key={d.user_id} value={d.user_id}>{d.full_name || "Doctor"}</option>
                  ))}
                </select>
              </div>
              <div className="sheet-field">
                <label>Estado comercial</label>
                <select 
                  className="sheet-select"
                  value={currentStatus || "pendiente"}
                  onChange={(e) => setDraftStatus(e.target.value as AppointmentStatus)}
                >
                  <option value="pendiente">Pendiente</option>
                  <option value="confirmada">Confirmada</option>
                  <option value="completada">Completada</option>
                </select>
              </div>
            </div>
            <div className="sheet-field" style={{ marginTop: 10 }}>
              <label>Notas para recepción</label>
              <textarea 
                className="sheet-textarea" 
                value={currentNotes}
                onChange={(e) => setDraftNotes(e.target.value)}
              />
            </div>
          </section>
        </div>

        {canAct && (
          <div className="drawer-footer">
            <button 
              className="btn outline-strong full" 
              onClick={saveChanges}
              disabled={pending !== null}
            >
              ✓ Guardar / Actualizar
            </button>
            {isActive && (
              <button 
                className="btn subtle-danger full" 
                onClick={() => updateStatus("cancelada", "Cita cancelada")}
                disabled={pending !== null}
              >
                ⊗ Cancelar cita
              </button>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

function formatPriceRange(
  min: number | null,
  max: number | null,
  currency: string,
): string {
  const code = currency || CLINIC_CURRENCY;
  if (min != null && max != null && min !== max) {
    return `${formatCurrency(min, code)} – ${formatCurrency(max, code)}`;
  }
  const value = min ?? max;
  return value != null ? formatCurrency(value, code) : "";
}
