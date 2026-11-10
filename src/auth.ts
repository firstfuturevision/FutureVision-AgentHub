import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentKind } from './protocol.ts';

/**
 * 연동 — AI 마다 "로그인"(CLI 가 저장한 계정) 또는 "API 키" 중 하나.
 * API 키는 이 PC 의 data/auth.json 에만 두고 화면에는 "설정됨"만 보낸다.
 * Agent Hub 가 그 AI 를 띄울 때만 환경 변수로 넣는다(PC 전체 환경 변수는 건드리지 않음).
 *  - Claude : ANTHROPIC_API_KEY
 *  - Codex  : OPENAI_API_KEY·CODEX_API_KEY + ACP authenticate(api-key)
 *  - Gemini : GEMINI_API_KEY + Hub 전용 시스템 설정(GEMINI_CLI_SYSTEM_SETTINGS_PATH)으로 인증 방식만 바꿈 — 개인 ~/.gemini 는 그대로
 *             회사(Workspace) 계정 로그인이면 GOOGLE_CLOUD_PROJECT
 */
export type AuthMode = 'login' | 'apikey';
interface Entry { mode: AuthMode; key?: string; project?: string }
type State = Record<AgentKind, Entry>;

export interface PublicAuth { mode: AuthMode; hasKey: boolean; project?: string }

const KEY_RE = /^[\x21-\x7e]{8,300}$/; // 공백 없는 보이는 글자
const PROJECT_RE = /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/; // Google Cloud 프로젝트 ID 규칙

export class AuthStore {
  private file: string;
  private state: State = { claude: { mode: 'login' }, codex: { mode: 'login' }, gemini: { mode: 'login' } };

  constructor(file: string) {
    this.file = file;
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        for (const a of ['claude', 'codex', 'gemini'] as AgentKind[]) {
          const e = raw?.[a];
          if (!e) continue;
          this.state[a] = {
            mode: e.mode === 'apikey' ? 'apikey' : 'login',
            ...(typeof e.key === 'string' && KEY_RE.test(e.key) ? { key: e.key } : {}),
            ...(typeof e.project === 'string' && PROJECT_RE.test(e.project) ? { project: e.project } : {}),
          };
        }
      } catch {}
    }
  }

  /** 화면용 — 키 값은 절대 내보내지 않는다 */
  public(): Record<AgentKind, PublicAuth> {
    const out = {} as Record<AgentKind, PublicAuth>;
    for (const [a, e] of Object.entries(this.state) as [AgentKind, Entry][]) {
      out[a] = { mode: e.mode, hasKey: Boolean(e.key), ...(e.project ? { project: e.project } : {}) };
    }
    return out;
  }

  /** 바꾸기. key: 문자열=새 키, null=지우기, 없음=그대로 */
  set(agent: AgentKind, input: { mode?: unknown; key?: unknown; project?: unknown }) {
    const e = { ...this.state[agent] };
    if (input.mode === 'login' || input.mode === 'apikey') e.mode = input.mode;
    if (input.key === null) delete e.key;
    else if (typeof input.key === 'string' && input.key.trim()) {
      const k = input.key.trim();
      if (!KEY_RE.test(k)) throw new Error('API 키 형식이 맞지 않음(공백 없이 8자 이상)');
      e.key = k;
    }
    if (agent === 'gemini' && input.project !== undefined) {
      const p = typeof input.project === 'string' ? input.project.trim() : '';
      if (p && !PROJECT_RE.test(p)) throw new Error('Google Cloud 프로젝트 ID 형식이 맞지 않음(영문 소문자·숫자·- 6~63자)');
      if (p) e.project = p;
      else delete e.project;
    }
    if (e.mode === 'apikey' && !e.key) throw new Error('API 키를 먼저 넣어 주세요');
    this.state[agent] = e;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }

  /** 그 AI 를 띄울 때 넣을 환경 변수와 ACP 인증 방식 */
  launch(agent: AgentKind): { env: Record<string, string>; authMethod?: string } {
    const e = this.state[agent];
    const env: Record<string, string> = {};
    if (agent === 'gemini' && e.project) env.GOOGLE_CLOUD_PROJECT = e.project;
    if (e.mode !== 'apikey' || !e.key) return { env };
    if (agent === 'claude') env.ANTHROPIC_API_KEY = e.key;
    if (agent === 'codex') {
      env.OPENAI_API_KEY = e.key;
      env.CODEX_API_KEY = e.key;
      return { env, authMethod: 'api-key' };
    }
    if (agent === 'gemini') {
      env.GEMINI_API_KEY = e.key;
      // 인증 방식만 API 키로 — Hub 전용 시스템 설정 파일(시스템 설정이 개인 설정보다 우선)
      const sys = join(dirname(this.file), 'gemini-system-settings.json');
      writeFileSync(sys, JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } } }));
      env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = sys;
    }
    return { env };
  }
}
