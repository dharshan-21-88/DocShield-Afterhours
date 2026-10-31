'use client';

/**
 * Redaction Studio — review detected sensitive fields, filter by category,
 * select what to remove, and trigger a permanent raster rebuild.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  CheckSquare,
  EyeOff,
  Info,
  Loader2,
  RotateCcw,
  ScanSearch,
  SquareDashed,
  SquareDashedBottom,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { useDocShield } from '@/lib/docshield/store';
import { detectSensitive, fetchRedactedPdf, redactPdf } from '@/lib/docshield/api';
import { ApiError } from '@/lib/docshield/api';
import type { DetectionCategory, DetectionItem } from '@/lib/docshield/types';
import { useOriginalBytesAutoload } from '../hooks';
import { PdfPreview, type PdfOverlay } from '../pdf-preview';
import {
  CategoryBadge,
  ConfidenceBadge,
  CONFIDENCE_META,
  EmptyState,
  ErrorPanel,
  InfoNotice,
  SectionCard,
  SpinnerLine,
  StatusPill,
  ViewHeader,
} from '../primitives';

export function StudioView() {
  const doc = useDocShield((s) => s.doc);
  const detection = useDocShield((s) => s.detection);
  const detectionRunning = useDocShield((s) => s.detectionRunning);
  const detectionError = useDocShield((s) => s.detectionError);
  const setDetection = useDocShield((s) => s.setDetection);
  const setDetectionRunning = useDocShield((s) => s.setDetectionRunning);
  const setDetectionError = useDocShield((s) => s.setDetectionError);
  const selectedIds = useDocShield((s) => s.selectedIds);
  const setSelectedIds = useDocShield((s) => s.setSelectedIds);
  const toggleSelectedId = useDocShield((s) => s.toggleSelectedId);
  const redaction = useDocShield((s) => s.redaction);
  const redactionRunning = useDocShield((s) => s.redactionRunning);
  const setRedaction = useDocShield((s) => s.setRedaction);
  const setRedactionRunning = useDocShield((s) => s.setRedactionRunning);
  const setRedactedBytes = useDocShield((s) => s.setRedactedBytes);
  const setRedactedBytesState = useDocShield((s) => s.setRedactedBytesState);
  const addHistory = useDocShield((s) => s.addHistory);
  const setView = useDocShield((s) => s.setView);

  const { originalPdfBytes, originalBytesState, retryOriginalFetch } = useOriginalBytesAutoload();

  const [page, setPage] = useState(1);
  const [activeCategories, setActiveCategories] = useState<Set<DetectionCategory>>(new Set());
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [redactError, setRedactError] = useState<ApiError | null>(null);
  const autoSelectedRef = useRef<string | null>(null);

  /* ---------------- detection ---------------- */

  const runDetection = useCallback(async () => {
    if (!doc) return;
    setDetectionRunning(true);
    setDetectionError(null);
    try {
      const resp = await detectSensitive(doc.documentId);
      setDetection(resp);
      addHistory({
        kind: 'detect',
        title: `Detection finished — ${resp.totalDetected} item(s) found`,
        detail:
          Object.entries(resp.categoryBreakdown)
            .map(([k, v]) => `${k} ×${v}`)
            .join(', ') || 'no supported patterns matched',
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Detection failed.';
      setDetectionError(msg);
      import('sonner').then(({ toast }) => toast.error(msg));
    } finally {
      setDetectionRunning(false);
    }
  }, [doc, addHistory, setDetection, setDetectionError, setDetectionRunning]);

  useEffect(() => {
    if (doc && !detection && !detectionRunning && !detectionError) {
      runDetection();
    }
  }, [doc, detection, detectionRunning, detectionError, runDetection]);

  /* Default: select everything as soon as a fresh detection lands. */
  useEffect(() => {
    if (!detection || detection.items.length === 0) return;
    if (autoSelectedRef.current === detection.documentId) return;
    autoSelectedRef.current = detection.documentId;
    setSelectedIds(detection.items.map((i) => i.id));
    setActiveCategories(new Set(Object.keys(detection.categoryBreakdown) as DetectionCategory[]));
  }, [detection, setSelectedIds]);

  /* ---------------- derived ---------------- */

  const items = detection?.items ?? [];
  const categories = useMemo(
    () => Array.from(new Set(items.map((i) => i.category))) as DetectionCategory[],
    [items]
  );
  const filteredItems = useMemo(
    () => (activeCategories.size === 0 ? items : items.filter((i) => activeCategories.has(i.category))),
    [items, activeCategories]
  );
  const filteredSelected = filteredItems.filter((i) => selectedIds.includes(i.id));
  const pageItems = filteredItems.filter((i) => i.pageNumber === page);

  const overlays: PdfOverlay[] = pageItems
    .filter((i) => i.boundingBox)
    .map((i) => ({
      id: i.id,
      x: i.boundingBox!.x,
      y: i.boundingBox!.y,
      width: i.boundingBox!.width,
      height: i.boundingBox!.height,
      label: `${i.categoryLabel}: ${i.text}`,
      tone: selectedIds.includes(i.id) ? 'selected' : 'detected',
    }));

  /* ---------------- actions ---------------- */

  const executeRedaction = useCallback(
    async (mode: 'automatic' | 'selective') => {
      if (!doc || redactionRunning) return;
      const targetIds = filteredSelected.map((i) => i.id);
      if (mode === 'selective' && targetIds.length === 0) {
        import('sonner').then(({ toast }) => toast.error('Select at least one detected field to redact.'));
        return;
      }
      setRedactError(null);
      setRedactionRunning(true);
      try {
        const resp = await redactPdf(
          doc.documentId,
          mode,
          mode === 'selective' ? targetIds : undefined
        );
        setRedaction(resp);
        addHistory({
          kind: 'redact',
          title: `Redaction rebuilt the document (${mode} mode)`,
          detail: `${resp.selectedForRedactionCount} item(s) masked · ${resp.unselectedCount} left unselected · SHA-256 ${resp.redactedPdfSha256.slice(0, 12)}…`,
        });
        import('sonner').then(({ toast }) =>
          toast.success('Protected PDF generated', { description: 'Compare the result in the Privacy Risk Lens.' })
        );
        setRedactedBytesState('loading');
        fetchRedactedPdf(doc.documentId)
          .then((b) => setRedactedBytes(b))
          .catch(() => setRedactedBytesState('error'));
        setView('lens');
      } catch (e) {
        const err = e instanceof ApiError ? e : new ApiError('UNKNOWN', 0, e instanceof Error ? e.message : 'Redaction failed.');
        setRedactError(err);
        import('sonner').then(({ toast }) => toast.error(err.message));
      } finally {
        setRedactionRunning(false);
      }
    },
    [doc, redactionRunning, filteredSelected, addHistory, setRedaction, setRedactionRunning, setRedactedBytes, setRedactedBytesState, setView]
  );

  const jumpToItem = useCallback(
    (item: DetectionItem) => {
      setPage(item.pageNumber);
      setHighlightId(item.id);
      setTimeout(() => setHighlightId(null), 2600);
    },
    []
  );

  /* ---------------- states ---------------- */

  if (!doc) {
    return (
      <div className="space-y-6">
        <ViewHeader eyebrow="Step 02 — Review & select" title="Redaction Studio" />
        <EmptyState
          icon={ScanSearch}
          title="No document in the workspace"
          description="Upload or load a sample document first — detection and selection happen here."
          action={<Button onClick={() => setView('upload')}>Go to upload</Button>}
        />
      </div>
    );
  }

  /* Already redacted: show a completion panel instead of the selection UI. */
  if (redaction) {
    return (
      <div className="space-y-6">
        <ViewHeader
          eyebrow="Step 02 — Review & select"
          title="Redaction Studio"
          description="This document has already been rebuilt with the selected fields permanently masked."
        />
        <SectionCard title="Redaction complete" description={`${doc.fileName} · ${redaction.mode} mode`}>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone="success">{redaction.selectedForRedactionCount} masked</StatusPill>
            {redaction.unselectedCount > 0 ? (
              <StatusPill tone="warning">{redaction.unselectedCount} left exposed</StatusPill>
            ) : (
              <StatusPill tone="neutral">nothing left unselected</StatusPill>
            )}
          </div>
          <p className="mt-3 max-w-2xl text-[13px] leading-6 text-muted-foreground">{redaction.notice}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button className="gap-2" onClick={() => setView('lens')}>
              Open Privacy Risk Lens <ArrowRight className="h-4 w-4" aria-hidden />
            </Button>
            <Button variant="outline" className="gap-2" onClick={() => setView('verify')}>
              Go to Verification
            </Button>
          </div>
        </SectionCard>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <ViewHeader
        eyebrow="Step 02 — Review & select"
        title="Redaction Studio"
        description={
          <>
            <span className="font-medium text-foreground">{doc.fileName}</span> — tick the values you want permanently masked.
            Selected pages are rasterized, masked at the pixel level, and rebuilt into a brand-new PDF.
          </>
        }
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={detectionRunning || redactionRunning}
              onClick={runDetection}
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Re-scan
            </Button>
            <Button
              size="sm"
              className="gap-1.5 border border-[#aedd53] bg-accent text-accent-foreground hover:bg-accent/85"
              disabled={redactionRunning || filteredSelected.length === 0}
              onClick={() => executeRedaction('selective')}
            >
              {redactionRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <EyeOff className="h-3.5 w-3.5" aria-hidden />}
              Redact selected ({filteredSelected.length})
            </Button>
          </>
        }
      />

      {detection && detection.totalDetected > 0 ? (
        <InfoNotice tone="info" title="Detection is heuristic — not exhaustive">
          {detection.disclaimer}
        </InfoNotice>
      ) : null}

      {detectionError ? (
        <ErrorPanel message={detectionError} onRetry={runDetection} />
      ) : null}
      {redactError ? <ErrorPanel code={redactError.code} message={redactError.message} /> : null}

      <div className="grid gap-5 lg:grid-cols-5">
        {/* Preview */}
        <div className="lg:col-span-3">
          <SectionCard
            title="Document preview"
            description={
              doc.usedOcrFallback
                ? 'Scanned document — text recovered via OCR; mask positions are approximate.'
                : 'Detected values are highlighted on the page.'
            }
            actions={
              <StatusPill tone={doc.origin === 'sample' ? 'neutral' : 'dark'}>
                {doc.origin === 'sample' ? `sample · ${doc.sampleId}` : 'your upload'}
              </StatusPill>
            }
          >
            {originalBytesState === 'loading' ? (
              <div className="flex min-h-[320px] items-center justify-center rounded-lg border border-dashed border-input bg-muted/40">
                <SpinnerLine label="Loading document preview…" />
              </div>
            ) : originalBytesState === 'error' || !originalPdfBytes ? (
              <div className="space-y-3">
                <EmptyState
                  icon={SquareDashedBottom}
                  title="Visual preview unavailable"
                  description="The original file could not be streamed for preview. You can still select fields from the list and redact."
                  className="border-0 bg-transparent"
                  action={
                    <Button variant="outline" size="sm" onClick={retryOriginalFetch}>
                      Retry preview
                    </Button>
                  }
                />
                <TextPreview />
              </div>
            ) : (
              <PdfPreview
                data={originalPdfBytes}
                page={page}
                onPageChange={setPage}
                overlays={overlays}
                highlightId={highlightId}
                onOverlayClick={(id) => {
                  const item = items.find((i) => i.id === id);
                  if (item) toggleSelectedId(item.id);
                }}
                ariaLabel={`Page ${page} of ${doc.fileName}`}
              />
            )}
          </SectionCard>
        </div>

        {/* Detections */}
        <div className="lg:col-span-2">
          <SectionCard
            title={`Detected fields${detection ? ` (${detection.totalDetected})` : ''}`}
            description="Values the engine believes are sensitive. Confidence reflects how strict the matching pattern is."
            bodyClassName="p-0"
          >
            {detectionRunning ? (
              <div className="flex min-h-[280px] flex-col items-center justify-center gap-3 p-6 text-center">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden />
                <p className="text-sm font-medium">Scanning pages for sensitive patterns…</p>
                <p className="max-w-xs text-xs text-muted-foreground">
                  Regex matching over the extracted text layer and OCR output.
                </p>
              </div>
            ) : !detection ? (
              <div className="p-5">
                <EmptyState icon={ScanSearch} title="Waiting for detection" className="border-0 bg-transparent" />
              </div>
            ) : items.length === 0 ? (
              <div className="space-y-4 p-5">
                <EmptyState
                  icon={CheckSquare}
                  title="No sensitive patterns detected"
                  description="None of the supported formats (phones, emails, IDs, addresses, financial identifiers) were matched. That is not a guarantee that the document contains nothing sensitive."
                  className="border-0 bg-transparent"
                />
                <Button variant="outline" className="w-full gap-2" onClick={() => executeRedaction('automatic')} disabled={redactionRunning}>
                  <EyeOff className="h-4 w-4" aria-hidden />
                  Continue with a clean rebuild (0 items)
                </Button>
              </div>
            ) : (
              <div className="flex h-full flex-col">
                {/* Filters */}
                <div className="border-b border-border px-4 py-3 sm:px-5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Categories</p>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => setActiveCategories(new Set(categories))}
                      >
                        All
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => setSelectedIds(filteredItems.map((i) => i.id))}
                      >
                        Select all
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => setSelectedIds(selectedIds.filter((id) => !filteredItems.some((i) => i.id === id)))}
                      >
                        None
                      </Button>
                    </div>
                  </div>
                  <ScrollArea className="whitespace-nowrap pb-1">
                    <div className="flex gap-1.5">
                      {categories.map((c) => {
                        const count = items.filter((i) => i.category === c).length;
                        const on = activeCategories.has(c);
                        return (
                          <button
                            key={c}
                            type="button"
                            aria-pressed={on}
                            onClick={() =>
                              setActiveCategories((prev) => {
                                const next = new Set(prev);
                                if (next.has(c)) next.delete(c);
                                else next.add(c);
                                return next;
                              })
                            }
                            className={cn(
                              'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                              on ? 'border-primary bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'
                            )}
                          >
                            {on ? <SquareDashed className="h-3 w-3" aria-hidden /> : null}
                            {c.replace(/_/g, ' ').toLowerCase()} · {count}
                          </button>
                        );
                      })}
                    </div>
                    <ScrollBar orientation="horizontal" />
                  </ScrollArea>
                </div>

                {/* Items */}
                <ScrollArea className="thin-scrollbar h-[430px] flex-1">
                  <ul className="divide-y divide-border">
                    {filteredItems.map((item) => {
                      const checked = selectedIds.includes(item.id);
                      return (
                        <li key={item.id}>
                          <div
                            role="button"
                            tabIndex={0}
                            onClick={() => jumpToItem(item)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                jumpToItem(item);
                              }
                            }}
                            onMouseEnter={() => item.boundingBox && setPage(item.pageNumber)}
                            className={cn(
                              'block w-full cursor-pointer px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:px-5',
                              item.pageNumber === page && highlightId === item.id && 'bg-accent/25'
                            )}
                            aria-label={`${item.categoryLabel}, page ${item.pageNumber}: ${item.text}. ${checked ? 'Selected for redaction' : 'Not selected'}. Press Enter to locate on page.`}
                          >
                            <div className="flex items-start gap-3">
                              <Checkbox
                                checked={checked}
                                onCheckedChange={() => toggleSelectedId(item.id)}
                                onClick={(e) => e.stopPropagation()}
                                aria-label={`Select ${item.categoryLabel} ${item.text} for redaction`}
                                className="mt-0.5 data-[state=checked]:border-[#5a7a1e] data-[state=checked]:bg-[#8bb930] data-[state=checked]:text-[#172622]"
                              />
                              <div className="min-w-0 flex-1 space-y-1.5">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <CategoryBadge category={item.category} />
                                  <ConfidenceBadge confidence={item.confidence} />
                                  <span className="font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">
                                    p.{item.pageNumber}
                                  </span>
                                </div>
                                <p className="fingerprint text-foreground" title={item.text}>
                                  {item.text}
                                </p>
                                <p className="flex items-start gap-1 text-[11px] leading-4 text-muted-foreground">
                                  <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                                  {item.detectionStatus}
                                </p>
                              </div>
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </ScrollArea>

                <div className="border-t border-border px-4 py-3 sm:px-5">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      {filteredSelected.length} of {filteredItems.length} shown fields selected
                    </span>
                    <span className="hidden items-center gap-1 sm:flex">
                      <span className="inline-block h-2.5 w-2.5 rounded-sm border border-[#5a7a1e] bg-[#c6f36a]/60" aria-hidden />
                      highlighted on preview
                    </span>
                  </div>
                </div>
              </div>
            )}
          </SectionCard>
        </div>
      </div>

      {/* Confidence legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-card px-4 py-3 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Confidence legend:</span>
        {(['HIGH', 'MEDIUM', 'LOW_UNCERTAIN'] as const).map((c) => {
          const meta = CONFIDENCE_META[c];
          return (
            <span key={c} className="flex items-center gap-1.5">
              <meta.icon className="h-3.5 w-3.5" aria-hidden />
              {meta.label} — {meta.hint}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** Fallback text-mode preview (extracted page snippets) used when the original PDF cannot be streamed. */
function TextPreview() {
  const doc = useDocShield((s) => s.doc);
  if (!doc) return null;
  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      <p className="text-xs font-medium text-muted-foreground">Extracted text preview</p>
      {doc.pages.map((p) => (
        <div key={p.pageNumber} className="rounded-lg border border-border bg-background p-3">
          <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            page {p.pageNumber} · {p.method} · {p.characterCount} chars
          </p>
          <p className="mt-1.5 whitespace-pre-wrap font-mono text-[11px] leading-5 text-muted-foreground">
            {p.textPreview}
          </p>
        </div>
      ))}
    </div>
  );
}
