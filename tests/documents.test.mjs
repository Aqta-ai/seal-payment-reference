import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DOCUMENT_LIMITS, normaliseDocuments, numberedSources, sourceDigestOf, validateOriginalAuthority, validateReport } from '../src/documents.mjs';

const authority = { supplierId: 'liffey-supplies', supplierName: 'Liffey Supplies', beneficiaryAccount: 'IE00-TEST-5600', amountMinor: 71899, currency: 'GBP' };
const sources = () => [{ kind: 'invoice', text: 'Liffey Supplies\r\nAmount: 71899\r\nCurrency: GBP\r\nAccount: IE00-TEST-5600' }, { kind: 'instruction', text: 'Pay Liffey Supplies\nUse IE00-TEST-5601' }];
function report() { return { status: 'ready', candidate: {
  supplierName: { value: authority.supplierName, citation: { documentId: 'invoice', line: 1, quote: 'Liffey Supplies' } },
  amountMinor: { value: authority.amountMinor, citation: { documentId: 'invoice', line: 2, quote: '71899' } },
  currency: { value: authority.currency, citation: { documentId: 'invoice', line: 3, quote: 'GBP' } },
  beneficiaryAccount: { value: 'IE00-TEST-5601', citation: { documentId: 'instruction', line: 2, quote: 'IE00-TEST-5601' } },
}, questions: [] }; }

test('documents normalise line endings once with stable full digests and numbered lines', () => {
  const documents = normaliseDocuments(sources());
  assert.equal(documents[0].text.includes('\r'), false);
  assert.equal(documents[0].digest, createHash('sha256').update(documents[0].text).digest('hex'));
  assert.equal(documents[0].digest.length, 64);
  assert.deepEqual(documents[0].lines[0], { id: 'invoice:L1', number: 1, text: 'Liffey Supplies' });
  assert.match(numberedSources(documents), /Document invoice \(invoice\)\n1: Liffey Supplies/);
  assert.equal(sourceDigestOf(documents), sourceDigestOf(normaliseDocuments(sources().reverse())));
  assert.notEqual(sourceDigestOf(documents), sourceDigestOf(normaliseDocuments(sources().map(item => ({ ...item, text: item.text + '.' })))));
});

test('document and authority schemas reject paths, extra keys, bad UTF8, lines and unsupported money', () => {
  const badSources = [[], [{ kind: 'invoice', path: '/private/file' }, sources()[1]], [{ ...sources()[0], text: '\ud800' }, sources()[1]],
    [{ ...sources()[0], text: 'x'.repeat(DOCUMENT_LIMITS.perDocument + 1) }, sources()[1]], [{ ...sources()[0], text: 'x'.repeat(DOCUMENT_LIMITS.perLine + 1) }, sources()[1]],
    [{ ...sources()[0], text: 'x\n'.repeat(DOCUMENT_LIMITS.lines) }, sources()[1]], [sources()[0], sources()[0]]];
  for (const value of badSources) assert.throws(() => normaliseDocuments(value));
  for (const change of [{ amountMinor: 0 }, { amountMinor: 1.5 }, { currency: 'CAD' }, { supplierId: '../file' }, { supplierName: '' }, { extra: 'no' }]) assert.throws(() => validateOriginalAuthority({ ...authority, ...change }));
});

test('literal citation validation rejects fabricated quotes, wrong lines and malformed candidates', () => {
  const documents = normaliseDocuments(sources());
  assert.equal(validateReport(report(), documents).status, 'ready');
  for (const modify of [value => { value.candidate.currency.citation.line = 2; }, value => { value.candidate.currency.citation.quote = 'EUR'; }, value => { value.candidate.currency.citation.extra = true; }, value => { value.candidate.amountMinor.value = 0; }, value => { value.extra = true; }]) {
    const value = report(); modify(value);
    assert.equal(validateReport(value, documents).status, 'needs_clarification');
  }
  const missing = report(); missing.candidate.currency = null;
  assert.equal(validateReport(missing, documents).status, 'needs_clarification');
  const ambiguous = report(); ambiguous.status = 'ambiguous'; ambiguous.questions = ['Which account should be used?'];
  assert.equal(validateReport(ambiguous, documents).status, 'needs_clarification');
});

test('reference consistency is explicitly narrower than semantic truth', () => {
  const value = report(); value.candidate.amountMinor.value = 42;
  const checked = validateReport(value, normaliseDocuments(sources()));
  assert.equal(checked.referenceConsistency, true);
  assert.equal(checked.status, 'ready');
});
