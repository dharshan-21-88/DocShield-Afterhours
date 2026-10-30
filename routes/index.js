import { Router } from 'express';
import { uploadPdfMiddleware, uploadImageMiddleware } from '../middleware/index.js';
import {
  getHealth,
  uploadPdfController,
  uploadImageController,
  listSamplesController,
  loadSampleController,
  detectSensitiveController,
  redactPdfController,
  verifyPdfController,
  getReportController,
  downloadRedactedPdfController,
} from '../controllers/index.js';

const router = Router();

// 1. Health endpoint
router.get('/health', getHealth);

// 2. Built-in fictional sample PDFs for testing all 6 hackathon scenarios
router.get('/samples', listSamplesController);
router.post('/samples/:sampleId/load', loadSampleController);

// 3. Upload PDF & extract text (with OCR fallback)
router.post('/upload', uploadPdfMiddleware, uploadPdfController);

router.post('/upload-image', uploadImageMiddleware, uploadImageController);

// 4. Detect sensitive information
router.post('/detect', detectSensitiveController);

// 5. Generate permanently redacted PDF (automatic or selective)
router.post('/redact', redactPdfController);

// 6. Post-redaction verification (re-extraction + OCR check)
router.post('/verify', verifyPdfController);

// 7. Retrieve privacy assessment report
router.get('/report/:id', getReportController);

// 8. Download protected PDF
router.get('/download/:documentId', downloadRedactedPdfController);

export default router;
