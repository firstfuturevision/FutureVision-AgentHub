import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { Peers } from '../src/peers.ts';
import { parseVia } from '../src/protocol.ts';

test('이 PC 를 쓰는 사람 이름: 저장 · 쓴 사람 정하기(중계 이름 > 설정 > PC 이름)', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'peer-user-')), 'peers.json');
  const p = new Peers(file);
  assert.equal(p.writer(), hostname().slice(0, 40)); // 비어 있으면 PC 이름
  p.setUser('  사람 A\n ');
  assert.equal(p.user, '사람 A');
  assert.equal(p.writer(), '사람 A');
  assert.equal(p.writer('대시보드 계정'), '대시보드 계정');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).user, '사람 A');
  assert.equal(new Peers(file).user, '사람 A'); // 다시 켜도 그대로
  p.setUser('');
  assert.equal(p.writer(), hostname().slice(0, 40));
});

test('원격 접속 표에 쓴 사람(by)이 함께 온다', () => {
  assert.deepEqual(parseVia({ app: 'Agent Hub pc-a', label: '사람', by: '사람 A' }), { app: 'Agent Hub pc-a', label: '사람', by: '사람 A' });
  assert.deepEqual(parseVia({ app: 'Agent Hub pc-a', label: '사람' }), { app: 'Agent Hub pc-a', label: '사람' });
});
