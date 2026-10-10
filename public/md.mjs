// Small, safe Markdown renderer (headings, tables, lists, code, quotes, inline) + citation linking.
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function sourcesFrom(md) {
  const map = {};
  const idx = md.search(/^#{1,4}\s*sources\b/im);
  const tail = idx >= 0 ? md.slice(idx) : md;
  for (const m of tail.matchAll(/^\s*(?:[-*]\s*)?\[(\d+)\].*?(https?:\/\/[^\s)<>\]]+)/gm)) map[m[1]] = m[2].replace(/[.,;]+$/, '');
  return map;
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function inline(s, cites) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = esc(s)
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;])/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
    .replace(/\[(\d+)\](?!\()/g, (m, n) => cites[n]
      ? `<a class="cite" href="${cites[n]}" target="_blank" rel="noopener" title="${hostOf(cites[n])}">${n}</a>` : m);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[i])}</code>`);
}

export function renderMarkdown(md) {
  if (!md) return '';
  const cites = sourcesFrom(md);
  const lines = md.replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  const isTable = (j) => /^\s*\|.*\|\s*$/.test(lines[j] || '');
  while (i < lines.length) {
    const l = lines[i];
    let m;
    if (/^```/.test(l)) {
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
    } else if ((m = l.match(/^(#{1,6})\s+(.*)$/))) {
      const lv = Math.min(m[1].length + 1, 4);
      out.push(`<h${lv}>${inline(m[2], cites)}</h${lv}>`); i++;
    } else if (/^\s*([-*_])\1{2,}\s*$/.test(l)) { out.push('<hr>'); i++; }
    else if (isTable(i) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const row = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = row(lines[i]); i += 2;
      const body = [];
      while (isTable(i)) body.push(row(lines[i++]));
      out.push(`<div class="tbl"><table><thead><tr>${head.map((c) => `<th>${inline(c, cites)}</th>`).join('')}</tr></thead><tbody>${
        body.map((r) => `<tr>${r.map((c) => `<td>${inline(c, cites)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    } else if (/^\s*>\s?/.test(l)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${inline(buf.join(' '), cites)}</blockquote>`);
    } else if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items = [];
      while (i < lines.length && (/^\s*([-*]|\d+\.)\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        const li = lines[i++];
        const mm = li.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
        if (!mm) items[items.length - 1].text += ' ' + li.trim();
        else if (mm[1].length >= 2 && items.length) items[items.length - 1].sub.push(mm[3]);
        else items.push({ text: mm[3], sub: [] });
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((it) => `<li>${inline(it.text, cites)}${
        it.sub.length ? `<ul>${it.sub.map((s) => `<li>${inline(s, cites)}</li>`).join('')}</ul>` : ''}</li>`).join('')}</${tag}>`);
    } else if (!l.trim()) i++;
    else {
      const buf = [];
      while (i < lines.length && lines[i].trim() && !/^(```|#{1,6}\s|\s*>|\s*([-*]|\d+\.)\s+)/.test(lines[i]) && !isTable(i)) buf.push(lines[i++]);
      if (!buf.length) { buf.push(lines[i++]); }
      out.push(`<p>${inline(buf.join(' '), cites)}</p>`);
    }
  }
  return out.join('\n');
}
