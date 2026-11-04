import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const SESSION_COOKIE = '__Host-seal_demo_session';
const OAUTH_COOKIE = '__Host-seal_demo_oauth';
const OAUTH_TTL = 600;
const SESSION_TTL = 8 * 60 * 60;
const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const HEX_SESSION = /^[a-f0-9]{64}$/;
const B64 = /^[A-Za-z0-9_-]+$/;
const PATHS = new Set(['/', '/stage', '/glasses']);

export class DemoAccessError extends Error {
  constructor(status = 503) { super(status === 401 ? 'Sign in to the demo again.' : 'Demo access could not be confirmed. Try again.'); this.status = status; }
}

function origin(value, allowLoopback) {
  if (typeof value !== 'string' || /[\s\\]/.test(value)) throw new TypeError('Demo access configuration is unavailable.');
  let url;
  try { url = new URL(value); } catch { throw new TypeError('Demo access configuration is unavailable.'); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || (url.protocol !== 'https:' && !(allowLoopback && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))) {
    throw new TypeError('Demo access configuration is unavailable.');
  }
  return url.origin;
}

export function demoReturnPath(value) {
  if (typeof value !== 'string' || value.length > 1024 || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(value)) return '/';
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(decoded)) return '/';
    const url = new URL(value, 'https://demo.invalid');
    return url.origin === 'https://demo.invalid' && PATHS.has(url.pathname) ? url.pathname + url.search + url.hash : '/';
  } catch { return '/'; }
}

function oneCookie(req, name, pattern, max) {
  const raw = req.headers.cookie || '';
  if (typeof raw !== 'string' || raw.length > 16384) return null;
  const matches = raw.split(';').map(part => part.trim()).filter(part => part.startsWith(name + '='));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(name.length + 1);
  return value.length <= max && pattern.test(value) ? value : null;
}

function cookie(name, value, maxAge, secure = true) {
  return `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function appendCookie(res, value) {
  const previous = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(Array.isArray(previous) ? previous : previous ? [previous] : []), value]);
}

function send(res, status, body) {
  res.writeHead(status, { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(stream, maximum = 16384) {
  const chunks = []; let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maximum) throw new DemoAccessError(413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new DemoAccessError(400); }
}

async function responseJson(response, maximum = 32768) {
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new DemoAccessError();
  if (!response.body) throw new DemoAccessError();
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new DemoAccessError(); }
      chunks.push(Buffer.from(next.value));
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new DemoAccessError(); }
}

function publicIdentity(identity, returnTo) {
  return { authenticated: true, email: identity.email, approved: identity.approved,
    requires_use_case: identity.requires_use_case, expires_at: identity.expires_at, return_to: returnTo };
}

/** A demo-specific OIDC boundary. It never creates product sessions or API keys. */
export function createDemoAccess(config, { fetchImpl = globalThis.fetch, now = Date.now, allowLoopback = false } = {}) {
  const publicOrigin = origin(config?.origin, allowLoopback);
  const registryOrigin = origin(config?.registryOrigin, allowLoopback);
  const { clientId, clientSecret, cookieSecret, brokerSecret } = config || {};
  if ([clientId, clientSecret].some(value => typeof value !== 'string' || !value || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value))
    || [cookieSecret, brokerSecret].some(value => typeof value !== 'string' || Buffer.byteLength(value) < 32 || Buffer.byteLength(value) > 4096)
    || cookieSecret === brokerSecret || cookieSecret === clientSecret || brokerSecret === clientSecret) throw new TypeError('Demo access configuration is unavailable.');
  const secure = new URL(publicOrigin).protocol === 'https:';
  const sessionName = secure ? SESSION_COOKIE : 'seal_demo_session_local';
  const oauthName = secure ? OAUTH_COOKIE : 'seal_demo_oauth_local';
  const callbackUrl = publicOrigin + '/auth/callback';
  const stateKey = createHash('sha256').update('seal-demo-oauth-v1\0').update(cookieSecret).digest();
  const attempts = new Map();

  function encrypt(value) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', stateKey, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
  }

  function decrypt(value) {
    if (!value || !B64.test(value)) throw new DemoAccessError(401);
    try {
      const bytes = Buffer.from(value, 'base64url');
      if (bytes.toString('base64url') !== value || bytes.length < 29) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', stateKey, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const state = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
      if (!state || Object.keys(state).sort().join(',') !== 'created,nonce,return_to,state,v,verifier'
        || state.v !== 1 || !Number.isSafeInteger(state.created) || now() - state.created > OAUTH_TTL * 1000 || state.created > now() + 30000
        || [state.state, state.nonce, state.verifier].some(item => typeof item !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(item))
        || demoReturnPath(state.return_to) !== state.return_to) throw new Error();
      return state;
    } catch { throw new DemoAccessError(401); }
  }

  function validateIdentity(value, tokenRequired = false) {
    const expires = Date.parse(value?.expires_at);
    if (!value || typeof value !== 'object' || !/^[a-f0-9]{32}$/.test(value.owner_id || '')
      || typeof value.email !== 'string' || value.email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(value.email)
      || typeof value.approved !== 'boolean' || typeof value.requires_use_case !== 'boolean'
      || !Number.isFinite(expires) || expires <= now() || expires > now() + (SESSION_TTL + 60) * 1000
      || (tokenRequired && !HEX_SESSION.test(value.token || ''))) throw new DemoAccessError();
    return value;
  }

  async function registry(path, body, token) {
    try {
      const response = await fetchImpl(`${registryOrigin}/v1/demo-access/${path}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Demo-Broker': brokerSecret,
          ...(token ? { 'X-Demo-Session': token } : {}) }, body: JSON.stringify(body),
      });
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new DemoAccessError(response.status === 401 ? 401 : response.status === 400 ? 400 : 503); }
      return await responseJson(response);
    } catch (error) { if (error instanceof DemoAccessError) throw error; throw new DemoAccessError(); }
  }

  async function identity(req) {
    const token = oneCookie(req, sessionName, HEX_SESSION, 64);
    if (!token) return null;
    try { return validateIdentity(await registry('introspect', {}, token)); }
    catch (error) { if (error instanceof DemoAccessError && error.status === 401) return null; throw error; }
  }

  async function handle(req, res, url) {
    if (!['/auth/google', '/auth/callback', '/auth/session', '/auth/intake', '/auth/logout'].includes(url.pathname)) return false;
    const read = ['/auth/google', '/auth/callback', '/auth/session'].includes(url.pathname);
    if (req.method !== (read ? 'GET' : 'POST')) { send(res, 405, { error: 'This access action uses a different method.' }); return true; }
    const returnTo = demoReturnPath(url.searchParams.get('return'));
    try {
      if (url.pathname === '/auth/google') {
        const address = String(req.headers['x-forwarded-for'] || '').split(',').at(-1).trim() || req.socket.remoteAddress || 'unknown';
        const minute = Math.floor(now() / 60000);
        if (attempts.size >= 1000) for (const [key, entry] of attempts) if (entry.minute < minute - 1) attempts.delete(key);
        const seen = attempts.get(address);
        if (seen?.minute === minute && seen.count >= 10) { send(res, 429, { error: 'Too many sign-in attempts. Try again in a minute.' }); return true; }
        if (attempts.size >= 10000 && !attempts.has(address)) { send(res, 429, { error: 'Sign-in is busy. Try again shortly.' }); return true; }
        attempts.set(address, { minute, count: seen?.minute === minute ? seen.count + 1 : 1 });
        const state = { v: 1, state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'),
          verifier: randomBytes(32).toString('base64url'), created: now(), return_to: returnTo };
        appendCookie(res, cookie(oauthName, encrypt(state), OAUTH_TTL, secure));
        const target = new URL(GOOGLE_AUTHORIZE);
        target.search = new URLSearchParams({ client_id: clientId, redirect_uri: callbackUrl, response_type: 'code', scope: 'openid email',
          state: state.state, nonce: state.nonce, code_challenge: createHash('sha256').update(state.verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'select_account' }).toString();
        res.writeHead(302, { ...HEADERS, Location: target.href }); res.end(); return true;
      }
      if (url.pathname === '/auth/callback') {
        appendCookie(res, cookie(oauthName, '', 0, secure));
        const state = decrypt(oneCookie(req, oauthName, B64, 4096));
        const supplied = url.searchParams.getAll('state'), codes = url.searchParams.getAll('code');
        if (supplied.length !== 1 || codes.length !== 1 || !codes[0] || codes[0].length > 4096 || url.searchParams.has('error')
          || Buffer.byteLength(supplied[0]) !== Buffer.byteLength(state.state)
          || !timingSafeEqual(Buffer.from(supplied[0]), Buffer.from(state.state))) throw new DemoAccessError(401);
        const response = await fetchImpl(GOOGLE_TOKEN, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams({ code: codes[0], client_id: clientId, client_secret: clientSecret, redirect_uri: callbackUrl,
            grant_type: 'authorization_code', code_verifier: state.verifier }).toString() });
        if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new DemoAccessError(401); }
        const google = await responseJson(response);
        if (typeof google?.id_token !== 'string' || !google.id_token || google.id_token.length > 8192) throw new DemoAccessError(401);
        const result = validateIdentity(await registry('exchange', { id_token: google.id_token, nonce: state.nonce }), true);
        appendCookie(res, cookie(sessionName, result.token, Math.min(SESSION_TTL, Math.floor((Date.parse(result.expires_at) - now()) / 1000)), secure));
        const destination = state.return_to === '/' ? '/?view=run' : state.return_to;
        const location = result.approved && !result.requires_use_case
          ? destination : `/access?${new URLSearchParams({ return: destination })}`;
        res.writeHead(303, { ...HEADERS, Location: location }); res.end(); return true;
      }
      if (url.pathname === '/auth/session') {
        const current = await identity(req);
        send(res, 200, current ? publicIdentity(current, returnTo) : { authenticated: false, return_to: returnTo }); return true;
      }
      if (req.headers.origin !== publicOrigin || req.headers['x-seal-demo-action'] !== (url.pathname === '/auth/intake' ? 'intake' : 'logout')) throw new DemoAccessError(403);
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) throw new DemoAccessError(415);
      const token = oneCookie(req, sessionName, HEX_SESSION, 64);
      const body = await readJson(req);
      if (url.pathname === '/auth/intake') {
        if (!token) throw new DemoAccessError(401);
        if (Object.keys(body).length !== 1 || typeof body.building !== 'string' || !body.building.trim() || body.building.length > 1000) throw new DemoAccessError(400);
        const result = validateIdentity(await registry('intake', { building: body.building.trim() }, token));
        send(res, 200, publicIdentity(result, returnTo)); return true;
      }
      if (Object.keys(body).length) throw new DemoAccessError(400);
      let revocationConfirmed = false;
      if (token) {
        try { await registry('logout', {}, token); revocationConfirmed = true; }
        catch { /* A failed broker request does not prove session revocation. */ }
      }
      // Explicit sign-out always removes this browser's credential, including
      // during a registry outage. Report the remote revocation separately.
      appendCookie(res, cookie(sessionName, '', 0, secure));
      send(res, 200, { authenticated: false, revocation_confirmed: revocationConfirmed }); return true;
    } catch (error) {
      if (url.pathname === '/auth/callback') {
        res.writeHead(303, { ...HEADERS, Location: '/access?error=signin' }); res.end();
      } else {
        const status = error instanceof DemoAccessError ? error.status : 503;
        send(res, status, { error: status === 400 ? 'Check your answer and try again.' : status === 401 ? 'Sign in to the demo again.'
          : status === 403 ? 'Open this action from the Seal demo.' : status === 413 ? 'Keep your answer within 1,000 characters.'
            : status === 415 ? 'Send this answer from the access form.' : 'Demo access could not be confirmed. Try again.' });
      }
      return true;
    }
  }
  return Object.freeze({ handle, identity });
}

export function demoAccessFromEnvironment(environment, options) {
  return createDemoAccess({ origin: environment.SANDBOX_PUBLIC_ORIGIN, registryOrigin: environment.DEMO_ACCESS_REGISTRY_ORIGIN,
    clientId: environment.DEMO_GOOGLE_CLIENT_ID, clientSecret: environment.DEMO_GOOGLE_CLIENT_SECRET,
    cookieSecret: environment.DEMO_AUTH_COOKIE_SECRET, brokerSecret: environment.DEMO_ACCESS_BROKER_SECRET }, options);
}
