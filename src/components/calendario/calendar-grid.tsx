"use client";

/**
 * CalendarGrid — rejilla horaria 07:00–21:00 para vista semana (7
 * columnas) o día (1 columna). Pinta citas como bloques posicionados
 * por hora (lado a lado si chocan), bloqueos de agenda con patrón
 * rayado y la línea de "ahora" en el día actual.
 */

import { cn } from "@/lib/utils";
import {
  formatDayShort,
  formatTime,
  gridPosition,
  hourLabels,
  isSameDay,
  layoutOverlaps,
  nowLinePct,
  segmentForDay,
} from "@/lib/clinic/calendar";
import type {
  AppointmentStatus,
  AppointmentWithRelations,
  Doctor,
  ScheduleBlock,
} from "@/lib/clinic/types";

/** Altura de una hora de rejilla, en px (14 filas → 784px). */
const HOUR_PX = 56;
const GRID_HEIGHT = hourLabels().length * HOUR_PX;

/** Estilo del bloque de cita por estado (regla del módulo: pendiente=
 *  warning, confirmada=primary, completada=success, cancelada y
 *  no_asistio en gris tachado). */
const BLOCK_STYLES: Record<
  AppointmentStatus,
  { container: string; bar: string; struck: boolean }
> = {
  pendiente: {
    container:
      "border-warning/30 bg-warning/15 hover:bg-warning/25 text-foreground",
    bar: "bg-warning",
    struck: false,
  },
  confirmada: {
    container:
      "border-primary/30 bg-primary/10 hover:bg-primary/20 text-foreground",
    bar: "bg-primary",
    struck: false,
  },
  completada: {
    container:
      "border-success/30 bg-success/10 hover:bg-success/20 text-foreground",
    bar: "bg-success",
    struck: false,
  },
  cancelada: {
    container:
      "border-border bg-muted/60 hover:bg-muted text-muted-foreground opacity-75",
    bar: "bg-muted-foreground/50",
    struck: true,
  },
  no_asistio: {
    container:
      "border-border bg-muted/60 hover:bg-muted text-muted-foreground opacity-75",
    bar: "bg-muted-foreground/50",
    struck: true,
  },
};

interface CalendarGridProps {
  /** Columnas a pintar: 7 días (semana) o 1 (día). Medianoche local. */
  days: Date[];
  appointments: AppointmentWithRelations[];
  blocks: ScheduleBlock[];
  now: Date;
  /** Doctor por user_id, para colorear/etiquetar la cita por doctor. */
  doctorsById?: Map<string, Doctor>;
  onSelectAppointment: (id: string) => void;
  /** Click en el encabezado de un día (la vista semana salta a día). */
  onSelectDay?: (day: Date) => void;
}

export function CalendarGrid({
  days,
  appointments,
  blocks,
  now,
  doctorsById,
  onSelectAppointment,
  onSelectDay,
}: CalendarGridProps) {
  const labels = hourLabels();
  const columns = `3.5rem repeat(${days.length}, minmax(0, 1fr))`;

  return (
    <div className="animate-fade-up overflow-hidden rounded-xl border border-border bg-card shadow-soft">
      {/* Encabezado de días */}
      <div
        className="grid border-b border-border"
        style={{ gridTemplateColumns: columns }}
      >
        <div />
        {days.map((day) => {
          const today = isSameDay(day, now);
          return (
            <div
              key={day.toISOString()}
              className="flex items-center justify-center border-l border-border py-2"
            >
              <button
                type="button"
                onClick={() => onSelectDay?.(day)}
                disabled={!onSelectDay}
                className={cn(
                  "nums rounded-full px-3 py-1 text-xs font-medium transition-colors",
                  today
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground",
                  onSelectDay && !today && "hover:bg-muted hover:text-foreground",
                )}
              >
                {formatDayShort(day)}
              </button>
            </div>
          );
        })}
      </div>

      {/* Cuerpo con scroll */}
      <div className="max-h-[70vh] overflow-y-auto">
        <div
          className="grid"
          style={{ gridTemplateColumns: columns, height: GRID_HEIGHT }}
        >
          {/* Gutter de horas */}
          <div className="relative">
            {labels.map((label, i) => (
              <span
                key={label}
                className="nums absolute right-2 -translate-y-1/2 text-[11px] text-muted-foreground"
                style={{ top: `${(i / labels.length) * 100}%` }}
              >
                {i === 0 ? "" : label}
              </span>
            ))}
          </div>

          {/* Columnas de día */}
          {days.map((day) => (
            <DayColumn
              key={day.toISOString()}
              day={day}
              appointments={appointments}
              blocks={blocks}
              now={now}
              doctorsById={doctorsById}
              onSelectAppointment={onSelectAppointment}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// Columna de un día
// ------------------------------------------------------------

function DayColumn({
  day,
  appointments,
  blocks,
  now,
  doctorsById,
  onSelectAppointment,
}: {
  day: Date;
  appointments: AppointmentWithRelations[];
  blocks: ScheduleBlock[];
  now: Date;
  doctorsById?: Map<string, Doctor>;
  onSelectAppointment: (id: string) => void;
}) {
  const labels = hourLabels();
  const isToday = isSameDay(day, now);
  const nowPct = isToday ? nowLinePct(now) : null;

  // Segmentos de cita que tocan este día (una cita que cruza medianoche
  // se pinta recortada en ambos días).
  const dayAppointments = appointments
    .map((appointment) => ({
      appointment,
      segment: segmentForDay(
        new Date(appointment.starts_at),
        new Date(appointment.ends_at),
        day,
      ),
    }))
    .filter(
      (
        x,
      ): x is {
        appointment: AppointmentWithRelations;
        segment: NonNullable<ReturnType<typeof segmentForDay>>;
      } => x.segment !== null,
    );

  const layout = layoutOverlaps(
    dayAppointments.map(({ appointment, segment }) => ({
      id: appointment.id,
      start: segment.start.getTime(),
      end: segment.end.getTime(),
    })),
  );

  const dayBlocks = blocks
    .map((block) => ({
      block,
      segment: segmentForDay(
        new Date(block.starts_at),
        new Date(block.ends_at),
        day,
      ),
    }))
    .filter((x) => x.segment !== null);

  return (
    <div className={cn("relative border-l border-border", isToday && "bg-primary/[0.03]")}>
      {/* Líneas de hora */}
      {labels.map((label, i) =>
        i === 0 ? null : (
          <div
            key={label}
            aria-hidden
            className="absolute inset-x-0 border-t border-border/60"
            style={{ top: `${(i / labels.length) * 100}%` }}
          />
        ),
      )}

      {/* Bloqueos de agenda (debajo de las citas) */}
      {dayBlocks.map(({ block, segment }) => {
        const pos = gridPosition(segment!.start, segment!.end);
        if (!pos) return null;
        return (
          <div
            key={block.id}
            title={block.reason ?? "Horario bloqueado"}
            className="absolute inset-x-0.5 z-0 overflow-hidden rounded-md border border-border bg-muted/50 px-1.5 py-1 bg-[repeating-linear-gradient(135deg,transparent,transparent_5px,var(--border)_5px,var(--border)_6px)]"
            style={{ top: `${pos.topPct}%`, height: `${pos.heightPct}%` }}
          >
            <p className="truncate text-[11px] font-medium text-muted-foreground">
              {block.reason || "Horario bloqueado"}
            </p>
            <p className="nums truncate text-[10px] text-muted-foreground/80">
              {formatTime(new Date(block.starts_at))} –{" "}
              {formatTime(new Date(block.ends_at))}
            </p>
          </div>
        );
      })}

      {/* Citas */}
      {dayAppointments.map(({ appointment, segment }) => {
        const pos = gridPosition(segment.start, segment.end);
        if (!pos) return null;
        const slot = layout.get(appointment.id) ?? { column: 0, columns: 1 };
        const style = BLOCK_STYLES[appointment.status];
        const width = 100 / slot.columns;

        // Doctor asignado: si tiene color propio, la barra izquierda lo
        // usa (mientras la cita esté activa; canceladas/no-asistió quedan
        // en gris tachado, sin sobrescribir). El nombre corto va en el
        // subtítulo para distinguir doctores de un vistazo.
        const doctor = appointment.doctor_id
          ? doctorsById?.get(appointment.doctor_id)
          : undefined;
        const doctorFirstName = doctor?.full_name?.trim().split(/\s+/)[0];
        const useDoctorColor =
          !style.struck && !!doctor?.provider_color;

        return (
          <button
            key={appointment.id}
            type="button"
            onClick={() => onSelectAppointment(appointment.id)}
            className={cn(
              "absolute z-10 flex items-stretch overflow-hidden rounded-xl border text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md",
              style.container,
            )}
            style={{
              top: `${pos.topPct}%`,
              height: `${pos.heightPct}%`,
              left: `calc(${slot.column * width}% + 2px)`,
              width: `calc(${width}% - 4px)`,
            }}
          >
            <span
              aria-hidden
              className={cn(
                "w-1.5 shrink-0",
                !useDoctorColor && style.bar,
              )}
              style={
                useDoctorColor
                  ? { backgroundColor: doctor!.provider_color! }
                  : undefined
              }
            />
            <span className="min-w-0 flex-1 flex flex-col py-1.5 px-2">
              <span
                className={cn(
                  "block truncate text-xs font-bold leading-tight",
                  style.struck && "line-through",
                )}
              >
                {appointment.contact?.name ||
                  appointment.contact?.phone ||
                  "Sin contacto"}
              </span>
              <span
                className={cn(
                  "nums mt-0.5 block truncate text-[10px] leading-tight text-foreground/75",
                  style.struck && "line-through",
                )}
              >
                {formatTime(new Date(appointment.starts_at))}
                {appointment.procedure ? ` · ${appointment.procedure.name}` : ""}
                {doctorFirstName ? ` · ${doctorFirstName}` : ""}
              </span>
              <div className="mt-auto flex items-center justify-end pt-1 gap-1">
                {appointment.status === "completada" ? (
                  <span className="inline-flex items-center rounded-full border border-success/30 bg-success/10 px-1.5 py-0.5 text-[9px] font-bold text-success">
                    Completada
                  </span>
                ) : appointment.deposit_status === "pagado" ? (
                  <span className="inline-flex items-center rounded-full border border-success/30 bg-success/10 px-1.5 py-0.5 text-[9px] font-bold text-success">
                    Pagado
                  </span>
                ) : null}
              </div>
            </span>
          </button>
        );
      })}

      {/* Línea de "ahora" */}
      {nowPct !== null && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 z-20"
          style={{ top: `${nowPct}%` }}
        >
          <div className="relative h-px bg-destructive">
            <span className="absolute -left-0.5 -top-[3px] size-[7px] rounded-full bg-destructive" />
          </div>
        </div>
      )}
    </div>
  );
}
