export const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>JellyPass · Jellyfin library access</title>
  <meta name="description" content="JellyPass manages personalized library access for Jellyfin.">
  <link rel="icon" href="/admin/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/admin/styles.css">
</head>
<body>
  <div class="ambient ambient-one"></div><div class="ambient ambient-two"></div>
  <main class="shell">
    <header class="topbar">
      <a class="brand" href="/admin/" aria-label="JellyPass home">
        <span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 48 48"><defs><linearGradient id="jellypass-mark" x1="5" y1="7" x2="43" y2="41" gradientUnits="userSpaceOnUse"><stop stop-color="#AA5CC3"/><stop offset="1" stop-color="#00A4DC"/></linearGradient></defs><path fill="url(#jellypass-mark)" d="M8 6h32a5 5 0 0 1 5 5v7.1a6.5 6.5 0 0 0 0 11.8V37a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5v-7.1a6.5 6.5 0 0 0 0-11.8V11a5 5 0 0 1 5-5Z"/><circle cx="15" cy="19" r="4" fill="#000B25" fill-opacity=".82"/><path d="M10 32c1.4-4 8.6-4 10 0M27 17h10M27 24h10M27 31h7" stroke="#000B25" stroke-opacity=".82" stroke-width="2.6" stroke-linecap="round"/></svg></span>
        <span><strong>JellyPass</strong><small>Library access for Jellyfin</small></span>
      </a>
      <div class="topbar-actions"><div id="connection" class="connection disconnected" role="status"><span></span><b>Disconnected</b></div><button id="logout" class="button quiet compact" hidden>Sign out</button></div>
    </header>
    <div id="notice" class="notice" role="status" aria-live="polite" hidden></div>

    <section id="login-view" class="login-wrap">
      <div class="login-card panel">
        <div class="eyebrow">Administration</div>
        <h1>The right library<br><em>for every viewer.</em></h1>
        <p>Control who can watch what with request-based grants, shared groups, and Jellyfin-native access policies.</p>
        <form id="login-form">
          <div class="credentials"><label for="username">Username<input id="username" name="username" autocomplete="username" required autofocus></label><label for="password">Password<input id="password" name="password" type="password" autocomplete="current-password" required></label></div>
          <button class="button primary login-button" type="submit">Sign in with Jellyfin</button>
          <p class="hint">Use an enabled Jellyfin administrator account. JellyPass never stores your Jellyfin password.</p>
          <p id="login-error" class="form-error" role="alert"></p>
        </form>
      </div>
      <aside class="login-note"><span>JP</span><p>JellyPass uses Jellyfin's native tag policies. Every change can be previewed before it is applied.</p></aside>
    </section>

    <section id="app-view" hidden>
      <div class="hero-row">
        <div><div id="hero-eyebrow" class="eyebrow">Jellyfin access</div><h1 id="hero-title">JellyPass dashboard</h1><p id="hero-subtitle" class="subtitle">Monitor library access, audiences, and synchronization health.</p></div>
      </div>

      <div id="jellyfin-version" class="version-alert" role="alert" hidden><div><strong id="jellyfin-version-title"></strong><p id="jellyfin-version-text"></p></div><button id="jellyfin-version-confirm" class="button primary compact" type="button" hidden></button></div>

      <nav class="tabs" aria-label="Admin sections"><button class="active" data-tab="dashboard">Dashboard</button><button data-tab="requests">Requests <span id="requests-count"></span></button><button data-tab="library">Library <span id="library-count"></span></button><button data-tab="grants">Grants <span id="grant-count"></span></button><button data-tab="groups">Groups <span id="group-count"></span></button></nav>
      <section id="dashboard-panel" class="tab-panel">
        <div class="section-tools"><div><h2>Access overview</h2><p>A compact view of JellyPass activity and policy health.</p></div></div>
        <div class="stats" aria-label="Access summary">
          <article><span>Active grants</span><strong id="stat-grants">—</strong><small>protected titles</small></article>
          <article><span>Request owners</span><strong id="stat-owners">—</strong><small>unique Jellyfin users</small></article>
          <article><span>Access groups</span><strong id="stat-groups">—</strong><small>shared audiences</small></article>
        </div>
        <div class="recent-head"><div><div class="eyebrow">Activity</div><h2>Recent requests</h2></div><p>The latest requests successfully linked to your Jellyfin library.</p></div>
        <div id="recent-requests" class="recent-grid"></div>
      </section>
      <section id="requests-panel" class="tab-panel" hidden>
        <div class="section-tools"><div><h2>Household requests</h2><p>What households asked for in the app. Approve, decline or cancel a request for every household following it.</p></div><button id="refresh-requests" class="button quiet" type="button">Refresh</button></div>
        <div class="requests-toolbar"><label class="search"><span aria-hidden="true">⌕</span><input id="requests-search" type="search" placeholder="Search title or requester" aria-label="Search by title or requester"></label><select id="requests-household" aria-label="Filter by household"><option value="">All households</option></select><select id="requests-status" aria-label="Filter by status"><option value="">All statuses</option><option value="waiting">Waiting (pending or approved)</option><option value="pending">Pending in Seerr</option><option value="approved">Approved in Seerr</option><option value="ready">Ready</option><option value="failed">Declined or failed</option><option value="cancelled">Cancelled or deleted</option><option value="held">Held for no household</option></select><select id="requests-type" aria-label="Filter by type"><option value="">Films and series</option><option value="movie">Films</option><option value="tv">Series</option></select></div>
        <p id="requests-summary" class="requests-summary" role="status" aria-live="polite"></p>
        <div id="household-requests-list" class="request-rows"></div>
        <div class="recent-head"><div><div class="eyebrow">Cancelled, then arrived</div><h2>Held titles</h2></div><p>Titles nobody follows any more. They are hidden from every household until you release them.</p></div>
        <div id="held-list" class="request-rows"></div>
      </section>
      <section id="grants-panel" class="tab-panel" hidden>
        <div class="section-tools"><div><h2>Protected titles</h2><p>Requests and shared groups currently controlling access.</p></div><div class="grant-tools"><label class="search"><span>⌕</span><input id="grant-search" type="search" placeholder="Search item, owner, or request"></label><button id="reconcile-policies" class="button quiet">Reconcile policies</button></div></div>
        <div id="grants-list" class="grant-list"></div>
      </section>
      <section id="groups-panel" class="tab-panel" hidden>
        <div class="section-tools"><div><h2>Households and access groups</h2><p>Group users for shared media access and household-specific Jellyfin login screens.</p></div><div class="actions"><button id="new-user" class="button quiet">Create Jellyfin user</button><button id="new-group" class="button primary">New group</button></div></div>
        <div id="groups-list" class="group-grid"></div>
      </section>
      <section id="library-panel" class="tab-panel" hidden>
        <div class="section-tools"><div><h2>Synchronized library</h2><p id="library-sync-status">Not synchronized yet</p></div><button id="sync-library" class="button primary">Sync with Jellyfin</button></div>
        <div class="catalog-toolbar"><div class="catalog-search"><label class="search"><span>⌕</span><input id="library-filter" type="search" placeholder="Search title or year"></label><button id="clear-library-search" class="button quiet" type="button" disabled>Clear search</button></div><select id="library-name-filter" aria-label="Filter by Jellyfin library"><option value="">All Jellyfin libraries</option></select><select id="library-sort" aria-label="Sort library results"><option value="title-asc">Title A–Z</option><option value="title-desc">Title Z–A</option><option value="date-desc">Date added · newest</option><option value="date-asc">Date added · oldest</option><option value="year-desc">Release year · newest</option><option value="year-asc">Release year · oldest</option><option value="access-desc">Request/access · recent</option><option value="managed-first">Protected first</option><option value="unmanaged-first">Unmanaged first</option></select></div>
        <div class="selection-bar"><label><input id="select-visible" type="checkbox"> Select visible</label><span id="selection-count">0 selected</span><button id="clear-selection" class="button quiet" type="button">Clear selection</button><button id="bulk-access" class="button primary" type="button" disabled>Assign access</button></div>
        <div id="catalog-list" class="catalog-list"></div>
        <div class="catalog-footer"><label>Results per page <select id="library-page-size"><option value="25">25</option><option value="50">50</option><option value="100">100</option></select></label><span id="library-page-info">Page 1 of 1</span><div><button id="library-previous" class="button quiet" type="button">Previous</button><button id="library-next" class="button quiet" type="button">Next</button></div></div>
      </section>
    </section>
  </main>

  <dialog id="plan-dialog"><div class="dialog-head"><div><div class="eyebrow">Dry-run</div><h2 id="plan-title">Change plan</h2></div><button class="dialog-close icon button" aria-label="Close">×</button></div><div id="plan-content" class="plan-content"></div></dialog>
  <dialog id="group-dialog"><form id="group-form"><div class="dialog-head"><div><div class="eyebrow">Shared access</div><h2 id="group-title">New group</h2></div><button type="button" class="dialog-close icon button" aria-label="Close">×</button></div><label>Group ID<input id="group-id" required pattern="[a-zA-Z0-9_-]{1,128}" placeholder="household"></label><label>Display name<input id="group-name" required placeholder="Household"></label><fieldset><legend>Jellyfin users</legend><div id="user-options" class="check-list"></div></fieldset><fieldset><legend>One-tap sign-in</legend><p class="hint">Mark users whose Jellyfin account has no password. Their household login skips the password prompt. A marked user who does have a password will be unable to sign in from the household URL.</p><div id="passwordless-options" class="check-list"></div></fieldset><div class="dialog-actions"><button type="button" class="dialog-close button quiet">Cancel</button><button class="button primary" type="submit">Save group</button></div></form></dialog>
  <dialog id="user-dialog"><form id="user-form"><div class="dialog-head"><div><div class="eyebrow">Household member</div><h2>Create Jellyfin user</h2></div><button type="button" class="dialog-close icon button" aria-label="Close">×</button></div><label>Username<input id="new-username" name="new-username" maxlength="128" autocomplete="off" required></label><label>Password · optional<input id="new-password" name="new-password" type="password" maxlength="256" autocomplete="new-password"></label><label>Confirm password<input id="confirm-password" name="confirm-password" type="password" maxlength="256" autocomplete="new-password"></label><p class="hint">Leave both password fields blank to create a passwordless Jellyfin account. Until household SSO is implemented, anyone who can reach Jellyfin and knows the username can sign in to that account.</p><label>Household or access group<select id="new-user-group" required></select></label><label class="check"><input id="import-to-seerr" type="checkbox"><span><strong>Import into Seerr</strong><small id="seerr-import-help">Link this Jellyfin identity so the user can own requests.</small></span></label><p class="hint">This creates a real non-administrator Jellyfin account and adds it to the selected group. Seerr applies its configured default permissions to imported users.</p><div class="dialog-actions"><button type="button" class="dialog-close button quiet">Cancel</button><button class="button primary" type="submit">Create user</button></div></form></dialog>
  <dialog id="access-dialog"><form id="access-form"><div class="dialog-head"><div><div class="eyebrow">Grant access</div><h2>Shared groups</h2></div><button type="button" class="dialog-close icon button" aria-label="Close">×</button></div><p id="access-item" class="mono"></p><fieldset><legend>Groups with access</legend><div id="group-options" class="check-list"></div></fieldset><input id="access-item-id" type="hidden"><div class="dialog-actions"><button type="button" class="dialog-close button quiet">Cancel</button><button class="button primary" type="submit">Preview changes</button></div></form></dialog>
  <dialog id="requests-dialog"><div class="dialog-head"><div><div class="eyebrow">Direct access</div><h2>Seerr requests</h2></div><button class="dialog-close icon button" aria-label="Close">×</button></div><p id="requests-item" class="mono"></p><div id="requests-list" class="request-list"></div></dialog>
  <dialog id="bulk-dialog"><form id="bulk-form"><div class="dialog-head"><div><div class="eyebrow">Bulk access</div><h2>Assign selected media</h2></div><button type="button" class="dialog-close icon button" aria-label="Close">×</button></div><p id="bulk-summary" class="hint"></p><fieldset><legend>Individual Jellyfin users</legend><div id="bulk-user-options" class="check-list"></div></fieldset><fieldset><legend>Access groups</legend><div id="bulk-group-options" class="check-list"></div></fieldset><p class="hint">This replaces existing manual users and groups for every selected title. Seerr request owners are preserved.</p><div class="dialog-actions"><button type="button" class="dialog-close button quiet">Cancel</button><button class="button primary" type="submit">Preview bulk changes</button></div></form></dialog>
  <dialog id="request-action-dialog" aria-labelledby="request-action-title"><form id="request-action-form"><div class="dialog-head"><div><div class="eyebrow">Household request</div><h2 id="request-action-title">Confirm</h2></div><button type="button" class="dialog-close icon button" aria-label="Close">×</button></div><p id="request-action-text"></p><p id="request-action-warning" class="hint" hidden></p><label id="request-radarr-option" class="check" hidden><input id="request-radarr" type="checkbox"><span><strong>Also remove from Radarr</strong><small>Radarr stops downloading this movie and deletes any files it has for it.</small></span></label><div class="dialog-actions"><button type="button" class="dialog-close button quiet">Keep it</button><button id="request-action-confirm" class="button primary" type="submit">Confirm</button></div></form></dialog>
  <dialog id="release-dialog" aria-labelledby="release-title"><form id="release-form"><div class="dialog-head"><div><div class="eyebrow">Held title</div><h2 id="release-title">Release</h2></div><button type="button" class="dialog-close icon button" aria-label="Close">×</button></div><p id="release-text" class="hint"></p><fieldset><legend>Households to give it to</legend><div id="release-options" class="check-list"></div></fieldset><p id="release-error" class="form-error" role="alert"></p><div class="dialog-actions"><button type="button" class="dialog-close button quiet">Cancel</button><button class="button primary" type="submit">Release</button></div></form></dialog>
  <div id="toast" class="toast" role="status" aria-live="polite"></div>
  <script src="/admin/app.js" defer></script>
</body>
</html>`;

export const ADMIN_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><defs><linearGradient id="g" x1="5" y1="7" x2="43" y2="41" gradientUnits="userSpaceOnUse"><stop stop-color="#AA5CC3"/><stop offset="1" stop-color="#00A4DC"/></linearGradient></defs><rect width="48" height="48" rx="12" fill="#000B25"/><path fill="url(#g)" d="M9 7h30a5 5 0 0 1 5 5v6.4a6.2 6.2 0 0 0 0 11.2V36a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5v-6.4a6.2 6.2 0 0 0 0-11.2V12a5 5 0 0 1 5-5Z"/><circle cx="15" cy="19" r="3.7" fill="#000B25" fill-opacity=".84"/><path d="M10.5 31.5c1.2-3.8 7.8-3.8 9 0M27 17h10M27 24h10M27 31h7" stroke="#000B25" stroke-opacity=".84" stroke-width="2.5" stroke-linecap="round"/></svg>`;

export const ADMIN_STYLES = `
:root{--bg:#000b25;--panel:#09152d;--panel-2:#101d38;--line:#283858;--text:#f8f9ff;--muted:#9ba9c6;--cyan:#00a4dc;--blue:#aa5cc3;--amber:#f6b94d;--red:#ff6d76;--green:#45d69a;--jelly-purple:#aa5cc3;--jelly-blue:#00a4dc;--shadow:0 24px 80px rgba(0,0,0,.42)}
[hidden]{display:none!important}
*{box-sizing:border-box}html{min-height:100%;background:var(--bg)}body{margin:0;min-height:100vh;color:var(--text);font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:radial-gradient(circle at 16% 8%,#10283a 0,transparent 30%),linear-gradient(145deg,#080d15 0%,#0a111b 100%);overflow-x:hidden}button,input{font:inherit}.ambient{position:fixed;border-radius:50%;filter:blur(90px);opacity:.13;pointer-events:none}.ambient-one{width:420px;height:420px;background:var(--cyan);right:-160px;top:10%}.ambient-two{width:360px;height:360px;background:var(--blue);left:-180px;bottom:0}.shell{position:relative;width:min(1180px,calc(100% - 40px));margin:auto;padding:0 0 64px}.topbar{height:92px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(145,161,180,.18)}.brand{display:flex;align-items:center;gap:13px;color:inherit;text-decoration:none}.brand strong,.brand small{display:block}.brand strong{font-size:15px;letter-spacing:.02em}.brand small{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.12em;margin-top:1px}.brand-mark{position:relative;width:36px;height:36px;border:1px solid rgba(37,211,200,.55);border-radius:10px;transform:rotate(45deg);display:grid;place-items:center;box-shadow:inset 0 0 18px rgba(37,211,200,.15)}.brand-mark span{width:12px;height:12px;border-radius:4px;background:linear-gradient(135deg,var(--cyan),var(--blue))}.connection{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.09em}.connection span{width:7px;height:7px;background:#5b6878;border-radius:50%;box-shadow:0 0 0 4px rgba(91,104,120,.1)}.connection.online span{background:var(--green);box-shadow:0 0 0 4px rgba(69,214,154,.1)}.connection.online b{color:#bdebd8}.panel{background:linear-gradient(145deg,rgba(19,30,44,.96),rgba(13,21,32,.96));border:1px solid var(--line);border-radius:20px;box-shadow:var(--shadow)}.login-wrap{min-height:calc(100vh - 150px);display:grid;grid-template-columns:minmax(0,650px) 260px;gap:80px;align-items:center;justify-content:center}.login-card{padding:54px}.eyebrow{color:var(--cyan);font-size:11px;font-weight:750;text-transform:uppercase;letter-spacing:.18em;margin-bottom:10px}.login-card h1,.hero-row h1{font-size:clamp(40px,6vw,68px);line-height:1.02;letter-spacing:-.045em;margin:0}.login-card h1 em{font-style:normal;color:transparent;-webkit-text-stroke:1px #7f91a5}.login-card>p{color:var(--muted);font-size:17px;max-width:540px;margin:24px 0 34px}.login-card label,.dialog-head+label,form>label{display:grid;gap:8px;color:#c6d1dd;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em}.token-row{display:flex;gap:10px;margin-top:8px}input{width:100%;color:var(--text);background:#080e17;border:1px solid var(--line);border-radius:10px;padding:12px 14px;outline:none;transition:.2s border,.2s box-shadow}input:focus{border-color:var(--cyan);box-shadow:0 0 0 3px rgba(37,211,200,.1)}.hint,.form-error{font-size:12px!important;margin:10px 0 0!important}.form-error{color:var(--red)!important;min-height:18px}.button{border:1px solid var(--line);border-radius:10px;padding:10px 15px;background:#111b28;color:var(--text);cursor:pointer;font-weight:700;white-space:nowrap;transition:.18s transform,.18s background,.18s border}.button:hover{transform:translateY(-1px);border-color:#49617e}.button:disabled{opacity:.45;cursor:wait;transform:none}.button.primary{border-color:transparent;color:#041413;background:linear-gradient(135deg,var(--cyan),#5fe4b0)}.button.quiet{background:rgba(17,27,40,.65)}.button.danger{color:#ffc7cb;border-color:rgba(255,109,118,.35);background:rgba(255,109,118,.08)}.button.icon{width:41px;height:41px;padding:0;display:grid;place-items:center}.login-note{display:flex;gap:18px;align-items:flex-start;color:var(--muted)}.login-note span{font:700 12px/1 ui-monospace,monospace;color:var(--cyan);padding-top:5px}.login-note p{margin:0;border-left:1px solid var(--line);padding-left:18px}.hero-row{display:flex;justify-content:space-between;align-items:flex-end;padding:62px 0 38px}.hero-row h1{font-size:48px}.subtitle,.section-tools p{color:var(--muted);margin:8px 0 0}.actions{display:flex;gap:9px;flex-wrap:wrap;justify-content:flex-end}.stats{display:grid;gap:12px;margin-bottom:44px}.stats article{position:relative;overflow:hidden;padding:22px 24px;background:linear-gradient(145deg,rgba(19,30,44,.9),rgba(13,21,32,.8));border:1px solid var(--line);border-radius:14px}.stats article:after{content:"";position:absolute;width:60px;height:2px;left:24px;bottom:0;background:var(--cyan)}.stats span,.stats small{display:block;color:var(--muted)}.stats span{font-size:11px;text-transform:uppercase;letter-spacing:.12em}.stats strong{display:block;font-size:34px;line-height:1;margin:15px 0 10px}.stats small{font-size:12px}.stats article.error:after{background:var(--red)}.stats article.error strong{color:var(--red)}.tabs{display:flex;gap:28px;border-bottom:1px solid var(--line)}.tabs button{position:relative;border:0;background:transparent;color:var(--muted);padding:0 1px 15px;font-weight:750;cursor:pointer}.tabs button.active{color:var(--text)}.tabs button.active:after{content:"";position:absolute;height:2px;left:0;right:0;bottom:-1px;background:var(--cyan)}.tabs span{font-size:11px;color:var(--muted);margin-left:5px}.section-tools{display:flex;align-items:flex-end;justify-content:space-between;padding:32px 0 20px;gap:20px}.section-tools h2{margin:0;font-size:22px}.section-tools p{font-size:13px}.search{position:relative}.search span{position:absolute;left:13px;top:10px;color:var(--muted)}.search input{width:285px;padding-left:36px}.grant-list{display:grid;gap:10px}.grant-card{background:rgba(14,23,34,.86);border:1px solid var(--line);border-radius:13px;padding:12px 14px;display:grid;grid-template-columns:56px minmax(220px,1.3fr) minmax(180px,.8fr) minmax(170px,.8fr) auto;gap:18px;align-items:center}.grant-card:hover{border-color:#354a63}.grant-poster{width:56px;aspect-ratio:2/3;overflow:hidden;border-radius:8px;background:linear-gradient(145deg,rgba(170,92,195,.48),rgba(0,164,220,.35));box-shadow:0 8px 22px rgba(0,0,0,.25)}.grant-poster img{width:100%;height:100%;object-fit:cover;display:block}.grant-poster-fallback{width:100%;height:100%;display:grid;place-items:center;color:rgba(255,255,255,.78);font-size:18px;font-weight:800}.grant-main{min-width:0}.grant-title{display:flex;align-items:center;gap:9px}.grant-title h3{font-size:15px;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0}.type{font-size:10px;padding:3px 7px;border:1px solid #38526e;border-radius:99px;color:#a9bfd6;text-transform:uppercase}.meta,.grant-section small{color:var(--muted);font-size:11px}.grant-section strong{display:block;font-size:13px;margin-bottom:4px}.pill-row{display:flex;gap:5px;flex-wrap:wrap}.pill{font-size:10px;border-radius:99px;background:#1a2b3e;color:#bad0e3;padding:3px 7px}.pill.sync-synced{color:#a9f0d0;background:rgba(69,214,154,.1)}.pill.sync-error{color:#ffc0c5;background:rgba(255,109,118,.1)}.pill.sync-pending{color:#ffe0a7;background:rgba(246,185,77,.1)}.pill.sync-orphaned{color:#ffc0c5;background:rgba(255,109,118,.1)}.card-actions{display:flex;gap:7px;justify-content:flex-end}.card-actions .button{font-size:12px;padding:8px 10px}.empty{border:1px dashed var(--line);border-radius:13px;padding:52px;text-align:center;color:var(--muted)}.empty strong{display:block;color:var(--text);font-size:18px;margin-bottom:6px}.group-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.group-card{background:rgba(14,23,34,.86);border:1px solid var(--line);border-radius:14px;padding:22px}.group-card h3{font-size:17px;margin:0 0 4px}.group-card .mono{color:var(--cyan)}.group-card>p{color:var(--muted);min-height:45px}.group-card footer{display:flex;justify-content:space-between;align-items:center;margin-top:22px}.group-card footer span{color:var(--muted);font-size:12px}.mono{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;overflow-wrap:anywhere}dialog{width:min(680px,calc(100% - 30px));max-height:85vh;overflow:auto;color:var(--text);background:#101924;border:1px solid #31445b;border-radius:18px;padding:26px;box-shadow:var(--shadow)}dialog::backdrop{background:rgba(1,5,10,.78);backdrop-filter:blur(5px)}.dialog-head{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:24px}.dialog-head h2{margin:0;font-size:25px}.dialog-close{font-size:20px}.dialog-actions{display:flex;justify-content:flex-end;gap:9px;margin-top:26px}dialog form{display:grid;gap:18px}fieldset{margin:0;padding:0;border:0}legend{font-size:12px;color:#c6d1dd;font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px}.check-list{display:grid;grid-template-columns:repeat(2,1fr);gap:7px;max-height:260px;overflow:auto}.check{display:flex;gap:9px;align-items:center;background:#0a111b;border:1px solid var(--line);border-radius:9px;padding:10px 11px;cursor:pointer}.check input{width:auto;accent-color:var(--cyan)}.check span{min-width:0}.check strong,.check small{display:block;overflow:hidden;text-overflow:ellipsis}.check strong{font-size:13px}.check small{font:10px ui-monospace,monospace;color:var(--muted)}.plan-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-bottom:20px}.plan-summary article{background:#0a111b;border:1px solid var(--line);padding:13px;border-radius:10px}.plan-summary span,.plan-summary strong{display:block}.plan-summary span{font-size:10px;color:var(--muted);text-transform:uppercase}.plan-summary strong{margin-top:5px}.plan-item{border-top:1px solid var(--line);padding:15px 0}.plan-item strong,.plan-item span{display:block}.plan-item span{color:var(--muted);font-size:12px}.plan-item .change{color:var(--cyan)}.toast{position:fixed;right:22px;bottom:22px;max-width:380px;padding:13px 17px;border-radius:10px;background:#172434;border:1px solid #38506a;box-shadow:var(--shadow);opacity:0;transform:translateY(12px);pointer-events:none;transition:.2s}.toast.show{opacity:1;transform:none}.toast.error{border-color:rgba(255,109,118,.6);color:#ffc7cb}
.request-list{display:grid;gap:8px}.request-row{display:flex;align-items:center;justify-content:space-between;gap:16px;background:#0a111b;border:1px solid var(--line);border-radius:10px;padding:12px}.request-row strong,.request-row small{display:block}.request-row small{color:var(--muted);font:10px ui-monospace,monospace;margin-top:3px}.credentials{display:grid;grid-template-columns:1fr 1fr;gap:12px}.login-button{width:100%;margin-top:12px;padding:12px}
.grant-tools{display:flex;align-items:center;gap:10px}
dialog select{width:100%;color:var(--text);background:#080e17;border:1px solid var(--line);border-radius:10px;padding:12px 14px;outline:none;font:inherit}dialog select:focus{border-color:var(--jelly-blue);box-shadow:0 0 0 3px rgba(0,164,220,.13)}
.catalog-toolbar{display:grid;grid-template-columns:minmax(320px,1fr) repeat(2,minmax(190px,auto));gap:10px;margin-bottom:12px}.catalog-search{display:flex;gap:8px}.catalog-search .search{flex:1}.catalog-toolbar .search input{width:100%}.catalog-toolbar select,.catalog-footer select{color:var(--text);background:#080e17;border:1px solid var(--line);border-radius:10px;padding:11px 13px;outline:none}.selection-bar{display:flex;align-items:center;gap:12px;padding:12px 14px;margin-bottom:12px;background:rgba(16,29,56,.8);border:1px solid var(--line);border-radius:11px}.selection-bar label{display:flex;align-items:center;gap:8px}.selection-bar input,.catalog-check{width:auto;accent-color:var(--jelly-blue)}.selection-bar #selection-count{color:var(--muted);margin-right:auto}.catalog-list{display:grid;gap:7px}.catalog-row{display:grid;grid-template-columns:auto 44px minmax(220px,1.4fr) minmax(140px,.7fr) minmax(100px,.5fr);gap:14px;align-items:center;padding:12px 15px;background:linear-gradient(145deg,rgba(16,29,56,.82),rgba(6,14,33,.86));border:1px solid var(--line);border-radius:11px}.catalog-row.selected{border-color:rgba(0,164,220,.65);background:linear-gradient(145deg,rgba(22,47,83,.9),rgba(8,22,47,.92))}.media-glyph{width:40px;height:48px;display:grid;place-items:center;border-radius:7px;color:#d9e9ff;font-weight:800;background:linear-gradient(145deg,var(--jelly-purple),var(--jelly-blue))}.catalog-title strong,.catalog-title small{display:block}.catalog-title small,.catalog-library,.catalog-year{color:var(--muted);font-size:12px}.catalog-status{justify-self:end}.catalog-footer{display:flex;align-items:center;gap:16px;margin-top:14px;color:var(--muted)}.catalog-footer label{display:flex;align-items:center;gap:9px}.catalog-footer>span{margin-left:auto}.catalog-footer>div{display:flex;gap:8px}
body{background:radial-gradient(circle at 14% 4%,rgba(170,92,195,.2) 0,transparent 30%),radial-gradient(circle at 86% 18%,rgba(0,164,220,.16) 0,transparent 28%),linear-gradient(145deg,#000b25 0%,#050a18 72%)}.ambient-one{background:var(--jelly-purple);opacity:.16}.ambient-two{background:var(--jelly-blue);opacity:.14}.topbar{border-color:rgba(170,92,195,.22)}.brand-mark{width:42px;height:42px;border:0;border-radius:0;transform:none;display:grid;place-items:center;box-shadow:none}.brand-mark svg{width:42px;height:42px;filter:drop-shadow(0 8px 18px rgba(0,164,220,.22))}.brand strong{font-size:17px;letter-spacing:-.01em}.panel{background:linear-gradient(145deg,rgba(16,29,56,.97),rgba(5,12,31,.98));border-color:rgba(170,92,195,.34)}.login-card{position:relative;overflow:hidden}.login-card:before{content:"";position:absolute;inset:0 0 auto;height:3px;background:linear-gradient(90deg,var(--jelly-purple),var(--jelly-blue))}.login-card h1 em{color:transparent;-webkit-text-stroke:0;background:linear-gradient(105deg,var(--jelly-purple),var(--jelly-blue));background-clip:text;-webkit-background-clip:text}.eyebrow{color:#6fdcff}.button.primary{color:#000b25;background:linear-gradient(120deg,var(--jelly-purple),var(--jelly-blue));box-shadow:0 8px 24px rgba(78,112,219,.2)}.button.primary:hover{border-color:transparent;box-shadow:0 10px 30px rgba(78,112,219,.32)}button:focus-visible,a:focus-visible,input:focus-visible{outline:2px solid var(--jelly-blue);outline-offset:3px}input:focus{border-color:var(--jelly-blue);box-shadow:0 0 0 3px rgba(0,164,220,.13)}.stats article,.grant-card,.group-card{background:linear-gradient(145deg,rgba(16,29,56,.88),rgba(6,14,33,.9))}.stats article:after,.tabs button.active:after{background:linear-gradient(90deg,var(--jelly-purple),var(--jelly-blue))}.pill{background:rgba(64,88,137,.24)}dialog{background:linear-gradient(145deg,#101d38,#060e21);border-color:rgba(170,92,195,.38)}.connection.online span{background:var(--jelly-blue);box-shadow:0 0 0 4px rgba(0,164,220,.12)}.connection.online b{color:#a9e9ff}
.topbar{height:76px}.topbar-actions{display:flex;align-items:center;gap:16px}.button.compact{padding:7px 11px;font-size:12px}.connection span{width:8px;height:8px}.connection.healthy span{background:var(--green);box-shadow:0 0 0 4px rgba(69,214,154,.12)}.connection.healthy b{color:#bdebd8}.connection.warning span{background:var(--amber);box-shadow:0 0 0 4px rgba(246,185,77,.12)}.connection.warning b{color:#ffe0a7}.connection.disconnected span{background:var(--red);box-shadow:0 0 0 4px rgba(255,109,118,.12)}.connection.disconnected b{color:#ffc7cb}.hero-row{padding:34px 0 24px}.hero-row h1{font-size:36px}.stats{margin-bottom:0}
.stats{grid-template-columns:repeat(3,1fr)}
.recent-head{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin:36px 0 16px}.recent-head h2{font-size:22px;margin:0}.recent-head .eyebrow{margin-bottom:5px}.recent-head p{color:var(--muted);font-size:13px;margin:0}.recent-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.request-card{min-width:0;overflow:hidden;background:linear-gradient(145deg,rgba(16,29,56,.9),rgba(6,14,33,.94));border:1px solid var(--line);border-radius:14px;transition:transform .2s ease,border-color .2s ease,box-shadow .2s ease}.request-card:hover{transform:translateY(-4px);border-color:rgba(0,164,220,.55);box-shadow:0 18px 40px rgba(0,0,0,.3)}.request-poster{position:relative;aspect-ratio:2/3;overflow:hidden;background:linear-gradient(145deg,rgba(170,92,195,.45),rgba(0,164,220,.32))}.request-poster:after{content:"";position:absolute;inset:45% 0 0;background:linear-gradient(transparent,rgba(4,10,25,.92))}.request-poster img{width:100%;height:100%;object-fit:cover;transition:transform .35s ease}.request-card:hover .request-poster img{transform:scale(1.035)}.request-fallback{height:100%;display:grid;place-items:center;color:rgba(255,255,255,.72);font-size:42px;font-weight:800}.request-badges{position:absolute;z-index:1;inset:10px 10px auto;display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.request-badge{padding:4px 7px;border-radius:99px;background:rgba(0,11,37,.84);backdrop-filter:blur(7px);color:#dce8ff;font-size:9px;font-weight:800;letter-spacing:.07em;text-transform:uppercase}.request-badge.status-available,.request-badge.status-completed{color:#b9f3d9;background:rgba(15,74,60,.88)}.request-badge.status-partially_available,.request-badge.status-pending{color:#ffe0a7;background:rgba(91,61,10,.9)}.request-badge.status-declined,.request-badge.status-failed{color:#ffc7cb;background:rgba(91,25,34,.9)}.request-body{padding:13px 14px 15px}.request-body h3{font-size:14px;line-height:1.3;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.request-meta{display:flex;gap:7px;color:var(--muted);font-size:11px;margin-top:5px}.request-by{display:flex;align-items:center;gap:8px;margin-top:12px;color:#c8d5ea;font-size:11px}.request-avatar{width:24px;height:24px;display:grid;place-items:center;border-radius:50%;background:linear-gradient(135deg,var(--jelly-purple),var(--jelly-blue));color:white;font-size:10px;font-weight:800}.recent-grid>.empty{grid-column:1/-1}
@media(max-width:900px){.login-wrap{grid-template-columns:1fr}.login-note{display:none}.stats{grid-template-columns:repeat(2,1fr)}.grant-card{grid-template-columns:1fr 1fr}.card-actions{justify-content:flex-start}.group-grid{grid-template-columns:repeat(2,1fr)}.hero-row{align-items:flex-start;gap:24px;flex-direction:column}.actions{justify-content:flex-start}.catalog-toolbar{grid-template-columns:1fr 1fr}.catalog-row{grid-template-columns:auto 40px 1fr auto}.catalog-library{display:none}}
@media(max-width:620px){.shell{width:min(100% - 24px,1180px)}.credentials,.catalog-toolbar{grid-template-columns:1fr}.topbar{height:76px}.login-wrap{min-height:calc(100vh - 90px)}.login-card{padding:28px 22px}.login-card h1{font-size:42px}.token-row{flex-direction:column}.hero-row{padding-top:38px}.hero-row h1{font-size:38px}.stats{grid-template-columns:1fr 1fr}.stats article{padding:17px}.stats strong{font-size:28px}.section-tools{align-items:stretch;flex-direction:column}.search input{width:100%}.grant-tools{align-items:stretch;flex-direction:column}.grant-card{grid-template-columns:1fr}.group-grid{grid-template-columns:1fr}.check-list{grid-template-columns:1fr}.plan-summary{grid-template-columns:1fr}.actions .button{flex:1}.actions .icon{flex:0 0 41px}.selection-bar,.catalog-footer{flex-wrap:wrap}.selection-bar #selection-count{width:calc(100% - 30px);margin:0}.catalog-footer>span{order:-1;width:100%;margin:0}.catalog-row{grid-template-columns:auto 36px 1fr}.catalog-year,.catalog-status{display:none}.media-glyph{width:34px;height:42px}}
@media(max-width:620px){.topbar{height:68px}.topbar-actions{gap:9px}.connection b{display:none}.hero-row{padding-top:26px}.hero-row h1{font-size:32px}}
@media(max-width:900px){.stats{grid-template-columns:repeat(3,1fr)}}
@media(max-width:620px){.stats{grid-template-columns:1fr}}
@media(max-width:900px){.recent-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media(max-width:620px){.recent-head{align-items:flex-start;flex-direction:column;gap:4px}.recent-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.request-body{padding:11px}.request-badges{inset:7px 7px auto}.request-badge{font-size:8px}}
.request-card.linked{cursor:pointer}.request-card.linked:focus-visible{border-color:rgba(0,164,220,.7);box-shadow:0 18px 40px rgba(0,0,0,.3);outline:none}.request-card.unlinked{opacity:.72}.request-card.unlinked:hover{transform:none;border-color:var(--line);box-shadow:none}.request-card.unlinked:hover .request-poster img{transform:none}.request-action{display:block;margin-top:11px;color:#70dfff;font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase}.request-card.unlinked .request-action{color:var(--muted)}
.household-route{margin-top:16px;padding:11px 12px;border:1px solid rgba(0,164,220,.25);border-radius:9px;background:rgba(0,164,220,.07)}.household-route small{display:block;color:var(--muted);font-size:9px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}.household-route a{display:block;margin-top:4px;color:#70dfff;font:11px ui-monospace,SFMono-Regular,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.household-route.unavailable{border-color:var(--line);background:rgba(16,29,56,.45)}
@media(max-width:900px){.grant-card{grid-template-columns:56px 1fr 1fr}.grant-poster{grid-column:1;grid-row:1}.grant-main{grid-column:2/-1}.grant-owners{grid-column:2}.grant-access{grid-column:3}.grant-card>.card-actions{grid-column:2/-1;justify-content:flex-start}}
@media(max-width:620px){.grant-card{grid-template-columns:48px 1fr}.grant-poster{width:48px}.grant-main{grid-column:2}.grant-owners,.grant-access,.grant-card>.card-actions{grid-column:1/-1}}
.requests-toolbar{display:grid;grid-template-columns:minmax(240px,1fr) repeat(3,minmax(150px,auto));gap:10px;margin-bottom:10px}.requests-toolbar .search input{width:100%}.requests-toolbar select{color:var(--text);background:#080e17;border:1px solid var(--line);border-radius:10px;padding:11px 13px;outline:none}.requests-summary{color:var(--muted);font-size:12px;margin:0 0 10px}.request-rows{display:grid;gap:8px}.request-row{display:grid;grid-template-columns:minmax(220px,1.4fr) minmax(170px,1fr) minmax(150px,.8fr) auto;gap:16px;align-items:center;padding:13px 15px;background:linear-gradient(145deg,rgba(16,29,56,.86),rgba(6,14,33,.9));border:1px solid var(--line);border-radius:12px}.request-row h3{font-size:15px;margin:0 0 3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.request-row .meta{display:block}.request-row .pill.status-requested,.request-row .pill.seerr-pending,.request-row .pill.seerr-approved{color:#ffe0a7;background:rgba(246,185,77,.1)}.request-row .pill.status-ready,.request-row .pill.seerr-completed{color:#a9f0d0;background:rgba(69,214,154,.1)}.request-row .pill.status-failed,.request-row .pill.status-declined,.request-row .pill.seerr-declined,.request-row .pill.seerr-failed,.request-row .pill.held{color:#ffc0c5;background:rgba(255,109,118,.1)}.request-row .card-actions{flex-wrap:wrap}.request-rows>.empty{padding:32px}
@media(max-width:900px){.requests-toolbar{grid-template-columns:1fr 1fr}.request-row{grid-template-columns:1fr 1fr}.request-row .card-actions{grid-column:1/-1;justify-content:flex-start}}
@media(max-width:620px){.requests-toolbar,.request-row{grid-template-columns:1fr}}
.version-alert{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:0 0 18px;padding:13px 16px;border:1px solid rgba(255,109,118,.5);border-radius:11px;background:rgba(255,109,118,.09);color:#ffc7cb;font-size:13px}.version-alert strong{display:block;color:#ffdfe1;margin-bottom:3px}.version-alert p{margin:0}.version-alert.confirmed{border-color:rgba(246,185,77,.45);background:rgba(246,185,77,.09);color:#ffe0a7}.version-alert.confirmed strong{color:#ffe9c2}
.notice{margin:0 0 18px;padding:11px 15px;border:1px solid rgba(246,185,77,.45);border-radius:10px;background:rgba(246,185,77,.09);color:#ffe0a7;font-size:13px}
`;

export const ADMIN_APP_JS = `
(() => {
  'use strict';
  const state = { lastRemovedFormAt: null, jellyfinVersion: null, grants: [], groups: [], users: [], seerrImportAvailable: false, catalog: [], catalogSyncedAt: null, recentRequests: [], recentRequestsUnavailable: false, selectedItems: new Set(), catalogPage: 1, catalogPageSize: 25, activeTab: 'dashboard', appRequests: [], heldTitles: [], requestsLoaded: false, requestsUnavailable: '', pendingAction: null, pendingRelease: null };
  const byId = (id) => document.getElementById(id);
  const loginView = byId('login-view');
  const appView = byId('app-view');
  const toastNode = byId('toast');
  const noticeNode = byId('notice');
  // Text for the error codes JellyPass answers with; other errors already carry a sentence.
  const errorText = {
    session_check_unavailable: 'Jellyfin is temporarily unavailable — retrying…',
    jellyfin_unavailable: 'Jellyfin is temporarily unavailable. Try again in a moment.',
    shutting_down: 'JellyPass is restarting. Try again in a moment.',
    unauthorized: 'Your session has ended. Sign in again.',
    invalid_credentials: 'That username or password was not accepted.',
    too_many_login_attempts: 'Too many attempts. Try again later.',
    too_many_requests: 'Too many requests. Try again in a moment.',
    cross_origin_request_refused: 'This request was refused because it did not come from the admin page. Reload the page and try again.',
    unsupported_media_type: 'This request was refused. Reload the page and try again.',
    request_too_large: 'That request is too large.',
    invalid_request: 'That request was not valid.',
    not_found: 'That was not found.',
    item_not_found: 'That item was not found in Jellyfin.',
    requests_not_configured: 'Requests need the household app and Seerr.',
    request_declined: 'That request was declined in Seerr.',
    request_not_pending: 'Only a pending request can be declined.',
    request_not_cancellable: 'Only a pending, approved or failed request can be cancelled.',
    request_granted: 'That title has arrived. Change its access in Grants instead.',
    request_gone: 'Seerr no longer has that request.',
    radarr_removal_not_offered: 'Removing from Radarr is not available for this title.',
    title_not_held: 'That title is no longer held. Change its access in Grants.',
    jellyfin_version_changed: 'Jellyfin now reports another version. Check it again before allowing it.',
    jellyfin_version_unknown: 'JellyPass cannot read the Jellyfin version yet. Try again in a moment.',
    jellyfin_version_supported: 'This Jellyfin version is supported and needs no confirmation.',
  };
  // While Jellyfin cannot answer the server's session check, the server keeps the session and allows another check
  // 30 seconds later: the UI keeps its view and asks again, backing off to two minutes, never while the tab is hidden.
  // Time spent hidden does not count towards the wait: remaining holds what was left of it when the tab was hidden.
  const SESSION_RETRY_FIRST_MS = 30 * 1000;
  const SESSION_RETRY_MAX_MS = 2 * 60 * 1000;
  const sessionRetry = { delay: 0, dueAt: 0, remaining: null, timer: null };
  // Changes when a session ends (sign-out, 401) or starts (sign-in): an answer to a request made before then has no effect.
  let sessionEpoch = 0;
  const heroCopy = {
    dashboard: ['Jellyfin access', 'JellyPass dashboard', 'Monitor library access, audiences, and synchronization health.'],
    library: ['Jellyfin library', 'Your media library', 'Browse synchronized movies and series, then assign access in bulk.'],
    grants: ['Access policies', 'Access grants', 'Review protected titles, request owners, and applied Jellyfin policies.'],
    groups: ['Shared audiences', 'Access groups', 'Organize Jellyfin users into reusable library-access audiences.'],
    requests: ['Household app', 'Requests', 'Approve, decline or cancel what households asked for, and release held titles.'],
  };

  function scrollToTop() {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  window.addEventListener('pageshow', scrollToTop);
  window.addEventListener('load', scrollToTop);

  function node(tag, options, children) {
    const element = document.createElement(tag);
    if (options) Object.entries(options).forEach(([key, value]) => {
      if (key === 'class') element.className = value;
      else if (key === 'text') element.textContent = value;
      else if (key.startsWith('data-')) element.setAttribute(key, value);
      else element[key] = value;
    });
    (children || []).forEach((child) => element.append(child));
    return element;
  }

  async function api(path, options) {
    const config = options || {};
    const headers = new Headers(config.headers || {});
    if (config.body) headers.set('Content-Type', 'application/json');
    const epoch = sessionEpoch;
    let response;
    let text;
    try {
      response = await fetch(path, Object.assign({}, config, { headers }));
      text = await response.text();
    } catch (error) {
      // A request that failed after its session ended is as stale as one that was answered.
      assertSession(epoch);
      throw error;
    }
    assertSession(epoch);
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
    if (!response.ok) {
      // A session that ended at the server (signed out elsewhere, or the administrator was demoted or disabled).
      if (response.status === 401 && path.indexOf('/auth/') !== 0) setConnected(false);
      const known = typeof body.error === 'string' && Object.prototype.hasOwnProperty.call(errorText, body.error);
      if (response.status === 503 && body.error === 'session_check_unavailable') sessionUnavailable();
      const error = new Error(known ? errorText[body.error] : body.error || ('Request failed (' + response.status + ')'));
      error.code = body.code || (known ? body.error : undefined);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    // A successful answer means the session passed its check again.
    if (!noticeNode.hidden) sessionAvailable();
    return body;
  }

  // Thrown for an answer that arrived after its session ended or another began: callers show nothing for it.
  function staleAnswer() {
    const error = new Error('The session changed while this request was answered');
    error.stale = true;
    return error;
  }

  // Throws a stale answer when the session ended or another began since epoch was read: every view or state change that
  // follows an await checks this first, so only the session that asked is changed by the answer.
  function assertSession(epoch) {
    if (epoch !== sessionEpoch) throw staleAnswer();
  }

  async function load() {
    const epoch = sessionEpoch;
    // Recent requests are optional: a failure to load them shows an empty widget, but an ended session is not one.
    const recent = api('/v1/requests/recent').catch((error) => {
      if (error.stale || error.status === 401) throw error;
      return { requests: [], unavailable: true };
    });
    // The version check is optional too: a JellyPass without it answers 404, and the readout stays hidden.
    const version = api('/v1/jellyfin/version').catch((error) => {
      if (error.stale || error.status === 401) throw error;
      return null;
    });
    const results = await Promise.all([api('/v1/grants'), api('/v1/groups'), api('/v1/users'), api('/v1/library'), recent, version, api('/v1/webhooks/status')]);
    assertSession(epoch);
    state.jellyfinVersion = results[5];
    state.lastRemovedFormAt = results[6].lastRemovedFormAt;
    state.grants = results[0].grants;
    state.groups = results[1].groups;
    state.users = results[2].users;
    state.seerrImportAvailable = results[2].jellyseerrImportAvailable === true;
    state.catalog = results[3].items;
    state.catalogSyncedAt = results[3].lastSyncedAt || null;
    state.recentRequests = results[4].requests || [];
    state.recentRequestsUnavailable = results[4].unavailable === true;
    const catalogIds = new Set(state.catalog.map((item) => item.id.toLowerCase()));
    state.selectedItems.forEach((id) => { if (!catalogIds.has(id.toLowerCase())) state.selectedItems.delete(id); });
    render();
    scrollToTop();
  }

  function render() {
    const active = state.grants.filter((grant) => grant.active);
    const owners = new Set(active.flatMap((grant) => grant.owners));
    const attention = active.filter((grant) => grant.sync.state !== 'synced').length;
    byId('stat-grants').textContent = String(active.length);
    byId('stat-owners').textContent = String(owners.size);
    byId('stat-groups').textContent = String(state.groups.length);
    updateHealth(attention);
    byId('grant-count').textContent = String(state.grants.length);
    byId('group-count').textContent = String(state.groups.length);
    byId('library-count').textContent = String(state.catalog.length);
    renderGrants();
    renderGroups();
    renderCatalog();
    renderRecentRequests();
    renderJellyfinVersion();
  }

  // Shown only for a version outside the supported releases, or one that cannot be read: supported versions show nothing.
  function renderJellyfinVersion() {
    const status = state.jellyfinVersion;
    const panel = byId('jellyfin-version');
    const button = byId('jellyfin-version-confirm');
    const releases = status ? status.supportedReleases.map((release) => release + '.x').join(' and ') : '';
    panel.hidden = true;
    button.hidden = true;
    panel.classList.remove('confirmed');
    if (!status || status.supported === true) return;
    panel.hidden = false;
    if (status.version === null) {
      byId('jellyfin-version-title').textContent = 'Household hosts are paused: the Jellyfin version cannot be read';
      byId('jellyfin-version-text').textContent = 'JellyPass checks the Jellyfin version before household hosts serve, and keeps trying. ' + (status.error ? 'Last error: ' + status.error : '');
      return;
    }
    if (status.householdHosts === 'serving') {
      panel.classList.add('confirmed');
      byId('jellyfin-version-title').textContent = 'Jellyfin ' + status.version + ' is not a tested version';
      byId('jellyfin-version-text').textContent = 'Household hosts serve on it because ' + (status.confirmedVersion === status.version ? 'an administrator allowed it' : 'JELLYFIN_UNTESTED_VERSION_OK names it') + '. JellyPass is tested with Jellyfin ' + releases + '.';
      if (status.confirmedVersion === status.version) {
        button.textContent = 'Withdraw';
        button.dataset.action = 'withdraw';
        button.hidden = false;
      }
      return;
    }
    byId('jellyfin-version-title').textContent = 'Household hosts are paused: Jellyfin ' + status.version + ' is not a tested version';
    byId('jellyfin-version-text').textContent = 'JellyPass is tested with Jellyfin ' + releases + '. Household hosts answer 503 until you allow this exact version; the household privacy checks were not tested against it.';
    button.textContent = 'Allow Jellyfin ' + status.version;
    button.dataset.action = 'confirm';
    button.hidden = false;
  }

  function renderRecentRequests() {
    const container = byId('recent-requests');
    if (!state.recentRequests.length) {
      container.replaceChildren(node('div', { class: 'empty' }, [
        node('strong', { text: state.recentRequestsUnavailable ? 'Activity unavailable' : 'No linked requests yet' }),
        node('span', { text: state.recentRequestsUnavailable ? 'JellyPass could not load recent requests right now.' : 'Requests appear here after their media is linked to the synchronized Jellyfin library.' }),
      ]));
      return;
    }
    container.replaceChildren(...state.recentRequests.map((request) => {
      const poster = node('div', { class: 'request-poster' });
      if (request.posterPath) {
        const image = node('img', { alt: request.title + ' poster', loading: 'lazy', src: '/v1/requests/poster?path=' + encodeURIComponent(request.posterPath) });
        image.addEventListener('error', () => image.replaceWith(node('div', { class: 'request-fallback', text: request.mediaType === 'movie' ? 'M' : 'TV' })));
        poster.append(image);
      } else poster.append(node('div', { class: 'request-fallback', text: request.mediaType === 'movie' ? 'M' : 'TV' }));
      const status = request.mediaStatus === 'available' || request.mediaStatus === 'partially_available' || request.mediaStatus === 'processing'
        ? request.mediaStatus
        : request.requestStatus;
      const statusLabel = status.replaceAll('_', ' ');
      poster.append(node('div', { class: 'request-badges' }, [
        node('span', { class: 'request-badge', text: request.mediaType === 'movie' ? 'Movie' : 'Series' }),
        node('span', { class: 'request-badge status-' + status, text: statusLabel }),
      ]));
      const mediaMeta = [request.year ? String(request.year) : '', request.seasonCount ? request.seasonCount + ' season' + (request.seasonCount === 1 ? '' : 's') : ''].filter(Boolean);
      const requestedAt = new Date(request.createdAt);
      const catalogItem = request.jellyfinItemId && state.catalog.find((item) => item.id.toLowerCase() === request.jellyfinItemId.toLowerCase());
      const linked = Boolean(catalogItem);
      const card = node('article', { class: 'request-card ' + (linked ? 'linked' : 'unlinked') }, [poster, node('div', { class: 'request-body' }, [
        node('h3', { text: request.title, title: request.title }),
        node('div', { class: 'request-meta' }, [node('span', { text: mediaMeta.join(' · ') || (request.mediaType === 'movie' ? 'Movie' : 'Series') }), node('span', { text: '· ' + relativeTime(requestedAt) , title: requestedAt.toLocaleString() })]),
        node('div', { class: 'request-by' }, [node('span', { class: 'request-avatar', text: request.requestedBy.slice(0, 1).toUpperCase() }), node('span', { text: 'Requested by ' + request.requestedBy })]),
        node('span', { class: 'request-action', text: linked ? 'Edit library access →' : 'Waiting for Jellyfin' }),
      ])]);
      if (linked) {
        card.tabIndex = 0;
        card.setAttribute('role', 'button');
        card.setAttribute('aria-label', 'Edit library access for ' + request.title);
        card.addEventListener('click', () => editRecentRequest(request));
        card.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            editRecentRequest(request);
          }
        });
      } else {
        card.setAttribute('aria-disabled', 'true');
        card.setAttribute('title', 'This request is not linked to the synchronized Jellyfin library yet');
      }
      return card;
    }));
  }

  function editRecentRequest(request) {
    const item = request.jellyfinItemId && state.catalog.find((entry) => entry.id.toLowerCase() === request.jellyfinItemId.toLowerCase());
    if (!item) {
      toast('This request is not linked to a synchronized Jellyfin item yet', true);
      return;
    }
    activateTab('library');
    byId('library-filter').value = item.name;
    byId('library-name-filter').value = item.libraryId;
    byId('library-sort').value = 'title-asc';
    state.catalogPage = 1;
    state.selectedItems.clear();
    state.selectedItems.add(item.id);
    renderCatalog();
    openBulkAccess();
  }

  function relativeTime(date) {
    const seconds = Math.round((date.getTime() - Date.now()) / 1000);
    const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    if (Math.abs(seconds) < 3600) return formatter.format(Math.round(seconds / 60), 'minute');
    if (Math.abs(seconds) < 86400) return formatter.format(Math.round(seconds / 3600), 'hour');
    if (Math.abs(seconds) < 2592000) return formatter.format(Math.round(seconds / 86400), 'day');
    return formatter.format(Math.round(seconds / 2592000), 'month');
  }

  function filteredCatalog() {
    const query = byId('library-filter').value.trim().toLowerCase();
    const libraryId = byId('library-name-filter').value;
    const sort = byId('library-sort').value;
    const items = state.catalog.filter((item) =>
      (!query || item.name.toLowerCase().includes(query) || String(item.productionYear || '').includes(query)) &&
      (!libraryId || item.libraryId === libraryId)
    );
    const titleOrder = (left, right) => left.name.localeCompare(right.name, undefined, { numeric: true });
    const time = (value) => value ? Date.parse(value) || 0 : 0;
    items.sort((left, right) => {
      if (sort === 'title-desc') return -titleOrder(left, right);
      if (sort === 'date-desc') return time(right.dateCreated) - time(left.dateCreated) || titleOrder(left, right);
      if (sort === 'date-asc') return (time(left.dateCreated) || Number.MAX_SAFE_INTEGER) - (time(right.dateCreated) || Number.MAX_SAFE_INTEGER) || titleOrder(left, right);
      if (sort === 'year-desc') return (right.productionYear || 0) - (left.productionYear || 0) || titleOrder(left, right);
      if (sort === 'year-asc') return (left.productionYear || 9999) - (right.productionYear || 9999) || titleOrder(left, right);
      if (sort === 'access-desc') return time(right.managedAt) - time(left.managedAt) || titleOrder(left, right);
      if (sort === 'managed-first') return Number(right.managed) - Number(left.managed) || titleOrder(left, right);
      if (sort === 'unmanaged-first') return Number(left.managed) - Number(right.managed) || titleOrder(left, right);
      return titleOrder(left, right);
    });
    return items;
  }

  function renderCatalog() {
    byId('library-sync-status').textContent = state.catalogSyncedAt
      ? state.catalog.length + ' movies and series · synced ' + new Date(state.catalogSyncedAt).toLocaleString()
      : 'Not synchronized yet';
    const librarySelect = byId('library-name-filter');
    const selectedLibrary = librarySelect.value;
    const libraries = [...new Map(state.catalog.map((item) => [item.libraryId, item.libraryName])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    librarySelect.replaceChildren(node('option', { value: '', text: 'All Jellyfin libraries' }));
    libraries.forEach(([id, name]) => librarySelect.append(node('option', { value: id, text: name })));
    librarySelect.value = libraries.some(([id]) => id === selectedLibrary) ? selectedLibrary : '';
    const filtered = filteredCatalog();
    const pageCount = Math.max(1, Math.ceil(filtered.length / state.catalogPageSize));
    state.catalogPage = Math.min(Math.max(1, state.catalogPage), pageCount);
    const start = (state.catalogPage - 1) * state.catalogPageSize;
    const visible = filtered.slice(start, start + state.catalogPageSize);
    const list = byId('catalog-list');
    list.replaceChildren();
    if (!state.catalog.length) {
      list.append(node('div', { class: 'empty' }, [node('strong', { text: 'Library catalog is empty' }), node('span', { text: 'Sync with Jellyfin to browse and assign media in bulk.' })]));
    } else if (!filtered.length) {
      list.append(node('div', { class: 'empty' }, [node('strong', { text: 'No matching media' }), node('span', { text: 'Try another title or year.' })]));
    } else {
      const sortingByDateAdded = ['date-desc', 'date-asc'].includes(byId('library-sort').value);
      visible.forEach((item) => {
        const checked = state.selectedItems.has(item.id);
        const checkbox = node('input', { class: 'catalog-check', type: 'checkbox', checked, ariaLabel: 'Select ' + item.name });
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) state.selectedItems.add(item.id); else state.selectedItems.delete(item.id);
          renderCatalog();
        });
        const row = node('article', { class: 'catalog-row' + (checked ? ' selected' : '') }, [
          checkbox,
          node('div', { class: 'media-glyph', text: item.mediaType === 'series' ? 'S' : 'M' }),
          node('div', { class: 'catalog-title' }, [node('strong', { text: item.name, title: item.id }), node('small', { text: item.mediaType + (sortingByDateAdded && item.dateCreated ? ' · Added ' + shortDate(item.dateCreated) : item.productionYear ? ' · ' + item.productionYear : '') })]),
          node('div', { class: 'catalog-library', text: item.libraryName }),
          node('div', { class: 'catalog-status' }, [node('span', { class: 'pill ' + (item.managed ? 'sync-synced' : ''), text: item.managed ? 'Protected' : 'Unmanaged' })]),
        ]);
        list.append(row);
      });
    }
    byId('select-visible').checked = visible.length > 0 && visible.every((item) => state.selectedItems.has(item.id));
    byId('select-visible').indeterminate = visible.some((item) => state.selectedItems.has(item.id)) && !byId('select-visible').checked;
    byId('selection-count').textContent = state.selectedItems.size + ' selected';
    byId('bulk-access').disabled = state.selectedItems.size === 0;
    byId('clear-library-search').disabled = !byId('library-filter').value && !byId('library-name-filter').value;
    byId('library-page-size').value = String(state.catalogPageSize);
    byId('library-page-info').textContent = 'Page ' + state.catalogPage + ' of ' + pageCount + ' · ' + filtered.length + ' result' + (filtered.length === 1 ? '' : 's');
    byId('library-previous').disabled = state.catalogPage <= 1;
    byId('library-next').disabled = state.catalogPage >= pageCount;
  }

  function shortDate(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(undefined, { dateStyle: 'short' }).format(date);
  }

  function userName(id) {
    const user = state.users.find((entry) => entry.id.toLowerCase() === String(id).toLowerCase());
    return user ? user.name : id || 'Unknown requester';
  }

  function catalogItem(itemId) {
    return state.catalog.find((item) => item.id.toLowerCase() === String(itemId).toLowerCase());
  }

  function renderGrants() {
    const query = byId('grant-search').value.trim().toLowerCase();
    const list = byId('grants-list');
    const grants = state.grants.filter((grant) => {
      const item = catalogItem(grant.itemId);
      return JSON.stringify(grant).toLowerCase().includes(query)
        || (item && item.name.toLowerCase().includes(query))
        || grant.owners.some((id) => userName(id).toLowerCase().includes(query));
    });
    list.replaceChildren();
    if (!grants.length) {
      list.append(node('div', { class: 'empty' }, [node('strong', { text: query ? 'No matching grants' : 'No protected titles yet' }), node('span', { text: query ? 'Try a different search.' : 'New Seerr requests will appear here after their media becomes available.' })]));
      return;
    }
    grants.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).forEach((grant) => {
      const item = catalogItem(grant.itemId);
      const displayTitle = item ? item.name : grant.itemId;
      const poster = node('div', { class: 'grant-poster' });
      if (item) {
        const image = node('img', { alt: displayTitle + ' poster', loading: 'lazy', src: '/v1/library/poster?itemId=' + encodeURIComponent(grant.itemId) });
        image.addEventListener('error', () => image.replaceWith(node('div', { class: 'grant-poster-fallback', text: grant.mediaType === 'tv' || grant.mediaType === 'series' ? 'TV' : 'M' })));
        poster.append(image);
      } else poster.append(node('div', { class: 'grant-poster-fallback', text: grant.mediaType === 'tv' || grant.mediaType === 'series' ? 'TV' : 'M' }));
      const ownerPills = grant.owners.slice(0, 3).map((id) => node('span', { class: 'pill', text: userName(id) }));
      if (grant.owners.length > 3) ownerPills.push(node('span', { class: 'pill', text: '+' + (grant.owners.length - 3) }));
      const groupNames = grant.groupIds.map((id) => (state.groups.find((group) => group.id === id) || { name: id }).name);
      const title = node('div', { class: 'grant-title' }, [node('h3', { text: displayTitle, title: displayTitle }), node('span', { class: 'type', text: grant.mediaType || (item && item.mediaType) || 'media' })]);
      const requestCount = Object.keys(grant.requests).length;
      const manualCount = (grant.manualUserIds || []).length;
      const sourceText = requestCount + ' request' + (requestCount === 1 ? '' : 's') + (manualCount ? ' · ' + manualCount + ' manual' : '');
      const main = node('div', { class: 'grant-main' }, [title, node('div', { class: 'meta mono', text: grant.itemId }), node('div', { class: 'meta', text: sourceText + ' · updated ' + new Date(grant.updatedAt).toLocaleString() })]);
      const ownerSection = node('div', { class: 'grant-section grant-owners' }, [node('strong', { text: 'Access owners' }), node('div', { class: 'pill-row' }, ownerPills.length ? ownerPills : [node('span', { class: 'meta', text: 'No direct owners' })])]);
      const accessSection = node('div', { class: 'grant-section grant-access' }, [node('strong', { text: groupNames.length ? groupNames.join(', ') : 'Direct requests only' }), node('div', { class: 'pill-row' }, [node('span', { class: 'pill sync-' + grant.sync.state, text: grant.sync.state })].concat(grant.remap && grant.remap.sourceReappeared ? [node('span', { class: 'pill sync-orphaned', text: 'source reappeared', title: 'This item exists again in Jellyfin after its grant was moved to ' + grant.remap.sourceReappeared.movedTo.join(', ') + '. Its restrictions were kept; revoke the grant explicitly if it is no longer needed.' })] : [], [node('span', { class: 'meta', text: groupNames.length + ' shared group' + (groupNames.length === 1 ? '' : 's') })]))]);
      const planButton = node('button', { class: 'button quiet', text: 'Plan' });
      planButton.addEventListener('click', () => showGrantPlan(grant));
      const accessButton = node('button', { class: 'button quiet', text: 'Access' });
      accessButton.addEventListener('click', () => openAccess(grant));
      const requestsButton = node('button', { class: 'button quiet', text: 'Requests' });
      requestsButton.addEventListener('click', () => openRequests(grant));
      const moveButton = node('button', { class: 'button quiet', text: 'Move', title: 'Move this grant to another Jellyfin item, for example after a title was re-imported under a new ID' });
      moveButton.addEventListener('click', () => remapGrant(grant));
      const actions = node('div', { class: 'card-actions' }, [planButton, requestsButton, accessButton, moveButton]);
      list.append(node('article', { class: 'grant-card' }, [poster, main, ownerSection, accessSection, actions]));
    });
  }

  function renderGroups() {
    const list = byId('groups-list');
    list.replaceChildren();
    if (!state.groups.length) {
      list.append(node('div', { class: 'empty' }, [node('strong', { text: 'No access groups yet' }), node('span', { text: 'Create a household or shared audience to grant several users access together.' })]));
      return;
    }
    state.groups.forEach((group) => {
      const addUser = node('button', { class: 'button quiet', text: 'Add user' });
      addUser.addEventListener('click', () => openCreateUser(group.id));
      const edit = node('button', { class: 'button quiet', text: 'Edit' });
      edit.addEventListener('click', () => openGroup(group));
      const remove = node('button', { class: 'button danger', text: 'Delete' });
      remove.addEventListener('click', () => deleteGroup(group));
      const route = group.householdUrl
        ? node('div', { class: 'household-route' }, [node('small', { text: 'Household Jellyfin URL' }), node('a', { text: group.householdUrl, href: group.householdUrl, target: '_blank', rel: 'noreferrer' })])
        : node('div', { class: 'household-route unavailable' }, [node('small', { text: 'Household Jellyfin URL' }), node('span', { class: 'meta', text: 'Use a DNS-safe group ID to enable a household URL.' })]);
      list.append(node('article', { class: 'group-card' }, [node('div', { class: 'mono', text: group.id }), node('h3', { text: group.name }), node('p', { text: group.userIds.map(userName).join(', ') || 'No users in this group' }), route, node('footer', {}, [node('span', { text: group.userIds.length + ' member' + (group.userIds.length === 1 ? '' : 's') }), node('div', { class: 'card-actions' }, [addUser, edit, remove])])]));
    });
  }

  function showPlan(title, plans) {
    byId('plan-title').textContent = title;
    const content = byId('plan-content');
    content.replaceChildren();
    const list = Array.isArray(plans) ? plans : [plans];
    const changes = list.flatMap((plan) => plan.users).filter((entry) => entry.action !== 'none');
    const itemChanges = list.reduce((total, plan) => total + (plan.item.action !== 'none' ? 1 : 0) + (plan.relatedItems || []).filter((item) => item.action !== 'none').length, 0);
    content.append(node('div', { class: 'plan-summary' }, [summary('Titles checked', list.length), summary('Item changes', itemChanges), summary('User policy changes', changes.length)]));
    if (!itemChanges && !changes.length) content.append(node('div', { class: 'empty' }, [node('strong', { text: 'Everything is already in sync' }), node('span', { text: 'No Jellyfin tags or user policies need to change.' })]));
    list.forEach((plan) => {
      const affected = plan.users.filter((entry) => entry.action !== 'none');
      const related = (plan.relatedItems || []).filter((entry) => entry.action !== 'none');
      if (plan.item.action === 'none' && !related.length && !affected.length && list.length > 1) return;
      const relatedText = related.length ? ' · Related: ' + related.map((entry) => entry.action + ' ' + entry.itemName).join(', ') : '';
      content.append(node('div', { class: 'plan-item' }, [node('strong', { text: plan.itemName || plan.itemId }), node('span', { text: plan.itemId }), node('span', { class: 'change', text: 'Item: ' + plan.item.action + relatedText + ' · Policies: ' + (affected.map((entry) => entry.action + ' ' + entry.userName).join(', ') || 'none') })]));
    });
    byId('plan-dialog').showModal();
  }

  function summary(label, value) { return node('article', {}, [node('span', { text: label }), node('strong', { text: String(value) })]); }

  async function showGrantPlan(grant) {
    await busy(async (live) => {
      const result = await api('/v1/grants/' + encodeURIComponent(grant.itemId) + '/plan');
      live();
      showPlan('Grant plan', result.plan);
    });
  }

  function openGroup(group) {
    const editing = Boolean(group);
    byId('group-title').textContent = editing ? 'Edit group' : 'New group';
    byId('group-id').value = editing ? group.id : '';
    byId('group-id').readOnly = editing;
    byId('group-name').value = editing ? group.name : '';
    const selected = new Set(editing ? group.userIds.map((id) => id.toLowerCase()) : []);
    const options = byId('user-options');
    options.replaceChildren();
    state.users.filter((user) => !user.isAdministrator).forEach((user) => options.append(checkOption('group-user', user.id, user.name, user.id, selected.has(user.id.toLowerCase()))));
    const passwordless = byId('passwordless-options');
    passwordless.replaceChildren();
    state.users.filter((user) => !user.isAdministrator).forEach((user) => passwordless.append(checkOption('passwordless-user', user.id, user.name, 'No password', Boolean(user.passwordless))));
    byId('group-dialog').showModal();
  }

  function openCreateUser(groupId) {
    if (!state.groups.length) {
      toast('Create a household or access group first', true);
      return;
    }
    byId('user-form').reset();
    const select = byId('new-user-group');
    select.replaceChildren(...state.groups.map((group) => node('option', { value: group.id, text: group.name + ' · ' + group.id })));
    if (groupId && state.groups.some((group) => group.id === groupId)) select.value = groupId;
    const importOption = byId('import-to-seerr');
    importOption.disabled = !state.seerrImportAvailable;
    importOption.checked = false;
    byId('seerr-import-help').textContent = state.seerrImportAvailable
      ? 'Link this Jellyfin identity so the user can own requests.'
      : 'Seerr is not configured in JellyPass.';
    byId('user-dialog').showModal();
    byId('new-username').focus();
  }

  function openAccess(grant) {
    byId('access-item-id').value = grant.itemId;
    byId('access-item').textContent = grant.itemId;
    const selected = new Set(grant.groupIds);
    const options = byId('group-options');
    options.replaceChildren();
    state.groups.forEach((group) => options.append(checkOption('grant-group', group.id, group.name, group.userIds.length + ' members', selected.has(group.id))));
    if (!state.groups.length) options.append(node('p', { class: 'hint', text: 'Create a group first, then attach it to this title.' }));
    byId('access-dialog').showModal();
  }

  function openRequests(grant) {
    byId('requests-item').textContent = grant.itemId;
    const list = byId('requests-list');
    list.replaceChildren();
    const requests = Object.entries(grant.requests);
    if (!requests.length) list.append(node('div', { class: 'empty' }, [node('strong', { text: 'No direct requests' }), node('span', { text: 'This title is accessible only through shared groups.' })]));
    requests.forEach(([requestId, userId]) => {
      const revoke = node('button', { class: 'button danger', text: 'Revoke' });
      revoke.addEventListener('click', () => revokeRequest(grant, requestId, userId));
      list.append(node('div', { class: 'request-row' }, [node('div', {}, [node('strong', { text: userName(userId) }), node('small', { text: 'Request ' + requestId + ' · ' + userId })]), revoke]));
    });
    byId('requests-dialog').showModal();
  }

  async function syncCatalog() {
    await busy(async (live) => {
      const result = await api('/v1/library/sync', { method: 'POST' });
      live();
      state.catalog = result.items;
      state.catalogSyncedAt = result.lastSyncedAt;
      render();
      toast('Synchronized ' + result.items.length + ' library titles');
    });
  }

  function selectVisible() {
    const filtered = filteredCatalog();
    const start = (state.catalogPage - 1) * state.catalogPageSize;
    const visible = filtered.slice(start, start + state.catalogPageSize);
    if (byId('select-visible').checked) visible.forEach((item) => state.selectedItems.add(item.id));
    else visible.forEach((item) => state.selectedItems.delete(item.id));
    renderCatalog();
  }

  function clearSelection() {
    state.selectedItems.clear();
    renderCatalog();
  }

  function clearLibrarySearch() {
    byId('library-filter').value = '';
    byId('library-name-filter').value = '';
    state.catalogPage = 1;
    renderCatalog();
    scrollToTop();
    byId('library-filter').focus();
  }

  function resetLibraryView() {
    byId('library-filter').value = '';
    byId('library-name-filter').value = '';
    state.catalogPage = 1;
    state.selectedItems.clear();
    renderCatalog();
  }

  function openBulkAccess() {
    const itemIds = [...state.selectedItems];
    if (!itemIds.length) return;
    byId('bulk-summary').textContent = itemIds.length + ' selected title' + (itemIds.length === 1 ? '' : 's') + '. The same audience will be assigned to all of them.';
    const grants = itemIds.map((id) => state.grants.find((grant) => grant.itemId.toLowerCase() === id.toLowerCase()));
    const allManaged = grants.every(Boolean);
    const commonUsers = allManaged && grants.length
      ? (grants[0].manualUserIds || []).filter((id) => grants.every((grant) => (grant.manualUserIds || []).includes(id)))
      : [];
    const commonGroups = allManaged && grants.length
      ? grants[0].groupIds.filter((id) => grants.every((grant) => grant.groupIds.includes(id)))
      : [];
    const selectedUsers = new Set(commonUsers.map((id) => id.toLowerCase()));
    const userOptions = byId('bulk-user-options');
    userOptions.replaceChildren();
    state.users.filter((user) => !user.isAdministrator).forEach((user) => userOptions.append(checkOption('bulk-user', user.id, user.name, user.id, selectedUsers.has(user.id.toLowerCase()))));
    const selectedGroups = new Set(commonGroups);
    const groupOptions = byId('bulk-group-options');
    groupOptions.replaceChildren();
    state.groups.forEach((group) => groupOptions.append(checkOption('bulk-group', group.id, group.name, group.userIds.length + ' members', selectedGroups.has(group.id))));
    if (!state.groups.length) groupOptions.append(node('p', { class: 'hint', text: 'No access groups exist yet.' }));
    byId('bulk-dialog').showModal();
  }

  async function previewBulkAccess(event) {
    event.preventDefault();
    const body = {
      itemIds: [...state.selectedItems],
      userIds: checkedValues('bulk-user'),
      groupIds: checkedValues('bulk-group'),
    };
    if (!body.userIds.length && !body.groupIds.length) {
      toast('Select at least one user or group', true);
      return;
    }
    await busy(async (live) => {
      const preview = await api('/v1/library/access?dryRun=true', { method: 'PUT', body: JSON.stringify(body) });
      live();
      byId('bulk-dialog').close();
      showPlan('Bulk library access plan', preview.result.plans);
      if (confirm('Apply this audience to ' + body.itemIds.length + ' selected title' + (body.itemIds.length === 1 ? '' : 's') + '?')) {
        await api('/v1/library/access', { method: 'PUT', body: JSON.stringify(body) });
        live();
        byId('plan-dialog').close();
        state.selectedItems.clear();
        await load();
        live();
        toast('Bulk library access updated');
      }
    });
  }

  async function remapGrant(grant) {
    const toItemId = (prompt('Move this grant to Jellyfin item ID. Only a grant whose item was deleted can be moved; its audience is merged with any grant already on that item:') || '').trim();
    if (!toItemId) return;
    await busy(async (live) => {
      const path = '/v1/grants/' + encodeURIComponent(grant.itemId) + '/remap';
      const body = JSON.stringify({ toItemId });
      try {
        const preview = await api(path + '?dryRun=true', { method: 'POST', body });
        live();
        showPlan('Move plan', [preview.result.sourcePlan, preview.result.plan]);
        if (confirm('Move this grant from ' + grant.itemId + ' to ' + toItemId + '?')) {
          await api(path, { method: 'POST', body });
          live();
          byId('plan-dialog').close();
          await load();
          live();
          toast('Grant moved');
        }
      } catch (error) {
        if (error.stale) throw error;
        live();
        if (error.code === 'source_item_exists') {
          throw new Error('Not moved: ' + grant.itemId + ' still exists in Jellyfin, and moving its grant would make it visible to every household. Revoke its access explicitly first.');
        }
        if (error.code === 'quality_mismatch') throw new Error('Not moved: ' + error.message);
        if (error.code === 'source_reappeared') {
          byId('plan-dialog').close();
          await load();
          live();
          throw new Error(grant.itemId + ' exists again in Jellyfin: ' + toItemId + ' was granted, but the original grant was kept with its restrictions. Revoke it explicitly if it is no longer needed.');
        }
        throw error;
      }
    });
  }

  async function revokeRequest(grant, requestId, userId) {
    await busy(async (live) => {
      const path = '/v1/grants/' + encodeURIComponent(grant.itemId) + '/requests/' + encodeURIComponent(requestId);
      const preview = await api(path + '?dryRun=true', { method: 'DELETE' });
      live();
      byId('requests-dialog').close();
      showPlan('Revocation plan', preview.result.plan);
      if (confirm('Revoke request ' + requestId + ' for ' + userName(userId) + '?')) {
        await api(path, { method: 'DELETE' });
        live();
        byId('plan-dialog').close();
        await load();
        live();
        toast('Request revoked');
      }
    });
  }

  function checkOption(name, value, label, detail, checked) {
    const input = node('input', { type: 'checkbox', name, value, checked });
    return node('label', { class: 'check' }, [input, node('span', {}, [node('strong', { text: label }), node('small', { text: detail })])]);
  }

  async function saveGroup(event) {
    event.preventDefault();
    const id = byId('group-id').value.trim();
    const body = { name: byId('group-name').value.trim(), userIds: checkedValues('group-user') };
    await busy(async (live) => {
      await api('/v1/groups/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify(body) });
      live();
      const passwordless = new Set(checkedValues('passwordless-user').map((userId) => userId.toLowerCase()));
      const changed = state.users.filter((user) => !user.isAdministrator && Boolean(user.passwordless) !== passwordless.has(user.id.toLowerCase()));
      for (const user of changed) {
        await api('/v1/users/' + encodeURIComponent(user.id) + '/sign-in', { method: 'PUT', body: JSON.stringify({ passwordless: !user.passwordless }) });
        live();
      }
      byId('group-dialog').close();
      await load();
      live();
      toast('Group saved');
    });
  }

  async function createUser(event) {
    event.preventDefault();
    const username = byId('new-username').value.trim();
    const password = byId('new-password').value;
    const confirmation = byId('confirm-password').value;
    if (password !== confirmation) {
      toast('Passwords do not match', true);
      byId('confirm-password').focus();
      return;
    }
    if (password.length > 0 && password.length < 8) {
      toast('Use at least 8 characters or leave the password blank', true);
      byId('new-password').focus();
      return;
    }
    const groupId = byId('new-user-group').value;
    const importToSeerr = byId('import-to-seerr').checked && !byId('import-to-seerr').disabled;
    await busy(async (live) => {
      try {
        const result = await api('/v1/users', { method: 'POST', body: JSON.stringify({ username, password, groupId, importToJellyseerr: importToSeerr }) });
        live();
        byId('user-dialog').close();
        await load();
        live();
        const imported = result.jellyseerr.status === 'imported' ? ' and imported into Seerr' : result.jellyseerr.status === 'already_imported' ? '; Seerr was already linked' : '';
        toast(result.user.name + ' was created and added to ' + result.group.name + imported);
      } catch (error) {
        if (error.stale) throw error;
        live();
        if (error.code === 'user_created_jellyseerr_import_failed' || error.code === 'user_created_household_assignment_failed') {
          byId('user-dialog').close();
          await load();
          live();
        }
        throw error;
      } finally {
        byId('new-password').value = '';
        byId('confirm-password').value = '';
      }
    });
  }

  async function deleteGroup(group) {
    if (!confirm('Delete "' + group.name + '"? It will be removed from every linked title and those policies will be reconciled.')) return;
    await busy(async (live) => {
      await api('/v1/groups/' + encodeURIComponent(group.id), { method: 'DELETE' });
      await load();
      live();
      toast('Group deleted');
    });
  }

  async function previewAccess(event) {
    event.preventDefault();
    const itemId = byId('access-item-id').value;
    const groupIds = checkedValues('grant-group');
    await busy(async (live) => {
      const preview = await api('/v1/grants/' + encodeURIComponent(itemId) + '/groups?dryRun=true', { method: 'PUT', body: JSON.stringify({ groupIds }) });
      live();
      byId('access-dialog').close();
      showPlan('Shared access plan', preview.result.plan);
      if (confirm('Apply this shared-access change now?')) {
        await api('/v1/grants/' + encodeURIComponent(itemId) + '/groups', { method: 'PUT', body: JSON.stringify({ groupIds }) });
        live();
        byId('plan-dialog').close();
        await load();
        live();
        toast('Shared access updated');
      }
    });
  }

  function checkedValues(name) { return Array.from(document.querySelectorAll('input[name="' + name + '"]:checked')).map((input) => input.value); }

  async function reconcilePolicies() {
    await busy(async (live) => {
      const preview = await api('/v1/reconcile?dryRun=true', { method: 'POST' });
      live();
      showPlan('Reconciliation plan', preview.plans);
      const changes = preview.plans.reduce((total, plan) => total + (plan.item.action !== 'none' ? 1 : 0) + (plan.relatedItems || []).filter((item) => item.action !== 'none').length + plan.users.filter((user) => user.action !== 'none').length, 0);
      if (!changes) return;
      if (confirm('Apply ' + changes + ' previewed reconciliation change' + (changes === 1 ? '' : 's') + '?')) {
        await api('/v1/reconcile', { method: 'POST' });
        live();
        byId('plan-dialog').close();
        await load();
        live();
        toast('Policies reconciled');
      }
    });
  }

  // Runs an action with the buttons disabled. operation receives live(), which throws a stale answer once the session
  // that started the action has ended: the action calls it after each await, before it changes the view.
  async function busy(operation) {
    const enabledButtons = Array.from(document.querySelectorAll('button:not(:disabled)'));
    enabledButtons.forEach((button) => { button.disabled = true; });
    const epoch = sessionEpoch;
    const live = () => assertSession(epoch);
    try { await operation(live); } catch (error) { if (!error.stale) toast(error.message || String(error), true); }
    finally { enabledButtons.forEach((button) => { button.disabled = false; }); }
  }

  let toastTimer;
  function toast(message, isError) {
    clearTimeout(toastTimer);
    toastNode.textContent = message;
    toastNode.className = 'toast show' + (isError ? ' error' : '');
    toastTimer = setTimeout(() => { toastNode.className = 'toast'; }, 4200);
  }

  function sessionUnavailable() {
    noticeNode.textContent = errorText.session_check_unavailable;
    noticeNode.hidden = false;
    // The session is kept at the server, so the sign-in form is not shown.
    if (appView.hidden) loginView.hidden = true;
    setHealth('warning', 'Jellyfin unavailable');
    if (sessionRetry.timer || sessionRetry.remaining !== null) return;
    sessionRetry.delay = sessionRetry.delay ? Math.min(sessionRetry.delay * 2, SESSION_RETRY_MAX_MS) : SESSION_RETRY_FIRST_MS;
    sessionRetry.remaining = sessionRetry.delay;
    armSessionRetry();
  }

  // Starts the wait that is left while the tab is shown, and pauses it, keeping what is left, while it is hidden.
  function armSessionRetry() {
    if (document.visibilityState === 'hidden') {
      if (!sessionRetry.timer) return;
      clearTimeout(sessionRetry.timer);
      sessionRetry.timer = null;
      sessionRetry.remaining = Math.max(0, sessionRetry.dueAt - Date.now());
      sessionRetry.dueAt = 0;
      return;
    }
    if (sessionRetry.timer || sessionRetry.remaining === null) return;
    sessionRetry.dueAt = Date.now() + sessionRetry.remaining;
    sessionRetry.remaining = null;
    sessionRetry.timer = setTimeout(retrySession, sessionRetry.dueAt - Date.now());
  }

  function clearSessionRetry() {
    clearTimeout(sessionRetry.timer);
    sessionRetry.timer = null;
    sessionRetry.dueAt = 0;
    sessionRetry.remaining = null;
    sessionRetry.delay = 0;
  }

  function sessionAvailable() {
    clearSessionRetry();
    noticeNode.hidden = true;
    noticeNode.textContent = '';
    if (!appView.hidden) updateHealth();
  }

  async function retrySession() {
    sessionRetry.timer = null;
    sessionRetry.dueAt = 0;
    const connected = !appView.hidden;
    const epoch = sessionEpoch;
    try {
      await api('/auth/session');
      assertSession(epoch);
      if (!connected) {
        await load();
        assertSession(epoch);
        setConnected(true);
      }
    } catch (error) {
      if (error.stale || epoch !== sessionEpoch) return;
      if (error.status === 401) setConnected(false);
      // Anything else (JellyPass unreachable, or a load that failed) is asked again later.
      else sessionUnavailable();
    }
  }

  document.addEventListener('visibilitychange', armSessionRetry);

  // A session that ends invalidates the answers still on their way, so none of them can show a view, notice or retry.
  function endSession() {
    sessionEpoch += 1;
    sessionAvailable();
  }

  function setConnected(connected) {
    if (!connected) endSession();
    loginView.hidden = connected;
    appView.hidden = !connected;
    byId('logout').hidden = !connected;
    if (connected) updateHealth();
    else setHealth('disconnected', 'Disconnected');
    scrollToTop();
  }

  function setHealth(level, label) {
    const connection = byId('connection');
    connection.classList.remove('healthy', 'warning', 'disconnected', 'online');
    connection.classList.add(level);
    connection.querySelector('b').textContent = label;
  }

  function updateHealth(attentionCount) {
    const attention = attentionCount === undefined
      ? state.grants.filter((grant) => grant.active && grant.sync.state !== 'synced').length
      : attentionCount;
    const syncedAt = state.catalogSyncedAt ? Date.parse(state.catalogSyncedAt) : 0;
    const syncOverdue = !syncedAt || Date.now() - syncedAt > 2 * 60 * 60 * 1000;
    const version = state.jellyfinVersion;
    if (version && version.householdHosts !== 'serving') setHealth('warning', 'Household hosts paused');
    else if (state.lastRemovedFormAt && Date.now() - state.lastRemovedFormAt < 24 * 60 * 60 * 1000) setHealth('warning', 'Seerr webhook refused: update header and template');
    else if (attention) setHealth('warning', attention + ' polic' + (attention === 1 ? 'y' : 'ies') + ' need attention');
    else if (syncOverdue) setHealth('warning', syncedAt ? 'Library sync overdue' : 'Library sync required');
    else setHealth('healthy', 'Sync healthy');
  }

  byId('jellyfin-version-confirm').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const status = state.jellyfinVersion;
    if (!status) return;
    const withdraw = button.dataset.action === 'withdraw';
    if (!withdraw && !confirm('Allow household hosts to serve on Jellyfin ' + status.version + '? JellyPass has not been tested with it.')) return;
    button.disabled = true;
    try {
      state.jellyfinVersion = withdraw
        ? await api('/v1/jellyfin/version/confirmation', { method: 'DELETE' })
        : await api('/v1/jellyfin/version/confirmation', { method: 'PUT', body: JSON.stringify({ version: status.version }) });
      renderJellyfinVersion();
      updateHealth();
      toast(withdraw ? 'Household hosts are paused again for this version' : 'Household hosts serve on Jellyfin ' + status.version);
    } catch (error) {
      if (error.stale) return;
      toast(error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  byId('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    byId('login-error').textContent = '';
    let accepted = false;
    try {
      await api('/auth/login', { method: 'POST', body: JSON.stringify({ username: byId('username').value.trim(), password: byId('password').value }) });
      accepted = true;
      // A new session: answers to requests made before it have no effect.
      sessionEpoch += 1;
      const epoch = sessionEpoch;
      clearSessionRetry();
      await load();
      assertSession(epoch);
      byId('password').value = '';
      setConnected(true);
    } catch (error) {
      if (error.stale) return;
      // Only the sign-in itself can reject the credentials: a 401 after it was accepted is a session that ended.
      const rejected = !accepted && ['invalid_credentials', 'unauthorized'].includes(error.code);
      byId('login-error').textContent = rejected ? errorText.invalid_credentials : accepted && error.status === 401 ? errorText.unauthorized : error.message;
    }
  });
  byId('logout').addEventListener('click', () => busy(async (live) => { await api('/auth/logout', { method: 'POST' }); live(); setConnected(false); }));
  byId('grant-search').addEventListener('input', renderGrants);
  byId('reconcile-policies').addEventListener('click', reconcilePolicies);
  byId('sync-library').addEventListener('click', syncCatalog);
  byId('library-filter').addEventListener('input', () => { state.catalogPage = 1; renderCatalog(); });
  byId('clear-library-search').addEventListener('click', clearLibrarySearch);
  byId('library-name-filter').addEventListener('change', () => { state.catalogPage = 1; renderCatalog(); scrollToTop(); });
  byId('library-sort').addEventListener('change', () => { state.catalogPage = 1; renderCatalog(); scrollToTop(); });
  byId('library-page-size').addEventListener('change', () => { state.catalogPageSize = Number(byId('library-page-size').value); state.catalogPage = 1; renderCatalog(); scrollToTop(); });
  byId('library-previous').addEventListener('click', () => { state.catalogPage -= 1; renderCatalog(); scrollToTop(); });
  byId('library-next').addEventListener('click', () => { state.catalogPage += 1; renderCatalog(); scrollToTop(); });
  byId('select-visible').addEventListener('change', selectVisible);
  byId('clear-selection').addEventListener('click', clearSelection);
  byId('bulk-access').addEventListener('click', openBulkAccess);
  byId('bulk-form').addEventListener('submit', previewBulkAccess);
  byId('new-user').addEventListener('click', () => openCreateUser());
  byId('new-group').addEventListener('click', () => openGroup(null));
  byId('group-form').addEventListener('submit', saveGroup);
  byId('user-form').addEventListener('submit', createUser);
  byId('access-form').addEventListener('submit', previewAccess);
  byId('request-action-form').addEventListener('submit', confirmRequestAction);
  byId('release-form').addEventListener('submit', confirmRelease);
  byId('refresh-requests').addEventListener('click', loadRequests);
  ['requests-search', 'requests-household', 'requests-status', 'requests-type'].forEach((id) => byId(id).addEventListener(id === 'requests-search' ? 'input' : 'change', renderRequests));
  document.querySelectorAll('.dialog-close').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
  const ROW_STATUS = { requested: 'Requested', ready: 'Ready', failed: 'Failed', declined: 'Declined', deleted: 'Deleted', cancelled: 'Cancelled' };
  const SEERR_STATUS = { pending: 'Pending', approved: 'Approved', declined: 'Declined', failed: 'Failed', completed: 'Completed', gone: 'Gone from Seerr', unknown: 'Seerr unreadable' };

  // The Requests tab is loaded when it is opened (and refreshed), never with the rest: it reads Seerr.
  async function loadRequests() {
    const epoch = sessionEpoch;
    byId('requests-summary').textContent = 'Loading…';
    try {
      const body = await api('/v1/app/requests');
      assertSession(epoch);
      state.appRequests = body.requests || [];
      state.heldTitles = body.held || [];
      state.requestsUnavailable = '';
    } catch (error) {
      if (error.stale) return;
      state.appRequests = [];
      state.heldTitles = [];
      state.requestsUnavailable = error.message;
      if (error.status === 401) return;
    }
    state.requestsLoaded = true;
    renderRequests();
  }

  function titleText(entry) {
    return (entry.title || (entry.mediaType === 'movie' ? 'Film' : 'Series') + ' · TMDB ' + entry.tmdbId) + (entry.year ? ' (' + entry.year + ')' : '');
  }

  function householdName(id) {
    const group = state.groups.find((entry) => entry.id === id);
    return group ? group.name : id;
  }

  function matchesStatus(row, status) {
    if (!status) return true;
    if (status === 'waiting') return row.seerrStatus === 'pending' || row.seerrStatus === 'approved';
    if (status === 'pending' || status === 'approved') return row.seerrStatus === status;
    if (status === 'failed') return row.status === 'failed' || row.status === 'declined';
    if (status === 'cancelled') return row.status === 'cancelled' || row.status === 'deleted';
    if (status === 'held') return row.held;
    return row.status === status;
  }

  function filteredRequests() {
    const query = byId('requests-search').value.trim().toLowerCase();
    const household = byId('requests-household').value;
    const status = byId('requests-status').value;
    const type = byId('requests-type').value;
    return state.appRequests.filter((row) => (!type || row.mediaType === type)
      && (!household || row.households.some((entry) => entry.id === household))
      && matchesStatus(row, status)
      && (!query || [titleText(row), row.requester.name].some((text) => text.toLowerCase().includes(query))));
  }

  function renderRequests() {
    byId('requests-count').textContent = state.requestsLoaded ? String(state.appRequests.length) : '';
    const select = byId('requests-household');
    const chosen = select.value;
    const households = new Map(state.groups.map((group) => [group.id, group.name]));
    state.appRequests.forEach((row) => row.households.forEach((entry) => { if (!households.has(entry.id)) households.set(entry.id, entry.name); }));
    select.replaceChildren(node('option', { value: '', text: 'All households' }), ...[...households].sort((left, right) => left[1].localeCompare(right[1]))
      .map(([id, name]) => node('option', { value: id, text: name })));
    select.value = households.has(chosen) ? chosen : '';
    const list = byId('household-requests-list');
    if (state.requestsUnavailable) {
      byId('requests-summary').textContent = '';
      list.replaceChildren(node('div', { class: 'empty' }, [node('strong', { text: 'Requests unavailable' }), node('span', { text: state.requestsUnavailable })]));
    } else {
      const rows = filteredRequests();
      byId('requests-summary').textContent = rows.length === state.appRequests.length
        ? state.appRequests.length + ' request' + (state.appRequests.length === 1 ? '' : 's')
        : rows.length + ' of ' + state.appRequests.length + ' requests shown';
      list.replaceChildren(...(rows.length ? rows.map(requestRow) : [node('div', { class: 'empty' }, [
        node('strong', { text: state.appRequests.length ? 'No requests match' : 'No household requests yet' }),
        node('span', { text: state.appRequests.length ? 'Change the filters to see more.' : 'Requests appear here when a household asks for a title in the app.' }),
      ])]));
    }
    const held = byId('held-list');
    held.replaceChildren(...(state.heldTitles.length ? state.heldTitles.map(heldRow) : [node('div', { class: 'empty' }, [
      node('strong', { text: 'Nothing held' }),
      node('span', { text: 'A cancelled title that arrives with nobody following it is listed here.' }),
    ])]));
  }

  function requestRow(row) {
    const title = titleText(row);
    const pills = [node('span', { class: 'pill status-' + row.status, text: ROW_STATUS[row.status] || row.status })];
    if (row.seerrStatus) pills.push(node('span', { class: 'pill seerr-' + row.seerrStatus, text: 'Seerr: ' + (SEERR_STATUS[row.seerrStatus] || row.seerrStatus) }));
    if (row.held) pills.push(node('span', { class: 'pill held', text: 'Held' }));
    else if (row.withdrawn) pills.push(node('span', { class: 'pill', text: 'Withdrawn' }));
    const actions = [];
    if (row.actions.approve) actions.push(actionButton('Approve', 'button primary', row, 'approve'));
    if (row.actions.decline) actions.push(actionButton('Decline', 'button quiet', row, 'decline'));
    if (row.actions.cancel) actions.push(actionButton('Cancel request', 'button danger', row, 'cancel'));
    const following = row.households.map((entry) => entry.name + (entry.status === 'requested' ? '' : ' (' + (ROW_STATUS[entry.status] || entry.status).toLowerCase() + ')'));
    return node('article', { class: 'request-row' }, [
      node('div', { class: 'grant-main' }, [
        node('div', { class: 'grant-title' }, [node('h3', { text: title, title }), node('span', { class: 'type', text: row.mediaType === 'movie' ? 'Film' : 'Series' })]),
        node('span', { class: 'meta', text: 'Requested ' + row.requestedOn + ' by ' + row.requester.name + ' · ' + row.householdName }),
        row.seasons.length ? node('span', { class: 'meta', text: 'Seasons ' + row.seasons.join(', ') }) : node('span'),
      ]),
      node('div', { class: 'grant-section' }, [node('strong', { text: 'Households' }), node('small', { text: following.join(', ') + (row.followers ? ' · ' + row.followers + ' following' : '') })]),
      node('div', { class: 'pill-row' }, pills),
      node('div', { class: 'card-actions' }, actions),
    ]);
  }

  function actionButton(label, className, row, action) {
    const button = node('button', { class: className, type: 'button', text: label });
    button.setAttribute('aria-label', label + ': ' + titleText(row));
    button.addEventListener('click', () => openRequestAction(row, action));
    return button;
  }

  function openRequestAction(row, action) {
    const title = titleText(row);
    const others = row.households.length;
    const copy = {
      approve: ['Approve request', 'Approve ' + title + ' in Seerr? It is sent to ' + (row.mediaType === 'movie' ? 'Radarr' : 'Sonarr') + ' to download.', ''],
      decline: ['Decline request', 'Decline ' + title + ' in Seerr? ' + (others === 1 ? 'The household that asked sees' : 'All ' + others + ' households following it see') + ' “We couldn’t get this”.', ''],
      cancel: ['Cancel request', 'Cancel ' + title + ' for every household? ' + (others === 1 ? 'The household that asked goes' : 'All ' + others + ' households go') + ' back to “Get this”, and the request is deleted in Seerr.',
        (row.mediaType === 'movie' && row.actions.removeFromRadarr ? 'Without removing it from Radarr, it may still download. It is then held for no household until you release it'
          : 'It may still download. It is then held for no household until you release it') + '. A request that follows the join rules (a title or series Jellyfin already had) is the exception: a public title stays public.'],
    }[action];
    state.pendingAction = { row, action };
    byId('request-action-title').textContent = copy[0];
    byId('request-action-text').textContent = copy[1];
    byId('request-action-warning').textContent = copy[2];
    byId('request-action-warning').hidden = !copy[2];
    byId('request-radarr').checked = false;
    byId('request-radarr-option').hidden = !(action === 'cancel' && row.mediaType === 'movie' && row.actions.removeFromRadarr);
    byId('request-action-confirm').textContent = copy[0];
    byId('request-action-confirm').className = 'button ' + (action === 'approve' ? 'primary' : 'danger');
    byId('request-action-dialog').showModal();
  }

  async function confirmRequestAction(event) {
    event.preventDefault();
    const pending = state.pendingAction;
    if (!pending) return;
    const body = pending.action === 'cancel' && !byId('request-radarr-option').hidden && byId('request-radarr').checked ? { removeFromRadarr: true } : undefined;
    await busy(async (live) => {
      const result = await api('/v1/app/requests/' + encodeURIComponent(pending.row.requestId) + '/' + pending.action, Object.assign({ method: 'POST' }, body ? { body: JSON.stringify(body) } : {}));
      live();
      state.pendingAction = null;
      byId('request-action-dialog').close();
      const done = { approve: 'Approved', decline: 'Declined', cancel: 'Cancelled' }[pending.action];
      toast(result.changed === false ? 'Already ' + done.toLowerCase() + '.' : done + (result.removedFromRadarr ? ' and removed from Radarr.' : '.'));
    });
    // Also after a failure: a cancel Seerr could not finish has still sent the households back to Get this.
    if (state.activeTab === 'requests') await loadRequests();
  }

  function heldRow(entry) {
    const title = titleText(entry);
    const release = node('button', { class: 'button primary', type: 'button', text: 'Release' });
    release.setAttribute('aria-label', 'Release ' + title);
    release.addEventListener('click', () => openRelease(entry));
    return node('article', { class: 'request-row' }, [
      node('div', { class: 'grant-main' }, [
        node('div', { class: 'grant-title' }, [node('h3', { text: title, title }), node('span', { class: 'type', text: entry.mediaType === 'movie' ? 'Film' : 'Series' })]),
        node('span', { class: 'meta', text: 'Cancelled ' + entry.cancelledAt.slice(0, 10) + (entry.grantedAt ? ' · arrived ' + entry.grantedAt.slice(0, 10) : '') }),
      ]),
      node('div', { class: 'grant-section' }, [node('strong', { text: 'Who can watch' }), node('small', { text: 'Nobody but Jellyfin administrators' })]),
      node('div', { class: 'pill-row' }, [node('span', { class: 'pill held', text: 'Held' })]),
      node('div', { class: 'card-actions' }, [release]),
    ]);
  }

  function openRelease(entry) {
    state.pendingRelease = entry;
    byId('release-title').textContent = 'Release ' + titleText(entry);
    byId('release-text').textContent = 'The households you choose can watch it. Everyone else still cannot.';
    byId('release-error').textContent = '';
    byId('release-options').replaceChildren(...state.groups.map((group) => checkOption('release-household', group.id, group.name, group.id, false)));
    byId('release-dialog').showModal();
  }

  async function confirmRelease(event) {
    event.preventDefault();
    const entry = state.pendingRelease;
    if (!entry) return;
    const householdIds = checkedValues('release-household');
    if (!householdIds.length) {
      byId('release-error').textContent = 'Choose at least one household.';
      return;
    }
    await busy(async (live) => {
      await api('/v1/app/held/' + encodeURIComponent(entry.requestId) + '/release', { method: 'POST', body: JSON.stringify({ householdIds }) });
      live();
      state.pendingRelease = null;
      byId('release-dialog').close();
      toast('Released to ' + householdIds.map(householdName).join(', ') + '.');
    });
    if (state.activeTab === 'requests') await loadRequests();
  }

  function activateTab(tab) {
    if (state.activeTab === 'library' && tab !== 'library') resetLibraryView();
    state.activeTab = tab;
    document.querySelectorAll('.tabs button').forEach((entry) => entry.classList.toggle('active', entry.dataset.tab === tab));
    const copy = heroCopy[tab];
    byId('hero-eyebrow').textContent = copy[0];
    byId('hero-title').textContent = copy[1];
    byId('hero-subtitle').textContent = copy[2];
    byId('dashboard-panel').hidden = tab !== 'dashboard';
    byId('grants-panel').hidden = tab !== 'grants';
    byId('library-panel').hidden = tab !== 'library';
    byId('groups-panel').hidden = tab !== 'groups';
    byId('requests-panel').hidden = tab !== 'requests';
    if (tab === 'requests') loadRequests();
    scrollToTop();
  }

  document.querySelectorAll('.tabs button').forEach((button) => button.addEventListener('click', () => activateTab(button.dataset.tab)));

  scrollToTop();
  const firstEpoch = sessionEpoch;
  api('/auth/session')
    .then(() => { assertSession(firstEpoch); return load(); })
    .then(() => { assertSession(firstEpoch); setConnected(true); })
    .catch((error) => {
      if (error.stale || firstEpoch !== sessionEpoch) return;
      // A session Jellyfin could not check is kept: the notice is shown and the check retried.
      if (error.status === 503 && error.code === 'session_check_unavailable') sessionUnavailable();
      else setConnected(false);
    });
})();
`;
