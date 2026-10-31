/**
 * The setup wizard's page (/admin/setup/), on the admin listener only. It holds nothing secret: it asks for the admin
 * token, keeps it in memory for this page only (never in storage), and sends it as a bearer token to /v1/setup. Secret
 * fields are password inputs that are cleared once sent, and the API only ever answers whether a secret is set.
 */
export const SETUP_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>JellyPass setup</title>
  <link rel="icon" href="/admin/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/admin/styles.css">
</head>
<body>
  <main class="shell setup-shell">
    <header class="topbar">
      <a class="brand" href="/admin/" aria-label="JellyPass admin"><span><strong>JellyPass</strong><small>Setup</small></span></a>
      <a id="setup-admin-link" class="button quiet compact" href="/admin/" hidden>Admin site</a>
    </header>

    <section id="setup-token-view" class="setup-card panel">
      <div class="eyebrow">First-run setup</div>
      <h1>Set up JellyPass</h1>
      <p>Sign in with the admin token: <code>ADMIN_TOKEN</code> if you set one, otherwise the setup token JellyPass wrote to <code>admin-token</code> in its data directory (with Docker Compose: <code>docker compose exec jellypass cat /app/data/admin-token</code>).</p>
      <form id="setup-token-form">
        <label for="setup-token">Admin token<input id="setup-token" type="password" autocomplete="off" spellcheck="false" required></label>
        <button class="button primary" type="submit">Continue</button>
        <p id="setup-token-error" class="form-error" role="alert"></p>
      </form>
    </section>

    <section id="setup-steps" hidden>
      <p id="setup-summary" class="setup-summary" role="status" aria-live="polite"></p>

      <article class="setup-card panel" id="step-jellyfin">
        <div class="eyebrow">Step 1 · required</div><h2>Connect Jellyfin</h2>
        <p>JellyPass signs in once as a Jellyfin administrator to create an API key of its own, named JellyPass. The password is used for that sign-in only and never stored.</p>
        <p class="setup-state" data-state="jellyfin"></p>
        <form id="jellyfin-form" class="setup-form">
          <label>Jellyfin address<input id="jellyfin-url" type="url" placeholder="http://jellyfin:8096" required></label>
          <label>Administrator name<input id="jellyfin-username" autocomplete="off"></label>
          <label>Password<input id="jellyfin-password" type="password" autocomplete="off"></label>
          <button id="jellyfin-submit" class="button primary" type="submit">Connect and create API key</button>
          <p class="form-error" role="alert"></p>
        </form>
      </article>

      <article class="setup-card panel" id="step-seerr">
        <div class="eyebrow">Step 2 · for requests</div><h2>Connect Seerr</h2>
        <p>The API key is in Seerr's Settings → General. It must be an administrator's key.</p>
        <p class="setup-state" data-state="seerr"></p>
        <form id="seerr-form" class="setup-form">
          <label>Seerr address<input id="seerr-url" type="url" placeholder="http://seerr:5055" required></label>
          <label>API key<input id="seerr-key" type="password" autocomplete="off" spellcheck="false"></label>
          <button class="button primary" type="submit">Check and save</button>
          <p class="form-error" role="alert"></p>
        </form>
      </article>

      <article class="setup-card panel" id="step-webhook">
        <div class="eyebrow">Step 3 · for requests</div><h2>Seerr webhook</h2>
        <p>JellyPass generates its webhook token and points Seerr's webhook at its admin listener (Request Available only, with the token as a bearer header), then asks Seerr to send a test.</p>
        <p class="setup-state" data-state="webhook"></p>
        <form id="webhook-form" class="setup-form">
          <label>JellyPass admin address, as Seerr reaches it<input id="webhook-base" type="url" value="http://jellypass:8788" required></label>
          <button class="button primary" type="submit">Configure Seerr's webhook</button>
          <p class="form-error" role="alert"></p>
        </form>
      </article>

      <article class="setup-card panel" id="step-tmdb">
        <div class="eyebrow">Step 4 · for the apps</div><h2>TMDB key</h2>
        <p>The household apps read titles from TMDB: an API key (v3) or API read access token (v4) from your TMDB account's API settings.</p>
        <p class="setup-state" data-state="tmdb"></p>
        <form id="tmdb-form" class="setup-form">
          <label>TMDB key or token<input id="tmdb-key" type="password" autocomplete="off" spellcheck="false"></label>
          <button class="button primary" type="submit">Check and save</button>
          <p class="form-error" role="alert"></p>
        </form>
      </article>

      <article class="setup-card panel" id="step-backfill">
        <div class="eyebrow">Step 5 · for requests</div><h2>Request backfill</h2>
        <p>Grants Seerr requests the webhook missed. Requests made before the cutoff are never imported; the install date is the safe choice.</p>
        <p class="setup-state" data-state="backfill"></p>
        <form id="backfill-form" class="setup-form">
          <button class="button primary" type="submit">Use the install date</button>
          <button id="backfill-off" class="button quiet" type="button">Turn it off</button>
          <p class="form-error" role="alert"></p>
        </form>
      </article>

      <article class="setup-card panel" id="step-household">
        <div class="eyebrow">Step 6 · optional</div><h2>Household addresses</h2>
        <p>Serve households at their own HTTPS addresses (such as https://media.example.com) through your reverse proxy. Map each household's address in the admin site's Groups tab afterwards. HTTP addresses are accepted, but the JellyPass mobile app only connects over HTTPS; members cannot sign in to the app with an HTTP address.</p>
        <p class="setup-state" data-state="household"></p>
        <form id="household-form" class="setup-form">
          <label class="check"><input id="household-gateway" type="checkbox"><span><strong>Serve household addresses</strong><small>On the member listener (port 8787).</small></span></label>
          <label>Reverse proxy addresses (IP or CIDR, comma-separated)<input id="household-proxies" placeholder="192.168.1.5"></label>
          <label class="check"><input id="household-app" type="checkbox"><span><strong>Household app</strong><small>Needs Seerr and a TMDB key.</small></span></label>
          <button class="button primary" type="submit">Save</button>
          <p class="form-error" role="alert"></p>
        </form>
      </article>

      <article class="setup-card panel" id="step-finish">
        <div class="eyebrow">Finish</div><h2 id="finish-title">Start JellyPass</h2>
        <p id="finish-text">JellyPass checks the whole configuration, then starts with it. Settings set in the environment always win over these.</p>
        <p class="setup-state" data-state="finish"></p>
        <form id="finish-form" class="setup-form">
          <button id="finish-button" class="button primary" type="submit">Finish and start JellyPass</button>
          <p class="form-error" role="alert"></p>
        </form>
      </article>
    </section>
  </main>
  <div id="toast" class="toast" role="status" aria-live="polite"></div>
  <script src="/admin/setup.js" defer></script>
</body>
</html>`;

export const SETUP_APP_JS = `
(() => {
  'use strict';
  const byId = (id) => document.getElementById(id);
  // The token lives in this variable only: never in storage, never in the address.
  let token = '';
  let status = null;

  async function api(path, body) {
    const init = { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } };
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    const response = await fetch(path, init);
    let answer = {};
    try { answer = await response.json(); } catch { answer = {}; }
    if (!response.ok) {
      const error = new Error(answer.message || (answer.error === 'unauthorized' ? 'That token was not accepted.' : answer.error) || ('Request failed (' + response.status + ')'));
      error.code = answer.error;
      error.status = response.status;
      error.body = answer;
      throw error;
    }
    if (answer.setup) status = answer.setup;
    return answer;
  }

  function setState(name, text, done) {
    const element = document.querySelector('[data-state="' + name + '"]');
    element.textContent = text;
    element.classList.toggle('done', Boolean(done));
  }

  function lockForm(form, lockedBy) {
    const locked = lockedBy && lockedBy.length > 0;
    form.querySelectorAll('input, button').forEach((input) => { input.disabled = locked; });
    return locked;
  }

  // A step the environment partly sets: each field it sets is off (and left out of what is sent); all of them, the form.
  function lockFields(form, allLocked, fields) {
    form.querySelectorAll('input, button').forEach((input) => { input.disabled = Boolean(allLocked); });
    if (allLocked) return;
    fields.forEach(([id, locked]) => { byId(id).disabled = Boolean(locked); });
  }

  function lockedText(lockedBy) {
    return 'Set in the environment (' + lockedBy.join(', ') + '), which wins over the wizard.';
  }

  function render() {
    const steps = status.steps;
    const running = status.mode === 'running';
    byId('setup-admin-link').hidden = !running;
    byId('setup-summary').textContent = status.missing.length
      ? 'Still needed: ' + status.missing.join(', ') + '.'
      : running
        ? (status.restartNeeded ? 'Saved changes take effect when you apply them.' : 'JellyPass is running with these settings.')
        : 'Everything required is in place. Finish to start JellyPass.';

    const jellyfin = steps.jellyfin;
    const jellyfinFields = jellyfin.fields || {};
    lockFields(byId('jellyfin-form'), jellyfin.locked, [['jellyfin-url', jellyfinFields.url], ['jellyfin-username', jellyfinFields.apiKey], ['jellyfin-password', jellyfinFields.apiKey]]);
    if (jellyfin.url && (jellyfinFields.url || !byId('jellyfin-url').value)) byId('jellyfin-url').value = jellyfin.url;
    byId('jellyfin-submit').textContent = jellyfinFields.apiKey ? 'Check and save' : 'Connect and create API key';
    setState('jellyfin', (jellyfin.locked ? '' : jellyfin.apiKey === 'set'
      ? 'Connected to ' + jellyfin.url + (jellyfin.createdByJellyPass ? ' with JellyPass\\'s own API key.' : '.')
      : 'Not connected yet.') + (jellyfin.lockedBy.length ? ' ' + lockedText(jellyfin.lockedBy) : ''), jellyfin.apiKey === 'set');

    const seerr = steps.seerr;
    const seerrFields = seerr.fields || {};
    lockFields(byId('seerr-form'), seerr.locked, [['seerr-url', seerrFields.url], ['seerr-key', seerrFields.apiKey]]);
    if (seerr.url && (seerrFields.url || !byId('seerr-url').value)) byId('seerr-url').value = seerr.url;
    byId('seerr-key').placeholder = seerrFields.apiKey ? 'Set in the environment' : seerr.apiKey === 'set' ? 'Stored: leave empty to keep it' : '';
    setState('seerr', (seerr.locked ? '' : seerr.apiKey === 'set' ? 'Connected to ' + seerr.url + '.' : 'Not connected (requests and the household app need it).')
      + (seerr.lockedBy.length ? ' ' + lockedText(seerr.lockedBy) : ''), seerr.apiKey === 'set');

    const webhook = seerr.webhook;
    byId('webhook-form').querySelectorAll('input, button').forEach((input) => { input.disabled = seerr.apiKey !== 'set'; });
    setState('webhook', webhook
      ? 'Seerr calls ' + webhook.url + (webhook.tested ? '; its test reached JellyPass.' : '; its test did not reach JellyPass yet. Check the address and try again.')
      : seerr.apiKey === 'set' ? 'Not configured yet.' : 'Connect Seerr first.', Boolean(webhook && webhook.tested));

    const tmdb = steps.tmdb;
    lockForm(byId('tmdb-form'), tmdb.lockedBy);
    byId('tmdb-key').placeholder = tmdb.apiKey === 'set' ? 'Stored: enter a new one to replace it' : '';
    setState('tmdb', tmdb.locked ? lockedText(tmdb.lockedBy) : tmdb.apiKey === 'set' ? 'Stored' + (tmdb.validatedAt ? ' and checked with TMDB.' : '.') : 'Not set (only the household apps need it).', tmdb.apiKey === 'set');

    const backfill = steps.backfill;
    lockForm(byId('backfill-form'), backfill.lockedBy);
    setState('backfill', backfill.locked ? lockedText(backfill.lockedBy) : backfill.enabled && backfill.since
      ? 'On: requests since ' + new Date(backfill.since).toUTCString() + '.'
      : 'Off. The install date is ' + new Date(backfill.suggested).toUTCString() + '.', backfill.enabled);

    const household = steps.household;
    byId('household-gateway').checked = household.gatewayEnabled;
    byId('household-app').checked = household.appEnabled;
    if (!byId('household-proxies').value) byId('household-proxies').value = household.trustedProxies.join(', ');
    byId('household-gateway').disabled = household.locked.gatewayEnabled;
    byId('household-app').disabled = household.locked.appEnabled;
    byId('household-proxies').disabled = household.locked.trustedProxies;
    setState('household', (household.gatewayEnabled ? 'Household addresses on' : 'Household addresses off') + (household.appEnabled ? ', household app on.' : '.')
      + (household.lockedBy.length ? ' ' + lockedText(household.lockedBy) : ''), household.gatewayEnabled);

    byId('finish-title').textContent = running ? 'Apply changes' : 'Start JellyPass';
    byId('finish-button').textContent = running ? 'Apply and restart JellyPass' : 'Finish and start JellyPass';
    byId('finish-text').textContent = running
      ? 'Changes are saved as you make them and take effect when JellyPass restarts its services with them, which signs administrators out of the admin site.'
      : 'JellyPass checks the whole configuration, then starts with it. Settings set in the environment always win over these.';
    setState('finish', status.completedAt ? 'Setup finished ' + new Date(status.completedAt).toUTCString() + '.' : '', Boolean(status.completedAt));
  }

  let toastTimer;
  function toast(message, isError) {
    const node = byId('toast');
    clearTimeout(toastTimer);
    node.textContent = message;
    node.className = 'toast show' + (isError ? ' error' : '');
    toastTimer = setTimeout(() => { node.className = 'toast'; }, 4200);
  }

  // Runs a step from its form: the button is off while it runs, the form's error line shows what went wrong.
  function step(formId, run) {
    const form = byId(formId);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const error = form.querySelector('.form-error');
      error.textContent = '';
      const buttons = Array.from(form.querySelectorAll('button'));
      buttons.forEach((button) => { button.disabled = true; });
      let message = '';
      try {
        message = await run(form);
      } catch (failure) {
        error.textContent = failure.message;
      }
      buttons.forEach((button) => { button.disabled = false; });
      // Applies the locks again (a form the environment locks stays off).
      if (status) render();
      if (message) toast(message);
    });
  }

  step('jellyfin-form', async () => {
    const password = byId('jellyfin-password');
    try {
      const body = {};
      if (!byId('jellyfin-url').disabled) body.url = byId('jellyfin-url').value;
      if (!password.disabled) { body.username = byId('jellyfin-username').value; body.password = password.value; }
      const answer = await api('/v1/setup/jellyfin', body);
      return answer.status === 'kept' ? 'Jellyfin connected; JellyPass kept its API key.' : answer.status === 'connected' ? 'Jellyfin connected with the environment\\'s API key.' : 'Jellyfin connected; API key created.';
    } finally {
      password.value = '';
    }
  });
  step('seerr-form', async () => {
    const key = byId('seerr-key');
    try {
      const body = {};
      if (!byId('seerr-url').disabled) body.url = byId('seerr-url').value;
      if (!key.disabled) body.apiKey = key.value;
      await api('/v1/setup/seerr', body);
      return 'Seerr connected.';
    } finally {
      key.value = '';
    }
  });
  step('webhook-form', async () => {
    const body = { jellypassUrl: byId('webhook-base').value };
    let answer;
    try {
      answer = await api('/v1/setup/webhook', body);
    } catch (error) {
      if (error.code !== 'seerr_webhook_in_use') throw error;
      if (!confirm('Seerr\\'s webhook is ' + (error.body.currentEnabled ? 'on' : 'off') + ' and set to call ' + (error.body.currentHost || 'another address') + '. Seerr has one webhook: replace it with JellyPass\\'s?')) return '';
      answer = await api('/v1/setup/webhook', Object.assign({ replace: true }, body));
    }
    return answer.tested ? 'Webhook configured; Seerr\\'s test reached JellyPass.' : 'Webhook configured, but Seerr\\'s test did not reach JellyPass.';
  });
  step('tmdb-form', async () => {
    const key = byId('tmdb-key');
    try {
      await api('/v1/setup/tmdb', { apiKey: key.value });
      return 'TMDB key checked and saved.';
    } finally {
      key.value = '';
    }
  });
  step('backfill-form', async () => {
    await api('/v1/setup/backfill', {});
    return 'Backfill cutoff set to the install date.';
  });
  byId('backfill-off').addEventListener('click', async () => {
    try { await api('/v1/setup/backfill', { since: null }); render(); toast('Request backfill off.'); } catch (error) { toast(error.message, true); }
  });
  step('household-form', async () => {
    const body = {};
    if (!byId('household-proxies').disabled) body.trustedProxies = byId('household-proxies').value;
    if (!byId('household-gateway').disabled) body.gatewayEnabled = byId('household-gateway').checked;
    if (!byId('household-app').disabled) body.appEnabled = byId('household-app').checked;
    await api('/v1/setup/household', body);
    return 'Saved.';
  });
  step('finish-form', async () => {
    await api('/v1/setup/secrets', {});
    await api('/v1/setup/finish', {});
    setState('finish', 'Starting JellyPass…', false);
    await waitForRestart();
    return '';
  });

  // Waits for JellyPass to answer again after it restarted its services, then opens the admin site.
  async function waitForRestart() {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      try {
        const answer = await api('/v1/setup');
        if (answer.mode === 'running' && !answer.restartNeeded) { status = answer; window.location.assign('/admin/'); return; }
      } catch { /* not answering yet */ }
    }
    throw new Error('JellyPass did not come back within a minute. Check its log.');
  }

  byId('setup-token-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    byId('setup-token-error').textContent = '';
    const input = byId('setup-token');
    token = input.value.trim();
    try {
      status = await api('/v1/setup');
      input.value = '';
      byId('setup-token-view').hidden = true;
      byId('setup-steps').hidden = false;
      render();
    } catch (error) {
      token = '';
      byId('setup-token-error').textContent = error.message;
    }
  });
})();
`;
