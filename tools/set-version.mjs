// キャッシュよけ: 読むファイル全部に、同じ版の番号(?v=番号)をつける道具。
// 使い方: node tools/set-version.mjs 0.6.2
// - index.html の <script src="..."> と <link href="....css"> (外のサイトのものは変えない)
// - js の中の import ... from "./xxx.js" と import("./xxx.js")
// 上げるたびに、新しい版の番号で動かす。
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ver = process.argv[2];
if (!ver || !/^[0-9A-Za-z._-]+$/.test(ver)) {
  console.error('使い方: node tools/set-version.mjs 0.6.2');
  process.exit(1);
}

const root = process.cwd();
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || name === 'node_modules' || name === 'tools') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (['.html', '.js', '.mjs'].includes(extname(p))) files.push(p);
  }
})(root);

// 同じサイトの中のファイル(http で始まらない .js / .css)だけ
const local = (u) => !/^[a-z]+:\/\//i.test(u) && !u.startsWith('//');
let count = 0;
const tag = (url) => {
  const base = url.replace(/\?v=[^"'#]*/, '');
  count++;
  return `${base}?v=${ver}`;
};

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  let out = src;
  if (f.endsWith('.html')) {
    out = out.replace(/(<script\b[^>]*\bsrc=")([^"]+\.js)(\?v=[^"]*)?(")/g,
      (m, a, u, v, b) => (local(u) ? a + tag(u) + b : m));
    out = out.replace(/(<link\b[^>]*\bhref=")([^"]+\.css)(\?v=[^"]*)?(")/g,
      (m, a, u, v, b) => (local(u) ? a + tag(u) + b : m));
  } else {
    // import ... from "./xxx.js" / export ... from "./xxx.js"
    out = out.replace(/(\bfrom\s*)(["'])(\.{1,2}\/[^"']+?\.js)(\?v=[^"']*)?\2/g,
      (m, a, q, u) => a + q + tag(u) + q);
    // import("./xxx.js")
    out = out.replace(/(\bimport\(\s*)(["'])(\.{1,2}\/[^"']+?\.js)(\?v=[^"']*)?\2/g,
      (m, a, q, u) => a + q + tag(u) + q);
  }
  if (out !== src) writeFileSync(f, out);
}
console.log(`v=${ver} にしました(${count}か所)`);
