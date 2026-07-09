"use client";

/**
 * useAgenda — datos del calendario para un rango [rangeStart, rangeEnd).
 *
 * Sigue el patrón de fetching de contacts/page.tsx (cliente supabase de
 * navegador + useCallback/useEffect + guard de secuencia) y el patrón
 * realtime de use-realtime.ts (canal con callbacks en refs). Vive aquí y
 * no en src/hooks/ para respetar la frontera del módulo de calendario.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  addDays,
  mondayOf,
  startOfDay,
} from "@/lib/clinic/calendar";
import type {
  AppointmentWithRelations,
  Doctor,
  Procedure,
  ScheduleBlock,
} from "@/lib/clinic/types";

/** Columnas embebidas que necesita la agenda (contacto + procedimiento). */
const AGENDA_SELECT =
  "*, contact:contacts(id, name, phone), procedure:procedures(id, name, price_min, price_max, currency, deposit_amount, duration_minutes)";

export interface AgendaKpis {
  /** Citas de hoy (excluye canceladas). */
  todayCount: number;
  /** Citas de la semana en curso (lun→dom, excluye canceladas). */
  weekCount: number;
  /** Citas activas con anticipo pendiente desde hoy en adelante. */
  depositPendingCount: number;
  /** Suma de sus anticipos (snapshot deposit_amount). */
  depositPendingTotal: number;
  /** Citas con anticipo pagado esta semana. */
  depositPaidCount: number;
  /** Suma de anticipos pagados esta semana. */
  depositPaidTotal: number;
}

const EMPTY_KPIS: AgendaKpis = {
  todayCount: 0,
  weekCount: 0,
  depositPendingCount: 0,
  depositPendingTotal: 0,
  depositPaidCount: 0,
  depositPaidTotal: 0,
};

export function useAgenda(rangeStart: Date, rangeEnd: Date) {
  const supabase = createClient();

  const [appointments, setAppointments] = useState<AppointmentWithRelations[]>(
    [],
  );
  const [blocks, setBlocks] = useState<ScheduleBlock[]>([]);
  const [procedures, setProcedures] = useState<Procedure[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [kpis, setKpis] = useState<AgendaKpis>(EMPTY_KPIS);
  const [loading, setLoading] = useState(true);

  // Guard contra respuestas fuera de orden al navegar rápido de semana
  // (mismo truco que fetchContacts en contacts/page.tsx).
  const fetchSeq = useRef(0);

  const rangeStartMs = rangeStart.getTime();
  const rangeEndMs = rangeEnd.getTime();

  const fetchAgenda = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setLoading(true);

    const startIso = new Date(rangeStartMs).toISOString();
    const endIso = new Date(rangeEndMs).toISOString();

    // KPIs siempre sobre "hoy" y "esta semana", independientemente de la
    // semana que se esté viendo.
    const now = new Date();
    const todayStart = startOfDay(now);
    const todayEnd = addDays(todayStart, 1);
    const weekStart = mondayOf(now);
    const weekEnd = addDays(weekStart, 7);

    const [agendaRes, blocksRes, todayRes, weekRes, depositRes, depositPaidRes] =
      await Promise.all([
        // Todo lo que TOQUE el rango (starts_at < fin Y ends_at > inicio),
        // no solo lo que empiece dentro — una cita que cruza medianoche
        // debe pintarse en ambos días. Las canceladas no se pintan: al
        // cancelar, la cita desaparece de la rejilla (sigue en la BD y
        // en la ficha del contacto para el historial).
        supabase
          .from("appointments")
          .select(AGENDA_SELECT)
          .lt("starts_at", endIso)
          .gt("ends_at", startIso)
          .neq("status", "cancelada")
          .order("starts_at", { ascending: true }),
        supabase
          .from("schedule_blocks")
          .select("*")
          .lt("starts_at", endIso)
          .gt("ends_at", startIso)
          .order("starts_at", { ascending: true }),
        supabase
          .from("appointments")
          .select("id", { count: "exact", head: true })
          .gte("starts_at", todayStart.toISOString())
          .lt("starts_at", todayEnd.toISOString())
          .neq("status", "cancelada"),
        supabase
          .from("appointments")
          .select("id", { count: "exact", head: true })
          .gte("starts_at", weekStart.toISOString())
          .lt("starts_at", weekEnd.toISOString())
          .neq("status", "cancelada"),
        supabase
          .from("appointments")
          .select("deposit_amount")
          .eq("deposit_status", "pendiente")
          .gte("starts_at", todayStart.toISOString())
          .neq("status", "cancelada")
          .neq("status", "no_asistio"),
        supabase
          .from("appointments")
          .select("deposit_amount")
          .eq("deposit_status", "pagado")
          .gte("starts_at", weekStart.toISOString())
          .lt("starts_at", weekEnd.toISOString())
          .neq("status", "cancelada"),
      ]);

    if (seq !== fetchSeq.current) return; // superado por un fetch más nuevo

    if (agendaRes.error || blocksRes.error) {
      toast.error("No se pudo cargar la agenda");
      setLoading(false);
      return;
    }

    setAppointments(
      (agendaRes.data ?? []) as unknown as AppointmentWithRelations[],
    );
    setBlocks((blocksRes.data ?? []) as ScheduleBlock[]);

    const depositRows = (depositRes.data ?? []) as {
      deposit_amount: number | null;
    }[];
    const paidRows = (depositPaidRes.data ?? []) as {
      deposit_amount: number | null;
    }[];
    
    setKpis({
      todayCount: todayRes.count ?? 0,
      weekCount: weekRes.count ?? 0,
      depositPendingCount: depositRows.length,
      depositPendingTotal: depositRows.reduce(
        (sum, r) => sum + (Number(r.deposit_amount) || 0),
        0,
      ),
      depositPaidCount: paidRows.length,
      depositPaidTotal: paidRows.reduce(
        (sum, r) => sum + (Number(r.deposit_amount) || 0),
        0,
      ),
    });
    setLoading(false);

  }, [supabase, rangeStartMs, rangeEndMs]);

  // Catálogo activo — una vez al montar; cambia poco y solo lo usa el
  // formulario de nueva cita.
  const fetchProcedures = useCallback(async () => {
    const { data } = await supabase
      .from("procedures")
      .select("*")
      .eq("is_active", true)
      .order("name");
    if (data) setProcedures(data as Procedure[]);
  }, [supabase]);

  // Doctores asignables = perfiles con is_provider (migración 044). RLS
  // los limita a la cuenta del usuario. Se usan para asignar, filtrar y
  // colorear la agenda.
  const fetchDoctors = useCallback(async () => {
    const { data } = await supabase
      .from("profiles")
      .select("user_id, full_name, provider_color")
      .eq("is_provider", true)
      .order("full_name");
    if (data) setDoctors(data as Doctor[]);
  }, [supabase]);

  useEffect(() => {
    // Los setters corren tras awaits de Supabase, no síncronos en el effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchAgenda();
  }, [fetchAgenda]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- ídem.
    fetchProcedures();
  }, [fetchProcedures]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- ídem.
    fetchDoctors();
  }, [fetchDoctors]);

  // ------------------------------------------------------------
  // Realtime: appointments está en supabase_realtime (migración 031).
  // Cualquier INSERT/UPDATE/DELETE (el agente IA agenda, otra persona
  // confirma) refresca la agenda y los KPIs. Callback en ref para no
  // re-suscribir en cada render (patrón de use-realtime.ts).
  // ------------------------------------------------------------
  const refetchRef = useRef(fetchAgenda);
  useEffect(() => {
    refetchRef.current = fetchAgenda;
  });

  useEffect(() => {
    const client = createClient();
    const channel = client
      .channel("calendario-appointments")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "appointments" },
        () => {
          refetchRef.current();
        },
      )
      .subscribe();

    return () => {
      client.removeChannel(channel);
    };
  }, []);

  return {
    appointments,
    blocks,
    procedures,
    doctors,
    kpis,
    loading,
    refetch: fetchAgenda,
  };
}
