// Agent Hub 화면 — 왼쪽 작업 목록, 가운데 메인 에이전트 대화(작업자 카드 포함), 아래 입력창.
// 대시보드 화면도 같은 이벤트를 받으므로 이 렌더링 규칙을 그대로 옮겨 쓴다.
const NAMES = { claude: 'Claude', gemini: 'Gemini', codex: 'Codex' };
const AGENTS = ['claude', 'codex', 'gemini'];
const STATUS = { starting: '시작 중', idle: '대기', working: '작업 중', ended: '끝남' };
const $ = (id) => document.getElementById(id);

const sessions = new Map(); // id → { info, items: [], draft }
let viewId = null; // 지금 보고 있는 메인 세션 (null = 새 작업 화면)
let pendingFirst = null; // 새 작업 화면에서 보낸 첫 마디 — 메인이 만들어지면 보낸다
const opened = new Set(); // 펼쳐 둔 작업자 카드
const models = { claude: [], gemini: [], codex: [] }; // 드롭다운 목록 (설정 → CLI 가 알려 주면 교체)

// 사람이 고른 값은 이 브라우저에만 기억한다(편의용)
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('agent-hub:' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('agent-hub:' + k, JSON.stringify(v)); } catch {} },
};

// ── 보내기 ──────────────────────────────────
async function send(cmd) {
  const res = await fetch('/cmd', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cmd) });
  if (!res.ok) flash(`요청 실패 (${res.status}): ${await res.text()}`, true);
}
// ── 작업 폴더: 새 작업마다 고른다 ──────────────
const NEW_FOLDER = '__new__';
const workdir = () => $('folder-select').value || undefined; // '' = 뿌리

let folderList = []; // 작업 폴더 뿌리 아래 폴더들(오른쪽 패널의 폴더 연결에도 씀)
function fillFolders(list, pick) {
  folderList = list;
  const sel = $('folder-select');
  const cur = pick ?? sel.value ?? store.get('folder', '');
  sel.replaceChildren(
    ...list.map((f) => new Option(f.name || rootName(), f.name)),
    new Option('＋ 새 폴더…', NEW_FOLDER),
  );
  sel.value = list.some((f) => f.name === cur) ? cur : '';
  sel.dataset.prev = sel.value;
}
async function loadFolders(pick) {
  try {
    const r = await fetch('/folders');
    if (r.ok) fillFolders(await r.json(), pick);
  } catch {}
}
$('folder-select').onchange = async () => {
  const sel = $('folder-select');
  if (sel.value !== NEW_FOLDER) {
    sel.dataset.prev = sel.value;
    return store.set('folder', sel.value);
  }
  const name = await askDialog({ title: '새 폴더', input: '' , placeholder: '폴더 이름', ok: '만들기' });
  if (!name || !name.trim()) return void (sel.value = sel.dataset.prev ?? '');
  const r = await fetch('/folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  if (!r.ok) {
    flash(await r.text(), true);
    return void (sel.value = sel.dataset.prev ?? '');
  }
  fillFolders(await r.json(), name.trim());
  store.set('folder', name.trim());
};
loadFolders(store.get('folder', ''));

// ── 모델 드롭다운 ────────────────────────────
function fillSelects() {
  const main = $('main-select');
  const mainPick = main.value || store.get('main', 'claude|');
  // 메인 에이전트는 에이전트 프리셋에서 고른다 (값: preset|<id>). 프리셋이 없을 때를 위해 "기본 (Claude)" 하나만 둔다.
  main.replaceChildren(new Option('기본 (Claude)', 'claude|'));
  for (const p of presets) main.append(new Option(`${p.name} · ${NAMES[p.agent]}${p.model ? ` · ${modelName(p.agent, p.model)}` : ''}`, `preset|${p.id}`));
  main.value = [...main.options].some((o) => o.value === mainPick) ? mainPick : 'claude|';

  // 기본 작업자: 작업자(자동/AI) → 모델(그 AI 의 목록)
  const saved = store.get('worker', { agent: '', model: '' });
  const wa = $('worker-agent');
  if (!wa.dataset.ready) { wa.value = saved.agent ?? ''; wa.dataset.ready = '1'; }
  fillWorkerModels($('worker-model').value || saved.model || '');
}

function fillWorkerModels(cur) {
  const agent = $('worker-agent').value;
  const sel = $('worker-model');
  sel.replaceChildren(new Option('기본', ''), ...(agent ? models[agent] : []).map((m) => new Option(m.name, m.id)));
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '';
  sel.disabled = !agent; // 자동이면 모델은 메인이 정한다
}
const saveWorker = () => store.set('worker', { agent: $('worker-agent').value, model: $('worker-model').value });
$('main-select').onchange = () => store.set('main', $('main-select').value);
$('worker-agent').onchange = () => { fillWorkerModels(''); saveWorker(); };
$('worker-model').onchange = saveWorker;
function defaultWorker() {
  const agent = $('worker-agent').value;
  if (!agent) return undefined;
  const model = $('worker-model').value;
  return { agent, ...(model ? { model } : {}) };
}

// ── 입력창 ──────────────────────────────────
const input = $('input');
const autosize = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 220) + 'px'; };
input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (suggestKey(e)) return; // @·/ 팝업이 열려 있으면 방향키·Enter·Esc 는 팝업이 쓴다
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});
input.addEventListener('input', updateSuggest);
input.addEventListener('click', updateSuggest);
input.addEventListener('blur', () => setTimeout(hideSuggest, 150));

// ── @ 하위 에이전트 · / 명령 팝업 ──────────────
// @: 프리셋과 AI 를 고르면 "@이름 " 을 넣는다(메인은 @이름을 그 하위 에이전트로 맡기라는 뜻으로 읽는다)
// /: 줄 맨 앞에서 명령을 고른다
let sug = { items: [], index: 0, start: 0, end: 0 };
const COMMANDS = [
  { label: '/새 작업', hint: '새 작업 화면으로', run: () => $('new-task').click() },
  { label: '/끝내기', hint: '지금 작업을 멈춤', run: () => viewId && send({ type: 'session.stop', sessionId: viewId }) },
  { label: '/에이전트 만들기', hint: '메인에게 부탁', insert: '새 에이전트를 만들어 줘. 이름: , AI: , 하는 일: ' },
  { label: '/에이전트', hint: '설정 열기', run: () => { showNav('settings'); showSetTab('presets'); } },
  { label: '/프리셋', hint: '설정 열기', run: () => { showNav('settings'); showSetTab('workpresets'); } },
  { label: '/툴', hint: '설정의 툴 열기', run: () => { showNav('settings'); showSetTab('tools'); } },
  { label: '/연동', hint: 'Claude·Codex·Gemini·GitHub 로그인', run: () => { showNav('settings'); showSetTab('connect'); } },
];

function updateSuggest() {
  const pos = input.selectionStart;
  const before = input.value.slice(0, pos);
  const at = before.match(/(^|\s)@([^\s@]*)$/);
  const slash = before.match(/^\/(\S*)$/);
  let items = [];
  if (at) {
    // @ 는 에이전트 프리셋(하위 에이전트)만. AI 를 직접 고르려면 말로("Codex로") 하거나 작업자 드롭다운으로.
    const q = at[2].toLowerCase();
    items = presets
      .map((p) => ({ label: `@${p.name}`, hint: `${NAMES[p.agent]}${p.description ? `, ${p.description}` : ''}`, value: `@${p.name} ` }))
      .filter((x) => x.label.slice(1).toLowerCase().includes(q));
    if (!presets.length) items = [{ label: '에이전트가 없어요', hint: '만들기', run: () => { showNav('settings'); showSetTab('presets'); $('preset-new').click(); } }];
    sug = { items, index: 0, start: pos - at[2].length - 1, end: pos };
  } else if (slash) {
    const q = slash[1];
    items = COMMANDS.filter((c) => c.label.slice(1).includes(q));
    sug = { items, index: 0, start: 0, end: pos };
  }
  if (!items.length) return hideSuggest();
  renderSuggest();
}
function renderSuggest() {
  const box = $('suggest');
  box.replaceChildren();
  sug.items.forEach((x, i) => {
    const b = el('button', `sug${i === sug.index ? ' on' : ''}`);
    b.type = 'button';
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(i === sug.index));
    b.append(el('span', 'sug-label', x.label), el('span', 'sug-hint', x.hint));
    b.onmousedown = (e) => { e.preventDefault(); pickSuggest(i); };
    box.append(b);
  });
  box.hidden = false;
  // 화살표로 고른 줄이 목록 밖으로 나가면 그 줄까지 굴린다(목록 상자 안에서만)
  const on = box.querySelector('.sug.on');
  if (on) {
    if (on.offsetTop < box.scrollTop) box.scrollTop = on.offsetTop;
    else if (on.offsetTop + on.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = on.offsetTop + on.offsetHeight - box.clientHeight;
  }
}
function hideSuggest() { $('suggest').hidden = true; sug.items = []; }
function pickSuggest(i) {
  const x = sug.items[i];
  if (!x) return;
  hideSuggest();
  if (x.run) { input.value = ''; autosize(); return x.run(); }
  const text = x.insert ?? x.value;
  input.value = input.value.slice(0, sug.start) + text + input.value.slice(sug.end);
  const caret = sug.start + text.length;
  input.focus();
  input.setSelectionRange(caret, caret);
  autosize();
}
function suggestKey(e) {
  if ($('suggest').hidden || !sug.items.length) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    sug.index = (sug.index + (e.key === 'ArrowDown' ? 1 : -1) + sug.items.length) % sug.items.length;
    renderSuggest();
  } else if ((e.key === 'Enter' || e.key === 'Tab') && !e.isComposing) pickSuggest(sug.index);
  else if (e.key === 'Escape') hideSuggest();
  else return false;
  e.preventDefault();
  return true;
}
$('composer').onsubmit = (e) => {
  e.preventDefault();
  const text = input.value.trim();
  const files = pendingFiles.splice(0);
  if (!text && !files.length) return;
  renderAttachments();
  const s = viewId && sessions.get(viewId);
  if (s && s.info.status !== 'ended') {
    void sendWithFiles(viewId, text, files);
  } else {
    // 새 작업: 메인을 만들고, 만들어지면 첫 마디(와 첨부)를 보낸다
    const [kind, val] = $('main-select').value.split('|');
    pendingFirst = { text, files };
    if (kind === 'preset') {
      // 프리셋을 메인으로: 호스트가 프리셋의 AI·모델·역할 지침을 쓴다
      const p = presets.find((x) => x.id === val);
      send({ type: 'session.create', role: 'main', agent: p?.agent ?? 'claude', preset: val, workPreset: $('wp-select').value || undefined, defaultWorker: defaultWorker(), workdir: workdir() });
    } else {
      send({ type: 'session.create', role: 'main', agent: kind, model: val || undefined, workPreset: $('wp-select').value || undefined, defaultWorker: defaultWorker(), workdir: workdir() });
    }
  }
  input.value = '';
  autosize();
};

// ── 첨부: 붙여넣기 · 끌어다 놓기 · ＋ 버튼 ──────
// 파일은 그 작업 폴더의 첨부/ 에 올리고(경로로 전달), 이미지는 이미지째 에이전트에게 간다
const pendingFiles = []; // 아직 보내지 않은 File
const thumbs = new Map(); // 첨부 경로 → 이 브라우저에서 만든 미리보기 URL
function addFiles(list) {
  for (const f of list) if (f && f.size >= 0) pendingFiles.push(f);
  renderAttachments();
  input.focus();
}
function renderAttachments() {
  const box = $('attachments');
  box.replaceChildren();
  pendingFiles.forEach((f, i) => {
    const chip = el('span', 'chip');
    if (f.type.startsWith('image/')) {
      const img = el('img');
      img.src = f._url ??= URL.createObjectURL(f);
      img.alt = '';
      chip.append(img);
    }
    chip.append(el('span', 'chip-name', f.name || '붙여 넣은 이미지'));
    const x = el('button', '', '×');
    x.type = 'button';
    x.setAttribute('aria-label', `${f.name} 빼기`);
    x.onclick = () => { pendingFiles.splice(i, 1); renderAttachments(); };
    chip.append(x);
    box.append(chip);
  });
  box.hidden = !pendingFiles.length;
}
async function upload(sessionId, f) {
  const name = f.name || `붙여넣은-이미지.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
  const r = await fetch(`/attach?sessionId=${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    headers: { 'content-type': f.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(name) },
    body: f,
  });
  if (!r.ok) throw new Error(`${name}: ${await r.text()}`);
  const att = await r.json();
  if (f._url) thumbs.set(att.path, f._url);
  return att;
}
async function sendWithFiles(sessionId, text, files) {
  const attachments = [];
  for (const f of files) {
    try { attachments.push(await upload(sessionId, f)); } catch (err) { flash(`첨부 실패: ${err.message}`, true); }
  }
  if (!text && !attachments.length) return;
  send({ type: 'user.message', sessionId, text, ...(attachments.length ? { attachments } : {}) });
}
$('attach-btn').onclick = () => $('attach-input').click();
$('attach-input').onchange = () => { addFiles([...$('attach-input').files]); $('attach-input').value = ''; };
input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length) { e.preventDefault(); addFiles(files); }
});
const composerEl = $('composer');
composerEl.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); composerEl.classList.add('drop'); } });
composerEl.addEventListener('dragleave', () => composerEl.classList.remove('drop'));
composerEl.addEventListener('drop', (e) => {
  composerEl.classList.remove('drop');
  if (e.dataTransfer?.files.length) { e.preventDefault(); addFiles([...e.dataTransfer.files]); }
});

// ── 옆 목록·버튼 ─────────────────────────────
// 세션(작업 목록 + 대화) ↔ 설정
function showNav(nav) {
  for (const b of document.querySelectorAll('[data-nav]')) b.setAttribute('aria-current', String(b.dataset.nav === nav));
  $('chat').hidden = nav !== 'sessions';
  $('settings').hidden = nav !== 'settings';
  if (nav === 'settings') {
    renderSettings();
    loadPresets();
    loadTools();
    loadAuth();
    loadSkills();
    loadWorkPresets();
  }
  closeSide();
  renderPanel();
}
for (const b of document.querySelectorAll('[data-nav]')) b.onclick = () => showNav(b.dataset.nav);

$('new-task').onclick = () => { viewId = null; showNav('sessions'); render(); input.focus(); };
$('stop').onclick = () => viewId && send({ type: 'session.stop', sessionId: viewId });
// 터미널: 보고 있던 작업이 있으면 그 작업 폴더에서, 없으면 뿌리에서
for (const b of document.querySelectorAll('[data-term]')) {
  b.onclick = () => send({ type: 'terminal.open', agent: b.dataset.term, sessionId: viewId ?? undefined });
}
const closeSide = () => $('side').classList.remove('open');
for (const b of document.querySelectorAll('.side-open')) b.onclick = () => $('side').classList.add('open');
$('side-close').onclick = closeSide;

// ── 설정 화면 ────────────────────────────────
// 탭: 에이전트 프리셋 | 연동 | 툴
function showSetTab(tab) {
  if (![...document.querySelectorAll('[data-set]')].some((b) => b.dataset.set === tab)) tab = 'connect';
  for (const b of document.querySelectorAll('[data-set]')) b.setAttribute('aria-selected', String(b.dataset.set === tab));
  for (const s of document.querySelectorAll('.settings [data-tab]')) s.hidden = s.dataset.tab !== tab;
  store.set('setTab', tab);
}
for (const b of document.querySelectorAll('[data-set]')) b.onclick = () => showSetTab(b.dataset.set);
showSetTab(store.get('setTab', 'connect'));

let hostInfo = {};
function renderSettings() {}
/** 작업 폴더 뿌리 기준 상대 이름('' = 뿌리 자신, 뿌리 밖이면 null) */
function relName(dir) {
  const root = hostInfo.workspaceRoot ?? '';
  if (!root || !dir.startsWith(root)) return null;
  return dir.slice(root.length).replace(/^[\\/]+/, '');
}
/** 뿌리 폴더의 실제 이름(예: workspace) */
const rootName = () => (hostInfo.workspaceRoot ?? '').split(/[\\/]/).filter(Boolean).pop() || '작업 폴더';
/** 화면에 보일 폴더 이름: 실제 폴더 이름 그대로 */
function folderName(dir) {
  const rel = relName(dir);
  return rel === null ? dir : rel || rootName();
}

// ── 설정: 연동 (AI 마다 로그인 / API 키) ──────
let authState = {};
const AUTH_HELP = {
  claude: 'API 키는 Anthropic Console',
  codex: 'API 키는 OpenAI Platform',
  gemini: 'API 키는 Google AI Studio. 회사 계정 로그인은 프로젝트 ID 필요',
};
let cliState = {}; // AI CLI 설치 여부
let ghState = null; // GitHub: { installed, login?, pending?: { code, url } }
let updState = null; // 업데이트: { repo, mode, state, current, latest, behind, lastCheck, checking, canRestart }
const getJson = async (url, fallback) => {
  try {
    const r = await fetch(url);
    return r.ok ? await r.json() : fallback;
  } catch {
    return fallback;
  }
};
async function loadAuth() {
  [authState, cliState, ghState, updState] = await Promise.all([getJson('/auth', {}), getJson('/clis', {}), getJson('/github', null), getJson('/update', null)]);
  renderAuth();
}
// 설치·로그인을 시작하면 끝날 때까지 상태를 몇 초마다 다시 읽는다(최대 16분 — GitHub 일회용 코드는 15분이면 만료)
let authPoll = null;
function pollAuth() {
  clearInterval(authPoll);
  const until = Date.now() + 16 * 60 * 1000;
  let last = JSON.stringify([cliState, ghState]);
  authPoll = setInterval(async () => {
    const [c, g] = await Promise.all([getJson('/clis', cliState), getJson('/github', ghState)]);
    const now = JSON.stringify([c, g]);
    if (now !== last) { cliState = c; ghState = g; last = now; renderAuth(); }
    const busy = AGENTS.some((a) => c[a] && !c[a].installed) || (g && (!g.installed || g.pending));
    const u = await getJson('/update', updState);
    if (JSON.stringify(u) !== JSON.stringify(updState)) { updState = u; renderAuth(); }
    if (u?.checking) return; // 업데이트 확인 중이면 계속 본다
    if (!busy || Date.now() > until) clearInterval(authPoll);
  }, 3000);
}
async function postJson(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) return flash(await r.text(), true), null;
  return r.json();
}
async function saveAuth(agent, body) {
  const r = await fetch('/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent, ...body }) });
  if (!r.ok) return flash(await r.text(), true), false;
  authState = await r.json();
  renderAuth();
  return true;
}
function renderAuth() {
  const list = $('auth-list');
  list.replaceChildren();
  for (const a of AGENTS) {
    const st = authState[a] ?? { mode: 'login', hasKey: false };
    const row = el('div', 'auth-row');
    const head = el('div', 'auth-head');
    head.append(el('span', 'preset-name', NAMES[a]));
    // 로그인 | API 키
    const seg = el('div', 'seg');
    for (const [mode, label] of [['login', '로그인'], ['apikey', 'API 키']]) {
      const b = el('button', st.mode === mode ? 'on' : '', label);
      b.type = 'button';
      b.onclick = async () => {
        if (mode === st.mode) return;
        if (mode === 'apikey' && !st.hasKey) { st.mode = 'apikey'; return renderAuthRow(row, a, st, true); }
        if (await saveAuth(a, { mode })) flash(`${NAMES[a]} ${label}`);
      };
      seg.append(b);
    }
    head.append(seg);
    row.append(head);
    if (cliState[a] && !cliState[a].installed) {
      // CLI 가 없으면 로그인 대신 설치부터
      const body = el('div', 'auth-body');
      const b = el('button', 'line-btn', '설치');
      b.type = 'button';
      b.onclick = async () => { if (await postJson('/clis', { agent: a })) { flash(`${NAMES[a]} 설치 창을 열었어요`); pollAuth(); } };
      body.append(el('span', 'auth-state off', `${cliState[a].missing.join(', ')} 없음`), b);
      row.append(body);
      seg.hidden = true;
    } else renderAuthRow(row, a, st, false);
    list.append(row);
  }
  if (ghState) list.append(githubRow());
  if (updState) list.append(updateRow());
}

/** GitHub — 회사 계정으로 로그인. 저장소 만들기·푸시에 쓴다 */
function githubRow() {
  const g = ghState;
  const row = el('div', 'auth-row');
  const head = el('div', 'auth-head');
  head.append(el('span', 'preset-name', 'GitHub'));
  if (g.login) head.append(el('span', 'auth-state on', g.login));
  row.append(head);
  const body = el('div', 'auth-body');
  const btn = (label, fn, cls = 'line-btn') => {
    const b = el('button', cls, label);
    b.type = 'button';
    b.onclick = fn;
    body.append(b);
    return b;
  };
  if (!g.installed) {
    body.append(el('span', 'auth-state off', 'GitHub CLI 없음'));
    btn('설치', async () => { if ((ghState = await postJson('/github', { action: 'install' }) ?? ghState)) { flash('설치 창을 열었어요'); pollAuth(); } });
  } else if (g.pending) {
    // 일회용 코드: 승인 페이지에 넣으면 gh 가 스스로 로그인을 마친다
    body.append(el('span', 'auth-code', g.pending.code));
    btn('코드 복사', async () => { try { await navigator.clipboard.writeText(g.pending.code); flash('복사함'); } catch { flash('복사하지 못했어요', true); } });
    btn('승인 페이지 열기', () => window.open(g.pending.url, '_blank', 'noopener'));
    btn('취소', async () => { ghState = (await postJson('/github', { action: 'cancel' })) ?? ghState; renderAuth(); }, 'ghost');
    body.append(el('div', 'hint-inline auth-help', '승인 페이지에서 코드를 넣고 회사 계정으로 승인하세요'));
  } else if (g.login) {
    btn('다른 계정으로', () => startGithubLogin());
    btn('로그아웃', async () => {
      if (!(await askDialog({ title: 'GitHub 로그아웃', text: `${g.login} 계정을 이 PC 의 Agent Hub 에서 뺍니다.`, ok: '로그아웃', danger: true }))) return;
      ghState = (await postJson('/github', { action: 'logout' })) ?? ghState;
      renderAuth();
    }, 'ghost');
  } else {
    if (g.error) body.append(el('span', 'auth-state off', g.error));
    btn('로그인', () => startGithubLogin());
  }
  if (!g.pending) body.append(el('div', 'hint-inline auth-help', '회사 조직 계정. 에이전트 세션의 git·gh 가 이 계정을 씁니다'));
  row.append(body);
  return row;
}
/** 업데이트 — 레포 주소, 자동/수동, 상태 */
const UPD_TEXT = { unknown: '아직 확인 안 함', latest: '최신', available: '새 버전 있음', blocked: '받지 않음', notgit: '업데이트 불가', error: '확인 실패', ready: '받음' };
function updateRow() {
  const u = updState;
  const row = el('div', 'auth-row');
  const head = el('div', 'auth-head');
  head.append(el('span', 'preset-name', '업데이트'));
  const seg = el('div', 'seg');
  for (const [mode, label] of [['auto', '자동'], ['manual', '수동']]) {
    const b = el('button', u.mode === mode ? 'on' : '', label);
    b.type = 'button';
    b.onclick = async () => {
      if (mode === u.mode) return;
      const r = await postJson('/update', { mode });
      if (r) { updState = r; renderAuth(); flash(`${label} 업데이트`); }
    };
    seg.append(b);
  }
  head.append(seg);
  row.append(head);

  const repo = el('div', 'auth-body');
  const inp = el('input', 'key-input');
  inp.placeholder = u.defaultRepo;
  inp.value = u.repo === u.defaultRepo ? '' : u.repo;
  inp.autocomplete = 'off';
  inp.spellcheck = false;
  inp.setAttribute('aria-label', '업데이트 레포 주소');
  const save = el('button', 'line-btn', '저장');
  save.type = 'button';
  save.onclick = async () => {
    const r = await postJson('/update', { repo: inp.value });
    if (r) { updState = r; renderAuth(); flash('레포 저장'); }
  };
  repo.append(inp, save);
  row.append(repo);

  const body = el('div', 'auth-body');
  const st = u.checking ? '확인 중' : UPD_TEXT[u.state] ?? u.state;
  const bad = ['blocked', 'notgit', 'error'].includes(u.state) && !u.checking;
  const parts = [u.current ? `현재 ${u.current}` : '', u.state === 'available' && u.behind ? `${st} (${u.behind}개)` : st, u.message && !u.checking ? u.message : ''].filter(Boolean);
  body.append(el('span', `auth-state${bad ? ' off' : u.state === 'available' ? ' on' : ''}`, parts.join(' · ')));
  const check = el('button', 'line-btn', '지금 확인');
  check.type = 'button';
  check.disabled = u.checking;
  check.onclick = async () => { const r = await postJson('/update', { action: 'check' }); if (r) { updState = r; renderAuth(); pollAuth(); } };
  body.append(check);
  if (u.state === 'available' && !u.checking) {
    const go = el('button', 'line-btn', '업데이트');
    go.type = 'button';
    go.onclick = async () => {
      const text = u.canRestart ? '받은 뒤 진행 중인 작업이 끝나면 Agent Hub 를 다시 켭니다.' : '받은 뒤 Agent Hub 를 직접 다시 켜야 적용됩니다.';
      if (!(await askDialog({ title: '업데이트', text, ok: '받기' }))) return;
      const r = await postJson('/update', { action: 'apply' });
      if (r) { updState = r; renderAuth(); pollAuth(); }
    };
    body.append(go);
  }
  if (u.state === 'ready' && !u.canRestart) body.append(el('span', 'auth-state off', '다시 켜야 적용'));
  const when = u.lastCheck ? new Date(u.lastCheck).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const how = u.mode === 'auto'
    ? `매일 ${u.hour}시에 확인하고 받아서, 진행 중인 작업이 없을 때 다시 켭니다`
    : `매일 ${u.hour}시에 확인만 하고, 받기는 업데이트 버튼으로`;
  body.append(el('div', 'hint-inline auth-help', `${how}${when ? `. 마지막 확인 ${when}` : ''}`));
  row.append(body);
  return row;
}
async function startGithubLogin() {
  const g = await postJson('/github', { action: 'login' });
  if (!g) return;
  ghState = g;
  renderAuth();
  if (g.pending) window.open(g.pending.url, '_blank', 'noopener');
  pollAuth();
}
function renderAuthRow(row, a, st, pending) {
  row.querySelector('.auth-body')?.remove();
  row.querySelectorAll('.seg button').forEach((b, i) => b.classList.toggle('on', (i === 0) === (st.mode === 'login')));
  const body = el('div', 'auth-body');
  if (st.mode === 'login') {
    // 기본 로그인 = 기본 메인용(계정 설정), 에이전트 로그인 = 에이전트 세션용(전용 프로필). Gemini 는 프로필 분리가 없다.
    const targets = a === 'gemini' ? [['로그인', false]] : [['기본 로그인', false], ['에이전트 로그인', true]];
    for (const [label, profile] of targets) {
      const b = el('button', 'line-btn', label);
      b.type = 'button';
      b.title = profile ? '에이전트를 골라 시작한 세션' : '에이전트 없이 시작한 세션';
      b.onclick = () => send({ type: 'terminal.open', agent: a, sessionId: viewId ?? undefined, profile });
      body.append(b);
    }
  } else {
    const inp = el('input', 'key-input');
    inp.type = 'password';
    inp.autocomplete = 'off';
    inp.placeholder = st.hasKey ? '설정됨' : 'API 키';
    const save = el('button', 'line-btn', '저장');
    save.type = 'button';
    save.onclick = async () => {
      if (!inp.value.trim()) return flash('API 키를 넣어 주세요', true);
      if (await saveAuth(a, { mode: 'apikey', key: inp.value })) flash(`${NAMES[a]} API 키 저장`);
    };
    body.append(inp, save);
    if (st.hasKey && !pending) {
      const del = el('button', 'ghost', '키 지우기');
      del.type = 'button';
      del.onclick = async () => { if (await askDialog({ title: `${NAMES[a]} API 키 지우기`, text: '로그인으로 바뀝니다.', ok: '지우기', danger: true })) await saveAuth(a, { mode: 'login', key: null }); };
      body.append(del);
    }
  }
  if (a === 'gemini') {
    const p = el('input', 'key-input');
    p.placeholder = 'Google Cloud 프로젝트 ID';
    p.value = st.project ?? '';
    p.autocomplete = 'off';
    const ps = el('button', 'line-btn', '저장');
    ps.type = 'button';
    ps.onclick = async () => { if (await saveAuth('gemini', { project: p.value })) flash('저장함'); };
    const line = el('div', 'auth-body sub');
    line.append(p, ps);
    body.append(line);
  }
  body.append(el('div', 'hint-inline auth-help', AUTH_HELP[a]));
  row.append(body);
}

// ── 설정: 스킬 (에이전트가 쓰는 Agent Hub 스킬) ──
let hubSkillList = [];
const kform = $('skill-form');
async function loadSkills() {
  try {
    const r = await fetch('/hub-skills');
    hubSkillList = r.ok ? await r.json() : [];
  } catch {
    hubSkillList = [];
  }
  renderSkills();
}
function renderSkills() {
  const list = $('skill-list');
  list.replaceChildren();
  if (!hubSkillList.length && kform.hidden) return list.append(el('p', 'ext-empty', '없음'));
  for (const k of hubSkillList) {
    const row = el('div', 'preset');
    const head = el('div', 'preset-head');
    const edit = el('button', 'ghost', '고치기');
    edit.type = 'button';
    edit.onclick = () => openSkillForm(k);
    const del = el('button', 'ghost', '지우기');
    del.type = 'button';
    del.onclick = async () => {
      if (!(await askDialog({ title: `${k.name} 스킬 지우기`, ok: '지우기', danger: true }))) return;
      const r = await fetch(`/hub-skills?name=${encodeURIComponent(k.name)}`, { method: 'DELETE' });
      if (r.ok) hubSkillList = await r.json();
      renderSkills();
    };
    head.append(el('span', 'preset-name', k.name), edit, del);
    row.append(head, el('div', 'preset-desc', k.description), el('div', 'preset-inst', k.body.length > 160 ? k.body.slice(0, 160) + '…' : k.body));
    list.append(row);
  }
}
function openSkillForm(k) {
  const f = kform.elements;
  f.name.value = k?.name ?? '';
  f.name.readOnly = Boolean(k); // 이름이 폴더 이름이라 고칠 때는 그대로
  f.description.value = k?.description ?? '';
  f.body.value = k?.body ?? '';
  kform.hidden = false;
  renderSkills();
  (k ? f.description : f.name).focus();
}
$('skill-new').onclick = () => openSkillForm(null);
$('skill-cancel').onclick = () => { kform.hidden = true; renderSkills(); };
kform.onsubmit = async (e) => {
  e.preventDefault();
  const f = kform.elements;
  const r = await fetch('/hub-skills', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: f.name.value.trim(), description: f.description.value, body: f.body.value }) });
  if (!r.ok) return flash(await r.text(), true);
  hubSkillList = await r.json();
  kform.hidden = true;
  flash(`${f.name.value.trim()} 저장함`);
  renderSkills();
};

// ── 설정: 프리셋 (작업 환경: 폴더·지침) ─────────
let workPresetList = [];
const wform = $('wp-form');
async function loadWorkPresets() {
  try {
    const r = await fetch('/work-presets');
    workPresetList = r.ok ? await r.json() : [];
  } catch {
    workPresetList = [];
  }
  renderWorkPresets();
  fillWorkPresetSelect();
}
function renderWorkPresets() {
  const list = $('wp-list');
  list.replaceChildren();
  if (!workPresetList.length && wform.hidden) return list.append(el('p', 'ext-empty', '없음'));
  for (const p of workPresetList) {
    const row = el('div', 'preset');
    const head = el('div', 'preset-head');
    const edit = el('button', 'ghost', '고치기');
    edit.type = 'button';
    edit.onclick = () => openWpForm(p);
    const del = el('button', 'ghost', '지우기');
    del.type = 'button';
    del.onclick = async () => {
      if (!(await askDialog({ title: `${p.name} 프리셋 지우기`, ok: '지우기', danger: true }))) return;
      const r = await fetch(`/work-presets?id=${encodeURIComponent(p.id)}`, { method: 'DELETE' });
      if (r.ok) workPresetList = await r.json();
      renderWorkPresets();
      fillWorkPresetSelect();
    };
    const mainName = p.mainAgent ? presets.find((a) => a.id === p.mainAgent)?.name : null;
    head.append(el('span', 'preset-name', p.name), el('span', 'preset-meta', `${p.folder || '뿌리'}, 메인 ${mainName ?? '기본'}, 하위 ${allowText(p.agents, presets, (x) => x.name)}`), edit, del);
    row.append(head);
    if (p.description) row.append(el('div', 'preset-desc', p.description));
    if (p.guidelines) row.append(el('div', 'preset-inst', p.guidelines.length > 160 ? p.guidelines.slice(0, 160) + '…' : p.guidelines));
    list.append(row);
  }
}
function fillWpFolders(pick) {
  // 작업 폴더: 뿌리 아래 폴더 목록 + 새 폴더
  const sel = wform.elements.folder;
  sel.replaceChildren(...folderList.map((x) => new Option(x.name || rootName(), x.name)), new Option('새 폴더…', NEW_FOLDER));
  sel.value = folderList.some((x) => x.name === pick) ? pick : '';
  sel.dataset.prev = sel.value;
}
async function openWpForm(p) {
  const f = wform.elements;
  f.id.value = p?.id ?? '';
  f.name.value = p?.name ?? '';
  f.description.value = p?.description ?? '';
  f.guidelines.value = p?.guidelines ?? '';
  await loadFolders();
  fillWpFolders(p?.folder ?? '');
  // 메인 에이전트: 기본 + 에이전트들
  f.mainAgent.replaceChildren(new Option('기본 (Claude)', ''), ...presets.map((a) => new Option(`${a.name} · ${NAMES[a.agent]}`, a.id)));
  f.mainAgent.value = p?.mainAgent && presets.some((a) => a.id === p.mainAgent) ? p.mainAgent : '';
  fillAllow('wpagents', presets.map((a) => ({ id: a.id, label: `${a.name} · ${NAMES[a.agent]}` })), p?.agents, wform);
  wform.hidden = false;
  renderWorkPresets();
  f.name.focus();
}
wform.elements.folder.onchange = async () => {
  const sel = wform.elements.folder;
  if (sel.value !== NEW_FOLDER) return void (sel.dataset.prev = sel.value);
  const name = await askDialog({ title: '새 폴더', input: '', placeholder: '폴더 이름', ok: '만들기' });
  if (!name) return void (sel.value = sel.dataset.prev ?? '');
  const r = await fetch('/folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  if (!r.ok) { flash(await r.text(), true); return void (sel.value = sel.dataset.prev ?? ''); }
  fillFolders(await r.json(), $('folder-select').value);
  fillWpFolders(name.trim());
};
$('wp-new').onclick = () => openWpForm(null);
$('wp-cancel').onclick = () => { wform.hidden = true; renderWorkPresets(); };
wform.onsubmit = async (e) => {
  e.preventDefault();
  const f = wform.elements;
  const body = {
    id: f.id.value || undefined,
    name: f.name.value,
    folder: f.folder.value === NEW_FOLDER ? '' : f.folder.value,
    description: f.description.value,
    guidelines: f.guidelines.value,
    mainAgent: f.mainAgent.value || undefined,
    agents: readAllow('wpagents', wform),
  };
  const r = await fetch('/work-presets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) return flash(await r.text(), true);
  workPresetList = await r.json();
  wform.hidden = true;
  flash(`${body.name.trim()} 저장함`);
  renderWorkPresets();
  fillWorkPresetSelect();
};
/** 새 작업 화면의 프리셋 선택 */
function fillWorkPresetSelect() {
  const sel = $('wp-select');
  const cur = sel.value || store.get('workPreset', '');
  sel.replaceChildren(new Option('없음', ''), ...workPresetList.map((p) => new Option(p.name, p.id)));
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '';
  $('folder-pick').classList.toggle('by-preset', Boolean(sel.value));
}

// ── 설정: 툴 (모든 세션에 붙이는 MCP 서버) ────
let toolList = [];
const tform = $('tool-form');

async function loadTools() {
  try {
    const r = await fetch('/tools');
    toolList = r.ok ? await r.json() : [];
  } catch {
    toolList = [];
  }
  renderTools();
}

async function saveTool(body) {
  const r = await fetch('/tools', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) return flash(await r.text(), true), false;
  toolList = await r.json();
  renderTools();
  return true;
}

function renderTools() {
  const list = $('tool-list');
  list.replaceChildren();
  if (!toolList.length && tform.hidden) {
    list.append(el('p', 'ext-empty', '아직 툴이 없어요. “＋ 툴 추가”로 MCP 서버를 붙여 보세요.'));
    return;
  }
  for (const t of toolList) {
    const row = el('div', 'preset');
    const head = el('div', 'preset-head');
    const sw = el('button', `switch${t.enabled ? ' on' : ''}`);
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(t.enabled));
    sw.setAttribute('aria-label', `${t.name} ${t.enabled ? '끄기' : '켜기'}`);
    sw.onclick = async () => {
      sw.disabled = true;
      if (await saveTool({ ...t, enabled: !t.enabled })) flash(`${t.name} ${t.enabled ? '끔' : '켬'}`);
    };
    const edit = el('button', 'ghost', '고치기');
    edit.type = 'button';
    edit.onclick = () => openToolForm(t);
    const del = el('button', 'ghost', '지우기');
    del.type = 'button';
    del.onclick = async () => {
      if (!(await askDialog({ title: `${t.name} 툴 지우기`, ok: '지우기', danger: true }))) return;
      const r = await fetch(`/tools?id=${encodeURIComponent(t.id)}`, { method: 'DELETE' });
      if (r.ok) toolList = await r.json();
      renderTools();
    };
    head.append(el('span', 'preset-name', t.name), el('span', 'preset-meta', t.type === 'http' ? 'HTTP' : '명령'), edit, del, sw);
    row.append(head);
    if (t.description) row.append(el('div', 'preset-desc', t.description));
    row.append(el('div', 'preset-inst mono-line', t.type === 'http' ? t.url : [t.command, ...(t.args ?? [])].join(' ')));
    list.append(row);
  }
}

function showToolType() {
  const type = tform.elements.type.value;
  for (const l of tform.querySelectorAll('[data-for]')) l.hidden = l.dataset.for !== type;
}
function openToolForm(t) {
  const f = tform.elements;
  f.id.value = t?.id ?? '';
  f.name.value = t?.name ?? '';
  f.type.value = t?.type ?? 'http';
  f.url.value = t?.url ?? '';
  f.command.value = t?.command ?? '';
  f.args.value = (t?.args ?? []).join('\n');
  f.description.value = t?.description ?? '';
  tform.dataset.enabled = String(t?.enabled ?? true);
  showToolType();
  tform.hidden = false;
  renderTools();
  f.name.focus();
}
$('tool-new').onclick = () => openToolForm(null);
$('tool-cancel').onclick = () => { tform.hidden = true; renderTools(); };
tform.elements.type.onchange = showToolType;
tform.onsubmit = async (e) => {
  e.preventDefault();
  const f = tform.elements;
  const body = {
    id: f.id.value || undefined,
    name: f.name.value.trim(),
    type: f.type.value,
    url: f.url.value,
    command: f.command.value,
    args: f.args.value.split('\n'),
    description: f.description.value,
    enabled: tform.dataset.enabled !== 'false',
  };
  if (await saveTool(body)) {
    tform.hidden = true;
    flash(`${body.name} 저장함`);
    renderTools();
  }
};

// ── 설정: 에이전트 프리셋 ─────────────────────
let presets = [];
const pform = $('preset-form');

async function loadPresets() {
  try {
    const r = await fetch('/presets');
    presets = r.ok ? await r.json() : [];
  } catch {
    presets = [];
  }
  renderPresets();
  fillSelects(); // 메인 에이전트 선택에 프리셋을 넣는다
}

function renderPresets() {
  const list = $('preset-list');
  list.replaceChildren();
  if (!presets.length && pform.hidden) {
    list.append(el('p', 'ext-empty', '없음'));
    return;
  }
  for (const p of presets) {
    const row = el('div', `preset agent-${p.agent}`);
    const head = el('div', 'preset-head');
    head.append(el('span', 'card-dot'), el('span', 'preset-name', p.name), el('span', 'preset-meta', `${NAMES[p.agent]} · ${p.model ? modelName(p.agent, p.model) : '작업자 기본 모델'}${p.autoApprove ? ' · 권한 묻지 않음' : ''}`));
    const edit = el('button', 'ghost', '고치기');
    edit.type = 'button';
    edit.onclick = () => openForm(p);
    const del = el('button', 'ghost', '지우기');
    del.type = 'button';
    del.onclick = async () => {
      if (!(await askDialog({ title: `${p.name} 에이전트 지우기`, ok: '지우기', danger: true }))) return;
      const r = await fetch(`/presets?id=${encodeURIComponent(p.id)}`, { method: 'DELETE' });
      if (r.ok) presets = await r.json();
      renderPresets();
    };
    head.append(edit, del);
    row.append(head);
    if (p.description) row.append(el('div', 'preset-desc', p.description));
    row.append(el('div', 'preset-inst', p.instructions.length > 180 ? p.instructions.slice(0, 180) + '…' : p.instructions));
    row.append(el('div', 'preset-allow', `하위 에이전트 ${allowText(p.agents, presets, (x) => x.name)}, 툴 ${allowText(p.tools, toolList, (x) => x.name, '켜진 툴 전부')}, 스킬 ${p.skills ? (p.skills.join(', ') || '없음') : '전부'}`));
    list.append(row);
  }
}

function fillPresetModels(agent, value) {
  const sel = pform.elements.model;
  sel.replaceChildren(new Option('작업자 기본 모델', ''), ...models[agent].map((m) => new Option(m.name, m.id)));
  if (value && ![...sel.options].some((o) => o.value === value)) sel.append(new Option(value, value)); // 목록에 없는 기존 값도 지키기
  sel.value = value ?? '';
}

async function openForm(p) {
  const f = pform.elements;
  f.id.value = p?.id ?? '';
  f.name.value = p?.name ?? '';
  f.agent.value = p?.agent ?? 'claude';
  fillPresetModels(f.agent.value, p?.model);
  f.description.value = p?.description ?? '';
  f.instructions.value = p?.instructions ?? '';
  f.autoApprove.checked = Boolean(p?.autoApprove);
  if (!toolList.length) await loadTools();
  // 허용 목록: 없으면 "전부", 있으면 "고르기"에 체크
  fillAllow('agents', presets.filter((x) => x.id !== p?.id).map((x) => ({ id: x.id, label: `${x.name} · ${NAMES[x.agent]}` })), p?.agents);
  fillAllow('tools', toolList.map((t) => ({ id: t.id, label: `${t.name}${t.enabled ? '' : ' (꺼짐)'}` })), p?.tools);
  if (!hubSkillList.length) await loadSkills();
  fillAllow('skills', hubSkillList.map((k) => ({ id: k.name, label: k.name })), p?.skills);
  pform.hidden = false;
  renderPresets();
  f.name.focus();
}

/** 허용 목록을 한 줄 글로: 없음=전부, []=없음, 아니면 이름들 */
function allowText(ids, pool, name, all = '전부') {
  if (!ids) return all;
  if (!ids.length) return '없음';
  return ids.map((id) => pool.find((x) => x.id === id)).filter(Boolean).map(name).join(', ') || '없음';
}

/** 허용 칸: 전부 / 고르기 + 체크 목록 */
function fillAllow(kind, options, picked, form = pform) {
  const box = form.querySelector(`[data-allow="${kind}"]`);
  const list = box.querySelector('.allow-list');
  const mode = picked ? 'pick' : 'all';
  for (const r of box.querySelectorAll('input[type=radio]')) {
    r.checked = r.value === mode;
    r.onchange = () => (list.hidden = !box.querySelector('input[value=pick]').checked);
  }
  list.replaceChildren();
  if (!options.length) list.append(el('span', 'hint-inline', '없음'));
  for (const o of options) {
    const l = el('label', 'allow-item');
    const c = el('input');
    c.type = 'checkbox';
    c.value = o.id;
    c.checked = Boolean(picked?.includes(o.id));
    l.append(c, document.createTextNode(` ${o.label}`));
    list.append(l);
  }
  list.hidden = mode !== 'pick';
}
/** 저장할 값: "전부"면 undefined(제한 없음), "고르기"면 체크한 id 들(아무것도 안 고르면 빈 목록 = 없음) */
function readAllow(kind, form = pform) {
  const box = form.querySelector(`[data-allow="${kind}"]`);
  if (!box.querySelector('input[value=pick]').checked) return null;
  return [...box.querySelectorAll('.allow-list input:checked')].map((c) => c.value);
}
$('preset-new').onclick = () => openForm(null);
$('preset-cancel').onclick = () => { pform.hidden = true; renderPresets(); };
pform.elements.agent.onchange = () => fillPresetModels(pform.elements.agent.value, '');
pform.onsubmit = async (e) => {
  e.preventDefault();
  const f = pform.elements;
  const body = {
    id: f.id.value || undefined,
    name: f.name.value,
    agent: f.agent.value,
    model: f.model.value,
    description: f.description.value,
    instructions: f.instructions.value,
    agents: readAllow('agents'),
    tools: readAllow('tools'),
    skills: readAllow('skills'),
    autoApprove: f.autoApprove.checked,
  };
  const r = await fetch('/presets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) return flash(await r.text(), true);
  presets = await r.json();
  pform.hidden = true;
  flash(`${body.name.trim()} 저장함`);
  renderPresets();
};

// ── 이벤트 받기 ──────────────────────────────
const link = $('link');
const es = new EventSource('/events');
es.onopen = () => {
  // 다시 붙으면 서버가 기록 전체를 다시 보내 주므로 비우고 새로 그린다.
  sessions.clear();
  render();
  link.textContent = '';
  link.title = '이 PC 의 Agent Hub 에 연결됨';
  link.classList.remove('off');
};
es.onerror = () => {
  link.textContent = '연결 끊김';
  link.title = '다시 연결하는 중';
  link.classList.add('off');
};
es.onmessage = (m) => onEvent(JSON.parse(m.data));

function onEvent(ev) {
  if ((ev.type === 'notice' || ev.type === 'error') && !ev.sessionId) return flash(ev.message, ev.type === 'error');
  // 프리셋이 바뀌면(설정 화면이든 메인 에이전트든) 설정 화면을 다시 읽는다
  if (ev.type === 'presets.changed') return void loadPresets(); // 설정 목록·메인 선택·@ 팝업 모두 새로
  if (ev.type === 'schedules.changed') { scheduleCache.clear(); return renderPanel(); } // 예약이 바뀌거나 실행됨

  if (ev.type === 'session.deleted') {
    sessions.delete(ev.sessionId);
    for (const s of sessions.values()) s.items = s.items.filter((it) => !(it.k === 'worker' && it.id === ev.sessionId));
    if (viewId === ev.sessionId) viewId = null;
    return render();
  }

  if (ev.type === 'session.created') {
    const info = ev.session;
    sessions.set(info.id, { info, items: [], draft: null });
    if (info.forkedFrom && pendingFork === info.forkedFrom) { viewId = info.id; pendingFork = null; } // 포크하면 새 작업으로 이동
    else if (info.splitFrom && pendingFork === info.splitFrom) { viewId = info.id; pendingFork = null; } // 분담도
    else if (info.copiedFrom && pendingCopy === info.copiedFrom) { viewId = info.id; pendingCopy = null; } // 복사도
    if (info.role === 'worker') sessions.get(info.parentId)?.items.push({ k: 'worker', id: info.id });
    if (info.role === 'main' && pendingFirst && info.via === 'local' && !info.forkedFrom) {
      viewId = info.id;
      void sendWithFiles(info.id, pendingFirst.text, pendingFirst.files);
      pendingFirst = null;
    }
    return render();
  }

  const s = ev.sessionId && sessions.get(ev.sessionId);
  if (!s) return;
  switch (ev.type) {
    case 'session.status': s.info.status = ev.status; break;
    case 'session.renamed': s.info.customTitle = ev.title; break;
    case 'session.dirs': s.info.extraDirs = ev.dirs; break;
    case 'session.configured': {
      Object.assign(s.info, ev.session);
      skillsCache.delete(s.info.id);
      const who = ev.session.preset ? ev.session.preset.name : '기본';
      const what = [who, NAMES[ev.session.agent], ev.session.model ? modelName(ev.session.agent, ev.session.model) : '', ev.session.workPreset ? `프리셋 ${ev.session.workPreset.name}` : '', ev.session.autoApprove ? '권한 묻지 않음' : ''].filter(Boolean).join(' · ');
      s.items.push({ k: 'line meta', t: `설정 바꿈: ${what}. 다음 지시에 앞 대화를 붙여 이어갑니다` });
      break;
    }
    case 'session.merged': s.items.push({ k: 'merged', t: ev.title, text: ev.text, fromId: ev.fromId, split: ev.kind === 'split' }); break;
    case 'session.ended': s.info.status = 'ended'; s.draft = null; s.items.push({ k: 'line err', t: `끝남: ${ev.reason}` }); break;
    case 'user.message': s.items.push({ k: 'user', t: ev.text, from: ev.from, files: ev.attachments }); s.turnStart = Date.now(); break;
    case 'agent.text':
      if (ev.partial) s.draft = ev.text;
      else { s.draft = null; s.items.push({ k: 'agent', t: ev.text }); }
      break;
    case 'agent.models':
      // CLI 가 알려 준 실제 모델 목록으로 드롭다운을 바꾼다
      models[ev.agent] = ev.models;
      fillSelects();
      break;
    case 'agent.tool':
      if (s.info.role === 'main' && /clink/.test(ev.name)) break; // 메인의 맡기기는 카드가 대신 보여 준다
      s.items.push({ k: 'line tool', t: `${toolLabel(ev.name)} ${brief(ev.input)}`.trim(), toolId: ev.toolId });
      break;
    case 'agent.tool_result':
      if (s.info.role === 'main' && !s.items.some((it) => it.toolId === ev.toolId)) break;
      s.items.push({ k: `line ${ev.ok ? 'ok' : 'fail'}`, t: ev.summary || '(결과 없음)' });
      break;
    case 'turn.done':
      // 화면에는 걸린 시간만. 비용은 기록(data/sessions/*.jsonl)에만 남긴다.
      s.items.push({ k: 'line meta', t: `${(ev.durationMs / 1000).toFixed(1)}초` });
      break;
    case 'permission.request':
      s.items.push({ k: 'perm', requestId: ev.requestId, t: ev.tool, detail: ev.detail, resolved: null });
      if (s.info.role === 'worker') opened.add(s.info.id); // 승인이 필요하면 카드를 펼친다
      break;
    case 'permission.resolved': {
      const p = s.items.find((it) => it.k === 'perm' && it.requestId === ev.requestId);
      if (p) p.resolved = { allow: ev.allow, by: ev.by };
      break;
    }
    case 'error': s.items.push({ k: 'line err', t: ev.message }); break;
  }
  render();
}

// ── 그리기 ──────────────────────────────────
const mains = () => [...sessions.values()].filter((s) => s.info.role === 'main').sort((a, b) => b.info.createdAt.localeCompare(a.info.createdAt));
const workersOf = (s) => s.items.filter((it) => it.k === 'worker').map((it) => sessions.get(it.id)).filter(Boolean);
const pendingPerm = (s) => s.info.status !== 'ended' && s.items.some((it) => it.k === 'perm' && !it.resolved);
const waitingIn = (s) => pendingPerm(s) || workersOf(s).some(pendingPerm);
const titleOf = (s) => {
  const first = s.items.find((it) => it.k === 'user');
  return s.info.customTitle || first?.t || (first?.files?.length ? first.files[0].name : '') || (s.info.forkedFrom ? '포크한 작업' : s.info.splitFrom ? '분담한 작업' : s.info.copiedFrom ? '복사한 작업' : '새 작업');
};

// ── 작업 메뉴: 우클릭 또는 ⋯ → 이름 바꾸기 · 포크 · 분담 · 복사 · 삭제 ──
// 포크 = 대화를 이어받아 갈라짐(답이 끝날 때마다 원본에 공유), 분담 = 이어받고 원본과 서로 공유, 복사 = 공유 없는 사본
let pendingFork = null;
let pendingCopy = null;
function forkTask(s, upTo) {
  pendingFork = s.info.id;
  send({ type: 'session.fork', sessionId: s.info.id, ...(upTo !== undefined ? { upTo } : {}) });
}
const menu = el('div', 'ctx-menu');
menu.hidden = true;
document.body.append(menu);
function openTaskMenu(s, x, y) {
  closeMenu();
  menu.replaceChildren();
  const items = [
    ['이름 바꾸기', async () => {
      const t = await askDialog({ title: '이름 바꾸기', input: titleOf(s), ok: '바꾸기' });
      if (t && t.trim()) send({ type: 'session.rename', sessionId: s.info.id, title: t.trim() });
    }],
    ['포크', () => forkTask(s)],
    ['분담', () => { pendingFork = s.info.id; send({ type: 'session.split', sessionId: s.info.id }); }],
    ['복사', () => {
      pendingCopy = s.info.id;
      send({ type: 'session.copy', sessionId: s.info.id });
    }],
    ['삭제', async () => {
      const running = s.info.status !== 'ended' ? '진행 중이면 멈춥니다. ' : '';
      if (await askDialog({ title: '작업 삭제', text: `${titleOf(s)}\n${running}기록 파일은 남습니다.`, ok: '삭제', danger: true })) send({ type: 'session.delete', sessionId: s.info.id });
    }, 'danger'],
  ];
  for (const [label, fn, cls] of items) {
    const b = el('button', cls ?? '', label);
    b.type = 'button';
    b.onclick = () => { closeMenu(); fn(); };
    menu.append(b);
  }
  placeMenu(x, y);
}
let menuOwner = null; // 메뉴를 연 선택 상자(그 상자를 다시 누르면 닫는다)
function placeMenu(x, y, above = 0) {
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  // 아래 자리가 모자라면 위로 연다(above = 위로 열 때의 기준 y)
  const top = y + r.height > innerHeight - 8 && above ? above - r.height - 4 : Math.min(y, innerHeight - r.height - 8);
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  menu.style.top = `${Math.max(8, top)}px`;
}
const closeMenu = () => { menu.hidden = true; menu.className = 'ctx-menu'; menu.style.minWidth = ''; menuOwner = null; };
document.addEventListener('click', (e) => { if (!menu.contains(e.target) && !menuOwner?.contains(e.target)) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { const o = menuOwner; closeMenu(); o?.focus(); } });
addEventListener('blur', closeMenu);
// 메뉴 안 화살표 이동
menu.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const bs = [...menu.querySelectorAll('button')];
  const i = bs.indexOf(document.activeElement);
  bs[(i + (e.key === 'ArrowDown' ? 1 : bs.length - 1)) % bs.length]?.focus();
});

// ── 선택 상자: 브라우저 기본 목록 대신 직접 그린 메뉴로 연다(마우스일 때. 폰은 기본 목록이 편하다) ──
const finePointer = matchMedia('(pointer: fine)');
document.addEventListener('mousedown', (e) => {
  const sel = e.target instanceof Element ? e.target.closest('select') : null;
  if (!sel || sel.disabled || sel.multiple || e.button !== 0 || !finePointer.matches) return;
  e.preventDefault();
  sel.focus();
  if (menuOwner === sel) return closeMenu();
  openSelectMenu(sel);
});
function openSelectMenu(sel) {
  closeMenu();
  menu.replaceChildren();
  menu.classList.add('sel');
  const add = (opt) => {
    if (opt.hidden) return;
    const b = el('button', opt.selected ? 'on' : '', opt.textContent);
    b.type = 'button';
    b.disabled = opt.disabled;
    b.onclick = () => {
      closeMenu();
      sel.focus();
      if (sel.value === opt.value) return;
      sel.value = opt.value;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    };
    menu.append(b);
  };
  for (const c of sel.children) {
    if (c.tagName === 'OPTGROUP') { menu.append(el('div', 'ctx-label', c.label)); for (const o of c.children) add(o); }
    else add(c);
  }
  menuOwner = sel;
  const r = sel.getBoundingClientRect();
  menu.style.minWidth = `${Math.max(160, r.width)}px`;
  placeMenu(r.left, r.bottom + 4, r.top);
  (menu.querySelector('button.on') ?? menu.querySelector('button'))?.focus({ preventScroll: true });
  menu.querySelector('button.on')?.scrollIntoView({ block: 'nearest' });
}

function render() {
  renderList();
  renderChat();
  renderPanel();
}

// ── 오른쪽 패널: 지금 작업의 지침 · 환경 · 허용 · 연결된 세션 ──
// 에이전트 설정(지침·스킬·환경·예약·허용)은 기본으로 접어 둔다. 펼친 상태는 이 브라우저에만 기억
let settingsOpen = (() => { try { return localStorage.getItem('hub.settingsOpen') === '1'; } catch { return false; } })();
$('p-settings-toggle').onclick = () => {
  settingsOpen = !settingsOpen;
  try { localStorage.setItem('hub.settingsOpen', settingsOpen ? '1' : '0'); } catch {}
  renderPanel();
};
let panelOpen = store.get('panel', true);
const skillsCache = new Map(); // 세션 id → 스킬 목록
let skillsAll = false; // 스킬 모두 보기
$('panel-btn').onclick = () => { panelOpen = !panelOpen; store.set('panel', panelOpen); renderPanel(); };
$('panel-close').onclick = () => { panelOpen = false; store.set('panel', false); renderPanel(); };
$('p-folder-add').onchange = async () => {
  const s = viewId && sessions.get(viewId);
  let name = $('p-folder-add').value;
  $('p-folder-add').value = '';
  if (!s || !name) return;
  if (name === '?browse') name = await pickFolder(s.info.workdir);
  if (!name) return;
  const cur = (s.info.extraDirs ?? []).map(relFolder);
  send({ type: 'session.dirs', sessionId: s.info.id, dirs: [...cur, name] });
};
/** 절대 경로 → 작업 폴더 뿌리 아래 이름(뿌리는 '.'). 뿌리 밖이면 절대 경로 그대로 */
const relFolder = (abs) => { const r = relName(abs); return r === null ? abs : r || '.'; };

/** 폴더 찾아보기 창 — 고른 폴더의 절대 경로, 취소하면 null */
function pickFolder(start) {
  return new Promise((done) => {
    const back = el('div', 'dlg-back');
    const box = el('div', 'dlg fpick');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.append(el('div', 'dlg-title', '연결할 폴더'));
    const bar = el('div', 'fpick-bar');
    const up = el('button', 'p-mini', '위로');
    up.type = 'button';
    const path = el('input', 'dlg-input fpick-path');
    path.spellcheck = false;
    path.setAttribute('aria-label', '폴더 경로');
    bar.append(up, path);
    const roots = el('div', 'fpick-roots');
    const list = el('div', 'fpick-list');
    const note = el('div', 'hint-inline', '');
    const foot = el('div', 'dlg-foot');
    const no = el('button', 'dlg-no', '취소');
    const yes = el('button', 'dlg-yes', '이 폴더 연결');
    no.type = yes.type = 'button';
    foot.append(no, yes);
    box.append(bar, roots, list, note, foot);
    back.append(box);
    document.body.append(back);
    let cur = null;
    const go = async (p) => {
      const r = await fetch(`/browse?path=${encodeURIComponent(p ?? '')}`);
      if (!r.ok) { note.textContent = await r.text(); note.classList.add('err'); return; }
      cur = await r.json();
      note.textContent = '';
      note.classList.remove('err');
      path.value = cur.path;
      up.disabled = !cur.parent;
      yes.disabled = !cur.parent; // 드라이브 전체는 안 됨
      roots.replaceChildren(...[['홈', cur.home], ...cur.roots.map((d) => [d, d])].map(([label, p2]) => {
        const b = el('button', 'p-mini', label);
        b.type = 'button';
        b.onclick = () => go(p2);
        return b;
      }));
      list.replaceChildren();
      if (!cur.dirs.length) list.append(el('div', 'p-empty', '하위 폴더 없음'));
      for (const d of cur.dirs) {
        const b = el('button', 'fpick-item', d.name);
        b.type = 'button';
        b.onclick = () => go(d.path);
        list.append(b);
      }
      list.scrollTop = 0;
    };
    const close = (v) => { back.remove(); document.removeEventListener('keydown', key, true); done(v); };
    const key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      else if (e.key === 'Enter' && !e.isComposing && document.activeElement === path) { e.preventDefault(); go(path.value); }
    };
    document.addEventListener('keydown', key, true);
    up.onclick = () => cur?.parent && go(cur.parent);
    no.onclick = () => close(null);
    yes.onclick = () => cur && close(cur.path);
    back.onmousedown = (e) => { if (e.target === back) close(null); };
    go(start);
  });
}

function renderPanel() {
  const s = viewId && sessions.get(viewId);
  const show = Boolean(s) && !$('chat').hidden;
  $('panel-btn').hidden = !s;
  $('panel').hidden = !(show && panelOpen);
  document.querySelector('.app').classList.toggle('with-panel', show && panelOpen);
  if (!show || !panelOpen) return;
  const preset = s.info.preset ? presets.find((p) => p.id === s.info.preset.id) : undefined;

  renderLinks(s);
  renderSchedules(s); // 예약은 설정이 아니라 일정 — 늘 보인다
  $('p-settings').hidden = !settingsOpen;
  $('p-settings-toggle').setAttribute('aria-expanded', String(settingsOpen));
  if (!settingsOpen) return; // 접혀 있으면 설정 칸은 그리지도 읽지도 않는다

  // 지침: 메인 역할 + 그 CLI 가 읽는 스킬
  const role = $('p-role');
  role.replaceChildren();
  const wp = s.info.workPreset ? workPresetList.find((p) => p.id === s.info.workPreset.id) : undefined;
  if (s.info.workPreset) {
    role.append(el('div', 'p-item-title', `프리셋 ${s.info.workPreset.name}`));
    if (wp?.guidelines) role.append(el('div', 'p-text', wp.guidelines.length > 220 ? wp.guidelines.slice(0, 220) + '…' : wp.guidelines));
    role.append(el('div', 'p-gap'));
  }
  if (s.info.preset) {
    role.append(el('div', 'p-item-title', `${s.info.preset.name} · ${NAMES[s.info.agent]}${s.info.model ? ` · ${modelName(s.info.agent, s.info.model)}` : ''}`));
    if (preset) role.append(el('div', 'p-text', preset.instructions.length > 220 ? preset.instructions.slice(0, 220) + '…' : preset.instructions));
  } else {
    role.append(el('div', 'p-item-title', `기본 · ${NAMES[s.info.agent]}${s.info.model ? ` · ${modelName(s.info.agent, s.info.model)}` : ''}`), el('div', 'p-text', '계정 설정 그대로'));
  }
  if (s.info.autoApprove) role.append(el('div', 'p-warn', '권한 묻지 않음 · 도구를 허용 없이 바로 실행'));
  if (s.info.role !== 'worker') {
    const acts = el('div', 'p-acts');
    const change = el('button', 'p-mini', confEdit === s.info.id ? '닫기' : '바꾸기');
    change.type = 'button';
    change.onclick = () => { confEdit = confEdit === s.info.id ? null : s.info.id; confDraft = null; renderPanel(); };
    acts.append(change);
    if (preset) {
      // 스킬·허용 에이전트·툴은 에이전트에 딸려 있다 → 에이전트 편집 화면에서
      const edit = el('button', 'p-mini', '에이전트 편집');
      edit.type = 'button';
      edit.onclick = () => { showNav('settings'); showSetTab('presets'); openForm(preset); };
      acts.append(edit);
    }
    role.append(acts);
    if (confEdit === s.info.id) role.append(configForm(s));
  }
  const sk = $('p-skills');
  sk.replaceChildren();
  const list = skillsCache.get(s.info.id);
  if (!list) {
    sk.append(el('div', 'p-empty', '읽는 중'));
    fetch(`/skills?sessionId=${encodeURIComponent(s.info.id)}`).then((r) => (r.ok ? r.json() : [])).then((l) => { skillsCache.set(s.info.id, l); renderPanel(); }).catch(() => skillsCache.set(s.info.id, []));
  } else if (!list.length) sk.append(el('div', 'p-empty', '없음'));
  else {
    // 많으면 5개만 보이고 펼치기(아래 칸들이 밀리지 않게)
    const shown = skillsAll ? list : list.slice(0, 5);
    for (const k of shown) {
      const row = el('div', 'p-item');
      row.title = k.description;
      row.append(el('span', 'p-name', k.name), el('span', 'p-meta', k.where));
      sk.append(row);
    }
    if (list.length > 5) {
      const more = el('button', 'p-more', skillsAll ? '접기' : `모두 보기 (${list.length})`);
      more.type = 'button';
      more.onclick = () => { skillsAll = !skillsAll; renderPanel(); };
      sk.append(more);
    }
  }

  // 환경: 작업 폴더 + 연결 폴더(추가·삭제)
  const fl = $('p-folders');
  fl.replaceChildren();
  const main = el('div', 'p-item');
  main.title = s.info.workdir;
  main.append(el('span', 'p-name', folderName(s.info.workdir)));
  fl.append(main);
  const extra = s.info.extraDirs ?? [];
  for (const d of extra) {
    const row = el('div', 'p-item');
    row.title = d;
    const x = el('button', 'p-x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', `${folderName(d)} 연결 끊기`);
    x.onclick = () => send({ type: 'session.dirs', sessionId: s.info.id, dirs: extra.filter((e) => e !== d).map(relFolder) });
    row.append(el('span', 'p-name', folderName(d)), x);
    fl.append(row);
  }
  const add = $('p-folder-add');
  const used = new Set([s.info.workdir, ...extra]);
  const ph = new Option('＋ 폴더 연결', '');
  ph.hidden = true; // 상자에만 보이고 목록에는 안 나온다
  add.replaceChildren(ph, ...folderList.filter((f) => !used.has(f.path)).map((f) => new Option(f.name || rootName(), f.name || '.')), new Option('다른 폴더 찾기…', '?browse'));

  // 허용: 메인 프리셋이 정한 하위 에이전트 · 툴
  const al = $('p-allow');
  al.replaceChildren();
  const agentsText = preset ? allowText(preset.agents, presets, (x) => x.name) : '전부';
  const toolsText = preset ? allowText(preset.tools, toolList, (x) => x.name, '켜진 툴 전부') : '켜진 툴 전부';
  for (const [k, v] of [['하위 에이전트', agentsText], ['툴', toolsText]]) {
    const row = el('div', 'p-item col');
    row.append(el('span', 'p-meta', k), el('span', 'p-name wrap', v));
    al.append(row);
  }

}

/** 에이전트 설정 바꾸기 — 프리셋(지침)·에이전트·AI·모델. 적용하면 메인을 새 설정으로 다시 띄운다 */
let confEdit = null; // 바꾸기 창이 열린 세션 id
let confDraft = null; // 고르는 중인 값 — 다른 이벤트로 패널을 다시 그려도 지킨다
function configForm(s) {
  const f = el('div', 'p-conf');
  const d = confDraft?.id === s.info.id ? confDraft : (confDraft = { id: s.info.id, wp: s.info.workPreset?.id ?? '', ag: s.info.preset?.id ?? '', ai: s.info.agent, m: s.info.model ?? '', auto: Boolean(s.info.autoApprove) });
  const field = (label, sel) => {
    const l = el('label', 'p-conf-row');
    l.append(el('span', 'p-meta', label), sel);
    f.append(l);
    return sel;
  };
  const wpSel = field('프리셋', el('select'));
  wpSel.append(new Option('없음', ''), ...workPresetList.map((p) => new Option(p.name, p.id)));
  wpSel.value = d.wp;
  const agSel = field('에이전트', el('select'));
  agSel.append(new Option('기본 (계정 설정 그대로)', ''), ...presets.map((p) => new Option(`${p.name} · ${NAMES[p.agent]}`, p.id)));
  agSel.value = d.ag;
  const aiSel = field('AI', el('select'));
  aiSel.append(...AGENTS.map((a) => new Option(NAMES[a], a)));
  aiSel.value = d.ai;
  const mSel = field('모델', el('select'));
  const auSel = field('권한', el('select'));
  auSel.append(new Option('묻기', ''), new Option('묻지 않기', '1'));
  auSel.value = d.auto ? '1' : '';
  const aiRow = aiSel.parentElement;
  // 에이전트를 고르면 AI 는 그 에이전트 것. 모델은 고른 에이전트·AI 기준으로 다시 채운다
  const sync = (keepModel) => {
    const p = presets.find((x) => x.id === agSel.value);
    if (p) aiSel.value = p.agent;
    aiRow.hidden = Boolean(p);
    const agent = aiSel.value;
    const want = keepModel ?? p?.model ?? '';
    mSel.replaceChildren(new Option(p ? '에이전트 기본' : '기본', ''), ...models[agent].map((m) => new Option(m.name, m.id)));
    if (want && ![...mSel.options].some((o) => o.value === want)) mSel.append(new Option(want, want));
    mSel.value = want;
    Object.assign(d, { wp: wpSel.value, ag: agSel.value, ai: aiSel.value, m: mSel.value });
  };
  sync(d.m);
  agSel.onchange = () => { sync(); d.auto = Boolean(presets.find((x) => x.id === agSel.value)?.autoApprove); auSel.value = d.auto ? '1' : ''; };
  auSel.onchange = () => { d.auto = auSel.value === '1'; };
  aiSel.onchange = () => sync('');
  wpSel.onchange = mSel.onchange = () => Object.assign(d, { wp: wpSel.value, m: mSel.value });
  const busy = s.info.status === 'working' || s.info.status === 'starting';
  const apply = el('button', 'line-btn', '적용');
  apply.type = 'button';
  apply.disabled = busy;
  apply.onclick = async () => {
    const ok = await askDialog({ title: '에이전트 설정 바꾸기', text: '메인 에이전트를 새 설정으로 다시 띄웁니다. 지금까지의 대화는 다음 지시에 붙여 이어갑니다.', ok: '바꾸기' });
    if (!ok) return;
    send({
      type: 'session.configure',
      sessionId: s.info.id,
      workPreset: wpSel.value || null,
      preset: agSel.value || null,
      ...(agSel.value ? {} : { agent: aiSel.value }),
      model: mSel.value || null,
      autoApprove: auSel.value === '1',
    });
    confEdit = null;
    confDraft = null;
    renderPanel();
  };
  const foot = el('div', 'p-conf-foot');
  foot.append(apply, el('span', 'hint-inline', busy ? '작업이 끝난 뒤에 바꿀 수 있어요' : '폴더는 그대로. 스킬·허용은 에이전트를 따라갑니다'));
  f.append(foot);
  return f;
}

/** 연결된 세션(포크 관계) · 백그라운드(지금 도는 하위 에이전트) · 하위 작업(끝났거나 쉬는 하위 에이전트 일) */
function renderLinks(s) {
  const forks = [];
  if (s.info.forkedFrom && sessions.get(s.info.forkedFrom)) forks.push({ s: sessions.get(s.info.forkedFrom), label: '포크 원본', sub: titleOf(sessions.get(s.info.forkedFrom)) });
  for (const f of sessions.values()) if (f.info.forkedFrom === s.info.id) forks.push({ s: f, label: '포크', sub: titleOf(f) });
  if (s.info.splitFrom && sessions.get(s.info.splitFrom)) forks.push({ s: sessions.get(s.info.splitFrom), label: '분담 원본', sub: titleOf(sessions.get(s.info.splitFrom)) });
  for (const f of sessions.values()) if (f.info.splitFrom === s.info.id) forks.push({ s: f, label: '분담', sub: titleOf(f) });
  const running = [];
  const rest = [];
  for (const w of workersOf(s)) {
    const l = { s: w, label: `${w.info.preset ? `${w.info.preset.name} · ` : ''}${NAMES[w.info.agent]}`, sub: w.items.find((it) => it.k === 'user')?.t ?? '', worker: true };
    (pendingPerm(w) || w.info.status === 'working' || w.info.status === 'starting' ? running : rest).push(l);
  }
  fillLinks($('p-sessions'), forks);
  fillLinks($('p-running'), running);
  fillLinks($('p-subtasks'), rest);
}

function workerState(w) {
  if (pendingPerm(w)) return '승인 대기';
  if (w.info.status === 'working' || w.info.status === 'starting') return '작업 중';
  const failed = w.info.status === 'ended' && w.items.some((it) => it.k === 'line err') && !w.items.some((it) => it.k === 'line meta');
  if (failed) return '실패';
  return w.items.some((it) => it.k === 'line meta') ? '끝남' : STATUS[w.info.status];
}

function fillLinks(box, links) {
  box.replaceChildren();
  box.closest('.psec').hidden = !links.length; // 빈 칸은 숨긴다
  for (const l of links) {
    const b = el('button', 'p-item p-link');
    b.type = 'button';
    const st = l.worker ? workerState(l.s) : pendingPerm(l.s) ? '승인 대기' : STATUS[l.s.info.status];
    const text = el('span', 'p-name wrap');
    text.append(el('b', '', l.label), document.createTextNode(l.sub ? ` ${l.sub.length > 40 ? l.sub.slice(0, 40) + '…' : l.sub}` : ''));
    b.append(text, el('span', `p-meta${st === '승인 대기' ? ' wait' : st === '실패' ? ' fail' : ''}`, st));
    b.onclick = () => {
      if (l.worker) { opened.add(l.s.info.id); render(); document.querySelector('.tasks')?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      else { viewId = l.s.info.id; render(); }
    };
    box.append(b);
  }
}

// ── 예약: 이 작업에 정한 시각마다 지시를 보낸다(끝난 작업이면 이어서 새로 시작) ──
const scheduleCache = new Map(); // 세션 id → 예약 목록
let schedForm = null; // 열린 입력 창 { sessionId }
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
const REPEAT_NAMES = { once: '한 번', daily: '매일', weekdays: '평일', weekly: '매주' };
const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());

function whenText(x) {
  if (x.repeat === 'once') return Number(x.date.slice(5, 7)) + '/' + Number(x.date.slice(8)) + ' ' + x.time;
  if (x.repeat === 'weekly') return '매주 ' + WEEK[x.weekday] + ' ' + x.time;
  return REPEAT_NAMES[x.repeat] + ' ' + x.time;
}
function nextText(iso) {
  if (!iso) return '끝남';
  const d = new Date(iso);
  const day = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(new Date().setHours(0, 0, 0, 0))) / 864e5);
  const hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  return day === 0 ? '오늘 ' + hm : day === 1 ? '내일 ' + hm : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
}
async function saveSchedule(s, body) {
  const r = await fetch('/schedules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, sessionId: s.info.id }) });
  if (!r.ok) { flash(await r.text(), true); return false; }
  scheduleCache.set(s.info.id, await r.json());
  return true;
}

function renderSchedules(s) {
  const box = $('p-schedules');
  box.replaceChildren();
  if (schedForm && schedForm.sessionId !== s.info.id) closeSchedForm();
  $('p-sched-add').hidden = Boolean(schedForm);
  const list = scheduleCache.get(s.info.id);
  if (!list) {
    box.append(el('div', 'p-empty', '읽는 중'));
    fetch('/schedules?sessionId=' + encodeURIComponent(s.info.id)).then((r) => (r.ok ? r.json() : [])).then((l) => { scheduleCache.set(s.info.id, l); renderPanel(); }).catch(() => scheduleCache.set(s.info.id, []));
    return;
  }
  for (const x of list) {
    const row = el('div', 'p-item sched' + (x.enabled ? '' : ' off'));
    const body = el('button', 'sched-body');
    body.type = 'button';
    body.title = (x.enabled ? '다음 ' + nextText(x.nextAt) : '꺼짐') + (x.lastResult ? '\n마지막: ' + x.lastResult : '');
    body.append(el('span', 'sched-when', whenText(x)), el('span', 'sched-prompt', x.prompt));
    body.onclick = () => openSchedForm(s, x);
    const sw = el('button', 'switch' + (x.enabled ? ' on' : ''));
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(x.enabled));
    sw.setAttribute('aria-label', x.enabled ? '예약 끄기' : '예약 켜기');
    sw.onclick = async () => { if (await saveSchedule(s, { ...x, enabled: !x.enabled })) renderPanel(); };
    const del = el('button', 'p-x', '×');
    del.type = 'button';
    del.setAttribute('aria-label', '예약 지우기');
    del.onclick = async () => {
      if (!(await askDialog({ title: '예약 지우기', text: whenText(x) + '\n' + x.prompt.slice(0, 80), ok: '지우기', danger: true }))) return;
      const r = await fetch('/schedules?id=' + encodeURIComponent(x.id) + '&sessionId=' + encodeURIComponent(s.info.id), { method: 'DELETE' });
      if (r.ok) { scheduleCache.set(s.info.id, await r.json()); renderPanel(); }
    };
    row.append(body, sw, del);
    box.append(row);
  }
}
$('p-sched-add').onclick = () => {
  const s = viewId && sessions.get(viewId);
  if (s) openSchedForm(s, null);
};

function closeSchedForm() {
  schedForm = null;
  $('p-sched-form').hidden = true;
  $('p-sched-form').replaceChildren();
  $('p-sched-add').hidden = false;
}

/** 예약 입력 창. 패널이 다시 그려져도 지워지지 않게 목록과 따로 둔다(쓰는 중인 글 보존). */
function openSchedForm(s, x) {
  const now = new Date();
  const d = x ? { ...x } : { prompt: '', repeat: 'daily', time: '09:00', enabled: true };
  d.date ??= ymd(now);
  d.weekday ??= now.getDay();
  schedForm = { sessionId: s.info.id };
  const f = $('p-sched-form');
  f.replaceChildren();
  f.hidden = false;
  $('p-sched-add').hidden = true;
  $('p-schedules').querySelector('.p-empty')?.remove();

  const ta = el('textarea', 'sched-input');
  ta.rows = 3;
  ta.placeholder = '보낼 지시';
  ta.value = d.prompt;
  ta.oninput = () => { d.prompt = ta.value; };

  const seg = el('div', 'seg sched-seg');
  const line = el('div', 'sched-line');
  const drawLine = () => {
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.k === d.repeat));
    line.replaceChildren();
    if (d.repeat === 'once') {
      const date = el('input', 'sched-field');
      date.type = 'date';
      date.value = d.date;
      date.min = ymd(now);
      date.onchange = () => { d.date = date.value; };
      line.append(date);
    }
    if (d.repeat === 'weekly') {
      const wd = el('select', 'sched-field');
      WEEK.forEach((w, i) => wd.append(new Option(w + '요일', String(i))));
      wd.value = String(d.weekday);
      wd.onchange = () => { d.weekday = Number(wd.value); };
      line.append(wd);
    }
    const time = el('input', 'sched-field');
    time.type = 'time';
    time.value = d.time;
    time.onchange = () => { d.time = time.value; };
    line.append(time);
  };
  for (const [k, n] of Object.entries(REPEAT_NAMES)) {
    const b = el('button', '', n);
    b.type = 'button';
    b.dataset.k = k;
    b.onclick = () => { d.repeat = k; drawLine(); };
    seg.append(b);
  }
  drawLine();

  const foot = el('div', 'sched-foot');
  const no = el('button', 'ghost', '취소');
  no.type = 'button';
  no.onclick = closeSchedForm;
  const ok = el('button', 'line-btn', '저장');
  ok.type = 'button';
  ok.onclick = async () => {
    if (!d.prompt.trim()) return flash('보낼 지시를 적어 주세요', true);
    const body = { id: x?.id, prompt: d.prompt, repeat: d.repeat, time: d.time, enabled: x ? d.enabled : true, ...(d.repeat === 'once' ? { date: d.date } : {}), ...(d.repeat === 'weekly' ? { weekday: d.weekday } : {}) };
    if (!(await saveSchedule(s, body))) return;
    closeSchedForm();
    flash('예약 저장');
    renderPanel();
  };
  foot.append(no, ok);
  f.append(ta, seg, line, foot);
  ta.focus();
}

// 접어 둔 포크 묶음(원본 id). 이 브라우저에만 기억
const folded = new Set((() => { try { return JSON.parse(localStorage.getItem('hub.folded') || '[]'); } catch { return []; } })());
function saveFolded() { try { localStorage.setItem('hub.folded', JSON.stringify([...folded])); } catch {} }

/** 작업 목록: 포크는 원본 아래 나무 모양(오래된 것부터), 원본이 지워진 포크는 맨 위 단계로 */
function renderList() {
  const list = $('task-list');
  list.replaceChildren();
  const all = mains();
  const parentOf = (k) => k.info.forkedFrom ?? k.info.splitFrom;
  const kidsOf = (s) => all.filter((k) => parentOf(k) === s.info.id).reverse();
  const holds = (s, id) => kidsOf(s).some((k) => k.info.id === id || holds(k, id));
  const group = (s, depth) => {
    const g = el('div', 'task-group');
    const kids = kidsOf(s);
    const open = !folded.has(s.info.id) || holds(s, viewId); // 보고 있는 포크가 안에 있으면 펼친다
    g.append(taskRow(s, depth, kids.length ? open : null));
    if (kids.length && open) {
      const box = el('div', 'task-kids');
      for (const k of kids) box.append(group(k, depth + 1));
      g.append(box);
    }
    return g;
  };
  for (const s of all) if (!parentOf(s) || !sessions.get(parentOf(s))) list.append(group(s, 0));
  if (!list.children.length) list.append(el('div', 'side-label', '아직 작업이 없어요'));
}

/** 작업 한 줄. 포크(depth>0)는 이름만. open: 포크가 달려 있으면 펼침 여부, 없으면 null */
function taskRow(s, depth, open) {
  const b = el('button', depth ? 'task kid' : 'task');
  b.type = 'button';
  b.setAttribute('aria-current', String(s.info.id === viewId));
  const wait = waitingIn(s);
  const time = new Date(s.info.createdAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  const head = el('span', `task-head${depth && wait ? ' wait' : ''}`);
  if (depth && s.info.splitFrom) head.append(el('span', 'task-tag', '분담')); // 서로 공유하는 갈래
  head.append(el('span', 'task-title', titleOf(s)));
  if (open !== null) {
    const fold = el('span', `task-fold${open ? '' : ' shut'}`);
    fold.innerHTML = '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    fold.setAttribute('role', 'button');
    fold.setAttribute('aria-label', open ? '갈래 접기' : '갈래 펼치기');
    fold.onclick = (e) => {
      e.stopPropagation();
      if (open) folded.add(s.info.id);
      else folded.delete(s.info.id);
      saveFolded();
      renderList();
    };
    head.append(fold);
  }
  b.append(head);
  if (!depth) b.append(el('span', `task-sub${wait ? ' wait' : ''}`, `${NAMES[s.info.agent]} · ${wait ? '승인 대기' : STATUS[s.info.status]} · ${s.info.via === 'dashboard' ? '대시보드 · ' : ''}${time}`));
  else b.title = `${wait ? '승인 대기' : STATUS[s.info.status]} · ${time}`;
  b.onclick = () => { viewId = s.info.id; showNav('sessions'); render(); };
  b.oncontextmenu = (e) => { e.preventDefault(); openTaskMenu(s, e.clientX, e.clientY); };
  const more = el('span', 'task-more', '⋯');
  more.setAttribute('role', 'button');
  more.setAttribute('aria-label', '작업 메뉴');
  more.onclick = (e) => {
    e.stopPropagation();
    const r = more.getBoundingClientRect();
    openTaskMenu(s, r.left, r.bottom + 2);
  };
  b.append(more);
  return b;
}

function renderChat() {
  const s = viewId && sessions.get(viewId);
  const live = s && s.info.status !== 'ended';
  $('welcome').hidden = Boolean(s);
  $('chat-title').textContent = s ? titleOf(s) : '새 작업';
  const wait = s && waitingIn(s);
  $('chat-status').textContent = s ? (wait ? '승인 대기' : STATUS[s.info.status]) : '';
  $('chat-status').classList.toggle('wait', Boolean(wait));
  $('stop').hidden = !live;

  // 메인 AI·모델은 새 작업을 시작할 때만 고른다. 진행 중인 작업은 정해진 값을 보여 준다.
  // 진행 중인 작업에서는 메인 선택을 숨긴다(이미 정해졌고, 목록에 표시됨)
  const fixed = Boolean(s && live);
  $('folder-pick').hidden = fixed || Boolean($('wp-select').value); // 폴더는 시작할 때만, 프리셋을 고르면 프리셋이 정한다
  $('chat-folder').textContent = s ? folderName(s.info.workdir) : '';
  $('chat-folder').title = s ? s.info.workdir : '';
  input.placeholder = s && !live ? '끝난 작업. 보내면 새 작업으로 시작' : '맡길 일  (@ 에이전트, / 명령)';

  const scroll = $('scroll');
  const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 60;
  const log = $('log');
  log.replaceChildren();
  if (s) {
    if (s.info.forkedFrom) {
      const from = sessions.get(s.info.forkedFrom);
      log.append(el('div', 'note', from ? `${titleOf(from)} 에서 포크. 여기서 한 일은 원본에 공유돼요` : '지워진 작업에서 포크'));
    } else if (s.info.splitFrom) {
      const from = sessions.get(s.info.splitFrom);
      log.append(el('div', 'note', from ? `${titleOf(from)} 와 분담. 서로 한 일이 다음 지시에 공유돼요` : '지워진 작업에서 분담'));
    } else if (s.info.copiedFrom) {
      const from = sessions.get(s.info.copiedFrom);
      log.append(el('div', 'note', `${from ? titleOf(from) : '지워진 작업'} 에서 복사`));
    }
    renderItems(s, live, log);
    if (s.draft) log.append(item({ k: 'agent', t: s.draft }));
    if (live && isBusy(s) && !waitingIn(s)) log.append(workingLine(s));
  }
  if (atBottom) scroll.scrollTop = scroll.scrollHeight;
}

const modelName = (agent, id) => models[agent].find((m) => m.id === id)?.name ?? id;
const isToolLine = (it) => it.k === 'line tool' || it.k === 'line ok' || it.k === 'line fail';
const isBusy = (s) => s.info.status === 'working' || s.info.status === 'starting' || workersOf(s).some((w) => w.info.status === 'working');
const openFolds = new Set(); // 펼친 "도구 N개 사용" 줄

/** 대화 항목 그리기: 연달아 나온 도구 줄은 한 줄로 접고, 연달아 맡긴 작업은 체크리스트 카드 하나로 묶는다 */
function renderItems(s, live, into, skip) {
  const items = s.items;
  let users = 0; // 지금까지 나온 사람 지시 수 — "여기서 포크"가 몇 번째 차례까지 가져갈지
  for (let i = 0; i < items.length; ) {
    const it = items[i];
    if (it.k === 'user') users++;
    if (it === skip || it.k === 'line meta') { i++; continue; } // 걸린 시간은 카드에만
    if (isToolLine(it)) {
      let j = i;
      while (j < items.length && isToolLine(items[j])) j++;
      into.append(...foldGroup(items.slice(i, j), `${s.info.id}:${i}`));
      i = j;
      continue;
    }
    if (it.k === 'worker') {
      let j = i;
      while (j < items.length && items[j].k === 'worker') j++;
      into.append(tasksCard(items.slice(i, j).map((w) => sessions.get(w.id)).filter(Boolean)));
      i = j;
      continue;
    }
    if (it.k === 'perm') into.append(permItem(s, it, live));
    else if (it.k === 'line err') into.append(el('div', 'err-line', it.t));
    else if (it.k === 'merged') into.append(mergedItem(it));
    else if (it.k === 'agent' && s.info.role === 'main') into.append(agentItem(s, it, users));
    else into.append(item(it));
    i++;
  }
}

/** "도구 3개 사용 ›" — 누르면 펼쳐서 무엇을 했는지 보여 준다 */
function foldGroup(run, key) {
  const tools = run.filter((it) => it.k === 'line tool').length || run.length;
  const fails = run.filter((it) => it.k === 'line fail').length;
  const open = openFolds.has(key);
  const b = el('button', `fold${open ? ' open' : ''}`, `도구 ${tools}개 사용${fails ? ` · 실패 ${fails}` : ''}`);
  b.type = 'button';
  b.append(el('span', 'chev', '›'));
  b.onclick = () => { open ? openFolds.delete(key) : openFolds.add(key); render(); };
  if (!open) return [b];
  const body = el('div', 'fold-body');
  for (const it of run) body.append(el('div', `fold-line${it.k === 'line fail' ? ' fail' : ''}`, it.k === 'line tool' ? it.t : `→ ${it.t}`));
  return [b, body];
}

/** 하위 에이전트에게 맡긴 일: 체크리스트 카드 — 줄마다 상태 표시, 누르면 그 에이전트의 대화를 펼친다 */
function tasksCard(ws) {
  const card = el('div', 'tasks');
  for (const w of ws) {
    const ended = w.info.status === 'ended';
    const failed = ended && w.items.some((it) => it.k === 'line err') && !w.items.some((it) => it.k === 'line meta');
    const done = w.items.some((it) => it.k === 'line meta');
    const state = pendingPerm(w) ? ['wait', '!'] : w.info.status === 'working' || w.info.status === 'starting' ? ['spin', ''] : failed ? ['fail', '×'] : done ? ['done', '✓'] : ['idle', ''];
    const open = opened.has(w.info.id);
    const row = el('button', `trow${open ? ' open' : ''}`);
    row.type = 'button';
    const ask = w.items.find((it) => it.k === 'user');
    const main = el('span', 'tmain');
    main.append(el('span', 'twho', `${w.info.preset ? `${w.info.preset.name} · ` : ''}${NAMES[w.info.agent]}${w.info.model ? ` · ${modelName(w.info.agent, w.info.model)}` : ''}`), document.createTextNode(ask?.t ?? ''));
    const meta = w.items.filter((it) => it.k === 'line meta').at(-1);
    row.append(el('span', `ticon ${state[0]}`, state[1]), main, el('span', 'tmeta', state[0] === 'wait' ? '승인 대기' : failed ? '실패' : meta?.t ?? ''), el('span', 'chev', '›'));
    row.onclick = () => { open ? opened.delete(w.info.id) : opened.add(w.info.id); render(); };
    card.append(row);
    if (open) {
      const body = el('div', 'tbody');
      renderItems(w, !ended, body, ask);
      if (w.draft) body.append(item({ k: 'agent', t: w.draft }));
      card.append(body);
    }
  }
  return card;
}

/** 진행 중: "● ● ● 작업 중 · 12초" */
function workingLine(s) {
  const line = el('div', 'working');
  const dots = el('span', 'dots');
  dots.append(el('i'), el('i'), el('i'));
  line.append(dots, el('span', 'elapsed', elapsedText(s)));
  line.dataset.sid = s.info.id;
  return line;
}
function elapsedText(s) {
  const sec = s.turnStart ? Math.floor((Date.now() - s.turnStart) / 1000) : 0;
  return `작업 중 · ${sec < 60 ? `${sec}초` : `${Math.floor(sec / 60)}분 ${sec % 60}초`}`;
}
setInterval(() => {
  const line = document.querySelector('.working');
  const s = line && sessions.get(line.dataset.sid);
  if (s) line.querySelector('.elapsed').textContent = elapsedText(s);
}, 1000);

/** 도구 이름을 읽기 쉽게: mcp__hub__agent_save → 프리셋 저장, mcp__docs__search → docs · search */
function toolLabel(name) {
  const hub = { mcp__hub__agent_save: '에이전트 저장', mcp__hub__agent_delete: '에이전트 삭제', mcp__hub__agent_list: '에이전트 목록' };
  return hub[name] ?? name.replace(/^mcp__([^_]+(?:_[^_]+)*?)__/, '$1 · ');
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** 메인의 답: 마우스를 올리면 "여기서 포크" — 이 차례까지의 대화를 가져가 갈라진다 */
function agentItem(s, it, upTo) {
  const div = item(it);
  const b = el('button', 'msg-fork', '여기서 포크');
  b.type = 'button';
  b.title = '이 답까지의 대화를 이어받아 새 작업으로';
  b.onclick = () => forkTask(s, upTo);
  div.append(b);
  return div;
}

/** 포크에서 공유받은 대화: 접힌 카드, 누르면 그 대화 */
function mergedItem(it) {
  const box = el('details', 'merged');
  const head = el('summary', '', `${it.split ? '분담' : '포크'} 공유 · ${it.t}`);
  box.append(head, el('div', 'merged-body', it.text));
  return box;
}

function item(it) {
  const div = el('div', it.k.startsWith('line') ? it.k : `msg ${it.k}`);
  if (it.from && it.from !== 'local') div.append(el('span', 'from', it.from));
  if (it.t) div.append(document.createTextNode(it.t));
  if (it.files?.length) {
    // 첨부: 이 브라우저에서 올린 이미지는 미리보기, 나머지는 이름
    const box = el('div', 'msg-files');
    for (const f of it.files) {
      const chip = el('span', 'chip');
      chip.title = f.path;
      const url = thumbs.get(f.path);
      if (url) { const img = el('img'); img.src = url; img.alt = ''; chip.append(img); }
      chip.append(el('span', 'chip-name', f.name));
      box.append(chip);
    }
    div.append(box);
  }
  return div;
}

// 승인 요청: 답이 오기 전엔 허용·거부 버튼, 답이 오면 누가 어떻게 답했는지
function permItem(s, it, live) {
  const box = el('div', 'perm' + (it.resolved ? ' done' : ''));
  box.append(el('div', 'perm-head', it.t));
  if (it.detail) box.append(el('div', 'perm-detail', it.detail));
  const foot = el('div', 'perm-foot');
  if (it.resolved) {
    foot.textContent = `${it.resolved.allow ? '허용' : '거부'}, ${it.resolved.by}`;
  } else if (live) {
    for (const [label, allow] of [['허용', true], ['거부', false]]) {
      const b = el('button', allow ? 'allow' : 'deny', label);
      b.type = 'button';
      b.onclick = () => {
        for (const x of foot.querySelectorAll('button')) x.disabled = true;
        send({ type: 'permission.respond', sessionId: s.info.id, requestId: it.requestId, allow });
      };
      foot.append(b);
    }
  } else {
    foot.textContent = '끝난 작업';
  }
  box.append(foot);
  return box;
}

function brief(input) {
  if (!input || typeof input !== 'object') return '';
  const v = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.url ?? Object.values(input)[0];
  const t = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  return t.length > 80 ? t.slice(0, 80) + '…' : t;
}

function flash(text, isError) {
  const box = $('flash');
  box.textContent = text;
  box.classList.toggle('err', Boolean(isError));
  box.hidden = false;
  clearTimeout(box._t);
  box._t = setTimeout(() => (box.hidden = true), 6000);
}

loadPresets(); // @ 팝업에 프리셋이 나오도록 처음부터 읽어 둔다
loadTools(); // 오른쪽 패널의 허용 툴 이름
loadWorkPresets(); // 새 작업 화면의 프리셋 선택
$('wp-select').onchange = () => {
  store.set('workPreset', $('wp-select').value);
  // 프리셋이 메인 에이전트를 정해 두었으면 에이전트 선택도 맞춘다
  const wp = workPresetList.find((p) => p.id === $('wp-select').value);
  if (wp?.mainAgent && [...$('main-select').options].some((o) => o.value === `preset|${wp.mainAgent}`)) { $('main-select').value = `preset|${wp.mainAgent}`; store.set('main', $('main-select').value); }
  render();
};
fetch('/info').then((r) => r.json()).then((info) => {
  hostInfo = info;
  $('elevated').hidden = !info.elevated;  for (const a of AGENTS) if (info.models?.[a] && !models[a].length) models[a] = info.models[a];
  if (info.mainAgent && !store.get('main', null)) store.set('main', `${info.mainAgent}|`);
  fillSelects();
}).catch(() => fillSelects());


// ── 확인 창 (브라우저 기본 confirm/prompt 대신) ──
// input 을 주면 글 입력 창: 확인 → 입력한 글, 취소 → null. 아니면 확인 → true, 취소 → false
function askDialog({ title, text = '', input, placeholder = '', ok = '확인', danger = false }) {
  return new Promise((resolve) => {
    const back = el('div', 'dlg-back');
    const box = el('div', 'dlg');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.append(el('div', 'dlg-title', title));
    if (text) box.append(el('div', 'dlg-text', text));
    let field = null;
    if (input !== undefined) {
      field = el('input', 'dlg-input');
      field.value = input;
      field.placeholder = placeholder;
      box.append(field);
    }
    const foot = el('div', 'dlg-foot');
    const no = el('button', 'dlg-no', '취소');
    const yes = el('button', `dlg-yes${danger ? ' danger' : ''}`, ok);
    no.type = yes.type = 'button';
    foot.append(no, yes);
    box.append(foot);
    back.append(box);
    document.body.append(back);
    const done = (v) => { back.remove(); document.removeEventListener('keydown', key, true); resolve(v); };
    const accept = () => done(field ? (field.value.trim() || null) : true);
    const cancel = () => done(field ? null : false);
    const key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); accept(); }
    };
    document.addEventListener('keydown', key, true);
    yes.onclick = accept;
    no.onclick = cancel;
    back.onmousedown = (e) => { if (e.target === back) cancel(); };
    (field ?? yes).focus();
    if (field) field.select();
  });
}
