import { createServer } from 'node:http';

export async function createFakeJellyfin() {
  const users = [
    { Id: 'alice-id', Name: 'Alice', Policy: { BlockedTags: [] } },
    { Id: 'bob-id', Name: 'Bob', Policy: { BlockedTags: [] } },
    { Id: 'admin-id', Name: 'Admin', Policy: { IsAdministrator: true, BlockedTags: [] } },
  ];
  const state = { item: { Id: 'item-1', Name: 'Movie', Tags: ['existing'] } };
  const server = createServer(async (request, response) => {
    if (request.headers['x-emby-token'] !== 'test-key') return send(response, 401, {});
    if (request.method === 'GET' && request.url === '/Users') return send(response, 200, users);
    if (request.method === 'GET' && request.url === '/Users/admin-id/Items/item-1') return send(response, 200, state.item);
    if (request.method === 'POST' && request.url === '/Items/item-1') {
      state.item = await body(request);
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
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    get item() { return state.item; },
    user: (id) => users.find((user) => user.Id === id),
    close: () => {
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
