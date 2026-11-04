import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createReferenceSigner } from '../src/reference-journal.mjs';
import { verifyReferenceJournalBrowser } from '../reference-verifier.js';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

// A judge edits the real signed record by hand. Every signed field must be caught by
// the browser verifier, and a change outside the signed content must not be.
function record() {
  const signer = createReferenceSigner();
  const events = [];
  let previousHash = '0'.repeat(64);
  for (const [index, type] of ['workflow_created', 'payment_committed'].entries()) {
    const at = '2026-11-04T00:00:00.000Z';
    const details = { eventId: `event_${index}`, revision: index + 1,
      ...(index ? { payment: { id: 'pay_one', operationId: 'operation_one', amountMinor: 25000000, currency: 'EUR', beneficiaryAccount: 'DE00-TEST-0000-1280' } } : { source: 'synthetic' }) };
    const proof = signer.signEvent({ workflowId: 'workflow_one', operationId: 'operation_one', sequence: index + 1, previousHash, timestamp: at, type, details });
    events.push({ id: details.eventId, revision: details.revision, at, type, details, proof });
    previousHash = proof.eventHash;
  }
  return { events, ledger: [events[1].details.payment], workflowId: 'workflow_one', operationId: 'operation_one', trustedPublicKey: signer.publicKey, expectedHead: previousHash };
}

const clone = value => JSON.parse(JSON.stringify(value));

test('the untouched record verifies in the browser verifier', async () => {
  assert.equal((await verifyReferenceJournalBrowser(record())).valid, true);
});

test('every signed field a judge can reach is rejected when changed', async () => {
  const edits = {
    'one cent on the committed payment': copy => { copy.events[1].details.payment.amountMinor += 1; copy.events[1].proof.payload.details.payment.amountMinor += 1; copy.ledger[0].amountMinor += 1; },
    'ledger alone': copy => { copy.ledger[0].amountMinor += 1; },
    'ledger beneficiary account alone': copy => { copy.ledger[0].beneficiaryAccount = 'DE00-TEST-0000-1289'; },
    'ledger currency alone': copy => { copy.ledger[0].currency = 'USD'; },
    'displayed amount alone': copy => { copy.events[1].details.payment.amountMinor += 1; },
    'beneficiary account': copy => { copy.events[1].proof.payload.details.payment.beneficiaryAccount = 'DE00-TEST-0000-1289'; copy.events[1].details.payment.beneficiaryAccount = 'DE00-TEST-0000-1289'; copy.ledger[0].beneficiaryAccount = 'DE00-TEST-0000-1289'; },
    'currency': copy => { for (const target of [copy.events[1].proof.payload.details.payment, copy.events[1].details.payment, copy.ledger[0]]) target.currency = 'USD'; },
    'timestamp': copy => { copy.events[1].at = '2026-11-04T00:00:01.000Z'; copy.events[1].proof.payload.timestamp = '2026-11-04T00:00:01.000Z'; },
    'event type': copy => { copy.events[1].type = 'payment_refused'; copy.events[1].proof.payload.type = 'payment_refused'; },
    'sequence reordered': copy => { copy.events.reverse(); },
    'event dropped': copy => { copy.events.pop(); },
    'signature byte': copy => { const sig = copy.events[1].proof.signature; copy.events[1].proof.signature = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1); },
    'event hash': copy => { copy.events[1].proof.eventHash = '0'.repeat(64); },
    'previous hash': copy => { copy.events[1].proof.payload.previousHash = '1'.repeat(64); },
    'a second payment added': copy => { copy.ledger.push({ ...copy.ledger[0], id: 'pay_two', operationId: 'operation_two' }); },
    'workflow id': copy => { copy.events[0].proof.payload.workflowId = 'workflow_two'; },
    'key swapped': copy => { copy.trustedPublicKey = createReferenceSigner().publicKey; },
  };
  for (const [name, edit] of Object.entries(edits)) {
    const copy = clone(record()); edit(copy);
    const result = await verifyReferenceJournalBrowser(copy);
    assert.equal(result.valid, false, `${name} was accepted`);
    assert.ok(result.failure?.code, `${name} carries no failure code`);
  }
});

test('an edit outside the signed content is not reported as tampering', async () => {
  const copy = clone(record());
  copy.note = 'a judge wrote this';
  copy.events[1].display = { colour: 'teal' };
  assert.equal((await verifyReferenceJournalBrowser(copy)).valid, true);
});

test('the page carries the bench, no silent download on verify, and no stale local wording', () => {
  const html = read('index.html'), app = read('app.js');
  for (const id of ['bench', 'bench-json', 'bench-check', 'bench-reset', 'bench-status']) assert.ok(html.includes(`id="${id}"`), `${id} missing`);
  const verifyHandler = app.slice(app.indexOf("$('check-evidence').addEventListener"), app.indexOf("$('check-edited-copy').addEventListener"));
  assert.equal(verifyHandler.includes('downloadRecord('), false, 'Verify this record must not download a file');
  for (const stale of ['Records are unsigned', 'local simulation', 'Connect the local model', 'Local reference profile', 'local SQLite', 'The local server is unavailable']) {
    assert.equal(html.includes(stale), false, `index.html still says: ${stale}`);
    assert.equal(app.includes(stale), false, `app.js still says: ${stale}`);
  }
  assert.equal(app.includes("$('export').hidden = hostedDemo"), true, 'Save run record must follow the hosted flag');
  for (const file of ['index.html', 'app.js', 'walkthrough.js', 'styles.css']) assert.equal(read(file).includes('\u2014'), false, `${file} has an em dash`);
  assert.match(html, /src="\/ron\/ron-wave\.png"[^>]*loading="lazy"/);
  assert.match(html, /src="\/samples\/invoice\.jpg"[^>]*loading="lazy"/);
});
