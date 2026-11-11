// 에이전트 답의 마크다운 → DOM. innerHTML 을 쓰지 않고 노드를 직접 만들어서, 답에 든 HTML 은 글자 그대로 보인다.
// 다루는 것: 문단(줄바꿈 유지), 제목, 굵게·기울임·취소선·인라인 코드, 링크(http/https 만), 코드 블록, 목록(들여쓰기 중첩), 인용, 표, 가로줄.

const h = (tag, cls) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const isTableRow = (l) => l.includes('|');

export function renderMarkdown(text) {
  const root = h('div', 'md');
  blocks(String(text ?? '').replace(/\r\n?/g, '\n').split('\n'), root);
  return root;
}

function blocks(lines, into) {
  let para = [];
  const flush = () => {
    if (!para.length) return;
    const p = h('p');
    para.forEach((l, i) => {
      if (i) p.append(h('br'));
      inline(l, p);
    });
    into.append(p);
    para = [];
  };

  for (let i = 0; i < lines.length; ) {
    const line = lines[i];

    // 코드 블록: 닫는 줄이 없으면(아직 쓰는 중) 끝까지
    const f = line.match(FENCE);
    if (f) {
      flush();
      const body = [];
      let j = i + 1;
      const close = new RegExp(`^\\s*\\${f[1][0]}{${f[1].length},}\\s*$`);
      while (j < lines.length && !close.test(lines[j])) body.push(lines[j++]);
      const pre = h('pre');
      const code = h('code');
      if (f[2]) pre.dataset.lang = f[2];
      code.textContent = body.join('\n');
      pre.append(code);
      into.append(pre);
      i = j + 1;
      continue;
    }

    if (!line.trim()) { flush(); i++; continue; }

    const hd = line.match(HEADING);
    if (hd) {
      flush();
      const e = h(`h${Math.min(6, hd[1].length + 2)}`); // # → h3: 대화 글 크기에 맞춘다
      inline(hd[2], e);
      into.append(e);
      i++;
      continue;
    }

    if (HR.test(line)) {
      flush();
      into.append(h('hr'));
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      flush();
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].match(QUOTE)[1]);
      const q = h('blockquote');
      blocks(body, q);
      into.append(q);
      continue;
    }

    // 표: 머리줄 다음 줄이 구분선
    if (isTableRow(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      flush();
      const aligns = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
      const wrap = h('div', 'md-table');
      const table = h('table');
      const row = (src, tag) => {
        const tr = h('tr');
        cells(src).forEach((c, k) => {
          const td = h(tag);
          if (aligns[k]) td.style.textAlign = aligns[k];
          inline(c, td);
          tr.append(td);
        });
        return tr;
      };
      const thead = h('thead');
      thead.append(row(line, 'th'));
      const tbody = h('tbody');
      let j = i + 2;
      while (j < lines.length && lines[j].trim() && isTableRow(lines[j])) tbody.append(row(lines[j++], 'td'));
      table.append(thead, tbody);
      wrap.append(table);
      into.append(wrap);
      i = j;
      continue;
    }

    if (ITEM.test(line)) {
      flush();
      i = list(lines, i, into);
      continue;
    }

    para.push(line);
    i++;
  }
  flush();
}

/** 목록 하나: 같은 들여쓰기의 항목들, 더 들여쓴 줄은 그 항목 안(중첩 목록·이어지는 글) */
function list(lines, i, into) {
  const first = lines[i].match(ITEM);
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const ul = h(ordered ? 'ol' : 'ul');
  if (ordered && parseInt(first[2], 10) !== 1) ul.start = parseInt(first[2], 10);
  while (i < lines.length) {
    const m = lines[i].match(ITEM);
    if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) break;
    const li = h('li');
    const inner = [m[3]];
    i++;
    // 항목에 딸린 줄: 더 들여쓴 줄, 또는 빈 줄 뒤에 더 들여쓴 줄
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) {
        const next = lines[i + 1];
        if (next != null && next.trim() && lead(next) > indent) { inner.push(''); i++; continue; }
        break;
      }
      const im = l.match(ITEM);
      if (im && im[1].length <= indent) break;
      if (!im && lead(l) <= indent && !/^\s/.test(l)) {
        if (HEADING.test(l) || FENCE.test(l) || QUOTE.test(l) || HR.test(l) || isTableRow(l)) break;
        // 들여쓰지 않은 이어지는 글은 같은 항목의 다음 줄로 본다(목록 사이 문단은 빈 줄로 나뉜다)
        inner.push(l.trim());
        i++;
        continue;
      }
      inner.push(l.slice(Math.min(lead(l), indent + 2)));
      i++;
    }
    // 글 한 줄짜리 항목은 문단 없이, 여러 덩어리면 블록으로
    if (inner.length === 1) inline(inner[0], li);
    else {
      const sub = h('div');
      blocks(inner, sub);
      // 첫 문단은 감싸지 않고 바로(항목 사이 간격이 벌어지지 않게)
      const firstP = sub.firstChild;
      if (firstP?.tagName === 'P') { li.append(...firstP.childNodes); firstP.remove(); }
      li.append(...sub.childNodes);
    }
    ul.append(li);
  }
  into.append(ul);
  return i;
}

const lead = (l) => l.match(/^\s*/)[0].replace(/\t/g, '    ').length;

function cells(row) {
  let s = row.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const out = [];
  let cur = '';
  let code = false;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === '\\' && s[k + 1] === '|') { cur += '|'; k++; continue; }
    if (c === '`') code = !code;
    if (c === '|' && !code) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

// 인라인: 코드 → 링크 → 굵게 → 취소선 → 기울임 → 맨 주소. 코드 안은 더 풀지 않는다.
const INLINE = new RegExp(
  [
    '(`+)([^`]|[^`][\\s\\S]*?[^`])\\1(?!`)', // 1,2 코드
    '\\[([^\\]\\n]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)', // 3,4 링크
    '\\*\\*(?=\\S)([\\s\\S]*?\\S)\\*\\*', // 5 굵게
    '__(?=\\S)([\\s\\S]*?\\S)__(?![\\w])', // 6 굵게
    '~~(?=\\S)([\\s\\S]*?\\S)~~', // 7 취소선
    '(?<![\\w*])\\*(?=[^\\s*])([^*\\n]*?[^\\s*])\\*(?![\\w*])', // 8 기울임
    '(?<![\\w_])_(?=[^\\s_])([^_\\n]*?[^\\s_])_(?![\\w_])', // 9 기울임
    '(https?:\\/\\/[^\\s<>()\\[\\]]*[^\\s<>()\\[\\].,;:!?\'"])', // 10 맨 주소
  ].join('|'),
  'g',
);

function inline(s, into) {
  let at = 0;
  INLINE.lastIndex = 0;
  const parts = [];
  for (let m; (m = INLINE.exec(s)); ) {
    if (m.index > at) parts.push(s.slice(at, m.index));
    parts.push(m);
    at = m.index + m[0].length;
  }
  if (at < s.length) parts.push(s.slice(at));
  for (const p of parts) {
    if (typeof p === 'string') { into.append(document.createTextNode(p.replace(/\\([\\`*_~\[\]()#>|-])/g, '$1'))); continue; }
    let e;
    if (p[2] != null) {
      e = h('code');
      e.textContent = p[2].length > 2 && p[2].startsWith(' ') && p[2].endsWith(' ') ? p[2].slice(1, -1) : p[2];
    } else if (p[4] != null) {
      e = link(p[4]);
      inline(p[3], e);
    } else if (p[5] != null || p[6] != null) {
      e = h('strong');
      inline(p[5] ?? p[6], e);
    } else if (p[7] != null) {
      e = h('del');
      inline(p[7], e);
    } else if (p[8] != null || p[9] != null) {
      e = h('em');
      inline(p[8] ?? p[9], e);
    } else {
      e = link(p[10]);
      e.textContent = p[10];
    }
    into.append(e);
  }
}

function link(href) {
  const a = h('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}
