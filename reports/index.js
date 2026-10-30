/**
 * Privacy Assessment Report Generator.
 *
 * Generates an indicative before-and-after privacy assessment report including:
 * - Number of sensitive items detected before redaction
 * - Number of items selected for redaction
 * - Number of items no longer detected after redaction
 * - Any remaining detected sensitive information
 * - Separate OCR visual verification and post-redaction structural verification results
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

  const ocrVerification = verificationResult.ocrVerification || null;
  const structuralVerification = verificationResult.structuralVerification || null;
  const structuralStatus = structuralVerification?.status || 'INDETERMINATE';

  let beforeStatus = 'MINIMAL_DETECTED_EXPOSURE (0 sensitive items detected)';
  if (detectedBefore >= 4) {
    beforeStatus = `HIGH_EXPOSURE (${detectedBefore} sensitive items detected)`;
  } else if (detectedBefore >= 1) {
    beforeStatus = `MODERATE_EXPOSURE (${detectedBefore} sensitive items detected)`;
  }

  let afterStatus = 'MINIMAL_DETECTED_EXPOSURE (0 sensitive items detected)';
  if (structuralStatus === 'FAILED') {
    afterStatus = 'STRUCTURAL_VERIFICATION_FAILED (hidden PDF structures survived in exported document)';
  } else if (structuralStatus === 'INDETERMINATE') {
    afterStatus = 'STRUCTURAL_VERIFICATION_INDETERMINATE (exported PDF structure could not be fully verified)';
  } else if (remainingCount >= 4) {
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

  if (structuralVerification) {
    summaryText += ` Post-redaction structural verification status: ${structuralVerification.status}.`;
    if (structuralVerification.checks?.attachments?.hadUninspectedAttachmentsBeforeRedaction) {
      summaryText +=
        ' Prior embedded attachment(s) from the original PDF were verified as removed from the exported PDF, though their original internal file contents were not inspected prior to removal.';
    }
  }

  if (structuralWarningCount > 0) {
    summaryText += ` Note: Pre-redaction structural inspection of the uploaded PDF flagged ${structuralWarningCount} hidden-structure warning(s).`;
  }

  return {
    reportId,
    documentId: documentRecord.documentId,
    fileName: documentRecord.fileName,
    generatedAt: new Date().toISOString(),
    redactionMode: documentRecord.redactionMode || 'automatic',
    verified: Boolean(verificationResult.verified),
    verificationStatus: verificationResult.status || 'INDETERMINATE',
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
        'This privacy assessment is an indicative evaluation based on automated pattern matching, OCR verification, and PDF structural verification. It is not a guarantee of absolute anonymity or legal compliance. Always review the exported PDF visually before sharing.',
    },
    removedSensitiveItems: verificationResult.removedItems || [],
    remainingSensitiveItems: remainingItems,
    ...(structuralAudit ? { structuralAudit } : {}),
    ocrVerification,
    structuralVerification,
    verificationDetails: {
      verified: Boolean(verificationResult.verified),
      status: verificationResult.status || 'INDETERMINATE',
      methodsUsed: verificationResult.methodsUsed,
      selectedStillDetectableCount: verificationResult.selectedStillDetectableCount,
      ocrVerification,
      structuralVerification,
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
