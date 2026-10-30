# DocShield – Smart Document Privacy Protector

A privacy-focused PDF processing engine that detects sensitive information, permanently redacts selected content, and verifies the resulting document.

## 1. Project Overview

DocShield is a Node.js-based document privacy protection system designed to identify and remove confidential information from PDF documents.

It uses PDF text extraction, Optical Character Recognition (OCR), and regex-based pattern matching to identify potentially sensitive information.

The system supports digitally generated PDFs and scanned PDFs. Users can select which detected information should be redacted. After redaction, the system generates a new PDF and performs verification to check whether the selected information remains detectable.

**Important:** DocShield does not claim 100% detection accuracy. Verification results indicate the outcome of the implemented text extraction and OCR checks.

## 2. Core Features

- PDF upload and validation.
- Multi-page PDF text extraction.
- OCR support for scanned documents using Tesseract.js.
- Sensitive information detection using regular expressions.
- Detection categories:
  - Phone numbers
  - Email addresses
  - Aadhaar-like identification numbers
  - Student registration numbers
  - Reliably identifiable addresses
- Selective sensitive information redaction.
- Permanent PDF reconstruction using processed page images.
- Post-redaction verification using text extraction and OCR.
- JSON-based privacy report generation.
- SHA-256 hash generation for the final PDF.
- Temporary file cleanup.
- Modular backend architecture.

## 3. Technology Stack

| Technology | Purpose |
|---|---|
| Node.js | Backend runtime |
| Express.js | REST API |
| JavaScript | Programming language |
| PDF.js | PDF text extraction |
| Tesseract.js | OCR |
| pdf-lib | PDF processing and generation |
| Regex | Sensitive information detection |
| Multer | File upload handling |
| Jest | Testing |
| Supertest | API testing |

## 4. Project Architecture

Recommended directory structure:

```text
DocShield/
│
├── src/
│   ├── app.js
│   ├── server.js
│   │
│   ├── routes/
│   │   ├── upload.routes.js
│   │   ├── detect.routes.js
│   │   ├── redact.routes.js
│   │   ├── verify.routes.js
│   │   └── health.routes.js
│   │
│   ├── controllers/
│   │   ├── upload.controller.js
│   │   ├── detect.controller.js
│   │   ├── redact.controller.js
│   │   └── verify.controller.js
│   │
│   ├── services/
│   │   ├── pdf.service.js
│   │   ├── extraction.service.js
│   │   └── report.service.js
│   │
│   ├── detection/
│   │   ├── detector.js
│   │   └── patterns.js
│   │
│   ├── redaction/
│   │   └── redaction.service.js
│   │
│   ├── verification/
│   │   └── verification.service.js
│   │
│   └── utils/
│       ├── file-validator.js
│       ├── hash.js
│       └── cleanup.js
│
├── tests/
│   ├── upload.test.js
│   ├── extraction.test.js
│   ├── detection.test.js
│   ├── redaction.test.js
│   ├── verification.test.js
│   └── fixtures/
│       ├── sample_text.pdf
│       ├── sample_scanned.pdf
│       ├── sample_multiple.pdf
│       ├── sample_clean.pdf
│       └── sample_corrupted.pdf
│
├── temp/
├── output/
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

## 5. Prerequisites

Install the following before running the project:

- Node.js (LTS version recommended).
- npm.
- Git.
- VS Code or another code editor.
- Postman or Thunder Client for API testing.

Check installation:

```bash
node --version
npm --version
git --version
```

## 6. Installation and Setup

### Step 1: Clone the repository

```bash
git clone YOUR_GITHUB_REPOSITORY_URL
```

Navigate into the project:

```bash
cd DocShield
```

### Step 2: Install dependencies

```bash
npm install
```

### Step 3: Configure environment variables

Create a `.env` file in the project root.

Example:

```env
PORT=5000
MAX_FILE_SIZE_MB=10
NODE_ENV=development
```

Refer to `.env.example` for the required configuration.

### Step 4: Start the server

Development mode:

```bash
npm run dev
```

Production mode:

```bash
npm start
```

The server should run at:

```text
http://localhost:5000
```

These commands assume the corresponding scripts are configured in `package.json`.

## 7. API Documentation

Base URL:

```text
http://localhost:5000
```

### 1. Health Check

**Endpoint:** `GET /api/health`

Purpose:
- Check whether the backend is running.
- Check basic service availability.

Expected response:

```json
{
  "status": "success",
  "message": "DocShield API is running"
}
```

### 2. Upload PDF

**Endpoint:** `POST /api/upload`

Purpose:
- Upload a PDF.
- Validate file type and size.
- Reject invalid or corrupted PDFs.

Request:
- Content-Type: `multipart/form-data`
- Field: `file`

### 3. Detect Sensitive Information

**Endpoint:** `POST /api/detect`

Purpose:
- Extract PDF text.
- Perform OCR where required.
- Identify sensitive information.
- Return category, page, confidence and coordinates where available.

Example response:

```json
{
  "status": "success",
  "totalDetections": 2,
  "detections": [
    {
      "category": "EMAIL",
      "page": 1,
      "confidence": 0.99,
      "value": "alex@example.com"
    },
    {
      "category": "PHONE",
      "page": 1,
      "confidence": 0.95,
      "value": "9876543210"
    }
  ]
}
```

The example values are fictional. Confidence values must be calculated or assigned according to the actual detection method, not hardcoded.

### 4. Redact PDF

**Endpoint:** `POST /api/redact`

Purpose:
- Accept selected detection IDs or categories.
- Permanently remove selected information.
- Generate a new PDF.

The request should identify the source document and the selected detections.

### 5. Verify PDF

**Endpoint:** `POST /api/verify`

Purpose:
- Re-extract text.
- Perform OCR on the exported document.
- Check whether selected sensitive information remains detectable.
- Return unresolved detections and verification failures.

Example response:

```json
{
  "status": "success",
  "verificationStatus": "PASSED",
  "remainingDetections": 0,
  "failedChecks": [],
  "message": "No selected sensitive values were detected by the implemented checks."
}
```

This response is illustrative. The system must never return PASSED when verification checks fail or are incomplete.

## 8. Testing Instructions

Run the test suite:

```bash
npm test
```

Test individual modules where supported:

```bash
npm test -- upload
npm test -- detection
npm test -- redaction
npm test -- verification
```

### Required test cases

| Test | Expected result |
|---|---|
| Valid text PDF | Upload and extraction succeed |
| Scanned PDF | OCR extracts readable text |
| Multiple sensitive fields | Supported fields are detected |
| Clean PDF | No supported sensitive fields detected |
| Corrupted PDF | Processing rejected |
| Selective redaction | Only selected detections are redacted |
| Text extraction after redaction | Selected original values are absent |
| OCR after redaction | Selected original values are not detected |
| Hash generation | Valid SHA-256 hash returned |

### Manual testing

Use Postman or Thunder Client to test every endpoint.

Test the following sequence:

1. Check `/api/health`.
2. Upload `sample_text.pdf`.
3. Call `/api/detect`.
4. Select the detections to redact.
5. Call `/api/redact`.
6. Download the processed PDF.
7. Call `/api/verify`.
8. Inspect the privacy report.

## 9. Privacy and Security Considerations

- Do not use real personal documents during development.
- Use fictional information in test documents.
- Do not send uploaded documents to external AI services.
- Do not log sensitive extracted values.
- Validate PDF files before processing.
- Enforce upload size limits.
- Use temporary storage and clean up files after processing.
- Avoid retaining original PDF content in the exported document.
- Remove or sanitize document metadata and embedded attachments.
- Never treat visual masking alone as successful redaction.
- Do not claim absolute privacy or perfect detection accuracy.

## 10. Development Roadmap

Implement the project in the following order:

- [ ] Stage 1: Express server and health endpoint.
- [ ] Stage 2: PDF upload and validation.
- [ ] Stage 3: Digital PDF text extraction.
- [ ] Stage 4: Scanned PDF OCR support.
- [ ] Stage 5: Sensitive information detection.
- [ ] Stage 6: Detection results and coordinates.
- [ ] Stage 7: Selective permanent PDF redaction.
- [ ] Stage 8: Post-redaction verification.
- [ ] Stage 9: JSON privacy report and SHA-256.
- [ ] Stage 10: Automated tests and security checks.
- [ ] Stage 11: React frontend integration.

## 11. Contribution Guidelines

This is a collaborative development project.

Before contributing:

1. Clone the repository.
2. Create a separate branch for your work.
3. Work on the assigned module.
4. Run the relevant tests.
5. Commit your changes with meaningful messages.
6. Push your branch.
7. Create a Pull Request for review.

Example:

```bash
git checkout -b feature/pdf-extraction
```

Commit changes:

```bash
git add .
git commit -m "Implement PDF text extraction"
git push origin feature/pdf-extraction
```

Avoid modifying unrelated modules without coordinating with the team.

## 12. Important Limitations

DocShield is a prototype document privacy protection system.

- Regex detection may miss unusual formats.
- OCR may misinterpret characters.
- Address detection is not guaranteed.
- Coordinates may be approximate.
- Verification is limited to implemented extraction and OCR checks.
- Raster-based reconstruction may reduce document quality and remove selectable text.

A successful verification result does not establish that the document is impossible to recover using every conceivable forensic technique.

## 13. Project Goal

The goal of DocShield is to develop a reliable, modular and privacy-conscious PDF processing engine that can detect confidential information, permanently redact selected content and independently verify the resulting document.

**Build the processing engine first. Frontend development comes later.**
