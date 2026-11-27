'use strict';

/**
 * 見本を GAS に送れる形にまとめる。
 *
 *   npm run example:build -- csv-reconcile
 *
 * dist/<見本の名前>/ に、次のものを置く（毎回作り直す）。
 *   appsscript.json            見本の appsscript.json
 *   witgas/<部品>.js           見本が使う src/ の部品（parts.json に書いたもの）
 *   <見本の .js>               見本のソース
 *   .clasp.json                見本のフォルダに .clasp.json があれば（rootDir は "." にする）
 *
 * そのあと dist/<見本の名前>/ で `npx @google/clasp push` する。
 *
 * 見本のフォルダに bundle.json があるときは、先方の既存のプロジェクトに「1 つだけ足す」ファイルを作る：
 *   { "file": "wit-inspect.js", "exports": "WIT_INSPECT", "entry": "entry.js" }
 *   - parts.json の部品と main.js を、1 つの関数の中に閉じ込める（先方のグローバルの WitGas を上書きしない）
 *   - main.js の最後で exports に渡すものを var WIT_INSPECT_API のように用意しておき、それを返す
 *   - entry.js（先方のエディタから実行するトップレベルの関数）をその後ろに足す
 *   - appsscript.json は出さない（先方の appsscript.json を置き換えないため）
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function build(name, outRoot) {
  if (!/^[a-z0-9-]+$/.test(name || '')) {
    throw new Error('example name is required (e.g. csv-reconcile)');
  }
  const exampleDir = path.join(ROOT, 'examples', name);
  if (!fs.existsSync(exampleDir)) throw new Error('no such example: ' + name);

  const parts = JSON.parse(fs.readFileSync(path.join(exampleDir, 'parts.json'), 'utf8'));
  const outDir = path.join(outRoot || path.join(ROOT, 'dist'), name);
  fs.rmSync(outDir, { recursive: true, force: true });

  const bundlePath = path.join(exampleDir, 'bundle.json');
  if (fs.existsSync(bundlePath)) {
    const b = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, b.file), bundle(exampleDir, parts, b));
    return { outDir, files: [b.file] };
  }
  fs.mkdirSync(path.join(outDir, 'witgas'), { recursive: true });

  const written = [];
  const copy = (from, to) => {
    fs.copyFileSync(from, path.join(outDir, to));
    written.push(to);
  };

  copy(path.join(exampleDir, 'appsscript.json'), 'appsscript.json');
  for (const part of parts) {
    const src = path.join(ROOT, 'src', part);
    if (!fs.existsSync(src)) throw new Error('parts.json lists a missing part: ' + part);
    copy(src, path.join('witgas', part));
  }
  for (const f of fs.readdirSync(exampleDir).filter((f) => f.endsWith('.js')).sort()) {
    copy(path.join(exampleDir, f), f);
  }
  const clasp = path.join(exampleDir, '.clasp.json');
  if (fs.existsSync(clasp)) {
    const conf = JSON.parse(fs.readFileSync(clasp, 'utf8'));
    conf.rootDir = '.';
    fs.writeFileSync(path.join(outDir, '.clasp.json'), JSON.stringify(conf, null, 2) + '\n');
    written.push('.clasp.json');
  }
  return { outDir, files: written };
}

/** 部品と main.js を 1 つの関数に閉じ込めた 1 ファイルの中身 */
function bundle(exampleDir, parts, b) {
  const read = (p) => fs.readFileSync(p, 'utf8');
  const chunks = [];
  chunks.push('/**\n * このファイルは npm run example:build で作ったもの。中身は examples/' + path.basename(exampleDir) +
    ' と src/ の部品（' + parts.join('・') + '）。\n * 部品は下の関数の中だけで使い、先方のグローバルの WitGas には触らない。\n *\n * © 2026 wi-t.com Inc.\n */');
  chunks.push('var ' + b.exports + ' = (function () {');
  chunks.push('var WitGas = {};');
  for (const part of parts) {
    const src = path.join(ROOT, 'src', part);
    if (!fs.existsSync(src)) throw new Error('parts.json lists a missing part: ' + part);
    chunks.push('// ---- src/' + part + ' ----\n' + read(src));
  }
  chunks.push('// ---- main.js ----\n' + read(path.join(exampleDir, 'main.js')));
  chunks.push('return ' + b.exports + '_API;\n})();');
  chunks.push('// ---- entry.js ----\n' + read(path.join(exampleDir, b.entry)));
  return chunks.join('\n\n') + '\n';
}

module.exports = { build, bundle };

if (require.main === module) {
  try {
    const res = build(process.argv[2]);
    console.log('built ' + path.relative(ROOT, res.outDir) + ':\n  ' + res.files.join('\n  '));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
