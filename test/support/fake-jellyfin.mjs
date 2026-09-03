import { createServer } from 'node:http';

export async function createFakeJellyfin() {
  const users = [
    { Id: 'alice-id', Name: 'Alice', Policy: { BlockedTags: [] } },
    { Id: 'bob-id', Name: 'Bob', Policy: { BlockedTags: [] } },
    { Id: 'admin-id', Name: 'Admin', Policy: { IsAdministrator: true, BlockedTags: [] } },
  ];
  const passwords = new Map();
  const sessions = new Map();
  const state = {
    items: {
      'item-1': { Id: 'item-1', Name: 'Movie', Type: 'Movie', ProductionYear: 2025, Tags: ['existing'] },
      'item-2': { Id: 'item-2', Name: 'Second Movie', Type: 'Movie', ProductionYear: 2026, Tags: [] },
      'trailer-1': { Id: 'trailer-1', Name: 'Movie Trailer', Type: 'Trailer', Tags: [] },
    },
  };
  let logoutCount = 0;
  let sessionSequence = 0;
  const upgradeSockets = new Set();
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && request.url === '/Users/Public') {
      return send(response, 200, users.map((user) => ({ Id: user.Id, Name: user.Name, HasPassword: false })));
    }
    if (request.method === 'GET' && request.url === '/System/Info/Public') {
      return send(response, 200, { ServerName: 'Test Jellyfin', Version: '10.11.0', Id: 'test-server' });
    }
    if (request.method === 'GET' && request.url === '/Branding/Configuration') {
      return send(response, 200, { LoginDisclaimer: '', CustomCss: '.existing-branding { color: white; }' });
    }
    if (request.method === 'POST' && request.url === '/Users/AuthenticateByName') {
      const credentials = await body(request);
      const user = users.find((entry) => entry.Name === credentials.Username);
      const expectedPassword = user && (passwords.get(user.Id) ?? (user.Policy.IsAdministrator ? 'admin-password' : 'user-password'));
      if (!user || credentials.Pw !== expectedPassword) {
        return send(response, 401, {});
      }
      // Jellyfin's login payload does not reliably include the full user policy.
      const token = `temporary-login-token-${user.Id}-${++sessionSequence}`;
      sessions.set(token, user.Id);
      return send(response, 200, { User: { Id: user.Id, Name: user.Name }, AccessToken: token });
    }
    if (request.method === 'POST' && request.url === '/Sessions/Logout') {
      if (!sessions.delete(request.headers['x-emby-token'])) return send(response, 401, {});
      logoutCount += 1;
      return send(response, 204);
    }
    const suppliedToken = request.headers['x-emby-token']
      ?? requestUrl.searchParams.get('ApiKey')
      ?? requestUrl.searchParams.get('api_key')
      ?? requestUrl.searchParams.get('access_token');
    const sessionUserId = sessions.get(suppliedToken);
    if (suppliedToken !== 'test-key' && !sessionUserId) return send(response, 401, {});
    if (request.method === 'GET' && requestUrl.pathname === '/Users/Me') {
      const user = users.find((entry) => entry.Id === sessionUserId);
      return user ? send(response, 200, user) : send(response, 401, {});
    }
    if (request.method === 'POST' && request.url === '/Users/New') {
      const input = await body(request);
      if (users.some((user) => user.Name.toLowerCase() === input.Name.toLowerCase())) return send(response, 400, { error: 'duplicate' });
      const id = input.Name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-id';
      const user = { Id: id, Name: input.Name, Policy: { BlockedTags: [] } };
      users.push(user);
      passwords.set(id, input.Password);
      return send(response, 200, user);
    }
    if (request.method === 'GET' && request.url === '/Users') return send(response, 200, users);
    if (request.method === 'GET' && request.url === '/Library/MediaFolders') {
      return send(response, 200, { Items: [{ Id: 'library-1', Name: 'Movies', CollectionType: 'movies' }], TotalRecordCount: 1 });
    }
    if (request.method === 'GET' && request.url?.startsWith('/Items?')) {
      const parameters = new URL(request.url, 'http://localhost').searchParams;
      const query = parameters.get('SearchTerm')?.toLowerCase() ?? '';
      const items = Object.values(state.items).filter((item) => item.Type !== 'Trailer' && item.Name.toLowerCase().includes(query));
      return send(response, 200, { Items: items, TotalRecordCount: items.length });
    }
    if (request.method === 'GET' && request.url?.startsWith('/Items/item-1/Images/Primary?')) {
      const poster = Buffer.from([255, 216, 255, 217]);
      response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': poster.length });
      response.end(poster);
      return;
    }
    const localTrailers = request.url?.match(/^\/Items\/([^/]+)\/LocalTrailers\?userId=([^&]+)$/);
    if (request.method === 'GET' && localTrailers) {
      return send(response, 200, localTrailers[1] === 'item-1' ? [state.items['trailer-1']] : []);
    }
    const userRecord = request.url?.match(/^\/Users\/([^/]+)$/);
    if (request.method === 'GET' && userRecord) {
      const user = users.find((entry) => entry.Id === userRecord[1]);
      return user ? send(response, 200, user) : send(response, 404, {});
    }
    const userItem = requestUrl.pathname.match(/^\/Users\/([^/]+)\/Items\/([^/]+)$/);
    if (request.method === 'GET' && userItem) {
      const user = users.find((entry) => entry.Id === userItem[1]);
      const item = state.items[userItem[2]];
      const blocked = item?.Tags?.some((tag) => user?.Policy.BlockedTags?.some((blockedTag) => blockedTag.toLowerCase() === tag.toLowerCase()));
      return item && user && !blocked ? send(response, 200, item) : send(response, 404, {});
    }
    if (request.method === 'GET' && request.url?.startsWith('/Videos/trailer-1/stream')) {
      response.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Length': 1, 'Content-Range': 'bytes 0-0/1' });
      response.end(Buffer.from([0]));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/Videos/trailer-1/master.m3u8') {
      const playlist = '#EXTM3U\n';
      response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': playlist.length });
      response.end(playlist);
      return;
    }
    const itemUpdate = request.url?.match(/^\/Items\/([^/]+)$/);
    if (request.method === 'POST' && itemUpdate && state.items[itemUpdate[1]]) {
      state.items[itemUpdate[1]] = await body(request);
      return send(response, 204);
    }
    const policy = request.url?.match(/^\/Users\/([^/]+)\/Policy$/);
    if (request.method === 'POST' && policy) {
      const user = users.find((entry) => entry.Id === policy[1]);
      user.Policy = await body(request);
      return send(response, 204);
    }
    return send(response, 404, {});
  });
  server.on('upgrade', (request, socket) => {
    if (request.url !== '/socket') return socket.destroy();
    upgradeSockets.add(socket);
    socket.once('close', () => upgradeSockets.delete(socket));
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    get item() { return state.items['item-1']; },
    itemById: (id) => state.items[id],
    get logoutCount() { return logoutCount; },
    user: (id) => users.find((user) => user.Id === id),
    close: () => {
      upgradeSockets.forEach((socket) => socket.destroy());
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function send(response, status, value) {
  if (status === 204) {
    response.writeHead(status);
    response.end();
    return;
  }
  const encoded = JSON.stringify(value);
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) });
  response.end(encoded);
}
