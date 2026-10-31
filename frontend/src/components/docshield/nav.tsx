'use client';

/**
 * Navigation shell: sidebar, mobile sheet nav, top bar and workflow stepper.
 */

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { LucideIcon } from 'lucide-react';
import {
  Check,
  Columns2,
  FileUp,
  LayoutDashboard,
  Menu,
  ScanSearch,
  Share2,
  ShieldCheck,
  ShieldX,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useDocShield, type ViewKey } from '@/lib/docshield/store';
import { formatDuration } from '@/lib/docshield/format';
import { Eyebrow } from './primitives';

/* ------------------------------------------------------------------ */
/* Nav configuration                                                   */
/* ------------------------------------------------------------------ */

export interface NavItem {
  key: ViewKey;
  label: string;
  shortLabel: string;
  icon: LucideIcon;
}

export const NAV_ITEMS: NavItem[] = [
  { key: 'dashboard', label: 'Dashboard', shortLabel: 'Dashboard', icon: LayoutDashboard },
  { key: 'upload', label: 'Protect a document', shortLabel: 'Upload', icon: FileUp },
  { key: 'studio', label: 'Redaction Studio', shortLabel: 'Redact', icon: ScanSearch },
  { key: 'lens', label: 'Privacy Risk Lens', shortLabel: 'Compare', icon: Columns2 },
  { key: 'verify', label: 'Verification', shortLabel: 'Verify', icon: ShieldCheck },
  { key: 'share', label: 'Share Record', shortLabel: 'Share', icon: Share2 },
];

export const VIEW_TITLES: Record<ViewKey, { section: string; title: string }> = {
  dashboard: { section: 'Workspace', title: 'Dashboard' },
  upload: { section: 'Step 01', title: 'Protect a document' },
  studio: { section: 'Step 02', title: 'Redaction Studio' },
  lens: { section: 'Step 03', title: 'Privacy Risk Lens' },
  verify: { section: 'Step 04', title: 'Verification' },
  share: { section: 'Step 05', title: 'Share Record' },
};

/* ------------------------------------------------------------------ */
/* Brand                                                               */
/* ------------------------------------------------------------------ */

function BrandMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground',
        className
      )}
      aria-hidden
    >
      <ShieldCheck className="h-4.5 w-4.5" strokeWidth={2.2} />
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Engine status dot                                                   */
/* ------------------------------------------------------------------ */

function EngineDot({ className }: { className?: string }) {
  const healthState = useDocShield((s) => s.healthState);
  return (
    <span className={cn('relative flex h-2 w-2', className)} aria-hidden>
      {healthState === 'ready' && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#7fb95e] opacity-60" />
      )}
      <span
        className={cn(
          'relative inline-flex h-2 w-2 rounded-full',
          healthState === 'ready' && 'bg-[#8fd065]',
          healthState === 'loading' && 'bg-[#d9c86a]',
          healthState === 'error' && 'bg-[#e05d4b]'
        )}
      />
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Nav list (shared by sidebar + mobile sheet)                         */
/* ------------------------------------------------------------------ */

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const view = useDocShield((s) => s.view);
  const setView = useDocShield((s) => s.setView);
  const doc = useDocShield((s) => s.doc);
  const redaction = useDocShield((s) => s.redaction);
  const verification = useDocShield((s) => s.verification);
  const report = useDocShield((s) => s.report);

  /* Completion is still tracked honestly — it drives the green checks,
     but nothing is locked: every view stays navigable at all times. */
  const progress = {
    upload: !!doc,
    studio: !!redaction,
    lens: !!redaction,
    verify: !!verification && !!report,
    share: !!verification && !!report,
  };

  const go = (item: NavItem) => {
    setView(item.key);
    onNavigate?.();
  };

  return (
    <nav aria-label="Workspace" className="space-y-1">
      {NAV_ITEMS.map((item) => {
        const active = view === item.key;
        const done = progress[item.key as keyof typeof progress] ?? false;
        const Icon = item.icon;
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => go(item)}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium transition-colors',
              active
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-sidebar-foreground/75 hover:bg-white/5 hover:text-sidebar-foreground'
            )}
          >
            <span
              className={cn(
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-md border transition-colors',
                active
                  ? 'border-[#c6f36a]/60 bg-[#c6f36a]/15 text-[#c6f36a]'
                  : done
                    ? 'border-transparent bg-[#c6f36a] text-[#172622]'
                    : 'border-white/10 text-sidebar-foreground/60 group-hover:text-sidebar-foreground'
              )}
              aria-hidden
            >
              {done && !active ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> : <Icon className="h-3.5 w-3.5" />}
            </span>
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {active ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#c6f36a]" aria-hidden /> : null}
          </button>
        );
      })}
    </nav>
  );
}

/* ------------------------------------------------------------------ */
/* Sidebar                                                             */
/* ------------------------------------------------------------------ */

export function Sidebar() {
  const health = useDocShield((s) => s.health);
  const healthState = useDocShield((s) => s.healthState);
  const resetSession = useDocShield((s) => s.resetSession);
  const [uptime, setUptime] = useState<number | null>(null);

  useEffect(() => {
    if (healthState === 'ready' && health) setUptime(health.uptimeSeconds);
  }, [health, healthState]);

  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-sidebar-border bg-sidebar md:flex">
      <div className="flex items-center gap-3 px-5 pb-5 pt-6">
        <BrandMark />
        <div className="min-w-0">
          <p className="text-[15px] font-semibold tracking-tight text-[#f2f5ef]">DocShield</p>
          <p className="text-[11px] text-sidebar-foreground/60">Document privacy workspace</p>
        </div>
      </div>

      <div className="px-5 pb-2 pt-3">
        <Eyebrow className="text-sidebar-foreground/40">Workflow</Eyebrow>
      </div>
      <div className="px-3">
        <NavList />
      </div>

      <div className="mt-auto space-y-3 px-5 pb-5 pt-4">
        <div className="rounded-lg border border-white/10 bg-white/[0.04] p-3">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-xs font-medium text-sidebar-foreground">
              <EngineDot />
              {healthState === 'ready' ? 'Engine online' : healthState === 'loading' ? 'Checking engine…' : 'Engine offline'}
            </span>
          </div>
          <dl className="mt-2 space-y-1 text-[11px] text-sidebar-foreground/60">
            <div className="flex justify-between gap-2">
              <dt>Uptime</dt>
              <dd className="font-mono">{uptime !== null ? formatDuration(uptime) : '—'}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>Max upload</dt>
              <dd className="font-mono">{health ? `${Math.round(health.config.maxFileSizeBytes / (1024 * 1024))} MB` : '—'}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>Storage</dt>
              <dd>In-memory · 30 min</dd>
            </div>
          </dl>
        </div>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            resetSession();
            import('sonner').then(({ toast }) => toast.success('Session cleared. Nothing about your documents leaves this browser.'));
          }}
          className="h-8 w-full justify-start gap-2 text-xs text-sidebar-foreground/70 hover:bg-white/5 hover:text-sidebar-foreground"
        >
          <ShieldX className="h-3.5 w-3.5" aria-hidden /> Start a clean session
        </Button>
        <p className="text-[10.5px] leading-4 text-sidebar-foreground/45">
          Documents are processed in memory and never leave this machine.
        </p>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/* Top bar                                                             */
/* ------------------------------------------------------------------ */

export function TopBar() {
  const view = useDocShield((s) => s.view);
  const doc = useDocShield((s) => s.doc);
  const meta = VIEW_TITLES[view];
  const [mounted, setMounted] = useState(false);

  // Mount-gate for the radix Sheet: avoids a server/client id mismatch.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-background">
      <div className="flex h-14 items-center gap-3 px-4 sm:px-6 lg:px-10">
        {/* Mobile nav — mounted-gated: radix generates ids that differ between
            server and client, which would trigger a hydration mismatch. */}
        {mounted ? (
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="outline" size="icon" className="h-8 w-8 md:hidden" aria-label="Open navigation">
                <Menu className="h-4 w-4" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 border-sidebar-border bg-sidebar p-0 [&>button]:text-sidebar-foreground">
              <SheetHeader className="px-5 pb-2 pt-5 text-left">
                <SheetTitle className="flex items-center gap-3 text-[#f2f5ef]">
                  <BrandMark /> DocShield
                </SheetTitle>
              </SheetHeader>
              <div className="px-3 pb-6">
                <NavList onNavigate={() => undefined} />
              </div>
              <p className="px-6 text-[10.5px] leading-4 text-sidebar-foreground/45">
                Documents are processed in memory and never leave this machine.
              </p>
            </SheetContent>
          </Sheet>
        ) : (
          <Button variant="outline" size="icon" className="h-8 w-8 md:hidden" aria-label="Open navigation" disabled>
            <Menu className="h-4 w-4" />
          </Button>
        )}

        <div className="min-w-0 flex-1">
          <p className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">{meta.section}</p>
          <h2 className="truncate text-sm font-semibold tracking-tight">{meta.title}</h2>
        </div>

        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="hidden max-w-[260px] items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 sm:flex">
                <EngineDot />
                <span className="truncate text-xs font-medium">{doc ? doc.fileName : 'No active document'}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              {doc ? (
                <p className="font-mono text-[11px]">{doc.documentId}</p>
              ) : (
                <p>Upload a document to begin.</p>
              )}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* Workflow stepper                                                    */
/* ------------------------------------------------------------------ */

const STEPPER: { key: ViewKey; label: string }[] = [
  { key: 'upload', label: 'Upload' },
  { key: 'studio', label: 'Redact' },
  { key: 'lens', label: 'Compare' },
  { key: 'verify', label: 'Verify' },
  { key: 'share', label: 'Share' },
];

export function WorkflowStepper() {
  const view = useDocShield((s) => s.view);
  const setView = useDocShield((s) => s.setView);
  const doc = useDocShield((s) => s.doc);
  const redaction = useDocShield((s) => s.redaction);
  const verification = useDocShield((s) => s.verification);
  const report = useDocShield((s) => s.report);

  const activeIndex = STEPPER.findIndex((s) => s.key === view);
  const done: Record<string, boolean> = {
    upload: !!doc,
    studio: !!redaction,
    lens: !!redaction,
    verify: !!verification && !!report,
    share: !!verification && !!report,
  };

  return (
    <TooltipProvider delayDuration={200}>
      <ol className="flex items-center gap-1" aria-label="Workflow progress">
        {STEPPER.map((step, i) => {
          const active = view === step.key;
          const complete = done[step.key] && !active;
          return (
            <li key={step.key} className="flex min-w-0 items-center">
              {i > 0 && (
                <span
                  className={cn('mx-1 h-px w-5 shrink-0 lg:w-8', complete || active ? 'bg-[#8bb930]' : 'bg-border')}
                  aria-hidden
                />
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setView(step.key)}
                    aria-current={active ? 'step' : undefined}
                    className={cn(
                      'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                      active && 'border-primary bg-primary text-primary-foreground',
                      !active && complete && 'border-[#b2e153] bg-accent/70 text-accent-foreground',
                      !active && !complete && 'border-border bg-card text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {complete && !active ? (
                      <Check className="h-3 w-3" strokeWidth={3} aria-hidden />
                    ) : (
                      <span className="font-mono text-[10px]" aria-hidden>
                        {i + 1}
                      </span>
                    )}
                    <span className="hidden sm:inline">{step.label}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent className="text-xs">{step.label}</TooltipContent>
              </Tooltip>
            </li>
          );
        })}
        {activeIndex === -1 && (
          <li className="ml-2 hidden font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground lg:block">
            overview
          </li>
        )}
      </ol>
    </TooltipProvider>
  );
}

/* ------------------------------------------------------------------ */
/* View transition wrapper                                             */
/* ------------------------------------------------------------------ */

export function ViewTransition({ viewKey, children }: { viewKey: string; children: React.ReactNode }) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={viewKey}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
