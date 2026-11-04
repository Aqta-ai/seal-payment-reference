import { createHash } from 'node:crypto';

export const DOCUMENT_LIMITS = Object.freeze({ perDocument: 12000, total: 24000, lines: 300, perLine: 2000 });
export const PAYMENT_FIELDS = Object.freeze(['supplierName', 'beneficiaryAccount', 'amountMinor', 'currency']);
export const CURRENCIES = Object.freeze(['EUR', 'GBP', 'USD']);
const KINDS = ['invoice', 'instruction'];

export function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function sha256(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }

function boundedText(value, maximum, empty = false) {
  return typeof value === 'string' && value.isWellFormed() && value.length <= maximum
    && Buffer.byteLength(value, 'utf8') <= maximum * 4 && (empty || value.trim().length > 0)
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

export function validPaymentValue(field, value) {
  if (field === 'amountMinor') return Number.isSafeInteger(value) && value > 0;
  if (field === 'currency') return CURRENCIES.includes(value);
  if (field === 'beneficiaryAccount') return typeof value === 'string' && /^[A-Z0-9][A-Z0-9-]{4,63}$/.test(value);
  return field === 'supplierName' && boundedText(value, 160) && !value.includes('\n') && value === value.trim();
}

export function validateOriginalAuthority(value) {
  if (!exactKeys(value, ['supplierId', ...PAYMENT_FIELDS])
    || typeof value.supplierId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.supplierId)
    || !PAYMENT_FIELDS.every(field => validPaymentValue(field, value[field]))) {
    throw new TypeError('Provide a supplier binding, account, positive integer minor units and EUR, GBP or USD.');
  }
  return structuredClone(value);
}

export function normaliseDocuments(input) {
  if (!Array.isArray(input) || input.length !== 2) throw new TypeError('Provide one invoice and one payment instruction as text.');
  const documents = KINDS.map(kind => {
    const matches = input.filter(item => item?.kind === kind);
    if (matches.length !== 1 || !exactKeys(matches[0], ['kind', 'text'])) throw new TypeError('Provide exactly one document of each supported kind.');
    const raw = matches[0].text;
    if (!boundedText(raw, DOCUMENT_LIMITS.perDocument)) throw new TypeError('A document is empty, invalid or exceeds 12,000 characters.');
    const text = raw.replace(/^\uFEFF/u, '').replace(/\r\n?/g, '\n').normalize('NFC');
    const parts = text.split('\n');
    if (!boundedText(text, DOCUMENT_LIMITS.perDocument) || parts.length > DOCUMENT_LIMITS.lines
      || parts.some(line => !boundedText(line, DOCUMENT_LIMITS.perLine, true))) throw new TypeError('Document line bounds exceeded.');
    return { id: kind, kind, text, digest: sha256(text), lines: parts.map((line, index) => ({ id: `${kind}:L${index + 1}`, number: index + 1, text: line })) };
  });
  if (documents.reduce((sum, document) => sum + document.text.length, 0) > DOCUMENT_LIMITS.total) throw new TypeError('Documents exceed 24,000 characters in total.');
  return documents;
}

export function validateStoredDocuments(documents) {
  if (!Array.isArray(documents) || documents.length !== 2) throw new TypeError('Invalid stored documents.');
  const expected = normaliseDocuments(documents.map(document => ({ kind: document.kind, text: document.text })));
  if (JSON.stringify(documents) !== JSON.stringify(expected)) throw new TypeError('Stored document content or digest does not match.');
  return documents;
}

export function sourceDigestOf(documents) {
  return sha256(JSON.stringify(documents.map(({ id, kind, digest }) => ({ id, kind, digest }))));
}

export function numberedSources(documents) {
  validateStoredDocuments(documents);
  return documents.map(document => `Document ${document.id} (${document.kind})\n${document.lines.map(line => `${line.number}: ${line.text}`).join('\n')}`).join('\n\n');
}

export function citationMatches(citation, documents) {
  if (!exactKeys(citation, ['documentId', 'line', 'quote']) || !Number.isSafeInteger(citation.line) || citation.line < 1
    || !boundedText(citation.quote, DOCUMENT_LIMITS.perLine)) return false;
  const document = documents.find(item => item.id === citation.documentId);
  const line = document?.lines[citation.line - 1];
  return Boolean(line && line.number === citation.line && line.text.includes(citation.quote));
}

/** Checks literal source references only. It does not establish semantic truth. */
export function validateReport(report, documents) {
  const questions = [];
  const empty = () => Object.fromEntries(PAYMENT_FIELDS.map(field => [field, null]));
  if (!exactKeys(report, ['status', 'candidate', 'questions']) || !['ready', 'missing', 'ambiguous'].includes(report.status)
    || !exactKeys(report.candidate, PAYMENT_FIELDS) || !Array.isArray(report.questions) || report.questions.length > 8
    || report.questions.some(question => !boundedText(question, 500))) {
    return { status: 'needs_clarification', candidate: empty(), questions: ['The extraction did not return the required closed report.'], referenceConsistency: false };
  }
  const candidate = structuredClone(report.candidate);
  let referencesValid = true;
  for (const field of PAYMENT_FIELDS) {
    const entry = candidate[field];
    if (entry === null) { questions.push(`Clarify ${field}.`); continue; }
    if (!exactKeys(entry, ['value', 'citation']) || !validPaymentValue(field, entry.value) || !citationMatches(entry.citation, documents)) {
      referencesValid = false;
      candidate[field] = null;
      questions.push(`Provide a valid source reference for ${field}.`);
    }
  }
  const ready = report.status === 'ready' && referencesValid && PAYMENT_FIELDS.every(field => candidate[field] !== null) && report.questions.length === 0;
  return { status: ready ? 'ready' : 'needs_clarification', candidate,
    questions: ready ? [] : (report.questions.length ? report.questions : questions).slice(0, 8).concat(!report.questions.length && !questions.length ? ['Clarify the missing or ambiguous payment details.'] : []),
    referenceConsistency: referencesValid && PAYMENT_FIELDS.every(field => candidate[field] !== null) };
}
