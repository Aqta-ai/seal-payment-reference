import http from 'node:http';

/** Preverified identities for server tests only; no production auth bypass. */
export function demoAccessFixture() {
  const sessions = new Map();
  let sequence = 0;
  function signIn(previous = {}) {
    sequence += 1;
    const token = `test_google_${sequence}`;
    const principal = {
      owner_id: previous.owner_id || sequence.toString(16).padStart(32, '0'),
      email: previous.email || `reviewer${sequence}@example.test`,
      approved: previous.approved ?? true,
      requires_use_case: previous.requires_use_case ?? false,
      expires_at: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
    };
    sessions.set(token, principal);
    return { ...principal, token, cookie: `test_google_session=${token}` };
  }
  return {
    demoAccess: {
      handle: async () => false,
      identity: async req => {
        const values = (req.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith('test_google_session='));
        if (values.length !== 1) return null;
        const principal = sessions.get(values[0].slice('test_google_session='.length));
        return principal ? structuredClone(principal) : null;
      },
    },
    signIn,
    revoke: user => sessions.delete(user.token),
  };
}

export function withResponseCookies(cookie, setCookies = []) {
  const values = new Map(cookie.split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const equal = part.indexOf('=');
    return [part.slice(0, equal), part.slice(equal + 1)];
  }));
  for (const item of setCookies) {
    const part = item.split(';')[0], equal = part.indexOf('=');
    values.set(part.slice(0, equal), part.slice(equal + 1));
  }
  return [...values].map(([name, value]) => `${name}=${value}`).join('; ');
}

export function hostedRequest(server, { host: defaultHost = 'pay.example.test', origin: defaultOrigin = 'https://pay.example.test' } = {}) {
  return (method, path, { body, host = defaultHost, origin = defaultOrigin, cookie, headers = {} } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path,
      headers: { Host: host, ...(payload ? { 'Content-Type': 'application/json', Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
