# DocShield Frontend — Intelligent Document Privacy Studio

A modern, high-performance web interface for privacy-preserving document redaction, sensitive data risk analysis, and post-redaction verification.

Built with **Next.js 16**, **React 19**, **TypeScript**, **Tailwind CSS**, and **PDF.js**.

---

## 1. Overview

DocShield Frontend provides a complete user experience for redacting confidential information from PDFs before sharing. Designed for sensitive workflows such as admissions, legal processing, healthcare records, and public filings, it bridges intuitive visual controls with strict document-privacy verification.

The frontend operates in tandem with the [DocShield Backend (DocShield-Afterhours)](https://github.com/dharshan-21-88/DocShield-Afterhours), delegating heavy OCR, sensitive entity detection, and PDF reconstruction to the backend service.

---

## 2. Core Capabilities & Views

### 📥 1. Intake & Document Upload
- **Drag-and-Drop Upload:** Fast multi-page PDF ingestion with client-side format and size validation.
- **Built-in Sample Suite:** One-click preloaded test documents (Marksheet, ID Card, Healthcare Invoice) for quick verification and demonstration without uploading personal files.

### 🎛️ 2. Redaction Studio
- **Dual-Pane Interactive PDF Canvas:** High-fidelity document rendering powered by PDF.js with real-time zooming, page switching, and fit-to-width controls.
- **Visual Bounding Boxes:** Sensitive text spans highlighted directly over the PDF canvas.
- **Selective & Automatic Redaction:** Choose to redact all detected entities with one click or selectively choose specific sensitive items (e.g., redact phone numbers and Aadhaar numbers while preserving roll numbers).
- **Jump-to-Item Navigation:** Clicking any detected entity in the sidebar instantly scrolls and focuses the PDF viewport onto that exact bounding box.

### 🔍 3. Privacy Risk Lens
- **Categorized Risk Breakdown:** Classifies detected entities across critical identifiers:
  - Phone Numbers
  - Email Addresses
  - Aadhaar / National ID Numbers
  - Student Registration Numbers
  - Structured Physical Addresses
- **Interactive Filtering:** Filter sensitive items by category or risk severity to inspect exposure before triggering redaction.

### 🛡️ 4. Redaction Verification Ledger
- **Multi-Engine Audit:** Displays comprehensive post-redaction verification metrics returned by the backend engine:
  - Text extraction scan (ensuring underlying PDF text stream is sanitized).
  - Optical Character Recognition (OCR) residual check on reconstructed page images.
- **Tamper Evidence:** Verifies that redacted zones have been permanently obfuscated rather than merely obscured with transparent visual layers.

### 📤 5. Share & Download Ledger
- **Cryptographic Receipt:** Displays computed SHA-256 hashes of both the original document and the sanitized document.
- **Audit Logging:** Clean export summary showing timestamp, redacted entity counts, and verification status.
- **Direct Download:** Fast streaming download of the verified, redacted PDF.

---

## 3. Architecture & API Proxy

The frontend uses a **same-origin API proxy** pattern to seamlessly communicate with the backend while avoiding browser CORS constraints and exposing backend internals.

```text
Browser (User)
      │
      ▼
Next.js Frontend (Port 3000)
      │
      ▼
API Proxy Gateway (src/app/api/[...path]/route.ts)
      │
      ▼
Express Backend Engine (Port 3002)
```

- Client API calls are routed through `/api/*?XTransformPort=3002`.
- The proxy transparently handles multipart uploads (`multipart/form-data`), JSON bodies, and binary streams (PDF downloads and original PDF preview).

---

## 4. Tech Stack

- **Framework:** Next.js 16 (App Router)
- **UI Library:** React 19, Tailwind CSS, Radix UI primitives, Lucide Icons
- **State Management:** Zustand (`src/lib/docshield/store.ts`)
- **PDF Rendering:** `pdfjs-dist` (v6 with custom web worker lifecycle management)
- **Language:** TypeScript 5 (Strict Mode)

---

## 5. Getting Started

### Prerequisites
- **Node.js:** v18.0.0 or higher
- **npm:** v9.0.0 or higher
- **DocShield Backend:** Running locally on port `3002`

### Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/dharshan-21-88/DocShield-Frontend.git
cd DocShield-Frontend
npm install
```

### Running the Development Server

Start the Next.js development server on port `3000`:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## 6. Project Structure

```text
DocShield-Frontend/
├── public/
│   ├── docshield-mark.svg
│   └── pdfjs/                   # Local PDF.js worker scripts
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   └── [...path]/       # Dynamic catch-all proxy to port 3002
│   │   ├── globals.css          # Tailwind and custom theme styles
│   │   ├── layout.tsx           # Root layout and metadata
│   │   └── page.tsx             # Application entry point
│   ├── components/
│   │   ├── docshield/
│   │   │   ├── app.tsx          # Main shell & tab navigation
│   │   │   ├── hooks.ts         # Custom hooks for DocShield operations
│   │   │   ├── nav.tsx          # Top navigation bar
│   │   │   ├── pdf-preview.tsx  # PDF.js dual-layer canvas viewer
│   │   │   ├── primitives.tsx   # Reusable DocShield UI components
│   │   │   └── views/
│   │   │       ├── dashboard-view.tsx    # Processing overview
│   │   │       ├── upload-view.tsx       # Intake & sample loader
│   │   │       ├── studio-view.tsx       # Redaction studio & item selector
│   │   │       ├── risk-lens-view.tsx    # Privacy analysis & filters
│   │   │       ├── verification-view.tsx # Post-redaction verification audit
│   │   │       └── share-view.tsx        # Receipt & download center
│   │   └── ui/                  # Accessible UI component library
│   └── lib/
│       ├── docshield/
│       │   ├── api.ts           # DocShield API client
│       │   ├── format.ts        # Formatting helpers
│       │   ├── store.ts         # Zustand application state
│       │   └── types.ts         # TypeScript definitions
└── package.json
```

---

## 7. Connecting to the Backend

The frontend defaults to connecting to the DocShield Express backend running at `http://localhost:3002`.

To run the backend:
```bash
cd ../DocShield-Afterhours
$env:PORT="3002"   # On Windows PowerShell
node server.js
```

Verify backend health at: [http://localhost:3002/api/health](http://localhost:3002/api/health)
Interactive API docs at: [http://localhost:3002/api-docs](http://localhost:3002/api-docs)

---

## 8. License

Distributed under the MIT License. See `LICENSE` for more information.
