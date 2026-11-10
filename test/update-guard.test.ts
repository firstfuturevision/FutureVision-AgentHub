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

test('업데이트: 이 PC 에서 고쳤거나 따로 커밋했으면 받지 않는다', async () => {
  const { base, origin, pc, url } = setup();
  const u = make(pc, join(base, 'update.json'), url);
  push(origin, '2\n');

  writeFileSync(join(pc, 'a.txt'), 'local\n');
  await u.apply();
  assert.equal(u.public().state, 'blocked');
  assert.match(u.public().message ?? '', /고친 파일/);
  assert.equal(readFileSync(join(pc, 'a.txt'), 'utf8').trim(), 'local');

  git(pc, 'commit', '-qam', 'local');
  await u.apply();
  assert.equal(u.public().state, 'blocked');
  assert.match(u.public().message ?? '', /커밋/);
});

test('업데이트: git 폴더가 아니면 불가, 레포 주소 검사와 기본값', async () => {
  const dir = tmp();
  const file = join(dir, 'update.json');
  const u = new Updater({ root: dir, file, defaultRepo: 'https://github.com/firstfuturevision/FutureVision-AgentHub' });
  await u.check();
  assert.equal(u.public().state, 'notgit');

  assert.throws(() => u.set({ repo: 'http://evil.example/x' }), /형식/);
  assert.throws(() => u.set({ repo: 'https://github.com/a/b; rm -rf /' }), /형식/);
  u.set({ repo: 'https://github.com/acme/hub/' });
  assert.equal(u.repo, 'https://github.com/acme/hub');
  u.set({ repo: '' }); // 비우면 기본 레포
  assert.equal(u.repo, 'https://github.com/firstfuturevision/FutureVision-AgentHub');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).repo, undefined);

  u.set({ mode: 'manual', hour: 6 });
  const again = new Updater({ root: dir, file, defaultRepo: 'x' });
  assert.equal(again.mode, 'manual');
  assert.equal(again.hour, 6);
});

test('업데이트: 마지막 확인 결과는 다시 켜도 남는다', async () => {
  const dir = tmp();
  const file = join(dir, 'update.json');
  const u = new Updater({ root: dir, file, defaultRepo: 'https://github.com/a/b' });
  await u.check();
  const again = new Updater({ root: dir, file, defaultRepo: 'https://github.com/a/b' });
  assert.equal(again.public().state, 'notgit');
  assert.ok(again.public().lastCheck);
});
