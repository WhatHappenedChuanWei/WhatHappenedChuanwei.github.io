/* SPDX-License-Identifier: MIT · Copyright (c) 2026 Chuanwei · 见同目录 LICENSE */
/* 极简 Markdown 渲染器（零依赖）。支持：标题、段落、粗体/斜体/删除线、行内代码、
   代码块、链接、图片、引用、有序/无序/任务列表（可嵌套）、表格、分隔线、Hexo front-matter。
   原始 HTML 一律转义显示（Hexo 里能用，这里只做预览）。 */
(function (root) {
  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function safeUrl(u) { return /^\s*(javascript|vbscript|data):/i.test(u) && !/^\s*data:image\//i.test(u) ? '#' : u; }

  function inline(s) {
    var st = [];
    function put(h) { st.push(h); return '\u0001' + (st.length - 1) + '\u0002'; }
    s = s.replace(/`([^`]+)`/g, function (m, c) { return put('<code>' + esc(c) + '</code>'); });
    s = s.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)/g, function (m, a, u, t) {
      return put('<img alt="' + esc(a) + '" src="' + esc(safeUrl(u)) + '"' + (t ? ' title="' + esc(t) + '"' : '') + '>');
    });
    s = s.replace(/\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)/g, function (m, a, u, t) {
      return put('<a href="' + esc(safeUrl(u)) + '"' + (t ? ' title="' + esc(t) + '"' : '') + ' target="_blank" rel="noopener">' + inline(a) + '</a>');
    });
    s = esc(s);
    s = s.replace(/(^|[\s(（])(https?:\/\/[^\s<)）]+)/g, function (m, p, u) {
      return p + put('<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>');
    });
    s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*(?=\S)([^*]*?\S)\*/g, '<em>$1</em>');
    s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
    var guard = 0;
    while (/\u0001\d+\u0002/.test(s) && guard++ < 10) {
      s = s.replace(/\u0001(\d+)\u0002/g, function (m, i) { return st[+i]; });
    }
    return s;
  }

  var LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  var HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
  var SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

  function isBlank(l) { return /^\s*$/.test(l); }
  function startsBlock(l) {
    return /^#{1,6}\s/.test(l) || /^\s*```/.test(l) || /^\s*>/.test(l) || LIST_RE.test(l) || HR_RE.test(l);
  }
  function splitRow(l) {
    l = l.trim().replace(/^\|/, '').replace(/\|$/, '');
    return l.split(/(?<!\\)\|/).map(function (c) { return c.trim().replace(/\\\|/g, '|'); });
  }

  function parseList(lines, i) {
    var first = lines[i].match(LIST_RE);
    var base = first[1].length;
    var ordered = /\d/.test(first[2]);
    var start = ordered ? parseInt(first[2], 10) : 1;
    var items = [];
    while (i < lines.length) {
      var l = lines[i];
      var mm = l.match(LIST_RE);
      if (isBlank(l)) {
        var j = i + 1;
        while (j < lines.length && isBlank(lines[j])) j++;
        if (j < lines.length) {
          var nm = lines[j].match(LIST_RE);
          var ind = lines[j].match(/^\s*/)[0].length;
          if ((nm && nm[1].length >= base) || (!nm && ind > base)) {
            if (items.length && ind > base) items[items.length - 1].sub.push('');
            i = j; continue;
          }
        }
        break;
      }
      if (mm && mm[1].length === base) { items.push({ text: mm[3], sub: [] }); i++; }
      else if (items.length && (mm ? mm[1].length > base : /^\s+\S/.test(l))) { items[items.length - 1].sub.push(l); i++; }
      else break;
    }
    var html = items.map(function (it) {
      var text = it.text, pre = '';
      var t = text.match(/^\[( |x|X)\]\s+(.*)$/);
      if (t) { pre = '<input type="checkbox" disabled' + (t[1] !== ' ' ? ' checked' : '') + '> '; text = t[2]; }
      var subHtml = '';
      if (it.sub.length) {
        var min = Infinity;
        it.sub.forEach(function (x) { if (!isBlank(x)) min = Math.min(min, x.match(/^\s*/)[0].length); });
        if (min === Infinity) min = 0;
        subHtml = blocks(it.sub.map(function (x) { return x.slice(Math.min(min, x.match(/^\s*/)[0].length)); })).join('');
      }
      return '<li' + (t ? ' class="task"' : '') + '>' + pre + inline(text) + subHtml + '</li>';
    }).join('');
    var tag = ordered ? 'ol' : 'ul';
    return { html: '<' + tag + (ordered && start !== 1 ? ' start="' + start + '"' : '') + '>' + html + '</' + tag + '>', next: i };
  }

  function blocks(lines) {
    var out = [], i = 0, m;
    while (i < lines.length) {
      var l = lines[i];
      if (isBlank(l)) { i++; continue; }
      if ((m = l.match(/^\s*```+\s*([\w+#.-]*)/))) {
        var code = []; i++;
        while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) code.push(lines[i++]);
        i++;
        out.push('<pre><code' + (m[1] ? ' class="lang-' + esc(m[1]) + '" data-lang="' + esc(m[1]) + '"' : '') + '>' + esc(code.join('\n')) + '</code></pre>');
        continue;
      }
      if ((m = l.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/))) {
        out.push('<h' + m[1].length + '>' + inline(m[2]) + '</h' + m[1].length + '>'); i++; continue;
      }
      if (HR_RE.test(l)) { out.push('<hr>'); i++; continue; }
      if (/^\s*<!--\s*more\s*-->\s*$/.test(l)) { out.push('<div class="more">摘要分隔线（首页只显示到这里）</div>'); i++; continue; }
      if (/^\s*<!--.*-->\s*$/.test(l)) { i++; continue; }
      if (/^\s*>/.test(l)) {
        var q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push('<blockquote>' + blocks(q).join('') + '</blockquote>');
        continue;
      }
      if (l.indexOf('|') >= 0 && i + 1 < lines.length && SEP_RE.test(lines[i + 1]) && lines[i + 1].indexOf('-') >= 0) {
        var head = splitRow(l);
        var al = splitRow(lines[i + 1]).map(function (c) {
          return /^:-+:$/.test(c) ? 'center' : /^-+:$/.test(c) ? 'right' : /^:-+$/.test(c) ? 'left' : '';
        });
        i += 2;
        var rows = [];
        while (i < lines.length && !isBlank(lines[i]) && lines[i].indexOf('|') >= 0) rows.push(splitRow(lines[i++]));
        var cell = function (tag, c, k) { return '<' + tag + (al[k] ? ' style="text-align:' + al[k] + '"' : '') + '>' + inline(c) + '</' + tag + '>'; };
        out.push('<table><thead><tr>' + head.map(function (c, k) { return cell('th', c, k); }).join('') + '</tr></thead><tbody>' +
          rows.map(function (r) { return '<tr>' + head.map(function (_, k) { return cell('td', r[k] || '', k); }).join('') + '</tr>'; }).join('') +
          '</tbody></table>');
        continue;
      }
      if (LIST_RE.test(l)) { var r = parseList(lines, i); out.push(r.html); i = r.next; continue; }
      var para = [l]; i++;
      while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i]) &&
             !(lines[i].indexOf('|') >= 0 && i + 1 < lines.length && SEP_RE.test(lines[i + 1]) && lines[i + 1].indexOf('-') >= 0)) para.push(lines[i++]);
      out.push('<p>' + para.map(function (x) { return inline(x.replace(/\s+$/, '')); }).join('<br>') + '</p>');
    }
    return out;
  }

  function splitFront(src) {
    src = src.replace(/\r\n?/g, '\n');
    var m = src.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(\n|$)/);
    if (!m) return { meta: '', body: src };
    return { meta: m[1], body: src.slice(m[0].length) };
  }
  function metaGet(meta, key) {
    var m = meta.match(new RegExp('^' + key + ':[ \\t]*(.*)$', 'm'));
    return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : '';
  }

  function render(src) {
    var f = splitFront(src);
    var html = blocks(f.body.split('\n')).join('\n');
    return { html: html, meta: f.meta, title: metaGet(f.meta, 'title'), date: metaGet(f.meta, 'date'),
             tags: metaGet(f.meta, 'tags'), categories: metaGet(f.meta, 'categories') };
  }

  var api = { render: render, esc: esc, inline: inline, splitFront: splitFront, metaGet: metaGet };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MD = api;
})(typeof window !== 'undefined' ? window : this);
