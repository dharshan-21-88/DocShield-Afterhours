/**
 * Privacy Assessment Report Generator.
 *
 * Generates an indicative before-and-after privacy assessment report including:
 * - Number of sensitive items detected before redaction
 * - Number of items selected for redaction
 * - Number of items no longer detected after redaction
 * - Any remaining detected sensitive information
 * - Before-and-after privacy exposure assessment
 * - SHA-256 integrity hash of the exported PDF
 */
export function buildPrivacyAssessmentReport({
  documentRecord,
  verificationResult,
}) {
  const reportId = `rep_${documentRecord.documentId.replace(/^doc_/, '')}`;
  const detectedBefore = (documentRecord.detectedItems || []).length;
  const selectedCount = (documentRecord.selectedItemIds || []).length;
  const removedCount = verificationResult.successfullyRemovedCount;
  const remainingItems = verificationResult.remainingItems || [];
  const remainingCount = remainingItems.length;

  let beforeStatus = 'MINIMAL_DETECTED_EXPOSURE (0 sensitive items detected)';
  if (detectedBefore >= 4) {
    beforeStatus = `HIGH_EXPOSURE (${detectedBefore} sensitive items detected)`;
  } else if (detectedBefore >= 1) {
    beforeStatus = `MODERATE_EXPOSURE (${detectedBefore} sensitive items detected)`;
  }

  let afterStatus = 'MINIMAL_DETECTED_EXPOSURE (0 sensitive items detected)';
  if (remainingCount >= 4) {
    afterStatus = `HIGH_EXPOSURE (${remainingCount} sensitive items remain detectable)`;
  } else if (remainingCount >= 1) {
    afterStatus = `PARTIAL_EXPOSURE (${remainingCount} sensitive item(s) remain detectable)`;
  }

  const indicativeReductionPercentage =
    detectedBefore > 0
      ? Math.max(0, Math.min(100, Math.round(((detectedBefore - remainingCount) / detectedBefore) * 100)))
      : 100;

  const structuralAudit =
    documentRecord.structuralAudit || documentRecord.extraction?.structuralAudit || null;
  const structuralWarningCount = Array.isArray(structuralAudit?.warnings)
    ? structuralAudit.warnings.length
    : 0;

  let summaryText = '';
  if (detectedBefore === 0) {
    summaryText =
      'No matching sensitive patterns were detected in the original document or the exported document.';
  } else if (remainingCount === 0) {
    summaryText = `${removedCount} of ${detectedBefore} detected sensitive item(s) were permanently redacted and verified as no longer detectable via PDF text extraction or OCR.`;
  } else {
    summaryText = `${removedCount} of ${selectedCount} selected item(s) were permanently removed. However, ${remainingCount} sensitive item(s) remain detectable in the exported PDF (for example, items left unselected during selective redaction).`;
  }

  if (structuralWarningCount > 0) {
    summaryText += ` Note: Structural inspection of the uploaded PDF flagged ${structuralWarningCount} hidden-structure warning(s) (such as metadata PII, uninspected embedded attachments, or incremental revisions).`;
  }

  return {
    reportId,
    documentId: documentRecord.documentId,
    fileName: documentRecord.fileName,
    generatedAt: new Date().toISOString(),
    redactionMode: documentRecord.redactionMode || 'automatic',
    metrics: {
      detectedBeforeRedaction: detectedBefore,
      selectedForRedaction: selectedCount,
      noLongerDetectedAfterRedaction: removedCount,
      remainingDetectedAfterRedaction: remainingCount,
    },
    beforeAndAfterAssessment: {
      beforeStatus,
      afterStatus,
      indicativeReductionPercentage,
      summary: summaryText,
      disclaimer:
        'This privacy assessment is an indicative evaluation based on automated pattern matching and OCR verification. It is not a guarantee of absolute anonymity or legal compliance. Always review the exported PDF visually before sharing.',
    },
    removedSensitiveItems: verificationResult.removedItems || [],
    remainingSensitiveItems: remainingItems,
    ...(structuralAudit ? { structuralAudit } : {}),
    verificationDetails: {
      methodsUsed: verificationResult.methodsUsed,
      selectedStillDetectableCount: verificationResult.selectedStillDetectableCount,
    },
    exportedDocumentIntegrity: {
      algorithm: 'SHA-256',
      originalDocumentSha256: documentRecord.originalSha256,
      sha256: documentRecord.redactedSha256,
      fileSizeBytes: documentRecord.redactedFileSizeBytes,
      downloadEndpoint: `/api/download/${documentRecord.documentId}`,
    },
  };
}

