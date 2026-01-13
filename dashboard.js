/* Dashboard Aplikasi - Offline-first, dinamis via IndexedDB + Scan Folder (File System Access API) */
(() => {
  const $ = (s, r=document) => r.querySelector(s);

  const DB_NAME = 'app_dashboard_db_v1';
  const STORE_APPS = 'apps';
  const STORE_META = 'meta';

    /* -----------------------------
     ✅ apps.json Manifest (rapi)
  ----------------------------- */
  const MANIFEST_URL = 'apps.json';

  async function loadAppsManifest(){
    try{
      const res = await fetch(MANIFEST_URL, { cache:'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();

      const list = Array.isArray(json?.apps) ? json.apps : [];
      const files = list
        .map(x => (typeof x === 'string' ? x : x?.file))
        .filter(Boolean)
        .map(s => String(s).trim())
        .filter(s => /\.html?$/i.test(s))
        .filter(s => !/^index\.html$/i.test(s))
        .filter(s => !/^dashboard\.html$/i.test(s))
        .filter(s => !/^dashboard\./i.test(s));

      return [...new Set(files)];
    }catch(e){
      console.warn('apps.json tidak bisa dibaca:', e);
      return [];
    }
  }

  async function syncAppsFromManifest(db){
    const current = await idbListApps(db);
    const files = await loadAppsManifest();

    let added = 0, updated = 0, skipped = 0;

    for (const fn of files){
      try{
        const res = await fetch(fn, { cache:'no-cache' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const html = await res.text();

        const prev = current.find(a => a.filename === fn);
        if (!prev){
          await upsertAppFromHtml({ db, htmlText: html, filename: fn, source:'bundled' });
          added++;
        }else{
          await upsertAppFromHtml({
            db,
            htmlText: html,
            filename: fn,
            source: prev.source || 'bundled',
            handle: prev.handle || null
          });
          updated++;
        }
      }catch(err){
        console.warn('Gagal load file dari apps.json:', fn, err);
        skipped++;
      }
    }

    return { added, updated, skipped, total: files.length };
  }

  const State = {
    editing: false,
    apps: [],
    q: '',
    folderHandle: null,
  };

  /* -----------------------------
     IndexedDB helpers
  ----------------------------- */
  function idbOpen(){
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_APPS)){
          const st = db.createObjectStore(STORE_APPS, { keyPath: 'id' });
          st.createIndex('order', 'order', { unique:false });
          st.createIndex('name', 'name', { unique:false });
        }
        if (!db.objectStoreNames.contains(STORE_META)){
          db.createObjectStore(STORE_META, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGet(db, store, key){
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbPut(db, store, val){
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(val);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbDel(db, store, key){
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbClear(db){
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_APPS, STORE_META], 'readwrite');
      tx.objectStore(STORE_APPS).clear();
      tx.objectStore(STORE_META).clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbListApps(db){
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_APPS, 'readonly');
      const idx = tx.objectStore(STORE_APPS).index('order');
      const req = idx.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  /* -----------------------------
     Utilities
  ----------------------------- */
  function fileStem(filename){
    return String(filename || '').split('/').pop().replace(/\.html?$/i,'');
  }

  function parseIconHref(html){
    // prefer rel="icon" href="..."; if missing, fallback emoji
    const m = html.match(/<link\s+[^>]*rel=["']icon["'][^>]*href="([^"]+)"/i)
           || html.match(/<link\s+[^>]*rel=["']icon["'][^>]*href='([^']+)'/i);
    return m ? m[1] : null;
  }

  function safeIconDataUrl(href){
    if (!href) return null;
    // allow data url or relative http(s)
    if (/^data:image\//i.test(href)) return href;
    if (/^https?:\/\//i.test(href)) return href;
    // relative path: keep as-is (works if app opened from same folder)
    if (/^[./]/.test(href) || /^[^:]+\//.test(href)) return href;
    return href;
  }

  function createEmojiIconDataUrl(emoji='📦'){
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><text y="54" x="10" font-size="44">${emoji}</text></svg>`;
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  }

  function nowId(){
    return 'app_' + Math.random().toString(16).slice(2) + Date.now().toString(16);
  }

  function showToast(msg){
    const el = $('#subInfo');
    if (!el) return;
    el.textContent = msg;
  }

  function byNameThenOrder(a,b){
    if ((a.order??9999) !== (b.order??9999)) return (a.order??9999)-(b.order??9999);
    return (a.name||'').localeCompare(b.name||'', 'id', { sensitivity:'base' });
  }

  /* -----------------------------
     App import logic
  ----------------------------- */
  async function upsertAppFromHtml({ db, htmlText, filename, source='file', handle=null }){
    const name = fileStem(filename);
    const iconHref = safeIconDataUrl(parseIconHref(htmlText)) || createEmojiIconDataUrl('📄');

    // check existing by filename (unique)
    const existing = (await idbListApps(db)).find(a => a.filename === filename);
    const order = existing?.order ?? (await idbListApps(db)).length + 1;

    const rec = {
      id: existing?.id || nowId(),
      name,
      filename,
      icon: iconHref,
      source,   // 'bundled' | 'file' | 'folder'
      order,
      updatedAt: Date.now(),
      // store HTML blob (standalone). If file has external assets, open fallback to original file.
      html: htmlText,
    };

    // store folder handle per app if given
    if (handle) rec.handle = handle;

    await idbPut(db, STORE_APPS, rec);
    return rec;
  }


  /* -----------------------------
     Folder scanning (Chrome/Edge)
  ----------------------------- */
  async function loadSavedFolderHandle(db){
    try{
      const meta = await idbGet(db, STORE_META, 'folderHandle');
      return meta?.value || null;
    }catch(e){
      return null;
    }
  }

  async function saveFolderHandle(db, handle){
    await idbPut(db, STORE_META, { key:'folderHandle', value: handle });
  }

  async function scanFolder(db, handle){
    // Find .html files in root folder (not recursive)
    let added = 0, updated = 0, skipped = 0;
    const existing = await idbListApps(db);

    for await (const [name, entry] of handle.entries()){
      if (entry.kind !== 'file') continue;
      if (!/\.html?$/i.test(name)) continue;
      if (/^index\.html$/i.test(name)) continue;
      if (/^dashboard\.html$/i.test(name)) continue;
      if (/^dashboard\./i.test(name)) continue;

      try{
        const file = await entry.getFile();
        const text = await file.text();

        const prev = existing.find(a => a.filename === name);
        if (!prev){
          await upsertAppFromHtml({ db, htmlText:text, filename:name, source:'folder', handle: entry });
          added++;
        }else{
          // update if changed size/time? easiest: always update icon/html
          await upsertAppFromHtml({ db, htmlText:text, filename:name, source: prev.source || 'folder', handle: entry });
          updated++;
        }
      }catch(err){
        console.warn('Gagal baca file dari folder:', name, err);
        skipped++;
      }
    }
    return { added, updated, skipped };
  }

  /* -----------------------------
     Rendering + interactions
  ----------------------------- */
  function filterApps(apps, q){
    q = (q||'').trim().toLowerCase();
    if (!q) return apps;
    return apps.filter(a =>
      (a.name||'').toLowerCase().includes(q) ||
      (a.filename||'').toLowerCase().includes(q)
    );
  }

  function render(){
    const grid = $('#grid');
    const pill = $('#countPill');
    const apps = filterApps(State.apps, State.q).sort(byNameThenOrder);

    pill.textContent = String(apps.length);

    grid.innerHTML = '';
    if (!apps.length){
      const empty = document.createElement('div');
      empty.style.gridColumn = '1 / -1';
      empty.style.padding = '18px 6px';
      empty.style.color = 'rgba(232,238,252,.75)';
      empty.innerHTML = `Belum ada aplikasi. Klik <b>Tambah</b> atau <b>Scan Folder</b>.`;
      grid.appendChild(empty);
      return;
    }

    apps.forEach((app, idx) => {
      const card = document.createElement('div');
      card.className = 'app' + (State.editing ? ' editing' : '');
      card.draggable = State.editing;

      card.dataset.id = app.id;

      const icon = document.createElement('div');
      icon.className = 'app__icon';
      const img = document.createElement('img');
      img.alt = app.name;
      img.src = app.icon || createEmojiIconDataUrl('📦');
      img.onerror = () => { img.src = createEmojiIconDataUrl('📦'); };
      icon.appendChild(img);

      const name = document.createElement('div');
      name.className = 'app__name';
      name.textContent = app.name;

      const badge = document.createElement('div');
      badge.className = 'app__badge';
      badge.textContent = app.source === 'bundled' ? 'Bundle' : (app.source === 'folder' ? 'Folder' : 'Import');

      const x = document.createElement('button');
      x.className = 'x';
      x.type = 'button';
      x.textContent = '✕';
      x.title = 'Hapus dari dashboard';
      x.addEventListener('click', (ev) => {
        ev.stopPropagation();
        confirmDelete(app.id, app.name);
      });

      card.appendChild(x);
      card.appendChild(icon);
      card.appendChild(name);

      // click open
      card.addEventListener('click', () => {
        if (State.editing) return;
        openApp(app);
      });

      // drag reorder
      card.addEventListener('dragstart', (ev) => {
        ev.dataTransfer.setData('text/plain', app.id);
        ev.dataTransfer.effectAllowed = 'move';
      });
      card.addEventListener('dragover', (ev) => {
        if (!State.editing) return;
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'move';
      });
      card.addEventListener('drop', (ev) => {
        if (!State.editing) return;
        ev.preventDefault();
        const fromId = ev.dataTransfer.getData('text/plain');
        const toId = app.id;
        if (fromId && toId && fromId !== toId){
          reorder(fromId, toId);
        }
      });

      grid.appendChild(card);
    });
  }

  async function openApp(app){
    // Prefer: if source is bundled/folder and file exists, open file directly (relative path) for best compatibility
    // But since we stored html in IDB, we can open stored blob to keep working even offline.
    try{
      const blob = new Blob([app.html || ''], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      // revoke later
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }catch(e){
      // fallback to file
      window.open(app.filename, '_blank', 'noopener');
    }
  }

  async function confirmDelete(id, name){
    const ok = await modalConfirm(
      'Hapus aplikasi?',
      `Aplikasi <b>${escapeHtml(name)}</b> akan dihapus dari dashboard (file aslinya tidak dihapus).`
    );
    if (!ok) return;

    const db = await idbOpen();
    await idbDel(db, STORE_APPS, id);
    await refresh();
    showToast('Dihapus: ' + name);
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  }

  async function reorder(fromId, toId){
    const apps = [...State.apps].sort(byNameThenOrder);
    const fromIdx = apps.findIndex(a => a.id === fromId);
    const toIdx = apps.findIndex(a => a.id === toId);
    if (fromIdx < 0 || toIdx < 0) return;

    const [moved] = apps.splice(fromIdx, 1);
    apps.splice(toIdx, 0, moved);

    // assign new orders
    const db = await idbOpen();
    for (let i=0;i<apps.length;i++){
      apps[i].order = i+1;
      await idbPut(db, STORE_APPS, apps[i]);
    }
    await refresh();
    showToast('Urutan disimpan.');
  }

  async function refresh(){
    const db = await idbOpen();
    State.apps = await idbListApps(db);
    render();
    $('#subInfo').textContent = `${State.apps.length} aplikasi`;
  }

  /* -----------------------------
     Modal confirm
  ----------------------------- */
  function modalShow(title, html, okText='OK', cancelText='Batal'){
    const modal = $('#modal');
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = html;

    const btnOk = $('#modalOk');
    const btnCancel = $('#modalCancel');
    btnOk.textContent = okText;
    btnCancel.textContent = cancelText;

    modal.classList.remove('hidden');

    return new Promise((resolve) => {
      const cleanup = () => {
        modal.classList.add('hidden');
        btnOk.onclick = null;
        btnCancel.onclick = null;
        modal.onclick = null;
        document.removeEventListener('keydown', onKey);
      };
      const onKey = (e) => {
        if (e.key === 'Escape'){ cleanup(); resolve(false); }
      };
      document.addEventListener('keydown', onKey);

      btnOk.onclick = () => { cleanup(); resolve(true); };
      btnCancel.onclick = () => { cleanup(); resolve(false); };
      modal.onclick = (e) => {
        if (e.target === modal){ cleanup(); resolve(false); }
      };
    });
  }

  function modalConfirm(title, html){
    return modalShow(title, html, 'Ya', 'Batal');
  }

  /* -----------------------------
     Actions
  ----------------------------- */
  async function onImportFile(){
    const fp = $('#filePicker');
    fp.value = '';
    fp.click();
  }

  async function handlePickedFile(file){
    const db = await idbOpen();
    const text = await file.text();
    const rec = await upsertAppFromHtml({ db, htmlText:text, filename:file.name, source:'file' });
    await refresh();
    showToast('Ditambahkan: ' + rec.name);
  }

  async function onScanFolder(){
    if (!('showDirectoryPicker' in window)){
      await modalShow('Tidak didukung',
        'Browser Anda belum mendukung <b>Scan Folder</b>. Gunakan tombol <b>Tambah</b> untuk import file .html satu per satu.',
        'OK', 'Tutup'
      );
      return;
    }
    const db = await idbOpen();
    const handle = await window.showDirectoryPicker();
    await saveFolderHandle(db, handle);
    const res = await scanFolder(db, handle);
    await refresh();
    showToast(`Scan selesai: +${res.added}, update ${res.updated}`);
  }

  async function autoScanIfPossible(){
    if (!('showDirectoryPicker' in window)) return;
    const db = await idbOpen();
    const handle = await loadSavedFolderHandle(db);
    if (!handle) return;

    // request permission quietly
    try{
      const perm = await handle.queryPermission?.({ mode:'read' }) || 'prompt';
      if (perm === 'denied') return;
      if (perm !== 'granted'){
        const req = await handle.requestPermission?.({ mode:'read' });
        if (req !== 'granted') return;
      }

      const res = await scanFolder(db, handle);
      if (res.added || res.updated){
        await refresh();
        showToast(`Auto-scan: +${res.added}, update ${res.updated}`);
      }
    }catch(e){
      console.warn('Auto scan gagal:', e);
    }
  }

  async function onToggleEdit(){
    State.editing = !State.editing;
    $('#btnEdit').classList.toggle('danger', State.editing);
    $('#btnEdit .ico').textContent = State.editing ? '✅' : '🛠️';
    showToast(State.editing ? 'Mode edit aktif: drag untuk urutkan, klik ✕ untuk hapus' : 'Mode edit selesai');
    render();
  }

  async function onReset(){
    const ok = await modalConfirm('Reset Dashboard?',
      `Ini akan menghapus <b>semua data dashboard</b> (daftar aplikasi, urutan, folder terhubung).
       File HTML aplikasi Anda tidak dihapus dari komputer/server.`);
    if (!ok) return;
    const db = await idbOpen();
    await idbClear(db);
    State.apps = [];
    State.q = '';
    $('#q').value = '';
    await init(); // bootstrap lagi
    showToast('Dashboard di-reset.');
  }

  /* -----------------------------
     Init
  ----------------------------- */
  async function init(){
    // service worker (optional)
    try{
      if ('serviceWorker' in navigator){
        await navigator.serviceWorker.register('sw.js');
      }
    }catch(e){}

    const db = await idbOpen();
    const boot = await syncAppsFromManifest(db);

    State.apps = await idbListApps(db);

    $('#q').addEventListener('input', (e) => {
      State.q = e.target.value;
      render();
    });

    $('#btnImport').addEventListener('click', onImportFile);
    $('#btnScan').addEventListener('click', onScanFolder);
    $('#btnEdit').addEventListener('click', onToggleEdit);
    $('#btnReset').addEventListener('click', onReset);

    $('#filePicker').addEventListener('change', async (e) => {
      const f = e.target.files?.[0];
      if (f) await handlePickedFile(f);
    });

    $('#subInfo').textContent = `${State.apps.length} aplikasi`;
    if (boot?.added || boot?.updated){
      showToast(`Sync apps.json: +${boot.added}, update ${boot.updated}`);
    }
    render();

    // auto scan folder if user already picked one
    await autoScanIfPossible();
  }

  init();
})();
