import assert from 'assert';
import fs from 'fs';
import { PDFDocument, StandardFonts, rgb, PDFString, PDFName } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import { createApp } from '../server.js';
import { generateSamplePdfFile } from '../extraction/samples.js';
import { extractPdfContent } from '../extraction/index.js';
import { verifyRedactedPdf, verifyExportedPdfStructure } from '../verification/index.js';
import { config } from '../config/index.js';
import {
  getDocumentRecord,
  cleanupExpiredFiles,
  safeDeleteFile,
} from '../config/storage.js';

/**
 * Automated End-to-End Test Suite for DocShield Backend
 *
 * Includes:
 * - All original 6 hackathon scenarios & assertions (preserved intact)
 * - 7 expanded test coverage scenarios (New Test 1 to New Test 7)
 * - 5 Phase 1 Code Review Regression Tests (H-1, H-2, M-1 Email, M-1 Phone, L-1):
 *   - [Regression Test H-1] Wrapped two-line address detection, per-line bounding boxes, and permanent redaction.
 *   - [Regression Test H-2] Address where the city name also appears in the document header (prevent false header anchor).
 *   - [Regression Test M-1A] The same email address appearing twice on one scanned page (both detected & both redacted).
 *   - [Regression Test M-1B] The same phone number appearing twice on one scanned page (both detected & both redacted).
 *   - [Regression Test L-1] OCR token substring collisions (prefer exact token match over earlier superstring token).
 */

async function createMultiPageTestPdfBuffer() {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle('FICTIONAL MULTI-PAGE ACADEMIC & FINANCIAL RECORD');
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // Page 1
  const page1 = pdfDoc.addPage([595.28, 841.89]);
  page1.drawText('PAGE 1: STUDENT ACADEMIC PROFILE (FICTIONAL)', {
    x: 50,
    y: 760,
    size: 15,
    font: fontBold,
    color: rgb(0.1, 0.1, 0.2),
  });
  page1.drawText('Student Name: Kavya Menon (Synthetic Profile)', {
    x: 50,
    y: 720,
    size: 12,
    font: fontRegular,
  });
  page1.drawText('Student Registration No: REG-2026-MP-0101', {
    x: 50,
    y: 690,
    size: 12,
    font: fontRegular,
  });
  page1.drawText('University Email: kavya.menon.page1@fictional-univ.edu', {
    x: 50,
    y: 660,
    size: 12,
    font: fontRegular,
  });

  // Page 2
  const page2 = pdfDoc.addPage([595.28, 841.89]);
  page2.drawText('PAGE 2: SCHOLARSHIP DISBURSEMENT DETAILS (FICTIONAL)', {
    x: 50,
    y: 760,
    size: 15,
    font: fontBold,
    color: rgb(0.1, 0.1, 0.2),
  });
  page2.drawText('Aadhaar / National ID: 5839 2019 4821', {
    x: 50,
    y: 720,
    size: 12,
    font: fontRegular,
  });
  page2.drawText('Contact Mobile: +91-9811122233', {
    x: 50,
    y: 690,
    size: 12,
    font: fontRegular,
  });
  page2.drawText('Bank IFSC Code: SBIN0009988', {
    x: 50,
    y: 660,
    size: 12,
    font: fontRegular,
  });

  return Buffer.from(await pdfDoc.save());
}

/**
 * Helper to create an image-only (scanned OCR) PDF from an array of `{ text, x, y, font }` entries.
 */
async function createCustomScannedPdfBuffer(drawItems) {
  const width = 1190;
  const height = 1684;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#000000';
  for (const item of drawItems) {
    ctx.font = item.font || '28px sans-serif';
    ctx.fillText(item.text, item.x || 80, item.y);
  }

  const pngBuffer = canvas.toBuffer('image/png');
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]);
  const pngImage = await pdfDoc.embedPng(pngBuffer);
  page.drawImage(pngImage, {
    x: 0,
    y: 0,
    width: 595.28,
    height: 841.89,
  });

  return Buffer.from(await pdfDoc.save());
}

async function runTests() {
  console.log('================================================================');
  console.log('🛡️  DocShield – Automated End-to-End Backend Test Suite');
  console.log('================================================================\n');

  const app = await createApp();
  const server = app.listen(0);
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const createdSampleFiles = new Set();
  const trackedDocumentIds = new Set();

  function trackDocId(docId) {
    if (docId) trackedDocumentIds.add(docId);
  }

  // Helper for multipart file upload via fetch FormData
  async function uploadSampleFile(sampleId) {
    const sample = await generateSamplePdfFile(sampleId);
    createdSampleFiles.add(sample.filePath);
    const buffer = await fs.promises.readFile(sample.filePath);
    const formData = new FormData();
    const blob = new Blob([buffer], { type: 'application/pdf' });
    formData.append('file', blob, sample.fileName);

    const res = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      body: formData,
    });
    const json = await res.json();
    if (json && json.documentId) {
      trackDocId(json.documentId);
    }
    return { status: res.status, body: json };
  }

  async function uploadCustomPdfBuffer(buffer, fileName) {
    const formData = new FormData();
    formData.append('file', new Blob([buffer], { type: 'application/pdf' }), fileName);
    const res = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      body: formData,
    });
    const json = await res.json();
    if (json && json.documentId) {
      trackDocId(json.documentId);
    }
    return { status: res.status, body: json };
  }

  // Shared state for original sequential tests where needed
  let marksDocId = null;
  let tc1Detect = null;
  let scannedDocId = null;
  let tc2Detect = null;
  let multiCategoryDocId = null;

  const testDefinitions = [
    {
      name: '[Phase 1 Check] GET /api/health and GET /api-docs',
      fn: async () => {
        const healthRes = await fetch(`${baseUrl}/api/health`);
        assert.strictEqual(healthRes.status, 200, 'Health endpoint should return 200');
        const healthJson = await healthRes.json();
        assert.strictEqual(healthJson.status, 'ok');

        const docsRes = await fetch(`${baseUrl}/api-docs/`);
        assert.strictEqual(docsRes.status, 200, 'Swagger UI at /api-docs/ should return 200');
      },
    },
    {
      name: '[Test Case 1] Text-based Fictional Marks Card PDF Upload & Detection',
      fn: async () => {
        const tc1Upload = await uploadSampleFile('marks-card');
        assert.strictEqual(tc1Upload.status, 201, 'Marks card upload should return 201');
        assert.strictEqual(tc1Upload.body.extraction.extractionMethod, 'pdf-text');
        marksDocId = tc1Upload.body.documentId;

        const tc1DetectRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: marksDocId }),
        });
        tc1Detect = await tc1DetectRes.json();
        assert.strictEqual(tc1DetectRes.status, 200);
        assert.ok(
          tc1Detect.totalDetected >= 4,
          `Expected >= 4 sensitive items in marks card, got ${tc1Detect.totalDetected}`
        );
      },
    },
    {
      name: '[Test Case 2] Scanned Image-Only PDF requiring Tesseract.js OCR Fallback',
      fn: async () => {
        const tc2Upload = await uploadSampleFile('scanned-ocr');
        assert.strictEqual(tc2Upload.status, 201, 'Scanned PDF upload should return 201');
        assert.strictEqual(tc2Upload.body.extraction.usedOcrFallback, true, 'Scanned PDF must trigger OCR fallback');
        assert.strictEqual(tc2Upload.body.extraction.extractionMethod, 'ocr-fallback');
        scannedDocId = tc2Upload.body.documentId;

        const tc2DetectRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: scannedDocId }),
        });
        tc2Detect = await tc2DetectRes.json();
        assert.strictEqual(tc2DetectRes.status, 200);
        assert.ok(
          tc2Detect.totalDetected >= 2,
          `Expected OCR detection to find sensitive items, found ${tc2Detect.totalDetected}`
        );
      },
    },
    {
      name: '[Test Case 3] Multi-Category Financial & Identity Document Upload & Detection',
      fn: async () => {
        const tc3Upload = await uploadSampleFile('multi-category');
        assert.strictEqual(tc3Upload.status, 201);
        multiCategoryDocId = tc3Upload.body.documentId;

        const tc3DetectRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: multiCategoryDocId }),
        });
        const tc3Detect = await tc3DetectRes.json();
        assert.ok(
          tc3Detect.totalDetected >= 6,
          `Expected >= 6 items across categories, got ${tc3Detect.totalDetected}`
        );
      },
    },
    {
      name: '[Test Case 4] Clean Public Syllabus (No Sensitive Information)',
      fn: async () => {
        const tc4Upload = await uploadSampleFile('clean-doc');
        assert.strictEqual(tc4Upload.status, 201);
        const tc4DetectRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: tc4Upload.body.documentId }),
        });
        const tc4Detect = await tc4DetectRes.json();
        assert.strictEqual(tc4Detect.totalDetected, 0, 'Clean syllabus should have 0 sensitive items');
      },
    },
    {
      name: '[Test Case 5] Corrupted PDF and Unsupported File Type Validation',
      fn: async () => {
        const tc5Upload = await uploadSampleFile('corrupted-pdf');
        assert.strictEqual(tc5Upload.status, 400, 'Corrupted PDF should return HTTP 400');
        assert.strictEqual(tc5Upload.body.error, 'CORRUPTED_PDF');

        const badForm = new FormData();
        badForm.append('file', new Blob(['hello world'], { type: 'text/plain' }), 'notes.txt');
        const badRes = await fetch(`${baseUrl}/api/upload`, { method: 'POST', body: badForm });
        assert.strictEqual(badRes.status, 400, 'Non-PDF file should return HTTP 400');
      },
    },
    {
      name: '[Test Case 6A] Selective Redaction & Post-Redaction Verification (Marks Card)',
      fn: async () => {
        assert.ok(marksDocId && tc1Detect, 'Marks card prerequisite must be available');
        const twoItemIds = tc1Detect.items.slice(0, 2).map((i) => i.id);
        const selRedactRes = await fetch(`${baseUrl}/api/redact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            documentId: marksDocId,
            mode: 'selective',
            selectedItemIds: twoItemIds,
          }),
        });
        const selRedact = await selRedactRes.json();
        assert.strictEqual(selRedactRes.status, 200);
        assert.strictEqual(selRedact.selectedForRedactionCount, 2);

        const selVerifyRes = await fetch(`${baseUrl}/api/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            documentId: marksDocId,
            runOcrCheck: true,
          }),
        });
        const selVerify = await selVerifyRes.json();
        assert.strictEqual(selVerifyRes.status, 200);
        assert.strictEqual(
          selVerify.verification.successfullyRemovedCount,
          2,
          'Both selected items must be permanently removed'
        );
        assert.ok(
          selVerify.verification.remainingUnselectedDetectableCount >= 1,
          'Unselected items should remain detectable and reported'
        );
      },
    },
    {
      name: '[Test Case 6B] Automatic Full Redaction, Verification, Download & Privacy Report (SHA-256)',
      fn: async () => {
        assert.ok(marksDocId, 'Marks card prerequisite must be available');
        const autoRedactRes = await fetch(`${baseUrl}/api/redact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            documentId: marksDocId,
            mode: 'automatic',
          }),
        });
        const autoRedact = await autoRedactRes.json();
        assert.strictEqual(autoRedactRes.status, 200);
        assert.ok(
          autoRedact.redactedPdfSha256 && autoRedact.redactedPdfSha256.length === 64,
          'Must return 64-char SHA-256 hex'
        );

        const autoVerifyRes = await fetch(`${baseUrl}/api/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            documentId: marksDocId,
            runOcrCheck: true,
          }),
        });
        const autoVerify = await autoVerifyRes.json();
        assert.strictEqual(autoVerifyRes.status, 200);
        assert.strictEqual(
          autoVerify.verification.selectedStillDetectableCount,
          0,
          '0 selected items should remain detectable after automatic redaction'
        );

        const reportRes = await fetch(`${baseUrl}/api/report/${autoVerify.reportId}`);
        const reportJson = await reportRes.json();
        assert.strictEqual(reportRes.status, 200);
        assert.strictEqual(
          reportJson.report.exportedDocumentIntegrity.sha256,
          autoRedact.redactedPdfSha256
        );

        const downloadRes = await fetch(`${baseUrl}/api/download/${marksDocId}`);
        assert.strictEqual(downloadRes.status, 200);
        assert.strictEqual(downloadRes.headers.get('x-document-sha256'), autoRedact.redactedPdfSha256);
      },
    },

    // =========================================================================
    // EXPANDED TEST SCENARIOS (1 through 7)
    // =========================================================================
    {
      name: '[New Test 1] Complete Redaction & Post-Redaction Verification of Scanned OCR-Only PDF',
      fn: async () => {
        const scanUpload = await uploadSampleFile('scanned-ocr');
        assert.strictEqual(scanUpload.status, 201);
        const docId = scanUpload.body.documentId;

        const detectRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId }),
        });
        const detectJson = await detectRes.json();
        assert.strictEqual(detectRes.status, 200);
        assert.ok(detectJson.totalDetected >= 2, 'Scanned PDF should have >= 2 detected items before redaction');

        const redactRes = await fetch(`${baseUrl}/api/redact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            documentId: docId,
            mode: 'automatic',
          }),
        });
        const redactJson = await redactRes.json();
        assert.strictEqual(redactRes.status, 200, 'Scanned PDF redaction should return HTTP 200');
        assert.strictEqual(
          redactJson.selectedForRedactionCount,
          detectJson.totalDetected,
          'Automatic redaction on scanned PDF should select all detected items'
        );

        const verifyRes = await fetch(`${baseUrl}/api/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            documentId: docId,
            runOcrCheck: true,
          }),
        });
        const verifyJson = await verifyRes.json();
        assert.strictEqual(verifyRes.status, 200, 'Scanned PDF verification should return HTTP 200');

        assert.strictEqual(
          verifyJson.verification.selectedStillDetectableCount,
          0,
          `Expected 0 selected items to remain detectable in redacted scanned PDF, but ${
            verifyJson.verification.selectedStillDetectableCount
          } item(s) were still detected via OCR: ${JSON.stringify(
            verifyJson.verification.selectedStillDetectable.map((i) => ({
              id: i.id,
              text: i.text,
              boundingBox: i.boundingBox,
            }))
          )}`
        );
        assert.strictEqual(
          verifyJson.verification.successfullyRemovedCount,
          detectJson.totalDetected,
          'All selected items on the scanned PDF must be verified as removed'
        );
      },
    },
    {
      name: '[New Test 2] Multi-Page PDF Extraction, Detection, Redaction & Verification',
      fn: async () => {
        const multiPageBuffer = await createMultiPageTestPdfBuffer();
        const uploadRes = await uploadCustomPdfBuffer(multiPageBuffer, 'fictional_multipage.pdf');
        assert.strictEqual(uploadRes.status, 201, 'Multi-page upload should return HTTP 201');
        const uploadJson = uploadRes.body;
        assert.strictEqual(uploadJson.extraction.pageCount, 2, 'Page count must be 2');
        assert.strictEqual(uploadJson.extraction.pages.length, 2, 'Pages array must contain 2 pages');

        const detectRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: uploadJson.documentId }),
        });
        const detectJson = await detectRes.json();
        assert.strictEqual(detectRes.status, 200);
        const page1Items = detectJson.items.filter((i) => i.pageNumber === 1);
        const page2Items = detectJson.items.filter((i) => i.pageNumber === 2);
        assert.ok(page1Items.length >= 2, `Expected >= 2 items on Page 1, got ${page1Items.length}`);
        assert.ok(page2Items.length >= 2, `Expected >= 2 items on Page 2, got ${page2Items.length}`);

        const redactRes = await fetch(`${baseUrl}/api/redact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            documentId: uploadJson.documentId,
            mode: 'automatic',
          }),
        });
        const redactJson = await redactRes.json();
        assert.strictEqual(redactRes.status, 200);
        assert.strictEqual(redactJson.selectedForRedactionCount, detectJson.totalDetected);

        const verifyRes = await fetch(`${baseUrl}/api/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            documentId: uploadJson.documentId,
            runOcrCheck: true,
          }),
        });
        const verifyJson = await verifyRes.json();
        assert.strictEqual(verifyRes.status, 200);
        assert.strictEqual(verifyJson.verification.postExtractionSummary.pageCount, 2);
        assert.strictEqual(
          verifyJson.verification.selectedStillDetectableCount,
          0,
          `Expected 0 items remaining on multi-page PDF after redaction, found ${verifyJson.verification.selectedStillDetectableCount}`
        );
      },
    },
    {
      name: '[New Test 3A] Upload Validation: Missing File Field',
      fn: async () => {
        const emptyForm = new FormData();
        const res = await fetch(`${baseUrl}/api/upload`, {
          method: 'POST',
          body: emptyForm,
        });
        const body = await res.json();
        assert.strictEqual(res.status, 400, 'Missing file should return HTTP 400');
        assert.strictEqual(body.error, 'MISSING_FILE');
      },
    },
    {
      name: '[New Test 3B] Upload Validation: Empty 0-Byte PDF File',
      fn: async () => {
        const form = new FormData();
        form.append('file', new Blob([], { type: 'application/pdf' }), 'empty_zero_byte.pdf');
        const res = await fetch(`${baseUrl}/api/upload`, {
          method: 'POST',
          body: form,
        });
        const body = await res.json();
        assert.strictEqual(res.status, 400, 'Empty 0-byte PDF should return HTTP 400');
        assert.strictEqual(body.error, 'EMPTY_FILE');
      },
    },
    {
      name: '[New Test 3C] Upload Validation: Invalid PDF Magic Header (%PDF- missing)',
      fn: async () => {
        const form = new FormData();
        form.append(
          'file',
          new Blob(['THIS_IS_NOT_A_VALID_PDF_HEADER_12345'], { type: 'application/pdf' }),
          'fake_header.pdf'
        );
        const res = await fetch(`${baseUrl}/api/upload`, {
          method: 'POST',
          body: form,
        });
        const body = await res.json();
        assert.strictEqual(res.status, 400, 'File without %PDF- header should return HTTP 400');
        assert.strictEqual(body.error, 'INVALID_PDF_HEADER');
      },
    },
    {
      name: '[New Test 3D] Upload Validation: File Exceeding Configured Size Limit (> 10 MB)',
      fn: async () => {
        const oversizedBuffer = Buffer.alloc(config.upload.maxFileSizeBytes + 2048, 0x41);
        oversizedBuffer.write('%PDF-1.7\n', 0, 'ascii');

        const form = new FormData();
        form.append('file', new Blob([oversizedBuffer], { type: 'application/pdf' }), 'oversized_10mb.pdf');
        const res = await fetch(`${baseUrl}/api/upload`, {
          method: 'POST',
          body: form,
        });
        const body = await res.json();
        assert.strictEqual(res.status, 413, 'Oversized PDF should return HTTP 413');
        assert.strictEqual(body.error, 'FILE_TOO_LARGE');
      },
    },
    {
      name: '[New Test 4] Detection Category Filtering',
      fn: async () => {
        let docId = multiCategoryDocId;
        if (!docId) {
          const up = await uploadSampleFile('multi-category');
          docId = up.body.documentId;
        }

        const requestedCategories = ['EMAIL_ADDRESS', 'FINANCIAL_ACCOUNT'];
        const res = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            documentId: docId,
            categories: requestedCategories,
          }),
        });
        const body = await res.json();
        assert.strictEqual(res.status, 200);
        assert.ok(body.totalDetected >= 2, 'Filtered detection should find EMAIL_ADDRESS and FINANCIAL_ACCOUNT items');

        for (const item of body.items) {
          assert.ok(
            requestedCategories.includes(item.category),
            `Unexpected category "${item.category}" returned when filtering for ${requestedCategories.join(', ')}`
          );
        }

        const breakdownKeys = Object.keys(body.categoryBreakdown);
        for (const k of breakdownKeys) {
          assert.ok(
            requestedCategories.includes(k),
            `Unexpected category key "${k}" in categoryBreakdown`
          );
        }
      },
    },
    {
      name: '[New Test 5] Sample Listing (GET /api/samples) & Sample-Loading API Endpoints',
      fn: async () => {
        const listRes = await fetch(`${baseUrl}/api/samples`);
        const listBody = await listRes.json();
        assert.strictEqual(listRes.status, 200);
        assert.strictEqual(listBody.success, true);
        assert.ok(Array.isArray(listBody.samples) && listBody.samples.length === 5);

        const loadValidRes = await fetch(`${baseUrl}/api/samples/marks-card/load`, {
          method: 'POST',
        });
        const loadValidBody = await loadValidRes.json();
        assert.strictEqual(loadValidRes.status, 201);
        assert.strictEqual(loadValidBody.success, true);
        assert.strictEqual(loadValidBody.sampleId, 'marks-card');
        assert.ok(loadValidBody.documentId);
        trackDocId(loadValidBody.documentId);

        const loadCorruptRes = await fetch(`${baseUrl}/api/samples/corrupted-pdf/load`, {
          method: 'POST',
        });
        const loadCorruptBody = await loadCorruptRes.json();
        assert.strictEqual(loadCorruptRes.status, 400);
        assert.strictEqual(loadCorruptBody.error, 'CORRUPTED_PDF');

        const loadUnknownRes = await fetch(`${baseUrl}/api/samples/non-existent-sample/load`, {
          method: 'POST',
        });
        const loadUnknownBody = await loadUnknownRes.json();
        assert.strictEqual(loadUnknownRes.status, 400);
        assert.strictEqual(loadUnknownBody.error, 'INVALID_SAMPLE_ID');
      },
    },
    {
      name: '[New Test 6] Invalid Document IDs & Invalid Redaction / Verification / Report Requests',
      fn: async () => {
        for (const endpoint of ['/api/detect', '/api/redact', '/api/verify']) {
          const res = await fetch(`${baseUrl}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
          const body = await res.json();
          assert.strictEqual(res.status, 400, `${endpoint} without documentId should return 400`);
          assert.strictEqual(body.error, 'MISSING_DOCUMENT_ID');
        }

        for (const endpoint of ['/api/detect', '/api/redact', '/api/verify']) {
          const res = await fetch(`${baseUrl}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ documentId: 'doc_does_not_exist_999999' }),
          });
          const body = await res.json();
          assert.strictEqual(res.status, 404, `${endpoint} with unknown documentId should return 404`);
          assert.strictEqual(body.error, 'DOCUMENT_NOT_FOUND');
        }

        const freshRes = await fetch(`${baseUrl}/api/samples/clean-doc/load`, { method: 'POST' });
        const freshDoc = await freshRes.json();
        trackDocId(freshDoc.documentId);

        const badModeRes = await fetch(`${baseUrl}/api/redact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: freshDoc.documentId, mode: 'unsupported_mode' }),
        });
        const badModeBody = await badModeRes.json();
        assert.strictEqual(badModeRes.status, 400);
        assert.strictEqual(badModeBody.error, 'INVALID_REDACTION_MODE');

        const noItemsRes = await fetch(`${baseUrl}/api/redact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: freshDoc.documentId, mode: 'selective' }),
        });
        const noItemsBody = await noItemsRes.json();
        assert.strictEqual(noItemsRes.status, 400);
        assert.strictEqual(noItemsBody.error, 'MISSING_SELECTED_ITEMS');

        const verifyEarlyRes = await fetch(`${baseUrl}/api/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: freshDoc.documentId }),
        });
        const verifyEarlyBody = await verifyEarlyRes.json();
        assert.strictEqual(verifyEarlyRes.status, 400);
        assert.strictEqual(verifyEarlyBody.error, 'REDACTED_PDF_NOT_READY');

        const repRes = await fetch(`${baseUrl}/api/report/rep_does_not_exist_999999`);
        const repBody = await repRes.json();
        assert.strictEqual(repRes.status, 404);
        assert.strictEqual(repBody.error, 'REPORT_NOT_FOUND');

        const dlRes = await fetch(`${baseUrl}/api/download/doc_does_not_exist_999999`);
        const dlBody = await dlRes.json();
        assert.strictEqual(dlRes.status, 404);
        assert.strictEqual(dlBody.error, 'REDACTED_FILE_NOT_FOUND');
      },
    },
    {
      name: '[New Test 7] Temporary File Cleanup (cleanupExpiredFiles)',
      fn: async () => {
        const originalRetention = config.upload.fileRetentionMs;
        try {
          const loadRes = await fetch(`${baseUrl}/api/samples/clean-doc/load`, { method: 'POST' });
          const loadBody = await loadRes.json();
          assert.strictEqual(loadRes.status, 201);
          const docId = loadBody.documentId;
          trackDocId(docId);

          const redactRes = await fetch(`${baseUrl}/api/redact`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ documentId: docId, mode: 'automatic' }),
          });
          assert.strictEqual(redactRes.status, 200);

          const recordBefore = getDocumentRecord(docId);
          assert.ok(recordBefore, 'Document record must exist before cleanup');
          const origPath = recordBefore.originalFilePath;
          const redPath = recordBefore.redactedFilePath;
          assert.strictEqual(fs.existsSync(origPath), true, 'Original temp file must exist on disk');
          assert.strictEqual(fs.existsSync(redPath), true, 'Redacted temp file must exist on disk');

          recordBefore.updatedAt = Date.now() - originalRetention - 10000;

          await cleanupExpiredFiles();

          const recordAfter = getDocumentRecord(docId);
          assert.strictEqual(recordAfter, null, 'Expired document record must be removed from memory');
          assert.strictEqual(fs.existsSync(origPath), false, 'Expired original PDF must be deleted from disk');
          assert.strictEqual(fs.existsSync(redPath), false, 'Expired redacted PDF must be deleted from disk');
        } finally {
          config.upload.fileRetentionMs = originalRetention;
        }
      },
    },

    // =========================================================================
    // PHASE 1 CODE REVIEW REGRESSION TESTS (H-1, H-2, M-1A, M-1B, L-1)
    // =========================================================================
    {
      name: '[Regression Test H-1] Wrapped Two-Line Address Complete Multi-Line Coverage & Redaction',
      fn: async () => {
        // Create a scanned PDF where the address wraps across two distinct vertical lines:
        // Line 1 (y = 260px -> ~130pt): "No. 42, MG Road, Indiranagar,"
        // Line 2 (y = 330px -> ~165pt): "Bengaluru - 560038"
        const scannedWrappedBuf = await createCustomScannedPdfBuffer([
          { text: 'STUDENT RESIDENCE VERIFICATION FORM (FICTIONAL)', x: 80, y: 120, font: 'bold 32px sans-serif' },
          { text: 'Candidate Name: Siddharth Rao', x: 80, y: 195, font: '28px sans-serif' },
          { text: 'No. 42, MG Road, Indiranagar,', x: 80, y: 265, font: '28px sans-serif' },
          { text: 'Bengaluru - 560038', x: 80, y: 335, font: '28px sans-serif' },
          { text: 'Department: Computer Science', x: 80, y: 420, font: '28px sans-serif' },
        ]);

        const up = await uploadCustomPdfBuffer(scannedWrappedBuf, 'wrapped_address_scan.pdf');
        assert.strictEqual(up.status, 201);
        const docId = up.body.documentId;

        const detRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, categories: ['ADDRESS'] }),
        });
        const detBody = await detRes.json();
        assert.strictEqual(detRes.status, 200);
        assert.strictEqual(detBody.totalDetected, 1, 'Must detect the wrapped two-line address');

        const addrItem = detBody.items[0];
        assert.ok(addrItem.boundingBox, 'Wrapped address must have a valid primary boundingBox');
        assert.ok(
          Array.isArray(addrItem.boundingBoxes) && addrItem.boundingBoxes.length === 2,
          `Wrapped two-line address must produce 2 per-line boundingBoxes, got: ${JSON.stringify(addrItem.boundingBoxes)}`
        );

        // Redact & verify that NEITHER Line 1 ("Indiranagar") NOR Line 2 ("560038") remains readable via OCR
        const redRes = await fetch(`${baseUrl}/api/redact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, mode: 'automatic' }),
        });
        assert.strictEqual(redRes.status, 200);

        const rec = getDocumentRecord(docId);
        const postOcr = await extractPdfContent(rec.redactedFilePath, { forceOcr: true });
        const afterText = postOcr.pages[0].text.toLowerCase();

        assert.strictEqual(
          afterText.includes('indiranagar'),
          false,
          `Line 1 of wrapped address ("Indiranagar") must be masked, but OCR read: ${afterText}`
        );
        assert.strictEqual(
          afterText.includes('560038'),
          false,
          `Line 2 of wrapped address ("560038") must be masked, but OCR read: ${afterText}`
        );
        assert.strictEqual(
          afterText.includes('siddharth'),
          true,
          'Unrelated candidate name line must remain unredacted and readable'
        );
      },
    },
    {
      name: '[Regression Test H-2] Address Where City Name Also Appears in Document Header (Anchor Accuracy)',
      fn: async () => {
        // Header at y = 110px (~55pt) contains "BENGALURU" and "ROAD"
        // Actual address is near bottom at y = 520px (~260pt)
        const headerCollisionBuf = await createCustomScannedPdfBuffer([
          { text: 'BENGALURU REGIONAL CAMPUS - MG ROAD OFFICE', x: 80, y: 110, font: 'bold 32px sans-serif' },
          { text: 'Official Academic Transcript Verification', x: 80, y: 185, font: '28px sans-serif' },
          { text: 'Student Name: Ananya Kulkarni', x: 80, y: 260, font: '28px sans-serif' },
          { text: 'Address: No. 42, MG Road, Bengaluru - 560001', x: 80, y: 520, font: '28px sans-serif' },
        ]);

        const up = await uploadCustomPdfBuffer(headerCollisionBuf, 'header_city_collision.pdf');
        assert.strictEqual(up.status, 201);
        const docId = up.body.documentId;

        const detRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, categories: ['ADDRESS'] }),
        });
        const detBody = await detRes.json();
        assert.strictEqual(detRes.status, 200);
        assert.strictEqual(detBody.totalDetected, 1);

        const addrItem = detBody.items[0];
        assert.ok(addrItem.boundingBox, 'Address must have a boundingBox');
        // Header is at ~55pt (110px / 2); Address is at ~250pt (520px / 2).
        assert.ok(
          addrItem.boundingBox.y > 200,
          `Address boundingBox.y (${addrItem.boundingBox.y}) must be anchored at the address line (~250pt), NOT the header (~55pt)`
        );

        const redRes = await fetch(`${baseUrl}/api/redact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, mode: 'automatic' }),
        });
        assert.strictEqual(redRes.status, 200);

        const verRes = await fetch(`${baseUrl}/api/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, runOcrCheck: true }),
        });
        const verBody = await verRes.json();
        assert.strictEqual(verRes.status, 200);
        assert.strictEqual(verBody.verification.selectedStillDetectableCount, 0, 'Address at bottom must be redacted');

        const rec = getDocumentRecord(docId);
        const postOcr = await extractPdfContent(rec.redactedFilePath, { forceOcr: true });
        const afterText = postOcr.pages[0].text.toLowerCase();
        assert.strictEqual(
          afterText.includes('regional campus'),
          true,
          'Document header must remain unredacted'
        );
        assert.strictEqual(
          afterText.includes('560001'),
          false,
          'Address PIN code must be completely masked'
        );
      },
    },
    {
      name: '[Regression Test M-1A] Duplicate Email Appearing Twice on One Scanned Page',
      fn: async () => {
        const dupEmail = 'duplicate.student@example.edu';
        const scannedDupEmailBuf = await createCustomScannedPdfBuffer([
          { text: 'DUPLICATE EMAIL VERIFICATION SLIP (FICTIONAL)', x: 80, y: 120, font: 'bold 32px sans-serif' },
          { text: `Primary Contact Email: ${dupEmail}`, x: 80, y: 240, font: '28px sans-serif' },
          { text: 'Intermediate Section: Academic Clearance Approved', x: 80, y: 360, font: '28px sans-serif' },
          { text: `Secondary Copy Email: ${dupEmail}`, x: 80, y: 480, font: '28px sans-serif' },
        ]);

        const up = await uploadCustomPdfBuffer(scannedDupEmailBuf, 'dup_email_scan.pdf');
        assert.strictEqual(up.status, 201);
        const docId = up.body.documentId;

        const detRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, categories: ['EMAIL_ADDRESS'] }),
        });
        const detBody = await detRes.json();
        assert.strictEqual(detRes.status, 200);
        assert.strictEqual(
          detBody.totalDetected,
          2,
          `Expected both occurrences of ${dupEmail} to be detected, got ${detBody.totalDetected}`
        );

        const box1 = detBody.items[0].boundingBox;
        const box2 = detBody.items[1].boundingBox;
        assert.ok(box1 && box2, 'Both email occurrences must have non-null bounding boxes');
        assert.ok(
          Math.abs(box2.y - box1.y) > 80,
          `The two email bounding boxes must have distinct vertical coordinates (y1=${box1.y}, y2=${box2.y})`
        );

        const redRes = await fetch(`${baseUrl}/api/redact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, mode: 'automatic' }),
        });
        assert.strictEqual(redRes.status, 200);

        const verRes = await fetch(`${baseUrl}/api/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, runOcrCheck: true }),
        });
        const verBody = await verRes.json();
        assert.strictEqual(verRes.status, 200);
        assert.strictEqual(
          verBody.verification.selectedStillDetectableCount,
          0,
          'Neither occurrence of the duplicate email may remain detectable after redaction'
        );
        assert.strictEqual(verBody.verification.successfullyRemovedCount, 2);
      },
    },
    {
      name: '[Regression Test M-1B] Duplicate Phone Number Appearing Twice on One Scanned Page',
      fn: async () => {
        const dupPhone = '+91 9876543210';
        const scannedDupPhoneBuf = await createCustomScannedPdfBuffer([
          { text: 'DUPLICATE PHONE VERIFICATION SLIP (FICTIONAL)', x: 80, y: 120, font: 'bold 32px sans-serif' },
          { text: `Applicant Mobile: ${dupPhone}`, x: 80, y: 240, font: '28px sans-serif' },
          { text: 'Intermediate Note: Emergency Contact Same As Applicant', x: 80, y: 360, font: '28px sans-serif' },
          { text: `Emergency Mobile: ${dupPhone}`, x: 80, y: 480, font: '28px sans-serif' },
        ]);

        const up = await uploadCustomPdfBuffer(scannedDupPhoneBuf, 'dup_phone_scan.pdf');
        assert.strictEqual(up.status, 201);
        const docId = up.body.documentId;

        const detRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, categories: ['PHONE_NUMBER'] }),
        });
        const detBody = await detRes.json();
        assert.strictEqual(detRes.status, 200);
        assert.strictEqual(
          detBody.totalDetected,
          2,
          `Expected both occurrences of ${dupPhone} to be detected, got ${detBody.totalDetected}`
        );

        const box1 = detBody.items[0].boundingBox;
        const box2 = detBody.items[1].boundingBox;
        assert.ok(box1 && box2, 'Both phone occurrences must have non-null bounding boxes');
        assert.ok(
          Math.abs(box2.y - box1.y) > 80,
          `The two phone bounding boxes must have distinct vertical coordinates (y1=${box1.y}, y2=${box2.y})`
        );

        const redRes = await fetch(`${baseUrl}/api/redact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, mode: 'automatic' }),
        });
        assert.strictEqual(redRes.status, 200);

        const verRes = await fetch(`${baseUrl}/api/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, runOcrCheck: true }),
        });
        const verBody = await verRes.json();
        assert.strictEqual(verRes.status, 200);
        assert.strictEqual(
          verBody.verification.selectedStillDetectableCount,
          0,
          'Neither occurrence of the duplicate phone number may remain detectable after redaction'
        );
        assert.strictEqual(verBody.verification.successfullyRemovedCount, 2);
      },
    },
    {
      name: '[Regression Test L-1] OCR Token Substring Collision (Exact Token Match Preferred Over Superstring)',
      fn: async () => {
        // Top of page (y = 210px -> ~105pt) has non-sensitive reference tokens that are superstrings of the individual
        // Aadhaar words ("REF4829X", "CODE7301Y", "BATCH9482Z"), while the actual standalone Aadhaar "4829 7301 9482"
        // is at y = 460px (~230pt).
        // Under the old Strategy 1 (`wNorm.includes(tNorm)`), the 3 contiguous superstring words at y = 210px
        // would falsely match `["4829", "7301", "9482"]` on the first pass!
        const collisionBuf = await createCustomScannedPdfBuffer([
          { text: 'OCR SUBSTRING COLLISION TEST (FICTIONAL)', x: 80, y: 110, font: 'bold 32px sans-serif' },
          { text: 'Batch Reference Codes: REF-4829-X CODE-7301-Y BATCH-9482-Z', x: 80, y: 210, font: '28px sans-serif' },
          { text: 'National ID No: 4829 7301 9482', x: 80, y: 460, font: '28px sans-serif' },
        ]);

        const up = await uploadCustomPdfBuffer(collisionBuf, 'ocr_substring_collision.pdf');
        assert.strictEqual(up.status, 201);
        const docId = up.body.documentId;

        const detRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, categories: ['NATIONAL_ID_AADHAAR'] }),
        });
        const detBody = await detRes.json();
        assert.strictEqual(detRes.status, 200);
        assert.strictEqual(detBody.totalDetected, 1);

        const idItem = detBody.items[0];
        assert.strictEqual(idItem.text, '4829 7301 9482');
        assert.ok(idItem.boundingBox, 'Aadhaar item must have a valid boundingBox');
        // Superstring tokens are at y ≈ 95pt (210px / 2); actual Aadhaar is at y ≈ 220pt (460px / 2)
        assert.ok(
          idItem.boundingBox.y > 180,
          `Aadhaar boundingBox.y (${idItem.boundingBox.y}) must match the exact tokens at ~220pt, not the superstring tokens at ~95pt`
        );

        const redRes = await fetch(`${baseUrl}/api/redact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, mode: 'automatic' }),
        });
        assert.strictEqual(redRes.status, 200);

        const verRes = await fetch(`${baseUrl}/api/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, runOcrCheck: true }),
        });
        const verBody = await verRes.json();
        assert.strictEqual(verRes.status, 200);
        assert.strictEqual(verBody.verification.selectedStillDetectableCount, 0);
      },
    },

    // =========================================================================
    // MANUAL SWAGGER TESTING BUG-FIX REGRESSION TESTS (Bugs 1 through 5)
    // =========================================================================
    {
      name: '[Bug 1A] Valid Indian PAN Identifier (ABCDE1234F) Classified as NATIONAL_ID_PAN (Not Aadhaar)',
      fn: async () => {
        const up = await uploadSampleFile('multi-category');
        assert.strictEqual(up.status, 201);
        const docId = up.body.documentId;

        const detRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId }),
        });
        const detBody = await detRes.json();
        assert.strictEqual(detRes.status, 200);

        const panItem = detBody.items.find((i) => i.text === 'ABCDE1234F');
        assert.ok(panItem, 'Must detect PAN identifier ABCDE1234F');
        assert.strictEqual(
          panItem.category,
          'NATIONAL_ID_PAN',
          `Expected ABCDE1234F category to be NATIONAL_ID_PAN, got ${panItem.category}`
        );
        assert.strictEqual(panItem.categoryLabel, 'Permanent Account Number (PAN)');
        assert.ok(
          panItem.detectionStatus.includes('Permanent Account Number (PAN)'),
          `Expected PAN detectionStatus explanation, got "${panItem.detectionStatus}"`
        );
        assert.strictEqual(
          detBody.items.some((i) => i.text === 'ABCDE1234F' && i.category === 'NATIONAL_ID_AADHAAR'),
          false,
          'ABCDE1234F must never be classified as NATIONAL_ID_AADHAAR'
        );
      },
    },
    {
      name: '[Bug 1B] Aadhaar Detection Continues Working Accurately alongside PAN',
      fn: async () => {
        const up = await uploadSampleFile('multi-category');
        assert.strictEqual(up.status, 201);
        const docId = up.body.documentId;

        const detRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId }),
        });
        const detBody = await detRes.json();
        assert.strictEqual(detRes.status, 200);

        const aadhaarItem = detBody.items.find((i) => i.text === '6291 8402 5519');
        assert.ok(aadhaarItem, 'Must detect 12-digit Aadhaar identifier 6291 8402 5519');
        assert.strictEqual(aadhaarItem.category, 'NATIONAL_ID_AADHAAR');
        assert.strictEqual(aadhaarItem.categoryLabel, 'Aadhaar / National ID Number');
        assert.ok(aadhaarItem.boundingBox, 'Aadhaar item must have a valid boundingBox');
      },
    },
    {
      name: '[Bug 2A] 16-Digit Card Number (4532 8910 2234 9012) Does Not Create Misleading Nested Aadhaar Detection',
      fn: async () => {
        const up = await uploadSampleFile('multi-category');
        assert.strictEqual(up.status, 201);
        const docId = up.body.documentId;

        const detRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId }),
        });
        const detBody = await detRes.json();
        assert.strictEqual(detRes.status, 200);

        const cardItems = detBody.items.filter((i) => i.text === '4532 8910 2234 9012');
        assert.strictEqual(cardItems.length, 1, '16-digit card number must be detected once');
        assert.strictEqual(cardItems[0].category, 'FINANCIAL_ACCOUNT');
        assert.ok(cardItems[0].boundingBox, '16-digit card number must have a valid boundingBox');

        // Ensure neither the first 12 digits ("4532 8910 2234") nor the last 12 digits ("8910 2234 9012")
        // are emitted as nested/overlapping NATIONAL_ID_AADHAAR detections
        const nestedAadhaar = detBody.items.filter(
          (i) => i.text === '4532 8910 2234' || i.text === '8910 2234 9012'
        );
        assert.strictEqual(
          nestedAadhaar.length,
          0,
          `Expected 0 nested Aadhaar detections inside 16-digit card number, got: ${JSON.stringify(nestedAadhaar)}`
        );
      },
    },
    {
      name: '[Bug 2B] Genuine Nearby Independent Detections on the Same Line Are Preserved',
      fn: async () => {
        const pdfDoc = await PDFDocument.create();
        const page = pdfDoc.addPage([595.28, 841.89]);
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        page.drawText('FICTIONAL INLINE MULTI-FIELD RECORD', { x: 50, y: 760, size: 14, font });
        // Place PAN, Aadhaar, and Phone adjacent on the very same line
        page.drawText('KYC Summary: PAN ABCDE1234F | Aadhaar 4829 7301 9482 | Mobile +91-9876543210', {
          x: 50,
          y: 710,
          size: 11,
          font,
        });
        const buf = Buffer.from(await pdfDoc.save());

        const up = await uploadCustomPdfBuffer(buf, 'nearby_same_line.pdf');
        assert.strictEqual(up.status, 201);

        const detRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: up.body.documentId }),
        });
        const detBody = await detRes.json();
        assert.strictEqual(detRes.status, 200);
        assert.strictEqual(detBody.totalDetected, 3, 'All 3 nearby independent items on the same line must be preserved');

        const categories = detBody.items.map((i) => i.category).sort();
        assert.deepStrictEqual(categories, ['NATIONAL_ID_AADHAAR', 'NATIONAL_ID_PAN', 'PHONE_NUMBER']);
        for (const item of detBody.items) {
          assert.ok(item.boundingBox, `Nearby item ${item.text} must have a valid boundingBox`);
        }
      },
    },
    {
      name: '[Bug 3A] Multi-Category Sample Has Valid Bounding Boxes for Every Item & Automatic Redaction Succeeds',
      fn: async () => {
        const up = await uploadSampleFile('multi-category');
        assert.strictEqual(up.status, 201);
        const docId = up.body.documentId;

        const detRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId }),
        });
        const detBody = await detRes.json();
        assert.strictEqual(detRes.status, 200);
        assert.strictEqual(detBody.totalDetected, 9);

        // Verify zero items have boundingBox: null
        const nullBoxItems = detBody.items.filter((i) => !i.boundingBox);
        assert.strictEqual(
          nullBoxItems.length,
          0,
          `Expected all detected items in multi-category PDF to have valid bounding boxes, but found null on: ${JSON.stringify(nullBoxItems)}`
        );

        // Automatic redaction on multi-category PDF must now succeed (HTTP 200) and verify cleanly
        const redRes = await fetch(`${baseUrl}/api/redact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, mode: 'automatic' }),
        });
        const redBody = await redRes.json();
        assert.strictEqual(redRes.status, 200, `Expected automatic redaction on multi-category to return 200, got ${redRes.status}: ${JSON.stringify(redBody)}`);
        assert.strictEqual(redBody.selectedForRedactionCount, 9);

        const verRes = await fetch(`${baseUrl}/api/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, runOcrCheck: true }),
        });
        const verBody = await verRes.json();
        assert.strictEqual(verRes.status, 200);
        assert.strictEqual(verBody.verification.selectedStillDetectableCount, 0);
      },
    },
    {
      name: '[Bug 3B] Text Spans Split Across Multiple PDF Runs / Font Variations / Line Breaks Map to Valid Coordinates',
      fn: async () => {
        const pdfDoc = await PDFDocument.create();
        const page = pdfDoc.addPage([595.28, 841.89]);
        const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

        page.drawText('SPLIT SPAN & WHITESPACE COORDINATE TEST (FICTIONAL)', {
          x: 50,
          y: 760,
          size: 14,
          font: fontBold,
        });

        // Draw a 16-digit card number split across 4 separate drawText calls (producing 4 separate PDF text runs)
        page.drawText('Card Number:', { x: 50, y: 700, size: 12, font: fontRegular });
        page.drawText('4532', { x: 135, y: 700, size: 12, font: fontBold });
        page.drawText('8910', { x: 170, y: 700, size: 12, font: fontRegular });
        page.drawText('2234', { x: 205, y: 700, size: 12, font: fontBold });
        page.drawText('9012', { x: 240, y: 700, size: 12, font: fontRegular });

        // Draw an address wrapped across 2 separate lines
        page.drawText('No. 88, Residency Road,', { x: 50, y: 650, size: 12, font: fontRegular });
        page.drawText('Bengaluru - 560025', { x: 50, y: 630, size: 12, font: fontRegular });

        const buf = Buffer.from(await pdfDoc.save());
        const up = await uploadCustomPdfBuffer(buf, 'split_runs_and_wraps.pdf');
        assert.strictEqual(up.status, 201);
        const docId = up.body.documentId;

        const detRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId }),
        });
        const detBody = await detRes.json();
        assert.strictEqual(detRes.status, 200);

        const cardItem = detBody.items.find((i) => i.category === 'FINANCIAL_ACCOUNT');
        const addrItem = detBody.items.find((i) => i.category === 'ADDRESS');
        assert.ok(cardItem && cardItem.boundingBox, 'Card split across 4 PDF text runs must map to a valid boundingBox');
        assert.ok(addrItem && addrItem.boundingBox, 'Wrapped 2-line PDF text address must map to a valid boundingBox');
        assert.ok(
          Array.isArray(addrItem.boundingBoxes) && addrItem.boundingBoxes.length === 2,
          'Wrapped 2-line PDF text address must include 2 per-line boundingBoxes'
        );

        const redRes = await fetch(`${baseUrl}/api/redact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, mode: 'automatic' }),
        });
        assert.strictEqual(redRes.status, 200);
      },
    },
    {
      name: '[Bug 4A] Automatic Redaction Never Silently Skips Unlocatable Items & Fails Safely with Structured Error',
      fn: async () => {
        const up = await uploadSampleFile('marks-card');
        assert.strictEqual(up.status, 201);
        const docId = up.body.documentId;

        const detRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId }),
        });
        assert.strictEqual(detRes.status, 200);

        // Simulate a synthetic unlocatable detection in the stored document record whose text does not exist on the page
        const rec = getDocumentRecord(docId);
        rec.detectedItems.push({
          id: 'det_unlocatable_99',
          text: 'SYNTHETIC-UNLOCATABLE-TOKEN-9999',
          category: 'NATIONAL_ID_PAN',
          categoryLabel: 'Permanent Account Number (PAN)',
          confidence: 'LOW_UNCERTAIN',
          detectionStatus: 'Synthetic unlocatable item for fail-safe redaction test',
          pageNumber: 1,
          boundingBox: null,
        });

        // Automatic redaction MUST refuse to silently skip det_unlocatable_99 and return 422 with structured details
        const autoRedRes = await fetch(`${baseUrl}/api/redact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, mode: 'automatic' }),
        });
        const autoRedBody = await autoRedRes.json();
        assert.strictEqual(autoRedRes.status, 422, 'Automatic redaction with unlocatable item must return HTTP 422');
        assert.strictEqual(autoRedBody.success, false);
        assert.strictEqual(autoRedBody.error, 'REDACTION_COORDINATES_MISSING');
        assert.ok(autoRedBody.details, 'Error response must include structured details object');
        assert.strictEqual(autoRedBody.details.unlocatableCount, 1);
        assert.strictEqual(autoRedBody.details.unlocatableItems[0].id, 'det_unlocatable_99');
        assert.strictEqual(
          rec.redactedFilePath,
          null,
          'Document record must not point to a partially modified redacted file when redaction aborts'
        );
      },
    },
    {
      name: '[Bug 4B] Coordinate Recovery Resolves Cleared Coordinates & Selective Redaction Works for Locatable Items',
      fn: async () => {
        const up = await uploadSampleFile('marks-card');
        assert.strictEqual(up.status, 201);
        const docId = up.body.documentId;

        const detRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId }),
        });
        const detBody = await detRes.json();
        assert.strictEqual(detRes.status, 200);

        // 1. If a real item on the page had its cached boundingBox cleared to null, redactPdfController
        //    re-runs coordinate resolution before redaction and succeeds safely:
        const rec = getDocumentRecord(docId);
        rec.detectedItems[0].boundingBox = null;
        delete rec.detectedItems[0].boundingBoxes;

        const recoveredRedRes = await fetch(`${baseUrl}/api/redact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, mode: 'automatic' }),
        });
        assert.strictEqual(recoveredRedRes.status, 200, 'Automatic redaction should recover coordinates for real page text');
        const firstRedactedSha = (await recoveredRedRes.json()).redactedPdfSha256;
        const recAfterFirstRedact = getDocumentRecord(docId);
        const firstRedactedPath = recAfterFirstRedact.redactedFilePath;
        assert.strictEqual(Boolean(firstRedactedPath && fs.existsSync(firstRedactedPath)), true);

        // 2. If an unlocatable item is added and automatic redaction fails (422), the previously generated
        //    valid redacted file on disk MUST NOT be deleted or corrupted:
        recAfterFirstRedact.detectedItems.push({
          id: 'det_unlocatable_100',
          text: 'NON-EXISTENT-TEXT-ON-PAGE-0000',
          category: 'FINANCIAL_ACCOUNT',
          categoryLabel: 'Financial Account / Banking Identifier',
          confidence: 'LOW_UNCERTAIN',
          detectionStatus: 'Unlocatable item',
          pageNumber: 1,
          boundingBox: null,
        });

        const failRedRes = await fetch(`${baseUrl}/api/redact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, mode: 'automatic' }),
        });
        assert.strictEqual(failRedRes.status, 422);
        const recAfterFailedRedact = getDocumentRecord(docId);
        assert.strictEqual(
          fs.existsSync(firstRedactedPath),
          true,
          'Previous valid redacted PDF must remain intact when a subsequent redaction attempt fails pre-validation'
        );
        assert.strictEqual(recAfterFailedRedact.redactedSha256, firstRedactedSha);

        // 3. Selective redaction of the locatable items succeeds cleanly:
        const locatableIds = detBody.items.slice(0, 3).map((i) => i.id);
        const selRedRes = await fetch(`${baseUrl}/api/redact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            documentId: docId,
            mode: 'selective',
            selectedItemIds: locatableIds,
          }),
        });
        assert.strictEqual(selRedRes.status, 200, 'Selective redaction of locatable items must succeed');
      },
    },
    {
      name: '[Bug 5] Verification IDs (ver_det_*) & Report References Never Collide with Original Detection IDs (det_*)',
      fn: async () => {
        const up = await uploadSampleFile('marks-card');
        assert.strictEqual(up.status, 201);
        const docId = up.body.documentId;

        const detRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId }),
        });
        const detBody = await detRes.json();
        assert.strictEqual(detRes.status, 200);
        assert.ok(detBody.items.length >= 4);

        // Select only the first 2 items (det_1, det_2) for selective redaction, leaving det_3+ unselected
        const selectedIds = [detBody.items[0].id, detBody.items[1].id];
        const unselectedOriginalIds = detBody.items.slice(2).map((i) => i.id);

        const redRes = await fetch(`${baseUrl}/api/redact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            documentId: docId,
            mode: 'selective',
            selectedItemIds: selectedIds,
          }),
        });
        assert.strictEqual(redRes.status, 200);

        const verRes = await fetch(`${baseUrl}/api/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, runOcrCheck: true }),
        });
        const verBody = await verRes.json();
        assert.strictEqual(verRes.status, 200);

        const removedIds = new Set(verBody.verification.removedItems.map((i) => i.id));
        const remainingItems = verBody.verification.remainingItems;
        assert.strictEqual(removedIds.size, 2);
        assert.ok(remainingItems.length >= 1, 'Unselected items must be reported in remainingItems');

        for (const rem of remainingItems) {
          assert.ok(
            rem.id.startsWith('ver_det_'),
            `Remaining item ID "${rem.id}" must use "ver_det_" namespace to avoid colliding with original "det_" IDs`
          );
          assert.strictEqual(
            removedIds.has(rem.id),
            false,
            `Remaining item ID "${rem.id}" must never collide with a removed item ID`
          );
          if (rem.originalDetectionId) {
            assert.strictEqual(
              removedIds.has(rem.originalDetectionId),
              false,
              `originalDetectionId "${rem.originalDetectionId}" must reference an unselected item, not a removed item`
            );
            assert.ok(
              unselectedOriginalIds.includes(rem.originalDetectionId),
              `originalDetectionId "${rem.originalDetectionId}" must match one of the unselected original IDs`
            );
          }
        }

        // Also check the Privacy Assessment Report
        const rep = verBody.report;
        const repRemovedIds = new Set(rep.removedSensitiveItems.map((i) => i.id));
        for (const rem of rep.remainingSensitiveItems) {
          assert.strictEqual(
            repRemovedIds.has(rem.id),
            false,
            'Report remainingSensitiveItems IDs must never overlap with removedSensitiveItems IDs'
          );
        }
      },
    },

    // =========================================================================
    // P1 SECURITY CHALLENGE: EMBEDDED IMAGES IN HYBRID PDFs
    // =========================================================================
    {
      name: '[P1 Hybrid Test 1] Hybrid PDF (Selectable Text + Embedded Image with PAN & Phone): Extraction, Non-Duplicate Detection, Automatic Redaction & OCR Verification',
      fn: async () => {
        // 1. Render an embedded PNG image containing ONLY the fictional PAN (ABCDE1234F) and Phone (+91 9876543210)
        const imgCanvas = createCanvas(900, 260);
        const imgCtx = imgCanvas.getContext('2d');
        imgCtx.fillStyle = '#FFFFFF';
        imgCtx.fillRect(0, 0, 900, 260);
        imgCtx.strokeStyle = '#1E293B';
        imgCtx.lineWidth = 3;
        imgCtx.strokeRect(10, 10, 880, 240);

        imgCtx.fillStyle = '#000000';
        imgCtx.font = 'bold 30px sans-serif';
        imgCtx.fillText('EMBEDDED IDENTITY STAMP IMAGE (FICTIONAL)', 35, 65);
        imgCtx.font = '28px sans-serif';
        imgCtx.fillText('Income Tax PAN: ABCDE1234F', 35, 135);
        imgCtx.fillText('Emergency Phone: +91 9876543210', 35, 200);
        const embeddedPngBuffer = imgCanvas.toBuffer('image/png');

        // 2. Create a PDF with > 150 characters of ordinary selectable text (including a selectable email & reg no)
        //    AND embed the PNG image in the lower half of the page.
        const pdfDoc = await PDFDocument.create();
        const page = pdfDoc.addPage([595.28, 841.89]);
        const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
        const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);

        page.drawText('HYBRID UNIVERSITY CLEARANCE CERTIFICATE (FICTIONAL)', {
          x: 50,
          y: 770,
          size: 15,
          font: fontBold,
        });
        page.drawText(
          'This certificate confirms that the student listed below has completed all laboratory coursework',
          { x: 50, y: 735, size: 11, font: fontRegular }
        );
        page.drawText(
          'and departmental library requirements for the academic semester without any pending dues.',
          { x: 50, y: 715, size: 11, font: fontRegular }
        );
        page.drawText('Student Registration No: REG-2026-HY-0777', {
          x: 50,
          y: 680,
          size: 12,
          font: fontRegular,
        });
        page.drawText('Institutional Email: hybrid.student.demo@fictional-univ.edu', {
          x: 50,
          y: 650,
          size: 12,
          font: fontRegular,
        });

        // Embed the PNG image at bottom-left PDF coordinates (x=50, y=380, width=450, height=130)
        // In top-left PDF coordinates, this spans y = [841.89 - 510 = 331.89] to [841.89 - 380 = 461.89]
        const pngEmbed = await pdfDoc.embedPng(embeddedPngBuffer);
        page.drawImage(pngEmbed, {
          x: 50,
          y: 380,
          width: 450,
          height: 130,
        });

        const hybridBuffer = Buffer.from(await pdfDoc.save());

        // 3. Upload the hybrid PDF and confirm extraction identifies the document and page as 'hybrid'
        const up = await uploadCustomPdfBuffer(hybridBuffer, 'fictional_hybrid_document.pdf');
        assert.strictEqual(up.status, 201, 'Hybrid PDF upload must succeed with HTTP 201');
        assert.strictEqual(
          up.body.extraction.extractionMethod,
          'hybrid',
          `Expected extractionMethod to be "hybrid", got "${up.body.extraction.extractionMethod}"`
        );
        assert.strictEqual(up.body.extraction.usedOcrFallback, true, 'Hybrid PDF must report usedOcrFallback: true');
        assert.strictEqual(up.body.extraction.pages[0].method, 'hybrid', 'Page 1 method must be "hybrid"');
        assert.ok(
          up.body.extraction.totalCharacters > 150,
          `Expected > 150 extracted characters, got ${up.body.extraction.totalCharacters}`
        );

        const docId = up.body.documentId;

        // 4. Run detection and verify both image-only items AND selectable-text items are detected without duplication
        const detRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId }),
        });
        const detBody = await detRes.json();
        assert.strictEqual(detRes.status, 200);

        // Confirm image-only PAN (ABCDE1234F) is detected with valid boundingBox inside the embedded image region (y > 300pt)
        const panMatches = detBody.items.filter((i) => i.text === 'ABCDE1234F');
        assert.strictEqual(panMatches.length, 1, 'Image-only PAN ABCDE1234F must be detected exactly once');
        assert.strictEqual(panMatches[0].category, 'NATIONAL_ID_PAN');
        assert.ok(panMatches[0].boundingBox, 'Image-only PAN must have a valid boundingBox');
        assert.ok(
          panMatches[0].boundingBox.y > 300 && panMatches[0].boundingBox.y < 470,
          `Image-only PAN boundingBox.y (${panMatches[0].boundingBox.y}) must map to the embedded image region (~330..460pt)`
        );

        // Confirm image-only Phone (+91 9876543210) is detected with valid boundingBox inside the embedded image region
        const phoneMatches = detBody.items.filter(
          (i) => i.category === 'PHONE_NUMBER' && i.text.replace(/\s+/g, '') === '+919876543210'
        );
        assert.strictEqual(phoneMatches.length, 1, 'Image-only phone +91 9876543210 must be detected exactly once');
        assert.ok(phoneMatches[0].boundingBox, 'Image-only phone must have a valid boundingBox');
        assert.ok(
          phoneMatches[0].boundingBox.y > 300 && phoneMatches[0].boundingBox.y < 470,
          `Image-only phone boundingBox.y (${phoneMatches[0].boundingBox.y}) must map to the embedded image region (~330..460pt)`
        );

        // Confirm ordinary selectable-text detections (REG-2026-HY-0777 and hybrid.student.demo@fictional-univ.edu)
        // are NOT duplicated by the full-page OCR pass
        const regMatches = detBody.items.filter((i) => i.text === 'REG-2026-HY-0777');
        const emailMatches = detBody.items.filter((i) => i.text === 'hybrid.student.demo@fictional-univ.edu');
        assert.strictEqual(
          regMatches.length,
          1,
          `Selectable-text registration number must not be duplicated by OCR, found ${regMatches.length}`
        );
        assert.strictEqual(
          emailMatches.length,
          1,
          `Selectable-text email address must not be duplicated by OCR, found ${emailMatches.length}`
        );
        assert.strictEqual(detBody.totalDetected, 4, `Expected exactly 4 total detections on hybrid page, got ${detBody.totalDetected}`);

        // 5. Run automatic redaction and confirm all 4 items (2 text + 2 embedded-image) are redacted
        const redRes = await fetch(`${baseUrl}/api/redact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, mode: 'automatic' }),
        });
        const redBody = await redRes.json();
        assert.strictEqual(redRes.status, 200);
        assert.strictEqual(redBody.selectedForRedactionCount, 4);

        // 6. Run post-redaction verification with OCR enabled and confirm neither image-based item remains detectable
        const verRes = await fetch(`${baseUrl}/api/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, runOcrCheck: true }),
        });
        const verBody = await verRes.json();
        assert.strictEqual(verRes.status, 200);
        assert.strictEqual(
          verBody.verification.selectedStillDetectableCount,
          0,
          `Expected 0 selected items remaining after hybrid PDF redaction, got: ${JSON.stringify(verBody.verification.selectedStillDetectable)}`
        );
        assert.strictEqual(verBody.verification.successfullyRemovedCount, 4);
      },
    },
    {
      name: '[P1 Hybrid Test 2] Selective Redaction of Only Embedded-Image Detections in a Hybrid PDF',
      fn: async () => {
        const imgCanvas = createCanvas(800, 180);
        const imgCtx = imgCanvas.getContext('2d');
        imgCtx.fillStyle = '#FFFFFF';
        imgCtx.fillRect(0, 0, 800, 180);
        imgCtx.fillStyle = '#000000';
        imgCtx.font = '28px sans-serif';
        imgCtx.fillText('Stamped PAN: ABCDE1234F', 30, 75);
        imgCtx.fillText('Stamped Mobile: +91 9876543210', 30, 135);
        const pngBuf = imgCanvas.toBuffer('image/png');

        const pdfDoc = await PDFDocument.create();
        const page = pdfDoc.addPage([595.28, 841.89]);
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        page.drawText(
          'SELECTIVE HYBRID REDACTION TEST DOCUMENT WITH MORE THAN ONE HUNDRED AND FIFTY CHARACTERS OF ORDINARY SELECTABLE TEXT ON THE PAGE.',
          { x: 50, y: 750, size: 10, font }
        );
        page.drawText('Selectable Email: keep.visible@fictional-univ.edu', { x: 50, y: 710, size: 12, font });
        const pngEmbed = await pdfDoc.embedPng(pngBuf);
        page.drawImage(pngEmbed, { x: 50, y: 420, width: 400, height: 90 });

        const buf = Buffer.from(await pdfDoc.save());
        const up = await uploadCustomPdfBuffer(buf, 'selective_hybrid.pdf');
        assert.strictEqual(up.status, 201);
        const docId = up.body.documentId;

        const detRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId }),
        });
        const detBody = await detRes.json();
        assert.strictEqual(detRes.status, 200);

        const imageItemIds = detBody.items
          .filter((i) => i.category === 'NATIONAL_ID_PAN' || i.category === 'PHONE_NUMBER')
          .map((i) => i.id);
        assert.strictEqual(imageItemIds.length, 2, 'Must find both image-based items for selective redaction');

        // Selectively redact ONLY the 2 embedded-image items, leaving the selectable email unredacted
        const redRes = await fetch(`${baseUrl}/api/redact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            documentId: docId,
            mode: 'selective',
            selectedItemIds: imageItemIds,
          }),
        });
        assert.strictEqual(redRes.status, 200);

        const verRes = await fetch(`${baseUrl}/api/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, runOcrCheck: true }),
        });
        const verBody = await verRes.json();
        assert.strictEqual(verRes.status, 200);
        assert.strictEqual(verBody.verification.successfullyRemovedCount, 2, 'Both image-based items must be verified removed');
        assert.strictEqual(verBody.verification.selectedStillDetectableCount, 0);
        assert.strictEqual(
          verBody.verification.remainingItems.some((r) => r.text === 'keep.visible@fictional-univ.edu'),
          true,
          'Unselected selectable-text email must remain visible and be reported in remainingItems'
        );
      },
    },

    // =========================================================================
    // P2.1 SECURITY CHALLENGE: ACROFORM WIDGETS & VISUAL ANNOTATIONS
    // =========================================================================
    {
      name: '[P2.1 Test A] AcroForm Text Field Containing Synthetic PAN (ABCDE1234F): Extraction, Validated Bounding Box, Automatic Redaction & OCR Verification',
      fn: async () => {
        const pdfDoc = await PDFDocument.create();
        const form = pdfDoc.getForm();
        const page = pdfDoc.addPage([595.28, 841.89]);
        const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
        const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);

        page.drawText('INTERACTIVE KYC TAX DECLARATION FORM (FICTIONAL)', {
          x: 50,
          y: 770,
          size: 15,
          font: fontBold,
        });
        page.drawText('Applicant Name: Vikramaditya Rao (Synthetic Form Record)', {
          x: 50,
          y: 730,
          size: 12,
          font: fontRegular,
        });
        page.drawText('Enter Permanent Account Number (PAN) in Form Box Below:', {
          x: 50,
          y: 650,
          size: 12,
          font: fontRegular,
        });

        // Create an interactive AcroForm text widget at bottom-left (x=60, y=600, width=220, height=28)
        // Expected top-left y ≈ 841.89 - 628 = 213.89pt
        const panField = form.createTextField('applicant_pan_widget');
        panField.setText('ABCDE1234F');
        panField.addToPage(page, { x: 60, y: 600, width: 220, height: 28 });

        const buf = Buffer.from(await pdfDoc.save());
        const up = await uploadCustomPdfBuffer(buf, 'acroform_pan_test.pdf');
        assert.strictEqual(up.status, 201);
        const docId = up.body.documentId;

        const detRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId }),
        });
        const detBody = await detRes.json();
        assert.strictEqual(detRes.status, 200);
        assert.strictEqual(detBody.totalDetected, 1, 'Must detect the PAN inside the AcroForm text widget');

        const panItem = detBody.items[0];
        assert.strictEqual(panItem.text, 'ABCDE1234F');
        assert.strictEqual(panItem.category, 'NATIONAL_ID_PAN');
        assert.ok(panItem.boundingBox, 'AcroForm PAN item must have a valid boundingBox');
        assert.ok(
          Math.abs(panItem.boundingBox.x - 60) <= 5 && Math.abs(panItem.boundingBox.y - 213.89) <= 5,
          `AcroForm widget boundingBox (${JSON.stringify(panItem.boundingBox)}) must match the converted widget rect (~60, ~213.4)`
        );

        // Run automatic redaction
        const redRes = await fetch(`${baseUrl}/api/redact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, mode: 'automatic' }),
        });
        assert.strictEqual(redRes.status, 200);

        // Verify via OCR on the exported page image that ABCDE1234F is completely masked
        const verRes = await fetch(`${baseUrl}/api/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, runOcrCheck: true }),
        });
        const verBody = await verRes.json();
        assert.strictEqual(verRes.status, 200);
        assert.strictEqual(
          verBody.verification.selectedStillDetectableCount,
          0,
          'AcroForm PAN must be visually masked on the exported page image and undetectable by OCR'
        );
        assert.strictEqual(verBody.verification.successfullyRemovedCount, 1);
      },
    },
    {
      name: '[P2.1 Test B] Visible FreeText Annotation Containing Synthetic Phone (+91 9876543210): Detection, Redaction & OCR Verification',
      fn: async () => {
        const pdfDoc = await PDFDocument.create();
        const page = pdfDoc.addPage([595.28, 841.89]);
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

        page.drawText('DOCUMENT WITH VISIBLE FREETEXT ANNOTATION (FICTIONAL)', {
          x: 50,
          y: 770,
          size: 14,
          font,
        });
        page.drawText('General academic record with a visible FreeText callout box below.', {
          x: 50,
          y: 735,
          size: 12,
          font,
        });

        // Create a visible FreeText annotation with a normal appearance stream (/AP /N)
        // at bottom-left Rect [60, 420, 340, 455] -> top-left y = 841.89 - 455 = 386.89, height = 35
        const apStream = pdfDoc.context.flateStream(
          'BT /Helv 14 Tf 0 0 0 rg 6 10 Td (FreeText Phone: +91 9876543210) Tj ET',
          {
            Type: 'XObject',
            Subtype: 'Form',
            BBox: [0, 0, 280, 35],
            Resources: {
              Font: {
                Helv: font.ref,
              },
            },
          }
        );
        const apRef = pdfDoc.context.register(apStream);

        const freeTextDict = pdfDoc.context.obj({
          Type: 'Annot',
          Subtype: 'FreeText',
          Rect: [60, 420, 340, 455],
          Contents: PDFString.of('FreeText Phone: +91 9876543210'),
          DA: PDFString.of('/Helv 14 Tf 0 0 0 rg'),
          AP: { N: apRef },
        });
        page.node.addAnnot(pdfDoc.context.register(freeTextDict));

        const buf = Buffer.from(await pdfDoc.save());
        const up = await uploadCustomPdfBuffer(buf, 'freetext_phone_test.pdf');
        assert.strictEqual(up.status, 201);
        const docId = up.body.documentId;

        const detRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId }),
        });
        const detBody = await detRes.json();
        assert.strictEqual(detRes.status, 200);
        assert.strictEqual(detBody.totalDetected, 1, 'Must detect phone number inside visible FreeText annotation');

        const phoneItem = detBody.items[0];
        assert.strictEqual(phoneItem.category, 'PHONE_NUMBER');
        assert.ok(phoneItem.boundingBox, 'FreeText annotation phone item must have a valid boundingBox');
        assert.ok(
          Math.abs(phoneItem.boundingBox.x - 60) <= 5 && Math.abs(phoneItem.boundingBox.y - 386.89) <= 5,
          `FreeText boundingBox (${JSON.stringify(phoneItem.boundingBox)}) must match converted annotation Rect (~60, ~386.89)`
        );

        const redRes = await fetch(`${baseUrl}/api/redact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, mode: 'automatic' }),
        });
        assert.strictEqual(redRes.status, 200);

        const verRes = await fetch(`${baseUrl}/api/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, runOcrCheck: true }),
        });
        const verBody = await verRes.json();
        assert.strictEqual(verRes.status, 200);
        assert.strictEqual(
          verBody.verification.selectedStillDetectableCount,
          0,
          'Visible FreeText annotation phone number must be permanently masked on the exported page image'
        );
        assert.strictEqual(verBody.verification.successfullyRemovedCount, 1);
      },
    },
    {
      name: '[P2.1 Test C] Selective Redaction of AcroForm PAN While Preserving Unselected Email in Normal Page Text',
      fn: async () => {
        const pdfDoc = await PDFDocument.create();
        const form = pdfDoc.getForm();
        const page = pdfDoc.addPage([595.28, 841.89]);
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

        page.drawText('SELECTIVE ACROFORM REDACTION TEST (FICTIONAL)', { x: 50, y: 770, size: 14, font });
        page.drawText('Unselected Contact Email: faculty.advisor@fictional-univ.edu', {
          x: 50,
          y: 720,
          size: 12,
          font,
        });

        const panField = form.createTextField('selective_pan_widget');
        panField.setText('ABCDE1234F');
        panField.addToPage(page, { x: 60, y: 580, width: 220, height: 28 });

        const buf = Buffer.from(await pdfDoc.save());
        const up = await uploadCustomPdfBuffer(buf, 'selective_acroform_test.pdf');
        assert.strictEqual(up.status, 201);
        const docId = up.body.documentId;

        const detRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId }),
        });
        const detBody = await detRes.json();
        assert.strictEqual(detRes.status, 200);
        assert.strictEqual(detBody.totalDetected, 2);

        const panItem = detBody.items.find((i) => i.category === 'NATIONAL_ID_PAN');
        const emailItem = detBody.items.find((i) => i.category === 'EMAIL_ADDRESS');
        assert.ok(panItem && emailItem, 'Must detect both the form-field PAN and the normal page email');

        // Selectively redact ONLY the AcroForm PAN item
        const redRes = await fetch(`${baseUrl}/api/redact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            documentId: docId,
            mode: 'selective',
            selectedItemIds: [panItem.id],
          }),
        });
        assert.strictEqual(redRes.status, 200);

        const verRes = await fetch(`${baseUrl}/api/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, runOcrCheck: true }),
        });
        const verBody = await verRes.json();
        assert.strictEqual(verRes.status, 200);
        assert.strictEqual(verBody.verification.successfullyRemovedCount, 1, 'Selected AcroForm PAN must be removed');
        assert.strictEqual(verBody.verification.selectedStillDetectableCount, 0);
        assert.strictEqual(
          verBody.verification.remainingItems.some((r) => r.text === 'faculty.advisor@fictional-univ.edu'),
          true,
          'Unselected normal-text email must remain detectable and be reported in remainingItems'
        );
      },
    },
    {
      name: '[P2.1 Test D] Annotation Without Reliable Bounding Box Reports Explicit Limitation & Blocks Silent Redaction',
      fn: async () => {
        const pdfDoc = await PDFDocument.create();
        const page = pdfDoc.addPage([595.28, 841.89]);
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

        page.drawText('UNSUPPORTED ANNOTATION BOUNDING BOX TEST (FICTIONAL)', {
          x: 50,
          y: 770,
          size: 14,
          font,
        });
        page.drawText('Selectable Registration No: REG-2026-AN-0101', {
          x: 50,
          y: 725,
          size: 12,
          font,
        });

        // Add a sticky-note Text annotation with zero-area/off-page coordinates [0, 0, 0, 0]
        // containing a synthetic Aadhaar number (4829 7301 9482)
        const unlocatableAnnot = pdfDoc.context.obj({
          Type: 'Annot',
          Subtype: 'Text',
          Rect: [0, 0, 0, 0],
          Contents: PDFString.of('Hidden sticky note Aadhaar: 4829 7301 9482'),
        });
        page.node.addAnnot(pdfDoc.context.register(unlocatableAnnot));

        const buf = Buffer.from(await pdfDoc.save());
        const up = await uploadCustomPdfBuffer(buf, 'unsupported_annot_test.pdf');
        assert.strictEqual(up.status, 201);
        assert.ok(
          Array.isArray(up.body.extraction.unsupportedAnnotations) &&
            up.body.extraction.unsupportedAnnotations.length === 1,
          'Upload response must surface unsupportedAnnotations warning'
        );

        const docId = up.body.documentId;
        const detRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId }),
        });
        const detBody = await detRes.json();
        assert.strictEqual(detRes.status, 200);

        // Verify the Aadhaar in the unlocatable annotation is detected with boundingBox: null (never fabricated)
        // and carries an explicit UNSUPPORTED_ANNOTATION_COORDINATES status
        const unlocItem = detBody.items.find((i) => i.text === '4829 7301 9482');
        assert.ok(unlocItem, 'Must detect sensitive value inside the unlocatable annotation');
        assert.strictEqual(unlocItem.boundingBox, null, 'Must NOT invent a bounding box for an unlocatable annotation');
        assert.ok(
          unlocItem.detectionStatus.includes('UNSUPPORTED_ANNOTATION_COORDINATES'),
          `Expected UNSUPPORTED_ANNOTATION_COORDINATES in detectionStatus, got "${unlocItem.detectionStatus}"`
        );
        assert.ok(
          Array.isArray(detBody.unsupportedAnnotations) && detBody.unsupportedAnnotations.length === 1,
          'Detect response must include unsupportedAnnotations details'
        );

        // Verify automatic redaction refuses to silently claim success and returns HTTP 422 REDACTION_COORDINATES_MISSING
        const autoRedRes = await fetch(`${baseUrl}/api/redact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, mode: 'automatic' }),
        });
        const autoRedBody = await autoRedRes.json();
        assert.strictEqual(
          autoRedRes.status,
          422,
          'Automatic redaction must fail-closed with 422 when an annotation item lacks reliable coordinates'
        );
        assert.strictEqual(autoRedBody.error, 'REDACTION_COORDINATES_MISSING');
        assert.strictEqual(autoRedBody.details.unlocatableItems[0].id, unlocItem.id);
      },
    },

    // =========================================================================
    // P2.2 SECURITY CHALLENGE: HIDDEN PDF STRUCTURE INSPECTION
    // =========================================================================
    {
      name: '[P2.2 Test A] Sensitive PII in PDF Title, Author and Keywords Metadata (Separated from Page Coordinates)',
      fn: async () => {
        const pdfDoc = await PDFDocument.create();
        pdfDoc.setTitle('Confidential Tax Record for PAN ABCDE1234F');
        pdfDoc.setAuthor('aarav.sharma@fictional-univ.edu');
        pdfDoc.setSubject('Clean General Subject');
        pdfDoc.setKeywords(['REG-2026-CS-0492', '+91 9876543210']);

        const page = pdfDoc.addPage([595.28, 841.89]);
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        page.drawText('PUBLIC NOTICE: This visible page body contains zero personal identifiers.', {
          x: 50,
          y: 750,
          size: 12,
          font,
        });

        const buf = Buffer.from(await pdfDoc.save());
        const up = await uploadCustomPdfBuffer(buf, 'metadata_pii_test.pdf');
        assert.strictEqual(up.status, 201);
        const docId = up.body.documentId;

        const detRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId }),
        });
        const detBody = await detRes.json();
        assert.strictEqual(detRes.status, 200);

        // 1. Visible page-coordinate detections must remain 0
        assert.strictEqual(
          detBody.totalDetected,
          0,
          'Metadata PII must NOT be mixed into normal page-coordinate detections'
        );
        assert.strictEqual(detBody.items.length, 0);

        // 2. Verify structuralAudit.metadata and structuralAudit.metadataDetections
        const audit = detBody.structuralAudit;
        assert.ok(audit, 'Response must include structuralAudit');
        assert.strictEqual(audit.hasHiddenStructureRisks, true);
        assert.strictEqual(audit.metadata.hasInfoDictionary, true);
        assert.ok(audit.metadata.standardFields.Title.includes('ABCDE1234F'));
        assert.strictEqual(audit.metadata.standardFields.Author, 'aarav.sharma@fictional-univ.edu');

        const metaDets = audit.metadataDetections;
        assert.ok(Array.isArray(metaDets) && metaDets.length >= 4, 'Must detect PAN, Email, Reg No, and Phone in metadata');

        const titlePan = metaDets.find((d) => d.metadataField === 'Title' && d.category === 'NATIONAL_ID_PAN');
        const authorEmail = metaDets.find((d) => d.metadataField === 'Author' && d.category === 'EMAIL_ADDRESS');
        const kwReg = metaDets.find((d) => d.metadataField === 'Keywords' && d.category === 'STUDENT_REG_NUMBER');
        const kwPhone = metaDets.find((d) => d.metadataField === 'Keywords' && d.category === 'PHONE_NUMBER');

        assert.ok(titlePan && titlePan.text === 'ABCDE1234F', 'Must detect PAN in Title metadata');
        assert.ok(
          authorEmail && authorEmail.text === 'aarav.sharma@fictional-univ.edu',
          'Must detect Email in Author metadata'
        );
        assert.ok(kwReg && kwReg.text === 'REG-2026-CS-0492', 'Must detect Student Reg Number in Keywords metadata');
        assert.ok(kwPhone, 'Must detect Phone Number in Keywords metadata');

        // 3. Never invent page coordinates for metadata detections
        for (const md of metaDets) {
          assert.strictEqual(md.pageNumber, null, 'Metadata detection pageNumber must be null');
          assert.strictEqual(md.boundingBox, null, 'Metadata detection boundingBox must be null');
        }

        // 4. Verify explicit METADATA_SENSITIVE_DATA_DETECTED warning
        assert.strictEqual(
          audit.warnings.some((w) => w.code === 'METADATA_SENSITIVE_DATA_DETECTED'),
          true,
          'Must emit METADATA_SENSITIVE_DATA_DETECTED warning'
        );
      },
    },
    {
      name: '[P2.2 Test B] Custom Info Dictionary Fields and XMP Metadata Stream Inspection',
      fn: async () => {
        const pdfDoc = await PDFDocument.create();
        pdfDoc.setTitle('General Academic Circular');

        // Add custom field to the PDF /Info dictionary
        const infoRef = pdfDoc.context.trailerInfo.Info;
        const infoDict = pdfDoc.context.lookup(infoRef);
        infoDict.set(PDFName.of('ApplicantPAN'), PDFString.of('ZYXWV9876K'));
        infoDict.set(PDFName.of('BackupAadhaar'), PDFString.of('4829 7301 9482'));

        // Embed raw XMP metadata stream on the Catalog containing a synthetic email and phone number
        const xmpPacket = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
   <dc:creator><rdf:Seq><rdf:li>xmp.custodian@fictional-univ.edu</rdf:li></rdf:Seq></dc:creator>
   <pdf:Keywords>Emergency Contact +91 9876543210</pdf:Keywords>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta><?xpacket end="w"?>`;

        const xmpStream = pdfDoc.context.stream(xmpPacket, {
          Type: 'Metadata',
          Subtype: 'XML',
          Length: Buffer.byteLength(xmpPacket, 'utf8'),
        });
        pdfDoc.catalog.set(PDFName.of('Metadata'), pdfDoc.context.register(xmpStream));

        const page = pdfDoc.addPage([595.28, 841.89]);
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        page.drawText('Visible page with no sensitive information.', { x: 50, y: 750, size: 12, font });

        const buf = Buffer.from(await pdfDoc.save());
        const up = await uploadCustomPdfBuffer(buf, 'custom_and_xmp_meta.pdf');
        assert.strictEqual(up.status, 201);
        const docId = up.body.documentId;

        const detRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId }),
        });
        const detBody = await detRes.json();
        assert.strictEqual(detRes.status, 200);

        const audit = detBody.structuralAudit;
        assert.strictEqual(audit.metadata.hasXmpMetadata, true, 'Must detect presence of XMP metadata stream');
        assert.strictEqual(audit.metadata.customFields.ApplicantPAN, 'ZYXWV9876K', 'Must extract Custom Info field ApplicantPAN');
        assert.strictEqual(audit.metadata.customFields.BackupAadhaar, '4829 7301 9482', 'Must extract Custom Info field BackupAadhaar');

        const customPanDet = audit.metadataDetections.find(
          (d) => d.metadataField === 'Custom:ApplicantPAN' && d.text === 'ZYXWV9876K'
        );
        const customAadhaarDet = audit.metadataDetections.find(
          (d) => d.metadataField === 'Custom:BackupAadhaar' && d.text === '4829 7301 9482'
        );
        const xmpEmailDet = audit.metadataDetections.find(
          (d) => d.metadataField === 'XMP' && d.text === 'xmp.custodian@fictional-univ.edu'
        );
        const xmpPhoneDet = audit.metadataDetections.find(
          (d) => d.metadataField === 'XMP' && d.category === 'PHONE_NUMBER'
        );

        assert.ok(customPanDet, 'Must detect PAN inside Custom Info dictionary field');
        assert.ok(customAadhaarDet, 'Must detect Aadhaar inside Custom Info dictionary field');
        assert.ok(xmpEmailDet, 'Must detect Email inside XMP metadata stream');
        assert.ok(xmpPhoneDet, 'Must detect Phone Number inside XMP metadata stream');
      },
    },
    {
      name: '[P2.2 Test C] Catalog Embedded Attachment (/Names -> /EmbeddedFiles) with Synthetic Sensitive Filename & Uninspected Content Warning',
      fn: async () => {
        const pdfDoc = await PDFDocument.create();
        const page = pdfDoc.addPage([595.28, 841.89]);
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        page.drawText('Cover page with an embedded attachment in Catalog /EmbeddedFiles.', {
          x: 50,
          y: 750,
          size: 12,
          font,
        });

        // Attach an embedded file whose payload contains an email that must NOT be auto-extracted into page text,
        // and whose filename contains a synthetic Aadhaar (4829-7301-9482)
        await pdfDoc.attach(
          Buffer.from('Uninspected inside file payload: hidden.payload@fictional.org', 'utf8'),
          'aadhaar_4829-7301-9482_backup.txt',
          {
            mimeType: 'text/plain',
            description: 'Archive copy for PAN ABCDE1234F',
          }
        );

        const buf = Buffer.from(await pdfDoc.save());
        const up = await uploadCustomPdfBuffer(buf, 'catalog_attachment_test.pdf');
        assert.strictEqual(up.status, 201);
        const docId = up.body.documentId;

        const detRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId }),
        });
        const detBody = await detRes.json();
        assert.strictEqual(detRes.status, 200);

        // 1. Attachment payload ("hidden.payload@fictional.org") must NOT be added to normal page detections
        assert.strictEqual(
          detBody.items.some((i) => i.text.includes('hidden.payload@fictional.org')),
          false,
          'Uninspected attachment contents must NOT be added to normal page text detections'
        );

        // 2. Verify structuralAudit.attachments
        const attAudit = detBody.structuralAudit.attachments;
        assert.strictEqual(attAudit.hasAttachments, true);
        assert.strictEqual(attAudit.totalCount, 1);
        assert.strictEqual(attAudit.uninspectedCount, 1);
        assert.strictEqual(attAudit.status, 'ATTACHMENTS_DETECTED_UNINSPECTED');

        const attItem = attAudit.items[0];
        assert.strictEqual(attItem.filename, 'aadhaar_4829-7301-9482_backup.txt');
        assert.strictEqual(attItem.contentInspected, false, 'Attachment contentInspected must be false');
        assert.strictEqual(attItem.inspectionStatus, 'UNINSPECTED_ATTACHMENT_CONTENT');
        assert.strictEqual(attItem.hasSensitiveFilenameOrDescription, true);
        assert.strictEqual(
          attItem.sensitiveMetadataMatches.some((m) => m.category === 'NATIONAL_ID_AADHAAR' && m.text === '4829-7301-9482'),
          true,
          'Must detect synthetic Aadhaar in attachment filename'
        );
        assert.strictEqual(
          attItem.sensitiveMetadataMatches.some((m) => m.category === 'NATIONAL_ID_PAN' && m.text === 'ABCDE1234F'),
          true,
          'Must detect synthetic PAN in attachment description'
        );

        // 3. Verify explicit UNINSPECTED_EMBEDDED_ATTACHMENTS warning
        assert.strictEqual(
          detBody.structuralAudit.warnings.some((w) => w.code === 'UNINSPECTED_EMBEDDED_ATTACHMENTS'),
          true,
          'Must emit UNINSPECTED_EMBEDDED_ATTACHMENTS warning'
        );
      },
    },
    {
      name: '[P2.2 Test D] Page-Level FileAttachment Annotation Detection & Uninspected Content Warning',
      fn: async () => {
        const pdfDoc = await PDFDocument.create();
        const page = pdfDoc.addPage([595.28, 841.89]);
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        page.drawText('Page containing a FileAttachment annotation paperclip.', {
          x: 50,
          y: 750,
          size: 12,
          font,
        });

        const embeddedStream = pdfDoc.context.flateStream('uninspected binary attachment data', {
          Type: 'EmbeddedFile',
          Subtype: 'application/pdf',
        });
        const filespecDict = pdfDoc.context.obj({
          Type: 'Filespec',
          F: PDFString.of('student_REG-2026-CS-0492_transcript.pdf'),
          UF: PDFString.of('student_REG-2026-CS-0492_transcript.pdf'),
          Desc: PDFString.of('Transcript attachment for +91 9876543210'),
          EF: { F: pdfDoc.context.register(embeddedStream) },
        });
        const fileAttachAnnot = pdfDoc.context.obj({
          Type: 'Annot',
          Subtype: 'FileAttachment',
          Rect: [80, 620, 104, 644],
          FS: pdfDoc.context.register(filespecDict),
          Contents: PDFString.of('Attached transcript file'),
        });
        page.node.addAnnot(pdfDoc.context.register(fileAttachAnnot));

        const buf = Buffer.from(await pdfDoc.save());
        const up = await uploadCustomPdfBuffer(buf, 'page_file_attachment_test.pdf');
        assert.strictEqual(up.status, 201);
        const docId = up.body.documentId;

        const detRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId }),
        });
        const detBody = await detRes.json();
        assert.strictEqual(detRes.status, 200);

        const attAudit = detBody.structuralAudit.attachments;
        assert.strictEqual(attAudit.hasAttachments, true);
        assert.ok(attAudit.totalCount >= 1, 'Must detect page-level FileAttachment annotation');

        const pageAtt = attAudit.items.find((a) => a.source === 'page-file-attachment');
        assert.ok(pageAtt, 'Must classify annotation as source: "page-file-attachment"');
        assert.strictEqual(pageAtt.pageNumber, 1);
        assert.strictEqual(pageAtt.filename, 'student_REG-2026-CS-0492_transcript.pdf');
        assert.strictEqual(pageAtt.contentInspected, false);
        assert.strictEqual(pageAtt.inspectionStatus, 'UNINSPECTED_ATTACHMENT_CONTENT');
        assert.strictEqual(
          pageAtt.sensitiveMetadataMatches.some((m) => m.text === 'REG-2026-CS-0492'),
          true,
          'Must detect Student Registration Number in FileAttachment filename'
        );
        assert.strictEqual(
          detBody.structuralAudit.warnings.some((w) => w.code === 'UNINSPECTED_EMBEDDED_ATTACHMENTS'),
          true
        );
      },
    },
    {
      name: '[P2.2 Test E] Incrementally Updated PDF Containing an Earlier Synthetic Sensitive Value',
      fn: async () => {
        // Revision 1: PDF page contains synthetic PAN ABCDE1234F
        const pdfDoc = await PDFDocument.create();
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const page = pdfDoc.addPage([595.28, 841.89]);
        page.drawText('Earlier revision secret PAN: ABCDE1234F', { x: 50, y: 700, size: 12, font });

        const rev1Bytes = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
        const rev1Str = rev1Bytes.toString('latin1');

        const startxrefMatch = /startxref\s+(\d+)/.exec(rev1Str);
        const rev1XrefOffset = Number(startxrefMatch[1]);
        const fontNameMatch = /\/(Helvetica-[0-9]+)\s+4\s+0\s+R/.exec(rev1Str);
        const fontKey = fontNameMatch ? fontNameMatch[1] : 'F1';

        // Revision 2 (Incremental Update): Overwrite object 6 (page content stream) with clean public text
        const newStreamContent = `BT /${fontKey} 12 Tf 50 700 Td (Updated public text with no sensitive items) Tj ET`;
        const obj6Offset = rev1Bytes.length + 1;
        const obj6Block = `\n6 0 obj\n<</Length ${newStreamContent.length}>>\nstream\n${newStreamContent}\nendstream\nendobj\n`;
        const rev2XrefOffset = rev1Bytes.length + Buffer.byteLength(obj6Block, 'latin1');
        const pad10 = String(obj6Offset).padStart(10, '0');
        const incrementalTail =
          `xref\n0 1\n0000000000 65535 f \n6 1\n${pad10} 00000 n \n` +
          `trailer\n<</Size 7/Root 2 0 R/Info 3 0 R/Prev ${rev1XrefOffset}>>\n` +
          `startxref\n${rev2XrefOffset}\n%%EOF\n`;

        const incrementalPdfBuf = Buffer.concat([
          rev1Bytes,
          Buffer.from(obj6Block + incrementalTail, 'latin1'),
        ]);

        const up = await uploadCustomPdfBuffer(incrementalPdfBuf, 'incremental_update_leak.pdf');
        assert.strictEqual(up.status, 201);
        const docId = up.body.documentId;

        const detRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId }),
        });
        const detBody = await detRes.json();
        assert.strictEqual(detRes.status, 200);

        // Current visible page text has 0 detections
        assert.strictEqual(detBody.totalDetected, 0, 'Latest visible revision has no page-level PII');

        // Verify incremental revision audit detects the earlier revision and its hidden PAN
        const revAudit = detBody.structuralAudit.revisions;
        assert.strictEqual(revAudit.status, 'DETECTED');
        assert.strictEqual(revAudit.incrementalUpdatesDetected, true);
        assert.strictEqual(revAudit.confidence, 'HIGH');
        assert.strictEqual(revAudit.revisionCount, 2);
        assert.strictEqual(revAudit.prevCount, 1);
        assert.strictEqual(revAudit.startxrefCount, 2);

        const histPan = revAudit.historicalDetections.find(
          (d) => d.category === 'NATIONAL_ID_PAN' && d.text === 'ABCDE1234F'
        );
        assert.ok(histPan, 'Must detect earlier revision synthetic PAN (ABCDE1234F) in historicalDetections');
        assert.strictEqual(histPan.revisionNumber, 1);
        assert.strictEqual(histPan.boundingBox, null);

        assert.strictEqual(
          detBody.structuralAudit.warnings.some((w) => w.code === 'INCREMENTAL_REVISIONS_DETECTED'),
          true,
          'Must emit INCREMENTAL_REVISIONS_DETECTED warning'
        );
        assert.strictEqual(
          detBody.structuralAudit.warnings.some((w) => w.code === 'HISTORICAL_REVISION_SENSITIVE_DATA_DETECTED'),
          true,
          'Must emit HISTORICAL_REVISION_SENSITIVE_DATA_DETECTED warning'
        );
      },
    },
    {
      name: '[P2.2 Test F] Linearized PDF Must Not Automatically Be Classified as Incrementally Updated',
      fn: async () => {
        const pdfDoc = await PDFDocument.create();
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const page = pdfDoc.addPage([500, 500]);
        page.drawText('Linearized Fast Web View Document (Synthetic Clean Text)', {
          x: 50,
          y: 400,
          size: 12,
          font,
        });

        const baseBytes = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
        const baseStr = baseBytes.toString('latin1');
        const headerEnd = baseStr.indexOf('1 0 obj');
        const headerPart = baseStr.slice(0, headerEnd);
        const bodyAndTail = baseStr.slice(headerEnd);

        // Insert a standard 260-byte Linearized parameter dictionary + first-page xref section
        const SHIFT = 260;
        const origStartxref = Number(/startxref\s+(\d+)/.exec(bodyAndTail)[1]);
        const newMainXref = origStartxref + SHIFT;
        const totalLen = baseBytes.length + SHIFT;

        const shiftedBodyAndTail = bodyAndTail
          .replace(/(\d{10}) 00000 n /g, (_m, offStr) => {
            return String(Number(offStr) + SHIFT).padStart(10, '0') + ' 00000 n ';
          })
          .replace(/startxref\s+\d+/, `startxref\n${newMainXref}`);

        let preamble =
          `99 0 obj\n<</Linearized 1/L ${totalLen}/H [ 120 60 ]/O 5/E 500/N 1/T ${newMainXref}>>\nendobj\n` +
          `xref\n99 1\n${String(headerPart.length).padStart(10, '0')} 00000 n \n` +
          `trailer\n<</Size 100/Root 2 0 R/Info 3 0 R/Prev ${newMainXref}>>\nstartxref\n0\n%%EOF\n`;
        const padNeeded = SHIFT - Buffer.byteLength(preamble, 'latin1');
        preamble = preamble.replace('%%EOF\n', '%%EOF' + ' '.repeat(padNeeded) + '\n');

        const linearizedBuf = Buffer.from(headerPart + preamble + shiftedBodyAndTail, 'latin1');

        const up = await uploadCustomPdfBuffer(linearizedBuf, 'linearized_clean.pdf');
        assert.strictEqual(up.status, 201);
        const docId = up.body.documentId;

        const detRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId }),
        });
        const detBody = await detRes.json();
        assert.strictEqual(detRes.status, 200);

        const revAudit = detBody.structuralAudit.revisions;
        assert.strictEqual(revAudit.isLinearized, true, 'Must identify PDF as linearized');
        assert.strictEqual(
          revAudit.status,
          'NOT_DETECTED',
          `Linearized PDF must NOT be falsely classified as incrementally updated (got status="${revAudit.status}", reason="${revAudit.reason}")`
        );
        assert.strictEqual(revAudit.incrementalUpdatesDetected, false);
        assert.strictEqual(revAudit.confidence, 'HIGH');
        assert.strictEqual(
          detBody.structuralAudit.warnings.some((w) => w.code === 'INCREMENTAL_REVISIONS_DETECTED'),
          false,
          'Must not emit INCREMENTAL_REVISIONS_DETECTED warning for a clean linearized PDF'
        );
      },
    },
    {
      name: '[P2.2 Test G] Malformed Revision Structure Returns INDETERMINATE Status Rather Than False Clean Result',
      fn: async () => {
        const pdfDoc = await PDFDocument.create();
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const page = pdfDoc.addPage([500, 500]);
        page.drawText('Document with damaged trailer /Prev and startxref offsets.', {
          x: 50,
          y: 400,
          size: 12,
          font,
        });

        const baseBytes = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
        const baseStr = baseBytes.toString('latin1');

        // Corrupt the trailer by adding an out-of-bounds /Prev 999999 and invalid startxref 888888
        // (PDF.js recovers the page via its internal XRef recovery scanner, while our revision inspector catches the anomaly)
        const malformedStr = baseStr
          .replace('/Root 2 0 R', '/Root 2 0 R/Prev 999999')
          .replace(/startxref\s+\d+/, 'startxref\n888888');
        const malformedBuf = Buffer.from(malformedStr, 'latin1');

        const up = await uploadCustomPdfBuffer(malformedBuf, 'malformed_revisions.pdf');
        assert.strictEqual(up.status, 201);
        const docId = up.body.documentId;

        const detRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId }),
        });
        const detBody = await detRes.json();
        assert.strictEqual(detRes.status, 200);

        const revAudit = detBody.structuralAudit.revisions;
        assert.strictEqual(
          revAudit.status,
          'INDETERMINATE',
          `Malformed revision structure must return status "INDETERMINATE", got "${revAudit.status}"`
        );
        assert.strictEqual(revAudit.incrementalUpdatesDetected, null);
        assert.strictEqual(revAudit.confidence, 'LOW_UNCERTAIN');
        assert.ok(revAudit.reason.includes('Malformed or inconsistent PDF revision structure'));

        assert.strictEqual(
          detBody.structuralAudit.warnings.some((w) => w.code === 'INDETERMINATE_REVISION_STRUCTURE'),
          true,
          'Must emit INDETERMINATE_REVISION_STRUCTURE warning rather than a false clean result'
        );
      },
    },

    // =========================================================================
    // P2.3 POST-REDACTION STRUCTURAL VERIFICATION REGRESSION TESTS
    // =========================================================================
    {
      name: '[P2.3 Test A] Sensitive Metadata, Custom /Info, and XMP Removed and Verified After Redaction',
      fn: async () => {
        const pdfDoc = await PDFDocument.create();
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const page = pdfDoc.addPage([595.28, 841.89]);
        page.drawText('Visible Student Aadhaar: 4829 7301 9482', {
          x: 50,
          y: 740,
          size: 12,
          font,
        });

        // Standard /Info metadata with sensitive PII
        pdfDoc.setTitle('Confidential Financial & Identity Record');
        pdfDoc.setAuthor('Ananya Sharma (ananya.sharma@fictional-univ.edu)');
        pdfDoc.setSubject('Tax PAN ABCDE1234F and Mobile +91 9876543210');
        pdfDoc.setKeywords(['IFSC SBIN0001234', 'REG-2026-CS-0492']);

        // Custom /Info dictionary fields with sensitive PII
        const infoDict = pdfDoc.getInfoDict();
        infoDict.set(PDFName.of('EmployeePAN'), PDFString.of('ZXCVB9876K'));
        infoDict.set(PDFName.of('BackupPhone'), PDFString.of('+91 9123456789'));

        // Raw XMP /Metadata stream with sensitive PII
        const xmpXml = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:description>Hidden XMP Aadhaar 5839 2019 4821 and email xmp.secret@example.org</dc:description>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
        const metaStream = pdfDoc.context.stream(xmpXml, {
          Type: 'Metadata',
          Subtype: 'XML',
          Length: Buffer.byteLength(xmpXml, 'utf8'),
        });
        pdfDoc.catalog.set(PDFName.of('Metadata'), pdfDoc.context.register(metaStream));

        const pdfBuffer = Buffer.from(await pdfDoc.save());
        const up = await uploadCustomPdfBuffer(pdfBuffer, 'p23_metadata_xmp_test.pdf');
        assert.strictEqual(up.status, 201);
        const docId = up.body.documentId;

        const detRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId }),
        });
        const detBody = await detRes.json();
        assert.strictEqual(detRes.status, 200);
        assert.strictEqual(detBody.totalDetected, 1, 'Only the 1 on-page Aadhaar has page coordinates');
        assert.ok(
          detBody.structuralAudit.metadataDetections.length >= 6,
          `Expected >= 6 metadata detections before redaction, got ${detBody.structuralAudit.metadataDetections.length}`
        );

        // Metadata detections without page coordinates must NOT cause false redaction failures
        const redRes = await fetch(`${baseUrl}/api/redact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, mode: 'automatic' }),
        });
        assert.strictEqual(
          redRes.status,
          200,
          'Automatic redaction must succeed and strip metadata by rebuilding the PDF'
        );

        const verRes = await fetch(`${baseUrl}/api/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, runOcrCheck: true }),
        });
        const verBody = await verRes.json();
        assert.strictEqual(verRes.status, 200);

        // Verify both OCR and Structural Verification pass and are separately visible
        assert.strictEqual(verBody.verified, true);
        assert.strictEqual(verBody.status, 'PASSED');
        assert.strictEqual(verBody.ocrVerification.status, 'PASSED');
        assert.strictEqual(verBody.structuralVerification.status, 'PASSED');

        const metaCheck = verBody.structuralVerification.checks.metadata;
        assert.strictEqual(metaCheck.status, 'PASSED');
        assert.strictEqual(metaCheck.verified, true);
        assert.strictEqual(metaCheck.hasXmpMetadata, false, 'XMP metadata must be absent in exported PDF');
        assert.strictEqual(
          metaCheck.survivingCustomFieldKeys.length,
          0,
          'Custom /Info entries must be absent in exported PDF'
        );
        assert.strictEqual(
          metaCheck.unexpectedStandardFields.length,
          0,
          'No non-allowlisted standard metadata fields may survive'
        );
        assert.strictEqual(
          metaCheck.survivingSensitiveMetadata.length,
          0,
          '0 sensitive metadata matches may survive in exported PDF'
        );
        assert.strictEqual(metaCheck.survivingOriginalMetadataCount, 0);
        assert.ok(
          metaCheck.originalSensitiveMetadataRemovedCount >= 6,
          'Must confirm all original sensitive metadata items were removed'
        );
        assert.strictEqual(metaCheck.onlyAllowedDocShieldMetadataPresent, true);
        assert.strictEqual(metaCheck.standardFields.Title, 'DocShield Protected Document');
        assert.strictEqual(metaCheck.standardFields.Author, null);
        assert.strictEqual(metaCheck.standardFields.Subject, null);
        assert.strictEqual(metaCheck.standardFields.Keywords, null);
      },
    },
    {
      name: '[P2.3 Test B] Embedded Attachments & FileAttachment Annotations Removed and Verified (Prior Uninspected Content Reported)',
      fn: async () => {
        const pdfDoc = await PDFDocument.create();
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const page = pdfDoc.addPage([595.28, 841.89]);
        page.drawText('Document with catalog attachment and page FileAttachment annotation.', {
          x: 50,
          y: 740,
          size: 12,
          font,
        });
        page.drawText('Visible Phone: +91 9876543210', {
          x: 50,
          y: 700,
          size: 12,
          font,
        });

        // 1. Add catalog embedded attachment (/Names -> /EmbeddedFiles)
        await pdfDoc.attach(
          Buffer.from('uninspected catalog attachment payload', 'utf8'),
          'aadhaar_4829-7301-9482_backup.txt',
          {
            mimeType: 'text/plain',
            description: 'Catalog attachment for PAN ABCDE1234F',
          }
        );

        // 2. Add page-level FileAttachment annotation
        const embeddedStream = pdfDoc.context.flateStream('uninspected page attachment payload', {
          Type: 'EmbeddedFile',
          Subtype: 'application/pdf',
        });
        const filespecDict = pdfDoc.context.obj({
          Type: 'Filespec',
          F: PDFString.of('student_REG-2026-CS-0492_transcript.pdf'),
          UF: PDFString.of('student_REG-2026-CS-0492_transcript.pdf'),
          Desc: PDFString.of('Page FileAttachment annotation'),
          EF: { F: pdfDoc.context.register(embeddedStream) },
        });
        const fileAttachAnnot = pdfDoc.context.obj({
          Type: 'Annot',
          Subtype: 'FileAttachment',
          Rect: [80, 620, 104, 644],
          FS: pdfDoc.context.register(filespecDict),
          Contents: PDFString.of('Attached transcript file'),
        });
        page.node.addAnnot(pdfDoc.context.register(fileAttachAnnot));

        const pdfBuffer = Buffer.from(await pdfDoc.save());
        const up = await uploadCustomPdfBuffer(pdfBuffer, 'p23_attachments_test.pdf');
        assert.strictEqual(up.status, 201);
        const docId = up.body.documentId;

        const detRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId }),
        });
        const detBody = await detRes.json();
        assert.strictEqual(detRes.status, 200);
        assert.strictEqual(detBody.structuralAudit.attachments.totalCount, 2);

        const redRes = await fetch(`${baseUrl}/api/redact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, mode: 'automatic' }),
        });
        assert.strictEqual(redRes.status, 200);

        const verRes = await fetch(`${baseUrl}/api/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, runOcrCheck: true }),
        });
        const verBody = await verRes.json();
        assert.strictEqual(verRes.status, 200);
        assert.strictEqual(verBody.verified, true);
        assert.strictEqual(verBody.structuralVerification.status, 'PASSED');

        const attCheck = verBody.structuralVerification.checks.attachments;
        assert.strictEqual(attCheck.status, 'PASSED');
        assert.strictEqual(attCheck.verified, true);
        assert.strictEqual(attCheck.remainingAttachmentCount, 0);
        assert.strictEqual(attCheck.hasCatalogEmbeddedFilesNameTree, false);
        assert.strictEqual(attCheck.isPortfolioCollection, false);
        assert.strictEqual(attCheck.hasAssociatedFiles, false);

        // Must explicitly report that original attachments had uninspected content before removal
        assert.strictEqual(
          attCheck.hadUninspectedAttachmentsBeforeRedaction,
          true,
          'Must flag hadUninspectedAttachmentsBeforeRedaction = true'
        );
        assert.strictEqual(
          attCheck.removedAttachmentsWithUninspectedContent.length,
          2,
          'Must list both removed attachments whose contents were uninspected prior to removal'
        );
        for (const remAtt of attCheck.removedAttachmentsWithUninspectedContent) {
          assert.strictEqual(remAtt.contentInspectedBeforeRedaction, false);
          assert.strictEqual(remAtt.removedFromExportedPdf, true);
          assert.strictEqual(remAtt.status, 'REMOVED_FROM_EXPORT_PRIOR_CONTENT_UNINSPECTED');
        }
        assert.ok(
          attCheck.uninspectedPriorContentNotice &&
            attCheck.uninspectedPriorContentNotice.includes('not inspected prior to redaction'),
          'Must include explicit uninspectedPriorContentNotice'
        );
        assert.strictEqual(
          verBody.structuralVerification.warnings.some(
            (w) => w.code === 'PRIOR_UNINSPECTED_ATTACHMENT_REMOVED'
          ),
          true,
          'Must emit PRIOR_UNINSPECTED_ATTACHMENT_REMOVED notice in structuralVerification.warnings'
        );
      },
    },
    {
      name: '[P2.3 Test C] AcroForm Fields and Annotations (Widget, FreeText, Stamp, Redact, Caret) Removed and Verified After Redaction',
      fn: async () => {
        const pdfDoc = await PDFDocument.create();
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const page = pdfDoc.addPage([595.28, 841.89]);
        page.drawText('Form and Annotation Structural Verification Test', {
          x: 50,
          y: 780,
          size: 13,
          font,
        });

        // 1. AcroForm Text Widget containing synthetic PAN
        const form = pdfDoc.getForm();
        const panField = form.createTextField('applicant.pan');
        panField.setText('ABCDE1234F');
        panField.addToPage(page, { x: 60, y: 700, width: 200, height: 26 });

        // 2. Stamp, Redact, Caret, and Link annotations (without unlocatable PII text so automatic redaction succeeds)
        for (const [idx, subtype] of ['Stamp', 'Redact', 'Caret'].entries()) {
          const annot = pdfDoc.context.obj({
            Type: 'Annot',
            Subtype: subtype,
            Rect: [60 + idx * 80, 620, 120 + idx * 80, 650],
          });
          page.node.addAnnot(pdfDoc.context.register(annot));
        }

        const linkAnnot = pdfDoc.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [60, 560, 240, 585],
          A: pdfDoc.context.obj({
            Type: 'Action',
            S: 'URI',
            URI: PDFString.of('https://example.edu/portal'),
          }),
        });
        page.node.addAnnot(pdfDoc.context.register(linkAnnot));

        const pdfBuffer = Buffer.from(await pdfDoc.save());
        const up = await uploadCustomPdfBuffer(pdfBuffer, 'p23_annotations_forms_test.pdf');
        assert.strictEqual(up.status, 201);
        const docId = up.body.documentId;

        const detRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId }),
        });
        const detBody = await detRes.json();
        assert.strictEqual(detRes.status, 200);
        assert.strictEqual(detBody.totalDetected, 1, 'Must detect PAN inside AcroForm widget');

        const redRes = await fetch(`${baseUrl}/api/redact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, mode: 'automatic' }),
        });
        assert.strictEqual(redRes.status, 200);

        const verRes = await fetch(`${baseUrl}/api/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, runOcrCheck: true }),
        });
        const verBody = await verRes.json();
        assert.strictEqual(verRes.status, 200);
        assert.strictEqual(verBody.verified, true);

        const annCheck = verBody.structuralVerification.checks.annotationsAndForms;
        assert.strictEqual(annCheck.status, 'PASSED');
        assert.strictEqual(annCheck.verified, true);
        assert.strictEqual(annCheck.remainingAnnotationCount, 0, '0 annotations may remain in exported PDF');
        assert.strictEqual(annCheck.acroFormFieldCount, 0, '0 AcroForm fields may remain in exported PDF');
        assert.strictEqual(annCheck.hasAcroFormCatalogEntry, false, 'Catalog /AcroForm must be absent');
        assert.strictEqual(annCheck.hasWidgetAnnotations, false, 'Widget annotations must be absent');
      },
    },
    {
      name: '[P2.3 Test D] Incremental Revisions Containing Earlier Sensitive Text Removed and Verified After Redaction',
      fn: async () => {
        // Revision 1: PDF page contains earlier synthetic PAN ABCDE1234F
        const pdfDoc = await PDFDocument.create();
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const page = pdfDoc.addPage([595.28, 841.89]);
        page.drawText('Earlier revision secret PAN: ABCDE1234F', { x: 50, y: 700, size: 12, font });

        const rev1Bytes = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
        const rev1Str = rev1Bytes.toString('latin1');
        const startxrefMatch = /startxref\s+(\d+)/.exec(rev1Str);
        const rev1XrefOffset = Number(startxrefMatch[1]);
        const fontNameMatch = /\/(Helvetica-[0-9]+)\s+4\s+0\s+R/.exec(rev1Str);
        const fontKey = fontNameMatch ? fontNameMatch[1] : 'F1';

        // Revision 2 (Incremental Update): Overwrite page content stream with clean public text
        const newStreamContent = `BT /${fontKey} 12 Tf 50 700 Td (Current revision public text only) Tj ET`;
        const obj6Offset = rev1Bytes.length + 1;
        const obj6Block = `\n6 0 obj\n<</Length ${newStreamContent.length}>>\nstream\n${newStreamContent}\nendstream\nendobj\n`;
        const rev2XrefOffset = rev1Bytes.length + Buffer.byteLength(obj6Block, 'latin1');
        const pad10 = String(obj6Offset).padStart(10, '0');
        const incrementalTail =
          `xref\n0 1\n0000000000 65535 f \n6 1\n${pad10} 00000 n \n` +
          `trailer\n<</Size 7/Root 2 0 R/Info 3 0 R/Prev ${rev1XrefOffset}>>\n` +
          `startxref\n${rev2XrefOffset}\n%%EOF\n`;

        const incrementalPdfBuf = Buffer.concat([
          rev1Bytes,
          Buffer.from(obj6Block + incrementalTail, 'latin1'),
        ]);

        const up = await uploadCustomPdfBuffer(incrementalPdfBuf, 'p23_incremental_revision_test.pdf');
        assert.strictEqual(up.status, 201);
        const docId = up.body.documentId;

        const detRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId }),
        });
        const detBody = await detRes.json();
        assert.strictEqual(detRes.status, 200);
        assert.strictEqual(detBody.structuralAudit.revisions.status, 'DETECTED');
        assert.strictEqual(detBody.structuralAudit.revisions.revisionCount, 2);

        const redRes = await fetch(`${baseUrl}/api/redact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, mode: 'automatic' }),
        });
        assert.strictEqual(redRes.status, 200);

        const verRes = await fetch(`${baseUrl}/api/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, runOcrCheck: true }),
        });
        const verBody = await verRes.json();
        assert.strictEqual(verRes.status, 200);
        assert.strictEqual(verBody.verified, true);
        assert.strictEqual(verBody.structuralVerification.status, 'PASSED');

        const revCheck = verBody.structuralVerification.checks.revisions;
        assert.strictEqual(revCheck.status, 'PASSED');
        assert.strictEqual(revCheck.verified, true);
        assert.strictEqual(revCheck.incrementalUpdatesDetected, false);
        assert.strictEqual(revCheck.revisionCount, 1);
        assert.strictEqual(revCheck.prevCount, 0);
        assert.strictEqual(revCheck.startxrefCount, 1);
        assert.strictEqual(revCheck.xrefSectionCount, 1);
      },
    },
    {
      name: '[P2.3 Test E] Text-Layer Removal Verification & Fail-Safe Negative Checks (FAILED and INDETERMINATE Block Overall Verification)',
      fn: async () => {
        // 1. Verify that a normal DocShield redacted export has 0 selectable text items and 0 PDF text operators
        const pdfDoc = await PDFDocument.create();
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const page = pdfDoc.addPage([595.28, 841.89]);
        page.drawText('Selectable Text Before Redaction: PAN ABCDE1234F', {
          x: 50,
          y: 720,
          size: 12,
          font,
        });
        const origBuf = Buffer.from(await pdfDoc.save());

        const up = await uploadCustomPdfBuffer(origBuf, 'p23_text_layer_test.pdf');
        assert.strictEqual(up.status, 201);
        const docId = up.body.documentId;

        await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId }),
        });
        await fetch(`${baseUrl}/api/redact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, mode: 'automatic' }),
        });

        const verRes = await fetch(`${baseUrl}/api/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, runOcrCheck: true }),
        });
        const verBody = await verRes.json();
        assert.strictEqual(verRes.status, 200);

        const txtCheck = verBody.structuralVerification.checks.textLayer;
        assert.strictEqual(txtCheck.status, 'PASSED');
        assert.strictEqual(txtCheck.verified, true);
        assert.strictEqual(txtCheck.selectableTextItemCount, 0);
        assert.strictEqual(txtCheck.selectableCharacterCount, 0);
        assert.strictEqual(txtCheck.pageTextOperatorCount, 0);
        assert.strictEqual(txtCheck.rawStreamTextBlockCount, 0);

        // 2. Negative Verification Check: If an exported PDF still contains a selectable text layer,
        //    non-allowlisted metadata, and an AcroForm widget, structuralVerification MUST return FAILED
        //    and overall verification.verified MUST be false.
        const rec = getDocumentRecord(docId);
        const unsanitizedDoc = await PDFDocument.create();
        const unsanitizedFont = await unsanitizedDoc.embedFont(StandardFonts.Helvetica);
        const unsanitizedPage = unsanitizedDoc.addPage([500, 500]);
        unsanitizedPage.drawText('Surviving selectable text object', {
          x: 50,
          y: 400,
          size: 12,
          font: unsanitizedFont,
        });
        unsanitizedDoc.setAuthor('Leaked Author Name');
        const unsanitizedForm = unsanitizedDoc.getForm();
        const leakedWidget = unsanitizedForm.createTextField('leaked.field');
        leakedWidget.setText('surviving widget');
        leakedWidget.addToPage(unsanitizedPage, { x: 50, y: 300, width: 150, height: 24 });

        const tempUnsanitizedPath = `${rec.redactedFilePath}.unsanitized_test.pdf`;
        createdSampleFiles.add(tempUnsanitizedPath);
        await fs.promises.writeFile(tempUnsanitizedPath, Buffer.from(await unsanitizedDoc.save()));

        const failedVerResult = await verifyRedactedPdf(tempUnsanitizedPath, [], [], false, null);
        assert.strictEqual(
          failedVerResult.ocrVerification.status,
          'PASSED',
          'Even when 0 selected items fail OCR, structural failure must block overall pass'
        );
        assert.strictEqual(failedVerResult.structuralVerification.status, 'FAILED');
        assert.strictEqual(failedVerResult.structuralVerification.verified, false);
        assert.strictEqual(failedVerResult.structuralVerification.checks.metadata.status, 'FAILED');
        assert.strictEqual(
          failedVerResult.structuralVerification.checks.annotationsAndForms.status,
          'FAILED'
        );
        assert.strictEqual(failedVerResult.structuralVerification.checks.textLayer.status, 'FAILED');
        assert.strictEqual(
          failedVerResult.verified,
          false,
          'Overall verification.verified MUST be false when any structural check fails'
        );
        assert.strictEqual(failedVerResult.status, 'FAILED');

        // 3. Fail-Safe Indeterminate Check: Unexpected inspection errors must NEVER be treated as PASSED
        const indetResult = await verifyRedactedPdf(
          rec.redactedFilePath,
          [],
          [],
          false,
          null,
          {
            simulateCheckErrors: {
              attachments: 'Simulated attachment parser error',
            },
          }
        );
        assert.strictEqual(indetResult.structuralVerification.checks.attachments.status, 'INDETERMINATE');
        assert.strictEqual(indetResult.structuralVerification.status, 'INDETERMINATE');
        assert.strictEqual(indetResult.structuralVerification.verified, false);
        assert.strictEqual(
          indetResult.verified,
          false,
          'Overall verification.verified MUST be false when any structural check is INDETERMINATE'
        );
        assert.strictEqual(indetResult.status, 'INDETERMINATE');
      },
    },
    {
      name: '[P2.3 Test F] Clean PDF Passing All OCR and Structural Verification Checks End-to-End',
      fn: async () => {
        const up = await uploadSampleFile('clean-doc');
        assert.strictEqual(up.status, 201);
        const docId = up.body.documentId;

        const detRes = await fetch(`${baseUrl}/api/detect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId }),
        });
        const detBody = await detRes.json();
        assert.strictEqual(detRes.status, 200);
        assert.strictEqual(detBody.totalDetected, 0);

        const redRes = await fetch(`${baseUrl}/api/redact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, mode: 'automatic' }),
        });
        assert.strictEqual(redRes.status, 200);

        const verRes = await fetch(`${baseUrl}/api/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId: docId, runOcrCheck: true }),
        });
        const verBody = await verRes.json();
        assert.strictEqual(verRes.status, 200);

        assert.strictEqual(verBody.verified, true);
        assert.strictEqual(verBody.status, 'PASSED');
        assert.strictEqual(verBody.ocrVerification.status, 'PASSED');
        assert.strictEqual(verBody.ocrVerification.verified, true);
        assert.strictEqual(verBody.structuralVerification.status, 'PASSED');
        assert.strictEqual(verBody.structuralVerification.verified, true);

        for (const checkKey of [
          'metadata',
          'attachments',
          'annotationsAndForms',
          'revisions',
          'textLayer',
        ]) {
          assert.strictEqual(
            verBody.structuralVerification.checks[checkKey].status,
            'PASSED',
            `Expected structural check "${checkKey}" to be PASSED`
          );
        }

        // Verify GET /api/report/:id includes both ocrVerification and structuralVerification separately
        const repRes = await fetch(`${baseUrl}/api/report/${verBody.reportId}`);
        const repBody = await repRes.json();
        assert.strictEqual(repRes.status, 200);
        assert.strictEqual(repBody.report.verified, true);
        assert.strictEqual(repBody.report.verificationStatus, 'PASSED');
        assert.strictEqual(repBody.report.ocrVerification.status, 'PASSED');
        assert.strictEqual(repBody.report.structuralVerification.status, 'PASSED');
        assert.strictEqual(repBody.report.verificationDetails.ocrVerification.status, 'PASSED');
        assert.strictEqual(repBody.report.verificationDetails.structuralVerification.status, 'PASSED');
      },
    },
  ];

  const results = testDefinitions.map((t) => ({
    name: t.name,
    status: 'NOT_EXECUTED',
    error: null,
  }));

  try {
    for (let i = 0; i < testDefinitions.length; i++) {
      const def = testDefinitions[i];
      console.log(`▶ Running: ${def.name}...`);
      try {
        await def.fn();
        results[i].status = 'PASSED';
        console.log(`  ✅ PASSED: ${def.name}\n`);
      } catch (err) {
        results[i].status = 'FAILED';
        results[i].error = err;
        console.error(`  ❌ FAILED: ${def.name}`);
        console.error(`     Message: ${err.message}\n`);
      }
    }
  } finally {
    // Clean up all generated sample files and tracked document files
    for (const filePath of createdSampleFiles) {
      await safeDeleteFile(filePath);
    }
    for (const docId of trackedDocumentIds) {
      const rec = getDocumentRecord(docId);
      if (rec) {
        await safeDeleteFile(rec.originalFilePath);
        await safeDeleteFile(rec.redactedFilePath);
      }
    }
    const origRetention = config.upload.fileRetentionMs;
    try {
      config.upload.fileRetentionMs = -1;
      await cleanupExpiredFiles();
    } finally {
      config.upload.fileRetentionMs = origRetention;
    }
    server.close();
  }

  const passedCount = results.filter((r) => r.status === 'PASSED').length;
  const failedCount = results.filter((r) => r.status === 'FAILED').length;
  const notExecutedCount = results.filter((r) => r.status === 'NOT_EXECUTED').length;

  console.log('================================================================');
  console.log('📊 DOCSHIELD TEST SUITE EXECUTION SUMMARY');
  console.log('================================================================');
  console.log(`Total Tests:   ${results.length}`);
  console.log(`Passed:        ${passedCount}`);
  console.log(`Failed:        ${failedCount}`);
  console.log(`Not Executed:  ${notExecutedCount}`);
  console.log('----------------------------------------------------------------');
  for (const r of results) {
    console.log(`- [${r.status}] ${r.name}`);
    if (r.error) {
      console.log(`    Error: ${r.error.stack || r.error.message}`);
    }
  }
  console.log('================================================================');

  if (failedCount > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('❌ Unhandled test runner error:', err);
  process.exit(1);
});
