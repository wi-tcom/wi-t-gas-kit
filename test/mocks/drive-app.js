'use strict';

/**
 * DriveApp の偽物（見本が使う分だけ）。フォルダとファイルを Map で持つ。
 * drive.file の権限では、スクリプトが作ったものしか見えない。偽物でも、作ったものだけを持つ。
 *
 * テスト用の操作：
 *   failNextCreateFile(err)  次の folder.createFile を失敗させる
 *   folders()                作ったフォルダの一覧
 */
function createDriveApp() {
  const folders = new Map();
  const files = new Map();
  let nextId = 1;
  let createFileError = null;

  function makeFile(blob, parentId) {
    const id = 'F' + nextId++;
    const f = {
      _blob: blob,
      _parent: parentId,
      _trashed: false,
      getId: () => id,
      getName: () => blob.getName(),
      getUrl: () => 'https://drive.google.com/file/d/' + id + '/view',
      getMimeType: () => blob.getContentType(),
      getBlob: () => blob,
      setTrashed(v) { f._trashed = !!v; return f; },
      isTrashed: () => f._trashed
    };
    files.set(id, f);
    return f;
  }

  function iterator(list) {
    let i = 0;
    return { hasNext: () => i < list.length, next: () => list[i++] };
  }

  function makeFolder(name) {
    const id = 'D' + nextId++;
    const folder = {
      getId: () => id,
      getName: () => name,
      getUrl: () => 'https://drive.google.com/drive/folders/' + id,
      createFile(blob) {
        if (createFileError) {
          const e = createFileError;
          createFileError = null;
          throw e;
        }
        return makeFile(blob, id);
      },
      getFilesByName(n) {
        return iterator(Array.from(files.values()).filter((f) => f._parent === id && !f._trashed && f.getName() === n));
      },
      getFiles() {
        return iterator(Array.from(files.values()).filter((f) => f._parent === id && !f._trashed));
      }
    };
    folders.set(id, folder);
    return folder;
  }

  return {
    createFolder: (name) => makeFolder(name),
    getFolderById(id) {
      const f = folders.get(id);
      if (!f) throw new Error('No item with the given ID could be found, or you do not have permission to access it.');
      return f;
    },
    getFileById(id) {
      const f = files.get(id);
      if (!f) throw new Error('No item with the given ID could be found, or you do not have permission to access it.');
      return f;
    },
    // --- テスト用 ---
    failNextCreateFile(err) { createFileError = err; },
    folders: () => Array.from(folders.values()),
    filesIn: (folderId) => Array.from(files.values()).filter((f) => f._parent === folderId && !f._trashed)
  };
}

module.exports = { createDriveApp };
