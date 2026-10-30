import assert from 'assert';
import fs from 'fs';
import { createApp } from '../server.js';
import { generateSamplePdfFile } from '../extraction/samples.js';

/**
 * Automated End-to-End Test Suite for DocShield Backend
 *
 * Tests all 6 required hackathon scenarios:
 * 1. A text-based marks card containing fictional sensitive information.
 * 2. A scanned PDF requiring OCR (Tesseract.js fallback).
 * 3. A document containing multiple sensitive information categories.
 * 4. A document containing no detectable sensitive information.
 * 5. A corrupted or unsupported PDF.
 * 6. A PDF after redaction (both selective and automatic) to verify whether selected information remains detectable, plus SHA-256 report verification.
 */

async function runTests() {
  console.log('================================================================');
  console.log('🛡️  DocShield – Automated End-to-End Backend Test Suite');
  console.log('================================================================\n');

  const app = await createApp();
  const server = app.listen(0);
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // 0. Health & Swagger OpenAPI specification check
    console.log('▶ [Phase 1 Check] Testing GET /api/health and GET /api-docs...');
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.strictEqual(healthRes.status, 200, 'Health endpoint should return 200');
    const healthJson = await healthRes.json();
    assert.strictEqual(healthJson.status, 'ok');

    const docsRes = await fetch(`${baseUrl}/api-docs/`);
    assert.strictEqual(docsRes.status, 200, 'Swagger UI at /api-docs/ should return 200');
    console.log('  ✅ Health check and Swagger UI (/api-docs) are operational.\n');

    // Helper for multipart file upload via fetch FormData
    async function uploadSampleFile(sampleId) {
      const sample = await generateSamplePdfFile(sampleId);
      const buffer = await fs.promises.readFile(sample.filePath);
      const formData = new FormData();
      const blob = new Blob([buffer], { type: 'application/pdf' });
      formData.append('file', blob, sample.fileName);

      const res = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        body: formData,
      });
      const json = await res.json();
      return { status: res.status, body: json };
    }

    // TEST CASE 1: Text-based marks card containing fictional sensitive information
    console.log('▶ [Test Case 1] Text-based Fictional Marks Card PDF...');
    const tc1Upload = await uploadSampleFile('marks-card');
    assert.strictEqual(tc1Upload.status, 201, 'Marks card upload should return 201');
    assert.strictEqual(tc1Upload.body.extraction.extractionMethod, 'pdf-text');
    const marksDocId = tc1Upload.body.documentId;

    const tc1DetectRes = await fetch(`${baseUrl}/api/detect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: marksDocId }),
    });
    const tc1Detect = await tc1DetectRes.json();
    assert.strictEqual(tc1DetectRes.status, 200);
    assert.ok(tc1Detect.totalDetected >= 4, `Expected >= 4 sensitive items in marks card, got ${tc1Detect.totalDetected}`);
    console.log(`  ✅ Uploaded marks card (${marksDocId}) & detected ${tc1Detect.totalDetected} sensitive items:`, Object.keys(tc1Detect.categoryBreakdown).join(', '), '\n');

    // TEST CASE 2: Scanned PDF requiring OCR
    console.log('▶ [Test Case 2] Scanned Image-Only PDF requiring Tesseract.js OCR Fallback...');
    const tc2Upload = await uploadSampleFile('scanned-ocr');
    assert.strictEqual(tc2Upload.status, 201, 'Scanned PDF upload should return 201');
    assert.strictEqual(tc2Upload.body.extraction.usedOcrFallback, true, 'Scanned PDF must trigger OCR fallback');
    assert.strictEqual(tc2Upload.body.extraction.extractionMethod, 'ocr-fallback');

    const tc2DetectRes = await fetch(`${baseUrl}/api/detect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: tc2Upload.body.documentId }),
    });
    const tc2Detect = await tc2DetectRes.json();
    assert.strictEqual(tc2DetectRes.status, 200);
    assert.ok(tc2Detect.totalDetected >= 2, `Expected OCR detection to find sensitive items, found ${tc2Detect.totalDetected}`);
    console.log(`  ✅ Scanned PDF triggered OCR fallback automatically and detected ${tc2Detect.totalDetected} items.\n`);

    // TEST CASE 3: Document containing multiple sensitive information categories
    console.log('▶ [Test Case 3] Multi-Category Financial & Identity Document...');
    const tc3Upload = await uploadSampleFile('multi-category');
    assert.strictEqual(tc3Upload.status, 201);
    const tc3DetectRes = await fetch(`${baseUrl}/api/detect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: tc3Upload.body.documentId }),
    });
    const tc3Detect = await tc3DetectRes.json();
    assert.ok(tc3Detect.totalDetected >= 6, `Expected >= 6 items across categories, got ${tc3Detect.totalDetected}`);
    console.log(`  ✅ Multi-category document detected ${tc3Detect.totalDetected} items across categories:`, JSON.stringify(tc3Detect.categoryBreakdown), '\n');

    // TEST CASE 4: Document containing no detectable sensitive information
    console.log('▶ [Test Case 4] Clean Public Syllabus (No Sensitive Information)...');
    const tc4Upload = await uploadSampleFile('clean-doc');
    assert.strictEqual(tc4Upload.status, 201);
    const tc4DetectRes = await fetch(`${baseUrl}/api/detect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: tc4Upload.body.documentId }),
    });
    const tc4Detect = await tc4DetectRes.json();
    assert.strictEqual(tc4Detect.totalDetected, 0, 'Clean syllabus should have 0 sensitive items');
    console.log('  ✅ Clean document verified with 0 sensitive items detected.\n');

    // TEST CASE 5: Corrupted or unsupported PDF
    console.log('▶ [Test Case 5] Corrupted PDF and Unsupported File Type Validation...');
    const tc5Upload = await uploadSampleFile('corrupted-pdf');
    assert.strictEqual(tc5Upload.status, 400, 'Corrupted PDF should return HTTP 400');
    assert.strictEqual(tc5Upload.body.error, 'CORRUPTED_PDF');

    // Also test non-PDF file rejection
    const badForm = new FormData();
    badForm.append('file', new Blob(['hello world'], { type: 'text/plain' }), 'notes.txt');
    const badRes = await fetch(`${baseUrl}/api/upload`, { method: 'POST', body: badForm });
    assert.strictEqual(badRes.status, 400, 'Non-PDF file should return HTTP 400');
    console.log('  ✅ Corrupted PDF and non-PDF file uploads rejected cleanly with HTTP 400.\n');

    // TEST CASE 6: Permanent Redaction (Selective + Automatic), Post-Redaction Verification, Report & SHA-256 Hash
    console.log('▶ [Test Case 6A] Selective Redaction & Post-Redaction Verification...');
    // Select only the first 2 items of the marks card so we verify that selected items are removed and unselected remain reported
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
    console.log(
      `  ✅ Selective Redaction verified: ${selVerify.verification.successfullyRemovedCount}/2 selected items permanently removed; ${selVerify.verification.remainingUnselectedDetectableCount} unselected items accurately flagged as still exposed.\n`
    );

    console.log('▶ [Test Case 6B] Automatic Full Redaction, Verification, Download & Privacy Report (SHA-256)...');
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
    assert.ok(autoRedact.redactedPdfSha256 && autoRedact.redactedPdfSha256.length === 64, 'Must return 64-char SHA-256 hex');

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

    // Retrieve privacy assessment report via GET /api/report/:id
    const reportRes = await fetch(`${baseUrl}/api/report/${autoVerify.reportId}`);
    const reportJson = await reportRes.json();
    assert.strictEqual(reportRes.status, 200);
    assert.strictEqual(reportJson.report.exportedDocumentIntegrity.sha256, autoRedact.redactedPdfSha256);

    // Download the protected PDF via GET /api/download/:documentId
    const downloadRes = await fetch(`${baseUrl}/api/download/${marksDocId}`);
    assert.strictEqual(downloadRes.status, 200);
    assert.strictEqual(downloadRes.headers.get('x-document-sha256'), autoRedact.redactedPdfSha256);
    console.log(`  ✅ Full Redaction & Verification passed! Report ID: ${autoVerify.reportId}`);
    console.log(`  ✅ Exported PDF SHA-256: ${autoRedact.redactedPdfSha256}\n`);

    console.log('================================================================');
    console.log('🎉 ALL 6 DOCSHIELD HACKATHON TEST CASES PASSED SUCCESSFULLY!');
    console.log('================================================================');
  } finally {
    server.close();
  }
}

runTests().catch((err) => {
  console.error('❌ Test suite failed:', err);
  process.exit(1);
});
