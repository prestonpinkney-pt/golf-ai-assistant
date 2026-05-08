import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

const buttonVariants = {
  primary:
    "border-emerald-700 bg-emerald-600 text-white shadow-sm hover:-translate-y-0.5 hover:bg-emerald-700 hover:shadow-md focus-visible:ring-emerald-500",
  secondary:
    "border-slate-200 bg-white text-slate-800 shadow-sm hover:-translate-y-0.5 hover:border-slate-300 hover:bg-slate-50 hover:shadow-md focus-visible:ring-slate-400",
  subtle:
    "border-transparent bg-emerald-50 text-emerald-800 hover:-translate-y-0.5 hover:bg-emerald-100 focus-visible:ring-emerald-500",
  danger:
    "border-red-200 bg-red-50 text-red-700 hover:bg-red-100 focus-visible:ring-red-500",
} as const;

export type ButtonVariant = keyof typeof buttonVariants;

export function ButtonLink({
  href,
  children,
  variant = "secondary",
  className = "",
}: {
  href: string;
  children: ReactNode;
  variant?: ButtonVariant;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center justify-center rounded-xl border px-3.5 py-2 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
        buttonVariants[variant],
        className
      )}
    >
      {children}
    </Link>
  );
}

export function ActionButton({
  children,
  variant = "secondary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
}) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center justify-center rounded-xl border px-3.5 py-2 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0",
        buttonVariants[variant],
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
  className = "",
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col gap-4 md:flex-row md:items-end md:justify-between", className)}>
      <div>
        {eyebrow ? (
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700">{eyebrow}</p>
        ) : null}
        <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-slate-950 md:text-4xl">{title}</h1>
        {description ? <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">{description}</p> : null}
      </div>
      {action ? <div className="flex flex-wrap items-center gap-2">{action}</div> : null}
    </section>
  );
}

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("motion-card rounded-2xl border border-slate-200 bg-white shadow-sm", className)}>
      {children}
    </section>
  );
}

export function SectionHeader({
  title,
  eyebrow,
  action,
}: {
  title: ReactNode;
  eyebrow?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        {eyebrow ? (
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-700">{eyebrow}</p>
        ) : null}
        <h2 className="text-sm font-semibold tracking-[-0.015em] text-slate-950">{title}</h2>
      </div>
      {action}
    </div>
  );
}

export function MetricCard({
  label,
  value,
  meta,
  accent = "neutral",
}: {
  label: string;
  value: ReactNode;
  meta?: ReactNode;
  accent?: "neutral" | "green" | "amber" | "blue";
}) {
  const accentClasses = {
    neutral: "bg-slate-50 text-slate-600",
    green: "bg-emerald-50 text-emerald-700",
    amber: "bg-amber-50 text-amber-700",
    blue: "bg-sky-50 text-sky-700",
  };

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium text-slate-500">{label}</p>
        {meta ? (
          <span className={cn("rounded-full px-2.5 py-1 text-[11px] font-semibold", accentClasses[accent])}>
            {meta}
          </span>
        ) : null}
      </div>
      <p className="mt-3 text-3xl font-semibold tracking-[-0.05em] text-slate-950">{value}</p>
    </Card>
  );
}

export function StatusBadge({
  children,
  tone = "neutral",
  className = "",
}: {
  children: ReactNode;
  tone?: "neutral" | "green" | "amber" | "red" | "blue";
  className?: string;
}) {
  const tones = {
    neutral: "border-slate-200 bg-slate-50 text-slate-700",
    green: "border-emerald-200 bg-emerald-50 text-emerald-700",
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    red: "border-red-200 bg-red-50 text-red-700",
    blue: "border-sky-200 bg-sky-50 text-sky-700",
  };

  return (
    <span className={cn("inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold", tones[tone], className)}>
      {children}
    </span>
  );
}

export function EmptyState({
  title,
  copy,
  action,
  className = "",
}: {
  title: string;
  copy: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-5", className)}>
      <p className="text-sm font-semibold text-slate-900">{title}</p>
      <p className="mt-1 text-sm leading-6 text-slate-600">{copy}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function InlineError({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
      <p className="text-sm font-semibold text-red-800">{message}</p>
      {onRetry ? (
        <ActionButton onClick={onRetry} variant="danger" className="mt-3">
          Retry
        </ActionButton>
      ) : null}
    </div>
  );
}
