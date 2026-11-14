import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/memory.ts';

test('기억: 처음엔 전부, 그 뒤엔 더하거나 고친 것만, 지우면 전부 다시, 공통 지침은 바뀔 때만', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mem-')), 'memory.json');
  const m = new MemoryStore(file);
  assert.equal(m.noteFor().text, ''); // 아무것도 없으면 붙이지 않는다
  const a = m.add('보고에 이모지 쓰지 않기', '영업');
  assert.equal(m.add('보고에 이모지  쓰지 않기', 'x').id, a.id); // 같은 글은 한 번만
  m.setGuide('먼저 확인한다');
  let n = m.noteFor();
  assert.match(n.text, /\[공통 지침[^\n]*\n먼저 확인한다/);
  assert.match(n.text, /- 보고에 이모지 쓰지 않기/);
  const b = m.add('표보다 글', '관리');
  let n2 = m.noteFor(n.seen);
  assert.doesNotMatch(n2.text, /공통 지침|이모지/);
  assert.match(n2.text, /새로 더하거나 고친 것[^\n]*\n- 표보다 글$/);
  assert.equal(m.noteFor(n2.seen).text, ''); // 그대로면 아무것도
  m.edit(b.id, '표보다 짧은 글');
  assert.match(m.noteFor(n2.seen).text, /- 표보다 짧은 글$/);
  const n3 = m.noteFor(n2.seen);
  m.remove(a.id);
  const n4 = m.noteFor(n3.seen);
  assert.match(n4.text, /전부, 앞의 기억 대신/);
  assert.doesNotMatch(n4.text, /이모지/);
  // 다시 읽어도 그대로
  const again = new MemoryStore(file);
  assert.deepEqual(again.public().items.map((x) => x.text), ['표보다 짧은 글']);
  assert.equal(again.public().guide, '먼저 확인한다');
  assert.throws(() => m.add('  ', 'x'), /비어 있음/);
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
