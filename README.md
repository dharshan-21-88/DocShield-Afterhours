# DocShield Backend — Privacy-Focused PDF Redaction & Verification Engine

A robust Node.js & Express document privacy protection engine that detects sensitive personal data in PDFs, permanently redacts selected content using visual & text-stream sanitization, and verifies document integrity using post-redaction OCR and SHA-256 hashing.

---

## 1. Project Overview

DocShield Backend is the authoritative processing engine for the DocShield privacy ecosystem. It provides:
- Multi-page digital PDF text extraction with PDF.js.
- Scanned PDF processing and Optical Character Recognition (OCR) with Tesseract.js.
- Pattern matching and entity classification for sensitive data (Aadhaar, Phone, Email, Student IDs, Addresses).
- Permanent redaction with true stream destruction (not simple cosmetic overlays).
- Post-redaction OCR verification to guarantee sensitive values cannot be recovered.
- Streaming of original and redacted documents with SHA-256 cryptographic verification.
- Interactive Swagger/OpenAPI documentation.

---

## 2. Technology Stack

| Technology | Purpose |
|---|---|
| **Node.js (ES Modules)** | Backend runtime |
| **Express.js** | RESTful API server |
| **PDF.js (`pdfjs-dist`)** | Multi-page PDF text extraction and canvas rendering |
| **Tesseract.js** | Optical Character Recognition (OCR) for scanned documents |
| **pdf-lib** | PDF stream manipulation and document reconstruction |
| **Multer** | Multipart form-data file upload handling |
| **Swagger UI (`swagger-ui-express`)** | OpenAPI interactive documentation |
| **Crypto** | SHA-256 cryptographic hash computation |

---

## 3. Architecture & Directory Structure

The backend is organized into clean, modular layers:

```text
DocShield-Afterhours/
├── config/
│   └── index.js             # Environment variables and defaults (PORT, limits)
├── controllers/
│   └── index.js             # HTTP request handlers & validation
├── detection/
│   ├── detector.js          # Sensitive entity detection orchestrator
│   └── patterns.js          # Regex rules & classification patterns
├── routes/
│   └── index.js             # Express API route declarations
├── services/
│   ├── documentStore.js     # In-memory document session registry
│   ├── extraction.service.js# PDF.js text extraction & coordinate mapping
│   ├── ocr.service.js       # Tesseract.js OCR engine
│   ├── pdf.service.js       # File validation & disk operations
│   ├── redaction.service.js # Bounding-box obfuscation & PDF rebuilding
│   ├── report.service.js    # Audit report & SHA-256 generation
│   └── verification.service.js # Post-redaction residual text & OCR verification
├── swagger/
│   └── openapi.json         # OpenAPI 3.0 specification
├── tests/
│   ├── run-tests.js         # Comprehensive 64-assertion test suite
│   └── fixtures/            # Test PDFs (sample_text, sample_scanned, corrupted)
├── server.js                # Express app entry point
└── package.json
```

---

## 4. API Reference

Base URL: `http://localhost:3002`

Interactive OpenAPI / Swagger Documentation:
👉 **[http://localhost:3002/api-docs](http://localhost:3002/api-docs)**

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Health check endpoint returning engine status |
| `GET` | `/api/samples` | List available built-in mock sample documents |
| `POST` | `/api/samples/:sampleId/load` | Load a built-in sample document into a session |
| `POST` | `/api/upload` | Upload a PDF (`multipart/form-data`, max 10MB) |
| `POST` | `/api/detect` | Run text extraction & entity detection on an uploaded document |
| `POST` | `/api/redact` | Redact sensitive items (supports both automatic and selective IDs) |
| `POST` | `/api/verify` | Perform post-redaction verification via OCR & text search |
| `GET` | `/api/report/:id` | Retrieve comprehensive JSON privacy and audit report |
| `GET` | `/api/original/:documentId` | Stream the original uploaded PDF (with `X-Document-SHA256` header) |
| `GET` | `/api/download/:documentId` | Stream the redacted, verified PDF for download |

---

## 5. Getting Started

### Prerequisites
- **Node.js:** v18.0.0 or higher
- **npm:** v9.0.0 or higher

### Installation

```bash
git clone https://github.com/dharshan-21-88/DocShield-Afterhours.git
cd DocShield-Afterhours
npm install
```

### Starting the Server

The backend defaults to port `3000`, but when paired with the Next.js frontend (which uses port `3000`), the backend runs on **port 3002**:

#### On Windows (PowerShell):
```powershell
$env:PORT="3002"; node server.js
```

#### On Linux / macOS:
```bash
PORT=3002 node server.js
```

The server will log:
```text
DocShield server running on port 3002
API Documentation: http://localhost:3002/api-docs
```

---

## 6. Testing

The backend includes a comprehensive, automated test runner covering 64 unit and integration test assertions across upload validation, text extraction, OCR, regex detection, selective redaction, post-redaction verification, and original document streaming:

```bash
npm test
```

Expected output:
```text
==================================================
DocShield Test Suite: 64 passed, 0 failed
==================================================
```

---

## 7. Frontend Integration

This backend is integrated with the **[DocShield Frontend](https://github.com/dharshan-21-88/DocShield-Frontend)** (Next.js 16).

The frontend runs on `http://localhost:3000` and proxies API calls to this service on `http://localhost:3002` via its internal catch-all proxy (`/api/[...path]?XTransformPort=3002`).

---

## 8. License

Distributed under the MIT License. See `LICENSE` for details.
