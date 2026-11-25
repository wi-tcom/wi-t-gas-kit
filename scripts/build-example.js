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

module.exports = { build };

if (require.main === module) {
  try {
    const res = build(process.argv[2]);
    console.log('built ' + path.relative(ROOT, res.outDir) + ':\n  ' + res.files.join('\n  '));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
