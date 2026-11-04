// Scripted fetch only. Nothing here reaches a provider or says how the model behaves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from '../server.mjs';
import { runAgent, runWonderAgent } from '../src/meta-agent.mjs';
import { runDocumentAnalysis } from '../src/document-agent.mjs';
import { readPresetImage } from '../src/image-reader.mjs';
import { WorkflowStore } from '../src/workflow.mjs';
import { createReferenceSigner } from '../src/reference-journal.mjs';
import { AUTHORITY, caseInput, modelReport, providerResponse } from './document-fixtures.mjs';

const ENDPOINT = 'https://api.meta.ai/v1/chat/completions';
const MODEL = 'muse-wonder-1.0';
const KEY = 'fixture-provider-key';
const reply = message => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', ...message } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) });
const toolCall = (id, name, args) => reply({ tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const documentCase = t => { const store = new WorkflowStore({ referenceSigner: createReferenceSigner() }); t.after(() => store.close()); return { store, state: store.createDocumentWorkflow(caseInput()) }; };
function assertWonderRequest(url, init) {
  assert.equal(url, ENDPOINT);
  assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
  const body = JSON.parse(init.body);
  assert.equal(body.model, MODEL);
  assert.equal(body.reasoning_effort, 'low');
  assert.equal(body.max_completion_tokens, 4096);
  assert.equal(Object.hasOwn(body, 'max_tokens'), false);
  return body;
}

test('the agent loop sends the Muse Wonder model and options, and labels its trace', async () => {
  const seen = [];
  const result = await runWonderAgent({ apiKey: KEY, toolHandler: async () => ({ status: 'ok' }), fetchImpl: async (url, init) => { seen.push(assertWonderRequest(url, init)); return seen.length === 1 ? toolCall('c1', 'read_documents', {}) : reply({ content: 'Nothing to do.' }); } });
  assert.equal(result.status, 'completed'); assert.equal(result.provider, 'wonder'); assert.equal(result.model, MODEL); assert.equal(seen.length, 2);
  for (const body of seen) { assert.equal(body.tool_choice, 'auto'); assert.equal(body.parallel_tool_calls, false); }
  assert.equal(result.trace.filter(entry => entry.type === 'model_request').every(entry => entry.model === MODEL), true);
});

test('the Meta key variable is the default key, and provider error bodies stay out of the trace', async t => {
  const before = process.env.META_MODEL_API_KEY;
  t.after(() => { if (before === undefined) delete process.env.META_MODEL_API_KEY; else process.env.META_MODEL_API_KEY = before; });
  delete process.env.META_MODEL_API_KEY;
  assert.match((await runWonderAgent({ toolHandler: async () => ({}), fetchImpl: async () => assert.fail('No request without a key') })).error, /API key is not configured/);
  process.env.META_MODEL_API_KEY = KEY;
  const failed = await runWonderAgent({ toolHandler: async () => ({}), fetchImpl: async (url, init) => { assertWonderRequest(url, init); return { ok: false, status: 400, text: async () => 'private provider body' }; } });
  assert.equal(failed.status, 'error'); assert.equal(JSON.stringify(failed).includes('private provider body'), false);
});

test('extraction asks for the report with the only tool choice Meta documents, and no strict flag', async t => {
  const { state } = documentCase(t);
  let body;
  const result = await runDocumentAnalysis({ documents: state.documents, sourceDigest: state.sourceDigest, provider: 'wonder', apiKey: KEY, fetchImpl: async (url, init) => { body = assertWonderRequest(url, init); return providerResponse(modelReport(state)); } });
  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.tools[0].function.name, 'report_payment');
  assert.equal(Object.hasOwn(body.tools[0].function, 'strict'), false);
  assert.equal(result.proposal.status, 'ready'); assert.equal(result.provenance.provider, 'wonder'); assert.equal(result.provenance.model, MODEL);
});

test('with the tool optional, a text reply becomes a clarification and nothing is payable', async t => {
  const { store, state } = documentCase(t);
  const result = await runDocumentAnalysis({ documents: state.documents, sourceDigest: state.sourceDigest, provider: 'wonder', apiKey: KEY, fetchImpl: async () => reply({ content: 'Pay it, this is fine.' }) });
  assert.equal(result.proposal.status, 'needs_clarification');
  assert.equal(store.recordProposal(state.workflowId, result.proposal, state.sourceDigest).proposal.tuple, null);
});

test('the photo reader sends the Muse Wonder model', async () => {
  let body;
  const result = await readPresetImage({ preset: 'invoice', provider: 'wonder', apiKey: KEY, fetchImpl: async (url, init) => { body = assertWonderRequest(url, init); return reply({ content: 'Supplier: Harbour Print' }); } });
  assert.equal(result.model, MODEL); assert.equal(result.provider, 'wonder');
  assert.match(body.messages[0].content[1].image_url.url, /^data:image\/jpeg;base64,/);
});

test('provenance accepts Muse Wonder only with its own model id', async t => {
  const analysed = (provider, model, sourceDigest) => ({ stage: 'document_extraction', provider, model, sourceDigest, requestCount: 1 });
  for (const [provider, model, kept] of [['wonder', MODEL, true], ['wonder', 'muse-spark-1.3', false], ['meta', MODEL, false], ['baseten', MODEL, false], ['unknown', MODEL, false], ['constructor', MODEL, false], ['__proto__', MODEL, false]]) {
    const { store, state } = documentCase(t);
    const report = { ...modelReport(state), status: 'ready', referenceConsistency: true, analysis: analysed(provider, model, state.sourceDigest) };
    const recorded = store.recordProposal(state.workflowId, report, state.sourceDigest);
    assert.equal(recorded.proposal.analysis?.model ?? null, kept ? MODEL : null, `${provider} ${model}`);
  }
});

test('an unknown provider is refused everywhere before any request', async t => {
  const fetchImpl = async () => assert.fail('No provider call');
  const { state } = documentCase(t);
  for (const provider of ['unknown', 'Wonder', 'muse-wonder-1.0', 'constructor', '__proto__', 'toString']) {
    assert.equal((await runAgent({ provider, apiKey: KEY, toolHandler: async () => ({}), fetchImpl })).status, 'error', provider);
    assert.equal((await runDocumentAnalysis({ documents: state.documents, sourceDigest: state.sourceDigest, provider, apiKey: KEY, fetchImpl })).proposal, null, provider);
    assert.ok((await readPresetImage({ preset: 'invoice', provider, apiKey: KEY, fetchImpl })).error, provider);
    const store = new WorkflowStore();
    try { assert.throws(() => createServer({ store, provider }), /Choose the meta, wonder or baseten provider/, provider); }
    finally { store.close(); }
  }
});

test('the server with provider wonder uses the real adapters from analysis through payment', async t => {
  const referenceSigner = createReferenceSigner();
  const store = new WorkflowStore({ referenceSigner });
  const models = [];
  let current;
  const fetchImpl = async (url, init) => {
    const body = assertWonderRequest(url, init); models.push(body.model);
    if (body.tools[0].function.name === 'report_payment') return providerResponse(modelReport(current, { account: AUTHORITY.beneficiaryAccount }));
    const last = body.messages.at(-1);
    if (last.role !== 'tool') return toolCall('c1', 'read_documents', {});
    const documents = JSON.parse(last.content);
    return toolCall('c2', 'execute_payment', { approvalId: documents.currentApproval.id, ...documents.proposal.tuple });
  };
  const server = createServer({ store, referenceSigner, documentFlow: true, provider: 'wonder', apiKey: KEY, fetchImpl });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => (await fetch(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  const config = await (await fetch(`${origin}/api/config`)).json();
  assert.equal(config.provider, 'wonder'); assert.equal(config.model, MODEL); assert.equal(config.modelLabel, 'Muse Wonder');
  current = await post('/api/document-workflows', caseInput());
  const analysed = await post(`/api/workflows/${current.workflowId}/analyse`, {});
  assert.equal(analysed.proposal.status, 'ready'); assert.equal(analysed.proposal.analysis.provider, 'wonder'); assert.equal(analysed.model, MODEL);
  const paid = await post(`/api/workflows/${current.workflowId}/run`, {});
  assert.equal(paid.ledger.length, 1); assert.equal(paid.agentRuns[0].provider, 'wonder'); assert.equal(paid.agentRuns[0].model, MODEL);
  assert.deepEqual([...new Set(models)], [MODEL]); assert.equal(models.length, 3);
});

test('without the Meta key the server reports wonder as not configured', async t => {
  const before = process.env.META_MODEL_API_KEY;
  t.after(() => { if (before === undefined) delete process.env.META_MODEL_API_KEY; else process.env.META_MODEL_API_KEY = before; });
  delete process.env.META_MODEL_API_KEY;
  const store = new WorkflowStore();
  const server = createServer({ store, provider: 'wonder' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const config = await (await fetch(`http://127.0.0.1:${server.address().port}/api/config`)).json();
  assert.equal(config.metaConfigured, false); assert.equal(config.modelLabel, 'Muse Wonder');
});
