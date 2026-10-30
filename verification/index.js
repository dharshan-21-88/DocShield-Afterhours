import { extractPdfContent } from '../extraction/index.js';
import { detectSensitiveInfo } from '../detection/index.js';

/**
 * Post-Redaction Verification Engine.
 *
 * "Don't just redact documents. Verify what remains exposed before sharing."
 *
 * After generating the permanently redacted PDF:
 * 1. Re-extracts any embedded PDF text streams.
 * 2. Runs Tesseract.js OCR on the rendered pages of the redacted PDF (when runOcrCheck = true).
 * 3. Checks whether each item selected for redaction is still detectable.
 * 4. Runs full pattern detection on the redacted output to report any remaining
 *    sensitive items (such as items the user left unselected in selective mode).
 */
export async function verifyRedactedPdf(redactedFilePath, originalDetectedItems = [], selectedItemIds = [], runOcrCheck = true) {
  const extraction = await extractPdfContent(redactedFilePath, {
    forceOcr: Boolean(runOcrCheck),
  });

  const combinedAfterText = (extraction.pages || [])
    .map((p) => p.text || '')
    .join('\n')
    .toLowerCase();

  // Also normalize whitespace/punctuation for resilient comparison
  const compactAfterText = combinedAfterText.replace(/[\s-]+/g, '');

  const selectedSet = new Set(selectedItemIds);
  const selectedItems = originalDetectedItems.filter((item) => selectedSet.has(item.id));
  const unselectedItems = originalDetectedItems.filter((item) => !selectedSet.has(item.id));

  const removedItems = [];
  const selectedStillDetectable = [];

  for (const item of selectedItems) {
    const rawTarget = (item.text || '').trim().toLowerCase();
    const compactTarget = rawTarget.replace(/[\s-]+/g, '');

    const stillPresentExact = rawTarget.length > 0 && combinedAfterText.includes(rawTarget);
    const stillPresentCompact = compactTarget.length >= 6 && compactAfterText.includes(compactTarget);

    if (stillPresentExact || stillPresentCompact) {
      selectedStillDetectable.push({
        ...item,
        verificationStatus: 'STILL_DETECTABLE',
      });
    } else {
      removedItems.push({
        ...item,
        verificationStatus: 'VERIFIED_REMOVED',
      });
    }
  }

  // Run the sensitive information detector on the redacted PDF's extracted/OCR text
  const postDetection = detectSensitiveInfo(extraction);

  // Also check if any unselected items from before redaction remain in the text
  const remainingItems = [...postDetection.items];
  for (const unsel of unselectedItems) {
    const rawTarget = (unsel.text || '').trim().toLowerCase();
    if (rawTarget && combinedAfterText.includes(rawTarget)) {
      const alreadyListed = remainingItems.some(
        (r) => r.text.trim().toLowerCase() === rawTarget && r.pageNumber === unsel.pageNumber
      );
      if (!alreadyListed) {
        remainingItems.push({
          ...unsel,
          detectionStatus: 'Unselected item still detectable in exported document',
        });
      }
    }
  }

  const methodsUsed = ['pdf-text-reextraction'];
  if (runOcrCheck || extraction.usedOcrFallback) {
    methodsUsed.push('tesseract-ocr-scan');
  }

  return {
    methodsUsed,
    selectedItemsCount: selectedItems.length,
    successfullyRemovedCount: removedItems.length,
    selectedStillDetectableCount: selectedStillDetectable.length,
    remainingUnselectedDetectableCount: remainingItems.length,
    removedItems,
    selectedStillDetectable,
    remainingItems,
    postExtractionSummary: {
      pageCount: extraction.pageCount,
      extractionMethod: extraction.extractionMethod,
      totalCharactersExtracted: extraction.totalCharacters,
    },
    verificationDisclaimer:
      'Verification checks both embedded PDF text layers and optical character recognition (OCR) on rendered pages. While verified removal confirms that automated tools no longer detect the masked strings, users should always visually inspect the exported PDF before sharing.',
  };
}
