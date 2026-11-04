import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from '../server.mjs';
import { WorkflowStore } from '../src/workflow.mjs';
import { DemoOwnerStore } from '../src/demo-owners.mjs';
import { createReferenceSigner } from '../src/reference-journal.mjs';
import { runAgent, runWonderAgent } from '../src/meta-agent.mjs';
import { runBasetenAgent } from '../src/baseten-agent.mjs';
import { runDocumentAnalysis } from '../src/document-agent.mjs';
import { readPresetImage } from '../src/image-reader.mjs';
import { MODEL_BUDGET_EXHAUSTED } from '../src/model-budget.mjs';
import { demoAccessFixture, hostedRequest, withResponseCookies } from './demo-access-fixture.mjs';
import { caseInput, modelReport, providerResponse } from './document-fixtures.mjs';

const ORIGIN = 'https://demo.example.test', HOST = 'demo.example.test';
const reply = (content = 'Done') => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), { status: 200 });
const toolReply = () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'read_1', type: 'function', function: { name: 'read_documents', arguments: '{}' } }] } }] }), { status: 200 });

async function fixture(t, { fetchImpl, cap = 1, ...options } = {}) {
  const referenceSigner = createReferenceSigner();
  const store = new WorkflowStore({ referenceSigner }), demoOwners = new DemoOwnerStore(), access = demoAccessFixture();
  const server = createServer({ store, referenceSigner, documentFlow: true, provider: 'baseten', apiKey: 'synthetic-test-key', fetchImpl, demoAccess: access.demoAccess, demoOwners,
    hosted: { origin: ORIGIN, limits: { globalDay: cap, perWorkspaceDay: 100, perAddressDay: 100, perAddressPerMinute: 100 } }, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); demoOwners.close(); });
  const request = hostedRequest(server, { host: HOST, origin: ORIGIN });
  const user = access.signIn(), page = await request('GET', '/', { cookie: user.cookie });
  const cookie = withResponseCookies(user.cookie, page.headers['set-cookie'] || []);
  const post = (path, body = {}) => request('POST', path, { cookie, body });
  const legacy = async () => (await post('/api/workflows', { scenario: 'legitimate' })).json();
  const document = async () => (await post('/api/document-workflows', caseInput())).json();
  return { post, legacy, document, store };
}

function exhausted(response, count) {
  assert.equal(response.status, 429);
  assert.equal(response.json().reasonCode, 'MODEL_BUDGET_EXHAUSTED');
  assert.equal(response.json().error, MODEL_BUDGET_EXHAUSTED.error);
  assert.equal(response.json().requestCount, count);
}

test('cap one refuses a second real-adapter continuation before dispatch and retains the actual count', async t => {
  const previous = process.env.SANDBOX_GLOBAL_MODEL_CALLS_DAY;
  process.env.SANDBOX_GLOBAL_MODEL_CALLS_DAY = '1';
  let setup, calls = 0;
  try { setup = await fixture(t, { cap: 100, fetchImpl: async () => { calls += 1; return toolReply(); } }); }
  finally { if (previous === undefined) delete process.env.SANDBOX_GLOBAL_MODEL_CALLS_DAY; else process.env.SANDBOX_GLOBAL_MODEL_CALLS_DAY = previous; }
  const { post, legacy } = setup, created = await legacy();
  const first = await post(`/api/workflows/${created.workflowId}/run`);
  exhausted(first, 1); assert.equal(calls, 1);
  assert.equal(first.json().agentRuns[0].requestCount, 1);
  assert.equal(first.json().running, false);
  const next = await post(`/api/workflows/${created.workflowId}/run`);
  exhausted(next, 0); assert.equal(calls, 1);
  assert.equal(next.json().agentRuns[1].requestCount, 0);
});

test('two concurrent real-adapter runs share cap one, with at most one provider dispatch', async t => {
  let enter, release, calls = 0;
  const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
  const { post, legacy } = await fixture(t, { fetchImpl: async () => { calls += 1; enter(); await held; return reply(); } });
  t.after(() => release());
  const first = await legacy(), second = await legacy();
  const inFlight = post(`/api/workflows/${first.workflowId}/run`);
  await entered;
  const denied = await post(`/api/workflows/${second.workflowId}/run`);
  exhausted(denied, 0); assert.equal(calls, 1);
  release();
  const completed = await inFlight;
  assert.equal(completed.status, 200); assert.equal(completed.json().agentRuns[0].requestCount, 1); assert.equal(calls, 1);
});

test('one document analysis consumes the shared request allowance and the next run is refused', async t => {
  let current, calls = 0;
  const { post, document, legacy } = await fixture(t, { fetchImpl: async () => { calls += 1; return providerResponse(modelReport(current)); } });
  current = await document();
  const analysed = await post(`/api/workflows/${current.workflowId}/analyse`);
  assert.equal(analysed.status, 200); assert.equal(analysed.json().proposal.analysis.requestCount, 1); assert.equal(calls, 1);
  const second = await document();
  exhausted(await post(`/api/workflows/${second.workflowId}/analyse`), 0);
  const run = await legacy(); exhausted(await post(`/api/workflows/${run.workflowId}/run`), 0); assert.equal(calls, 1);
});

test('one image request consumes the shared allowance, including across other adapter routes', async t => {
  let calls = 0;
  const { post, document, legacy } = await fixture(t, { fetchImpl: async () => { calls += 1; return reply('Supplier: Harbour Print'); } });
  assert.equal((await post('/api/read-image', { preset: 'invoice' })).status, 200); assert.equal(calls, 1);
  exhausted(await post('/api/read-image', { preset: 'instruction' }), 0);
  const extraction = await document(); exhausted(await post(`/api/workflows/${extraction.workflowId}/analyse`), 0);
  const run = await legacy(); exhausted(await post(`/api/workflows/${run.workflowId}/run`), 0); assert.equal(calls, 1);
});

test('a provider HTTP failure still consumes the hosted allowance', async t => {
  let calls = 0;
  const { post, legacy } = await fixture(t, { fetchImpl: async () => { calls += 1; return new Response('{}', { status: 503 }); } });
  const run = await legacy(), failed = await post(`/api/workflows/${run.workflowId}/run`);
  assert.equal(failed.json().agentRuns[0].status, 'error'); assert.equal(failed.json().agentRuns[0].requestCount, 1);
  exhausted(await post(`/api/workflows/${run.workflowId}/run`), 0); assert.equal(calls, 1);
});

test('Meta, Wonder and Baseten adapters invoke the synchronous hook before every attempted fetch', async () => {
  for (const adapter of [runAgent, runWonderAgent, runBasetenAgent]) {
    let reservations = 0, calls = 0;
    const result = await adapter({ apiKey: 'synthetic-test-key', toolHandler: async () => ({}), beforeModelRequest: () => ++reservations <= 1,
      fetchImpl: async () => { calls += 1; assert.equal(reservations, calls); return toolReply(); } });
    assert.equal(result.reasonCode, 'MODEL_BUDGET_EXHAUSTED'); assert.equal(result.requestCount, 1); assert.equal(reservations, 2); assert.equal(calls, 1);
  }
});

test('timeouts consume one reservation for every adapter and cannot be refunded on the next attempt', async () => {
  const store = new WorkflowStore({ referenceSigner: createReferenceSigner() });
  try {
    const state = store.createDocumentWorkflow(caseInput());
    for (const [adapter, extra, count] of [
      [runBasetenAgent, { toolHandler: async () => ({}) }, result => result.requestCount],
      [runDocumentAnalysis, { documents: state.documents, sourceDigest: state.sourceDigest }, result => result.provenance.requestCount],
      [readPresetImage, { preset: 'invoice' }, result => result.requestCount],
    ]) {
      let spent = 0, calls = 0;
      const options = { ...extra, provider: 'baseten', apiKey: 'synthetic-test-key', timeoutMs: 5, beforeModelRequest: () => spent < 1 ? (++spent, true) : false,
        fetchImpl: async () => { calls += 1; return new Promise(() => {}); } };
      const first = await adapter(options); assert.ok(first.error); assert.equal(count(first), 1); assert.equal(spent, 1);
      const next = await adapter(options); assert.equal(next.reasonCode, 'MODEL_BUDGET_EXHAUSTED'); assert.equal(count(next), 0); assert.equal(calls, 1);
    }
  } finally { store.close(); }
});

test('an async reservation is not treated as permission to dispatch', async () => {
  let calls = 0;
  for (const beforeModelRequest of [async () => true, async () => { throw new Error('No reservation'); }]) {
    const result = await runBasetenAgent({ apiKey: 'synthetic-test-key', toolHandler: async () => ({}), beforeModelRequest,
      fetchImpl: async () => { calls += 1; return reply(); } });
    assert.equal(result.reasonCode, 'MODEL_BUDGET_EXHAUSTED'); assert.equal(result.requestCount, 0); assert.equal(calls, 0);
  }
});
