import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Updater } from '../src/update.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'agent hub upd '));
const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();

/** 원본 레포(업데이트를 올리는 쪽)와 그것을 clone 한 PC 폴더 */
function setup() {
  const base = tmp();
  const origin = join(base, 'origin');
  execFileSync('git', ['init', '-q', '-b', 'main', origin]);
  writeFileSync(join(origin, 'a.txt'), '1\n');
  git(origin, 'add', '.');
  git(origin, 'commit', '-qm', 'v1');
  const pc = join(base, 'pc');
  execFileSync('git', ['clone', '-q', origin, pc]);
  // 경로에 공백이 있어도 되는 file:// 주소 — https 만 받는 형식 검사는 시험에서 우회한다
  const url = pathToFileURL(origin).href;
  return { base, origin, pc, url };
}
const push = (origin: string, text: string) => {
  writeFileSync(join(origin, 'a.txt'), text);
  git(origin, 'commit', '-qam', text.trim());
};
const make = (pc: string, file: string, url: string, restart?: () => void, busy = () => false) => {
  const u = new Updater({ root: pc, file, defaultRepo: url, restart, busy });
  return u;
};

test('업데이트: 자동이면 정한 시각이 지났을 때 받는다, 하루 한 번', async () => {
  const { base, origin, pc, url } = setup();
  const u = make(pc, join(base, 'update.json'), url);
  assert.equal(u.mode, 'auto');
  push(origin, '2\n');
  const now = new Date();
  await u.tick(now);
  assert.equal(readFileSync(join(pc, 'a.txt'), 'utf8').trim(), '2');
  assert.equal(u.public().state, 'ready');
  assert.equal(u.public().canRestart, false); // 실행기 없이 띄우면 다시 켜야 적용

  push(origin, '3\n');
  await u.tick(new Date(now.getTime() + 60_000)); // 같은 날 다시 — 이미 확인함
  assert.equal(readFileSync(join(pc, 'a.txt'), 'utf8').trim(), '2');

  const slot = u.lastSlot(new Date(now.getTime() + 86400_000));
  await u.tick(new Date(slot.getTime() + 1000)); // 다음 날 정한 시각 뒤
  assert.equal(readFileSync(join(pc, 'a.txt'), 'utf8').trim(), '3');
});

test('업데이트 버튼: 받아 두고 작업이 끝나길 기다리는 동안 "지금 다시 켜기"로 바로 다시 켠다', async () => {
  const { pc, origin, url, base } = setup();
  let restarted = 0;
  const u = make(pc, join(base, 'update.json'), url, () => restarted++, () => true); // 작업이 계속 돈다
  push(origin, '2\n');
  await u.apply();
  assert.equal(u.public().state, 'ready');
  assert.equal(u.public().waiting, true); // 기다리는 중
  assert.equal(restarted, 0);
  u.restartNow();
  assert.equal(restarted, 1);
  assert.equal(u.public().waiting, false);
  u.restartNow(); // 받아 둔 것이 없으면 아무것도 안 한다
  assert.equal(restarted, 1);
});
