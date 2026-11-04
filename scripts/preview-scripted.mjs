// Interface preview only. A scripted stand-in replaces the model so every screen
// state can be checked without a provider key. Nothing here is a model result.
// PREVIEW_MODE: legacy (default), or for the document flow refuse, direct, clarify, text.
// PREVIEW_PAUSE_MS: how long each scripted model call takes (default 500).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.mjs';
import { WorkflowStore } from '../src/workflow.mjs';
import { createReferenceSigner } from '../src/reference-journal.mjs';

const mode = process.env.PREVIEW_MODE || 'legacy';
if (!['legacy', 'refuse', 'direct', 'clarify', 'text'].includes(mode)) throw new Error('Choose legacy, refuse, direct, clarify or text.');
const documentFlow = mode !== 'legacy';
const label = { provider: 'scripted-preview', model: 'scripted-preview (no model call)' };
const step = (requestIndex, name, args, result) => ({ ...label, type: 'tool_result', requestIndex, name, arguments: args, result, dispatched: true });
const pauseMs = Number(process.env.PREVIEW_PAUSE_MS || 500);
const pause = () => new Promise(resolve => setTimeout(resolve, pauseMs));

async function scriptedDocuments({ toolHandler, messages }) {
  await pause();
  const trace = [];
  const docs = await toolHandler('read_documents', {});
  trace.push(step(1, 'read_documents', {}, { status: 'ok' }));
  const approval = docs.currentApproval;
  if (messages) {
    const args = { approvalId: approval.id, operationId: approval.operationId, supplierId: approval.supplierId, beneficiaryAccount: approval.beneficiaryAccount, amountMinor: approval.amountMinor, currency: approval.currency };
    trace.push(step(2, 'execute_payment', args, await toolHandler('execute_payment', args)));
    return { ...label, status: 'completed', requestCount: 0, messages, trace };
  }
  if (mode === 'text') return { ...label, status: 'completed', requestCount: 0, messages: [], trace };
  const tuple = docs.proposal.tuple;
  if (mode === 'refuse' || tuple.beneficiaryAccount === approval.beneficiaryAccount) {
    const attempt = { approvalId: approval.id, ...tuple };
    const result = await toolHandler('execute_payment', attempt);
    trace.push(step(2, 'execute_payment', attempt, result));
    if (result.status === 'committed') return { ...label, status: 'completed', requestCount: 0, messages: [], trace };
    await pause(); // A real model takes a turn between tools, so the stage's polling sees one event at a time.
  }
  trace.push(step(trace.length + 1, 'request_approval', tuple, await toolHandler('request_approval', tuple)));
  return { ...label, status: 'awaiting_human', requestCount: 0, messages: [{ role: 'user', content: 'Scripted preview history' }], trace };
}

async function scriptedAnalysis({ documents }) {
  await pause();
  const cite = (id, pattern) => { const document = documents.find(item => item.id === id); const line = document.lines.find(item => pattern.test(item.text)); return { documentId: id, line: line.number, quote: line.text }; };
  const later = documents.find(item => item.id === 'instruction').text.match(/DE00-TEST-0000-\d{4}/)[0];
  const candidate = {
    supplierName: { value: 'Harbour Print', citation: cite('invoice', /Supplier:/) },
    beneficiaryAccount: { value: later, citation: cite('instruction', new RegExp(later)) },
    amountMinor: { value: 25000000, citation: cite('invoice', /Amount:/) },
    currency: { value: 'EUR', citation: cite('invoice', /Currency:/) },
  };
  const proposal = mode === 'clarify'
    ? { status: 'ambiguous', candidate: { ...candidate, beneficiaryAccount: null }, questions: ['Which account should be paid, the one ending 1280 or the one ending 1289?'] }
    : { status: 'ready', candidate, questions: [] };
  return { proposal };
}

async function scripted({ toolHandler, messages }) {
  const trace = [];
  const docs = await toolHandler('read_documents', {});
  trace.push(step(1, 'read_documents', {}, { status: 'ok' }));
  const approval = docs.currentApproval;
  if (messages) {
    const args = { approvalId: approval.id, operationId: docs.operationId, supplierId: approval.supplierId, beneficiaryAccount: approval.beneficiaryAccount, amountMinor: approval.amountMinor, currency: approval.currency };
    trace.push(step(2, 'execute_payment', args, await toolHandler('execute_payment', args)));
    return { ...label, status: 'completed', requestCount: 0, messages, trace };
  }
  const request = docs.supplierRequest;
  const attempt = { approvalId: approval.id, operationId: docs.operationId, supplierId: request.supplierId, beneficiaryAccount: request.beneficiaryAccount, amountMinor: request.amountMinor, currency: request.currency };
  const result = await toolHandler('execute_payment', attempt);
  trace.push(step(2, 'execute_payment', attempt, result));
  if (result.status === 'committed') return { ...label, status: 'completed', requestCount: 0, messages: [], trace };
  const review = await toolHandler('request_approval', request);
  trace.push(step(3, 'request_approval', request, review));
  return { ...label, status: 'awaiting_human', requestCount: 0, messages: [{ role: 'user', content: 'Scripted preview history' }], trace };
}

const referenceSigner = documentFlow ? createReferenceSigner() : undefined;
const store = new WorkflowStore({ filename: join(mkdtempSync(join(tmpdir(), 'seal-preview-')), 'preview.sqlite'), referenceSigner });
const port = Number(process.env.PORT || 4182);
createServer({ store, agent: documentFlow ? scriptedDocuments : scripted, apiKey: 'scripted-preview', provider: 'baseten', modelLabel: 'a scripted preview', brandMarkFile: process.env.SANDBOX_BRAND_MARK, aqtaMarkFile: process.env.SANDBOX_AQTA_MARK, fontDir: process.env.SANDBOX_FONT_DIR,
  ...(documentFlow ? { documentFlow, referenceSigner, documentAgent: scriptedAnalysis } : {}) })
  .listen(port, '127.0.0.1', () => console.log(`Scripted interface preview (${mode}): http://localhost:${port}`));
