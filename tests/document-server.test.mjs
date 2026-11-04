import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from '../server.mjs';
import { WorkflowStore } from '../src/workflow.mjs';
import { createReferenceSigner } from '../src/reference-journal.mjs';
import { caseInput, modelReport, providerResponse } from './document-fixtures.mjs';

async function fixture(t, options = {}) {
  const referenceSigner = createReferenceSigner();
  const store = new WorkflowStore({ referenceSigner });
  const server = createServer({ store, referenceSigner, documentFlow: true, apiKey: 'fixture-provider-key', agent: async () => { throw new Error('Unexpected execution call'); }, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { store, origin, post, referenceSigner };
}

test('document flow is explicit and exposes only public key metadata on its allowlisted route', async t => {
  const { origin, referenceSigner, post } = await fixture(t);
  const config = await (await fetch(origin + '/api/config')).json();
  assert.equal(config.documentFlow, true); assert.equal(config.documentProfile, 'SEAL-DOCUMENT-WORKFLOW-v2');
  assert.deepEqual(config.referenceKey, { profile: 'SEAL-REFERENCE-EVENT-v1', publicKey: referenceSigner.publicKey, fingerprint: referenceSigner.fingerprint });
  assert.deepEqual(await (await fetch(origin + '/api/reference-key')).json(), config.referenceKey);
  for (const path of ['/src/document-agent.mjs', '/src/documents.mjs', '/src/reference-journal.mjs', '/.data/reference-key.pem', '/reference-key.pem', '/api/reference-key/private']) assert.equal((await fetch(origin + path)).status, 404);
  assert.equal(JSON.stringify(config).includes('fixture-provider-key'), false);
  assert.equal((await post('/api/document-workflows', { ...caseInput(), referenceKeyFile: '/tmp/not-allowed' })).status, 400);
  const legacy = await fixture(t, { documentFlow: false });
  assert.equal((await legacy.post('/api/document-workflows', caseInput())).status, 403);
  assert.equal((await fetch(legacy.origin + '/api/reference-key')).status, 404);
  assert.deepEqual(await (await fetch(legacy.origin + '/api/config')).json(), { metaConfigured: true, provider: 'meta', model: 'muse-spark-1.3', modelLabel: 'Muse Spark', simulation: true });
});

test('document upload supports bounded text beyond 16KiB but rejects over 64KiB and unknown versions', async t => {
  const { origin, post } = await fixture(t);
  const input = caseInput(); input.documents = input.documents.map(item => ({ ...item, text: Array.from({ length: 100 }, () => 'x'.repeat(100)).join('\n') }));
  assert.ok(Buffer.byteLength(JSON.stringify(input)) > 16384);
  assert.equal((await post('/api/document-workflows', input)).status, 201);
  input.documents[0].text = 'x'.repeat(70000);
  assert.equal((await post('/api/document-workflows', input)).status, 413);
  for (const version of [1, 3, '2', null]) assert.equal((await post('/api/document-workflows', { ...caseInput(), version })).status, 400);
  assert.equal((await post('/api/workflows', { scenario: 'conflict', version: 3 })).status, 400);
  assert.equal((await post('/api/document-workflows', { ...caseInput(), documents: [{ kind: 'invoice', path: '/tmp/source.txt' }, caseInput().documents[1]] })).status, 400);
  assert.equal((await post('/api/document-workflows', caseInput(), { Origin: 'https://other.invalid' })).status, 403);
  const malformed = await fetch(origin + '/api/document-workflows', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: Buffer.from([123, 34, 120, 34, 58, 34, 0xc3, 34, 125]) });
  assert.equal(malformed.status, 400);
});

test('v2 execution remains blocked until analysis returns a source-bound ready report', async t => {
  let calls = 0, current;
  const { post, origin } = await fixture(t, { fetchImpl: async () => { calls += 1; return providerResponse(modelReport(current)); } });
  current = await (await post('/api/document-workflows', caseInput())).json();
  assert.equal(current.version, 2); assert.equal(current.analysing, false); assert.equal(current.proposal, null);
  assert.equal((await post(`/api/workflows/${current.workflowId}/run`, {})).status, 409);
  assert.equal(calls, 0);
  const analysed = await post(`/api/workflows/${current.workflowId}/analyse`, {});
  assert.equal(analysed.status, 200);
  current = await analysed.json();
  assert.equal(current.proposal.status, 'ready'); assert.equal(current.analysing, false); assert.equal(calls, 1);
  assert.equal((await post(`/api/workflows/${current.workflowId}/analyse`, {})).status, 409);
  const exported = await (await fetch(`${origin}/api/workflows/${current.workflowId}/export`)).json();
  assert.equal(exported.referenceJournal.productionIssuer, false);
  assert.equal(exported.referenceJournal.completeness, 'not_established');
  assert.equal(exported.modelTraceScope, 'server_memory_only');
  assert.equal(exported.proposal.analysis.referenceValidation, 'literal_source_consistency_only');
});

test('analysis failure releases the concurrent lock for a same-case manual retry', async t => {
  let enter, release, current, calls = 0, runs = 0, recordings = 0;
  const entered = new Promise(resolve => { enter = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  const { store, post, origin } = await fixture(t, { agent: async () => { runs += 1; throw new Error('Unexpected execution call'); }, fetchImpl: async () => {
    calls += 1;
    if (calls === 1) { enter(); await delayed; return { ok: false, status: 503, text: async () => { throw new Error('The failed provider body must not be read'); } }; }
    return providerResponse(modelReport(current));
  } });
  current = await (await post('/api/document-workflows', caseInput())).json();
  const initial = store.state(current.workflowId);
  const recordProposal = store.recordProposal.bind(store);
  store.recordProposal = (...args) => { recordings += 1; return recordProposal(...args); };
  const cookie = (await fetch(origin + '/')).headers.get('set-cookie').split(';')[0];
  const inFlight = post(`/api/workflows/${current.workflowId}/analyse`, {});
  await entered;
  assert.equal((await (await fetch(`${origin}/api/workflows/${current.workflowId}`)).json()).analysing, true);
  assert.equal((await post(`/api/workflows/${current.workflowId}/analyse`, {})).status, 409);
  assert.equal((await post(`/api/workflows/${current.workflowId}/run`, {})).status, 409);
  assert.equal((await post(`/api/workflows/${current.workflowId}/approve`, { confirm: true }, { Cookie: cookie, 'X-Operator-Action': 'review' })).status, 409);
  release();
  const failure = await inFlight;
  assert.equal(failure.status, 503);
  const failedBody = await failure.json();
  assert.deepEqual(failedBody, { proposal: null, error: 'The read-only document extraction could not complete.', reasonCode: 'EXTRACTION_HTTP_ERROR', retryable: true });
  assert.equal(JSON.stringify(failedBody).includes('fixture-provider-key'), false);
  assert.equal(calls, 1); assert.equal(runs, 0); assert.equal(recordings, 0);
  assert.deepEqual(store.state(current.workflowId), initial);
  const afterFailure = await (await fetch(`${origin}/api/workflows/${current.workflowId}`)).json();
  assert.equal(afterFailure.analysing, false); assert.equal(afterFailure.proposal, null); assert.deepEqual(afterFailure.events, initial.events); assert.deepEqual(afterFailure.ledger, []);
  const retry = await post(`/api/workflows/${current.workflowId}/analyse`, {});
  assert.equal(retry.status, 200);
  const recovered = await retry.json();
  assert.equal(recovered.workflowId, current.workflowId); assert.equal(recovered.proposal.status, 'ready'); assert.equal(recovered.analysing, false);
  assert.equal(recovered.sourceDigest, initial.sourceDigest); assert.equal(recovered.proposal.sourceDigest, initial.sourceDigest); assert.equal(recovered.proposal.analysis.sourceDigest, initial.sourceDigest);
  assert.deepEqual(recovered.documents, initial.documents); assert.deepEqual(recovered.originalAuthority, initial.originalAuthority); assert.deepEqual(recovered.currentApproval, initial.currentApproval);
  assert.equal(recovered.events.length, initial.events.length + 1); assert.equal(recovered.events.at(-1).type, 'proposal_recorded'); assert.deepEqual(recovered.ledger, []);
  assert.equal(calls, 2); assert.equal(runs, 0); assert.equal(recordings, 1);
});

test('clarification and disabled v2 workflows never invoke the executor agent', async t => {
  let current, runs = 0, invalidTool = false;
  const { store, post } = await fixture(t, { agent: async () => { runs += 1; return {}; }, fetchImpl: async () => {
    if (invalidTool) return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'call', type: 'function', function: { name: 'execute_payment', arguments: '{}' } }] } }] }) };
    return providerResponse(modelReport(current, { status: 'ambiguous', questions: ['Which supplier?'] }));
  } });
  for (const invalid of [false, true]) {
    invalidTool = invalid;
    current = await (await post('/api/document-workflows', caseInput())).json();
    const analysed = await post(`/api/workflows/${current.workflowId}/analyse`, {});
    assert.equal(analysed.status, 200); assert.equal((await analysed.json()).proposal.status, 'needs_clarification');
    assert.equal((await post(`/api/workflows/${current.workflowId}/analyse`, {})).status, 409);
    assert.equal((await post(`/api/workflows/${current.workflowId}/run`, {})).status, 409);
    assert.deepEqual(store.state(current.workflowId).ledger, []);
  }
  assert.equal(runs, 0);
  const disabled = createServer({ store, documentFlow: false, apiKey: 'fixture-provider-key', agent: async () => { runs += 1; } });
  disabled.listen(0, '127.0.0.1'); await once(disabled, 'listening');
  t.after(async () => { disabled.closeAllConnections(); await new Promise(resolve => disabled.close(resolve)); });
  const origin = `http://127.0.0.1:${disabled.address().port}`;
  assert.equal((await fetch(`${origin}/api/workflows/${current.workflowId}/run`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal(runs, 0);
});

test('actual executor tool dispatch remains separate from the exact cookie-bound operator decision', async t => {
  let current, invocations = 0;
  const { post, origin } = await fixture(t, { fetchImpl: async () => providerResponse(modelReport(current)), agent: async ({ documents, toolHandler }) => {
    invocations += 1;
    const source = await toolHandler('read_documents', {});
    assert.deepEqual(source.proposal, documents.proposal);
    assert.equal(Object.hasOwn(source, 'supplierRequest'), false);
    const tuple = source.proposal.tuple;
    if (source.currentApproval.source === 'seeded_fixture') {
      assert.equal((await toolHandler('execute_payment', { approvalId: source.currentApproval.id, ...tuple })).reasonCode, 'ACCOUNT_MISMATCH');
      assert.equal((await toolHandler('request_approval', tuple)).status, 'awaiting_human');
    } else assert.equal((await toolHandler('execute_payment', { approvalId: source.currentApproval.id, ...tuple })).status, 'committed');
    return { status: source.currentApproval.source === 'seeded_fixture' ? 'awaiting_human' : 'completed', messages: [], trace: [], requestCount: 1 };
  } });
  current = await (await post('/api/document-workflows', caseInput())).json();
  await post(`/api/workflows/${current.workflowId}/analyse`, {});
  current = await (await post(`/api/workflows/${current.workflowId}/run`, {})).json();
  const body = { ...current.pendingReview, confirm: true };
  assert.equal((await post(`/api/workflows/${current.workflowId}/approve`, body)).status, 403);
  const cookie = (await fetch(origin + '/')).headers.get('set-cookie').split(';')[0];
  const headers = { Cookie: cookie, 'X-Operator-Action': 'review' };
  assert.equal((await post(`/api/workflows/${current.workflowId}/approve`, { ...body, digest: '0'.repeat(64) }, headers)).status, 409);
  current = await (await post(`/api/workflows/${current.workflowId}/approve`, body, headers)).json();
  assert.equal(current.currentApproval.source, 'operator_review'); assert.equal(current.ledger.length, 0);
  assert.equal((await post(`/api/workflows/${current.workflowId}/analyse`, {})).status, 409);
  current = await (await post(`/api/workflows/${current.workflowId}/run`, {})).json();
  assert.equal(invocations, 2); assert.equal(current.ledger.length, 1);
  assert.equal(current.operatorEvents[0].identityEstablished, false);
  assert.equal((await post(`/api/workflows/${current.workflowId}/run`, {})).status, 409);
});

test('document server requires the store signer and rejects a different configured signer', () => {
  const store = new WorkflowStore();
  assert.throws(() => createServer({ store, documentFlow: true }), /reference signer/); store.close();
  const signed = new WorkflowStore({ referenceSigner: createReferenceSigner() });
  assert.throws(() => createServer({ store: signed, documentFlow: true, referenceSigner: createReferenceSigner() }), /reference signer/); signed.close();
});
