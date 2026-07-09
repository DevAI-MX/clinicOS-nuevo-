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
import {
  CalendarDays,
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  Lock,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

type ViewMode = "semana" | "dia";
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
    <div className="flex h-full flex-col gap-4">
      {/* Encabezado */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <CalendarDays className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-foreground">
              Calendario
            </h1>
            <p className="text-xs capitalize text-muted-foreground">
              {rangeLabel}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative hidden sm:block">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Buscar cita..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-9 w-64 pl-9 bg-background"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setBlockOpen(true)}
            className="gap-1.5"
          >
            <Lock className="h-4 w-4" />
            <span className="hidden sm:inline">Bloquear horario</span>
          </Button>
          <Button
            size="sm"
            onClick={() => setNewOpen(true)}
            className="gap-1.5"
          >
            <CalendarPlus className="h-4 w-4" />
            Nueva cita
          </Button>
        </div>
      </div>

      {/* KPIs */}
      <KpiStrip kpis={kpis} loading={loading} />

      {/* Controles de navegación / vista */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={goPrev}
            aria-label="Anterior"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={goToday}
          >
            Hoy
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={goNext}
            aria-label="Siguiente"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex flex-1 items-center gap-2 overflow-x-auto px-2 scrollbar-none">
          <div className="flex gap-1.5 rounded-lg border border-border bg-card p-1 shadow-sm">
            {(
              [
                { id: "all", label: "Todos", dot: "bg-primary" },
                { id: "confirmada", label: "Confirmadas", dot: "bg-success" },
                { id: "deposit_pending", label: "Anticipo pendiente", dot: "bg-warning" },
                { id: "completada", label: "Completadas", dot: "bg-muted-foreground" },
              ] as const
            ).map((filter) => (
              <button
                key={filter.id}
                onClick={() => setStatusFilter(filter.id as StatusFilter)}
                className={cn(
                  "flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  statusFilter === filter.id
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <span className={cn("size-2 rounded-full", filter.dot)} />
                {filter.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Filtro por doctor — solo si la clínica configuró doctores. */}
          {doctors.length > 0 && (
            <Select
              value={doctorFilter}
              onValueChange={(v) => v && setDoctorFilter(v as string)}
            >
              <SelectTrigger
                size="sm"
                className="h-8 w-40 border-border bg-muted text-foreground"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-border bg-popover">
                <SelectItem value="all">Todos los doctores</SelectItem>
                <SelectItem value="unassigned">Sin asignar</SelectItem>
                {doctors.map((d) => (
                  <SelectItem key={d.user_id} value={d.user_id}>
                    {d.full_name || "Doctor sin nombre"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {/* Control segmentado semana/día — pista gris + pastilla activa,
              el estilo homologado del legacy (docs/legacy-clinicos/ui/segment.ts). */}
          <div className="flex h-8 items-center gap-0.5 rounded-lg bg-muted p-[3px]">
          {(["semana", "dia"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setView(mode)}
              className={cn(
                "h-full rounded-md px-3 text-xs font-medium transition-all",
                view === mode
                  ? "bg-background text-foreground shadow-sm"
                  : "text-foreground/60 hover:text-foreground",
              )}
            >
              {mode === "semana" ? "Semana" : "Día"}
            </button>
          ))}
          </div>
        </div>
      </div>

      {/* Rejilla */}
      <div className="min-h-0 flex-1 animate-fade-up overflow-hidden rounded-xl border border-border bg-card shadow-soft">
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
        />
      </div>

      {/* Diálogos */}
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
