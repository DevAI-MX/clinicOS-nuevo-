"use client";

import { cn } from "@/lib/utils";
import {
  formatTime,
  isSameDay,
  layoutOverlaps,
  segmentForDay,
} from "@/lib/clinic/calendar";
import type {
  AppointmentStatus,
  AppointmentWithRelations,
  Doctor,
  ScheduleBlock,
} from "@/lib/clinic/types";

const statusLabel = (s: AppointmentStatus) =>
  s === "pendiente"
    ? "Pendiente"
    : s === "completada"
    ? "Lista"
    : s === "confirmada"
    ? "Confirmada"
    : "Cancelada";

const statusColor = (s: AppointmentStatus) =>
  s === "pendiente"
    ? "#f3ddb8"
    : s === "completada"
    ? "#e4e1dc"
    : s === "cancelada"
    ? "#e4e1dc"
    : "#d9f0ec";

const docName = (id?: string | null, map?: Map<string, Doctor>) => {
  if (!id || !map) return "Sin asignar";
  return map.get(id)?.full_name?.split(" ")[0] || "Doctor";
};

const docColor = (id?: string | null, map?: Map<string, Doctor>) => {
  if (!id || !map) return "#c78221";
  return map.get(id)?.provider_color || "#7658a7";
};

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

interface CalendarGridProps {
  days: Date[];
  appointments: AppointmentWithRelations[];
  blocks: ScheduleBlock[];
  now: Date;
  doctorsById?: Map<string, Doctor>;
  onSelectAppointment: (id: string) => void;
  onSelectDay?: (day: Date) => void;
  viewMode?: "semana" | "dia" | "team";
}

export function CalendarGrid({
  days,
  appointments,
  blocks,
  now,
  doctorsById,
  onSelectAppointment,
  onSelectDay,
  viewMode = "semana",
}: CalendarGridProps) {
  const startHour = 8;
  const endHour = 19;
  const labelsToShow = [];
  for (let i = startHour; i < endHour; i++) {
    labelsToShow.push(`${String(i).padStart(2, "0")}:00`);
  }

  if (viewMode === "team") {
    const doctors = Array.from(doctorsById?.values() || []);
    return (
      <div className="calendar-grid team-agenda active" style={{ "--columns": doctors.length + 1 } as any}>
        <div className="corner">GMT-6</div>
        {doctors.map((d) => (
          <div key={d.user_id} className="team-head">
            <div className="avatar" style={{ background: d.provider_color || "#0f4d4f" }}>
              {d.full_name?.substring(0, 2).toUpperCase()}
            </div>
            <div>
              <strong>{d.full_name?.split(" ")[0]}</strong>
              <br />
              <span className="microcopy">{(d as any).specialties?.[0] || "General"}</span>
            </div>
          </div>
        ))}
        <div className="team-head">
          <div className="avatar" style={{ background: "#c78221" }}>
            SA
          </div>
          <div>
            <strong>Sin asignar</strong>
            <br />
            <span className="microcopy">Recepción</span>
          </div>
        </div>

        <div className="time-col">
          {labelsToShow.map((label) => (
            <div key={label} className="time-cell">
              {label}
            </div>
          ))}
        </div>

        {doctors.map((d) => (
          <DayColumn
            key={d.user_id}
            day={days[0]}
            appointments={appointments.filter((a) => a.doctor_id === d.user_id)}
            blocks={blocks}
            now={now}
            doctorsById={doctorsById}
            onSelectAppointment={onSelectAppointment}
            startHour={startHour}
            endHour={endHour}
          />
        ))}
        <DayColumn
          key="unassigned"
          day={days[0]}
          appointments={appointments.filter((a) => !a.doctor_id)}
          blocks={blocks}
          now={now}
          doctorsById={doctorsById}
          onSelectAppointment={onSelectAppointment}
          startHour={startHour}
          endHour={endHour}
        />
      </div>
    );
  }

  const daysToShow = viewMode === "dia" ? [days[0]] : days;

  const nowHour = now.getHours() + now.getMinutes() / 60;
  const showNowLine =
    daysToShow.some((d) => isSameDay(d, now)) &&
    nowHour >= startHour &&
    nowHour <= endHour;
  const HEADER_HEIGHT_PX = 56;

  return (
    <>
      {showNowLine && (
        <div
          className="now-line"
          style={{
            top: `calc(${HEADER_HEIGHT_PX}px + ${nowHour - startHour} * var(--hour-h))`,
          }}
        />
      )}
      <div className="calendar-grid week-agenda" style={{ "--columns": daysToShow.length } as any}>
        <div className="corner">GMT-6</div>
        {daysToShow.map((day) => {
          const today = isSameDay(day, now);
          const weekdayShort = capitalize(
            day.toLocaleDateString("es-MX", { weekday: "short" }).replace(/\.$/, ""),
          );
          const weekdayLong = capitalize(day.toLocaleDateString("es-MX", { weekday: "long" }));
          return (
            <div key={day.toISOString()} className={cn("day-head", today && "today")}>
              <div>
                <strong>
                  {weekdayShort} {day.getDate()}
                </strong>
                <br />
                <span>{weekdayLong}</span>
              </div>
              {onSelectDay && (
                <button className="btn small" onClick={() => onSelectDay(day)}>
                  ＋
                </button>
              )}
            </div>
          );
        })}

        <div className="time-col">
          {labelsToShow.map((label) => (
            <div key={label} className="time-cell">
              {label}
            </div>
          ))}
        </div>

        {daysToShow.map((day) => (
          <DayColumn
            key={day.toISOString()}
            day={day}
            appointments={appointments}
            blocks={blocks}
            now={now}
            doctorsById={doctorsById}
            onSelectAppointment={onSelectAppointment}
            startHour={startHour}
            endHour={endHour}
          />
        ))}
      </div>
    </>
  );
}

function DayColumn({
  day,
  appointments,
  blocks,
  now,
  doctorsById,
  onSelectAppointment,
  startHour,
  endHour,
}: {
  day: Date;
  appointments: AppointmentWithRelations[];
  blocks: ScheduleBlock[];
  now: Date;
  doctorsById?: Map<string, Doctor>;
  onSelectAppointment: (id: string) => void;
  startHour: number;
  endHour: number;
}) {
  const dayAppointments = appointments
    .map((appointment) => ({
      appointment,
      segment: segmentForDay(new Date(appointment.starts_at), new Date(appointment.ends_at), day),
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
      segment: segmentForDay(new Date(block.starts_at), new Date(block.ends_at), day),
    }))
    .filter(
      (x): x is { block: ScheduleBlock; segment: NonNullable<ReturnType<typeof segmentForDay>> } =>
        x.segment !== null,
    );

  return (
    <div className="day-col" style={{ minHeight: `calc(var(--hour-h) * ${endHour - startHour})` }}>
      {dayBlocks.map(({ block, segment }) => {
        const hStart = segment.start.getHours() + segment.start.getMinutes() / 60;
        const hEnd = segment.end.getHours() + segment.end.getMinutes() / 60;

        if (hEnd <= startHour || hStart >= endHour) return null;

        const topHrs = Math.max(0, hStart - startHour);
        const durationHrs = Math.min(endHour, hEnd) - Math.max(startHour, hStart);

        return (
          <div
            key={block.id}
            className="schedule-block"
            title={block.reason ?? "Horario bloqueado"}
            style={{
              top: `calc(${topHrs} * var(--hour-h))`,
              height: `calc(${durationHrs} * var(--hour-h))`,
            }}
          >
            <div className="name">{block.reason || "Horario bloqueado"}</div>
            <div className="time">
              {formatTime(segment.start)} – {formatTime(segment.end)}
            </div>
          </div>
        );
      })}
      {dayAppointments.map(({ appointment, segment }) => {
        const hStart = segment.start.getHours() + segment.start.getMinutes() / 60;
        const hEnd = segment.end.getHours() + segment.end.getMinutes() / 60;

        if (hEnd <= startHour || hStart >= endHour) return null;

        const topHrs = Math.max(0, hStart - startHour);
        const durationHrs = Math.min(endHour, hEnd) - Math.max(startHour, hStart);

        const topPx = `calc(${topHrs} * var(--hour-h))`;
        const heightPx = `calc(max(38px, ${durationHrs} * var(--hour-h) - 6px))`;

        const slot = layout.get(appointment.id) ?? { column: 0, columns: 1 };
        const width = 100 / slot.columns;

        return (
          <button
            key={appointment.id}
            className="appointment"
            onClick={() => onSelectAppointment(appointment.id)}
            style={{
              top: topPx,
              height: heightPx,
              left: `calc(${slot.column * width}% + 6px)`,
              width: `calc(${width}% - 12px)`,
              background: statusColor(appointment.status),
              borderLeft: `5px solid ${docColor(appointment.doctor_id, doctorsById)}`,
            }}
          >
            <span className="tag">{statusLabel(appointment.status)}</span>
            <div className="time">
              {formatTime(new Date(appointment.starts_at))} · {Math.round(durationHrs * 60)} min
            </div>
            <div className="name">
              {appointment.contact?.name || appointment.contact?.phone || "Sin contacto"}
            </div>
            <div className="meta">
              {appointment.procedure?.name || "Cita"} · {docName(appointment.doctor_id, doctorsById)}
            </div>
          </button>
        );
      })}
    </div>
  );
}
