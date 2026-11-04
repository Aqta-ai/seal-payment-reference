(() => {
  'use strict';
  if (document.querySelector('.demo-access-account')) return;
  const parent = document.querySelector('.topbar-right') || document.querySelector('.marks') || document.querySelector('header') || document.querySelector('main');
  if (!parent) return;
  const current = `${location.pathname}${location.search}${location.hash}`;
  const accessUrl = new URL('/access', location.origin);
  accessUrl.searchParams.set('return', current);
  const account = document.createElement('div');
  account.className = 'demo-access-account';
  const link = document.createElement('a');
  link.href = `${accessUrl.pathname}${accessUrl.search}`;
  link.textContent = 'Demo access';
  const button = document.createElement('button');
  button.className = 'demo-access-logout';
  button.type = 'button';
  button.textContent = 'Sign out';
  const status = document.createElement('span');
  status.className = 'demo-access-account-error';
  status.setAttribute('role', 'status');
  status.hidden = true;
  account.append(link, button, status);

  async function request(path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Seal-Demo-Action': 'logout' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = response.ok ? await response.json() : null;
      return { ok: response.ok, status: response.status, data };
    } finally { clearTimeout(timer); }
  }

  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true; button.textContent = 'Signing out…'; status.hidden = true;
    try {
      const response = await request('/auth/logout', {});
      if (!response.ok && response.status !== 401) throw new Error('Sign-out not confirmed.');
      if (response.ok) {
        if (response.data?.authenticated === true) throw new Error('Sign-out not confirmed.');
      }
      location.assign(response.data?.revocation_confirmed === false ? '/access?notice=local-signout' : '/access');
    } catch {
      status.textContent = 'Sign-out could not be confirmed. Please try again.';
      status.hidden = false;
    } finally { button.disabled = false; button.textContent = 'Sign out'; }
  });

  async function load() {
    try {
      const response = await request('/auth/session');
      if (response.status === 401) { location.replace(`${accessUrl.pathname}${accessUrl.search}`); return; }
      if (!response.ok) throw new Error('Access unavailable.');
      const data = response.data;
      if (data?.authenticated !== true || data.approved !== true || data.requires_use_case !== false) {
        location.replace(`${accessUrl.pathname}${accessUrl.search}`); return;
      }
      if (!document.querySelector('.demo-access-account')) parent.append(account);
    } catch {
      status.textContent = 'Demo access could not be confirmed. Reload to try again.';
      status.hidden = false;
      button.hidden = false;
      if (!document.querySelector('.demo-access-account')) parent.append(account);
    }
  }
  void load();
})();
