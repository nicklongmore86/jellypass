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

      <nav class="tabs" aria-label="Admin sections"><button class="active" data-tab="dashboard">Dashboard</button><button data-tab="library">Library <span id="library-count"></span></button><button data-tab="grants">Grants <span id="grant-count"></span></button><button data-tab="groups">Groups <span id="group-count"></span></button></nav>
      <section id="dashboard-panel" class="tab-panel">
        <div class="section-tools"><div><h2>Access overview</h2><p>A compact view of JellyPass activity and policy health.</p></div></div>
        <div class="stats" aria-label="Access summary">
          <article><span>Active grants</span><strong id="stat-grants">—</strong><small>protected titles</small></article>
          <article><span>Request owners</span><strong id="stat-owners">—</strong><small>unique Jellyfin users</small></article>
          <article><span>Access groups</span><strong id="stat-groups">—</strong><small>shared audiences</small></article>
        </div>
        <div class="recent-head"><div><div class="eyebrow">Jellyseerr activity</div><h2>Recent requests</h2></div><p>The latest requests successfully linked to your Jellyfin library.</p></div>
        <div id="recent-requests" class="recent-grid"></div>
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
  <dialog id="group-dialog"><form id="group-form"><div class="dialog-head"><div><div class="eyebrow">Shared access</div><h2 id="group-title">New group</h2></div><button type="button" class="dialog-close icon button" aria-label="Close">×</button></div><label>Group ID<input id="group-id" required pattern="[a-zA-Z0-9_-]{1,128}" placeholder="household"></label><label>Display name<input id="group-name" required placeholder="Household"></label><fieldset><legend>Jellyfin users</legend><div id="user-options" class="check-list"></div></fieldset><div class="dialog-actions"><button type="button" class="dialog-close button quiet">Cancel</button><button class="button primary" type="submit">Save group</button></div></form></dialog>
  <dialog id="user-dialog"><form id="user-form"><div class="dialog-head"><div><div class="eyebrow">Household member</div><h2>Create Jellyfin user</h2></div><button type="button" class="dialog-close icon button" aria-label="Close">×</button></div><label>Username<input id="new-username" name="new-username" maxlength="128" autocomplete="off" required></label><label>Password · optional<input id="new-password" name="new-password" type="password" maxlength="256" autocomplete="new-password"></label><label>Confirm password<input id="confirm-password" name="confirm-password" type="password" maxlength="256" autocomplete="new-password"></label><p class="hint">Leave both password fields blank to create a passwordless Jellyfin account. Until household SSO is implemented, anyone who can reach Jellyfin and knows the username can sign in to that account.</p><label>Household or access group<select id="new-user-group" required></select></label><label class="check"><input id="import-to-jellyseerr" type="checkbox"><span><strong>Import into Jellyseerr</strong><small id="jellyseerr-import-help">Link this Jellyfin identity so the user can own requests.</small></span></label><p class="hint">This creates a real non-administrator Jellyfin account and adds it to the selected group. Jellyseerr applies its configured default permissions to imported users.</p><div class="dialog-actions"><button type="button" class="dialog-close button quiet">Cancel</button><button class="button primary" type="submit">Create user</button></div></form></dialog>
  <dialog id="access-dialog"><form id="access-form"><div class="dialog-head"><div><div class="eyebrow">Grant access</div><h2>Shared groups</h2></div><button type="button" class="dialog-close icon button" aria-label="Close">×</button></div><p id="access-item" class="mono"></p><fieldset><legend>Groups with access</legend><div id="group-options" class="check-list"></div></fieldset><input id="access-item-id" type="hidden"><div class="dialog-actions"><button type="button" class="dialog-close button quiet">Cancel</button><button class="button primary" type="submit">Preview changes</button></div></form></dialog>
  <dialog id="requests-dialog"><div class="dialog-head"><div><div class="eyebrow">Direct access</div><h2>Jellyseerr requests</h2></div><button class="dialog-close icon button" aria-label="Close">×</button></div><p id="requests-item" class="mono"></p><div id="requests-list" class="request-list"></div></dialog>
  <dialog id="bulk-dialog"><form id="bulk-form"><div class="dialog-head"><div><div class="eyebrow">Bulk access</div><h2>Assign selected media</h2></div><button type="button" class="dialog-close icon button" aria-label="Close">×</button></div><p id="bulk-summary" class="hint"></p><fieldset><legend>Individual Jellyfin users</legend><div id="bulk-user-options" class="check-list"></div></fieldset><fieldset><legend>Access groups</legend><div id="bulk-group-options" class="check-list"></div></fieldset><p class="hint">This replaces existing manual users and groups for every selected title. Jellyseerr request owners are preserved.</p><div class="dialog-actions"><button type="button" class="dialog-close button quiet">Cancel</button><button class="button primary" type="submit">Preview bulk changes</button></div></form></dialog>
  <div id="toast" class="toast" role="status" aria-live="polite"></div>
  <script src="/admin/app.js" defer></script>
</body>
</html>`;

export const ADMIN_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><defs><linearGradient id="g" x1="5" y1="7" x2="43" y2="41" gradientUnits="userSpaceOnUse"><stop stop-color="#AA5CC3"/><stop offset="1" stop-color="#00A4DC"/></linearGradient></defs><rect width="48" height="48" rx="12" fill="#000B25"/><path fill="url(#g)" d="M9 7h30a5 5 0 0 1 5 5v6.4a6.2 6.2 0 0 0 0 11.2V36a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5v-6.4a6.2 6.2 0 0 0 0-11.2V12a5 5 0 0 1 5-5Z"/><circle cx="15" cy="19" r="3.7" fill="#000B25" fill-opacity=".84"/><path d="M10.5 31.5c1.2-3.8 7.8-3.8 9 0M27 17h10M27 24h10M27 31h7" stroke="#000B25" stroke-opacity=".84" stroke-width="2.5" stroke-linecap="round"/></svg>`;

export const ADMIN_STYLES = `
:root{--bg:#000b25;--panel:#09152d;--panel-2:#101d38;--line:#283858;--text:#f8f9ff;--muted:#9ba9c6;--cyan:#00a4dc;--blue:#aa5cc3;--amber:#f6b94d;--red:#ff6d76;--green:#45d69a;--jelly-purple:#aa5cc3;--jelly-blue:#00a4dc;--shadow:0 24px 80px rgba(0,0,0,.42)}
[hidden]{display:none!important}
*{box-sizing:border-box}html{min-height:100%;background:var(--bg)}body{margin:0;min-height:100vh;color:var(--text);font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:radial-gradient(circle at 16% 8%,#10283a 0,transparent 30%),linear-gradient(145deg,#080d15 0%,#0a111b 100%);overflow-x:hidden}button,input{font:inherit}.ambient{position:fixed;border-radius:50%;filter:blur(90px);opacity:.13;pointer-events:none}.ambient-one{width:420px;height:420px;background:var(--cyan);right:-160px;top:10%}.ambient-two{width:360px;height:360px;background:var(--blue);left:-180px;bottom:0}.shell{position:relative;width:min(1180px,calc(100% - 40px));margin:auto;padding:0 0 64px}.topbar{height:92px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(145,161,180,.18)}.brand{display:flex;align-items:center;gap:13px;color:inherit;text-decoration:none}.brand strong,.brand small{display:block}.brand strong{font-size:15px;letter-spacing:.02em}.brand small{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.12em;margin-top:1px}.brand-mark{position:relative;width:36px;height:36px;border:1px solid rgba(37,211,200,.55);border-radius:10px;transform:rotate(45deg);display:grid;place-items:center;box-shadow:inset 0 0 18px rgba(37,211,200,.15)}.brand-mark span{width:12px;height:12px;border-radius:4px;background:linear-gradient(135deg,var(--cyan),var(--blue))}.connection{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.09em}.connection span{width:7px;height:7px;background:#5b6878;border-radius:50%;box-shadow:0 0 0 4px rgba(91,104,120,.1)}.connection.online span{background:var(--green);box-shadow:0 0 0 4px rgba(69,214,154,.1)}.connection.online b{color:#bdebd8}.panel{background:linear-gradient(145deg,rgba(19,30,44,.96),rgba(13,21,32,.96));border:1px solid var(--line);border-radius:20px;box-shadow:var(--shadow)}.login-wrap{min-height:calc(100vh - 150px);display:grid;grid-template-columns:minmax(0,650px) 260px;gap:80px;align-items:center;justify-content:center}.login-card{padding:54px}.eyebrow{color:var(--cyan);font-size:11px;font-weight:750;text-transform:uppercase;letter-spacing:.18em;margin-bottom:10px}.login-card h1,.hero-row h1{font-size:clamp(40px,6vw,68px);line-height:1.02;letter-spacing:-.045em;margin:0}.login-card h1 em{font-style:normal;color:transparent;-webkit-text-stroke:1px #7f91a5}.login-card>p{color:var(--muted);font-size:17px;max-width:540px;margin:24px 0 34px}.login-card label,.dialog-head+label,form>label{display:grid;gap:8px;color:#c6d1dd;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em}.token-row{display:flex;gap:10px;margin-top:8px}input{width:100%;color:var(--text);background:#080e17;border:1px solid var(--line);border-radius:10px;padding:12px 14px;outline:none;transition:.2s border,.2s box-shadow}input:focus{border-color:var(--cyan);box-shadow:0 0 0 3px rgba(37,211,200,.1)}.hint,.form-error{font-size:12px!important;margin:10px 0 0!important}.form-error{color:var(--red)!important;min-height:18px}.button{border:1px solid var(--line);border-radius:10px;padding:10px 15px;background:#111b28;color:var(--text);cursor:pointer;font-weight:700;white-space:nowrap;transition:.18s transform,.18s background,.18s border}.button:hover{transform:translateY(-1px);border-color:#49617e}.button:disabled{opacity:.45;cursor:wait;transform:none}.button.primary{border-color:transparent;color:#041413;background:linear-gradient(135deg,var(--cyan),#5fe4b0)}.button.quiet{background:rgba(17,27,40,.65)}.button.danger{color:#ffc7cb;border-color:rgba(255,109,118,.35);background:rgba(255,109,118,.08)}.button.icon{width:41px;height:41px;padding:0;display:grid;place-items:center}.login-note{display:flex;gap:18px;align-items:flex-start;color:var(--muted)}.login-note span{font:700 12px/1 ui-monospace,monospace;color:var(--cyan);padding-top:5px}.login-note p{margin:0;border-left:1px solid var(--line);padding-left:18px}.hero-row{display:flex;justify-content:space-between;align-items:flex-end;padding:62px 0 38px}.hero-row h1{font-size:48px}.subtitle,.section-tools p{color:var(--muted);margin:8px 0 0}.actions{display:flex;gap:9px;flex-wrap:wrap;justify-content:flex-end}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:44px}.stats article{position:relative;overflow:hidden;padding:22px 24px;background:linear-gradient(145deg,rgba(19,30,44,.9),rgba(13,21,32,.8));border:1px solid var(--line);border-radius:14px}.stats article:after{content:"";position:absolute;width:60px;height:2px;left:24px;bottom:0;background:var(--cyan)}.stats span,.stats small{display:block;color:var(--muted)}.stats span{font-size:11px;text-transform:uppercase;letter-spacing:.12em}.stats strong{display:block;font-size:34px;line-height:1;margin:15px 0 10px}.stats small{font-size:12px}.stats article.error:after{background:var(--red)}.stats article.error strong{color:var(--red)}.tabs{display:flex;gap:28px;border-bottom:1px solid var(--line)}.tabs button{position:relative;border:0;background:transparent;color:var(--muted);padding:0 1px 15px;font-weight:750;cursor:pointer}.tabs button.active{color:var(--text)}.tabs button.active:after{content:"";position:absolute;height:2px;left:0;right:0;bottom:-1px;background:var(--cyan)}.tabs span{font-size:11px;color:var(--muted);margin-left:5px}.section-tools{display:flex;align-items:flex-end;justify-content:space-between;padding:32px 0 20px;gap:20px}.section-tools h2{margin:0;font-size:22px}.section-tools p{font-size:13px}.search{position:relative}.search span{position:absolute;left:13px;top:10px;color:var(--muted)}.search input{width:285px;padding-left:36px}.grant-list{display:grid;gap:10px}.grant-card{background:rgba(14,23,34,.86);border:1px solid var(--line);border-radius:13px;padding:12px 14px;display:grid;grid-template-columns:56px minmax(220px,1.3fr) minmax(180px,.8fr) minmax(170px,.8fr) auto;gap:18px;align-items:center}.grant-card:hover{border-color:#354a63}.grant-poster{width:56px;aspect-ratio:2/3;overflow:hidden;border-radius:8px;background:linear-gradient(145deg,rgba(170,92,195,.48),rgba(0,164,220,.35));box-shadow:0 8px 22px rgba(0,0,0,.25)}.grant-poster img{width:100%;height:100%;object-fit:cover;display:block}.grant-poster-fallback{width:100%;height:100%;display:grid;place-items:center;color:rgba(255,255,255,.78);font-size:18px;font-weight:800}.grant-main{min-width:0}.grant-title{display:flex;align-items:center;gap:9px}.grant-title h3{font-size:15px;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0}.type{font-size:10px;padding:3px 7px;border:1px solid #38526e;border-radius:99px;color:#a9bfd6;text-transform:uppercase}.meta,.grant-section small{color:var(--muted);font-size:11px}.grant-section strong{display:block;font-size:13px;margin-bottom:4px}.pill-row{display:flex;gap:5px;flex-wrap:wrap}.pill{font-size:10px;border-radius:99px;background:#1a2b3e;color:#bad0e3;padding:3px 7px}.pill.sync-synced{color:#a9f0d0;background:rgba(69,214,154,.1)}.pill.sync-error{color:#ffc0c5;background:rgba(255,109,118,.1)}.pill.sync-pending{color:#ffe0a7;background:rgba(246,185,77,.1)}.card-actions{display:flex;gap:7px;justify-content:flex-end}.card-actions .button{font-size:12px;padding:8px 10px}.empty{border:1px dashed var(--line);border-radius:13px;padding:52px;text-align:center;color:var(--muted)}.empty strong{display:block;color:var(--text);font-size:18px;margin-bottom:6px}.group-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.group-card{background:rgba(14,23,34,.86);border:1px solid var(--line);border-radius:14px;padding:22px}.group-card h3{font-size:17px;margin:0 0 4px}.group-card .mono{color:var(--cyan)}.group-card>p{color:var(--muted);min-height:45px}.group-card footer{display:flex;justify-content:space-between;align-items:center;margin-top:22px}.group-card footer span{color:var(--muted);font-size:12px}.mono{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;overflow-wrap:anywhere}dialog{width:min(680px,calc(100% - 30px));max-height:85vh;overflow:auto;color:var(--text);background:#101924;border:1px solid #31445b;border-radius:18px;padding:26px;box-shadow:var(--shadow)}dialog::backdrop{background:rgba(1,5,10,.78);backdrop-filter:blur(5px)}.dialog-head{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:24px}.dialog-head h2{margin:0;font-size:25px}.dialog-close{font-size:20px}.dialog-actions{display:flex;justify-content:flex-end;gap:9px;margin-top:26px}dialog form{display:grid;gap:18px}fieldset{margin:0;padding:0;border:0}legend{font-size:12px;color:#c6d1dd;font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px}.check-list{display:grid;grid-template-columns:repeat(2,1fr);gap:7px;max-height:260px;overflow:auto}.check{display:flex;gap:9px;align-items:center;background:#0a111b;border:1px solid var(--line);border-radius:9px;padding:10px 11px;cursor:pointer}.check input{width:auto;accent-color:var(--cyan)}.check span{min-width:0}.check strong,.check small{display:block;overflow:hidden;text-overflow:ellipsis}.check strong{font-size:13px}.check small{font:10px ui-monospace,monospace;color:var(--muted)}.plan-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-bottom:20px}.plan-summary article{background:#0a111b;border:1px solid var(--line);padding:13px;border-radius:10px}.plan-summary span,.plan-summary strong{display:block}.plan-summary span{font-size:10px;color:var(--muted);text-transform:uppercase}.plan-summary strong{margin-top:5px}.plan-item{border-top:1px solid var(--line);padding:15px 0}.plan-item strong,.plan-item span{display:block}.plan-item span{color:var(--muted);font-size:12px}.plan-item .change{color:var(--cyan)}.toast{position:fixed;right:22px;bottom:22px;max-width:380px;padding:13px 17px;border-radius:10px;background:#172434;border:1px solid #38506a;box-shadow:var(--shadow);opacity:0;transform:translateY(12px);pointer-events:none;transition:.2s}.toast.show{opacity:1;transform:none}.toast.error{border-color:rgba(255,109,118,.6);color:#ffc7cb}
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
`;

export const ADMIN_APP_JS = `
(() => {
  'use strict';
  const state = { grants: [], groups: [], users: [], jellyseerrImportAvailable: false, catalog: [], catalogSyncedAt: null, recentRequests: [], recentRequestsUnavailable: false, selectedItems: new Set(), catalogPage: 1, catalogPageSize: 25, activeTab: 'dashboard' };
  const byId = (id) => document.getElementById(id);
  const loginView = byId('login-view');
  const appView = byId('app-view');
  const toastNode = byId('toast');
  const heroCopy = {
    dashboard: ['Jellyfin access', 'JellyPass dashboard', 'Monitor library access, audiences, and synchronization health.'],
    library: ['Jellyfin library', 'Your media library', 'Browse synchronized movies and series, then assign access in bulk.'],
    grants: ['Access policies', 'Access grants', 'Review protected titles, request owners, and applied Jellyfin policies.'],
    groups: ['Shared audiences', 'Access groups', 'Organize Jellyfin users into reusable library-access audiences.'],
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
    const response = await fetch(path, Object.assign({}, config, { headers }));
    const text = await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
    if (!response.ok) {
      const error = new Error(body.error || ('Request failed (' + response.status + ')'));
      error.code = body.code;
      error.body = body;
      throw error;
    }
    return body;
  }

  async function load() {
    const results = await Promise.all([api('/v1/grants'), api('/v1/groups'), api('/v1/users'), api('/v1/library'), api('/v1/requests/recent').catch(() => ({ requests: [], unavailable: true }))]);
    state.grants = results[0].grants;
    state.groups = results[1].groups;
    state.users = results[2].users;
    state.jellyseerrImportAvailable = results[2].jellyseerrImportAvailable === true;
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
  }

  function renderRecentRequests() {
    const container = byId('recent-requests');
    if (!state.recentRequests.length) {
      container.replaceChildren(node('div', { class: 'empty' }, [
        node('strong', { text: state.recentRequestsUnavailable ? 'Jellyseerr activity unavailable' : 'No linked requests yet' }),
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
    return user ? user.name : id;
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
      list.append(node('div', { class: 'empty' }, [node('strong', { text: query ? 'No matching grants' : 'No protected titles yet' }), node('span', { text: query ? 'Try a different search.' : 'New Jellyseerr requests will appear here after their media becomes available.' })]));
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
      const accessSection = node('div', { class: 'grant-section grant-access' }, [node('strong', { text: groupNames.length ? groupNames.join(', ') : 'Direct requests only' }), node('div', { class: 'pill-row' }, [node('span', { class: 'pill sync-' + grant.sync.state, text: grant.sync.state }), node('span', { class: 'meta', text: groupNames.length + ' shared group' + (groupNames.length === 1 ? '' : 's') })])]);
      const planButton = node('button', { class: 'button quiet', text: 'Plan' });
      planButton.addEventListener('click', () => showGrantPlan(grant));
      const accessButton = node('button', { class: 'button quiet', text: 'Access' });
      accessButton.addEventListener('click', () => openAccess(grant));
      const requestsButton = node('button', { class: 'button quiet', text: 'Requests' });
      requestsButton.addEventListener('click', () => openRequests(grant));
      const actions = node('div', { class: 'card-actions' }, [planButton, requestsButton, accessButton]);
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
    const itemChanges = list.filter((plan) => plan.item.action !== 'none').length;
    content.append(node('div', { class: 'plan-summary' }, [summary('Titles checked', list.length), summary('Item changes', itemChanges), summary('User policy changes', changes.length)]));
    if (!itemChanges && !changes.length) content.append(node('div', { class: 'empty' }, [node('strong', { text: 'Everything is already in sync' }), node('span', { text: 'No Jellyfin tags or user policies need to change.' })]));
    list.forEach((plan) => {
      const affected = plan.users.filter((entry) => entry.action !== 'none');
      if (plan.item.action === 'none' && !affected.length && list.length > 1) return;
      content.append(node('div', { class: 'plan-item' }, [node('strong', { text: plan.itemName || plan.itemId }), node('span', { text: plan.itemId }), node('span', { class: 'change', text: 'Item: ' + plan.item.action + ' · Policies: ' + (affected.map((entry) => entry.action + ' ' + entry.userName).join(', ') || 'none') })]));
    });
    byId('plan-dialog').showModal();
  }

  function summary(label, value) { return node('article', {}, [node('span', { text: label }), node('strong', { text: String(value) })]); }

  async function showGrantPlan(grant) {
    await busy(async () => {
      const result = await api('/v1/grants/' + encodeURIComponent(grant.itemId) + '/plan');
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
    const importOption = byId('import-to-jellyseerr');
    importOption.disabled = !state.jellyseerrImportAvailable;
    importOption.checked = false;
    byId('jellyseerr-import-help').textContent = state.jellyseerrImportAvailable
      ? 'Link this Jellyfin identity so the user can own requests.'
      : 'Jellyseerr is not configured in JellyPass.';
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
    await busy(async () => {
      const result = await api('/v1/library/sync', { method: 'POST' });
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
    await busy(async () => {
      const preview = await api('/v1/library/access?dryRun=true', { method: 'PUT', body: JSON.stringify(body) });
      byId('bulk-dialog').close();
      showPlan('Bulk library access plan', preview.result.plans);
      if (confirm('Apply this audience to ' + body.itemIds.length + ' selected title' + (body.itemIds.length === 1 ? '' : 's') + '?')) {
        await api('/v1/library/access', { method: 'PUT', body: JSON.stringify(body) });
        byId('plan-dialog').close();
        state.selectedItems.clear();
        await load();
        toast('Bulk library access updated');
      }
    });
  }

  async function revokeRequest(grant, requestId, userId) {
    await busy(async () => {
      const path = '/v1/grants/' + encodeURIComponent(grant.itemId) + '/requests/' + encodeURIComponent(requestId);
      const preview = await api(path + '?dryRun=true', { method: 'DELETE' });
      byId('requests-dialog').close();
      showPlan('Revocation plan', preview.result.plan);
      if (confirm('Revoke request ' + requestId + ' for ' + userName(userId) + '?')) {
        await api(path, { method: 'DELETE' });
        byId('plan-dialog').close();
        await load();
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
    await busy(async () => {
      await api('/v1/groups/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify(body) });
      byId('group-dialog').close();
      await load();
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
    const importToJellyseerr = byId('import-to-jellyseerr').checked && !byId('import-to-jellyseerr').disabled;
    await busy(async () => {
      try {
        const result = await api('/v1/users', { method: 'POST', body: JSON.stringify({ username, password, groupId, importToJellyseerr }) });
        byId('user-dialog').close();
        await load();
        const imported = result.jellyseerr.status === 'imported' ? ' and imported into Jellyseerr' : result.jellyseerr.status === 'already_imported' ? '; Jellyseerr was already linked' : '';
        toast(result.user.name + ' was created and added to ' + result.group.name + imported);
      } catch (error) {
        if (error.code === 'user_created_jellyseerr_import_failed' || error.code === 'user_created_household_assignment_failed') {
          byId('user-dialog').close();
          await load();
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
    await busy(async () => {
      await api('/v1/groups/' + encodeURIComponent(group.id), { method: 'DELETE' });
      await load();
      toast('Group deleted');
    });
  }

  async function previewAccess(event) {
    event.preventDefault();
    const itemId = byId('access-item-id').value;
    const groupIds = checkedValues('grant-group');
    await busy(async () => {
      const preview = await api('/v1/grants/' + encodeURIComponent(itemId) + '/groups?dryRun=true', { method: 'PUT', body: JSON.stringify({ groupIds }) });
      byId('access-dialog').close();
      showPlan('Shared access plan', preview.result.plan);
      if (confirm('Apply this shared-access change now?')) {
        await api('/v1/grants/' + encodeURIComponent(itemId) + '/groups', { method: 'PUT', body: JSON.stringify({ groupIds }) });
        byId('plan-dialog').close();
        await load();
        toast('Shared access updated');
      }
    });
  }

  function checkedValues(name) { return Array.from(document.querySelectorAll('input[name="' + name + '"]:checked')).map((input) => input.value); }

  async function reconcilePolicies() {
    await busy(async () => {
      const preview = await api('/v1/reconcile?dryRun=true', { method: 'POST' });
      showPlan('Reconciliation plan', preview.plans);
      const changes = preview.plans.reduce((total, plan) => total + (plan.item.action !== 'none' ? 1 : 0) + plan.users.filter((user) => user.action !== 'none').length, 0);
      if (!changes) return;
      if (confirm('Apply ' + changes + ' previewed reconciliation change' + (changes === 1 ? '' : 's') + '?')) {
        await api('/v1/reconcile', { method: 'POST' });
        byId('plan-dialog').close();
        await load();
        toast('Policies reconciled');
      }
    });
  }

  async function busy(operation) {
    const enabledButtons = Array.from(document.querySelectorAll('button:not(:disabled)'));
    enabledButtons.forEach((button) => { button.disabled = true; });
    try { await operation(); } catch (error) { toast(error.message || String(error), true); }
    finally { enabledButtons.forEach((button) => { button.disabled = false; }); }
  }

  let toastTimer;
  function toast(message, isError) {
    clearTimeout(toastTimer);
    toastNode.textContent = message;
    toastNode.className = 'toast show' + (isError ? ' error' : '');
    toastTimer = setTimeout(() => { toastNode.className = 'toast'; }, 4200);
  }

  function setConnected(connected) {
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
    if (attention) setHealth('warning', attention + ' polic' + (attention === 1 ? 'y' : 'ies') + ' need attention');
    else if (syncOverdue) setHealth('warning', syncedAt ? 'Library sync overdue' : 'Library sync required');
    else setHealth('healthy', 'Sync healthy');
  }

  byId('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    byId('login-error').textContent = '';
    try {
      await api('/auth/login', { method: 'POST', body: JSON.stringify({ username: byId('username').value.trim(), password: byId('password').value }) });
      await load();
      byId('password').value = '';
      setConnected(true);
    } catch (error) {
      byId('login-error').textContent = ['invalid_credentials', 'unauthorized'].includes(error.message) ? 'That username or password was not accepted.' : error.message === 'too_many_login_attempts' ? 'Too many attempts. Try again in five minutes.' : error.message;
    }
  });
  byId('logout').addEventListener('click', () => busy(async () => { await api('/auth/logout', { method: 'POST' }); setConnected(false); }));
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
  document.querySelectorAll('.dialog-close').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
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
    scrollToTop();
  }

  document.querySelectorAll('.tabs button').forEach((button) => button.addEventListener('click', () => activateTab(button.dataset.tab)));

  scrollToTop();
  api('/auth/session').then(load).then(() => setConnected(true)).catch(() => setConnected(false));
})();
`;
