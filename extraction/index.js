import fs from 'fs/promises';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { createWorker } from 'tesseract.js';

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
    };
  }

  const visualAnnotationElements = [];
  const visualAnnotationTexts = [];
  const unlocatableAnnotationTexts = [];
  const unsupportedAnnotations = [];
  const linkAnnotations = [];

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
  };
}

/**
 * Extract embedded text and bounding-box items from a PDF file.
 * Automatically falls back to Tesseract.js OCR for any page that has little/no embedded text,
 * AND runs hybrid OCR inspection on pages that contain both selectable text and embedded raster images.
 * Also inspects AcroForm widgets and visual annotations via `page.getAnnotations()`.
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
  let usedOcrFallback = false;
  let usedPdfText = false;
  let ocrWorker = null;

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
      } = await extractPageAnnotations(page, viewport, pageNum);

      allUnsupportedAnnotations.push(...unsupportedAnnotations);
      allLinkAnnotations.push(...linkAnnotations);

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
        text: finalPageText,
        elements: finalElements,
      });
    }
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

  return {
    pageCount: numPages,
    extractionMethod,
    usedOcrFallback,
    totalCharacters,
    unsupportedAnnotations: allUnsupportedAnnotations,
    linkAnnotations: allLinkAnnotations,
    pages,
  };
}
