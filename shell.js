// Workspace navigation and list views. Payment authority stays on the server;
// these views only read workflow summaries.
const $ = id => document.getElementById(id);
const VIEWS = ['overview', 'approvals', 'runs', 'payments', 'policies', 'privacy', 'teams', 'run'];
const TITLES = { overview: 'Overview', approvals: 'Approvals', runs: 'Agent runs', payments: 'Payments', policies: 'Policies', privacy: 'Privacy and security', teams: 'Seal for your team', run: 'Payment run' };
const STATUS = {
  paid: ['Paid once', 'ok'], needs_review: ['Needs your decision', 'wait'], declined: ['Declined', 'bad'],
  approved: ['Approved, not yet paid', 'neutral'], refused: ['Refused', 'bad'], new: ['Not started', 'neutral'],
};
const SCENARIOS = { conflict: 'Changed bank details', legitimate: 'Unchanged invoice' };
const money = (minor, currency) => Number.isSafeInteger(minor) && ['EUR', 'GBP', 'USD'].includes(currency)
  ? new Intl.NumberFormat('en-IE', { style: 'currency', currency }).format(minor / 100) : '-';
const when = iso => { const date = new Date(iso); return Number.isFinite(date.getTime()) ? date.toLocaleString('en-IE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''; };
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
const runHref = id => `/?workflow=${encodeURIComponent(id)}`;
let workflows = [];

function currentView() {
  const params = new URLSearchParams(location.search);
  if (params.get('workflow')) return 'run';
  const view = params.get('view');
  return VIEWS.includes(view) ? view : 'overview';
}

function show(view) {
  for (const name of VIEWS) { const section = $(`view-${name}`); if (section) section.hidden = name !== view; }
  for (const link of document.querySelectorAll('[data-nav]')) link.setAttribute('aria-current', link.dataset.nav === view || (view === 'run' && link.dataset.nav === 'runs') ? 'page' : 'false');
  document.querySelector('[data-nav][aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  $('page-title').textContent = TITLES[view];
  document.title = `${TITLES[view]} | Seal payment test`;
}

function statusChip(status) {
  const [label, tone] = STATUS[status] || STATUS.new;
  return el('span', `chip is-${tone}`, label);
}

function runRow(item) {
  const row = el('a', 'run-row'); row.href = runHref(item.workflowId);
  const main = el('span', 'run-main');
  main.append(el('strong', '', item.version === 2 ? 'Your documents' : SCENARIOS[item.scenario] || 'Payment run'), el('span', 'run-sub', `${item.supplierName} · ${item.beneficiaryAccount || 'no account yet'}`));
  row.append(main, el('span', 'run-amount', money(item.amountMinor, item.currency)), statusChip(item.running ? 'new' : item.status), el('span', 'run-time', when(item.updatedAt)));
  if (item.running) row.querySelector('.chip').textContent = 'Agent working…';
  return row;
}

function emptyState(text, action = true) {
  const box = el('div', 'empty');
  box.append(el('p', '', text));
  if (action) { const link = el('a', 'primary', 'Start a payment run'); link.href = '/?view=run'; box.append(link); }
  return box;
}

function list(target, items, emptyText) {
  target.replaceChildren(...(items.length ? items.map(runRow) : [emptyState(emptyText)]));
}

function renderAll() {
  const sent = workflows.flatMap(item => item.ledger);
  const waiting = workflows.filter(item => item.status === 'needs_review');
  const refused = workflows.reduce((total, item) => total + item.refusedAttempts, 0);
  const byCurrency = sent.reduce((totals, payment) => ({ ...totals, [payment.currency]: (totals[payment.currency] || 0) + payment.amountMinor }), {});
  const sentText = Object.keys(byCurrency).length ? Object.entries(byCurrency).map(([currency, minor]) => money(minor, currency)).join(' · ') : money(0, 'EUR');
  $('kpi-sent').textContent = sentText;
  $('kpi-sent-note').textContent = `${sent.length} ${sent.length === 1 ? 'payment' : 'payments'} recorded`;
  $('kpi-waiting').textContent = String(waiting.length);
  $('kpi-refused').textContent = String(refused);
  $('kpi-runs').textContent = String(workflows.length);
  $('nav-approvals').textContent = String(waiting.length);
  $('nav-approvals').hidden = !waiting.length;
  list($('overview-approvals'), waiting.slice(0, 3), 'Nothing is waiting for you.');
  list($('overview-runs'), workflows.slice(0, 5), 'No runs yet. Start one to see the agent work.');
  list($('approvals-list'), waiting, 'Nothing is waiting for you. Changed payment details land here.');
  list($('runs-list'), workflows, 'No runs yet.');
  const ledger = $('payments-list');
  if (!sent.length) ledger.replaceChildren(emptyState('No payments yet. A payment appears here only after the executor records it.'));
  else ledger.replaceChildren(...sent.slice().sort((a, b) => b.committedAt.localeCompare(a.committedAt)).map(payment => {
    const row = el('a', 'run-row'); row.href = runHref(payment.workflowId);
    const main = el('span', 'run-main'); main.append(el('strong', '', payment.beneficiaryAccount), el('span', 'run-sub', `Payment ${payment.id.slice(0, 12)} · one use of approval ${payment.approvalId.slice(0, 12)}`));
    row.append(main, el('span', 'run-amount', money(payment.amountMinor, payment.currency)), statusChip('paid'), el('span', 'run-time', when(payment.committedAt)));
    return row;
  }));
}

const SVG = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}, text) => { const node = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v)); if (text !== undefined) node.textContent = text; return node; };

/** Horizontal bars with a direct label on every row; colour is never the only cue. */
function barChart(target, table, rows, format) {
  const width = 560, rowHeight = 34, labelWidth = 160, valueWidth = 120, top = 6;
  const max = Math.max(1, ...rows.map(row => row.value));
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${rows.length * rowHeight + top}`, role: 'img', 'aria-label': rows.map(row => `${row.label}: ${format(row.value)}`).join('; ') });
  rows.forEach((row, index) => {
    const y = top + index * rowHeight, span = width - labelWidth - valueWidth;
    const length = row.value > 0 ? Math.max(4, (row.value / max) * (span - 12)) : 0;
    const group = svgEl('g', { class: 'bar-row', tabindex: 0 });
    group.append(svgEl('title', {}, `${row.label}: ${format(row.value)}${row.note ? ' (' + row.note + ')' : ''}`));
    group.append(svgEl('text', { x: 0, y: y + 19, class: 'bar-label' }, `${row.icon} ${row.label}`));
    group.append(svgEl('rect', { x: labelWidth, y: y + 6, width: span - 12, height: 18, rx: 4, class: 'bar-track' }));
    if (length) group.append(svgEl('rect', { x: labelWidth, y: y + 6, width: length, height: 18, rx: 4, fill: row.color }));
    group.append(svgEl('text', { x: width, y: y + 19, class: 'bar-value', 'text-anchor': 'end' }, format(row.value)));
    svg.append(group);
  });
  target.replaceChildren(svg);
  const head = el('tr'); head.append(el('th', '', 'Outcome'), el('th', '', 'Value'));
  table.replaceChildren(head, ...rows.map(row => { const tr = el('tr'); tr.append(el('td', '', row.label), el('td', '', format(row.value))); return tr; }));
}

function renderCharts() {
  const count = status => workflows.filter(item => item.status === status).length;
  const refused = workflows.reduce((total, item) => total + item.refusedAttempts, 0);
  barChart($('chart-outcomes'), $('table-outcomes'), [
    { label: 'Paid once', icon: '✓', value: count('paid'), color: '#1f9d61' },
    { label: 'Waiting for you', icon: '◷', value: count('needs_review'), color: '#d98a00' },
    { label: 'Attempts refused', icon: '✕', value: refused, color: '#d14334', note: 'tried a payment the approval did not cover' },
    { label: 'Declined', icon: '-', value: count('declined'), color: '#8b97a8' },
  ], value => String(value));
  const sent = workflows.flatMap(item => item.ledger).reduce((total, payment) => total + (payment.currency === 'EUR' ? payment.amountMinor : 0), 0);
  const held = workflows.filter(item => item.status === 'needs_review' || item.status === 'declined' || (item.refusedAttempts > 0 && !item.ledger.length))
    .reduce((total, item) => total + (item.currency === 'EUR' && Number.isSafeInteger(item.amountMinor) ? item.amountMinor : 0), 0);
  barChart($('chart-money'), $('table-money'), [
    { label: 'Sent after approval', icon: '✓', value: sent, color: '#1f9d61' },
    { label: 'Held back', icon: '✕', value: held, color: '#d14334', note: 'refused or still waiting for a person' },
  ], value => money(value, 'EUR'));
}

async function refresh() {
  try {
    const response = await fetch('/api/workflows');
    if (!response.ok) return;
    const value = await response.json();
    if (Array.isArray(value.workflows)) { workflows = value.workflows; renderAll(); renderCharts(); }
  } catch {}
}

for (const link of document.querySelectorAll('[data-nav]')) link.addEventListener('click', event => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || currentView() === 'run') return;
  event.preventDefault();
  history.pushState(null, '', link.getAttribute('href'));
  show(currentView()); refresh();
});
addEventListener('popstate', () => { if (currentView() === 'run') location.reload(); else { show(currentView()); refresh(); } });
addEventListener('seal:state', refresh);
show(currentView());
refresh();
fetch('/api/config').then(response => response.json()).then(config => {
  if (config.brandMark !== true) return;
  const mark = el('img', 'brand-mark'); mark.src = '/brand-mark.svg'; mark.alt = ''; mark.width = 26; mark.height = 26;
  $('brand-slot').replaceChildren(mark);
}).catch(() => {});
