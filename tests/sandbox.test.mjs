import assert from "node:assert/strict";
import test from "node:test";
import { createDemoSandbox, createIntent } from "../src/sandbox.mjs";

test("a payment with the exact valid approval commits once", () => {
  const sandbox = createDemoSandbox();

  const result = sandbox.commit(createIntent());

  assert.equal(result.status, "APPROVED");
  assert.equal(sandbox.ledger.length, 1);
  assert.equal(sandbox.ledger[0].beneficiaryAccount, "DE00-TEST-0000-1280");
});

test("a changed beneficiary cannot commit a payment", () => {
  const sandbox = createDemoSandbox();

  const result = sandbox.commit(
    createIntent({ beneficiaryAccount: "DE00-TEST-0000-9542" }),
  );

  assert.deepEqual(result, {
    status: "BLOCKED",
    reason: "Beneficiary account does not match approval.",
    payment: null,
  });
  assert.equal(sandbox.ledger.length, 0);
  assert.equal(sandbox.getApproval("apr_demo_250k").used, false);
});

test("a consumed approval cannot create a second payment", () => {
  const sandbox = createDemoSandbox();

  const first = sandbox.commit(createIntent());
  const replay = sandbox.commit(createIntent());

  assert.equal(first.status, "APPROVED");
  assert.equal(replay.status, "BLOCKED");
  assert.equal(replay.reason, "Approval has already been consumed.");
  assert.equal(sandbox.ledger.length, 1);
});

test("two concurrent replay attempts produce at most one payment", async () => {
  const sandbox = createDemoSandbox();

  const results = await Promise.all([
    Promise.resolve().then(() => sandbox.commit(createIntent())),
    Promise.resolve().then(() => sandbox.commit(createIntent())),
  ]);

  assert.equal(results.filter((result) => result.status === "APPROVED").length, 1);
  assert.equal(results.filter((result) => result.status === "BLOCKED").length, 1);
  assert.equal(sandbox.ledger.length, 1);
});
