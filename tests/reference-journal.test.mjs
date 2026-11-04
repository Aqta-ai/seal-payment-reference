import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonicalJson, referenceHash, createReferenceSigner, loadReferenceSigner, verifyReferenceJournal } from '../src/reference-journal.mjs';
import { verifyReferenceJournalBrowser } from '../reference-verifier.js';
import { editOneCent, integrityRejected } from './reference-fixture-helpers.mjs';

const signer = createReferenceSigner();
function record() {
  const events = [];
  let previousHash = '0'.repeat(64);
  for (const [index, type] of ['workflow_created', 'payment_committed'].entries()) {
    const at = '2026-10-27T01:00:00.000Z';
    const details = { eventId: `event_${index}`, revision: index + 1,
      ...(index ? { payment: { id: 'pay_one', operationId: 'operation_one', amountMinor: 480000 } } : { source: 'synthetic' }) };
    const proof = signer.signEvent({ workflowId: 'workflow_one', operationId: 'operation_one', sequence: index + 1, previousHash, timestamp: at, type, details });
    events.push({ id: details.eventId, revision: details.revision, at, type, details, proof });
    previousHash = proof.eventHash;
  }
  return { events, ledger: [events[1].details.payment], workflowId: 'workflow_one', operationId: 'operation_one', trustedPublicKey: signer.publicKey };
}

test('Node and WebCrypto check the actual Ed25519 journal and ledger', async () => {
  const data = record();
  assert.equal(verifyReferenceJournal(data).valid, true);
  assert.equal((await verifyReferenceJournalBrowser(data)).valid, true);
});

test('the real one-cent edit fails the browser event hash, while the saved journal stays valid', async () => {
  const data = record();
  const before = JSON.stringify(data);
  const copy = editOneCent(data);
  assert.equal(JSON.stringify(data), before);
  assert.equal(copy.ledger[0].amountMinor, data.ledger[0].amountMinor + 1);
  assert.equal(verifyReferenceJournal(copy).valid, false);
  const result = await verifyReferenceJournalBrowser(copy);
  assert.equal(result.valid, false);
  assert.deepEqual(result.failure, { code: 'HASH_MISMATCH' });
  assert.equal(integrityRejected(result), true);
  assert.equal(verifyReferenceJournal(data).valid, true);
  assert.equal((await verifyReferenceJournalBrowser(data)).valid, true);
});

test('recomputing an edited envelope hash still fails the actual Ed25519 signature', async () => {
  const data = editOneCent(record());
  const proof = data.events.at(-1).proof;
  const { profile, payload, publicKey, signature } = proof;
  proof.eventHash = referenceHash({ profile, payload, publicKey, signature });
  const result = await verifyReferenceJournalBrowser(data);
  assert.equal(result.valid, false);
  assert.deepEqual(result.failure, { code: 'SIGNATURE_MISMATCH' });
  assert.equal(integrityRejected(result), true);
  assert.equal(verifyReferenceJournal(data).valid, false);
});

test('malformed records and wrong keys fail without being classified as an integrity rejection', async () => {
  for (const mutate of [
    data => { data.events = []; },
    data => { data.events[0].proof.unchecked = true; },
    data => { data.events[0].proof.eventHash = 'invalid'; },
    data => { data.trustedPublicKey = createReferenceSigner().publicKey; },
    data => { delete data.trustedPublicKey; },
  ]) {
    const data = record();
    mutate(data);
    const result = await verifyReferenceJournalBrowser(data);
    assert.equal(result.valid, false);
    assert.equal(typeof result.failure.code, 'string');
    assert.equal(integrityRejected(result), false, 'a check that could not establish integrity is not a proven hash or signature mismatch');
    assert.equal(verifyReferenceJournal(data).valid, false);
  }
});

test('generic crypto exceptions fail closed without claiming a hash or signature mismatch', async t => {
  const data = record();
  const failure = () => { throw new Error('Injected cryptography failure'); };
  for (const method of ['importKey', 'digest', 'verify']) {
    const mocked = t.mock.method(globalThis.crypto.subtle, method, failure);
    try {
      const result = await verifyReferenceJournalBrowser(data);
      assert.equal(result.valid, false, method);
      assert.deepEqual(result.failure, { code: 'VERIFICATION_INCOMPLETE' }, method);
      assert.equal(integrityRejected(result), false, method);
      assert.equal(result.errors.some(error => error.includes('Injected')), false, 'runtime exception text is not exposed');
    } finally { mocked.mock.restore(); }
  }
  assert.equal((await verifyReferenceJournalBrowser(data)).valid, true, 'cryptography is restored after each injected failure');
});

for (const [name, mutate] of [
  ['displayed values', x => { x.events[1].details.payment.amountMinor = 1; }],
  ['signed values', x => { x.events[0].proof.payload.details.source = 'edited'; }],
  ['ordering', x => x.events.reverse()],
  ['omitted middle event', x => x.events.shift()],
  ['ledger mismatch', x => { x.ledger = []; }],
  ['wrong workflow', x => { x.workflowId = 'different'; }],
  ['wrong operation', x => { x.operationId = 'different'; }],
  ['wrong pinned key', x => { x.trustedPublicKey = createReferenceSigner().publicKey; }],
  ['missing pinned key', x => { delete x.trustedPublicKey; }],
  ['extra envelope field', x => { x.events[0].proof.unchecked = true; }],
  ['non-canonical signature', x => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const proof = x.events[0].proof;
    proof.signature = proof.signature.slice(0, -1) + chars[chars.indexOf(proof.signature.at(-1)) + 1];
  }],
]) test(`Both verifiers reject ${name}`, async () => {
  const data = structuredClone(record()); mutate(data);
  assert.equal(verifyReferenceJournal(data).valid, false);
  assert.equal((await verifyReferenceJournalBrowser(data)).valid, false);
});

test('A valid prefix does not establish completeness; a pinned full head rejects it', async () => {
  const data = record(), head = data.events.at(-1).proof.eventHash;
  data.events.pop(); data.ledger = [];
  for (const check of [verifyReferenceJournal, verifyReferenceJournalBrowser]) {
    const prefix = await check(data);
    assert.equal(prefix.valid, true);
    assert.equal(prefix.completeness, 'not_established');
    assert.equal((await check({ ...data, expectedHead: head })).valid, false);
  }
});

test('Canonical profile rejects non-JSON and excessive nesting', () => {
  for (const input of [NaN, Infinity, new Date(), undefined, { a: undefined }, () => {}]) assert.throws(() => canonicalJson(input));
  let deep = {};
  for (let i = 0; i < 40; i++) deep = { child: deep };
  assert.throws(() => canonicalJson(deep));
  assert.equal(canonicalJson({ z: 1, a: ['Irish', null] }), '{"a":["Irish",null],"z":1}');
});

test('The signer rejects non-string workflow identifiers', () => {
  const payload = record().events[0].proof.payload;
  assert.throws(() => signer.signEvent({ ...payload, workflowId: 123 }));
  assert.throws(() => signer.signEvent({ ...payload, operationId: null }));
});

test('Private key persists with restrictive permissions and rejects permissive files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'reference-key-'));
  try {
    const path = join(directory, 'key.pem');
    const first = loadReferenceSigner(path);
    assert.equal(loadReferenceSigner(path).publicKey, first.publicKey);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const bytes = readFileSync(path);
    chmodSync(path, 0o644);
    assert.throws(() => loadReferenceSigner(path));
    assert.deepEqual(readFileSync(path), bytes);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Offline CLI requires an external key and returns a failure exit code for tampering', () => {
  const directory = mkdtempSync(join(tmpdir(), 'reference-cli-'));
  const cli = new URL('../scripts/verify-reference.mjs', import.meta.url);
  try {
    const data = record(), keyPath = join(directory, 'key.json'), recordPath = join(directory, 'record.json');
    writeFileSync(keyPath, JSON.stringify({ publicKey: signer.publicKey }));
    writeFileSync(recordPath, JSON.stringify(data));
    const run = () => spawnSync(process.execPath, [cli.pathname, '--key', keyPath, '--record', recordPath], { encoding: 'utf8' });
    assert.equal(run().status, 0);
    data.ledger = [];
    writeFileSync(recordPath, JSON.stringify(data));
    assert.equal(run().status, 1);
    assert.equal(spawnSync(process.execPath, [cli.pathname, '--record', recordPath]).status, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the verifier reports where the check stopped, and only for a real verdict', async t => {
  // JSON round trip, as the bench does, so the ledger row is no longer the signed event's object.
  const ledgerOnly = JSON.parse(JSON.stringify(record())); ledgerOnly.ledger[0].amountMinor += 1;
  const atLedger = await verifyReferenceJournalBrowser(ledgerOnly);
  assert.equal(atLedger.valid, false);
  assert.deepEqual(atLedger.failure, { code: 'VERIFICATION_INCOMPLETE' });
  assert.deepEqual(atLedger.where, { ledger: true });

  const annotatedThenBroken = record();
  annotatedThenBroken.events[0].reviewerNote = 'outside the signed fields';
  const last = annotatedThenBroken.events.at(-1);
  last.proof.signature = (last.proof.signature[0] === 'A' ? 'B' : 'A') + last.proof.signature.slice(1);
  const atLast = await verifyReferenceJournalBrowser(annotatedThenBroken);
  assert.equal(atLast.valid, false);
  assert.equal(atLast.where.event, annotatedThenBroken.events.length, 'blames the event that failed, not the first edit');
  assert.equal(atLast.where.type, last.type);

  const full = record();
  const pinnedHead = full.events.at(-1).proof.eventHash;
  full.events.pop(); delete full.ledger;
  const atHead = await verifyReferenceJournalBrowser({ ...full, expectedHead: pinnedHead });
  assert.equal(atHead.valid, false);
  assert.deepEqual(atHead.where, { head: true });

  const mocked = t.mock.method(globalThis.crypto.subtle, 'verify', () => { throw new Error('Injected cryptography failure'); });
  try {
    const runtime = await verifyReferenceJournalBrowser(record());
    assert.equal(runtime.valid, false);
    assert.equal(Object.hasOwn(runtime, 'where'), false, 'a runtime exception names no event');
  } finally { mocked.mock.restore(); }

  const clean = await verifyReferenceJournalBrowser(record());
  assert.equal(clean.valid, true);
  assert.equal(Object.hasOwn(clean, 'where'), false);
});
