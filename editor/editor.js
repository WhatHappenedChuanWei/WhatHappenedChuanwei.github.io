(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var GF = window.__gf, NATIVE = !!(GF && GF.native);   // NATIVE：由 server.js 提供页面（右键菜单、任意路径、回收站）
  var ed = $('ed'), doc = $('doc'), tree = $('tree');
  var srcDir = null;           // 含 _posts 的目录（用来解析 /img/ 图片）
  var cur = null;              // {fh, path, slug, type:'md'|'text'|'image'}
  var dirty = false, lastSaved = '', autoTimer = null, renderTimer = null;
  var imgCache = {};
  var treeRoot = null, srcRel = '', rootNode = null, openSet = {}, nodeMap = {}, selDir = null;
  var IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;
  // 不再用「文本扩展名白名单」：除了图片和已知的二进制格式，其余都按内容判断是不是文本
  var BIN_EXT = /\.(exe|dll|so|dylib|bin|obj|o|class|jar|zip|rar|7z|tar|gz|tgz|bz2|xz|iso|pdf|docx?|xlsx?|pptx?|mp3|mp4|mkv|avi|mov|wav|flac|ogg|webm|woff2?|ttf|otf|eot|psd|ai|db|sqlite|lnk|pyc|node)$/i;
  function maybeText(name) { return !IMG_EXT.test(name) && !BIN_EXT.test(name); }
  // 解码：先按 UTF-8 严格解码，失败再按 GBK（中文 Windows 记事本的「ANSI」）；含 NUL 视为二进制
  async function readText(file) {
    var buf = await file.arrayBuffer(), u8 = new Uint8Array(buf), probe = u8.subarray(0, 8192);
    for (var i = 0; i < probe.length; i++) if (probe[i] === 0) return null;
    try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(u8), enc: 'utf-8' }; } catch (e) {}
    try { return { text: new TextDecoder('gbk').decode(u8), enc: 'gbk' }; } catch (e) {}
    return null;
  }
  
  function ic(n) { return '<svg class="ic"><use href="#i-' + n + '"/></svg>'; }
  function esc(s) { return MD.esc(String(s)); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function nowStr() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  var msgT;
  function toast(t) {
    var m = $('msg'); m.textContent = t; m.classList.add('show');
    clearTimeout(msgT); msgT = setTimeout(function () { m.classList.remove('show'); }, 2200);
  }

  /* ---------- 记住上次的文件夹（IndexedDB） ---------- */
  function idb() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open('emberlight-editor', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('h'); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function idbGet(k) {
    if (NATIVE) return GF.pref().then(function (p) { return p.lastdir ? new GF.RDir(p.lastdir) : null; }); return idb().then(function (db) { return new Promise(function (res) { var q = db.transaction('h').objectStore('h').get(k); q.onsuccess = function () { res(q.result); }; q.onerror = function () { res(null); }; }); }).catch(function () { return null; }); }
  function idbSet(k, v) {
    if (NATIVE) return GF.setPref({ lastdir: v.path }); return idb().then(function (db) { return new Promise(function (res) { var tx = db.transaction('h', 'readwrite'); tx.objectStore('h').put(v, k); tx.oncomplete = res; tx.onerror = res; }); }).catch(function () {}); }

  /* ---------- 文件树 ---------- */
  async function sub(dir, name, create) {
    try { return await dir.getDirectoryHandle(name, { create: !!create }); } catch (e) { return null; }
  }
  async function findSource(dir) {
    if (await sub(dir, '_posts')) return { dir: dir, rel: '' };
    var s = await sub(dir, 'source');
    if (s && await sub(s, '_posts')) return { dir: s, rel: 'source' };
    return null;
  }
  function mkNode(handle, path, name, kind) {
    var n = { handle: handle, path: path, name: name, kind: kind, children: null };
    nodeMap[path] = n; return n;
  }
  function hidden(name, atRoot) {
    if (/^(\.DS_Store|Thumbs\.db|\.git)$/.test(name)) return true;
    return atRoot && /^(node_modules|\.deploy_git|public|\.claude)$/.test(name);
  }
  async function useFolder(dir, restoreLast) {
    var f = (await findSource(dir)) || { dir: null, rel: '' };   // 不是博客文件夹也能浏览和编辑，只是不能贴图/新建文章
    srcDir = f.dir; srcRel = f.rel; treeRoot = dir;
    await idbSet('dir', dir);
    openSet = { '': true }; nodeMap = {};
    rootNode = mkNode(dir, '', dir.name, 'directory'); selDir = rootNode;
    if (srcDir) {
      if (srcRel) openSet[srcRel] = true;
      openSet[(srcRel ? srcRel + '/' : '') + '_posts'] = true;
    }
    await expandOpen();
    $('b-open-t').textContent = dir.name; $('rootname').textContent = dir.name;
    if (restoreLast) { var last = lsGet('last:' + dir.name, ''); if (last) { var n = await nodeByPath(last); if (n && n.kind === 'file') { drawSide(); await openNode(n); } } }
    return true;
  }
  async function loadChildren(n) {
    var arr = [], root0 = n.path === '';
    for await (var e of n.handle.values()) {
      if (hidden(e.name, root0)) continue;
      arr.push(mkNode(e, n.path ? n.path + '/' + e.name : e.name, e.name, e.kind));
    }
    var recent = /^(_posts|_drafts)$/.test(n.name);
    if (recent) for (var i = 0; i < arr.length; i++) { if (arr[i].kind === 'file') { try { arr[i].t = arr[i].handle._mtime !== undefined ? arr[i].handle._mtime : (await arr[i].handle.getFile()).lastModified; } catch (x) { arr[i].t = 0; } } }
    arr.sort(function (x, y) {
      if (x.kind !== y.kind) return x.kind === 'directory' ? -1 : 1;
      if (recent && x.kind === 'file') return y.t - x.t;
      return x.name.localeCompare(y.name, 'zh');
    });
    n.children = arr;
  }
  async function expandOpen() {
    async function walk(n) {
      if (n.kind !== 'directory' || !openSet[n.path]) return;
      if (!n.children) await loadChildren(n);
      for (var i = 0; i < n.children.length; i++) await walk(n.children[i]);
    }
    await walk(rootNode); drawSide();
  }
  async function refreshList() {
    var keep = openSet; nodeMap = {};
    rootNode = mkNode(treeRoot, '', treeRoot.name, 'directory'); openSet = keep; selDir = rootNode;
    await expandOpen();
  }
  async function nodeByPath(p, keepClosed) {
    if (!rootNode) return null;
    var n = rootNode; if (!p) return n;
    var segs = p.split('/');
    for (var i = 0; i < segs.length; i++) {
      if (!n.children) await loadChildren(n);
      var c = n.children.filter(function (x) { return x.name === segs[i]; })[0];
      if (!c) return null;
      n = c; if (!keepClosed && i < segs.length - 1) openSet[n.path] = true;
    }
    return n;
  }
  function iconFor(n, open) {
    if (n.kind === 'directory') return ic(open ? 'folder-open' : 'folder');
    if (IMG_EXT.test(n.name)) return ic('image');
    if (/\.(md|markdown|txt)$/i.test(n.name)) return ic('file-text');
    return ic('file');
  }
  function drawSide() {
    tree.innerHTML = '';
    if (!rootNode) { tree.innerHTML = '<div class="empty">还没有打开文件夹。<br>点上方「打开文件夹」，选择 blog 或 blog\\source。</div>'; return; }
    (function walk(n, depth) {
      var d = document.createElement('div');
      var isDir = n.kind === 'directory', open = isDir && openSet[n.path];
      d.className = 'it' + (cur && cur.path === n.path ? ' cur' : '') + (isDir ? ' dir' : '');
      d.style.paddingLeft = (8 + depth * 14) + 'px';
      d.innerHTML = (isDir ? ic(open ? 'chev-d' : 'chev-r') : '<span style="width:16px;flex:none"></span>') + iconFor(n, open) + '<span class="nm">' + esc(n.name) + '</span>';
      d.title = n.path || n.name;
      if (!isDir && !maybeText(n.name) && !IMG_EXT.test(n.name)) d.className += ' dim';
      d.onclick = function () { if (isDir) { selDir = n; toggle(n); } else { selDir = nodeMap[parentPath(n.path)] || rootNode; openNode(n); } };
      d.oncontextmenu = function (e) { e.preventDefault(); showCtx(e, n); };
      tree.appendChild(d);
      if (open && n.children) n.children.forEach(function (c) { walk(c, depth + 1); });
    })(rootNode, 0);
  }
  async function toggle(n) {
    if (openSet[n.path]) { delete openSet[n.path]; drawSide(); return; }
    openSet[n.path] = true;
    if (!n.children) await loadChildren(n);
    drawSide();
  }
  function parentPath(p) { var i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }

  /* ---------- 右键菜单 ---------- */
  var ctx = document.createElement('div'); ctx.id = 'ctx'; document.body.appendChild(ctx);
  document.addEventListener('click', function () { ctx.style.display = 'none'; });
  function showCtx(e, n) {
    var items = [];
    if (n.kind === 'directory') {
      items.push([ic('file-plus') + '新建文件…', function () { newFile(n); }]);
      items.push([ic('folder-plus') + '新建文件夹…', function () { newFolder(n); }]);
      items.push([ic('refresh') + '刷新', async function () { n.children = null; await loadChildren(n); drawSide(); }]);
    }
    if (n.path !== '') {
      if (items.length) items.push(null);
      items.push([ic('pencil') + '重命名…', function () { renameNode(n); }]);
      items.push([ic('trash') + '删除…', function () { del(n); }]);
    }
    ctx.innerHTML = '';
    items.forEach(function (it) {
      if (!it) { ctx.appendChild(document.createElement('hr')); return; }
      var b = document.createElement('div'); b.innerHTML = it[0]; b.onclick = it[1]; ctx.appendChild(b);
    });
    ctx.style.left = Math.min(e.clientX, innerWidth - 180) + 'px'; ctx.style.top = Math.min(e.clientY, innerHeight - 160) + 'px'; ctx.style.display = 'block';
  }
  function badName(s) { return /[\\/:*?"<>|]/.test(s); }
  async function newFile(dirNode) {
    var name = prompt('新文件名（不写后缀就当作 .md）：', ''); if (!name) return;
    name = name.trim().replace(/[\\/:*?"<>|]/g, '-'); if (!name) return;
    if (!/\.[A-Za-z0-9]+$/.test(name)) name += '.md';
    try { await dirNode.handle.getFileHandle(name); alert('已经有同名文件'); return; } catch (e) {}
    var fh = await dirNode.handle.getFileHandle(name, { create: true });
    var text = '';
    if (/\.md$/i.test(name) && dirNode.name === '_posts') text = '---\ntitle: ' + name.replace(/\.md$/i, '') + '\ndate: ' + nowStr() + '\ncategories: 开发日志\ntags: []\n---\n\n';
    var w = await fh.createWritable(); await w.write(text); await w.close();
    openSet[dirNode.path] = true; dirNode.children = null; await loadChildren(dirNode); drawSide();
    var n = nodeMap[dirNode.path ? dirNode.path + '/' + name : name]; if (n) openNode(n);
  }
  async function newFolder(dirNode) {
    var name = prompt('新文件夹名：', ''); if (!name) return;
    name = name.trim().replace(/[\\/:*?"<>|]/g, '-'); if (!name) return;
    await dirNode.handle.getDirectoryHandle(name, { create: true });
    openSet[dirNode.path] = true; dirNode.children = null; await loadChildren(dirNode); drawSide();
  }
  function dropStale(prefix) { Object.keys(nodeMap).forEach(function (k) { if (k === prefix || k.indexOf(prefix + '/') === 0) delete nodeMap[k]; }); }
  async function del(n) {
    if (!confirm('确定删除「' + n.path + '」吗？' + (NATIVE ? '\n（会放进 Windows 回收站，可以还原）' : (n.kind === 'directory' ? '\n（整个文件夹及里面所有内容都会被删除，不会进回收站！）' : '\n（不会进回收站！）')))) return;
    var parent = nodeMap[parentPath(n.path)];
    try { await parent.handle.removeEntry(n.name, { recursive: true }); } catch (e) { alert('删除失败：' + e.message); return; }
    if (cur && (cur.path === n.path || cur.path.indexOf(n.path + '/') === 0)) { cur = null; ed.value = ''; ed.readOnly = false; lastSaved = ''; setDirty(false); renderNow(); status(); }
    dropStale(n.path); parent.children = null; await loadChildren(parent); drawSide(); toast('已删除');
  }

  /* ---------- 重命名（优先 move()，不行就复制再删除） ---------- */
  async function copyEntry(src, destDir, newName) {
    if (src.kind === 'file') {
      var f = await src.getFile(), nh = await destDir.getFileHandle(newName, { create: true });
      var w = await nh.createWritable(); await w.write(f); await w.close();
    } else {
      var nd = await destDir.getDirectoryHandle(newName, { create: true });
      for await (var e of src.values()) await copyEntry(e, nd, e.name);
    }
  }
  async function renameNode(n) {
    if (n.path === '') return;
    var nn = prompt('新名称：', n.name); if (!nn) return;
    nn = nn.trim(); if (!nn || nn === n.name) return;
    if (badName(nn)) { alert('名称里不能有 \\ / : * ? " < > |'); return; }
    var parent = nodeMap[parentPath(n.path)];
    if (!parent.children) await loadChildren(parent);
    if (parent.children.some(function (c) { return c !== n && c.name.toLowerCase() === nn.toLowerCase(); })) { alert('这里已经有同名的文件或文件夹'); return; }
    var affected = cur && (cur.path === n.path || cur.path.indexOf(n.path + '/') === 0);
    if (affected && !(await confirmLeave())) return;
    var oldP = n.path, newP = (parent.path ? parent.path + '/' : '') + nn, wasCur = affected ? cur.path : null;
    try {
      var moved = false;
      if (!window.__noMove && n.handle.move) { try { await n.handle.move(nn); moved = true; } catch (e) { moved = false; } }
      if (!moved) { await copyEntry(n.handle, parent.handle, nn); await parent.handle.removeEntry(n.name, { recursive: true }); }
    } catch (e) { alert('重命名失败：' + e.message); return; }
    var ns = {};
    Object.keys(openSet).forEach(function (k) {
      if (k === oldP) ns[newP] = true; else if (k.indexOf(oldP + '/') === 0) ns[newP + k.slice(oldP.length)] = true; else ns[k] = true;
    });
    openSet = ns; dropStale(oldP);
    if (affected) { cur = null; ed.value = ''; lastSaved = ''; setDirty(false); }
    parent.children = null; await expandOpen();
    if (wasCur) { var nd = await nodeByPath(newP + wasCur.slice(oldP.length)); if (nd) await openNode(nd); }
    toast('已重命名' + (/\.md$/i.test(nn) || n.kind === 'directory' ? '（文章里引用它的链接不会自动更新）' : ''));
  }

  /* ---------- 打开 / 保存 ---------- */
  async function confirmLeave() {
    if (!dirty) return true;
    if (confirm('当前文件有未保存的修改。\n确定 = 先保存再继续；取消 = 留在当前文件。')) return await save();
    return false;
  }
  function slugOf(n) {
    var base = n.name.replace(/\.[^.]+$/, '');
    if (base === 'index') { var seg = n.path.split('/'); base = seg.length > 1 ? seg[seg.length - 2] : 'index'; }
    return base;
  }
  async function openNode(n, jump) {
    if (cur && cur.path === n.path) { if (jump) doJump(jump); return; }
    var isImg = IMG_EXT.test(n.name);
    if (!isImg && !maybeText(n.name)) { toast('这种文件不能在这里打开（二进制文件）'); return; }
    if (!(await confirmLeave())) return;
    var f = await n.handle.getFile();
    if (isImg) {
      cur = { fh: n.handle, path: n.path, slug: slugOf(n), type: 'image' };
      ed.value = ''; ed.readOnly = true; lastSaved = ''; setDirty(false);
      if (document.body.classList.contains('m-edit')) setMode('m-split');
      doc.innerHTML = '<p class="head">' + esc(n.path) + '（图片预览，' + Math.round(f.size / 1024) + ' KB）</p><img src="' + URL.createObjectURL(f) + '">';
      drawSide(); status(); return;
    }
    if (f.size > 2 * 1024 * 1024) { toast('文件太大，不打开'); return; }
    var rd = await readText(f);
    if (!rd) { toast('这不是文本文件，无法打开'); return; }
    var text = rd.text.replace(/\r\n?/g, '\n');
    cur = { fh: n.handle, path: n.path, slug: slugOf(n), type: /\.(md|markdown)$/i.test(n.name) ? 'md' : 'text', enc: rd.enc, gbkOk: false };
    ed.readOnly = false; ed.value = text; lastSaved = text; setDirty(false);
    ed.scrollTop = 0; ed.setSelectionRange(0, 0);
    lsSet('last:' + treeRoot.name, n.path);
    drawSide(); renderNow(); status();
    if (jump) doJump(jump); else ed.focus();
  }
  async function save() {
    if (!cur) { toast('还没有打开文件'); return false; }
    if (cur.type === 'image') { toast('图片是只读的'); return false; }
    if (cur.enc === 'gbk' && !cur.gbkOk) {
      if (!confirm('这个文件原来是 GBK（ANSI）编码。\n保存会把它转成 UTF-8，之后在老软件里可能显示乱码。\n确定要保存吗？')) return false;
      cur.gbkOk = true;
    }
    try {
      var w = await cur.fh.createWritable();
      await w.write(ed.value); await w.close();
      lastSaved = ed.value; setDirty(false); toast('已保存'); return true;
    } catch (e) { alert('保存失败：' + e.message); return false; }
  }
  function setDirty(v) { dirty = v; $('s-dirty').textContent = v ? '● 未保存' : (cur ? '已保存' : ''); $('s-dirty').className = v ? 'dirty' : ''; title(); }
  function title() { document.title = (dirty ? '● ' : '') + (cur ? cur.path.split('/').pop() + ' — ' : '') + '工坊写作'; }
  function status() {
    $('s-file').textContent = cur ? (treeRoot.name + '\\' + cur.path.replace(/\//g, '\\')) : '未打开文件';
    $('s-count').textContent = cur && cur.type !== 'image' ? ed.value.replace(/\s/g, '').length + ' 字' : '';
    $('b-save').disabled = !cur || cur.type === 'image'; title();
  }

  /* ---------- 新建文章（顶栏） ---------- */
  async function newPost() {
    if (!srcDir) { toast(treeRoot ? '这个文件夹不是博客（没有 _posts），不能新建文章。可以在文件树里右键新建文件' : '请先打开文件夹'); return; }
    if (!(await confirmLeave())) return;
    var t = prompt('文章标题（中文可以）：'); if (!t) return; t = t.trim(); if (!t) return;
    var def = /^[\x20-\x7e]+$/.test(t) ? t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : 'post-' + nowStr().slice(0, 10);
    var slug = prompt('文件名（用英文、数字、短横线；它会变成网址的一部分）：', def); if (!slug) return;
    slug = slug.trim().replace(/\.md$/i, '').replace(/[\\/:*?"<>|\s]+/g, '-'); if (!slug) return;
    var postsRel = (srcRel ? srcRel + '/' : '') + '_posts';
    var posts = await sub(srcDir, '_posts');
    try { await posts.getFileHandle(slug + '.md'); alert('已经有同名文件：' + slug + '.md'); return; } catch (e) {}
    var fh = await posts.getFileHandle(slug + '.md', { create: true });
    var tpl = '---\ntitle: ' + t + '\ndate: ' + nowStr() + '\ncategories: 开发日志\ntags: []\n---\n\n';
    var w = await fh.createWritable(); await w.write(tpl); await w.close();
    openSet[postsRel] = true; await refreshList();
    var pn = nodeMap[postsRel]; if (pn && !pn.children) await loadChildren(pn);
    var x = nodeMap[postsRel + '/' + slug + '.md'];
    cur = null; await openNode(x);
    ed.setSelectionRange(ed.value.length, ed.value.length); ed.focus();
  }

  /* ---------- 搜索 ---------- */
  var seq = 0, caseSens = false;
  function snippet(line, idx, len) {
    var a = Math.max(0, idx - 24), b = Math.min(line.length, idx + len + 56);
    return (a > 0 ? '…' : '') + esc(line.slice(a, idx)) + '<mark>' + esc(line.slice(idx, idx + len)) + '</mark>' + esc(line.slice(idx + len, b)) + (b < line.length ? '…' : '');
  }
  async function collect(dir, path, out, root0) {
    for await (var e of dir.values()) {
      if (hidden(e.name, root0)) continue;
      var p = path ? path + '/' + e.name : e.name;
      out.push({ h: e, path: p, name: e.name, kind: e.kind });
      if (e.kind === 'directory' && out.length < 5000) await collect(e, p, out, false);
    }
  }
  async function doSearch() {
    var q = $('q').value, info = $('qinfo'), res = $('res'), my = ++seq;
    res.innerHTML = '';
    if (!treeRoot) { info.textContent = '请先打开文件夹'; return; }
    if (!q) { info.textContent = ''; return; }
    info.textContent = '搜索中…';
    var all = []; await collect(treeRoot, '', all, true);
    if (my !== seq) return;
    var needle = caseSens ? q : q.toLowerCase(), total = 0, files = 0, cap = false;
    var nameHits = all.filter(function (x) { return (caseSens ? x.name : x.name.toLowerCase()).indexOf(needle) >= 0; }).slice(0, 50);
    if (nameHits.length) {
      var h = document.createElement('div'); h.className = 'rf'; h.style.cursor = 'default'; h.innerHTML = ic('search') + '文件名匹配（' + nameHits.length + '）'; res.appendChild(h);
      nameHits.forEach(function (x) {
        var d = document.createElement('div'); d.className = 'rl'; d.textContent = x.path; d.title = x.path;
        d.onclick = async function () { var n = await nodeByPath(x.path); if (n && n.kind === 'file') { drawSide(); openNode(n); } else if (n) { openSet[n.path] = true; if (!n.children) await loadChildren(n); drawSide(); showPanel('files'); } };
        res.appendChild(d);
      });
    }
    for (var i = 0; i < all.length && !cap; i++) {
      var x = all[i]; if (x.kind !== 'file' || !maybeText(x.name)) continue;
      var text;
      if (cur && cur.path === x.path && cur.type !== 'image') text = ed.value;
      else { try { var f = await x.h.getFile(); if (f.size > 1024 * 1024) continue; var rr = await readText(f); if (!rr) continue; text = rr.text; } catch (e) { continue; } }
      if (my !== seq) return;
      var lines = text.replace(/\r\n?/g, '\n').split('\n'), hits = [];
      for (var li = 0; li < lines.length && hits.length < 20; li++) {
        var idx = (caseSens ? lines[li] : lines[li].toLowerCase()).indexOf(needle);
        if (idx >= 0) hits.push({ line: li + 1, idx: idx, text: lines[li] });
      }
      if (!hits.length) continue;
      files++; total += hits.length;
      var fh = document.createElement('div'); fh.className = 'rf'; fh.innerHTML = iconFor({ kind: 'file', name: x.name }) + '<span>' + esc(x.path) + '</span>'; res.appendChild(fh);
      (function (path) { fh.onclick = async function () { var n = await nodeByPath(path); if (n) { drawSide(); openNode(n); } }; })(x.path);
      hits.forEach(function (hh) {
        var d = document.createElement('div'); d.className = 'rl';
        d.innerHTML = '<b>' + hh.line + '</b>' + snippet(hh.text, hh.idx, q.length);
        (function (path, hit) { d.onclick = async function () { var n = await nodeByPath(path); if (n) { drawSide(); openNode(n, { line: hit.line, idx: hit.idx, len: q.length }); } }; })(x.path, hh);
        res.appendChild(d);
      });
      if (total >= 500) cap = true;
    }
    info.textContent = (files || nameHits.length) ? ('找到 ' + total + ' 处内容匹配，分布在 ' + files + ' 个文件' + (cap ? '（结果过多，只显示前面一部分）' : '') + (nameHits.length ? '；另有 ' + nameHits.length + ' 个文件名匹配' : '')) : '没有找到';
  }
  function doJump(j) {
    if (document.body.classList.contains('m-read')) setMode('m-split');
    var lines = ed.value.split('\n'), pos = 0;
    for (var i = 0; i < j.line - 1; i++) pos += lines[i].length + 1;
    ed.focus(); ed.setSelectionRange(pos + j.idx, pos + j.idx + j.len);
    var lh = parseFloat(getComputedStyle(ed).lineHeight) || 26;
    ed.scrollTop = Math.max(0, (j.line - 1) * lh - ed.clientHeight / 3);
  }
  function showPanel(p) {
    var same = !document.body.classList.contains('noside') && document.querySelector('#act [data-p].on') && document.querySelector('#act [data-p].on').getAttribute('data-p') === p;
    if (same && arguments[1] !== 'force') { document.body.classList.add('noside'); document.querySelectorAll('#act [data-p]').forEach(function (b) { b.classList.remove('on'); }); return; }
    document.body.classList.remove('noside');
    document.querySelectorAll('#act [data-p]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-p') === p); });
    $('files').hidden = p !== 'files'; $('searchpane').hidden = p !== 'search';
    if (p === 'search') { $('q').focus(); $('q').select(); }
  }
  document.querySelectorAll('#act [data-p]').forEach(function (b) { b.onclick = function () { showPanel(b.getAttribute('data-p')); }; });
  var qT; $('q').addEventListener('input', function () { clearTimeout(qT); qT = setTimeout(doSearch, 300); });
  $('q').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.isComposing) { clearTimeout(qT); doSearch(); } });
  $('q-case').onclick = function () { caseSens = !caseSens; this.classList.toggle('on', caseSens); doSearch(); };
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); showPanel('search', 'force'); }
  });

  /* ---------- 渲染与预览 ---------- */
  function welcome() {
    doc.innerHTML = '<div class="welcome"><img src="icon.svg" alt=""><h2>工坊写作</h2><p>' + (treeRoot ? '从左边的文件树里选一篇文章，或者新建一篇。' : '先选择你的博客文件夹，就能开始写了。') + '</p>' +
      (treeRoot ? '<button id="w-new">' + ic('file-plus') + '新文章</button>' : '<button id="w-open">' + ic('folder-open') + '打开文件夹</button>') + '<p style="margin-top:22px;font-size:12px">Ctrl+Shift+F 搜索 · 右键文件树可重命名' + (NATIVE ? ' · 在资源管理器里右键任意文件可直接用本软件打开' : '') + '</p></div>';
    var a = $('w-new'), b = $('w-open'); if (a) a.onclick = newPost; if (b) b.onclick = openFolder;
  }
  function renderNow() {
    if (!cur) { welcome(); return; }
    if (cur.type === 'image') return;
    if (cur.type === 'text') { doc.innerHTML = '<p class="head">' + esc(cur.path) + '（' + (cur.enc === 'gbk' ? 'GBK 编码，' : '') + '纯文本，无预览效果）</p><pre><code>' + esc(ed.value) + '</code></pre>'; return; }
    var r = MD.render(ed.value), head = '';
    if (r.title) head += '<h1>' + esc(r.title) + '</h1>';
    var chips = [];
    if (r.date) chips.push('<span>' + esc(r.date) + '</span>');
    if (r.categories) chips.push('<span>分类：' + esc(r.categories) + '</span>');
    if (r.tags && r.tags !== '[]') chips.push('<span>标签：' + esc(r.tags.replace(/[\[\]]/g, '')) + '</span>');
    if (chips.length) head += '<div class="head">' + chips.join('') + '</div>';
    var html = r.html.replace(/src="(\/img\/[^"]+)"/g, function (m, u) { return imgCache[u] ? 'src="' + imgCache[u] + '"' : 'data-local="' + u + '"'; });
    doc.innerHTML = head + html;
    doc.querySelectorAll('img[data-local]').forEach(resolveImg);
    doc.querySelectorAll('a').forEach(function (a) { a.addEventListener('click', function (e) { if (a.getAttribute('href') === '#') e.preventDefault(); }); });
  }
  async function resolveImg(img) {
    var u = img.getAttribute('data-local');
    if (!srcDir || !u) return;
    try {
      var parts = u.replace(/^\//, '').split('/'), d = srcDir;
      for (var i = 0; i < parts.length - 1; i++) d = await d.getDirectoryHandle(decodeURIComponent(parts[i]));
      var fh = await d.getFileHandle(decodeURIComponent(parts[parts.length - 1]));
      imgCache[u] = URL.createObjectURL(await fh.getFile());
      img.src = imgCache[u];
    } catch (e) { img.alt = '（找不到图片 ' + u + '）'; }
  }
  function schedule() {
    setDirty(ed.value !== lastSaved); status();
    clearTimeout(renderTimer); renderTimer = setTimeout(renderNow, 80);
    clearTimeout(autoTimer);
    if ($('c-auto').checked && cur && dirty) autoTimer = setTimeout(save, 1500);
  }

  /* ---------- 编辑辅助 ---------- */
  function insert(text) {
    ed.focus();
    if (!document.execCommand('insertText', false, text)) ed.setRangeText(text, ed.selectionStart, ed.selectionEnd, 'end');
    schedule();
  }
  function wrap(b, a, ph) {
    var s = ed.selectionStart, e = ed.selectionEnd, sel = ed.value.slice(s, e) || ph;
    insert(b + sel + a);
    ed.setSelectionRange(s + b.length, s + b.length + sel.length);
  }
  function linePrefix(prefix, strip) {
    var v = ed.value, s = ed.selectionStart, e = ed.selectionEnd;
    var ls = v.lastIndexOf('\n', s - 1) + 1, le = v.indexOf('\n', e); if (le < 0) le = v.length;
    var lines = v.slice(ls, le).split('\n');
    var allHave = lines.every(function (l) { return l.indexOf(prefix) === 0; });
    var out = lines.map(function (l) { l = l.replace(strip, ''); return allHave ? l : prefix + l; });
    ed.setSelectionRange(ls, le); insert(out.join('\n'));
    ed.setSelectionRange(ls, ls + out.join('\n').length);
  }
  function numbered() {
    var v = ed.value, s = ed.selectionStart, e = ed.selectionEnd;
    var ls = v.lastIndexOf('\n', s - 1) + 1, le = v.indexOf('\n', e); if (le < 0) le = v.length;
    var n = 0, out = v.slice(ls, le).split('\n').map(function (l) { return (++n) + '. ' + l.replace(/^\s*\d+[.)]\s+/, ''); }).join('\n');
    ed.setSelectionRange(ls, le); insert(out);
  }
  async function saveImage(file) {
    if (!srcDir) { toast(treeRoot ? '这个文件夹不是博客（没有 _posts），无法自动存图' : '请先打开文件夹'); return; }
    if (!cur || cur.type !== 'md') { toast('请先打开一篇 Markdown 文章再插入图片'); return; }
    var d = new Date(), ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '');
    var name = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '-' + Math.floor(Math.random() * 900 + 100) + '.' + ext;
    var img = await sub(srcDir, 'img', true), dir = await sub(img, cur.slug, true);
    var fh = await dir.getFileHandle(name, { create: true });
    var w = await fh.createWritable(); await w.write(file); await w.close();
    insert('![](/img/' + cur.slug + '/' + name + ')');
    toast('图片已保存到 img\\' + cur.slug + '\\' + name);
    if (rootNode) { var dn = await nodeByPath((srcRel ? srcRel + '/' : '') + 'img/' + cur.slug, true); if (dn) { dn.children = null; if (openSet[dn.path]) { await loadChildren(dn); drawSide(); } } }
  }

  var FMT = [
    ['H1', '一级标题', function () { linePrefix('# ', /^#{1,6}\s+/); }],
    ['H2', '二级标题', function () { linePrefix('## ', /^#{1,6}\s+/); }],
    ['H3', '三级标题', function () { linePrefix('### ', /^#{1,6}\s+/); }],
    null,
    ['bold', '粗体 Ctrl+B', function () { wrap('**', '**', '粗体'); }],
    ['italic', '斜体 Ctrl+I', function () { wrap('*', '*', '斜体'); }],
    ['strike', '删除线', function () { wrap('~~', '~~', '删除线'); }],
    ['code', '行内代码', function () { wrap('`', '`', 'code'); }],
    ['link', '链接 Ctrl+K', function () { var s = ed.selectionStart, e = ed.selectionEnd, t = ed.value.slice(s, e) || '链接文字'; insert('[' + t + '](https://)'); ed.setSelectionRange(s + t.length + 3, s + t.length + 11); }],
    ['image', '插入图片', function () { $('file').click(); }],
    null,
    ['quote', '引用', function () { linePrefix('> ', /^>\s?/); }],
    ['list', '无序列表', function () { linePrefix('- ', /^\s*[-*+]\s+/); }],
    ['list-ordered', '有序列表', numbered],
    ['check-square', '任务列表', function () { linePrefix('- [ ] ', /^\s*-\s\[[ xX]\]\s+/); }],
    ['code-block', '代码块', function () { var s = ed.selectionStart, t = ed.value.slice(s, ed.selectionEnd); insert('```\n' + t + '\n```\n'); ed.setSelectionRange(s + 4, s + 4 + t.length); }],
    ['table', '表格', function () { insert('| 列1 | 列2 |\n| --- | --- |\n|  |  |\n'); }],
    ['minus', '分隔线', function () { insert('\n---\n'); }],
    ['cut', '摘要分隔（首页只显示到此）', function () { insert('\n<!-- more -->\n'); }]
  ];
  var FIDX = {};
  FMT.forEach(function (f) {
    if (!f) { var s = document.createElement('span'); s.className = 'sep'; $('fmt').appendChild(s); return; }
    var b = document.createElement('button');
    if (/^H\d$/.test(f[0])) b.textContent = f[0]; else b.innerHTML = ic(f[0]);
    b.title = f[1]; FIDX[f[0]] = f[2];
    b.onmousedown = function (e) { e.preventDefault(); }; b.onclick = function () { if (cur && cur.type !== 'image') f[2](); };
    $('fmt').appendChild(b);
  });
  var fileIn = document.createElement('input'); fileIn.type = 'file'; fileIn.accept = 'image/*'; fileIn.id = 'file'; fileIn.style.display = 'none';
  fileIn.onchange = function () { if (fileIn.files[0]) saveImage(fileIn.files[0]); fileIn.value = ''; };
  document.body.appendChild(fileIn);

  ed.addEventListener('input', schedule);
  ed.addEventListener('keydown', function (e) {
    if (e.isComposing || e.keyCode === 229) return;
    var k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && k === 's') { e.preventDefault(); save(); return; }
    if (mod && !e.shiftKey && k === 'b') { e.preventDefault(); FIDX.bold(); return; }
    if (mod && !e.shiftKey && k === 'i') { e.preventDefault(); FIDX.italic(); return; }
    if (mod && !e.shiftKey && k === 'k') { e.preventDefault(); FIDX.link(); return; }
    if (e.key === 'Tab') { e.preventDefault(); insert('  '); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && ed.selectionStart === ed.selectionEnd) {
      var v = ed.value, p = ed.selectionStart, ls = v.lastIndexOf('\n', p - 1) + 1, line = v.slice(ls, p);
      var m = line.match(/^(\s*)(?:([-*+])|(\d+)[.)])\s+(\[[ xX]\]\s+)?(.*)$/);
      var nl = v.indexOf('\n', p);
      if (m && (nl === p || (nl < 0 && p === v.length))) {
        e.preventDefault();
        if (!m[5]) { ed.setSelectionRange(ls, p); if (!document.execCommand('delete')) ed.setRangeText('', ls, p, 'end'); schedule(); return; }
        var mark = m[2] ? m[2] : (parseInt(m[3], 10) + 1) + '.';
        insert('\n' + m[1] + mark + ' ' + (m[4] ? '[ ] ' : ''));
      }
    }
  });
  document.addEventListener('keydown', function (e) { if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 's' && e.target !== ed) { e.preventDefault(); save(); } });
  ed.addEventListener('paste', function (e) {
    var items = e.clipboardData && e.clipboardData.items || [];
    for (var i = 0; i < items.length; i++) if (items[i].type.indexOf('image/') === 0) { e.preventDefault(); saveImage(items[i].getAsFile()); return; }
  });
  var dropEl = $('drop');
  window.addEventListener('dragover', function (e) { e.preventDefault(); dropEl.style.display = 'block'; });
  window.addEventListener('dragleave', function (e) { if (!e.relatedTarget) dropEl.style.display = 'none'; });
  window.addEventListener('drop', function (e) {
    e.preventDefault(); dropEl.style.display = 'none';
    Array.prototype.forEach.call(e.dataTransfer.files, function (f) { if (f.type.indexOf('image/') === 0) saveImage(f); });
  });
  ed.addEventListener('scroll', function () {
    if (!document.body.classList.contains('m-split')) return;
    var r = ed.scrollTop / Math.max(1, ed.scrollHeight - ed.clientHeight);
    $('pv').scrollTop = r * ($('pv').scrollHeight - $('pv').clientHeight);
  });

  /* ---------- 顶栏与杂项 ---------- */
  function setMode(m) {
    document.body.classList.remove('m-edit', 'm-split', 'm-read'); document.body.classList.add(m); lsSet('mode', m);
    document.querySelectorAll('[data-m]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-m') === m); });
  }
  document.querySelectorAll('[data-m]').forEach(function (b) { b.onclick = function () { setMode(b.getAttribute('data-m')); }; });
  setMode(lsGet('mode', 'm-split'));
  $('c-auto').checked = lsGet('auto', '0') === '1';
  $('c-auto').onchange = function () { lsSet('auto', this.checked ? '1' : '0'); };
  $('b-save').onclick = save;
  $('b-new').onclick = newPost;
  $('t-file').onclick = function () { if (rootNode) newFile(selDir || rootNode); else toast('请先打开文件夹'); };
  $('t-dir').onclick = function () { if (rootNode) newFolder(selDir || rootNode); else toast('请先打开文件夹'); };
  $('t-ref').onclick = function () { if (treeRoot) refreshList().then(function () { toast('已刷新'); }); };
  $('t-col').onclick = function () { if (rootNode) { openSet = { '': true }; drawSide(); } };
  var helpEl = $('help');
  $('b-help').onclick = function () { helpEl.style.display = 'flex'; };
  helpEl.onclick = function () { helpEl.style.display = 'none'; };
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') helpEl.style.display = 'none'; });

  /* ---------- 可拖动的分栏 ---------- */
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function applySizes() {
    var sw = parseFloat(lsGet('w-side', '')), ew = parseFloat(lsGet('w-ed', ''));
    if (sw) document.documentElement.style.setProperty('--side-w', clamp(sw, 160, 600) + 'px');
    if (ew) document.documentElement.style.setProperty('--ed-w', clamp(ew, 20, 80) + '%');
  }
  function gutter(id, onMove, reset) {
    var g = $(id);
    g.addEventListener('pointerdown', function (e) {
      e.preventDefault(); g.setPointerCapture(e.pointerId); g.classList.add('drag'); document.body.classList.add('dragging');
    });
    g.addEventListener('pointermove', function (e) { if (g.classList.contains('drag')) onMove(e); });
    function end(e) { if (!g.classList.contains('drag')) return; g.classList.remove('drag'); document.body.classList.remove('dragging'); try { g.releasePointerCapture(e.pointerId); } catch (x) {} }
    g.addEventListener('pointerup', end); g.addEventListener('pointercancel', end);
    g.addEventListener('dblclick', reset);
  }
  gutter('g-side', function (e) {
    var w = clamp(e.clientX - $('act').getBoundingClientRect().right, 160, Math.min(600, innerWidth - 400));
    document.documentElement.style.setProperty('--side-w', w + 'px'); lsSet('w-side', w);
  }, function () { document.documentElement.style.removeProperty('--side-w'); lsSet('w-side', ''); });
  gutter('g-pv', function (e) {
    var r = $('main').getBoundingClientRect(), p = clamp((e.clientX - r.left) / r.width * 100, 20, 80);
    document.documentElement.style.setProperty('--ed-w', p + '%'); lsSet('w-ed', p);
  }, function () { document.documentElement.style.removeProperty('--ed-w'); lsSet('w-ed', ''); });
  applySizes();

  async function openFolder() {
    if (!window.showDirectoryPicker) { alert('当前浏览器不支持直接读写文件夹，请用 Edge 或 Chrome 打开（双击「打开编辑器.bat」即可）。'); return; }
    var saved = await idbGet('dir');
    try {
      if (saved && !srcDir) {
        var p = await saved.requestPermission({ mode: 'readwrite' });
        if (p === 'granted' && await useFolder(saved, true)) { renderNow(); return; }
      }
      var d = await window.showDirectoryPicker({ mode: 'readwrite', id: 'blog-source' });
      if (await confirmLeave()) { cur = null; ed.value = ''; lastSaved = ''; setDirty(false); await useFolder(d, false); renderNow(); status(); }
    } catch (e) { if (e.name !== 'AbortError') alert('打开失败：' + e.message); }
  }
  $('b-open').onclick = openFolder;
  window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  /* 外部要求打开某个路径（资源管理器右键 / 再次启动时转交） */
  async function openExternal(p) {
    var info; try { info = await GF.resolve(p); } catch (e) { toast('打不开：' + p); return; }
    async function switchTo(rootPath) {
      if (!treeRoot || treeRoot.path !== rootPath) {
        if (!(await confirmLeave())) return false;
        cur = null; ed.value = ''; ed.readOnly = false; lastSaved = ''; setDirty(false);
        await useFolder(new GF.RDir(rootPath), false);
      }
      return true;
    }
    if (!(await switchTo(info.root))) return;
    if (info.kind === 'file') {
      var n = await nodeByPath(info.rel);
      if (!n) {                                   // 文件在被隐藏的目录里（如 node_modules）：改用它所在的文件夹作根
        if (!(await switchTo(info.dir))) return;
        n = await nodeByPath(info.rel.split('/').pop());
      }
      drawSide(); if (n) await openNode(n);
    }
    renderNow(); status();
    try { window.focus(); } catch (e) {}
  }

  (async function init() {
    drawSide(); renderNow(); status();
    if (NATIVE) {
      var ini = await GF.init();
      if (ini.open && ini.open.length) { for (var oi = 0; oi < ini.open.length; oi++) await openExternal(ini.open[oi]); }
      else { var last = await idbGet('dir'); if (last) { try { await useFolder(last, true); renderNow(); status(); } catch (e) {} } }
      GF.start(openExternal);
      window.__ready = true; return;
    }
    var saved = await idbGet('dir');
    if (saved) {
      try {
        if ((await saved.queryPermission({ mode: 'readwrite' })) === 'granted') { await useFolder(saved, true); renderNow(); status(); }
        else $('b-open-t').textContent = '继续「' + saved.name + '」';
      } catch (e) {}
    }
    window.__ready = true;
  })();

  window.__editor = { openExternal: openExternal, save: save, openNode: openNode, node: function (p) { return nodeMap[p]; }, cur: function () { return cur; }, nodeByPath: nodeByPath };
})();
