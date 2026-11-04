import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DemoOwnerStore } from '../src/demo-owners.mjs';
import { WorkflowStore } from '../src/workflow.mjs';

const ALICE = 'a'.repeat(32);
const BOB = 'b'.repeat(32);

function memoryStore(t) {
  const store = new DemoOwnerStore();
  t.after(() => store.close());
  return store;
}

function filename(t) {
  const directory = mkdtempSync(join(tmpdir(), 'demo-owners-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'workflow.sqlite');
}

test('assigns explicit owners and counts each owner separately', t => {
  const store = memoryStore(t);
  assert.equal(store.ownerOf('unclaimed'), null);
  assert.equal(store.count(ALICE), 0);
  store.assign('workflow_one', ALICE);
  store.assign('workflow_two', ALICE);
  store.assign('workflow_three', BOB);
  assert.equal(store.ownerOf('workflow_one'), ALICE);
  assert.equal(store.ownerOf('workflow_three'), BOB);
  assert.equal(store.count(ALICE), 2);
  assert.equal(store.count(BOB), 1);
});

test('same-owner assignment is idempotent and cannot transfer ownership', t => {
  const store = memoryStore(t);
  store.assign('workflow_one', ALICE);
  store.assign('workflow_one', ALICE);
  assert.equal(store.count(ALICE), 1);
  assert.throws(() => store.assign('workflow_one', BOB), /already belongs to another demo owner/);
  assert.equal(store.ownerOf('workflow_one'), ALICE);
  assert.equal(store.count(ALICE), 1);
  assert.equal(store.count(BOB), 0);
});

test('rejects invalid workflow identifiers without changing valid rows', t => {
  const store = memoryStore(t);
  store.assign('valid-workflow_123', ALICE);
  for (const id of ['', 'x'.repeat(129), 'with space', 'é', "x'; DROP TABLE demo_workflow_owners; --", 'x\n', null, 5, {}]) {
    assert.throws(() => store.assign(id, ALICE), TypeError);
    assert.throws(() => store.ownerOf(id), TypeError);
  }
  assert.equal(store.ownerOf('valid-workflow_123'), ALICE);
  assert.equal(store.count(ALICE), 1);
});

test('rejects invalid owner identifiers without changing valid rows', t => {
  const store = memoryStore(t);
  store.assign('workflow_one', ALICE);
  for (const owner of ['', 'a'.repeat(31), 'a'.repeat(33), 'A'.repeat(32), 'g'.repeat(32), "'; DROP TABLE demo_workflow_owners;", null, 5, {}]) {
    assert.throws(() => store.assign('workflow_two', owner), TypeError);
    assert.throws(() => store.count(owner), TypeError);
    assert.throws(() => store.workflowIds(owner), TypeError);
  }
  assert.equal(store.ownerOf('workflow_two'), null);
  assert.equal(store.count(ALICE), 1);
});

test('ownership survives closing and reopening the database', t => {
  const path = filename(t);
  const first = new DemoOwnerStore({ filename: path });
  first.assign('workflow_one', ALICE);
  first.assign('workflow_two', BOB);
  first.close();
  const second = new DemoOwnerStore({ filename: path });
  t.after(() => second.close());
  assert.equal(second.ownerOf('workflow_one'), ALICE);
  assert.equal(second.ownerOf('workflow_two'), BOB);
  assert.equal(second.count(ALICE), 1);
  assert.equal(second.count(BOB), 1);
  assert.deepEqual(second.workflowIds(ALICE), ['workflow_one']);
  assert.deepEqual(second.workflowIds(BOB), ['workflow_two']);
});

test('separate connections cannot replace an existing owner', t => {
  const path = filename(t);
  const first = new DemoOwnerStore({ filename: path });
  const second = new DemoOwnerStore({ filename: path });
  t.after(() => { first.close(); second.close(); });
  first.assign('workflow_one', ALICE);
  assert.throws(() => second.assign('workflow_one', BOB), /already belongs to another demo owner/);
  second.assign('workflow_one', ALICE);
  assert.equal(first.ownerOf('workflow_one'), ALICE);
  assert.equal(second.count(ALICE), 1);
});

test('coexists with WorkflowStore and leaves legacy workflows unclaimed', t => {
  const path = filename(t);
  const workflows = new WorkflowStore({ filename: path });
  const legacy = workflows.createWorkflow({ scenario: 'conflict' });
  const owners = new DemoOwnerStore({ filename: path });
  t.after(() => { owners.close(); workflows.close(); });
  assert.ok(legacy.workflowId);
  assert.equal(owners.ownerOf(legacy.workflowId), null);
  const current = workflows.createWorkflow({ scenario: 'legitimate' });
  owners.assign(current.workflowId, ALICE);
  assert.equal(owners.ownerOf(current.workflowId), ALICE);
  assert.equal(owners.ownerOf(legacy.workflowId), null);
  assert.equal(workflows.state(current.workflowId).workflowId, current.workflowId);
  assert.equal(workflows.state(legacy.workflowId).workflowId, legacy.workflowId);
});

test('closed stores fail instead of returning an empty or memory-backed result', t => {
  const store = memoryStore(t);
  store.assign('workflow_one', ALICE);
  store.close();
  assert.throws(() => store.ownerOf('workflow_one'), /ownership store is closed/);
  assert.throws(() => store.count(ALICE), /ownership store is closed/);
  assert.throws(() => store.workflowIds(ALICE), /ownership store is closed/);
  assert.throws(() => store.assign('workflow_two', ALICE), /ownership store is closed/);
  assert.doesNotThrow(() => store.close());
});

test('an unavailable database path fails without a memory fallback', t => {
  const path = join(filename(t), 'missing', 'owners.sqlite');
  assert.throws(() => new DemoOwnerStore({ filename: path }));
});

test('lists only the requested owner newest first with the requested limit', t => {
  const store = memoryStore(t);
  assert.deepEqual(store.workflowIds(ALICE), []);
  store.assign('alice_first', ALICE);
  store.assign('bob_first', BOB);
  store.assign('alice_second', ALICE);
  store.assign('bob_second', BOB);
  store.assign('alice_third', ALICE);
  store.assign('alice_first', ALICE);
  assert.deepEqual(store.workflowIds(ALICE), ['alice_third', 'alice_second', 'alice_first']);
  assert.deepEqual(store.workflowIds(ALICE, 2), ['alice_third', 'alice_second']);
  assert.deepEqual(store.workflowIds(BOB, 1), ['bob_second']);
});

test('more than 500 other mappings cannot hide an owner workflow', t => {
  const store = memoryStore(t);
  store.assign('alice_first', ALICE);
  for (let index = 0; index < 501; index += 1) store.assign(`bob_${index}`, BOB);
  assert.deepEqual(store.workflowIds(ALICE), ['alice_first']);
  assert.equal(store.workflowIds(BOB).length, 100);
  assert.equal(store.workflowIds(BOB)[0], 'bob_500');
  assert.equal(store.workflowIds(BOB)[99], 'bob_401');
});

test('rejects invalid list limits', t => {
  const store = memoryStore(t);
  store.assign('workflow_one', ALICE);
  for (const limit of [0, -1, 101, 1.5, NaN, Infinity, '1', null, {}, []]) {
    assert.throws(() => store.workflowIds(ALICE, limit), TypeError);
  }
  assert.deepEqual(store.workflowIds(ALICE, 100), ['workflow_one']);
});
