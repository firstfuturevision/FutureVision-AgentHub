import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-ignore — 실행기·설치 스크립트는 그냥 JS(.mjs)
import { plan, apply, removeFiles, runWindows } from '../scripts/setup.mjs';
import { linuxTerminalArgs } from '../src/terminal.ts';
import { linuxGhInstall } from '../src/github.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'agent hub setup '));
const ROOT = '/opt/My Work/agent-hub';
const NODE = '/usr/bin/node';

test('시작 설정(리눅스): 앱 아이콘·바탕화면·자동 시작 .desktop 을 만들고 지운다', () => {
  const home = tmp();
  mkdirSync(join(home, 'Desktop'));
  const files = plan({ platform: 'linux', home, root: ROOT, node: NODE });
  assert.equal(files.length, 3);
  const made = apply(files);
  const app = readFileSync(join(home, '.local', 'share', 'applications', 'agent-hub.desktop'), 'utf8');
  assert.match(app, /^Exec="\/usr\/bin\/node" "\/opt\/My Work\/agent-hub\/scripts\/launch\.mjs" --background --open$/m); // 공백 든 경로는 따옴표
  const auto = readFileSync(join(home, '.config', 'autostart', 'agent-hub.desktop'), 'utf8');
  assert.match(auto, /--background$/m);
  assert.doesNotMatch(auto, /--open/); // 자동 시작은 브라우저를 열지 않는다
  if (process.platform !== 'win32') assert.equal(statSync(made[0]).mode & 0o111, 0o111);
  assert.equal(removeFiles(files).length, 3);
  assert.ok(!existsSync(made[0]));
});

test('시작 설정(macOS): .command 와 LaunchAgent', () => {
  const home = tmp();
  const files = plan({ platform: 'darwin', home, root: '/Users/a/agent & hub', node: NODE });
  apply(files);
  const cmd = readFileSync(join(home, 'Desktop', 'Agent Hub.command'), 'utf8');
  assert.match(cmd, /exec '\/usr\/bin\/node' '\/Users\/a\/agent & hub\/scripts\/launch\.mjs' --background --open/);
  const plist = readFileSync(join(home, 'Library', 'LaunchAgents', 'com.firstfuturevision.agenthub.plist'), 'utf8');
  assert.match(plist, /<string>\/Users\/a\/agent &amp; hub\/scripts\/launch\.mjs<\/string>/); // XML 이스케이프
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  removeFiles(files);
});

test('시작 설정(Windows): 바탕화면·시작 메뉴·시작프로그램 바로가기', { skip: process.platform !== 'win32' }, () => {
  const base = tmp();
  const env = { AH_DESKTOP: join(base, 'd'), AH_PROGRAMS: join(base, 'p'), AH_STARTUP: join(base, 's') };
  for (const d of Object.values(env)) mkdirSync(d);
  const made = runWindows({ root: 'C:\\My Work\\agent-hub', node: process.execPath, env });
  assert.equal(made.length, 3);
  for (const d of Object.values(env)) assert.ok(existsSync(join(d, 'Agent Hub.lnk')));
  assert.equal(runWindows({ remove: true, env }).length, 3);
  assert.ok(!existsSync(join(env.AH_STARTUP, 'Agent Hub.lnk')));
});

test('리눅스 터미널 창: 있는 터미널을 골라 폴더·명령은 인자로만 넘긴다', () => {
  const only = (name: string) => (c: string) => c === name;
  const [cmd, args] = linuxTerminalArgs('Claude 로그인', 'claude', '/home/u/My Work', only('gnome-terminal'))!;
  assert.equal(cmd, 'gnome-terminal');
  assert.deepEqual(args.slice(0, 4), ['--title', 'Claude 로그인', '--', 'sh']);
  assert.equal(args.at(-2), '/home/u/My Work');
  assert.equal(args.at(-1), 'claude');
  assert.equal(linuxTerminalArgs('t', 'x', '/', only('xterm'))![0], 'xterm');
  assert.equal(linuxTerminalArgs('t', 'x', '/', () => false), null);

  assert.match(linuxGhInstall(only('apt-get')), /sudo apt-get install -y gh/);
  assert.match(linuxGhInstall(only('dnf')), /dnf install -y gh/);
  assert.throws(() => linuxGhInstall(() => false), /패키지 관리자/);
});

test('자동 실행 켜고 끄기: 자동 시작 하나만 만들고 지운다(바탕화면 아이콘은 안 건드림)', async () => {
  const { AutoStart } = await import('../src/autostart.ts');
  // 리눅스
  const home = tmp();
  const lx = new AutoStart({ platform: 'linux', home, root: ROOT, node: NODE });
  assert.deepEqual(lx.status(), { supported: true, enabled: false });
  assert.deepEqual(await lx.set(true), { supported: true, enabled: true });
  assert.match(readFileSync(join(home, '.config', 'autostart', 'agent-hub.desktop'), 'utf8'), /--background$/m);
  assert.ok(!existsSync(join(home, '.local', 'share', 'applications', 'agent-hub.desktop')));
  assert.deepEqual(await lx.set(false), { supported: true, enabled: false });
  // macOS
  const mac = new AutoStart({ platform: 'darwin', home, root: '/Users/a/hub', node: NODE });
  await mac.set(true);
  assert.ok(existsSync(join(home, 'Library', 'LaunchAgents', 'com.firstfuturevision.agenthub.plist')));
  assert.ok(!existsSync(join(home, 'Desktop', 'Agent Hub.command')));
  // Windows: 실제 바로가기(이 PC 가 Windows 일 때만)
  if (process.platform === 'win32') {
    const dir = join(tmp(), 'Startup');
    const win = new AutoStart({ root: process.cwd(), startupDir: dir });
    assert.deepEqual(await win.set(true), { supported: true, enabled: true });
    assert.ok(existsSync(join(dir, 'Agent Hub.lnk')));
    assert.deepEqual(await win.set(false), { supported: true, enabled: false });
  }
});
