"use client";

/**
 * KpiStrip — resumen operativo arriba del calendario: citas de hoy,
 * anticipos pendientes (con monto total por cobrar) y citas de la
 * semana en curso.
 */

import { CalendarCheck, CalendarDays, HandCoins, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/currency";
import { CLINIC_CURRENCY } from "@/lib/clinic/types";
import type { AgendaKpis } from "./use-agenda";

interface KpiStripProps {
  kpis: AgendaKpis;
  loading?: boolean;
}

export function KpiStrip({ kpis, loading = false }: KpiStripProps) {
  return (
    <section className="kpis">
      <article className="kpi">
        <div className="label">Citas de hoy</div>
        <div className="value">{loading ? "—" : kpis.todayCount}</div>
        <div className="hint">Agendadas para hoy</div>
      </article>
      <article className="kpi">
        <div className="label">Pendientes de anticipo</div>
        <div className="value">{loading ? "—" : kpis.depositPendingCount}</div>
        <div className="hint">
          {!loading && kpis.depositPendingTotal > 0
            ? `${formatCurrency(kpis.depositPendingTotal, CLINIC_CURRENCY)} por cobrar`
            : "Prioridad comercial"}
        </div>
      </article>
      <article className="kpi">
        <div className="label">Anticipos pagados</div>
        <div className="value">{loading ? "—" : kpis.depositPaidCount}</div>
        <div className="hint">
          {!loading && kpis.depositPaidTotal > 0
            ? `${formatCurrency(kpis.depositPaidTotal, CLINIC_CURRENCY)} confirmados`
            : "Ingresos asegurados"}
        </div>
      </article>
      <article className="kpi">
        <div className="label">Citas de la semana</div>
        <div className="value">{loading ? "—" : kpis.weekCount}</div>
        <div className="hint">Volumen total proyectado</div>
      </article>
    </section>
  );
}
