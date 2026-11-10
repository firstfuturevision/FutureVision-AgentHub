import { mkdirSync } from 'node:fs';
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

// 업데이트: 실행기(npm start)로 띄웠을 때만 받은 뒤 스스로 다시 켠다
const updater = new Updater({
  root,
  file: join(cfg.dataDir, 'update.json'),
  defaultRepo: cfg.updateRepo,
  gitEnv: () => github.sessionEnv(),
  busy: () => sessions.list().some((s) => s.status === 'working' || s.status === 'starting'),
  restart: process.env.AGENT_HUB_LAUNCHER === '1' ? () => shutdown(75) : undefined,
});

const restored = sessions.restore();
if (restored) console.log(`[agent-hub] 기록에서 작업 ${restored}개를 되살림(끝남 상태)`);

const server = await startLocalServer({ port: cfg.port, uiDir: join(root, 'ui'), sessions, info: {
    elevated,
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
});
// 예약: 20초마다 차례가 된 것을 실행한다
const scheduleTimer = setInterval(() => void sessions.runSchedules(), 20_000);
// 업데이트: 1분마다 정한 시각이 지났는지 본다(켜진 뒤 처음은 10초 뒤)
const updateTimer = setInterval(() => void updater.tick(), 60_000);
const firstUpdate = setTimeout(() => void updater.tick(), 10_000);
const stopDashboard = startDashboardLink(cfg.dashboard, sessions);
console.log(`[agent-hub] 직접 작업 화면: http://127.0.0.1:${cfg.port}`);
console.log(`[agent-hub] 작업 폴더 뿌리: ${cfg.workspaceRoot}`);

/** 끄기. code 75 = 업데이트를 받아 다시 켜기(실행기가 다시 띄움) */
function shutdown(code = 0) {
  stopDashboard();
  clearInterval(scheduleTimer);
  clearInterval(updateTimer);
  clearTimeout(firstUpdate);
  sessions.stopAll();
  server.close();
  setTimeout(() => process.exit(code), 3500);
}
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
