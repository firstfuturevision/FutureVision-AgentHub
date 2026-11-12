import type { ScreenControl } from './screen.ts';

/**
 * 메인 에이전트에게 주는 화면 제어 도구(MCP) — 사람이 쓰는 화면 제어(src/screen.ts)를 그대로 쓴다.
 *  - 화면 제어 스위치가 켜져 있을 때만(꺼져 있으면 켜 달라고 사람에게 말하라고 돌려준다).
 *  - screen_view 가 돌려준 그림의 픽셀 좌표로 누른다. 그림 크기는 메인마다 기억한다(모니터·너비가 바뀌면 다시 본다).
 *  - 누르고 쓰는 도구는 0.6초 뒤 화면을 다시 찍어 함께 돌려준다(screenshot:false 면 글만).
 */
export const SCREEN_TOOLS = [
  {
    name: 'screen_view',
    title: '화면 보기',
    description: '이 PC 화면을 그림으로 본다. 누르기 전에 먼저 본다. 다른 화면 도구의 x·y 는 이 그림의 픽셀 좌표다.',
    inputSchema: {
      type: 'object',
      properties: {
        monitor: { type: 'integer', description: '선택: 모니터 번호(0 = 첫째). 기본 0' },
        width: { type: 'integer', description: '선택: 그림 너비(픽셀, 640~1920). 기본 1280. 글자가 작으면 크게' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'screen_click',
    title: '화면 누르기',
    description: 'screen_view 그림의 (x, y) 를 누른다. 누른 뒤의 화면을 돌려준다.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' }, y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: '기본 left' },
        double: { type: 'boolean', description: '두 번 누르기' },
        screenshot: { type: 'boolean', description: '누른 뒤 화면을 돌려줄지(기본 true)' },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
  },
  {
    name: 'screen_drag',
    title: '화면 끌기',
    description: '(x, y) 에서 눌러 (to_x, to_y) 까지 끌어 놓는다.',
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, to_x: { type: 'number' }, to_y: { type: 'number' }, screenshot: { type: 'boolean' } },
      required: ['x', 'y', 'to_x', 'to_y'],
      additionalProperties: false,
    },
  },
  {
    name: 'screen_scroll',
    title: '화면 스크롤',
    description: '(x, y) 위에서 위·아래로 스크롤한다.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' }, y: { type: 'number' },
        direction: { type: 'string', enum: ['up', 'down'] },
        amount: { type: 'integer', description: '칸 수(1~10). 기본 3' },
        screenshot: { type: 'boolean' },
      },
      required: ['x', 'y', 'direction'],
      additionalProperties: false,
    },
  },
  {
    name: 'screen_type',
    title: '글자 입력',
    description: '지금 입력 칸에 글자를 넣는다(한글 포함, 줄바꿈은 Enter). 먼저 칸을 눌러 둔다.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, screenshot: { type: 'boolean' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'screen_key',
    title: '키 누르기',
    description: '키나 단축키를 누른다. 예: "enter", "esc", "tab", "ctrl+c", "ctrl+shift+t", "alt+tab", "f5", "win", "한영".',
    inputSchema: {
      type: 'object',
      properties: { keys: { type: 'string' }, screenshot: { type: 'boolean' } },
      required: ['keys'],
      additionalProperties: false,
    },
  },
];

/** 사람에게 그림을 채팅으로 보여 주기 — 화면 제어가 꺼져 있어도 파일은 보여 줄 수 있다 */
export const SHOW_IMAGE_TOOL = {
  name: 'show_image',
  title: '채팅에 그림 띄우기',
  description: '사람에게 그림을 채팅에 띄워 보여 준다. path 를 주면 그 그림 파일(png·jpg·gif·webp, 작업 폴더 기준 또는 절대 경로), 없으면 지금 이 PC 화면을 찍어서(화면 제어가 켜져 있어야 함). 사람이 "찍어서 보여줘·공유해줘"라고 하면 쓴다.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '선택: 보여 줄 그림 파일' },
      caption: { type: 'string', description: '선택: 그림 아래 짧은 설명' },
      monitor: { type: 'integer', description: '선택: 화면을 찍을 때 모니터 번호(기본 0)' },
    },
    additionalProperties: false,
  },
};

export const SCREEN_INSTRUCTION =
  '사람이 화면이나 결과 그림을 보여 달라고 하면 show_image 로 채팅에 띄운다(그림 파일이면 path, 아니면 지금 화면). screen_view 로 본 것은 너만 보고 사람에게는 안 보인다. ' +
  '사람이 이 PC 의 프로그램을 직접 다뤄 달라고 하면(화면에서 누르기·입력) screen_view 로 먼저 보고 screen_click·screen_type·screen_key 로 다룬다. 한 번 할 때마다 돌려받은 화면으로 결과를 확인한다. 화면 제어가 꺼져 있으면 사람에게 Agent Hub 왼쪽 위 화면 제어에서 켜 달라고 한다.';

/** 키 이름 → 윈도우 가상 키 코드(화면 제어 도우미가 받는 형식) */
const NAMED: Record<string, number> = {
  enter: 13, return: 13, tab: 9, esc: 27, escape: 27, backspace: 8, delete: 46, del: 46, space: 32, spacebar: 32,
  up: 38, down: 40, left: 37, right: 39, home: 36, end: 35, pageup: 33, pagedown: 34, insert: 45,
  ctrl: 162, control: 162, shift: 160, alt: 164, option: 164, win: 91, windows: 91, meta: 91, super: 91, cmd: 91, command: 91,
  capslock: 20, printscreen: 44, prtsc: 44, menu: 93, 한영: 21, hangul: 21, 한자: 25, hanja: 25,
  '-': 189, '=': 187, '[': 219, ']': 221, ';': 186, "'": 222, ',': 188, '.': 190, '/': 191, '\\': 220, '`': 192,
};
const MODIFIERS = new Set([162, 160, 164, 91]);

export function keyCode(name: string): number | null {
  const k = name.trim().toLowerCase();
  if (k in NAMED) return NAMED[k];
  if (/^[a-z]$/.test(k)) return k.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(k)) return 48 + Number(k);
  const f = k.match(/^f([1-9]|1[0-9]|2[0-4])$/);
  if (f) return 111 + Number(f[1]);
  return null;
}

/** "ctrl+shift+t" → 누르는 순서대로의 입력(수식 키 먼저 누르고 나중에 뗀다) */
export function comboEvents(keys: string): { t: 'key'; d: boolean; vk: number }[] {
  const parts = keys.split('+').map((p) => p.trim()).filter(Boolean);
  if (keys.trim().endsWith('+') && !parts.includes('+')) parts.push('='); // "ctrl++" 는 드물어 = 로
  const codes = parts.map((p) => {
    const c = keyCode(p);
    if (c === null) throw new Error(`모르는 키: ${p}`);
    return c;
  });
  if (!codes.length) throw new Error('누를 키가 없음');
  const mods = codes.filter((c, i) => i < codes.length - 1 && MODIFIERS.has(c));
  const main = codes.filter((c, i) => !(i < codes.length - 1 && MODIFIERS.has(c)));
  return [
    ...mods.map((vk) => ({ t: 'key' as const, d: true, vk })),
    ...main.flatMap((vk) => [{ t: 'key' as const, d: true, vk }, { t: 'key' as const, d: false, vk }]),
    ...[...mods].reverse().map((vk) => ({ t: 'key' as const, d: false, vk })),
  ];
}

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type Result = { content: Content[]; isError?: boolean };

const views = new Map<string, { m: number; w: number; h: number }>(); // 메인 → 마지막으로 본 그림
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);

/** 화면 도구 하나 실행. 모르는 도구면 null */
export async function handleScreenTool(name: string, a: any, mainId: string, screen: ScreenControl | undefined): Promise<Result | null> {
  if (!SCREEN_TOOLS.some((t) => t.name === name)) return null;
  const err = (t: string): Result => ({ content: [{ type: 'text', text: t }], isError: true });
  if (!screen) return err('이 Agent Hub 에는 화면 제어가 없음');
  if (!screen.supported) return err(`이 PC 에서는 화면 제어를 쓸 수 없음: ${screen.public().reason ?? ''}`);
  if (!screen.enabled) return err('화면 제어가 꺼져 있음. 사람에게 Agent Hub 왼쪽 위 화면 제어에서 켜 달라고 말한다');

  const look = async (monitor: number, width: number, prefix = ''): Promise<Result> => {
    const f = await screen.frame(monitor, width, 70, `agent:${mainId}`);
    if (f.kind !== 'image') return err(`${prefix}화면을 볼 수 없음: ${f.message ?? '관리자 확인 창이나 잠금 화면'}`);
    const { w, h } = jpegSize(f.data) ?? { w: width, h: 0 };
    views.set(mainId, { m: monitor, w, h });
    return { content: [{ type: 'text', text: `${prefix}화면 ${w}×${h}(모니터 ${monitor}). 좌표는 이 그림의 픽셀` }, { type: 'image', data: f.data.toString('base64'), mimeType: f.type }] };
  };

  try {
    if (name === 'screen_view') {
      const m = Number.isInteger(a.monitor) ? Math.max(0, Math.min(15, a.monitor)) : 0;
      const w = Number.isInteger(a.width) ? Math.max(640, Math.min(1920, a.width)) : 1280;
      return await look(m, w);
    }
    const v = views.get(mainId);
    if (!v || !v.h) return err('먼저 screen_view 로 화면을 본다(좌표는 그 그림 기준)');
    const nx = (x: unknown) => Math.min(1, Math.max(0, num(x) / Math.max(1, v.w - 1)));
    const ny = (y: unknown) => Math.min(1, Math.max(0, num(y) / Math.max(1, v.h - 1)));
    const point = (x: unknown, y: unknown) => {
      if (Number.isNaN(num(x)) || Number.isNaN(num(y))) throw new Error('x·y 는 숫자');
      return { x: nx(x), y: ny(y) };
    };
    let did = '';
    if (name === 'screen_click') {
      const p = point(a.x, a.y);
      const b = a.button === 'right' ? 1 : a.button === 'middle' ? 2 : 0;
      const once = [{ t: 'down', ...p, b }, { t: 'up', ...p, b }];
      await screen.input(v.m, [{ t: 'move', ...p }, ...once, ...(a.double ? once : [])]);
      did = `${a.double ? '두 번 ' : ''}${b === 1 ? '오른쪽 ' : b === 2 ? '가운데 ' : ''}누름 (${a.x}, ${a.y})`;
    } else if (name === 'screen_drag') {
      const p = point(a.x, a.y), q = point(a.to_x, a.to_y);
      const steps = Array.from({ length: 8 }, (_, i) => ({ t: 'move', x: p.x + ((q.x - p.x) * (i + 1)) / 8, y: p.y + ((q.y - p.y) * (i + 1)) / 8 }));
      await screen.input(v.m, [{ t: 'move', ...p }, { t: 'down', ...p, b: 0 }]);
      for (const s of steps) { await screen.input(v.m, [s]); await sleep(25); }
      await screen.input(v.m, [{ t: 'up', ...q, b: 0 }]);
      did = `끌어 놓음 (${a.x}, ${a.y}) → (${a.to_x}, ${a.to_y})`;
    } else if (name === 'screen_scroll') {
      const p = point(a.x, a.y);
      const n = Number.isInteger(a.amount) ? Math.max(1, Math.min(10, a.amount)) : 3;
      await screen.input(v.m, [{ t: 'move', ...p }, { t: 'wheel', ...p, dy: (a.direction === 'up' ? 1 : -1) * 120 * n }]);
      did = `${a.direction === 'up' ? '위' : '아래'}로 ${n}칸 스크롤`;
    } else if (name === 'screen_type') {
      if (typeof a.text !== 'string' || !a.text) return err('text 가 비었음');
      await screen.input(v.m, [{ t: 'text', s: a.text.slice(0, 2000) }]);
      did = `글자 ${a.text.length}자 넣음`;
    } else if (name === 'screen_key') {
      await screen.input(v.m, comboEvents(String(a.keys ?? '')));
      did = `키 ${a.keys}`;
    }
    if (a.screenshot === false) return { content: [{ type: 'text', text: did }] };
    await sleep(600);
    return await look(v.m, v.w, `${did}. `);
  } catch (e) {
    return err(`화면 제어 오류: ${(e as Error).message}`);
  }
}

/** JPEG 의 너비·높이(SOF 표지) */
export function jpegSize(b: Buffer): { w: number; h: number } | null {
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    const len = b.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}
