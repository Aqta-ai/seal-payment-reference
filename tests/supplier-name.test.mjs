import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from '../server.mjs';
import { foldSupplierName, supplierNamesMatch } from '../supplier-name.js';
import { WorkflowStore } from '../src/workflow.mjs';
import { createReferenceSigner } from '../src/reference-journal.mjs';
import { AUTHORITY, caseInput, analyse, modelReport } from './document-fixtures.mjs';

const fixture = t => {
  const store = new WorkflowStore({ referenceSigner: createReferenceSigner() });
  t.after(() => store.close());
  return { store, state: store.createDocumentWorkflow(caseInput()) };
};
const payment = state => ({ approvalId: state.currentApproval.id, ...state.proposal.tuple });
// Ready reports only: every value carries a citation that matches the source line.
const reportFor = (state, changes) => { const report = modelReport(state, { account: AUTHORITY.beneficiaryAccount, supplierName: 'LIFFEY SUPPLIES' }); for (const [field, value] of Object.entries(changes)) report.candidate[field].value = value; return report; };

test('the same name in other capitals, spacing or compatibility forms matches', () => {
  for (const variant of ['Liffey Supplies', 'LIFFEY SUPPLIES', 'liffey supplies', '  Liffey   Supplies\t', 'Liffey Supplies', 'ＬＩＦＦＥＹ ＳＵＰＰＬＩＥＳ', 'Liﬀey Supplies']) assert.equal(supplierNamesMatch(variant, 'Liffey Supplies'), true, variant);
  assert.equal(supplierNamesMatch('Café Dublin', 'CAFÉ DUBLIN'), true);
  assert.equal(supplierNamesMatch('Straße Tools', 'STRASSE TOOLS'), true);
  assert.equal(supplierNamesMatch('ΣΑΣ', 'σας'), true);
});

test('a different name never matches, including lookalikes', () => {
  for (const variant of ['Liffey Supplies Ltd', 'Liffey', 'Liffey Supplise', 'Lifefy Supplies', 'LiffeySupplies',
    'Liffey Suррlies', // Cyrillic er, which NFKC does not unify with p
    'Іiffey Supplies', // Cyrillic capital i
    'Lıffey Supplies', // Dotless i, which an upper-then-lower fold would unify
    'Liffey​Supplies', 'Liffey​ Supplies',
    '', '   ', null, undefined, 7, {}, '\ud800']) assert.equal(supplierNamesMatch(variant, 'Liffey Supplies'), false, String(variant));
  assert.equal(supplierNamesMatch('', ''), false);
  assert.equal(supplierNamesMatch('   ', '\t'), false);
  assert.equal(foldSupplierName(null), '');
});

test('an invoice printing the supplier in capitals still pays, and the stored case reloads', async t => {
  const { store, state } = fixture(t);
  const ready = await analyse(store, state, { supplierName: 'LIFFEY SUPPLIES', account: AUTHORITY.beneficiaryAccount });
  assert.equal(ready.proposal.status, 'ready');
  assert.equal(ready.proposal.candidate.supplierName.value, 'LIFFEY SUPPLIES');
  assert.equal(ready.proposal.tuple.supplierId, AUTHORITY.supplierId);
  assert.equal(store.state(state.workflowId).proposal.status, 'ready');
  assert.equal(store.executePayment(state.workflowId, payment(ready)).status, 'committed');
  assert.equal(store.state(state.workflowId).ledger.length, 1);
});

test('lookalike suppliers through the real check become a clarification with nothing payable', async t => {
  for (const supplierName of ['Liffey Supplies Ltd', 'Liffey Supplise', 'Liffey Suррlies', 'Lıffey Supplies']) {
    const { store, state } = fixture(t);
    const recorded = await analyse(store, state, { supplierName, account: AUTHORITY.beneficiaryAccount });
    assert.equal(recorded.proposal.status, 'needs_clarification', supplierName);
    assert.equal(recorded.proposal.tuple, null);
    const attempt = { approvalId: state.currentApproval.id, operationId: state.operationId, supplierId: AUTHORITY.supplierId, beneficiaryAccount: AUTHORITY.beneficiaryAccount, amountMinor: AUTHORITY.amountMinor, currency: AUTHORITY.currency };
    assert.equal(store.executePayment(state.workflowId, attempt).reasonCode, 'PROPOSAL_NOT_READY');
    assert.equal(store.state(state.workflowId).ledger.length, 0);
  }
  const { store, state } = fixture(t);
  const empty = store.recordProposal(state.workflowId, reportFor(state, { supplierName: '' }), state.sourceDigest);
  assert.equal(empty.proposal.status, 'needs_clarification');
});

test('relaxing the name leaves account, amount and currency byte exact', t => {
  for (const [changes, reasonCode] of [
    [{ beneficiaryAccount: 'IE00-TEST-5601' }, 'ACCOUNT_MISMATCH'],
    [{ amountMinor: AUTHORITY.amountMinor + 1 }, 'AMOUNT_MISMATCH'],
    [{ currency: 'USD' }, 'CURRENCY_MISMATCH'],
  ]) {
    const { store, state } = fixture(t);
    const recorded = store.recordProposal(state.workflowId, reportFor(state, changes), state.sourceDigest);
    assert.equal(recorded.proposal.status, 'ready');
    assert.equal(store.executePayment(state.workflowId, payment(recorded)).reasonCode, reasonCode);
    assert.equal(store.state(state.workflowId).ledger.length, 0);
  }
  for (const beneficiaryAccount of ['ie00-test-5600', 'IE00 TEST 5600', ' IE00-TEST-5600']) {
    const { store, state } = fixture(t);
    const recorded = store.recordProposal(state.workflowId, reportFor(state, { beneficiaryAccount }), state.sourceDigest);
    assert.equal(recorded.proposal.status, 'needs_clarification', beneficiaryAccount);
  }
});

test('the server serves every absolute local JavaScript import used by the page module', async t => {
  const store = new WorkflowStore();
  const server = createServer({ store });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const imports = [...app.matchAll(/from '\/([\w.-]+\.js)'/g)];
  assert.ok(imports.length > 0);
  for (const [, file] of imports) {
    const response = await fetch(`${origin}/${file}`);
    assert.equal(response.status, 200, file);
    assert.equal(await response.text(), readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), file);
  }
});
