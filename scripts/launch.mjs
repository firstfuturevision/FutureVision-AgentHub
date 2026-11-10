// Agent Hub 실행기 — 서버(src/main.ts)를 띄우고, 업데이트를 받아 끝나면(종료 코드 75) 다시 띄운다.
//   npm start                     이 창에서 켠다(창을 닫으면 꺼짐)
//   node scripts/launch.mjs --background [--open]   창 없이 뒤에서 켠다. 이미 켜져 있으면 브라우저만 연다
//   npm run stop                  뒤에서 도는 것을 끈다
// 서버 인자(--config 등)는 그대로 넘긴다. 운영체제 공통(Windows·macOS·리눅스).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const root = join(dirname(self), '..');
const RESTART = 75;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const li = argv.indexOf('--log');
const logArg = li >= 0 ? argv[li + 1] : undefined;
// 실행기 자신의 인자는 빼고 서버에 넘긴다
const pass = argv.filter((a, i) => !['--open', '--background', '--stop', '--log'].includes(a) && argv[i - 1] !== '--log');

const ci = pass.indexOf('--config');
let cfg = {};
try {
  cfg = JSON.parse(readFileSync(resolve(root, ci >= 0 ? pass[ci + 1] : 'config.json'), 'utf8'));
} catch {}
const port = Number(cfg.port) || 4317;
const dataDir = resolve(root, cfg.dataDir ?? './data');
const pidFile = join(dataDir, `hub-${port}.pid`);
const url = `http://127.0.0.1:${port}`;

async function alive() {
  try {
    return (await fetch(`${url}/info`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

function openBrowser() {
  const [cmd, args] =
    process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
  p.on('error', () => console.log(`[agent-hub] 브라우저를 열지 못함. 직접 여세요: ${url}`));
  p.unref();
}

async function openWhenReady() {
  for (let i = 0; i < 60; i++) {
    if (await alive()) return openBrowser();
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`[agent-hub] 30초 안에 켜지지 않음. 기록을 확인하세요: ${join(dataDir, 'logs', 'hub.log')}`);
}

function stop() {
  let pids;
  try {
    pids = JSON.parse(readFileSync(pidFile, 'utf8'));
  } catch {
    console.log('[agent-hub] 뒤에서 도는 Agent Hub 가 없음');
    return;
  }
  // 서버를 끄면 실행기도 따라 끝난다. 혹시 남으면 실행기도 끈다
  for (const pid of [pids.server, pids.launcher]) {
    try {
      if (pid) process.kill(pid);
    } catch {}
  }
  rmSync(pidFile, { force: true });
  console.log('[agent-hub] 껐습니다');
}

let child;
function run() {
  child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'src/main.ts', ...pass], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, AGENT_HUB_LAUNCHER: '1' },
  });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(pidFile, JSON.stringify({ launcher: process.pid, server: child.pid }));
  child.on('exit', (code) => {
    if (code === RESTART) {
      console.log('[agent-hub] 업데이트를 받아 다시 켭니다');
      setTimeout(run, 1000);
      return;
    }
    try {
      if (JSON.parse(readFileSync(pidFile, 'utf8')).launcher === process.pid) rmSync(pidFile, { force: true });
    } catch {}
    process.exit(code ?? 1);
  });
}

if (has('--stop')) {
  stop();
} else if (await alive()) {
  // 이미 켜져 있으면 하나 더 띄우지 않는다
  console.log(`[agent-hub] 이미 켜져 있음: ${url}`);
  if (has('--open')) openBrowser();
} else if (has('--background')) {
  // 창 없이 뒤에서: 자신을 떼어 내 다시 띄우고, 출력은 기록 파일로
  const log = logArg ?? join(dataDir, 'logs', 'hub.log');
  mkdirSync(dirname(log), { recursive: true });
  const out = openSync(log, 'a');
  const bg = spawn(process.execPath, [self, ...pass], { cwd: root, detached: true, stdio: ['ignore', out, out], windowsHide: true });
  bg.unref();
  if (has('--open')) await openWhenReady();
  else console.log(`[agent-hub] 뒤에서 켰습니다: ${url}`);
} else {
  // Ctrl+C 는 서버도 함께 받는다. 실행기는 서버가 끝나길 기다렸다가 같이 끝난다.
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => child?.kill());
  if (existsSync(pidFile)) rmSync(pidFile, { force: true }); // 앞서 비정상으로 끝나 남은 것
  run();
  if (has('--open')) void openWhenReady();
}
