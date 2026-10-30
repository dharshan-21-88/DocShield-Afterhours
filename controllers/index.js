import crypto from 'crypto';
import fs from 'fs';
import { config } from '../config/index.js';
import {
  computeFileSha256,
  saveDocumentRecord,
  getDocumentRecord,
  updateDocumentRecord,
  saveReportRecord,
  getReportRecord,
  safeDeleteFile,
} from '../config/storage.js';
import { extractPdfContent } from '../extraction/index.js';
import { SAMPLE_SCENARIOS, generateSamplePdfFile } from '../extraction/samples.js';
import { detectSensitiveInfo, findBoundingBoxForMatch } from '../detection/index.js';
import { generatePermanentlyRedactedPdf, hasValidItemCoordinates } from '../redaction/index.js';
import { verifyRedactedPdf } from '../verification/index.js';
import { buildPrivacyAssessmentReport } from '../reports/index.js';

/**
 * GET /api/health
 */
export function getHealth(_req, res) {
  res.status(200).json({
    status: 'ok',
    service: 'DocShield – Smart Document Privacy Protector Backend',
    motto: "Don't just redact documents. Verify what remains exposed before sharing.",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Number(process.uptime().toFixed(2)),
    config: {
      maxFileSizeBytes: config.upload.maxFileSizeBytes,
      allowedMimeTypes: config.upload.allowedMimeTypes,
      frontendApiBaseUrl: config.frontendApiBaseUrl,
    },
  });
}

/**
 * Helper to process an uploaded or generated PDF file into a stored DocumentRecord.
 */
async function processUploadedPdfFile(filePath, originalName, fileSizeBytes) {
  try {
    const originalSha256 = await computeFileSha256(filePath);
    const extraction = await extractPdfContent(filePath);

    const documentId = `doc_${crypto.randomUUID()}`;
    const record = saveDocumentRecord({
      documentId,
      fileName: originalName,
      fileSizeBytes,
      originalFilePath: filePath,
      originalSha256,
      extraction,
      detectedItems: null,
      selectedItemIds: [],
      redactionMode: null,
      redactedFilePath: null,
      redactedSha256: null,
      redactedFileSizeBytes: null,
      reportId: null,
    });

    return {
      success: true,
      documentId: record.documentId,
      fileName: record.fileName,
      fileSizeBytes: record.fileSizeBytes,
      originalSha256: record.originalSha256,
      extraction: {
        pageCount: extraction.pageCount,
        extractionMethod: extraction.extractionMethod,
        usedOcrFallback: extraction.usedOcrFallback,
        totalCharacters: extraction.totalCharacters,
        ...(Array.isArray(extraction.unsupportedAnnotations) && extraction.unsupportedAnnotations.length > 0
          ? { unsupportedAnnotations: extraction.unsupportedAnnotations }
          : {}),
        ...(Array.isArray(extraction.linkAnnotations) && extraction.linkAnnotations.length > 0
          ? { linkAnnotations: extraction.linkAnnotations }
          : {}),
        pages: extraction.pages.map((p) => ({
          pageNumber: p.pageNumber,
          width: p.width,
          height: p.height,
          method: p.method,
          characterCount: p.text.length,
          textPreview: p.text.slice(0, 300) + (p.text.length > 300 ? '...' : ''),
        })),
      },
    };
  } catch (err) {
    await safeDeleteFile(filePath);
    throw err;
  }
}

/**
 * POST /api/upload
 */
export async function uploadPdfController(req, res, next) {
  try {
    const file = req.file;
    const responsePayload = await processUploadedPdfFile(
      file.path,
      file.originalname || 'uploaded_document.pdf',
      file.size
    );
    res.status(201).json(responsePayload);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/samples
 */
export function listSamplesController(_req, res) {
  res.status(200).json({
    success: true,
    samples: SAMPLE_SCENARIOS,
  });
}

/**
 * POST /api/samples/:sampleId/load
 */
export async function loadSampleController(req, res, next) {
  try {
    const { sampleId } = req.params;
    const sampleFile = await generateSamplePdfFile(sampleId);
    const responsePayload = await processUploadedPdfFile(
      sampleFile.filePath,
      sampleFile.fileName,
      sampleFile.fileSizeBytes
    );
    res.status(201).json({
      ...responsePayload,
      sampleId,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/detect
 */
export async function detectSensitiveController(req, res, next) {
  try {
    const { documentId, categories } = req.body || {};

    if (!documentId || typeof documentId !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'MISSING_DOCUMENT_ID',
        message: 'Please provide a valid "documentId" in the request body.',
      });
    }

    const docRecord = getDocumentRecord(documentId);
    if (!docRecord) {
      return res.status(404).json({
        success: false,
        error: 'DOCUMENT_NOT_FOUND',
        message: `Document with ID "${documentId}" was not found or has expired.`,
      });
    }

    const detectionResult = detectSensitiveInfo(docRecord.extraction, categories);

    updateDocumentRecord(documentId, {
      detectedItems: detectionResult.items,
      categoryBreakdown: detectionResult.categoryBreakdown,
    });

    res.status(200).json({
      success: true,
      documentId,
      totalDetected: detectionResult.totalDetected,
      categoryBreakdown: detectionResult.categoryBreakdown,
      disclaimer: detectionResult.disclaimer,
      items: detectionResult.items,
      ...(detectionResult.unsupportedAnnotations ? { unsupportedAnnotations: detectionResult.unsupportedAnnotations } : {}),
      ...(detectionResult.linkAnnotations ? { linkAnnotations: detectionResult.linkAnnotations } : {}),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/redact
 */
export async function redactPdfController(req, res, next) {
  try {
    const { documentId, mode = 'automatic', selectedItemIds } = req.body || {};

    if (!documentId || typeof documentId !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'MISSING_DOCUMENT_ID',
        message: 'Please provide a valid "documentId" in the request body.',
      });
    }

    if (!['automatic', 'selective'].includes(mode)) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_REDACTION_MODE',
        message: 'Redaction mode must be either "automatic" or "selective".',
      });
    }

    const docRecord = getDocumentRecord(documentId);
    if (!docRecord) {
      return res.status(404).json({
        success: false,
        error: 'DOCUMENT_NOT_FOUND',
        message: `Document with ID "${documentId}" was not found or has expired.`,
      });
    }

    // Ensure detection has been run at least once
    let detectedItems = docRecord.detectedItems;
    if (!detectedItems) {
      const detectionResult = detectSensitiveInfo(docRecord.extraction);
      detectedItems = detectionResult.items;
      updateDocumentRecord(documentId, {
        detectedItems,
        categoryBreakdown: detectionResult.categoryBreakdown,
      });
    }

    let itemsToRedact = [];
    if (mode === 'automatic') {
      itemsToRedact = [...detectedItems];
    } else {
      if (!Array.isArray(selectedItemIds)) {
        return res.status(400).json({
          success: false,
          error: 'MISSING_SELECTED_ITEMS',
          message: 'When mode is "selective", please provide a "selectedItemIds" array of item IDs to redact.',
        });
      }
      const idSet = new Set(selectedItemIds);
      itemsToRedact = detectedItems.filter((item) => idSet.has(item.id));
    }

    // Attempt coordinate recovery against extracted page elements for any selected item missing coordinates
    const pagesByNum = new Map((docRecord.extraction?.pages || []).map((p) => [p.pageNumber, p]));
    const usedKeysByPage = new Map();
    for (const item of itemsToRedact) {
      if (!hasValidItemCoordinates(item)) {
        const pageObj = pagesByNum.get(item.pageNumber);
        if (pageObj) {
          if (!usedKeysByPage.has(item.pageNumber)) {
            usedKeysByPage.set(item.pageNumber, new Set());
          }
          const resolved = findBoundingBoxForMatch(item.text, pageObj, usedKeysByPage.get(item.pageNumber));
          if (resolved && resolved.boundingBox) {
            item.boundingBox = resolved.boundingBox;
            if (Array.isArray(resolved.boundingBoxes) && resolved.boundingBoxes.length > 1) {
              item.boundingBoxes = resolved.boundingBoxes;
            }
          }
        }
      }
    }

    const previousRedactedPath = docRecord.redactedFilePath;

    const redactionOutput = await generatePermanentlyRedactedPdf(
      docRecord.originalFilePath,
      itemsToRedact
    );

    // Clean up any previous redacted file only after the new redaction has succeeded
    if (previousRedactedPath && previousRedactedPath !== redactionOutput.redactedFilePath) {
      await safeDeleteFile(previousRedactedPath);
    }

    const chosenIds = itemsToRedact.map((i) => i.id);
    updateDocumentRecord(documentId, {
      redactionMode: mode,
      selectedItemIds: chosenIds,
      redactedFilePath: redactionOutput.redactedFilePath,
      redactedSha256: redactionOutput.sha256,
      redactedFileSizeBytes: redactionOutput.fileSizeBytes,
    });

    res.status(200).json({
      success: true,
      documentId,
      mode,
      totalDetectedBeforeRedaction: detectedItems.length,
      selectedForRedactionCount: itemsToRedact.length,
      unselectedCount: Math.max(0, detectedItems.length - itemsToRedact.length),
      redactedPdfSha256: redactionOutput.sha256,
      redactedFileSizeBytes: redactionOutput.fileSizeBytes,
      downloadUrl: `/api/download/${documentId}`,
      notice:
        'Pages were rendered to raster images, masked permanently, and rebuilt into a new PDF. Original embedded text layers have been stripped, which reduces text selectability and searchability in exchange for permanent removal.',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/verify
 */
export async function verifyPdfController(req, res, next) {
  try {
    const { documentId, runOcrCheck = true } = req.body || {};

    if (!documentId || typeof documentId !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'MISSING_DOCUMENT_ID',
        message: 'Please provide a valid "documentId" in the request body.',
      });
    }

    const docRecord = getDocumentRecord(documentId);
    if (!docRecord) {
      return res.status(404).json({
        success: false,
        error: 'DOCUMENT_NOT_FOUND',
        message: `Document with ID "${documentId}" was not found or has expired.`,
      });
    }

    if (!docRecord.redactedFilePath || !fs.existsSync(docRecord.redactedFilePath)) {
      return res.status(400).json({
        success: false,
        error: 'REDACTED_PDF_NOT_READY',
        message: 'Please call POST /api/redact to generate a redacted PDF before running POST /api/verify.',
      });
    }

    const verificationResult = await verifyRedactedPdf(
      docRecord.redactedFilePath,
      docRecord.detectedItems || [],
      docRecord.selectedItemIds || [],
      runOcrCheck
    );

    const report = buildPrivacyAssessmentReport({
      documentRecord: docRecord,
      verificationResult,
    });

    saveReportRecord(report);
    updateDocumentRecord(documentId, {
      reportId: report.reportId,
      lastVerification: verificationResult,
    });

    res.status(200).json({
      success: true,
      documentId,
      reportId: report.reportId,
      verification: verificationResult,
      report,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/report/:id
 */
export function getReportController(req, res) {
  const { id } = req.params;
  const report = getReportRecord(id);

  if (!report) {
    return res.status(404).json({
      success: false,
      error: 'REPORT_NOT_FOUND',
      message: `No privacy assessment report found for ID "${id}". Run POST /api/verify first to generate the report.`,
    });
  }

  res.status(200).json({
    success: true,
    report,
  });
}

/**
 * GET /api/download/:documentId
 */
export function downloadRedactedPdfController(req, res) {
  const { documentId } = req.params;
  const docRecord = getDocumentRecord(documentId);

  if (!docRecord || !docRecord.redactedFilePath || !fs.existsSync(docRecord.redactedFilePath)) {
    return res.status(404).json({
      success: false,
      error: 'REDACTED_FILE_NOT_FOUND',
      message: `Redacted PDF for document "${documentId}" was not found. Generate it first via POST /api/redact.`,
    });
  }

  const safeBaseName = (docRecord.fileName || 'document.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
  const downloadFileName = `protected_${safeBaseName}`;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${downloadFileName}"`);
  if (docRecord.redactedSha256) {
    res.setHeader('X-Document-SHA256', docRecord.redactedSha256);
  }

  const stream = fs.createReadStream(docRecord.redactedFilePath);
  stream.pipe(res);
}
