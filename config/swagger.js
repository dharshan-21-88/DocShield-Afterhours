export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'DocShield – Smart Document Privacy Protector API',
    version: '1.0.0',
    description:
      'REST API for **DocShield – Smart Document Privacy Protector**.\n\n' +
      '> *"Don\'t just redact documents. Verify what remains exposed before sharing."*\n\n' +
      '### Core Capabilities\n' +
      '1. **Upload PDF Documents** (`POST /api/upload`) with strict file-type, magic-byte, and file-size validation.\n' +
      '2. **Extract Text & OCR Fallback** (`POST /api/upload` or `POST /api/detect`) using PDF.js text extraction and Tesseract.js OCR fallback for scanned documents.\n' +
      '3. **Sensitive Information Detection** (`POST /api/detect`) using pattern matching for phone numbers, email addresses, physical addresses, student registration numbers, Aadhaar-like / ID-like numbers, and financial account numbers with bounding-box coordinates and confidence indicators.\n' +
      '4. **Permanent PDF Redaction** (`POST /api/redact`) supporting both **automatic** and **selective** redaction by rasterizing pages, burning permanent masks over target regions, stripping original text layers, and rebuilding a clean PDF.\n' +
      '5. **Post-Redaction Verification** (`POST /api/verify`) that re-extracts text and runs OCR on the redacted PDF to verify whether selected sensitive items remain detectable.\n' +
      '6. **Privacy Assessment Report & SHA-256 Integrity** (`GET /api/report/:id`) providing before/after metrics, indicative privacy scores, and SHA-256 hashes.\n' +
      '7. **Fictional Sample Test Suite** (`GET /api/samples` & `POST /api/samples/:sampleType/load`) to immediately test all 6 hackathon verification scenarios.',
  },
  servers: [
    {
      url: '/',
      description: 'Current DocShield Server',
    },
  ],
  tags: [
    { name: 'System', description: 'Health check and server status' },
    { name: 'Samples', description: 'Fictional sample PDF generator for testing all 6 hackathon cases' },
    { name: 'Workflow', description: 'Core upload, detection, permanent redaction, and verification endpoints' },
    { name: 'Reports & Downloads', description: 'Privacy assessment reports and protected PDF downloads' },
  ],
  paths: {
    '/api/health': {
      get: {
        tags: ['System'],
        summary: 'Check whether the DocShield backend is running',
        description: 'Returns server health status, uptime, version, and active configuration limits.',
        responses: {
          200: {
            description: 'Backend is healthy and operational',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'ok' },
                    service: { type: 'string', example: 'DocShield – Smart Document Privacy Protector Backend' },
                    motto: {
                      type: 'string',
                      example: "Don't just redact documents. Verify what remains exposed before sharing.",
                    },
                    timestamp: { type: 'string', format: 'date-time' },
                    uptimeSeconds: { type: 'number', example: 42.5 },
                    config: {
                      type: 'object',
                      properties: {
                        maxFileSizeBytes: { type: 'integer', example: 10485760 },
                        allowedMimeTypes: { type: 'array', items: { type: 'string' }, example: ['application/pdf'] },
                        frontendApiBaseUrl: { type: 'string', example: 'http://localhost:3000' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/samples': {
      get: {
        tags: ['Samples'],
        summary: 'List built-in fictional test PDF scenarios',
        description:
          'Returns the list of 6 fictional test cases (marks card, scanned OCR PDF, multi-category PII document, clean non-sensitive document, corrupted PDF, and full redaction verification).',
        responses: {
          200: {
            description: 'List of available fictional test cases',
            content: {
              'application/json': {
                example: {
                  success: true,
                  samples: [
                    {
                      id: 'marks-card',
                      title: '1. Fictional University Marks Card (Text PDF)',
                      description: 'Contains student registration number, Aadhaar-like ID, phone, email, and address.',
                    },
                    {
                      id: 'scanned-ocr',
                      title: '2. Scanned KYC Notice (Image-only PDF requiring OCR)',
                      description: 'Rasterized image page with no embedded text layer; triggers Tesseract.js OCR fallback.',
                    },
                    {
                      id: 'multi-category',
                      title: '3. Multi-Category Financial & Identity Statement',
                      description: 'Contains all 6 sensitive categories including bank account, IFSC, PAN/ID, phone, email, and address.',
                    },
                    {
                      id: 'clean-doc',
                      title: '4. Clean Public Syllabus (No Sensitive Information)',
                      description: 'General academic syllabus with zero sensitive personal identifiers.',
                    },
                    {
                      id: 'corrupted-pdf',
                      title: '5. Corrupted / Invalid PDF File',
                      description: 'Tests error handling and file structure validation for broken PDF streams.',
                    },
                  ],
                },
              },
            },
          },
        },
      },
    },
    '/api/samples/{sampleId}/load': {
      post: {
        tags: ['Samples'],
        summary: 'Generate and load a fictional sample PDF directly into the upload & extraction pipeline',
        parameters: [
          {
            name: 'sampleId',
            in: 'path',
            required: true,
            schema: {
              type: 'string',
              enum: ['marks-card', 'scanned-ocr', 'multi-category', 'clean-doc', 'corrupted-pdf'],
            },
            description: 'ID of the fictional sample PDF to generate and upload',
          },
        ],
        responses: {
          201: {
            description: 'Sample generated, uploaded, and text extracted successfully',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/UploadResponse' },
              },
            },
          },
          400: {
            description: 'Corrupted or invalid sample PDF rejected as expected',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/api/upload': {
      post: {
        tags: ['Workflow'],
        summary: 'Upload a PDF document and extract its text (with automatic OCR fallback)',
        description:
          'Accepts a `multipart/form-data` PDF file under field name `file` (max 10 MB). Validates MIME type, PDF magic header (`%PDF-`), and structural integrity. Automatically extracts embedded text per page and falls back to Tesseract.js OCR if the PDF is scanned.',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['file'],
                properties: {
                  file: {
                    type: 'string',
                    format: 'binary',
                    description: 'PDF file to upload (application/pdf, max 10MB)',
                  },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'PDF uploaded and text extracted successfully',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/UploadResponse' },
              },
            },
          },
          400: {
            description: 'Validation error (missing file, unsupported file format, empty or corrupted PDF)',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
                examples: {
                  invalidFileType: {
                    summary: 'Unsupported file format',
                    value: {
                      success: false,
                      error: 'INVALID_FILE_TYPE',
                      message: 'Only valid PDF documents (.pdf) are allowed.',
                    },
                  },
                  corruptedPdf: {
                    summary: 'Corrupted or unreadable PDF',
                    value: {
                      success: false,
                      error: 'CORRUPTED_PDF',
                      message: 'The uploaded PDF file appears to be corrupted or cannot be parsed.',
                    },
                  },
                },
              },
            },
          },
          413: {
            description: 'File exceeds maximum allowed size (10 MB)',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/api/detect': {
      post: {
        tags: ['Workflow'],
        summary: 'Detect potentially sensitive information in an uploaded PDF',
        description:
          'Scans the extracted text and coordinate items of an uploaded document (`documentId`) for Phone Numbers, Email Addresses, Physical Addresses, Student Registration Numbers, Aadhaar-like / ID Numbers, and Financial Account Numbers. Returns bounding boxes, page numbers, and confidence status.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['documentId'],
                properties: {
                  documentId: {
                    type: 'string',
                    description: 'The documentId returned from POST /api/upload',
                    example: 'doc_9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
                  },
                  categories: {
                    type: 'array',
                    items: {
                      type: 'string',
                      enum: [
                        'PHONE_NUMBER',
                        'EMAIL_ADDRESS',
                        'ADDRESS',
                        'STUDENT_REG_NUMBER',
                        'NATIONAL_ID_AADHAAR',
                        'NATIONAL_ID_PAN',
                        'FINANCIAL_ACCOUNT',
                      ],
                    },
                    description: 'Optional filter of categories to detect. Defaults to all categories.',
                  },
                },
              },
              example: {
                documentId: 'doc_9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Sensitive information detection completed',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DetectionResponse' },
              },
            },
          },
          404: {
            description: 'Document ID not found or expired',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/api/redact': {
      post: {
        tags: ['Workflow'],
        summary: 'Generate a permanently redacted PDF (automatic or selective mode)',
        description:
          'Permanently removes sensitive content by rendering each PDF page to a high-resolution image canvas, burning solid opaque redaction blocks over the selected bounding boxes/items, stripping all underlying text layers, and rebuilding a clean PDF. Returns the redaction summary and SHA-256 hash.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['documentId'],
                properties: {
                  documentId: {
                    type: 'string',
                    example: 'doc_9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
                  },
                  mode: {
                    type: 'string',
                    enum: ['automatic', 'selective'],
                    default: 'automatic',
                    description:
                      '`automatic` redacts all detected items. `selective` redacts only the item IDs specified in `selectedItemIds`.',
                  },
                  selectedItemIds: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Required when mode is `selective`. Array of detection item IDs to redact.',
                    example: ['det_1', 'det_3', 'det_4'],
                  },
                },
              },
              examples: {
                automaticMode: {
                  summary: 'Automatic Redaction (All detected items)',
                  value: {
                    documentId: 'doc_9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
                    mode: 'automatic',
                  },
                },
                selectiveMode: {
                  summary: 'Selective Redaction (Specific items only)',
                  value: {
                    documentId: 'doc_9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
                    mode: 'selective',
                    selectedItemIds: ['det_1', 'det_2'],
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Permanently redacted PDF generated',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/RedactionResponse' },
              },
            },
          },
          400: {
            description: 'Invalid mode or missing selectedItemIds in selective mode',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          404: {
            description: 'Document not found',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          422: {
            description: 'One or more selected detections lack valid page coordinates (REDACTION_COORDINATES_MISSING)',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/api/verify': {
      post: {
        tags: ['Workflow'],
        summary: 'Verify the redacted PDF to check whether sensitive information remains detectable',
        description:
          'Re-extracts embedded text AND performs Tesseract.js OCR on the rendered pages of the redacted PDF to verify whether the selected sensitive items were permanently removed or if any items remain exposed. Generates or updates the Privacy Assessment Report.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['documentId'],
                properties: {
                  documentId: {
                    type: 'string',
                    example: 'doc_9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
                  },
                  runOcrCheck: {
                    type: 'boolean',
                    default: true,
                    description: 'Whether to run OCR on the redacted pages to verify visual text removal',
                  },
                },
              },
              example: {
                documentId: 'doc_9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
                runOcrCheck: true,
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Post-redaction verification completed and privacy report generated',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/VerificationResponse' },
              },
            },
          },
          400: {
            description: 'Redacted PDF has not been generated yet for this document',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          404: {
            description: 'Document not found',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/api/report/{id}': {
      get: {
        tags: ['Reports & Downloads'],
        summary: 'Retrieve the privacy assessment report by report ID or document ID',
        description:
          'Returns the complete Privacy Assessment Report including before/after counts, successfully removed items, remaining exposed items, indicative privacy assessment, and the SHA-256 hash of the exported PDF.',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Report ID (`rep_...`) or Document ID (`doc_...`)',
          },
        ],
        responses: {
          200: {
            description: 'Privacy assessment report retrieved',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ReportResponse' },
              },
            },
          },
          404: {
            description: 'Report not found',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/api/download/{documentId}': {
      get: {
        tags: ['Reports & Downloads'],
        summary: 'Download the permanently redacted PDF document',
        description:
          'Streams the protected, permanently redacted PDF binary with `Content-Disposition: attachment` and includes the `X-Document-SHA256` integrity header.',
        parameters: [
          {
            name: 'documentId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Document ID (`doc_...`)',
          },
        ],
        responses: {
          200: {
            description: 'Redacted PDF file stream',
            headers: {
              'X-Document-SHA256': {
                description: 'SHA-256 integrity hash of the redacted PDF',
                schema: { type: 'string' },
              },
            },
            content: {
              'application/pdf': {
                schema: { type: 'string', format: 'binary' },
              },
            },
          },
          404: {
            description: 'Redacted PDF not found',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      ErrorResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          error: { type: 'string', example: 'VALIDATION_ERROR' },
          message: { type: 'string', example: 'Detailed human-readable error message.' },
        },
      },
      UploadResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          documentId: { type: 'string', example: 'doc_9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d' },
          fileName: { type: 'string', example: 'fictional_marks_card.pdf' },
          fileSizeBytes: { type: 'integer', example: 24580 },
          originalSha256: {
            type: 'string',
            example: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          },
          extraction: {
            type: 'object',
            properties: {
              pageCount: { type: 'integer', example: 1 },
              extractionMethod: {
                type: 'string',
                enum: ['pdf-text', 'ocr-fallback', 'hybrid'],
                example: 'pdf-text',
              },
              usedOcrFallback: { type: 'boolean', example: false },
              totalCharacters: { type: 'integer', example: 642 },
              pages: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    pageNumber: { type: 'integer', example: 1 },
                    method: { type: 'string', example: 'pdf-text' },
                    characterCount: { type: 'integer', example: 642 },
                    textPreview: {
                      type: 'string',
                      example: 'NATIONAL INSTITUTE OF TECHNOLOGY - STATEMENT OF MARKS...',
                    },
                  },
                },
              },
            },
          },
        },
      },
      DetectedItem: {
        type: 'object',
        properties: {
          id: { type: 'string', example: 'det_1' },
          text: { type: 'string', example: '4829 7301 9482' },
          category: {
            type: 'string',
            enum: [
              'PHONE_NUMBER',
              'EMAIL_ADDRESS',
              'ADDRESS',
              'STUDENT_REG_NUMBER',
              'NATIONAL_ID_AADHAAR',
              'NATIONAL_ID_PAN',
              'FINANCIAL_ACCOUNT',
            ],
            example: 'NATIONAL_ID_AADHAAR',
          },
          categoryLabel: { type: 'string', example: 'Aadhaar / National ID Number' },
          confidence: {
            type: 'string',
            enum: ['HIGH', 'MEDIUM', 'LOW_UNCERTAIN'],
            example: 'HIGH',
          },
          detectionStatus: {
            type: 'string',
            example: 'Pattern matched 12-digit Aadhaar-like identifier with contextual label',
          },
          pageNumber: { type: 'integer', example: 1 },
          boundingBox: {
            type: 'object',
            nullable: true,
            properties: {
              x: { type: 'number', example: 180.5 },
              y: { type: 'number', example: 240.0 },
              width: { type: 'number', example: 112.4 },
              height: { type: 'number', example: 16.0 },
              coordinateSpace: { type: 'string', example: 'pdf-top-left-points' },
            },
          },
        },
      },
      DetectionResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          documentId: { type: 'string', example: 'doc_9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d' },
          totalDetected: { type: 'integer', example: 6 },
          categoryBreakdown: {
            type: 'object',
            example: {
              STUDENT_REG_NUMBER: 1,
              NATIONAL_ID_AADHAAR: 1,
              PHONE_NUMBER: 1,
              EMAIL_ADDRESS: 1,
              ADDRESS: 1,
              FINANCIAL_ACCOUNT: 1,
            },
          },
          disclaimer: {
            type: 'string',
            example:
              'Automated pattern matching identifies common sensitive formats but cannot guarantee detection of all context-dependent personal information. Please review uncertain detections carefully.',
          },
          items: {
            type: 'array',
            items: { $ref: '#/components/schemas/DetectedItem' },
          },
        },
      },
      RedactionResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          documentId: { type: 'string', example: 'doc_9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d' },
          mode: { type: 'string', example: 'selective' },
          totalDetectedBeforeRedaction: { type: 'integer', example: 6 },
          selectedForRedactionCount: { type: 'integer', example: 4 },
          unselectedCount: { type: 'integer', example: 2 },
          redactedPdfSha256: {
            type: 'string',
            example: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
          },
          downloadUrl: {
            type: 'string',
            example: '/api/download/doc_9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
          },
          notice: {
            type: 'string',
            example:
              'Pages were rendered to raster images, masked permanently, and rebuilt into a new PDF. Original embedded text layers have been stripped, which reduces text selectability and searchability in exchange for permanent removal.',
          },
        },
      },
      VerificationResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          documentId: { type: 'string', example: 'doc_9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d' },
          reportId: { type: 'string', example: 'rep_9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d' },
          verification: {
            type: 'object',
            properties: {
              methodsUsed: {
                type: 'array',
                items: { type: 'string' },
                example: ['pdf-text-reextraction', 'tesseract-ocr-scan'],
              },
              selectedItemsCount: { type: 'integer', example: 4 },
              successfullyRemovedCount: { type: 'integer', example: 4 },
              selectedStillDetectableCount: { type: 'integer', example: 0 },
              remainingUnselectedDetectableCount: { type: 'integer', example: 2 },
              removedItems: {
                type: 'array',
                items: { $ref: '#/components/schemas/DetectedItem' },
              },
              remainingItems: {
                type: 'array',
                items: { $ref: '#/components/schemas/DetectedItem' },
              },
            },
          },
          report: { $ref: '#/components/schemas/PrivacyReport' },
        },
      },
      PrivacyReport: {
        type: 'object',
        properties: {
          reportId: { type: 'string', example: 'rep_9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d' },
          documentId: { type: 'string', example: 'doc_9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d' },
          generatedAt: { type: 'string', format: 'date-time' },
          metrics: {
            type: 'object',
            properties: {
              detectedBeforeRedaction: { type: 'integer', example: 6 },
              selectedForRedaction: { type: 'integer', example: 6 },
              noLongerDetectedAfterRedaction: { type: 'integer', example: 6 },
              remainingDetectedAfterRedaction: { type: 'integer', example: 0 },
            },
          },
          beforeAndAfterAssessment: {
            type: 'object',
            properties: {
              beforeStatus: { type: 'string', example: 'HIGH_EXPOSURE (6 sensitive items detected)' },
              afterStatus: { type: 'string', example: 'MINIMAL_DETECTED_EXPOSURE (0 sensitive items detected)' },
              indicativeReductionPercentage: { type: 'number', example: 100 },
              summary: {
                type: 'string',
                example:
                  '6 of 6 detected sensitive items were selected and verified as no longer detectable via text extraction or OCR.',
              },
              disclaimer: {
                type: 'string',
                example:
                  'This privacy score is an indicative assessment based on automated pattern matching and OCR verification, not a legal or absolute guarantee of document safety.',
              },
            },
          },
          remainingSensitiveItems: {
            type: 'array',
            items: { $ref: '#/components/schemas/DetectedItem' },
          },
          exportedDocumentIntegrity: {
            type: 'object',
            properties: {
              algorithm: { type: 'string', example: 'SHA-256' },
              sha256: {
                type: 'string',
                example: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
              },
              fileSizeBytes: { type: 'integer', example: 84320 },
              downloadEndpoint: {
                type: 'string',
                example: '/api/download/doc_9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
              },
            },
          },
        },
      },
      ReportResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          report: { $ref: '#/components/schemas/PrivacyReport' },
        },
      },
    },
  },
};
