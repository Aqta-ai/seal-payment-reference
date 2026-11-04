import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { WorkflowStore } from "../src/workflow.mjs";

const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const ORIGINAL_ACCOUNT = "DE00-TEST-0000-1280";
const CHANGED_ACCOUNT = "DE00-TEST-0000-1289";

function fixture(t, options = {}) {
  const store = new WorkflowStore({ now: () => NOW, ...options });
  t.after(() => store.close());
  return { store, state: store.createWorkflow({ scenario: "conflict" }) };
}

function tuple(state, changes = {}) {
  return {
    operationId: state.operationId,
    supplierId: "harbour-print",
    beneficiaryAccount: ORIGINAL_ACCOUNT,
    amountMinor: 25000000,
    currency: "EUR",
    ...changes,
  };
}

function intent(state, changes = {}) {
  return { approvalId: state.currentApproval.id, ...tuple(state), ...changes };
}

function valuesOf(value) {
  const { operationId, supplierId, beneficiaryAccount, amountMinor, currency } = value;
  return { operationId, supplierId, beneficiaryAccount, amountMinor, currency };
}

function decision(review, changes = {}) {
  return { reviewId: review.reviewId, digest: review.digest, expectedRevision: review.expectedRevision, ...changes };
}

function temporaryDatabase(t) {
  const directory = mkdtempSync(join(tmpdir(), "workflow-store-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "workflow.sqlite");
}

async function concurrentWorkers(t, filename, state, mode = "execute") {
  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const workers = Array.from({ length: 2 }, () => new Worker(new URL("./workflow-worker.mjs", import.meta.url), {
    workerData: { filename, workflowId: state.workflowId, intent: intent(state), tuple: tuple(state), mode, now: NOW, gate },
  }));
  t.after(async () => { await Promise.all(workers.map((worker) => worker.terminate())); });
  let ready = 0;
  const results = await Promise.all(workers.map((worker) => new Promise((resolve, reject) => {
    worker.on("error", reject);
    worker.on("exit", (code) => { if (code !== 0) reject(new Error(`Worker exited with code ${code}.`)); });
    worker.on("message", (message) => {
      if (message.ready) {
        ready += 1;
        if (ready === workers.length) {
          Atomics.store(new Int32Array(gate), 0, 1);
          Atomics.notify(new Int32Array(gate), 0, workers.length);
        }
      } else if (message.result) {
        resolve(message.result);
      }
    });
  })));
  return results;
}

test("synthetic documents expose the operation, exact values and clearly seeded approval", (t) => {
  const { store, state } = fixture(t);
  assert.equal(state.scenario, "conflict");
  assert.equal(state.currentApproval.source, "seeded_fixture");
  assert.deepEqual(state.approval, state.currentApproval);
  assert.equal(state.pendingReview, null);
  assert.equal(state.ledger.length, 0);
  assert.equal(state.events.filter((event) => event.type === "operator_approved").length, 0);

  const documents = store.readDocuments(state.workflowId);
  assert.equal(documents.operationId, state.operationId);
  assert.equal(documents.currentApproval.id, state.currentApproval.id);
  assert.deepEqual(documents.invoice, tuple(state));
  assert.deepEqual(documents.supplierRequest, tuple(state, { beneficiaryAccount: CHANGED_ACCOUNT }));
  assert.match(documents.invoiceText, /Synthetic invoice/);
  assert.ok(documents.invoiceText.includes(state.operationId));
  assert.ok(documents.invoiceText.includes(ORIGINAL_ACCOUNT));
  assert.ok(documents.supplierEmail.includes(CHANGED_ACCOUNT));
  const legitimate = store.createWorkflow({ scenario: "legitimate" });
  assert.equal(store.readDocuments(legitimate.workflowId).supplierRequest.beneficiaryAccount, ORIGINAL_ACCOUNT);
  assert.equal(store.createWorkflow({ scenario: "unknown" }).reasonCode, "INVALID_SCENARIO");

  state.currentApproval.amountMinor = 1;
  documents.currentApproval.beneficiaryAccount = CHANGED_ACCOUNT;
  assert.equal(store.state(state.workflowId).currentApproval.amountMinor, 25000000);
  assert.equal(store.state(state.workflowId).currentApproval.beneficiaryAccount, ORIGINAL_ACCOUNT);
});

test("the exact approval commits once and cannot be replayed or refreshed after commit", (t) => {
  const { store, state } = fixture(t);
  const result = store.executePayment(state.workflowId, intent(state));
  assert.equal(result.status, "committed");
  assert.equal(result.reasonCode, "PAYMENT_COMMITTED");
  assert.deepEqual(valuesOf(result.payment), tuple(state));
  assert.equal(result.payment.approvalId, state.currentApproval.id);
  assert.equal(store.state(state.workflowId).currentApproval.used, true);
  assert.equal(store.executePayment(state.workflowId, intent(state)).reasonCode, "OPERATION_ALREADY_COMMITTED");
  assert.equal(store.requestApproval(state.workflowId, tuple(state)).reasonCode, "OPERATION_ALREADY_COMMITTED");
  assert.equal(store.state(state.workflowId).ledger.length, 1);
});

test("changed account, amount, currency, supplier and operation cannot use the original approval", (t) => {
  const { store, state } = fixture(t);
  for (const [changes, code] of [
    [{ beneficiaryAccount: CHANGED_ACCOUNT }, "ACCOUNT_MISMATCH"],
    [{ amountMinor: 25000001 }, "AMOUNT_MISMATCH"],
    [{ currency: "USD" }, "CURRENCY_MISMATCH"],
    [{ supplierId: "another-supplier" }, "SUPPLIER_MISMATCH"],
    [{ operationId: "op_another" }, "OPERATION_MISMATCH"],
    [{ approvalId: "apr_missing" }, "APPROVAL_NOT_FOUND"],
  ]) {
    const result = store.executePayment(state.workflowId, intent(state, changes));
    assert.equal(result.status, "blocked");
    assert.equal(result.reasonCode, code);
    assert.equal(result.payment, null);
  }
  const after = store.state(state.workflowId);
  assert.equal(after.currentApproval.used, false);
  assert.equal(after.ledger.length, 0);
  assert.equal(after.events.filter((event) => event.type === "payment_blocked").length, 6);
});

test("intent and review schemas reject missing fields, extra fields and invalid minor units", (t) => {
  const { store, state } = fixture(t);
  const missing = intent(state);
  delete missing.approvalId;
  const malformed = [missing, null, [], { ...intent(state), extra: "ignored" }];
  for (const amountMinor of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "25000000"]) {
    malformed.push(intent(state, { amountMinor }));
    assert.equal(store.requestApproval(state.workflowId, tuple(state, { amountMinor })).reasonCode, "INVALID_TUPLE");
  }
  for (const value of malformed) {
    assert.equal(store.executePayment(state.workflowId, value).reasonCode, "INVALID_INTENT");
  }
  assert.equal(store.requestApproval(state.workflowId, { ...tuple(state), approvalId: state.currentApproval.id }).reasonCode, "INVALID_TUPLE");
  assert.equal(store.requestApproval(state.workflowId, tuple(state, { supplierId: "another-supplier" })).reasonCode, "SUPPLIER_MISMATCH");
  assert.equal(store.requestApproval(state.workflowId, tuple(state, { operationId: "op_another" })).reasonCode, "OPERATION_MISMATCH");
  assert.equal(store.state(state.workflowId).ledger.length, 0);
  assert.equal(store.state(state.workflowId).currentApproval.used, false);
});

test("workflow scope rejects another workflow's operation and approval", (t) => {
  const { store, state } = fixture(t);
  const other = store.createWorkflow({ scenario: "legitimate" });
  assert.equal(store.executePayment(state.workflowId, intent(other)).reasonCode, "OPERATION_MISMATCH");
  assert.equal(store.executePayment(state.workflowId, intent(state, { approvalId: other.currentApproval.id })).reasonCode, "APPROVAL_NOT_FOUND");
  assert.equal(store.requestApproval(state.workflowId, tuple(other)).reasonCode, "OPERATION_MISMATCH");
  assert.equal(store.state(state.workflowId).ledger.length, 0);
  assert.equal(store.state(other.workflowId).ledger.length, 0);
});

test("expiry uses the advancing clock, including its exact boundary", (t) => {
  let now = NOW;
  const { store, state } = fixture(t, { now: () => now });
  now = Date.parse(state.currentApproval.expiresAt);
  assert.equal(store.executePayment(state.workflowId, intent(state)).reasonCode, "APPROVAL_EXPIRED");
  assert.equal(store.state(state.workflowId).currentApproval.used, false);
  assert.equal(store.state(state.workflowId).ledger.length, 0);
});

test("requesting authority withdraws the old approval and stores a copied exact tuple without autoapproval", (t) => {
  const { store, state } = fixture(t);
  const reviewed = tuple(state, { beneficiaryAccount: CHANGED_ACCOUNT });
  const result = store.requestApproval(state.workflowId, reviewed);
  assert.equal(result.status, "awaiting_human");
  assert.equal(result.currentApproval, null);
  const expectedDigest = createHash("sha256").update(JSON.stringify(reviewed)).digest("hex");
  assert.equal(result.pendingReview.digest, expectedDigest);
  assert.equal(result.pendingReview.digest.length, 64);
  assert.equal(result.pendingReview.expectedRevision, result.revision);
  reviewed.amountMinor = 1;
  result.pendingReview.tuple.currency = "USD";
  const pending = store.state(state.workflowId);
  assert.equal(pending.currentApproval, null);
  assert.deepEqual(pending.pendingReview.tuple, tuple(state, { beneficiaryAccount: CHANGED_ACCOUNT }));
  assert.equal(store.executePayment(state.workflowId, intent(state)).reasonCode, "APPROVAL_SUPERSEDED");
  assert.equal(store.state(state.workflowId).ledger.length, 0);
  assert.equal(store.state(state.workflowId).events.filter((event) => event.type === "operator_approved").length, 0);
});

test("stale review identifiers, digests and revisions are rejected without any effects for both operator methods", (t) => {
  const { store, state } = fixture(t);
  const first = store.requestApproval(state.workflowId, tuple(state, { beneficiaryAccount: CHANGED_ACCOUNT }));
  const latest = store.requestApproval(state.workflowId, tuple(state, { amountMinor: 25000001 }));
  for (const method of ["approve", "decline"]) {
    for (const value of [
      decision(first.pendingReview),
      decision(latest.pendingReview, { reviewId: "rev_stale" }),
      decision(latest.pendingReview, { digest: "0".repeat(64) }),
      decision(latest.pendingReview, { expectedRevision: latest.revision - 1 }),
      { ...decision(latest.pendingReview), tuple: tuple(state) },
    ]) {
      const before = store.state(state.workflowId);
      assert.equal(store[method](state.workflowId, value).reasonCode, "STALE_REVIEW");
      assert.deepEqual(store.state(state.workflowId), before);
    }
  }
});

test("reapproval authorises only the last exact reviewed account, amount and currency", (t) => {
  const { store, state } = fixture(t);
  const reviewed = tuple(state, { beneficiaryAccount: CHANGED_ACCOUNT, amountMinor: 25000001, currency: "USD" });
  const request = store.requestApproval(state.workflowId, reviewed);
  const approved = store.approve(state.workflowId, decision(request.pendingReview));
  assert.equal(approved.status, "approved");
  assert.equal(approved.currentApproval.source, "operator_review");
  assert.notEqual(approved.currentApproval.id, state.currentApproval.id);
  assert.deepEqual(valuesOf(approved.currentApproval), reviewed);
  assert.equal(store.state(state.workflowId).pendingReview, null);
  assert.equal(store.executePayment(state.workflowId, intent(state)).reasonCode, "APPROVAL_SUPERSEDED");
  assert.equal(store.executePayment(state.workflowId, { approvalId: approved.currentApproval.id, ...tuple(state) }).reasonCode, "ACCOUNT_MISMATCH");
  const result = store.executePayment(state.workflowId, { approvalId: approved.currentApproval.id, ...reviewed });
  assert.equal(result.status, "committed");
  assert.deepEqual(valuesOf(result.payment), reviewed);
  assert.equal(store.state(state.workflowId).ledger.length, 1);
  const before = store.state(state.workflowId);
  assert.equal(store.approve(state.workflowId, decision(request.pendingReview)).reasonCode, "STALE_REVIEW");
  assert.deepEqual(store.state(state.workflowId), before);
});

test("an exact operator decline leaves no approval or simulated payment", (t) => {
  const { store, state } = fixture(t);
  const request = store.requestApproval(state.workflowId, tuple(state, { beneficiaryAccount: CHANGED_ACCOUNT }));
  const result = store.decline(state.workflowId, decision(request.pendingReview));
  assert.equal(result.status, "declined");
  assert.equal(result.currentApproval, null);
  assert.equal(result.pendingReview, null);
  assert.equal(store.executePayment(state.workflowId, intent(state)).reasonCode, "APPROVAL_SUPERSEDED");
  assert.equal(store.state(state.workflowId).ledger.length, 0);
});

test("pending reviews, operator approvals, consumption and ledger survive closing and reopening", (t) => {
  const filename = temporaryDatabase(t);
  const first = new WorkflowStore({ filename, now: () => NOW });
  const state = first.createWorkflow({ scenario: "conflict" });
  const request = first.requestApproval(state.workflowId, tuple(state, { beneficiaryAccount: CHANGED_ACCOUNT }));
  const pending = first.state(state.workflowId);
  first.close();
  const second = new WorkflowStore({ filename, now: () => NOW });
  assert.deepEqual(second.state(state.workflowId), pending);
  const approved = second.approve(state.workflowId, decision(request.pendingReview));
  const committed = second.executePayment(state.workflowId, { approvalId: approved.currentApproval.id, ...request.pendingReview.tuple });
  assert.equal(committed.status, "committed");
  const saved = second.state(state.workflowId);
  second.close();
  const third = new WorkflowStore({ filename, now: () => NOW });
  t.after(() => third.close());
  assert.deepEqual(third.state(state.workflowId), saved);
  assert.equal(third.executePayment(state.workflowId, { approvalId: approved.currentApproval.id, ...request.pendingReview.tuple }).reasonCode, "OPERATION_ALREADY_COMMITTED");
  assert.equal(third.state(state.workflowId).ledger.length, 1);
});

test("independent SQLite connections see the same single committed operation", (t) => {
  const filename = temporaryDatabase(t);
  const { store: first, state } = fixture(t, { filename });
  const second = new WorkflowStore({ filename, now: () => NOW });
  t.after(() => second.close());
  assert.equal(first.executePayment(state.workflowId, intent(state)).status, "committed");
  assert.equal(second.executePayment(state.workflowId, intent(state)).reasonCode, "OPERATION_ALREADY_COMMITTED");
  assert.equal(second.state(state.workflowId).ledger.length, 1);
});

test("concurrent worker threads and independent connections commit one replay at most", async (t) => {
  const filename = temporaryDatabase(t);
  const { store, state } = fixture(t, { filename });
  const results = await concurrentWorkers(t, filename, state);
  assert.equal(results.filter((result) => result.status === "committed").length, 1);
  assert.equal(results.filter((result) => result.reasonCode === "OPERATION_ALREADY_COMMITTED").length, 1);
  assert.equal(store.state(state.workflowId).ledger.length, 1);
});

test("concurrent fresh operator approvals cannot pay one operation twice", async (t) => {
  const filename = temporaryDatabase(t);
  const { store, state } = fixture(t, { filename });
  const results = await concurrentWorkers(t, filename, state, "review-and-execute");
  assert.equal(results.filter((result) => result.status === "committed").length, 1);
  assert.equal(results.filter((result) => result.status === "unavailable").length, 0);
  assert.equal(store.state(state.workflowId).ledger.length, 1);
  assert.equal(store.requestApproval(state.workflowId, tuple(state)).reasonCode, "OPERATION_ALREADY_COMMITTED");
});

test("an injected failure before ledger insertion rolls back consumption and permits a safe retry", (t) => {
  let fail = true;
  const { store, state } = fixture(t, {
    beforeInsert: (payment) => {
      assert.equal(Object.isFrozen(payment), true);
      if (fail) throw new Error("Private test failure detail must not escape.");
    },
  });
  const before = store.state(state.workflowId);
  const result = store.executePayment(state.workflowId, intent(state));
  assert.equal(result.status, "unavailable");
  assert.equal(result.reasonCode, "STORE_UNAVAILABLE");
  assert.equal(result.payment, null);
  assert.ok(!JSON.stringify(result).includes("Private test failure"));
  assert.deepEqual(store.state(state.workflowId), before);
  fail = false;
  assert.equal(store.executePayment(state.workflowId, intent(state)).status, "committed");
  assert.equal(store.state(state.workflowId).ledger.length, 1);
});

test("unavailable clocks and closed or inaccessible databases fail closed without effects", (t) => {
  let fail = false;
  const { store, state } = fixture(t, { now: () => { if (fail) throw new Error("Private clock detail."); return NOW; } });
  const before = store.state(state.workflowId);
  fail = true;
  assert.equal(store.executePayment(state.workflowId, intent(state)).status, "unavailable");
  assert.equal(store.requestApproval(state.workflowId, tuple(state)).status, "unavailable");
  assert.deepEqual(store.state(state.workflowId), before);
  store.close();
  assert.equal(store.state(state.workflowId).status, "unavailable");
  assert.equal(store.executePayment(state.workflowId, intent(state)).status, "unavailable");
  const filename = temporaryDatabase(t);
  const inaccessible = new WorkflowStore({ filename: join(filename, "missing.sqlite") });
  t.after(() => inaccessible.close());
  assert.equal(inaccessible.createWorkflow({ scenario: "legitimate" }).status, "unavailable");
});

test("a database failure after approval consumption rolls the transaction back", (t) => {
  const filename = temporaryDatabase(t);
  const { store, state } = fixture(t, { filename });
  const inspection = new DatabaseSync(filename);
  t.after(() => inspection.close());
  inspection.exec("CREATE TRIGGER reject_test_ledger BEFORE INSERT ON ledger BEGIN SELECT RAISE(ABORT, 'test storage failure'); END;");
  const before = store.state(state.workflowId);
  assert.equal(store.executePayment(state.workflowId, intent(state)).status, "unavailable");
  assert.deepEqual(store.state(state.workflowId), before);
  inspection.exec("DROP TRIGGER reject_test_ledger");
  assert.equal(store.executePayment(state.workflowId, intent(state)).status, "committed");
  assert.equal(inspection.prepare("SELECT COUNT(*) AS count FROM ledger").get().count, 1);
});
