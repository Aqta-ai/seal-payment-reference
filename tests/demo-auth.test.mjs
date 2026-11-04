import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createDemoAccess, demoAccessFromEnvironment, demoReturnPath } from '../src/demo-auth.mjs';

const ORIGIN = 'https://agent.example.test';
const REGISTRY = 'https://registry.example.test';
const NOW = Date.UTC(2026, 10, 2, 18);
const config = { origin: ORIGIN, registryOrigin: REGISTRY, clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'fixture-client-secret',
  cookieSecret: 'fixture-cookie-secret-'.padEnd(48, 'c'), brokerSecret: 'fixture-broker-secret-'.padEnd(48, 'b') };
const token = 'a'.repeat(64);
const owner = 'b'.repeat(32);
const cookies = response => (response.headers['set-cookie'] || []).map(value => value.split(';')[0]).filter(value => !value.endsWith('=')).join('; ');
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

async function fixture(t, { approved = true, requiresUseCase = true, customFetch, clock = () => NOW } = {}) {
  let current = { owner_id: owner, email: 'judge@example.test', approved, requires_use_case: requiresUseCase,
    expires_at: new Date(NOW + 8 * 3600000).toISOString() };
  let active = false, authUrl;
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (customFetch) { const answer = await customFetch(url, options); if (answer) return answer; }
    if (url === 'https://oauth2.googleapis.com/token') {
      const body = new URLSearchParams(options.body);
      assert.equal(body.get('redirect_uri'), ORIGIN + '/auth/callback');
      assert.equal(body.get('client_id'), config.clientId);
      assert.equal(body.get('client_secret'), config.clientSecret);
      assert.equal(body.get('grant_type'), 'authorization_code');
      assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), authUrl.searchParams.get('code_challenge'));
      return json({ id_token: 'fixture-google-id-token', access_token: 'discarded-fixture-access-token' });
    }
    assert.equal(options.headers['X-Demo-Broker'], config.brokerSecret);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    if (url === REGISTRY + '/v1/demo-access/exchange') {
      assert.deepEqual(JSON.parse(options.body), { id_token: 'fixture-google-id-token', nonce: authUrl.searchParams.get('nonce') });
      active = true; return json({ token, ...current });
    }
    assert.equal(options.headers['X-Demo-Session'], token);
    if (!active) return json({ detail: 'A valid demo sign-in is required.' }, 401);
    if (url.endsWith('/introspect')) return json(current);
    if (url.endsWith('/intake')) { assert.equal(typeof JSON.parse(options.body).building, 'string'); current = { ...current, requires_use_case: false }; return json(current); }
    if (url.endsWith('/logout')) { active = false; return json({ ok: true }); }
    assert.fail('Unexpected fixture network route');
  };
  const access = createDemoAccess(config, { fetchImpl, now: clock });
  const server = http.createServer(async (req, res) => {
    if (!await access.handle(req, res, new URL(req.url, ORIGIN))) { res.writeHead(404); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const request = (path, { method = 'GET', body, cookie, headers = {} } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(payload ? { 'Content-Type': 'application/json', Origin: ORIGIN } : {}), ...headers } }, response => {
      const parts = []; response.on('data', part => parts.push(part)); response.on('end', () => {
        const text = Buffer.concat(parts).toString(); resolve({ status: response.statusCode, headers: response.headers, text, json: () => JSON.parse(text) });
      });
    });
    req.on('error', reject); if (payload) req.write(payload); req.end();
  });
  async function begin(returnTo = '/stage') {
    const response = await request('/auth/google?' + new URLSearchParams({ return: returnTo }));
    authUrl = new URL(response.headers.location);
    return { response, cookie: cookies(response), url: authUrl };
  }
  async function login(returnTo) {
    const start = await begin(returnTo);
    const response = await request('/auth/callback?' + new URLSearchParams({ code: 'fixture-one-time-code', state: start.url.searchParams.get('state') }), { cookie: start.cookie });
    return { ...start, callback: response, cookie: cookies(response) };
  }
  return { request, begin, login, calls, change: update => { current = { ...current, ...update }; }, invalidate: () => { active = false; }, access };
}

test('OAuth uses server code flow, nonce, state, S256 and a protected opaque state cookie', async t => {
  const f = await fixture(t); const { response, url, cookie } = await f.begin('/stage');
  assert.equal(response.status, 302); assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('scope'), 'openid email');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(url.searchParams.get('state'), /^[A-Za-z0-9_-]{43}$/);
  assert.match(url.searchParams.get('nonce'), /^[A-Za-z0-9_-]{43}$/);
  assert.match(cookie, /^__Host-seal_demo_oauth=/);
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=600']) assert.ok(response.headers['set-cookie'][0].includes(flag));
  assert.equal(cookie.includes(url.searchParams.get('state')), false);
  assert.equal(f.calls.length, 0);
});

test('callback uses the stored verifier and nonce, then keeps tokens out of browser-readable output', async t => {
  const f = await fixture(t); const result = await f.login('/stage');
  assert.equal(result.callback.status, 303);
  assert.equal(result.callback.headers.location, '/access?return=%2Fstage');
  assert.match(result.cookie, /^__Host-seal_demo_session=/);
  assert.equal(result.cookie.includes('next-auth'), false);
  assert.ok(result.callback.headers['set-cookie'].some(value => value.startsWith('__Host-seal_demo_oauth=;')));
  const status = await f.request('/auth/session?return=%2Fstage', { cookie: result.cookie });
  assert.deepEqual(status.json(), { authenticated: true, email: 'judge@example.test', approved: true, requires_use_case: true,
    expires_at: new Date(NOW + 8 * 3600000).toISOString(), return_to: '/stage' });
  assert.equal(status.text.includes(token), false); assert.equal(status.text.includes(owner), false);
  assert.equal(status.text.includes('fixture-google-id-token'), false);
});

test('pending intake is saved without approving access and preserves the stage destination', async t => {
  const f = await fixture(t, { approved: false }); const session = await f.login('/stage');
  const result = await f.request('/auth/intake?return=%2Fstage', { method: 'POST', body: { building: 'Invoice review for our team' }, cookie: session.cookie, headers: { 'X-Seal-Demo-Action': 'intake' } });
  assert.equal(result.status, 200); assert.equal(result.json().approved, false);
  assert.equal(result.json().requires_use_case, false); assert.equal(result.json().return_to, '/stage');
  assert.equal(f.calls.filter(call => call.url.endsWith('/intake')).length, 1);
});

test('approved returning users go straight to their saved demo destination', async t => {
  const f = await fixture(t, { requiresUseCase: false });
  for (const path of ['/', '/?workflow=wf_fixture', '/stage?case=one#review', '/glasses']) {
    const session = await f.login(path);
    assert.equal(session.callback.status, 303);
    assert.equal(session.callback.headers.location, path === '/' ? '/?view=run' : path);
  }
});

test('callback keeps pending invitation and required intake on the access page', async t => {
  for (const state of [{ approved: false, requiresUseCase: false }, { approved: true, requiresUseCase: true }]) {
    const f = await fixture(t, state);
    const session = await f.login('/');
    assert.equal(session.callback.headers.location, '/access?return=%2F%3Fview%3Drun');
  }
});

test('introspection rechecks approval and revocation; logout revokes then clears the host cookie', async t => {
  const f = await fixture(t); const session = await f.login('/');
  f.change({ approved: false });
  assert.equal((await f.request('/auth/session', { cookie: session.cookie })).json().approved, false);
  const out = await f.request('/auth/logout', { method: 'POST', body: {}, cookie: session.cookie, headers: { 'X-Seal-Demo-Action': 'logout' } });
  assert.equal(out.status, 200); assert.equal(out.json().authenticated, false);
  assert.equal(out.json().revocation_confirmed, true);
  assert.match(out.headers['set-cookie'][0], /^__Host-seal_demo_session=;.*Max-Age=0/);
  assert.equal((await f.request('/auth/session', { cookie: session.cookie })).json().authenticated, false);
});

test('a registry outage fails closed and cannot be misreported as anonymous or saved', async t => {
  let broken = false;
  const f = await fixture(t, { customFetch: async url => broken && url.startsWith(REGISTRY) ? json({ detail: 'fixture-sensitive-upstream-body' }, 500) : null });
  const session = await f.login('/'); broken = true;
  const status = await f.request('/auth/session', { cookie: session.cookie });
  assert.equal(status.status, 503); assert.equal(status.text.includes('fixture-sensitive'), false);
  const saved = await f.request('/auth/intake', { method: 'POST', cookie: session.cookie, body: { building: 'A payment tool' }, headers: { 'X-Seal-Demo-Action': 'intake' } });
  assert.equal(saved.status, 503);
});

test('explicit logout clears the browser cookie during an outage without claiming remote revocation', async t => {
  let broken = false;
  const f = await fixture(t, { customFetch: async url => broken && url.startsWith(REGISTRY) ? json({}, 503) : null });
  const session = await f.login('/'); broken = true;
  const result = await f.request('/auth/logout', { method: 'POST', body: {}, cookie: session.cookie, headers: { 'X-Seal-Demo-Action': 'logout' } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json(), { authenticated: false, revocation_confirmed: false });
  assert.match(result.headers['set-cookie'][0], /^__Host-seal_demo_session=;.*Max-Age=0/);
  const local = await f.request('/auth/session');
  assert.equal(local.status, 200);
  assert.equal(local.json().authenticated, false);
});

test('a broker rejection is not treated as proof of session revocation', async t => {
  let broken = false;
  const f = await fixture(t, { customFetch: async url => broken && url.endsWith('/logout') ? json({}, 401) : null });
  const session = await f.login('/'); broken = true;
  const result = await f.request('/auth/logout', { method: 'POST', body: {}, cookie: session.cookie, headers: { 'X-Seal-Demo-Action': 'logout' } });
  assert.deepEqual(result.json(), { authenticated: false, revocation_confirmed: false });
  assert.match(result.headers['set-cookie'][0], /^__Host-seal_demo_session=;.*Max-Age=0/);
  assert.equal((await f.request('/auth/session', { cookie: session.cookie })).json().authenticated, true);
});

test('explicit logout without a valid cookie still clears the browser credential', async t => {
  const f = await fixture(t);
  const result = await f.request('/auth/logout', { method: 'POST', body: {}, headers: { 'X-Seal-Demo-Action': 'logout' } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json(), { authenticated: false, revocation_confirmed: false });
  assert.match(result.headers['set-cookie'][0], /^__Host-seal_demo_session=;.*Max-Age=0/);
  assert.equal(f.calls.length, 0);
});

test('cross-origin, missing action headers, duplicate cookies and malformed input make no intake call', async t => {
  const f = await fixture(t); const session = await f.login('/');
  const attempt = headers => f.request('/auth/intake', { method: 'POST', cookie: session.cookie, body: { building: 'A payment tool' }, headers });
  assert.equal((await attempt({ Origin: 'https://other.example', 'X-Seal-Demo-Action': 'intake' })).status, 403);
  assert.equal((await attempt({})).status, 403);
  assert.equal((await f.request('/auth/intake', { method: 'POST', body: { building: 'x', approved: true }, cookie: session.cookie, headers: { 'X-Seal-Demo-Action': 'intake' } })).status, 400);
  assert.equal((await f.request('/auth/intake', { method: 'POST', body: { building: 'x'.repeat(1001) }, cookie: session.cookie, headers: { 'X-Seal-Demo-Action': 'intake' } })).status, 400);
  const duplicate = session.cookie + '; ' + session.cookie;
  assert.equal((await f.request('/auth/session', { cookie: duplicate })).json().authenticated, false);
  assert.equal(f.calls.filter(call => call.url.endsWith('/intake')).length, 0);
});

for (const variant of ['missing-cookie', 'tampered-cookie', 'wrong-state', 'duplicate-state', 'duplicate-code', 'google-error', 'expired']) {
  test(`callback rejects ${variant} before any token exchange`, async t => {
    let time = NOW; const f = await fixture(t, { clock: () => time }); const start = await f.begin('/');
    let cookie = start.cookie;
    const query = new URLSearchParams({ code: 'fixture-code', state: start.url.searchParams.get('state') });
    if (variant === 'missing-cookie') cookie = '';
    if (variant === 'tampered-cookie') cookie = start.cookie.slice(0, -1) + (start.cookie.endsWith('a') ? 'b' : 'a');
    if (variant === 'wrong-state') query.set('state', 'x'.repeat(43));
    if (variant === 'duplicate-state') query.append('state', query.get('state'));
    if (variant === 'duplicate-code') query.append('code', 'another-code');
    if (variant === 'google-error') query.set('error', 'access_denied');
    if (variant === 'expired') time += 601000;
    const result = await f.request('/auth/callback?' + query, { cookie });
    assert.equal(result.status, 303); assert.equal(result.headers.location, '/access?error=signin');
    assert.equal(f.calls.length, 0); assert.equal(result.text.includes('fixture'), false);
  });
}

test('bad exchange and unexpected session shapes never set a demo session', async t => {
  const f = await fixture(t, { customFetch: async url => url.endsWith('/exchange') ? json({ token, owner_id: owner, email: 'judge@example.test', approved: true, requires_use_case: false, expires_at: new Date(NOW + 24 * 3600000).toISOString() }) : null });
  const result = await f.login('/');
  assert.equal(result.callback.headers.location, '/access?error=signin');
  assert.equal((result.callback.headers['set-cookie'] || []).some(value => value.startsWith('__Host-seal_demo_session=')), false);
});

test('only the dedicated host cookie is accepted; private dashboard cookies grant no demo identity', async t => {
  const f = await fixture(t); const result = await f.request('/auth/session', { cookie: '__Secure-next-auth.session-token=fixture; aqta_session=fixture; __Host-seal_workspace=' + token });
  assert.equal(result.json().authenticated, false); assert.equal(f.calls.length, 0);
});

test('configuration fails closed without dedicated values and conceals malformed origin inputs', () => {
  assert.throws(() => demoAccessFromEnvironment({}), /configuration is unavailable/);
  for (const patch of [{ origin: 'http://agent.example.test' }, { registryOrigin: 'https://user:fixture-secret@registry.example.test' }, { cookieSecret: config.brokerSecret }, { brokerSecret: config.clientSecret }, { clientId: '' }]) {
    assert.throws(() => createDemoAccess({ ...config, ...patch }), error => error.message === 'Demo access configuration is unavailable.');
  }
});

test('return paths stay on the three supported demo surfaces', () => {
  for (const value of ['/', '/stage', '/glasses', '/?view=run', '/stage?case=one#review']) assert.equal(demoReturnPath(value), value);
  for (const value of ['https://other.example', '//other.example', '/\\other.example', '/%2fother.example', '/admin', '/stage%0a', '/stage?x=%5c', '/stage?x=%', '/stage\t']) assert.equal(demoReturnPath(value), '/');
});
