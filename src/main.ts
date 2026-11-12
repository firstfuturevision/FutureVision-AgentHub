import { mkdirSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.ts';
import { SessionManager } from './sessions.ts';
import { ClaudeAdapter } from './adapters/claude.ts';
import { AcpAdapter } from './adapters/acp.ts';
import { openTerminal, isElevated } from './terminal.ts';
import { PresetStore } from './presets.ts';
import { ToolStore } from './tools.ts';
import { AuthStore } from './auth.ts';
import { GitHub } from './github.ts';
import { cliStatus } from './install.ts';
import { Updater } from './update.ts';
import { HubSkillStore } from './hubskills.ts';
import { WorkPresetStore } from './workpresets.ts';
import { ScheduleStore } from './schedules.ts';
import { SharedRepo } from './shared.ts';
import { AutoStart } from './autostart.ts';
import { RemoteAccess } from './remote.ts';
import { ScreenControl } from './screen.ts';
import { startLocalServer } from './transports/local.ts';
import { startDashboardLink } from './transports/dashboard.ts';
import type { AgentKind } from './protocol.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argi = process.argv.indexOf('--config');
const cfg = loadConfig(root, argi > 0 ? process.argv[argi + 1] : undefined);
mkdirSync(cfg.workspaceRoot, { recursive: true });

const NAMES = { claude: 'Claude', gemini: 'Gemini', codex: 'Codex' } as const;
const elevated = isElevated();
if (elevated) {
  console.warn('[agent-hub] 경고: 관리자 권한으로 실행 중 — 에이전트와 터미널도 모두 관리자 권한을 갖는다. 일반 사용자로 다시 실행 권장.');
}

const presets = new PresetStore(join(cfg.dataDir, 'presets.json'));
const tools = new ToolStore(join(cfg.dataDir, 'tools.json'));
const auth = new AuthStore(join(cfg.dataDir, 'auth.json'));
const github = new GitHub(join(cfg.dataDir, 'profiles', 'gh'));
void github.status(); // gh 가 방금 설치돼 PATH 에 없으면 이때 찾아 붙인다
const hubSkills = new HubSkillStore(join(cfg.dataDir, 'skills'));
const workPresets = new WorkPresetStore(join(cfg.dataDir, 'work-presets.json'));
const schedules = new ScheduleStore(join(cfg.dataDir, 'schedules.json'));

const sessions = new SessionManager({
  workspaceRoot: cfg.workspaceRoot,
  dataDir: cfg.dataDir,
  presets,
  tools,
  auth,
  gitEnv: () => github.sessionEnv(),
  hubSkills,
  workPresets,
  schedules,
  profilesDir: join(cfg.dataDir, 'profiles'),
  // 로그인 터미널에는 비밀이 아닌 값만 넘긴다(전용 프로필 경로, Gemini 프로젝트 ID). API 키는 명령줄에 싣지 않는다.
  openTerminal: (agent, dir, profile) => {
    const env: Record<string, string> = {};
    const project = agent === 'gemini' ? auth.launch('gemini').env.GOOGLE_CLOUD_PROJECT : undefined;
    if (project) env.GOOGLE_CLOUD_PROJECT = project;
    if (profile && agent === 'claude') env.CLAUDE_CONFIG_DIR = join(cfg.dataDir, 'profiles', 'claude');
    if (profile && agent === 'codex') env.CODEX_HOME = join(cfg.dataDir, 'profiles', 'codex');
    for (const v of Object.values(env)) if (v.includes(cfg.dataDir)) mkdirSync(v, { recursive: true });
    return openTerminal(`${NAMES[agent]} ${profile ? '에이전트' : '기본'} 로그인`, cfg.terminal[agent], dir, env);
  },
  mcpBaseUrl: `http://127.0.0.1:${cfg.port}/mcp`,
  clinkWaitMs: cfg.clinkWaitMinutes * 60 * 1000,
  makeAdapter: (agent: AgentKind) => {
    switch (agent) {
      case 'claude':
        return new ClaudeAdapter(cfg.claude);
      case 'gemini':
        return new AcpAdapter({ label: 'Gemini', ...cfg.gemini });
      case 'codex':
        return new AcpAdapter({ label: 'Codex', ...cfg.codex });
    }
  },
});

// 업데이트: 받은 뒤 스스로 다시 켠다. 실행기(npm start)로 띄웠으면 실행기가(종료 코드 75),
// 아니면 같은 명령으로 새 Agent Hub 를 떼어 띄우고 꺼진다(새 것은 화면 포트가 비기를 기다린다)
const updater = new Updater({
  root,
  file: join(cfg.dataDir, 'update.json'),
  defaultRepo: cfg.updateRepo,
  gitEnv: () => github.sessionEnv(),
  busy: () => sessions.list().some((s) => s.status === 'working' || s.status === 'starting'),
  restart: () => (process.env.AGENT_HUB_LAUNCHER === '1' ? shutdown(75) : selfRestart()),
});

/** 실행기 없이 켠 경우의 다시 켜기: 같은 node·같은 인자로 떼어 띄우고(출력은 data/logs/hub.log) 이것은 끈다 */
function selfRestart() {
  const logFile = join(cfg.dataDir, 'logs', 'hub.log');
  mkdirSync(dirname(logFile), { recursive: true });
  const out = openSync(logFile, 'a');
  const next = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
    env: { ...process.env, AGENT_HUB_RESTART_WAIT: '1' },
  });
  next.unref();
  console.log(`[agent-hub] 업데이트를 받아 다시 켭니다(새 프로세스 ${next.pid}, 기록 ${logFile})`);
  shutdown(0);
}

// 공유 레포: 프리셋·에이전트·스킬·툴을 회사 GitHub 레포로 주고받는다
const shared = new SharedRepo({
  file: join(cfg.dataDir, 'shared.json'),
  dir: join(cfg.dataDir, 'shared', 'repo'),
  presets,
  workPresets,
  tools,
  skills: hubSkills,
  gitEnv: () => github.sessionEnv(),
  author: async () => (await github.status()).login,
  // 시험용: GitHub 대신 로컬 레포(가짜 AI 화면 확인)
  remoteUrl: process.env.AGENT_HUB_SHARED_REMOTE ? () => process.env.AGENT_HUB_SHARED_REMOTE! : undefined,
  onChange: () => sessions.presetsChanged(),
});
sessions.attachShared(shared); // 메인이 대화로 공유 레포에 올릴 때

const restored = sessions.restore();
if (restored) console.log(`[agent-hub] 기록에서 작업 ${restored}개를 되살림(대기 — 다음 지시 때 CLI 를 다시 띄움)`);

const remote = new RemoteAccess(join(cfg.dataDir, 'remote.json'), cfg.port + 2); // 원격 접속(사무실 네트워크만)
// 화면 제어(기본 꺼짐) — Windows 는 도우미를 처음 쓸 때 컴파일해 data/bin 에 둔다
const screen = new ScreenControl({ file: join(cfg.dataDir, 'screen.json'), binDir: join(cfg.dataDir, 'bin'), source: join(root, 'src', 'screen-helper.cs') });
// 스스로 다시 켤 때는 앞의 Agent Hub 가 화면 포트를 놓을 때까지 기다린다(최대 30초)
const serverOpts: Parameters<typeof startLocalServer>[0] = { port: cfg.port, uiDir: join(root, 'ui'), sessions, info: {
    elevated,
    bootId: randomUUID(), // 화면이 "다시 켜졌다"를 알아채고 새로 고치는 데 쓴다
    platform: process.platform,
    mainAgent: cfg.mainAgent,
    models: cfg.models,
    workspaceRoot: cfg.workspaceRoot,
    dataDir: cfg.dataDir,
    dashboard: cfg.dashboard.enabled,  },
  presets,
  tools,
  auth,
  github,
  updater,
  // 설치 터미널: 설치 중 확인 창(약관·관리자 권한)은 사람이 직접 누른다
  openInstall: (title: string, command: string) => openTerminal(title, command, cfg.workspaceRoot, github.terminalEnv()),
  clis: () => cliStatus({
    claude: [cfg.claude.command, cfg.terminal.claude.split(' ')[0]],
    codex: [cfg.codex.command, cfg.terminal.codex.split(' ')[0]],
    gemini: [cfg.gemini.command, cfg.terminal.gemini.split(' ')[0]],
  }),
  hubSkills,
  workPresets,
  schedules,
  shared,
  // 연동의 자동 실행(로그인하면 뒤에서 켜기). 시험용: AGENT_HUB_STARTUP_DIR 로 시작프로그램 폴더를 바꾼다
  autostart: new AutoStart({ root, startupDir: process.env.AGENT_HUB_STARTUP_DIR || undefined }),
  // 원격 접속(사무실 네트워크만, 공용 비밀번호). 끄면 이 PC 에서만. 원격 포트 기본 = 화면 포트 + 2
  remote,
  screen,
};
const server = await (async () => {
  for (let i = 0; ; i++) {
    try {
      return await startLocalServer(serverOpts);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || process.env.AGENT_HUB_RESTART_WAIT !== '1' || i >= 60) throw err;
      await new Promise((ok) => setTimeout(ok, 500));
    }
  }
})();
// 예약: 20초마다 차례가 된 것을 실행한다
const scheduleTimer = setInterval(() => void sessions.runSchedules(), 20_000);
// 업데이트: 1분마다 정한 시각이 지났는지 본다(켜진 뒤 처음은 10초 뒤)
const updateTimer = setInterval(() => void updater.tick(), 60_000);
const firstUpdate = setTimeout(() => void updater.tick(), 10_000);
// 공유 레포: 켜고 15초 뒤, 그다음 6시간마다 받는다
const firstShared = setTimeout(() => void shared.tick(), 15_000);
const sharedTimer = setInterval(() => void shared.tick(), 6 * 60 * 60 * 1000);
const stopDashboard = startDashboardLink(cfg.dashboard, sessions);
console.log(`[agent-hub] 직접 작업 화면: http://127.0.0.1:${cfg.port}`);
if (remote.enabled) for (const u of remote.urls()) console.log(`[agent-hub] 원격 접속(같은 사무실 네트워크): ${u}`);
console.log(`[agent-hub] 작업 폴더 뿌리: ${cfg.workspaceRoot}`);

/** 끄기. code 75 = 업데이트를 받아 다시 켜기(실행기가 다시 띄움) */
function shutdown(code = 0) {
  stopDashboard();
  clearInterval(scheduleTimer);
  clearInterval(updateTimer);
  clearTimeout(firstUpdate);
  clearTimeout(firstShared);
  clearInterval(sharedTimer);
  sessions.stopAll();
  server.close();
  setTimeout(() => process.exit(code), 3500);
}
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
