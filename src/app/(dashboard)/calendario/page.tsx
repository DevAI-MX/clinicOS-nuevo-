"use client";

/**
 * Calendario — módulo V1 de clinicOS.
 *
 * Ensambla el hook useAgenda (datos + realtime) con la rejilla horaria,
 * el strip de KPIs y los diálogos de nueva cita / bloqueo / detalle.
 * Vista semana (default, lun→dom) y vista día, con navegación
 * anterior / hoy / siguiente. El look sigue el tema porcelana/petróleo
 * de clinicOS (bg-card, shadow-soft, badges por tono).
 */

import { useMemo, useState } from "react";
import "./calendar.css";
import { cn } from "@/lib/utils";
import { useAgenda } from "@/components/calendario/use-agenda";
import { KpiStrip } from "@/components/calendario/kpi-strip";
import { CalendarGrid } from "@/components/calendario/calendar-grid";
import { NewAppointmentDialog } from "@/components/calendario/new-appointment-dialog";
import { BlockScheduleDialog } from "@/components/calendario/block-schedule-dialog";
import { AppointmentSheet } from "@/components/calendario/appointment-sheet";
import {
  addDays,
  formatDayLong,
  formatWeekRange,
  mondayOf,
  startOfDay,
  weekDays,
} from "@/lib/clinic/calendar";

type ViewMode = "semana" | "dia" | "team";
type StatusFilter = "all" | "confirmada" | "deposit_pending" | "completada";

export default function CalendarioPage() {
  const [view, setView] = useState<ViewMode>("semana");
  // Ancla de navegación: para "semana" se normaliza al lunes; para "día"
  // es el día mismo (medianoche local).
  const [anchor, setAnchor] = useState<Date>(() => startOfDay(new Date()));
  const [newOpen, setNewOpen] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Filtro por doctor: "all" = todos, "unassigned" = sin doctor, o un user_id.
  const [doctorFilter, setDoctorFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  // Días visibles + rango [inicio, fin) que pide el hook.
  const { days, rangeStart, rangeEnd } = useMemo(() => {
    if (view === "dia") {
      const d = startOfDay(anchor);
      return { days: [d], rangeStart: d, rangeEnd: addDays(d, 1) };
    }
    const monday = mondayOf(anchor);
    return {
      days: weekDays(monday),
      rangeStart: monday,
      rangeEnd: addDays(monday, 7),
    };
  }, [view, anchor]);

  const { appointments, blocks, procedures, doctors, kpis, loading, refetch } =
    useAgenda(rangeStart, rangeEnd);

  // Índice de doctores por user_id, para colorear/etiquetar la rejilla.
  const doctorsById = useMemo(
    () => new Map(doctors.map((d) => [d.user_id, d])),
    [doctors],
  );

  // Citas visibles según el filtro de doctor, estado y búsqueda.
  const visibleAppointments = useMemo(() => {
    let list = appointments;

    if (doctorFilter !== "all") {
      list = list.filter((a) =>
        doctorFilter === "unassigned" ? !a.doctor_id : a.doctor_id === doctorFilter
      );
    }

    if (statusFilter === "confirmada") {
      list = list.filter((a) => a.status === "confirmada");
    } else if (statusFilter === "deposit_pending") {
      list = list.filter((a) => a.deposit_status === "pendiente");
    } else if (statusFilter === "completada") {
      list = list.filter((a) => a.status === "completada");
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter((a) => {
        const cName = (a.contact?.name || "").toLowerCase();
        const cPhone = (a.contact?.phone || "").toLowerCase();
        const pName = (a.procedure?.name || "").toLowerCase();
        return cName.includes(q) || cPhone.includes(q) || pName.includes(q);
      });
    }

    return list;
  }, [appointments, doctorFilter, statusFilter, searchQuery]);

  const selected =
    appointments.find((a) => a.id === selectedId) ?? null;

  const now = new Date();

  const goPrev = () =>
    setAnchor((a) => addDays(a, view === "dia" ? -1 : -7));
  const goNext = () =>
    setAnchor((a) => addDays(a, view === "dia" ? 1 : 7));
  const goToday = () => setAnchor(startOfDay(new Date()));

  const rangeLabel =
    view === "dia" ? formatDayLong(days[0]) : formatWeekRange(anchor);

  return (
    <div className="calendar-scope">
      <div className="app-shell">
        <main className="main">
          <section className="topbar">
            <div className="title-wrap">
              <div className="title-icon">⌁</div>
              <div>
                <h1>Calendario clínico</h1>
                <p className="subtitle">{view === "team" ? "Segmentación por doctor, sala o equipo médico" : `Agenda compartida · ${rangeLabel}`}</p>
              </div>
            </div>
            <div className="actions">
              <div className="input-wrap">
                <span>⌕</span>
                <input
                  className="input"
                  placeholder="Buscar paciente, teléfono o procedimiento..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <button className="btn ghost" onClick={() => setBlockOpen(true)}>⏸ Bloquear horario</button>
              <button className="btn primary" onClick={() => setNewOpen(true)}>＋ Nueva cita</button>
            </div>
          </section>

          <KpiStrip kpis={kpis} loading={loading} />

          <section className="control-deck">
            <div className="left-controls">
              <button className="btn icon" onClick={goPrev}>‹</button>
              <button className="btn small" onClick={goToday}>Hoy</button>
              <button className="btn icon" onClick={goNext}>›</button>
              <div className="segmented" aria-label="Vista">
                <button className={cn("segment", view === "semana" && "active")} onClick={() => setView("semana")}>Semana</button>
                <button className={cn("segment", view === "team" && "active")} onClick={() => setView("team")}>Equipo médico</button>
                <button className={cn("segment", view === "dia" && "active")} onClick={() => setView("dia")}>Día</button>
              </div>
              <div className="doctor-strip">
                <button
                  className={cn("chip", doctorFilter === "all" && "active")}
                  onClick={() => setDoctorFilter("all")}
                >
                  <span className="dot" style={{ background: "#0f4d4f" }}></span>Todos
                </button>
                {doctors.map(d => (
                  <button
                    key={d.user_id}
                    className={cn("chip", doctorFilter === d.user_id && "active")}
                    onClick={() => setDoctorFilter(d.user_id)}
                  >
                    <span className="dot" style={{ background: d.provider_color || "#7658a7" }}></span>{d.full_name?.split(" ")[0] || "Doctor"}
                  </button>
                ))}
                <button
                  className={cn("chip", doctorFilter === "unassigned" && "active")}
                  onClick={() => setDoctorFilter("unassigned")}
                >
                  <span className="dot" style={{ background: "#c78221" }}></span>Sin asignar
                </button>
              </div>
            </div>
            <div className="right-controls">
              <select
                className="select"
                title="Estado"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              >
                <option value="all">Todos los estados</option>
                <option value="confirmada">Confirmadas</option>
                <option value="deposit_pending">Anticipo pendiente</option>
                <option value="completada">Completadas</option>
              </select>
            </div>
          </section>

          <section className="workspace">
            <section className="calendar-card">
              <div className="calendar-toolbar">
                <div>
                  <div className="range">{view === "dia" ? "Día completo" : "Semana operativa"}</div>
                  <div className="microcopy">Mostrando 08:00–19:00 para reducir scroll vertical.</div>
                </div>
                <div className="legend">
                  <span>● Confirmada</span>
                  <span>● Anticipo pendiente</span>
                  <span>● Sin asignar</span>
                </div>
              </div>
              <div className="calendar-scroll">
                {visibleAppointments.length === 0 && (
                  <div className="empty show">No hay citas con estos filtros. Prueba "Todos los doctores" o limpia la búsqueda.</div>
                )}
                <CalendarGrid
                  days={days}
                  appointments={visibleAppointments}
                  blocks={blocks}
                  now={now}
                  doctorsById={doctorsById}
                  onSelectAppointment={setSelectedId}
                  onSelectDay={(day) => {
                    setView("dia");
                    setAnchor(startOfDay(day));
                  }}
                  viewMode={view}
                />
              </div>
            </section>

            <aside className="side">
              <section className="panel">
                <div className="panel-head">
                  <div className="panel-title">Agenda compartida</div>
                  <button className="btn small" onClick={() => setView("team")}>Ver por equipo</button>
                </div>
                <div className="panel-body">
                  {doctors.map(d => {
                    const count = visibleAppointments.filter(a => a.doctor_id === d.user_id).length;
                    const allCount = appointments.filter(a => a.doctor_id === d.user_id).length;
                    return (
                      <div key={d.user_id} className="doctor-card">
                        <div className="avatar" style={{ background: d.provider_color || "#0f4d4f" }}>
                          {d.full_name?.substring(0, 2).toUpperCase() || "DR"}
                        </div>
                        <div>
                          <h3>{d.full_name || "Doctor"}</h3>
                          <p>{(d as any).specialties?.[0] || "General"} · {allCount} citas semana</p>
                        </div>
                        <div className="load">{count}</div>
                      </div>
                    )
                  })}
                  <div className="doctor-card">
                    <div className="avatar" style={{ background: "#c78221" }}>SA</div>
                    <div>
                      <h3>Sin asignar</h3>
                      <p>Bandeja de recepción</p>
                    </div>
                    <div className="load">{visibleAppointments.filter(a => !a.doctor_id).length}</div>
                  </div>
                </div>
              </section>

              <section className="panel smart-panel">
                <div className="panel-head">
                  <div className="panel-title">Acciones inteligentes</div>
                  <button className="btn small" onClick={() => {
                    setDoctorFilter("all");
                    setStatusFilter("all");
                    setSearchQuery("");
                  }}>Limpiar</button>
                </div>
                <div className="panel-body">
                  <div className="queue-item">
                    <div className="queue-icon">↗</div>
                    <div className="queue-copy">
                      <strong>{appointments.filter(a => !a.doctor_id).length} citas sin doctor asignado</strong>
                      <span>Asignarlas antes de confirmar evita huecos y dobles agendas.</span>
                    </div>
                  </div>
                  <div className="queue-item">
                    <div className="queue-icon">$</div>
                    <div className="queue-copy">
                      <strong>{appointments.filter(a => a.deposit_status === "pendiente").length} anticipos pendientes</strong>
                      <span>Enviar recordatorio por WhatsApp antes de apartar horario premium.</span>
                    </div>
                  </div>
                </div>
              </section>
            </aside>
          </section>
        </main>
      </div>

      <NewAppointmentDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        procedures={procedures}
        doctors={doctors}
        defaultDate={days[0]}
        onCreated={refetch}
      />
      <BlockScheduleDialog
        open={blockOpen}
        onOpenChange={setBlockOpen}
        defaultDate={days[0]}
        onCreated={refetch}
      />
      <AppointmentSheet
        appointment={selected}
        open={selectedId !== null}
        doctors={doctors}
        onOpenChange={(o) => {
          if (!o) setSelectedId(null);
        }}
        onChanged={refetch}
      />
    </div>
  );
}
