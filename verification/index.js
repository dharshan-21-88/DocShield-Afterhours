import fs from 'fs/promises';
import zlib from 'zlib';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  extractPdfContent,
  inspectPdfMetadataStructure,
  inspectPdfAttachmentStructure,
  inspectPdfRevisionStructure,
  maskBinaryStreamsPreservingOffsets,
} from '../extraction/index.js';
import {
  detectSensitiveInfo,
  scanTextForSensitiveMatches,
} from '../detection/index.js';

/**
 * Explicit allowlist of safe DocShield-generated metadata fields permitted in the exported PDF.
 * Any original document metadata, custom `/Info` entries, or XMP streams must be absent.
 */
export const ALLOWED_DOCSHIELD_METADATA = Object.freeze({
  Title: ['DocShield Protected Document'],
  Creator: [
    'DocShield – Smart Document Privacy Protector',
    'pdf-lib (https://github.com/Hopding/pdf-lib)',
  ],
  Producer: [
    'DocShield – Smart Document Privacy Protector',
    'pdf-lib (https://github.com/Hopding/pdf-lib)',
  ],
  forbiddenPopulatedStandardFields: ['Author', 'Subject', 'Keywords'],
  datePattern: /^D:\d{8,14}(?:[+-Z]\d{0,2}'?\d{0,2}'?)?$/,
});

const PDF_TEXT_OPERATORS = new Set(
  [
    pdfjsLib.OPS?.beginText,
    pdfjsLib.OPS?.endText,
    pdfjsLib.OPS?.showText,
    pdfjsLib.OPS?.showSpacedText,
    pdfjsLib.OPS?.nextLineShowText,
    pdfjsLib.OPS?.nextLineSetSpacingShowText,
  ].filter((op) => typeof op === 'number')
);

/**
 * Inspect raw content streams in the exported PDF (excluding `/Subtype /Image` and `/Type /XRef`)
 * for any surviving PDF text-object blocks (`BT ... ET`) or text-showing operators (`Tj`, `TJ`).
 */
function countRawContentStreamTextBlocks(rawPdfLatin1) {
  if (!rawPdfLatin1) return 0;
  let textBlockCount = 0;

  const inspectStreamBody = (bodyStr) => {
    if (!bodyStr) return;
    if (/\bBT\b[\s\S]{1,8192}?\bET\b/.test(bodyStr)) {
      textBlockCount++;
      return;
    }
    if (/\([^()\\]*(?:\\.[^()\\]*)*\)\s*Tj\b|\[[^\]]+\]\s*TJ\b/.test(bodyStr)) {
      textBlockCount++;
    }
  };

  const streamRegex = /<<([\s\S]{0,400}?)>>\s*stream(?:\r\n|\n|\r)([\s\S]*?)(?:\r\n|\n|\r)?endstream/g;
  let sm;
  while ((sm = streamRegex.exec(rawPdfLatin1)) !== null) {
    const dictHeader = sm[1] || '';
    const streamBodyLatin1 = sm[2] || '';
    if (/\/Subtype\s*\/Image\b|\/Type\s*\/XRef\b/i.test(dictHeader)) {
      continue;
    }

    if (/\/Filter\s*(?:\/FlateDecode|\[\s*\/FlateDecode\b)/i.test(dictHeader)) {
      try {
        const inflated = zlib
          .inflateSync(Buffer.from(streamBodyLatin1, 'latin1'), { maxOutputLength: 2 * 1024 * 1024 })
          .toString('latin1');
        inspectStreamBody(inflated);
      } catch {
        // Uninflatable non-image stream is handled by operator list check
      }
    } else {
      inspectStreamBody(streamBodyLatin1);
    }
  }

  return textBlockCount;
}

/**
 * Create an INDETERMINATE structural check result when an unexpected inspection error occurs.
 * Fail-safe requirement: never silently treat inspection errors as successful checks.
 */
function buildIndeterminateCheck(checkName, err) {
  const errMsg = err?.message || String(err || 'Unknown structural inspection error');
  return {
    status: 'INDETERMINATE',
    verified: false,
    error: errMsg,
    reason: `Structural verification check "${checkName}" could not be completed safely: ${errMsg}`,
  };
}

/**
 * P2.3 Post-Redaction Structural Verification Engine.
 *
 * Independently inspects the exported PDF on disk to verify that hidden structures
 * from the original document have not survived:
 * 1. Metadata verification (standard `/Info`, custom `/Info`, XMP metadata, safe DocShield allowlist).
 * 2. Attachment verification (catalog `/EmbeddedFiles`, `/AF` associated files, `/Collection` portfolios,
 *    raw `/Filespec` dictionaries, and page `FileAttachment` annotations; explicitly reports if original
 *    attachments had uninspected content before removal).
 * 3. Annotation and form verification (AcroForm `/AcroForm` fields, Widget, FreeText, Stamp, Redact,
 *    Caret, Link, Text, Popup, and all other annotation subtypes).
 * 4. Revision verification (incremental updates, trailer `/Prev`, multiple `startxref` or `xref` sections).
 * 5. Text-layer verification (confirms 0 selectable text items and 0 hidden PDF text operators survive).
 *
 * Distinguishes `PASSED`, `FAILED`, and `INDETERMINATE`.
 */
export async function verifyExportedPdfStructure(redactedFilePath, originalStructuralAudit = null, options = {}) {
  const simulatedErrors = options?.simulateCheckErrors || {};
  const warnings = [];

  // Extract prior attachment info from the original document's structuralAudit (if provided)
  const originalAttachmentItems = Array.isArray(originalStructuralAudit?.attachments?.items)
    ? originalStructuralAudit.attachments.items
    : [];
  const originalUninspectedAttachments = originalAttachmentItems.filter(
    (att) => att && att.contentInspected === false
  );
  const originalMetadataDetections = Array.isArray(originalStructuralAudit?.metadataDetections)
    ? originalStructuralAudit.metadataDetections.filter(
        (d) =>
          d &&
          (d.source === 'pdf-metadata' ||
            d.source === 'pdf-custom-metadata' ||
            d.source === 'pdf-xmp-metadata')
      )
    : [];

  let dataBuffer;
  let pdfDoc;
  try {
    if (simulatedErrors.fileLoad) {
      throw new Error(String(simulatedErrors.fileLoad));
    }
    dataBuffer = await fs.readFile(redactedFilePath);
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(dataBuffer),
      useSystemFonts: true,
      disableFontFace: true,
      verbosity: 0,
    });
    pdfDoc = await loadingTask.promise;
    if (!pdfDoc || !pdfDoc.numPages || pdfDoc.numPages < 1) {
      throw new Error('Exported PDF has 0 pages or invalid document structure.');
    }
  } catch (loadErr) {
    const indeterminateChecks = {
      metadata: buildIndeterminateCheck('metadata', loadErr),
      attachments: {
        ...buildIndeterminateCheck('attachments', loadErr),
        hadUninspectedAttachmentsBeforeRedaction: originalUninspectedAttachments.length > 0,
        removedAttachmentsWithUninspectedContent: [],
      },
      annotationsAndForms: buildIndeterminateCheck('annotationsAndForms', loadErr),
      revisions: buildIndeterminateCheck('revisions', loadErr),
      textLayer: buildIndeterminateCheck('textLayer', loadErr),
    };

    warnings.push({
      code: 'STRUCTURAL_VERIFICATION_INDETERMINATE',
      severity: 'HIGH',
      section: 'structuralVerification',
      message: `Exported PDF could not be opened for structural verification: ${loadErr?.message || 'Unknown error'}`,
    });

    return {
      verified: false,
      status: 'INDETERMINATE',
      summary: `Post-redaction structural verification is INDETERMINATE because the exported PDF could not be inspected: ${
        loadErr?.message || 'Unknown error'
      }`,
      checks: indeterminateChecks,
      warnings,
    };
  }

  const rawPdfLatin1 = dataBuffer.toString('latin1');
  const nonStreamPdfLatin1 = maskBinaryStreamsPreservingOffsets(rawPdfLatin1);
  const numPages = pdfDoc.numPages;

  // Shared metadata info reference for attachment/revision helpers
  let sharedMetaInfo = null;
  const checks = {};

  // =========================================================================
  // 1. METADATA VERIFICATION
  // =========================================================================
  try {
    if (simulatedErrors.metadata) {
      throw new Error(String(simulatedErrors.metadata));
    }

    const metaStruct = await inspectPdfMetadataStructure(pdfDoc, rawPdfLatin1);
    sharedMetaInfo = metaStruct.metaInfo || {};

    const standardFields = metaStruct.standardFields || {};
    const customFields = metaStruct.customFields || {};
    const survivingCustomFieldKeys = Object.keys(customFields);
    const hasRawMetadataStream = /\/Type\s*\/Metadata\b/.test(nonStreamPdfLatin1);
    const hasXmpMetadata = Boolean(metaStruct.hasXmpMetadata) || hasRawMetadataStream;

    // Check every populated standard field against the explicit safe DocShield allowlist
    const unexpectedStandardFields = [];
    for (const [key, val] of Object.entries(standardFields)) {
      if (val === null || val === undefined || String(val).trim() === '') continue;
      const trimmed = String(val).trim();

      if (ALLOWED_DOCSHIELD_METADATA.forbiddenPopulatedStandardFields.includes(key)) {
        unexpectedStandardFields.push({
          field: key,
          reason: `Standard metadata field "${key}" must be empty in the exported PDF.`,
        });
      } else if (key === 'Title' && !ALLOWED_DOCSHIELD_METADATA.Title.includes(trimmed)) {
        unexpectedStandardFields.push({
          field: key,
          reason: `Title metadata does not match safe DocShield Title allowlist.`,
        });
      } else if (key === 'Creator' && !ALLOWED_DOCSHIELD_METADATA.Creator.includes(trimmed)) {
        unexpectedStandardFields.push({
          field: key,
          reason: `Creator metadata does not match safe DocShield Creator allowlist.`,
        });
      } else if (key === 'Producer' && !ALLOWED_DOCSHIELD_METADATA.Producer.includes(trimmed)) {
        unexpectedStandardFields.push({
          field: key,
          reason: `Producer metadata does not match safe DocShield Producer allowlist.`,
        });
      } else if (
        (key === 'CreationDate' || key === 'ModDate') &&
        !ALLOWED_DOCSHIELD_METADATA.datePattern.test(trimmed)
      ) {
        unexpectedStandardFields.push({
          field: key,
          reason: `${key} does not match standard PDF timestamp format.`,
        });
      }
    }

    // Scan all exported metadata strings for any sensitive information patterns
    const survivingSensitiveMetadata = [];
    for (const [k, v] of Object.entries(standardFields)) {
      if (!v) continue;
      const matches = scanTextForSensitiveMatches(v);
      for (const m of matches) {
        survivingSensitiveMetadata.push({
          field: k,
          source: 'pdf-metadata',
          category: m.category,
          categoryLabel: m.categoryLabel,
          maskedText: m.maskedText,
        });
      }
    }
    for (const [k, v] of Object.entries(customFields)) {
      if (!v) continue;
      const matches = scanTextForSensitiveMatches(v);
      for (const m of matches) {
        survivingSensitiveMetadata.push({
          field: `Custom:${k}`,
          source: 'pdf-custom-metadata',
          category: m.category,
          categoryLabel: m.categoryLabel,
          maskedText: m.maskedText,
        });
      }
    }
    if (metaStruct.xmpText) {
      const matches = scanTextForSensitiveMatches(metaStruct.xmpText);
      for (const m of matches) {
        survivingSensitiveMetadata.push({
          field: 'XMP',
          source: 'pdf-xmp-metadata',
          category: m.category,
          categoryLabel: m.categoryLabel,
          maskedText: m.maskedText,
        });
      }
    }

    // Also confirm that none of the original document's sensitive metadata strings survived
    const combinedExportedMetaText = [
      ...Object.values(standardFields).filter(Boolean),
      ...Object.values(customFields).filter(Boolean),
      metaStruct.xmpText || '',
    ]
      .join('\n')
      .toLowerCase();

    const survivingOriginalMetadataItems = [];
    for (const origDet of originalMetadataDetections) {
      const target = String(origDet.text || '').trim().toLowerCase();
      if (target && combinedExportedMetaText.includes(target)) {
        survivingOriginalMetadataItems.push({
          id: origDet.id,
          category: origDet.category,
          metadataField: origDet.metadataField,
          maskedText: origDet.maskedText,
        });
      }
    }

    const failureReasons = [];
    if (survivingSensitiveMetadata.length > 0) {
      failureReasons.push(
        `Detected ${survivingSensitiveMetadata.length} sensitive item(s) in exported PDF metadata.`
      );
    }
    if (survivingOriginalMetadataItems.length > 0) {
      failureReasons.push(
        `${survivingOriginalMetadataItems.length} original sensitive metadata item(s) survived in the exported PDF.`
      );
    }
    if (unexpectedStandardFields.length > 0) {
      failureReasons.push(
        `Unexpected or non-allowlisted standard metadata field(s) present: ${unexpectedStandardFields
          .map((u) => u.field)
          .join(', ')}.`
      );
    }
    if (survivingCustomFieldKeys.length > 0) {
      failureReasons.push(
        `Custom /Info metadata field(s) survived in the exported PDF: ${survivingCustomFieldKeys.join(', ')}.`
      );
    }
    if (hasXmpMetadata) {
      failureReasons.push('XMP metadata stream (/Metadata) survived in the exported PDF.');
    }

    const passed = failureReasons.length === 0;
    if (!passed) {
      warnings.push({
        code: 'STRUCTURAL_METADATA_VERIFICATION_FAILED',
        severity: 'HIGH',
        section: 'metadata',
        message: failureReasons.join(' '),
      });
    }

    checks.metadata = {
      status: passed ? 'PASSED' : 'FAILED',
      verified: passed,
      hasInfoDictionary: Boolean(metaStruct.hasInfoDictionary),
      hasXmpMetadata,
      standardFields,
      survivingCustomFieldKeys,
      unexpectedStandardFields,
      survivingSensitiveMetadata,
      survivingOriginalMetadataCount: survivingOriginalMetadataItems.length,
      originalSensitiveMetadataRemovedCount: Math.max(
        0,
        originalMetadataDetections.length - survivingOriginalMetadataItems.length
      ),
      onlyAllowedDocShieldMetadataPresent:
        unexpectedStandardFields.length === 0 &&
        survivingCustomFieldKeys.length === 0 &&
        !hasXmpMetadata,
      reason: passed
        ? 'Original sensitive metadata, custom Info entries, and XMP streams are absent; only safe DocShield-generated metadata is present.'
        : failureReasons.join(' '),
    };
  } catch (metaErr) {
    checks.metadata = buildIndeterminateCheck('metadata', metaErr);
    warnings.push({
      code: 'STRUCTURAL_METADATA_CHECK_INDETERMINATE',
      severity: 'HIGH',
      section: 'metadata',
      message: checks.metadata.reason,
    });
  }

  // =========================================================================
  // 2. ATTACHMENT VERIFICATION
  // =========================================================================
  try {
    if (simulatedErrors.attachments) {
      throw new Error(String(simulatedErrors.attachments));
    }

    const exportedPageFileAttachments = [];
    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const rawAnns = (await page.getAnnotations()) || [];
      for (const ann of rawAnns) {
        if (ann?.subtype === 'FileAttachment') {
          const fileObj = ann.file || {};
          exportedPageFileAttachments.push({
            id: ann.id || `exp_page_att_${pageNum}_${exportedPageFileAttachments.length + 1}`,
            pageNumber: pageNum,
            source: 'page-file-attachment',
            subtype: 'FileAttachment',
            filename:
              fileObj.filename ||
              fileObj.rawFilename ||
              ann.titleObj?.str ||
              'page_file_attachment',
          });
        }
      }
    }

    const attStruct = await inspectPdfAttachmentStructure(
      pdfDoc,
      exportedPageFileAttachments,
      sharedMetaInfo,
      nonStreamPdfLatin1
    );
    const hasCatalogEmbeddedFilesNameTree = /\/EmbeddedFiles\b/.test(nonStreamPdfLatin1);
    const remainingAttachments = (attStruct.items || []).map((item) => ({
      id: item.id,
      filename: item.filename,
      source: item.source,
      pageNumber: item.pageNumber ?? null,
    }));

    const remainingAttachmentCount = remainingAttachments.length;
    const isPortfolioCollection = Boolean(attStruct.isPortfolioCollection);
    const hasAssociatedFiles = Boolean(attStruct.hasAssociatedFiles);

    const failureReasons = [];
    if (remainingAttachmentCount > 0) {
      failureReasons.push(
        `${remainingAttachmentCount} embedded attachment(s) or FileAttachment annotation(s) remain in the exported PDF.`
      );
    }
    if (hasCatalogEmbeddedFilesNameTree && remainingAttachmentCount === 0) {
      failureReasons.push('Catalog /EmbeddedFiles name tree remains present in the exported PDF.');
    }
    if (isPortfolioCollection) {
      failureReasons.push('PDF Portfolio (/Collection) structure remains present in the exported PDF.');
    }
    if (hasAssociatedFiles) {
      failureReasons.push('Associated Files (/AF) structure remains present in the exported PDF.');
    }

    const passed = failureReasons.length === 0;
    const hadUninspectedAttachmentsBeforeRedaction = originalUninspectedAttachments.length > 0;
    const removedAttachmentsWithUninspectedContent = originalUninspectedAttachments.map((att) => ({
      id: att.id,
      filename: att.filename,
      source: att.source,
      pageNumber: att.pageNumber ?? null,
      contentInspectedBeforeRedaction: false,
      removedFromExportedPdf: passed,
      status: passed
        ? 'REMOVED_FROM_EXPORT_PRIOR_CONTENT_UNINSPECTED'
        : 'ATTACHMENT_REMOVAL_NOT_VERIFIED',
    }));

    const uninspectedPriorContentNotice = hadUninspectedAttachmentsBeforeRedaction
      ? `Original PDF contained ${removedAttachmentsWithUninspectedContent.length} attachment(s) whose internal file contents were not inspected prior to redaction. ${
          passed
            ? 'Structural verification confirms all attachments were completely removed from the exported PDF, though their prior internal contents were uninspected before removal.'
            : 'Attachment removal failed verification.'
        }`
      : null;

    if (hadUninspectedAttachmentsBeforeRedaction) {
      warnings.push({
        code: 'PRIOR_UNINSPECTED_ATTACHMENT_REMOVED',
        severity: 'MEDIUM',
        section: 'attachments',
        message: uninspectedPriorContentNotice,
      });
    }

    if (!passed) {
      warnings.push({
        code: 'STRUCTURAL_ATTACHMENT_VERIFICATION_FAILED',
        severity: 'HIGH',
        section: 'attachments',
        message: failureReasons.join(' '),
      });
    }

    checks.attachments = {
      status: passed ? 'PASSED' : 'FAILED',
      verified: passed,
      remainingAttachmentCount,
      hasCatalogEmbeddedFilesNameTree,
      isPortfolioCollection,
      hasAssociatedFiles,
      remainingAttachments,
      hadUninspectedAttachmentsBeforeRedaction,
      removedAttachmentsWithUninspectedContent,
      uninspectedPriorContentNotice,
      reason: passed
        ? hadUninspectedAttachmentsBeforeRedaction
          ? `Confirmed 0 attachments, associated files, portfolios, or FileAttachment annotations remain in the exported PDF (${removedAttachmentsWithUninspectedContent.length} prior attachment(s) with uninspected content were stripped during rebuild).`
          : 'Confirmed 0 catalog embedded files, associated files, portfolios, or FileAttachment annotations exist in the exported PDF.'
        : failureReasons.join(' '),
    };
  } catch (attErr) {
    checks.attachments = {
      ...buildIndeterminateCheck('attachments', attErr),
      hadUninspectedAttachmentsBeforeRedaction: originalUninspectedAttachments.length > 0,
      removedAttachmentsWithUninspectedContent: [],
    };
    warnings.push({
      code: 'STRUCTURAL_ATTACHMENT_CHECK_INDETERMINATE',
      severity: 'HIGH',
      section: 'attachments',
      message: checks.attachments.reason,
    });
  }

  // =========================================================================
  // 3. ANNOTATION AND FORM VERIFICATION
  // =========================================================================
  try {
    if (simulatedErrors.annotationsAndForms) {
      throw new Error(String(simulatedErrors.annotationsAndForms));
    }

    const remainingAnnotations = [];
    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const rawAnns = (await page.getAnnotations()) || [];
      for (const ann of rawAnns) {
        remainingAnnotations.push({
          id: ann?.id || null,
          pageNumber: pageNum,
          subtype: ann?.subtype || 'Unknown',
          fieldType: ann?.fieldType || null,
          fieldName: ann?.fieldName || null,
        });
      }
    }

    let acroFormFieldCount = 0;
    try {
      const fieldObjects = await pdfDoc.getFieldObjects();
      if (fieldObjects && typeof fieldObjects === 'object') {
        acroFormFieldCount = Object.keys(fieldObjects).length;
      }
    } catch {
      // Fall back to raw catalog /AcroForm inspection below
    }

    const hasAcroFormCatalogEntry = /\/AcroForm\s*(?:<<|\d+\s+\d+\s+R\b)/.test(nonStreamPdfLatin1);
    const hasRawAnnotObjects =
      /\/Subtype\s*\/(?:Widget|FreeText|Stamp|Redact|Caret|Text|Popup|FileAttachment|Link|Highlight|Underline|StrikeOut|Ink|Square|Circle)\b/.test(
        nonStreamPdfLatin1
      );
    const hasWidgetAnnotations = remainingAnnotations.some((a) => a.subtype === 'Widget');

    const failureReasons = [];
    if (remainingAnnotations.length > 0) {
      const subtypes = Array.from(new Set(remainingAnnotations.map((a) => a.subtype))).join(', ');
      failureReasons.push(
        `Found ${remainingAnnotations.length} surviving annotation(s) in exported PDF (subtypes: ${subtypes}).`
      );
    }
    if (acroFormFieldCount > 0 || hasAcroFormCatalogEntry) {
      failureReasons.push(
        `AcroForm structure or form fields survived in exported PDF (fieldObjects=${acroFormFieldCount}, hasAcroFormCatalogEntry=${hasAcroFormCatalogEntry}).`
      );
    }
    if (hasRawAnnotObjects && remainingAnnotations.length === 0) {
      failureReasons.push('Raw PDF annotation dictionary object(s) survived in exported PDF.');
    }

    const passed = failureReasons.length === 0;
    if (!passed) {
      warnings.push({
        code: 'STRUCTURAL_ANNOTATION_FORM_VERIFICATION_FAILED',
        severity: 'HIGH',
        section: 'annotationsAndForms',
        message: failureReasons.join(' '),
      });
    }

    checks.annotationsAndForms = {
      status: passed ? 'PASSED' : 'FAILED',
      verified: passed,
      remainingAnnotationCount: remainingAnnotations.length,
      acroFormFieldCount,
      hasAcroFormCatalogEntry,
      hasWidgetAnnotations,
      remainingAnnotations,
      reason: passed
        ? 'Confirmed 0 annotations (Widget, FreeText, Stamp, Redact, Caret, Link, Text, Popup, or other) and 0 AcroForm fields exist in the exported PDF.'
        : failureReasons.join(' '),
    };
  } catch (annErr) {
    checks.annotationsAndForms = buildIndeterminateCheck('annotationsAndForms', annErr);
    warnings.push({
      code: 'STRUCTURAL_ANNOTATION_CHECK_INDETERMINATE',
      severity: 'HIGH',
      section: 'annotationsAndForms',
      message: checks.annotationsAndForms.reason,
    });
  }

  // =========================================================================
  // 4. REVISION VERIFICATION
  // =========================================================================
  try {
    if (simulatedErrors.revisions) {
      throw new Error(String(simulatedErrors.revisions));
    }

    const revStruct = inspectPdfRevisionStructure(
      dataBuffer,
      rawPdfLatin1,
      nonStreamPdfLatin1,
      sharedMetaInfo
    );

    if (revStruct.status === 'INDETERMINATE') {
      checks.revisions = {
        status: 'INDETERMINATE',
        verified: false,
        incrementalUpdatesDetected: null,
        revisionCount: revStruct.revisionCount ?? null,
        prevCount: revStruct.prevCount ?? 0,
        startxrefCount: revStruct.startxrefCount ?? 0,
        xrefSectionCount: revStruct.xrefSectionCount ?? 0,
        eofCount: revStruct.eofCount ?? 0,
        reason:
          revStruct.reason ||
          'Exported PDF cross-reference / trailer structure is malformed or indeterminate.',
      };
      warnings.push({
        code: 'STRUCTURAL_REVISION_CHECK_INDETERMINATE',
        severity: 'HIGH',
        section: 'revisions',
        message: checks.revisions.reason,
      });
    } else {
      const isSingleCleanRevision =
        revStruct.status === 'NOT_DETECTED' &&
        !revStruct.isLinearized &&
        revStruct.revisionCount === 1 &&
        revStruct.prevCount === 0 &&
        revStruct.startxrefCount === 1 &&
        revStruct.xrefSectionCount === 1;

      const failureReasons = [];
      if (revStruct.status === 'DETECTED' || revStruct.prevCount > 0 || revStruct.revisionCount > 1) {
        failureReasons.push(
          `Exported PDF contains multiple revisions or trailer /Prev references (revisionCount=${revStruct.revisionCount}, prevCount=${revStruct.prevCount}, startxrefCount=${revStruct.startxrefCount}).`
        );
      } else if (!isSingleCleanRevision) {
        failureReasons.push(
          `Exported PDF does not have a single clean cross-reference generation (status=${revStruct.status}, startxrefCount=${revStruct.startxrefCount}, xrefSectionCount=${revStruct.xrefSectionCount}, isLinearized=${revStruct.isLinearized}).`
        );
      }

      const passed = failureReasons.length === 0;
      if (!passed) {
        warnings.push({
          code: 'STRUCTURAL_REVISION_VERIFICATION_FAILED',
          severity: 'HIGH',
          section: 'revisions',
          message: failureReasons.join(' '),
        });
      }

      checks.revisions = {
        status: passed ? 'PASSED' : 'FAILED',
        verified: passed,
        incrementalUpdatesDetected: !passed && (revStruct.status === 'DETECTED' || revStruct.prevCount > 0),
        revisionCount: revStruct.revisionCount ?? 1,
        prevCount: revStruct.prevCount ?? 0,
        startxrefCount: revStruct.startxrefCount ?? 0,
        xrefSectionCount: revStruct.xrefSectionCount ?? 0,
        eofCount: revStruct.eofCount ?? 0,
        reason: passed
          ? 'Exported PDF is a clean, independently written single-revision document with 0 trailer /Prev references and 1 cross-reference section.'
          : failureReasons.join(' '),
      };
    }
  } catch (revErr) {
    checks.revisions = buildIndeterminateCheck('revisions', revErr);
    warnings.push({
      code: 'STRUCTURAL_REVISION_CHECK_INDETERMINATE',
      severity: 'HIGH',
      section: 'revisions',
      message: checks.revisions.reason,
    });
  }

  // =========================================================================
  // 5. TEXT-LAYER VERIFICATION
  // =========================================================================
  try {
    if (simulatedErrors.textLayer) {
      throw new Error(String(simulatedErrors.textLayer));
    }

    let selectableTextItemCount = 0;
    let selectableCharacterCount = 0;
    let pageTextOperatorCount = 0;
    const pagesWithSelectableText = [];
    const pagesWithTextOperators = [];

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const textContent = await page.getTextContent();
      const rawItems = textContent?.items || [];

      let pageItems = 0;
      let pageChars = 0;
      for (const item of rawItems) {
        const str = (item?.str || '').trim();
        if (str.length > 0) {
          pageItems++;
          pageChars += str.length;
        }
      }
      if (pageItems > 0) {
        selectableTextItemCount += pageItems;
        selectableCharacterCount += pageChars;
        pagesWithSelectableText.push(pageNum);
      }

      const opList = await page.getOperatorList();
      const fnArray = opList?.fnArray || [];
      let pageTextOps = 0;
      for (let i = 0; i < fnArray.length; i++) {
        if (PDF_TEXT_OPERATORS.has(fnArray[i])) {
          pageTextOps++;
        }
      }
      if (pageTextOps > 0) {
        pageTextOperatorCount += pageTextOps;
        pagesWithTextOperators.push(pageNum);
      }
    }

    const rawStreamTextBlockCount = countRawContentStreamTextBlocks(rawPdfLatin1);

    const failureReasons = [];
    if (selectableTextItemCount > 0 || selectableCharacterCount > 0) {
      failureReasons.push(
        `Exported PDF retains ${selectableTextItemCount} selectable text item(s) (${selectableCharacterCount} characters) on page(s) ${pagesWithSelectableText.join(
          ', '
        )}.`
      );
    }
    if (pageTextOperatorCount > 0 || rawStreamTextBlockCount > 0) {
      failureReasons.push(
        `Exported PDF retains hidden or visible PDF text operators (pageTextOperatorCount=${pageTextOperatorCount}, rawStreamTextBlockCount=${rawStreamTextBlockCount}).`
      );
    }

    const passed = failureReasons.length === 0;
    if (!passed) {
      warnings.push({
        code: 'STRUCTURAL_TEXT_LAYER_VERIFICATION_FAILED',
        severity: 'HIGH',
        section: 'textLayer',
        message: failureReasons.join(' '),
      });
    }

    checks.textLayer = {
      status: passed ? 'PASSED' : 'FAILED',
      verified: passed,
      selectableTextItemCount,
      selectableCharacterCount,
      pageTextOperatorCount,
      rawStreamTextBlockCount,
      pagesWithSelectableText,
      pagesWithTextOperators,
      reason: passed
        ? 'Confirmed 0 selectable text items and 0 hidden PDF text objects across all exported pages.'
        : failureReasons.join(' '),
    };
  } catch (txtErr) {
    checks.textLayer = buildIndeterminateCheck('textLayer', txtErr);
    warnings.push({
      code: 'STRUCTURAL_TEXT_LAYER_CHECK_INDETERMINATE',
      severity: 'HIGH',
      section: 'textLayer',
      message: checks.textLayer.reason,
    });
  }

  // =========================================================================
  // AGGREGATE STRUCTURAL VERIFICATION RESULT
  // =========================================================================
  const requiredCheckKeys = [
    'metadata',
    'attachments',
    'annotationsAndForms',
    'revisions',
    'textLayer',
  ];

  const failedCheckNames = requiredCheckKeys.filter((k) => checks[k]?.status === 'FAILED');
  const indeterminateCheckNames = requiredCheckKeys.filter(
    (k) => !checks[k] || checks[k].status === 'INDETERMINATE'
  );

  let overallStatus = 'PASSED';
  if (failedCheckNames.length > 0) {
    overallStatus = 'FAILED';
  } else if (indeterminateCheckNames.length > 0) {
    overallStatus = 'INDETERMINATE';
  }

  const verified = overallStatus === 'PASSED';
  let summary =
    'All 5 post-redaction structural checks PASSED (metadata, attachments, annotations/forms, single-revision history, and text-layer removal).';
  if (overallStatus === 'FAILED') {
    summary = `Post-redaction structural verification FAILED in check(s): ${failedCheckNames.join(', ')}.`;
  } else if (overallStatus === 'INDETERMINATE') {
    summary = `Post-redaction structural verification is INDETERMINATE in check(s): ${indeterminateCheckNames.join(
      ', '
    )}.`;
  } else if (checks.attachments?.hadUninspectedAttachmentsBeforeRedaction) {
    summary =
      'All 5 post-redaction structural checks PASSED. Note: original embedded attachment(s) had uninspected content prior to being stripped from the exported PDF.';
  }

  return {
    verified,
    status: overallStatus,
    summary,
    checks,
    warnings,
  };
}

/**
 * Post-Redaction Verification Engine (Visual OCR + Independent Structural Verification).
 *
 * "Don't just redact documents. Verify what remains exposed before sharing."
 *
 * After generating the permanently redacted PDF:
 * 1. Re-extracts any embedded PDF text streams and runs Tesseract.js OCR on rendered pages (when runOcrCheck = true).
 * 2. Checks whether each item selected for redaction is still detectable via OCR/text.
 * 3. Runs full pattern detection on the redacted output to report any remaining unselected sensitive items.
 * 4. Independently inspects the exported PDF structure (`structuralVerification`) to verify that metadata,
 *    attachments, AcroForm/annotations, incremental revisions, and selectable/hidden text layers have not survived.
 * 5. Never reports overall verification as passed if either OCR verification or any required structural check
 *    failed or is indeterminate.
 */
export async function verifyRedactedPdf(
  redactedFilePath,
  originalDetectedItems = [],
  selectedItemIds = [],
  runOcrCheck = true,
  originalStructuralAudit = null,
  options = {}
) {
  let extraction = null;
  let ocrError = null;

  try {
    if (options?.simulateOcrError) {
      throw new Error(String(options.simulateOcrError));
    }
    extraction = await extractPdfContent(redactedFilePath, {
      forceOcr: Boolean(runOcrCheck),
    });
  } catch (err) {
    ocrError = err;
  }

  const selectedSet = new Set(selectedItemIds);
  const selectedItems = originalDetectedItems.filter((item) => selectedSet.has(item.id));
  const unselectedItems = originalDetectedItems.filter((item) => !selectedSet.has(item.id));

  const removedItems = [];
  const selectedStillDetectable = [];
  let remainingItems = [];

  if (!ocrError && extraction) {
    const combinedAfterText = (extraction.pages || [])
      .map((p) => p.text || '')
      .join('\n')
      .toLowerCase();

    // Also normalize whitespace/punctuation for resilient comparison
    const compactAfterText = combinedAfterText.replace(/[\s-]+/g, '');

    for (const item of selectedItems) {
      const rawTarget = (item.text || '').trim().toLowerCase();
      const compactTarget = rawTarget.replace(/[\s-]+/g, '');

      const stillPresentExact = rawTarget.length > 0 && combinedAfterText.includes(rawTarget);
      const stillPresentCompact =
        compactTarget.length >= 6 && compactAfterText.includes(compactTarget);

      if (stillPresentExact || stillPresentCompact) {
        selectedStillDetectable.push({
          ...item,
          verificationStatus: 'STILL_DETECTABLE',
        });
      } else {
        removedItems.push({
          ...item,
          verificationStatus: 'VERIFIED_REMOVED',
        });
      }
    }

    // Run the sensitive information detector on the redacted PDF's extracted/OCR text
    // Use `ver_det` prefix so post-redaction detection IDs never collide with original `det_N` IDs
    const postDetection = detectSensitiveInfo(extraction, null, { idPrefix: 'ver_det' });

    // Correlate post-redaction detections with unselected original detections where applicable
    const usedOriginalUnselectedIds = new Set();
    remainingItems = postDetection.items.map((postItem) => {
      const postNorm = (postItem.text || '').trim().toLowerCase();
      const postCompact = postNorm.replace(/[\s-]+/g, '');
      const matchingUnselected = unselectedItems.find((u) => {
        if (usedOriginalUnselectedIds.has(u.id) || u.pageNumber !== postItem.pageNumber) {
          return false;
        }
        const unselNorm = (u.text || '').trim().toLowerCase();
        if (unselNorm === postNorm) return true;

        // Handle OCR intra-token whitespace splits (e.g., "preserve. me@fictional-univ.edu" where regex
        // matched "me@fictional-univ.edu" while compact page OCR text contains the full unselected value)
        const unselCompact = unselNorm.replace(/[\s-]+/g, '');
        if (
          u.category === postItem.category &&
          postCompact.length >= 6 &&
          unselCompact.includes(postCompact) &&
          compactAfterText.includes(unselCompact)
        ) {
          return true;
        }
        return false;
      });

      if (matchingUnselected) {
        usedOriginalUnselectedIds.add(matchingUnselected.id);
        return {
          ...postItem,
          text: matchingUnselected.text,
          originalDetectionId: matchingUnselected.id,
          verificationStatus: 'UNSELECTED_REMAINING',
        };
      }

      return {
        ...postItem,
        originalDetectionId: null,
        verificationStatus: 'NEWLY_DETECTED_OR_REMAINING',
      };
    });

    // Also check if any unselected items from before redaction remain in the text (exact or compact OCR match)
    let fallbackVerCounter = postDetection.items.length + 1;
    for (const unsel of unselectedItems) {
      if (usedOriginalUnselectedIds.has(unsel.id)) continue;
      const rawTarget = (unsel.text || '').trim().toLowerCase();
      const compactTarget = rawTarget.replace(/[\s-]+/g, '');
      const presentExact = rawTarget.length > 0 && combinedAfterText.includes(rawTarget);
      const presentCompact = compactTarget.length >= 6 && compactAfterText.includes(compactTarget);

      if (presentExact || presentCompact) {
        const alreadyListed = remainingItems.some(
          (r) => r.text.trim().toLowerCase() === rawTarget && r.pageNumber === unsel.pageNumber
        );
        if (!alreadyListed) {
          remainingItems.push({
            ...unsel,
            id: `ver_det_${fallbackVerCounter++}`,
            originalDetectionId: unsel.id,
            verificationStatus: 'UNSELECTED_REMAINING',
            detectionStatus: 'Unselected item still detectable in exported document',
          });
        }
      }
    }
  }

  const ocrMethodsUsed = ['pdf-text-reextraction'];
  if (runOcrCheck || extraction?.usedOcrFallback) {
    ocrMethodsUsed.push('tesseract-ocr-scan');
  }

  let ocrStatus = 'PASSED';
  let ocrSummary = `All ${removedItems.length} selected item(s) verified removed via ${ocrMethodsUsed.join(
    ' + '
  )}.`;
  if (ocrError) {
    ocrStatus = 'INDETERMINATE';
    ocrSummary = `OCR/text verification could not complete: ${ocrError.message || 'Unknown OCR error'}`;
  } else if (selectedStillDetectable.length > 0) {
    ocrStatus = 'FAILED';
    ocrSummary = `${selectedStillDetectable.length} selected item(s) remained detectable after redaction.`;
  }

  const ocrVerification = {
    verified: ocrStatus === 'PASSED',
    status: ocrStatus,
    runOcrCheck: Boolean(runOcrCheck),
    methodsUsed: ocrMethodsUsed,
    selectedItemsCount: selectedItems.length,
    successfullyRemovedCount: removedItems.length,
    selectedStillDetectableCount: selectedStillDetectable.length,
    remainingUnselectedDetectableCount: remainingItems.length,
    summary: ocrSummary,
    ...(ocrError ? { error: ocrError.message || String(ocrError) } : {}),
  };

  // Run independent post-redaction structural verification on the exported PDF
  const structuralVerification = await verifyExportedPdfStructure(
    redactedFilePath,
    originalStructuralAudit,
    options
  );

  const methodsUsed = [...ocrMethodsUsed, 'pdf-structural-sanitization-verification'];

  // Compute overall verification status: never report PASSED if either OCR or structural verification failed or is indeterminate
  let overallStatus = 'PASSED';
  if (ocrVerification.status === 'FAILED' || structuralVerification.status === 'FAILED') {
    overallStatus = 'FAILED';
  } else if (
    ocrVerification.status === 'INDETERMINATE' ||
    structuralVerification.status === 'INDETERMINATE'
  ) {
    overallStatus = 'INDETERMINATE';
  }
  const overallVerified = overallStatus === 'PASSED';

  return {
    verified: overallVerified,
    status: overallStatus,
    methodsUsed,
    selectedItemsCount: selectedItems.length,
    successfullyRemovedCount: removedItems.length,
    selectedStillDetectableCount: selectedStillDetectable.length,
    remainingUnselectedDetectableCount: remainingItems.length,
    removedItems,
    selectedStillDetectable,
    remainingItems,
    ocrVerification,
    structuralVerification,
    postExtractionSummary: {
      pageCount: extraction?.pageCount ?? 0,
      extractionMethod: extraction?.extractionMethod ?? 'indeterminate',
      totalCharactersExtracted: extraction?.totalCharacters ?? 0,
    },
    verificationDisclaimer:
      'Verification independently checks both rendered visual content via optical character recognition (OCR) and hidden PDF structures (metadata, XMP, attachments, AcroForm/annotations, incremental revisions, and text layers). While verified removal confirms that automated tools no longer detect the masked strings or hidden structures, users should always visually inspect the exported PDF before sharing.',
  };
}
