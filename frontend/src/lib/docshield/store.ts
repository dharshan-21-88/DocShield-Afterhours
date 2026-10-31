'use client';

/**
 * Client-side session store for the DocShield workspace.
 *
 * Privacy note: document bytes and API results live in memory only.
 * Nothing about a document's contents is written to localStorage —
 * a page refresh intentionally clears the working session.
 */

import { create } from 'zustand';
import type {
  DetectionResponse,
  HealthResponse,
  PageExtractionInfo,
  PrivacyReport,
  RedactionResponse,
  VerificationResult,
} from './types';

export type ViewKey =
  | 'dashboard'
  | 'upload'
  | 'studio'
  | 'lens'
  | 'verify'
  | 'share';

export interface SessionDoc {
  documentId: string;
  fileName: string;
  fileSizeBytes: number;
  originalSha256: string;
  pageCount: number;
  extractionMethod: string;
  usedOcrFallback: boolean;
  totalCharacters: number;
  pages: PageExtractionInfo[];
  sampleId?: string;
  origin: 'upload' | 'sample';
  uploadedAt: number;
}

export type HistoryKind =
  | 'upload'
  | 'detect'
  | 'redact'
  | 'verify'
  | 'share'
  | 'reset'
  | 'error';

export interface HistoryEvent {
  id: string;
  at: number;
  kind: HistoryKind;
  title: string;
  detail?: string;
}

export interface ShareEntry {
  id: string;
  at: number;
  recipient: string;
  note?: string;
  documentId: string;
  fileName: string;
  sha256: string;
  reportId: string | null;
}

export type FetchState = 'idle' | 'loading' | 'ready' | 'error';

interface DocShieldState {
  /* Navigation */
  view: ViewKey;
  setView: (v: ViewKey) => void;

  /* Engine health */
  health: HealthResponse | null;
  healthState: FetchState;
  refreshHealth: () => Promise<boolean>;

  /* Active document */
  doc: SessionDoc | null;
  originalPdfBytes: ArrayBuffer | null;
  originalBytesState: FetchState;
  setOriginalBytesState: (s: FetchState) => void;
  setOriginalBytes: (b: ArrayBuffer | null) => void;
  setDocument: (doc: SessionDoc, originalBytes: ArrayBuffer | null) => void;

  /* Recent documents this session (metadata only — never file contents) */
  recentDocs: SessionDoc[];

  /* Detection */
  detection: DetectionResponse | null;
  detectionRunning: boolean;
  detectionError: string | null;
  setDetectionRunning: (running: boolean) => void;
  setDetection: (d: DetectionResponse | null) => void;
  setDetectionError: (e: string | null) => void;

  /* Selection in the Redaction Studio */
  selectedIds: string[];
  setSelectedIds: (ids: string[]) => void;
  toggleSelectedId: (id: string) => void;

  /* Redaction */
  redaction: RedactionResponse | null;
  redactionRunning: boolean;
  setRedactionRunning: (running: boolean) => void;
  setRedaction: (r: RedactionResponse | null) => void;

  /* Protected PDF bytes (fetched after redaction, for previews) */
  redactedPdfBytes: ArrayBuffer | null;
  redactedBytesState: FetchState;
  setRedactedBytesState: (s: FetchState) => void;
  setRedactedBytes: (b: ArrayBuffer | null) => void;

  /* Verification + report */
  verification: VerificationResult | null;
  report: PrivacyReport | null;
  verifyRunning: boolean;
  setVerifyRunning: (running: boolean) => void;
  setVerification: (v: VerificationResult | null, report: PrivacyReport | null) => void;

  /* Session journal */
  history: HistoryEvent[];
  addHistory: (e: Omit<HistoryEvent, 'id' | 'at'>) => void;

  /* Local share ledger */
  shares: ShareEntry[];
  addShare: (e: Omit<ShareEntry, 'id' | 'at'>) => void;

  /* Session lifecycle */
  clearDocument: () => void;
  resetSession: () => void;
}

let eventSeq = 0;
function nextId(prefix: string): string {
  eventSeq += 1;
  return `${prefix}_${Date.now()}_${eventSeq}`;
}

export const useDocShield = create<DocShieldState>((set) => ({
  view: 'dashboard',
  setView: (v) => set({ view: v }),

  health: null,
  healthState: 'loading',
  refreshHealth: async () => {
    const { getHealth } = await import('./api');
    try {
      const health = await getHealth();
      set({ health, healthState: 'ready' });
      return true;
    } catch {
      set({ healthState: 'error' });
      return false;
    }
  },

  doc: null,
  originalPdfBytes: null,
  originalBytesState: 'idle',
  setOriginalBytesState: (s) => set({ originalBytesState: s }),
  setOriginalBytes: (b) => set({ originalPdfBytes: b, originalBytesState: b ? 'ready' : 'error' }),
  setDocument: (doc, originalBytes) =>
    set((s) => ({
      doc,
      originalPdfBytes: originalBytes,
      originalBytesState: originalBytes ? 'ready' : 'idle',
      detection: null,
      detectionError: null,
      selectedIds: [],
      redaction: null,
      redactedPdfBytes: null,
      redactedBytesState: 'idle',
      verification: null,
      report: null,
      recentDocs: [doc, ...s.recentDocs.filter((d) => d.documentId !== doc.documentId)].slice(0, 8),
    })),

  recentDocs: [],

  detection: null,
  detectionRunning: false,
  detectionError: null,
  setDetectionRunning: (running) => set({ detectionRunning: running }),
  setDetection: (d) => set({ detection: d, detectionError: null }),
  setDetectionError: (e) => set({ detectionError: e }),

  selectedIds: [],
  setSelectedIds: (ids) => set({ selectedIds: ids }),
  toggleSelectedId: (id) =>
    set((s) => ({
      selectedIds: s.selectedIds.includes(id)
        ? s.selectedIds.filter((x) => x !== id)
        : [...s.selectedIds, id],
    })),

  redaction: null,
  redactionRunning: false,
  setRedactionRunning: (running) => set({ redactionRunning: running }),
  setRedaction: (r) => set({ redaction: r }),

  redactedPdfBytes: null,
  redactedBytesState: 'idle',
  setRedactedBytesState: (s) => set({ redactedBytesState: s }),
  setRedactedBytes: (b) => set({ redactedPdfBytes: b, redactedBytesState: b ? 'ready' : 'error' }),

  verification: null,
  report: null,
  verifyRunning: false,
  setVerifyRunning: (running) => set({ verifyRunning: running }),
  setVerification: (v, report) => set({ verification: v, report }),

  history: [],
  addHistory: (e) =>
    set((s) => ({
      history: [{ ...e, id: nextId('evt'), at: Date.now() }, ...s.history].slice(0, 50),
    })),

  shares: [],
  addShare: (e) =>
    set((s) => ({
      shares: [{ ...e, id: nextId('share'), at: Date.now() }, ...s.shares],
    })),

  clearDocument: () =>
    set({
      doc: null,
      originalPdfBytes: null,
      originalBytesState: 'idle',
      detection: null,
      detectionError: null,
      selectedIds: [],
      redaction: null,
      redactedPdfBytes: null,
      redactedBytesState: 'idle',
      verification: null,
      report: null,
    }),

  resetSession: () =>
    set({
      view: 'dashboard',
      doc: null,
      originalPdfBytes: null,
      originalBytesState: 'idle',
      detection: null,
      detectionError: null,
      selectedIds: [],
      redaction: null,
      redactedPdfBytes: null,
      redactedBytesState: 'idle',
      verification: null,
      report: null,
      shares: [],
      history: [],
      recentDocs: [],
    }),
}));

/*
 * Navigation is fully unlocked: every view is reachable at any time.
 * Views that lack their prerequisites (no document, no redaction, …)
 * render an honest empty state with a call to action instead of gating.
 */
