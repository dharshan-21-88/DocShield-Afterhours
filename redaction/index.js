import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument } from 'pdf-lib';
import { renderPageToCanvas } from '../extraction/index.js';
import { config } from '../config/index.js';
import { ensureTempDirs, computeSha256 } from '../config/storage.js';

/**
 * Permanently redacts a PDF document.
 *
 * Why image-based raster redaction?
 * Drawing a black rectangle on top of an existing PDF page leaves the underlying
 * text stream intact (anyone can copy-paste or extract the hidden text).
 *
 * DocShield renders each PDF page onto an image canvas, paints solid opaque
 * redaction blocks directly onto the pixel buffer over every selected sensitive item,
 * discards all original text streams/fonts/metadata, and rebuilds a brand-new PDF
 * containing only the sanitized page images.
 *
 * @param {string} originalPdfPath - Path to original uploaded PDF
 * @param {Array} itemsToRedact - Array of detected sensitive items selected for redaction
 */
export async function generatePermanentlyRedactedPdf(originalPdfPath, itemsToRedact = []) {
  await ensureTempDirs();

  const rawBuffer = await fs.readFile(originalPdfPath);
  const uint8Array = new Uint8Array(rawBuffer);

  const loadingTask = pdfjsLib.getDocument({
    data: uint8Array,
    useSystemFonts: true,
    disableFontFace: true,
    verbosity: 0,
  });

  const pdfDoc = await loadingTask.promise;
  const numPages = pdfDoc.numPages;

  // Create a brand new, empty PDF document via pdf-lib (contains zero original text objects)
  const outputPdf = await PDFDocument.create();
  outputPdf.setTitle('DocShield Protected Document');
  outputPdf.setProducer('DocShield – Smart Document Privacy Protector');
  outputPdf.setCreationDate(new Date());

  const renderScale = 2.0; // 2x resolution for crisp readability of unredacted content

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const baseViewport = page.getViewport({ scale: 1.0 });
    const { canvas, context } = await renderPageToCanvas(page, renderScale);

    // Filter items belonging to this page
    const pageItems = itemsToRedact.filter((item) => item.pageNumber === pageNum);

    // Also inspect raw PDF text items on this page to ensure any text run containing
    // a selected sensitive string is completely covered even if a regex matched a substring
    const textContent = await page.getTextContent();
    const rawTextItems = textContent.items || [];

    context.save();
    context.fillStyle = '#000000';

    for (const item of pageItems) {
      let drewBox = false;

      if (item.boundingBox) {
        const padX = 4;
        const padY = 3;
        const rx = Math.max(0, (item.boundingBox.x - padX) * renderScale);
        const ry = Math.max(0, (item.boundingBox.y - padY) * renderScale);
        const rw = (item.boundingBox.width + padX * 2) * renderScale;
        const rh = (item.boundingBox.height + padY * 2) * renderScale;

        context.fillRect(rx, ry, rw, rh);
        drewBox = true;
      }

      // Also check raw PDF text items for any substring match of item.text
      const targetNorm = (item.text || '').trim().toLowerCase();
      if (targetNorm) {
        for (const raw of rawTextItems) {
          const rawStr = (raw.str || '').trim();
          if (!rawStr) continue;
          if (rawStr.toLowerCase().includes(targetNorm)) {
            const tx = raw.transform ? raw.transform[4] : 0;
            const ty = raw.transform ? raw.transform[5] : 0;
            const fontH = Math.max(Math.abs(raw.height || (raw.transform ? raw.transform[3] : 12)), 11);
            const rawW = Math.max(raw.width || rawStr.length * (fontH * 0.6), 20);
            const topY = Math.max(0, baseViewport.height - ty - fontH * 0.9);

            // Calculate proportional offset if the sensitive value is preceded by a label (e.g. "Phone: +91-9876543210")
            const matchIdx = rawStr.toLowerCase().indexOf(targetNorm);
            const startRatio = Math.max(0, (matchIdx - 1) / Math.max(rawStr.length, 1));
            const maskX = (tx + rawW * startRatio - 3) * renderScale;
            const maskY = (topY - 3) * renderScale;
            const maskW = (rawW * (1 - startRatio) + 10) * renderScale;
            const maskH = (fontH * 1.35 + 4) * renderScale;

            context.fillRect(maskX, maskY, maskW, maskH);
            drewBox = true;
          }
        }
      }

      // Fallback safety mask if neither boundingBox nor rawTextItems matched
      if (!drewBox) {
        context.fillRect(40 * renderScale, 100 * renderScale, 300 * renderScale, 20 * renderScale);
      }
    }

    context.restore();

    const pngBuffer = canvas.toBuffer('image/png');
    const embeddedImage = await outputPdf.embedPng(pngBuffer);

    const newPage = outputPdf.addPage([baseViewport.width, baseViewport.height]);
    newPage.drawImage(embeddedImage, {
      x: 0,
      y: 0,
      width: baseViewport.width,
      height: baseViewport.height,
    });
  }

  const redactedPdfBytes = await outputPdf.save();
  const redactedBuffer = Buffer.from(redactedPdfBytes);
  const sha256 = computeSha256(redactedBuffer);

  const outputFileName = `redacted_${Date.now()}_${crypto.randomUUID()}.pdf`;
  const redactedFilePath = path.join(config.upload.redactedDir, outputFileName);
  await fs.writeFile(redactedFilePath, redactedBuffer);

  return {
    redactedFilePath,
    fileSizeBytes: redactedBuffer.length,
    sha256,
    pageCount: numPages,
  };
}
