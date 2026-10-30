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
 * Returns bounding boxes (and per-line boundingBoxes for multi-line wrapped values),
 * page numbers, categories, and explicit confidence / uncertainty indicators.
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

function cleanToken(str) {
  return (str || '').replace(/^[,.;:()[\]"']+|[,.;:()[\]"']+$/g, '').trim().toLowerCase();
}

/**
 * Check if a candidate word token matches a target token under constrained fallback rules:
 * Only matches if the candidate word starts with a label prefix separated by `:`, `=`, or `/`
 * (e.g., `email:user@example.com` or `no:reg-2026-cs-0492`), never an arbitrary alphanumeric superstring
 * like `ref482900` for `4829`.
 */
function isConstrainedPrefixMatch(wordNorm, targetNorm) {
  if (!wordNorm || !targetNorm || wordNorm === targetNorm) return false;
  if (!wordNorm.endsWith(targetNorm)) return false;
  const prefix = wordNorm.slice(0, wordNorm.length - targetNorm.length);
  return /[:=/#-]$/.test(prefix);
}

/**
 * Group a list of page elements into distinct horizontal line bands (within 12pt Y tolerance)
 * and compute a tight bounding box per line band, plus an overall summary boundingBox.
 */
function buildLineBoxesFromElements(elements, pageWidth) {
  if (!elements || elements.length === 0) return null;

  const bands = [];
  for (const el of elements) {
    let band = bands.find((b) => Math.abs(b.anchorY - el.y) <= 12);
    if (!band) {
      band = { anchorY: el.y, items: [] };
      bands.push(band);
    }
    band.items.push(el);
  }

  const boundingBoxes = bands.map((band) => {
    const minX = Math.min(...band.items.map((w) => w.x));
    const minY = Math.min(...band.items.map((w) => w.y));
    const maxX = Math.max(...band.items.map((w) => w.x + w.width));
    const maxY = Math.max(...band.items.map((w) => w.y + w.height));

    const boxX = Math.max(0, minX - 3);
    const boxY = Math.max(0, minY - 2);
    const boxW = Math.min(pageWidth - boxX, maxX - minX + 6);
    const boxH = maxY - minY + 4;

    return {
      x: Number(boxX.toFixed(2)),
      y: Number(boxY.toFixed(2)),
      width: Number(boxW.toFixed(2)),
      height: Number(boxH.toFixed(2)),
      coordinateSpace: 'pdf-top-left-points',
    };
  });

  const overallMinX = Math.min(...boundingBoxes.map((b) => b.x));
  const overallMinY = Math.min(...boundingBoxes.map((b) => b.y));
  const overallMaxX = Math.max(...boundingBoxes.map((b) => b.x + b.width));
  const overallMaxY = Math.max(...boundingBoxes.map((b) => b.y + b.height));

  const primaryBox = {
    x: Number(overallMinX.toFixed(2)),
    y: Number(overallMinY.toFixed(2)),
    width: Number((overallMaxX - overallMinX).toFixed(2)),
    height: Number((overallMaxY - overallMinY).toFixed(2)),
    coordinateSpace: 'pdf-top-left-points',
  };

  return {
    boundingBox: primaryBox,
    boundingBoxes,
  };
}

/**
 * Compute proportional horizontal sub-box within a single line element (`pdf-text` or `ocr-line`)
 * for a substring [startCharIdx, startCharIdx + subLength].
 */
function buildSubBoxInLineElement(el, startCharIdx, subLength, pageWidth) {
  const elText = (el.text || '').replace(/\s+/g, ' ').trim();
  const totalLen = Math.max(elText.length, 1);
  const ratioStart = Math.max(0, startCharIdx / totalLen);
  const ratioWidth = Math.min(1 - ratioStart, subLength / totalLen);

  const subX = Math.max(0, el.x + el.width * ratioStart - 4);
  const subWidth = Math.min(pageWidth - subX, Math.max(el.width * ratioWidth + 12, 36));

  return {
    x: Number(subX.toFixed(2)),
    y: Number(Math.max(0, el.y - 2).toFixed(2)),
    width: Number(subWidth.toFixed(2)),
    height: Number((el.height + 4).toFixed(2)),
    coordinateSpace: 'pdf-top-left-points',
  };
}

/**
 * Locate the accurate bounding box(es) on the page for a detected text snippet.
 *
 * Addresses Code Review Findings:
 * - L-1: Strategy 1 runs a strict exact token pass (`wNorm === tNorm`) first before considering
 *        a constrained label-prefix fallback pass (`isConstrainedPrefixMatch`), preventing false
 *        substring collisions (e.g., `"4829"` inside `"REF482900"`).
 * - M-1: Tracks consumed word/line element positions in `usedBoxKeys` so duplicate occurrences of
 *        the same email, phone number, or ID on the same page each receive their own distinct bounding box.
 * - H-1: Supports multi-line / wrapped sensitive values (both across contiguous OCR words on consecutive
 *        lines and across consecutive `pdf-text` / `ocr-line` elements), returning per-line `boundingBoxes`
 *        so every wrapped line is masked tightly without drawing a giant box over unrelated text.
 * - H-2: Never anchors blindly to `matchedEls[0]` using a single shared word (like a city name in a header);
 *        requires contiguous token sequence matching or multi-line prefix+suffix line continuity.
 */
export function findBoundingBoxForMatch(matchText, page, usedBoxKeys) {
  const normalizedTarget = matchText.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalizedTarget) return null;

  const elements = page.elements || [];
  if (elements.length === 0) return null;

  const ocrWords = elements.filter((el) => el.source === 'ocr');
  const targetWords = normalizedTarget.split(/\s+/).map(cleanToken).filter(Boolean);

  // =========================================================================
  // STRATEGY 1: Word-level contiguous sequence match (`source === 'ocr'`)
  // Pass 1A: Strict exact token equality (`wNorm === tNorm`)
  // Pass 1B: Constrained label-prefix equality (`wNorm === tNorm || isConstrainedPrefixMatch`)
  // =========================================================================
  if (ocrWords.length > 0 && targetWords.length > 0) {
    for (const allowPrefixFallback of [false, true]) {
      for (let i = 0; i <= ocrWords.length - targetWords.length; i++) {
        let allMatch = true;
        for (let j = 0; j < targetWords.length; j++) {
          const wNorm = cleanToken(ocrWords[i + j].text);
          const tNorm = targetWords[j];
          const isExact = wNorm === tNorm;
          const isConstrained = allowPrefixFallback && isConstrainedPrefixMatch(wNorm, tNorm);
          if (!isExact && !isConstrained) {
            allMatch = false;
            break;
          }
        }

        if (allMatch) {
          const seqKey = `ocr_word_seq_${i}_${targetWords.length}`;
          if (!usedBoxKeys.has(seqKey)) {
            usedBoxKeys.add(seqKey);
            const seq = ocrWords.slice(i, i + targetWords.length);
            return buildLineBoxesFromElements(seq, page.width);
          }
        }
      }
    }
  }

  // =========================================================================
  // STRATEGY 2: Single-line and Multi-line Wrapped Containment in Line Elements
  // (`source === 'pdf-text'` or `source === 'ocr-line'`)
  // =========================================================================
  const lineElements = elements.filter((el) => el.source !== 'ocr');
  const candidateLines = lineElements.length > 0 ? lineElements : elements;

  // Pass 2A: Single-line direct substring containment (supports multiple occurrences on same/different lines)
  for (let elIdx = 0; elIdx < candidateLines.length; elIdx++) {
    const el = candidateLines[elIdx];
    const elText = (el.text || '').replace(/\s+/g, ' ').trim();
    const elLower = elText.toLowerCase();
    if (!elLower) continue;

    let searchStart = 0;
    while (searchStart < elLower.length) {
      const idx = elLower.indexOf(normalizedTarget, searchStart);
      if (idx === -1) break;

      const boxKey = `line_single_${elIdx}_${idx}`;
      if (!usedBoxKeys.has(boxKey)) {
        usedBoxKeys.add(boxKey);
        const subBox = buildSubBoxInLineElement(el, idx, normalizedTarget.length, page.width);
        return {
          boundingBox: subBox,
          boundingBoxes: [subBox],
        };
      }
      searchStart = idx + Math.max(normalizedTarget.length, 1);
    }
  }

  // Pass 2B: Multi-line wrapped value across 2 or 3 consecutive line elements (Fixes H-1 & H-2)
  if (candidateLines.length >= 2) {
    for (const spanCount of [2, 3]) {
      for (let startIdx = 0; startIdx <= candidateLines.length - spanCount; startIdx++) {
        const spanEls = candidateLines.slice(startIdx, startIdx + spanCount);
        const normTexts = spanEls.map((e) => (e.text || '').replace(/\s+/g, ' ').trim().toLowerCase());
        if (normTexts.some((t) => !t)) continue;

        // Build combined text with single-space join and track each line's [charStart, charEnd]
        const ranges = [];
        let combined = '';
        for (let k = 0; k < normTexts.length; k++) {
          if (k > 0) combined += ' ';
          const s = combined.length;
          combined += normTexts[k];
          ranges.push({ lineIndex: k, start: s, end: combined.length, text: normTexts[k] });
        }

        const matchPos = combined.indexOf(normalizedTarget);
        if (matchPos !== -1) {
          const matchEnd = matchPos + normalizedTarget.length;
          // Ensure the match actually spans across the boundary of the selected lines
          const touchesFirst = matchPos < ranges[0].end;
          const touchesLast = matchEnd > ranges[ranges.length - 1].start;
          if (!touchesFirst || !touchesLast) continue;

          const spanKey = `line_wrapped_${startIdx}_${spanCount}_${matchPos}`;
          if (usedBoxKeys.has(spanKey)) continue;
          usedBoxKeys.add(spanKey);

          const boundingBoxes = [];
          for (const r of ranges) {
            const overlapStart = Math.max(matchPos, r.start);
            const overlapEnd = Math.min(matchEnd, r.end);
            if (overlapEnd > overlapStart) {
              const localStart = overlapStart - r.start;
              const localLen = overlapEnd - overlapStart;
              const el = spanEls[r.lineIndex];
              boundingBoxes.push(buildSubBoxInLineElement(el, localStart, localLen, page.width));
            }
          }

          if (boundingBoxes.length > 0) {
            const minX = Math.min(...boundingBoxes.map((b) => b.x));
            const minY = Math.min(...boundingBoxes.map((b) => b.y));
            const maxX = Math.max(...boundingBoxes.map((b) => b.x + b.width));
            const maxY = Math.max(...boundingBoxes.map((b) => b.y + b.height));

            return {
              boundingBox: {
                x: Number(minX.toFixed(2)),
                y: Number(minY.toFixed(2)),
                width: Number((maxX - minX).toFixed(2)),
                height: Number((maxY - minY).toFixed(2)),
                coordinateSpace: 'pdf-top-left-points',
              },
              boundingBoxes,
            };
          }
        }
      }
    }
  }

  // =========================================================================
  // STRATEGY 3: Ordered Contiguous Sub-Token Window Match (Fixes H-1 & H-2)
  // Requires at least 60% of split tokens (and at least the starting token) to
  // appear in order within a contiguous window of page words, preventing a single
  // common word (like a city name in the header) from anchoring the bounding box.
  // =========================================================================
  const splitTokens = normalizedTarget.split(/[\s,.-]+/).map(cleanToken).filter((t) => t.length >= 2);
  if (splitTokens.length >= 2 && ocrWords.length > 0) {
    const firstTok = splitTokens[0];
    const lastTok = splitTokens[splitTokens.length - 1];
    const maxWindowLen = splitTokens.length + 4;

    for (let i = 0; i < ocrWords.length; i++) {
      const wStart = cleanToken(ocrWords[i].text);
      if (wStart !== firstTok && !isConstrainedPrefixMatch(wStart, firstTok)) continue;

      for (let end = i + 1; end < Math.min(ocrWords.length, i + maxWindowLen); end++) {
        const wEnd = cleanToken(ocrWords[end].text);
        if (wEnd !== lastTok) continue;

        const windowWords = ocrWords.slice(i, end + 1);
        const matchedTokenCount = splitTokens.filter((tok) =>
          windowWords.some((w) => cleanToken(w.text) === tok || isConstrainedPrefixMatch(cleanToken(w.text), tok))
        ).length;

        if (matchedTokenCount >= Math.ceil(splitTokens.length * 0.6)) {
          const winKey = `ocr_window_${i}_${end}`;
          if (!usedBoxKeys.has(winKey)) {
            usedBoxKeys.add(winKey);
            return buildLineBoxesFromElements(windowWords, page.width);
          }
        }
      }
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
    const usedBoxKeys = new Set();
    // Track character spans [start, end] on pageText to prevent cross-category overlap at the SAME text offset,
    // while allowing duplicate occurrences of the same value at DIFFERENT offsets on the page (Fixes M-1).
    const matchedIntervals = [];

    for (const pattern of DETECTION_PATTERNS) {
      if (!categorySet.has(pattern.category)) continue;

      const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
      let match;
      while ((match = regex.exec(pageText)) !== null) {
        const rawMatch = match[0];
        const matchedText = rawMatch.trim();
        if (!matchedText) continue;

        const matchStart = match.index + rawMatch.indexOf(matchedText);
        const matchEnd = matchStart + matchedText.length;

        // Skip if this exact character span [matchStart, matchEnd] was already matched
        // by an equal or higher-priority pattern (e.g., a 10-digit substring inside an Aadhaar or Account number)
        const overlapsExistingSpan = matchedIntervals.some(
          (span) => matchStart >= span.start && matchEnd <= span.end
        );
        if (overlapsExistingSpan) continue;

        matchedIntervals.push({
          start: matchStart,
          end: matchEnd,
          category: pattern.category,
          text: matchedText,
        });

        const boxResult = findBoundingBoxForMatch(matchedText, page, usedBoxKeys);
        const boundingBox = boxResult ? boxResult.boundingBox : null;
        const boundingBoxes = boxResult ? boxResult.boundingBoxes : null;

        const confidence = boundingBox ? pattern.confidence : 'LOW_UNCERTAIN';
        const detectionStatus = boundingBox
          ? pattern.statusNote
          : `${pattern.statusNote} (coordinates could not be established on page)`;

        const item = {
          id: `det_${counter++}`,
          text: matchedText,
          category: pattern.category,
          categoryLabel: pattern.label,
          confidence,
          detectionStatus,
          pageNumber: page.pageNumber,
          boundingBox,
          ...(boundingBoxes && boundingBoxes.length > 1 ? { boundingBoxes } : {}),
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
