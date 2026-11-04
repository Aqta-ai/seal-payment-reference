import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { WorkflowStore } from '../src/workflow.mjs';
import { createReferenceSigner, verifyReferenceJournal } from '../src/reference-journal.mjs';
import { caseInput, analyse, decision } from './document-fixtures.mjs';

const NOW = Date.parse('2026-10-27T12:00:00.000Z');
function fixture(t, options = {}) {
  const signer = options.referenceSigner ?? createReferenceSigner();
  const store = new WorkflowStore({ now: () => NOW, ...options, referenceSigner: signer });
  t.after(() => store.close());
  return { store, signer, state: store.createDocumentWorkflow(caseInput()) };
}
function temporaryDatabase(t) { const dir = mkdtempSync(join(tmpdir(), 'document-workflow-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return join(dir, 'documents.sqlite'); }
const intent = (state, changes = {}) => ({ approvalId: state.currentApproval.id, ...state.proposal.tuple, ...changes });

test('v2 varies supplier and money, labels trusted seed and signs source-bound creation', async t => {
  const { store, signer, state } = fixture(t);
  assert.equal(state.version, 2); assert.equal(state.scenario, 'documents');
  assert.equal(state.originalAuthoritySource, 'synthetic_case_input');
  assert.equal(state.events[0].proof.payload.details.originalAuthoritySource, 'synthetic_case_input');
  assert.equal(state.currentApproval.source, 'seeded_fixture');
  assert.equal(state.proposal, null); assert.equal(state.sourceDigest.length, 64);
  assert.equal(state.referenceJournal.profile, 'SEAL-REFERENCE-EVENT-v1');
  assert.equal(state.referenceJournal.completeness, 'not_established');
  assert.equal(state.referenceJournal.productionIssuer, false);
  assert.equal(state.events.every(event => event.proof && event.details.eventId === event.id && event.details.revision === event.revision), true);
  assert.equal(verifyReferenceJournal({ events: state.events, trustedPublicKey: signer.publicKey, ledger: [] }).valid, true);
  const other = store.createDocumentWorkflow(caseInput({ supplierId: 'shannon-tools', supplierName: 'Shannon Tools', amountMinor: 1234, currency: 'USD' }));
  assert.notEqual(other.operationId, state.operationId);
  const ready = await analyse(store, other);
  assert.equal(ready.proposal.tuple.supplierId, 'shannon-tools'); assert.equal(ready.proposal.tuple.amountMinor, 1234); assert.equal(ready.proposal.tuple.currency, 'USD');
  const documents = store.readDocuments(other.workflowId);
  assert.equal(Object.hasOwn(documents, 'invoice'), false); assert.equal(Object.hasOwn(documents, 'supplierRequest'), false); assert.equal(Object.hasOwn(documents, 'originalAuthority'), false);
  assert.deepEqual(documents.proposal, ready.proposal); assert.match(documents.sources, /Shannon Tools/);
});

test('v2 cannot run before ready and mismatched proposal tuples never inherit authority', async t => {
  const { store, state } = fixture(t);
  const initial = { approvalId: state.currentApproval.id, operationId: state.operationId, supplierId: state.originalAuthority.supplierId, beneficiaryAccount: state.originalAuthority.beneficiaryAccount, amountMinor: state.originalAuthority.amountMinor, currency: state.originalAuthority.currency };
  assert.equal(store.executePayment(state.workflowId, initial).reasonCode, 'PROPOSAL_NOT_READY');
  assert.equal(store.requestApproval(state.workflowId, Object.fromEntries(Object.entries(initial).filter(([key]) => key !== 'approvalId'))).reasonCode, 'PROPOSAL_NOT_READY');
  const ready = await analyse(store, store.state(state.workflowId));
  assert.equal(ready.proposal.status, 'ready');
  for (const changes of [{ beneficiaryAccount: state.originalAuthority.beneficiaryAccount }, { amountMinor: 1 }, { currency: 'EUR' }, { supplierId: 'another' }, { operationId: 'op_other' }]) {
    assert.equal(store.executePayment(state.workflowId, intent(ready, changes)).reasonCode, 'PROPOSAL_MISMATCH');
    assert.equal(store.requestApproval(state.workflowId, { ...ready.proposal.tuple, ...changes }).reasonCode, 'PROPOSAL_MISMATCH');
  }
  assert.equal(store.executePayment(state.workflowId, intent(ready)).reasonCode, 'ACCOUNT_MISMATCH');
  const refused = store.state(state.workflowId).events.find(event => event.type === 'payment_blocked' && event.details.reasonCode === 'ACCOUNT_MISMATCH');
  assert.deepEqual(refused.details.attemptedIntent, intent(ready));
  assert.equal(store.state(state.workflowId).ledger.length, 0);
});

test('missing, ambiguous, fabricated quotes and changed supplier cannot execute or request approval', async t => {
  const { store } = fixture(t);
  for (const changes of [{ status: 'missing', questions: ['Which currency?'] }, { status: 'ambiguous', questions: ['Which account?'] }, { account: 'IE00-FAKE-9999' }, { supplierName: 'Another Supplier' }]) {
    const created = store.createDocumentWorkflow(caseInput());
    const state = await analyse(store, created, changes);
    assert.equal(state.proposal.status, 'needs_clarification');
    assert.equal(state.proposal.tuple, null);
    const tuple = { operationId: state.operationId, supplierId: state.originalAuthority.supplierId, beneficiaryAccount: state.originalAuthority.beneficiaryAccount, amountMinor: state.originalAuthority.amountMinor, currency: state.originalAuthority.currency };
    assert.equal(store.executePayment(state.workflowId, { approvalId: state.currentApproval.id, ...tuple }).reasonCode, 'PROPOSAL_NOT_READY');
    assert.equal(store.requestApproval(state.workflowId, tuple).reasonCode, 'PROPOSAL_NOT_READY');
  }
});

test('source digest guard and immutable analysis reject replacement or cross-case extraction', async t => {
  const { store, state } = fixture(t);
  assert.equal(store.recordProposal(state.workflowId, {}, '0'.repeat(64)).reasonCode, 'SOURCE_DIGEST_MISMATCH');
  const ready = await analyse(store, state);
  assert.equal(store.recordProposal(state.workflowId, ready.proposal, ready.sourceDigest).reasonCode, 'ANALYSIS_LOCKED');
  const otherInput = caseInput(); otherInput.documents[1].text += '\nClarify later.';
  const other = store.createDocumentWorkflow(otherInput);
  assert.notEqual(other.workflowId, state.workflowId); assert.notEqual(other.sourceDigest, state.sourceDigest);
  assert.equal(store.recordProposal(other.workflowId, ready.proposal, ready.sourceDigest).reasonCode, 'SOURCE_DIGEST_MISMATCH');
});

test('source-bound human review enforces stale decisions, expiry, decline and one commit', async t => {
  let now = NOW;
  const { store, signer, state } = fixture(t, { now: () => now });
  let ready = await analyse(store, state);
  const first = store.requestApproval(state.workflowId, ready.proposal.tuple);
  const second = store.requestApproval(state.workflowId, ready.proposal.tuple);
  assert.equal(store.approve(state.workflowId, decision(first.pendingReview)).reasonCode, 'STALE_REVIEW');
  assert.equal(store.decline(state.workflowId, decision(second.pendingReview)).status, 'declined');
  assert.equal(store.state(state.workflowId).currentApproval, null);
  const review = store.requestApproval(state.workflowId, ready.proposal.tuple);
  assert.equal(store.approve(state.workflowId, decision(review.pendingReview)).status, 'approved');
  ready = store.state(state.workflowId);
  now = Date.parse(ready.currentApproval.expiresAt);
  assert.equal(store.executePayment(state.workflowId, intent(ready)).reasonCode, 'APPROVAL_EXPIRED');
  const fresh = store.requestApproval(state.workflowId, ready.proposal.tuple);
  store.approve(state.workflowId, decision(fresh.pendingReview));
  ready = store.state(state.workflowId);
  const committed = store.executePayment(state.workflowId, intent(ready));
  assert.equal(committed.status, 'committed');
  assert.equal(store.executePayment(state.workflowId, intent(ready)).reasonCode, 'OPERATION_ALREADY_COMMITTED');
  const final = store.state(state.workflowId);
  assert.deepEqual(final.events.find(event => event.type === 'payment_committed').details.payment, final.ledger[0]);
  assert.equal(verifyReferenceJournal({ events: final.events, trustedPublicKey: signer.publicKey, ledger: final.ledger }).valid, true);
});

test('signer failure during commit rolls back ledger, consumption and journal atomically', async t => {
  const original = createReferenceSigner(); let fail = false;
  const referenceSigner = { publicKey: original.publicKey, fingerprint: original.fingerprint, signEvent(payload) { if (fail) throw new Error('Injected failure'); return original.signEvent(payload); } };
  const { store, state } = fixture(t, { referenceSigner });
  const ready = await analyse(store, state, { account: state.originalAuthority.beneficiaryAccount });
  const before = store.state(state.workflowId);
  fail = true;
  assert.equal(store.executePayment(state.workflowId, intent(ready)).status, 'unavailable');
  fail = false;
  const after = store.state(state.workflowId);
  assert.deepEqual(after.events, before.events); assert.equal(after.ledger.length, 0); assert.equal(after.currentApproval.used, false);
  assert.equal(store.executePayment(state.workflowId, intent(after)).status, 'committed');
});

test('database insertion failure rolls back signed authority use', async t => {
  let fail = true;
  const { store, state } = fixture(t, { beforeInsert() { if (fail) throw new Error('Injected failure'); } });
  const ready = await analyse(store, state, { account: state.originalAuthority.beneficiaryAccount });
  assert.equal(store.executePayment(state.workflowId, intent(ready)).status, 'unavailable');
  assert.equal(store.state(state.workflowId).currentApproval.used, false);
  assert.equal(store.state(state.workflowId).ledger.length, 0);
  fail = false; assert.equal(store.executePayment(state.workflowId, intent(ready)).status, 'committed');
});

test('legacy records reopen unchanged and unsigned; v2 requires its original pinned key', async t => {
  const filename = temporaryDatabase(t), signer = createReferenceSigner();
  let store = new WorkflowStore({ filename, referenceSigner: signer, now: () => NOW });
  const legacy = store.createWorkflow({ scenario: 'conflict' });
  const created = store.createDocumentWorkflow(caseInput());
  const ready = await analyse(store, created, { account: created.originalAuthority.beneficiaryAccount });
  store.close();
  store = new WorkflowStore({ filename, referenceSigner: signer, now: () => NOW });
  assert.deepEqual(store.state(legacy.workflowId), legacy);
  assert.equal(store.state(legacy.workflowId).events.some(event => event.proof), false);
  assert.deepEqual(store.state(created.workflowId), ready);
  store.close();
  for (const options of [{}, { referenceSigner: createReferenceSigner() }]) {
    const wrong = new WorkflowStore({ filename, ...options, now: () => NOW });
    assert.equal(wrong.state(created.workflowId).status, 'unavailable');
    assert.deepEqual(wrong.state(legacy.workflowId), legacy);
    wrong.close();
  }
});

test('unknown versions, source tampering and unsigned approval expiry changes fail closed on load', async t => {
  for (const change of [record => { record.version = 3; }, record => { record.documents[0].text += '.'; }, record => { record.approvals[0].expiresAtMs += 86400000; }, record => { record.events[0].details.synthetic = false; }]) {
    const filename = temporaryDatabase(t), signer = createReferenceSigner();
    const store = new WorkflowStore({ filename, referenceSigner: signer, now: () => NOW });
    const state = store.createDocumentWorkflow(caseInput()); store.close();
    const db = new DatabaseSync(filename); const row = db.prepare('SELECT record_json FROM workflows WHERE workflow_id = ?').get(state.workflowId); const record = JSON.parse(row.record_json); change(record);
    db.prepare('UPDATE workflows SET record_json = ? WHERE workflow_id = ?').run(JSON.stringify(record), state.workflowId); db.close();
    const reopened = new WorkflowStore({ filename, referenceSigner: signer, now: () => NOW });
    assert.equal(reopened.state(state.workflowId).status, 'unavailable'); reopened.close();
  }
  const { store } = fixture(t);
  assert.equal(store.createWorkflow({ version: 3 }).reasonCode, 'UNSUPPORTED_VERSION');
  assert.equal(store.createDocumentWorkflow({ ...caseInput(), version: 3 }).reasonCode, 'UNSUPPORTED_VERSION');
  const unsigned = new WorkflowStore(); assert.equal(unsigned.createDocumentWorkflow(caseInput()).status, 'unavailable'); unsigned.close();
});

test('competing SQLite worker connections commit one variable document operation at most', async t => {
  const filename = temporaryDatabase(t);
  const privateKeyPem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  const referenceSigner = createReferenceSigner({ privateKeyPem });
  const { store, state } = fixture(t, { filename, referenceSigner });
  const ready = await analyse(store, state, { account: state.originalAuthority.beneficiaryAccount });
  const gate = new SharedArrayBuffer(4);
  const workers = Array.from({ length: 2 }, () => new Worker(new URL('./document-workflow-worker.mjs', import.meta.url), { workerData: { filename, privateKeyPem, workflowId: state.workflowId, intent: intent(ready), gate, now: NOW } }));
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  let count = 0;
  const results = await Promise.all(workers.map(worker => new Promise((resolve, reject) => {
    worker.on('error', reject); worker.on('exit', code => { if (code) reject(new Error(`Worker exit ${code}`)); });
    worker.on('message', message => { if (message.ready) { if (++count === workers.length) { Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0); } } else resolve(message.result); });
  })));
  assert.equal(results.filter(result => result.status === 'committed').length, 1);
  assert.equal(store.state(state.workflowId).ledger.length, 1);
});
