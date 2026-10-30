/**
 * Sensitive Information Detection Engine for DocShield.
 *
 * Uses regular expressions and contextual heuristics to detect:
 * 1. Phone numbers (PHONE_NUMBER)
 * 2. Email addresses (EMAIL_ADDRESS)
 * 3. Physical address-like information (ADDRESS)
 * 4. Student registration / roll numbers (STUDENT_REG_NUMBER)
 * 5. Aadhaar-like or National ID-like patterns (NATIONAL_ID_AADHAAR)
 * 6. Financial account / IFSC / card-like numbers (FINANCIAL_ACCOUNT)
 *
 * Returns bounding boxes (when matched to page elements), page numbers,
 * categories, and explicit confidence / uncertainty indicators.
 */

export const SENSITIVE_CATEGORIES = {
  PHONE_NUMBER: 'Phone Number',
  EMAIL_ADDRESS: 'Email Address',
  ADDRESS: 'Physical Address',
  STUDENT_REG_NUMBER: 'Student Registration Number',
  NATIONAL_ID_AADHAAR: 'Aadhaar / National ID Number',
  FINANCIAL_ACCOUNT: 'Financial Account / Banking Identifier',
};

const DETECTION_PATTERNS = [
  {
    category: 'EMAIL_ADDRESS',
    label: SENSITIVE_CATEGORIES.EMAIL_ADDRESS,
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    confidence: 'HIGH',
    statusNote: 'Matched standard RFC email address pattern',
  },
  {
    category: 'STUDENT_REG_NUMBER',
    label: SENSITIVE_CATEGORIES.STUDENT_REG_NUMBER,
    // Matches e.g. REG-2026-CS-0492, USN: 1RV22CS084, STU20240918, Roll No: CS21B1045
    regex: /\b(?:REG-\d{4}-[A-Z]{2,4}-\d{3,6}|1[A-Z]{2}\d{2}[A-Z]{2}\d{3}|STU[-/]?\d{4}[-/]?\d{3,6}|[A-Z]{2}\d{2}[A-Z]\d{4})\b/g,
    confidence: 'HIGH',
    statusNote: 'Matched academic student registration / university roll number format',
  },
  {
    category: 'NATIONAL_ID_AADHAAR',
    label: SENSITIVE_CATEGORIES.NATIONAL_ID_AADHAAR,
    // Matches 12-digit Aadhaar-like (e.g., 4829 7301 9482 or 4829-7301-9482) or PAN-like (ABCDE1234F) or ID-XXXX
    regex: /\b(?:[2-9]\d{3}[\s-]\d{4}[\s-]\d{4}|[A-Z]{5}\d{4}[A-Z]|ID-\d{4}-\d{4})\b/g,
    confidence: 'HIGH',
    statusNote: 'Matched 12-digit Aadhaar-like space/hyphen-separated pattern or national ID code',
  },
  {
    category: 'PHONE_NUMBER',
    label: SENSITIVE_CATEGORIES.PHONE_NUMBER,
    // Matches Indian/International phone numbers e.g. +91-9876543210, +91 98765 43210, (555) 234-5678, 9876543210
    regex: /(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b|\+\d{1,3}[\s-]?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}\b/g,
    confidence: 'MEDIUM',
    statusNote: 'Matched 10-digit mobile / telephone number pattern',
  },
  {
    category: 'FINANCIAL_ACCOUNT',
    label: SENSITIVE_CATEGORIES.FINANCIAL_ACCOUNT,
    // Matches IFSC codes (SBIN0004821), masked/full account numbers with context or 11-16 digit account/card numbers
    regex: /\b(?:[A-Z]{4}0[A-Z0-9]{6}|ACC-\d{4}-\d{6,8}|(?:\d{4}[\s-]){3}\d{4})\b/g,
    confidence: 'MEDIUM',
    statusNote: 'Matched financial account number, IFSC code, or 16-digit payment card pattern',
  },
  {
    category: 'ADDRESS',
    label: SENSITIVE_CATEGORIES.ADDRESS,
    // Matches address phrases like "No. 42, MG Road, Bengaluru - 560001" or "Flat 302, Green Valley Apt, Pune 411001"
    regex: /\b(?:No\.?\s*\d+|Flat\s*#?\d+|Plot\s*#?\d+|\d{1,4}\s+[A-Z][a-z]+\s+(?:Street|St|Road|Rd|Avenue|Ave|Layout|Nagar|Park|Block))[A-Za-z0-9,\s.-]{8,65}?(?:-\s*\d{6}|\b\d{5,6}\b)/gi,
    confidence: 'LOW_UNCERTAIN',
    statusNote: 'Heuristic address pattern (street/building + postal PIN code); review carefully as addresses vary widely',
  },
];

/**
 * Locate the best bounding box on the page for a detected text snippet.
 * Searches through extracted PDF text elements and OCR word/line elements.
 */
function findBoundingBoxForMatch(matchText, page, usedBoxes) {
  const normalizedTarget = matchText.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalizedTarget) return null;

  const elements = page.elements || [];

  // 1. Direct containment in an element (e.g. a PDF text line or OCR line containing the match)
  for (const el of elements) {
    const elText = (el.text || '').replace(/\s+/g, ' ').trim();
    const elLower = elText.toLowerCase();
    if (!elLower) continue;

    const idx = elLower.indexOf(normalizedTarget);
    if (idx !== -1) {
      // Estimate horizontal sub-box within the text line if the element is much wider than the match
      const ratioStart = Math.max(0, idx / Math.max(elLower.length, 1));
      const ratioWidth = Math.min(1 - ratioStart, normalizedTarget.length / Math.max(elLower.length, 1));

      // Add generous padding on width/height so redaction covers the full sensitive string cleanly
      const subX = Math.max(0, el.x + el.width * ratioStart - 4);
      const subWidth = Math.min(page.width - subX, Math.max(el.width * ratioWidth + 12, 40));
      const boxKey = `${Math.round(subX)}_${Math.round(el.y)}`;

      if (!usedBoxes.has(boxKey)) {
        usedBoxes.add(boxKey);
        return {
          x: Number(subX.toFixed(2)),
          y: Number(Math.max(0, el.y - 2).toFixed(2)),
          width: Number(subWidth.toFixed(2)),
          height: Number((el.height + 4).toFixed(2)),
          coordinateSpace: 'pdf-top-left-points',
        };
      }
    }
  }

  // 2. Multi-token union match (e.g. when OCR splits "4829 7301 9482" into 3 word boxes)
  const targetTokens = normalizedTarget.split(/[\s,.-]+/).filter((t) => t.length >= 2);
  if (targetTokens.length > 0) {
    const matchedEls = elements.filter((el) => {
      const w = (el.text || '').toLowerCase();
      return targetTokens.some((tok) => w.includes(tok));
    });

    if (matchedEls.length > 0) {
      // Group elements that are on roughly the same vertical band
      const anchor = matchedEls[0];
      const cluster = matchedEls.filter((el) => Math.abs(el.y - anchor.y) < 35);
      const minX = Math.min(...cluster.map((c) => c.x));
      const minY = Math.min(...cluster.map((c) => c.y));
      const maxX = Math.max(...cluster.map((c) => c.x + c.width));
      const maxY = Math.max(...cluster.map((c) => c.y + c.height));

      return {
        x: Number(Math.max(0, minX - 4).toFixed(2)),
        y: Number(Math.max(0, minY - 2).toFixed(2)),
        width: Number(Math.min(page.width - minX, maxX - minX + 10).toFixed(2)),
        height: Number((maxY - minY + 4).toFixed(2)),
        coordinateSpace: 'pdf-top-left-points',
      };
    }
  }

  return null;
}

/**
 * Run sensitive information detection across all extracted pages of a document.
 *
 * @param {object} extractionResult - Output from extractPdfContent()
 * @param {string[]} allowedCategories - Optional subset of category keys
 */
export function detectSensitiveInfo(extractionResult, allowedCategories = null) {
  const categorySet =
    Array.isArray(allowedCategories) && allowedCategories.length > 0
      ? new Set(allowedCategories)
      : new Set(Object.keys(SENSITIVE_CATEGORIES));

  const detectedItems = [];
  const categoryBreakdown = {};
  let counter = 1;

  for (const page of extractionResult.pages || []) {
    const pageText = page.text || '';
    const usedBoxes = new Set();
    const seenOnPage = new Set();

    for (const pattern of DETECTION_PATTERNS) {
      if (!categorySet.has(pattern.category)) continue;

      const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
      let match;
      while ((match = regex.exec(pageText)) !== null) {
        const matchedText = match[0].trim();
        if (!matchedText) continue;

        // Prevent duplicate overlap (e.g., an Aadhaar 12-digit number also matching a 10-digit phone regex)
        const dedupeKey = `${pattern.category}::${matchedText}`;
        if (seenOnPage.has(dedupeKey)) continue;

        // Avoid classifying part of an Aadhaar or Financial Account number as a Phone Number
        if (pattern.category === 'PHONE_NUMBER') {
          const alreadyMatchedAsIdOrAcc = detectedItems.some(
            (item) =>
              item.pageNumber === page.pageNumber &&
              (item.category === 'NATIONAL_ID_AADHAAR' || item.category === 'FINANCIAL_ACCOUNT') &&
              item.text.includes(matchedText)
          );
          if (alreadyMatchedAsIdOrAcc) continue;
        }

        seenOnPage.add(dedupeKey);

        const boundingBox = findBoundingBoxForMatch(matchedText, page, usedBoxes);
        const confidence = boundingBox ? pattern.confidence : 'LOW_UNCERTAIN';
        const detectionStatus = boundingBox
          ? pattern.statusNote
          : `${pattern.statusNote} (exact bounding box uncertain; fallback line region applied)`;

        const item = {
          id: `det_${counter++}`,
          text: matchedText,
          category: pattern.category,
          categoryLabel: pattern.label,
          confidence,
          detectionStatus,
          pageNumber: page.pageNumber,
          boundingBox,
        };

        detectedItems.push(item);
        categoryBreakdown[pattern.category] = (categoryBreakdown[pattern.category] || 0) + 1;
      }
    }
  }

  return {
    totalDetected: detectedItems.length,
    categoryBreakdown,
    disclaimer:
      'Automated pattern matching identifies common sensitive formats but cannot guarantee detection of every context-dependent personal detail. Uncertain detections are marked with LOW_UNCERTAIN confidence for human review.',
    items: detectedItems,
  };
}
