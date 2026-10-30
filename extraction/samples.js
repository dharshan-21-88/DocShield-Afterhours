import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import { config } from '../config/index.js';
import { ensureTempDirs } from '../config/storage.js';

export const SAMPLE_SCENARIOS = [
  {
    id: 'marks-card',
    title: '1. Fictional University Marks Card (Text PDF)',
    description:
      'Text-based academic transcript containing fictional student registration number, Aadhaar-like national ID, phone number, email address, and residential address.',
  },
  {
    id: 'scanned-ocr',
    title: '2. Scanned KYC Verification Notice (Image-Only PDF for OCR)',
    description:
      'Contains zero embedded PDF text streams; rendered purely as a scanned image inside a PDF to test Tesseract.js OCR fallback.',
  },
  {
    id: 'multi-category',
    title: '3. Multi-Category Financial & Identity Statement',
    description:
      'Contains all 6 sensitive categories: Student Registration No, Aadhaar-like ID, Phone, Email, Physical Address, and Financial Account / IFSC details.',
  },
  {
    id: 'clean-doc',
    title: '4. Clean Public Course Syllabus (Zero Sensitive Data)',
    description:
      'A standard computer science syllabus containing no personal or sensitive identifiers.',
  },
  {
    id: 'corrupted-pdf',
    title: '5. Corrupted / Unsupported PDF File',
    description:
      'Intentionally malformed file stream to test upload validation and graceful error handling.',
  },
];

async function createTextPdf(lines, title) {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(title);
  const page = pdfDoc.addPage([595.28, 841.89]); // A4
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);

  let y = 780;
  page.drawText(title, {
    x: 50,
    y,
    size: 16,
    font: fontBold,
    color: rgb(0.1, 0.15, 0.3),
  });

  y -= 32;
  for (const line of lines) {
    const isHeader = line.startsWith('---') || line.endsWith(':');
    page.drawText(line, {
      x: 50,
      y,
      size: isHeader ? 12 : 11,
      font: isHeader ? fontBold : fontRegular,
      color: rgb(0.1, 0.1, 0.1),
    });
    y -= 24;
  }

  return Buffer.from(await pdfDoc.save());
}

async function createScannedOcrPdf() {
  // Draw clear high-contrast text onto a node-canvas and embed ONLY the PNG into the PDF
  const width = 1190;
  const height = 1684;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#000000';
  ctx.font = 'bold 34px sans-serif';
  ctx.fillText('SCANNED STUDENT VERIFICATION SLIP (FICTIONAL)', 80, 120);

  ctx.font = '28px sans-serif';
  const scanLines = [
    'Candidate Name: Aarav Sharma (Fictional Record)',
    'Registration No: REG-2026-CS-0492',
    'National ID No: 4829 7301 9482',
    'Contact Email: aarav.sharma.demo@example.edu',
    'Contact Phone: +91 9876543210',
    'Account IFSC: SBIN0004821',
    'Status: Submitted for Privacy Redaction Test',
  ];

  let y = 210;
  for (const line of scanLines) {
    ctx.fillText(line, 80, y);
    y += 65;
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

/**
 * Generates one of the 5 fictional sample PDF files on disk and returns its metadata.
 */
export async function generateSamplePdfFile(sampleId) {
  await ensureTempDirs();

  let buffer;
  let fileName = `fictional_${sampleId}.pdf`;

  switch (sampleId) {
    case 'marks-card': {
      buffer = await createTextPdf(
        [
          'FICTIONAL TECHNOLOGICAL UNIVERSITY - STATEMENT OF MARKS',
          'Academic Session: 2025 - 2026 (Synthetic Demonstration Data)',
          '------------------------------------------------------------',
          'Student Full Name: Priya Nair (Fictional Profile)',
          'Student Registration No: REG-2026-CS-0492',
          'University Roll Code: 1RV22CS084',
          'Aadhaar / National ID: 4829 7301 9482',
          'Student Email: priya.nair.demo@fictional-univ.edu',
          'Guardian Mobile: +91-9876543210',
          'Permanent Address: No. 42, MG Road, Bengaluru - 560001',
          '------------------------------------------------------------',
          'CS301 Data Structures and Algorithms : 92 / 100 (Grade A+)',
          'CS302 Operating Systems              : 88 / 100 (Grade A)',
          'CS303 Computer Networks              : 90 / 100 (Grade A+)',
          'CS304 Information Security & Privacy : 95 / 100 (Grade O)',
          'Result: PASSED WITH DISTINCTION',
        ],
        'UNIVERSITY MARKS CARD (FICTIONAL SAMPLE)'
      );
      break;
    }

    case 'scanned-ocr': {
      buffer = await createScannedOcrPdf();
      break;
    }

    case 'multi-category': {
      buffer = await createTextPdf(
        [
          'COMPREHENSIVE STUDENT SCHOLARSHIP & DISBURSEMENT RECORD',
          'Notice: Contains Fictional Multi-Category Sensitive Identifiers',
          '------------------------------------------------------------',
          'Applicant Name: Rohan Verma (Synthetic Test Identity)',
          'Student Registration Number: REG-2026-EC-1088',
          'Aadhaar / National ID Number: 6291 8402 5519',
          'Tax PAN Identifier: ABCDE1234F',
          'Primary Email Address: rohan.verma.test@demo-campus.org',
          'Registered Phone Number: +91-9123456789',
          'Residential Address: Flat 302, Green Valley Road, Pune - 411001',
          'Bank Account Reference: ACC-2026-88492011',
          'Bank Branch IFSC Code: SBIN0004821',
          'Disbursement Card Ref: 4532 8910 2234 9012',
          '------------------------------------------------------------',
          'Scholarship Grant Amount: INR 45,000 (Approved for Disbursement)',
        ],
        'SCHOLARSHIP FINANCIAL & KYC RECORD (FICTIONAL)'
      );
      break;
    }

    case 'clean-doc': {
      buffer = await createTextPdf(
        [
          'DEPARTMENT OF COMPUTER SCIENCE & ENGINEERING',
          'Course Overview: Introduction to Open-Source Privacy Engineering',
          '------------------------------------------------------------',
          'Module 1: Principles of Document Sanitization and Data Minimization',
          'Module 2: Understanding PDF Object Streams vs Rasterized Redaction',
          'Module 3: Optical Character Recognition (OCR) Verification Pipelines',
          'Module 4: Cryptographic Integrity Verification with SHA-256 Hashes',
          '------------------------------------------------------------',
          'Note: This public syllabus contains zero personal or sensitive data.',
        ],
        'PUBLIC COURSE SYLLABUS (CLEAN SAMPLE)'
      );
      break;
    }

    case 'corrupted-pdf': {
      buffer = Buffer.from('%PDF-1.7\n%CORRUPTED_FICTIONAL_STREAM_WITHOUT_XREF_OR_TRAILER\n0000000');
      break;
    }

    default: {
      const err = new Error(
        `Unknown sampleId "${sampleId}". Valid options: marks-card, scanned-ocr, multi-category, clean-doc, corrupted-pdf.`
      );
      err.code = 'INVALID_SAMPLE_ID';
      err.statusCode = 400;
      throw err;
    }
  }

  const filePath = path.join(
    config.upload.tempDir,
    `sample_${sampleId}_${Date.now()}_${crypto.randomUUID()}.pdf`
  );
  await fs.writeFile(filePath, buffer);

  return {
    sampleId,
    fileName,
    filePath,
    fileSizeBytes: buffer.length,
  };
}
