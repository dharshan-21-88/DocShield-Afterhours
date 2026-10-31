'use client';

/**
 * Share Record — the final protected version, integrity fingerprints, and a
 * locally recorded share ledger. DocShield never transmits a document to an
 * external recipient; the ledger records your confirmed sharing intent only.
 */

import { useCallback, useState } from 'react';
import {
  ArrowRight,
  CircleCheck,
  Download,
  FileJson,
  FileText,
  Info,
  NotebookPen,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useDocShield } from '@/lib/docshield/store';
import { getReport, protectedPdfDownloadUrl } from '@/lib/docshield/api';
import { formatBytes, formatDateTime, timeAgo } from '@/lib/docshield/format';
import { PdfPreview } from '../pdf-preview';
import {
  EmptyState,
  FingerprintField,
  InfoNotice,
  KeyValue,
  SectionCard,
  StatusPill,
  ViewHeader,
} from '../primitives';

export function ShareView() {
  const doc = useDocShield((s) => s.doc);
  const redaction = useDocShield((s) => s.redaction);
  const verification = useDocShield((s) => s.verification);
  const report = useDocShield((s) => s.report);
  const redactedPdfBytes = useDocShield((s) => s.redactedPdfBytes);
  const redactedBytesState = useDocShield((s) => s.redactedBytesState);
  const shares = useDocShield((s) => s.shares);
  const addShare = useDocShield((s) => s.addShare);
  const addHistory = useDocShield((s) => s.addHistory);
  const setView = useDocShield((s) => s.setView);
  const setRedactedBytes = useDocShield((s) => s.setRedactedBytes);
  const setRedactedBytesState = useDocShield((s) => s.setRedactedBytesState);

  const [recipient, setRecipient] = useState('');
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [reportBusy, setReportBusy] = useState(false);

  const recordShare = useCallback(() => {
    if (!doc || !report) return;
    if (!recipient.trim()) {
      setFormError('Give the share a recipient label — even "self / archive" works. This is your audit trail.');
      return;
    }
    setFormError(null);
    addShare({
      recipient: recipient.trim(),
      note: note.trim() || undefined,
      documentId: doc.documentId,
      fileName: doc.fileName,
      sha256: report.exportedDocumentIntegrity.sha256 ?? redaction?.redactedPdfSha256 ?? '',
      reportId: report.reportId,
    });
    addHistory({
      kind: 'share',
      title: `Share recorded — ${recipient.trim()}`,
      detail: `Local ledger entry · ${report.reportId} · SHA-256 ${(report.exportedDocumentIntegrity.sha256 ?? '').slice(0, 12)}…`,
    });
    setRecipient('');
    setNote('');
    import('sonner').then(({ toast }) =>
      toast.success('Share recorded locally', { description: 'DocShield did not send anything — the ledger entry is stored in this session only.' })
    );
  }, [doc, report, redaction, recipient, note, addShare, addHistory]);

  const downloadReport = useCallback(async () => {
    if (!report || reportBusy) return;
    setReportBusy(true);
    try {
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
    } catch (e) {
      import('sonner').then(({ toast }) =>
        toast.error(e instanceof Error ? e.message : 'The report could not be downloaded.')
      );
    } finally {
      setReportBusy(false);
    }
  }, [report, reportBusy]);

  const fetchPreview = useCallback(() => {
    if (!doc) return;
    setRedactedBytesState('loading');
    import('@/lib/docshield/api').then(({ fetchRedactedPdf }) =>
      fetchRedactedPdf(doc.documentId)
        .then((b) => setRedactedBytes(b))
        .catch(() => setRedactedBytesState('error'))
    );
  }, [doc, setRedactedBytes, setRedactedBytesState]);

  if (!doc || !redaction || !verification || !report) {
    return (
      <div className="space-y-6">
        <ViewHeader eyebrow="Step 05 — Share" title="Share Record" />
        <EmptyState
          icon={ShieldCheck}
          title="Verification required"
          description="The share record needs a verified, report-backed protected version. Run verification first."
          action={
            <Button className="gap-2" onClick={() => setView('verify')}>
              Go to Verification <ArrowRight className="h-4 w-4" aria-hidden />
            </Button>
          }
        />
      </div>
    );
  }

  const sha = report.exportedDocumentIntegrity.sha256 ?? '';

  return (
    <div className="space-y-5">
      <ViewHeader
        eyebrow="Step 05 — Share"
        title="Share Record"
        description="The final protected version, its integrity fingerprint, and an auditable record of who it was prepared for."
      />

      <div className="grid gap-5 lg:grid-cols-5">
        {/* Final version */}
        <div className="lg:col-span-3">
          <SectionCard
            title="Final protected version"
            description="The only artifact DocShield intends you to share."
            actions={<StatusPill tone="success" icon={CircleCheck}>verified</StatusPill>}
          >
            <div className="grid gap-4 sm:grid-cols-[minmax(0,180px)_1fr]">
              <div>
                {redactedPdfBytes ? (
                  <PdfPreview
                    data={redactedPdfBytes}
                    page={1}
                    showPageControls={false}
                    ariaLabel="Protected document first page"
                    className="[&>div]:border"
                  />
                ) : redactedBytesState === 'loading' ? (
                  <div className="flex h-[240px] items-center justify-center rounded-lg border border-dashed border-input bg-muted/40 text-xs text-muted-foreground">
                    Loading preview…
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={fetchPreview}
                    className="flex h-[240px] w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-input bg-muted/40 text-xs text-muted-foreground hover:bg-muted/70"
                  >
                    <FileText className="h-5 w-5" aria-hidden />
                    Load preview
                  </button>
                )}
              </div>
              <dl className="divide-y divide-border self-start">
                <KeyValue label="File">{doc.fileName}</KeyValue>
                <KeyValue label="Protected size">{formatBytes(report.exportedDocumentIntegrity.fileSizeBytes ?? redaction.redactedFileSizeBytes)}</KeyValue>
                <KeyValue label="Pages">{doc.pageCount}</KeyValue>
                <KeyValue label="Redaction mode">{report.redactionMode}</KeyValue>
                <KeyValue label="Report"><span className="font-mono text-xs">{report.reportId}</span></KeyValue>
                <KeyValue label="Generated">{formatDateTime(report.generatedAt)}</KeyValue>
              </dl>
            </div>

            <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
              <FingerprintField label="Integrity fingerprint · SHA-256" hash={sha} />
              <FingerprintField label="Original · SHA-256 (for reference)" hash={report.exportedDocumentIntegrity.originalDocumentSha256} />
            </div>

            <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4">
              <a href={protectedPdfDownloadUrl(doc.documentId)} download>
                <Button variant="outline" className="gap-2">
                  <Download className="h-4 w-4" aria-hidden /> Download protected PDF
                </Button>
              </a>
              <Button variant="outline" className="gap-2" onClick={downloadReport} disabled={reportBusy}>
                <FileJson className="h-4 w-4" aria-hidden /> Download report (JSON)
              </Button>
            </div>
          </SectionCard>

          <InfoNotice tone="info" title="Verification summary" className="mt-5">
            {report.beforeAndAfterAssessment.summary} {report.beforeAndAfterAssessment.disclaimer}
          </InfoNotice>
        </div>

        {/* Record share */}
        <div className="space-y-5 lg:col-span-2">
          <SectionCard title="Record a share" description="Confirm who this protected copy is being prepared for.">
            <div className="space-y-3.5">
              <div className="space-y-1.5">
                <Label htmlFor="share-recipient">Recipient label</Label>
                <Input
                  id="share-recipient"
                  placeholder="e.g. Admissions office, legal team, self/archive"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  maxLength={120}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="share-note">Note (optional)</Label>
                <Textarea
                  id="share-note"
                  placeholder="Context for this record — purpose, channel, ticket reference…"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  maxLength={400}
                  className="resize-none"
                />
              </div>
              {formError ? <p className="text-xs text-[#b3261e]">{formError}</p> : null}
              <Button className="w-full gap-2" onClick={recordShare}>
                <NotebookPen className="h-4 w-4" aria-hidden /> Record share entry
              </Button>
              <p className="flex items-start gap-1.5 text-[11.5px] leading-4 text-muted-foreground">
                <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                Recording is a local audit action in this session. DocShield does not send documents to external recipients, so no
                delivery confirmation is claimed — the timestamp and fingerprint are yours to verify against the file you hand over.
              </p>
            </div>
          </SectionCard>

          <SectionCard
            title={`Share ledger (${shares.length})`}
            description="Oldest entries at the bottom."
            bodyClassName={shares.length ? 'p-0' : undefined}
          >
            {shares.length === 0 ? (
              <EmptyState
                icon={NotebookPen}
                title="No shares recorded yet"
                description="Record an entry when you hand the protected file to someone — it keeps timestamp + fingerprint together."
                className="border-0 bg-transparent"
              />
            ) : (
              <ol className="divide-y divide-border">
                {shares.map((s) => (
                  <li key={s.id} className="space-y-1.5 px-4 py-3 sm:px-5">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-[13px] font-medium">{s.recipient}</p>
                      <StatusPill tone="accent">local record</StatusPill>
                    </div>
                    {s.note ? <p className="text-xs leading-5 text-muted-foreground">{s.note}</p> : null}
                    <p className="font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">
                      {formatDateTime(s.at)} · {timeAgo(s.at)}
                    </p>
                    <p className="fingerprint text-muted-foreground">sha256 {s.sha256.slice(0, 32)}…</p>
                    <p className="font-mono text-[10.5px] text-muted-foreground">report {s.reportId}</p>
                  </li>
                ))}
              </ol>
            )}
          </SectionCard>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3.5">
        <p className="text-[13px] text-muted-foreground">
          Done with this document? Start the next one — the workspace keeps history for this session only.
        </p>
        <Button variant="outline" size="sm" className="gap-2" onClick={() => setView('upload')}>
          Protect another document <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>
    </div>
  );
}
