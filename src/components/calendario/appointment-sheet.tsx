"use client";

/**
 * AppointmentSheet — detalle lateral de una cita con sus acciones.
 *
 * Regla de oro del legacy (migración 031): la IA solo PREVALIDA pagos;
 * un humano los confirma aquí. "Marcar anticipo pagado" confirma (o
 * crea) el Payment, pone deposit_status='pagado' y sube la cita de
 * 'pendiente' a 'confirmada'.
 */

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { nudgeCalendarSync } from "@/lib/integrations/google/nudge-client";
import {
  confirmDepositRequest,
  confirmDepositToast,
} from "@/lib/clinic/confirm-deposit-client";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MetaBadge } from "@/components/shared/status-badge";
import { useCan } from "@/hooks/use-can";
import { formatCurrency } from "@/lib/currency";
import { formatDayLong, formatTime } from "@/lib/clinic/calendar";
import {
  APPOINTMENT_STATUS,
  APPOINTMENT_TYPE_LABEL,
  DEPOSIT_STATUS,
} from "@/lib/clinic/status-maps";
import {
  CLINIC_CURRENCY,
  type AppointmentStatus,
  type AppointmentWithRelations,
  type Doctor,
} from "@/lib/clinic/types";
import {
  BanknoteIcon,
  CheckCheck,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Phone,
  Stethoscope,
  User,
  UserRound,
  XCircle,
  MessageCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

/** Centinela del select de doctor para "sin asignar". */
const NO_DOCTOR = "none";

interface AppointmentSheetProps {
  appointment: AppointmentWithRelations | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Doctores asignables (perfiles con is_provider). Vacío = no se
   *  muestra el selector de doctor. */
  doctors: Doctor[];
  /** Refresca la agenda tras una acción (el sheet queda abierto y se
   *  re-renderiza con la cita actualizada que le pasa el padre). */
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
  /** Acción en curso, para el spinner del botón correspondiente. */
  const [pending, setPending] = useState<string | null>(null);

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
      // Propaga el nuevo estado (o el borrado, si se canceló) a Google.
      nudgeCalendarSync();
    }
    setPending(null);
  }

  async function updateDoctor(nextDoctorId: string) {
    if (!appointment) return;
    const doctorId = nextDoctorId === NO_DOCTOR ? null : nextDoctorId;
    if (doctorId === appointment.doctor_id) return;
    setPending("doctor");
    const { error } = await supabase
      .from("appointments")
      .update({ doctor_id: doctorId })
      .eq("id", appointment.id);
    if (error) {
      toast.error("No se pudo reasignar el doctor");
    } else {
      toast.success(doctorId ? "Doctor asignado" : "Doctor quitado");
      onChanged();
      // El color del evento en Google depende del doctor: resincroniza.
      nudgeCalendarSync();
    }
    setPending(null);
  }

  /**
   * Confirma el anticipo vía POST /api/appointments/[id]/confirm-deposit
   * (el mismo camino que el botón "Confirmar pago" del CRM y del
   * inbox): Payment → 'confirmado', deposit_status='pagado', la cita
   * pendiente pasa a 'confirmada', se avisa al paciente por WhatsApp,
   * queda la notificación interna y Google Calendar se sincroniza en
   * el servidor.
   */
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
  const statusMeta = APPOINTMENT_STATUS[appointment.status];
  const depositMeta = DEPOSIT_STATUS[appointment.deposit_status];
  const isActive =
    appointment.status === "pendiente" || appointment.status === "confirmada";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex flex-col w-full px-0 sm:max-w-md bg-background/95 backdrop-blur-xl">
        <SheetHeader className="px-6 pb-4 border-b border-border">
          <div className="flex items-start justify-between gap-4 pr-6">
            <div>
              <SheetTitle className="truncate text-xl">
                {appointment.contact?.name ||
                  appointment.contact?.phone ||
                  "Cita"}
              </SheetTitle>
              <SheetDescription className="mt-1 first-letter:uppercase">
                {APPOINTMENT_TYPE_LABEL[appointment.appointment_type]} · {formatDayLong(starts)}, {formatTime(starts)}–{formatTime(ends)}
              </SheetDescription>
            </div>
          </div>
          <div className="flex gap-2 flex-wrap mt-3">
            <MetaBadge
              meta={statusMeta}
              dot
              pulse={appointment.status === "pendiente"}
            />
            <MetaBadge
              meta={depositMeta}
              dot
              pulse={appointment.deposit_status === "pendiente"}
            />
          </div>
        </SheetHeader>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4 bg-muted/20">
          
          {/* Contacto */}
          <div className="rounded-[18px] border border-border bg-card p-4 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Contacto</p>
              <Link
                href="/contacts"
                className="rounded-full border border-border bg-background px-3 py-1 text-[11px] font-semibold hover:bg-muted transition-colors inline-flex items-center gap-1"
              >
                Ver CRM <ExternalLink className="size-3" />
              </Link>
            </div>
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="flex size-[30px] shrink-0 items-center justify-center rounded-xl bg-muted text-foreground/70">
                  <User className="size-4" />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-[15px] font-bold leading-tight">
                    {appointment.contact?.name || "Sin nombre"}
                  </p>
                  <p className="text-[12px] text-muted-foreground mt-0.5">Paciente</p>
                </div>
              </div>
              {appointment.contact?.phone && (
                <div className="flex items-center gap-3">
                  <div className="flex size-[30px] shrink-0 items-center justify-center rounded-xl bg-muted text-foreground/70">
                    <Phone className="size-4" />
                  </div>
                  <div className="min-w-0">
                    <p className="nums truncate text-[15px] font-bold leading-tight">
                      {appointment.contact.phone}
                    </p>
                    <p className="text-[12px] text-muted-foreground mt-0.5">WhatsApp / Teléfono</p>
                  </div>
                </div>
              )}
              {canAct && appointment.contact?.phone && (
                <Button
                  className="w-full mt-2 gap-2 bg-primary text-primary-foreground hover:bg-primary/90"
                  onClick={() => {
                     // TODO: Lógica para abrir WhatsApp (fuera del alcance de UI por ahora, o un href)
                     toast.success("Abriendo WhatsApp...");
                  }}
                >
                  <MessageCircle className="size-4" />
                  Enviar WhatsApp
                </Button>
              )}
            </div>
          </div>

          {/* Procedimiento */}
          <div className="rounded-[18px] border border-border bg-card p-4 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Procedimiento</p>
            </div>
            <div className="space-y-3">
              <div className="flex items-start gap-3">
                <div className="flex size-[30px] shrink-0 items-center justify-center rounded-xl bg-muted text-foreground/70 mt-0.5">
                  <Stethoscope className="size-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-[15px] font-bold leading-tight">
                    {appointment.procedure?.name ?? (
                      <span className="italic text-muted-foreground">
                        Sin procedimiento
                      </span>
                    )}
                  </p>
                  {appointment.procedure &&
                   (appointment.procedure.price_min != null ||
                    appointment.procedure.price_max != null) && (
                    <p className="nums text-[13px] text-muted-foreground mt-1 font-medium">
                      {formatPriceRange(
                        appointment.procedure.price_min,
                        appointment.procedure.price_max,
                        appointment.procedure.currency,
                      )} <span className="font-normal text-[11px]">precio base</span>
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Doctor asignado */}
          {(doctors.length > 0 || appointment.doctor_id) && (
            <div className="rounded-[18px] border border-border bg-card p-4 shadow-sm">
              <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-3">
                Doctor
              </p>
              {canAct && doctors.length > 0 ? (
                <Select
                  value={appointment.doctor_id ?? NO_DOCTOR}
                  onValueChange={(v) => v && updateDoctor(v as string)}
                >
                  <SelectTrigger
                    className="w-full border-border bg-muted text-foreground"
                    disabled={pending !== null}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-border bg-popover">
                    <SelectItem value={NO_DOCTOR}>Sin asignar</SelectItem>
                    {doctors.map((d) => (
                      <SelectItem key={d.user_id} value={d.user_id}>
                        {d.full_name || "Doctor sin nombre"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <div className="flex items-center gap-3">
                  <div className="flex size-[30px] shrink-0 items-center justify-center rounded-xl bg-muted text-foreground/70">
                    <UserRound className="size-4" />
                  </div>
                  <p className="text-[15px] font-bold">
                    {doctors.find((d) => d.user_id === appointment.doctor_id)
                      ?.full_name ?? (
                      <span className="italic text-muted-foreground">
                        Sin asignar
                      </span>
                    )}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Anticipo y Timeline */}
          <div className="rounded-[18px] border border-border bg-card p-4 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                Anticipo y Estado
              </p>
            </div>
            
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="nums text-[21px] font-bold tracking-tight">
                  {appointment.deposit_amount
                    ? formatCurrency(
                        appointment.deposit_amount,
                        appointment.procedure?.currency || CLINIC_CURRENCY,
                      )
                    : "—"}
                </p>
                <p className="text-[13px] text-muted-foreground mt-0.5">Anticipo</p>
              </div>
              <MetaBadge meta={depositMeta} />
            </div>

            <div className="mt-5 flex gap-2">
              <TimelineStep label="Lead" state="done" />
              <TimelineStep label="Anticipo" state={appointment.deposit_status === "pagado" ? "done" : "active"} />
              <TimelineStep label="Cita" state={appointment.status === "completada" ? "done" : (appointment.status === "confirmada" ? "active" : "pending")} />
              <TimelineStep label="Completada" state={appointment.status === "completada" ? "done" : "pending"} />
            </div>
          </div>

          {/* Notas */}
          {appointment.notes && (
            <div className="rounded-[18px] border border-border bg-card p-4 shadow-sm">
              <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-2">
                Notas internas
              </p>
              <p className="whitespace-pre-wrap text-sm text-foreground leading-relaxed">
                {appointment.notes}
              </p>
            </div>
          )}
        </div>

        {/* Acciones */}
        {canAct && (
          <div className="px-6 pb-6 pt-4 bg-background/95 border-t border-border shadow-[0_-10px_20px_rgba(0,0,0,0.02)]">
            <div className="grid gap-2">
            {appointment.deposit_status === "pendiente" && isActive && (
              <Button
                onClick={markDepositPaid}
                disabled={pending !== null}
                className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {pending === "deposit" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <BanknoteIcon className="size-4" />
                )}
                Marcar anticipo pagado
              </Button>
            )}
            {appointment.status === "pendiente" && (
              <Button
                variant="outline"
                onClick={() => updateStatus("confirmada", "Cita confirmada")}
                disabled={pending !== null}
                className="w-full border-border"
              >
                {pending === "confirmada" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="size-4" />
                )}
                Confirmar cita
              </Button>
            )}
            {isActive && (
              <Button
                variant="outline"
                onClick={() => updateStatus("completada", "Cita completada")}
                disabled={pending !== null}
                className="w-full border-border"
              >
                {pending === "completada" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <CheckCheck className="size-4" />
                )}
                Marcar completada
              </Button>
            )}
            {isActive && (
              <Button
                variant="ghost"
                onClick={() => updateStatus("cancelada", "Cita cancelada")}
                disabled={pending !== null}
                className="w-full text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                {pending === "cancelada" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <XCircle className="size-4" />
                )}
                Cancelar cita
              </Button>
            )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
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

function TimelineStep({ label, state }: { label: string; state: "done" | "active" | "pending" }) {
  return (
    <div className="flex-1 min-w-0">
      <div className={cn(
        "h-[5px] rounded-full mb-[7px]",
        state === "done" ? "bg-success" : state === "active" ? "bg-primary" : "bg-muted"
      )} />
      <p className="text-[10.5px] text-muted-foreground truncate">{label}</p>
    </div>
  );
}
