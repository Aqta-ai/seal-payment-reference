import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const source = app.slice(app.indexOf('const bench = '), app.indexOf('\nfunction downloadRecord('));

function fixture(verifyProofRecord = async () => ({ valid: true }), payment = { amountMinor: 25000000, beneficiaryAccount: 'DE00-TEST-0000-1280', currency: 'EUR' }) {
  const elements = new Map();
  const $ = id => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', dataset: {}, hidden: false, disabled: false, handlers: {}, attributes: {},
      addEventListener(type, handler) { this.handlers[type] = handler; }, setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; } });
    return elements.get(id);
  };
  const record = { ledger: payment ? [payment] : [], events: [{ type: 'payment_committed' }] };
  const context = { id: 'workflow_one', operationId: 'operation_one', sourceDigest: 'source_one', head: 'head_one', ledgerKey: JSON.stringify(record.ledger) };
  const sandbox = { $, json: JSON.stringify, ledgerStateKey: JSON.stringify, verifyProofRecord, record, context,
    proofChecks: { key: 'record_one' }, current: { workflowId: context.id, operationId: context.operationId, sourceDigest: context.sourceDigest, referenceJournal: { head: context.head }, ledger: record.ledger } };
  vm.createContext(sandbox); vm.runInContext(source, sandbox); sandbox.benchShow(record, context);
  return { $, sandbox, original: $('bench-json').value, input: value => { $('bench-json').value = value; $('bench-json').handlers.input(); },
    field: (name, value) => { $(`bench-${name}`).value = value; $(`bench-${name}`).handlers.input(); },
    check: () => $('bench-check').handlers.click(), reset: () => $('bench-reset').handlers.click() };
}

test('copy fields edit only the corresponding ledger value and preserve the signed events', async () => {
  const checked = [];
  const f = fixture(async record => { checked.push(record); return { valid: false, failure: { code: 'VERIFICATION_INCOMPLETE' }, where: { ledger: true } }; });
  const original = JSON.parse(f.original);
  assert.equal(f.$('bench-amount').value, '250000.00');
  assert.equal(f.$('bench-original-account').textContent, original.ledger[0].beneficiaryAccount);
  for (const [name, field, text, value] of [
    ['amount', 'amountMinor', '250000.01', 25000001],
    ['account', 'beneficiaryAccount', 'DE00-TEST-0000-1289', 'DE00-TEST-0000-1289'],
    ['currency', 'currency', 'USD', 'USD'],
  ]) {
    f.reset(); f.field(name, text);
    const expected = structuredClone(original); expected.ledger[0][field] = value;
    assert.deepEqual(JSON.parse(f.$('bench-json').value), expected);
    assert.equal(f.$('bench-json').dataset.state, 'edited');
    assert.equal(f.$(`bench-${name}-change`).textContent, 'Changed');
    assert.equal(f.$('bench-status').dataset.result, undefined);
    await f.check();
    assert.equal(f.$('bench-status').textContent, 'Rejected at the exported ledger: it no longer matches the signed payment events.');
  }
  assert.equal(checked.length, 3);
});

test('invalid decimal amounts cannot check an older valid JSON copy', async () => {
  let calls = 0;
  const f = fixture(async () => { calls += 1; return { valid: true }; });
  for (const value of ['', '-1', '0', '1.001', '1e3', '90071992547409.92']) {
    f.reset(); f.field('amount', value);
    assert.equal(f.$('bench-json').value, f.original);
    assert.equal(f.$('bench-json').dataset.state, 'edited');
    assert.equal(f.$('bench-status').dataset.result, 'error');
    assert.equal(f.$('bench-amount').attributes['aria-invalid'], 'true');
    assert.equal(f.$('bench-check').disabled, true);
    await f.check();
  }
  assert.equal(calls, 0);
  f.field('amount', '0.01');
  assert.equal(JSON.parse(f.$('bench-json').value).ledger[0].amountMinor, 1);
  assert.equal(f.$('bench-check').disabled, false);
  assert.equal(f.$('bench-amount').attributes['aria-invalid'], undefined);
});

test('raw JSON edits synchronise copy fields and preserve arbitrary edits through form changes', () => {
  const f = fixture();
  const edited = JSON.parse(f.original);
  edited.ledger[0] = { ...edited.ledger[0], amountMinor: 101, beneficiaryAccount: 'DE00-TEST-0000-1289', currency: 'USD' };
  edited.note = 'unsigned annotation'; edited.events[0].reviewerNote = 'kept for inspection';
  f.input(JSON.stringify(edited));
  assert.equal(f.$('bench-amount').value, '1.01');
  assert.equal(f.$('bench-account').value, edited.ledger[0].beneficiaryAccount);
  assert.equal(f.$('bench-currency').value, 'USD');
  assert.equal(f.$('bench-original-amount').textContent, '250000.00');
  f.field('amount', '2.02'); edited.ledger[0].amountMinor = 202;
  assert.deepEqual(JSON.parse(f.$('bench-json').value), edited);
});

test('raw copies without one editable payment disable fields while retaining the JSON checker', async () => {
  const f = fixture();
  for (const text of ['null', '{', '{"ledger":[]}', '{"ledger":[null]}', '{"ledger":[{},{}]}']) {
    f.input(text);
    for (const name of ['amount', 'account', 'currency']) assert.equal(f.$(`bench-${name}`).disabled, true);
    assert.match(f.$('bench-fields-note').textContent, /Edit Technical details or reset/);
    assert.equal(f.$('bench-check').disabled, false);
  }
  f.reset();
  assert.equal(f.$('bench-json').value, f.original);
  assert.equal(f.$('bench-amount').disabled, false);
  f.sandbox.benchClear();
  assert.equal(f.$('bench-check').disabled, true);
  assert.equal(f.$('bench-json').disabled, true);
  assert.match(f.$('bench-fields-note').textContent, /Verify a signed payment record/);
});

test('form edits invalidate pending results even when invalid input leaves the JSON unchanged', async () => {
  for (const value of ['250000.01', 'invalid', '250000.00']) {
    let release;
    const f = fixture(() => new Promise(resolve => { release = resolve; }));
    const check = f.check(); f.field('amount', value);
    const state = f.$('bench-json').dataset.state, status = f.$('bench-status').textContent;
    release({ valid: true }); await check;
    assert.equal(f.$('bench-json').dataset.state, state);
    assert.equal(f.$('bench-status').textContent, status);
    assert.notEqual(f.$('bench-status').dataset.result, 'passed');
  }
});

test('reset restores the exact record and all fields without calling the verifier', () => {
  let calls = 0;
  const f = fixture(async () => { calls += 1; return { valid: true }; });
  f.field('account', 'DE00-TEST-0000-1289'); f.field('amount', 'invalid'); f.reset();
  assert.equal(f.$('bench-json').value, f.original);
  assert.equal(f.$('bench-amount').value, '250000.00');
  assert.equal(f.$('bench-account').value, 'DE00-TEST-0000-1280');
  assert.equal(f.$('bench-currency').value, 'EUR');
  assert.equal(f.$('bench-check').disabled, false);
  assert.equal(f.$('bench-status').dataset.result, 'passed');
  assert.equal(calls, 0);
});

test('the bench rejects non-object JSON before calling the verifier', async () => {
  let calls = 0;
  const f = fixture(async () => { calls += 1; return { valid: true }; });
  for (const text of ['null', '[]', '1', 'true', '"record"', '{']) {
    f.input(text); await f.check();
    assert.equal(f.$('bench-json').dataset.state, 'rejected');
    assert.equal(f.$('bench-status').dataset.result, 'error');
    assert.equal(f.$('bench-status').textContent.includes('Checking'), false);
  }
  assert.equal(calls, 0);
});

test('the bench contains an asynchronous verifier failure', async () => {
  const f = fixture(async () => { throw new TypeError('private shape detail'); });
  await f.check();
  assert.equal(f.$('bench-json').dataset.state, 'rejected');
  assert.match(f.$('bench-status').textContent, /No verification result was established/);
  assert.equal(f.$('bench-status').textContent.includes('private shape detail'), false);
});

test('editing during a check invalidates its later valid result', async () => {
  let release;
  const f = fixture(() => new Promise(resolve => { release = resolve; }));
  const check = f.check();
  const edited = JSON.parse(f.original); edited.ledger[0].amountMinor += 1; f.input(JSON.stringify(edited));
  release({ valid: true }); await check;
  assert.equal(f.$('bench-json').dataset.state, 'edited');
  assert.equal(f.$('bench-status').textContent, 'Edited. Press Check this copy.');
});

test('reset invalidates a pending rejected result', async () => {
  let release;
  const f = fixture(() => new Promise(resolve => { release = resolve; }));
  f.input('{"ledger":[]}'); const check = f.check(); f.reset();
  release({ valid: false, failure: { code: 'HASH_MISMATCH' } }); await check;
  assert.equal(f.$('bench-json').value, f.original);
  assert.equal(f.$('bench-json').dataset.state, 'verified');
  assert.equal(f.$('bench-status').textContent, 'Reset. This copy matches the signed record.');
});

test('a newer check keeps its verdict when an older check completes', async () => {
  const releases = [];
  const f = fixture(() => new Promise(resolve => { releases.push(resolve); }));
  const first = f.check(), second = f.check();
  releases[1]({ valid: false, failure: { code: 'HASH_MISMATCH' } }); await second;
  const status = f.$('bench-status').textContent;
  releases[0]({ valid: true }); await first;
  assert.equal(f.$('bench-json').dataset.state, 'rejected'); assert.equal(f.$('bench-status').textContent, status);
});

test('clearing or replacing the current record invalidates an in-flight result', async () => {
  for (const change of [f => f.sandbox.benchClear(), f => { f.sandbox.current = { ...f.sandbox.current, workflowId: 'workflow_two' }; }]) {
    let release;
    const f = fixture(() => new Promise(resolve => { release = resolve; }));
    const check = f.check(); change(f);
    const state = f.$('bench-json').dataset.state, status = f.$('bench-status').textContent;
    release({ valid: true }); await check;
    assert.equal(f.$('bench-json').dataset.state, state); assert.equal(f.$('bench-status').textContent, status);
  }
});

test('failure wording uses the verifier code without guessing an edited event or field', async () => {
  const f = fixture(async () => ({ valid: false, failure: { code: 'HASH_MISMATCH' } }));
  const edited = JSON.parse(f.original); edited.events[0].reviewerNote = 'unsigned annotation';
  f.input(JSON.stringify(edited)); await f.check();
  assert.equal(f.$('bench-status').textContent, 'Rejected: an event hash no longer matches. Code HASH_MISMATCH.');
  assert.equal(f.$('bench-status').textContent.includes('reviewerNote'), false);
  assert.equal(f.$('bench-status').textContent.includes('event 1'), false);
});

test('failure wording names only the place the verifier reports', async () => {
  const worded = async result => {
    const f = fixture(async () => result);
    const edited = JSON.parse(f.original); edited.events[0].reviewerNote = 'unsigned annotation';
    f.input(JSON.stringify(edited)); await f.check();
    assert.equal(f.$('bench-json').dataset.state, 'rejected');
    return f.$('bench-status').textContent;
  };
  assert.equal(await worded({ valid: false, failure: { code: 'VERIFICATION_INCOMPLETE' }, where: { ledger: true } }),
    'Rejected at the exported ledger: it no longer matches the signed payment events.');
  assert.equal(await worded({ valid: false, failure: { code: 'HASH_MISMATCH' }, where: { event: 7, type: 'payment_committed' } }),
    'Rejected at event 7 (payment committed): an event hash no longer matches. Code HASH_MISMATCH.');
  assert.equal(await worded({ valid: false, failure: { code: 'VERIFICATION_INCOMPLETE' }, where: { event: 2 } }),
    'Rejected at event 2: it no longer matches the signed record. Code VERIFICATION_INCOMPLETE.');
  assert.equal(await worded({ valid: false, failure: { code: 'VERIFICATION_INCOMPLETE' }, where: { head: true } }),
    'Rejected: the record no longer ends at the head pinned for this case. Code VERIFICATION_INCOMPLETE.');
  assert.equal(await worded({ valid: false, failure: { code: 'VERIFICATION_INCOMPLETE' } }),
    'Rejected: the record could not be verified. Code VERIFICATION_INCOMPLETE.');
});
