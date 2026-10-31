'use client';

/**
 * Privacy Risk Lens — side-by-side original vs protected preview with real
 * detected-field counts. The "after" column is measured by the verification
 * engine; until that scan runs, the UI says so instead of guessing.
 */

import { useCallback, useMemo, useState } from 'react';
import { ArrowRight, CircleCheck, Loader2, ScanSearch, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useDocShield } from '@/lib/docshield/store';
import { fetchRedactedPdf, verifyPdf } from '@/lib/docshield/api';
import type { DetectionItem } from '@/lib/docshield/types';
import { useOriginalBytesAutoload } from '../hooks';
import { PdfPreview, type PdfOverlay } from '../pdf-preview';
import {
  CategoryBadge,
  ConfidenceBadge,
  EmptyState,
  ErrorPanel,
  InfoNotice,
  MetricTile,
  SectionCard,
  SpinnerLine,
  StatusPill,
  ViewHeader,
} from '../primitives';

export function RiskLensView() {
  const doc = useDocShield((s) => s.doc);
  const detection = useDocShield((s) => s.detection);
  const redaction = useDocShield((s) => s.redaction);
  const redactedPdfBytes = useDocShield((s) => s.redactedPdfBytes);
  const redactedBytesState = useDocShield((s) => s.redactedBytesState);
  const setRedactedBytes = useDocShield((s) => s.setRedactedBytes);
  const setRedactedBytesState = useDocShield((s) => s.setRedactedBytesState);
  const verification = useDocShield((s) => s.verification);
  const report = useDocShield((s) => s.report);
  const verifyRunning = useDocShield((s) => s.verifyRunning);
  const setVerifyRunning = useDocShield((s) => s.setVerifyRunning);
  const setVerification = useDocShield((s) => s.setVerification);
  const addHistory = useDocShield((s) => s.addHistory);
  const setView = useDocShield((s) => s.setView);

  const { originalPdfBytes, originalBytesState } = useOriginalBytesAutoload();
  const [page, setPage] = useState(1);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);

  const items = detection?.items ?? [];

  const originalOverlays: PdfOverlay[] = useMemo(
    () =>
      items
        .filter((i) => i.pageNumber === page && i.boundingBox)
        .map((i) => ({
          id: i.id,
          x: i.boundingBox!.x,
          y: i.boundingBox!.y,
          width: i.boundingBox!.width,
          height: i.boundingBox!.height,
          label: `${i.categoryLabel}: ${i.text}`,
          tone: 'detected' as const,
        })),
    [items, page]
  );

  const remainingOverlays: PdfOverlay[] = useMemo(
    () =>
      (verification?.remainingItems ?? [])
        .filter((i) => i.pageNumber === page && i.boundingBox)
        .map((i) => ({
          id: i.id,
          x: i.boundingBox!.x,
          y: i.boundingBox!.y,
          width: i.boundingBox!.width,
          height: i.boundingBox!.height,
          label: `Still detectable: ${i.text}`,
          tone: 'remaining' as const,
        })),
    [verification, page]
  );

  const beforeBreakdown = Object.entries(detection?.categoryBreakdown ?? {});
  const afterBreakdown = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of verification?.remainingItems ?? []) {
      map.set(item.category, (map.get(item.category) ?? 0) + 1);
    }
    return Array.from(map.entries());
  }, [verification]);

  const runVerificationScan = useCallback(async () => {
    if (!doc || verifyRunning) return;
    setVerifyError(null);
    setVerifyRunning(true);
    try {
      const resp = await verifyPdf(doc.documentId, true);
      setVerification(resp.verification, resp.report);
      addHistory({
        kind: 'verify',
        title: `Verification scan — ${resp.verification.remainingItems.length} item(s) remain detectable`,
        detail: `${resp.verification.successfullyRemovedCount}/${resp.verification.selectedItemsCount} selected values confirmed removed · methods: ${resp.verification.methodsUsed.join(' + ')}`,
      });
      import('sonner').then(({ toast }) => toast.success('Verification scan complete', { description: 'The comparison below now uses measured results.' }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Verification failed.';
      setVerifyError(msg);
      import('sonner').then(({ toast }) => toast.error(msg));
    } finally {
      setVerifyRunning(false);
    }
  }, [doc, verifyRunning, setVerifyRunning, setVerification, addHistory]);

  const retryRedactedFetch = useCallback(() => {
    if (!doc) return;
    setRedactedBytesState('loading');
    fetchRedactedPdf(doc.documentId)
      .then((b) => setRedactedBytes(b))
      .catch(() => setRedactedBytesState('error'));
  }, [doc, setRedactedBytes, setRedactedBytesState]);

  if (!doc || !redaction) {
    return (
      <div className="space-y-6">
        <ViewHeader eyebrow="Step 03 — Compare" title="Privacy Risk Lens" />
        <EmptyState
          icon={ShieldCheck}
          title="Nothing to compare yet"
          description="Generate a protected PDF in the Redaction Studio first — then this view shows before and after, side by side."
          action={<Button onClick={() => setView('studio')}>Open Redaction Studio</Button>}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <ViewHeader
        eyebrow="Step 03 — Compare"
        title="Privacy Risk Lens"
        description="The original next to the protected rebuild. Counts come from the engine's actual detections — the 'after' numbers only appear once a verification scan has measured the protected copy."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setView('studio')}>
              Back to Studio
            </Button>
            <Button
              size="sm"
              className="gap-1.5 border border-[#aedd53] bg-accent text-accent-foreground hover:bg-accent/85"
              onClick={() => setView('verify')}
            >
              Verification details <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </Button>
          </>
        }
      />

      {/* Before / after summary */}
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold">Before — original document</p>
            <StatusPill tone="warning">{detection ? `${detection.totalDetected} detected` : 'not scanned'}</StatusPill>
          </div>
          {beforeBreakdown.length === 0 ? (
            <p className="mt-2 text-[13px] text-muted-foreground">No supported sensitive patterns were detected.</p>
          ) : (
            <ul className="mt-3 flex flex-wrap gap-1.5">
              {beforeBreakdown.map(([cat, count]) => (
                <li key={cat}>
                  <CategoryBadge category={cat as DetectionItem['category']} label={`${cat.replace(/_/g, ' ').toLowerCase()} × ${count}`} />
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 font-mono text-[11px] text-muted-foreground">
            sha256 {redaction ? '' : ''}{(detection?.documentId ?? doc.documentId) ? '' : ''}
            {doc.originalSha256.slice(0, 24)}…
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold">After — protected document</p>
            {verification ? (
              verification.remainingItems.length === 0 ? (
                <StatusPill tone="success" icon={ShieldCheck}>0 remain detectable</StatusPill>
              ) : (
                <StatusPill tone="warning" icon={ShieldAlert}>{verification.remainingItems.length} remain detectable</StatusPill>
              )
            ) : (
              <StatusPill tone="neutral">not measured yet</StatusPill>
            )}
          </div>
          {verification ? (
            afterBreakdown.length === 0 ? (
              <p className="mt-2 text-[13px] text-muted-foreground">
                The verification scan found none of the supported patterns in the protected copy.
              </p>
            ) : (
              <ul className="mt-3 flex flex-wrap gap-1.5">
                {afterBreakdown.map(([cat, count]) => (
                  <li key={cat}>
                    <CategoryBadge category={cat as DetectionItem['category']} label={`${cat.replace(/_/g, ' ').toLowerCase()} × ${count}`} />
                  </li>
                ))}
              </ul>
            )
          ) : (
            <div className="mt-2 flex flex-col items-start gap-2.5">
              <p className="text-[13px] text-muted-foreground">
                Run the verification scan to measure what the engine can still detect in the protected copy.
              </p>
              <Button size="sm" variant="outline" className="gap-2" onClick={runVerificationScan} disabled={verifyRunning}>
                {verifyRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <ScanSearch className="h-3.5 w-3.5" aria-hidden />}
                {verifyRunning ? 'Scanning protected copy…' : 'Run verification scan'}
              </Button>
            </div>
          )}
          <p className="mt-3 font-mono text-[11px] text-muted-foreground">sha256 {redaction.redactedPdfSha256.slice(0, 24)}…</p>
        </div>
      </div>

      {verifyError ? <ErrorPanel message={verifyError} onRetry={runVerificationScan} /> : null}

      {/* Side-by-side previews */}
      <div className="grid gap-5 lg:grid-cols-2">
        <SectionCard
          title="Original"
          description={`${doc.fileName} · ${detection ? `${detection.totalDetected} highlighted` : 'not scanned'}`}
          actions={<StatusPill tone="warning">exposed</StatusPill>}
        >
          {originalBytesState === 'loading' ? (
            <div className="flex min-h-[360px] items-center justify-center rounded-lg border border-dashed border-input bg-muted/40">
              <SpinnerLine label="Loading original preview…" />
            </div>
          ) : originalPdfBytes ? (
            <PdfPreview
              data={originalPdfBytes}
              page={page}
              onPageChange={setPage}
              overlays={originalOverlays}
              highlightId={highlightId}
              ariaLabel="Original document preview"
            />
          ) : (
            <EmptyState icon={ShieldAlert} title="Original preview unavailable" description="The original file has expired on the engine." />
          )}
        </SectionCard>

        <SectionCard
          title="Protected"
          description={`Raster rebuild · ${redaction.selectedForRedactionCount} field(s) masked permanently`}
          actions={<StatusPill tone="success" icon={CircleCheck}>redacted</StatusPill>}
        >
          {redactedBytesState === 'loading' ? (
            <div className="flex min-h-[360px] items-center justify-center rounded-lg border border-dashed border-input bg-muted/40">
              <SpinnerLine label="Loading protected preview…" />
            </div>
          ) : redactedBytesState === 'error' || !redactedPdfBytes ? (
            <EmptyState
              icon={ShieldAlert}
              title="Protected preview unavailable"
              description="The protected PDF could not be streamed for preview. Downloads still work from the Verification step."
              action={
                <Button variant="outline" size="sm" onClick={retryRedactedFetch}>
                  Retry
                </Button>
              }
            />
          ) : (
            <PdfPreview
              data={redactedPdfBytes}
              page={page}
              onPageChange={setPage}
              overlays={remainingOverlays}
              highlightId={highlightId}
              ariaLabel="Protected document preview"
            />
          )}
        </SectionCard>
      </div>

      {/* Still detectable list */}
      {verification ? (
        <SectionCard
          title={`Still detectable after redaction (${verification.remainingItems.length})`}
          description="Measured by re-extracting text and running OCR on the protected copy."
        >
          {verification.remainingItems.length === 0 ? (
            <InfoNotice tone="success" title="No supported patterns remain detectable">
              The automated checks found none of the supported sensitive formats in the protected copy. This does not mean the
              document is guaranteed to contain no sensitive information — review it visually before sharing.
            </InfoNotice>
          ) : (
            <ul className="space-y-2.5">
              {verification.remainingItems.map((item) => (
                <li
                  key={`${item.id}-${item.pageNumber}`}
                  className="flex flex-wrap items-start gap-3 rounded-lg border border-[#ead9a4] bg-[#faf3dd]/60 p-3"
                >
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[#946200]" aria-hidden />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <CategoryBadge category={item.category} />
                      <ConfidenceBadge confidence={item.confidence} />
                      <span className="font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">p.{item.pageNumber}</span>
                    </div>
                    <p className="fingerprint">{item.text}</p>
                    <p className="text-[11px] text-muted-foreground">{item.detectionStatus}</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 shrink-0 text-xs"
                    onClick={() => {
                      setPage(item.pageNumber);
                      setHighlightId(item.id);
                      setTimeout(() => setHighlightId(null), 2600);
                    }}
                  >
                    Locate on page
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      ) : null}

      <InfoNotice tone="info" title="How to read this comparison">
        The protected copy is a raster rebuild — its pages are images, so copy-paste extraction of the original text is no longer
        possible. The overlays on the right mark anything the verification engine can <em>still</em> detect (for example, fields you
        deliberately left unselected).{report ? ' ' + report.beforeAndAfterAssessment.disclaimer : ''}
      </InfoNotice>
    </div>
  );
}
