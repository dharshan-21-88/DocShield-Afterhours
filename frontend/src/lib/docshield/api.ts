/**
 * API service layer for the DocShield engine.
 *
 * The Express backend runs as a mini service on port 3002. All browser
 * requests go through the same-origin gateway using the XTransformPort
 * query parameter — never absolute URLs, never direct ports.
 */

import type {
  DetectionResponse,
  HealthResponse,
  PrivacyReport,
  RedactionResponse,
  ReportResponse,
  SamplesResponse,
  UploadResponse,
  VerifyResponse,
} from './types';

export const DOC_SHIELD_PORT = 3002;

export function apiUrl(path: string): string {
  return `/api${path}?XTransformPort=${DOC_SHIELD_PORT}`;
}

interface ApiErrorBody {
  success: false;
  error: string;
  message: string;
}

export class ApiError extends Error {
  code: string;
  status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), init);
  } catch {
    throw new ApiError(
      'NETWORK_ERROR',
      0,
      'Could not reach the DocShield engine. Make sure the service is running, then try again.'
    );
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON error body — fall through to the generic branch below.
  }

  const errBody = body as Partial<ApiErrorBody> | null;
  if (!res.ok || errBody?.success === false) {
    throw new ApiError(
      errBody?.error ?? `HTTP_${res.status}`,
      res.status,
      errBody?.message ?? 'The DocShield engine returned an unexpected response.'
    );
  }
  return body as T;
}

/* ------------------------------------------------------------------ */
/* Endpoints                                                           */
/* ------------------------------------------------------------------ */

export function getHealth(): Promise<HealthResponse> {
  return requestJson<HealthResponse>('/health');
}

export function listSamples(): Promise<SamplesResponse> {
  return requestJson<SamplesResponse>('/samples');
}

export function loadSample(sampleId: string): Promise<UploadResponse> {
  return requestJson<UploadResponse>(
    `/samples/${encodeURIComponent(sampleId)}/load`,
    { method: 'POST' }
  );
}

export function detectSensitive(
  documentId: string,
  categories?: string[]
): Promise<DetectionResponse> {
  return requestJson<DetectionResponse>('/detect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ documentId, ...(categories ? { categories } : {}) }),
  });
}

export function redactPdf(
  documentId: string,
  mode: 'automatic' | 'selective',
  selectedItemIds?: string[]
): Promise<RedactionResponse> {
  return requestJson<RedactionResponse>('/redact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ documentId, mode, selectedItemIds }),
  });
}

export function verifyPdf(
  documentId: string,
  runOcrCheck = true
): Promise<VerifyResponse> {
  return requestJson<VerifyResponse>('/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ documentId, runOcrCheck }),
  });
}

export function getReport(reportId: string): Promise<ReportResponse> {
  return requestJson<ReportResponse>(`/report/${encodeURIComponent(reportId)}`);
}

/** Fetch the original PDF bytes (used to preview server-generated samples). */
export async function fetchOriginalPdf(documentId: string): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await fetch(apiUrl(`/original/${encodeURIComponent(documentId)}`));
  } catch {
    throw new ApiError('NETWORK_ERROR', 0, 'Could not reach the DocShield engine.');
  }
  if (!res.ok) {
    let errBody: Partial<ApiErrorBody> | null = null;
    try {
      errBody = await res.json();
    } catch {
      // ignore
    }
    throw new ApiError(
      errBody?.error ?? `HTTP_${res.status}`,
      res.status,
      errBody?.message ?? 'The original PDF could not be loaded for preview.'
    );
  }
  return res.arrayBuffer();
}

/** Fetch the protected (redacted) PDF bytes for client-side preview. */
export async function fetchRedactedPdf(documentId: string): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await fetch(apiUrl(`/download/${encodeURIComponent(documentId)}`));
  } catch {
    throw new ApiError('NETWORK_ERROR', 0, 'Could not reach the DocShield engine.');
  }
  if (!res.ok) {
    let errBody: Partial<ApiErrorBody> | null = null;
    try {
      errBody = await res.json();
    } catch {
      // ignore
    }
    throw new ApiError(
      errBody?.error ?? `HTTP_${res.status}`,
      res.status,
      errBody?.message ?? 'The protected PDF could not be downloaded.'
    );
  }
  return res.arrayBuffer();
}

/**
 * Multipart upload with real progress reporting.
 * The backend expects a single file under the form field name "file".
 */
export function uploadPdfWithProgress(
  file: File,
  onProgress: (percent: number) => void
): Promise<UploadResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiUrl('/upload'));
    xhr.responseType = 'json';

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
      }
    };

    xhr.onload = () => {
      const body = xhr.response as Partial<UploadResponse & ApiErrorBody> | null;
      if (xhr.status >= 200 && xhr.status < 300 && body?.success !== false && body?.documentId) {
        onProgress(100);
        resolve(body as UploadResponse);
      } else {
        reject(
          new ApiError(
            body?.error ?? `HTTP_${xhr.status}`,
            xhr.status,
            body?.message ?? 'The upload could not be processed.'
          )
        );
      }
    };

    xhr.onerror = () =>
      reject(
        new ApiError('NETWORK_ERROR', 0, 'Could not reach the DocShield engine during upload.')
      );

    xhr.onabort = () =>
      reject(new ApiError('UPLOAD_ABORTED', 0, 'Upload cancelled.'));

    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  });
}

/** Trigger a browser download of the protected PDF via the gateway. */
export function protectedPdfDownloadUrl(documentId: string): string {
  return apiUrl(`/download/${encodeURIComponent(documentId)}`);
}
