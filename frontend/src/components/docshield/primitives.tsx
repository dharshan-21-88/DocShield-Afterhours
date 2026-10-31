'use client';

/**
 * Shared editorial design-system primitives for the DocShield workspace.
 */

import { useCallback, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  AlertTriangle,
  Check,
  ChevronRight,
  CircleCheck,
  Copy,
  CreditCard,
  GraduationCap,
  IdCard,
  Info,
  Loader2,
  Mail,
  MapPin,
  OctagonAlert,
  Phone,
  RotateCcw,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { Confidence, DetectionCategory } from '@/lib/docshield/types';

/* ------------------------------------------------------------------ */
/* Typography                                                          */
/* ------------------------------------------------------------------ */

export function Eyebrow({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cn('font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground', className)}>
      {children}
    </p>
  );
}

/* ------------------------------------------------------------------ */
/* Status pills & badges                                               */
/* ------------------------------------------------------------------ */

type PillTone = 'neutral' | 'success' | 'warning' | 'destructive' | 'accent' | 'dark';

const PILL_TONES: Record<PillTone, string> = {
  neutral: 'bg-muted text-muted-foreground border-border',
  success: 'bg-[#e5f0dd] text-[#2e5a35] border-[#cfe2c2]',
  warning: 'bg-[#f6eccf] text-[#77571b] border-[#ead9a4]',
  destructive: 'bg-[#f7dfd9] text-[#8f2f24] border-[#ecc9c1]',
  accent: 'bg-accent text-accent-foreground border-[#b2e153]',
  dark: 'bg-primary text-primary-foreground border-primary',
};

export function StatusPill({
  tone = 'neutral',
  children,
  className,
  icon: Icon,
}: {
  tone?: PillTone;
  children: React.ReactNode;
  className?: string;
  icon?: LucideIcon;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium leading-5',
        PILL_TONES[tone],
        className
      )}
    >
      {Icon ? <Icon className="h-3 w-3" aria-hidden /> : null}
      {children}
    </span>
  );
}

export const CATEGORY_META: Record<
  DetectionCategory,
  { short: string; icon: LucideIcon; className: string }
> = {
  PHONE_NUMBER: {
    short: 'Phone',
    icon: Phone,
    className: 'bg-[#e9efe0] text-[#42552c] border-[#d6e0c4]',
  },
  EMAIL_ADDRESS: {
    short: 'Email',
    icon: Mail,
    className: 'bg-[#edeae0] text-[#5d5744] border-[#ddd7c6]',
  },
  ADDRESS: {
    short: 'Address',
    icon: MapPin,
    className: 'bg-[#f0ead9] text-[#6d5c2f] border-[#e3d8ba]',
  },
  STUDENT_REG_NUMBER: {
    short: 'Reg. number',
    icon: GraduationCap,
    className: 'bg-[#e4ede8] text-[#2f5748] border-[#cfdfd6]',
  },
  NATIONAL_ID_AADHAAR: {
    short: 'National ID',
    icon: IdCard,
    className: 'bg-[#f0e5e0] text-[#75432f] border-[#e2cec4]',
  },
  FINANCIAL_ACCOUNT: {
    short: 'Financial',
    icon: CreditCard,
    className: 'bg-[#e5ebee] text-[#34525c] border-[#d0dde2]',
  },
};

export function CategoryBadge({ category, label, className }: { category: DetectionCategory; label?: string; className?: string }) {
  const meta = CATEGORY_META[category] ?? null;
  const Icon = meta?.icon ?? Info;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium leading-5',
        meta?.className ?? 'bg-muted text-muted-foreground border-border',
        className
      )}
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden />
      {label ?? meta?.short ?? category}
    </span>
  );
}

export const CONFIDENCE_META: Record<Confidence, { label: string; tone: PillTone; icon: LucideIcon; hint: string }> = {
  HIGH: {
    label: 'High confidence',
    tone: 'success',
    icon: CircleCheck,
    hint: 'Matched a strict, well-defined format.',
  },
  MEDIUM: {
    label: 'Medium confidence',
    tone: 'warning',
    icon: Info,
    hint: 'Plausible pattern — worth a quick review.',
  },
  LOW_UNCERTAIN: {
    label: 'Low confidence',
    tone: 'destructive',
    icon: AlertTriangle,
    hint: 'Heuristic match — review carefully before acting.',
  },
};

export function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  const meta = CONFIDENCE_META[confidence] ?? CONFIDENCE_META.MEDIUM;
  return (
    <StatusPill tone={meta.tone} icon={meta.icon}>
      <span className="sr-only">{meta.hint}</span>
      {meta.label}
    </StatusPill>
  );
}

/* ------------------------------------------------------------------ */
/* Notices                                                             */
/* ------------------------------------------------------------------ */

type NoticeTone = 'info' | 'warning' | 'success' | 'error';

const NOTICE_STYLES: Record<NoticeTone, { wrapper: string; icon: LucideIcon; iconClass: string }> = {
  info: { wrapper: 'border-border bg-card', icon: Info, iconClass: 'text-muted-foreground' },
  warning: { wrapper: 'border-[#ead9a4] bg-[#faf3dd]', icon: AlertTriangle, iconClass: 'text-[#946200]' },
  success: { wrapper: 'border-[#cfe2c2] bg-[#eef5e7]', icon: CircleCheck, iconClass: 'text-[#2e7d4f]' },
  error: { wrapper: 'border-[#ecc9c1] bg-[#fbeeec]', icon: OctagonAlert, iconClass: 'text-[#b3261e]' },
};

export function InfoNotice({
  tone = 'info',
  title,
  children,
  className,
}: {
  tone?: NoticeTone;
  title?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const s = NOTICE_STYLES[tone];
  const Icon = s.icon;
  return (
    <div role={tone === 'error' ? 'alert' : 'note'} className={cn('flex gap-3 rounded-lg border p-3.5 text-sm', s.wrapper, className)}>
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', s.iconClass)} aria-hidden />
      <div className="min-w-0 space-y-1">
        {title ? <p className="font-medium leading-5">{title}</p> : null}
        {children ? <div className="text-[13px] leading-5 text-muted-foreground">{children}</div> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Copy helpers                                                        */
/* ------------------------------------------------------------------ */

export function CopyButton({ value, label = 'Copy', className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard unavailable — silently ignore.
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }, [value]);

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onCopy}
      className={cn('h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground', className)}
      aria-label={`${label}: ${value.slice(0, 24)}…`}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-[#2e7d4f]" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      {copied ? 'Copied' : label}
    </Button>
  );
}

export function FingerprintField({ label, hash, className }: { label: string; hash?: string | null; className?: string }) {
  return (
    <div className={cn('rounded-lg border border-border bg-muted/50 p-3', className)}>
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
        {hash ? <CopyButton value={hash} /> : null}
      </div>
      <p className="fingerprint mt-1 text-foreground" title={hash ?? undefined}>
        {hash ? (hash.length > 52 ? `${hash.slice(0, 52)}…` : hash) : '—'}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Metrics & key-value rows                                            */
/* ------------------------------------------------------------------ */

export function MetricTile({
  label,
  value,
  sub,
  icon: Icon,
  tone = 'neutral',
  className,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  icon?: LucideIcon;
  tone?: PillTone;
  className?: string;
}) {
  return (
    <div className={cn('rounded-xl border border-border bg-card p-4', className)}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {Icon ? (
          <span
            className={cn(
              'flex h-6 w-6 items-center justify-center rounded-md border',
              PILL_TONES[tone === 'neutral' ? 'neutral' : tone]
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
          </span>
        ) : null}
      </div>
      <p className="mt-2 truncate text-xl font-semibold tracking-tight" title={typeof value === 'string' ? value : undefined}>
        {value}
      </p>
      {sub ? <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

export function KeyValue({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className={cn('min-w-0 text-right text-[13px] font-medium', mono && 'font-mono text-xs break-all')}>{children}</dd>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Empty / error / loading states                                      */
/* ------------------------------------------------------------------ */

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center rounded-xl border border-dashed border-input bg-muted/30 px-6 py-10 text-center', className)}>
      <span className="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-background">
        <Icon className="h-4.5 w-4.5 text-muted-foreground" aria-hidden />
      </span>
      <p className="mt-3 text-sm font-medium">{title}</p>
      {description ? <p className="mt-1 max-w-sm text-[13px] leading-5 text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function ErrorPanel({
  code,
  message,
  onRetry,
  className,
}: {
  code?: string;
  message: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div role="alert" className={cn('rounded-xl border border-[#ecc9c1] bg-[#fbeeec] p-4', className)}>
      <div className="flex items-start gap-3">
        <OctagonAlert className="mt-0.5 h-4 w-4 shrink-0 text-[#b3261e]" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-[#8f2f24]">{message}</p>
          {code ? <p className="mt-1 font-mono text-[11px] uppercase tracking-wider text-[#b3574b]">{code}</p> : null}
        </div>
        {onRetry ? (
          <Button type="button" variant="outline" size="sm" className="h-7 shrink-0 gap-1.5" onClick={onRetry}>
            <RotateCcw className="h-3 w-3" aria-hidden /> Retry
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function SpinnerLine({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2.5 text-sm text-muted-foreground" role="status" aria-live="polite">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      {label}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Staged progress                                                     */
/* ------------------------------------------------------------------ */

export function ProgressStages({ stages, current, className }: { stages: string[]; current: number; className?: string }) {
  return (
    <ol className={cn('space-y-2.5', className)} aria-label="Progress">
      {stages.map((stage, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={stage} className="flex items-center gap-2.5 text-sm">
            <span
              className={cn(
                'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold',
                done && 'border-[#b2e153] bg-accent text-accent-foreground',
                active && 'border-primary bg-primary text-primary-foreground',
                !done && !active && 'border-border bg-muted text-muted-foreground'
              )}
              aria-hidden
            >
              {done ? <Check className="h-3 w-3" /> : i + 1}
            </span>
            <span className={cn(done && 'text-muted-foreground line-through decoration-border', active && 'font-medium', !done && !active && 'text-muted-foreground')}>
              {stage}
            </span>
            {active ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-hidden /> : null}
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ */
/* Section scaffolding                                                 */
/* ------------------------------------------------------------------ */

export function SectionCard({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn('rounded-xl border border-border bg-card', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
          <div className="min-w-0">
            {title ? <h2 className="text-sm font-semibold tracking-tight">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </header>
      )}
      <div className={cn('p-4 sm:p-5', bodyClassName)}>{children}</div>
    </section>
  );
}

export function ViewHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  eyebrow: string;
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn('flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between', className)}>
      <div className="min-w-0 max-w-2xl">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1 className="mt-1.5 text-2xl font-semibold tracking-tight sm:text-[1.75rem]">{title}</h1>
        {description ? <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function BreadcrumbHint({ items }: { items: string[] }) {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-xs text-muted-foreground">
      {items.map((item, i) => (
        <span key={item} className="flex items-center gap-1">
          {i > 0 ? <ChevronRight className="h-3 w-3" aria-hidden /> : null}
          <span className={i === items.length - 1 ? 'font-medium text-foreground' : undefined}>{item}</span>
        </span>
      ))}
    </nav>
  );
}
