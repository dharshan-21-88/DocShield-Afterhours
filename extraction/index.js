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
 * Extract embedded text and bounding-box items from a PDF file.
 * Automatically falls back to Tesseract.js OCR for any page that has little/no embedded text,
 * AND runs hybrid OCR inspection on pages that contain both selectable text and embedded raster images.
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

      const joinedPdfText = textLines.join(' ').replace(/\s+/g, ' ').trim();
      const hasSubstantialText = joinedPdfText.length >= 15;
      let pageMethod = 'pdf-text';
      let finalPageText = joinedPdfText;
      let finalElements = textElements;

      // Trigger OCR when:
      // 1. `forceOcr` is requested (e.g., during post-redaction verification), OR
      // 2. The page has fewer than 15 characters of selectable text (`ocr-fallback`), OR
      // 3. The page has selectable text AND embedded raster images (`hybrid`).
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
          // Hybrid page: merge selectable PDF text with non-duplicate OCR elements originating from embedded images
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
            ? `${joinedPdfText}\n${supplementalOcrText}`.trim()
            : joinedPdfText;
          finalElements = [...textElements, ...uniqueOcrElements];
        }
      } else {
        usedPdfText = true;
      }

      pages.push({
        pageNumber: pageNum,
        width: Number(pageWidth.toFixed(2)),
        height: Number(pageHeight.toFixed(2)),
        method: pageMethod,
        hasEmbeddedImages,
        imageOperatorCount,
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
    pages,
  };
}
