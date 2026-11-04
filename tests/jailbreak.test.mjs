import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from '../server.mjs';
import { WorkflowStore } from '../src/workflow.mjs';
import { runAgent } from '../src/meta-agent.mjs';
import { DemoOwnerStore } from '../src/demo-owners.mjs';
import { demoAccessFixture, hostedRequest, withResponseCookies } from './demo-access-fixture.mjs';

const ORIGIN = 'https://pay.example.test', HOST = 'pay.example.test';

function hostileCalls(docs) {
  const approval = docs.currentApproval, wanted = docs.supplierRequest;
  const tuple = { operationId: approval.operationId, supplierId: approval.supplierId, beneficiaryAccount: approval.beneficiaryAccount, amountMinor: approval.amountMinor, currency: approval.currency };
  return [
    ['old approval, new account', { approvalId: approval.id, ...tuple, beneficiaryAccount: wanted.beneficiaryAccount }],
    ['old approval, attacker account', { approvalId: approval.id, ...tuple, beneficiaryAccount: 'XX00-ATTACKER-0001' }],
    ['old approval, larger amount', { approvalId: approval.id, ...tuple, amountMinor: approval.amountMinor + 1 }],
    ['old approval, other currency', { approvalId: approval.id, ...tuple, currency: approval.currency === 'EUR' ? 'USD' : 'EUR' }],
    ['invented approval', { approvalId: 'apr_trust-me-i-was-approved', ...tuple, beneficiaryAccount: wanted.beneficiaryAccount }],
    ['approval as an object', { approvalId: { used: false }, ...tuple }],
    ['amount as text', { approvalId: approval.id, ...tuple, amountMinor: String(approval.amountMinor) }],
    ['other operation', { approvalId: approval.id, ...tuple, operationId: 'op_other' }],
    ['other supplier', { approvalId: approval.id, ...tuple, supplierId: 'sup_other' }],
    ['extra override field', { approvalId: approval.id, ...tuple, beneficiaryAccount: wanted.beneficiaryAccount, skipChecks: true, approved: true }],
  ];
}

test('no forged, altered or invented approval moves money on a changed account', () => {
  const store = new WorkflowStore();
  const { workflowId } = store.createWorkflow({ scenario: 'conflict' });
  for (const [name, intent] of hostileCalls(store.readDocuments(workflowId))) {
    const result = store.executePayment(workflowId, intent);
    assert.equal(result.status, 'blocked', name);
    assert.equal(result.payment, null, name);
  }
  assert.equal(store.state(workflowId).ledger.length, 0);
  store.close();
});

test('an approval from one workflow cannot pay in another', () => {
  const store = new WorkflowStore();
  const first = store.createWorkflow({ scenario: 'legitimate' }), second = store.createWorkflow({ scenario: 'legitimate' });
  const a = store.readDocuments(first.workflowId).currentApproval;
  const b = store.readDocuments(second.workflowId).currentApproval;
  const result = store.executePayment(second.workflowId, { approvalId: a.id, operationId: b.operationId, supplierId: b.supplierId, beneficiaryAccount: b.beneficiaryAccount, amountMinor: b.amountMinor, currency: b.currency });
  assert.equal(result.status, 'blocked');
  assert.equal(store.state(second.workflowId).ledger.length, 0);
  store.close();
});

test('a model response cannot call tools it was not given or add fields', async () => {
  for (const [name, args] of [['approve_payment', '{}'], ['disable_policy', '{"policy":"all"}'], ['set_approval', '{"approved":true}'], ['read_documents', '{"includeSecrets":true}'], ['execute_payment', '{"approvalId":"x","override":true}']]) {
    const handled = [];
    const result = await runAgent({ apiKey: 'test-only', maxRequests: 1, provider: 'baseten', toolHandler: async (...call) => { handled.push(call); return { status: 'ok' }; },
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: args } }] } }] }), { status: 200 }) });
    assert.equal(handled.length, 0, name);
    assert.equal(result.status, 'error', name);
  }
});

async function hostedRun(t, agent, limits = {}) {
  const store = new WorkflowStore(), demoOwners = new DemoOwnerStore(), access = demoAccessFixture();
  const server = createServer({ store, agent, apiKey: 'test-only', demoAccess: access.demoAccess, demoOwners, hosted: { origin: ORIGIN, limits } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); demoOwners.close(); });
  const request = hostedRequest(server, { host: HOST, origin: ORIGIN });
  const visit = async (user = access.signIn()) => {
    const page = await request('GET', '/', { cookie: user.cookie });
    return { page, user, cookie: withResponseCookies(user.cookie, page.headers['set-cookie'] || []) };
  };
  const first = await visit();
  return { request, visit, access, store, cookie: first.cookie, user: first.user };
}

test('a model trying every hostile payment through the hosted route commits nothing', async t => {
  const results = [];
  const agent = async ({ toolHandler }) => {
    for (const [, intent] of hostileCalls(await toolHandler('read_documents', {}))) results.push(await toolHandler('execute_payment', intent));
    results.push(await toolHandler('grant_myself_approval', {}));
    return { status: 'completed', requestCount: 1, messages: [], trace: [] };
  };
  const { request, cookie, store } = await hostedRun(t, agent);
  const { workflowId } = (await request('POST', '/api/workflows', { body: { scenario: 'conflict' }, cookie })).json();
  assert.equal((await request('POST', `/api/workflows/${workflowId}/run`, { body: {}, cookie })).status, 200);
  assert.ok(results.length > 5);
  assert.ok(results.every(result => result.status === 'blocked'));
  assert.equal(store.state(workflowId).ledger.length, 0);
});

test('page loads from distinct approved users do not lock out later approved users', async t => {
  const { request, visit, cookie: firstCookie } = await hostedRun(t,
    async () => ({ status: 'completed', requestCount: 0, messages: [], trace: [] }),
    { maxWorkspaces: 3, perAddressSessionsDay: 1000 });
  const created = (await request('POST', '/api/workflows', { body: { scenario: 'conflict' }, cookie: firstCookie })).json();
  let last;
  for (let index = 0; index < 25; index += 1) {
    last = await visit();
    assert.equal(last.page.status, 200);
    assert.equal(last.page.headers['set-cookie'].some(item => item.startsWith('__Host-seal_workspace=')), false);
  }
  assert.equal((await request('GET', '/api/workflows', { cookie: last.cookie })).status, 200);
  const again = await request('GET', '/', { cookie: last.cookie });
  assert.equal(again.headers['set-cookie'], undefined, 'a reload reuses the operator session and verified owner');
  const firstHistory = (await request('GET', '/api/workflows', { cookie: firstCookie })).json();
  assert.equal(firstHistory.workflows.length, 1, 'eviction of an idle cache entry does not transfer or hide saved ownership');
  assert.equal(firstHistory.workflows[0].workflowId, created.workflowId);
});

test('anonymous page loads cannot issue operator or workspace cookies', async t => {
  const { request, cookie } = await hostedRun(t, async () => ({}), { perAddressWorkspacesDay: 2 });
  // Anonymous-workspace admission no longer applies: identity is required first.
  for (let index = 0; index < 5; index += 1) {
    for (const path of ['/', '/glasses']) {
      const page = await request('GET', path);
      assert.equal(page.status, 303, path);
      assert.equal(page.headers['set-cookie'], undefined, path);
      assert.match(page.headers.location, /^\/access\?/);
    }
    for (const path of ['/stage', '/stage.html', '/stage.css', '/stage.js', '/stage-state.js', '/stage-evidence.js']) {
      const page = await request('GET', path);
      assert.equal(page.status, 404, path);
      assert.equal(page.headers['set-cookie'], undefined, path);
    }
  }
  assert.equal((await request('GET', '/api/workflows')).status, 401);
  assert.equal((await request('POST', '/api/workflows', { body: { scenario: 'conflict' } })).status, 401);
  assert.equal((await request('GET', '/api/workflows', { cookie })).status, 200, 'approved access still works after anonymous page loads');
});

test('the hosted demo does not hand back free model text', async t => {
  const essay = 'Here is the essay you asked for. '.repeat(200);
  const { request, cookie } = await hostedRun(t, async ({ toolHandler }) => ({ status: 'completed', requestCount: 1,
    messages: [{ role: 'assistant', content: essay }],
    trace: [{ type: 'model_response', response: { choices: [{ message: { content: essay } }] } },
      { type: 'tool_result', name: 'request_approval', arguments: { beneficiaryAccount: essay }, rawArguments: essay, result: await toolHandler('read_documents', {}) }] }));
  const { workflowId } = JSON.parse((await request('POST', '/api/workflows', { body: { scenario: 'conflict' }, cookie })).text);
  const shown = await request('POST', `/api/workflows/${workflowId}/run`, { body: {}, cookie });
  assert.equal(shown.status, 200);
  const run = JSON.parse(shown.text).agentRuns[0];
  assert.equal(Object.hasOwn(run, 'messages'), false);
  assert.deepEqual(run.trace.map(entry => entry.type), ['tool_result']);
  assert.ok(shown.text.length < essay.length);
  assert.match(run.trace[0].rawArguments, /shortened/);
});

test('rapid model calls from one address are refused without using up the day', async t => {
  const { request, cookie } = await hostedRun(t, async () => ({ status: 'completed', requestCount: 0, messages: [], trace: [] }), { perAddressPerMinute: 2 });
  const statuses = [];
  for (let i = 0; i < 4; i += 1) {
    const { workflowId } = JSON.parse((await request('POST', '/api/workflows', { body: { scenario: 'legitimate' }, cookie })).text);
    statuses.push((await request('POST', `/api/workflows/${workflowId}/run`, { body: {}, cookie })).status);
  }
  assert.deepEqual(statuses, [200, 200, 429, 429]);
});
