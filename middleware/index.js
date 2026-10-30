import rateLimit from 'express-rate-limit';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs/promises';
import { config } from '../config/index.js';
import { ensureTempDirs, safeDeleteFile } from '../config/storage.js';

/**
 * Rate limiter middleware to protect API endpoints from abuse.
 */
export const apiRateLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many requests from this IP, please try again later.',
  },
});

const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    try {
      await ensureTempDirs();
      cb(null, config.upload.tempDir);
    } catch (err) {
      cb(err, config.upload.tempDir);
    }
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = `${Date.now()}_${crypto.randomUUID()}`;
    const ext = path.extname(file.originalname).toLowerCase() || '.pdf';
    cb(null, `upload_${uniqueSuffix}${ext}`);
  },
});

const fileFilter = (_req, file, cb) => {
  const ext = path.extname(file.originalname || '').toLowerCase();
  const isPdfMime = config.upload.allowedMimeTypes.includes(file.mimetype);
  const isPdfExt = ext === '.pdf';

  if (!isPdfMime && !isPdfExt) {
    const error = new Error('Only valid PDF documents (.pdf) are allowed.');
    error.code = 'INVALID_FILE_TYPE';
    return cb(error, false);
  }
  cb(null, true);
};

const uploadInstance = multer({
  storage,
  limits: {
    fileSize: config.upload.maxFileSizeBytes,
    files: 1,
  },
  fileFilter,
});

/**
 * Middleware that handles multipart PDF upload and validates magic bytes (%PDF-).
 */
export function uploadPdfMiddleware(req, res, next) {
  const singleUpload = uploadInstance.single('file');

  singleUpload(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({
            success: false,
            error: 'FILE_TOO_LARGE',
            message: `Uploaded file exceeds the maximum allowed size of ${Math.round(
              config.upload.maxFileSizeBytes / (1024 * 1024)
            )} MB.`,
          });
        }
        return res.status(400).json({
          success: false,
          error: 'UPLOAD_ERROR',
          message: err.message,
        });
      }

      if (err.code === 'INVALID_FILE_TYPE') {
        return res.status(400).json({
          success: false,
          error: 'INVALID_FILE_TYPE',
          message: err.message,
        });
      }

      return res.status(400).json({
        success: false,
        error: 'BAD_UPLOAD_REQUEST',
        message: err.message || 'Failed to process uploaded file.',
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'MISSING_FILE',
        message: 'No PDF file was provided. Please upload a PDF under the form field name "file".',
      });
    }

    try {
      const stats = await fs.stat(req.file.path);
      if (stats.size === 0) {
        await safeDeleteFile(req.file.path);
        return res.status(400).json({
          success: false,
          error: 'EMPTY_FILE',
          message: 'The uploaded PDF file is empty (0 bytes).',
        });
      }

      // Check PDF magic header (%PDF-)
      const fd = await fs.open(req.file.path, 'r');
      const headerBuffer = Buffer.alloc(5);
      await fd.read(headerBuffer, 0, 5, 0);
      await fd.close();

      const headerStr = headerBuffer.toString('ascii');
      if (!headerStr.startsWith('%PDF-')) {
        await safeDeleteFile(req.file.path);
        return res.status(400).json({
          success: false,
          error: 'INVALID_PDF_HEADER',
          message: 'The uploaded file does not have a valid PDF header (%PDF-). It may be unsupported or corrupted.',
        });
      }

      next();
    } catch (validationErr) {
      if (req.file?.path) {
        await safeDeleteFile(req.file.path);
      }
      return res.status(400).json({
        success: false,
        error: 'FILE_VALIDATION_FAILED',
        message: 'Unable to validate the uploaded PDF file.',
      });
    }
  });
}

/**
 * Global error handler that never leaks sensitive document contents.
 */
export function errorHandler(err, _req, res, _next) {
  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    success: false,
    error: err.code || 'INTERNAL_SERVER_ERROR',
    message: err.message || 'An unexpected error occurred while processing the request.',
  });
}
