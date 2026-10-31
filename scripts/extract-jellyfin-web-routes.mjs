import fs from 'node:fs';
import path from 'node:path';
// Run against jellyfin-web copied from either pinned image; output is the raw getUrl audit.
const dir = process.argv[2];
const out = new Map();
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  // getUrl("A".concat(x,"/B")...) and getUrl("A/B")
  for (const m of src.matchAll(/getUrl\(((?:"[^"]*"|\.concat\([^()]*(?:\([^()]*\))?[^()]*\)|[^,()]){1,400}?)[,)]/g)) {
    let expr = m[1];
    const parts = [...expr.matchAll(/"([^"]*)"/g)].map((x) => x[1]);
    if (!parts.length || !/^\/?[A-Z]/.test(parts[0])) continue;
    // join literal parts with placeholder between them
    let tpl = parts.join('X');
    if (/\.concat\([^)]*\)$/.test(expr.trim()) && !expr.trim().endsWith('")')) tpl += 'X';
    tpl = '/' + tpl.replace(/^\//, '').replace(/\/+$/, '');
    tpl = tpl.replace(/X+/g, 'abc123').toLowerCase().replace(/\/+/g, '/');
    if (!out.has(tpl)) out.set(tpl, f);
  }
}
for (const [tpl, f] of [...out].sort()) console.log(JSON.stringify({ route: tpl, bundle: f }));
console.error('checked', out.size);
