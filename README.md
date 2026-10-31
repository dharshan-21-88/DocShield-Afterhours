# DocShield — Smart Document Privacy & Redaction Engine

A complete, full-stack document privacy protection platform that detects sensitive personal data in PDFs, permanently redacts selected content using visual and text-stream sanitization, and verifies document integrity with post-redaction OCR, structural audits, and SHA-256 cryptographic proofs.

This repository is a **unified monorepo** containing both the Express processing backend and the Next.js interactive frontend studio.

---

## 1. Monorepo Architecture

```text
DocShield-Afterhours/
├── frontend/                # Next.js 16 interactive redaction & risk studio
│   ├── src/
│   │   ├── app/             # App router, layout, and same-origin API proxy
│   │   ├── components/      # UI components & DocShield views (Studio, Risk Lens, etc.)
│   │   └── lib/             # API client, Zustand store, TypeScript definitions
│   ├── public/              # Static assets & PDF.js worker
│   └── package.json
│
├── config/                  # Server configuration & environment variables
├── controllers/             # RESTful API request handlers
├── detection/               # Sensitive regex patterns & detection logic
├── routes/                  # Express route definitions
├── services/                # PDF text extraction, Tesseract OCR, redaction & verification
├── swagger/                 # OpenAPI 3.0 specification
├── tests/                   # 64-assertion automated test suite
├── server.js                # Express backend server entry point
├── package.json             # Root monorepo scripts & dependencies
└── README.md
```

---

## 2. Core Features

- **Document Intake & Built-in Samples:** Upload digital/scanned PDFs or test with built-in mock documents (Marksheet, ID Card, Invoice).
- **Interactive Redaction Studio:** Dual-pane PDF canvas rendering (via PDF.js) with real-time zooming, bounding box overlays, and jump-to-item navigation.
- **Selective & Automatic Redaction:** Choose between one-click full redaction or fine-grained selective redaction of specific sensitive items.
- **Privacy Risk Lens:** Automatic categorization and risk scoring for Aadhaar numbers, PAN cards, phone numbers, email addresses, student IDs, and addresses.
- **Multi-Engine Post-Redaction Verification:** Re-extracts text streams and runs Tesseract.js OCR to mathematically verify that redacted text cannot be recovered.
- **Cryptographic Audit Ledger:** Computes SHA-256 integrity hashes for both original and redacted files, generating a tamper-evident privacy report.

---

## 3. Quick Start

### Prerequisites
- **Node.js:** v18.0.0 or higher
- **npm:** v9.0.0 or higher

### 1. Installation

Clone the repository and install root dependencies:

```bash
git clone https://github.com/dharshan-21-88/DocShield-Afterhours.git
cd DocShield-Afterhours
npm install
```

Install frontend dependencies:

```bash
cd frontend
npm install
cd ..
```

---

### 2. Running the Application

You can run both services simultaneously from separate terminals:

#### Terminal 1: Backend Server (Port 3002)
```powershell
# Windows PowerShell:
$env:PORT="3002"; node server.js

# macOS / Linux:
PORT=3002 node server.js
```
- Backend API: `http://localhost:3002`
- Interactive Swagger Docs: `http://localhost:3002/api-docs`
- Health check: `http://localhost:3002/api/health`

#### Terminal 2: Frontend Studio (Port 3000)
```bash
npm run dev:frontend
```
- Web Application: `http://localhost:3000`

---

## 4. API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Health check endpoint returning engine status |
| `GET` | `/api/samples` | List available built-in mock sample documents |
| `POST` | `/api/samples/:sampleId/load` | Load a built-in sample document into an active session |
| `POST` | `/api/upload` | Upload a PDF (`multipart/form-data`, max 10MB) |
| `POST` | `/api/detect` | Run text extraction & sensitive entity detection |
| `POST` | `/api/redact` | Redact sensitive items (supports both automatic and selective IDs) |
| `POST` | `/api/verify` | Perform post-redaction verification via OCR & text search |
| `GET` | `/api/report/:id` | Retrieve comprehensive JSON privacy and audit report |
| `GET` | `/api/original/:documentId` | Stream the original uploaded PDF (with `X-Document-SHA256` header) |
| `GET` | `/api/download/:documentId` | Stream the redacted, verified PDF for download |

---

## 5. Automated Tests

The backend test suite consists of **64 comprehensive unit and integration test assertions** validating upload security, multi-page extraction, OCR fallbacks, selective redaction, post-redaction verification, dimensional obfuscation, and metadata removal:

```bash
npm test
```

Expected result:
```text
================================================================
DocShield Test Suite: 64 passed, 0 failed
================================================================
```

---

## 6. Monorepo Scripts

- `npm run dev` or `npm run dev:backend` — Starts the backend server (`server.js`).
- `npm run dev:frontend` — Starts the Next.js frontend dev server on port `3000`.
- `npm run build:frontend` — Builds the production Next.js frontend bundle.
- `npm test` — Executes the 64-test backend validation suite.
- `npm run lint` — Syntax checks backend code.

---

## 7. License

Distributed under the MIT License. See `LICENSE` for details.
