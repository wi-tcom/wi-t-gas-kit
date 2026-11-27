'use strict';

/**
 * Drive API（詳細サービス v3、GAS では Drive）の偽物。見本が使う Files.create / list / get / update だけ。
 * drive.file の権限では、スクリプトが作ったものしか見えない。偽物も、作ったものだけを持つ。
 *
 * list の q は、見本が使う形だけを読む：
 *   name = '...'、mimeType = '...'、'<id>' in parents、trashed = false を and でつないだもの
 *
 * テスト用の操作：failNextCreate(err)、folders()、filesIn(folderId)、trash(id)、calls
 */
const FOLDER = 'application/vnd.google-apps.folder';

function createDriveApi() {
  const items = new Map();
  const calls = [];
  let nextId = 1;
  let createError = null;

  function view(it, fields) {
    const out = { id: it.id, name: it.name, mimeType: it.mimeType, parents: it.parents.slice(), trashed: it.trashed };
    if (!fields) return out;
    const wanted = fields.replace(/^files\((.*)\)$/, '$1').split(',').map((f) => f.trim());
    return Object.fromEntries(wanted.filter((f) => f in out).map((f) => [f, out[f]]));
  }

  function unquote(s) {
    return s.slice(1, -1).replace(/\\(.)/g, '$1');
  }

  function matcher(q) {
    const tests = q.split(/\s+and\s+/).map((clause) => {
      let m;
      if ((m = /^name\s*=\s*('(?:[^'\\]|\\.)*')$/.exec(clause))) { const v = unquote(m[1]); return (it) => it.name === v; }
      if ((m = /^mimeType\s*=\s*('(?:[^'\\]|\\.)*')$/.exec(clause))) { const v = unquote(m[1]); return (it) => it.mimeType === v; }
      if ((m = /^('(?:[^'\\]|\\.)*')\s+in\s+parents$/.exec(clause))) { const v = unquote(m[1]); return (it) => it.parents.includes(v); }
      if (/^trashed\s*=\s*false$/.test(clause)) return (it) => !it.trashed;
      throw new Error('mock Drive.Files.list: unsupported q clause: ' + clause);
    });
    return (it) => tests.every((t) => t(it));
  }

  const Files = {
    create(resource, blob) {
      calls.push({ method: 'create', resource });
      if (createError) { const e = createError; createError = null; throw e; }
      if (!resource || !resource.name) throw new Error('Drive.Files.create: name is required');
      const id = (resource.mimeType === FOLDER ? 'D' : 'F') + nextId++;
      const it = {
        id,
        name: resource.name,
        mimeType: resource.mimeType || (blob ? blob.getContentType() : 'application/octet-stream'),
        parents: (resource.parents || []).slice(),
        trashed: false,
        blob: blob || null
      };
      for (const p of it.parents) {
        if (!items.has(p)) throw new Error('File not found: ' + p);
      }
      items.set(id, it);
      return view(it);
    },
    list(params) {
      calls.push({ method: 'list', params });
      const all = Array.from(items.values());
      const hit = params && params.q ? all.filter(matcher(params.q)) : all;
      return { files: hit.map((it) => view(it, params && params.fields)) };
    },
    get(id, params) {
      calls.push({ method: 'get', id });
      const it = items.get(id);
      if (!it) throw new Error('GoogleJsonResponseException: API call to drive.files.get failed with error: File not found: ' + id);
      return view(it, params && params.fields);
    },
    update(resource, id) {
      calls.push({ method: 'update', id, resource });
      const it = items.get(id);
      if (!it) throw new Error('File not found: ' + id);
      if ('trashed' in resource) it.trashed = !!resource.trashed;
      if ('name' in resource) it.name = resource.name;
      return view(it);
    }
  };

  return {
    Files,
    // --- テスト用 ---
    failNextCreate(err) { createError = err; },
    folders: () => Array.from(items.values()).filter((it) => it.mimeType === FOLDER && !it.trashed),
    filesIn: (folderId) => Array.from(items.values()).filter((it) => it.parents.includes(folderId) && !it.trashed),
    trash(id) { items.get(id).trashed = true; },
    calls
  };
}

module.exports = { createDriveApi, FOLDER };
