/**
 * The household "Add to my library" page, served on household hostnames at /jellypass/add. It runs on the same origin
 * as the proxied Jellyfin web client, so it reuses the access token Jellyfin web keeps in localStorage and never asks
 * for a password. All text it shows is fixed; nothing from a response is rendered as HTML.
 */
export const LIBRARY_JOIN_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Add to my library</title>
  <link rel="stylesheet" href="/jellypass/add.css">
</head>
<body>
  <main>
    <h1>Add to my library</h1>
    <p>Paste a Seerr or TMDB link to a movie or series. If it is in the library and can be shared, it appears in your
      Jellyfin library within a few minutes.</p>
    <p id="signed-out" class="notice" hidden>Sign in to <a href="/web/">Jellyfin on this address</a> first, then
      come back to this page.</p>
    <form id="add-form">
      <label for="link">Link or TMDB ID</label>
      <input id="link" name="link" autocomplete="off" required placeholder="https://www.themoviedb.org/movie/603">
      <fieldset>
        <legend>For a bare TMDB ID</legend>
        <label><input type="radio" name="mediaType" value="movie" checked> Movie</label>
        <label><input type="radio" name="mediaType" value="tv"> Series</label>
      </fieldset>
      <button type="submit">Add to my library</button>
    </form>
    <p id="status" role="status"></p>
    <p><a href="/web/">Back to Jellyfin</a></p>
  </main>
  <script src="/jellypass/add.js"></script>
</body>
</html>
`;

export const LIBRARY_JOIN_STYLES = `
body { margin: 0; background: #101010; color: #e6e6e6; font: 16px/1.5 system-ui, sans-serif; }
main { box-sizing: border-box; max-width: 36rem; margin: 0 auto; padding: 2rem 1rem; }
h1 { font-size: 1.6rem; font-weight: 600; }
a { color: #00a4dc; }
form { display: grid; gap: 0.75rem; }
input[name="link"] { box-sizing: border-box; width: 100%; padding: 0.6rem; border: 1px solid #444; border-radius: 0.4rem; background: #1c1c1c; color: inherit; font: inherit; }
fieldset { display: flex; gap: 1rem; border: 0; margin: 0; padding: 0; }
legend { float: left; margin-right: 0.5rem; color: #aaa; }
button { justify-self: start; padding: 0.6rem 1.2rem; border: 0; border-radius: 0.4rem; background: #00a4dc; color: #fff; font: inherit; cursor: pointer; }
button:disabled { opacity: 0.6; cursor: default; }
.notice { padding: 0.75rem; border-radius: 0.4rem; background: #3a2f12; }
#status { min-height: 1.5rem; }
`;

export const LIBRARY_JOIN_JS = `
(function () {
  'use strict';
  var form = document.getElementById('add-form');
  var link = document.getElementById('link');
  var status = document.getElementById('status');
  var signedOut = document.getElementById('signed-out');
  var button = form.querySelector('button');

  function credentials() {
    try {
      var stored = JSON.parse(localStorage.getItem('jellyfin_credentials') || '{}');
      var servers = (Array.isArray(stored.Servers) ? stored.Servers : []).filter(function (server) {
        return server && typeof server.AccessToken === 'string' && server.AccessToken && server.UserId;
      });
      var here = location.origin.toLowerCase();
      var matching = servers.filter(function (server) {
        return [server.ManualAddress, server.LocalAddress, server.RemoteAddress].some(function (address) {
          return typeof address === 'string' && address.replace(/\\/+$/, '').toLowerCase() === here;
        });
      });
      return (matching[0] || servers[0] || {}).AccessToken;
    } catch (error) {
      return undefined;
    }
  }

  function quote(value) {
    return encodeURIComponent(value).replace(/"/g, '%22');
  }

  function parse(value) {
    var text = value.trim();
    var match = /\\/(movie|tv)\\/(\\d{1,10})(?:[^\\d]|$)/i.exec(text);
    if (match) return { mediaType: match[1].toLowerCase(), tmdbId: Number(match[2]) };
    if (/^\\d{1,10}$/.test(text)) {
      return { mediaType: form.querySelector('input[name="mediaType"]:checked').value, tmdbId: Number(text) };
    }
    return undefined;
  }

  function show(message) {
    status.textContent = message;
  }

  if (!credentials()) signedOut.hidden = false;

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var token = credentials();
    if (!token) {
      signedOut.hidden = false;
      show('');
      return;
    }
    var media = parse(link.value);
    if (!media || media.tmdbId < 1) {
      show('That does not look like a Seerr or TMDB movie or series link.');
      return;
    }
    button.disabled = true;
    show('Adding…');
    fetch('/jellypass/add', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Only the token: client and device fields would make Jellyfin rename the web client's own session.
        Authorization: 'MediaBrowser Token="' + quote(token) + '"'
      },
      body: JSON.stringify(media)
    }).then(function (response) {
      if (response.status === 202) {
        show('Done. If this title is in the library and can be shared, it will appear in your library within a few minutes.');
        link.value = '';
      } else if (response.status === 401) {
        signedOut.hidden = false;
        show('Your Jellyfin sign-in has expired.');
      } else if (response.status === 429) {
        show('Too many attempts. Try again in a few minutes.');
      } else if (response.status === 400) {
        show('That does not look like a Seerr or TMDB movie or series link.');
      } else {
        show('Something went wrong. Try again later.');
      }
    }, function () {
      show('Something went wrong. Try again later.');
    }).then(function () {
      button.disabled = false;
    });
  });
})();
`;
