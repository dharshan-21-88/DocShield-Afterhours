/**
 * Typed contracts for the DocShield backend API.
 * Every shape mirrors the actual Express controllers — nothing invented.
 */

export interface HealthConfig {
  maxFileSizeBytes: number;
  allowedMimeTypes: string[];
  frontendApiBaseUrl: string;
}

export interface HealthResponse {
  status: string;
  service: string;
  motto: string;
  timestamp: string;
  uptimeSeconds: number;
  config: HealthConfig;
}

export interface SampleScenario {
  id: string;
  title: string;
  description: string;
}

export interface SamplesResponse {
  success: boolean;
  samples: SampleScenario[];
}

export interface PageExtractionInfo {
  pageNumber: number;
  width: number;
  height: number;
  method: string;
  characterCount: number;
  textPreview: string;
}

export interface ExtractionSummary {
  pageCount: number;
  extractionMethod: string;
  usedOcrFallback: boolean;
  totalCharacters: number;
  pages: PageExtractionInfo[];
}

export interface UploadResponse {
  success: boolean;
  documentId: string;
  fileName: string;
  fileSizeBytes: number;
  originalSha256: string;
  extraction: ExtractionSummary;
  sampleId?: string;
}

export type DetectionCategory =
  | 'PHONE_NUMBER'
  | 'EMAIL_ADDRESS'
  | 'ADDRESS'
  | 'STUDENT_REG_NUMBER'
  | 'NATIONAL_ID_AADHAAR'
  | 'FINANCIAL_ACCOUNT';

export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW_UNCERTAIN';

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  coordinateSpace: string;
}

export interface DetectionItem {
  id: string;
  text: string;
  category: DetectionCategory;
  categoryLabel: string;
  confidence: Confidence;
  detectionStatus: string;
  pageNumber: number;
  boundingBox: BoundingBox | null;
  /** Present on items returned by the verification engine */
  verificationStatus?: 'STILL_DETECTABLE' | 'VERIFIED_REMOVED';
}

export interface DetectionResponse {
  success: boolean;
  documentId: string;
  totalDetected: number;
  categoryBreakdown: Partial<Record<DetectionCategory, number>>;
  disclaimer: string;
  items: DetectionItem[];
}

export interface RedactionResponse {
  success: boolean;
  documentId: string;
  mode: 'automatic' | 'selective';
  totalDetectedBeforeRedaction: number;
  selectedForRedactionCount: number;
  unselectedCount: number;
  redactedPdfSha256: string;
  redactedFileSizeBytes: number;
  downloadUrl: string;
  notice: string;
}

export interface PostExtractionSummary {
  pageCount: number;
  extractionMethod: string;
  totalCharactersExtracted: number;
}

export interface VerificationResult {
  methodsUsed: string[];
  selectedItemsCount: number;
  successfullyRemovedCount: number;
  selectedStillDetectableCount: number;
  remainingUnselectedDetectableCount: number;
  removedItems: DetectionItem[];
  selectedStillDetectable: DetectionItem[];
  remainingItems: DetectionItem[];
  postExtractionSummary: PostExtractionSummary;
  verificationDisclaimer: string;
}

export interface PrivacyReport {
  reportId: string;
  documentId: string;
  fileName: string;
  generatedAt: string;
  redactionMode: string;
  metrics: {
    detectedBeforeRedaction: number;
    selectedForRedaction: number;
    noLongerDetectedAfterRedaction: number;
    remainingDetectedAfterRedaction: number;
  };
  beforeAndAfterAssessment: {
    beforeStatus: string;
    afterStatus: string;
    indicativeReductionPercentage: number;
    summary: string;
    disclaimer: string;
  };
  removedSensitiveItems: DetectionItem[];
  remainingSensitiveItems: DetectionItem[];
  verificationDetails: {
    methodsUsed: string[];
    selectedStillDetectableCount: number;
  };
  exportedDocumentIntegrity: {
    algorithm: string;
    originalDocumentSha256: string;
    sha256: string | null;
    fileSizeBytes: number | null;
    downloadEndpoint: string;
  };
}

export interface VerifyResponse {
  success: boolean;
  documentId: string;
  reportId: string;
  verification: VerificationResult;
  report: PrivacyReport;
}

export interface ReportResponse {
  success: boolean;
  report: PrivacyReport;
}

export type VerificationStatus = 'PASSED' | 'PARTIAL' | 'FAILED';

/**
 * The engine returns counts, not a single status string.
 * Derive an honest status from the actual verification outcome:
 * - FAILED:  a value the user explicitly selected for redaction is still detectable.
 * - PARTIAL: selected values were removed, but other sensitive patterns remain detectable.
 * - PASSED:  nothing selected remains detectable and no other patterns were found.
 */
export function deriveVerificationStatus(v: VerificationResult): VerificationStatus {
  if (v.selectedStillDetectableCount > 0) return 'FAILED';
  if (v.remainingItems.length > 0) return 'PARTIAL';
  return 'PASSED';
}
