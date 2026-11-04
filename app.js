import { supplierNamesMatch } from '/supplier-name.js';
import { OWN_DOCUMENTS, REASONS, tourStage } from '/walkthrough.js';

const $ = id => document.getElementById(id);
let current = null;
let busy = false;
let configured = false;
let providerLabel = 'Model';
let renderedReviewId = null;
let documentFlow = false;
let hostedDemo = false;
const proofChecks = { key: null, original: false, edited: false, repeat: false };
const json = value => JSON.stringify(value, null, 2);
const money = tuple => new Intl.NumberFormat('en-IE', { style: 'currency', currency: tuple.currency }).format(tuple.amountMinor / 100);
const pending = state => state.pendingReview?.status === 'awaiting_human' ? state.pendingReview : null;

function showAccounts(original, requested) {
  $('approved-account').textContent = original;
  $('requested-account').replaceChildren();
  let same = 0;
  while (same < original.length && original[same] === requested[same]) same += 1;
  $('requested-account').append(document.createTextNode(requested.slice(0, same)));
  if (same < requested.length) {
    const changed = document.createElement('mark'); changed.textContent = requested.slice(same);
    $('requested-account').append(changed);
  }
}

async function api(path, body, operator = false, signal) {
  const response = await fetch(path, { ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json', ...(operator ? { 'X-Operator-Action': 'review' } : {}) }, body: json(body) } : {}), ...(signal ? { signal } : {}) });
  let value;
  try { value = await response.json(); }
  catch { throw new Error(response.ok ? 'The server sent an unreadable reply. Reload and try again.' : `The server is busy or unavailable (${response.status}). Try again in a moment.`); }
  if (!response.ok) {
    const error = new Error(value.error || value.reason || 'The operation did not complete.');
    error.status = response.status;
    throw error;
  }
  return value;
}

function documentSummary(text) {
  return String(text).split('\n').filter(line => !/^(Synthetic |Supplier ID:|Operation ID:)/.test(line)).join('\n')
    .replace('Amount (minor units): 25000000', 'Amount: €250,000.00')
    .replace('25000000 minor units in EUR', '€250,000.00 EUR');
}

function selectDocument(name, focus = false) {
  for (const item of ['email', 'invoice']) {
    const selected = name === item;
    $(`tab-${item}`).setAttribute('aria-selected', String(selected));
    $(`tab-${item}`).tabIndex = selected ? 0 : -1;
    $(`${item}-panel`).hidden = !selected;
  }
  if (focus) $(`tab-${name}`).focus();
}

for (const name of ['email', 'invoice']) {
  $(`tab-${name}`).addEventListener('click', () => selectDocument(name));
  $(`tab-${name}`).addEventListener('keydown', event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      selectDocument(event.key === 'Home' ? 'email' : event.key === 'End' ? 'invoice' : name === 'email' ? 'invoice' : 'email', true);
    }
  });
}

const modelName = model => /scripted/.test(model || '') ? 'Scripted preview' : 'Agent';

function describeStep(entry, waiting) {
  const args = entry.arguments || {}, result = entry.result || {};
  const amount = Number.isSafeInteger(args.amountMinor) && ['EUR', 'GBP', 'USD'].includes(args.currency) ? money(args) : 'a payment';
  const account = typeof args.beneficiaryAccount === 'string' ? args.beneficiaryAccount : 'an account';
  if (entry.name === 'read_documents') return { text: 'Read the invoice and the supplier’s message', tone: 'neutral' };
  if (entry.name === 'execute_payment') {
    if (result.status === 'committed') return { text: `Paid ${amount} to ${account}`, chip: 'Recorded once', tone: 'ok' };
    return { text: `Tried to pay ${amount} to ${account}`, chip: `Refused: ${REASONS[result.reasonCode] || 'not permitted by the approval'}`, tone: 'bad' };
  }
  if (entry.name === 'request_approval') return { text: `Asked a person to approve ${amount} to ${account}`, chip: waiting ? 'Waiting for you' : 'Sent for review', tone: waiting ? 'wait' : 'neutral' };
  return { text: `Called ${String(entry.name || 'a tool')}`, tone: 'neutral' };
}

function renderSteps(state) {
  const list = $('steps'); list.replaceChildren();
  const add = (meta, { text, chip, tone }, title) => {
    const li = document.createElement('li'); li.className = `step is-${tone}`;
    const top = document.createElement('span'); top.className = 'step-meta'; top.textContent = meta; if (title) top.title = title;
    const body = document.createElement('span'); body.className = 'step-text'; body.textContent = text;
    li.append(top, body);
    if (chip) { const badge = document.createElement('span'); badge.className = 'step-chip'; badge.textContent = chip; li.append(badge); }
    list.append(li);
  };
  let number = 0;
  (state.agentRuns || []).forEach((run, index) => {
    for (const entry of run.trace || []) {
      if (entry.type !== 'tool_result') continue;
      number += 1;
      add(`${modelName(entry.model || run.model)} · step ${number}`, describeStep(entry, entry.name === 'request_approval' && Boolean(pending(state)) && index === state.agentRuns.length - 1), entry.model || run.model || '');
    }
    const decision = (state.operatorEvents || [])[index];
    if (decision) add('You · review screen', decision.action === 'approve' ? { text: 'Approved this exact amount and account', chip: 'One use', tone: 'ok' } : { text: 'Declined the changed account', chip: 'Nothing paid', tone: 'bad' });
  });
  list.hidden = !list.children.length;
}

const TOUR_KEY = 'seal-walkthrough';
const touring = () => { try { return sessionStorage.getItem(TOUR_KEY) === 'on'; } catch { return false; } };
let tourSeen = { id: null, stages: new Set() };
let tourFocusKey = null;
function renderTour(state) {
  document.querySelectorAll('.tour-focus').forEach(node => node.classList.remove('tour-focus'));
  $('tour').hidden = !touring();
  if (!touring()) return;
  const id = state?.workflowId ?? null;
  if (tourSeen.id !== id) tourSeen = { id, stages: new Set() };
  const stage = tourStage(state, { busy, ready: state?.version === 2 && readyProposal(state), seen: tourSeen.stages, proof: proofChecks });
  $('tour-step').textContent = `Step ${stage.step} of ${stage.total}`;
  $('tour-text').textContent = stage.text;
  $('tour-hint').textContent = stage.hint || '';
  $('tour-hint').hidden = !stage.hint;
  $('tour-next').hidden = !stage.next;
  $('tour-next').dataset.stage = stage.next || '';
  for (const [index, id] of ['tour-link', 'tour-link-2'].entries()) {
    const link = stage.links[index];
    $(id).hidden = !link;
    if (link) { $(id).href = link[0]; $(id).textContent = link[1]; }
  }
  const target = stage.target && $(stage.target);
  if (!target || target.hidden) return;
  target.classList.add('tour-focus');
  // Only when the step moves, and only once the run view is on screen, so reading is never interrupted.
  const key = `${id}|${stage.step}|${stage.target}`;
  if (key !== tourFocusKey && target.offsetParent) { tourFocusKey = key; target.scrollIntoView({ block: 'center' }); }
}
$('tour-next').addEventListener('click', () => { tourSeen.stages.add($('tour-next').dataset.stage); renderTour(current); });
for (const id of ['tour-link', 'tour-link-2']) $(id).addEventListener('click', event => { if (event.currentTarget.getAttribute('href') === OWN_DOCUMENTS[0]) { try { sessionStorage.removeItem(TOUR_KEY); } catch {} } });
$('tour-end').addEventListener('click', () => { try { sessionStorage.removeItem(TOUR_KEY); } catch {} renderTour(current); });
if (new URLSearchParams(location.search).get('tour') === '1') { try { sessionStorage.setItem(TOUR_KEY, 'on'); } catch {} }
renderTour(null);

const RON = {
  idle: ['think', 'Will the old approval cover the new account?'],
  working: ['inspect', 'Reading the invoice and the letter…'],
  refused: ['stamp', 'That account was not approved. Stopped.'],
  waiting: ['phone', 'Your turn: approve the exact payment, or decline.'],
  approved: ['phone', 'Approved once. The agent can finish now.'],
  paid: ['cheer', 'Paid once, to the account you approved.'],
  declined: ['stamp', 'Declined. Nothing left the account.'],
};
function renderRon(state) {
  const review = state && pending(state);
  const key = !state ? 'idle' : state.ledger?.length ? 'paid' : state.events?.some(event => event.type === 'operator_declined') ? 'declined'
    : review ? (state.events?.some(event => event.type === 'payment_blocked') ? 'refused' : 'waiting')
    : state.currentApproval?.source === 'operator_review' ? 'approved' : (busy || state.running) ? 'working' : 'idle';
  const [pose, line] = RON[key];
  if (!$('ron-pose').src.endsWith(`/ron/ron-${pose}.png`)) $('ron-pose').src = `/ron/ron-${pose}.png`;
  $('ron-line').textContent = line;
}

function renderAccount(state) {
  const sent = state.ledger.reduce((total, payment) => total + payment.amountMinor, 0);
  const currency = state.ledger[0]?.currency || state.currentApproval?.currency || 'EUR';
  $('money-sent').textContent = money({ amountMinor: sent, currency });
  $('money-sent').classList.toggle('is-paid', sent > 0);
  $('account-empty').hidden = state.ledger.length > 0;
}

function renderEvents(state) {
  $('trace').replaceChildren();
  const labels = {
    payment_blocked: ['Payment refused', 'blocked'],
    proposal_recorded: ['Document analysis recorded', 'pending'],
    approval_requested: ['Human review requested', 'pending'],
    operator_approved: ['New payment details approved', 'approved'],
    operator_declined: ['Change declined', 'blocked'],
    payment_committed: ['One payment recorded', 'approved'],
  };
  const events = state.events.filter(event => labels[event.type]);
  if (!events.length) return;
  const list = document.createElement('ol');
  for (const event of events) {
    const [label, tone] = labels[event.type];
    const li = document.createElement('li');
    li.className = tone;
    const text = document.createElement('span'); text.textContent = label; li.append(text);
    if (event.details?.reasonCode) {
      const detail = document.createElement('small');
      detail.textContent = ({ ACCOUNT_MISMATCH: 'Account differs from approval', OPERATION_ALREADY_COMMITTED: 'This operation is already paid', APPROVAL_EXPIRED: 'Approval expired', APPROVAL_SUPERSEDED: 'Approval replaced' })[event.details.reasonCode] || 'See the event record for details';
      detail.title = event.details.reasonCode;
      li.append(detail);
    }
    list.append(li);
  }
  $('trace').append(list);
}

const fields = [['supplierName', 'Supplier'], ['beneficiaryAccount', 'Account'], ['amountMinor', 'Amount'], ['currency', 'Currency']];
let formGeneration = 0;
let evidenceGeneration = 0;
let observationTimer = null;
let pinnedReferenceKey = null;
let evidenceRequest = null;
const fileLoads = new Set();
const textVersions = { invoice: 0, instruction: 0 };
const isDocumentCase = state => state?.version === 2;
function workflowScope(state) {
  const events = state.events || [], journal = state.referenceJournal;
  const signed = journal?.profile === 'SEAL-REFERENCE-EVENT-v1' && events.length > 0
    && events.every(event => event.proof?.profile === journal.profile && event.proof.publicKey === journal.publicKey && typeof event.proof.signature === 'string');
  const signing = signed ? 'Events are signed with a demo reference key, separate from production Seal.'
    : events.some(event => event.proof) ? 'A complete set of demo reference signatures is unavailable.' : 'Events are unsigned.';
  return `One demo ledger. ${signing} No bank or external payment service is connected. The review screen does not establish real-world identity. Verifying a supplier’s account remains a separate business check.`;
}
const minorDecimal = value => { const minor = BigInt(value); return `${minor / 100n}.${String(minor % 100n).padStart(2, '0')}`; };
const fieldValue = (field, value, currency) => field === 'amountMinor' ? currency ? money({ amountMinor: value, currency }) : `${minorDecimal(value)} (currency needed)` : String(value);
const sourceName = id => id === 'invoice' ? 'Invoice' : 'Later message';
const proposalCurrency = state => validEntry(state, 'currency', state.proposal?.candidate?.currency) ? state.proposal.candidate.currency.value : null;

function validEntry(state, field, entry) {
  if (!entry || !entry.citation) return false;
  const { value, citation } = entry;
  const validValue = field === 'amountMinor' ? Number.isSafeInteger(value) && value > 0
    : field === 'currency' ? ['EUR', 'GBP', 'USD'].includes(value)
    : field === 'beneficiaryAccount' ? typeof value === 'string' && /^[A-Z0-9][A-Z0-9-]{4,63}$/.test(value)
    : typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 160;
  const document = state.documents?.find(item => item.id === citation.documentId);
  const line = document?.lines?.find(item => item.number === citation.line);
  return validValue && Number.isSafeInteger(citation.line) && typeof citation.quote === 'string' && citation.quote.trim().length > 0 && Boolean(line?.text.includes(citation.quote));
}

function readyProposal(state) {
  const proposal = state?.proposal;
  return Boolean(proposal?.status === 'ready' && proposal.referenceConsistency === true && proposal.sourceDigest === state.sourceDigest
    && proposal.questions?.length === 0 && fields.every(([field]) => validEntry(state, field, proposal.candidate?.[field]))
    && supplierNamesMatch(proposal.candidate.supplierName.value, state.originalAuthority.supplierName)
    && proposal.tuple?.operationId === state.operationId && proposal.tuple?.supplierId === state.originalAuthority.supplierId && ['beneficiaryAccount', 'amountMinor', 'currency'].every(field => proposal.tuple[field] === proposal.candidate[field].value));
}

function showPhases(state) {
  $('document-phases').hidden = !documentFlow || (!isDocumentCase(state) && $('document-entry').hidden);
  const phase = !isDocumentCase(state) || !state.proposal ? 'documents'
    : state.ledger.length || state.events.some(event => event.type === 'operator_declined') ? 'outcome'
    : pending(state) || state.currentApproval?.source === 'operator_review' ? 'decision' : 'proposal';
  for (const item of $('document-phases').children) {
    item.classList.toggle('is-current', item.dataset.phase === phase);
    if (item.dataset.phase === phase) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  }
}

function renderNumberedDocument(sourceDocument) {
  const target = $(sourceDocument.id === 'invoice' ? 'invoice' : 'email');
  target.replaceChildren();
  target.classList.add('numbered-document');
  for (const line of sourceDocument.lines) {
    const row = document.createElement('span');
    row.className = 'source-line'; row.dataset.sourceLine = line.id; row.tabIndex = -1;
    const number = document.createElement('span'); number.className = 'line-number'; number.textContent = String(line.number); number.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span'); text.className = 'line-text'; text.textContent = line.text || ' ';
    row.append(number, text); target.append(row);
  }
}

function highlightSource(state, citation) {
  if (current?.workflowId !== state.workflowId || current.sourceDigest !== state.sourceDigest) return;
  selectDocument(citation.documentId === 'invoice' ? 'invoice' : 'email');
  document.querySelectorAll('[data-source-line]').forEach(row => { row.classList.remove('is-source-highlight'); const text = row.querySelector('.line-text'); text.textContent = text.textContent; });
  const documentSource = state.documents.find(item => item.id === citation.documentId);
  const line = documentSource.lines.find(item => item.number === citation.line);
  const row = [...document.querySelectorAll('[data-source-line]')].find(item => item.dataset.sourceLine === line.id);
  if (!row) return;
  row.classList.add('is-source-highlight');
  const text = row.querySelector('.line-text');
  const position = line.text.indexOf(citation.quote);
  const mark = document.createElement('mark'); mark.textContent = citation.quote;
  text.replaceChildren(document.createTextNode(line.text.slice(0, position)), mark, document.createTextNode(line.text.slice(position + citation.quote.length)));
  row.focus({ preventScroll: true }); row.scrollIntoView({ block: 'nearest', behavior: 'auto' });
}

function renderProposal(state) {
  const proposal = state.proposal;
  const ready = readyProposal(state);
  $('proposal').hidden = !proposal;
  $('proposal-facts').replaceChildren(); $('proposal-questions').replaceChildren();
  $('proposal-heading').textContent = ready ? 'Proposed payment' : 'One more detail is needed';
  $('proposal-note').textContent = 'Check each value against its quoted source. Matching a quote does not establish that the model interpreted it correctly.';
  if (proposal) {
    for (const [field, label] of fields) {
      const entry = proposal.candidate?.[field];
      const valid = validEntry(state, field, entry);
      const row = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = label;
      const value = document.createElement('strong');
      value.textContent = valid ? fieldValue(field, entry.value, proposalCurrency(state)) : 'Needs clarification';
      dd.append(value);
      if (valid) {
        const quote = document.createElement('blockquote'); quote.textContent = entry.citation.quote;
        const button = document.createElement('button'); button.type = 'button'; button.className = 'source-link';
        button.textContent = `${sourceName(entry.citation.documentId)}, line ${entry.citation.line}`;
        button.setAttribute('aria-label', `Show source for ${label.toLowerCase()}: ${sourceName(entry.citation.documentId)}, line ${entry.citation.line}`);
        button.addEventListener('click', () => highlightSource(state, entry.citation));
        dd.append(quote, button);
      }
      row.append(dt, dd); $('proposal-facts').append(row);
    }
    for (const question of proposal.questions || []) { const item = document.createElement('li'); item.textContent = question; $('proposal-questions').append(item); }
    if (!ready && !proposal.questions?.length) { const item = document.createElement('li'); item.textContent = 'A complete proposal with valid source references is needed. Update the documents in a new case.'; $('proposal-questions').append(item); }
  }
  $('comparison-values').replaceChildren();
  for (const [field, label] of fields) {
    const row = document.createElement('tr'), heading = document.createElement('th'); heading.scope = 'row'; heading.textContent = label; row.append(heading);
    const entry = proposal?.candidate?.[field];
    const original = document.createElement('td'); original.textContent = fieldValue(field, state.originalAuthority[field], state.originalAuthority.currency);
    const proposed = document.createElement('td'); proposed.textContent = validEntry(state, field, entry) ? fieldValue(field, entry.value, proposalCurrency(state)) : proposal ? 'Needs clarification' : 'Awaiting analysis';
    if (validEntry(state, field, entry) && (field === 'supplierName' ? !supplierNamesMatch(entry.value, state.originalAuthority.supplierName) : entry.value !== state.originalAuthority[field])) { proposed.className = 'changed-value'; const note = document.createElement('span'); note.className = 'change-label'; note.textContent = 'Changed'; proposed.append(note); }
    row.append(original, proposed); $('comparison-values').append(row);
  }
  $('analyse-documents').hidden = Boolean(proposal);
  $('analysis-note').hidden = Boolean(proposal);
  $('continue-proposal').hidden = !ready || Boolean(pending(state)) || Boolean(state.ledger.length) || state.currentApproval?.source === 'operator_review' || state.events.some(event => event.type === 'operator_declined');
}

function renderDocumentCase(state) {
  $('source-supplier').textContent = state.originalAuthority.supplierName;
  $('source-mode').textContent = 'Saved test documents';
  for (const source of state.documents) renderNumberedDocument(source);
  $('email-panel').querySelector('.document-title').textContent = 'Later message';
  $('invoice-panel').querySelector('.document-title').textContent = 'Invoice';
  renderProposal(state);
  $('reference-metadata').textContent = json({ sourceDigest: state.sourceDigest, proposalDigest: state.proposalDigest, extraction: state.proposal?.analysis || null, journal: state.referenceJournal });
  $('scope-note').textContent = workflowScope(state);
  if (!state.proposal) $('agent-heading').textContent = state.analysing ? 'Reading the documents…' : 'Documents saved. Ready to read.';
  else if (!readyProposal(state)) $('agent-heading').textContent = 'One more detail is needed.';
  else if (!busy && !state.running && !state.agentRuns?.length && !pending(state) && !state.ledger.length && state.currentApproval?.source !== 'operator_review' && !state.events.some(event => event.type === 'operator_declined')) $('agent-heading').textContent = 'Review the proposed details.';
  if (state.ledger.length) $('agent-heading').textContent = 'Payment recorded in this simulation.';
}

function openDocumentForm(fromCurrent = false) {
  if (busy || !documentFlow) return;
  formGeneration += 1; fileLoads.clear(); evidenceGeneration += 1; evidenceRequest = null;
  if (fromCurrent && isDocumentCase(current)) {
    $('permission-name').value = current.originalAuthority.supplierName;
    $('permission-account').value = current.originalAuthority.beneficiaryAccount;
    $('permission-amount').value = minorDecimal(current.originalAuthority.amountMinor);
    $('permission-currency').value = current.originalAuthority.currency;
    for (const source of current.documents) $(`input-${source.kind}`).value = source.text;
  }
  $('permission-confirm').checked = false;
  for (const kind of ['invoice', 'instruction']) { $(`file-${kind}`).value = ''; $(`${kind}-file-status`).textContent = ''; }
  $('form-error').hidden = true; $('document-entry').hidden = false;
  document.querySelector('.workbench').hidden = true;
  $('inspection').hidden = true;
  $('proof-checks').hidden = true;
  $('use-documents').setAttribute('aria-expanded', 'true');
  showPhases(null); updateButtons(); $('document-entry-heading').focus();
}

function closeDocumentForm() {
  formGeneration += 1; fileLoads.clear();
  $('document-entry').hidden = true; document.querySelector('.workbench').hidden = false;
  $('inspection').hidden = false;
  $('proof-checks').hidden = !isDocumentCase(current) || current.ledger.length !== 1;
  $('use-documents').setAttribute('aria-expanded', 'false'); showPhases(current); updateButtons();
}

function checkedText(raw, label) {
  if (typeof raw !== 'string' || !raw.isWellFormed() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(raw)) throw new Error(`${label} must be valid UTF-8 text without control characters.`);
  const text = raw.replace(/^\uFEFF/u, '').replace(/\r\n?/g, '\n').normalize('NFC');
  if (!text.trim() || raw.length > 12000 || text.length > 12000) throw new Error(`${label} needs text within 12,000 characters.`);
  const lines = text.split('\n');
  if (lines.length > 300 || lines.some(line => line.length > 2000)) throw new Error(`${label} exceeds 300 lines or 2,000 characters on one line.`);
  return text;
}

function documentInput() {
  const text = $('permission-amount').value.trim();
  if (!/^[0-9]+(?:\.[0-9]{1,2})?$/.test(text)) throw new Error('Enter a positive decimal amount with up to two decimal places.');
  const [whole, fraction = ''] = text.split('.');
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (amount < 1n || amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('The amount must be positive and fit within the simulation’s numeric limit.');
  if (!['EUR', 'GBP', 'USD'].includes($('permission-currency').value)) throw new Error('Choose EUR, GBP or USD for the original permission.');
  const name = $('permission-name').value.trim();
  const account = $('permission-account').value.trim();
  if (!name || !name.isWellFormed() || name.length > 160 || /[\r\n\u0000-\u001f\u007f]/u.test(name)) throw new Error('Enter a supplier name on one line, within 160 characters.');
  if (!/^[A-Z0-9][A-Z0-9-]{4,63}$/.test(account)) throw new Error('Use an account of 5 to 64 uppercase letters, digits or hyphens.');
  if (!$('permission-confirm').checked) throw new Error('Confirm the displayed original permission before creating this synthetic case.');
  const documents = ['invoice', 'instruction'].map(kind => ({ kind, text: checkedText($(`input-${kind}`).value, sourceName(kind)) }));
  if (documents.reduce((total, item) => total + item.text.length, 0) > 24000) throw new Error('Keep both documents within 24,000 characters in total.');
  const body = { originalAuthority: { supplierId: `supplier_${crypto.randomUUID()}`, supplierName: name, beneficiaryAccount: account, amountMinor: Number(amount), currency: $('permission-currency').value }, documents };
  if (new TextEncoder().encode(json(body)).length > 65536) throw new Error('The encoded documents exceed the 64 KiB request limit. Shorten the text and try again.');
  return body;
}

for (const kind of ['invoice', 'instruction']) {
  $(`input-${kind}`).addEventListener('input', () => { textVersions[kind] += 1; $(`${kind}-file-status`).textContent = ''; });
  $(`file-${kind}`).addEventListener('change', async () => {
    const file = $(`file-${kind}`).files[0];
    if (!file || busy) return;
    const generation = formGeneration, version = textVersions[kind], token = {};
    fileLoads.add(token); updateButtons();
    const status = $(`${kind}-file-status`); status.textContent = 'Reading text file…';
    try {
      if (!/\.(txt|md)$/i.test(file.name)) throw new Error('Choose a .txt or .md text file.');
      if (file.size > 48000) throw new Error('This file is too large. Use text within 12,000 characters.');
      const content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      const text = checkedText(content, sourceName(kind));
      if (generation !== formGeneration || version !== textVersions[kind] || $(`file-${kind}`).files[0] !== file) return;
      $(`input-${kind}`).value = text; textVersions[kind] += 1; status.textContent = `${file.name} loaded. Review the text before creating the case.`;
    } catch (error) {
      if (generation === formGeneration && version === textVersions[kind] && $(`file-${kind}`).files[0] === file) status.textContent = error instanceof TypeError ? 'This file is not valid UTF-8 text. Choose another file or paste the text.' : error.message;
    } finally { fileLoads.delete(token); updateButtons(); }
  });
}
for (const kind of ['invoice', 'instruction']) {
  $(`read-${kind}`).addEventListener('click', async () => {
    if (busy || !configured || !documentFlow) return;
    const generation = formGeneration, version = textVersions[kind], token = {};
    fileLoads.add(token); updateButtons();
    const status = $(`${kind}-file-status`); status.textContent = `${providerLabel} is reading the photo…`;
    try {
      const result = await api('/api/read-image', { preset: kind });
      const text = checkedText(result.text, sourceName(kind));
      if (generation !== formGeneration || version !== textVersions[kind]) return;
      $(`input-${kind}`).value = text; textVersions[kind] += 1;
      status.textContent = 'Read from the photo. Check every value before creating the case.';
    } catch (error) {
      if (generation === formGeneration && version === textVersions[kind]) status.textContent = error.message;
    } finally { fileLoads.delete(token); updateButtons(); }
  });
}
$('use-documents').addEventListener('click', () => openDocumentForm());
$('new-document-case').addEventListener('click', () => openDocumentForm(true));
$('cancel-document-case').addEventListener('click', () => { closeDocumentForm(); (isDocumentCase(current) ? $('new-document-case') : $('use-documents')).focus(); });
$('permission-confirm').addEventListener('change', updateButtons);
for (const id of ['permission-name', 'permission-account', 'permission-amount', 'permission-currency']) $(id).addEventListener('input', () => { $('permission-confirm').checked = false; updateButtons(); });
$('document-form').addEventListener('submit', event => {
  event.preventDefault();
  if (busy || fileLoads.size || !documentFlow) return;
  let body;
  try { body = documentInput(); }
  catch (error) { $('form-error').textContent = error.message; $('form-error').hidden = false; return; }
  perform(async () => {
    const state = await api('/api/document-workflows', body);
    closeDocumentForm(); evidenceGeneration += 1; $('evidence-status').textContent = '';
    render(state); history.replaceState(null, '', `/?workflow=${state.workflowId}`); selectDocument('invoice');
    $('status').textContent = 'The documents are saved. Analyse them when you are ready.';
  });
});
$('analyse-documents').addEventListener('click', () => perform(async () => {
  if (!isDocumentCase(current) || current.proposal || !documentFlow) return;
  const id = current.workflowId, digest = current.sourceDigest;
  $('status').textContent = `${providerLabel} is reading the source documents. No payment tools are available in this step.`;
  $('agent-heading').textContent = 'Reading the documents…';
  const state = await api(`/api/workflows/${id}/analyse`, {});
  if (current?.workflowId !== id || current.sourceDigest !== digest) return;
  render(state); $('status').textContent = readyProposal(state) ? 'Review all four values and their quoted sources before continuing.' : 'Update the source documents in a new case to resolve these details.';
}));
$('continue-proposal').addEventListener('click', () => perform(async () => { if (documentFlow && readyProposal(current) && !pending(current) && !current.ledger.length) await run(); }));
const proofStatusIds = ['evidence-status', 'edited-copy-status', 'repeat-run-status'];
const ledgerStateKey = ledger => json(ledger.map(payment => Object.keys(payment).sort().map(key => [key, payment[key]])));

function clearProofResults() {
  proofChecks.original = false; proofChecks.edited = false; proofChecks.repeat = false;
  if (typeof benchClear === 'function') benchClear();
  for (const id of proofStatusIds) { $(id).textContent = ''; delete $(id).dataset.result; }
}

function syncProofChecks(state) {
  const key = isDocumentCase(state) ? `${state.workflowId}|${state.operationId}|${state.sourceDigest}|${state.referenceJournal?.head}|${ledgerStateKey(state.ledger)}` : null;
  if (proofChecks.key === key) return;
  proofChecks.key = key; evidenceGeneration += 1; clearProofResults();
}

function proofMismatch() {
  const error = new Error('The reference key, saved record or displayed payment did not match. No verification result was established. Reload and inspect the record.');
  error.referenceMismatch = true;
  return error;
}

async function fetchProofRecord(context) {
  const [key, record] = await Promise.all([api('/api/reference-key', undefined, false, context.signal), api(`/api/workflows/${context.id}/export`, undefined, false, context.signal)]);
  if (!context.unchanged()) return null;
  if (!['profile', 'publicKey', 'fingerprint'].every(field => key[field] === context.key[field])
    || record.version !== 2 || record.workflowId !== context.id || record.operationId !== context.operationId
    || record.sourceDigest !== context.sourceDigest || record.referenceJournal?.head !== context.head
    || !Array.isArray(record.ledger) || ledgerStateKey(record.ledger) !== context.ledgerKey
    || !['profile', 'publicKey', 'fingerprint'].every(field => record.referenceJournal?.[field] === context.key[field])) throw proofMismatch();
  return record;
}

async function verifyProofRecord(record, context) {
  const { verifyReferenceJournalBrowser } = await import('/reference-verifier.js');
  return verifyReferenceJournalBrowser({ events: record.events, trustedPublicKey: context.key.publicKey, ledger: record.ledger,
    workflowId: context.id, operationId: context.operationId, expectedHead: context.head });
}

async function checkProof(kind, statusId, loadingText, check) {
  if (!isDocumentCase(current) || !documentFlow || busy || evidenceRequest || !pinnedReferenceKey || current.running || current.analysing || current.ledger.length !== 1) return;
  const controller = new AbortController();
  const context = { id: current.workflowId, operationId: current.operationId, sourceDigest: current.sourceDigest,
    head: current.referenceJournal?.head, key: pinnedReferenceKey, ledger: structuredClone(current.ledger),
    ledgerKey: ledgerStateKey(current.ledger), agentRuns: json(current.agentRuns || []),
    signal: controller.signal, cancelled: false, generation: ++evidenceGeneration };
  context.sameCase = () => current?.workflowId === context.id && current.sourceDigest === context.sourceDigest
    && current.referenceJournal?.head === context.head && ledgerStateKey(current.ledger) === context.ledgerKey
    && evidenceGeneration === context.generation;
  context.unchanged = () => !context.cancelled && context.sameCase();
  const request = {}; evidenceRequest = request; proofChecks[kind] = false;
  const status = $(statusId); status.textContent = loadingText; delete status.dataset.result;
  updateButtons(); renderTour(current);
  let deadline;
  try {
    await Promise.race([check(context, status), new Promise((_, reject) => {
      deadline = setTimeout(() => {
        context.cancelled = true;
        controller.abort();
        const error = new Error('This check took too long. No result was established. Try again.');
        error.proofTimeout = true;
        reject(error);
      }, 15000);
    })]);
  }
  catch (error) {
    if (context.sameCase()) {
      if (error.referenceMismatch) clearProofResults();
      status.textContent = error.referenceMismatch || error.proofTimeout ? error.message : 'This check could not complete. No result was established. Keep this page open and try again.';
      status.dataset.result = 'error';
    }
  } finally {
    clearTimeout(deadline);
    context.cancelled = true;
    controller.abort();
    if (evidenceRequest === request) { evidenceRequest = null; updateButtons(); renderTour(current); }
  }
}

$('check-evidence').addEventListener('click', () => checkProof('original', 'evidence-status', 'Checking the reference signatures and saved record in this browser…', async (context, status) => {
  const record = await fetchProofRecord(context);
  if (!record || !context.unchanged()) return;
  const result = await verifyProofRecord(record, context);
  if (!context.unchanged()) return;
  $('reference-metadata').textContent = json({ pinnedReferenceKey: context.key, journal: record.referenceJournal, integrityCheck: result });
  if (result.valid) benchShow(record, context);
  if (!result.valid) clearProofResults();
  proofChecks.original = result.valid;
  status.dataset.result = result.valid ? 'passed' : 'error';
  status.textContent = result.valid
    ? 'Record verified. The signatures, event links and ledger match this workspace’s pinned reference key.'
    : 'This record could not be verified. Keep the download and inspect its details.';
}));

$('check-edited-copy').addEventListener('click', () => checkProof('edited', 'edited-copy-status', 'Verifying the original, then checking a copy with an edited payment amount…', async (context, status) => {
  const record = await fetchProofRecord(context);
  if (!record || !context.unchanged()) return;
  const original = await verifyProofRecord(record, context);
  if (!context.unchanged()) return;
  proofChecks.original = original.valid;
  if (!original.valid) {
    clearProofResults();
    $('evidence-status').textContent = 'This record could not be verified. Keep the download and inspect its details.';
    $('evidence-status').dataset.result = 'error';
    status.textContent = 'The original did not verify, so this comparison was not established.'; status.dataset.result = 'error';
    return;
  }
  const copy = structuredClone(record), payment = copy.ledger?.[0];
  if (copy.ledger.length !== 1 || !Number.isSafeInteger(payment?.amountMinor) || payment.amountMinor >= Number.MAX_SAFE_INTEGER) throw new Error('An editable committed payment is required.');
  const event = copy.events.find(item => item.type === 'payment_committed' && item.details?.payment?.id === payment.id && item.proof?.payload?.details?.payment?.id === payment.id);
  if (!event) throw new Error('The signed committed payment is missing.');
  const editedAmount = payment.amountMinor + 1;
  payment.amountMinor = editedAmount;
  event.details.payment.amountMinor = editedAmount;
  event.proof.payload.details.payment.amountMinor = editedAmount;
  const edited = await verifyProofRecord(copy, context);
  if (!context.unchanged()) return;
  proofChecks.edited = !edited.valid;
  $('evidence-status').textContent = 'Record verified. The signatures, event links and ledger match this workspace’s pinned reference key.';
  $('evidence-status').dataset.result = 'passed';
  status.dataset.result = !edited.valid ? 'passed' : 'error';
  status.textContent = !edited.valid
    ? `Original verified. Edited copy rejected after a ${money({ amountMinor: 1, currency: payment.currency })} change to the signed payment. The saved record was not changed.`
    : 'The edited copy was accepted. This comparison did not establish that the edit was detected.';
}));

$('check-repeat-run').addEventListener('click', () => checkProof('repeat', 'repeat-run-status', 'Trying the same run again, then refreshing its saved payment…', async (context, status) => {
  const record = await fetchProofRecord(context);
  if (!record || !context.unchanged()) return;
  const response = await fetch(`/api/workflows/${context.id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: context.signal });
  if (!context.unchanged()) return;
  const body = await response.json();
  if (!context.unchanged()) return;
  const refreshed = await api(`/api/workflows/${context.id}`, undefined, false, context.signal);
  if (!context.unchanged()) return;
  if (refreshed.version !== 2 || refreshed.workflowId !== context.id || refreshed.operationId !== context.operationId
    || refreshed.sourceDigest !== context.sourceDigest || refreshed.referenceJournal?.head !== context.head) throw proofMismatch();
  const passed = response.status === 409 && body.error === 'This invoice already has a committed payment.'
    && refreshed.ledger?.length === 1 && ledgerStateKey(refreshed.ledger) === context.ledgerKey
    && json(refreshed.agentRuns || []) === context.agentRuns && !refreshed.running && !refreshed.analysing;
  render(refreshed);
  if (!context.unchanged()) return;
  proofChecks.repeat = passed; status.dataset.result = passed ? 'passed' : 'error';
  status.textContent = passed ? 'The repeat run was refused. The same single payment remains in the ledger.'
    : 'The expected repeat-run refusal was not established. Inspect the refreshed run before trying again.';
}));


// The bench. The judge edits the real signed record by hand; the browser verifier
// decides. Nothing here talks to the server after the record is loaded, and no edit
// can change a payment: it is a copy, checked against the pinned demo key.
const bench = { original: null, context: null, recordKey: null, generation: 0, amountError: null };
function benchStatus(text, result) {
  const status = $('bench-status'); status.textContent = text;
  if (result) status.dataset.result = result; else delete status.dataset.result;
}
function benchPayment(record) {
  const payment = Array.isArray(record?.ledger) && record.ledger.length === 1 ? record.ledger[0] : null;
  return payment && typeof payment === 'object' && !Array.isArray(payment)
    && Number.isSafeInteger(payment.amountMinor) && payment.amountMinor > 0
    && typeof payment.beneficiaryAccount === 'string' && typeof payment.currency === 'string' ? payment : null;
}
function benchReadCopy() {
  try { return JSON.parse($('bench-json').value); } catch { return null; }
}
function benchAmountText(value) {
  const digits = String(value).padStart(3, '0');
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}
function benchAmountValue(text) {
  if (!/^[0-9]+(?:\.[0-9]{1,2})?$/.test(text.trim())) return null;
  const [whole, fraction = ''] = text.trim().split('.');
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return amount > 0n && amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : null;
}
function benchButtons() {
  $('bench-check').disabled = bench.original === null || Boolean(bench.amountError);
  $('bench-reset').disabled = bench.original === null;
  $('bench-json').disabled = bench.original === null;
}
function benchDifferences() {
  const original = bench.original === null ? null : benchPayment(JSON.parse(bench.original));
  for (const [name, field] of [['amount', 'amountMinor'], ['account', 'beneficiaryAccount'], ['currency', 'currency']]) {
    const input = $(`bench-${name}`), value = name === 'amount' ? benchAmountValue(input.value) : input.value;
    const changed = Boolean(original) && value !== original[field];
    input.dataset.changed = String(changed);
    $(`bench-${name}-change`).textContent = changed ? 'Changed' : '';
  }
}
function benchSyncFields() {
  const payment = benchPayment(benchReadCopy());
  bench.amountError = null;
  $('bench-fields').disabled = !payment;
  for (const [name, value] of [['amount', payment ? benchAmountText(payment.amountMinor) : ''], ['account', payment?.beneficiaryAccount || ''], ['currency', payment?.currency || '']]) {
    const input = $(`bench-${name}`); input.value = value; input.disabled = !payment;
    input.removeAttribute('aria-invalid');
  }
  $('bench-fields-note').textContent = payment
    ? 'Editing these fields changes only this ledger copy. Reset restores the original record.'
    : bench.original === null ? 'Verify a signed payment record to edit its copy.'
      : 'The JSON copy needs one payment with an integer amount, account and currency to use these fields. Edit Technical details or reset.';
  benchDifferences(); benchButtons();
}
function benchEdited(force = false) {
  bench.generation += 1;
  const same = !force && $('bench-json').value === bench.original;
  $('bench-json').dataset.state = same ? 'verified' : 'edited';
  benchStatus(bench.amountError || (same ? 'This copy matches the signed record.' : 'Edited. Press Check this copy.'), bench.amountError ? 'error' : same ? 'passed' : undefined);
  benchDifferences(); benchButtons();
}
function benchShow(record, context) {
  // Only what the signature covers: the exported ledger and the signed events. The rest
  // of the export (proposal text, documents, agent runs) is unsigned context and would
  // let a judge edit something the verifier is not meant to catch.
  const signedPart = { ledger: record.ledger, events: record.events };
  bench.generation += 1;
  bench.original = json(signedPart); bench.context = context; bench.recordKey = proofChecks.key;
  $('bench-json').value = bench.original; $('bench-json').dataset.state = 'verified';
  const payment = benchPayment(signedPart);
  $('bench-original-amount').textContent = payment ? benchAmountText(payment.amountMinor) : 'No recorded payment';
  $('bench-original-account').textContent = payment?.beneficiaryAccount || 'Unavailable';
  $('bench-original-currency').textContent = payment?.currency || 'Unavailable';
  benchSyncFields();
  benchStatus('This copy matches the signed record.', 'passed');
  $('bench').hidden = false;
}
function benchClear() {
  bench.generation += 1; bench.original = null; bench.context = null; bench.recordKey = null;
  $('bench').hidden = true; $('bench-json').value = ''; delete $('bench-json').dataset.state;
  for (const name of ['amount', 'account', 'currency']) $(`bench-original-${name}`).textContent = '';
  benchSyncFields(); benchStatus('');
}
function describeFailure(result) {
  const code = result.failure?.code || 'VERIFICATION_INCOMPLETE', where = result.where;
  if (where?.ledger) return 'Rejected at the exported ledger: it no longer matches the signed payment events.';
  if (where?.head) return `Rejected: the record no longer ends at the head pinned for this case. Code ${code}.`;
  const why = { SIGNATURE_MISMATCH: 'a signature no longer matches', HASH_MISMATCH: 'an event hash no longer matches', ENVELOPE_INVALID: 'a signed envelope is malformed', PIN_REQUIRED: 'no pinned key is available', VERIFIER_UNAVAILABLE: 'browser cryptography is unavailable' }[code]
    || (where?.event ? 'it no longer matches the signed record' : 'the record could not be verified');
  const place = where?.event ? ` at event ${where.event}${where.type ? ` (${where.type.replaceAll('_', ' ')})` : ''}` : '';
  return `Rejected${place}: ${why}. Code ${code}.`;
}
$('bench-json').addEventListener('input', () => {
  benchSyncFields(); benchEdited();
});
for (const [name, field] of [['amount', 'amountMinor'], ['account', 'beneficiaryAccount'], ['currency', 'currency']]) {
  $(`bench-${name}`).addEventListener('input', () => {
    if (bench.original === null) return;
    const copy = benchReadCopy(), payment = benchPayment(copy);
    if (!payment) { benchSyncFields(); benchEdited(true); return; }
    const input = $(`bench-${name}`), value = name === 'amount' ? benchAmountValue(input.value) : input.value;
    if (name === 'amount') {
      bench.amountError = value === null ? 'Enter a positive decimal amount with up to two decimal places, within the simulation’s numeric limit. Nothing has been checked.' : null;
      if (bench.amountError) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    }
    if (name !== 'amount' || value !== null) { payment[field] = value; $('bench-json').value = json(copy); }
    benchEdited(true);
  });
}
$('bench-reset').addEventListener('click', () => {
  bench.generation += 1;
  if (bench.original === null) return;
  $('bench-json').value = bench.original; $('bench-json').dataset.state = 'verified';
  benchSyncFields(); benchStatus('Reset. This copy matches the signed record.', 'passed');
});
$('bench-check').addEventListener('click', async () => {
  if (bench.original === null || !bench.context || bench.amountError) return;
  const text = $('bench-json').value, context = bench.context, recordKey = bench.recordKey, generation = ++bench.generation;
  const unchanged = () => bench.generation === generation && bench.context === context && bench.recordKey === recordKey
    && proofChecks.key === recordKey && $('bench-json').value === text
    && current?.workflowId === context.id && current.operationId === context.operationId && current.sourceDigest === context.sourceDigest
    && current.referenceJournal?.head === context.head && ledgerStateKey(current.ledger) === context.ledgerKey;
  let edited;
  try { edited = JSON.parse(text); }
  catch { $('bench-json').dataset.state = 'rejected'; benchStatus('This copy is not valid JSON, so nothing was checked.', 'error'); return; }
  if (!edited || typeof edited !== 'object' || Array.isArray(edited)) {
    $('bench-json').dataset.state = 'rejected'; benchStatus('This copy must be a JSON object containing the record, so nothing was checked.', 'error'); return;
  }
  $('bench-json').dataset.state = 'checking';
  benchStatus('Checking in your browser…');
  let result;
  try { result = await verifyProofRecord(edited, context); }
  catch {
    if (!unchanged()) return;
    $('bench-json').dataset.state = 'rejected'; benchStatus('This copy could not be checked. No verification result was established. Reset or try again.', 'error'); return;
  }
  if (!unchanged()) return;
  const same = text === bench.original;
  if (result.valid) {
    $('bench-json').dataset.state = 'verified';
    benchStatus(same ? 'Verified. This copy matches the signed record.' : 'Verified. Your change was outside the signed fields (for example a label or spacing), so the record still stands.', 'passed');
  } else {
    $('bench-json').dataset.state = 'rejected';
    benchStatus(describeFailure(result), 'error');
  }
});

function downloadRecord(record) {
  const url = URL.createObjectURL(new Blob([json(record)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `execution-sandbox-${record.workflowId}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function observeActiveCase(state) {
  clearTimeout(observationTimer);
  if (busy || (!state.running && !state.analysing)) return;
  const id = state.workflowId, digest = state.sourceDigest;
  observationTimer = setTimeout(async () => {
    try {
      const updated = await api(`/api/workflows/${id}`);
      if (busy || current?.workflowId !== id || current.sourceDigest !== digest || updated.revision < current.revision) return;
      render(updated);
      $('status').textContent = updated.analysing ? `${providerLabel} is reading the saved documents.` : updated.running ? `${providerLabel} is using the payment tools…` : outcomeStatus();
    } catch { if (current?.workflowId === id) $('status').textContent = 'The case could not be refreshed. Reload to retrieve its latest record.'; }
  }, 2500);
}

function render(state) {
  syncProofChecks(state);
  current = state;
  const documents = isDocumentCase(state);
  document.querySelector('.source-pane').setAttribute('aria-label', documents ? 'Invoice and later message' : 'Invoice and supplier email');
  for (const node of $('tab-email').childNodes) if (node.nodeType === Node.TEXT_NODE) node.textContent = documents ? 'Later message' : 'Supplier email';
  $('document-controls').hidden = !documents || !documentFlow;
  $('source-comparison').hidden = !documents;
  $('legacy-comparison').hidden = documents;
  ($('account-note').closest('.source-annotation') || $('account-note')).hidden = documents;
  $('reference-evidence').hidden = !documents;
  $('proof-checks').hidden = !documents || state.ledger.length !== 1;
  $('preset-permission-note').hidden = !documents || state.originalAuthority?.supplierId !== 'harbour-print';
  showPhases(state);
  if (!documents) {
  $('source-supplier').textContent = 'Harbour Print';
  $('email-panel').querySelector('.document-title').textContent = 'A change to the payment details';
  $('invoice-panel').querySelector('.document-title').textContent = 'Supplier invoice';
  for (const id of ['invoice', 'email']) $(id).classList.remove('numbered-document');
  $('scope-note').textContent = workflowScope(state);
  $('source-mode').textContent = 'Workflow documents';
  $('invoice').textContent = documentSummary(state.invoiceText);
  $('email').textContent = documentSummary(state.supplierEmail);
  const original = state.invoiceText.match(/Beneficiary account: (\S+)/)?.[1] || 'Unavailable';
  const requested = state.supplierEmail.match(/to ([A-Z0-9-]+)\.?/)?.[1] || 'Unavailable';
  showAccounts(original, requested);
  $('account-note').textContent = original === requested ? 'The requested account matches the original approval.' : 'The amount stays the same. The destination changes.';
  }
  $('approval').textContent = json(state.currentApproval);
  const review = pending(state);
  const lastRun = state.agentRuns?.at(-1);
  const declined = state.events.some(event => event.type === 'operator_declined');
  const approved = !review && state.currentApproval?.source === 'operator_review' && !state.ledger.length;
  $('agent-heading').textContent = state.ledger.length ? 'Paid once. Recorded.' : review ? 'Your decision is needed.' : approved ? 'Approved. Ready to continue.' : declined ? 'Change declined.' : busy || state.running ? 'The agent is working…' : lastRun?.status === 'error' || lastRun?.status === 'limit' ? 'The run needs attention.' : 'Ready for the agent.';
  $('ledger-count').textContent = `${state.ledger.length} ${state.ledger.length === 1 ? 'payment' : 'payments'}`;
  $('ledger-count').classList.toggle('has-payment', state.ledger.length > 0);
  $('review').hidden = !review || (documents && !readyProposal(state));
  $('review-values').replaceChildren();
  if (review) {
    for (const [term, value] of [['Supplier', documents ? (readyProposal(state) ? state.proposal.candidate.supplierName.value : 'Needs clarification') : review.tuple.supplierId], ['Account', review.tuple.beneficiaryAccount], ['Amount', money(review.tuple)], ['Currency', review.tuple.currency]]) {
      const row = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = term; dd.textContent = value; row.append(dt, dd); $('review-values').append(row);
    }
    $('review-digest').textContent = `${review.reviewId}\nExact tuple digest: ${review.digest}`;
  }
  if (renderedReviewId !== (review?.reviewId || null)) $('confirm').checked = false;
  renderedReviewId = review?.reviewId || null;
  $('resume').hidden = !approved || (documents && !readyProposal(state));
  $('start-controls').hidden = documents || !!review || approved || busy || state.running;
  $('start-conflict').firstChild.textContent = 'Try a changed account';
  $('idle-art').hidden = true;
  $('ledger').hidden = !state.ledger.length;
  $('ledger').replaceChildren();
  for (const payment of state.ledger) {
    const amount = document.createElement('strong'); amount.textContent = money(payment);
    const account = document.createElement('span'); account.textContent = `to ${payment.beneficiaryAccount}`;
    $('ledger').append(amount, account);
  }
  renderEvents(state);
  renderSteps(state);
  renderAccount(state);
  renderRon(state);
  $('events').textContent = json(state.events);
  $('tool-records').replaceChildren();
  for (const [number, entry] of (state.agentRuns || []).entries()) {
    const details = document.createElement('details'), summary = document.createElement('summary'), pre = document.createElement('pre');
    summary.textContent = `Run ${number + 1}: ${entry.requestCount} model requests, ${entry.status.replaceAll('_', ' ')}`;
    pre.textContent = json(entry.trace); details.append(summary, pre); $('tool-records').append(details);
  }
  if (!state.agentRuns?.length) $('tool-records').textContent = 'No model trace is retained in this server process yet.';
  $('export').hidden = hostedDemo;
  if (documents) renderDocumentCase(state);
  updateButtons();
  observeActiveCase(state);
  dispatchEvent(new CustomEvent('seal:state'));
  renderTour(state);
}

function updateButtons() {
  const locked = busy || Boolean(evidenceRequest);
  for (const id of ['start-legitimate', 'start-conflict', 'resume', 'analyse-documents', 'continue-proposal']) $(id).disabled = locked || !configured || Boolean(current?.running || current?.analysing);
  for (const id of ['use-documents', 'new-document-case', 'cancel-document-case']) $(id).disabled = locked || Boolean(current?.running || current?.analysing);
  $('export').disabled = locked;
  for (const id of ['check-evidence', 'check-edited-copy', 'check-repeat-run']) $(id).disabled = locked || !pinnedReferenceKey || !isDocumentCase(current) || current.ledger.length !== 1 || Boolean(current?.running || current?.analysing);
  $('create-document-case').disabled = locked || Boolean(fileLoads.size) || !$('permission-confirm').checked;
  for (const id of ['read-invoice', 'read-instruction']) $(id).disabled = locked || !configured || Boolean(fileLoads.size);
  for (const input of $('document-form').querySelectorAll('input, textarea, select')) input.disabled = locked;
  $('document-form').setAttribute('aria-busy', String(locked || Boolean(fileLoads.size)));
  document.querySelector('.decision-pane').setAttribute('aria-busy', String(busy));
  $('approve').disabled = locked || Boolean(current?.running || current?.analysing) || !$('confirm').checked;
  $('decline').disabled = locked || Boolean(current?.running || current?.analysing);
  if (isDocumentCase(current) && !readyProposal(current)) for (const id of ['approve', 'resume', 'continue-proposal']) $(id).disabled = true;
  $('proof-checks').setAttribute('aria-busy', String(Boolean(evidenceRequest)));
  document.body.classList.toggle('is-running', busy);
}

function outcomeStatus() {
  if (isDocumentCase(current) && !current.proposal) return 'The documents are saved. Analyse them when you are ready.';
  if (isDocumentCase(current) && !readyProposal(current)) return 'Update the source documents in a new case to resolve these details.';
  if (pending(current)) return 'No payment made. Review the exact new details.';
  if (current.ledger.length) return 'The executor recorded the exact approved payment.';
  if (current.currentApproval?.source === 'operator_review') return 'Continue when you are ready.';
  if (current.events.some(event => event.type === 'operator_declined')) return 'No payment made.';
  if (isDocumentCase(current) && !current.agentRuns?.length) return 'Review all four values and their quoted sources before continuing.';
  return 'Inspect the run for the recorded outcome.';
}

async function perform(fn) {
  if (busy || evidenceRequest) return;
  busy = true; updateButtons(); renderTour(current); $('error').hidden = true;
  try { await fn(); }
  catch (error) { $('error').textContent = error.message; $('error').hidden = false; $('status').textContent = 'The run stopped. Its record is still available.'; }
  finally {
    busy = false; if (current) render(current); updateButtons();
    if (!$('document-entry').hidden) { if (!$('error').hidden) $('error').scrollIntoView({ block: 'nearest' }); }
    else if (current && !$('resume').hidden) $('resume').focus();
    else if (isDocumentCase(current) && !current.proposal) $('analyse-documents').focus();
    else if (isDocumentCase(current) && current.ledger.length === 1) $('proof-heading').focus({ preventScroll: true });
    else if (current) $('agent-heading').focus({ preventScroll: true });
  }
}

async function run() {
  $('status').textContent = `${providerLabel} is using the payment tools…`;
  $('agent-heading').textContent = 'The agent is working…';
  $('start-controls').hidden = true; $('idle-art').hidden = true;
  const id = current.workflowId;
  const timer = setInterval(async () => {
    try { const state = await api(`/api/workflows/${id}`); if (busy && current?.workflowId === id) render(state); } catch {}
  }, 2500);
  try { const state = await api(`/api/workflows/${id}/run`, {}); if (current?.workflowId === id) { render(state); $('status').textContent = outcomeStatus(); } }
  finally { clearInterval(timer); }
}

function suppliedDocumentCase(scenario) {
  // The changed case states which account replaces which: Muse Spark Open rightly asks for clarification otherwise.
  const instruction = scenario === 'conflict' ? 'Later payment instruction for Harbour Print.\nRequested amount: 250000.00 EUR.\nRequested beneficiary account: DE00-TEST-0000-1289.\nThis replaces the previous account DE00-TEST-0000-1280 shown on the invoice.\nThe supplier, amount and currency are unchanged.\nThis is a payment request. It is not approval to execute it.' : 'Please pay Harbour Print 250000.00 EUR to DE00-TEST-0000-1280.';
  return {
    originalAuthority: { supplierId: 'harbour-print', supplierName: 'Harbour Print', beneficiaryAccount: 'DE00-TEST-0000-1280', amountMinor: 25000000, currency: 'EUR' },
    documents: [
      { kind: 'invoice', text: 'Supplier: Harbour Print\nAmount: 250000.00\nCurrency: EUR\nBeneficiary account: DE00-TEST-0000-1280' },
      { kind: 'instruction', text: instruction },
    ],
  };
}

for (const scenario of ['legitimate', 'conflict']) $(`start-${scenario}`).addEventListener('click', () => perform(async () => {
  const state = documentFlow ? await api('/api/document-workflows', suppliedDocumentCase(scenario)) : await api('/api/workflows', { scenario });
  render(state);
  history.replaceState(null, '', `/?workflow=${current.workflowId}`);
  selectDocument('email');
  if (documentFlow) $('status').textContent = 'The test documents are saved. Analyse them to review the proposed payment details.';
  else await run();
}));
$('resume').addEventListener('click', () => perform(run));
$('confirm').addEventListener('change', updateButtons);
for (const action of ['approve', 'decline']) $(action).addEventListener('click', () => perform(async () => {
  const review = pending(current);
  if (!review || (action === 'approve' && !$('confirm').checked)) return;
  render(await api(`/api/workflows/${current.workflowId}/${action}`, { reviewId: review.reviewId, digest: review.digest, expectedRevision: review.expectedRevision, confirm: true }, true));
  $('status').textContent = action === 'approve' ? 'Continue when you are ready.' : 'No payment made.';
}));
$('export').addEventListener('click', async () => {
  try {
    const record = await api(`/api/workflows/${current.workflowId}/export`);
    downloadRecord(record);
  } catch { $('error').textContent = 'The record could not be saved. Keep this page open and try again.'; $('error').hidden = false; }
});

showAccounts($('approved-account').textContent, $('requested-account').textContent);
updateButtons();
api('/api/config').then(async config => {
  configured = config.metaConfigured;
  documentFlow = config.documentFlow === true;
  hostedDemo = config.hosted === true;
  if (documentFlow && config.referenceKey?.profile === 'SEAL-REFERENCE-EVENT-v1' && typeof config.referenceKey.publicKey === 'string' && typeof config.referenceKey.fingerprint === 'string') pinnedReferenceKey = Object.freeze({ profile: config.referenceKey.profile, publicKey: config.referenceKey.publicKey, fingerprint: config.referenceKey.fingerprint });
  $('use-documents').hidden = !documentFlow;
  providerLabel = 'The agent';
  $('provider').textContent = '';
  $('model-pill').lastChild.textContent = `Runs on ${config.modelLabel}`;
  $('model-pill').title = config.model;
  $('model-pill').classList.toggle('is-ready', configured);
  $('status').textContent = configured ? 'See whether the old approval permits the new account.' : 'The model is not connected on this server.';
  const id = new URLSearchParams(location.search).get('workflow');
  if (id) {
    try { render(await api(`/api/workflows/${encodeURIComponent(id)}`)); $('status').textContent = outcomeStatus(); }
    catch (error) {
      if (error.status === 404) { $('status').textContent = 'This run is no longer stored on the demo server.'; $('error').textContent = 'Runs are kept for a limited time. Start a fresh case.'; $('error').hidden = false; }
      else if (error.status === 401) { $('status').textContent = 'Your demo session has ended. Open the workspace again to continue.'; }
      else throw error;
    }
  }
  else if (new URLSearchParams(location.search).get('documents') === '1') openDocumentForm();
  updateButtons(); renderTour(current);
}).catch(() => { $('status').textContent = 'The demo server did not answer. Reload to try again.'; });
