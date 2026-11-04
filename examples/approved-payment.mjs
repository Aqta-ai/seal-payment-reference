// Deterministic local integration example. No model or external service is called.
// The fixed report represents a model proposal, never payment authority.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { WorkflowStore } from '../src/workflow.mjs';
import { createReferenceSigner, verifyReferenceJournal } from '../src/reference-journal.mjs';
import { verifyReferenceJournalBrowser } from '../reference-verifier.js';
import { caseInput, modelReport, decision } from '../tests/document-fixtures.mjs';

const output = resolve(process.argv[2] || '.data/example');
const signer = createReferenceSigner(); // A fresh local key, unrelated to production Seal.
const store = new WorkflowStore({ referenceSigner: signer });
try {
  // Synthetic source input is shared with the native document workflow tests.
  const created = store.createDocumentWorkflow(caseInput());
  const ready = store.recordProposal(created.workflowId, modelReport(created), created.sourceDigest);
  assert.equal(ready.proposal.status, 'ready');
  const originalIntent = { approvalId: ready.currentApproval.id, ...ready.proposal.tuple };
  const refused = store.executePayment(ready.workflowId, originalIntent);
  assert.equal(refused.reasonCode, 'ACCOUNT_MISMATCH');
  assert.equal(store.state(ready.workflowId).ledger.length, 0);

  // This explicit fixture decision stands in for a person reviewing the exact tuple.
  // A real integration must establish its own approver identity and review channel.
  const review = store.requestApproval(ready.workflowId, ready.proposal.tuple);
  assert.equal(review.status, 'awaiting_human');
  assert.equal(store.approve(ready.workflowId, decision(review.pendingReview)).status, 'approved');
  const approved = store.state(ready.workflowId);
  const approvedIntent = { approvalId: approved.currentApproval.id, ...approved.proposal.tuple };
  assert.equal(store.executePayment(approved.workflowId, approvedIntent).status, 'committed');
  const ledger = structuredClone(store.state(approved.workflowId).ledger);
  assert.equal(ledger.length, 1);
  assert.equal(store.executePayment(approved.workflowId, approvedIntent).reasonCode, 'OPERATION_ALREADY_COMMITTED');
  const final = store.state(approved.workflowId);
  assert.deepEqual(final.ledger, ledger);

  const record = { ...final, example: 'deterministic fixture, no model call or real approver identity' };
  const check = data => ({ events: data.events, ledger: data.ledger,
    workflowId: data.workflowId, operationId: data.operationId, trustedPublicKey: signer.publicKey });
  assert.equal(verifyReferenceJournal(check(record)).valid, true);
  assert.equal((await verifyReferenceJournalBrowser(check(record))).valid, true);

  // Change the displayed and signed amount together without re-signing the event.
  const edited = structuredClone(record);
  const amountMinor = record.ledger[0].amountMinor + 1;
  const commit = edited.events.find(event => event.type === 'payment_committed' && event.details.payment.id === ledger[0].id);
  edited.ledger[0].amountMinor = amountMinor;
  commit.details.payment.amountMinor = amountMinor;
  commit.proof.payload.details.payment.amountMinor = amountMinor;
  assert.equal(verifyReferenceJournal(check(edited)).valid, false);
  const editedResult = await verifyReferenceJournalBrowser(check(edited));
  assert.equal(editedResult.valid, false);
  assert.equal(editedResult.failure.code, 'HASH_MISMATCH');
  assert.equal(verifyReferenceJournal(check(record)).valid, true);

  mkdirSync(output, { recursive: true });
  for (const [name, data] of [['record.json', record], ['edited-record.json', edited], ['pinned-key.json', store.referenceKey]]) {
    writeFileSync(join(output, name), JSON.stringify(data, null, 2) + '\n');
  }
  console.log('Changed proposal refused; explicit fixture review approved a fresh tuple.');
  console.log('One simulated payment committed; replay refused with an unchanged ledger.');
  console.log('Original record verified; one-cent edited copy rejected by both real verifiers.');
  console.log(`Exported record, edited copy and public checking key to ${output}`);
} finally { store.close(); }
