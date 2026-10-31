'use client';

/**
 * Client-side PDF preview built on pdf.js.
 *
 * Renders one page at a time onto a canvas and can overlay detection
 * bounding boxes (PDF point space, top-left origin — the coordinate space
 * the DocShield engine reports). Document bytes are held in memory only.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, FileWarning, Loader2, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export type OverlayTone = 'detected' | 'remaining' | 'selected';

export interface PdfOverlay {
  id: string;
  /** PDF points, top-left origin (engine boundingBox space) */
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
  tone?: OverlayTone;
}

type PdfDoc = Awaited<ReturnType<typeof import('pdfjs-dist').getDocument>['promise']>;

let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;

async function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist').then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

const OVERLAY_TONE_CLASSES: Record<OverlayTone, string> = {
  detected: 'bg-[#c6f36a]/45 border-[#5a7a1e]',
  selected: 'bg-[#c6f36a]/60 border-[#3f5a10]',
  remaining: 'bg-[#e36c4f]/35 border-[#b3261e]',
};

interface PdfPreviewProps {
  data: ArrayBuffer | null;
  /** 1-based page number (controlled) */
  page: number;
  onPageChange?: (page: number) => void;
  overlays?: PdfOverlay[];
  highlightId?: string | null;
  onOverlayClick?: (id: string) => void;
  className?: string;
  ariaLabel?: string;
  showPageControls?: boolean;
  emptyLabel?: string;
}

export function PdfPreview({
  data,
  page,
  onPageChange,
  overlays = [],
  highlightId,
  onOverlayClick,
  className,
  ariaLabel = 'PDF preview',
  showPageControls = true,
  emptyLabel = 'No document loaded',
}: PdfPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const docRef = useRef<PdfDoc | null>(null);
  const renderSeqRef = useRef(0);

  /* The wrapper only exists after the empty state passes — use a callback ref
     so the observer attaches as soon as the node appears. */
  const [wrapperEl, setWrapperEl] = useState<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [pageCount, setPageCount] = useState(0);
  const [scale, setScale] = useState(0);
  const [state, setState] = useState<'empty' | 'loading' | 'ready' | 'error'>(data ? 'loading' : 'empty');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [retryTick, setRetryTick] = useState(0);

  /* Observe container width so the page re-renders responsively. */
  useEffect(() => {
    if (!wrapperEl) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(wrapperEl);
    return () => observer.disconnect();
  }, [wrapperEl]);

  /* Load the document whenever new bytes arrive. */
  useEffect(() => {
    let cancelled = false;

    if (!data || data.byteLength === 0) {
      if (docRef.current) {
        docRef.current.cleanup().catch(() => {});
        docRef.current.loadingTask?.destroy().catch(() => {});
        docRef.current = null;
      }
      setPageCount(0);
      setState('empty');
      return;
    }

    setState('loading');
    setErrorMessage('');

    (async () => {
      try {
        const pdfjs = await loadPdfjs();
        if (cancelled) return;

        // pdf.js transfers the buffer to the worker — always hand it a copy
        // so the store's bytes stay reusable (Risk Lens, Share preview).
        const copied = new Uint8Array(data.slice(0));
        const doc = await pdfjs.getDocument({ data: copied, verbosity: 0 }).promise;
        if (cancelled) {
          doc.cleanup().catch(() => {});
          doc.loadingTask?.destroy().catch(() => {});
          return;
        }
        if (docRef.current) {
          docRef.current.cleanup().catch(() => {});
          docRef.current.loadingTask?.destroy().catch(() => {});
        }
        docRef.current = doc;
        setPageCount(doc.numPages);
        setState('ready');
      } catch (err) {
        if (cancelled) return;
        setState('error');
        setErrorMessage(
          err instanceof Error && err.message
            ? `This PDF could not be rendered in the browser: ${err.message}`
            : 'This PDF could not be rendered in the browser.'
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [data, retryTick]);

  /* Render the requested page. */
  useEffect(() => {
    const doc = docRef.current;
    const canvas = canvasRef.current;
    if (!doc || !canvas || state !== 'ready' || containerWidth < 40) return;

    const seq = ++renderSeqRef.current;
    const safePage = Math.min(Math.max(1, page), doc.numPages);
    let renderTask: { cancel: () => void; promise: Promise<void> } | null = null;

    (async () => {
      try {
        const pdfPage = await doc.getPage(safePage);
        if (renderSeqRef.current !== seq) return;

        const base = pdfPage.getViewport({ scale: 1 });
        const fitScale = containerWidth / base.width;
        const viewport = pdfPage.getViewport({ scale: fitScale });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);

        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas 2D context unavailable');

        const task = pdfPage.render({
          canvas,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
          background: '#FFFFFF',
        });
        renderTask = task;
        await task.promise;
        if (renderSeqRef.current !== seq) return;
        setScale(fitScale);
      } catch (err) {
        // Rendering was cancelled by a newer render — ignore.
        if (renderSeqRef.current === seq) {
          const name = (err as { name?: string })?.name;
          if (name !== 'RenderingCancelledException') {
            setState('error');
            setErrorMessage('The page could not be rendered.');
          }
        }
      }
    })();

    return () => {
      renderTask?.cancel();
    };
  }, [state, page, containerWidth, pageCount]);

  const visibleOverlays = useMemo(
    () => overlays.filter((o) => o.width > 0 && o.height > 0),
    [overlays]
  );

  const goToPage = useCallback(
    (p: number) => {
      const clamped = Math.min(Math.max(1, p), pageCount || 1);
      onPageChange?.(clamped);
    },
    [onPageChange, pageCount]
  );

  const effectivePage = Math.min(Math.max(1, page), pageCount || page || 1);

  if (state === 'empty') {
    return (
      <div
        role="img"
        aria-label={emptyLabel}
        className={cn('flex min-h-[280px] flex-col items-center justify-center rounded-lg border border-dashed border-input bg-muted/40 p-8 text-center', className)}
      >
        <p className="text-sm text-muted-foreground">{emptyLabel}</p>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col', className)}>
      <div
        ref={setWrapperEl}
        className="relative mx-auto w-full overflow-hidden rounded-lg border border-border bg-white"
        aria-label={ariaLabel}
        role="figure"
      >
        {/* pdf.js renders asynchronously — keep the canvas mounted */}
        <canvas ref={canvasRef} className="block h-auto w-full" aria-label={ariaLabel} />

        {visibleOverlays.length > 0 && scale > 0 && (
          <div className="pointer-events-none absolute inset-0" aria-hidden={visibleOverlays.every((o) => !onOverlayClick)}>
            {visibleOverlays.map((o) => (
              <button
                key={o.id}
                type="button"
                tabIndex={onOverlayClick ? 0 : -1}
                aria-label={o.label ?? 'Detected field'}
                onClick={onOverlayClick ? () => onOverlayClick(o.id) : undefined}
                className={cn(
                  'absolute rounded-[3px] border transition-shadow',
                  OVERLAY_TONE_CLASSES[o.tone ?? 'detected'],
                  o.id === highlightId && 'overlay-focus ring-2 ring-[#5a7a1e]',
                  onOverlayClick && 'pointer-events-auto cursor-pointer hover:bg-[#c6f36a]/70'
                )}
                style={{
                  left: `${o.x * scale}px`,
                  top: `${o.y * scale}px`,
                  width: `${o.width * scale}px`,
                  height: `${o.height * scale}px`,
                }}
              />
            ))}
          </div>
        )}

        {(state === 'loading' || (state === 'ready' && scale === 0)) && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/60">
            <div className="flex items-center gap-2 rounded-full border border-border bg-card px-3.5 py-1.5 text-xs text-muted-foreground shadow-sm">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Rendering page…
            </div>
          </div>
        )}
      </div>

      {state === 'error' ? (
        <div className="mt-3 flex items-start gap-2.5 rounded-lg border border-[#ecc9c1] bg-[#fbeeec] p-3 text-[13px] text-[#8f2f24]">
          <FileWarning className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p>{errorMessage}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2 h-7 gap-1.5"
              onClick={() => setRetryTick((t) => t + 1)}
            >
              <RotateCcw className="h-3 w-3" aria-hidden /> Try again
            </Button>
          </div>
        </div>
      ) : null}

      {showPageControls && pageCount > 0 ? (
        <div className="mt-2.5 flex items-center justify-between">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1"
            disabled={effectivePage <= 1}
            onClick={() => goToPage(effectivePage - 1)}
            aria-label="Previous page"
          >
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden /> Prev
          </Button>
          <p className="font-mono text-xs text-muted-foreground" aria-live="polite">
            Page {effectivePage} / {pageCount}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1"
            disabled={effectivePage >= pageCount}
            onClick={() => goToPage(effectivePage + 1)}
            aria-label="Next page"
          >
            Next <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
