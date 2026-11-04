import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.mjs';
import { WorkflowStore } from '../src/workflow.mjs';

async function fixture(t, agent = async () => { throw new Error('Unexpected agent call'); }, options = {}) {
  const store = new WorkflowStore();
  const server = createServer({ ...options, store, agent, apiKey: 'test-only-provider-key' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { store, origin, post };
}

test('local server does not serve credentials or implementation files', async t => {
  const { origin, post } = await fixture(t);
  for (const path of ['/.env', '/.env.example', '/src/meta-agent.mjs', '/.data/sandbox.sqlite']) assert.equal((await fetch(origin + path)).status, 404);
  assert.equal((await post('/api/workflows', { scenario: 'conflict' }, { Origin: 'https://example.invalid' })).status, 403);
});

test('alternate UI serves only named assets and keeps the shared application script', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'payment-ui-'));
  const uiRoot = join(directory, 'private-ui');
  mkdirSync(uiRoot);
  writeFileSync(join(uiRoot, 'index.html'), '<!doctype html><title>Private preview fixture</title>');
  writeFileSync(join(uiRoot, 'styles.css'), 'body { color: navy; }');
  writeFileSync(join(uiRoot, 'app.js'), 'This must not replace the shared application.');
  writeFileSync(join(uiRoot, 'mascot.png'), Buffer.from([137, 80, 78, 71]));
  writeFileSync(join(uiRoot, 'font-body.woff2'), 'font fixture');
  writeFileSync(join(uiRoot, 'font-pen.woff2'), 'pen font fixture');
  writeFileSync(join(uiRoot, 'brand-mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(uiRoot, 'brand-mark.png'), Buffer.from([137, 80, 78, 71, 1]));
  writeFileSync(join(uiRoot, '.env'), 'private fixture value');
  writeFileSync(join(uiRoot, 'notes.txt'), 'unlisted fixture');
  writeFileSync(join(uiRoot, 'private-guide.md'), 'private documentation fixture');
  writeFileSync(join(directory, 'sibling.txt'), 'sibling fixture');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { origin, post } = await fixture(t, undefined, { uiRoot });
  const index = await fetch(origin + '/');
  assert.equal(index.status, 200);
  assert.equal(await index.text(), '<!doctype html><title>Private preview fixture</title>');
  assert.match(index.headers.get('set-cookie'), /^sandbox_operator_[0-9]+=/);
  assert.equal(await (await fetch(origin + '/styles.css')).text(), 'body { color: navy; }');
  assert.equal(await (await fetch(origin + '/app.js?uiRoot=ignored')).text(), readFileSync(new URL('../app.js', import.meta.url), 'utf8'));
  for (const [path, type] of [['/mascot.png', 'image/png'], ['/font-body.woff2', 'font/woff2'], ['/font-pen.woff2', 'font/woff2'], ['/brand-mark.svg', 'image/svg+xml'], ['/brand-mark.png', 'image/png']]) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), type);
  }
  assert.deepEqual(Buffer.from(await (await fetch(origin + '/brand-mark.png')).arrayBuffer()), Buffer.from([137, 80, 78, 71, 1]));
  for (const path of ['/.env', '/notes.txt', '/private-guide.md', '/sibling.txt', '/../sibling.txt', '/..%2fsibling.txt', '/src/meta-agent.mjs', '/.data/sandbox.sqlite', '/private-ui/index.html']) {
    assert.equal((await fetch(origin + path)).status, 404, path);
  }
  assert.equal((await post('/api/workflows', { scenario: 'conflict' }, { Origin: 'https://example.invalid' })).status, 403);
});

test('alternate UI optional assets stay unavailable when absent', async t => {
  const uiRoot = mkdtempSync(join(tmpdir(), 'payment-empty-ui-'));
  writeFileSync(join(uiRoot, 'index.html'), '<!doctype html><title>Minimal fixture</title>');
  writeFileSync(join(uiRoot, 'styles.css'), 'body {}');
  mkdirSync(join(uiRoot, 'mascot.png'));
  mkdirSync(join(uiRoot, 'brand-mark.png'));
  t.after(() => rmSync(uiRoot, { recursive: true, force: true }));
  const { origin } = await fixture(t, undefined, { uiRoot });
  for (const path of ['/mascot.png', '/font-body.woff2', '/font-pen.woff2', '/brand-mark.svg', '/brand-mark.png']) {
    assert.equal((await fetch(origin + path)).status, 404, path);
  }
});

test('legal routes serve only the named repository documents, never private UI replacements', async t => {
  const uiRoot = mkdtempSync(join(tmpdir(), 'payment-legal-ui-'));
  writeFileSync(join(uiRoot, 'index.html'), '<!doctype html><title>Legal route fixture</title>');
  writeFileSync(join(uiRoot, 'styles.css'), 'body {}');
  for (const name of ['LICENSE', 'NOTICE', 'ASSETS.md']) writeFileSync(join(uiRoot, name), `Private ${name} fixture`);
  writeFileSync(join(uiRoot, 'private-licence.md'), 'private fixture');
  t.after(() => rmSync(uiRoot, { recursive: true, force: true }));
  const { origin } = await fixture(t, undefined, { uiRoot });
  for (const [name, type] of [['LICENSE', 'text/plain'], ['NOTICE', 'text/plain'], ['ASSETS.md', 'text/markdown']]) {
    const response = await fetch(`${origin}/${name}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), `${type}; charset=utf-8`);
    assert.equal(await response.text(), readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
  }
  for (const path of ['/private-licence.md', '/private-ui/LICENSE', '/..%2fprivate-licence.md', '/LICENSE%2f..%2fprivate-licence.md']) {
    assert.equal((await fetch(origin + path)).status, 404, path);
  }
});

test('provider configuration exposes fixed identity without exposing a credential', async t => {
  const store = new WorkflowStore();
  const server = createServer({ store, provider: 'baseten', apiKey: 'test-only-hidden-key' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/config`);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), { metaConfigured: true, provider: 'baseten', model: 'meta-models/muse-spark-open-1026', modelLabel: 'Muse Spark Open', simulation: true });
  assert.equal(body.includes('test-only-hidden-key'), false);
});

test('unknown server provider fails before creating an agent request', () => {
  const store = new WorkflowStore();
  try { assert.throws(() => createServer({ store, provider: 'unsupported' }), /Choose the meta, wonder or baseten provider/); }
  finally { store.close(); }
});

test('operator cookies are isolated by server port when both previews share a hostname', async t => {
  const first = await fixture(t);
  const second = await fixture(t);
  const firstSetCookie = (await fetch(first.origin + '/')).headers.get('set-cookie');
  const secondSetCookie = (await fetch(second.origin + '/')).headers.get('set-cookie');
  const firstCookie = firstSetCookie.split(';')[0];
  const secondCookie = secondSetCookie.split(';')[0];
  const firstName = `sandbox_operator_${new URL(first.origin).port}`;
  const secondName = `sandbox_operator_${new URL(second.origin).port}`;
  assert.equal(firstCookie.split('=')[0], firstName);
  assert.equal(secondCookie.split('=')[0], secondName);
  assert.notEqual(firstName, secondName);
  for (const value of [firstSetCookie, secondSetCookie]) {
    assert.match(value, /; HttpOnly; SameSite=Strict; Path=\/$/);
  }
  const pending = server => {
    const created = server.store.createWorkflow({ scenario: 'conflict' });
    const tuple = server.store.readDocuments(created.workflowId).supplierRequest;
    const requested = server.store.requestApproval(created.workflowId, tuple);
    const review = requested.pendingReview;
    return {
      path: `/api/workflows/${created.workflowId}/approve`,
      body: { reviewId: review.reviewId, digest: review.digest, expectedRevision: review.expectedRevision, confirm: true },
    };
  };
  const firstReview = pending(first);
  const secondReview = pending(second);
  const operatorHeaders = cookie => ({ Cookie: cookie, 'X-Operator-Action': 'review' });
  assert.equal((await first.post(firstReview.path, firstReview.body, operatorHeaders(secondCookie))).status, 403);
  assert.equal((await second.post(secondReview.path, secondReview.body, operatorHeaders(firstCookie))).status, 403);
  const combinedCookies = `${secondCookie}; ${firstCookie}`;
  assert.equal((await first.post(firstReview.path, firstReview.body, operatorHeaders(combinedCookies))).status, 200);
  assert.equal((await second.post(secondReview.path, secondReview.body, operatorHeaders(combinedCookies))).status, 200);
});

test('operator review is separate from model dispatch and bound to the reviewed tuple', async t => {
  const mockedAgent = async ({ toolHandler, messages }) => {
    const docs = await toolHandler('read_documents', {});
    const approval = docs.currentApproval;
    if (messages) {
      const result = await toolHandler('execute_payment', { approvalId: approval.id, operationId: docs.operationId, supplierId: approval.supplierId,
        beneficiaryAccount: approval.beneficiaryAccount, amountMinor: approval.amountMinor, currency: approval.currency });
      return { status: result.status === 'committed' ? 'completed' : 'error', requestCount: 0, messages: [], trace: [{ type: 'tool_result', name: 'execute_payment', result }] };
    }
    const result = await toolHandler('request_approval', { operationId: docs.operationId, supplierId: 'harbour-print', beneficiaryAccount: 'DE00-TEST-0000-1289', amountMinor: 25000000, currency: 'EUR' });
    return { status: 'awaiting_human', requestCount: 0, messages: [{ role: 'user', content: 'Mocked unit-test history' }], trace: [{ type: 'tool_result', name: 'request_approval', result }] };
  };
  const { origin, post } = await fixture(t, mockedAgent);
  const cookie = (await fetch(origin + '/')).headers.get('set-cookie').split(';')[0];
  const created = await (await post('/api/workflows', { scenario: 'conflict' })).json();
  const path = `/api/workflows/${created.workflowId}`;
  const paused = await (await post(path + '/run', {})).json();
  assert.equal(paused.ledger.length, 0);
  assert.equal(paused.pendingReview.status, 'awaiting_human');
  const review = paused.pendingReview;
  const body = { reviewId: review.reviewId, digest: review.digest, expectedRevision: review.expectedRevision, confirm: true };
  assert.equal((await post(path + '/approve', body)).status, 403);
  const headers = { Cookie: cookie, 'X-Operator-Action': 'review' };
  assert.equal((await post(path + '/approve', { ...body, digest: 'wrong' }, headers)).status, 409);
  assert.equal((await post(path + '/approve', body, headers)).status, 200);
  const completed = await (await post(path + '/run', {})).json();
  assert.equal(completed.ledger.length, 1);
  assert.equal(completed.ledger[0].beneficiaryAccount, 'DE00-TEST-0000-1289');
  assert.equal((await post(path + '/run', {})).status, 409);
});

test('retained observations survive a server restart and new agent runs append to them', async t => {
  const store = new WorkflowStore();
  const mockedAgent = async ({ toolHandler, messages }) => {
    const docs = await toolHandler('read_documents', {});
    if (!messages) {
      const result = await toolHandler('request_approval', docs.supplierRequest);
      return { status: 'awaiting_human', requestCount: 0, messages: [{ role: 'user', content: 'Unit-test retained conversation' }], trace: [{ type: 'tool_result', name: 'request_approval', result }] };
    }
    assert.equal(messages[0].content, 'Unit-test retained conversation');
    const { id: approvalId, operationId, supplierId, beneficiaryAccount, amountMinor, currency } = docs.currentApproval;
    const result = await toolHandler('execute_payment', { approvalId, operationId, supplierId, beneficiaryAccount, amountMinor, currency });
    return { status: result.status === 'committed' ? 'completed' : 'error', requestCount: 0, messages, trace: [{ type: 'tool_result', name: 'execute_payment', result }] };
  };
  let server = createServer({ store, agent: mockedAgent, apiKey: 'test-only-provider-key' });
  const listen = async () => {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    return {
      origin,
      post: (path, body, headers = {}) => fetch(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }),
    };
  };
  const close = async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
  t.after(async () => { await close(); store.close(); });
  let connection = await listen();
  const cookie = (await fetch(connection.origin + '/')).headers.get('set-cookie').split(';')[0];
  const created = await (await connection.post('/api/workflows', { scenario: 'conflict' })).json();
  const path = `/api/workflows/${created.workflowId}`;
  const paused = await (await connection.post(path + '/run', {})).json();
  const { reviewId, digest, expectedRevision } = paused.pendingReview;
  assert.equal((await connection.post(path + '/approve', { reviewId, digest, expectedRevision, confirm: true }, { Cookie: cookie, 'X-Operator-Action': 'review' })).status, 200);
  const before = await (await fetch(connection.origin + path + '/export')).json();
  assert.equal(before.agentRuns.length, 1);
  assert.equal(before.operatorEvents.length, 1);
  assert.equal(before.ledger.length, 0);
  await close();
  server = createServer({ store, agent: mockedAgent, apiKey: 'test-only-provider-key', savedRecords: JSON.parse(JSON.stringify([before])) });
  connection = await listen();
  const restored = await (await fetch(connection.origin + path + '/export')).json();
  assert.deepEqual(restored.agentRuns, before.agentRuns);
  assert.deepEqual(restored.operatorEvents, before.operatorEvents);
  assert.deepEqual(restored.currentApproval, before.currentApproval);
  assert.deepEqual(restored.ledger, before.ledger);
  const completed = await (await connection.post(path + '/run', {})).json();
  assert.equal(completed.ledger.length, 1);
  assert.equal(completed.agentRuns.length, 2);
  assert.deepEqual(completed.agentRuns[0], before.agentRuns[0]);
  assert.deepEqual(completed.operatorEvents, before.operatorEvents);
});

test('saved observations cannot replace workflow authority or ledger state', async t => {
  const store = new WorkflowStore();
  const created = store.createWorkflow({ scenario: 'conflict' });
  const before = store.state(created.workflowId);
  const saved = {
    workflowId: created.workflowId, provider: 'meta', model: 'muse-spark-1.3',
    agentRuns: [], operatorEvents: [{ action: 'approve', channel: 'fixture-annotation' }],
    currentApproval: { id: 'invented-approval', source: 'operator_review' },
    ledger: [{ id: 'invented-payment' }],
  };
  const server = createServer({ store, savedRecords: [saved] });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  saved.agentRuns.push({ status: 'invented-run' });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const restored = await (await fetch(`${origin}/api/workflows/${created.workflowId}/export`)).json();
  assert.deepEqual(restored.ledger, []);
  assert.deepEqual(restored.currentApproval, before.currentApproval);
  assert.deepEqual(restored.agentRuns, []);
  const requested = store.readDocuments(created.workflowId).supplierRequest;
  assert.equal(store.executePayment(created.workflowId, { approvalId: 'invented-approval', ...requested }).reasonCode, 'APPROVAL_NOT_FOUND');
  assert.equal(store.state(created.workflowId).ledger.length, 0);
  const response = await fetch(`${origin}/api/workflows/${created.workflowId}/import`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(saved) });
  assert.equal(response.status, 404);
});

test('saved observation archives reject malformed or mismatched records before serving', () => {
  const store = new WorkflowStore();
  try {
    const created = store.createWorkflow({ scenario: 'legitimate' });
    const valid = { workflowId: created.workflowId, provider: 'meta', model: 'muse-spark-1.3', agentRuns: [], operatorEvents: [] };
    for (const savedRecords of [null, {}, 'invalid', [null], [{ ...valid, workflowId: 'wf_unknown' }], [{ ...valid, provider: 'baseten' }], [{ ...valid, model: 'unknown-model' }], [{ ...valid, agentRuns: null }], [{ ...valid, operatorEvents: {} }], [valid, valid]]) {
      assert.throws(() => createServer({ store, savedRecords }), /Saved run records/);
    }
  } finally { store.close(); }
});

test('workspace list summarises runs read-only and never exposes approval secrets', async t => {
  const store = new WorkflowStore();
  const agent = async ({ toolHandler }) => {
    const docs = await toolHandler('read_documents', {});
    const result = await toolHandler('request_approval', docs.supplierRequest);
    return { status: 'awaiting_human', requestCount: 0, messages: [{ role: 'user', content: 'list test' }], trace: [{ type: 'tool_result', name: 'request_approval', result }] };
  };
  const server = createServer({ store, agent, apiKey: 'test-only-provider-key' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.deepEqual((await (await fetch(origin + '/api/workflows')).json()).workflows, []);
  const created = await (await post('/api/workflows', { scenario: 'conflict' })).json();
  await post(`/api/workflows/${created.workflowId}/run`, {});
  const listed = await (await fetch(origin + '/api/workflows')).json();
  assert.equal(listed.workflows.length, 1);
  const [item] = listed.workflows;
  assert.equal(item.workflowId, created.workflowId); assert.equal(item.status, 'needs_review');
  assert.equal(item.beneficiaryAccount, 'DE00-TEST-0000-1289'); assert.equal(item.amountMinor, 25000000); assert.deepEqual(item.ledger, []);
  assert.equal(JSON.stringify(listed).includes('test-only-provider-key'), false);
  assert.equal(JSON.stringify(listed).includes('digest'), false);
  assert.equal((await fetch(origin + '/api/workflows', { method: 'DELETE' })).status, 404);
});
