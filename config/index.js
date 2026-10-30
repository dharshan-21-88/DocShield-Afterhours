import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  frontendApiBaseUrl: process.env.FRONTEND_API_BASE_URL || process.env.VITE_API_BASE_URL || 'http://localhost:3000',
  corsOrigins: process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map((origin) => origin.trim())
    : ['*'],
  upload: {
    maxFileSizeBytes: parseInt(process.env.MAX_FILE_SIZE_BYTES || String(10 * 1024 * 1024), 10), // 10 MB default
    tempDir: path.resolve(__dirname, '../.tmp_uploads'),
    redactedDir: path.resolve(__dirname, '../.tmp_redacted'),
    samplesDir: path.resolve(__dirname, '../.tmp_samples'),
    allowedMimeTypes: ['application/pdf'],
    fileRetentionMs: parseInt(process.env.FILE_RETENTION_MS || String(30 * 60 * 1000), 10), // 30 minutes
  },
  rateLimit: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX || '200', 10),
  },
};
