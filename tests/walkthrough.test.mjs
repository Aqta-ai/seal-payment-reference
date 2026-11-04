// The real store produces every state, so each sentence is checked against a recorded run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from '../server.mjs';
import { TOUR_TEXT, OWN_DOCUMENTS, tourStage } from '../walkthrough.js';
import { WorkflowStore } from '../src/workflow.mjs';
import { createReferenceSigner } from '../src/reference-journal.mjs';

const CONFLICT = { originalAuthority: { supplierId: 'harbour-print', supplierName: 'Harbour Print', beneficiaryAccount: 'DE00-TEST-0000-1280', amountMinor: 25000000, currency: 'EUR' }, documents: [
  { kind: 'invoice', text: 'Supplier: Harbour Print\nAmount: 250000.00\nCurrency: EUR\nBeneficiary account: DE00-TEST-0000-1280' },
  { kind: 'instruction', text: 'Requested beneficiary account: DE00-TEST-0000-1289.' },
] };
const report = (account = 'DE00-TEST-0000-1289') => ({ status: 'ready', questions: [], candidate: {
  supplierName: { value: 'Harbour Print', citation: { documentId: 'invoice', line: 1, quote: 'Harbour Print' } },
  amountMinor: { value: 25000000, citation: { documentId: 'invoice', line: 2, quote: '250000.00' } },
  currency: { value: 'EUR', citation: { documentId: 'invoice', line: 3, quote: 'EUR' } },
  beneficiaryAccount: { value: account, citation: account.endsWith('1289') ? { documentId: 'instruction', line: 1, quote: account } : { documentId: 'invoice', line: 4, quote: account } },
} });
function start(t) { const store = new WorkflowStore({ referenceSigner: createReferenceSigner() }); t.after(() => store.close()); return { store, id: store.createDocumentWorkflow(CONFLICT).workflowId }; }
const view = (store, id, runs = []) => ({ ...store.state(id), agentRuns: runs });
const ready = { ready: true };
const attempt = state => ({ approvalId: state.currentApproval.id, ...state.proposal.tuple });
const decision = review => ({ reviewId: review.reviewId, digest: review.digest, expectedRevision: review.expectedRevision });

test('the five fixed sentences read as agreed', () => {
  assert.deepEqual(TOUR_TEXT, {
    opening: 'This invoice was approved for the account ending 1280. A later message asks to pay 1289.',
    decide: 'Check the exact details, then approve this one payment.',
    paid: 'One payment. Nothing else moved.',
    breakIt: 'Now try to break it: change one cent in a copy, or try paying again.',
  });
  assert.equal(tourStage(null).text, TOUR_TEXT.opening); assert.equal(tourStage(null).step, 1); assert.equal(tourStage(null).target, 'start-conflict');
});

test('the opening holds through analysing, and continuing still needs both controls', t => {
  const { store, id } = start(t);
  const saved = tourStage(view(store, id));
  assert.equal(saved.text, TOUR_TEXT.opening); assert.equal(saved.target, 'analyse-documents'); assert.match(saved.hint, /Analyse documents/);
  assert.match(tourStage(view(store, id), { busy: true }).hint, /no payment tools/);
  store.recordProposal(id, report(), view(store, id).sourceDigest);
  const proposed = tourStage(view(store, id), ready);
  assert.equal(proposed.text, TOUR_TEXT.opening); assert.equal(proposed.target, 'continue-proposal'); assert.equal(proposed.step, 1);
});

test('nothing is said about the agent before it acts', t => {
  const { store, id } = start(t);
  store.recordProposal(id, report(), view(store, id).sourceDigest);
  const working = tourStage(view(store, id), { ready: true, busy: true });
  assert.equal(working.step, 2); assert.doesNotMatch(working.text, /refus|tried|asked/i);
});

test('a refusal is described only when one was recorded, then the decision follows Next', t => {
  const { store, id } = start(t);
  store.recordProposal(id, report(), view(store, id).sourceDigest);
  const state = view(store, id);
  assert.equal(store.executePayment(id, attempt(state)).reasonCode, 'ACCOUNT_MISMATCH');
  store.requestApproval(id, state.proposal.tuple);
  const acted = tourStage(view(store, id, [{ status: 'awaiting_human' }]), ready);
  assert.equal(acted.step, 2); assert.equal(acted.next, 'agent');
  assert.match(acted.text, /tried to pay the account ending 1289 using the existing approval\. The check refused it: account differs from the approval\. It then asked a person to review/);
  const decide = tourStage(view(store, id, [{}]), { ...ready, seen: new Set(['agent']) });
  assert.equal(decide.step, 3); assert.equal(decide.text, TOUR_TEXT.decide); assert.equal(decide.target, 'review');
});

test('a direct request is never described as a refusal', t => {
  const { store, id } = start(t);
  store.recordProposal(id, report(), view(store, id).sourceDigest);
  store.requestApproval(id, view(store, id).proposal.tuple);
  const acted = tourStage(view(store, id, [{}]), ready);
  assert.match(acted.text, /did not try to pay\. It asked a person to review the account ending 1289/);
  assert.doesNotMatch(acted.text, /refus/i);
});

test('approval, payment and the attempts to break it follow the record', t => {
  const { store, id } = start(t);
  store.recordProposal(id, report(), view(store, id).sourceDigest);
  store.requestApproval(id, view(store, id).proposal.tuple);
  store.approve(id, decision(view(store, id).pendingReview));
  const approved = tourStage(view(store, id, [{}]), ready);
  assert.equal(approved.step, 3); assert.equal(approved.target, 'resume');
  assert.match(tourStage(view(store, id, [{}]), { ...ready, busy: true }).hint, /using the approval/);
  const state = view(store, id);
  assert.equal(store.executePayment(id, { approvalId: state.currentApproval.id, ...state.proposal.tuple }).status, 'committed');
  const paid = tourStage(view(store, id, [{}]), ready);
  assert.equal(paid.step, 4); assert.equal(paid.text, TOUR_TEXT.paid); assert.equal(paid.next, 'paid');
  const seen = new Set(['paid']);
  const breakIt = tourStage(view(store, id, [{}]), { ...ready, seen });
  assert.equal(breakIt.step, 5); assert.equal(breakIt.text, TOUR_TEXT.breakIt); assert.equal(breakIt.target, 'check-edited-copy'); assert.deepEqual(breakIt.links, [OWN_DOCUMENTS]);
  assert.equal(breakIt.hint, null);
  assert.equal(tourStage(view(store, id, [{}]), { ...ready, seen, proof: { edited: true } }).target, 'check-repeat-run');
  assert.match(tourStage(view(store, id, [{}]), { ...ready, seen, proof: { edited: true, repeat: true } }).hint, /still one payment/);
  assert.equal(tourStage(view(store, id, [{}]), { ...ready, seen, proof: { edited: false, repeat: false } }).hint, null);
});

test('a question from the model is reported as one, with a fresh case and own documents offered', t => {
  const { store, id } = start(t);
  const question = 'Which account should be paid?';
  store.recordProposal(id, { status: 'ambiguous', candidate: { ...report().candidate, beneficiaryAccount: null }, questions: [question] }, view(store, id).sourceDigest);
  const asked = tourStage(view(store, id));
  assert.equal(asked.step, 2); assert.match(asked.text, /The model asked a question/); assert.ok(asked.text.includes(question)); assert.match(asked.text, /Nothing was paid/);
  assert.deepEqual(asked.links.map(link => link[1]), ['Start a fresh case', 'Use your own test documents']);
});

test('a failed extraction is not called a question from the model', t => {
  const { store, id } = start(t);
  store.recordProposal(id, { status: 'ambiguous', candidate: { ...report().candidate, beneficiaryAccount: null }, questions: ['The model did not provide one valid extraction report.'] }, view(store, id).sourceDigest);
  assert.doesNotMatch(tourStage(view(store, id)).text, /asked a question/);
});

test('a run that ends without a decision says so and offers a fresh case', t => {
  const { store, id } = start(t);
  store.recordProposal(id, report(), view(store, id).sourceDigest);
  const words = tourStage(view(store, id, [{ status: 'completed' }]), ready);
  assert.equal(words.step, 2); assert.match(words.text, /answered in words/); assert.equal(words.links[0][1], 'Start a fresh case');
  assert.match(tourStage(view(store, id, [{ status: 'error' }]), ready).text, /stopped before the agent acted/);
  store.executePayment(id, attempt(view(store, id)));
  assert.match(tourStage(view(store, id, [{ status: 'limit' }]), ready).text, /refused it.*stopped without asking for review/);
});

test('a payment on the existing approval skips the decision and says why', t => {
  const { store, id } = start(t);
  store.recordProposal(id, report('DE00-TEST-0000-1280'), view(store, id).sourceDigest);
  assert.match(tourStage(view(store, id), ready).text, /asks to pay the same account/);
  store.executePayment(id, attempt(view(store, id)));
  const acted = tourStage(view(store, id, [{}]), ready);
  assert.equal(acted.step, 2); assert.match(acted.text, /paid the account ending 1280 with the existing approval/); assert.equal(acted.next, 'agent');
  assert.equal(tourStage(view(store, id, [{}]), { ...ready, seen: new Set(['agent']) }).step, 4);
});

test('declining ends the walkthrough truthfully', t => {
  const { store, id } = start(t);
  store.recordProposal(id, report(), view(store, id).sourceDigest);
  store.requestApproval(id, view(store, id).proposal.tuple);
  store.decline(id, decision(view(store, id).pendingReview));
  const declined = tourStage(view(store, id, [{}]), ready);
  assert.match(declined.text, /You declined/); assert.equal(declined.next, null);
});

test('the older unsigned flow keeps its four steps and never promises the proof checks', () => {
  const store = new WorkflowStore();
  try {
    const state = store.createWorkflow({ scenario: 'conflict' });
    assert.equal(tourStage(state).text, TOUR_TEXT.opening); assert.equal(tourStage(state).total, 4);
    store.requestApproval(state.workflowId, state.currentApproval && { operationId: state.operationId, supplierId: 'harbour-print', beneficiaryAccount: 'DE00-TEST-0000-1289', amountMinor: 25000000, currency: 'EUR' });
    const acted = tourStage({ ...store.state(state.workflowId), agentRuns: [{}] });
    assert.match(acted.text, /did not try to pay/);
  } finally { store.close(); }
});

test('the working message promises the steps at the end of the run, not as they happen', t => {
  const { store, id } = start(t);
  store.recordProposal(id, report(), view(store, id).sourceDigest);
  const working = tourStage(view(store, id), { ready: true, busy: true });
  assert.equal(working.text, 'The agent is working. Its steps will appear when this run finishes.');
  assert.doesNotMatch(working.text, /as it happens/);
  store.executePayment(id, attempt(view(store, id)));
  store.requestApproval(id, view(store, id).proposal.tuple);
  const midRun = tourStage({ ...view(store, id), running: true, agentRuns: [] }, ready);
  assert.equal(midRun.text, working.text);
});

test('the decision hint names the original account and does not ask for a match', t => {
  const { store, id } = start(t);
  store.recordProposal(id, report(), view(store, id).sourceDigest);
  store.requestApproval(id, view(store, id).proposal.tuple);
  const decide = tourStage(view(store, id, [{}]), { ...ready, seen: new Set(['agent']) });
  assert.equal(decide.step, 3);
  assert.equal(decide.hint, 'The original approval was for the account ending 1280. Tick the box if you accept these exact details, or decline.');
  const other = view(store, id, [{}]);
  const moved = tourStage({ ...other, originalAuthority: { ...other.originalAuthority, beneficiaryAccount: 'DE00-TEST-0000-4321' } }, { ...ready, seen: new Set(['agent']) });
  assert.match(moved.hint, /account ending 4321\./);
  const legacy = new WorkflowStore();
  try {
    const state = legacy.createWorkflow({ scenario: 'conflict' });
    legacy.requestApproval(state.workflowId, { operationId: state.operationId, supplierId: 'harbour-print', beneficiaryAccount: 'DE00-TEST-0000-1289', amountMinor: 25000000, currency: 'EUR' });
    assert.match(tourStage({ ...legacy.state(state.workflowId), agentRuns: [{}] }, { seen: new Set(['agent']) }).hint, /account ending 1280\./);
  } finally { legacy.close(); }
});

test('perform refreshes the walkthrough as soon as it is busy, before the call begins', async t => {
  const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const perform = source.match(/async function perform\(fn\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(perform, 'perform is in app.js');
  const element = { hidden: true, focus() {}, scrollIntoView() {} };
  const harness = new Function('$', 'isDocumentCase', 'state', `
    let busy = false, evidenceRequest = null, current = state;
    const rendered = [];
    const renderTour = tourState => rendered.push({ busy, tourState });
    const render = () => {}, updateButtons = () => {};
    ${perform}
    return { perform, rendered };`);
  const { store, id } = start(t);
  store.recordProposal(id, report(), view(store, id).sourceDigest);
  const state = view(store, id);
  const { perform: run, rendered } = harness(() => element, () => true, state);
  let shown = null;
  await run(async () => { shown = rendered.at(-1) ?? null; });
  assert.ok(shown, 'the walkthrough was rendered before the call started');
  assert.equal(shown.busy, true);
  assert.equal(shown.tourState, state);
  const stage = tourStage(shown.tourState, { ready: true, busy: shown.busy });
  assert.equal(stage.step, 2); assert.equal(stage.text, 'The agent is working. Its steps will appear when this run finishes.');
});

test('the walkthrough copy has no em dashes, and the page serves its module', async t => {
  const source = readFileSync(new URL('../walkthrough.js', import.meta.url), 'utf8');
  assert.equal(source.includes('\u2014'), false);
  assert.match(readFileSync(new URL('../index.html', import.meta.url), 'utf8'), /src="\/app\.js"/);
  assert.match(readFileSync(new URL('../app.js', import.meta.url), 'utf8'), /from '\/walkthrough\.js'/);
  const store = new WorkflowStore();
  const server = createServer({ store });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/walkthrough.js`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), source);
});
