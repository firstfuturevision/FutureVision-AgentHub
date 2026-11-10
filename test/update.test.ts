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

test('업데이트: 수동이면 확인만, 받으면 앞으로 감기 후 다시 켜기', async () => {
  const { base, origin, pc, url } = setup();
  const file = join(base, 'update.json');
  let restarted = 0;
  let busy = true;
  const u = make(pc, file, url, () => restarted++, () => busy);
  u.set({ mode: 'manual' });

  await u.check();
  assert.equal(u.public().state, 'latest');

  push(origin, '2\n');
  push(origin, '3\n');
  await u.tick(new Date(Date.now() + 2 * 86400_000)); // 정한 시각이 지남 → 수동: 확인만
  assert.equal(u.public().state, 'available');
  assert.equal(u.public().behind, 2);
  assert.equal(readFileSync(join(pc, 'a.txt'), 'utf8').trim(), '1'); // 받지 않음

  await u.apply();
  assert.equal(readFileSync(join(pc, 'a.txt'), 'utf8').trim(), '3');
  assert.equal(u.public().state, 'ready');
  assert.equal(restarted, 0); // 작업이 진행 중이면 기다린다
  busy = false;
  u.maybeRestart();
  assert.equal(restarted, 1);
  u.maybeRestart();
  assert.equal(restarted, 1); // 한 번만

  // 레포 설정(origin)은 건드리지 않는다
  assert.equal(git(pc, 'remote'), 'origin');
});
