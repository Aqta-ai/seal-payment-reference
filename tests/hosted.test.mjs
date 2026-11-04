import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from '../server.mjs';
import { WorkflowStore } from '../src/workflow.mjs';
import { DemoOwnerStore } from '../src/demo-owners.mjs';
import { demoAccessFixture, hostedRequest, withResponseCookies } from './demo-access-fixture.mjs';
import { MODEL_BUDGET_EXHAUSTED } from '../src/model-budget.mjs';

const ORIGIN = 'https://pay.example.test';
const HOST = 'pay.example.test';

const agent = async ({ toolHandler, messages, beforeModelRequest }) => {
  if (!beforeModelRequest()) return { ...MODEL_BUDGET_EXHAUSTED, requestCount: 0, messages, trace: [] };
  const docs = await toolHandler('read_documents', {});
  if (messages) {
    const { id: approvalId, operationId, supplierId, beneficiaryAccount, amountMinor, currency } = docs.currentApproval;
    const result = await toolHandler('execute_payment', { approvalId, operationId, supplierId, beneficiaryAccount, amountMinor, currency });
    return { status: 'completed', requestCount: 1, messages, trace: [{ type: 'tool_result', name: 'execute_payment', result }] };
  }
  const result = await toolHandler('request_approval', docs.supplierRequest);
  return { status: 'awaiting_human', requestCount: 1, messages: [{ role: 'user', content: 'hosted test' }], trace: [{ type: 'tool_result', name: 'request_approval', result }] };
};

async function fixture(t, limits = {}) {
  const store = new WorkflowStore();
  const demoOwners = new DemoOwnerStore(), access = demoAccessFixture();
  const server = createServer({ store, agent, apiKey: 'test-only-provider-key', demoAccess: access.demoAccess, demoOwners, hosted: { origin: ORIGIN, limits: { perAddressPerMinute: 1000, ...limits } } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); demoOwners.close(); });
  const request = hostedRequest(server, { host: HOST, origin: ORIGIN });
  const visit = async (user = access.signIn()) => {
    const page = await request('GET', '/', { cookie: user.cookie });
    const set = page.headers['set-cookie'] || [];
    return { page, set, user, cookie: withResponseCookies(user.cookie, set) };
  };
  return { request, visit, access };
}

test('hosted mode rejects other hosts and origins and sets secure, host-only cookies', async t => {
  const { request, visit } = await fixture(t);
  assert.equal((await request('GET', '/', { host: `127.0.0.1` })).status, 403);
  const { page, set, cookie } = await visit();
  assert.equal(page.status, 200);
  assert.equal(set.length, 1);
  for (const item of set) { assert.match(item, /^__Host-/); assert.match(item, /; Secure/); assert.match(item, /HttpOnly/); assert.match(item, /SameSite=Strict/); assert.match(item, /Path=\//); }
  assert.equal(set.some(item => item.startsWith('__Host-seal_workspace=')), false);
  assert.match(page.headers['strict-transport-security'], /max-age=/);
  assert.equal((await request('POST', '/api/workflows', { body: { scenario: 'conflict' }, cookie, origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('POST', '/api/workflows', { body: { scenario: 'conflict' }, cookie, origin: 'http://pay.example.test' })).status, 403);
  assert.equal((await request('GET', '/api/workflows')).status, 401);
  assert.equal((await request('GET', '/api/config')).status, 401);
  assert.equal((await request('GET', '/api/config', { cookie })).status, 200);
});

test('each visitor sees, runs and approves only their own runs', async t => {
  const { request, visit } = await fixture(t);
  const alice = await visit(), bob = await visit();
  const created = (await request('POST', '/api/workflows', { body: { scenario: 'conflict' }, cookie: alice.cookie })).json();
  const id = created.workflowId;
  const paused = (await request('POST', `/api/workflows/${id}/run`, { body: {}, cookie: alice.cookie })).json();
  assert.equal(paused.pendingReview.status, 'awaiting_human');
  assert.equal((await request('GET', '/api/workflows', { cookie: alice.cookie })).json().workflows.length, 1);
  assert.equal((await request('GET', '/api/workflows', { cookie: bob.cookie })).json().workflows.length, 0);
  assert.equal((await request('GET', `/api/workflows/${id}`, { cookie: bob.cookie })).status, 404);
  assert.equal((await request('POST', `/api/workflows/${id}/run`, { body: {}, cookie: bob.cookie })).status, 404);
  const review = paused.pendingReview;
  const decision = { reviewId: review.reviewId, digest: review.digest, expectedRevision: review.expectedRevision, confirm: true };
  assert.equal((await request('POST', `/api/workflows/${id}/approve`, { body: decision, cookie: bob.cookie, headers: { 'X-Operator-Action': 'review' } })).status, 404);
  const forged = `${bob.user.cookie}; ${alice.cookie.split('; ').find(c => c.startsWith('__Host-seal_review'))}; __Host-seal_workspace=${'a'.repeat(64)}`;
  assert.equal((await request('POST', `/api/workflows/${id}/approve`, { body: decision, cookie: forged, headers: { 'X-Operator-Action': 'review' } })).status, 404, 'a legacy workspace cookie cannot transfer Google ownership');
  assert.equal((await request('POST', `/api/workflows/${id}/approve`, { body: decision, cookie: alice.cookie, headers: { 'X-Operator-Action': 'review' } })).status, 200, 'owner approves');
  assert.equal((await request('POST', `/api/workflows/${id}/run`, { body: {}, cookie: forged })).status, 404, 'Bob cannot continue Alice workflow with a legacy cookie');
  assert.equal((await request('POST', `/api/workflows/${id}/run`, { body: {}, cookie: alice.cookie })).json().ledger.length, 1, 'the verified owner continues and pays once');
  assert.equal((await request('POST', `/api/workflows/${id}/run`, { body: {}, cookie: alice.cookie })).status, 409);
  assert.equal((await request('GET', `/api/workflows/${id}`, { cookie: alice.cookie })).json().ledger.length, 1);
  const madeUp = `__Host-seal_workspace=${'a'.repeat(64)}`;
  assert.equal((await request('GET', '/api/workflows', { cookie: madeUp })).status, 401);
});

test('model operations stay capped per workspace and address, and actual requests share the global cap', async t => {
  const { request, visit } = await fixture(t, { perWorkspaceDay: 2, perAddressDay: 3, globalDay: 4, workflowsPerWorkspace: 3 });
  const one = await visit();
  const runOnce = async cookie => {
    const created = await request('POST', '/api/workflows', { body: { scenario: 'conflict' }, cookie });
    if (created.status !== 201) return created.status;
    return (await request('POST', `/api/workflows/${created.json().workflowId}/run`, { body: {}, cookie })).status;
  };
  assert.deepEqual([await runOnce(one.cookie), await runOnce(one.cookie), await runOnce(one.cookie)], [200, 200, 429]);
  assert.equal(await runOnce(one.cookie), 429, 'run limit per workspace');
  const two = await visit();
  assert.equal(await runOnce(two.cookie), 200);
  assert.equal(await runOnce(two.cookie), 429, 'per-address cap reached (3 from one address)');
  const three = await visit();
  const runFromNewAddress = async (cookie, address) => {
    const headers = { 'X-Forwarded-For': address };
    const created = await request('POST', '/api/workflows', { body: { scenario: 'conflict' }, cookie, headers });
    if (created.status !== 201) return created.status;
    return (await request('POST', `/api/workflows/${created.json().workflowId}/run`, { body: {}, cookie, headers })).status;
  };
  assert.equal(await runFromNewAddress(three.cookie, '192.0.2.3'), 200);
  const four = await visit();
  assert.equal(await runFromNewAddress(four.cookie, '192.0.2.4'), 429, 'global model allowance reached across addresses');
});

test('refresh and a new verified session for the same owner do not reset the model allowance', async t => {
  const { request, visit, access } = await fixture(t, { perWorkspaceDay: 1, perAddressDay: 100, globalDay: 100 });
  const first = await visit();
  const runOnce = async cookie => {
    const created = await request('POST', '/api/workflows', { body: { scenario: 'conflict' }, cookie });
    assert.equal(created.status, 201);
    return (await request('POST', `/api/workflows/${created.json().workflowId}/run`, { body: {}, cookie })).status;
  };
  assert.equal(await runOnce(first.cookie), 200);
  const refreshed = await request('GET', '/', { cookie: first.cookie });
  assert.equal(refreshed.headers['set-cookie'], undefined);
  assert.equal(await runOnce(first.cookie), 429);
  access.revoke(first.user);
  assert.equal((await request('GET', '/api/workflows', { cookie: first.cookie })).status, 401);
  const signedInAgain = await visit(access.signIn(first.user));
  assert.equal(signedInAgain.user.owner_id, first.user.owner_id);
  assert.equal(await runOnce(signedInAgain.cookie), 429, 'new Google session retains the owner budget');
});
