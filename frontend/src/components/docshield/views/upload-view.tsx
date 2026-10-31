'use client';

/**
 * Upload — drag & drop intake, explicit sample loading, validation,
 * real upload progress, and honest error surfacing.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { CloudUpload, FileText, FileUp, FlaskConical, Loader2, ShieldCheck, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useDocShield, type SessionDoc } from '@/lib/docshield/store';
import { formatBytes, formatDateTime } from '@/lib/docshield/format';
import { ApiError, loadSample, listSamples, uploadPdfWithProgress } from '@/lib/docshield/api';
import type { SampleScenario, UploadResponse } from '@/lib/docshield/types';
import {
  ErrorPanel,
  InfoNotice,
  KeyValue,
  ProgressStages,
  SectionCard,
  StatusPill,
  ViewHeader,
} from '../primitives';

type Phase = 'idle' | 'uploading' | 'extracting' | 'loading-sample';

export function UploadView() {
  const health = useDocShield((s) => s.health);
  const setDocument = useDocShield((s) => s.setDocument);
  const addHistory = useDocShield((s) => s.addHistory);
  const setView = useDocShield((s) => s.setView);

  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [uploadPct, setUploadPct] = useState(0);
  const [error, setError] = useState<ApiError | null>(null);
  const [samples, setSamples] = useState<SampleScenario[] | null>(null);
  const [samplesError, setSamplesError] = useState<string | null>(null);
  const [busySampleId, setBusySampleId] = useState<string | null>(null);

  const maxBytes = health?.config.maxFileSizeBytes ?? 10 * 1024 * 1024;
  const working = phase !== 'idle';

  useEffect(() => {
    listSamples()
      .then((r) => setSamples(r.samples))
      .catch((e) => setSamplesError(e instanceof Error ? e.message : 'Samples could not be loaded.'));
  }, []);

  const acceptFile = useCallback(
    (f: File) => {
      setError(null);
      setValidationError(null);
      const isPdf = f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');
      if (!isPdf) {
        setValidationError(`"${f.name}" is not a PDF file. DocShield only accepts .pdf documents.`);
        return;
      }
      if (f.size === 0) {
        setValidationError('That file is empty (0 bytes).');
        return;
      }
      if (f.size > maxBytes) {
        setValidationError(`That file is ${formatBytes(f.size)} — the engine accepts up to ${formatBytes(maxBytes)}.`);
        return;
      }
      setFile(f);
    },
    [maxBytes]
  );

  const finishSuccess = useCallback(
    (resp: UploadResponse, origin: 'upload' | 'sample', originalBytes: ArrayBuffer | null) => {
      const doc: SessionDoc = {
        documentId: resp.documentId,
        fileName: resp.fileName,
        fileSizeBytes: resp.fileSizeBytes,
        originalSha256: resp.originalSha256,
        pageCount: resp.extraction.pageCount,
        extractionMethod: resp.extraction.extractionMethod,
        usedOcrFallback: resp.extraction.usedOcrFallback,
        totalCharacters: resp.extraction.totalCharacters,
        pages: resp.extraction.pages,
        sampleId: resp.sampleId,
        origin,
        uploadedAt: Date.now(),
      };
      setDocument(doc, originalBytes);
      addHistory({
        kind: 'upload',
        title: `Document intake — ${resp.fileName}`,
        detail: `${resp.extraction.pageCount} page(s) · extraction: ${resp.extraction.extractionMethod}${
          resp.extraction.usedOcrFallback ? ' (OCR fallback used)' : ''
        } · SHA-256 ${resp.originalSha256.slice(0, 12)}…`,
      });
      import('sonner').then(({ toast }) =>
        toast.success('Document ready', { description: 'Text extracted — moving to the Redaction Studio.' })
      );
      setView('studio');
    },
    [addHistory, setDocument, setView]
  );

  const processFile = useCallback(async () => {
    if (!file || working) return;
    setError(null);
    setPhase('uploading');
    setUploadPct(0);
    try {
      const bytesPromise = file.arrayBuffer();
      const resp = await uploadPdfWithProgress(file, setUploadPct);
      setPhase('extracting');
      const bytes = await bytesPromise;
      finishSuccess(resp, 'upload', bytes);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError('UNKNOWN', 0, e instanceof Error ? e.message : 'Upload failed.'));
      addHistory({ kind: 'error', title: 'Upload failed', detail: file.name });
    } finally {
      setPhase('idle');
      setUploadPct(0);
    }
  }, [file, working, finishSuccess, addHistory]);

  const applySample = useCallback(
    async (sample: SampleScenario) => {
      if (working) return;
      setError(null);
      setBusySampleId(sample.id);
      setPhase('loading-sample');
      try {
        const resp = await loadSample(sample.id);
        finishSuccess(resp, 'sample', null);
      } catch (e) {
        setError(e instanceof ApiError ? e : new ApiError('UNKNOWN', 0, e instanceof Error ? e.message : 'Sample could not be loaded.'));
        addHistory({ kind: 'error', title: 'Sample failed to load', detail: sample.title });
      } finally {
        setBusySampleId(null);
        setPhase('idle');
      }
    },
    [working, finishSuccess, addHistory]
  );

  return (
    <div className="space-y-6">
      <ViewHeader
        eyebrow="Step 01 — Intake"
        title="Protect a document"
        description="Upload a PDF to detect sensitive information. The engine validates the file, extracts its text layer (with OCR fallback for scans), and fingerprints it with SHA-256 — all in memory."
      />

      <div className="grid gap-6 lg:grid-cols-5">
        {/* Dropzone column */}
        <div className="space-y-4 lg:col-span-3">
          {!file ? (
            <div
              role="button"
              tabIndex={0}
              aria-label="Upload a PDF: drag and drop or press Enter to browse"
              onClick={() => !working && inputRef.current?.click()}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ' ') && !working) {
                  e.preventDefault();
                  inputRef.current?.click();
                }
              }}
              onDragOver={(e) => {
                e.preventDefault();
                if (!working) setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                if (working) return;
                const dropped = e.dataTransfer.files?.[0];
                if (dropped) acceptFile(dropped);
              }}
              className={cn(
                'bg-grid-paper flex min-h-[300px] cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 text-center transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                dragOver ? 'border-[#8bb930] bg-accent/20' : 'border-input hover:border-muted-foreground/40 hover:bg-muted/40',
                working && 'pointer-events-none opacity-60'
              )}
            >
              <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-card shadow-sm">
                <FileUp className="h-5 w-5 text-muted-foreground" aria-hidden />
              </span>
              <p className="mt-4 text-[15px] font-medium">Drag & drop your PDF here</p>
              <p className="mt-1 text-[13px] text-muted-foreground">or browse from your device</p>
              <Button type="button" variant="outline" className="mt-5 gap-2" tabIndex={-1} onClick={(e) => { e.stopPropagation(); inputRef.current?.click(); }}>
                <CloudUpload className="h-4 w-4" aria-hidden /> Browse files
              </Button>
              <p className="mt-4 text-xs text-muted-foreground">
                PDF only · up to {formatBytes(maxBytes)} · processed in memory, never stored
              </p>
              <input
                ref={inputRef}
                type="file"
                accept="application/pdf,.pdf"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) acceptFile(f);
                  e.target.value = '';
                }}
              />
            </div>
          ) : (
            <SectionCard
              title="Selected file"
              actions={
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 text-xs"
                  disabled={working}
                  onClick={() => {
                    setFile(null);
                    setValidationError(null);
                    setError(null);
                  }}
                >
                  <X className="h-3 w-3" aria-hidden /> Remove
                </Button>
              }
            >
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-muted">
                  <FileText className="h-5 w-5 text-muted-foreground" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" title={file.name}>{file.name}</p>
                  <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                    {formatBytes(file.size)} · {file.type || 'application/pdf'} · last modified {formatDateTime(file.lastModified)}
                  </p>
                </div>
              </div>

              {phase === 'uploading' || phase === 'extracting' ? (
                <div className="mt-5 space-y-4 border-t border-border pt-4">
                  <Progress value={phase === 'uploading' ? uploadPct : undefined} className="h-1.5" aria-label="Upload progress" />
                  <ProgressStages
                    stages={['Uploading file', 'Validating & extracting text', 'Fingerprinting with SHA-256']}
                    current={phase === 'uploading' ? 0 : 1}
                  />
                  <p className="text-xs text-muted-foreground">
                    Large scanned PDFs can take a moment — OCR runs page by page.
                  </p>
                </div>
              ) : (
                <div className="mt-5 border-t border-border pt-4">
                  <Button className="w-full gap-2 sm:w-auto" onClick={processFile} disabled={working}>
                    <ShieldCheck className="h-4 w-4" aria-hidden /> Process document
                  </Button>
                </div>
              )}
            </SectionCard>
          )}

          {validationError ? <InfoNotice tone="warning" title="This file can't be processed">{validationError}</InfoNotice> : null}
          {error ? <ErrorPanel code={error.code} message={error.message} onRetry={file ? () => processFile() : undefined} /> : null}

          <InfoNotice tone="info" title="Private by design">
            Your document is sent only to the DocShield engine running on this machine, kept in memory for 30 minutes, and never
            forwarded to any external service. DocShield does not store document contents in your browser.
          </InfoNotice>
        </div>

        {/* Side column */}
        <div className="space-y-4 lg:col-span-2">
          <SectionCard title="What happens on upload">
            <ProgressStages
              stages={[
                'Validate PDF header & size limits',
                'Extract embedded text (PDF.js)',
                'OCR fallback for scanned pages (Tesseract)',
                'Compute the original SHA-256 fingerprint',
              ]}
              current={4}
              className="[&>li]:text-muted-foreground"
            />
          </SectionCard>

          <SectionCard title="Good to know">
            <dl className="divide-y divide-border">
              <div className="pb-1"><KeyValue label="Max file size">{formatBytes(maxBytes)}</KeyValue></div>
              <div className="py-1"><KeyValue label="Pages">Multi-page supported</KeyValue></div>
              <div className="py-1"><KeyValue label="Scanned PDFs">OCR fallback, page by page</KeyValue></div>
              <div className="pt-1"><KeyValue label="Corrupted files">Rejected with a clear error</KeyValue></div>
            </dl>
          </SectionCard>
        </div>
      </div>

      {/* Samples */}
      <SectionCard
        title={
          <span className="flex items-center gap-2">
            <FlaskConical className="h-4 w-4 text-muted-foreground" aria-hidden /> Fictional sample documents
          </span>
        }
        description="Generated on the fly by the engine — synthetic data only, nothing real. Loaded only when you explicitly choose one."
      >
        {samplesError ? (
          <ErrorPanel message={samplesError} onRetry={() => listSamples().then((r) => setSamples(r.samples)).catch(() => {})} />
        ) : !samples ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading samples…
          </div>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {samples.map((s) => {
              const corrupted = s.id === 'corrupted-pdf';
              const busy = busySampleId === s.id;
              return (
                <li
                  key={s.id}
                  className={cn(
                    'flex flex-col rounded-lg border border-border bg-background p-4',
                    busy && 'border-[#8bb930] bg-accent/10'
                  )}
                >
                  <div className="flex-1">
                    <p className="text-[13px] font-medium leading-5">{s.title}</p>
                    <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{s.description}</p>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-2">
                    {corrupted ? <StatusPill tone="warning">expects a visible error</StatusPill> : <span />}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1.5 text-xs"
                      disabled={working}
                      onClick={() => applySample(s)}
                    >
                      {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
                      {busy ? 'Loading…' : 'Use this sample'}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
