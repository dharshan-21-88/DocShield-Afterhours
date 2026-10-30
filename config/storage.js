import fs from 'fs/promises';
import fsSync from 'fs';
import crypto from 'crypto';
import { config } from '../config/index.js';

/**
 * In-memory registry of active documents and privacy reports.
 * Automatically cleans up temporary files on disk when expired or after verification.
 */
const documents = new Map();
const reports = new Map();

export async function ensureTempDirs() {
  for (const dir of [config.upload.tempDir, config.upload.redactedDir, config.upload.samplesDir]) {
    if (!fsSync.existsSync(dir)) {
      await fs.mkdir(dir, { recursive: true });
    }
  }
}

export function computeSha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export async function computeFileSha256(filePath) {
  const buffer = await fs.readFile(filePath);
  return computeSha256(buffer);
}

export function saveDocumentRecord(docRecord) {
  documents.set(docRecord.documentId, {
    ...docRecord,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return documents.get(docRecord.documentId);
}

export function getDocumentRecord(documentId) {
  return documents.get(documentId) || null;
}

export function updateDocumentRecord(documentId, updates) {
  const existing = documents.get(documentId);
  if (!existing) return null;
  const updated = {
    ...existing,
    ...updates,
    updatedAt: Date.now(),
  };
  documents.set(documentId, updated);
  return updated;
}

export function saveReportRecord(report) {
  reports.set(report.reportId, report);
  // Also allow lookup by documentId
  reports.set(report.documentId, report);
  return report;
}

export function getReportRecord(id) {
  return reports.get(id) || null;
}

export async function safeDeleteFile(filePath) {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch {
    // Ignore if already deleted
  }
}

export async function cleanupExpiredFiles() {
  const now = Date.now();
  for (const [docId, record] of documents.entries()) {
    if (now - record.updatedAt > config.upload.fileRetentionMs) {
      await safeDeleteFile(record.originalFilePath);
      await safeDeleteFile(record.redactedFilePath);
      documents.delete(docId);
    }
  }
}

// Run periodic cleanup every 5 minutes
setInterval(() => {
  cleanupExpiredFiles().catch(() => {});
}, 5 * 60 * 1000).unref();
