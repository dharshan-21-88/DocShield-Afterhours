'use client';

/**
 * Dashboard — welcome, session status, recent documents and the
 * processing journal. Everything shown is real session state.
 */

import { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Database,
  EyeOff,
  FileText,
  FileUp,
  HardDrive,
  RotateCcw,
  ScanSearch,
  Share2,
  ShieldCheck,
  Timer,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useDocShield, type HistoryKind } from '@/lib/docshield/store';
import { formatBytes, timeAgo } from '@/lib/docshield/format';
import { getReport } from '@/lib/docshield/api';
import {
  EmptyState,
  InfoNotice,
  MetricTile,
  SectionCard,
  StatusPill,
  ViewHeader,
} from '../primitives';

const HISTORY_ICONS: Record<HistoryKind, typeof FileUp> = {
  upload: FileUp,
  detect: ScanSearch,
  redact: EyeOff,
  verify: ShieldCheck,
  share: Share2,
  reset: RotateCcw,
  error: AlertTriangle,
};

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Working late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export function DashboardView() {
  const health = useDocShield((s) => s.health);
  const healthState = useDocShield((s) => s.healthState);
  const doc = useDocShield((s) => s.doc);
  const detection = useDocShield((s) => s.detection);
  const redaction = useDocShield((s) => s.redaction);
  const verification = useDocShield((s) => s.verification);
  const report = useDocShield((s) => s.report);
  const recentDocs = useDocShield((s) => s.recentDocs);
  const history = useDocShield((s) => s.history);
  const shares = useDocShield((s) => s.shares);
  const setView = useDocShield((s) => s.setView);

  const [greet, setGreet] = useState('Welcome');
  useEffect(() => setGreet(greeting()), []);

  const stage = !doc
    ? 'Waiting for a document'
    : !redaction
      ? 'Reviewing detected fields'
      : !verification
        ? 'Ready for verification'
        : 'Verified — ready to share';

  const stageTone = !doc
    ? ('neutral' as const)
    : !verification
      ? ('warning' as const)
      : ('success' as const);

  const openReport = async () => {
    if (!report) return;
    try {
      await getReport(report.reportId);
      setView('verify');
    } catch {
      import('sonner').then(({ toast }) =>
        toast.error('The report has expired on the engine. Re-run verification to regenerate it.')
      );
    }
  };

  return (
    <div className="space-y-6">
      <ViewHeader
        eyebrow="Privacy workspace"
        title={`${greet}. What are we protecting today?`}
        description={
          health?.motto ??
          'Detect sensitive information, redact it permanently, and verify what remains exposed before anything leaves your hands.'
        }
        actions={
          <>
            {report ? (
              <Button variant="outline" onClick={openReport} className="gap-2">
                <FileText className="h-4 w-4" aria-hidden /> Latest report
              </Button>
            ) : null}
            <Button
              onClick={() => setView('upload')}
              className="gap-2 border border-[#aedd53] bg-accent text-accent-foreground hover:bg-accent/85"
            >
              <ShieldCheck className="h-4 w-4" aria-hidden /> Protect a document
            </Button>
          </>
        }
      />

      {/* Status strip */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricTile
          label="Engine"
          icon={Activity}
          tone={healthState === 'ready' ? 'success' : healthState === 'error' ? 'destructive' : 'neutral'}
          value={healthState === 'ready' ? 'Online' : healthState === 'loading' ? 'Checking…' : 'Offline'}
          sub={health ? `uptime ${Math.floor(health.uptimeSeconds / 60)} min` : 'service unreachable'}
        />
        <MetricTile
          label="Max upload size"
          icon={HardDrive}
          value={health ? formatBytes(health.config.maxFileSizeBytes) : '—'}
          sub="PDF files only"
        />
        <MetricTile
          label="Active document"
          icon={FileText}
          value={doc ? doc.fileName : 'None'}
          sub={doc ? `${doc.pageCount} page${doc.pageCount === 1 ? '' : 's'} · ${formatBytes(doc.fileSizeBytes)}` : 'upload to begin'}
        />
        <MetricTile
          label="Session activity"
          icon={Timer}
          value={`${history.length} event${history.length === 1 ? '' : 's'}`}
          sub={`${shares.length} share record${shares.length === 1 ? '' : 's'}`}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left: documents + journal */}
        <div className="space-y-6 lg:col-span-2">
          <SectionCard
            title="Recent documents"
            description="Documents processed in this browser session — metadata only, never file contents."
            actions={
              <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={() => setView('upload')}>
                New <ArrowRight className="h-3 w-3" aria-hidden />
              </Button>
            }
          >
            {recentDocs.length === 0 ? (
              <EmptyState
                icon={FileText}
                title="No documents yet"
                description="Upload your own PDF or start from a fictional sample to see the full detect → redact → verify journey."
                className="border-0 bg-transparent"
              />
            ) : (
              <ul className="divide-y divide-border">
                {recentDocs.map((d) => {
                  const active = d.documentId === doc?.documentId;
                  return (
                    <li key={d.documentId} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
                        <FileText className="h-4 w-4 text-muted-foreground" aria-hidden />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium">
                          {d.fileName}
                          {active ? (
                            <span className="ml-2 align-middle">
                              <StatusPill tone="accent">active</StatusPill>
                            </span>
                          ) : null}
                        </p>
                        <p className="truncate font-mono text-[11px] text-muted-foreground">
                          {d.documentId} · {formatBytes(d.fileSizeBytes)} · {timeAgo(d.uploadedAt)}
                        </p>
                      </div>
                      {active ? (
                        <StatusPill tone={stageTone}>{stage}</StatusPill>
                      ) : (
                        <span className="hidden text-[11px] text-muted-foreground sm:block">expired from view</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </SectionCard>

          <SectionCard
            title="Processing history"
            description="Every action this session, in order. The journal lives in memory only."
          >
            {history.length === 0 ? (
              <EmptyState
                icon={ScanSearch}
                title="Nothing processed yet"
                description="Upload, detection, redaction and verification events will appear here."
                className="border-0 bg-transparent"
              />
            ) : (
              <ol className="relative space-y-0">
                {history.map((e, i) => {
                  const Icon = HISTORY_ICONS[e.kind] ?? FileText;
                  return (
                    <li key={e.id} className="relative flex gap-3 pb-4 last:pb-0">
                      {i < history.length - 1 && (
                        <span className="absolute left-[13px] top-7 h-[calc(100%-1.6rem)] w-px bg-border" aria-hidden />
                      )}
                      <span
                        className={cn(
                          'z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border bg-card',
                          e.kind === 'error' ? 'border-[#ecc9c1] text-[#b3261e]' : 'border-border text-muted-foreground'
                        )}
                      >
                        <Icon className="h-3.5 w-3.5" aria-hidden />
                      </span>
                      <div className="min-w-0 pt-0.5">
                        <p className="text-[13px] font-medium leading-5">{e.title}</p>
                        {e.detail ? <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{e.detail}</p> : null}
                        <p className="mt-0.5 font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground/70">
                          {timeAgo(e.at)}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </SectionCard>
        </div>

        {/* Right: workflow + honesty */}
        <div className="space-y-6">
          <SectionCard title="Current workflow" description="Where the active document stands right now.">
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <StatusPill tone={stageTone}>{stage}</StatusPill>
                {detection ? (
                  <span className="font-mono text-xs text-muted-foreground">
                    {detection.totalDetected} detected
                  </span>
                ) : null}
              </div>
              <Button
                className="w-full gap-2"
                onClick={() => setView(doc ? 'studio' : 'upload')}
              >
                {doc ? 'Continue in Redaction Studio' : 'Upload a document'} <ArrowRight className="h-4 w-4" aria-hidden />
              </Button>
              <ul className="space-y-2 pt-1 text-[13px] text-muted-foreground">
                {[
                  ['Upload & extract', 'Text layer or OCR fallback'],
                  ['Review detections', 'Regex patterns with confidence'],
                  ['Redact selectively', 'Raster rebuild — permanently gone'],
                  ['Verify what remains', 'Re-extraction + OCR on the copy'],
                  ['Record the share', 'Local ledger with SHA-256'],
                ].map(([t, d], i) => (
                  <li key={t} className="flex gap-2.5">
                    <span className="mt-0.5 font-mono text-[10px] leading-5 text-muted-foreground/60">0{i + 1}</span>
                    <span className="min-w-0">
                      <span className="font-medium text-foreground">{t}</span> — {d}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </SectionCard>

          <InfoNotice tone="warning" title="What DocShield can't promise">
            <ul className="list-disc space-y-1 pl-4">
              <li>Regex detection can miss unusual or context-dependent formats.</li>
              <li>Address matching is heuristic and needs human review.</li>
              <li>Verification only proves the automated checks found nothing — it is not proof that no sensitive data remains.</li>
            </ul>
          </InfoNotice>

          <SectionCard title="Engine" description={health?.service ?? 'DocShield processing service'}>
            <dl className="space-y-1 text-[13px]">
              <div className="flex justify-between gap-3 py-0.5">
                <dt className="text-muted-foreground">Status</dt>
                <dd className="font-medium">{health?.status ?? (healthState === 'error' ? 'unreachable' : 'checking')}</dd>
              </div>
              <div className="flex justify-between gap-3 py-0.5">
                <dt className="text-muted-foreground">Accepted types</dt>
                <dd className="font-mono text-xs">{health?.config.allowedMimeTypes.join(', ') ?? 'application/pdf'}</dd>
              </div>
              <div className="flex justify-between gap-3 py-0.5">
                <dt className="text-muted-foreground">Retention</dt>
                <dd className="font-medium">30 min, then deleted</dd>
              </div>
              <div className="flex justify-between gap-3 py-0.5">
                <dt className="text-muted-foreground">External calls</dt>
                <dd className="font-medium">None</dd>
              </div>
            </dl>
            <p className="mt-3 flex items-center gap-1.5 border-t border-border pt-3 text-xs text-muted-foreground">
              <Database className="h-3.5 w-3.5" aria-hidden />
              Nothing is stored in your browser — a refresh clears the workspace.
            </p>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
