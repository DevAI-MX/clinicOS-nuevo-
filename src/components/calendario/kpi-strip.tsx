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
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <KpiCard
        icon={<CalendarCheck className="size-4" />}
        label="Citas de hoy"
        value={loading ? "—" : String(kpis.todayCount)}
      />
      <KpiCard
        icon={<HandCoins className="size-4" />}
        label="Pendientes de anticipo"
        value={loading ? "—" : String(kpis.depositPendingCount)}
        detail={
          !loading && kpis.depositPendingTotal > 0
            ? `${formatCurrency(kpis.depositPendingTotal, CLINIC_CURRENCY)} por cobrar`
            : undefined
        }
        detailClassName="text-warning"
      />
      <KpiCard
        icon={<CheckCircle2 className="size-4 text-success" />}
        label="Anticipos pagados"
        value={loading ? "—" : String(kpis.depositPaidCount)}
        detail={
          !loading && kpis.depositPaidTotal > 0
            ? `${formatCurrency(kpis.depositPaidTotal, CLINIC_CURRENCY)} confirmados`
            : undefined
        }
        detailClassName="text-success"
      />
      <KpiCard
        icon={<CalendarDays className="size-4" />}
        label="Citas de la semana"
        value={loading ? "—" : String(kpis.weekCount)}
      />
    </div>
  );
}

function KpiCard({
  icon,
  label,
  value,
  detail,
  detailClassName,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail?: string;
  detailClassName?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-soft transition-shadow hover:shadow-lifted">
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <p className="text-xs font-medium">{label}</p>
      </div>
      <p className="nums mt-2 text-2xl font-semibold text-foreground">
        {value}
      </p>
      {detail && (
        <p className={cn("nums mt-0.5 text-xs font-medium", detailClassName)}>
          {detail}
        </p>
      )}
    </div>
  );
}
