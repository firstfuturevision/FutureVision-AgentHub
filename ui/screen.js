// 화면 제어 — 이 PC 화면을 보고 마우스·키보드로 조작한다(Windows·리눅스 X11).
// 프레임은 한 장씩 당겨 온다(받으면 다음 요청): 네트워크가 느리면 저절로 덜 받는다.
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const FRAME_GAP = 60; // 프레임 사이 최소 간격(ms) ≈ 초당 16장
const viewer = Math.random().toString(36).slice(2, 12); // 보는 사람 수 세기용

const scr = { open: false, st: null, mon: 0, size: null, looping: false, queue: [], sending: false };
const stage = $('screen-stage');
const canvas = $('screen-canvas');
const ctx = canvas.getContext('2d');

function msg(text) {
  $('screen-msg').hidden = !text;
  $('screen-msg').textContent = text ?? '';
}

async function load(body) {
  try {
    const r = await fetch('/screen', body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    if (!r.ok) { msg(await r.text()); return; }
    scr.st = await r.json();
  } catch {
    msg('Agent Hub 에 연결하지 못함');
    return;
  }
  renderTop();
  if (scr.st.enabled) loop();
}

function renderTop() {
  const st = scr.st;
  const sw = $('screen-switch');
  sw.hidden = !st.supported;
  sw.classList.toggle('on', st.enabled);
  sw.setAttribute('aria-checked', String(st.enabled));
  sw.setAttribute('aria-label', st.enabled ? '화면 제어 끄기' : '화면 제어 켜기');
  $('screen-state').textContent = st.enabled ? '켜짐' : '꺼짐';
  $('screen-state').classList.toggle('on', st.enabled);
  const sel = $('screen-mon');
  const mons = st.monitors ?? [];
  sel.hidden = mons.length < 2;
  sel.replaceChildren(...mons.map((m, i) => new Option(`모니터 ${i + 1}${m.primary ? ' (주)' : ''}`, String(i))));
  if (scr.mon >= mons.length) scr.mon = 0;
  sel.value = String(scr.mon);
  scr.size = mons[scr.mon] ?? null;
  if (!st.supported) msg(st.reason);
  else if (!st.enabled) { msg('꺼져 있음'); ctx.clearRect(0, 0, canvas.width, canvas.height); }
  else msg(st.error);
}

async function loop() {
  if (scr.looping) return;
  scr.looping = true;
  try {
    while (scr.open && scr.st?.enabled) {
      if (document.hidden) { await sleep(500); continue; }
      const t0 = performance.now();
      const full = scr.size?.w ?? 1920;
      const w = Math.max(320, Math.min(full, Math.round(stage.clientWidth * (devicePixelRatio || 1))));
      let r;
      try {
        r = await fetch(`/screen/frame?m=${scr.mon}&w=${w}&q=70&v=${viewer}`, { cache: 'no-store' });
      } catch {
        msg('Agent Hub 에 연결하지 못함');
        await sleep(1500);
        continue;
      }
      if (r.ok) {
        const bmp = await createImageBitmap(await r.blob());
        if (canvas.width !== bmp.width || canvas.height !== bmp.height) { canvas.width = bmp.width; canvas.height = bmp.height; }
        ctx.drawImage(bmp, 0, 0);
        bmp.close?.();
        if (!$('screen-msg').hidden) msg(null);
      } else if (r.status === 403) {
        await load(); // 다른 곳에서 껐다
        break;
      } else {
        msg(await r.text()); // 423: 관리자 확인 창·잠금 화면
        await sleep(1000);
      }
      await sleep(Math.max(0, FRAME_GAP - (performance.now() - t0)));
    }
  } finally {
    scr.looping = false;
  }
}

export function openScreen() {
  scr.open = true;
  $('screen').hidden = false;
  stage.focus();
  load();
}
function closeScreen() {
  scr.open = false;
  $('screen').hidden = true;
}

$('screen-open').onclick = () => openScreen();
$('screen-close').onclick = closeScreen;
$('screen-switch').onclick = () => load({ enabled: !scr.st?.enabled });
$('screen-mon').onchange = () => { scr.mon = Number($('screen-mon').value) || 0; scr.size = scr.st.monitors[scr.mon]; };

// ── 입력: 모아서 하나씩 보낸다(마우스 이동은 마지막 것만) ──
function push(ev) {
  if (!scr.st?.enabled) return;
  const last = scr.queue[scr.queue.length - 1];
  if (ev.t === 'move' && last?.t === 'move') scr.queue[scr.queue.length - 1] = ev;
  else scr.queue.push(ev);
  flush();
}
async function flush() {
  if (scr.sending || !scr.queue.length) return;
  scr.sending = true;
  const events = scr.queue.splice(0);
  try {
    await fetch('/screen/input', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ m: scr.mon, events }) });
  } catch {}
  scr.sending = false;
  flush();
}
/** 화면 위 점 → 그 모니터 안 0..1 */
function at(e) {
  const r = canvas.getBoundingClientRect();
  return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
}
const BUTTON = { 0: 0, 1: 2, 2: 1 }; // 브라우저(왼·가운데·오른) → 도우미(왼·오른·가운데)

// 마우스: 그대로
canvas.addEventListener('pointerdown', (e) => {
  stage.focus();
  if (e.pointerType === 'touch') return touchDown(e);
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  push({ t: 'down', ...at(e), b: BUTTON[e.button] ?? 0 });
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') return touchMove(e);
  push({ t: 'move', ...at(e) });
});
canvas.addEventListener('pointerup', (e) => {
  if (e.pointerType === 'touch') return touchUp(e);
  push({ t: 'up', ...at(e), b: BUTTON[e.button] ?? 0 });
});
canvas.addEventListener('pointercancel', (e) => { if (e.pointerType === 'touch') touches.clear(); });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const dy = Math.round(-e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 400 : 1.2));
  if (dy) push({ t: 'wheel', ...at(e), dy });
}, { passive: false });

// 터치: 톡 = 클릭, 길게 = 오른쪽 클릭, 끌기 = 끌어 놓기, 두 손가락 = 스크롤
const touches = new Map(); // pointerId → { sx, sy, y, t, start, dragging, cancel }
let twoY = null;
function touchDown(e) {
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  touches.set(e.pointerId, { sx: e.clientX, sy: e.clientY, y: e.clientY, t: Date.now(), start: at(e), dragging: false, cancel: false });
  if (touches.size === 2) twoY = avgY();
}
function touchMove(e) {
  const p = touches.get(e.pointerId);
  if (!p) return;
  p.y = e.clientY;
  if (touches.size >= 2) {
    for (const q of touches.values()) q.cancel = true;
    const y = avgY();
    if (twoY != null && Math.abs(y - twoY) >= 8) { push({ t: 'wheel', ...at(e), dy: Math.round((y - twoY) * 4) }); twoY = y; }
    return;
  }
  if (p.cancel) return;
  if (!p.dragging && Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > 10) {
    p.dragging = true;
    push({ t: 'move', ...p.start });
    push({ t: 'down', ...p.start, b: 0 });
  }
  if (p.dragging) push({ t: 'move', ...at(e) });
}
function touchUp(e) {
  const p = touches.get(e.pointerId);
  touches.delete(e.pointerId);
  if (touches.size < 2) twoY = null;
  if (!p || p.cancel) return;
  if (p.dragging) return push({ t: 'up', ...at(e), b: 0 });
  const b = Date.now() - p.t > 550 ? 1 : 0; // 길게 누르면 오른쪽 클릭
  push({ t: 'move', ...p.start });
  push({ t: 'down', ...p.start, b });
  push({ t: 'up', ...p.start, b });
}
function avgY() {
  let s = 0;
  for (const q of touches.values()) s += q.y;
  return s / touches.size;
}

// 키보드: 화면을 누른 뒤(포커스) 누르는 키를 그대로 보낸다 — 한글은 이 PC 의 입력기가 조합한다
const CODES = {
  Backspace: 8, Tab: 9, Enter: 13, NumpadEnter: 13, ShiftLeft: 160, ShiftRight: 161, ControlLeft: 162, ControlRight: 163, AltLeft: 164, AltRight: 165,
  Pause: 19, CapsLock: 20, Escape: 27, Space: 32, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  PrintScreen: 44, Insert: 45, Delete: 46, MetaLeft: 91, MetaRight: 92, OSLeft: 91, OSRight: 92, ContextMenu: 93,
  NumpadMultiply: 106, NumpadAdd: 107, NumpadSubtract: 109, NumpadDecimal: 110, NumpadDivide: 111, NumLock: 144, ScrollLock: 145,
  Semicolon: 186, Equal: 187, Comma: 188, Minus: 189, Period: 190, Slash: 191, Backquote: 192, BracketLeft: 219, Backslash: 220, BracketRight: 221, Quote: 222,
  Lang1: 21, Lang2: 25,
};
export function vkOf(e) {
  if (e.key === 'HangulMode') return 21;
  if (e.key === 'HanjaMode') return 25;
  const c = e.code ?? '';
  let m;
  if ((m = c.match(/^Key([A-Z])$/))) return m[1].charCodeAt(0);
  if ((m = c.match(/^Digit(\d)$/))) return 48 + Number(m[1]);
  if ((m = c.match(/^Numpad(\d)$/))) return 96 + Number(m[1]);
  if ((m = c.match(/^F(\d{1,2})$/)) && Number(m[1]) <= 24) return 111 + Number(m[1]);
  return CODES[c] ?? 0;
}
const held = new Set();
stage.addEventListener('keydown', (e) => {
  const vk = vkOf(e);
  if (!vk) return;
  e.preventDefault();
  held.add(vk);
  push({ t: 'key', d: true, vk });
});
stage.addEventListener('keyup', (e) => {
  const vk = vkOf(e);
  if (!vk) return;
  e.preventDefault();
  held.delete(vk);
  push({ t: 'key', d: false, vk });
});
// 포커스를 잃으면 누르고 있던 키를 뗀다(Ctrl·Shift 가 눌린 채로 남지 않게)
stage.addEventListener('blur', () => { for (const vk of held) push({ t: 'key', d: false, vk }); held.clear(); });

// 폰: 글자 칸에 쓰고 보내기, 자주 쓰는 키 버튼
$('screen-text').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing) return;
  e.preventDefault();
  const s = e.target.value;
  if (s) push({ t: 'text', s });
  e.target.value = '';
});
for (const b of document.querySelectorAll('.screen-keys [data-vk]')) {
  b.onclick = () => { const vk = Number(b.dataset.vk); push({ t: 'key', d: true, vk }); push({ t: 'key', d: false, vk }); };
}
