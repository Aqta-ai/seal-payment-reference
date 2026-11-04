(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const loading = byId('access-loading');
  const errorBox = byId('access-error');
  const retry = byId('access-retry');
  const anonymous = byId('access-anonymous');
  const signedIn = byId('access-signed-in');
  const form = byId('access-form');
  const building = byId('access-building');
  const save = byId('access-save');
  const logout = byId('access-logout');
  const result = byId('access-result');
  const open = byId('access-open');
  let busy = false;
  const defaultReturn = '/?view=run';
  let returnTo = defaultReturn;

  function safeReturn(value) {
    if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.length > 2000) return defaultReturn;
    try {
      if (/[\\\u0000-\u0020\u007f]/.test(value) || /[\\\u0000-\u001f\u007f]/.test(decodeURIComponent(value))) return defaultReturn;
      const url = new URL(value, location.origin);
      if (url.origin !== location.origin || !['/', '/stage', '/glasses'].includes(url.pathname)) return defaultReturn;
      const path = `${url.pathname}${url.search}${url.hash}`;
      return path === '/' ? defaultReturn : path;
    } catch { return defaultReturn; }
  }

  function setBusy(value) {
    busy = value;
    building.disabled = value;
    save.disabled = value;
    logout.disabled = value;
    retry.disabled = value;
    form.setAttribute('aria-busy', String(value));
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function clearError() { errorBox.textContent = ''; errorBox.hidden = true; retry.hidden = true; }

  async function request(path, body, action) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Seal-Demo-Action': action },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status === 401) return { authenticated: false, return_to: returnTo };
      if (!response.ok) throw new Error('We could not confirm your demo access. Please try again.');
      const data = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('We could not confirm your demo access. Please try again.');
      return data;
    } finally { clearTimeout(timer); }
  }

  function render(data) {
    if (typeof data.authenticated !== 'boolean') throw new Error('We could not confirm your demo access. Please try again.');
    returnTo = safeReturn(data.return_to ?? returnTo);
    const login = new URL('/auth/google', location.origin);
    login.searchParams.set('return', returnTo);
    byId('access-google').href = `${login.pathname}${login.search}`;
    document.querySelector('.demo-access-intro').textContent = data.authenticated
      ? (data.requires_use_case ? 'One detail before you try the payment demo.' : 'Demo access is by invitation.')
      : 'Run a synthetic payment, change the account, then check the record.';
    loading.hidden = true;
    anonymous.hidden = data.authenticated;
    signedIn.hidden = !data.authenticated;
    logout.hidden = !data.authenticated;
    if (!data.authenticated) return;
    if (typeof data.email !== 'string' || !data.email || typeof data.approved !== 'boolean' || typeof data.requires_use_case !== 'boolean') {
      signedIn.hidden = true;
      throw new Error('We could not confirm your demo access. Please try again.');
    }
    byId('access-email').textContent = data.email;
    form.hidden = !data.requires_use_case;
    result.hidden = data.requires_use_case;
    if (!data.requires_use_case) {
      byId('access-result-copy').textContent = data.approved ? 'Your demo access is ready.' : 'Your answer is saved. Demo access is by invitation.';
      open.href = returnTo;
      open.hidden = !data.approved;
    }
  }

  async function load() {
    if (busy) return;
    setBusy(true); clearError(); loading.hidden = false;
    try {
      const query = new URLSearchParams({ return: returnTo });
      render(await request(`/auth/session?${query}`));
      if (new URL(location.href).searchParams.get('error') === 'signin') showError('Sign-in could not be completed. Please try again.');
      if (new URL(location.href).searchParams.get('notice') === 'local-signout') showError('Signed out in this browser. Server session revocation could not be confirmed.');
    } catch {
      loading.hidden = true;
      anonymous.hidden = true;
      signedIn.hidden = true;
      logout.hidden = false;
      showError('We could not confirm your demo access. Please try again.');
      retry.hidden = false;
    } finally { setBusy(false); }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !form.reportValidity()) return;
    const answer = building.value.trim();
    if (!answer) { building.setCustomValidity('Please tell us what you are building.'); building.reportValidity(); return; }
    if (answer.length > 1000) { showError('Keep your answer to 1,000 characters.'); return; }
    setBusy(true); clearError(); save.textContent = 'Saving answer…';
    try {
      const data = await request(`/auth/intake?${new URLSearchParams({ return: returnTo })}`, { building: answer }, 'intake');
      render(data);
      if (data.authenticated === true && data.approved === true && data.requires_use_case === false) {
        byId('access-result-copy').textContent = 'Opening the payment demo…';
        location.assign(returnTo);
      }
    }
    catch { showError('Your answer could not be confirmed as saved. Please try again.'); }
    finally { setBusy(false); save.textContent = 'Continue to demo'; }
  });
  building.addEventListener('input', () => {
    building.setCustomValidity('');
    byId('access-building-count').textContent = `${building.value.length.toLocaleString('en-IE')} of 1,000 characters`;
  });
  logout.addEventListener('click', async () => {
    if (busy) return;
    setBusy(true); clearError(); logout.textContent = 'Signing out…';
    try {
      const response = await request('/auth/logout', {}, 'logout');
      if (response.authenticated === true) throw new Error('Sign-out was not confirmed.');
      location.assign(response.revocation_confirmed === false ? '/access?notice=local-signout' : '/access');
    } catch { showError('Sign-out could not be confirmed. Please try again.'); }
    finally { setBusy(false); logout.textContent = 'Sign out'; }
  });
  retry.addEventListener('click', () => void load());
  returnTo = safeReturn(new URL(location.href).searchParams.get('return'));
  void load();
})();
