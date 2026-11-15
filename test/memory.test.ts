import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/memory.ts';

test('기억: 짧으면 지시마다 전부, 길면 처음엔 전부 · 그 뒤엔 더하거나 고친 것만 · 지우면 전부 다시, 공통 지침은 바뀔 때만', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mem-')), 'memory.json');
  const m = new MemoryStore(file);
  assert.equal(m.noteFor().text, ''); // 아무것도 없으면 붙이지 않는다
  const a = m.add('보고에 이모지 쓰지 않기', '영업');
  assert.equal(m.add('보고에 이모지  쓰지 않기', 'x').id, a.id); // 같은 글은 한 번만
  m.setGuide('먼저 확인한다');
  const n = m.noteFor();
  assert.match(n.text, /\[공통 지침[^\n]*\n먼저 확인한다/);
  assert.match(n.text, /- 보고에 이모지 쓰지 않기/);
  // 짧으면(3000자 안) 바뀐 게 없어도 지시마다 전부 — CLI 가 스스로 줄이며 잃어도 다시 받게. 공통 지침은 바뀔 때만
  const n1 = m.noteFor(n.seen);
  assert.doesNotMatch(n1.text, /공통 지침/);
  assert.match(n1.text, /전부, 앞의 기억 대신[^\n]*\n- 보고에 이모지 쓰지 않기$/);
  // 길면: 더하거나 고친 것만
  const long: string[] = [];
  for (let i = 0; i < 12; i++) long.push(m.add(`긴 규칙 ${i} ${'가'.repeat(280)}`, '관리').id);
  const s0 = m.noteFor(n1.seen).seen;
  assert.equal(m.noteFor(s0).text, ''); // 그대로면 아무것도
  const b = m.add('표보다 글', '관리');
  const n2 = m.noteFor(s0);
  assert.doesNotMatch(n2.text, /이모지|긴 규칙/);
  assert.match(n2.text, /새로 더하거나 고친 것[^\n]*\n- 표보다 글$/);
  m.edit(b.id, '표보다 짧은 글');
  assert.match(m.noteFor(n2.seen).text, /- 표보다 짧은 글$/);
  const n3 = m.noteFor(n2.seen);
  m.remove(long[0]);
  const n4 = m.noteFor(n3.seen);
  assert.match(n4.text, /전부, 앞의 기억 대신/);
  assert.doesNotMatch(n4.text, /긴 규칙 0 /);
  // 다시 읽어도 그대로
  const again = new MemoryStore(file);
  assert.equal(again.public().items.length, 13);
  assert.equal(again.public().guide, '먼저 확인한다');
  assert.throws(() => m.add('  ', 'x'), /비어 있음/);
});

test('기억 80개: 가득 차면 오래된 것을 몰래 버리지 않고 받지 않는다, 곧 가득 차면 알린다. 맞추기는 다른 PC 의 날짜를 지킨다', () => {
  const m = new MemoryStore(join(mkdtempSync(join(tmpdir(), 'mem-')), 'memory.json'));
  for (let i = 0; i < 74; i++) m.add(`규칙 ${i}`, '사람');
  assert.equal(m.fullness(), '');
  m.add('규칙 74', '사람');
  assert.match(m.fullness(), /75\/80개 — 곧 가득 참/);
  for (let i = 75; i < 80; i++) m.add(`규칙 ${i}`, '사람');
  assert.throws(() => m.add('하나 더', '사람'), /80개로 가득 참/);
  assert.equal(m.public().items[0].text, '규칙 0'); // 오래된 것이 남아 있다
  // 맞춘 결과가 넘치면 아무것도 바꾸지 않는다
  const before = JSON.stringify(m.public());
  assert.throws(() => m.replaceShared('', ['새 회사 규칙'], '맞추기'), /넘음/);
  assert.equal(JSON.stringify(m.public()), before);

  const k = new MemoryStore(join(mkdtempSync(join(tmpdir(), 'mem-')), 'memory.json'));
  k.replaceShared('', ['다른 PC 에서 온 규칙', '새로 합친 규칙'], '맞추기', { '다른 PC 에서 온 규칙': '2026-11-01T09:00:00.000Z', '새로 합친 규칙': 'nonsense' });
  const at = Object.fromEntries(k.public().items.map((x) => [x.text, x.at]));
  assert.equal(at['다른 PC 에서 온 규칙'], '2026-11-01T09:00:00.000Z');
  assert.ok(Date.now() - Date.parse(at['새로 합친 규칙']) < 60_000);
});

test('회사·개인 기억: 맞추기는 공통 지침과 회사 기억만 바꾸고 개인 기억은 그대로', () => {
  const m = new MemoryStore(join(mkdtempSync(join(tmpdir(), 'mem-')), 'memory.json'));
  m.add('보고에 이모지 쓰지 않기', '사람'); // 개인
  m.add('외부 플랫폼은 화면 제어로', '사람', 'company');
  m.add('옛 회사 규칙', '사람', 'company');
  assert.deepEqual(m.shared().items.map((x) => x.text), ['외부 플랫폼은 화면 제어로', '옛 회사 규칙']);
  const seen = m.noteFor().seen;
  m.replaceShared('먼저 확인', ['외부 플랫폼은 화면 제어로', '새 회사 규칙', '보고에 이모지 쓰지 않기'], '맞추기 · pc1');
  const items = m.public().items;
  assert.deepEqual(items.filter((x) => x.scope === 'company').map((x) => x.text).sort(), ['보고에 이모지 쓰지 않기', '새 회사 규칙', '외부 플랫폼은 화면 제어로'].sort());
  assert.equal(items.some((x) => x.text === '옛 회사 규칙'), false);
  assert.equal(m.public().guide, '먼저 확인');
  const note = m.noteFor(seen).text;
  assert.match(note, /\[공통 지침/);
  assert.match(note, /\(회사\) 새 회사 규칙/);
});
