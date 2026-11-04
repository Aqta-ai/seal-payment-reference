import http from 'node:http';
import { readFileSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { WorkflowStore } from './src/workflow.mjs';
import { runAgent, runWonderAgent } from './src/meta-agent.mjs';
import { runBasetenAgent } from './src/baseten-agent.mjs';
import { runDocumentAnalysis } from './src/document-agent.mjs';
import { readPresetImage, IMAGE_PRESETS } from './src/image-reader.mjs';
import { loadReferenceSigner } from './src/reference-journal.mjs';
import { demoAccessFromEnvironment } from './src/demo-auth.mjs';
import { DemoOwnerStore } from './src/demo-owners.mjs';
import { MODEL_BUDGET_EXHAUSTED } from './src/model-budget.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const publicOrigin = value => { const url = new URL(value); if (url.protocol !== 'https:') throw new Error('SANDBOX_PUBLIC_ORIGIN must use https.'); return url.origin; };
const exactBody = (value, keys) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const extractionFailureCodes = new Set(['INVALID_DOCUMENT_SOURCES', 'EXTRACTION_CONFIGURATION_UNAVAILABLE', 'EXTRACTION_TIMEOUT', 'EXTRACTION_NETWORK_ERROR', 'EXTRACTION_HTTP_ERROR', 'EXTRACTION_INVALID_RESPONSE', 'EXTRACTION_PROVIDER_ERROR']);

const providers = {
  meta: { agent: runAgent, model: 'muse-spark-1.3', label: 'Muse Spark', keyEnv: 'META_MODEL_API_KEY' },
  wonder: { agent: runWonderAgent, model: 'muse-wonder-1.0', label: 'Muse Wonder', keyEnv: 'META_MODEL_API_KEY' },
  baseten: { agent: runBasetenAgent, model: 'meta-models/muse-spark-open-1026', label: 'Muse Spark Open', keyEnv: 'BASETEN_API_KEY' },
};

export function createServer({ store, agent, apiKey, provider = process.env.PAYMENT_AGENT_PROVIDER || 'meta', uiRoot = root, savedRecords = [], documentFlow = false, referenceSigner, documentAgent = runDocumentAnalysis, imageReader = readPresetImage, brandMarkFile, aqtaMarkFile, fontDir, hosted = null, fetchImpl = globalThis.fetch, modelLabel, demoAccess = null, demoOwners = null } = {}) {
  if (!store) throw new Error('A workflow store is required.');
  if (!Object.hasOwn(providers, provider)) throw new Error('Choose the meta, wonder or baseten provider.');
  if (typeof documentFlow !== 'boolean') throw new TypeError('Document flow must be a trusted boolean setting.');
  const referenceKey = store.referenceKey;
  if (documentFlow && (!referenceKey?.publicKey || (referenceSigner && referenceSigner.publicKey !== referenceKey.publicKey))) throw new TypeError('Document flow requires the store reference signer.');
  if (typeof documentAgent !== 'function') throw new TypeError('A document extraction function is required.');
  if (typeof imageReader !== 'function') throw new TypeError('An image reading function is required.');
  const selected = providers[provider];
  const modelRunner = agent || selected.agent;
  const key = apiKey ?? process.env[selected.keyEnv];
  const uiDirectory = resolve(uiRoot);
  const staticFiles = new Map([
    ['/', [join(uiDirectory, 'index.html'), 'text/html']],
    ['/styles.css', [join(uiDirectory, 'styles.css'), 'text/css']],
    ['/app.js', [join(root, 'app.js'), 'text/javascript']],
    ['/reference-verifier.js', [join(root, 'reference-verifier.js'), 'text/javascript']],
    ['/shell.js', [join(root, 'shell.js'), 'text/javascript']],
    ['/supplier-name.js', [join(root, 'supplier-name.js'), 'text/javascript']],
    ['/walkthrough.js', [join(root, 'walkthrough.js'), 'text/javascript']],
    ['/glasses', [join(root, 'glasses.html'), 'text/html']],
    ['/glasses.css', [join(root, 'glasses.css'), 'text/css']],
    ['/glasses.js', [join(root, 'glasses.js'), 'text/javascript']],
    ['/access', [join(root, 'access.html'), 'text/html']],
    ['/access.css', [join(root, 'access.css'), 'text/css']],
    ['/access.js', [join(root, 'access.js'), 'text/javascript']],
    ['/access-bar.js', [join(root, 'access-bar.js'), 'text/javascript']],
  ]);
  for (const [name, type] of [['mascot.png', 'image/png'], ['font-body.woff2', 'font/woff2'], ['font-pen.woff2', 'font/woff2'], ['brand-mark.svg', 'image/svg+xml'], ['brand-mark.png', 'image/png']]) {
    const file = join(uiDirectory, name);
    if (statSync(file, { throwIfNoEntry: false })?.isFile()) staticFiles.set(`/${name}`, [file, type]);
  }
  if (typeof brandMarkFile === 'string' && statSync(brandMarkFile, { throwIfNoEntry: false })?.isFile()) staticFiles.set('/brand-mark.svg', [resolve(brandMarkFile), 'image/svg+xml']);
  if (typeof aqtaMarkFile === 'string' && statSync(aqtaMarkFile, { throwIfNoEntry: false })?.isFile()) staticFiles.set('/aqta-mark.svg', [resolve(aqtaMarkFile), 'image/svg+xml']);
  // Stage fonts come from outside the repository at run time, like the logos.
  const fonts = [];
  if (typeof fontDir === 'string') for (const name of ['body', 'mono', 'pen']) {
    const file = resolve(fontDir, `font-${name}.woff2`);
    if (statSync(file, { throwIfNoEntry: false })?.isFile()) { staticFiles.set(`/font-${name}.woff2`, [file, 'font/woff2']); fonts.push(name); }
  }
  for (const name of ['ron-wave', 'ron-think', 'ron-stamp', 'ron-phone', 'ron-cheer', 'ron-inspect', 'favicon-32', 'ron-face-180', 'ron-face-512']) staticFiles.set(`/ron/${name}.png`, [join(root, 'ron', `${name}.png`), 'image/png']);
  for (const { file, type } of Object.values(IMAGE_PRESETS)) staticFiles.set(`/samples/${file}`, [join(root, 'samples', file), type]);
  for (const [name, type] of [['LICENSE', 'text/plain'], ['NOTICE', 'text/plain'], ['ASSETS.md', 'text/markdown']]) {
    const file = join(root, name);
    if (statSync(file, { throwIfNoEntry: false })?.isFile()) staticFiles.set(`/${name}`, [file, type]);
  }
  if (hosted !== null && (!hosted || !['string', 'function'].includes(typeof hosted.origin))) throw new TypeError('Hosted mode needs a public origin.');
  if (hosted && (!demoAccess || typeof demoAccess.identity !== 'function' || typeof demoAccess.handle !== 'function'
    || !demoOwners || typeof demoOwners.ownerOf !== 'function' || typeof demoOwners.assign !== 'function' || typeof demoOwners.count !== 'function')) {
    throw new TypeError('Hosted mode requires verified demo access and an ownership store.');
  }
  const limits = { perWorkspaceDay: 12, perAddressDay: 30, perAddressPerMinute: 6, globalDay: 200, workflowsPerWorkspace: 30, maxWorkspaces: 5000, perAddressSessionsDay: 300, perAddressWorkspacesDay: 100, perAddressWorkflowsDay: 60, globalWorkflowsDay: 3000, maxConcurrentModelOps: 6, ...(hosted?.limits || {}) };
  if (hosted && process.env.SANDBOX_GLOBAL_MODEL_CALLS_DAY) { const cap = Number(process.env.SANDBOX_GLOBAL_MODEL_CALLS_DAY); if (!Number.isInteger(cap) || cap < 1 || cap > 100000) throw new TypeError('SANDBOX_GLOBAL_MODEL_CALLS_DAY must be a whole number of calls.'); limits.globalDay = cap; }
  const workspaces = new Map(), owners = new Map(), usage = new Map();
  const today = () => new Date().toISOString().slice(0, 10);
  let usageDay = today();
  const spend = keys => {
    const day = today();
    // Counters only matter for the current day, so they cannot grow without limit.
    if (day !== usageDay) { usage.clear(); usageDay = day; }
    for (const [name, limit] of keys) { const entry = usage.get(name); if (entry?.day === day && entry.count >= limit) return false; }
    for (const [name] of keys) { const entry = usage.get(name); usage.set(name, { day, count: entry?.day === day ? entry.count + 1 : 1 }); }
    return true;
  };
  const sessions = new Set(), runs = new Map(), running = new Set(), analysing = new Set(), reading = new Set(), operatorEvents = new Map();
  if (!Array.isArray(savedRecords)) throw new TypeError('Saved run records must be an array.');
  for (const record of savedRecords) {
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || typeof record.workflowId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(record.workflowId)
      || store.state(record.workflowId)?.workflowId !== record.workflowId
      || record.provider !== provider || record.model !== selected.model
      || !Array.isArray(record.agentRuns) || !Array.isArray(record.operatorEvents)
      || runs.has(record.workflowId)) {
      throw new TypeError('Saved run records must match existing workflows and the selected provider.');
    }
    // Only retained observations are restored. Authority and ledger state stay
    // in the workflow store, and operator browser sessions are never imported.
    runs.set(record.workflowId, structuredClone(record.agentRuns));
    operatorEvents.set(record.workflowId, structuredClone(record.operatorEvents));
  }
  // The browser needs the recorded steps, not the model's free text. Trimming it
  // here means the hosted demo cannot be used as a free general-purpose model.
  const trimText = (value, depth = 0) => {
    if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 300)}… [shortened]` : value;
    if (depth > 8) return null;
    if (Array.isArray(value)) return value.slice(0, 40).map(item => trimText(item, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, trimText(item, depth + 1)]));
    return value;
  };
  const publicRun = run => {
    if (!hosted || !run || typeof run !== 'object') return run;
    const { messages, ...kept } = run;
    return trimText({ ...kept, trace: (run.trace || []).filter(entry => entry?.type === 'tool_result' || entry?.type === 'model_error') });
  };
  const bursts = new Map();
  const logLimit = (name, address) => console.warn(`[abuse-limit] ${name} address=${createHash('sha256').update(address).digest('hex').slice(0, 12)}`);
  const dropWorkspace = id => {
    workspaces.delete(id);
    for (const [workflowId, owner] of owners) if (owner === id) { owners.delete(workflowId); runs.delete(workflowId); operatorEvents.delete(workflowId); }
  };
  const oldestIdleWorkspace = () => {
    const busy = new Set([...running, ...analysing].map(id => owners.get(id)));
    for (const id of workspaces.keys()) if (!busy.has(id)) return id;
    return null;
  };
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' });
      res.end(JSON.stringify(body));
    };
    try {
      const port = server.address()?.port;
      const publicOrigin = hosted ? new URL(typeof hosted.origin === 'function' ? hosted.origin() : hosted.origin).origin : null;
      const operatorCookieName = hosted ? '__Host-seal_review' : `sandbox_operator_${port}`;
      const cookieFlags = hosted ? '; Secure' : '';
      const hosts = hosted ? [new URL(publicOrigin).host] : [`localhost:${port}`, `127.0.0.1:${port}`];
      const origins = hosted ? [publicOrigin] : hosts.map(host => `http://${host}`);
      if (!hosts.includes(req.headers.host)) return send(403, { error: hosted ? 'Unknown host.' : 'Use the local preview address.' });
      const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(part => part.trim().split('=')).filter(([name, value]) => name && value).map(([name, value]) => [name, value]));
      let workspace = null, demoIdentity = null;
      const owns = id => !hosted || (demoIdentity !== null && demoOwners.ownerOf(id) === demoIdentity.owner_id);
      const rememberOwner = id => { if (hosted) { demoOwners.assign(id, demoIdentity.owner_id); owners.set(id, workspace); } };
      const requireCurrentAccess = async () => {
        if (!hosted) return;
        const current = await demoAccess.identity(req);
        if (!current?.approved || current.requires_use_case || current.owner_id !== demoIdentity?.owner_id) throw new Error('Demo access changed.');
      };
      const address = hosted ? (String(req.headers['x-forwarded-for'] || '').split(',').at(-1).trim() || req.socket.remoteAddress || 'unknown') : 'local';
      const modelBusy = () => {
        if (!hosted) return false;
        if (running.size + analysing.size + reading.size >= limits.maxConcurrentModelOps) { logLimit('concurrent', address); return true; }
        const now = Date.now(), recent = (bursts.get(address) || []).filter(at => now - at < 60000);
        if (recent.length >= limits.perAddressPerMinute) { bursts.set(address, recent); logLimit('burst', address); return true; }
        if (bursts.size > 20000) bursts.clear();
        bursts.set(address, [...recent, now]);
        return false;
      };
      const workflowBudget = () => !hosted || spend([[`wf:${address}`, limits.perAddressWorkflowsDay], ['wf:global', limits.globalWorkflowsDay]]);
      const modelOperationBudget = () => !hosted || spend([[`w:${workspace}`, limits.perWorkspaceDay], [`a:${address}`, limits.perAddressDay]]);
      const beforeModelRequest = () => {
        if (!hosted || spend([['global', limits.globalDay]])) return true;
        logLimit('daily-model-request', address);
        return false;
      };
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (hosted && await demoAccess.handle(req, res, url)) return;
      const protectedPage = ['/', '/glasses'].includes(url.pathname);
      const protectedApi = url.pathname.startsWith('/api/') && url.pathname !== '/api/reference-key';
      if (hosted && (protectedPage || protectedApi)) {
        try { demoIdentity = await demoAccess.identity(req); }
        catch {
          if (protectedApi) return send(503, { error: 'Demo access could not be confirmed. Try again.' });
          res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
          return res.end(readFileSync(join(root, 'access.html')));
        }
        if (!demoIdentity?.approved || demoIdentity.requires_use_case) {
          if (protectedApi) return send(demoIdentity ? 403 : 401, { error: demoIdentity ? 'Complete your demo access request before continuing.' : 'Sign in to the Seal demo.' });
          res.writeHead(303, { Location: `/access?${new URLSearchParams({ return: url.pathname + url.search })}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
          return res.end();
        }
        workspace = createHash('sha256').update('seal-demo-owner-v1\0').update(demoIdentity.owner_id).digest('hex');
        if (!workspaces.has(workspace)) {
          if (workspaces.size >= limits.maxWorkspaces) { const oldest = oldestIdleWorkspace(); if (oldest) dropWorkspace(oldest); }
          if (workspaces.size >= limits.maxWorkspaces) return send(429, { error: 'The demo is busy. Try again shortly.' });
          workspaces.set(workspace, { createdAt: Date.now() });
        }
      }
      if (req.method === 'GET' && staticFiles.has(url.pathname)) {
        const [file, type] = staticFiles.get(url.pathname);
        let content = readFileSync(file);
        if (hosted && protectedPage) content = Buffer.from(content.toString('utf8').replace('</head>', '<link rel="stylesheet" href="/access.css"></head>').replace('</body>', '<script type="module" src="/access-bar.js"></script></body>'));
        const headers = { 'Content-Type': type.startsWith('text/') ? `${type}; charset=utf-8` : type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
        if (hosted) Object.assign(headers, { 'Strict-Transport-Security': 'max-age=31536000', 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin' });
        if (url.pathname === '/' || url.pathname === '/glasses') {
          headers['Set-Cookie'] = [];
          // A returning visitor keeps their session and workspace, so reloading never uses up capacity.
          if (!sessions.has(cookies[operatorCookieName]) && (!hosted || spend([[`s:${address}`, limits.perAddressSessionsDay]]))) {
            const token = randomBytes(32).toString('hex'); sessions.add(token);
            if (sessions.size > 20000) sessions.delete(sessions.values().next().value);
            headers['Set-Cookie'].push(`${operatorCookieName}=${token}; HttpOnly; SameSite=Strict; Path=/${cookieFlags}`);
          }
          if (!headers['Set-Cookie'].length) delete headers['Set-Cookie'];
        }
        res.writeHead(200, headers); return res.end(content);
      }
      if (req.method === 'GET' && url.pathname === '/api/config') return send(200, { metaConfigured: Boolean(key), provider, model: selected.model, modelLabel: modelLabel ?? selected.label, simulation: true, ...(hosted ? { hosted: true } : {}), ...(staticFiles.has('/brand-mark.svg') ? { brandMark: true } : {}), ...(staticFiles.has('/aqta-mark.svg') ? { aqtaMark: true } : {}), ...(fonts.length ? { fonts } : {}),
        ...(documentFlow ? { documentFlow: true, documentProfile: 'SEAL-DOCUMENT-WORKFLOW-v2', referenceKey } : {}) });
      if (req.method === 'GET' && url.pathname === '/api/reference-key' && documentFlow) return send(200, referenceKey);
      if (hosted && url.pathname.startsWith('/api/') && url.pathname !== '/api/config' && !workspace) return send(401, { error: 'Open the workspace page to start a private workspace.' });
      if (req.method === 'GET' && url.pathname === '/api/workflows') {
        const listed = store.listWorkflows(100, hosted ? demoOwners.workflowIds(demoIdentity.owner_id, 100) : null);
        if (!Array.isArray(listed?.workflows)) return send(503, { error: 'The workspace could not be listed.' });
        return send(200, { workflows: listed.workflows.filter(item => owns(item.workflowId)).slice(0, 100).map(item => ({ ...item, running: running.has(item.workflowId) })), provider, model: selected.model });
      }
      const match = url.pathname.match(/^\/api\/workflows\/([a-zA-Z0-9_-]+)(?:\/(run|analyse|approve|decline|export))?$/);
      const publicState = id => ({ ...store.state(id), running: running.has(id), ...(documentFlow ? { analysing: analysing.has(id) } : {}), agentRuns: (runs.get(id) || []).map(publicRun), operatorEvents: operatorEvents.get(id) || [],
        provider, model: selected.model,
        scope: 'Synthetic payments in one local SQLite database. No production Seal or external payment service.', approverIdentityEstablished: false, ...(documentFlow ? { modelTraceScope: 'server_memory_only', documentFlow: true } : {}) });
      if (req.method === 'GET' && match && (!match[2] || match[2] === 'export')) {
        if (!owns(match[1]) || !store.state(match[1])?.workflowId) return send(404, { error: 'Workflow not found.' });
        return send(200, publicState(match[1]));
      }
      if (req.method !== 'POST') return send(404, { error: 'Route not found.' });
      if (!origins.includes(req.headers.origin)) return send(403, { error: hosted ? 'A matching Origin is required.' : 'A matching local Origin is required.' });
      if (!req.headers['content-type']?.startsWith('application/json')) return send(415, { error: 'Send JSON.' });
      const bodyLimit = documentFlow && url.pathname === '/api/document-workflows' ? 65536 : 16384;
      const chunks = []; let byteLength = 0;
      for await (const chunk of req) { byteLength += chunk.length; if (byteLength > bodyLimit) return send(413, { error: 'Request too large.' }); chunks.push(chunk); }
      let body;
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { return send(400, { error: 'Invalid JSON.' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return send(400, { error: 'Send a JSON object.' });
      await requireCurrentAccess();
      if (url.pathname === '/api/document-workflows') {
        if (!documentFlow) return send(403, { error: 'Document flow is not enabled in this local server.' });
        if (hosted && demoOwners.count(demoIdentity.owner_id) >= limits.workflowsPerWorkspace) return send(429, { error: `This demo account has reached its limit of ${limits.workflowsPerWorkspace} saved runs. Ask the team for more access.` });
        if (!workflowBudget()) return send(429, { error: 'Today’s demo limit for new runs is used up. Try again tomorrow.' });
        const created = store.createDocumentWorkflow(body);
        if (created.status === 'unavailable') return send(503, created);
        if (!created.workflowId) return send(400, created);
        rememberOwner(created.workflowId);
        return send(201, publicState(created.workflowId));
      }
      if (url.pathname === '/api/read-image') {
        if (!documentFlow) return send(403, { error: 'Document flow is not enabled in this local server.' });
        if (!exactBody(body, ['preset']) || typeof body.preset !== 'string' || !Object.hasOwn(IMAGE_PRESETS, body.preset)) return send(400, { error: 'Choose a supplied sample photo.' });
        if (!key) return send(503, { error: 'The selected model provider is not configured in the local server.' });
        if (reading.has(body.preset)) return send(409, { error: 'This photo is already being read.' });
        if (modelBusy()) return send(429, { error: 'Too many runs right now. Try again in a minute.' });
        if (!modelOperationBudget()) { logLimit('daily', address); return send(429, { error: 'Today’s model limit for this workspace is used up. Try again tomorrow.' }); }
        reading.add(body.preset);
        try {
          const result = await imageReader({ preset: body.preset, provider, apiKey: key, fetchImpl, beforeModelRequest, timeoutMs: 20000 });
          if (result?.reasonCode === MODEL_BUDGET_EXHAUSTED.reasonCode) return send(429, { ...MODEL_BUDGET_EXHAUSTED, requestCount: result.requestCount });
          if (!result || typeof result.text !== 'string') return send(503, { error: result?.error || 'The photo could not be read.' });
          return send(200, { text: result.text, preset: body.preset, kind: result.kind, provider, model: selected.model, imageSha256: result.imageSha256, reviewRequired: true });
        } finally { reading.delete(body.preset); }
      }
      if (url.pathname === '/api/workflows') {
        if (body.version !== undefined && body.version !== 1) return send(400, { error: 'Unsupported workflow version.' });
        if (!['legitimate', 'conflict'].includes(body.scenario)) return send(400, { error: 'Choose a supplied scenario.' });
        if (hosted && demoOwners.count(demoIdentity.owner_id) >= limits.workflowsPerWorkspace) return send(429, { error: `This demo account has reached its limit of ${limits.workflowsPerWorkspace} saved runs. Ask the team for more access.` });
        if (!workflowBudget()) return send(429, { error: 'Today’s demo limit for new runs is used up. Try again tomorrow.' });
        const created = store.createWorkflow({ scenario: body.scenario });
        if (created?.workflowId) rememberOwner(created.workflowId);
        return send(201, created);
      }
      if (!match) return send(404, { error: 'Route not found.' });
      const [, id, action] = match;
      if (!owns(id)) return send(404, { error: 'Workflow not found.' });
      const state = store.state(id);
      if (!state?.workflowId) return send(404, { error: 'Workflow not found.' });
      if (state.version === 2 && !documentFlow) return send(403, { error: 'Document flow is not enabled in this local server.' });
      if (action === 'analyse') {
        if (!documentFlow || state.version !== 2) return send(403, { error: 'Analysis requires an enabled document workflow.' });
        if (!key) return send(503, { error: 'The selected model provider is not configured in the local server.' });
        if (analysing.has(id) || running.has(id)) return send(409, { error: 'This case already has a model operation in progress.' });
        if (state.proposal || state.pendingReview || state.ledger.length || state.currentApproval?.source === 'operator_review') return send(409, { error: 'This case already has an analysis or authority decision. Create a fresh case.' });
        if (modelBusy()) return send(429, { error: 'Too many runs right now. Try again in a minute.' });
        if (!modelOperationBudget()) { logLimit('daily', address); return send(429, { error: 'Today’s model limit for this workspace is used up. Try again tomorrow.' }); }
        analysing.add(id);
        try {
          const result = await documentAgent({ documents: state.documents, sourceDigest: state.sourceDigest, provider, apiKey: key, fetchImpl, beforeModelRequest, timeoutMs: 20000 });
          if (result?.reasonCode === MODEL_BUDGET_EXHAUSTED.reasonCode) return send(429, { ...MODEL_BUDGET_EXHAUSTED, requestCount: result.requestCount });
          if (!result?.proposal) {
            const knownFailure = extractionFailureCodes.has(result?.reasonCode);
            return send(503, { proposal: null, error: 'The read-only document extraction could not complete.', reasonCode: knownFailure ? result.reasonCode : 'EXTRACTION_UNAVAILABLE', retryable: knownFailure && result.retryable === true });
          }
          await requireCurrentAccess();
          const recorded = store.recordProposal(id, result.proposal, state.sourceDigest);
          if (recorded.status === 'unavailable') return send(503, recorded);
          if (!recorded.workflowId) return send(409, recorded);
          return send(200, { ...publicState(id), analysing: false });
        } finally { analysing.delete(id); }
      }
      if (action === 'run') {
        if (analysing.has(id)) return send(409, { error: 'Wait for document analysis to finish.' });
        if (state.version === 2 && state.proposal?.status !== 'ready') return send(409, { error: 'A complete source-bound proposal is required. Clarification requires a new case.' });
        if (!key) return send(503, { error: 'The selected model provider is not configured in the local server.' });
        if (running.has(id)) return send(409, { error: 'This agent run is already in progress.' });
        if (state.pendingReview?.status === 'awaiting_human') return send(409, { error: 'An operator must decide the pending review first.' });
        if (state.ledger.length) return send(409, { error: 'This invoice already has a committed payment.' });
        if (modelBusy()) return send(429, { error: 'Too many runs right now. Try again in a minute.' });
        if (!modelOperationBudget()) { logLimit('daily', address); return send(429, { error: 'Today’s model limit for this workspace is used up. Try again tomorrow.' }); }
        running.add(id);
        try {
          let messages = (runs.get(id) || []).at(-1)?.messages;
          if (messages && state.currentApproval?.source === 'operator_review') messages = [...messages, { role: 'user', content: `Local operator update: this exact payment was approved through the review screen. Complete it once using the executor: ${JSON.stringify(state.currentApproval)}` }];
          const result = await modelRunner({ documents: store.readDocuments(id), messages, apiKey: key, fetchImpl, beforeModelRequest, maxRequests: 6, timeoutMs: 20000,
            toolHandler: async (name, args) => {
              if (name === 'read_documents') return store.readDocuments(id);
              if (name === 'execute_payment') { await requireCurrentAccess(); return store.executePayment(id, args); }
              if (name === 'request_approval') { await requireCurrentAccess(); return store.requestApproval(id, args); }
              return { status: 'blocked', reasonCode: 'UNKNOWN_TOOL' };
            } });
          runs.set(id, [...(runs.get(id) || []), result]);
          if (result?.reasonCode === MODEL_BUDGET_EXHAUSTED.reasonCode) return send(429, { ...publicState(id), running: false, ...MODEL_BUDGET_EXHAUSTED, requestCount: result.requestCount });
          return send(200, { ...publicState(id), running: false });
        } finally { running.delete(id); }
      }
      if (action === 'approve' || action === 'decline') {
        const token = cookies[operatorCookieName];
        if (!token || !sessions.has(token) || req.headers['x-operator-action'] !== 'review') return send(403, { error: 'Use the operator review screen.' });
        if (running.has(id) || analysing.has(id)) return send(409, { error: 'Wait for the model operation to stop before reviewing.' });
        if (body.confirm !== true) return send(400, { error: 'Confirm the exact reviewed values.' });
        const result = store[action](id, { reviewId: body.reviewId, digest: body.digest, expectedRevision: body.expectedRevision });
        if (result.status === 'unavailable') return send(503, result);
        if (result.status === 'blocked') return send(409, result);
        operatorEvents.set(id, [...(operatorEvents.get(id) || []), { action, reviewId: body.reviewId, digest: body.digest, at: new Date().toISOString(), channel: 'local_operator_screen', identityEstablished: false }]);
        return send(200, publicState(id));
      }
      return send(404, { error: 'Route not found.' });
    } catch { return send(503, { error: 'The sandbox operation could not complete. No external payment service is connected.' }); }
  });
  // Slow or stalled uploads must not hold connections open.
  server.headersTimeout = 10000; server.requestTimeout = 15000;
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const provider = process.env.PAYMENT_AGENT_PROVIDER || 'meta';
  if (!Object.hasOwn(providers, provider)) throw new Error('Choose the meta, wonder or baseten provider.');
  const hosted = process.env.SANDBOX_PUBLIC_ORIGIN ? { origin: publicOrigin(process.env.SANDBOX_PUBLIC_ORIGIN) } : null;
  const demoAccess = hosted ? demoAccessFromEnvironment(process.env) : null;
  const documentFlow = process.env.SANDBOX_DOCUMENT_FLOW === '1';
  if (process.env.SANDBOX_DOCUMENT_FLOW && !['0', '1'].includes(process.env.SANDBOX_DOCUMENT_FLOW)) throw new Error('Use 0 or 1 for the document flow setting.');
  const defaultFilename = join(root, '.data', provider === 'meta' ? 'sandbox.sqlite' : `${provider}-sandbox.sqlite`);
  let filename = defaultFilename, referenceSigner;
  if (!documentFlow) mkdirSync(join(root, '.data'), { recursive: true });
  if (documentFlow) {
    if (!process.env.SANDBOX_DATA_FILE || !process.env.SANDBOX_REFERENCE_KEY_FILE) throw new Error('Document flow requires separate trusted data and reference key files.');
    filename = resolve(process.env.SANDBOX_DATA_FILE);
    if (['sandbox.sqlite', 'baseten-sandbox.sqlite', 'wonder-sandbox.sqlite'].some(name => filename === join(root, '.data', name))) throw new Error('Document flow must use a separate database.');
    const keyFile = resolve(process.env.SANDBOX_REFERENCE_KEY_FILE);
    if (keyFile === filename || [filename + '-wal', filename + '-shm'].includes(keyFile)) throw new Error('The reference key must use a separate file.');
    mkdirSync(dirname(filename), { recursive: true });
    mkdirSync(dirname(keyFile), { recursive: true });
    referenceSigner = loadReferenceSigner(keyFile);
  }
  const store = new WorkflowStore({ filename, referenceSigner });
  const demoOwners = hosted ? new DemoOwnerStore({ filename }) : null;
  const port = Number(process.env.PORT || 4174);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use a local port from 1024 to 65535.');
  let savedRecords = [];
  if (process.env.SANDBOX_RUN_ARCHIVE) {
    try { savedRecords = JSON.parse(readFileSync(resolve(process.env.SANDBOX_RUN_ARCHIVE), 'utf8')); }
    catch { throw new Error('The saved run archive could not be read as JSON.'); }
  }
  const server = createServer({ store, provider, uiRoot: process.env.SANDBOX_UI_ROOT || root, savedRecords, documentFlow, referenceSigner, brandMarkFile: process.env.SANDBOX_BRAND_MARK, aqtaMarkFile: process.env.SANDBOX_AQTA_MARK, fontDir: process.env.SANDBOX_FONT_DIR,
    hosted, demoAccess, demoOwners });
  const listenHost = process.env.HOST || '127.0.0.1';
  if (listenHost !== '127.0.0.1' && !process.env.SANDBOX_PUBLIC_ORIGIN) throw new Error('Binding beyond loopback requires SANDBOX_PUBLIC_ORIGIN (hosted mode).');
  server.listen(port, listenHost, () => console.log(process.env.SANDBOX_PUBLIC_ORIGIN ? `Hosted sandbox for ${process.env.SANDBOX_PUBLIC_ORIGIN}` : `Local synthetic sandbox: http://localhost:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { store.close(); demoOwners?.close(); process.exit(0); }));
}
