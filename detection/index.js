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
  NATIONAL_ID_PAN: 'Permanent Account Number (PAN)',
  FINANCIAL_ACCOUNT: 'Financial Account / Banking Identifier',
};

const DETECTION_PATTERNS = [
  {
    category: 'EMAIL_ADDRESS',
    label: SENSITIVE_CATEGORIES.EMAIL_ADDRESS,
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    confidence: 'HIGH',
    specificity: 95,
    contextKeywords: ['email', 'e-mail', 'mail', 'contact'],
    statusNote: 'Matched standard RFC email address pattern',
  },
  {
    category: 'STUDENT_REG_NUMBER',
    label: SENSITIVE_CATEGORIES.STUDENT_REG_NUMBER,
    // Matches e.g. REG-2026-CS-0492, USN: 1RV22CS084, STU20240918, Roll No: CS21B1045
    regex: /\b(?:REG-\d{4}-[A-Z]{2,4}-\d{3,6}|1[A-Z]{2}\d{2}[A-Z]{2}\d{3}|STU[-/]?\d{4}[-/]?\d{3,6}|[A-Z]{2}\d{2}[A-Z]\d{4})\b/g,
    confidence: 'HIGH',
    specificity: 92,
    contextKeywords: ['registration', 'reg', 'usn', 'roll', 'student', 'enrollment'],
    statusNote: 'Matched academic student registration / university roll number format',
  },
  {
    category: 'NATIONAL_ID_PAN',
    label: SENSITIVE_CATEGORIES.NATIONAL_ID_PAN,
    // Matches Indian Income Tax Permanent Account Number (5 uppercase letters + 4 digits + 1 uppercase check letter)
    regex: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
    confidence: 'HIGH',
    specificity: 94,
    contextKeywords: ['pan', 'tax', 'income tax', 'permanent account'],
    statusNote: 'Matched 10-character Indian Permanent Account Number (PAN) format',
  },
  {
    category: 'FINANCIAL_ACCOUNT',
    label: SENSITIVE_CATEGORIES.FINANCIAL_ACCOUNT,
    // Matches IFSC codes (SBIN0004821), masked/full account numbers with context, or 16-digit payment card numbers
    regex: /\b(?:[A-Z]{4}0[A-Z0-9]{6}|ACC-\d{4}-\d{6,8}|(?<![\d-])(?:\d{4}[\s-]){3}\d{4}(?![\s-]\d{4}))\b/g,
    confidence: 'MEDIUM',
    specificity: 90,
    contextKeywords: ['card', 'account', 'acc', 'ifsc', 'bank', 'branch', 'disbursement', 'credit', 'debit', 'payment'],
    statusNote: 'Matched financial account number, IFSC code, or 16-digit payment card pattern',
  },
  {
    category: 'NATIONAL_ID_AADHAAR',
    label: SENSITIVE_CATEGORIES.NATIONAL_ID_AADHAAR,
    // Matches standalone 12-digit Aadhaar-like (e.g., 4829 7301 9482 or 4829-7301-9482, not part of a 16-digit sequence) or ID-XXXX-XXXX
    regex: /\b(?:(?<!\d{4}[\s-])(?<![\d-])[2-9]\d{3}[\s-]\d{4}[\s-]\d{4}(?![\s-]\d{4})|ID-\d{4}-\d{4})\b/g,
    confidence: 'HIGH',
    specificity: 88,
    contextKeywords: ['aadhaar', 'aadhar', 'uidai', 'national id', 'identity', 'kyc'],
    statusNote: 'Matched 12-digit Aadhaar-like space/hyphen-separated pattern or national ID code',
  },
  {
    category: 'PHONE_NUMBER',
    label: SENSITIVE_CATEGORIES.PHONE_NUMBER,
    // Matches Indian/International phone numbers e.g. +91-9876543210, +91 98765 43210, (555) 234-5678, 9876543210
    regex: /(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b|\+\d{1,3}[\s-]?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}\b/g,
    confidence: 'MEDIUM',
    specificity: 80,
    contextKeywords: ['phone', 'mobile', 'contact', 'tel', 'telephone', 'cell', 'guardian'],
    statusNote: 'Matched 10-digit mobile / telephone number pattern',
  },
  {
    category: 'ADDRESS',
    label: SENSITIVE_CATEGORIES.ADDRESS,
    // Matches address phrases like "No. 42, MG Road, Bengaluru - 560001" or "Flat 302, Green Valley Apt, Pune 411001"
    regex: /\b(?:No\.?\s*\d+|Flat\s*#?\d+|Plot\s*#?\d+|\d{1,4}\s+[A-Z][a-z]+\s+(?:Street|St|Road|Rd|Avenue|Ave|Layout|Nagar|Park|Block))[A-Za-z0-9,\s.-]{8,65}?(?:-\s*\d{6}|\b\d{5,6}\b)/gi,
    confidence: 'LOW_UNCERTAIN',
    specificity: 85,
    contextKeywords: ['address', 'residence', 'residential', 'permanent', 'street', 'road', 'flat', 'plot'],
    statusNote: 'Heuristic address pattern (street/building + postal PIN code); review carefully as addresses vary widely',
  },
];

function cleanToken(str) {
  return (str || '').replace(/^[,.;:()[\]"']+|[,.;:()[\]"']+$/g, '').trim().toLowerCase();
}

/**
 * Compute a deterministic score for a candidate detection to resolve overlapping matches
 * on the same underlying text span using pattern specificity, surrounding label context, and match length.
 */
function scoreCandidateMatch(candidate, pageText) {
  const lookbehindStart = Math.max(0, candidate.start - 48);
  const precedingContext = pageText.slice(lookbehindStart, candidate.start).toLowerCase();
  const followingContext = pageText.slice(candidate.end, Math.min(pageText.length, candidate.end + 24)).toLowerCase();

  let contextBonus = 0;
  for (const kw of candidate.pattern.contextKeywords || []) {
    if (precedingContext.includes(kw)) {
      contextBonus += 25;
      break;
    }
    if (followingContext.includes(kw)) {
      contextBonus += 10;
      break;
    }
  }

  return candidate.length * 10 + (candidate.pattern.specificity || 50) + contextBonus;
}

/**
 * Resolve overlapping candidate detections on the same page deterministically:
 * - Candidates that do not overlap any character indices are always preserved (even if nearby on the same line).
 * - When two candidates overlap in character span `[start, end)`, the candidate with the higher
 *   context + specificity + span length score wins.
 */
function resolveOverlappingCandidates(candidates, pageText) {
  const scored = candidates.map((c) => ({
    ...c,
    score: scoreCandidateMatch(c, pageText),
  }));

  // Sort by highest score first, then longest span, then earliest start offset
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.length !== a.length) return b.length - a.length;
    return a.start - b.start;
  });

  const accepted = [];
  for (const cand of scored) {
    const hasOverlap = accepted.some((acc) => cand.start < acc.end && cand.end > acc.start);
    if (!hasOverlap) {
      accepted.push(cand);
    }
  }

  // Restore natural document reading order (by start offset)
  accepted.sort((a, b) => a.start - b.start);
  return accepted;
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
  if (el.fullRectCover || el.source === 'pdf-annotation') {
    const boxX = Math.max(0, el.x);
    const boxW = Math.min(pageWidth - boxX, el.width);
    return {
      x: Number(boxX.toFixed(2)),
      y: Number(Math.max(0, el.y).toFixed(2)),
      width: Number(boxW.toFixed(2)),
      height: Number(el.height.toFixed(2)),
      coordinateSpace: 'pdf-top-left-points',
    };
  }

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
 * Handles:
 * - Word-level contiguous OCR sequences (exact pass first, then constrained label-prefix pass).
 * - Single-line substring containment with flexible whitespace normalization (`\s+`) and punctuation-insensitive fallback.
 * - Multi-element / multi-line spans across up to 6 consecutive PDF text runs or wrapped lines
 *   (handling split font runs, kerning splits, and line breaks).
 * - Ordered contiguous sub-token window matching across both OCR words and PDF text elements.
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
          const seqKey = `ocr_word_seq_${i}_${targetWords.length}_${normalizedTarget}`;
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
  // STRATEGY 2: Single-line and Multi-Run / Multi-Line Containment in Line Elements
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

      const boxKey = `line_single_${elIdx}_${idx}_${normalizedTarget.length}`;
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

  // Pass 2B: Multi-run / Multi-line wrapped value across 2 to 6 consecutive elements
  // Handles both multi-line wrapped text (e.g., 2-3 line addresses) and single lines split into multiple PDF text runs
  // due to font changes, kerning, or inline formatting.
  if (candidateLines.length >= 2) {
    const maxSpan = Math.min(6, candidateLines.length);
    for (let spanCount = 2; spanCount <= maxSpan; spanCount++) {
      for (let startIdx = 0; startIdx <= candidateLines.length - spanCount; startIdx++) {
        const spanEls = candidateLines.slice(startIdx, startIdx + spanCount);
        const normTexts = spanEls.map((e) => (e.text || '').replace(/\s+/g, ' ').trim().toLowerCase());
        if (normTexts.some((t) => !t)) continue;

        // Build combined text with single-space join and track each element's [charStart, charEnd]
        const ranges = [];
        let combined = '';
        for (let k = 0; k < normTexts.length; k++) {
          if (k > 0) combined += ' ';
          const s = combined.length;
          combined += normTexts[k];
          ranges.push({ lineIndex: k, start: s, end: combined.length, text: normTexts[k] });
        }

        let searchPos = 0;
        while (searchPos < combined.length) {
          const matchPos = combined.indexOf(normalizedTarget, searchPos);
          if (matchPos === -1) break;
          searchPos = matchPos + 1;

          const matchEnd = matchPos + normalizedTarget.length;
          // Ensure the match actually spans from the first element into the last element of this window
          const touchesFirst = matchPos < ranges[0].end;
          const touchesLast = matchEnd > ranges[ranges.length - 1].start;
          if (!touchesFirst || !touchesLast) continue;

          const spanKey = `line_wrapped_${startIdx}_${spanCount}_${matchPos}_${normalizedTarget.length}`;
          if (usedBoxKeys.has(spanKey)) continue;
          usedBoxKeys.add(spanKey);

          const rawSubBoxes = [];
          for (const r of ranges) {
            const overlapStart = Math.max(matchPos, r.start);
            const overlapEnd = Math.min(matchEnd, r.end);
            if (overlapEnd > overlapStart) {
              const localStart = overlapStart - r.start;
              const localLen = overlapEnd - overlapStart;
              const el = spanEls[r.lineIndex];
              rawSubBoxes.push(buildSubBoxInLineElement(el, localStart, localLen, page.width));
            }
          }

          if (rawSubBoxes.length > 0) {
            // Merge sub-boxes that lie on the same horizontal line band (within 8pt Y) so split runs on the same
            // line coalesce into a single clean line box, while multi-line wraps stay as separate per-line boxes.
            const mergedLineBoxes = [];
            for (const sb of rawSubBoxes) {
              const sameLine = mergedLineBoxes.find((mb) => Math.abs(mb.y - sb.y) <= 8);
              if (!sameLine) {
                mergedLineBoxes.push({ ...sb });
              } else {
                const minX = Math.min(sameLine.x, sb.x);
                const minY = Math.min(sameLine.y, sb.y);
                const maxX = Math.max(sameLine.x + sameLine.width, sb.x + sb.width);
                const maxY = Math.max(sameLine.y + sameLine.height, sb.y + sb.height);
                sameLine.x = Number(minX.toFixed(2));
                sameLine.y = Number(minY.toFixed(2));
                sameLine.width = Number((maxX - minX).toFixed(2));
                sameLine.height = Number((maxY - minY).toFixed(2));
              }
            }

            const minX = Math.min(...mergedLineBoxes.map((b) => b.x));
            const minY = Math.min(...mergedLineBoxes.map((b) => b.y));
            const maxX = Math.max(...mergedLineBoxes.map((b) => b.x + b.width));
            const maxY = Math.max(...mergedLineBoxes.map((b) => b.y + b.height));

            return {
              boundingBox: {
                x: Number(minX.toFixed(2)),
                y: Number(minY.toFixed(2)),
                width: Number((maxX - minX).toFixed(2)),
                height: Number((maxY - minY).toFixed(2)),
                coordinateSpace: 'pdf-top-left-points',
              },
              boundingBoxes: mergedLineBoxes,
            };
          }
        }
      }
    }
  }

  // Pass 2C: Whitespace- and delimiter-flexible matching inside single or consecutive line elements
  // Handles cases where PDF text extraction inserts or omits spaces around hyphens/colons/slashes.
  const compactTarget = normalizedTarget.replace(/[\s-]+/g, '');
  if (compactTarget.length >= 6) {
    for (let elIdx = 0; elIdx < candidateLines.length; elIdx++) {
      const el = candidateLines[elIdx];
      const elText = (el.text || '').replace(/\s+/g, ' ').trim();
      const elLower = elText.toLowerCase();
      if (!elLower) continue;

      // Build character mapping from compact string back to elLower indices
      const charMap = [];
      let compactEl = '';
      for (let cIdx = 0; cIdx < elLower.length; cIdx++) {
        const ch = elLower[cIdx];
        if (!/[\s-]/.test(ch)) {
          charMap.push(cIdx);
          compactEl += ch;
        }
      }

      let cSearch = 0;
      while (cSearch < compactEl.length) {
        const cMatchIdx = compactEl.indexOf(compactTarget, cSearch);
        if (cMatchIdx === -1) break;
        cSearch = cMatchIdx + compactTarget.length;

        const origStart = charMap[cMatchIdx];
        const origEnd = charMap[cMatchIdx + compactTarget.length - 1] + 1;
        const origLen = origEnd - origStart;
        const boxKey = `line_compact_${elIdx}_${origStart}_${origLen}`;
        if (!usedBoxKeys.has(boxKey)) {
          usedBoxKeys.add(boxKey);
          const subBox = buildSubBoxInLineElement(el, origStart, origLen, page.width);
          return {
            boundingBox: subBox,
            boundingBoxes: [subBox],
          };
        }
      }
    }
  }

  // =========================================================================
  // STRATEGY 3: Ordered Contiguous Sub-Token Window Match (OCR words or PDF elements)
  // Requires at least 60% of split tokens (and both first & last tokens) to
  // appear in order within a contiguous window, preventing a single common word
  // (like a city name in the header) from anchoring the bounding box.
  // =========================================================================
  const splitTokens = normalizedTarget.split(/[\s,.-]+/).map(cleanToken).filter((t) => t.length >= 2);
  const wordPool = ocrWords.length > 0 ? ocrWords : candidateLines;
  if (splitTokens.length >= 2 && wordPool.length > 0) {
    const firstTok = splitTokens[0];
    const lastTok = splitTokens[splitTokens.length - 1];
    const maxWindowLen = splitTokens.length + 4;

    for (let i = 0; i < wordPool.length; i++) {
      const wStartTokens = (wordPool[i].text || '').toLowerCase().split(/[\s,.-]+/).map(cleanToken).filter(Boolean);
      const hasStart = wStartTokens.some((w) => w === firstTok || isConstrainedPrefixMatch(w, firstTok));
      if (!hasStart) continue;

      for (let end = i; end < Math.min(wordPool.length, i + maxWindowLen); end++) {
        if (end === i && ocrWords.length > 0) continue;
        const wEndTokens = (wordPool[end].text || '').toLowerCase().split(/[\s,.-]+/).map(cleanToken).filter(Boolean);
        const hasEnd = wEndTokens.some((w) => w === lastTok);
        if (!hasEnd) continue;

        const windowEls = wordPool.slice(i, end + 1);
        const windowTokens = windowEls
          .flatMap((el) => (el.text || '').toLowerCase().split(/[\s,.-]+/).map(cleanToken))
          .filter(Boolean);

        const matchedTokenCount = splitTokens.filter((tok) =>
          windowTokens.some((w) => w === tok || isConstrainedPrefixMatch(w, tok))
        ).length;

        if (matchedTokenCount >= Math.ceil(splitTokens.length * 0.6)) {
          const winKey = `token_window_${i}_${end}_${normalizedTarget}`;
          if (!usedBoxKeys.has(winKey)) {
            usedBoxKeys.add(winKey);
            return buildLineBoxesFromElements(windowEls, page.width);
          }
        }
      }
    }
  }

  return null;
}

/**
 * Mask a sensitive value for safe display in warning messages and logs without exposing the full raw string.
 */
export function maskSensitiveValue(value) {
  const str = String(value || '').trim();
  if (str.length <= 4) return '****';
  return `${str.slice(0, 2)}${'*'.repeat(Math.min(8, str.length - 4))}${str.slice(-2)}`;
}

/**
 * Scan an arbitrary text string (such as a PDF metadata value, XMP text, attachment filename, or
 * earlier incremental revision stream) using DocShield's sensitive-data detection patterns.
 *
 * Returns resolved non-overlapping matches without fabricating page coordinates.
 */
export function scanTextForSensitiveMatches(text, allowedCategories = null) {
  const rawInput = String(text || '');
  if (!rawInput.trim()) return [];

  const categorySet =
    Array.isArray(allowedCategories) && allowedCategories.length > 0
      ? new Set(allowedCategories)
      : new Set(Object.keys(SENSITIVE_CATEGORIES));

  // Scan both the raw string and an underscore-normalized variant (so filenames like
  // "pan_ABCDE1234F_scan.pdf" or "aadhaar_4829-7301-9482.txt" match word-boundary regexes).
  const variants = [rawInput];
  if (rawInput.includes('_')) {
    variants.push(rawInput.replace(/_/g, ' '));
  }

  const rawCandidates = [];
  const seenSpanKeys = new Set();

  for (const variantText of variants) {
    for (const pattern of DETECTION_PATTERNS) {
      if (!categorySet.has(pattern.category)) continue;
      // Avoid breaking email addresses that legitimately contain underscores when scanning the underscore-stripped variant
      if (variantText !== rawInput && pattern.category === 'EMAIL_ADDRESS') continue;

      const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
      let match;
      while ((match = regex.exec(variantText)) !== null) {
        const rawMatch = match[0];
        const matchedText = rawMatch.trim();
        if (!matchedText) continue;

        const matchStart = match.index + rawMatch.indexOf(matchedText);
        const matchEnd = matchStart + matchedText.length;
        const spanKey = `${pattern.category}:${matchStart}:${matchEnd}:${matchedText.toLowerCase()}`;
        if (seenSpanKeys.has(spanKey)) continue;
        seenSpanKeys.add(spanKey);

        rawCandidates.push({
          start: matchStart,
          end: matchEnd,
          length: matchedText.length,
          text: matchedText,
          pattern,
        });
      }
    }
  }

  const resolved = resolveOverlappingCandidates(rawCandidates, rawInput);
  return resolved.map((cand) => ({
    text: cand.text,
    maskedText: maskSensitiveValue(cand.text),
    category: cand.pattern.category,
    categoryLabel: cand.pattern.label,
    confidence: cand.pattern.confidence,
    statusNote: cand.pattern.statusNote,
  }));
}

/**
 * Build the complete `structuralAudit` object from raw structural inspection data extracted from the PDF,
 * scanning metadata fields, custom Info fields, XMP metadata, attachment names/descriptions, and earlier
 * incremental revision streams for sensitive information.
 *
 * Metadata and structural detections are kept strictly separate from normal page-coordinate detections
 * and never invent page coordinates.
 */
export function buildStructuralAudit(rawStructuralInspection, allowedCategories = null) {
  const raw = rawStructuralInspection || {};
  const rawMeta = raw.metadata || {};
  const rawAttachments = raw.attachments || {};
  const rawRevisions = raw.revisions || {};

  const metadataDetections = [];
  let metaCounter = 1;
  const fieldsWithSensitiveData = new Set();

  const recordMetaMatches = (fieldValue, fieldName, sourceType) => {
    if (!fieldValue || typeof fieldValue !== 'string') return [];
    const matches = scanTextForSensitiveMatches(fieldValue, allowedCategories);
    const seenInField = new Set();
    const recordedForField = [];

    for (const m of matches) {
      const dedupKey = `${fieldName}:${m.category}:${m.text.toLowerCase()}`;
      if (seenInField.has(dedupKey)) continue;
      seenInField.add(dedupKey);
      fieldsWithSensitiveData.add(fieldName);

      const detObj = {
        id: `meta_det_${metaCounter++}`,
        text: m.text,
        maskedText: m.maskedText,
        category: m.category,
        categoryLabel: m.categoryLabel,
        confidence: m.confidence,
        source: sourceType,
        metadataField: fieldName,
        pageNumber: null,
        boundingBox: null,
        redactionReady: false,
        detectionStatus: `${m.statusNote} (detected in ${sourceType} field "${fieldName}"; document-level metadata has no page coordinates)`,
      };
      metadataDetections.push(detObj);
      recordedForField.push(detObj);
    }
    return recordedForField;
  };

  // 1. Scan standard Info dictionary fields
  const standardFields = rawMeta.standardFields || {
    Title: null,
    Author: null,
    Subject: null,
    Keywords: null,
    Creator: null,
    Producer: null,
    CreationDate: null,
    ModDate: null,
  };

  for (const [fieldKey, fieldVal] of Object.entries(standardFields)) {
    if (typeof fieldVal === 'string' && fieldVal.trim()) {
      recordMetaMatches(fieldVal, fieldKey, 'pdf-metadata');
    }
  }

  // 2. Scan custom Info dictionary fields
  const customFields = rawMeta.customFields || {};
  for (const [customKey, customVal] of Object.entries(customFields)) {
    if (typeof customVal === 'string' && customVal.trim()) {
      recordMetaMatches(customVal, `Custom:${customKey}`, 'pdf-custom-metadata');
    }
  }

  // 3. Scan XMP metadata text
  if (rawMeta.xmpText && typeof rawMeta.xmpText === 'string' && rawMeta.xmpText.trim()) {
    recordMetaMatches(rawMeta.xmpText, 'XMP', 'pdf-xmp-metadata');
  }

  // 4. Inspect attachments and scan attachment filenames/descriptions (without scanning or executing file contents)
  const rawAttachmentItems = Array.isArray(rawAttachments.items) ? rawAttachments.items : [];
  const enrichedAttachmentItems = rawAttachmentItems.map((att, idx) => {
    const fnMatches = recordMetaMatches(
      att.filename || att.rawFilename || '',
      `AttachmentFilename:${att.id || idx + 1}`,
      'pdf-attachment-metadata'
    );
    const descMatches = recordMetaMatches(
      [att.description, att.annotationContents].filter(Boolean).join(' '),
      `AttachmentDescription:${att.id || idx + 1}`,
      'pdf-attachment-metadata'
    );

    const sensitiveMetadataMatches = [...fnMatches, ...descMatches].map((d) => ({
      id: d.id,
      text: d.text,
      maskedText: d.maskedText,
      category: d.category,
      categoryLabel: d.categoryLabel,
      metadataField: d.metadataField,
    }));

    return {
      id: att.id || `att_${idx + 1}`,
      filename: att.filename || 'unnamed_attachment',
      rawFilename: att.rawFilename || att.filename || null,
      description: att.description || null,
      source: att.source || 'catalog-embedded-files',
      pageNumber: att.pageNumber ?? null,
      contentByteLength: att.contentByteLength ?? null,
      contentInspected: false,
      inspectionStatus: 'UNINSPECTED_ATTACHMENT_CONTENT',
      hasSensitiveFilenameOrDescription: sensitiveMetadataMatches.length > 0,
      sensitiveMetadataMatches,
      warning:
        'Embedded attachment content was not automatically extracted or scanned; uninspected embedded files cannot be assumed safe.',
    };
  });

  // 5. Inspect incremental revisions and scan earlier revision bodies when incremental updates are detected
  const historicalDetections = [];
  let revDetCounter = 1;
  if (rawRevisions.status === 'DETECTED' && Array.isArray(rawRevisions.earlierRevisionTexts)) {
    const seenHist = new Set();
    for (const revEntry of rawRevisions.earlierRevisionTexts) {
      const revNum = revEntry.revisionNumber || 1;
      const matches = scanTextForSensitiveMatches(revEntry.text || '', allowedCategories);
      for (const m of matches) {
        const key = `${revNum}:${m.category}:${m.text.toLowerCase()}`;
        if (seenHist.has(key)) continue;
        seenHist.add(key);

        historicalDetections.push({
          id: `rev_det_${revDetCounter++}`,
          text: m.text,
          maskedText: m.maskedText,
          category: m.category,
          categoryLabel: m.categoryLabel,
          confidence: m.confidence,
          source: 'pdf-incremental-revision',
          revisionNumber: revNum,
          pageNumber: null,
          boundingBox: null,
          redactionReady: false,
          detectionStatus: `${m.statusNote} (detected inside earlier incremental PDF revision #${revNum})`,
        });
      }
    }
  }

  // 6. Build structured warnings without exposing full raw sensitive strings in warning messages
  const warnings = [];

  if (metadataDetections.length > 0) {
    const fieldList = Array.from(fieldsWithSensitiveData).join(', ');
    warnings.push({
      code: 'METADATA_SENSITIVE_DATA_DETECTED',
      severity: 'HIGH',
      section: 'metadata',
      message: `Detected ${metadataDetections.length} sensitive item(s) inside hidden PDF/attachment metadata fields (${fieldList}). Metadata items do not have page coordinates and require metadata sanitization.`,
    });
  }

  if (enrichedAttachmentItems.length > 0) {
    warnings.push({
      code: 'UNINSPECTED_EMBEDDED_ATTACHMENTS',
      severity: 'HIGH',
      section: 'attachments',
      message: `PDF contains ${enrichedAttachmentItems.length} embedded attachment(s) or FileAttachment annotation(s) whose binary/file contents were not automatically extracted or scanned. Do not assume embedded attachments are free of sensitive data.`,
    });
  }

  if (rawAttachments.isPortfolioCollection) {
    warnings.push({
      code: 'PDF_PORTFOLIO_COLLECTION_DETECTED',
      severity: 'HIGH',
      section: 'attachments',
      message:
        'PDF contains a /Collection (PDF Portfolio) dictionary that may package multiple hidden documents or files.',
    });
  }

  if (rawAttachments.hasAssociatedFiles && enrichedAttachmentItems.length === 0) {
    warnings.push({
      code: 'ASSOCIATED_FILES_DETECTED',
      severity: 'MEDIUM',
      section: 'attachments',
      message: 'PDF contains an /AF (Associated Files) structure that may reference embedded file specifications.',
    });
  }

  if (rawRevisions.status === 'DETECTED') {
    warnings.push({
      code: 'INCREMENTAL_REVISIONS_DETECTED',
      severity: 'HIGH',
      section: 'revisions',
      message:
        rawRevisions.reason ||
        'PDF contains multiple incremental save revisions. Earlier revisions in the raw file body may retain deleted or superseded sensitive information.',
    });
  } else if (rawRevisions.status === 'INDETERMINATE') {
    warnings.push({
      code: 'INDETERMINATE_REVISION_STRUCTURE',
      severity: 'MEDIUM',
      section: 'revisions',
      message:
        rawRevisions.reason ||
        'PDF cross-reference / trailer revision structure is malformed or inconsistent; incremental update history could not be verified as clean.',
    });
  }

  if (historicalDetections.length > 0) {
    warnings.push({
      code: 'HISTORICAL_REVISION_SENSITIVE_DATA_DETECTED',
      severity: 'HIGH',
      section: 'revisions',
      message: `Detected ${historicalDetections.length} sensitive item(s) retained inside earlier incremental PDF revision stream(s).`,
    });
  }

  const populatedFieldNames = rawMeta.populatedFieldNames || [];

  return {
    hasHiddenStructureRisks: warnings.length > 0,
    metadata: {
      hasInfoDictionary: Boolean(rawMeta.hasInfoDictionary),
      hasXmpMetadata: Boolean(rawMeta.hasXmpMetadata),
      standardFields,
      customFields,
      xmpPresent: Boolean(rawMeta.hasXmpMetadata),
      xmpLength: rawMeta.xmpLength || 0,
      populatedFieldNames,
      sensitiveFieldCount: fieldsWithSensitiveData.size,
      totalSensitiveMatches: metadataDetections.length,
    },
    metadataDetections,
    attachments: {
      hasAttachments:
        enrichedAttachmentItems.length > 0 ||
        Boolean(rawAttachments.isPortfolioCollection) ||
        Boolean(rawAttachments.hasAssociatedFiles),
      isPortfolioCollection: Boolean(rawAttachments.isPortfolioCollection),
      hasAssociatedFiles: Boolean(rawAttachments.hasAssociatedFiles),
      totalCount: enrichedAttachmentItems.length,
      uninspectedCount: enrichedAttachmentItems.length,
      status:
        enrichedAttachmentItems.length > 0
          ? 'ATTACHMENTS_DETECTED_UNINSPECTED'
          : rawAttachments.isPortfolioCollection
          ? 'PORTFOLIO_COLLECTION_DETECTED'
          : 'NONE_DETECTED',
      items: enrichedAttachmentItems,
    },
    revisions: {
      status: rawRevisions.status || 'INDETERMINATE',
      incrementalUpdatesDetected:
        rawRevisions.status === 'DETECTED' ? true : rawRevisions.status === 'NOT_DETECTED' ? false : null,
      isLinearized: Boolean(rawRevisions.isLinearized),
      confidence: rawRevisions.confidence || 'LOW_UNCERTAIN',
      revisionCount: rawRevisions.revisionCount ?? null,
      startxrefCount: rawRevisions.startxrefCount ?? 0,
      xrefSectionCount: rawRevisions.xrefSectionCount ?? 0,
      prevCount: rawRevisions.prevCount ?? 0,
      eofCount: rawRevisions.eofCount ?? 0,
      reason: rawRevisions.reason || 'Revision inspection was not performed.',
      historicalDetections,
    },
    warnings,
  };
}

/**
 * Run sensitive information detection across all extracted pages of a document.
 *
 * @param {object} extractionResult - Output from extractPdfContent()
 * @param {string[]} allowedCategories - Optional subset of category keys
 * @param {object} options - Optional configuration `{ idPrefix: 'det' }`
 */
export function detectSensitiveInfo(extractionResult, allowedCategories = null, options = {}) {
  const { idPrefix = 'det' } = options || {};
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

    // 1. Collect all candidate regex matches across all active categories on this page
    const rawCandidates = [];
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

        rawCandidates.push({
          start: matchStart,
          end: matchEnd,
          length: matchedText.length,
          text: matchedText,
          pattern,
        });
      }
    }

    // 2. Deterministically resolve any overlapping matches on the same underlying text span
    //    while preserving genuinely distinct nearby detections.
    const resolvedCandidates = resolveOverlappingCandidates(rawCandidates, pageText);

    // 3. Map each resolved detection to its PDF page bounding box(es)
    const pageUnsupportedAnns = page.unsupportedAnnotations || [];
    for (const cand of resolvedCandidates) {
      const { text: matchedText, pattern } = cand;
      const boxResult = findBoundingBoxForMatch(matchedText, page, usedBoxKeys);
      const boundingBox = boxResult ? boxResult.boundingBox : null;
      const boundingBoxes = boxResult ? boxResult.boundingBoxes : null;

      const confidence = boundingBox ? pattern.confidence : 'LOW_UNCERTAIN';
      let detectionStatus = pattern.statusNote;
      if (!boundingBox) {
        if (pageUnsupportedAnns.length > 0) {
          detectionStatus = `${pattern.statusNote} (UNSUPPORTED_ANNOTATION_COORDINATES: detected inside an annotation without a reliable page bounding box; automatic redaction is blocked until manually reviewed)`;
        } else {
          detectionStatus = `${pattern.statusNote} (coordinates could not be established on page)`;
        }
      }

      const item = {
        id: `${idPrefix}_${counter++}`,
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

  const unsupportedAnnotations = extractionResult.unsupportedAnnotations || [];
  const linkAnnotations = extractionResult.linkAnnotations || [];
  const structuralAudit = buildStructuralAudit(
    extractionResult.rawStructuralInspection || extractionResult.structuralAudit,
    allowedCategories
  );

  return {
    totalDetected: detectedItems.length,
    categoryBreakdown,
    disclaimer:
      'Automated pattern matching identifies common sensitive formats but cannot guarantee detection of every context-dependent personal detail. Uncertain detections are marked with LOW_UNCERTAIN confidence for human review.',
    items: detectedItems,
    structuralAudit,
    ...(unsupportedAnnotations.length > 0 ? { unsupportedAnnotations } : {}),
    ...(linkAnnotations.length > 0 ? { linkAnnotations } : {}),
  };
}

