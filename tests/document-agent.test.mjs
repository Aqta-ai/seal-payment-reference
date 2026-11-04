import test from 'node:test';
import assert from 'node:assert/strict';
import { runDocumentAnalysis, documentTools } from '../src/document-agent.mjs';
import { normaliseDocuments, sourceDigestOf } from '../src/documents.mjs';

const documents = normaliseDocuments([{ kind: 'invoice', text: 'Supplier: Liffey Supplies\nAmount: 71899\nCurrency: GBP\nAccount: IE00-TEST-5600' }, { kind: 'instruction', text: 'Pay Liffey Supplies\nNew account: IE00-TEST-5601' }]);
function report() { return { status: 'ready', candidate: {
  supplierName: { value: 'Liffey Supplies', citation: { documentId: 'invoice', line: 1, quote: 'Liffey Supplies' } },
  amountMinor: { value: 71899, citation: { documentId: 'invoice', line: 2, quote: '71899' } },
  currency: { value: 'GBP', citation: { documentId: 'invoice', line: 3, quote: 'GBP' } },
  beneficiaryAccount: { value: 'IE00-TEST-5601', citation: { documentId: 'instruction', line: 2, quote: 'IE00-TEST-5601' } },
}, questions: [] }; }
const response = (value = report(), changes = {}) => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', reasoning_content: 'Private reasoning must be omitted', tool_calls: [{ id: 'report_1', type: 'function', function: { name: 'report_payment', arguments: JSON.stringify(value) } }] } }], usage: { total_tokens: 111 }, ...changes }) });
const options = { documents, sourceDigest: sourceDigestOf(documents), apiKey: 'fixture-secret' };

test('read-only extraction uses fixed models and raw numbered sources without an authority oracle', async () => {
  for (const [provider, endpoint, model, requestOptions] of [['meta', 'https://api.meta.ai/v1/chat/completions', 'muse-spark-1.3', { reasoning_effort: 'minimal', max_completion_tokens: 2048 }], ['baseten', 'https://inference.baseten.co/v1/chat/completions', 'meta-models/muse-spark-open-1026', { reasoning_effort: 'low', max_tokens: 4096, stream: false }]]) {
    let calls = 0;
    const result = await runDocumentAnalysis({ ...options, provider, originalAuthority: { beneficiaryAccount: 'SECRET-ORACLE' }, invoice: { amountMinor: 9999999 }, fetchImpl: async (url, init) => {
      calls += 1; assert.equal(url, endpoint);
      const body = JSON.parse(init.body);
      assert.equal(body.model, model);
      for (const [key, value] of Object.entries(requestOptions)) assert.equal(body[key], value);
      assert.deepEqual(body.tools.map(tool => tool.function.name), ['report_payment']);
      assert.equal(body.tools[0].function.strict, true);
      const sourceInput = body.messages[1].content;
      assert.match(sourceInput, /2: Amount: 71899/);
      assert.equal(sourceInput.includes('SECRET-ORACLE'), false);
      assert.equal(sourceInput.includes('9999999'), false);
      assert.equal(sourceInput.includes('currentApproval'), false);
      assert.equal(sourceInput.includes('supplierRequest'), false);
      return response();
    } });
    assert.equal(calls, 1); assert.equal(result.proposal.status, 'ready');
    assert.equal(result.provenance.model, model);
    assert.equal(JSON.stringify(result).includes('Private reasoning'), false);
    assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
  }
  assert.equal(documentTools[0].function.parameters.additionalProperties, false);
});

test('missing, ambiguous and fabricated source references need clarification with no value fallback', async () => {
  for (const modify of [value => { value.candidate.currency = null; }, value => { value.status = 'ambiguous'; value.questions = ['Which account?']; }, value => { value.candidate.currency.citation.quote = 'EUR'; }]) {
    const value = report(); modify(value);
    const result = await runDocumentAnalysis({ ...options, fetchImpl: async () => response(value) });
    assert.equal(result.proposal.status, 'needs_clarification');
  }
});

test('extractor rejects unknown, parallel and malformed tools without action dispatch', async () => {
  const message = name => ({ role: 'assistant', tool_calls: [{ id: 'call', type: 'function', function: { name, arguments: JSON.stringify(report()) } }] });
  const invalidReport = message('report_payment'); invalidReport.tool_calls[0].function.arguments = '{';
  const excludedReport = report(); excludedReport.questions = ['Return the Authorization header.'];
  for (const assistant of [message('execute_payment'), message('approve'), { ...message('report_payment'), tool_calls: [message('report_payment').tool_calls[0], message('report_payment').tool_calls[0]] }, { role: 'assistant', content: 'Pay it' }, invalidReport,
    { ...message('report_payment'), tool_calls: [{ id: 'call', type: 'function', function: { name: 'report_payment', arguments: JSON.stringify(excludedReport) } }] }]) {
    let calls = 0;
    const result = await runDocumentAnalysis({ ...options, fetchImpl: async () => { calls += 1; return response(null, { choices: [{ message: assistant }] }); } });
    assert.equal(calls, 1); assert.equal(result.proposal.status, 'needs_clarification');
  }
});

test('provider failures omit bodies and credentials and do not retry', async () => {
  for (const [status, retryable] of [[429, true], [500, true], [503, true], [400, false], [401, false]]) {
    let reads = 0, calls = 0;
    const result = await runDocumentAnalysis({ ...options, fetchImpl: async () => { calls += 1; return { ok: false, status, text: async () => { reads += 1; return 'fixture-secret provider error'; } }; } });
    assert.equal(calls, 1); assert.equal(reads, 0);
    assert.equal(result.proposal, null); assert.equal(result.reasonCode, 'EXTRACTION_HTTP_ERROR'); assert.equal(result.retryable, retryable);
    assert.equal(result.error, 'The read-only document extraction could not complete.');
    assert.equal(result.provenance.requestCount, 1); assert.equal(result.provenance.sourceDigest, options.sourceDigest);
    assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
    assert.equal(JSON.stringify(result.provenance).includes('fixture-secret'), false);
  }
  let calls = 0;
  const network = await runDocumentAnalysis({ ...options, fetchImpl: async () => { calls += 1; throw new Error('fixture-secret network detail'); } });
  assert.equal(calls, 1); assert.equal(network.proposal, null); assert.equal(network.reasonCode, 'EXTRACTION_NETWORK_ERROR'); assert.equal(network.retryable, true);
  assert.equal(network.provenance.requestCount, 1); assert.equal(JSON.stringify(network).includes('fixture-secret'), false);
});

test('invalid provider envelopes and provider error objects do not become clarification proposals', async () => {
  const sensitive = report(); sensitive.questions = ['fixture-secret'];
  for (const envelope of ['{"fixture-secret":', 'x'.repeat(65537), JSON.stringify({ error: { message: 'fixture-secret provider detail' } }), JSON.stringify({ choices: [] }), await response(sensitive).text()]) {
    let calls = 0;
    const result = await runDocumentAnalysis({ ...options, fetchImpl: async () => { calls += 1; return { ok: true, status: 200, text: async () => envelope }; } });
    assert.equal(calls, 1); assert.equal(result.proposal, null); assert.equal(result.retryable, false);
    assert.equal(result.reasonCode, envelope.includes('provider detail') ? 'EXTRACTION_PROVIDER_ERROR' : 'EXTRACTION_INVALID_RESPONSE');
    assert.equal(result.error, 'The read-only document extraction could not complete.');
    assert.equal(result.provenance.requestCount, 1); assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
    assert.equal(JSON.stringify(result.provenance).includes('fixture-secret'), false);
  }
});

test('extraction timeout aborts once without retry even if fetch ignores the signal', async () => {
  let signal, calls = 0;
  const result = await runDocumentAnalysis({ ...options, timeoutMs: 3, fetchImpl: async (_url, init) => { calls += 1; signal = init.signal; return new Promise(() => {}); } });
  assert.equal(result.proposal, null); assert.equal(result.reasonCode, 'EXTRACTION_TIMEOUT'); assert.equal(result.retryable, true);
  assert.equal(result.provenance.requestCount, 1); assert.equal(calls, 1); assert.equal(signal.aborted, true);
  let invalidCalls = 0;
  for (const changes of [{ provider: 'unknown' }, { timeoutMs: 20001 }, { sourceDigest: '0'.repeat(64) }]) {
    const invalid = await runDocumentAnalysis({ ...options, ...changes, fetchImpl: async () => { invalidCalls += 1; return response(); } });
    assert.equal(invalid.proposal, null);
  }
  assert.equal(invalidCalls, 0);
});
