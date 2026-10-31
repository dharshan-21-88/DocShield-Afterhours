'use client';

/**
 * Shared client hooks for the DocShield workspace.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useDocShield } from '@/lib/docshield/store';
import { fetchOriginalPdf } from '@/lib/docshield/api';

/**
 * Ensures the original PDF bytes are available for previews.
 * User uploads carry their bytes from the File object; server-generated
 * samples are fetched once via the read-only /api/original endpoint.
 *
 * Dedupes with a ref (StrictMode-safe): the loading state alone must not
 * gate re-entry, or a cancelled first effect run can deadlock the state.
 */
export function useOriginalBytesAutoload() {
  const doc = useDocShield((s) => s.doc);
  const originalPdfBytes = useDocShield((s) => s.originalPdfBytes);
  const originalBytesState = useDocShield((s) => s.originalBytesState);
  const setOriginalBytes = useDocShield((s) => s.setOriginalBytes);
  const setOriginalBytesState = useDocShield((s) => s.setOriginalBytesState);
  const fetchedDocRef = useRef<string | null>(null);

  const retry = useCallback(() => {
    if (!doc) return;
    fetchedDocRef.current = null;
    setOriginalBytesState('loading');
    fetchOriginalPdf(doc.documentId)
      .then((b) => setOriginalBytes(b))
      .catch(() => setOriginalBytesState('error'));
  }, [doc, setOriginalBytes, setOriginalBytesState]);

  useEffect(() => {
    if (!doc || originalPdfBytes) return;
    if (fetchedDocRef.current === doc.documentId) return;
    fetchedDocRef.current = doc.documentId;
    setOriginalBytesState('loading');
    fetchOriginalPdf(doc.documentId)
      .then((bytes) => setOriginalBytes(bytes))
      .catch(() => setOriginalBytesState('error'));
  }, [doc, originalPdfBytes, setOriginalBytes, setOriginalBytesState]);

  return { originalPdfBytes, originalBytesState, retryOriginalFetch: retry };
}
