import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScreenControl } from '../src/screen.ts';
import { handleScreenTool, comboEvents, keyCode, SCREEN_TOOLS } from '../src/screen-tools.ts';
import { handleMcp } from '../src/mcp.ts';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'src');
const until = async (f: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error('시간 초과'); await new Promise((ok) => setTimeout(ok, 20)); } };

function make() {
  const base = mkdtempSync(join(tmpdir(), 'agent hub stools '));
  const log = join(base, 'input.log');
  // 'raw' = 리눅스처럼 날 픽셀(4×2) → 허브가 JPEG 로
  const screen = new ScreenControl({ file: join(base, 'screen.json'), binDir: base, source: join(src, 'screen-helper.cs'), helperCommand: [process.execPath, join(here, 'fake-screen.mjs'), log, 'raw'] });
  const lines = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter((l) => l && !l.startsWith('indicator')) : []);
  return { screen, lines };
}

test('키 이름·단축키 → 입력(수식 키는 먼저 누르고 나중에 뗀다)', () => {
  assert.equal(keyCode('Enter'), 13);
  assert.equal(keyCode('a'), 65);
  assert.equal(keyCode('F5'), 116);
  assert.equal(keyCode('한영'), 21);
  assert.equal(keyCode('없는키'), null);
  assert.deepEqual(comboEvents('ctrl+shift+t').map((e) => `${e.d ? 'd' : 'u'}${e.vk}`), ['d162', 'd160', 'd84', 'u84', 'u160', 'u162']);
  assert.deepEqual(comboEvents('enter').map((e) => `${e.d ? 'd' : 'u'}${e.vk}`), ['d13', 'u13']);
  assert.throws(() => comboEvents('ctrl+없는키'), /모르는 키/);
});

test('에이전트 화면 도구: 꺼져 있으면 켜 달라고, 보기 → 그림 좌표로 누르기·입력·키·스크롤', async () => {
  const { screen, lines } = make();
  try {
    let r = (await handleScreenTool('screen_view', {}, 'm1', screen))!;
    assert.equal(r.isError, true);
    assert.match((r.content[0] as any).text, /꺼져 있음/);

    screen.set({ enabled: true });
    // 보기 전에 누르면 먼저 보라고
    r = (await handleScreenTool('screen_click', { x: 1, y: 1 }, 'm1', screen))!;
    assert.match((r.content[0] as any).text, /먼저 screen_view/);

    r = (await handleScreenTool('screen_view', {}, 'm1', screen))!;
    assert.ok(!r.isError);
    assert.match((r.content[0] as any).text, /화면 4×2/);
    assert.equal((r.content[1] as any).type, 'image');
    assert.equal((r.content[1] as any).mimeType, 'image/jpeg');

    // 그림(4×2)의 (3,1) = 오른쪽 아래 끝 → 0..1 좌표 (1,1)
    r = (await handleScreenTool('screen_click', { x: 3, y: 1, screenshot: false }, 'm1', screen))!;
    assert.match((r.content[0] as any).text, /누름 \(3, 1\)/);
    await handleScreenTool('screen_type', { text: '안녕', screenshot: false }, 'm1', screen);
    await handleScreenTool('screen_key', { keys: 'ctrl+s', screenshot: false }, 'm1', screen);
    await handleScreenTool('screen_scroll', { x: 0, y: 0, direction: 'down', amount: 2, screenshot: false }, 'm1', screen);
    await until(() => lines().length >= 10);
    assert.deepEqual(lines(), [
      'move 0 1.00000 1.00000', 'down 0 1.00000 1.00000 0', 'up 0 1.00000 1.00000 0',
      `text ${Buffer.from('안녕').toString('base64')}`,
      'key d 162', 'key d 83', 'key u 83', 'key u 162',
      'move 0 0.00000 0.00000', 'wheel 0 0.00000 0.00000 -240',
    ]);
    // 누른 뒤 화면을 함께 돌려준다(기본)
    r = (await handleScreenTool('screen_click', { x: 0, y: 0, button: 'right' }, 'm1', screen))!;
    assert.match((r.content[0] as any).text, /오른쪽 누름/);
    assert.equal((r.content[1] as any)?.type, 'image');
    // 다른 메인은 자기 그림을 따로 본다
    r = (await handleScreenTool('screen_click', { x: 0, y: 0 }, 'm2', screen))!;
    assert.match((r.content[0] as any).text, /먼저 screen_view/);
    // 모르는 도구는 null(다른 처리로)
    assert.equal(await handleScreenTool('clink', {}, 'm1', screen), null);
  } finally {
    screen.stop();
  }
});

test('MCP: 화면 도구가 도구 목록에 있고, tools/call 로 그림을 돌려준다', async () => {
  const { screen } = make();
  screen.set({ enabled: true });
  const fakeSessions: any = { screen, presetsForMain: () => [], info: () => undefined };
  try {
    const list: any = await handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'm1', fakeSessions);
    const names = list.result.tools.map((t: any) => t.name);
    for (const t of SCREEN_TOOLS) assert.ok(names.includes(t.name), t.name);
    const call: any = await handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'screen_view', arguments: { width: 800 } } }, 'm1', fakeSessions);
    assert.equal(call.result.content[1].type, 'image');
    assert.ok(Buffer.from(call.result.content[1].data, 'base64').subarray(0, 2).equals(Buffer.from([0xff, 0xd8])));
  } finally {
    screen.stop();
  }
});
