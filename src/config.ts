import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ClaudeOptions } from './adapters/claude.ts';
import type { DashboardOptions } from './transports/dashboard.ts';

export interface Config {
  port: number;  mainAgent: 'claude' | 'gemini' | 'codex'; // 메인 에이전트 기본값(화면에서 바꿀 수 있음)
  clinkWaitMinutes: number; // clink 한 번이 기다리는 최대 시간
  workspaceRoot: string; // 에이전트가 일할 수 있는 폴더의 뿌리
  dataDir: string; // 세션 기록
  claude: ClaudeOptions;
  gemini: AcpAgentConfig;
  codex: AcpAgentConfig;
  terminal: Record<'claude' | 'gemini' | 'codex', string>; // "터미널" 버튼이 대화형으로 실행할 명령
  // 화면 모델 드롭다운의 처음 목록. 로그인 후 CLI 가 실제 목록을 알려 주면(ACP) 그것으로 바뀐다.
  models: Record<'claude' | 'gemini' | 'codex', { id: string; name: string }[]>;
  dashboard: DashboardOptions;
  updateRepo: string; // 업데이트 레포 기본 주소(연동에서 바꿀 수 있음)
}

export interface AcpAgentConfig {
  command: string;
  args: string[];
  startTimeoutMs?: number;
  modelArg?: string;
}

const DEFAULTS: Config = {
  port: 4317,
  mainAgent: 'claude',
  clinkWaitMinutes: 10,
  workspaceRoot: './workspace',
  dataDir: './data',
  claude: { command: 'claude', permissionMode: 'default' },
  gemini: { command: 'gemini', args: ['--experimental-acp'], modelArg: '--model' },
  codex: { command: 'codex-acp', args: [] },
  terminal: { claude: 'claude', gemini: 'gemini', codex: 'codex' },
  models: {
    claude: [
      { id: 'claude-opus-5-5', name: 'Opus 5.5' },
      { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' },
      { id: 'claude-haiku-5-5', name: 'Haiku 5.5' },
      { id: 'claude-fable-5-1', name: 'Fable 5.1' },
    ],
    // gemini-cli 0.23.0 내장 모델 이름 (gemini-cli-core config/models.js)
    gemini: [
      { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro (미리보기)' },
      { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash (미리보기)' },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
    ],
    // 확실하지 않음 — 로그인하면 codex-acp 가 알려 주는 목록으로 바뀐다
    codex: [
      { id: 'gpt-5.5', name: 'GPT-5.5' },
      { id: 'gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max' },
    ],
  },
  dashboard: { enabled: false, url: '', tokenEnv: 'AGENT_HUB_DASHBOARD_TOKEN' },
  updateRepo: 'https://github.com/firstfuturevision/FutureVision-AgentHub',
};

/** config.json 이 있으면 기본값 위에 덮는다. 상대 경로는 저장소 뿌리 기준. */
export function loadConfig(root: string, configPath = 'config.json'): Config {
  const file = resolve(root, configPath);
  const user = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const cfg: Config = {
    ...DEFAULTS,
    ...user,
    claude: { ...DEFAULTS.claude, ...user.claude },
    gemini: { ...DEFAULTS.gemini, ...user.gemini },
    codex: { ...DEFAULTS.codex, ...user.codex },
    terminal: { ...DEFAULTS.terminal, ...user.terminal },
    models: { ...DEFAULTS.models, ...user.models },
    dashboard: { ...DEFAULTS.dashboard, ...user.dashboard },
  };
  cfg.workspaceRoot = resolve(root, cfg.workspaceRoot);
  cfg.dataDir = resolve(root, cfg.dataDir);
  // './' 로 시작하는 명령·인자는 저장소 뿌리 기준(세션은 작업 폴더에서 실행되므로)
  const rel = (s: string) => (s.startsWith('./') ? resolve(root, s) : s);
  cfg.claude.command = rel(cfg.claude.command);
  cfg.claude.extraArgs = cfg.claude.extraArgs?.map(rel);
  for (const a of [cfg.gemini, cfg.codex]) {
    a.command = rel(a.command);
    a.args = a.args.map(rel);
  }
  return cfg;
}
