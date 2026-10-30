/**
 * Contextual Information Leakage & Quasi-Identifier Risk Analysis Engine for DocShield (P4).
 *
 * Evaluates contextual privacy risks that persist even when primary sensitive identifiers are redacted:
 * 1. Category Label Leakage: Visible text labels (e.g. "Permanent Account Number (PAN):", "Email address:")
 *    immediately preceding or surrounding a redacted secret that disclose the semantic category of the hidden asset.
 * 2. Quasi-Identifiers (QIs): Individually non-unique contextual attributes (Occupation, Organization,
 *    Geographic Location, Demographic/Age) that may indirectly narrow down identity.
 * 3. Combinatorial Heuristic Risk: Evaluates co-occurrence, proximity, and specificity of quasi-identifiers
 *    to generate explainable, heuristic warnings without asserting scientific certainty or k-anonymity.
 *
 * GUARDRAIL: This engine produces heuristic analysis and explainable warnings only. It NEVER automatically
 * or silently redacts surrounding text or quasi-identifiers without explicit user selection.
 */

export const CONTEXTUAL_CATEGORIES = {
  DIRECT_IDENTIFIER: 'Direct Identifier',
  LABEL_LEAKAGE: 'Surrounding Category Label Exposure',
  QUASI_IDENTIFIER: 'Quasi-Identifier',
};

export const QUASI_IDENTIFIER_TYPES = {
  OCCUPATION_ROLE: 'Occupation / Professional Designation',
  ORGANIZATION: 'Organization / Institution / Employer',
  GEOGRAPHIC_LOCATION: 'Geographic Location / Locality',
  DEMOGRAPHIC_ATTRIBUTE: 'Demographic / Cohort Attribute',
};

// Known direct PII category keys from detection engine
const DIRECT_PII_CATEGORIES = new Set([
  'NATIONAL_ID_PAN',
  'NATIONAL_ID_AADHAAR',
  'PHONE_NUMBER',
  'EMAIL_ADDRESS',
  'FINANCIAL_ACCOUNT',
  'STUDENT_REG_NUMBER',
]);

// Patterns for identifying preceding category lead-in labels
const CATEGORY_LABEL_PATTERNS = [
  {
    targetCategory: 'NATIONAL_ID_PAN',
    labelType: 'PAN_LABEL',
    regex: /\b(?:Permanent\s+Account\s+Number(?:\s*\(PAN\))?|PAN(?:\s+Card(?:\s+No\.?|\s+Number)?)?|Tax\s+ID(?:\s*\(PAN\))?)\s*[:=-]?/gi,
    description: 'Permanent Account Number (PAN) identifier lead-in label',
  },
  {
    targetCategory: 'EMAIL_ADDRESS',
    labelType: 'EMAIL_LABEL',
    regex: /\b(?:Email(?:\s+Address)?|E-mail(?:\s+Address)?|Mail\s+ID|Contact\s+Email)\s*[:=-]?/gi,
    description: 'Email address lead-in label',
  },
  {
    targetCategory: 'PHONE_NUMBER',
    labelType: 'PHONE_LABEL',
    regex: /\b(?:Phone(?:\s+Number|\s+No\.?)?|Mobile(?:\s+Number|\s+No\.?)?|Contact(?:\s+Number|\s+No\.?)?|Telephone(?:\s+No\.?)?|Cell(?:\s+No\.?)?)\s*[:=-]?/gi,
    description: 'Telephone / mobile number lead-in label',
  },
  {
    targetCategory: 'NATIONAL_ID_AADHAAR',
    labelType: 'AADHAAR_LABEL',
    regex: /\b(?:Aadhaar(?:\s+Number|\s+No\.?|\s+Card)?|Aadhar|UIDAI|National\s+ID(?:\s+Number)?)\s*[:=-]?/gi,
    description: 'Aadhaar / National Identity lead-in label',
  },
  {
    targetCategory: 'FINANCIAL_ACCOUNT',
    labelType: 'FINANCIAL_LABEL',
    regex: /\b(?:Bank\s+Account(?:\s+No\.?|\s+Number)?|Account\s+No\.?|A\/C\s+No\.?|IFSC(?:\s+Code)?|Card\s+Number)\s*[:=-]?/gi,
    description: 'Financial account or banking identifier lead-in label',
  },
  {
    targetCategory: 'STUDENT_REG_NUMBER',
    labelType: 'STUDENT_REG_LABEL',
    regex: /\b(?:Student\s+Registration(?:\s+No\.?|\s+Number)?|Registration\s+No\.?|Roll\s+No\.?|USN|Enrollment\s+No\.?)\s*[:=-]?/gi,
    description: 'Student academic registration or roll number lead-in label',
  },
];

// Heuristic patterns for quasi-identifiers
const QUASI_IDENTIFIER_PATTERNS = [
  {
    type: 'OCCUPATION_ROLE',
    categoryLabel: QUASI_IDENTIFIER_TYPES.OCCUPATION_ROLE,
    specificity: 'HIGH',
    regex: /\b(?:Dean|Director(?:\s+General)?|Registrar|Vice[- ]Chancellor|Head\s+of\s+Department|HOD|Chief\s+(?:Executive|Medical|Technology|Financial)\s+Officer|Lead\s+(?:Architect|Scientist|Engineer)|Senior\s+(?:Consultant|Registrar|Surgeon|Lecturer)|Associate\s+Professor|Professor|Assistant\s+Professor)\b(?:\s+of\s+[A-Z][a-zA-Z\s]+)?/gi,
    description: 'Executive, academic, or medical leadership role',
  },
  {
    type: 'ORGANIZATION',
    categoryLabel: QUASI_IDENTIFIER_TYPES.ORGANIZATION,
    specificity: 'MEDIUM',
    regex: /\b(?:[A-Z][A-Za-z0-9&.-]+(?:\s+[A-Z][A-Za-z0-9&.-]+)*\s+(?:University|Institute\s+of\s+Technology|Hospital|Medical\s+Center|College|Foundation|Corporation|Pvt\.?\s*Ltd\.?|Limited))\b/g,
    description: 'Named institutional, corporate, or healthcare entity',
  },
  {
    type: 'DEMOGRAPHIC_ATTRIBUTE',
    categoryLabel: QUASI_IDENTIFIER_TYPES.DEMOGRAPHIC_ATTRIBUTE,
    specificity: 'MEDIUM',
    regex: /\b(?:Age\s*[:=-]?\s*(?:[1-9]\d|\d{2}\s*-\s*\d{2})|Born\s+in\s+\d{4}|Class\s+of\s+\d{4}|Graduating\s+Class\s+of\s+\d{4}|DOB\s*[:=-]?\s*\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/gi,
    description: 'Age, birth year, or graduation cohort indicator',
  },
  {
    type: 'GEOGRAPHIC_LOCATION',
    categoryLabel: QUASI_IDENTIFIER_TYPES.GEOGRAPHIC_LOCATION,
    specificity: 'MEDIUM',
    regex: /\b(?:(?:Bengaluru|Bangalore|Mumbai|Delhi|Chennai|Hyderabad|Kolkata|Pune|Ahmedabad|Jaipur)\s*(?:-\s*\d{6}|\b\d{6}\b)?|\b\d{6}\b|[A-Z][a-z]+\s+(?:District|Nagar|Layout|Sector\s*\d+|Block\s*[A-Z0-9]+))\b/g,
    description: 'Geographic locality, city, district, or postal PIN code',
  },
];

/**
 * Identify category labels in the text that appear adjacent to detected sensitive items.
 *
 * @param {Array} pages - Extracted PDF pages
 * @param {Array} detectedItems - Sensitive items detected on the pages
 * @returns {Array} List of identified category label exposures
 */
export function detectCategoryLabelExposures(pages = [], detectedItems = []) {
  const exposures = [];
  let labelCounter = 1;

  for (const page of pages) {
    const pageText = page.text || '';
    const pageItems = (detectedItems || []).filter((it) => it.pageNumber === page.pageNumber);
    if (!pageText || pageItems.length === 0) continue;

    for (const item of pageItems) {
      if (!DIRECT_PII_CATEGORIES.has(item.category)) continue;

      // Find the position of item.text on pageText
      const itemText = item.text || '';
      if (!itemText) continue;

      let searchStart = 0;
      while (searchStart < pageText.length) {
        const itemIdx = pageText.indexOf(itemText, searchStart);
        if (itemIdx === -1) break;
        searchStart = itemIdx + itemText.length;

        // Inspect window of up to 60 characters preceding this item
        const windowStart = Math.max(0, itemIdx - 60);
        const precedingText = pageText.slice(windowStart, itemIdx);

        for (const pattern of CATEGORY_LABEL_PATTERNS) {
          if (pattern.targetCategory !== item.category) continue;

          const re = new RegExp(pattern.regex.source, pattern.regex.flags);
          let match;
          while ((match = re.exec(precedingText)) !== null) {
            const labelStr = match[0].trim();
            // Ensure label directly leads into the sensitive value on the same logical line
            const labelEndInPreceding = match.index + match[0].length;
            const gapText = precedingText.slice(labelEndInPreceding);

            if (/^[\s:=-]{0,10}$/.test(gapText) && !gapText.includes('\n')) {
              const labelId = `lbl_${labelCounter++}`;
              exposures.push({
                id: labelId,
                pageNumber: page.pageNumber,
                associatedItemId: item.id,
                targetCategory: item.category,
                targetCategoryLabel: item.categoryLabel,
                labelText: labelStr,
                labelType: pattern.labelType,
                description: pattern.description,
                severity: 'MEDIUM',
                riskSummary: `Surrounding text explicitly contains "${labelStr}" immediately preceding the redacted ${item.categoryLabel}. Even if the value is masked, observers can infer the category of the hidden asset.`,
                remediationAdvice: 'Review surrounding text. If appropriate for the use-case, consider removing or generalizing the category lead-in phrase during document authoring.',
              });
            }
          }
        }
      }
    }
  }

  return exposures;
}

/**
 * Extract heuristic quasi-identifiers present in document pages.
 *
 * @param {Array} pages - Extracted PDF pages
 * @returns {Array} List of detected quasi-identifiers
 */
export function extractQuasiIdentifiers(pages = []) {
  const quasiIdentifiers = [];
  let qiCounter = 1;
  const seenTexts = new Set();

  for (const page of pages) {
    const pageText = page.text || '';
    if (!pageText.trim()) continue;

    for (const pattern of QUASI_IDENTIFIER_PATTERNS) {
      const re = new RegExp(pattern.regex.source, pattern.regex.flags);
      let match;
      while ((match = re.exec(pageText)) !== null) {
        const matchedText = match[0].trim();
        if (!matchedText || matchedText.length < 3) continue;

        // Skip standalone common numbers that matched PIN regex but are irrelevant
        if (pattern.type === 'GEOGRAPHIC_LOCATION' && /^\d+$/.test(matchedText)) {
          // Require exactly 6 digits for Indian PIN codes
          if (!/^\d{6}$/.test(matchedText)) continue;
        }

        const dedupKey = `${page.pageNumber}:${pattern.type}:${matchedText.toLowerCase()}`;
        if (seenTexts.has(dedupKey)) continue;
        seenTexts.add(dedupKey);

        quasiIdentifiers.push({
          id: `qi_${qiCounter++}`,
          pageNumber: page.pageNumber,
          type: pattern.type,
          categoryLabel: pattern.categoryLabel,
          text: matchedText,
          specificity: pattern.specificity,
          description: pattern.description,
        });
      }
    }
  }

  return quasiIdentifiers;
}

/**
 * Assess combinatorial indirect re-identification risk from quasi-identifiers.
 *
 * NOTE: This is a configurable heuristic assessment, NOT a mathematical calculation
 * of population uniqueness or formal k-anonymity.
 *
 * @param {Array} quasiIdentifiers - List of extracted quasi-identifiers
 * @param {Array} pages - Extracted PDF pages for context
 * @returns {Object} Structured combinatorial risk assessment
 */
export function evaluateQuasiIdentifierCombinations(quasiIdentifiers = [], pages = []) {
  if (!quasiIdentifiers || quasiIdentifiers.length === 0) {
    return {
      hasCombinatorialRisk: false,
      riskLevel: 'LOW_INDICATIVE_RISK',
      flaggedCombinations: [],
      distinctCategoryCount: 0,
      summary: 'No prominent quasi-identifier clusters were detected in the document text.',
      disclaimer:
        'This assessment is a heuristic contextual privacy scan. It does not measure true population uniqueness or guarantee k-anonymity.',
    };
  }

  const distinctTypes = new Set(quasiIdentifiers.map((qi) => qi.type));
  const distinctCategoryCount = distinctTypes.size;

  const flaggedCombinations = [];

  // Group QIs by page to analyze local co-occurrence
  const byPage = new Map();
  for (const qi of quasiIdentifiers) {
    if (!byPage.has(qi.pageNumber)) byPage.set(qi.pageNumber, []);
    byPage.get(qi.pageNumber).push(qi);
  }

  for (const [pageNumber, qis] of byPage.entries()) {
    const pageTypes = new Set(qis.map((q) => q.type));
    const hasRole = qis.some((q) => q.type === 'OCCUPATION_ROLE');
    const hasOrg = qis.some((q) => q.type === 'ORGANIZATION');
    const hasLoc = qis.some((q) => q.type === 'GEOGRAPHIC_LOCATION');
    const hasDemo = qis.some((q) => q.type === 'DEMOGRAPHIC_ATTRIBUTE');

    // Case 1: Specific Role + Organization (+ optional Location)
    if (hasRole && hasOrg) {
      const roleItems = qis.filter((q) => q.type === 'OCCUPATION_ROLE');
      const orgItems = qis.filter((q) => q.type === 'ORGANIZATION');
      const locItems = qis.filter((q) => q.type === 'GEOGRAPHIC_LOCATION');

      const details = [
        `Role: "${roleItems[0].text}"`,
        `Organization: "${orgItems[0].text}"`,
        ...(locItems.length > 0 ? [`Location: "${locItems[0].text}"`] : []),
      ].join(' + ');

      flaggedCombinations.push({
        id: `comb_p${pageNumber}_role_org`,
        pageNumber,
        riskLevel: locItems.length > 0 ? 'HIGH_INDICATIVE_RISK' : 'MODERATE_INDICATIVE_RISK',
        confidence: 'MEDIUM',
        coOccurringCategories: Array.from(pageTypes),
        evidenceSnippet: details,
        reason:
          'A specific professional designation or academic leadership role combined with a named organization significantly narrows the candidate pool of individuals, creating potential indirect re-identification risk.',
        remediationAdvice:
          'Review whether designating specific executive/academic roles alongside institution names is required in the shared document.',
      });
    }

    // Case 2: Organization + Location + Demographic attribute (without role)
    if (!hasRole && hasOrg && hasLoc && hasDemo) {
      const orgItems = qis.filter((q) => q.type === 'ORGANIZATION');
      const locItems = qis.filter((q) => q.type === 'GEOGRAPHIC_LOCATION');
      const demoItems = qis.filter((q) => q.type === 'DEMOGRAPHIC_ATTRIBUTE');

      const details = [
        `Organization: "${orgItems[0].text}"`,
        `Location: "${locItems[0].text}"`,
        `Demographic: "${demoItems[0].text}"`,
      ].join(' + ');

      flaggedCombinations.push({
        id: `comb_p${pageNumber}_org_loc_demo`,
        pageNumber,
        riskLevel: 'MODERATE_INDICATIVE_RISK',
        confidence: 'MEDIUM',
        coOccurringCategories: Array.from(pageTypes),
        evidenceSnippet: details,
        reason:
          'Co-occurrence of institutional affiliation, geographic locality, and demographic or cohort attributes (e.g. age range or graduating class) may allow indirect triangulation in small cohorts.',
        remediationAdvice:
          'Consider whether granular demographic details or precise location attributes can be aggregated or omitted.',
      });
    }

    // Case 3: Multiple distinct QIs (>= 2) without specific role
    if (!hasRole && pageTypes.size >= 2 && flaggedCombinations.length === 0) {
      const summaryItems = qis.slice(0, 3).map((q) => `[${q.type}] "${q.text}"`).join(', ');
      flaggedCombinations.push({
        id: `comb_p${pageNumber}_multi_qi`,
        pageNumber,
        riskLevel: 'LOW_TO_MODERATE_INDICATIVE_RISK',
        confidence: 'LOW_UNCERTAIN',
        coOccurringCategories: Array.from(pageTypes),
        evidenceSnippet: summaryItems,
        reason:
          'Multiple distinct contextual attributes appear on the same page. While individually benign, their combination provides contextual clues about the document subject.',
        remediationAdvice: 'Review whether these contextual attributes could assist in deductive re-identification.',
      });
    }
  }

  // Determine overall document risk level
  let overallRisk = 'LOW_INDICATIVE_RISK';
  if (flaggedCombinations.some((c) => c.riskLevel === 'HIGH_INDICATIVE_RISK')) {
    overallRisk = 'HIGH_INDICATIVE_RISK';
  } else if (flaggedCombinations.some((c) => c.riskLevel.includes('MODERATE'))) {
    overallRisk = 'MODERATE_INDICATIVE_RISK';
  }

  const summary =
    flaggedCombinations.length > 0
      ? `Flagged ${flaggedCombinations.length} contextual quasi-identifier cluster(s) with ${overallRisk.replace(/_/g, ' ')}. Individually harmless details could assist indirect re-identification when combined.`
      : 'Quasi-identifiers detected, but no high-risk combinations were identified.';

  return {
    hasCombinatorialRisk: flaggedCombinations.length > 0,
    riskLevel: overallRisk,
    distinctCategoryCount,
    flaggedCombinations,
    summary,
    disclaimer:
      'Heuristic contextual privacy assessment. DocShield does not claim absolute uniqueness, measured re-identification probability, or k-anonymity without a population reference dataset.',
  };
}

/**
 * Master analysis function for contextual privacy leakage.
 *
 * Categorizes findings into:
 * - Direct Identifiers (from detection engine)
 * - Category Label Exposures
 * - Quasi-Identifiers & Combinatorial Linkage Risks
 *
 * @param {Object} extraction - PDF extraction result
 * @param {Array} detectedItems - Sensitive items from detectSensitiveInfo
 * @returns {Object} Comprehensive contextual privacy assessment
 */
export function analyzeContextualPrivacy({ extraction, detectedItems = [] }) {
  const pages = extraction?.pages || [];

  // 1. Separate direct identifiers from contextual metadata
  const directIdentifiers = (detectedItems || []).map((it) => ({
    id: it.id,
    pageNumber: it.pageNumber,
    category: it.category,
    categoryLabel: it.categoryLabel,
    classification: 'DIRECT_IDENTIFIER',
    confidence: it.confidence,
    boundingBox: it.boundingBox || null,
  }));

  // 2. Identify category label leakage adjacent to direct identifiers
  const labelExposures = detectCategoryLabelExposures(pages, detectedItems);

  // 3. Extract heuristic quasi-identifiers
  const quasiIdentifiers = extractQuasiIdentifiers(pages);

  // 4. Evaluate combinatorial linkage risk
  const combinatorialRisk = evaluateQuasiIdentifierCombinations(quasiIdentifiers, pages);

  return {
    hasContextualRisks: labelExposures.length > 0 || combinatorialRisk.hasCombinatorialRisk,
    overallRiskLevel: combinatorialRisk.riskLevel,
    directIdentifierCount: directIdentifiers.length,
    labelExposureCount: labelExposures.length,
    quasiIdentifierCount: quasiIdentifiers.length,
    labelExposures,
    quasiIdentifiers,
    combinatorialRisk,
    disclaimer:
      'Contextual privacy findings are heuristic signals designed to guide human review. Ordinary surrounding labels and quasi-identifiers are not automatically redacted. Absolute anonymity cannot be guaranteed.',
  };
}
