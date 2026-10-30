import fs from 'fs/promises';
import zlib from 'zlib';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { createWorker } from 'tesseract.js';
import { buildStructuralAudit } from '../detection/index.js';

/**
 * Custom CanvasFactory required by pdfjs-dist in Node.js environments
 * to render PDF pages onto @napi-rs/canvas instances.
 */
class NodeCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(Math.ceil(width), Math.ceil(height));
    const context = canvas.getContext('2d');
    return {
      canvas,
      context,
    };
  }

  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width = Math.ceil(width);
    canvasAndContext.canvas.height = Math.ceil(height);
  }

  destroy(canvasAndContext) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

/**
 * Render a single PDF.js page to a PNG Buffer and canvas at the specified scale.
 */
export async function renderPageToCanvas(page, scale = 2.0) {
  const viewport = page.getViewport({ scale });
  const canvasFactory = new NodeCanvasFactory();
  const { canvas, context } = canvasFactory.create(viewport.width, viewport.height);

  // Fill white background for clean rendering and OCR
  context.fillStyle = '#FFFFFF';
  context.fillRect(0, 0, viewport.width, viewport.height);

  await page.render({
    canvasContext: context,
    viewport,
    canvasFactory,
  }).promise;

  return {
    canvas,
    context,
    viewport,
    scale,
  };
}

const RASTER_IMAGE_OPERATORS = new Set(
  [
    pdfjsLib.OPS?.paintImageXObject,
    pdfjsLib.OPS?.paintInlineImageXObject,
    pdfjsLib.OPS?.paintInlineImageXObjectGroup,
    pdfjsLib.OPS?.paintImageXObjectRepeat,
    pdfjsLib.OPS?.paintImageMaskXObject,
    pdfjsLib.OPS?.paintImageMaskXObjectGroup,
    pdfjsLib.OPS?.paintImageMaskXObjectRepeat,
    pdfjsLib.OPS?.beginInlineImage,
  ].filter((op) => typeof op === 'number')
);

/**
 * Inspect a PDF.js page's operator list to determine whether the page paints
 * any embedded or inline raster images.
 */
async function detectEmbeddedImagesOnPage(page) {
  const opList = await page.getOperatorList();
  const fnArray = opList?.fnArray || [];
  let imageOperatorCount = 0;

  for (let i = 0; i < fnArray.length; i++) {
    if (RASTER_IMAGE_OPERATORS.has(fnArray[i])) {
      imageOperatorCount++;
    }
  }

  return {
    hasEmbeddedImages: imageOperatorCount > 0,
    imageOperatorCount,
  };
}

/**
 * Normalize text for token comparison between selectable PDF text and OCR output.
 */
function normalizeComparableText(str) {
  return (str || '').replace(/^[,.;:()[\]"']+|[,.;:()[\]"']+$/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Determine whether an OCR element (`ocr` word or `ocr-line`) spatially overlaps
 * with an existing selectable `pdf-text` element on the same page that already contains
 * the same text content.
 *
 * Why spatial + textual comparison?
 * - If we only checked text equality across the page, a legitimate duplicate value inside an
 *   embedded image elsewhere on the page would be falsely suppressed.
 * - By requiring both vertical/horizontal bounding-box proximity AND textual containment at that
 *   location, OCR re-reads of selectable PDF text are suppressed while embedded-image text at
 *   a different page location is preserved in full.
 */
function isOcrElementDuplicatingPdfText(ocrEl, pdfTextElements) {
  const ocrNorm = normalizeComparableText(ocrEl.text);
  if (!ocrNorm) return true;

  const ocrLeft = ocrEl.x;
  const ocrRight = ocrEl.x + ocrEl.width;
  const ocrCenterY = ocrEl.y + ocrEl.height / 2;

  for (const pdfEl of pdfTextElements) {
    const pdfCenterY = pdfEl.y + pdfEl.height / 2;
    const verticalTolerance = Math.max(ocrEl.height, pdfEl.height, 14) * 0.85;
    if (Math.abs(ocrCenterY - pdfCenterY) > verticalTolerance) {
      continue;
    }

    const pdfLeft = pdfEl.x - 8;
    const pdfRight = pdfEl.x + pdfEl.width + 8;
    const horizOverlap = Math.min(ocrRight, pdfRight) - Math.max(ocrLeft, pdfLeft);
    if (horizOverlap <= 0) {
      continue;
    }

    const pdfNorm = normalizeComparableText(pdfEl.text);
    if (!pdfNorm) continue;

    if (pdfNorm.includes(ocrNorm) || ocrNorm.includes(pdfNorm)) {
      return true;
    }

    // For multi-word OCR lines overlapping a pdf-text line at the same coordinates,
    // check whether the majority of OCR words are already present in that overlapping pdf-text element.
    const ocrTokens = ocrNorm.split(/\s+/).filter((t) => t.length >= 2);
    if (ocrTokens.length >= 2) {
      const matchedCount = ocrTokens.filter((tok) => pdfNorm.includes(tok)).length;
      if (matchedCount >= Math.ceil(ocrTokens.length * 0.7)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Extract word-level and line-level OCR elements from Tesseract.js v7 blocks hierarchy,
 * converting pixel bounding boxes into 1.0x PDF point coordinates.
 */
function extractOcrElementsFromData(ocrData, ocrScale) {
  const ocrElements = [];
  const blocks = ocrData?.blocks || [];
  if (blocks.length > 0 && !Array.isArray(blocks[0]?.paragraphs)) {
    const err = new Error('OCR engine returned an incompatible blocks structure (missing paragraphs array).');
    err.code = 'OCR_BLOCKS_INCOMPATIBLE';
    err.statusCode = 500;
    throw err;
  }

  for (const block of blocks) {
    const paragraphs = block?.paragraphs || [];
    for (const para of paragraphs) {
      const lines = para?.lines || [];
      for (const ln of lines) {
        // First collect all word-level bounding boxes in this line
        const words = ln?.words || [];
        for (const w of words) {
          const wordText = (w?.text || '').trim();
          if (!wordText || !w?.bbox) continue;

          const x = w.bbox.x0 / ocrScale;
          const y = w.bbox.y0 / ocrScale;
          const width = (w.bbox.x1 - w.bbox.x0) / ocrScale;
          const height = (w.bbox.y1 - w.bbox.y0) / ocrScale;

          ocrElements.push({
            text: wordText,
            x: Number(x.toFixed(2)),
            y: Number(y.toFixed(2)),
            width: Number(Math.max(width, 4).toFixed(2)),
            height: Number(Math.max(height, 8).toFixed(2)),
            source: 'ocr',
          });
        }

        // Also store the line-level bounding box
        const lineText = (ln?.text || '').trim();
        if (lineText && ln?.bbox) {
          const x = ln.bbox.x0 / ocrScale;
          const y = ln.bbox.y0 / ocrScale;
          const width = (ln.bbox.x1 - ln.bbox.x0) / ocrScale;
          const height = (ln.bbox.y1 - ln.bbox.y0) / ocrScale;

          ocrElements.push({
            text: lineText,
            x: Number(x.toFixed(2)),
            y: Number(y.toFixed(2)),
            width: Number(Math.max(width, 10).toFixed(2)),
            height: Number(Math.max(height, 10).toFixed(2)),
            source: 'ocr-line',
          });
        }
      }
    }
  }

  return ocrElements;
}

/**
 * Convert a PDF bottom-left annotation rectangle `[x1, y1, x2, y2]` into a validated
 * 1.0x top-left PDF point bounding box `{ x, y, width, height }` using `viewport.convertToViewportPoint`.
 *
 * Returns `null` if the annotation lacks a finite, positive-area rectangle within the visible page viewport.
 */
function convertAndValidateAnnotationRect(rect, viewport) {
  if (!Array.isArray(rect) || rect.length !== 4) return null;
  const nums = rect.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;

  const [p1x, p1y] = viewport.convertToViewportPoint(nums[0], nums[1]);
  const [p2x, p2y] = viewport.convertToViewportPoint(nums[2], nums[3]);

  const rawX = Math.min(p1x, p2x);
  const rawY = Math.min(p1y, p2y);
  const rawMaxX = Math.max(p1x, p2x);
  const rawMaxY = Math.max(p1y, p2y);
  const rawW = rawMaxX - rawX;
  const rawH = rawMaxY - rawY;

  if (rawW < 2 || rawH < 2) return null;

  const pageWidth = viewport.width;
  const pageHeight = viewport.height;

  // Reject rectangles that lie completely outside the visible page bounds
  if (rawMaxX <= 0 || rawMaxY <= 0 || rawX >= pageWidth || rawY >= pageHeight) {
    return null;
  }

  const clampedX = Math.max(0, rawX);
  const clampedY = Math.max(0, rawY);
  const clampedW = Math.min(pageWidth - clampedX, rawMaxX - clampedX);
  const clampedH = Math.min(pageHeight - clampedY, rawMaxY - clampedY);

  if (clampedW < 2 || clampedH < 2) return null;

  return {
    x: Number(clampedX.toFixed(2)),
    y: Number(clampedY.toFixed(2)),
    width: Number(clampedW.toFixed(2)),
    height: Number(clampedH.toFixed(2)),
  };
}

/**
 * Extract human-readable text strings from a PDF.js annotation or AcroForm widget.
 */
function extractTextFromAnnotationObject(ann) {
  const parts = [];

  if (ann.subtype === 'Widget') {
    const rawVal = ann.fieldValue ?? ann.defaultFieldValue;
    if (Array.isArray(rawVal)) {
      parts.push(rawVal.filter(Boolean).map(String).join(' '));
    } else if (typeof rawVal === 'string' && rawVal.trim()) {
      parts.push(rawVal.trim());
    } else if (typeof rawVal === 'number') {
      parts.push(String(rawVal));
    }
  }

  if (Array.isArray(ann.textContent) && ann.textContent.length > 0) {
    const joinedTextContent = ann.textContent.map((s) => (s || '').trim()).filter(Boolean).join(' ');
    if (joinedTextContent) {
      parts.push(joinedTextContent);
    }
  }

  if (typeof ann.contentsObj?.str === 'string' && ann.contentsObj.str.trim()) {
    parts.push(ann.contentsObj.str.trim());
  } else if (typeof ann.contents === 'string' && ann.contents.trim()) {
    parts.push(ann.contents.trim());
  }

  // Deduplicate identical strings (e.g. when both fieldValue and textContent hold "ABCDE1234F")
  const unique = [];
  const seen = new Set();
  for (const p of parts) {
    const norm = p.replace(/\s+/g, ' ').trim();
    const lower = norm.toLowerCase();
    if (norm && !seen.has(lower)) {
      seen.add(lower);
      unique.push(norm);
    }
  }

  return unique.join(' ');
}

/**
 * Inspect `page.getAnnotations()` on a PDF.js page to:
 * 1. Extract visible AcroForm widgets (`Tx`, `Ch`) and visual text annotations (`FreeText`, custom appearance streams)
 *    with validated page bounding boxes (`source: 'pdf-annotation'`).
 * 2. Record non-visual / unlocatable annotations (`Text` sticky notes, `Popup`, zero-area/off-page rects, or
 *    `FreeText` without appearance streams) so any sensitive text inside them is never given a fabricated box
 *    and is surfaced with an explicit warning.
 * 3. Record `Link` / URI annotations as structural metadata rather than visible page text.
 */
async function extractPageAnnotations(page, viewport, pageNum) {
  let rawAnnotations = [];
  try {
    rawAnnotations = (await page.getAnnotations()) || [];
  } catch {
    return {
      visualAnnotationElements: [],
      visualAnnotationTexts: [],
      unlocatableAnnotationTexts: [],
      unsupportedAnnotations: [],
      linkAnnotations: [],
      fileAttachmentAnnotations: [],
    };
  }

  const visualAnnotationElements = [];
  const visualAnnotationTexts = [];
  const unlocatableAnnotationTexts = [];
  const unsupportedAnnotations = [];
  const linkAnnotations = [];
  const fileAttachmentAnnotations = [];

  for (const ann of rawAnnotations) {
    const subtype = ann?.subtype || 'Unknown';
    const annotFlags = Number(ann?.annotationFlags || 0);
    // PDF 32000-1 Table 165: bit 1 (value 1) = Invisible, bit 2 (value 2) = Hidden, bit 6 (value 32) = NoView
    const isHiddenByFlags = Boolean(ann?.hidden) || (annotFlags & 1) !== 0 || (annotFlags & 2) !== 0 || (annotFlags & 32) !== 0;

    // 1. Structural Link / URI annotations: record structurally, never treat as visible text requiring a black rectangle
    if (subtype === 'Link') {
      const targetUrl = ann.url || ann.unsafeUrl || null;
      if (targetUrl) {
        linkAnnotations.push({
          id: ann.id || null,
          pageNumber: pageNum,
          subtype: 'Link',
          url: targetUrl,
          rect: Array.isArray(ann.rect) ? ann.rect : null,
        });
      }
      continue;
    }

    // 2. Page-level FileAttachment annotations: record in structuralAudit.attachments without adding uninspected
    //    attachment contents or attachment metadata to normal page-coordinate detections.
    if (subtype === 'FileAttachment') {
      const fileObj = ann.file || {};
      const filename =
        fileObj.filename ||
        fileObj.rawFilename ||
        ann.titleObj?.str ||
        'page_file_attachment';
      const rawFilename = fileObj.rawFilename || fileObj.filename || null;
      const description = fileObj.description || ann.contentsObj?.str || ann.contents || '';
      const contentByteLength =
        fileObj.content && typeof fileObj.content.byteLength === 'number'
          ? fileObj.content.byteLength
          : null;

      fileAttachmentAnnotations.push({
        id: ann.id ? `page_att_${pageNum}_${ann.id}` : `page_att_${pageNum}_${fileAttachmentAnnotations.length + 1}`,
        pageNumber: pageNum,
        source: 'page-file-attachment',
        subtype: 'FileAttachment',
        filename,
        rawFilename,
        description,
        annotationContents: ann.contentsObj?.str || ann.contents || '',
        contentByteLength,
        rect: Array.isArray(ann.rect) ? ann.rect : null,
        contentInspected: false,
        inspectionStatus: 'UNINSPECTED_ATTACHMENT_CONTENT',
      });
      continue;
    }

    const extractedText = extractTextFromAnnotationObject(ann);
    if (!extractedText) continue;

    // Ignore purely boolean/off checkbox states ('Off') on non-text button widgets
    if (subtype === 'Widget' && ann.fieldType === 'Btn' && extractedText.toLowerCase() === 'off') {
      continue;
    }

    const validatedBox = convertAndValidateAnnotationRect(ann.rect, viewport);

    // Determine whether PDF.js `page.render()` actually renders this annotation visually on the page canvas
    const isSupportedFormWidget =
      subtype === 'Widget' &&
      (ann.fieldType === 'Tx' || ann.fieldType === 'Ch' || Boolean(ann.fieldValue) || Boolean(ann.defaultFieldValue));
    const isVisualFreeText = subtype === 'FreeText' && Boolean(ann.hasAppearance);
    const isOtherVisualAppearance =
      subtype !== 'Text' &&
      subtype !== 'Popup' &&
      Boolean(ann.hasAppearance) &&
      Array.isArray(ann.textContent) &&
      ann.textContent.length > 0;

    const isVisuallyRendered = !isHiddenByFlags && (isSupportedFormWidget || isVisualFreeText || isOtherVisualAppearance);

    if (isVisuallyRendered && validatedBox) {
      visualAnnotationElements.push({
        text: extractedText,
        x: validatedBox.x,
        y: validatedBox.y,
        width: validatedBox.width,
        height: validatedBox.height,
        source: 'pdf-annotation',
        annotationSubtype: subtype,
        fieldType: ann.fieldType || null,
        fieldName: ann.fieldName || null,
        fullRectCover: true,
      });
      visualAnnotationTexts.push(extractedText);
    } else {
      // Do NOT invent a bounding box for non-visual sticky notes, hidden annotations, FreeText without /AP,
      // or annotations with missing/zero-area/off-page rectangles.
      let reason = `Annotation of subtype "${subtype}" does not have a visually rendered appearance stream or reliable page coordinates.`;
      if (!validatedBox) {
        reason = `Annotation of subtype "${subtype}" has missing, zero-area, or off-page rectangle coordinates (${JSON.stringify(ann.rect || null)}).`;
      } else if (isHiddenByFlags) {
        reason = `Annotation of subtype "${subtype}" is marked hidden/invisible by PDF annotation flags.`;
      } else if (subtype === 'Text' || subtype === 'Popup') {
        reason = `Sticky-note / popup annotation ("${subtype}") stores text in metadata popups rather than a reliable on-page text bounding box.`;
      } else if (subtype === 'FreeText' && !ann.hasAppearance) {
        reason = `FreeText annotation lacks an embedded normal appearance stream (/AP /N) and is not rendered onto the page canvas by PDF.js.`;
      }

      unlocatableAnnotationTexts.push(extractedText);
      unsupportedAnnotations.push({
        id: ann.id || null,
        pageNumber: pageNum,
        subtype,
        fieldType: ann.fieldType || null,
        fieldName: ann.fieldName || null,
        hasAppearance: Boolean(ann.hasAppearance),
        hasValidRect: Boolean(validatedBox),
        status: 'UNSUPPORTED_ANNOTATION_COORDINATES',
        reason,
      });
    }
  }

  return {
    visualAnnotationElements,
    visualAnnotationTexts,
    unlocatableAnnotationTexts,
    unsupportedAnnotations,
    linkAnnotations,
    fileAttachmentAnnotations,
  };
}

/**
 * Replace binary content inside `stream ... endstream` blocks with spaces of the exact same byte length
 * so all byte offsets (`startxref`, `/Prev`, `xref`, object offsets) remain 100% identical while preventing
 * compressed stream bytes from producing false structural token matches.
 */
function maskBinaryStreamsPreservingOffsets(rawPdfLatin1) {
  return rawPdfLatin1.replace(/(stream(?:\r\n|\n|\r))([\s\S]*?)((?:\r\n|\n|\r)?endstream)/g, (_m, p1, body, p3) => {
    return p1 + ' '.repeat(body.length) + p3;
  });
}

/**
 * Decode a PDF hexadecimal string `<...>` (supporting both ASCII/WinAnsi and UTF-16BE with BOM `FEFF`).
 */
function decodePdfHexString(hexContent) {
  const cleanHex = String(hexContent || '').replace(/\s+/g, '');
  if (cleanHex.length < 4) return '';
  const paddedHex = cleanHex.length % 2 === 1 ? `${cleanHex}0` : cleanHex;
  if (!/^[0-9A-Fa-f]+$/.test(paddedHex)) return '';

  const buf = Buffer.from(paddedHex, 'hex');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16BE with BOM
    const payload = Buffer.alloc(buf.length - 2);
    for (let i = 2; i + 1 < buf.length; i += 2) {
      payload[i - 2] = buf[i + 1];
      payload[i - 1] = buf[i];
    }
    return payload.toString('utf16le').replace(/\0/g, '').trim();
  }

  let out = '';
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if ((b >= 32 && b <= 126) || b === 9 || b === 10 || b === 13) {
      out += String.fromCharCode(b);
    } else if (b === 0) {
      continue;
    } else {
      out += ' ';
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Decode a PDF literal string `(...)` with standard escape sequences.
 */
function decodePdfLiteralString(litContent) {
  return String(litContent || '')
    .replace(/\\(\d{1,3})/g, (_m, oct) => String.fromCharCode(parseInt(oct, 8)))
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
    .replace(/\0/g, '')
    .trim();
}

/**
 * Safely extract human-readable text and attribute values from raw XMP XML metadata
 * without using an external XML parser or expanding external entities.
 */
function sanitizeXmpXmlToText(rawXmp) {
  if (!rawXmp || typeof rawXmp !== 'string') return '';
  const boundedXmp = rawXmp.slice(0, 262144);

  const decodeEntities = (s) =>
    s
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');

  // Collect attribute values inside RDF descriptions (excluding xmlns/rdf:about/xmpmeta boilerplate URIs)
  const attrValues = [];
  const attrRegex = /\b([A-Za-z0-9_]+:[A-Za-z0-9_-]+)\s*=\s*"([^"]+)"/g;
  let attrMatch;
  while ((attrMatch = attrRegex.exec(boundedXmp)) !== null) {
    const attrName = attrMatch[1];
    const attrVal = attrMatch[2];
    if (
      attrName.startsWith('xmlns:') ||
      attrName === 'rdf:about' ||
      attrName === 'x:xmptk' ||
      /^https?:\/\/ns\.adobe\.com|^http:\/\/www\.w3\.org|^http:\/\/purl\.org/i.test(attrVal)
    ) {
      continue;
    }
    attrValues.push(decodeEntities(attrVal));
  }

  // Strip processing instructions, comments, and XML tags to extract text nodes
  const tagStripped = decodeEntities(
    boundedXmp
      .replace(/<\?[\s\S]*?\?>/g, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();

  return [tagStripped, ...attrValues].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Extract readable text strings (both literal `(...)` and hex `<...>`) from a raw PDF byte segment,
 * including inflating any `/FlateDecode` streams inside that segment.
 */
function extractReadableStringsFromPdfSegment(segmentLatin1) {
  if (!segmentLatin1) return '';
  const collected = [];

  const collectFromContentString = (str) => {
    const litRegex = /\(([^()\\]*(?:\\.[^()\\]*)*)\)/g;
    let m;
    while ((m = litRegex.exec(str)) !== null) {
      const dec = decodePdfLiteralString(m[1]);
      if (dec.length >= 4) collected.push(dec);
    }

    const hexRegex = /<([0-9A-Fa-f\s]{8,})>/g;
    while ((m = hexRegex.exec(str)) !== null) {
      const dec = decodePdfHexString(m[1]);
      if (dec.length >= 4) collected.push(dec);
    }
  };

  // 1. Scan non-stream object dictionaries and uncompressed content in the segment
  const nonStream = maskBinaryStreamsPreservingOffsets(segmentLatin1);
  collectFromContentString(nonStream);

  // 2. Inflate any FlateDecode streams in the segment and extract text literals / hex strings
  const streamRegex = /<<([\s\S]{0,400}?)>>\s*stream(?:\r\n|\n|\r)([\s\S]*?)(?:\r\n|\n|\r)?endstream/g;
  let sm;
  while ((sm = streamRegex.exec(segmentLatin1)) !== null) {
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
        collectFromContentString(inflated);
      } catch {
        // Ignore streams that cannot be inflated
      }
    } else {
      collectFromContentString(streamBodyLatin1);
    }
  }

  return collected.join('\n');
}

/**
 * Inspect PDF document metadata (`/Info` standard & custom fields + XMP metadata stream).
 */
async function inspectPdfMetadataStructure(pdfDoc, rawPdfLatin1) {
  let pdfjsMeta = null;
  try {
    pdfjsMeta = await pdfDoc.getMetadata();
  } catch {
    pdfjsMeta = null;
  }

  const info = pdfjsMeta?.info || {};
  const standardKeys = [
    'Title',
    'Author',
    'Subject',
    'Keywords',
    'Creator',
    'Producer',
    'CreationDate',
    'ModDate',
  ];

  const standardFields = {};
  const populatedFieldNames = [];
  let hasInfoDictionary = false;

  for (const key of standardKeys) {
    const val = typeof info[key] === 'string' && info[key].trim() ? info[key].trim() : null;
    standardFields[key] = val;
    if (val) {
      hasInfoDictionary = true;
      populatedFieldNames.push(key);
    }
  }

  const customFields = {};
  if (info.Custom) {
    const entries =
      info.Custom instanceof Map
        ? Array.from(info.Custom.entries())
        : typeof info.Custom === 'object'
        ? Object.entries(info.Custom)
        : [];
    for (const [k, v] of entries) {
      if (v !== undefined && v !== null && String(v).trim()) {
        customFields[String(k)] = String(v).trim();
        hasInfoDictionary = true;
        populatedFieldNames.push(`Custom:${k}`);
      }
    }
  }

  let rawXmp = null;
  try {
    if (pdfjsMeta?.metadata && typeof pdfjsMeta.metadata.getRaw === 'function') {
      rawXmp = pdfjsMeta.metadata.getRaw();
    }
  } catch {
    rawXmp = null;
  }

  // Fallback check if raw XMP packet exists in the file stream but was not parsed by pdfjs-dist
  if (!rawXmp && rawPdfLatin1) {
    const xmpMatch = /<x:xmpmeta[\s\S]{1,262144}?<\/x:xmpmeta>/i.exec(rawPdfLatin1);
    if (xmpMatch) {
      rawXmp = xmpMatch[0];
    }
  }

  const hasXmpMetadata = Boolean(rawXmp && rawXmp.trim());
  const xmpText = hasXmpMetadata ? sanitizeXmpXmlToText(rawXmp) : '';
  if (hasXmpMetadata) {
    populatedFieldNames.push('XMP');
  }

  return {
    metaInfo: info,
    hasInfoDictionary,
    hasXmpMetadata,
    xmpLength: rawXmp ? rawXmp.length : 0,
    xmpText,
    standardFields,
    customFields,
    populatedFieldNames,
  };
}

/**
 * Inspect embedded attachments across:
 * 1. Catalog `/Names -> /EmbeddedFiles` via `pdfDoc.getAttachments()` (supporting both Map and Object).
 * 2. Page-level `FileAttachment` annotations collected from `page.getAnnotations()`.
 * 3. Catalog `/AF` (Associated Files), `/Collection` (PDF Portfolio), and raw `/Filespec` dictionaries.
 */
async function inspectPdfAttachmentStructure(pdfDoc, pageFileAttachments, metaInfo, nonStreamPdfLatin1) {
  const items = [];
  const seenKeys = new Set();

  // 1. Inspect Catalog /Names -> /EmbeddedFiles via PDF.js getAttachments()
  try {
    const rawAttachments = await pdfDoc.getAttachments();
    if (rawAttachments) {
      const entries =
        rawAttachments instanceof Map
          ? Array.from(rawAttachments.entries())
          : typeof rawAttachments === 'object'
          ? Object.entries(rawAttachments)
          : [];

      for (const [attKey, attVal] of entries) {
        if (!attVal) continue;
        const filename = attVal.filename || attVal.rawFilename || String(attKey) || 'embedded_attachment';
        const rawFilename = attVal.rawFilename || attVal.filename || String(attKey) || null;
        const description = attVal.description || '';
        const contentByteLength =
          attVal.content && typeof attVal.content.byteLength === 'number'
            ? attVal.content.byteLength
            : null;

        const dedupKey = `catalog:${filename.toLowerCase()}`;
        seenKeys.add(dedupKey);

        items.push({
          id: `att_catalog_${items.length + 1}`,
          filename,
          rawFilename,
          description,
          source: 'catalog-embedded-files',
          pageNumber: null,
          contentByteLength,
          contentInspected: false,
          inspectionStatus: 'UNINSPECTED_ATTACHMENT_CONTENT',
        });
      }
    }
  } catch {
    // Continue with page annotations and raw catalog fallback
  }

  // 2. Include page-level FileAttachment annotations
  for (const pageAtt of pageFileAttachments || []) {
    items.push({
      ...pageAtt,
      id: pageAtt.id || `att_page_${items.length + 1}`,
    });
    if (pageAtt.filename) {
      seenKeys.add(`page:${pageAtt.filename.toLowerCase()}`);
    }
  }

  // 3. Fallback inspection of raw `/Filespec` dictionaries in case an attachment is referenced only via `/AF`
  const filespecRegex = /<<[^>]*?\/Type\s*\/Filespec\b([\s\S]{0,600}?)>>/g;
  let fsMatch;
  while ((fsMatch = filespecRegex.exec(nonStreamPdfLatin1)) !== null) {
    const dictBody = fsMatch[1] || '';
    let filename = '';
    const ufHex = /\/UF\s*<([0-9A-Fa-f\s]+)>/.exec(dictBody);
    const ufLit = /\/UF\s*\(([^()\\]*(?:\\.[^()\\]*)*)\)/.exec(dictBody);
    const fLit = /\/F\s*\(([^()\\]*(?:\\.[^()\\]*)*)\)/.exec(dictBody);
    const fHex = /\/F\s*<([0-9A-Fa-f\s]+)>/.exec(dictBody);

    if (ufHex) filename = decodePdfHexString(ufHex[1]);
    else if (ufLit) filename = decodePdfLiteralString(ufLit[1]);
    else if (fLit) filename = decodePdfLiteralString(fLit[1]);
    else if (fHex) filename = decodePdfHexString(fHex[1]);

    if (!filename) continue;
    const lowerName = filename.toLowerCase();
    if (seenKeys.has(`catalog:${lowerName}`) || seenKeys.has(`page:${lowerName}`) || seenKeys.has(`filespec:${lowerName}`)) {
      continue;
    }
    seenKeys.add(`filespec:${lowerName}`);

    let description = '';
    const descHex = /\/Desc\s*<([0-9A-Fa-f\s]+)>/.exec(dictBody);
    const descLit = /\/Desc\s*\(([^()\\]*(?:\\.[^()\\]*)*)\)/.exec(dictBody);
    if (descHex) description = decodePdfHexString(descHex[1]);
    else if (descLit) description = decodePdfLiteralString(descLit[1]);

    items.push({
      id: `att_filespec_${items.length + 1}`,
      filename,
      rawFilename: filename,
      description,
      source: 'associated-file-or-filespec',
      pageNumber: null,
      contentByteLength: null,
      contentInspected: false,
      inspectionStatus: 'UNINSPECTED_ATTACHMENT_CONTENT',
    });
  }

  const isPortfolioCollection =
    Boolean(metaInfo?.IsCollectionPresent) ||
    /\/Type\s*\/Catalog\b[\s\S]{0,600}?\/Collection\b/.test(nonStreamPdfLatin1);
  const hasAssociatedFiles = /\/AF\s*(?:\[|\d+\s+\d+\s+R\b)/.test(nonStreamPdfLatin1);

  return {
    isPortfolioCollection,
    hasAssociatedFiles,
    items,
  };
}

/**
 * Inspect raw PDF structure for incremental save revisions, `/Prev` trailer chains, `startxref` markers,
 * cross-reference tables/streams, linearized PDF structures, and malformed revision anomalies.
 */
function inspectPdfRevisionStructure(dataBuffer, rawPdfLatin1, nonStreamPdfLatin1, metaInfo) {
  const fileSize = dataBuffer.length;
  const headerSlice = nonStreamPdfLatin1.slice(0, Math.min(fileSize, 4096));

  // 1. Detect Linearized PDF dictionary near the beginning of the file
  const hasLinearizedDict = /<<[\s\S]{0,500}?\/Linearized\s+\d/.test(headerSlice);
  const isLinearized = Boolean(metaInfo?.IsLinearized) || hasLinearizedDict;
  let linearizedDeclaredLength = null;
  if (hasLinearizedDict) {
    const lenMatch = /\/Linearized\s+\d[\s\S]{0,300}?\/L\s+(\d+)/.exec(headerSlice);
    if (lenMatch) {
      linearizedDeclaredLength = Number(lenMatch[1]);
    }
  }

  // 2. Locate all `xref` tables and `/Type /XRef` cross-reference stream objects
  const xrefTableOffsets = [];
  const xrefTableRegex = /(?:^|[\r\n])\s*(xref)\s*[\r\n]/g;
  let xm;
  while ((xm = xrefTableRegex.exec(nonStreamPdfLatin1)) !== null) {
    const kwOffset = xm.index + xm[0].indexOf('xref');
    xrefTableOffsets.push(kwOffset);
  }

  const xrefStreamOffsets = [];
  const xrefStreamRegex = /(\d+\s+\d+\s+obj)\b[\s\S]{0,320}?\/Type\s*\/XRef\b/g;
  while ((xm = xrefStreamRegex.exec(nonStreamPdfLatin1)) !== null) {
    xrefStreamOffsets.push(xm.index);
  }

  const totalXrefSectionCount = xrefTableOffsets.length + xrefStreamOffsets.length;

  // 3. Locate all `%%EOF` markers (informational telemetry; never used alone as proof)
  const eofOffsets = [];
  const eofRegex = /%%EOF/g;
  while ((xm = eofRegex.exec(nonStreamPdfLatin1)) !== null) {
    eofOffsets.push(xm.index + xm[0].length);
  }

  // 4. Locate and validate all `startxref` tokens
  const startxrefAllTokens = [];
  const startxrefRegex = /\bstartxref(?:\s+([^\s%]+))?/g;
  while ((xm = startxrefRegex.exec(nonStreamPdfLatin1)) !== null) {
    const rawToken = xm[1] ?? '';
    const isInt = /^\d+$/.test(rawToken);
    startxrefAllTokens.push({
      markerIndex: xm.index,
      rawToken,
      offset: isInt ? Number(rawToken) : null,
    });
  }

  // 5. Locate and validate all `/Prev` entries in trailers or XRef stream dictionaries
  const prevAllTokens = [];
  const prevRegex = /\/Prev\s+([^\s/>\]<]+)/g;
  while ((xm = prevRegex.exec(nonStreamPdfLatin1)) !== null) {
    const rawToken = xm[1] ?? '';
    const isInt = /^\d+$/.test(rawToken);
    prevAllTokens.push({
      markerIndex: xm.index,
      rawToken,
      offset: isInt ? Number(rawToken) : null,
    });
  }

  // Helper to verify whether a byte offset points to a genuine `xref` table or `/Type /XRef` stream object
  const isValidXrefTargetOffset = (offset, allowLinearizedZero = false) => {
    if (allowLinearizedZero && isLinearized && offset === 0) {
      return true;
    }
    if (!Number.isInteger(offset) || offset <= 0 || offset >= fileSize) {
      return false;
    }
    const probe = nonStreamPdfLatin1.slice(offset, Math.min(fileSize, offset + 350)).trimStart();
    if (/^xref\b/.test(probe)) {
      return true;
    }
    if (/^\d+\s+\d+\s+obj\b[\s\S]{0,280}?\/Type\s*\/XRef\b/.test(probe)) {
      return true;
    }
    return false;
  };

  // 6. Check for malformed / indeterminate revision structures
  const anomalyReasons = [];

  if (startxrefAllTokens.length === 0) {
    anomalyReasons.push('Missing "startxref" marker in PDF trailer structure.');
  }

  for (const sx of startxrefAllTokens) {
    if (sx.offset === null) {
      anomalyReasons.push(`Malformed non-integer startxref token "${sx.rawToken}".`);
    } else if (!isValidXrefTargetOffset(sx.offset, true)) {
      anomalyReasons.push(
        `startxref offset ${sx.offset} does not point to a valid xref table or /Type /XRef stream within the ${fileSize}-byte file.`
      );
    }
  }

  const seenPrevOffsets = new Set();
  for (const pv of prevAllTokens) {
    if (pv.offset === null) {
      anomalyReasons.push(`Malformed non-integer trailer /Prev token "${pv.rawToken}".`);
    } else if (!isValidXrefTargetOffset(pv.offset, false)) {
      anomalyReasons.push(
        `Trailer /Prev offset ${pv.offset} is out of bounds or does not point to a valid xref table or /Type /XRef stream.`
      );
    } else if (seenPrevOffsets.has(pv.offset)) {
      anomalyReasons.push(`Cyclic or duplicate trailer /Prev offset (${pv.offset}) detected.`);
    } else {
      seenPrevOffsets.add(pv.offset);
    }
  }

  if (!isLinearized && totalXrefSectionCount > 1 && prevAllTokens.length === 0 && startxrefAllTokens.length < totalXrefSectionCount) {
    anomalyReasons.push(
      `Found ${totalXrefSectionCount} cross-reference sections but missing matching startxref or trailer /Prev linkage.`
    );
  }

  if (anomalyReasons.length > 0) {
    return {
      status: 'INDETERMINATE',
      isLinearized,
      confidence: 'LOW_UNCERTAIN',
      revisionCount: null,
      startxrefCount: startxrefAllTokens.length,
      xrefSectionCount: totalXrefSectionCount,
      prevCount: prevAllTokens.length,
      eofCount: eofOffsets.length,
      reason: `Malformed or inconsistent PDF revision structure: ${anomalyReasons.join(' ')}`,
      earlierRevisionTexts: [],
    };
  }

  // 7. Distinguish legitimate Linearized PDFs from Incremental Updates
  if (isLinearized) {
    const lengthMatchesDeclared =
      linearizedDeclaredLength === null || Math.abs(fileSize - linearizedDeclaredLength) <= 64;
    const isStandardLinearizedLayout =
      startxrefAllTokens.length <= 2 &&
      totalXrefSectionCount <= 2 &&
      prevAllTokens.length <= 1 &&
      lengthMatchesDeclared;

    if (isStandardLinearizedLayout) {
      return {
        status: 'NOT_DETECTED',
        isLinearized: true,
        confidence: 'HIGH',
        revisionCount: 1,
        startxrefCount: startxrefAllTokens.length,
        xrefSectionCount: totalXrefSectionCount,
        prevCount: prevAllTokens.length,
        eofCount: eofOffsets.length,
        reason:
          'Linearized PDF structure detected (first-page cross-reference section + main cross-reference section with matching /L file length); no post-linearization incremental updates detected.',
        earlierRevisionTexts: [],
      };
    }

    // Linearized PDF with extra incremental revisions appended after linearization
    const boundaryOffset =
      linearizedDeclaredLength && linearizedDeclaredLength < fileSize
        ? linearizedDeclaredLength
        : eofOffsets.length >= 2
        ? eofOffsets[eofOffsets.length - 2]
        : Math.floor(fileSize * 0.75);

    const earlierText = extractReadableStringsFromPdfSegment(rawPdfLatin1.slice(0, boundaryOffset));
    return {
      status: 'DETECTED',
      isLinearized: true,
      confidence: 'HIGH',
      revisionCount: Math.max(2, startxrefAllTokens.length - 1),
      startxrefCount: startxrefAllTokens.length,
      xrefSectionCount: totalXrefSectionCount,
      prevCount: prevAllTokens.length,
      eofCount: eofOffsets.length,
      reason: `Linearized PDF has additional incremental revision(s) appended beyond the base linearized structure (${startxrefAllTokens.length} startxref markers, ${prevAllTokens.length} /Prev references).`,
      earlierRevisionTexts: earlierText ? [{ revisionNumber: 1, text: earlierText }] : [],
    };
  }

  // 8. Non-linearized PDF: check for incremental updates
  const hasIncrementalRevisions =
    prevAllTokens.length >= 1 || (startxrefAllTokens.length >= 2 && totalXrefSectionCount >= 2);

  if (hasIncrementalRevisions) {
    const revisionCount = Math.max(startxrefAllTokens.length, prevAllTokens.length + 1, 2);

    // Extract readable text from all earlier revision byte segments (before the final revision)
    const earlierRevisionTexts = [];
    if (eofOffsets.length >= 2) {
      let segStart = 0;
      for (let rIdx = 0; rIdx < eofOffsets.length - 1; rIdx++) {
        const segEnd = eofOffsets[rIdx];
        const segLatin1 = rawPdfLatin1.slice(segStart, segEnd);
        const extracted = extractReadableStringsFromPdfSegment(segLatin1);
        if (extracted) {
          earlierRevisionTexts.push({
            revisionNumber: rIdx + 1,
            text: extracted,
          });
        }
        segStart = segEnd;
      }
    } else if (startxrefAllTokens.length >= 1) {
      // Fallback: inspect up to the earliest /Prev xref table
      const earliestPrev = Math.min(...prevAllTokens.map((p) => p.offset));
      const segLatin1 = rawPdfLatin1.slice(0, earliestPrev);
      const extracted = extractReadableStringsFromPdfSegment(segLatin1);
      if (extracted) {
        earlierRevisionTexts.push({
          revisionNumber: 1,
          text: extracted,
        });
      }
    }

    return {
      status: 'DETECTED',
      isLinearized: false,
      confidence: 'HIGH',
      revisionCount,
      startxrefCount: startxrefAllTokens.length,
      xrefSectionCount: totalXrefSectionCount,
      prevCount: prevAllTokens.length,
      eofCount: eofOffsets.length,
      reason: `Detected ${revisionCount} PDF revisions linked via ${prevAllTokens.length} trailer /Prev reference(s) and ${startxrefAllTokens.length} startxref marker(s). Earlier revisions may retain historical or overwritten sensitive content.`,
      earlierRevisionTexts,
    };
  }

  return {
    status: 'NOT_DETECTED',
    isLinearized: false,
    confidence: 'HIGH',
    revisionCount: 1,
    startxrefCount: startxrefAllTokens.length,
    xrefSectionCount: totalXrefSectionCount,
    prevCount: prevAllTokens.length,
    eofCount: eofOffsets.length,
    reason: 'Single cross-reference generation with no trailer /Prev chain or incremental updates detected.',
    earlierRevisionTexts: [],
  };
}

/**
 * Perform complete P2.2 hidden-structure inspection (metadata, XMP, attachments, incremental revisions).
 */
async function inspectPdfHiddenStructures(pdfDoc, dataBuffer, pageFileAttachments) {
  const rawPdfLatin1 = dataBuffer.toString('latin1');
  const nonStreamPdfLatin1 = maskBinaryStreamsPreservingOffsets(rawPdfLatin1);

  const metadata = await inspectPdfMetadataStructure(pdfDoc, rawPdfLatin1);
  const attachments = await inspectPdfAttachmentStructure(
    pdfDoc,
    pageFileAttachments,
    metadata.metaInfo,
    nonStreamPdfLatin1
  );
  const revisions = inspectPdfRevisionStructure(
    dataBuffer,
    rawPdfLatin1,
    nonStreamPdfLatin1,
    metadata.metaInfo
  );

  return {
    metadata,
    attachments,
    revisions,
  };
}

/**
 * Extract embedded text and bounding-box items from a PDF file.
 * Automatically falls back to Tesseract.js OCR for any page that has little/no embedded text,
 * AND runs hybrid OCR inspection on pages that contain both selectable text and embedded raster images.
 * Also inspects AcroForm widgets, visual annotations, and hidden PDF structures (metadata, attachments, revisions).
 *
 * @param {string} filePath - Path to the PDF file on disk
 * @param {object} options - { forceOcr: boolean }
 */
export async function extractPdfContent(filePath, options = {}) {
  const { forceOcr = false } = options;

  let dataBuffer;
  try {
    dataBuffer = await fs.readFile(filePath);
  } catch {
    const err = new Error('Unable to read the uploaded PDF file.');
    err.code = 'FILE_READ_ERROR';
    err.statusCode = 400;
    throw err;
  }

  const uint8Array = new Uint8Array(dataBuffer);
  let pdfDoc;
  try {
    const loadingTask = pdfjsLib.getDocument({
      data: uint8Array,
      useSystemFonts: true,
      disableFontFace: true,
      verbosity: 0,
    });
    pdfDoc = await loadingTask.promise;
  } catch {
    const err = new Error('The uploaded PDF file appears to be corrupted or cannot be parsed.');
    err.code = 'CORRUPTED_PDF';
    err.statusCode = 400;
    throw err;
  }

  const numPages = pdfDoc.numPages;
  if (!numPages || numPages < 1) {
    const err = new Error('The PDF contains no pages.');
    err.code = 'EMPTY_PDF_PAGES';
    err.statusCode = 400;
    throw err;
  }

  const pages = [];
  const allUnsupportedAnnotations = [];
  const allLinkAnnotations = [];
  const allPageFileAttachments = [];
  let usedOcrFallback = false;
  let usedPdfText = false;
  let ocrWorker = null;
  let rawStructuralInspection = null;

  try {
    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1.0 });
      const pageWidth = viewport.width;
      const pageHeight = viewport.height;

      const textContent = await page.getTextContent();
      const rawItems = textContent.items || [];

      // Inspect PDF page operator list for embedded raster images
      const { hasEmbeddedImages, imageOperatorCount } = await detectEmbeddedImagesOnPage(page);

      // Inspect AcroForm widgets and page annotations
      const {
        visualAnnotationElements,
        visualAnnotationTexts,
        unlocatableAnnotationTexts,
        unsupportedAnnotations,
        linkAnnotations,
        fileAttachmentAnnotations,
      } = await extractPageAnnotations(page, viewport, pageNum);

      allUnsupportedAnnotations.push(...unsupportedAnnotations);
      allLinkAnnotations.push(...linkAnnotations);
      allPageFileAttachments.push(...fileAttachmentAnnotations);

      // Convert PDF.js text items into normalized top-left coordinate items (PDF points)
      const textElements = [];
      const textLines = [];

      for (const item of rawItems) {
        const str = (item.str || '').trim();
        if (!str) continue;

        // item.transform is [scaleX, skewY, skewX, scaleY, tx, ty] in bottom-left PDF coordinates
        const tx = item.transform ? item.transform[4] : 0;
        const ty = item.transform ? item.transform[5] : 0;
        const fontHeight = Math.max(
          Math.abs(item.height || (item.transform ? item.transform[3] : 12)),
          10
        );
        const width = Math.max(item.width || str.length * (fontHeight * 0.55), 8);

        // Convert bottom-left baseline (tx, ty) to top-left bounding box (x, y, width, height)
        const topY = Math.max(0, pageHeight - ty - fontHeight * 0.85);

        textElements.push({
          text: item.str,
          x: Number(tx.toFixed(2)),
          y: Number(topY.toFixed(2)),
          width: Number(width.toFixed(2)),
          height: Number((fontHeight * 1.2).toFixed(2)),
          source: 'pdf-text',
        });
        textLines.push(item.str);
      }

      // Append validated visual AcroForm widget and visual annotation elements into textElements/textLines
      for (const annEl of visualAnnotationElements) {
        textElements.push(annEl);
      }
      for (const annTxt of visualAnnotationTexts) {
        textLines.push(annTxt);
      }

      const joinedSelectableAndWidgetText = textLines.join(' ').replace(/\s+/g, ' ').trim();
      const hasSubstantialText = joinedSelectableAndWidgetText.length >= 15;
      let pageMethod = 'pdf-text';
      let finalPageText = joinedSelectableAndWidgetText;
      let finalElements = textElements;

      // Trigger OCR when:
      // 1. `forceOcr` is requested (e.g., during post-redaction verification), OR
      // 2. The page has fewer than 15 characters of selectable/widget text (`ocr-fallback`), OR
      // 3. The page has selectable/widget text AND embedded raster images (`hybrid`).
      if (forceOcr || !hasSubstantialText || hasEmbeddedImages) {
        usedOcrFallback = true;
        pageMethod = !hasSubstantialText ? 'ocr-fallback' : 'hybrid';

        let ocrData;
        const ocrScale = 2.0;
        try {
          const { canvas } = await renderPageToCanvas(page, ocrScale);
          const imageBuffer = canvas.toBuffer('image/png');

          if (!ocrWorker) {
            ocrWorker = await createWorker('eng');
          }

          // Request text: true, blocks: true so Tesseract.js v7 populates blocks -> paragraphs -> lines -> words with bboxes
          const ocrResult = await ocrWorker.recognize(imageBuffer, {}, { text: true, blocks: true });
          if (!ocrResult || !ocrResult.data) {
            throw new Error('OCR worker returned empty recognition data.');
          }
          ocrData = ocrResult.data;
        } catch (ocrErr) {
          const err = new Error(
            `OCR inspection failed on page ${pageNum}: ${ocrErr.message || 'Unknown OCR error'}`
          );
          err.code = ocrErr.code || 'OCR_EXTRACTION_FAILED';
          err.statusCode = ocrErr.statusCode || 500;
          throw err;
        }

        const ocrText = (ocrData.text || '').trim();
        const ocrElements = extractOcrElementsFromData(ocrData, ocrScale);

        if (!hasSubstantialText) {
          finalPageText = ocrText;
          finalElements = ocrElements;
        } else {
          // Hybrid page: merge selectable/widget PDF text with non-duplicate OCR elements originating from embedded images
          usedPdfText = true;
          const uniqueOcrElements = ocrElements.filter(
            (ocrEl) => !isOcrElementDuplicatingPdfText(ocrEl, textElements)
          );
          const uniqueOcrLineTexts = uniqueOcrElements
            .filter((el) => el.source === 'ocr-line')
            .map((el) => el.text.trim())
            .filter(Boolean);

          // If line-level elements were filtered out but unique word-level elements remain, preserve their text
          const supplementalOcrText =
            uniqueOcrLineTexts.length > 0
              ? uniqueOcrLineTexts.join('\n')
              : uniqueOcrElements
                  .filter((el) => el.source === 'ocr')
                  .map((el) => el.text.trim())
                  .join(' ');

          finalPageText = supplementalOcrText
            ? `${joinedSelectableAndWidgetText}\n${supplementalOcrText}`.trim()
            : joinedSelectableAndWidgetText;
          finalElements = [...textElements, ...uniqueOcrElements];
        }
      } else {
        usedPdfText = true;
      }

      // If the page also contains unlocatable/non-visual annotations (e.g., sticky notes or annotations with invalid/missing rect),
      // append their text to `finalPageText` WITHOUT adding any element to `finalElements`.
      // That way, `detectSensitiveInfo()` will detect any PII inside them with `boundingBox: null` (never inventing coordinates)
      // and surface an explicit unlocatable-annotation status, preventing silent false-success redaction.
      if (unlocatableAnnotationTexts.length > 0) {
        const unlocText = unlocatableAnnotationTexts.join('\n').trim();
        if (unlocText) {
          finalPageText = finalPageText ? `${finalPageText}\n${unlocText}` : unlocText;
        }
      }

      pages.push({
        pageNumber: pageNum,
        width: Number(pageWidth.toFixed(2)),
        height: Number(pageHeight.toFixed(2)),
        method: pageMethod,
        hasEmbeddedImages,
        imageOperatorCount,
        annotationCount: visualAnnotationElements.length + unsupportedAnnotations.length,
        unsupportedAnnotations,
        linkAnnotations,
        fileAttachmentAnnotations,
        text: finalPageText,
        elements: finalElements,
      });
    }

    // Perform P2.2 hidden PDF structure inspection (metadata, XMP, attachments, incremental revisions)
    rawStructuralInspection = await inspectPdfHiddenStructures(
      pdfDoc,
      dataBuffer,
      allPageFileAttachments
    );
  } finally {
    if (ocrWorker) {
      try {
        await ocrWorker.terminate();
      } catch {
        // Ensure worker termination errors never mask extraction results or failures
      }
    }
  }

  const totalCharacters = pages.reduce((acc, p) => acc + p.text.length, 0);
  let extractionMethod = 'pdf-text';
  if (usedOcrFallback && usedPdfText) {
    extractionMethod = 'hybrid';
  } else if (usedOcrFallback) {
    extractionMethod = 'ocr-fallback';
  }

  const structuralAudit = buildStructuralAudit(rawStructuralInspection, null);

  return {
    pageCount: numPages,
    extractionMethod,
    usedOcrFallback,
    totalCharacters,
    unsupportedAnnotations: allUnsupportedAnnotations,
    linkAnnotations: allLinkAnnotations,
    rawStructuralInspection,
    structuralAudit,
    pages,
  };
}

