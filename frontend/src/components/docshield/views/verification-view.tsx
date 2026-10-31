'use client';

/**
 * Verification — runs the engine's post-redaction checks (text re-extraction
 * + OCR) and surfaces the actual outcome: removed, unresolved, remaining.
 * Also hosts the report download and the SHA-256 fingerprint.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  CircleCheck,
  Download,
  FileJson,
  Loader2,
  ScanSearch,
  ShieldAlert,
  ShieldCheck,
  Timer,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import { useDocShield } from '@/lib/docshield/store';
import { getReport, protectedPdfDownloadUrl, verifyPdf } from '@/lib/docshield/api';
import { deriveVerificationStatus } from '@/lib/docshield/types';
import { formatBytes, formatDateTime, formatDuration } from '@/lib/docshield/format';
import {
  CategoryBadge,
  ConfidenceBadge,
  CopyButton,
  EmptyState,
  ErrorPanel,
  FingerprintField,
  InfoNotice,
  KeyValue,
  MetricTile,
  ProgressStages,
  SectionCard,
  StatusPill,
  ViewHeader,
} from '../primitives';

const VERIFY_STAGES = [
  'Re-extracting the text layer from the protected PDF',
  'Running Tesseract OCR across rendered pages',
  'Comparing selected values against what the engine can still see',
];

export function VerificationView() {
  const doc = useDocShield((s) => s.doc);
  const redaction = useDocShield((s) => s.redaction);
  const verification = useDocShield((s) => s.verification);
  const report = useDocShield((s) => s.report);
  const verifyRunning = useDocShield((s) => s.verifyRunning);
  const setVerifyRunning = useDocShield((s) => s.setVerifyRunning);
  const setVerification = useDocShield((s) => s.setVerification);
  const addHistory = useDocShield((s) => s.addHistory);
  const setView = useDocShield((s) => s.setView);

  const [runOcr, setRunOcr] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [stage, setStage] = useState(0);
  const [reportDownloadBusy, setReportDownloadBusy] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (verifyRunning) {
      setElapsed(0);
      setStage(0);
      timerRef.current = setInterval(() => {
        setElapsed((s) => s + 0.25);
        setStage((prev) => {
          // Presentational stage estimate; the authoritative result is the API response.
          if (prev === 0 && elapsed > 2) return 1;
          if (prev === 1 && elapsed > 6) return 2;
          return prev;
        });
      }, 250);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [verifyRunning, elapsed]);

  const runVerification = useCallback(async () => {
    if (!doc || verifyRunning) return;
    setError(null);
    setVerifyRunning(true);
    try {
      const resp = await verifyPdf(doc.documentId, runOcr);
      setVerification(resp.verification, resp.report);
      addHistory({
        kind: 'verify',
        title: `Verification — ${resp.verification.selectedStillDetectableCount === 0 ? 'no selected value remains detectable' : `${resp.verification.selectedStillDetectableCount} selected value(s) still detectable`}`,
        detail: `${resp.verification.successfullyRemovedCount}/${resp.verification.selectedItemsCount} removed · ${resp.verification.remainingItems.length} remaining pattern(s) · report ${resp.reportId}`,
      });
      import('sonner').then(({ toast }) => toast.success('Verification finished', { description: `Report ${resp.reportId} generated.` }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Verification failed.';
      setError(msg);
      addHistory({ kind: 'error', title: 'Verification failed', detail: msg });
      import('sonner').then(({ toast }) => toast.error(msg));
    } finally {
      setVerifyRunning(false);
    }
  }, [doc, verifyRunning, runOcr, setVerifyRunning, setVerification, addHistory]);

  const downloadReport = useCallback(async () => {
    if (!report || reportDownloadBusy) return;
    setReportDownloadBusy(true);
    try {
      // Fetch fresh from the engine so the downloaded file is provably the stored report.
      const resp = await getReport(report.reportId);
      const blob = new Blob([JSON.stringify(resp.report, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `docshield-report-${report.reportId}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      import('sonner').then(({ toast }) => toast.success('Report downloaded (JSON).'));
    } catch (e) {
      import('sonner').then(({ toast }) =>
        toast.error(e instanceof Error ? e.message : 'The report could not be downloaded.')
      );
    } finally {
      setReportDownloadBusy(false);
    }
  }, [report, reportDownloadBusy]);

  const status = useMemo(() => (verification ? deriveVerificationStatus(verification) : null), [verification]);

  if (!doc || !redaction) {
    return (
      <div className="space-y-6">
        <ViewHeader eyebrow="Step 04 — Verify" title="Verification" />
        <EmptyState
          icon={ShieldCheck}
          title="No protected document yet"
          description="Verification checks the redacted copy — generate it in the Redaction Studio first."
          action={<Button onClick={() => setView('studio')}>Open Redaction Studio</Button>}
        />
      </div>
    );
  }

  /* ----------------------------- running ----------------------------- */
  if (verifyRunning) {
    return (
      <div className="space-y-6">
        <ViewHeader
          eyebrow="Step 04 — Verify"
          title="Verifying the protected copy…"
          description="The engine is re-reading the redacted PDF exactly like an attacker would: first the text layer, then OCR over the rendered pixels."
        />
        <SectionCard>
          <Progress value={undefined} className="h-1.5" aria-label="Verification in progress" />
          <div className="mt-5">
            <ProgressStages stages={VERIFY_STAGES} current={stage} />
          </div>
          <p className="mt-5 flex items-center gap-2 border-t border-border pt-4 font-mono text-xs text-muted-foreground">
            <Timer className="h-3.5 w-3.5" aria-hidden /> {formatDuration(elapsed)} elapsed — OCR is the slow part; keep this tab open.
          </p>
        </SectionCard>
      </div>
    );
  }

  /* ----------------------------- result ------------------------------ */
  if (verification && report) {
    const unresolved = [
      ...verification.selectedStillDetectable.map((i) => ({
        item: i,
        reason: 'You selected this for redaction, but it is still detectable in the protected copy.',
      })),
      ...verification.remainingItems
        .filter((r) => !verification.selectedStillDetectable.some((s) => s.id === r.id))
        .map((i) => ({
          item: i,
          reason: i.detectionStatus || 'Sensitive pattern still detectable (for example, left unselected).',
        })),
    ];

    return (
      <div className="space-y-5">
        <ViewHeader
          eyebrow="Step 04 — Verify"
          title="Verification result"
          description={`${doc.fileName} · checks ran ${formatDateTime(report.generatedAt)}`}
          actions={
            <>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={runVerification} disabled={verifyRunning}>
                <ScanSearch className="h-3.5 w-3.5" aria-hidden /> Re-run verification
              </Button>
              <Button
                size="sm"
                className="gap-1.5 border border-[#aedd53] bg-accent text-accent-foreground hover:bg-accent/85"
                onClick={() => setView('share')}
              >
                Continue to Share Record <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </>
          }
        />

        {/* Status banner */}
        {status === 'PASSED' ? (
          <InfoNotice tone="success" title="Selected values are no longer detectable">
            All {verification.selectedItemsCount} selected value(s) were confirmed removed by text re-extraction
            {verification.methodsUsed.includes('tesseract-ocr-scan') ? ' and OCR' : ''}. No other supported patterns were found.
          </InfoNotice>
        ) : null}
        {status === 'PARTIAL' ? (
          <InfoNotice tone="warning" title="Partial exposure — other sensitive patterns remain">
            The values you selected were removed, but {verification.remainingItems.length} sensitive item(s) remain detectable in the
            protected copy. Review the list below before sharing.
          </InfoNotice>
        ) : null}
        {status === 'FAILED' ? (
          <InfoNotice tone="error" title="Attention — selected values are still detectable">
            {verification.selectedStillDetectableCount} of the values you asked DocShield to remove can still be found by the
            automated checks. Do not share this copy; return to the studio and re-run redaction.
          </InfoNotice>
        ) : null}

        {/* Metrics */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricTile label="Selected for redaction" value={verification.selectedItemsCount} sub={redaction.mode + ' mode'} />
          <MetricTile
            label="Verified removed"
            value={verification.successfullyRemovedCount}
            tone="success"
            icon={CircleCheck}
            sub="no longer detectable"
          />
          <MetricTile
            label="Still detectable (selected)"
            value={verification.selectedStillDetectableCount}
            tone={verification.selectedStillDetectableCount > 0 ? 'destructive' : 'neutral'}
            icon={ShieldAlert}
            sub="unresolved findings"
          />
          <MetricTile
            label="Remaining patterns"
            value={verification.remainingItems.length}
            tone={verification.remainingItems.length > 0 ? 'warning' : 'success'}
            icon={ScanSearch}
            sub="whole-document scan"
          />
        </div>

        {/* Methods + summary */}
        <SectionCard title="How this was checked" description="Verification is only as good as the checks behind it.">
          <div className="flex flex-wrap gap-1.5">
            {verification.methodsUsed.map((m) => (
              <span key={m} className="rounded-md border border-border bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                {m}
              </span>
            ))}
          </div>
          <dl className="mt-4 grid gap-x-8 sm:grid-cols-2">
            <div><KeyValue label="Protected pages">{verification.postExtractionSummary.pageCount}</KeyValue></div>
            <div><KeyValue label="Extraction method">{verification.postExtractionSummary.extractionMethod}</KeyValue></div>
            <div><KeyValue label="Characters recovered">{verification.postExtractionSummary.totalCharactersExtracted}</KeyValue></div>
            <div><KeyValue label="Report ID"><span className="font-mono text-xs">{report.reportId}</span></KeyValue></div>
          </dl>
          <p className="mt-3 border-t border-border pt-3 text-[13px] leading-6 text-muted-foreground">
            {verification.verificationDisclaimer}
          </p>
        </SectionCard>

        {/* Unresolved findings */}
        <SectionCard
          title={`Unresolved findings (${unresolved.length})`}
          description="Anything the engine can still see in the protected copy."
        >
          {unresolved.length === 0 ? (
            <p className="flex items-center gap-2 text-[13px] text-[#2e7d4f]">
              <CircleCheck className="h-4 w-4" aria-hidden /> Nothing unresolved — no supported pattern remains detectable.
            </p>
          ) : (
            <ul className="space-y-2.5">
              {unresolved.map(({ item, reason }) => (
                <li key={`${item.id}-${reason.slice(0, 12)}`} className="flex flex-wrap items-start gap-3 rounded-lg border border-border bg-background p-3">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[#946200]" aria-hidden />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <CategoryBadge category={item.category} />
                      <ConfidenceBadge confidence={item.confidence} />
                      <span className="font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">p.{item.pageNumber}</span>
                    </div>
                    <p className="fingerprint">{item.text}</p>
                    <p className="text-[11px] text-muted-foreground">{reason}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        {/* Removed items */}
        <SectionCard title={`Verified removed (${verification.removedItems.length})`} description="Selected values the checks can no longer find.">
          {verification.removedItems.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">No items were confirmed removed.</p>
          ) : (
            <ul className="divide-y divide-border">
              {verification.removedItems.map((item) => (
                <li key={item.id} className="flex flex-wrap items-center gap-2.5 py-2.5 first:pt-0 last:pb-0">
                  <CircleCheck className="h-4 w-4 shrink-0 text-[#2e7d4f]" aria-hidden />
                  <CategoryBadge category={item.category} />
                  <span className="fingerprint min-w-0 flex-1 truncate">{item.text}</span>
                  <StatusPill tone="success">removed</StatusPill>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        {/* Report + downloads */}
        <SectionCard title="Privacy assessment report" description={report.beforeAndAfterAssessment.summary}>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-3">
              <div>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Indicative exposure reduction</span>
                  <span className="font-mono font-semibold text-foreground">{report.beforeAndAfterAssessment.indicativeReductionPercentage}%</span>
                </div>
                <Progress
                  value={report.beforeAndAfterAssessment.indicativeReductionPercentage}
                  className="mt-1.5 h-1.5 [&>div]:bg-[#8bb930]"
                  aria-label={`Indicative exposure reduction ${report.beforeAndAfterAssessment.indicativeReductionPercentage}%`}
                />
              </div>
              <dl className="divide-y divide-border">
                <KeyValue label="Before">{report.beforeAndAfterAssessment.beforeStatus}</KeyValue>
                <KeyValue label="After">{report.beforeAndAfterAssessment.afterStatus}</KeyValue>
                <KeyValue label="Generated">{formatDateTime(report.generatedAt)}</KeyValue>
              </dl>
            </div>
            <div className="space-y-2.5">
              <FingerprintField label="Protected PDF · SHA-256" hash={report.exportedDocumentIntegrity.sha256} />
              <FingerprintField label="Original PDF · SHA-256" hash={report.exportedDocumentIntegrity.originalDocumentSha256} />
            </div>
          </div>
          <p className="mt-4 border-t border-border pt-3 text-[12.5px] leading-5 text-muted-foreground">
            {report.beforeAndAfterAssessment.disclaimer}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="outline" className="gap-2" onClick={downloadReport} disabled={reportDownloadBusy}>
              {reportDownloadBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <FileJson className="h-4 w-4" aria-hidden />}
              Download report (JSON)
            </Button>
            <a href={protectedPdfDownloadUrl(doc.documentId)} download>
              <Button variant="outline" className="gap-2">
                <Download className="h-4 w-4" aria-hidden /> Download protected PDF
              </Button>
            </a>
            <CopyButton value={report.exportedDocumentIntegrity.sha256 ?? ''} label="Copy fingerprint" className="h-9 border border-input bg-card" />
          </div>
        </SectionCard>
      </div>
    );
  }

  /* ----------------------------- pre-run ----------------------------- */
  return (
    <div className="space-y-5">
      <ViewHeader
        eyebrow="Step 04 — Verify"
        title="Verification"
        description="Don't just redact — verify what remains exposed. The engine re-extracts the text layer and runs OCR on the protected copy, then reports exactly what it can still detect."
      />
      {error ? <ErrorPanel message={error} onRetry={runVerification} /> : null}

      <div className="grid gap-5 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <SectionCard title="Run the checks" description={`${redaction.selectedForRedactionCount} field(s) were masked in ${redaction.mode} mode.`}>
            <div className="space-y-4">
              <ProgressStages stages={VERIFY_STAGES} current={-1} className="[&>li]:text-muted-foreground" />
              <div className="flex items-center justify-between rounded-lg border border-border bg-muted/40 px-3.5 py-3">
                <div className="pr-3">
                  <Label htmlFor="ocr-switch" className="text-[13px] font-medium">Include OCR scan (recommended)</Label>
                  <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                    Renders each page and reads it back with Tesseract — slower, but catches values stripped from the text layer.
                  </p>
                </div>
                <Switch id="ocr-switch" checked={runOcr} onCheckedChange={setRunOcr} />
              </div>
              <Button className="w-full gap-2 sm:w-auto" onClick={runVerification} disabled={verifyRunning}>
                <ScanSearch className="h-4 w-4" aria-hidden /> Run verification
              </Button>
            </div>
          </SectionCard>
        </div>
        <div className="space-y-4 lg:col-span-2">
          <InfoNotice tone="warning" title="What a pass really means">
            A passed verification says the automated text-layer and OCR checks no longer detect the selected values. It is not
            proof that every sensitive field was found, and it cannot rule out forensic recovery by other means.
          </InfoNotice>
          <SectionCard title="Current document">
            <dl className="divide-y divide-border">
              <KeyValue label="Protected size">{formatBytes(redaction.redactedFileSizeBytes)}</KeyValue>
              <KeyValue label="Unselected fields">{redaction.unselectedCount}</KeyValue>
            </dl>
            <div className="mt-3">
              <FingerprintField label="Protected PDF · SHA-256" hash={redaction.redactedPdfSha256} />
            </div>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
