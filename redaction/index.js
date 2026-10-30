import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument } from 'pdf-lib';
import { renderPageToCanvas } from '../extraction/index.js';
import { config } from '../config/index.js';
import { ensureTempDirs, computeSha256 } from '../config/storage.js';

function isValidBox(box) {
  return (
    Boolean(box) &&
    typeof box.x === 'number' &&
    typeof box.y === 'number' &&
    typeof box.width === 'number' &&
    typeof box.height === 'number' &&
    box.width > 0 &&
    box.height > 0
  );
}

/**
 * Check whether an item has valid boundingBox or boundingBoxes coordinates.
 */
export function hasValidItemCoordinates(item) {
  if (!item) return false;
  if (Array.isArray(item.boundingBoxes) && item.boundingBoxes.length > 0) {
    return item.boundingBoxes.every((b) => isValidBox(b));
  }
  return isValidBox(item.boundingBox);
}

export const STANDARD_MASK_WIDTH_BUCKETS_PT = [240, 360, 480];
export const STANDARD_MASK_HEIGHT_BUCKETS_PT = [22, 34, 48];
export const MASK_OBFUSCATION_STRATEGY = 'standardized-bucket-obfuscation-v1';

function round2(val) {
  return Number(Number(val).toFixed(2));
}

function cloneBox(box) {
  if (!isValidBox(box)) return null;
  return {
    x: round2(box.x),
    y: round2(box.y),
    width: round2(box.width),
    height: round2(box.height),
    ...(box.coordinateSpace ? { coordinateSpace: box.coordinateSpace } : {}),
  };
}

/**
 * Selects a standardized mask width bucket in PDF points based purely on bounding-box
 * geometry (never derived from sensitive string character length).
 */
export function selectStandardizedWidthBucket(paddedWidth, pageWidth = 595.28) {
  for (const bucket of STANDARD_MASK_WIDTH_BUCKETS_PT) {
    if (paddedWidth <= bucket) {
      return bucket;
    }
  }
  const quantized = Math.ceil(paddedWidth / 60) * 60;
  return Math.max(paddedWidth, Math.min(quantized, Math.max(paddedWidth, pageWidth - 16)));
}

/**
 * Selects a standardized mask height bucket in PDF points based purely on bounding-box
 * geometry.
 */
export function selectStandardizedHeightBucket(paddedHeight, pageHeight = 841.89) {
  for (const bucket of STANDARD_MASK_HEIGHT_BUCKETS_PT) {
    if (paddedHeight <= bucket) {
      return bucket;
    }
  }
  const quantized = Math.ceil(paddedHeight / 16) * 16;
  return Math.max(paddedHeight, Math.min(quantized, pageHeight));
}

/**
 * Builds the list of obstacle bounding boxes on a page that an expanding mask for `targetItem`
 * must NOT cover:
 * 1. All unselected sensitive detections on the same page (`UNSELECTED_DETECTION`).
 * 2. All neighboring non-redacted text elements or same-line prefix/suffix text segments
 *    that do not belong to any selected item (`NEIGHBOR_TEXT`, `LINE_PREFIX_TEXT`, `LINE_SUFFIX_TEXT`).
 */
export function buildPageObstaclesForItem({
  targetItem,
  targetBox,
  pageNumber,
  selectedItemsOnPage = [],
  unselectedItemsOnPage = [],
  pageElements = [],
}) {
  const obstacles = [];
  if (!isValidBox(targetBox)) return obstacles;

  // 1. Unselected sensitive detections on this page are strict obstacles
  for (const unsel of unselectedItemsOnPage) {
    if (!unsel || unsel.id === targetItem?.id) continue;
    const boxes =
      Array.isArray(unsel.boundingBoxes) && unsel.boundingBoxes.length > 0
        ? unsel.boundingBoxes
        : unsel.boundingBox
        ? [unsel.boundingBox]
        : [];
    for (const b of boxes) {
      if (!isValidBox(b)) continue;
      obstacles.push({
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        type: 'UNSELECTED_DETECTION',
        itemId: unsel.id || null,
        category: unsel.category || null,
      });
    }
  }

  // Collect all original boxes of selected items on this page so we don't treat
  // another selected item being redacted as a non-redacted obstacle
  const allSelectedBoxes = [];
  for (const sel of selectedItemsOnPage) {
    if (!sel) continue;
    if (Array.isArray(sel.boundingBoxes) && sel.boundingBoxes.length > 0) {
      for (const sb of sel.boundingBoxes) {
        if (isValidBox(sb)) allSelectedBoxes.push({ box: sb, item: sel });
      }
    } else if (isValidBox(sel.boundingBox)) {
      allSelectedBoxes.push({ box: sel.boundingBox, item: sel });
    }
  }

  // 2. Inspect page elements (PDF text runs, OCR words, hybrid embedded-image OCR words)
  for (const el of pageElements) {
    if (!isValidBox(el)) continue;
    const rawElText = (el.text || '').replace(/\s+/g, ' ').trim();
    if (!rawElText) continue;

    // Ignore pure standalone punctuation tokens in OCR (note escaped hyphen so ASCII range )-] is not created)
    if (/^[\s.,;:!?)\-\]]+$/.test(rawElText)) continue;

    // AcroForm widget and annotation containers that overlap a selected item are the field box itself
    if (el.source === 'pdf-acroform-widget' || el.source === 'pdf-annotation') {
      const overlapsAnySelected = allSelectedBoxes.some(({ box }) => {
        const hOv = Math.min(el.x + el.width, box.x + box.width) - Math.max(el.x, box.x);
        const vOv = Math.min(el.y + el.height, box.y + box.height) - Math.max(el.y, box.y);
        return hOv > 1 && vOv > 1;
      });
      if (overlapsAnySelected) continue;
    }

    // Check which selected boxes overlap this element
    const overlappingSelected = allSelectedBoxes.filter(({ box }) => {
      const hOv = Math.min(el.x + el.width, box.x + box.width) - Math.max(el.x, box.x);
      const vOv = Math.min(el.y + el.height, box.y + box.height) - Math.max(el.y, box.y);
      return hOv > 1 && vOv > 1;
    });

    if (overlappingSelected.length === 0) {
      // Element does not overlap any selected item -> entire element is non-redacted neighbor content
      obstacles.push({
        x: el.x,
        y: el.y,
        width: el.width,
        height: el.height,
        type: 'NEIGHBOR_TEXT',
        source: el.source || 'page-element',
      });
      continue;
    }

    // Element overlaps at least one selected item (e.g. a single PDF text line containing "Label: Value" or "Label: Value  Neighbor: Text")
    // Check if this element overlaps our current `targetBox` vertically
    const vOvTarget =
      Math.min(el.y + el.height, targetBox.y + targetBox.height) - Math.max(el.y, targetBox.y);
    if (vOvTarget <= 1) continue;

    // For OCR word tokens that overlap a selected item, the word token itself is part of the redacted value
    if (el.source === 'ocr' || el.source === 'embedded-image-ocr') {
      continue;
    }

    // Left prefix obstacle: if the line element starts well to the left of the leftmost selected box on this element
    const minSelX = Math.min(...overlappingSelected.map(({ box }) => box.x));
    if (minSelX - el.x > 6) {
      const prefixRight = Math.max(el.x + 2, minSelX - 2.5);
      obstacles.push({
        x: el.x,
        y: el.y,
        width: prefixRight - el.x,
        height: el.height,
        type: 'LINE_PREFIX_TEXT',
        source: el.source || 'pdf-text-layer',
      });
    }

    // Right suffix obstacle: check if there is non-redacted text in `el.text` after `targetItem`
    const normEl = rawElText.toLowerCase();
    const normTarget = (targetItem?.text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (normTarget && normEl.includes(normTarget)) {
      const matchIdx = normEl.lastIndexOf(normTarget);
      const matchEnd = matchIdx + normTarget.length;
      let trailingSubstr = rawElText.slice(matchEnd);

      // Remove any other selected items on this line from the trailing substring
      for (const { item: otherSel } of overlappingSelected) {
        const otherNorm = (otherSel?.text || '').replace(/\s+/g, ' ').trim();
        if (otherNorm) {
          const escaped = otherNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          trailingSubstr = trailingSubstr.replace(new RegExp(escaped, 'gi'), ' ');
        }
      }

      const trailingCleaned = trailingSubstr.replace(/^[\s.,;:!?)\-\]|/]+/, '').trim();
      if (trailingCleaned.length > 0) {
        const firstToken = trailingCleaned.split(/\s+/)[0];
        const suffixCharIdx = rawElText.indexOf(firstToken, matchEnd);
        const charWidth = el.width / Math.max(rawElText.length, 1);
        const estimatedSuffixX =
          suffixCharIdx > 0
            ? el.x + suffixCharIdx * charWidth
            : targetBox.x + targetBox.width + 6;
        const suffixStartX = Math.max(targetBox.x + targetBox.width + 5, estimatedSuffixX);
        const suffixWidth = Math.max(12, el.x + el.width - suffixStartX);

        obstacles.push({
          x: suffixStartX,
          y: el.y,
          width: suffixWidth,
          height: el.height,
          type: 'LINE_SUFFIX_TEXT',
          source: el.source || 'pdf-text-layer',
        });
      }
    }
  }

  return obstacles;
}

/**
 * Dedicated Redaction Mask Dimension Obfuscation Function (P3).
 *
 * Computes a standardized mask bounding box from the original detection bounding box
 * using coarse geometric width/height buckets so that short and long sensitive values
 * produce comparable mask dimensions without leaking approximate string length.
 *
 * Before expanding to the standardized bucket, checks for collisions with:
 * - Unselected sensitive detections on the same page
 * - Neighboring non-redacted text segments on the same page
 *
 * Never derives mask dimensions from `item.text.length` and never mutates `originalBox`.
 *
 * @param {Object} originalBox - Original detection bounding box `{ x, y, width, height, coordinateSpace }`
 * @param {Object} options - `{ pageDimensions, obstacles, glyphCoverageBox, padX, padY, itemMetadata }`
 */
export function computeObfuscatedMaskGeometry(originalBox, options = {}) {
  const orig = cloneBox(originalBox);
  if (!orig) {
    return {
      maskObfuscationApplied: false,
      obfuscationStatus: 'INVALID_COORDINATES',
      obfuscationStrategy: MASK_OBFUSCATION_STRATEGY,
      originalBoundingBox: null,
      finalMaskBoundingBox: null,
      targetBucket: null,
      obfuscationWarnings: [],
    };
  }

  const pageWidth = Number(options.pageDimensions?.width) || 595.28;
  const pageHeight = Number(options.pageDimensions?.height) || 841.89;
  const obstacles = Array.isArray(options.obstacles) ? options.obstacles : [];
  const padX = typeof options.padX === 'number' ? options.padX : 2;
  const padY = typeof options.padY === 'number' ? options.padY : 1.5;
  const meta = options.itemMetadata || {};

  // Base padded box (incorporating optional proportional-font glyph coverage box if unobstructed)
  let baseLeft = Math.max(0, orig.x - padX);
  let baseRight = Math.min(pageWidth, orig.x + orig.width + padX);
  let baseTop = Math.max(0, orig.y - padY);
  let baseBottom = Math.min(pageHeight, orig.y + orig.height + padY);

  if (isValidBox(options.glyphCoverageBox)) {
    const gc = options.glyphCoverageBox;
    const gcLeft = Math.max(0, gc.x);
    const gcRight = Math.min(pageWidth, gc.x + gc.width);
    const gcTop = Math.max(0, gc.y);
    const gcBottom = Math.min(pageHeight, gc.y + gc.height);

    // Only widen base glyph coverage if it does not collide with an unselected detection or neighbor/prefix obstacle
    const hitsObstacleLeft = obstacles.some((obs) => {
      const vOv = Math.min(baseBottom, obs.y + obs.height) - Math.max(baseTop, obs.y);
      return vOv > 1 && obs.x + obs.width <= orig.x + 2 && obs.x + obs.width + 1.5 > gcLeft;
    });
    const hitsObstacleRight = obstacles.some((obs) => {
      const vOv = Math.min(baseBottom, obs.y + obs.height) - Math.max(baseTop, obs.y);
      return vOv > 1 && obs.x >= orig.x + orig.width - 2 && obs.x - 1.5 < gcRight;
    });

    if (!hitsObstacleLeft) baseLeft = Math.min(baseLeft, gcLeft);
    if (!hitsObstacleRight) baseRight = Math.max(baseRight, gcRight);
    baseTop = Math.min(baseTop, gcTop);
    baseBottom = Math.max(baseBottom, gcBottom);
  }

  // Ensure base padding never intrudes into an adjacent unselected detection or same-line prefix/suffix/neighbor obstacle
  for (const obs of obstacles) {
    if (!isValidBox(obs)) continue;
    const vOv = Math.min(baseBottom - 1, obs.y + obs.height) - Math.max(baseTop + 1, obs.y);
    if (vOv <= 0) continue;

    const clearance = obs.type === 'UNSELECTED_DETECTION' ? 2.0 : 1.5;
    if (obs.x >= orig.x + orig.width - 2 && obs.x - clearance < baseRight) {
      baseRight = Math.max(orig.x + orig.width, obs.x - clearance);
    }
    if (obs.x + obs.width <= orig.x + 2 && obs.x + obs.width + clearance > baseLeft) {
      baseLeft = Math.min(orig.x, obs.x + obs.width + clearance);
    }
  }

  const paddedWidth = Math.max(1, baseRight - baseLeft);
  const paddedHeight = Math.max(1, baseBottom - baseTop);

  const targetWidth = selectStandardizedWidthBucket(paddedWidth, pageWidth);
  const targetHeight = selectStandardizedHeightBucket(paddedHeight, pageHeight);

  // Compute safe horizontal expansion interval [minSafeX, maxSafeRightX] around [baseLeft, baseRight]
  let minSafeX = Math.min(baseLeft, 8);
  let maxSafeRightX = Math.max(baseRight, pageWidth - 8);
  const blockingObstacles = [];

  for (const obs of obstacles) {
    if (!isValidBox(obs)) continue;
    const vOv = Math.min(baseBottom - 1, obs.y + obs.height) - Math.max(baseTop + 1, obs.y);
    if (vOv <= 0) continue;

    const safetyGap = obs.type === 'UNSELECTED_DETECTION' ? 2.5 : 1.5;

    // Obstacle to the left of the target
    if (obs.x + obs.width <= orig.x + 4) {
      const rightBound = Math.min(baseLeft, obs.x + obs.width + safetyGap);
      if (rightBound > minSafeX) {
        minSafeX = rightBound;
        if (obs.type !== 'LINE_PREFIX_TEXT') {
          blockingObstacles.push(obs);
        }
      }
      continue;
    }

    // Obstacle to the right of the target
    if (obs.x >= orig.x + orig.width - 4) {
      const leftBound = Math.max(baseRight, obs.x - safetyGap);
      if (leftBound < maxSafeRightX) {
        maxSafeRightX = leftBound;
        blockingObstacles.push(obs);
      }
      continue;
    }

    // Obstacle directly overlaps the interior of `orig` (e.g. overlapping unselected detection)
    minSafeX = baseLeft;
    maxSafeRightX = baseRight;
    blockingObstacles.push(obs);
  }

  const availableSafeWidth = Math.max(paddedWidth, maxSafeRightX - minSafeX);

  // Check if the standardized width bucket fits safely without colliding with any obstacle
  if (availableSafeWidth + 0.01 >= targetWidth) {
    // Prefer rightward expansion from baseLeft; shift leftward into [minSafeX, baseLeft] only as needed
    let finalLeft = baseLeft;
    let finalRight = finalLeft + targetWidth;
    if (finalRight > maxSafeRightX) {
      finalRight = maxSafeRightX;
      finalLeft = Math.max(minSafeX, finalRight - targetWidth);
    }

    // Compute vertical safe bounds [minSafeY, maxSafeBottomY] for the horizontal span [finalLeft, finalRight]
    let minSafeY = Math.min(baseTop, 4);
    let maxSafeBottomY = Math.max(baseBottom, pageHeight - 4);
    for (const obs of obstacles) {
      if (!isValidBox(obs)) continue;
      if (obs.type === 'LINE_PREFIX_TEXT' || obs.type === 'LINE_SUFFIX_TEXT') continue;
      const hOv = Math.min(finalRight - 1, obs.x + obs.width) - Math.max(finalLeft + 1, obs.x);
      if (hOv <= 0) continue;

      if (obs.y + obs.height <= orig.y + 2) {
        const bottomBound = Math.min(baseTop, obs.y + obs.height + 1.5);
        if (bottomBound > minSafeY) minSafeY = bottomBound;
      } else if (obs.y >= orig.y + orig.height - 2) {
        const topBound = Math.max(baseBottom, obs.y - 1.5);
        if (topBound < maxSafeBottomY) maxSafeBottomY = topBound;
      }
    }

    let finalTop = baseTop;
    let finalBottom = baseBottom;
    if (maxSafeBottomY - minSafeY + 0.01 >= targetHeight) {
      const extraH = targetHeight - (baseBottom - baseTop);
      finalTop = Math.max(minSafeY, baseTop - extraH / 2);
      finalBottom = finalTop + targetHeight;
      if (finalBottom > maxSafeBottomY) {
        finalBottom = maxSafeBottomY;
        finalTop = Math.max(minSafeY, finalBottom - targetHeight);
      }
    }

    return {
      maskObfuscationApplied: true,
      obfuscationStatus: 'OBFUSCATED',
      obfuscationStrategy: MASK_OBFUSCATION_STRATEGY,
      originalBoundingBox: orig,
      finalMaskBoundingBox: {
        x: round2(finalLeft),
        y: round2(finalTop),
        width: round2(targetWidth),
        height: round2(finalBottom - finalTop),
        coordinateSpace: orig.coordinateSpace || 'pdf-top-left-points',
      },
      targetBucket: {
        width: targetWidth,
        height: targetHeight,
      },
      obfuscationWarnings: [],
    };
  }

  // Unsafe expansion blocked by neighboring content or unselected item:
  // Fall back safely to the non-colliding padded box [baseLeft, baseRight] without over-redacting neighbors,
  // and emit an explicit warning explaining why dimension obfuscation was blocked.
  const blockedByUnselected = blockingObstacles.some((o) => o.type === 'UNSELECTED_DETECTION');
  const warningCode = blockedByUnselected
    ? 'MASK_EXPANSION_BLOCKED_BY_UNSELECTED_ITEM'
    : 'MASK_EXPANSION_BLOCKED_BY_NEIGHBOR_CONTENT';
  const warningReason = blockedByUnselected
    ? `Standardized mask expansion to ${targetWidth}pt width was blocked for item "${
        meta.id || 'unknown'
      }" on page ${
        meta.pageNumber || 1
      } to avoid covering an adjacent or overlapping unselected sensitive detection (available non-colliding width: ${round2(
        availableSafeWidth
      )}pt).`
    : `Standardized mask expansion to ${targetWidth}pt width was blocked for item "${
        meta.id || 'unknown'
      }" on page ${
        meta.pageNumber || 1
      } to avoid over-redacting adjacent non-redacted page content (available non-colliding width: ${round2(
        availableSafeWidth
      )}pt).`;

  const warningObj = {
    code: warningCode,
    severity: 'MEDIUM',
    itemId: meta.id || null,
    pageNumber: meta.pageNumber || null,
    category: meta.category || null,
    categoryLabel: meta.categoryLabel || null,
    source: meta.source || null,
    originalWidth: orig.width,
    targetBucketWidth: targetWidth,
    availableSafeWidth: round2(availableSafeWidth),
    finalMaskWidth: round2(paddedWidth),
    reason: warningReason,
  };

  return {
    maskObfuscationApplied: false,
    obfuscationStatus: 'UNSAFE_EXPANSION_BLOCKED',
    obfuscationStrategy: MASK_OBFUSCATION_STRATEGY,
    originalBoundingBox: orig,
    finalMaskBoundingBox: {
      x: round2(baseLeft),
      y: round2(baseTop),
      width: round2(paddedWidth),
      height: round2(paddedHeight),
      coordinateSpace: orig.coordinateSpace || 'pdf-top-left-points',
    },
    targetBucket: {
      width: targetWidth,
      height: targetHeight,
    },
    obfuscationWarnings: [warningObj],
  };
}

/**
 * Permanently redacts a PDF document with P3 Mask Dimension Obfuscation.
 *
 * Why image-based raster redaction?
 * Drawing a black rectangle on top of an existing PDF page leaves the underlying
 * text stream intact (anyone can copy-paste or extract the hidden text).
 *
 * DocShield renders each PDF page onto an image canvas, computes dimension-obfuscated
 * redaction rectangles using standardized width/height buckets (while checking for
 * collisions against unselected detections and neighboring page content), paints solid
 * opaque black masks onto the pixel buffer, discards all original text streams/fonts/metadata,
 * and rebuilds a brand-new PDF containing only the sanitized page images.
 *
 * @param {string} originalPdfPath - Path to original uploaded PDF
 * @param {Array} itemsToRedact - Array of detected sensitive items selected for redaction
 * @param {Object} options - Optional `{ allDetectedItems, extraction, failOnUnsafeObfuscation }`
 */
export async function generatePermanentlyRedactedPdf(
  originalPdfPath,
  itemsToRedact = [],
  options = {}
) {
  await ensureTempDirs();

  const rawBuffer = await fs.readFile(originalPdfPath);
  const uint8Array = new Uint8Array(rawBuffer);

  const loadingTask = pdfjsLib.getDocument({
    data: uint8Array,
    useSystemFonts: true,
    disableFontFace: true,
    verbosity: 0,
  });

  const pdfDoc = await loadingTask.promise;
  const numPages = pdfDoc.numPages;

  // Map any fallback raw text coordinates without mutating original detection objects
  const fallbackBoxByItemId = new Map();

  // Pre-validate all selected items across all pages BEFORE rendering or modifying any output
  // so that if any selected item is unlocatable, we fail safely with a complete list of unlocatable items.
  const preCheckUnlocatable = [];
  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const pageItems = itemsToRedact.filter((item) => item.pageNumber === pageNum);
    if (pageItems.length === 0) continue;

    const page = await pdfDoc.getPage(pageNum);
    const baseViewport = page.getViewport({ scale: 1.0 });
    const textContent = await page.getTextContent();
    const rawTextItems = textContent.items || [];

    for (const item of pageItems) {
      if (hasValidItemCoordinates(item)) continue;

      // Check whether raw PDF text streams on this page can locate the item
      const targetNorm = (item.text || '').replace(/\s+/g, ' ').trim().toLowerCase();
      let foundInRaw = false;
      if (targetNorm) {
        for (const raw of rawTextItems) {
          const rawStr = (raw.str || '').replace(/\s+/g, ' ').trim();
          if (rawStr && rawStr.toLowerCase().includes(targetNorm)) {
            const tx = raw.transform ? raw.transform[4] : 0;
            const ty = raw.transform ? raw.transform[5] : 0;
            const fontH = Math.max(Math.abs(raw.height || (raw.transform ? raw.transform[3] : 12)), 11);
            const rawW = Math.max(raw.width || rawStr.length * (fontH * 0.6), 20);
            const topY = Math.max(0, baseViewport.height - ty - fontH * 0.9);
            const matchIdx = rawStr.toLowerCase().indexOf(targetNorm);
            const startRatio = Math.max(0, (matchIdx - 1) / Math.max(rawStr.length, 1));
            const widthRatio = Math.min(1 - startRatio, (targetNorm.length + 2) / Math.max(rawStr.length, 1));

            fallbackBoxByItemId.set(item.id, {
              x: round2(Math.max(0, tx + rawW * startRatio - 3)),
              y: round2(Math.max(0, topY - 2)),
              width: round2(Math.max(rawW * widthRatio + 8, 24)),
              height: round2(fontH * 1.3 + 4),
              coordinateSpace: 'pdf-top-left-points',
            });
            foundInRaw = true;
            break;
          }
        }
      }

      if (!foundInRaw) {
        preCheckUnlocatable.push({
          id: item.id,
          category: item.category,
          categoryLabel: item.categoryLabel,
          pageNumber: item.pageNumber,
          confidence: item.confidence || 'LOW_UNCERTAIN',
          reason:
            'Bounding box coordinates could not be established on the PDF page. Manual review or selective redaction of locatable items is required.',
        });
      }
    }
  }

  if (preCheckUnlocatable.length > 0) {
    const failedIds = preCheckUnlocatable.map((u) => `${u.id} (page ${u.pageNumber}, ${u.category})`).join(', ');
    const err = new Error(
      `Redaction aborted safely: ${preCheckUnlocatable.length} selected detection(s) lack valid page coordinates [${failedIds}]. The document was not modified. Review the unlocatable items or use selective redaction for verified items.`
    );
    err.code = 'REDACTION_COORDINATES_MISSING';
    err.statusCode = 422;
    err.details = {
      unlocatableCount: preCheckUnlocatable.length,
      unlocatableItems: preCheckUnlocatable,
      guidance:
        'Automatic redaction never silently skips unlocatable sensitive items. Inspect the listed items in unlocatableItems or use mode="selective" with locatable item IDs.',
    };
    throw err;
  }

  const allDetectedItems = Array.isArray(options.allDetectedItems)
    ? options.allDetectedItems
    : itemsToRedact;
  const selectedIdSet = new Set(itemsToRedact.map((i) => i.id));
  const failOnUnsafeObfuscation = Boolean(options.failOnUnsafeObfuscation);

  const obfuscationWarnings = [];
  const maskGeometryAudit = [];

  // Create a brand new, empty PDF document via pdf-lib (contains zero original text objects)
  const outputPdf = await PDFDocument.create();
  const exportTimestamp = new Date();
  outputPdf.setTitle('DocShield Protected Document');
  outputPdf.setCreator('DocShield – Smart Document Privacy Protector');
  outputPdf.setProducer('DocShield – Smart Document Privacy Protector');
  outputPdf.setCreationDate(exportTimestamp);
  outputPdf.setModificationDate(exportTimestamp);

  const renderScale = 2.0; // 2x resolution for crisp readability of unredacted content

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const baseViewport = page.getViewport({ scale: 1.0 });
    const pageDimensions = { width: baseViewport.width, height: baseViewport.height };
    const { canvas, context } = await renderPageToCanvas(page, renderScale);

    // Filter selected and unselected items belonging to this page
    const pageItems = itemsToRedact.filter((item) => item.pageNumber === pageNum);
    const unselectedPageItems = allDetectedItems.filter(
      (item) => item.pageNumber === pageNum && !selectedIdSet.has(item.id)
    );

    // Extract raw PDF text items on this page for glyph coverage and fallback element construction
    const textContent = await page.getTextContent();
    const rawTextItems = textContent.items || [];
    const consumedRawIndices = new Set();

    // Use extraction page elements when available; otherwise synthesize from rawTextItems
    const extractionPage = options.extraction?.pages?.find((p) => p.pageNumber === pageNum);
    const pageElements =
      Array.isArray(extractionPage?.elements) && extractionPage.elements.length > 0
        ? extractionPage.elements
        : rawTextItems
            .map((raw) => {
              const rawStr = (raw.str || '').replace(/\s+/g, ' ').trim();
              if (!rawStr) return null;
              const tx = raw.transform ? raw.transform[4] : 0;
              const ty = raw.transform ? raw.transform[5] : 0;
              const fontH = Math.max(
                Math.abs(raw.height || (raw.transform ? raw.transform[3] : 12)),
                10
              );
              const rawW = Math.max(raw.width || rawStr.length * (fontH * 0.55), 10);
              const topY = Math.max(0, baseViewport.height - ty - fontH * 0.85);
              return {
                text: rawStr,
                x: round2(tx),
                y: round2(topY),
                width: round2(rawW),
                height: round2(fontH * 1.2),
                source: 'pdf-text-layer',
              };
            })
            .filter(Boolean);

    context.save();
    context.fillStyle = '#000000';

    for (const item of pageItems) {
      let drewBox = false;
      const padX = 2;
      const padY = 1.5;

      const singleOrigBox = isValidBox(item.boundingBox)
        ? item.boundingBox
        : fallbackBoxByItemId.get(item.id) || null;
      const refBox = isValidBox(singleOrigBox)
        ? singleOrigBox
        : Array.isArray(item.boundingBoxes) && isValidBox(item.boundingBoxes[0])
        ? item.boundingBoxes[0]
        : null;

      let resolvedSource = item.source || null;
      if (!resolvedSource && refBox) {
        const matchingEl = pageElements.find((el) => {
          if (!isValidBox(el) || !el.source) return false;
          const hOv = Math.min(el.x + el.width, refBox.x + refBox.width) - Math.max(el.x, refBox.x);
          const vOv = Math.min(el.y + el.height, refBox.y + refBox.height) - Math.max(el.y, refBox.y);
          return hOv > 1 && vOv > 1;
        });
        if (matchingEl) {
          resolvedSource = matchingEl.source;
        }
      }

      const sanitizedItemMeta = {
        id: item.id || null,
        pageNumber: pageNum,
        category: item.category || null,
        categoryLabel: item.categoryLabel || null,
        maskedText: item.maskedText || '[REDACTED]',
        source: resolvedSource || 'pdf-text-layer',
      };

      // Compute optional raw PDF text substring glyph coverage box for single-line items
      let glyphCoverageBox = null;
      const targetNorm = (item.text || '').replace(/\s+/g, ' ').trim().toLowerCase();

      if (
        targetNorm &&
        (!Array.isArray(item.boundingBoxes) || item.boundingBoxes.length <= 1)
      ) {
        for (let rawIdx = 0; rawIdx < rawTextItems.length; rawIdx++) {
          if (consumedRawIndices.has(rawIdx)) continue;
          const raw = rawTextItems[rawIdx];
          const rawStr = (raw.str || '').replace(/\s+/g, ' ').trim();
          if (!rawStr) continue;

          if (rawStr.toLowerCase().includes(targetNorm)) {
            const tx = raw.transform ? raw.transform[4] : 0;
            const ty = raw.transform ? raw.transform[5] : 0;
            const fontH = Math.max(
              Math.abs(raw.height || (raw.transform ? raw.transform[3] : 12)),
              11
            );
            const rawW = Math.max(raw.width || rawStr.length * (fontH * 0.6), 20);
            const topY = Math.max(0, baseViewport.height - ty - fontH * 0.9);

            if (isValidBox(singleOrigBox) && Math.abs(topY - singleOrigBox.y) > 18) {
              continue;
            }

            const matchIdx = rawStr.toLowerCase().indexOf(targetNorm);
            const startRatio = Math.max(0, matchIdx / Math.max(rawStr.length, 1));
            const widthRatio = Math.min(
              1 - startRatio,
              targetNorm.length / Math.max(rawStr.length, 1)
            );
            glyphCoverageBox = {
              x: Math.max(0, tx + rawW * startRatio - 1.5),
              y: Math.max(0, topY - 1.5),
              width: rawW * widthRatio + 4,
              height: fontH * 1.2 + 3,
              coordinateSpace: 'pdf-top-left-points',
            };
            consumedRawIndices.add(rawIdx);
            break;
          }
        }
      }

      // 1. Multi-line item with `boundingBoxes` (e.g., wrapped 2-line address)
      if (Array.isArray(item.boundingBoxes) && item.boundingBoxes.length > 0) {
        const origSegs = [];
        const finalSegs = [];
        const itemWarnings = [];
        let allSegsObfuscated = true;

        for (const segBox of item.boundingBoxes) {
          if (!isValidBox(segBox)) continue;
          const obstacles = buildPageObstaclesForItem({
            targetItem: item,
            targetBox: segBox,
            pageNumber: pageNum,
            selectedItemsOnPage: pageItems,
            unselectedItemsOnPage: unselectedPageItems,
            pageElements,
          });
          const geom = computeObfuscatedMaskGeometry(segBox, {
            pageDimensions,
            obstacles,
            padX,
            padY,
            itemMetadata: sanitizedItemMeta,
          });
          origSegs.push(geom.originalBoundingBox);
          finalSegs.push(geom.finalMaskBoundingBox);
          if (!geom.maskObfuscationApplied) {
            allSegsObfuscated = false;
          }
          if (geom.obfuscationWarnings.length > 0) {
            itemWarnings.push(...geom.obfuscationWarnings);
            obfuscationWarnings.push(...geom.obfuscationWarnings);
          }

          const fBox = geom.finalMaskBoundingBox;
          if (isValidBox(fBox)) {
            context.fillRect(
              Math.max(0, fBox.x * renderScale),
              Math.max(0, fBox.y * renderScale),
              fBox.width * renderScale,
              fBox.height * renderScale
            );
            drewBox = true;
          }
        }

        if (finalSegs.length > 0) {
          const unionX = Math.min(...finalSegs.map((b) => b.x));
          const unionY = Math.min(...finalSegs.map((b) => b.y));
          const unionRight = Math.max(...finalSegs.map((b) => b.x + b.width));
          const unionBottom = Math.max(...finalSegs.map((b) => b.y + b.height));

          maskGeometryAudit.push({
            id: sanitizedItemMeta.id,
            pageNumber: pageNum,
            category: sanitizedItemMeta.category,
            categoryLabel: sanitizedItemMeta.categoryLabel,
            maskedText: sanitizedItemMeta.maskedText,
            source: sanitizedItemMeta.source,
            maskObfuscationApplied: allSegsObfuscated,
            obfuscationStatus: allSegsObfuscated ? 'OBFUSCATED' : 'UNSAFE_EXPANSION_BLOCKED',
            obfuscationStrategy: MASK_OBFUSCATION_STRATEGY,
            originalBoundingBox: cloneBox(item.boundingBox) || origSegs[0],
            originalBoundingBoxes: origSegs,
            finalMaskBoundingBox: {
              x: round2(unionX),
              y: round2(unionY),
              width: round2(unionRight - unionX),
              height: round2(unionBottom - unionY),
              coordinateSpace: 'pdf-top-left-points',
            },
            finalMaskBoundingBoxes: finalSegs,
            obfuscationWarnings: itemWarnings,
          });
        }
      } else if (isValidBox(singleOrigBox)) {
        // 2. Single-line bounding box (handles PDF text, OCR, hybrid embedded-image OCR, and AcroForm/annotations)
        const obstacles = buildPageObstaclesForItem({
          targetItem: item,
          targetBox: singleOrigBox,
          pageNumber: pageNum,
          selectedItemsOnPage: pageItems,
          unselectedItemsOnPage: unselectedPageItems,
          pageElements,
        });

        const geom = computeObfuscatedMaskGeometry(singleOrigBox, {
          pageDimensions,
          obstacles,
          glyphCoverageBox,
          padX,
          padY,
          itemMetadata: sanitizedItemMeta,
        });

        if (geom.obfuscationWarnings.length > 0) {
          obfuscationWarnings.push(...geom.obfuscationWarnings);
        }

        const fBox = geom.finalMaskBoundingBox;
        if (isValidBox(fBox)) {
          context.fillRect(
            Math.max(0, fBox.x * renderScale),
            Math.max(0, fBox.y * renderScale),
            fBox.width * renderScale,
            fBox.height * renderScale
          );
          drewBox = true;
        }

        maskGeometryAudit.push({
          id: sanitizedItemMeta.id,
          pageNumber: pageNum,
          category: sanitizedItemMeta.category,
          categoryLabel: sanitizedItemMeta.categoryLabel,
          maskedText: sanitizedItemMeta.maskedText,
          source: sanitizedItemMeta.source,
          maskObfuscationApplied: geom.maskObfuscationApplied,
          obfuscationStatus: geom.obfuscationStatus,
          obfuscationStrategy: MASK_OBFUSCATION_STRATEGY,
          originalBoundingBox: geom.originalBoundingBox,
          finalMaskBoundingBox: geom.finalMaskBoundingBox,
          targetBucket: geom.targetBucket,
          obfuscationWarnings: geom.obfuscationWarnings,
        });
      }

      // Never substitute a hardcoded fallback rectangle or silently report success if location could not be established
      if (!drewBox) {
        context.restore();
        const err = new Error(
          `Redaction failed for item "${item.id}" on page ${pageNum}: bounding box coordinates could not be established.`
        );
        err.code = 'REDACTION_COORDINATES_MISSING';
        err.statusCode = 422;
        err.details = {
          unlocatableCount: 1,
          unlocatableItems: [
            {
              id: item.id,
              category: item.category,
              categoryLabel: item.categoryLabel,
              pageNumber: pageNum,
              confidence: item.confidence || 'LOW_UNCERTAIN',
              reason: 'Bounding box coordinates could not be established on the PDF page.',
            },
          ],
        };
        throw err;
      }
    }

    context.restore();

    const pngBuffer = canvas.toBuffer('image/png');
    const embeddedImage = await outputPdf.embedPng(pngBuffer);

    const newPage = outputPdf.addPage([baseViewport.width, baseViewport.height]);
    newPage.drawImage(embeddedImage, {
      x: 0,
      y: 0,
      width: baseViewport.width,
      height: baseViewport.height,
    });
  }

  // If caller requested strict fail-closed behavior when safe dimension obfuscation is blocked:
  if (failOnUnsafeObfuscation && obfuscationWarnings.length > 0) {
    const blockedIds = obfuscationWarnings.map((w) => w.itemId).filter(Boolean).join(', ');
    const err = new Error(
      `Redaction aborted safely: dimension obfuscation could not be safely applied for ${obfuscationWarnings.length} item(s) [${blockedIds}] without colliding with neighboring content or unselected items.`
    );
    err.code = 'MASK_OBFUSCATION_UNSAFE';
    err.statusCode = 422;
    err.details = {
      blockedCount: obfuscationWarnings.length,
      obfuscationStrategy: MASK_OBFUSCATION_STRATEGY,
      obfuscationWarnings,
      maskGeometryAudit,
    };
    throw err;
  }

  const redactedPdfBytes = await outputPdf.save();
  const redactedBuffer = Buffer.from(redactedPdfBytes);
  const sha256 = computeSha256(redactedBuffer);

  const outputFileName = `redacted_${Date.now()}_${crypto.randomUUID()}.pdf`;
  const redactedFilePath = path.join(config.upload.redactedDir, outputFileName);
  await fs.writeFile(redactedFilePath, redactedBuffer);

  const totalAudited = maskGeometryAudit.length;
  const obfuscatedCount = maskGeometryAudit.filter((m) => m.maskObfuscationApplied).length;
  const blockedCount = totalAudited - obfuscatedCount;

  let obfuscationStatus = 'NOT_APPLICABLE';
  let maskObfuscationApplied = false;
  if (totalAudited > 0) {
    if (obfuscatedCount === totalAudited) {
      obfuscationStatus = 'OBFUSCATED';
      maskObfuscationApplied = true;
    } else if (obfuscatedCount > 0) {
      obfuscationStatus = 'PARTIALLY_OBFUSCATED';
      maskObfuscationApplied = false;
    } else {
      obfuscationStatus = 'UNSAFE_EXPANSION_BLOCKED';
      maskObfuscationApplied = false;
    }
  }

  return {
    redactedFilePath,
    fileSizeBytes: redactedBuffer.length,
    sha256,
    pageCount: numPages,
    maskObfuscationApplied,
    obfuscationStatus,
    obfuscationStrategy: MASK_OBFUSCATION_STRATEGY,
    obfuscationWarnings,
    maskGeometryAudit,
    maskObfuscationSummary: {
      maskObfuscationApplied,
      obfuscationStatus,
      obfuscationStrategy: MASK_OBFUSCATION_STRATEGY,
      totalRedactedItems: totalAudited,
      obfuscatedItemsCount: obfuscatedCount,
      constrainedItemsCount: blockedCount,
      obfuscationWarnings,
      items: maskGeometryAudit,
    },
  };
}

