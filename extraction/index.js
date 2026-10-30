import fs from 'fs/promises';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import Tesseract from 'tesseract.js';

/**
 * Custom CanvasFactory required by pdfjs-dist in Node.js environments
 * to render PDF pages onto node-canvas instances.
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

/**
 * Extract embedded text and bounding-box items from a PDF file.
 * Automatically falls back to Tesseract.js OCR for any page that has little/no embedded text.
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

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.0 });
    const pageWidth = viewport.width;
    const pageHeight = viewport.height;

    const textContent = await page.getTextContent();
    const rawItems = textContent.items || [];

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
    let pageMethod = 'pdf-text';
    let finalPageText = joinedPdfText;
    let finalElements = textElements;

    // Trigger OCR fallback if page has fewer than 15 characters of embedded text OR forceOcr is enabled
    if (forceOcr || joinedPdfText.length < 15) {
      usedOcrFallback = true;
      pageMethod = joinedPdfText.length < 15 ? 'ocr-fallback' : 'hybrid';

      const ocrScale = 2.0;
      const { canvas } = await renderPageToCanvas(page, ocrScale);
      const imageBuffer = canvas.toBuffer('image/png');

      const ocrResult = await Tesseract.recognize(imageBuffer, 'eng');
      const ocrData = ocrResult?.data || {};
      const ocrText = (ocrData.text || '').trim();

      const ocrElements = [];
      const words = ocrData.words || [];
      for (const w of words) {
        const wordText = (w.text || '').trim();
        if (!wordText || !w.bbox) continue;
        // Convert pixel bbox back to 1.0x PDF point space
        const x = w.bbox.x0 / ocrScale;
        const y = w.bbox.y0 / ocrScale;
        const width = (w.bbox.x1 - w.bbox.x0) / ocrScale;
        const height = (w.bbox.y1 - w.bbox.y0) / ocrScale;
        ocrElements.push({
          text: wordText,
          x: Number(x.toFixed(2)),
          y: Number(y.toFixed(2)),
          width: Number(Math.max(width, 6).toFixed(2)),
          height: Number(Math.max(height, 10).toFixed(2)),
          source: 'ocr',
        });
      }

      // Also include lines from OCR if available for multi-word phrase matching
      const lines = ocrData.lines || [];
      for (const ln of lines) {
        const lineText = (ln.text || '').trim();
        if (!lineText || !ln.bbox) continue;
        const x = ln.bbox.x0 / ocrScale;
        const y = ln.bbox.y0 / ocrScale;
        const width = (ln.bbox.x1 - ln.bbox.x0) / ocrScale;
        const height = (ln.bbox.y1 - ln.bbox.y0) / ocrScale;
        ocrElements.push({
          text: lineText,
          x: Number(x.toFixed(2)),
          y: Number(y.toFixed(2)),
          width: Number(Math.max(width, 12).toFixed(2)),
          height: Number(Math.max(height, 12).toFixed(2)),
          source: 'ocr-line',
        });
      }

      if (joinedPdfText.length < 15) {
        finalPageText = ocrText;
        finalElements = ocrElements;
      } else {
        finalPageText = `${joinedPdfText}\n${ocrText}`.trim();
        finalElements = [...textElements, ...ocrElements];
        usedPdfText = true;
      }
    } else {
      usedPdfText = true;
    }

    pages.push({
      pageNumber: pageNum,
      width: Number(pageWidth.toFixed(2)),
      height: Number(pageHeight.toFixed(2)),
      method: pageMethod,
      text: finalPageText,
      elements: finalElements,
    });
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
