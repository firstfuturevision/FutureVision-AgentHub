import { randomUUID, createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, existsSync, statSync, readFileSync, writeFileSync, readdirSync, renameSync, rmSync, openSync, readSync, closeSync } from 'node:fs';
import { spawnSync, spawn, execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { dirname, join, resolve, relative, isAbsolute, extname, basename, sep } from 'node:path';
import { AGENTS, EFFORTS, MODEL_RE, viaLabel } from './protocol.ts';
import { scanFolder, setupCommands, cannotMove, packFolder, unpackTo, type MovePlan } from './move.ts';
import type { Effort, AgentKind, Attachment, ClientCommand, CommandOrigin, ContextItem, HostEvent, PermMode, RemoteLink, RemoteVia, SessionInfo, SessionRole } from './protocol.ts';
import { UnavailableAdapter, type AgentAdapter, type AdapterEvent, type StartContext } from './adapters/types.ts';
import { withRole, type Preset, type PresetStore } from './presets.ts';
import type { ToolStore } from './tools.ts';
import type { AuthStore } from './auth.ts';
import type { HubSkillStore } from './hubskills.ts';
import { withGuidelines, type WorkPreset, type WorkPresetStore } from './workpresets.ts';
import { SHARED_KINDS, type SharedRepo, type SharedKind } from './shared.ts';
import { skillsFor, type SkillInfo } from './skills.ts';
import type { ScheduleStore } from './schedules.ts';
import { ClaudeHistory, claudeHome, claudeTranscript } from './external.ts';
import type { ScreenControl } from './screen.ts';
import type { Peers, PeerSummary } from './peers.ts';
import type { MemoryStore } from './memory.ts';
import { forwardedText, intakePrompt, type IntakeStore } from './intake.ts';
import { dataAllows } from './permits.ts';
import type { LimitStore, Account } from './limits.ts';

export type AdapterFactory = (agent: AgentKind) => AgentAdapter;
export type TerminalOpener = (agent: AgentKind, dir: string, profile?: boolean) => Promise<void>;
type Listener = (event: HostEvent) => void;

/** clink 한 번의 결과 — 메인 에이전트가 받는 값 */
export interface ClinkResult {
  continuation_id: string;
  cli_name: AgentKind;
  model: string | null;
  status: 'done' | 'failed' | 'ended' | 'working';
  content: string;
  duration_ms: number;
  cost_usd: number | null;
}

export interface ClinkArgs {
  prompt?: string;
  preset?: string; // 에이전트 프리셋 이름 또는 id — 주면 AI·모델·역할 지침을 프리셋에서 가져온다
  cli_name?: AgentKind;
  model?: string;
  continuation_id?: string;
}

/** 메인이 작업자에게 보낸 한 차례를 모으는 그릇 */
interface Turn {
  texts: string[];
  errors: string[];
  done: { isError: boolean; costUsd: number | null } | null;
  ended: string | null;
  startedAt: number;
  waiters: Set<() => void>;
}

interface Live {
  info: SessionInfo;
  relaunch?: boolean; // 이번 차례가 끝나면 CLI 를 내려 바뀐 설정(생각 깊이)으로 다시 띄운다
  turnEffort?: Effort; // 이번 차례만의 생각 깊이(입력 세션이 고름). 차례가 끝나면 지우고 작업 설정으로
  launchedEffort?: Effort | null; // 지금 떠 있는 CLI 의 생각 깊이
  schedRun?: { id: string; skip: number; started: number; note: string; error?: string }; // 예약으로 보낸 지시의 차례 — 끝나면 예약 결과를 고친다
  adapter: AgentAdapter;
  history: HostEvent[]; // 나중에 붙은 화면이 이어서 볼 수 있게
  token?: string; // main 만: MCP 주소의 비밀 토큰
  turn: Turn | null; // worker 만: 메인이 기다리는 차례
  carry?: string; // 복제한 작업: 첫 지시에 붙일 원래 대화
  role?: Preset; // 에이전트로 시작한 세션: 첫 지시에 붙일 역할 지침
  guide?: WorkPreset; // 프리셋(작업 환경)으로 시작한 세션: 첫 지시에 붙일 지침
  memSeen?: { rev: number; guideRev: number; ids: string[] }; // 이 작업이 받은 기억·공통 지침(다음엔 바뀐 것만)
  merges?: { label: string; text: string }[]; // 포크·분담에서 공유받은 것: 다음 지시에 붙일 내용
  ctx?: { label: string; chars: number }[]; // 이번 CLI 에 이미 넣은 것(앞 대화, 공유) — 다시 띄우면 비운다
  gen?: number; // 몇 번째로 띄운 CLI 인지 — 설정을 바꿔 다시 띄우면 앞 CLI 의 이벤트는 버린다
  dormant?: boolean; // 호스트를 다시 켜서 CLI 가 아직 없음 — 다음 지시 때 띄운다
  resume?: string; // 다음에 띄울 CLI 가 이어 갈 Claude 대화 id(--resume)
  compactPending?: string; // 컨텍스트 정리를 부탁한 사람 — 하던 차례가 끝나면 정리한다
  compacting?: { mode: 'cli' | 'summary'; before: number; text?: string; done?: boolean }; // 정리 중인 차례
  afterCompact?: () => void; // 정리가 끝나면 할 일(입력 세션이 "넘기기 전에 정리"로 넘긴 지시)
  idleSince?: number; // 쉬기 시작한 때 — 오래 쉬면 CLI 를 내려 메모리를 돌려준다(sleepIdle)
  remotes?: Map<string, RemoteLink>; // 연결된 원격 접속(app + label → 연결). 기록 전체에서 모은다 — 기록이 길어 앞이 잘려도 남게
}

const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_INLINE_IMAGE = 5 * 1024 * 1024; // 이보다 큰 이미지는 경로로만 알린다
const MAX_ATTACHMENT = 50 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
function formatSize(n: number): string {
  return n < 1024 ? `${n}B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** 지시한 사람: 원격 접속으로 온 글이면 그 연결 이름(대시보드 · 채팅 #일반), 아니면 보낸 사람 */
const speaker = (e: { from: string; via?: RemoteVia }) => `사람(${e.via ? viaLabel(e.via) : e.from})`;
const remoteKey = (app: string, label: string) => `${app}\u0000${label}`;

/** 대화 기록 → 줄(사람·에이전트 말, 합친 포크). upTo: 사람 지시 몇 번째 차례까지(그다음 지시 앞에서 끊음) */
function conversation(history: HostEvent[], upTo?: number): string[] {
  const lines: string[] = [];
  const turnAt: number[] = []; // 사람 지시마다 그 줄이 시작한 자리(되감기에 쓴다)
  let users = 0;
  for (const e of history) {
    if (e.type === 'session.rewound') {
      // 되감기: 그 차례 뒤로 쌓인 줄은 없던 것으로
      if (e.upTo < users) {
        lines.length = turnAt[e.upTo];
        turnAt.length = e.upTo;
        users = e.upTo;
      }
    } else if (e.type === 'user.message') {
      if (upTo !== undefined && users >= upTo) break;
      turnAt.push(lines.length);
      users++;
      lines.push(`${speaker(e)}: ${e.text}`);
    } else if (e.type === 'session.compacted' && e.summary) {
      // 컨텍스트 정리(정리본 방식): 앞 줄은 정리본 하나로. 정리 앞으로 되감아도 정리본은 남는다
      lines.length = 0;
      lines.push(`[앞 대화 정리본]\n${e.summary}`);
      turnAt.fill(1);
    } else if (e.type === 'agent.text' && !e.partial) lines.push(`에이전트: ${e.text}`);
    else if (e.type === 'session.merged') lines.push(`[하위 작업 공유: ${e.title}]\n${e.text}`);
  }
  return lines;
}
/** 지금 살아 있는 사람 지시 차례 수(되감은 것은 뺀다) */
function turnsOf(history: HostEvent[]): number {
  let n = 0;
  for (const e of history) {
    if (e.type === 'user.message') n++;
    else if (e.type === 'session.rewound' && e.upTo < n) n = e.upTo;
  }
  return n;
}
const clip = (text: string, n: number) => (text.length > n ? text.slice(0, n) + ' …(줄임)' : text);
/** 공유용 요약: 차례마다 사람 지시 + 그 차례의 마지막 보고, 다른 갈래에서 받은 공유(이어 넘기기용, 길면 줄임) */
export function digest(events: HostEvent[]): string[] {
  const out: string[] = [];
  let last: string | undefined;
  const flush = () => { if (last) out.push(`에이전트: ${clip(last, 4000)}`); last = undefined; };
  for (const e of events) {
    // 예약 지시는 길고 날마다 같아서 첫 줄(제목)만
    if (e.type === 'user.message') { flush(); out.push(`${speaker(e)}: ${e.from === '예약' ? clip(e.text.split('\n')[0], 200) : clip(e.text, 1500)}`); }
    else if (e.type === 'agent.text' && !e.partial) last = e.text;
    else if (e.type === 'turn.done') flush();
    else if (e.type === 'session.merged') { flush(); out.push(`[하위 작업 공유: ${e.title}]\n${clip(e.text, 3000)}`); }
  }
  flush();
  return out;
}
/** CLI 오류 → 사람이 할 일을 알려 주는 한국어. 모르는 오류면 undefined. kind: 연결 상태(health)에 남길 종류 */
export function friendlyError(msg: string): { text: string; auth: boolean } | undefined {
  const m = String(msg ?? '');
  if (/credit balance is too low/i.test(m)) return { text: '크레딧이 부족해요. 결제 페이지에서 충전하거나 설정 → 연동에서 로그인 방식으로 바꾸세요', auth: true };
  if (/oauth session expired|failed to authenticate|not logged in|please run .*login|authentication required|-32000/i.test(m)) return { text: '로그인이 만료됐어요. 설정 → 연동에서 다시 로그인하세요', auth: true };
  if (/invalid api key|incorrect api key|api key not valid/i.test(m)) return { text: 'API 키가 맞지 않아요. 설정 → 연동에서 키를 다시 넣으세요', auth: true };
  if (/not scoped to a workspace/i.test(m)) return { text: '이 API 키는 워크스페이스에 속하지 않아요. 콘솔에서 워크스페이스 안의 키를 새로 만드세요', auth: true };
  if (/rate.?limit|usage limit|limit reached|\b429\b|quota/i.test(m)) return { text: '사용 한도에 걸렸어요. 잠시 뒤 다시 하거나 예약 시각을 나누세요', auth: false };
  if (/overloaded|\b529\b/i.test(m)) return { text: 'AI 서버가 붐벼요. 잠시 뒤 다시 하세요', auth: false };
  return undefined;
}
const tail = (text: string) => (text.length > 8000 ? '…' + text.slice(-8000) : text);
/** 대화 기록 → 이어받기용 글(뒤쪽 8000자) */
function transcript(history: HostEvent[], upTo?: number): string {
  return tail(conversation(history, upTo).join('\n')) || '(대화 없음)';
}

const HISTORY_CAP = 2000;
/** 기록 파일이 이보다 크면 켤 때 통째로 data/sessions/archive/*.jsonl.gz 에 압축해 두고 최근 것만 남긴다 */
const LOG_TRIM_BYTES = 20 * 1024 * 1024;

/**
 * 세션의 유일한 주인. 로컬 화면이든 대시보드든 메인 에이전트(MCP)든 같은 명령을 여기로 보내고,
 * 같은 이벤트를 여기서 받는다. 모든 이벤트는 세션별 JSONL 에 기록한다.
 */
export class SessionManager {
  private sessions = new Map<string, Live>();
  private tokens = new Map<string, string>(); // MCP 토큰 → 메인 세션 id
  private listeners = new Set<Listener>();
  private workspaceRoot: string;
  private logDir: string;
  private permFile: string;
  /** 화면 제어 — 메인 에이전트의 screen_* 도구가 쓴다(main.ts 가 붙인다) */
  screen?: ScreenControl;
  private aboutLine = false;
  /** 쉬는 작업 내리기: 이만큼(분) 쉰 CLI 를 내린다(0 이면 안 함). 떠 있는 CLI 가 maxAwake 를 넘으면 오래 쉰 것부터 내린다(0 이면 한도 없음) */
  sleepIdleMinutes = 0;
  maxAwake = 0;
  limits?: LimitStore; // 연결별 사용 한도(설정 → 연동)
  intake?: IntakeStore;
  private makingIntake = false; // 입력 세션(이 PC 에 하나) — 입력 거치기를 켠 작업의 사람 지시를 먼저 정리한다
  memory?: MemoryStore; // 설정 → 기억(취향·고쳐 준 것, 공통 지침) — 모든 메인 작업이 받는다
  peers?: Peers; // 다른 PC 의 Agent Hub(왼쪽 "연결") — 작업 목록·보내기가 PC 를 넘는다
  /** 권한 묻지 않기(모든 작업) — 설정 → 연동. 켜면 모든 작업의 도구 권한을 묻지 않고 허용한다(작업별 설정보다 앞선다) */
  autoApproveAll = false;
  /** AI 마다 연결 상태: 로그인 만료·크레딧 부족 같은 오류가 나면 error, 그 AI 의 차례가 잘 끝나면 ok. 화면 위쪽 알림과 GET /health */
  health: Partial<Record<AgentKind, { state: 'ok' | 'error'; message: string; at: string }>> = {};
  private setHealth(agent: AgentKind, state: 'ok' | 'error', message: string) {
    const cur = this.health[agent];
    if (cur?.state === state && cur.message === message) return;
    if (!cur && state === 'ok') { this.health[agent] = { state, message, at: new Date().toISOString() }; return; }
    this.health[agent] = { state, message, at: new Date().toISOString() };
    this.publish({ type: 'agent.health', agent, state, message });
  }
  private makeAdapter: AdapterFactory;
  private openTerminal?: TerminalOpener;
  private mcpBaseUrl?: string;
  private clinkWaitMs: number;
  private presets?: PresetStore;
  private tools?: ToolStore;
  private auth?: AuthStore;
  private gitEnv?: () => Record<string, string>;
  private hubSkills?: HubSkillStore;
  private workPresets?: WorkPresetStore;
  private profileDir?: (agent: AgentKind) => string;
  private schedules?: ScheduleStore;
  private opsAlert?: OpsAlert;
  private shared?: SharedRepo; // 공유 레포 — 메인이 대화로 올릴 때(사람 승인 후)
  private scheduleRunning = new Set<string>(); // 실행 중인 예약(같은 예약이 겹쳐 돌지 않게)
  private asks = new Map<string, { sessionId: string; resolve: (allow: boolean) => void }>(); // 호스트가 사람에게 묻는 중인 것
  private order = new WeakMap<HostEvent, number>(); // 기록된 이벤트의 순서(다시 보낼 때 정렬)
  private claudeHome: string; // Claude Code 기록이 있는 곳(~/.claude) — 프리셋이 아닌 Claude 세션이 쓴다
  readonly claudeCode: ClaudeHistory; // 이 PC 의 Claude Code 세션 찾기
  private seq = 0;
  private stamp(ev: HostEvent, ms = Date.now()) {
    this.order.set(ev, ms * 1000 + (this.seq++ % 1000));
  }

  /** 이벤트가 일어난 시각(ms). 기록하지 않는 조각 글은 undefined */
  timeOf(ev: HostEvent): number | undefined {
    const o = this.order.get(ev);
    return o === undefined ? undefined : Math.floor(o / 1000);
  }
  private askSeq = 0;

  constructor(opts: {
    workspaceRoot: string;
    dataDir: string;
    makeAdapter: AdapterFactory;
    openTerminal?: TerminalOpener;
    mcpBaseUrl?: string; // 예: http://127.0.0.1:4317/mcp — 메인 에이전트에게 줄 도구 주소
    clinkWaitMs?: number; // clink 한 번이 기다리는 최대 시간. 넘으면 'working' 으로 돌려주고 이어서 기다리게 한다
    presets?: PresetStore; // 에이전트 프리셋 — clink 의 preset 인자로 고른다
    tools?: ToolStore; // 설정의 "툴" — 모든 세션에 붙이는 MCP 서버
    auth?: AuthStore; // 설정의 "연동" — 로그인 / API 키
    gitEnv?: () => Record<string, string>; // 연동의 GitHub — 로그인돼 있으면 세션에 넣을 gh·git 자격 증명 환경 변수
    hubSkills?: HubSkillStore; // 설정의 "스킬" — 프리셋 세션이 쓰는 Agent Hub 스킬
    profilesDir?: string; // 에이전트 세션의 전용 프로필 뿌리(data/profiles)
    workPresets?: WorkPresetStore; // 설정의 "프리셋" — 작업 환경(폴더·지침)
    schedules?: ScheduleStore; // 작업 정보의 "예약"
    opsAlert?: OpsAlert; // 예약이 실패하면 바깥 운영 알림으로(풀리면 resolved)
    claudeHome?: string; // Claude Code 설정 폴더(시험용). 기본 CLAUDE_CONFIG_DIR 또는 ~/.claude
    aboutLine?: boolean; // 메인 지시 앞에 [이 작업 역할: …] 한 줄(Agent Hub 는 켬, 시험은 기본 꺼짐)
  }) {
    this.aboutLine = Boolean(opts.aboutLine);
    this.claudeHome = opts.claudeHome ?? claudeHome();
    this.claudeCode = new ClaudeHistory(this.claudeHome);
    this.schedules = opts.schedules;
    this.opsAlert = opts.opsAlert;
    this.workPresets = opts.workPresets;
    this.auth = opts.auth;
    this.gitEnv = opts.gitEnv;
    this.hubSkills = opts.hubSkills;
    if (opts.profilesDir) {
      const root = opts.profilesDir;
      this.profileDir = (a) => {
        const d = join(root, a);
        mkdirSync(d, { recursive: true });
        return d;
      };
    }
    this.presets = opts.presets;
    this.tools = opts.tools;
    this.workspaceRoot = resolve(opts.workspaceRoot);
    this.logDir = join(resolve(opts.dataDir), 'sessions');
    this.permFile = join(resolve(opts.dataDir), 'permissions.json');
    try { this.autoApproveAll = JSON.parse(readFileSync(this.permFile, 'utf8')).autoApproveAll === true; } catch {}
    this.makeAdapter = opts.makeAdapter;
    this.openTerminal = opts.openTerminal;
    this.mcpBaseUrl = opts.mcpBaseUrl;
    this.clinkWaitMs = opts.clinkWaitMs ?? 10 * 60 * 1000;
    mkdirSync(this.logDir, { recursive: true });
  }

  /**
   * 호스트를 다시 켰을 때 기록 파일(data/sessions/*.jsonl)에서 작업 목록·대화를 되살린다.
   * CLI 프로세스는 이미 없으므로 "대기"로 두고, 다음 지시가 오면 CLI 를 다시 띄워 앞 대화를 붙여 이어 간다(wake).
   * 작업에는 "끝남"이 없다 — 지우기 전까지 언제든 이어 간다. 삭제한 작업은 되살리지 않는다.
   */
  restore(): number {
    let files: string[] = [];
    try {
      files = readdirSync(this.logDir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return 0;
    }
    const restored: Live[] = [];
    for (const f of files) {
      let events: HostEvent[];
      let lines: string[];
      try {
        lines = readFileSync(join(this.logDir, f), 'utf8').split('\n').filter(Boolean);
        events = lines.map((l) => {
          const { at, ...ev } = JSON.parse(l);
          this.stamp(ev as HostEvent, Date.parse(at) || 0); // 기록된 시각으로 순서를 되살린다
          return ev as HostEvent;
        });
      } catch {
        continue; // 깨진 기록은 건너뛴다
      }
      const created = events.find((e) => e.type === 'session.created');
      if (!created || created.type !== 'session.created' || events.some((e) => e.type === 'session.deleted')) continue;
      const info = created.session;
      if (this.sessions.has(info.id)) continue;
      for (const e of events) {
        if (e.type === 'session.renamed') { info.customTitle = e.title; if (e.aliases) info.aliases = e.aliases; }
        if (e.type === 'session.reordered') info.rank = e.rank;
        if (e.type === 'session.remoteParent') { if (e.parent) info.remoteParent = e.parent; else delete info.remoteParent; }
        if (e.type === 'session.reparented') { delete info.forkedFrom; if (e.parentId) info.splitFrom = e.parentId; else delete info.splitFrom; }
        if (e.type === 'session.intakeSet') { if (e.on) info.viaIntake = true; else delete info.viaIntake; }
        if (e.type === 'session.archived') { if (e.archived) info.archived = true; else delete info.archived; }
        if (e.type === 'session.about') { if (e.about) info.about = e.about; else delete info.about; }
        if (e.type === 'session.rewound') delete info.cliSessionId; // 되감은 뒤에는 옛 Claude 대화로 이어 가지 않는다
        if (e.type === 'session.dirs') info.extraDirs = e.dirs;
        if (e.type === 'session.cli') info.cliSessionId = e.cliSessionId;
        if (e.type === 'session.model') info.lastModel = e.model;
        if (e.type === 'session.configured') Object.assign(info, { agent: e.session.agent, model: e.session.model, preset: e.session.preset, workPreset: e.session.workPreset, autoApprove: e.session.autoApprove, permMode: e.session.permMode, permAllow: e.session.permAllow, effort: e.session.effort, movedTo: e.session.movedTo });
      }
      // 길면 최근 것만. 만든 기록(session.created)은 꼭 남긴다 — 없으면 화면이 그 작업을 모른다
      const history = events.length > HISTORY_CAP ? [created, ...events.slice(-(HISTORY_CAP - 1)).filter((e) => e !== created)] : events;
      this.trimLog(f, lines, info, created.via);
      const live: Live = { info, adapter: new UnavailableAdapter('다시 띄우기 전'), history, turn: null };
      for (const e of events) this.trackRemote(live, e); // 원격 접속은 잘라 내기 전 기록 전체에서
      info.status = 'idle';
      live.dormant = true;
      restored.push(live);
    }
    // 메인이 작업자보다 먼저 오도록(화면이 카드를 메인에 붙인다), 만든 순서대로
    restored.sort((a, b) => Number(a.info.role === 'worker') - Number(b.info.role === 'worker') || a.info.createdAt.localeCompare(b.info.createdAt));
    for (const l of restored) this.sessions.set(l.info.id, l);
    for (const l of restored) {
      this.closePerms(l, '호스트를 다시 켬'); // 꺼진 CLI 가 묻던 것은 답할 곳이 없다
      // 일하던 중에 꺼졌으면 기록의 마지막 상태가 "작업 중"이다 — 화면이 기록을 다시 받을 때 대기로 끝나게
      const last = l.history.findLast((e) => e.type === 'session.status');
      if (last && last.type === 'session.status' && last.status !== 'idle') this.publish({ type: 'session.status', sessionId: l.info.id, status: 'idle' });
    }
    return restored.length;
  }

  /**
   * 기록 파일이 너무 크면(LOG_TRIM_BYTES) 통째로 archive 에 압축해 두고, 파일에는 지금 정보로 쓴 만든 기록 + 최근 줄만 남긴다.
   * 기록은 AX 근거라 지우지 않고 옮긴다.
   */
  private trimLog(file: string, lines: string[], info: SessionInfo, via?: RemoteVia) {
    const path = join(this.logDir, file);
    try {
      if (statSync(path).size <= LOG_TRIM_BYTES || lines.length <= HISTORY_CAP) return;
      const archive = join(this.logDir, 'archive');
      mkdirSync(archive, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      writeFileSync(join(archive, `${file.replace(/\.jsonl$/, '')}-${stamp}.jsonl.gz`), gzipSync(lines.join('\n') + '\n'));
      const head = JSON.stringify({ at: info.createdAt, type: 'session.created', session: { ...info, status: 'idle' }, ...(via ? { via } : {}) });
      const keep = lines.slice(-(HISTORY_CAP - 1)).filter((l) => !l.includes('"type":"session.created"'));
      writeFileSync(`${path}.tmp`, [head, ...keep].join('\n') + '\n');
      renameSync(`${path}.tmp`, path);
    } catch {}
  }

  /** 구독. 지금까지의 세션 기록을 먼저 다시 보내 준다. 해지 함수를 돌려준다. */
  subscribe(listener: Listener): () => void {
    // 세션별이 아니라 일어난 순서대로 다시 보낸다 — 작업자 카드가 메인 대화의 제자리에 붙도록
    const all: [number, HostEvent][] = [];
    for (const live of this.sessions.values()) for (const ev of live.history) all.push([this.order.get(ev) ?? 0, ev]);
    all.sort((a, b) => a[0] - b[0]);
    for (const [, ev] of all) listener(ev);
    // 원격 접속 목록은 기록하지 않으므로 지금 것을 따로 보낸다
    for (const live of this.sessions.values()) if (live.remotes?.size) listener({ type: 'session.remotes', sessionId: live.info.id, remotes: this.remotesOf(live.info.id) });
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((l) => l.info);
  }

  info(id: string): SessionInfo | undefined {
    return this.sessions.get(id)?.info;
  }

  /** 이 작업에 연결된 원격 접속(최근에 쓴 것부터) */
  remotesOf(id: string): RemoteLink[] {
    const m = this.sessions.get(id)?.remotes;
    return m ? [...m.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt)).map((r) => ({ ...r })) : [];
  }

  /**
   * 기록된 이벤트 하나로 원격 접속 목록을 고친다(바뀌었으면 true).
   * 원격 접속으로 만든 작업·받은 지시·막기/풀기만 본다. 같은 app + label 이면 같은 연결이고 주소(ref)는 마지막 것
   */
  private trackRemote(live: Live, ev: HostEvent): boolean {
    const via = ev.type === 'user.message' || ev.type === 'session.created' ? ev.via : undefined;
    const at = new Date(this.timeOf(ev) ?? Date.now()).toISOString();
    const m = (live.remotes ??= new Map());
    if (via) {
      const key = remoteKey(via.app, via.label);
      const r = m.get(key) ?? { app: via.app, label: via.label, firstAt: at, lastAt: at, messages: 0, createdSession: false, blocked: false };
      if (via.ref) r.ref = via.ref;
      if (at > r.lastAt) r.lastAt = at;
      if (ev.type === 'session.created') r.createdSession = true;
      else r.messages++;
      m.set(key, r);
      return true;
    }
    if (ev.type === 'session.remoteBlocked') {
      const r = m.get(remoteKey(ev.app, ev.label));
      if (!r) return false;
      r.blocked = ev.blocked;
      return true;
    }
    return false;
  }

  /** 오른쪽 패널의 스킬: 프리셋 세션은 Agent Hub 스킬 중 고른 것, 아니면 그 CLI 가 계정에서 읽는 것 */
  skillsOf(id: string): SkillInfo[] {
    const s = this.sessions.get(id)?.info;
    if (!s) return [];
    if (!s.preset || !this.hubSkills) return skillsFor(s.agent, s.workdir);
    const preset = this.presets?.find(s.preset.id);
    const names = new Set(this.hubSkills.pick(preset?.skills));
    const hub = this.hubSkills.list().filter((k) => names.has(k.name)).map((k) => ({ name: k.name, description: k.description, where: 'Agent Hub' }));
    const project = skillsFor(s.agent, s.workdir, join(this.logDir, '__no_home__')).filter((k) => k.where === '작업 폴더');
    return [...hub, ...project];
  }

  presetList(): Preset[] {
    return this.presets?.list() ?? [];
  }

  /** 이 메인이 맡길 수 있는 하위 에이전트(프리셋). 메인이 프리셋이고 허용 목록이 있으면 그것만. */
  presetsForMain(mainId: string): Preset[] {
    const allowed = this.mainAllowed(mainId);
    return this.presetList().filter((p) => !allowed || allowed.includes(p.id));
  }

  /** 메인 프리셋의 허용 하위 에이전트 목록(없으면 undefined = 제한 없음) */
  private mainAllowed(mainId: string): string[] | undefined {
    // 메인 에이전트의 허용 목록과 프리셋(작업 환경)의 허용 목록 — 둘 다 있으면 둘 다 허용한 것만
    const info = this.sessions.get(mainId)?.info;
    const byAgent = this.liveAllow(info?.preset ? this.presets?.find(info.preset.id)?.agents : undefined);
    const byPreset = this.liveAllow(info?.workPreset ? this.workPresets?.find(info.workPreset.id)?.agents : undefined);
    if (byAgent && byPreset) return byAgent.filter((a) => byPreset.includes(a));
    return byAgent ?? byPreset;
  }

  /**
   * 허용 목록에서 지워진 에이전트는 뺀다. 골라 둔 에이전트가 모두 지워졌으면 제한도 없앤다(전부) —
   * 남겨 두면 아무에게도 못 맡기는데, 화면에는 고른 게 안 보여 왜 막혔는지 알 수 없다.
   * 처음부터 아무것도 안 고른 빈 목록([])은 "하위 에이전트 없음"으로 그대로 둔다.
   */
  private liveAllow(ids?: string[]): string[] | undefined {
    if (!ids) return undefined;
    if (!ids.length) return ids;
    const live = ids.filter((id) => this.presets?.find(id));
    return live.length ? live : undefined;
  }

  /** 첨부 저장: 세션 작업 폴더의 첨부/ 에 "날짜시각-이름" 으로. 작업자도 같은 폴더라 그대로 열 수 있다. */
  saveAttachment(sessionId: string, rawName: string, mime: string, data: Buffer): Attachment {
    if (data.length > MAX_ATTACHMENT) throw new Error(`파일이 너무 큼(최대 ${formatSize(MAX_ATTACHMENT)})`);
    const a = this.newAttachment(sessionId, rawName, mime);
    writeFileSync(a.abs, data);
    return { path: a.path, name: a.name, mime: a.mime, size: data.length };
  }

  /** 큰 파일 나눠 올리기용: 작업 폴더 첨부/ 에 이름을 정해 빈 파일을 만들고 자리를 돌려준다(조각은 이어 쓴다) */
  newAttachment(sessionId: string, rawName: string, mime: string): { abs: string; path: string; name: string; mime: string } {
    const live = this.sessions.get(sessionId);
    if (!live) throw new Error('없는 세션');
    const safe = (rawName || '파일').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(-120) || '파일';
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
    const dir = join(live.info.workdir, '첨부');
    mkdirSync(dir, { recursive: true });
    let name = `${stamp}-${safe}`;
    for (let n = 2; existsSync(join(dir, name)); n++) name = `${stamp}-${n}-${safe}`;
    writeFileSync(join(dir, name), '');
    return { abs: join(dir, name), path: `첨부/${name}`, name: rawName || safe, mime: /^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime : 'application/octet-stream' };
  }

  /**
   * 에이전트가 사람에게 그림을 보여 준다(show_image): 그림 파일 또는 지금 화면을 data/images/<작업>/ 에 두고 채팅에 띄운다.
   * 기록에 남으니 다시 켜도 보인다. 작업을 지워도 그림 파일은 남는다(기록 파일과 같이).
   */
  async showImage(sessionId: string, a: { path?: unknown; caption?: unknown; monitor?: unknown }): Promise<string> {
    const live = this.sessions.get(sessionId);
    if (!live) throw new Error('없는 작업');
    let data: Buffer, ext: string, name: string;
    if (typeof a.path === 'string' && a.path.trim()) {
      const abs = resolve(live.info.workdir, a.path.trim());
      ext = extname(abs).toLowerCase().replace('.jpeg', '.jpg');
      if (!IMAGE_TYPES[ext]) throw new Error('그림 파일(png·jpg·gif·webp)만 띄울 수 있음');
      if (!existsSync(abs)) throw new Error(`파일이 없음: ${abs}`);
      if (statSync(abs).size > MAX_ATTACHMENT) throw new Error(`그림이 너무 큼(최대 ${formatSize(MAX_ATTACHMENT)})`);
      data = readFileSync(abs);
      name = basename(abs);
    } else {
      const screen = this.screen;
      if (!screen?.enabled) throw new Error('화면 제어가 꺼져 있어 화면을 찍을 수 없음. 사람에게 Agent Hub 왼쪽 위 화면 제어에서 켜 달라고 하거나, 그림 파일이면 path 를 준다');
      const m = Number.isInteger(a.monitor) ? Math.max(0, Math.min(15, a.monitor as number)) : 0;
      const f = await screen.frame(m, 1920, 85, `agent:${sessionId}`);
      if (f.kind !== 'image') throw new Error(`화면을 찍을 수 없음: ${f.message ?? '관리자 확인 창이나 잠금 화면'}`);
      data = f.data;
      ext = '.jpg';
      name = '화면';
    }
    const dir = join(this.logDir, '..', 'images', sessionId);
    mkdirSync(dir, { recursive: true });
    const file = `${randomUUID()}${ext}`;
    writeFileSync(join(dir, file), data);
    const caption = typeof a.caption === 'string' && a.caption.trim() ? a.caption.trim().slice(0, 300) : undefined;
    this.publish({ type: 'agent.image', sessionId, url: `/images/${sessionId}/${file}`, name, ...(caption ? { caption } : {}) });
    return `채팅에 띄움: ${name}${caption ? ` — ${caption}` : ''}`;
  }

  /** since 뒤에 그 작업 채팅에 뜬 그림. relay: undefined = 모두, true = 아래에서 올라온 것만, false = 그 작업이 띄운 것만. skip = 그 작업에서 받은 것은 빼고 */
  private shotsIn(from: Live, since: number, relay?: boolean, skip?: string): { url: string; name: string; caption?: string; from?: string }[] {
    return from.history.flatMap((e) => (e.type === 'agent.image' && (this.order.get(e) ?? 0) > since && (relay === undefined || relay === Boolean(e.from)) && !(skip && e.url.startsWith(`/images/${skip}/`)) ? [e] : []));
  }

  /** 그림 내용의 지문(같은 그림을 다른 파일로 두 번 띄워도 같게). 파일이 없으면 주소 */
  private shotHash(url: string): string {
    const m = url.match(/^\/images\/([^/]+)\/([^/]+)$/);
    const f = m && this.imagePath(m[1], m[2]);
    try { return f ? createHash('sha1').update(readFileSync(f.path)).digest('hex') : url; } catch { return url; }
  }
  /** 그 작업 채팅에 이미 뜬 그림들의 지문 */
  private shotHashes(l: Live): Set<string> {
    return new Set(l.history.flatMap((e) => (e.type === 'agent.image' ? [this.shotHash(e.url)] : [])));
  }

  /** 사람이 올린 첨부 그림(채팅에서 눌러 크게 보기) → 실제 경로. 그 작업 폴더 첨부/ 안의 그림만 */
  attachmentImage(sessionId: string, rel: string): { path: string; type: string } | null {
    const live = this.sessions.get(sessionId);
    const ext = extname(rel).toLowerCase().replace('.jpeg', '.jpg');
    const abs = live && IMAGE_TYPES[ext] ? this.attachmentPath(live, rel) : null;
    return abs ? { path: abs, type: IMAGE_TYPES[ext] } : null;
  }

  /** /images/<작업>/<파일> → 실제 경로(이름 모양이 맞고 실제로 있을 때만) */
  imagePath(sessionId: string, file: string): { path: string; type: string } | null {
    if (!/^[\w-]+$/.test(sessionId) || !/^[\w-]+\.(png|jpg|gif|webp)$/.test(file)) return null;
    const path = join(this.logDir, '..', 'images', sessionId, file);
    return existsSync(path) ? { path, type: IMAGE_TYPES[extname(file)] } : null;
  }

  /** 첨부 경로 → 실제 파일 경로(그 세션 작업 폴더의 첨부/ 안에 실제로 있을 때만) */
  private attachmentPath(live: Live, rel: string): string | null {
    const abs = resolve(live.info.workdir, rel);
    const r = relative(join(live.info.workdir, '첨부'), abs);
    if (r.startsWith('..') || isAbsolute(r) || !existsSync(abs)) return null;
    return abs;
  }

  /** 공유 레포를 붙인다(만드는 순서상 나중에) */
  attachShared(shared: SharedRepo) {
    this.shared = shared;
  }

  /** 프리셋(작업 환경) 목록 — 메인에게는 에이전트를 id 대신 이름으로 보여 준다 */
  workPresetList() {
    const name = (id?: string) => (id ? this.presets?.find(id)?.name ?? id : undefined);
    return (this.workPresets?.list() ?? []).map((p) => ({ ...p, mainAgent: name(p.mainAgent), agents: p.agents?.map((a) => name(a)!) }));
  }

  /** 메인이 프리셋(작업 환경)을 만들고 고친다. 에이전트는 이름이나 id 로 받는다. 사람 승인 후 저장 */
  async workPresetSaveByMain(mainId: string, input: any): Promise<WorkPreset> {
    if (!this.workPresets) throw new Error('프리셋 저장소가 없음');
    const agentId = (key: unknown) => {
      if (typeof key !== 'string' || !key.trim()) return undefined;
      const p = this.presets?.find(key);
      if (!p) throw new Error(`없는 에이전트: ${key}`);
      return p.id;
    };
    const draft = { ...input, mainAgent: agentId(input?.mainAgent), agents: Array.isArray(input?.agents) ? input.agents.map(agentId).filter(Boolean) : undefined };
    if (typeof input?.id === 'string' && !this.workPresets.find(input.id)) {
      const byName = this.workPresets.find(input.id); // 이름으로 준 경우
      if (byName) draft.id = byName.id;
    }
    this.workPresets.check(draft);
    const existing = typeof draft.id === 'string' ? this.workPresets.find(draft.id) : undefined;
    const title = `${existing ? '프리셋 고치기' : '프리셋 만들기'} · ${String(draft.name).trim()}`;
    const detail = [draft.folder ? `폴더 ${draft.folder}` : '폴더 뿌리', String(draft.guidelines ?? '').slice(0, 300)].filter(Boolean).join(' — ');
    if (!(await this.askHuman(mainId, title, detail))) throw new Error('사람이 거부함');
    const saved = this.workPresets.save(draft);
    this.presetsChanged();
    return saved;
  }

  async workPresetDeleteByMain(mainId: string, key: string): Promise<WorkPreset> {
    const p = this.workPresets?.find(key);
    if (!p) throw new Error(`없는 프리셋: ${key}`);
    if (p.shared) throw new Error('공유받은 프리셋은 지울 수 없음 — 공유에서 내리려면 설정 화면에서');
    if (!(await this.askHuman(mainId, `프리셋 지우기 · ${p.name}`, p.description))) throw new Error('사람이 거부함');
    this.workPresets!.remove(p.id);
    this.presetsChanged();
    return p;
  }

  /** 메인이 자기 작업의 설정을 본다(session_info): 권한 묻지 않기(이 작업·모든 작업), 모델, 폴더, 예약 수, 이 PC 의 현지 시각 */
  sessionInfoByMain(mainId: string) {
    const live = this.sessions.get(mainId);
    if (!live) throw new Error('없는 작업');
    const i = live.info;
    const now = new Date();
    return {
      id: i.id,
      title: i.customTitle ?? i.title,
      agent: i.agent,
      model: i.model ?? null,
      workdir: i.workdir,
      extraDirs: i.extraDirs ?? [],
      preset: i.preset?.name ?? null,
      workPreset: i.workPreset?.name ?? null,
      autoApproveThisTask: Boolean(i.autoApprove),
      autoApproveAllTasks: this.autoApproveAll,
      permMode: i.permMode ?? null, // ask = 늘 묻기, readonly = 묻는 도구는 거절. 모든 작업 설정보다 앞선다
      asksPermission: Boolean(i.permMode) || !(i.autoApprove || this.autoApproveAll),
      about: i.about ?? null, // 역할 설명
      schedules: this.schedules?.forSession(i.id).length ?? 0,
      localTime: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }

  /** 메인이 자기 작업(오른쪽 작업 정보의 "예약")에 걸린 예약을 본다 */
  /** 예약 보기: session(작업 이름)을 주면 그 작업, 없으면 이 작업. all 이면 모든 작업 */
  scheduleListByMain(mainId: string, key?: unknown, all = false) {
    if (!this.schedules) throw new Error('예약 기능이 없음');
    if (all) return this.schedules.list().map((x) => ({ ...x, task: this.sessions.get(x.sessionId) ? this.nameOf(this.sessions.get(x.sessionId)!) : '(지워진 작업)' }));
    const { target } = this.crossTask(mainId, key);
    return this.schedules.forSession(target.info.id);
  }

  /** 예약 걸기(id 없이)·고치기(id 와 함께). session(작업 이름)을 주면 그 작업에, 없으면 이 작업에 */
  scheduleSaveByMain(mainId: string, a: Record<string, unknown>) {
    if (!this.schedules) throw new Error('예약 기능이 없음');
    const { target } = this.crossTask(mainId, a.session);
    const id = target.info.id;
    if (typeof a.id === 'string' && a.id && !this.schedules.forSession(id).some((s) => s.id === a.id)) throw new Error(`${this.nameOf(target)} 의 예약이 아님: ${a.id}`);
    const { session: _s, ...rest } = a;
    const s = this.schedules.save({ ...rest, sessionId: id });
    this.schedulesChanged();
    return { ...s, task: this.nameOf(target) };
  }

  scheduleDeleteByMain(mainId: string, id: string, key?: unknown) {
    if (!this.schedules) throw new Error('예약 기능이 없음');
    const { target } = this.crossTask(mainId, key);
    if (!this.schedules.forSession(target.info.id).some((s) => s.id === id)) throw new Error(`${this.nameOf(target)} 의 예약이 아님: ${id}`);
    this.schedules.remove(id);
    this.schedulesChanged();
  }

  // ── 메인이 다른 작업 다루기: 작업 이름으로 찾아 보기·보내기·분담·예약 ──
  // 늘 묻기·읽기만인 작업은 쓰지 못한다(다른 작업을 시켜 제 권한을 넘지 않게)

  /** 작업 이름(사람이 붙인 이름, 없으면 첫 지시) */
  private nameOf(live: Live): string {
    const first = live.history.find((e) => e.type === 'user.message');
    return live.info.customTitle ?? (first && first.type === 'user.message' ? first.text.replace(/\s+/g, ' ').slice(0, 40) : '새 작업');
  }

  // ── 입력 세션 ──────────────────────────────
  /** 입력 세션(없거나 지워졌으면 만든다) */
  private async ensureIntake(): Promise<Live | undefined> {
    if (!this.intake) return undefined;
    const have = this.intake.sessionId ? this.sessions.get(this.intake.sessionId) : undefined;
    if (have && !have.info.archived) return have;
    const before = new Set(this.sessions.keys());
    this.makingIntake = true;
    try { await this.handle({ type: 'session.create', agent: 'claude', role: 'main', model: this.intake.model, title: '입력' }, { via: 'local', user: 'local' }); } finally { this.makingIntake = false; }
    const made = [...this.sessions.values()].find((l) => !before.has(l.info.id) && l.info.role === 'main');
    if (!made) return undefined;
    this.rename(made, '입력');
    this.setAbout(made, '입력 세션(목록에 안 보임): "입력 거치기"를 켠 작업에 사람이 쓴 지시를 먼저 받아, 역할에 맞는지·앞 지시와 어긋나는지·사내 문서를 보고 정리해 그 작업(또는 맞는 작업)에 넘기거나 그 작업 화면에 묻는다. 직접 일은 하지 않는다.');
    this.intake.setSession(made.info.id);
    return made;
  }

  /** 사람 지시를 입력 세션으로. 입력 세션을 못 쓰면 false(그 작업이 그대로 받는다) */
  private async toIntake(live: Live, text: string, atts: { path: string; name: string; mime: string; size: number }[]): Promise<boolean> {
    const intake = await this.ensureIntake();
    if (!intake || !this.intake) return false;
    const answerTo = this.intake.askingIn(live.info.id);
    if (answerTo) this.intake.pending.delete(answerTo.id);
    const req = this.intake.add({ taskId: live.info.id, original: answerTo ? `${answerTo.original}\n\n(물음 "${answerTo.question}" 에 대한 답) ${text}` : text, ...(atts.length ? { attachments: atts } : {}) });
    const lastReport = [...live.history].reverse().find((e) => e.type === 'agent.text' && !e.partial) as { text: string } | undefined;
    const prompt = intakePrompt(req, { name: this.nameOf(live), about: live.info.about, recent: this.recentOf(live), lastReport: lastReport?.text.replace(/\s+/g, ' ').slice(0, 300), context: this.contextNote(live) }, answerTo);
    this.publish({ type: 'session.intake', sessionId: live.info.id, state: 'pending', request: req.id });
    await this.handle({ type: 'user.message', sessionId: intake.info.id, text: prompt }, { via: 'local', user: '입력 요청' });
    return true;
  }

  private intakeReq(mainId: string, request: unknown) {
    if (!this.intake || mainId !== this.intake.sessionId) throw new Error('입력 세션만 쓸 수 있음');
    const req = this.intake.pending.get(String(request ?? ''));
    if (!req) throw new Error(`없는 요청: ${request} (이미 넘겼거나 Agent Hub 를 다시 켜서 사라짐)`);
    return req;
  }

  /**
   * 입력 세션이 정리할지 판단할 거리 한 줄: 지금 컨텍스트 크기(한도 대비), 마지막으로 정리한 때, 일하는 중·승인 대기.
   * 대화 내용은 주지 않는다(크기만).
   */
  contextNote(live: Live): string {
    let usage: { used: number; window: number | null } | undefined;
    let compactedAt: number | undefined;
    for (let i = live.history.length - 1; i >= 0 && (!usage || compactedAt === undefined); i--) {
      const e = live.history[i];
      if (!usage && e.type === 'context.usage') usage = e;
      if (compactedAt === undefined && e.type === 'session.compacted' && !e.error) compactedAt = this.timeOf(e) ?? 0;
    }
    const k = (n: number) => `${Math.round(n / 1000)}k`;
    const size = !usage || !usage.used ? '알 수 없음(새로 띄웠거나 아직 답이 없음)'
      : usage.window ? `${k(usage.used)} / ${k(usage.window)} 토큰(${Math.round((usage.used / usage.window) * 100)}%)` : `${k(usage.used)} 토큰(한도 모름)`;
    const when = compactedAt === undefined ? '정리한 적 없음' : compactedAt ? `마지막 정리 ${new Date(compactedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}` : '정리한 적 있음';
    const st = live.compacting ? ' · 지금 정리 중' : live.info.status === 'working' || live.info.status === 'starting' ? ' · 지금 일하는 중' : this.waitingPerm(live) ? ' · 승인 대기' : '';
    return `${size} · ${when}${st}`;
  }

  /** 입력 세션 도구: 정리한 지시를 작업에 넘긴다(session 을 주면 그 작업으로 — 역할에 더 맞는 작업). compact 면 그 작업 컨텍스트를 먼저 정리하고 넘긴다 */
  async intakeForwardByMain(mainId: string, request: unknown, instruction: unknown, key?: unknown, compact?: unknown, effort?: unknown): Promise<string> {
    const req = this.intakeReq(mainId, request);
    const body = String(instruction ?? '').trim();
    if (!body) throw new Error('정리한 지시가 비어 있음');
    const origin = this.sessions.get(req.taskId);
    const target = key ? this.findTask(String(key)) : origin;
    if (!target) throw new Error('그 작업이 지워짐');
    if (target.info.id === this.intake!.sessionId) throw new Error('입력 세션에는 넘길 수 없음');
    this.intake!.pending.delete(req.id);
    if (origin && origin !== target) this.publish({ type: 'session.intake', sessionId: origin.info.id, state: 'routed', text: `${this.nameOf(target)} 작업이 더 맞아 그쪽으로 보냄`, request: req.id });
    // 넘기기 전에 정리: 일하는 중·승인 대기·이미 정리 중이면 정리하지 않고 그대로 넘긴다(하던 일을 끊지 않게)
    const busy = Boolean(target.compacting || target.compactPending) || target.info.status === 'working' || target.info.status === 'starting' || this.waitingPerm(target);
    const doCompact = compact === true && !busy;
    const shown = doCompact ? `(넘기기 전에 컨텍스트를 정리함)\n${body}` : body;
    this.publish({ type: 'session.intake', sessionId: target.info.id, state: 'forwarded', text: shown, request: req.id });
    this.intake!.log({ state: origin && origin !== target ? 'routed' : 'forwarded', request: req.id, taskId: req.taskId, task: origin ? this.nameOf(origin) : '(지워진 작업)', target: this.nameOf(target), original: req.original, text: shown });
    // 이번 지시만의 생각 깊이: 사람이 작업에 깊이를 정해 두었으면 그것을 따른다(입력 세션 값은 버림). Claude 작업이 아니거나 일하는 중이면 쓰지 않는다
    const want = EFFORTS.includes(effort as Effort) ? (effort as Effort) : undefined;
    const useEffort = want && !target.info.effort && target.info.agent === 'claude' && !busy ? want : undefined;
    if (useEffort) {
      target.turnEffort = useEffort;
      if (!target.dormant && (target.launchedEffort ?? null) !== useEffort) this.sleep(target); // 다음 지시에 그 깊이로 다시 뜬다(같은 대화)
    }
    const deliver = () => this.handle({ type: 'user.message', sessionId: target.info.id, text: forwardedText(body, req.original), ...(req.attachments ? { attachments: req.attachments } : {}), ...(want ? { effort: want } : {}) }, { via: 'local', user: '입력' });
    if (doCompact) {
      await this.compact(target, '입력');
      if (target.compacting) {
        target.afterCompact = () => void deliver().catch((e) => this.publish({ type: 'error', sessionId: target.info.id, message: `정리 뒤 지시를 넘기지 못함: ${(e as Error).message}` }));
        return `${this.nameOf(target)} 의 컨텍스트를 정리하는 중. 끝나면 지시가 넘어간다`;
      }
    }
    await deliver();
    const eff = want ? (useEffort ? ` · 생각 깊이 ${useEffort}` : target.info.effort ? ` · 생각 깊이는 작업에 정해 둔 ${target.info.effort}` : '') : '';
    return compact === true && busy ? `${this.nameOf(target)} 에 넘김(일하는 중·승인 대기라 정리하지 않음)${eff}` : `${this.nameOf(target)} 에 넘김${eff}`;
  }

  /** 입력 세션 도구: 그 작업 화면에 사람에게 묻는다. 사람의 답은 다시 입력 세션으로 온다 */
  intakeAskByMain(mainId: string, request: unknown, question: unknown): string {
    const req = this.intakeReq(mainId, request);
    const q = String(question ?? '').trim().slice(0, 2000);
    if (!q) throw new Error('물을 것이 비어 있음');
    req.question = q;
    this.publish({ type: 'session.intake', sessionId: req.taskId, state: 'asked', text: q, request: req.id });
    const t = this.sessions.get(req.taskId);
    this.intake!.log({ state: 'asked', request: req.id, taskId: req.taskId, task: t ? this.nameOf(t) : '(지워진 작업)', original: req.original, text: q });
    return '물음을 그 작업 화면에 띄움. 사람이 답하면 새 입력 요청으로 온다';
  }

  /** 입력 거치기 켜기·끄기: 작업 하나(key) 또는 이 PC 의 모든 메인 작업(all — 입력 세션 자신·보관한 작업은 빼고). 바꾼 수 */
  setIntakeMany(on: boolean, key?: unknown, all = false): { changed: string[]; skipped: string[] } {
    const targets = all ? [...this.sessions.values()].filter((l) => l.info.role === 'main') : [this.findTask(String(key ?? ''))];
    const changed: string[] = [];
    const skipped: string[] = [];
    for (const l of targets) {
      if (l.info.id === this.intake?.sessionId || l.info.archived) { skipped.push(this.nameOf(l)); continue; }
      if (Boolean(l.info.viaIntake) === on) continue;
      if (on) l.info.viaIntake = true;
      else delete l.info.viaIntake;
      this.publish({ type: 'session.intakeSet', sessionId: l.info.id, on });
      changed.push(this.nameOf(l));
    }
    return { changed, skipped };
  }

  /** 메인 도구 session_intake */
  intakeByMain(mainId: string, on: unknown, key?: unknown, all?: unknown): string {
    const me = this.sessions.get(mainId);
    if (!me) throw new Error('없는 작업');
    if (me.info.permMode) throw new Error('늘 묻기·읽기만인 작업은 다른 작업 설정을 바꾸지 못함');
    if (typeof on !== 'boolean') throw new Error('on 은 true/false');
    const r = this.setIntakeMany(on, key ?? (all ? undefined : this.nameOf(me)), all === true);
    return `입력 거치기 ${on ? '켬' : '끔'}: ${r.changed.length ? r.changed.join(', ') : '바뀐 작업 없음(이미 그 상태)'}${all ? ' · 뺀 것: 입력 세션 자신, 보관한 작업' : ''}`;
  }

  /** 설정 → 입력 세션 모델 바꾸기(있으면 그 세션도) */
  async setIntakeModel(model: unknown) {
    if (!this.intake) return;
    this.intake.setModel(model);
    const live = this.intake.sessionId ? this.sessions.get(this.intake.sessionId) : undefined;
    if (live && live.info.model !== this.intake.model) await this.handle({ type: 'session.configure', sessionId: live.info.id, model: this.intake.model }, { via: 'local', user: 'local' });
  }

  /** 부모 바꾸기(기록에 남겨 다시 켜도 그대로) */
  private reparent(live: Live, parentId: string | null) {
    if (parentId && live.info.remoteParent) { delete live.info.remoteParent; this.publish({ type: 'session.remoteParent', sessionId: live.info.id, parent: null }); }
    const now = live.info.splitFrom ?? live.info.forkedFrom ?? null;
    if (now === parentId && !live.info.forkedFrom) return;
    delete live.info.forkedFrom;
    if (parentId) live.info.splitFrom = parentId;
    else delete live.info.splitFrom;
    delete live.info.rank; // 새 자리에서는 기본 순서로
    this.publish({ type: 'session.reparented', sessionId: live.info.id, parentId });
  }

  /** 분담·포크로 갈라진 아래 작업 전부 */
  private descendants(live: Live): Live[] {
    const out: Live[] = [];
    const walk = (id: string) => {
      for (const s of this.sessions.values()) if (s.info.role === 'main' && (s.info.splitFrom ?? s.info.forkedFrom) === id && !out.includes(s)) { out.push(s); walk(s.info.id); }
    };
    walk(live.info.id);
    return out;
  }

  /** 역할 설명 바꾸기(빈 글 = 지움) */
  private setAbout(live: Live, about: string) {
    const v = about.trim().slice(0, 500);
    if ((live.info.about ?? '') === v) return;
    if (v) live.info.about = v;
    else delete live.info.about;
    this.publish({ type: 'session.about', sessionId: live.info.id, about: v });
  }

  /** 최근에 하는 일: 마지막 사람·예약·다른 작업 지시의 첫 줄(공유·첨부 머리말은 건너뜀) — AI 를 부르지 않고 기록에서 바로 */
  private recentOf(live: Live): string | undefined {
    for (let i = live.history.length - 1; i >= 0; i--) {
      const e = live.history[i];
      if (e.type !== 'user.message') continue;
      const line = e.text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('[분담 공유') && !l.startsWith('[하위 작업 공유') && !l.startsWith('[포크 공유') && !l.startsWith('[첨부') && !l.startsWith('사람(') && !l.startsWith('에이전트:') && !l.startsWith('- 첨부'));
      if (line) return line.length > 100 ? `${line.slice(0, 100)}…` : line;
    }
    return undefined;
  }

  /** 이름 바꾸기: 예전 이름은 별칭으로 남겨(최근 5개) 이름으로 찾는 곳이 끊기지 않게 한다 */
  private rename(live: Live, title: string) {
    const old = live.info.customTitle;
    if (old === title) return;
    const aliases = [...(old ? [old] : []), ...(live.info.aliases ?? [])].filter((a, i, all) => a !== title && all.indexOf(a) === i).slice(0, 5);
    live.info.customTitle = title;
    if (aliases.length) live.info.aliases = aliases;
    else delete live.info.aliases;
    this.publish({ type: 'session.renamed', sessionId: live.info.id, title, ...(aliases.length ? { aliases } : {}) });
  }

  /** 이름(같음 → 시작 → 포함, 대소문자 무시) 또는 id 앞부분으로 메인 작업 하나를 찾는다. 여럿이면 후보를 알려 준다 */
  findTask(key: string): Live {
    const k = String(key ?? '').trim().toLowerCase();
    if (!k) throw new Error('작업 이름을 주세요(session_list 의 name)');
    const mains = [...this.sessions.values()].filter((l) => l.info.role === 'main' && !l.info.archived && l.info.id !== this.intake?.sessionId);
    const byId = mains.filter((l) => l.info.id.toLowerCase().startsWith(k));
    if (byId.length === 1 && k.length >= 4) return byId[0];
    // 지금 이름이 먼저, 없으면 예전 이름(별칭)으로
    const names = (l: Live, old: boolean) => (old ? (l.info.aliases ?? []) : [this.nameOf(l)]).map((n) => n.toLowerCase());
    for (const old of [false, true]) for (const test of [(n: string) => n === k, (n: string) => n.startsWith(k), (n: string) => n.includes(k)]) {
      const hit = mains.filter((l) => names(l, old).some(test));
      if (hit.length === 1) return hit[0];
      if (hit.length > 1) throw new Error(`"${key}" 에 맞는 작업이 여럿: ${hit.map((l) => `${this.nameOf(l)}(${l.info.id.slice(0, 8)})`).join(', ')}. id 앞 8자로 고르세요`);
    }
    throw new Error(`없는 작업: ${key}. session_list 로 이름을 확인하세요`);
  }

  private crossTask(mainId: string, key?: unknown): { me: Live; target: Live } {
    const me = this.sessions.get(mainId);
    if (!me) throw new Error('없는 작업');
    if (key === undefined || key === null || key === '') return { me, target: me };
    const target = this.findTask(String(key));
    if (target !== me && me.info.permMode) throw new Error('늘 묻기·읽기만인 작업은 다른 작업을 다루지 못함');
    return { me, target };
  }

  /** 메인 작업 목록: 이름, id, 상태, 분담 원본, 예약 수, 권한 */
  taskList() {
    return [...this.sessions.values()].filter((l) => l.info.role === 'main' && !l.info.archived && l.info.id !== this.intake?.sessionId).map((l) => {
      const from = l.info.splitFrom ?? l.info.forkedFrom;
      const src = from ? this.sessions.get(from) : undefined;
      return {
        name: this.nameOf(l),
        id: l.info.id.slice(0, 8),
        ...(l.info.about ? { about: l.info.about } : {}),
        ...(this.recentOf(l) ? { recent: this.recentOf(l) } : {}),
        status: l.info.status === 'working' || l.info.status === 'starting' ? (this.waitingPerm(l) ? '승인 대기' : '작업 중') : '대기',
        ...(l.info.lastModel ? { model: l.info.lastModel } : {}), // 마지막 차례에 쓴 모델
        ...this.activityOf(l), // 일하는 중이면 지금 하는 일 · 시작 시각(다른 PC 화면에 같은 모양으로) // 다른 PC 화면의 상태 표시(승인을 기다리는 건 일하는 중일 때뿐 — 화면과 같은 기준)
        context: this.contextNote(l),
        ...(src ? { [l.info.splitFrom ? 'splitFrom' : 'forkedFrom']: this.nameOf(src) } : {}),
        schedules: this.schedules?.forSession(l.info.id).length ?? 0,
        ...(l.info.permMode ? { permMode: l.info.permMode } : {}),
        workdir: l.info.workdir,
      };
    });
  }

  /** 다른 PC 가 GET /peer/summary 로 가져가는 이 PC 요약: 메인 작업(전체 id) */
  peerSummary(name: string, version?: string): PeerSummary {
    const tasks = [...this.sessions.values()].filter((l) => l.info.role === 'main' && !l.info.archived && l.info.id !== this.intake?.sessionId).map((l) => {
      const from = l.info.splitFrom ?? l.info.forkedFrom;
      const src = from ? this.sessions.get(from) : undefined;
      return {
        name: this.nameOf(l),
        id: l.info.id,
        rank: l.info.rank ?? (l.info.splitFrom || l.info.forkedFrom ? 1 : -1) * Date.parse(l.info.createdAt),
        ...(l.info.remoteParent ? { remoteParent: l.info.remoteParent } : {}), // 화면 목록과 같은 순서(끌어 옮긴 자리, 없으면 맨 위는 최근 것부터)
        ...(l.info.about ? { about: l.info.about } : {}),
        ...(this.recentOf(l) ? { recent: this.recentOf(l) } : {}),
        status: l.info.status === 'working' || l.info.status === 'starting' ? (this.waitingPerm(l) ? '승인 대기' : '작업 중') : '대기',
        ...(l.info.lastModel ? { model: l.info.lastModel } : {}), // 마지막 차례에 쓴 모델
        ...this.activityOf(l), // 일하는 중이면 지금 하는 일 · 시작 시각(다른 PC 화면에 같은 모양으로) // 다른 PC 화면의 상태 표시(승인을 기다리는 건 일하는 중일 때뿐 — 화면과 같은 기준)
        context: this.contextNote(l),
        ...(src ? { [l.info.splitFrom ? 'splitFrom' : 'forkedFrom']: this.nameOf(src) } : {}),
        schedules: this.schedules?.forSession(l.info.id).length ?? 0,
      };
    });
    return { name, version, tasks };
  }

  /** 일하는 중인 작업의 지금 하는 일(메인과 그 하위 에이전트 가운데 가장 최근 도구)과 이번 차례 시작 시각 */
  private activityOf(l: Live): { doing?: string; since?: number } {
    if (l.info.status !== 'working' && l.info.status !== 'starting') return {};
    const last = (x: Live) => {
      for (let i = x.history.length - 1; i >= 0; i--) {
        const e = x.history[i];
        if (e.type === 'user.message') return { at: this.timeOf(e) ?? 0, start: true } as const;
        if (e.type === 'agent.tool') {
          const input = e.input && typeof e.input === 'object' ? (e.input as Record<string, unknown>) : {};
          const v = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.url ?? input.description;
          const arg = typeof v === 'string' ? (v.length > 80 ? `${v.slice(0, 80)}…` : v) : '';
          const name = /clink/.test(e.name) ? '하위 에이전트에게 맡김' : e.name.replace(/^mcp__(.+?)__/, '$1 · ');
          return { at: this.timeOf(e) ?? 0, doing: `${name} ${/clink/.test(e.name) ? '' : arg}`.trim() };
        }
      }
      return { at: 0 };
    };
    // 이번 차례의 시작: 끝난 차례(turn.done) 뒤의 지시나 컨텍스트 정리 시작. 그 사이에 끝난 차례가 있으면 모름(옛 차례부터 세지 않게)
    let since: number | undefined;
    for (let i = l.history.length - 1; i >= 0; i--) {
      const e = l.history[i];
      if (e.type === 'turn.done') break;
      if (e.type === 'user.message' || (e.type === 'session.compacting' && !e.queued)) { since = this.timeOf(e); break; }
    }
    const busy = [l, ...[...this.sessions.values()].filter((w) => w.info.role === 'worker' && w.info.parentId === l.info.id && (w.info.status === 'working' || w.info.status === 'starting'))];
    const best = busy.map(last).filter((x) => 'doing' in x && x.doing).sort((a, b) => b.at - a.at)[0] as { doing?: string } | undefined;
    return { ...(best?.doing ? { doing: best.doing.slice(0, 160) } : {}), ...(since ? { since } : {}) };
  }

  private tryFindTask(key: string): Live | null {
    try { return this.findTask(key); } catch { return null; }
  }

  /** 이 PC 와 연결된 다른 PC 의 작업 목록(session_list) */
  async taskListAll() {
    const here = this.taskList();
    if (!this.peers) return here;
    const views = await this.peers.all();
    const other = views.filter((v) => v.ok).flatMap((v) => v.summary!.tasks.map((t) => ({ name: `${v.name}/${t.name}`, pc: v.name, id: t.id.slice(0, 8), status: t.status, ...(t.about ? { about: t.about } : {}), ...(t.recent ? { recent: t.recent } : {}), ...(t.splitFrom ? { splitFrom: `${v.name}/${t.splitFrom}` } : {}), schedules: t.schedules })));
    const down = views.filter((v) => !v.ok).map((v) => `${v.name || v.url}: ${v.error}`);
    return down.length ? [...here, ...other, { note: `연결 안 된 PC — ${down.join('; ')}` }] : [...here, ...other];
  }

  // ── 연결된 PC 끼리 공통 지침·회사 기억 맞추기: 다르면 이름순 맨 앞 PC 의 입력 세션이 비교해 합치고 모두에게 적용(개인 기억은 PC 마다) ──
  private reconcileAt = 0;
  /** 10분마다(또는 사람이 "지금"). 맞출 게 있어 입력 세션에 맡겼으면 true */
  async reconcileMemory(force = false): Promise<boolean> {
    if (!this.memory || !this.peers || !this.intake) return false;
    if (!force && Date.now() - this.reconcileAt < 30 * 60_000) return false; // 맡긴 뒤 30분은 기다린다
    const me = this.peers.summary().name;
    const views = (await this.peers.all(true)).filter((v) => v.ok && v.memory);
    if (!views.length) return false;
    if (!force && views.some((v) => (v.name ?? '') < me)) return false; // 이름순 맨 앞 PC 가 맡는다(여럿이 동시에 맞추지 않게)
    const sets = [{ pc: me, ...this.memory.shared() }];
    for (const v of views) { const sh = await this.peers.shared(v.url); if (sh) sets.push({ pc: v.name || v.url, ...sh }); }
    const key = (x: { guide: string; items: { text: string }[] }) => `${x.guide}\n${x.items.map((i) => i.text).sort().join('\n')}`;
    if (sets.every((x) => key(x) === key(sets[0]))) return false;
    const intake = await this.ensureIntake();
    if (!intake) return false;
    this.reconcileAt = Date.now();
    const body = sets.map((x) => `## ${x.pc}\n[공통 지침]\n${x.guide || '(없음)'}\n[회사 기억]\n${x.items.map((i) => `- ${i.text} (${i.at.slice(0, 10)})`).join('\n') || '(없음)'}`).join('\n\n');
    await this.handle({ type: 'user.message', sessionId: intake.info.id, text: `[기억 맞추기] 연결된 PC 들의 공통 지침과 회사 기억이 서로 다르다. 같은 뜻은 하나로 합치고, 한쪽에만 있는 것은 더하고, 어긋나면 날짜가 최근인 것을 따른다(판단이 어려우면 둘 다 남기고 끝에 짧게 보고). 합친 결과를 memory_reconcile(guide, items) 로 한 번에 모든 PC 에 적용한다. 개인 기억은 PC 마다 쓰는 사람이 달라 여기 없고 건드리지 않는다.\n\n${body}` }, { via: 'local', user: '입력 요청' });
    return true;
  }

  /** 입력 세션 도구: 합친 공통 지침·회사 기억을 이 PC 와 연결된 모든 PC 에 적용 */
  async memoryReconcileByMain(mainId: string, guide: unknown, items: unknown): Promise<string> {
    if (!this.intake || mainId !== this.intake.sessionId) throw new Error('입력 세션만 쓸 수 있음');
    if (!this.memory || !this.peers) throw new Error('기억 기능이 없음');
    const list = Array.isArray(items) ? items.map(String) : [];
    const me = this.peers.summary().name;
    const views = (await this.peers.all(true)).filter((x) => x.ok && x.memory);
    // 같은 글이 이미 어느 PC 에 있으면 그 날짜(가장 이른 것)를 지킨다 — 맞출 때마다 오늘 날짜가 되지 않게
    const dates: Record<string, string> = {};
    const note = (x: { text: string; at: string }) => { const t = x.text.replace(/\s+/g, ' ').trim(); if (!dates[t] || x.at < dates[t]) dates[t] = x.at; };
    this.memory.shared().items.forEach(note);
    for (const v of views) (await this.peers.shared(v.url))?.items.forEach(note);
    this.memory.replaceShared(guide, list, `맞추기 · ${me}`, dates);
    const done = [me];
    const failed: string[] = [];
    for (const v of views) {
      try { await this.peers.post(v.url, '/memory', { action: 'replaceShared', guide, items: list, dates, by: `맞추기 · ${me}` }); done.push(v.name || v.url); } catch (err) { failed.push(`${v.name || v.url}(${(err as Error).message})`); }
    }
    return `적용: ${done.join(', ')}${failed.length ? ` · 못 함: ${failed.join(', ')}` : ''} · 공통 지침 ${String(guide ?? '').trim() ? '있음' : '없음'}, 회사 기억 ${list.length}개`;
  }

  /** 모든 화면에 짧은 알림(작업과 상관없는 것) */
  notice(message: string) { this.publish({ type: 'notice', message }); }

  publishLimits() { this.publish({ type: 'limits.changed' }); }

  /** 기억이 바뀌었음을 화면에 알린다(설정 → 기억이 다시 읽음) */
  publishMemory() { this.publish({ type: 'memory.changed' }); }

  /** 기억 남기기·보기·지우기(메인 도구) */
  memoryByMain(mainId: string, op: 'save' | 'list' | 'delete', a: Record<string, unknown>): string {
    if (!this.memory) throw new Error('기억 기능이 없음');
    const me = this.sessions.get(mainId);
    if (!me) throw new Error('없는 작업');
    if (op === 'list') return JSON.stringify(this.memory.public().items.map((x) => ({ id: x.id, text: x.text, by: x.by })), null, 2);
    if (me.info.permMode) throw new Error('늘 묻기·읽기만인 작업은 기억을 바꾸지 못함');
    if (op === 'delete') { this.memory.remove(a.id); return '지움'; }
    const item = this.memory.add(a.text, this.nameOf(me), a.scope);
    me.memSeen = this.memory.noteFor(me.memSeen).seen; // 자기가 남긴 것은 다시 받지 않는다
    return `기억함(${item.id}${item.scope === 'company' ? ', 회사' : ', 개인'}): ${item.text}${this.memory.fullness()}`;
  }

  /** 역할 설명 쓰기(메인 도구): key 가 없으면 이 작업 */
  taskAboutByMain(mainId: string, about: unknown, key?: unknown): string {
    const { target } = this.crossTask(mainId, key);
    this.setAbout(target, String(about ?? ''));
    return `${this.nameOf(target)} 역할 설명을 ${String(about ?? '').trim() ? '바꿈' : '지움'}`;
  }

  /** 다른 작업에 지시를 보낸다(그 작업 대화에 "작업 <보낸 작업 이름>" 이 보낸 것으로 들어간다). 일하는 중이면 다음 차례에 */
  async taskSendByMain(mainId: string, key: unknown, text: unknown): Promise<string> {
    const body = String(text ?? '').trim();
    if (!body) throw new Error('보낼 글이 비어 있음');
    // "PC이름/작업" — 이 PC 에 그런 이름의 작업이 없고 연결된 PC 이름이면 그 PC 로
    const k = String(key ?? '');
    const slash = k.indexOf('/');
    if (slash > 0 && this.peers && !this.tryFindTask(k)) {
      const me = this.sessions.get(mainId);
      if (!me) throw new Error('없는 작업');
      if (me.info.permMode) throw new Error('늘 묻기·읽기만인 작업은 다른 작업을 다루지 못함');
      return this.peers.send(k.slice(0, slash), k.slice(slash + 1), body.slice(0, 20000), this.nameOf(me));
    }
    const { me, target } = this.crossTask(mainId, key);
    if (target === me) throw new Error('자기 작업에는 보낼 수 없음');
    const busy = target.info.status === 'working' || target.info.status === 'starting';
    await this.handle({ type: 'user.message', sessionId: target.info.id, text: body.slice(0, 20000) }, { via: 'local', user: `작업 ${this.nameOf(me)}` });
    return `${this.nameOf(target)} 에 보냄${busy ? '(일하는 중이라 지금 차례가 끝나면 이어서 받음)' : ''}`;
  }

  /** 분담 만들기: from(없으면 이 작업)을 분담하고 이름을 붙인다. 분담끼리는 서로 한 일을 공유한다 */
  async taskSplitByMain(mainId: string, name: unknown, fromKey?: unknown): Promise<string> {
    const { me, target: from } = this.crossTask(mainId, fromKey);
    if (me.info.permMode) throw new Error('늘 묻기·읽기만인 작업은 분담을 만들지 못함');
    const title = String(name ?? '').trim().slice(0, 80);
    if (!title) throw new Error('분담 이름을 주세요');
    const copy = await this.forkLive(from, { via: 'local', user: `작업 ${this.nameOf(me)}` }, ' (분담)', undefined, 'split');
    this.rename(copy, title);
    return `${this.nameOf(from)} 에서 분담 "${title}"(${copy.info.id.slice(0, 8)}) 을 만듦. 첫 지시는 session_send 로 보낸다`;
  }

  /** 메인이 이 PC 의 프리셋·에이전트·스킬·툴을 공유 레포에 올린다(이름으로). 사람 승인 후 */
  async sharePushByMain(mainId: string, kind: SharedKind, name: string): Promise<string> {
    if (!this.shared) throw new Error('공유 레포 기능이 없음');
    const st = this.shared.public();
    if (!st.repo) throw new Error('연동에서 공유 레포를 먼저 정해야 함');
    if (!SHARED_KINDS.includes(kind)) throw new Error('kind 는 presets·agents·skills·tools 중 하나');
    const label = { presets: '프리셋', agents: '에이전트', skills: '스킬', tools: '툴' }[kind];
    if (!st.kinds[kind]) throw new Error(`${label} 공유가 꺼져 있음(연동에서 켠다)`);
    const n = name.trim();
    const list: { id?: string; name: string; shared?: true }[] =
      kind === 'presets' ? this.workPresets?.list() ?? [] : kind === 'agents' ? this.presets?.list() ?? [] : kind === 'tools' ? this.tools?.list() ?? [] : this.hubSkills?.list() ?? [];
    const item = list.find((x) => x.name.toLowerCase() === n.toLowerCase() && !x.shared) ?? list.find((x) => x.name.toLowerCase() === n.toLowerCase());
    if (!item) throw new Error(`없는 ${label}: ${n} (있는 것: ${list.map((x) => x.name).join(', ') || '없음'})`);
    if (item.shared) throw new Error(`이미 공유된 ${label}: ${item.name}`);
    if (!(await this.askHuman(mainId, `공유 레포에 올리기 · ${label} ${item.name}`, `${st.repo} 에 올립니다. 모든 PC 가 받아 쓰고, 이 PC 것은 공유본(읽기 전용)으로 바뀝니다`))) throw new Error('사람이 거부함');
    await this.shared.push(kind, kind === 'skills' ? item.name : item.id!);
    return `${st.repo} 에 ${label} "${item.name}" 을 올림`;
  }

  /** 프리셋이 바뀌었음을 모든 화면에 알린다(설정 화면이 다시 읽음) */
  presetsChanged() {
    this.publish({ type: 'presets.changed' });
  }

  /**
   * 메인 에이전트가 프리셋을 만들고·고치고·지운다. 모두가 쓰는 설정이라 저장 전에 사람에게 묻는다
   * (메인 대화에 승인 카드 — 작업자 승인과 같은 방식). 거부되면 throw.
   */
  async presetSaveByMain(mainId: string, input: unknown): Promise<Preset> {
    if (!this.presets) throw new Error('프리셋 저장소가 없음');
    const draft = input as any;
    const existing = typeof draft?.id === 'string' ? this.presets.list().find((p) => p.id === draft.id) : undefined;
    // 형식 검사는 묻기 전에 — 사람에게 틀린 것을 보여 주지 않게
    this.presets.check(input);
    const title = `${existing ? '에이전트 고치기' : '에이전트 만들기'} · ${String(draft.name).trim()} (${draft.agent}${draft.model ? ` · ${draft.model}` : ''})`;
    const detail = [draft.description, String(draft.instructions ?? '').slice(0, 300)].filter(Boolean).join(' — ');
    if (!(await this.askHuman(mainId, title, detail))) throw new Error('사람이 거부함');
    const saved = this.presets.save(input);
    this.presetsChanged();
    return saved;
  }

  async presetDeleteByMain(mainId: string, key: string): Promise<Preset> {
    const p = this.presets?.find(key);
    if (!p) throw new Error(`없는 프리셋: ${key}`);
    if (!(await this.askHuman(mainId, `에이전트 지우기 · ${p.name}`, p.description))) throw new Error('사람이 거부함');
    this.presets!.remove(p.id);
    this.presetsChanged();
    return p;
  }

  /** 권한 묻지 않기(모든 작업) 켜기·끄기. 켜면 지금 기다리는 승인 요청도 바로 허용한다(호스트가 직접 묻는 것은 빼고) */
  setAutoApproveAll(on: boolean) {
    this.autoApproveAll = on;
    mkdirSync(dirname(this.permFile), { recursive: true });
    writeFileSync(this.permFile, JSON.stringify({ autoApproveAll: on }, null, 2));
    if (!on) return;
    for (const live of this.sessions.values()) {
      if (live.dormant || live.info.permMode) continue; // 이 작업만의 권한(늘 묻기·읽기만)이 앞선다
      const done = new Set(live.history.filter((e) => e.type === 'permission.resolved').map((e: any) => e.requestId));
      for (const e of live.history) {
        if (e.type !== 'permission.request' || done.has(e.requestId) || this.asks.has(e.requestId)) continue;
        this.publish({ type: 'permission.resolved', sessionId: live.info.id, requestId: e.requestId, allow: true, by: '자동 허용' });
        live.adapter.respondPermission(e.requestId, true);
      }
    }
  }

  /** 세션 대화에 승인 카드를 띄우고 사람의 답을 기다린다. 세션이 끝나면 거부로 본다. */
  private askHuman(sessionId: string, tool: string, detail: string): Promise<boolean> {
    const live = this.sessions.get(sessionId);
    if (!live || live.dormant) return Promise.resolve(false);
    const requestId = `hub${++this.askSeq}-${randomUUID().slice(0, 8)}`; // Agent Hub 를 다시 켜도 기록의 예전 요청과 겹치지 않게
    return new Promise((resolve) => {
      this.asks.set(requestId, { sessionId, resolve });
      this.publish({ type: 'permission.request', sessionId, requestId, tool, detail });
    });
  }

  /** MCP 토큰 → 메인 세션 id (끝난 메인이면 없음) */
  mainForToken(token: string): string | undefined {
    return this.tokens.get(token);
  }

  async handle(cmd: ClientCommand, origin: CommandOrigin): Promise<void> {
    switch (cmd.type) {
      case 'session.create': {
        // 프리셋(작업 환경): 폴더·연결 폴더를 정하고, 지침은 첫 지시에 붙인다. 폴더가 없으면 뿌리 아래에 만든다.
        const wp = cmd.workPreset ? this.workPresets?.find(cmd.workPreset) : undefined;
        if (cmd.workPreset && !wp) return this.publish({ type: 'error', message: `없는 프리셋: ${cmd.workPreset}` });
        const dir = wp ? this.ensureFolder(wp.folder) : this.resolveWorkdir(cmd.workdir);
        if (!dir) return this.publish({ type: 'error', message: `작업 폴더는 ${this.workspaceRoot} 안의 있는 폴더여야 함: ${wp?.folder ?? cmd.workdir}` });
        const extraDirs = (wp?.extraDirs ?? []).map((d) => this.ensureFolder(d)).filter((d): d is string => Boolean(d) && d !== dir);
        // 에이전트를 메인으로: 그 AI·모델로 띄우고, 첫 지시에 역할 지침을 붙인다
        // 에이전트를 따로 고르지 않았으면 프리셋이 정한 메인 에이전트
        const presetKey = cmd.preset ?? wp?.mainAgent;
        const preset = presetKey ? this.presets?.find(presetKey) : undefined;
        if (cmd.preset && !preset) return this.publish({ type: 'error', message: `없는 에이전트: ${cmd.preset}` });
        const live = await this.create({
          agent: preset?.agent ?? cmd.agent,
          role: cmd.role,
          model: cmd.model ?? preset?.model,
          defaultWorker: cmd.role === 'main' ? cmd.defaultWorker : undefined,
          preset: preset ? { id: preset.id, name: preset.name } : undefined,
          workPreset: wp ? { id: wp.id, name: wp.name } : undefined,
          workdir: dir,
          extraDirs,
          title: cmd.title,
          origin,
          autoApprove: preset?.autoApprove,
          via: cmd.via,
          // 새 작업 기본 입력 거치기(설정 → 입력): 사람이 이 화면에서 만든 메인 작업만(바깥 시스템·예약·입력 세션 자신은 빼고)
          viaIntake: Boolean(this.intake?.newTasksOn && cmd.role === 'main' && !cmd.via && origin.user === 'local' && !this.makingIntake),
        });
        if (preset) live.role = preset;
        if (wp) live.guide = wp;
        return;
      }
      case 'session.import':
        return this.importClaude(cmd.cliSessionId, origin);
      case 'user.message': {
        const live = this.get(cmd.sessionId);
        if (!live) return;
        // 막은 원격 접속에서 온 글은 받지 않는다(기록·에이전트 어디에도 넣지 않고 알리기만)
        if (cmd.via && live.remotes?.get(remoteKey(cmd.via.app, cmd.via.label))?.blocked) {
          return this.publish({ type: 'error', sessionId: cmd.sessionId, message: `막힌 원격 접속에서 온 글이라 받지 않았습니다: ${viaLabel(cmd.via)}` });
        }
        const atts = cmd.attachments?.filter((a) => this.attachmentPath(live, a.path)) ?? [];
        this.publish({ type: 'user.message', sessionId: cmd.sessionId, text: cmd.text, from: origin.user, ...(cmd.effort ? { effort: cmd.effort } : {}), ...(atts.length ? { attachments: atts } : {}), ...(cmd.via ? { via: cmd.via } : {}), ...(origin.author && !cmd.via ? { author: origin.author } : {}) });
        // 컨텍스트 정리 부탁(글 전체가 그 말일 때만): AI 에게 보통 지시로 보내지 않고 앱이 정리한다
        if (isCompactRequest(cmd.text) && !atts.length) return this.compact(live, origin.user);
        // 입력 거치기: 사람이 쓴 지시는 이 작업 AI 로 바로 보내지 않고 입력 세션이 먼저 정리한다(다른 작업·예약·입력 세션이 보낸 것, / 명령은 그대로)
        if (this.intake && live.info.viaIntake && live.info.id !== this.intake.sessionId && isHumanOrigin(origin.user) && viaThroughIntake(cmd.via) && !cmd.text.trimStart().startsWith('/')) {
          if (await this.toIntake(live, cmd.text, atts)) return;
        }
        // 첨부: 모든 파일은 작업 폴더 경로로 알려 주고(에이전트가 열어 봄), 이미지는 이미지째 함께 보낸다
        let text = cmd.text;
        if (atts.length) {
          const list = atts.map((a) => `- ${a.path.replace(/\\/g, '/')} (${a.mime}, ${formatSize(a.size)})`).join('\n');
          text = `${text}\n\n[첨부 파일 — 작업 폴더 기준 경로]\n${list}`.trim();
        }
        const images = atts
          .filter((a) => IMAGE_MIME.has(a.mime) && a.size <= MAX_INLINE_IMAGE)
          .map((a) => ({ mime: a.mime, data: readFileSync(this.attachmentPath(live, a.path)!).toString('base64') }));
        if (live.dormant && !(await this.wake(live, true))) return;
        this.setStatus(live, 'working');
        live.adapter.send(this.compose(live, text), images);
        return;
      }
      case 'permission.respond': {
        const live = this.get(cmd.sessionId);
        if (!live) return;
        // 같은 요청에 PC·대시보드가 동시에 답할 수 있다 — 먼저 온 답만 받는다.
        const open = live.history.some((e) => e.type === 'permission.request' && e.requestId === cmd.requestId);
        const done = live.history.some((e) => e.type === 'permission.resolved' && e.requestId === cmd.requestId);
        if (!open || done) return;
        this.publish({ type: 'permission.resolved', sessionId: cmd.sessionId, requestId: cmd.requestId, allow: cmd.allow, by: origin.user });
        // 호스트가 직접 물은 것(프리셋 저장 등)이면 그 질문에 답하고, 아니면 CLI 에 전달
        const ask = this.asks.get(cmd.requestId);
        if (ask) {
          this.asks.delete(cmd.requestId);
          ask.resolve(cmd.allow);
        } else live.adapter.respondPermission(cmd.requestId, cmd.allow);
        return;
      }
      case 'session.stop': {
        const live = this.get(cmd.sessionId);
        if (!live) return;
        // 멈춤(■): 하던 차례만 멈춘다. 메인을 멈추면 그 메인이 맡긴 작업자도 멈춘다. 작업은 대기로 남는다
        for (const w of this.sessions.values()) if (w.info.parentId === live.info.id) this.halt(w, origin.user);
        this.halt(live, origin.user);
        return;
      }
      case 'session.rename': {
        const live = this.get(cmd.sessionId);
        if (!live) return;
        this.rename(live, cmd.title);
        return;
      }
      case 'session.reparent': {
        // 끌어 놓기로 계층 옮기기: 다른 작업 아래(하위 작업)로, 또는 맨 위로. 자기 자신·자기 아래 작업 밑으로는 못 간다
        const live = this.get(cmd.sessionId);
        if (!live || live.info.role !== 'main') return;
        const parent = cmd.parentId ? this.get(cmd.parentId) : undefined;
        if (cmd.parentId && (!parent || parent.info.role !== 'main' || parent === live || this.descendants(live).includes(parent))) {
          return this.publish({ type: 'error', sessionId: live.info.id, message: '그 작업 아래로는 옮길 수 없음(자기 자신이나 자기 아래 작업)' });
        }
        this.reparent(live, parent?.info.id ?? null);
        return;
      }
      case 'session.mergeInto': {
        // 합치기: 이 작업이 한 일을 대상 작업에 넘기고, 아래 작업은 대상 아래로 옮기고, 이 작업은 보관한다(지우지 않아 되돌릴 수 있다)
        const live = this.get(cmd.sessionId);
        const target = this.get(cmd.targetId);
        if (!live || !target || live === target || live.info.role !== 'main' || target.info.role !== 'main') return;
        if (this.descendants(live).includes(target)) return this.publish({ type: 'error', sessionId: live.info.id, message: '자기 아래 작업에는 합칠 수 없음 — 먼저 그 작업을 밖으로 옮긴다' });
        this.shareTo(live, target, 'split', 'all', true);
        for (const k of [...this.sessions.values()]) if (k.info.role === 'main' && (k.info.splitFrom ?? k.info.forkedFrom) === live.info.id) this.reparent(k, target.info.id);
        if (live.info.status === 'working' || live.info.status === 'starting') this.halt(live, origin.user);
        live.info.archived = true;
        this.publish({ type: 'session.archived', sessionId: live.info.id, archived: true });
        // 예약도 받는 작업으로 옮긴다(보관된 작업의 예약은 돌지 않아 그대로 두면 멈춘다)
        const moved = this.schedules?.moveSession(live.info.id, target.info.id) ?? 0;
        if (moved) this.publish({ type: 'schedules.changed' });
        this.publish({ type: 'notice', sessionId: target.info.id, message: `${this.nameOf(live)} 를 합침(그 작업은 보관함${moved ? ` · 예약 ${moved}개를 이 작업으로 옮김` : ''})` });
        return;
      }
      case 'session.moveToPeer': {
        const live = this.get(cmd.sessionId);
        if (!live || live.info.role !== 'main') return;
        try {
          await this.moveToPeer(live, cmd.url, cmd.folder, cmd.secrets ?? []);
        } catch (err) {
          this.publish({ type: 'error', sessionId: live.info.id, message: `다른 PC 로 못 옮김: ${(err as Error).message}` });
        }
        return;
      }
      case 'session.setModel': {
        // 모델만 바꾸기: 생각 깊이처럼 같은 대화로 다음 차례부터(쉬는 중이면 지금 내려 두고, 일하는 중이면 끝난 뒤)
        const live = this.get(cmd.sessionId);
        if (!live || live.info.role !== 'main') return;
        if ((live.info.model ?? null) === cmd.model) return;
        if (cmd.model) live.info.model = cmd.model;
        else delete live.info.model;
        this.publish({ type: 'session.configured', sessionId: live.info.id, session: { ...live.info } });
        if (live.info.status === 'working' || live.info.status === 'starting') live.relaunch = true;
        else this.sleep(live);
        return;
      }
      case 'session.effort': {
        // 생각 깊이: CLI 를 띄울 때 정하는 값이라, 쉬는 중이면 지금 내려 두고(다음 지시에 같은 대화로 다시 뜸) 일하는 중이면 끝난 뒤 내린다
        const live = this.get(cmd.sessionId);
        if (!live || live.info.role !== 'main') return;
        if ((live.info.effort ?? null) === cmd.effort) return;
        if (cmd.effort) live.info.effort = cmd.effort;
        else delete live.info.effort;
        this.publish({ type: 'session.configured', sessionId: live.info.id, session: { ...live.info } });
        if (live.info.status === 'working' || live.info.status === 'starting') live.relaunch = true;
        else this.sleep(live);
        return;
      }
      case 'session.mergeIntoPeer': {
        // 다른 PC 작업에 합치기: 이 PC 안 합치기와 같게 — 한 일(사람 지시 · 마지막 보고)과 그림 · 첨부 그림을 그 작업에 넘기고,
        // 아래 작업은 그 작업 아래로 옮기고, 이 작업은 보관한다(지우지 않아 되돌릴 수 있다)
        const live = this.get(cmd.sessionId);
        if (!live || live.info.role !== 'main') return;
        try {
          await this.mergeIntoPeer(live, cmd.url, cmd.targetId, origin.user);
        } catch (err) {
          this.publish({ type: 'error', sessionId: live.info.id, message: `다른 PC 작업에 못 합침: ${(err as Error).message}` });
        }
        return;
      }
      case 'session.setIntake': {
        const live = this.get(cmd.sessionId);
        if (!live || live.info.role !== 'main' || live.info.id === this.intake?.sessionId) return;
        if (Boolean(live.info.viaIntake) === cmd.on) return;
        if (cmd.on) live.info.viaIntake = true;
        else delete live.info.viaIntake;
        this.publish({ type: 'session.intakeSet', sessionId: live.info.id, on: cmd.on });
        return;
      }
      case 'session.archive': {
        // 보관·꺼내기: 그 작업과 그 아래(분담·포크로 갈라진) 작업까지. 보관하면 하던 차례는 멈춘다
        const live = this.get(cmd.sessionId);
        if (!live) return;
        const all = [live, ...this.descendants(live)];
        for (const t of all) {
          if (Boolean(t.info.archived) === cmd.archived) continue;
          if (cmd.archived) {
            for (const w of this.sessions.values()) if (w.info.parentId === t.info.id) this.halt(w, origin.user);
            if (t.info.status === 'working' || t.info.status === 'starting') this.halt(t, origin.user);
            t.info.archived = true;
          } else delete t.info.archived;
          this.publish({ type: 'session.archived', sessionId: t.info.id, archived: cmd.archived });
        }
        return;
      }
      case 'session.setAbout': {
        const live = this.get(cmd.sessionId);
        if (!live) return;
        this.setAbout(live, cmd.about);
        return;
      }
      case 'session.reorder': {
        // 목록 순서만(계층은 그대로). 같은 단계 안에서의 자리를 화면이 정해 보낸다
        const live = this.get(cmd.sessionId);
        if (!live) return;
        live.info.rank = cmd.rank;
        this.publish({ type: 'session.reordered', sessionId: cmd.sessionId, rank: cmd.rank });
        return;
      }
      case 'session.dirs': {
        const live = this.get(cmd.sessionId);
        if (!live) return;
        // 작업 폴더 뿌리 아래 폴더, 또는 PC 앞에서 직접 고른 다른 폴더(절대 경로). 작업 폴더 자신은 빼고
        const dirs: string[] = [];
        const had = new Set(live.info.extraDirs ?? []);
        for (const d of cmd.dirs) {
          const abs = this.resolveWorkdir(d) ?? (had.has(d) ? d : null) ?? this.outsideDir(d, origin);
          if (typeof abs !== 'string') return this.publish({ type: 'error', sessionId: cmd.sessionId, message: abs?.error ?? `연결할 수 없는 폴더: ${d}` });
          if (abs !== live.info.workdir && !dirs.includes(abs)) dirs.push(abs);
        }
        live.info.extraDirs = dirs;
        this.publish({ type: 'session.dirs', sessionId: cmd.sessionId, dirs });
        return;
      }
      case 'session.delete': {
        const live = this.get(cmd.sessionId);
        if (!live) return;
        // 작업자까지 끝내고 목록에서 뺀다. 기록 파일(data/sessions/*.jsonl)은 AX 근거라 남긴다.
        const targets = [...this.sessions.values()].filter((w) => w.info.parentId === live.info.id).concat(live);
        for (const t of targets) {
          if (!t.dormant) t.adapter.stop();
          if (t.token) this.tokens.delete(t.token);
          for (const [id, a] of this.asks) if (a.sessionId === t.info.id) { this.asks.delete(id); a.resolve(false); }
          this.publish({ type: 'session.deleted', sessionId: t.info.id });
          this.sessions.delete(t.info.id);
        }
        if (this.schedules?.forSession(live.info.id).length) {
          this.schedules.removeForSession(live.info.id);
          this.schedulesChanged();
        }
        return;
      }
      case 'session.configure':
        await this.configure(cmd, origin);
        return;
      case 'session.remote': {
        const live = this.get(cmd.sessionId);
        if (!live) return;
        // 막는 것은 어디서든, 푸는 것은 PC 앞에서만(늘 묻기·읽기만과 같은 규칙) — 바깥에서 막힌 연결을 스스로 풀지 못하게
        const fail = (message: string) => this.publish({ type: 'error', sessionId: cmd.sessionId, message });
        const r = live.remotes?.get(remoteKey(cmd.app, cmd.label));
        if (!r) return fail(`이 작업에 연결한 적 없는 원격 접속: ${cmd.app} · ${cmd.label}`);
        if (r.blocked === cmd.blocked) return;
        if (!cmd.blocked && origin.via !== 'local' && !origin.trusted) return fail('막힌 원격 접속을 푸는 것은 PC 앞에서만 할 수 있음');
        this.publish({ type: 'session.remoteBlocked', sessionId: cmd.sessionId, app: r.app, label: r.label, blocked: cmd.blocked, by: origin.user });
        return;
      }
      case 'session.fork': {
        const live = this.get(cmd.sessionId);
        if (!live) return;
        if (live.info.role === 'worker') return this.publish({ type: 'error', sessionId: cmd.sessionId, message: '하위 에이전트는 포크할 수 없음. 메인 작업을 포크하세요' });
        await this.forkLive(live, origin, ' (포크)', cmd.upTo);
        return;
      }
      case 'session.split': {
        const live = this.get(cmd.sessionId);
        if (!live) return;
        if (live.info.role === 'worker') return this.publish({ type: 'error', sessionId: cmd.sessionId, message: '하위 에이전트는 분담할 수 없음. 메인 작업을 분담하세요' });
        await this.forkLive(live, origin, ' (분담)', cmd.upTo, 'split');
        return;
      }
      case 'session.compact': {
        const live = this.get(cmd.sessionId);
        if (live) await this.compact(live, origin.user);
        return;
      }
      case 'session.rewind': {
        const live = this.get(cmd.sessionId);
        if (!live) return;
        const no = (message: string) => this.publish({ type: 'error', sessionId: cmd.sessionId, message });
        if (live.info.role === 'worker') return no('하위 에이전트는 되감을 수 없음');
        if (live.info.status === 'working' || live.info.status === 'starting') return no('일하는 중에는 되감을 수 없음. 멈춘(■) 뒤에 되감으세요');
        const turns = turnsOf(live.history);
        if (cmd.upTo >= turns) return no(`되감을 차례가 없음 (지금 ${turns}번째 차례까지 있음)`);
        // 지금 CLI 는 뒤쪽 대화를 기억하므로 내리고, 다음 지시 때 그 앞까지만 글로 붙여 새로 띄운다(wake). 파일은 되돌리지 않는다
        live.gen = (live.gen ?? 0) + 1;
        if (!live.dormant) live.adapter.stop();
        live.dormant = true;
        live.resume = undefined;
        live.carry = undefined;
        live.ctx = [];
        if (live.token) this.tokens.delete(live.token);
        live.token = undefined;
        for (const [id, a] of this.asks) if (a.sessionId === live.info.id) { this.asks.delete(id); a.resolve(false); }
        delete live.info.cliSessionId;
        this.publish({ type: 'session.rewound', sessionId: live.info.id, upTo: cmd.upTo, by: origin.user });
        this.publish({ type: 'context.usage', sessionId: live.info.id, used: 0, window: null });
        this.publishContext(live);
        if (live.info.status !== 'idle') {
          live.info.status = 'idle';
          this.publish({ type: 'session.status', sessionId: live.info.id, status: 'idle' });
        }
        return;
      }
      case 'session.copy': {
        const live = this.get(cmd.sessionId);
        if (!live) return;
        if (live.info.role === 'worker') return this.publish({ type: 'error', sessionId: cmd.sessionId, message: '하위 에이전트는 복사할 수 없음' });
        await this.forkLive(live, origin, ' (사본)', undefined, 'copy');
        return;
      }
      case 'terminal.open':
        await this.terminal(cmd.agent, cmd.sessionId, cmd.workdir, origin, cmd.profile);
        return;
    }
  }

  /**
   * 멈춤: 하던 차례만 멈춘다. 묻던 것은 거부로 정리한다.
   * 차례만 멈출 수 있는 CLI(Claude interrupt, ACP session/cancel)는 그대로 두고, 아니면(또는 10초 안에 안 멈추면) 끈다 — 다음 지시 때 다시 띄운다.
   */
  private halt(live: Live, by: string) {
    const st = live.info.status;
    if (live.dormant || (st !== 'working' && st !== 'starting')) return;
    const id = live.info.id;
    this.closePerms(live, '멈춤');
    this.publish({ type: 'session.halted', sessionId: id, by });
    if (st === 'working' && live.adapter.interrupt) {
      live.adapter.interrupt();
      const gen = live.gen;
      const t = setTimeout(() => { if (live.gen === gen && !live.dormant && live.info.status === 'working') live.adapter.stop(); }, 10_000);
      t.unref?.();
    } else live.adapter.stop();
  }

  /** 아직 답하지 않은 승인 요청을 거부로 정리한다(호스트가 직접 물은 것 포함) — 화면의 허용·거부 버튼이 남지 않게 */
  private closePerms(live: Live, by: string) {
    const id = live.info.id;
    for (const [rid, a] of this.asks) if (a.sessionId === id) { this.asks.delete(rid); a.resolve(false); }
    const done = new Set(live.history.flatMap((e) => (e.type === 'permission.resolved' ? [e.requestId] : [])));
    for (const e of [...live.history]) {
      if (e.type === 'permission.request' && !done.has(e.requestId)) this.publish({ type: 'permission.resolved', sessionId: id, requestId: e.requestId, allow: false, by });
    }
  }

  /** 이번 지시에 붙어 갈 것을 붙인다: 역할 지침, 작업 환경 지침, 포크·분담 공유, 앞 대화(화면·기록에는 사람이 쓴 글만) */
  private compose(live: Live, text: string): string {
    if (live.role) {
      text = withRole(live.role, text);
      live.role = undefined;
    }
    if (live.guide) {
      text = withGuidelines(live.guide, text);
      live.guide = undefined;
    }
    // 역할 설명: 지시마다 지금 역할을 한 줄 앞에 붙인다 — 맡는 일이 바뀌었으면 에이전트가 session_about 으로 고친다(지침은 hub 안내에, 따로 AI 를 부르지 않는다)
    if (this.aboutLine && live.info.role === 'main' && !text.trimStart().startsWith('/')) text = `${aboutNote(live.info.about)}\n${text}`;
    // 기억·공통 지침: 처음엔 전부, 그 뒤로는 바뀐 것만
    if (this.memory && live.info.role === 'main' && !text.trimStart().startsWith('/')) {
      const note = this.memory.noteFor(live.memSeen);
      live.memSeen = note.seen;
      if (note.text) text = `${note.text}\n\n${text}`;
    }
    const sent = this.pendingContext(live).map(({ label, chars }) => ({ label, chars }));
    if (live.merges?.length) {
      text = `${live.merges.map((m) => m.text).join('\n\n')}\n\n[이어서 할 일]\n${text}`;
      live.merges = undefined;
    }
    const carry = live.carry;
    live.carry = undefined;
    if (sent.length) {
      (live.ctx ??= []).push(...sent);
      this.publishContext(live);
    }
    return carry ? `[이전 대화 — 이 작업의 앞선 기록. 이어서 진행한다]\n${carry}\n\n[이어서 할 일]\n${text}` : text;
  }

  /**
   * 끝난 작업이나 호스트를 다시 켜서 쉬는 작업을 같은 작업 그대로(id·기록·하위 작업) 다시 띄운다.
   * 새 CLI 는 앞 대화를 모르므로 다음 지시에 지금까지의 대화와 역할·작업 환경 지침을 붙인다.
   * 못 띄웠으면 false(끝남 이유가 기록에 남는다).
   */
  private async wake(live: Live, sentNow = false): Promise<boolean> {
    const info = live.info;
    live.dormant = false;
    live.gen = (live.gen ?? 0) + 1; // 앞 CLI 가 늦게 보내는 이벤트는 버린다
    if (live.token) this.tokens.delete(live.token);
    live.token = undefined;
    live.merges = undefined;
    live.ctx = [];
    // Claude 대화 기록이 남아 있으면 --resume 으로 그 대화에 그대로 이어 간다(대화·지침이 이미 그 안에 있다)
    live.resume = this.resumable(live);
    if (!live.resume) {
      // sentNow: 방금 기록한 이번 지시는 앞 대화에서 뺀다(이번 지시로 따로 간다)
      const upto = sentNow ? live.history.findLastIndex((e) => e.type === 'user.message') : -1;
      const said = conversation(upto >= 0 ? live.history.slice(0, upto) : live.history);
      if (said.length) live.carry = [live.carry, tail(said.join('\n'))].filter(Boolean).join('\n');
      live.role = info.preset ? this.presets?.find(info.preset.id) : undefined;
      live.guide = info.workPreset ? this.workPresets?.find(info.workPreset.id) : undefined;
    }
    info.status = 'starting';
    this.publish({ type: 'session.status', sessionId: info.id, status: 'starting' });
    this.publish({ type: 'context.usage', sessionId: info.id, used: 0, window: null });
    this.publishContext(live);
    live.adapter = this.makeAdapter(info.agent);
    await this.launch(live);
    return !live.dormant;
  }

  /**
   * 같은 설정·폴더로 새 작업을 만들고 지금까지의 대화를 이어받게 한다.
   * 에이전트·프리셋도 이어받는다(전용 프로필, 첫 지시의 역할·작업 환경 지침).
   */
  private async forkLive(live: Live, origin: CommandOrigin, suffix: string, upTo?: number, kind: 'fork' | 'split' | 'copy' = 'fork'): Promise<Live> {
    const o = live.info;
    const copy = await this.create({
      agent: o.agent,
      role: o.role,
      model: o.model,
      defaultWorker: o.defaultWorker,
      preset: o.preset,
      workPreset: o.workPreset,
      workdir: o.workdir,
      origin,
      forkedFrom: kind === 'fork' ? o.id : undefined, // 포크: 포크 → 원본 공유
      splitFrom: kind === 'split' ? o.id : undefined, // 분담: 서로 공유
      splitLines: kind === 'split' ? conversation(live.history, upTo).length : undefined,
      copiedFrom: kind === 'copy' ? o.id : undefined, // 복사: 공유 없음
      customTitle: o.customTitle ? `${o.customTitle}${suffix}` : undefined,
      extraDirs: o.extraDirs,
      autoApprove: o.autoApprove,
      permMode: o.permMode,
    });
    const role = o.preset ? this.presets?.find(o.preset.id) : undefined;
    const guide = o.workPreset ? this.workPresets?.find(o.workPreset.id) : undefined;
    if (role) copy.role = role;
    if (guide) copy.guide = guide;
    // 새 CLI 는 앞 대화를 모르므로, 첫 지시에 지금까지의 대화를 붙여 이어받게 한다(모든 CLI 에 똑같이 통하는 방법)
    copy.carry = transcript(live.history, upTo);
    this.publishContext(copy);
    return copy;
  }

  // ── 예약: 작업 하나에 걸어 둔 지시를 정한 시각에 보낸다 ──

  schedulesChanged() {
    this.publish({ type: 'schedules.changed' });
  }

  /** 차례가 된 예약을 실행한다. 1분마다 부른다(시험에서는 now 를 넘긴다). */
  async runSchedules(now = new Date()): Promise<void> {
    if (!this.schedules) return;
    for (const s of this.schedules.due(now)) {
      if (this.scheduleRunning.has(s.id)) continue;
      // 보관한 작업의 예약은 돌리지 않는다(다음 차례로만 넘긴다)
      if (this.sessions.get(s.sessionId)?.info.archived) {
        this.schedules.markRun(s.id, now, '보관 중이라 건너뜀');
        this.schedulesChanged();
        continue;
      }
      // 간격 예약: 앞 차례의 일이 아직 안 끝났으면 이번 차례는 건너뛴다(지시가 쌓이지 않게)
      const st = this.sessions.get(s.sessionId)?.info.status;
      if (s.repeat === 'interval' && (st === 'working' || st === 'starting')) {
        this.schedules.markRun(s.id, now, '작업 중이라 건너뜀');
        this.schedulesChanged();
        continue;
      }
      this.scheduleRunning.add(s.id);
      try {
        const r = await this.runScheduled(s.sessionId, s.prompt, s.id);
        // 보내는 사이에 그 차례가 벌써 끝났으면 끝난 결과를 남긴다
        const done = this.schedDone.get(s.id);
        this.schedDone.delete(s.id);
        const prev = this.lastResultOf(s.id);
        this.schedules.markRun(s.id, now, done ?? r.result, r.sessionId);
        this.alertSchedule(s.id, prev, done ?? r.result);
      } catch (err) {
        const prev = this.lastResultOf(s.id);
        this.schedules.markRun(s.id, now, `실패: ${(err as Error).message}`);
        this.alertSchedule(s.id, prev, `실패: ${(err as Error).message}`);
      } finally {
        this.scheduleRunning.delete(s.id);
      }
      this.schedulesChanged();
    }
  }

  /** 예약으로 보낸 지시의 차례가 끝남: 예약 결과를 고치고, 실패면 화면이 알림을 띄운다(error 이벤트) */
  private schedDone = new Map<string, string>(); // 보내는 사이에 끝난 예약 차례의 결과
  private finishScheduled(live: Live, result: string) {
    const run = live.schedRun;
    live.schedRun = undefined;
    if (!run || !this.schedules) return;
    result = `${run.note} → ${result}`;
    if (this.scheduleRunning.has(run.id)) this.schedDone.set(run.id, result); // 아직 보내는 중: 보낸 뒤 남긴다
    else {
      const prev = this.lastResultOf(run.id);
      this.schedules.markResult(run.id, result);
      this.alertSchedule(run.id, prev, result);
    }
    this.schedulesChanged();
    if (result.startsWith('실패')) this.publish({ type: 'error', sessionId: live.info.id, message: `예약 실행 ${result}` });
  }

  private lastResultOf(id: string): string | undefined {
    return this.schedules?.list().find((x) => x.id === id)?.lastResult;
  }

  /** 예약 결과 → 운영 알림: 실패로 끝나면 알리고, 앞이 실패였는데 이번에 끝까지 되면 풀림. 보내는 중 · 건너뜀은 아무것도 */
  private alertSchedule(id: string, prev: string | undefined, result: string) {
    if (!this.opsAlert) return;
    const key = `schedule-${id}`;
    if (scheduleFailed(result)) {
      const s = this.schedules?.list().find((x) => x.id === id);
      const t = s && this.sessions.get(s.sessionId);
      const first = (s?.prompt ?? '').split('\n').find((l) => l.trim())?.trim().slice(0, 80) ?? '';
      const why = result.slice(result.indexOf('실패') >= 0 ? result.indexOf('실패') : 0).replace(/^실패:?\s*/, '').split('\n')[0].slice(0, 160) || result.slice(0, 160);
      this.opsAlert({ key, problem: `${t ? this.nameOf(t) : '(지워진 작업)'} 예약 '${first}' 이 실패: ${why}`, since: new Date().toISOString(), action: '' });
    } else if (/끝남/.test(result) && prev && scheduleFailed(prev)) this.opsAlert({ key, resolved: true });
  }

  /** 같은 작업에 보낸다. 끝났거나 호스트를 다시 켜서 쉬는 작업이면 다시 띄워 앞 대화를 붙여 이어 간다. */
  private async runScheduled(sessionId: string, prompt: string, scheduleId?: string): Promise<{ result: string; sessionId?: string }> {
    const live = this.sessions.get(sessionId);
    if (!live) return { result: '작업이 없어 건너뜀' };
    const woke = live.dormant;
    // 이 지시의 차례가 끝나면 결과(끝남 · 걸린 시간 / 실패: 이유)로 고친다. 하던 차례가 있으면 그다음 차례
    if (scheduleId) live.schedRun = { id: scheduleId, skip: live.info.status === 'working' ? 1 : 0, started: Date.now(), note: woke ? '쉬던 작업을 다시 띄워 보냄' : '보냄' };
    await this.handle({ type: 'user.message', sessionId, text: prompt }, { via: 'local', user: '예약' });
    if (live.dormant) return { result: '작업을 다시 띄우지 못함' };
    return { result: woke ? '쉬던 작업을 다시 띄워 보냄' : '보냄' };
  }

  stopAll() {
    for (const live of this.sessions.values()) if (!live.dormant) live.adapter.stop();
  }

  // ── clink: 메인 에이전트가 작업자에게 일을 맡긴다 (설계: docs/DESIGN.md §5-1) ──

  async clink(mainId: string, args: ClinkArgs): Promise<ClinkResult> {
    const main = this.sessions.get(mainId);
    if (!main || main.info.role !== 'main' || main.dormant) throw new Error('메인 세션이 없거나 쉬는 중');
    const prompt = (args.prompt ?? '').trim();

    let worker: Live | undefined;
    let firstPrompt = prompt; // 작업자에게 실제로 보내는 글(프리셋이면 역할 지침이 앞에 붙는다)
    if (args.continuation_id) {
      worker = this.sessions.get(args.continuation_id);
      if (!worker || worker.info.parentId !== mainId) throw new Error(`이 메인이 맡긴 작업이 아님: ${args.continuation_id}`);
    } else {
      // 프리셋을 고르면 AI·모델·역할 지침을 프리셋에서 가져온다(모델은 clink 의 model 이 우선)
      let preset: Preset | undefined;
      if (args.preset) {
        preset = this.presets?.find(args.preset);
        if (!preset) {
          const names = this.presetList().map((p) => p.name).join(', ') || '없음';
          throw new Error(`없는 프리셋: ${args.preset} (있는 프리셋: ${names})`);
        }
      }
      // 메인 프리셋이 하위 에이전트를 정해 두었으면 그 프리셋으로만 맡길 수 있다(AI 직접 지정도 막음)
      const allowed = this.mainAllowed(mainId);
      if (allowed) {
        const names = this.presetsForMain(mainId).map((p) => p.name).join(', ') || '없음';
        if (!allowed.length) throw new Error('이 작업은 하위 에이전트를 쓰지 않게 정해져 있음 — 바꾸려면 설정에서 에이전트·프리셋의 "하위 에이전트" 허용을 고친다');
        if (!preset) throw new Error(`이 메인은 정해진 하위 에이전트에게만 맡길 수 있음 — preset 으로 고르세요 (허용: ${names})`);
        if (!allowed.includes(preset.id)) throw new Error(`이 메인은 "${preset.name}" 에게 맡길 수 없음 (허용: ${names})`);
      }
      // AI: 프리셋 > 메인이 지정한 cli_name > 사람이 고른 기본 작업자
      const dw = main.info.defaultWorker;
      const agent = preset?.agent ?? args.cli_name ?? dw?.agent;
      if (!agent || !AGENTS.includes(agent)) throw new Error(`cli_name 은 ${AGENTS.join(', ')} 중 하나 (또는 preset)`);
      if (args.model !== undefined && !MODEL_RE.test(args.model)) throw new Error(`쓸 수 없는 모델 이름: ${args.model}`);
      if (!prompt) throw new Error('prompt 가 비었음');
      if (preset) firstPrompt = withRole(preset, prompt);
      // 메인의 작업 환경(프리셋) 지침은 하위 에이전트도 따른다
      const wp = main.info.workPreset ? this.workPresets?.find(main.info.workPreset.id) : undefined;
      if (wp) firstPrompt = withGuidelines(wp, firstPrompt);
      worker = await this.create({
        agent,
        role: 'worker',
        parentId: mainId,
        // 모델: 메인이 지정 > 프리셋 > (같은 AI 라면) 사람이 고른 기본 작업자의 모델 > CLI 기본
        model: args.model ?? preset?.model ?? (dw?.agent === agent ? dw.model : undefined),
        preset: preset ? { id: preset.id, name: preset.name } : undefined,
        workdir: main.info.workdir, // 메인과 같은 작업 폴더
        extraDirs: main.info.extraDirs, // 메인에 연결한 폴더도 같이
        workPreset: main.info.workPreset,
        // 메인이 묻지 않으면 맡긴 일도 묻지 않는다. 메인이 늘 묻기·읽기만이면 맡긴 일도 같다
        autoApprove: !main.info.permMode && Boolean(preset?.autoApprove || main.info.autoApprove),
        permMode: main.info.permMode,
        title: prompt.slice(0, 60),
        origin: { via: main.info.via, user: main.info.requestedBy },
      });
    }

    const busy = worker.turn && !worker.turn.done && !worker.turn.ended;
    if (prompt) {
      if (busy) throw new Error('작업자가 아직 앞 지시를 처리 중 — prompt 없이 같은 continuation_id 로 부르면 이어서 기다린다');
      if (worker.dormant) {
        // 앞서 맡긴 작업자의 CLI 가 꺼졌으면(호스트 재시작 등) 같은 작업자를 다시 띄워 앞 대화를 붙여 이어 간다
        const woke = args.continuation_id ? await this.wake(worker) : false;
        if (!woke) {
          const end = worker.history.findLast((e) => e.type === 'session.ended');
          return this.result(worker, 'ended', end?.type === 'session.ended' ? `작업자 시작 실패: ${end.reason}` : '작업자가 끝났음', 0);
        }
      }
      if (args.continuation_id) firstPrompt = this.compose(worker, prompt);
      worker.turn = { texts: [], errors: [], done: null, ended: null, startedAt: Date.now(), waiters: new Set() };
      this.publish({ type: 'user.message', sessionId: worker.info.id, text: prompt, from: `메인 · ${main.info.agent}` });
      this.setStatus(worker, 'working');
      worker.adapter.send(firstPrompt); // 화면·기록에는 맡긴 일만, 작업자에게는 역할 지침까지
    } else if (!worker.turn) {
      throw new Error('기다릴 작업이 없음 — prompt 를 함께 보내야 함');
    }

    const turn = worker.turn!;
    await this.waitTurn(turn, this.clinkWaitMs);
    const ms = Date.now() - turn.startedAt;
    if (!turn.done && !turn.ended) {
      return this.result(worker, 'working', '아직 작업 중 (승인 대기일 수 있음). 같은 continuation_id 로 prompt 없이 다시 부르면 이어서 기다린다.', ms);
    }
    worker.turn = null;
    const body = [...turn.texts, ...turn.errors.map((e) => `[오류] ${e}`)].join('\n\n') || '(작업자 답 없음)';
    if (turn.ended) return this.result(worker, 'ended', `${body}\n\n[작업자 끝남] ${turn.ended}`, ms);
    return this.result(worker, turn.done!.isError || turn.errors.length ? 'failed' : 'done', body, ms, turn.done!.costUsd);
  }

  private result(w: Live, status: ClinkResult['status'], content: string, ms: number, cost: number | null = null): ClinkResult {
    return { continuation_id: w.info.id, cli_name: w.info.agent, model: w.info.model ?? null, status, content, duration_ms: ms, cost_usd: cost };
  }

  private waitTurn(turn: Turn, ms: number): Promise<void> {
    if (turn.done || turn.ended) return Promise.resolve();
    return new Promise((ok) => {
      const fire = () => {
        clearTimeout(t);
        turn.waiters.delete(fire);
        ok();
      };
      const t = setTimeout(fire, ms);
      turn.waiters.add(fire);
    });
  }

  // ── 세션 만들기 ─────────────────────────────

  private async create(o: {
    agent: AgentKind;
    role: SessionRole;
    workdir: string;
    origin: CommandOrigin;
    model?: string;
    defaultWorker?: SessionInfo['defaultWorker'];
    preset?: SessionInfo['preset'];
    workPreset?: SessionInfo['workPreset'];
    title?: string;
    parentId?: string;
    forkedFrom?: string;
    splitFrom?: string;
    splitLines?: number;
    copiedFrom?: string;
    customTitle?: string;
    extraDirs?: string[];
    autoApprove?: boolean;
    permMode?: PermMode;
    cliSessionId?: string; // 가져온 Claude Code 대화 — 첫 CLI 부터 --resume 으로 이어 간다
    via?: RemoteVia; // 원격 접속으로 만든 작업
    viaIntake?: boolean; // 처음부터 입력 거치기
    seed?: (id: string) => void; // CLI 를 띄우기 전에 기록에 먼저 넣을 것(가져온 대화)
  }): Promise<Live> {
    const info: SessionInfo = {
      id: randomUUID(),
      agent: o.agent,
      role: o.role,
      parentId: o.parentId,
      model: o.model,
      defaultWorker: o.defaultWorker,
      preset: o.preset,
      workPreset: o.workPreset,
      forkedFrom: o.forkedFrom,
      splitFrom: o.splitFrom,
      ...(o.splitFrom ? { splitLines: o.splitLines ?? 0 } : {}),
      copiedFrom: o.copiedFrom,
      customTitle: o.customTitle,
      extraDirs: o.extraDirs?.length ? o.extraDirs : undefined,
      ...(o.autoApprove && !o.permMode ? { autoApprove: true } : {}),
      ...(o.permMode ? { permMode: o.permMode } : {}),
      ...(o.cliSessionId ? { cliSessionId: o.cliSessionId, imported: true } : {}),
      // 입력 거치기: 정했으면 그대로, 아니면 새 작업 기본값(분담 · 포크 · 복사 · 옮겨 온 작업 포함). 입력 세션 자신 · 바깥 시스템이 만든 작업 · 작업자는 빼고
      ...((o.viaIntake ?? (o.role === 'main' && !o.via && !this.makingIntake && Boolean(this.intake?.newTasksOn))) ? { viaIntake: true } : {}),
      title: o.title ?? (o.role === 'main' ? '메인 에이전트' : `${o.agent} 작업`),
      workdir: o.workdir,
      requestedBy: o.origin.user,
      via: o.origin.via,
      createdAt: new Date().toISOString(),
      status: 'starting',
    };
    const live: Live = { info, adapter: this.makeAdapter(o.agent), history: [], turn: null, ...(o.cliSessionId ? { resume: o.cliSessionId } : {}) };
    this.sessions.set(info.id, live);
    this.publish({ type: 'session.created', session: info, ...(o.via ? { via: o.via } : {}) });
    o.seed?.(info.id);
    await this.launch(live);
    return live;
  }

  /** CLI 를 띄운다. 에이전트 설정을 바꾸면 같은 세션에서 다시 부른다(앞 CLI 의 이벤트는 무시) */
  private async launch(live: Live) {
    const o = live.info;
    const info = live.info;
    // 모든 세션: 설정의 "툴"에서 켠 MCP 서버. 메인: 여기에 hub(clink·프리셋 도구)를 더한다.
    // 프리셋으로 뜬 세션은 그 프리셋이 허용한 툴만(없으면 켜진 툴 전부)
    const allowedTools = o.preset ? this.presets?.find(o.preset.id)?.tools : undefined;
    const tools = (this.tools?.enabled() ?? []).filter((t) => !allowedTools || allowedTools.includes(t.id));
    const launch = this.auth?.launch(o.agent); // 연동: 로그인이면 그대로, API 키면 이 CLI 에만 환경 변수로
    const configDir = join(this.logDir, '..', 'mcp');
    const env: Record<string, string> = { ...(this.gitEnv?.() ?? {}), ...(launch?.env ?? {}) };
    let pluginDir: string | undefined;
    // 프리셋 세션은 Agent Hub 전용 프로필 — 계정 스킬·플러그인·개인 설정을 읽지 않고, 프리셋이 고른 Agent Hub 스킬만
    if (o.preset && this.profileDir) {
      const preset = this.presets?.find(o.preset.id);
      const names = this.hubSkills?.pick(preset?.skills) ?? [];
      if (o.agent === 'claude') {
        env.CLAUDE_CONFIG_DIR = this.profileDir('claude');
        pluginDir = this.hubSkills?.buildPlugin(join(configDir, `${info.id}-skills`), names) ?? undefined;
      } else if (o.agent === 'codex') {
        env.CODEX_HOME = this.profileDir('codex');
        this.hubSkills?.syncTo(join(env.CODEX_HOME, 'skills'), names);
      }
    }
    const ctx: StartContext = { tools, configDir, env, authMethod: launch?.authMethod, extraDirs: o.extraDirs, pluginDir, ...(live.resume ? { resume: live.resume } : {}), ...(live.turnEffort ? { effort: live.turnEffort } : {}) };
    live.launchedEffort = live.turnEffort ?? info.effort ?? null;
    live.resume = undefined;
    if (o.role === 'main' && this.mcpBaseUrl) {
      live.token = randomUUID().replace(/-/g, '');
      this.tokens.set(live.token, info.id);
      ctx.mcp = { name: 'hub', url: `${this.mcpBaseUrl}/${live.token}` };
    }
    const gen = (live.gen = (live.gen ?? 0) + 1);
    await live.adapter.start(info, (ev) => { if (live.gen === gen) this.fromAdapter(live, ev); }, ctx);
    if (live.gen === gen && live.info.status === 'starting') this.setStatus(live, 'idle');
  }

  /** --resume 으로 이어 갈 수 있으면 그 대화 id. Claude 이고 그 CLI 가 쓸 설정 폴더에 기록이 있어야 한다 */
  private resumable(live: Live): string | undefined {
    const id = live.info.cliSessionId;
    if (live.info.agent !== 'claude' || !id) return undefined;
    const home = live.info.preset && this.profileDir ? this.profileDir('claude') : this.claudeHome;
    return claudeTranscript(home, id) ? id : undefined;
  }

  /** 이 PC 의 Claude Code 세션 목록(이미 가져온 것은 빼고) — 화면의 "Claude Code 에서 이어 하기" */
  claudeCodeSessions() {
    const have = new Set<string>();
    for (const l of this.sessions.values()) if (l.info.cliSessionId) have.add(l.info.cliSessionId.toLowerCase());
    return this.claudeCode.list(have);
  }

  /**
   * Claude Code 세션 가져오기: 같은 폴더에서 그 대화 id 로 `claude --resume` 을 띄워 그 대화에 그대로 이어 간다.
   * 화면에는 대화 끝부분을 먼저 보여 준다. 이 PC 화면(사무실 원격 포함)에서만, 대시보드 연결에서는 안 된다.
   * 원래 창이 아직 쓰는 중이면 둘이 같은 대화에 이어 쓰게 되어 갈라질 수 있다 — 화면이 먼저 묻는다.
   */
  private async importClaude(id: string, origin: CommandOrigin) {
    const fail = (message: string) => this.publish({ type: 'error', message });
    if (origin.via !== 'local' && !origin.trusted) return fail('Claude Code 세션은 PC 앞에서만 가져올 수 있음');
    const had = [...this.sessions.values()].find((l) => l.info.cliSessionId?.toLowerCase() === id);
    if (had) return fail(`이미 가져온 세션: ${had.info.customTitle ?? had.info.title}`);
    const got = this.claudeCode.read(id);
    if (!got) return fail('Claude Code 세션을 찾지 못함');
    const inRoot = got.cwd ? this.resolveWorkdir(relative(this.workspaceRoot, got.cwd)) : null;
    const dir = inRoot && inRoot === resolve(got.cwd) ? inRoot : this.outsideDir(got.cwd, origin);
    if (typeof dir !== 'string') return fail(`이어 갈 수 없음: ${dir.error}`);
    const title = got.title.replace(/\s+/g, ' ').trim();
    await this.create({
      agent: 'claude',
      role: 'main',
      workdir: dir,
      origin,
      customTitle: title.length > 40 ? `${title.slice(0, 40)}…` : title || 'Claude Code',
      cliSessionId: id,
      seed: (sessionId) => {
        // 지시·답과 그 사이 도구 사용(파일 수정·명령 실행)·결과를 화면에 그대로
        for (const m of got.messages) {
          if (m.role === 'user') this.publish({ type: 'user.message', sessionId, text: m.text, from: 'Claude Code' });
          else if (m.role === 'assistant') this.publish({ type: 'agent.text', sessionId, text: m.text, partial: false });
          else if (m.role === 'tool') this.publish({ type: 'agent.tool', sessionId, toolId: m.id, name: m.name, input: m.input });
          else this.publish({ type: 'agent.tool_result', sessionId, toolId: m.id, ok: m.ok, summary: m.summary });
        }
        this.publish({ type: 'session.imported', sessionId, shown: got.messages.filter((m) => m.role === 'user' || m.role === 'assistant').length });
      },
    });
  }

  /**
   * 에이전트 설정 바꾸기 — 에이전트(역할·스킬·허용)·AI·모델·프리셋(지침)을 바꿔 메인 CLI 를 다시 띄운다.
   * 같은 작업(id·기록·하위 작업)은 그대로. 새 CLI 는 앞 대화를 모르므로 다음 지시에 지금까지의 대화를 붙인다.
   * 폴더는 그대로 둔다(연결 폴더는 환경에서 따로). 작업 중에는 바꾸지 않는다.
   */
  private async configure(cmd: Extract<ClientCommand, { type: 'session.configure' }>, origin: CommandOrigin) {
    const live = this.get(cmd.sessionId);
    if (!live) return;
    const fail = (message: string) => this.publish({ type: 'error', sessionId: cmd.sessionId, message });
    if (live.info.role === 'worker') return fail('하위 에이전트의 설정은 바꿀 수 없음');
    if (live.info.status === 'working' || live.info.status === 'starting') return fail('작업 중에는 바꿀 수 없음. 끝난 뒤에 바꾸세요');
    const info = live.info;
    let preset = info.preset ? this.presets?.find(info.preset.id) : undefined;
    if (cmd.preset !== undefined) {
      preset = cmd.preset ? this.presets?.find(cmd.preset) : undefined;
      if (cmd.preset && !preset) return fail(`없는 에이전트: ${cmd.preset}`);
    }
    let wp = info.workPreset ? this.workPresets?.find(info.workPreset.id) : undefined;
    if (cmd.workPreset !== undefined) {
      wp = cmd.workPreset ? this.workPresets?.find(cmd.workPreset) : undefined;
      if (cmd.workPreset && !wp) return fail(`없는 프리셋: ${cmd.workPreset}`);
    }
    // 에이전트를 고르면 그 AI 로 돈다. 에이전트를 새로 고르면서 모델을 안 정했으면 그 에이전트의 모델
    const agent = preset ? preset.agent : (cmd.agent ?? info.agent);
    const presetChanged = cmd.preset !== undefined && (cmd.preset ?? undefined) !== info.preset?.id;
    let model = cmd.model !== undefined ? (cmd.model ?? undefined) : info.model;
    if (cmd.model === undefined && (presetChanged || agent !== info.agent)) model = preset?.model;
    // 권한 묻지 않기: 정했으면 그 값, 에이전트를 새로 고르면 그 에이전트의 값, 아니면 그대로. 켜는 건 PC 앞에서만
    let autoApprove = cmd.autoApprove ?? (presetChanged ? Boolean(preset?.autoApprove) : Boolean(info.autoApprove));
    if (autoApprove && !info.autoApprove && origin.via !== 'local' && !origin.trusted) return fail('권한 묻지 않기는 PC 앞에서만 켤 수 있음');
    // 이 작업만의 권한: 조이는 것(늘 묻기·읽기만)은 어디서든, 푸는 것은 PC 앞에서만. 정하면 묻지 않기는 꺼진다
    const permMode = cmd.permMode !== undefined ? (cmd.permMode ?? undefined) : info.permMode;
    if (info.permMode && !permMode && origin.via !== 'local' && !origin.trusted) return fail('늘 묻기·읽기만·데이터만을 푸는 것은 PC 앞에서만 할 수 있음');
    // 데이터만의 허락 주소(http(s) 주소만). 늘리는 것도 푸는 것이라 PC 앞에서만
    const allowList = cmd.permAllow?.map((u) => String(u).trim()).filter((u) => /^https?:\/\/\S+$/i.test(u)).slice(0, 20);
    if (allowList?.some((u) => !(info.permAllow ?? []).includes(u)) && origin.via !== 'local' && !origin.trusted) return fail('허락 주소를 더하는 것은 PC 앞에서만 할 수 있음');
    if (permMode) autoApprove = false;

    live.gen = (live.gen ?? 0) + 1; // 앞 CLI 가 끝나며 보내는 이벤트는 버린다
    if (!live.dormant) live.adapter.stop();
    live.resume = undefined; // 설정을 바꾸면 새 대화로 시작하고 앞 대화는 글로 붙인다(새 CLI 가 새 대화 id 를 알려 준다)
    live.dormant = false;
    if (live.token) this.tokens.delete(live.token);
    live.token = undefined;
    for (const [id, a] of this.asks) if (a.sessionId === info.id) { this.asks.delete(id); a.resolve(false); }
    // 새 CLI 에게 넘길 것: 지금까지의 대화(아직 못 보낸 이어받기가 있으면 그것도), 역할·작업 환경 지침
    const said = conversation(live.history);
    if (said.length) live.carry = [live.carry, tail(said.join('\n'))].filter(Boolean).join('\n');
    // 새 CLI 는 빈 컨텍스트에서 시작한다: 넣었던 것은 앞 대화에 담겨 다시 간다
    live.ctx = [];
    this.publish({ type: 'context.usage', sessionId: info.id, used: 0, window: null });
    this.publishContext(live);
    live.role = preset;
    live.guide = wp;
    info.agent = agent;
    info.model = model;
    info.preset = preset ? { id: preset.id, name: preset.name } : undefined;
    info.workPreset = wp ? { id: wp.id, name: wp.name } : undefined;
    if (autoApprove) info.autoApprove = true;
    else delete info.autoApprove;
    if (permMode) info.permMode = permMode;
    else delete info.permMode;
    if (allowList !== undefined) { if (allowList.length) info.permAllow = allowList; else delete info.permAllow; }
    info.status = 'starting';
    this.publish({ type: 'session.configured', sessionId: info.id, session: { ...info } });
    live.adapter = this.makeAdapter(agent);
    await this.launch(live);
  }

  /** 이 작업이 쓰는 로그인: API 키 / 에이전트 로그인(전용 프로필) / 기본 로그인 */
  accountOf(live: Live): Account {
    if (this.auth?.public()[live.info.agent]?.mode === 'apikey') return 'apikey';
    return live.info.preset && this.profileDir ? 'agent' : 'default';
  }

  /** 그 로그인으로 CLI 를 띄울 때의 환경(한도 "지금 확인"용) */
  claudeEnvFor(account: Account): Record<string, string> {
    const env: Record<string, string> = { ...(this.auth?.launch('claude').env ?? {}) };
    if (account === 'agent' && this.profileDir) env.CLAUDE_CONFIG_DIR = this.profileDir('claude');
    return env;
  }

  private fromAdapter(live: Live, ev: AdapterEvent) {
    if (live.dormant) return;
    // 사용 한도는 기록하지 않고 연결별로 모은다
    if (ev.type === 'agent.limits') { this.limits?.record(live.info.agent, this.accountOf(live), ev.info); return; }
    if (ev.type === 'turn.done') this.limits?.turn(live.info.agent, this.accountOf(live), ev.costUsd);
    // 이번 차례만의 생각 깊이가 끝나면 작업 설정으로: 떠 있는 CLI 가 다른 깊이면 차례가 끝난 뒤 내려 두어 다음 지시에 작업 설정으로 다시 뜨게
    if (ev.type === 'turn.done' && live.turnEffort) { delete live.turnEffort; if ((live.launchedEffort ?? null) !== (live.info.effort ?? null)) live.relaunch = true; }
    if (ev.type === 'session.model') {
      // 실제로 도는 모델은 바뀔 때만 기록
      if (live.info.lastModel === ev.model) return;
      live.info.lastModel = ev.model;
    }
    if (ev.type === 'session.cli') {
      // 대화 id 는 바뀔 때만 기록(다시 켠 뒤 --resume 에 쓴다)
      if (live.info.cliSessionId === ev.cliSessionId) return;
      live.info.cliSessionId = ev.cliSessionId;
    }
    // 이 작업만의 권한이 먼저: 읽기만이면 묻는 도구는 바로 거절, 늘 묻기면 사람에게. 그다음 권한 묻지 않기(이 작업 또는 모든 작업)
    const mode = live.info.permMode;
    const ask = ev.type === 'permission.request';
    const auto = ask && !mode && Boolean(live.info.autoApprove || this.autoApproveAll);
    // 데이터만: 읽기 명령과 허락한 주소로 보내는 요청만 묻지 않고 허용, 나머지는 묻지 않고 거절(채팅 작업은 사람이 승인 버튼을 못 본다)
    const data = ask && mode === 'data' ? dataAllows(ev.toolName, ev.command, live.info.permAllow ?? []) : null;
    const deny = ask && (mode === 'readonly' || (data !== null && !data.ok));
    const dataOk = Boolean(data?.ok);
    // 아는 오류는 사람이 할 일로 바꿔 보여 주고(원문은 뒤에), 로그인·결제 문제면 그 AI 의 연결 상태에 남긴다
    let shown: AdapterEvent = ev;
    if (ev.type === 'error') {
      const f = friendlyError(ev.message);
      if (f) {
        shown = { ...ev, message: `${f.text}\n(원문: ${ev.message.slice(0, 300)})` };
        if (f.auth) this.setHealth(live.info.agent, 'error', f.text);
      }
      if (live.schedRun) live.schedRun.error = f?.text ?? ev.message.slice(0, 120);
    }
    if (ev.type === 'turn.done' && !ev.isError) this.setHealth(live.info.agent, 'ok', '');
    const full = { ...shown, sessionId: live.info.id, ...(auto || deny || dataOk ? { auto: true } : {}) } as HostEvent;
    this.publish(full);
    // 자동으로 정한 것은 요청과 답을 기록에만 남긴다
    if (ev.type === 'permission.request' && (auto || deny || dataOk)) {
      const allow = auto || dataOk;
      this.publish({ type: 'permission.resolved', sessionId: live.info.id, requestId: ev.requestId, allow, by: auto ? '자동 허용' : mode === 'data' ? (allow ? '데이터만 · 허용' : `데이터만 · 거절(${data?.why ?? ''})`) : '읽기만' });
      live.adapter.respondPermission(ev.requestId, allow);
    }
    const turn = live.turn;
    if (turn) {
      if (ev.type === 'agent.text' && !ev.partial) turn.texts.push(ev.text);
      if (ev.type === 'error') turn.errors.push(ev.message);
      if (ev.type === 'turn.done') turn.done = { isError: ev.isError, costUsd: ev.costUsd };
      if (ev.type === 'session.ended') turn.ended = ev.reason;
      if (turn.done || turn.ended) for (const w of [...turn.waiters]) w();
    }
    if (live.compacting && ev.type === 'agent.text' && !ev.partial) live.compacting.text = ev.text;
    if (live.compacting && ev.type === 'session.compacted') { live.compacting.done = true; live.memSeen = undefined; }
    if (ev.type === 'turn.done') {
      // 차례가 끝났는데 답하지 않은 승인 요청이 남아 있으면 더는 답할 곳이 없다 — "승인 대기"로 남지 않게 닫는다
      this.closePerms(live, '차례 끝남');
      if (live.compacting) return this.finishCompact(live, ev.isError);
      this.setStatus(live, 'idle');
      this.share(live);
      if (live.compactPending) { const by = live.compactPending; setTimeout(() => void this.compact(live, by), 0); } // 하던 일이 끝났으니 부탁받은 정리
      const run = live.schedRun;
      if (run && run.skip > 0) run.skip--; // 예약 지시 앞에 하던 차례
      else if (run) this.finishScheduled(live, ev.isError || run.error ? `실패: ${run.error ?? '오류로 끝남'}` : `끝남 · ${Math.round((Date.now() - run.started) / 1000)}초`);
    }
    if (ev.type === 'session.ended') {
      // CLI 가 꺼짐: 작업은 대기로 남기고 다음 지시 때 다시 띄운다(wake)
      live.dormant = true;
      if (live.token) this.tokens.delete(live.token);
      live.token = undefined;
      this.closePerms(live, 'CLI 꺼짐'); // 꺼진 CLI 에서 묻던 것은 거부로 정리
      if (live.compacting) return this.finishCompact(live, true); // 정리 중에 꺼짐: 실패로 끝내고 기다리던 지시는 넘긴다(다음 지시에 다시 띄운다)
      if (live.schedRun && ev.reason !== '사용자가 종료함') this.finishScheduled(live, `실패: ${live.schedRun.error ?? ev.reason}`);
      if (live.info.status !== 'idle') {
        live.info.status = 'idle';
        this.publish({ type: 'session.status', sessionId: live.info.id, status: 'idle' });
      }
    }
  }

  /**
   * 포크 공유: 포크의 답이 끝날 때마다 지난번 공유 뒤로 생긴 대화를 원본 기록에 남긴다.
   * 원본이 진행 중이면 다음 지시 앞에 붙어 간다(원본 에이전트를 바로 돌리지는 않음).
   * 원본이 끝났으면 기록에만 남아 원본을 다시 포크할 때 함께 이어받는다.
   * 포크의 포크는 바로 위 원본에 공유되고, 그 원본의 다음 답이 끝날 때 다시 위로 올라간다.
   */
  /** 답이 끝날 때마다: 포크 → 원본, 분담 묶음 안에서는 끝난 쪽부터 모든 분담으로 */
  private share(live: Live) {
    if (live.info.role === 'worker') return;
    // 분담 공유는 위로만: 분담이 한 일은 자기 원본에게, 원본도 분담이면 그 원본에게 이어 넘긴다(맨 위 작업이 전체를 본다).
    // 아래·옆(원본 → 분담, 분담 ↔ 분담)으로는 보내지 않는다 — 받는 작업 지시 앞에 남의 일이 줄줄이 붙지 않게. 아래로 알릴 것은 session_send 로
    let from = live;
    let what: 'own' | 'relay' = 'own';
    const seen = new Set([live.info.id]);
    for (let to = this.splitOrigin(from); to && !seen.has(to.info.id); to = this.splitOrigin(from)) {
      seen.add(to.info.id);
      this.shareTo(from, to, 'split', what);
      from = to;
      what = 'relay';
    }
    // 맨 위가 다른 PC 작업 아래에 있으면 그 PC 로 이어서 위로
    if (from.info.remoteParent) void this.remoteShareTo(from, from.info.remoteParent, what).catch((err) => this.publish({ type: 'notice', sessionId: from.info.id, message: `다른 PC 로 공유 못 함: ${(err as Error).message}` }));
  }

  /** 다른 PC 의 위 작업에 지난번 뒤로 한 일을 보낸다(같은 PC 의 공유와 같은 요약) */
  private async remoteShareTo(from: Live, rp: { url: string; id: string; pc: string }, what: 'own' | 'relay') {
    const prev = [...from.history].reverse().find((e) => e.type === 'session.remoteShared' && Boolean(e.relay) === (what === 'relay')) as { until: number } | undefined;
    const moved = [...from.history].reverse().find((e) => e.type === 'session.remoteParent' && e.parent);
    const since = prev?.until ?? (moved ? this.order.get(moved) ?? 0 : 0);
    const events = from.history.filter((e) => (this.order.get(e) ?? 0) > since && (what === 'own' ? e.type !== 'session.merged' : e.type === 'session.merged'));
    const fresh = digest(events);
    if (!fresh.length || !this.peers) return;
    const until = Math.max(...events.map((e) => this.order.get(e) ?? 0));
    // 그림은 파일째(그 PC 는 이 PC 의 /images 를 못 연다). 4장 · 장마다 4MB 까지
    const images = this.shotsIn(from, since, what === 'relay').slice(-4).flatMap((g) => {
      const m = g.url.match(/^\/images\/([^/]+)\/([^/]+)$/);
      const f = m && this.imagePath(m[1], m[2]);
      if (!f || statSync(f.path).size > 4_000_000) return [];
      return [{ name: g.name, ext: extname(f.path), data: readFileSync(f.path).toString('base64'), ...(g.caption ? { caption: g.caption } : {}), ...(g.from ? { from: g.from } : {}) }];
    });
    await this.peers.shareUp(rp, { fromPc: this.peers.summary().name, fromId: from.info.id, title: this.nameOf(from), text: tail(fresh.join('\n')), ...(images.length ? { images } : {}) });
    this.publish({ type: 'session.remoteShared', sessionId: from.info.id, until, ...(what === 'relay' ? { relay: true } : {}) });
  }

  /** 다른 PC 가 합치며 따로 보낸 그림 한 장(POST /peer/image). 같은 내용이 이미 있으면 건너뜀 */
  receiveRemoteImage(targetId: string, fromPc: string, title: string, g: unknown) {
    const target = this.sessions.get(targetId);
    if (!target || target.info.role !== 'main') throw new Error('없는 작업');
    this.saveRemoteImage(target, fromPc, title, g, this.shotHashes(target));
  }
  private saveRemoteImage(target: Live, fromPc: string, title: string, g: any, had: Set<string>) {
    const ext = String(g?.ext ?? '').toLowerCase().replace('.jpeg', '.jpg');
    if (!IMAGE_TYPES[ext] || typeof g?.data !== 'string') return;
    const data = Buffer.from(g.data, 'base64');
    if (!data.length || data.length > 4_000_000) return;
    const h = createHash('sha1').update(data).digest('hex');
    if (had.has(h)) return;
    had.add(h);
    const dir = join(this.logDir, '..', 'images', target.info.id);
    mkdirSync(dir, { recursive: true });
    const file = `${randomUUID()}${ext}`;
    writeFileSync(join(dir, file), data);
    const caption = typeof g.caption === 'string' && g.caption.trim() ? g.caption.trim().slice(0, 300) : undefined;
    this.publish({ type: 'agent.image', sessionId: target.info.id, url: `/images/${target.info.id}/${file}`, name: String(g.name ?? '그림').slice(0, 120), ...(caption ? { caption } : {}), from: `${fromPc.slice(0, 60)}/${String(g.from ?? title).slice(0, 80)}` });
  }

  // ── 작업 옮기기: 대화 · 역할 · 예약 · 작업 폴더를 다른 PC 로. 받는 PC 에서 새 작업으로 만들고 설치 명령을 다시 돌린다 ──
  private get moveDir() { const d = join(this.logDir, '..', 'moves'); mkdirSync(d, { recursive: true }); return d; }

  /** 옮기기 전에 보여 줄 것(파일 수 · 크기 · 빼는 것 · 비밀 파일 · 옮길 수 없는 것 · 예약) */
  movePlan(sessionId: string): MovePlan & { schedules: number; busy: boolean } {
    const live = this.sessions.get(sessionId);
    if (!live || live.info.role !== 'main') throw new Error('없는 작업');
    const folder = live.info.workdir;
    const others = [...this.sessions.values()].filter((l) => l !== live && l.info.role === 'main' && !l.info.archived);
    const shared = others.find((l) => l.info.workdir === folder || l.info.workdir.startsWith(folder + sep));
    const own = folder !== resolve(this.workspaceRoot) && !shared;
    const scan = own ? scanFolder(folder) : { files: 0, bytes: 0, skipped: [], secrets: [], git: false };
    const text = conversation(live.history).join('\n') + (live.info.about ?? '');
    return {
      folder, own, ...(own ? {} : { why: folder === resolve(this.workspaceRoot) ? '작업 폴더가 모든 작업이 함께 쓰는 맨 위 폴더라, 폴더는 두고 대화 · 첨부만 옮김' : `작업 폴더를 "${this.nameOf(shared!)}" 작업도 써서, 폴더는 두고 대화 · 첨부만 옮김` }),
      ...scan, setup: own ? setupCommands(folder) : [], cannot: cannotMove(folder, text),
      schedules: this.schedules?.forSession(live.info.id).length ?? 0,
      busy: live.info.status === 'working' || live.info.status === 'starting',
    };
  }

  private async moveToPeer(live: Live, rawUrl: string, folderName: string | undefined, secrets: string[]) {
    const peers = this.peers;
    if (!peers) throw new Error('연결 기능이 꺼져 있음');
    if (live.info.status === 'working' || live.info.status === 'starting') throw new Error('일하는 중 — 끝난 뒤에 옮긴다');
    const view = (await peers.all()).find((v) => v.url === rawUrl);
    if (!view?.ok) throw new Error(view ? `그 PC 와 연결이 끊김(${view.error ?? ''})` : '연결된 PC 가 아님');
    const plan = this.movePlan(live.info.id);
    const say = (message: string) => this.publish({ type: 'notice', sessionId: live.info.id, message });
    // 1) 묶기: 이 작업만 쓰는 폴더면 폴더 전체(뺄 것 · 고르지 않은 비밀 파일 빼고), 아니면 이 작업 첨부만
    const id = `${live.info.id.slice(0, 8)}-${createHash('sha1').update(rawUrl).digest('hex').slice(0, 8)}`;
    const tgz = join(this.moveDir, `out-${id}.tgz`);
    say('옮기는 중 · 파일 묶는 중');
    if (plan.own) packFolder(plan.folder, tgz, plan.secrets.filter((f) => !secrets.includes(f)));
    else {
      const atts = [...new Set(live.history.flatMap((e) => (e.type === 'user.message' ? (e.attachments ?? []).map((a) => a.path) : [])))].filter((p) => this.attachmentPath(live, p));
      if (atts.length) execFileSync('tar', ['-czf', tgz, '-C', plan.folder, ...atts], { stdio: ['ignore', 'ignore', 'pipe'] });
      else rmSync(tgz, { force: true });
    }
    const size = existsSync(tgz) ? statSync(tgz).size : 0;
    const sha1 = size ? createHash('sha1').update(readFileSync(tgz)).digest('hex') : '';
    // 2) 보내기: 4MB 조각, 받는 PC 가 이미 받은 만큼은 건너뛴다(끊겼다 다시 하면 이어서, 내용이 바뀌었으면 처음부터)
    if (size) {
      const start = (await peers.post(view.url, '/peer/move/start', { id, size, sha1 })) as { have: number };
      let have = start.have ?? 0;
      const fd = openSync(tgz, 'r');
      try {
        const CHUNK = 4 * 1024 * 1024;
        while (have < size) {
          const n = Math.min(CHUNK, size - have);
          const buf = Buffer.alloc(n);
          readSync(fd, buf, 0, n, have);
          const r = await peers.postRaw(view.url, `/peer/move/chunk?id=${encodeURIComponent(id)}&offset=${have}`, buf);
          have = r.have;
          say(`옮기는 중 · 보내는 중 ${Math.round(have / 1048576)}/${Math.max(1, Math.round(size / 1048576))}MB`);
        }
      } finally { closeSync(fd); }
    }
    // 3) 받는 PC 에서 새 작업으로: 대화 요약 · 역할 · 설정 · 예약 · 설치 명령 · 할 일
    say('옮기는 중 · 받는 PC 에서 푸는 중');
    const all = digest(live.history).join('\n');
    const meta = {
      title: this.nameOf(live), about: live.info.about ?? '', agent: live.info.agent, model: live.info.model, effort: live.info.effort,
      conversation: all.length > 60000 ? '…' + all.slice(-60000) : all,
      schedules: (this.schedules?.forSession(live.info.id) ?? []).map(({ prompt, repeat, time, date, weekday, every, enabled }) => ({ prompt, repeat, time, date, weekday, every, enabled })),
      folder: (folderName || basename(plan.folder) || 'moved').replace(/[\\/:*?"<>|]/g, '-').slice(0, 80),
      own: plan.own, git: plan.git, setup: plan.setup, cannot: plan.cannot, fromPc: peers.summary().name, fromId: live.info.id, secrets: secrets.length,
    };
    const done = (await peers.post(view.url, '/peer/move/finish', { id, sha1: size ? sha1 : '', meta })) as { sessionId: string; workdir: string };
    rmSync(tgz, { force: true });
    // 4) 이 PC: 예약은 끄고(두 번 돌지 않게) 작업은 "옮김"으로 보관 — 지우지 않아 되돌릴 수 있다
    for (const s of this.schedules?.forSession(live.info.id) ?? []) if (s.enabled) { try { this.schedules!.save({ ...s, enabled: false }); } catch {} }
    this.schedulesChanged();
    live.info.movedTo = { url: view.url, id: done.sessionId, pc: view.name ?? '' };
    this.publish({ type: 'session.configured', sessionId: live.info.id, session: { ...live.info } });
    live.info.archived = true;
    this.publish({ type: 'session.archived', sessionId: live.info.id, archived: true });
    this.notice(`${this.nameOf(live)} 를 ${view.name}(${done.workdir}) 로 옮김 — 이 PC 에서는 보관하고 예약은 껐음. 되돌리려면 그 PC 작업에서 다시 이 PC 로 옮긴다`);
  }

  /** 받는 PC: 옮겨 오는 묶음 받기 시작(이미 받은 만큼을 알려 이어 받는다) */
  moveStart(b: { id?: unknown; size?: unknown; sha1?: unknown }): { have: number } {
    const id = String(b.id ?? '');
    if (!/^[\w-]{4,40}$/.test(id)) throw new Error('잘못된 옮기기 id');
    const file = join(this.moveDir, `in-${id}.tgz`), metaFile = `${file}.json`;
    let prev: any = null;
    try { prev = JSON.parse(readFileSync(metaFile, 'utf8')); } catch {}
    if (!prev || prev.sha1 !== b.sha1 || prev.size !== b.size) { rmSync(file, { force: true }); writeFileSync(metaFile, JSON.stringify({ sha1: b.sha1, size: b.size })); }
    return { have: existsSync(file) ? statSync(file).size : 0 };
  }

  moveChunk(id: string, offset: number, buf: Buffer): { have: number } {
    if (!/^[\w-]{4,40}$/.test(id)) throw new Error('잘못된 옮기기 id');
    const file = join(this.moveDir, `in-${id}.tgz`);
    const have = existsSync(file) ? statSync(file).size : 0;
    if (offset === have) appendFileSync(file, buf);
    return { have: existsSync(file) ? statSync(file).size : 0 };
  }

  /** 받는 PC: 다 받았으면 풀고 새 작업을 만든다 */
  async moveFinish(b: { id?: unknown; sha1?: unknown; meta?: any }): Promise<{ sessionId: string; workdir: string }> {
    const id = String(b.id ?? '');
    const m = b.meta ?? {};
    const file = join(this.moveDir, `in-${id}.tgz`);
    if (b.sha1) {
      if (!existsSync(file) || createHash('sha1').update(readFileSync(file)).digest('hex') !== b.sha1) throw new Error('받은 파일이 다 오지 않았거나 깨짐 — 다시 옮기면 이어서 받는다');
    }
    // 받을 폴더: 이 PC 작업 뿌리 아래 새 폴더(있으면 -2, -3 …)
    const base = String(m.folder ?? 'moved').replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+/, '').slice(0, 80) || 'moved';
    let dest = join(this.workspaceRoot, base);
    for (let i = 2; existsSync(dest) && readdirSync(dest).length; i++) dest = join(this.workspaceRoot, `${base}-${i}`);
    mkdirSync(dest, { recursive: true });
    if (b.sha1) unpackTo(file, dest);
    rmSync(file, { force: true });
    rmSync(`${file}.json`, { force: true });
    const agent = AGENTS.includes(m.agent) ? m.agent : 'claude';
    const live = await this.create({ agent, role: 'main', workdir: dest, origin: { via: 'local', user: `Agent Hub ${String(m.fromPc ?? '').slice(0, 40)}` }, ...(typeof m.model === 'string' && m.model ? { model: m.model } : {}), title: String(m.title ?? '옮겨 온 작업').slice(0, 120), customTitle: String(m.title ?? '옮겨 온 작업').slice(0, 120) });
    if (typeof m.about === 'string' && m.about) this.setAbout(live, m.about);
    if (EFFORTS.includes(m.effort)) { live.info.effort = m.effort; this.publish({ type: 'session.configured', sessionId: live.info.id, session: { ...live.info } }); }
    const t = `${String(m.fromPc ?? '').slice(0, 60)}/${String(m.title ?? '').slice(0, 80)}`;
    const body = String(m.conversation ?? '').slice(0, 60000);
    this.publish({ type: 'session.merged', sessionId: live.info.id, fromId: `peer:${String(m.fromPc ?? '').slice(0, 60)}:${String(m.fromId ?? '').slice(0, 60)}`, title: t, text: body, lines: 0, kind: 'split' });
    (live.merges ??= []).push({ label: `옮겨 온 작업 · ${t}`, text: `[옮겨 온 작업: ${t} — 다른 PC 에서 이 PC 로 옮긴 작업의 지금까지 한 일(사람 지시와 마지막 보고). 작업 폴더는 ${dest} 로 옮겨 왔다(그 PC 의 절대 경로가 글에 있으면 이 폴더로 바꿔 읽는다). 이어서 맡는다]\n${body}` });
    this.publishContext(live);
    for (const s of Array.isArray(m.schedules) ? m.schedules.slice(0, 30) : []) { try { this.schedules?.save({ ...s, sessionId: live.info.id }); } catch {} }
    this.schedulesChanged();
    const todo = (Array.isArray(m.cannot) ? m.cannot : []).map(String).slice(0, 10);
    this.publish({ type: 'notice', sessionId: live.info.id, message: `${t} 에서 옮겨 옴 — 폴더 ${dest}${m.own ? '' : '(그 PC 에서 여러 작업이 함께 쓰던 폴더라 첨부만)'}${todo.length ? `. 이 PC 에서 할 일: ${todo.join(' / ')}` : ''}` });
    // 설치 명령: 뒤에서 차례로 돌리고 결과만 알린다(받는 PC 운영체제에 맞는 셸)
    const cmds = (Array.isArray(m.setup) ? m.setup : []).map(String).filter((c: string) => /^(npm|pnpm|yarn|uv|python3? -m venv)\b/.test(c)).slice(0, 3);
    if (cmds.length && m.own) void this.runSetup(live, dest, cmds);
    return { sessionId: live.info.id, workdir: dest };
  }

  private async runSetup(live: Live, dir: string, cmds: string[]) {
    for (const c of cmds) {
      const cmd = process.platform === 'win32' ? c.replace(/\.venv\/bin\/pip/g, '.venv\\Scripts\\pip').replace(/^python3 /, 'python ') : c;
      this.publish({ type: 'notice', sessionId: live.info.id, message: `세팅 · ${cmd} 돌리는 중` });
      const ok = await new Promise<boolean>((res) => {
        const p = spawn(cmd, { cwd: dir, shell: true, stdio: 'ignore' });
        const t = setTimeout(() => { p.kill(); res(false); }, 15 * 60_000);
        p.on('exit', (code) => { clearTimeout(t); res(code === 0); });
        p.on('error', () => { clearTimeout(t); res(false); });
      });
      this.publish({ type: 'notice', sessionId: live.info.id, message: `세팅 · ${cmd} ${ok ? '끝남' : '실패 — 이 작업에서 직접 다시 돌려 본다'}` });
      if (!ok) break;
    }
  }

  /** 이 PC 작업을 다른 PC 작업에 합친다(session.mergeIntoPeer) */
  private async mergeIntoPeer(live: Live, rawUrl: string, targetId: string, user: string) {
    const peers = this.peers;
    if (!peers) throw new Error('연결 기능이 꺼져 있음');
    const view = (await peers.all()).find((v) => v.url === rawUrl);
    if (!view?.ok) throw new Error(view ? `그 PC 와 연결이 끊김(${view.error ?? ''})` : '연결된 PC 가 아님');
    const target = view.summary?.tasks.find((t) => t.id === targetId);
    if (!target) throw new Error('그 PC 에 그 작업이 없음');
    const events = live.history;
    // 받는 PC 는 2만 자까지 받는다 — 그림 주소 자리를 남기고 최근 것부터 18000자
    const all = digest(events).join('\n');
    const text = all.length > 18000 ? '…' + all.slice(-18000) : all;
    // 그림: 채팅에 띄운 그림과 사람이 올린 첨부 그림(최근 6장, 장마다 4MB 까지)
    const files: string[] = [];
    for (const e of events) {
      if (e.type === 'agent.image') { const m = e.url.match(/^\/images\/([^/]+)\/([^/]+)$/); const f = m && this.imagePath(m[1], m[2]); if (f) files.push(f.path); }
      if (e.type === 'user.message') for (const a of e.attachments ?? []) { const f = this.attachmentImage(live.info.id, a.path); if (f) files.push(f.path); }
    }
    const me = peers.summary().name;
    const title = this.nameOf(live);
    const say = (message: string) => this.publish({ type: 'notice', sessionId: live.info.id, message });
    // 그림은 한 장씩 따로 보낸다(한 번에 보내면 받는 쪽 요청 크기 제한에 걸림). 받는 쪽은 같은 그림을 건너뛰어 다시 해도 겹치지 않는다.
    // 한 일(글)은 맨 마지막에 보낸다 — 이게 가야 합친 것. 중간에 끊기면 이 작업은 그대로라 다시 하면 된다
    const list = [...new Set(files)].slice(-20);
    const left: string[] = []; // 못 보낸 그림(옛 버전 PC · 4MB 넘음) — 이 PC 주소로 적어 보낸다
    let old = false;
    for (const [i, p] of list.entries()) {
      if (old || statSync(p).size > 4_000_000) { left.push(p); continue; }
      say(`합치는 중 · 그림 ${i + 1}/${list.length} 보내는 중`);
      try {
        await peers.post(view.url, '/peer/image', { to: targetId, fromPc: me, title, name: basename(p), ext: extname(p), data: readFileSync(p).toString('base64') });
      } catch (err) {
        if (!/옛 버전/.test((err as Error).message)) throw new Error(`그림 ${i + 1}/${list.length} 에서 끊김 — 이 작업은 그대로 두었음, 다시 하면 이어서(${(err as Error).message})`);
        old = true;
        left.push(p);
      }
    }
    const myUrl = peers.myUrl();
    const link = (p: string) => {
      const img = p.match(/images\/([^/]+)\/([^/]+)$/);
      if (img) return `${myUrl}/images/${img[1]}/${img[2]}`;
      const rel = relative(live.info.workdir, p);
      return `${myUrl}/attachment?sessionId=${encodeURIComponent(live.info.id)}&path=${encodeURIComponent(rel)}`;
    };
    const more = left.length && myUrl ? `\n\n[그림 ${left.length}장 — ${old ? '받는 PC 가 옛 버전이라 ' : '4MB 넘어 '}함께 못 보냄. ${me} PC 에서 열기]\n${left.map((p) => `- ${link(p)}`).join('\n')}` : '';
    say('합치는 중 · 한 일 보내는 중');
    await peers.post(view.url, '/peer/share', { to: targetId, fromPc: me, fromId: live.info.id, title, text: text + more, merge: true });
    // 아래 작업은 그 PC 작업 아래로(그 PC 목록에서 그 작업 아래에 보이고, 한 일이 그쪽으로 공유된다)
    const parent = { url: view.url, id: targetId, pc: view.name ?? view.summary?.name ?? '' };
    for (const k of [...this.sessions.values()]) if (k.info.role === 'main' && (k.info.splitFrom ?? k.info.forkedFrom) === live.info.id) this.setRemoteParent(k.info.id, parent);
    if (live.info.status === 'working' || live.info.status === 'starting') this.halt(live, user);
    live.info.archived = true;
    this.publish({ type: 'session.archived', sessionId: live.info.id, archived: true });
    this.notice(`${this.nameOf(live)} 를 ${parent.pc}/${target.name} 에 합침(이 작업은 보관함 — 왼쪽 보관에서 꺼낼 수 있어요)`);
  }

  /** 다른 PC 에서 온 하위 작업 공유를 받는다. merge = 그 PC 가 작업을 이 작업에 합친 것 */
  receiveRemoteShare(targetId: string, fromPc: string, fromId: string, title: string, text: string, images: unknown = [], merge = false) {
    const target = this.sessions.get(targetId);
    if (!target || target.info.role !== 'main') throw new Error('없는 작업');
    const t = `${fromPc.slice(0, 60)}/${title.slice(0, 80)}`;
    const body = text.slice(0, 20000);
    // 함께 온 그림: 이 PC 에 두고 위 작업 채팅에 띄운다(같은 내용이 이미 있으면 빼고). 공유 글보다 먼저 — 화면이 공유 카드 안에 작은 그림으로 넣는다
    const had = this.shotHashes(target);
    for (const g of (Array.isArray(images) ? images : []).slice(0, 4)) this.saveRemoteImage(target, fromPc, title, g, had);
    this.publish({ type: 'session.merged', sessionId: target.info.id, fromId: `peer:${fromPc.slice(0, 60)}:${fromId.slice(0, 60)}`, title: t, text: body, lines: 0, kind: 'split' });
    const head = merge ? `[합친 작업: ${t} — 다른 PC 에서 이 작업에 합친 작업이 지금까지 한 일(사람 지시와 마지막 보고). 이어서 맡는다]` : `[하위 작업 공유: ${t} — 다른 PC 의 아래 작업이 그사이 한 일(사람 지시와 마지막 보고). 겹치지 않게 반영한다]`;
    (target.merges ??= []).push({ label: `${merge ? '합친 작업' : '하위 작업 공유'} · ${t}`, text: `${head}\n${body}` });
    this.publishContext(target);
    if (merge) this.publish({ type: 'notice', sessionId: target.info.id, message: `${t} 를 합침(그 PC 에서는 보관함)${target.info.status === 'working' || target.info.status === 'starting' ? ' — 지금 하던 일이 끝난 뒤 다음 지시에 함께 받음' : ' — 다음 지시에 함께 받음'}` });
  }

  /** 다른 PC 작업 아래로 두기(그 PC 가 POST /peer/parent 로) */
  setRemoteParent(taskId: string, parent: { url: string; id: string; pc: string } | null) {
    const live = this.sessions.get(taskId);
    if (!live || live.info.role !== 'main') throw new Error('없는 작업');
    if (parent) {
      live.info.remoteParent = parent;
      // 이 PC 안의 부모에서는 떼어 낸다(맨 위로) — 위는 하나만
      if (live.info.splitFrom || live.info.forkedFrom) this.reparent(live, null);
    } else delete live.info.remoteParent;
    this.publish({ type: 'session.remoteParent', sessionId: live.info.id, parent });
  }

  /** 분담해 온 원본(없으면 undefined) */
  private splitOrigin(live: Live): Live | undefined {
    const p = live.info.splitFrom ?? live.info.forkedFrom; // 포크·분담 모두 "하위 작업" — 같은 규칙으로 위로만
    return p ? this.sessions.get(p) : undefined;
  }


  /**
   * from 이 지난번에 target 에게 보낸 뒤로 한 일을 target 기록에 남기고, 진행 중이면 다음 지시에 붙인다.
   * 보내는 것은 차례마다 사람 지시와 그 차례의 마지막 보고뿐(중간 진행 말은 빼서 받는 쪽 컨텍스트를 아낀다).
   * target 에게서 받은 공유는 빼고 센다(양쪽 공유가 서로 메아리치지 않게).
   */
  private shareTo(from: Live, target: Live, kind: 'fork' | 'split', what: 'own' | 'relay' | 'all' = 'all', whole = false) {
    // 어디부터: 자기 일과 넘겨받은 공유를 따로 센다. 예전 기록(relay 표시 없음)은 자기 일로 본다
    const mine = target.history.filter((e) => e.type === 'session.merged' && e.fromId === from.info.id);
    const prevOwn = mine.filter((e) => !(e.type === 'session.merged' && e.relay)).at(-1);
    const prevRelay = mine.filter((e) => e.type === 'session.merged' && e.relay).at(-1);
    const created = target.history.find((e) => e.type === 'session.created');
    // 처음이면 원본 → 분담은 분담한 때부터(그 앞은 이미 이어받음)
    // 계층을 옮겨 새 부모가 됐으면 옮긴 뒤부터(옛 대화가 한꺼번에 가지 않게). 합치기(whole)는 처음부터
    const moved = [...from.history].reverse().find((e) => e.type === 'session.reparented' && e.parentId === target.info.id);
    const start = whole ? 0 : target.info.splitFrom === from.info.id && created ? (this.order.get(created) ?? 0) : moved ? (this.order.get(moved) ?? 0) : 0;
    const cursor = (e: HostEvent | undefined) => (e && e.type === 'session.merged' ? (e.until ?? this.order.get(e) ?? 0) : undefined);
    const since = whole ? 0 : what === 'relay' ? (cursor(prevRelay) ?? cursor(prevOwn) ?? start) : (cursor(prevOwn) ?? start);
    const events = from.history.filter((e) => (this.order.get(e) ?? 0) > since
      && !(e.type === 'session.merged' && e.fromId === target.info.id)
      && (what === 'all' || (what === 'relay') === (e.type === 'session.merged')));
    const fresh = digest(events);
    if (!fresh.length) return;
    const until = Math.max(...events.map((e) => this.order.get(e) ?? 0));
    const shots = this.shotsIn(from, since, what === 'all' ? undefined : what === 'relay', target.info.id);
    const firstUser = from.history.find((e) => e.type === 'user.message');
    const title = from.info.customTitle ?? (firstUser && firstUser.type === 'user.message' ? firstUser.text.slice(0, 40) : '하위 작업');
    const text = tail(fresh.join('\n'));
    // 그사이 하위 작업이 띄운 그림도 위 작업 채팅에(같은 그림 파일을 가리킨다). 공유 글보다 먼저 — 위로 이어 넘길 때 다음 공유의 시작점(공유 글) 앞에 있어 다시 가지 않게
    const had = this.shotHashes(target);
    for (const g of shots) {
      const h = this.shotHash(g.url);
      if (had.has(h)) continue; // 같은 그림(같은 내용)이 이미 그 작업 채팅에 있으면 다시 띄우지 않는다
      had.add(h);
      this.publish({ type: 'agent.image', sessionId: target.info.id, url: g.url, name: g.name, ...(g.caption ? { caption: g.caption } : {}), from: g.from ?? title });
    }
    this.publish({ type: 'session.merged', sessionId: target.info.id, fromId: from.info.id, title, text, lines: 0, until, ...(kind === 'split' ? { kind } : {}), ...(what === 'relay' ? { relay: true } : {}) });
    const head = `[하위 작업 공유: ${title} — 아래 작업이 그사이 한 일(사람 지시와 마지막 보고). 겹치지 않게 반영한다]`;
    (target.merges ??= []).push({ label: `하위 작업 공유 · ${title}`, text: `${head}\n${text}` });
    this.publishContext(target);
  }

  /** 다음 지시에 붙어 갈 것 */
  private pendingContext(live: Live): ContextItem[] {
    const out: ContextItem[] = [];
    if (live.carry) out.push({ label: '앞 대화', chars: live.carry.length, pending: true });
    for (const m of live.merges ?? []) out.push({ label: m.label, chars: m.text.length, pending: true });
    return out;
  }

  /** 컨텍스트에 넣은 것·넣을 것 목록을 화면에 알린다 */
  private publishContext(live: Live) {
    const items = [...(live.ctx ?? []).map((c) => ({ ...c, pending: false })), ...this.pendingContext(live)];
    this.publish({ type: 'context.items', sessionId: live.info.id, items });
  }

  /**
   * 컨텍스트 정리. 하던 차례가 있으면 끝난 뒤에. 정리 전 기록은 그대로 남는다(화면 · 기록 파일).
   *  - Claude: CLI 의 /compact 에 남길 것(역할 · 하던 일 · 남은 할 일 · 사람이 정한 것 · 기억 · 공통 지침)을 붙여 보낸다 → compact_boundary 의 앞뒤 토큰
   *  - 그 밖(Codex · Gemini 등 ACP): 에이전트에게 정리본을 쓰게 한 뒤 CLI 를 내리고, 다음 지시에 정리본 + 그 뒤 대화만 붙여 새로 띄운다
   * 정리 뒤 첫 지시에는 기억 · 공통 지침을 처음처럼 다시 붙인다.
   */
  async compact(live: Live, by: string): Promise<void> {
    if (live.compacting) return;
    const st = live.info.status;
    if (st === 'working' || st === 'starting' || this.waitingPerm(live)) {
      live.compactPending = by;
      this.publish({ type: 'session.compacting', sessionId: live.info.id, queued: true });
      return;
    }
    live.compactPending = undefined;
    if (live.dormant && !(await this.wake(live))) return;
    const cli = live.info.agent === 'claude';
    const said = conversation(live.history).join('\n');
    live.compacting = { mode: cli ? 'cli' : 'summary', before: cli ? 0 : said.length };
    this.publish({ type: 'session.compacting', sessionId: live.info.id });
    this.setStatus(live, 'working');
    const keep = '이 작업의 역할, 진행 중이던 일과 남은 할 일, 사람이 정한 것과 고쳐 준 것, [기억]과 [공통 지침]의 규칙, 다루던 파일 · 주소 · 이름';
    // Claude 의 /compact 는 그대로(앞에 다른 글이 붙으면 명령이 아니다). 정리본 방식은 보통 지시처럼(새로 띄운 CLI 면 앞 대화가 붙는다)
    live.adapter.send(cli
      ? `/compact 정리본에 꼭 남길 것: ${keep}. 끝난 잡담과 도구 출력 원문은 줄인다.`
      : this.compose(live, `[컨텍스트 정리] 지금까지의 대화를 새 대화에서 이어서 일할 수 있게 정리본으로 써 줘. 꼭 남길 것: ${keep}. 끝난 잡담과 도구 출력 원문은 빼고, 정리본만 답한다(다른 일은 하지 않는다).`));
  }

  private finishCompact(live: Live, isError: boolean) {
    const c = live.compacting!;
    live.compacting = undefined;
    const id = live.info.id;
    if (c.mode === 'cli') {
      // CLI 가 정리하다 실패하면 "Error during compaction: …" 을 답 글로 내고 차례는 성공으로 끝낸다 — 그 까닭(API 안전장치·한도 등)을 그대로 보인다
      const failed = c.text?.match(/^Error during compaction:\s*(.+)/s)?.[1].split('\n')[0].slice(0, 300);
      if (!c.done) this.publish({ type: 'session.compacted', sessionId: id, mode: 'cli', unit: 'tokens', error: failed ? `정리하다 실패함: ${failed}` : isError ? '정리 명령이 실패함' : '정리되지 않음(이 CLI 버전이 대화 중 /compact 를 받지 않음)' });
    } else if (isError || !c.text?.trim()) {
      this.publish({ type: 'session.compacted', sessionId: id, mode: 'summary', unit: 'chars', error: '에이전트가 정리본을 쓰지 못함' });
    } else {
      // 정리본으로 새 대화: 지금 CLI 를 내리고 다음 지시에 정리본 + 그 뒤 대화만 붙인다(conversation 이 정리본에서 다시 센다)
      this.publish({ type: 'session.compacted', sessionId: id, mode: 'summary', unit: 'chars', before: c.before, after: c.text.trim().length, summary: c.text.trim() });
      live.gen = (live.gen ?? 0) + 1;
      live.dormant = true;
      if (live.token) this.tokens.delete(live.token);
      live.token = undefined;
      live.adapter.stop();
      live.carry = undefined;
      live.memSeen = undefined;
      delete live.info.cliSessionId;
      this.publish({ type: 'context.usage', sessionId: id, used: 0, window: null });
    }
    this.setStatus(live, 'idle');
    const next = live.afterCompact;
    live.afterCompact = undefined;
    next?.();
  }

  /**
   * 쉬는 작업의 CLI 를 내려 메모리를 돌려준다. 다음 지시가 오면 wake 가 --resume 으로 같은 대화에 이어 띄운다.
   * 내리지 않는 것: 일하는 중 · 승인 대기 · 예약 차례 · 메인이 기다리는 하위 작업자 · 일하는 하위 작업자가 있는 메인 ·
   * 그 대화로 이어 갈 수 없는 것(Claude 대화 기록이 없거나 Codex · Gemini) · CLI 아래에 살아 있는 프로세스가 있는 것(작업자가 띄운 서버 · 명령).
   * 돌려준 값: 내린 작업 id
   */
  sleepIdle(now = Date.now()): string[] {
    if (!this.sleepIdleMinutes && !this.maxAwake) return [];
    const awake = [...this.sessions.values()].filter((l) => !l.dormant && l.adapter.pid?.() !== undefined);
    const kids = childMap();
    const can = (l: Live) => {
      if (l.info.status !== 'idle' || !l.idleSince || l.schedRun) return false;
      if (l.turn && !l.turn.done && !l.turn.ended) return false;
      if (this.waitingPerm(l)) return false;
      if (l.info.id === this.intake?.sessionId && this.intake.pending.size) return false;
      if ([...this.sessions.values()].some((w) => w.info.parentId === l.info.id && (w.info.status === 'working' || w.info.status === 'starting'))) return false;
      if (!this.resumable(l)) return false;
      const pid = l.adapter.pid?.();
      return pid !== undefined && kids !== null && !hasLiveChildren(kids, pid);
    };
    const out: Live[] = [];
    if (this.sleepIdleMinutes) for (const l of awake) if (can(l) && now - l.idleSince! >= this.sleepIdleMinutes * 60_000) out.push(l);
    if (this.maxAwake && awake.length - out.length > this.maxAwake) {
      const more = awake.filter((l) => !out.includes(l) && can(l) && now - l.idleSince! >= 60_000).sort((a, b) => a.idleSince! - b.idleSince!);
      out.push(...more.slice(0, awake.length - out.length - this.maxAwake));
    }
    for (const l of out) {
      l.gen = (l.gen ?? 0) + 1; // 내린 CLI 가 늦게 보내는 소식은 버린다
      l.dormant = true;
      if (l.token) this.tokens.delete(l.token);
      l.token = undefined;
      l.adapter.stop();
    }
    return out.map((l) => l.info.id);
  }

  private waitingPerm(l: Live): boolean {
    for (const a of this.asks.values()) if (a.sessionId === l.info.id) return true;
    const open = new Set<string>();
    for (const e of l.history) {
      if (e.type === 'permission.request') open.add(e.requestId);
      else if (e.type === 'permission.resolved') open.delete(e.requestId);
    }
    return open.size > 0;
  }

  /** CLI 를 내려 둔다 — 다음 지시에 같은 대화로 다시 뜬다(설정을 바꾼 값으로) */
  private sleep(l: Live) {
    if (l.dormant) return;
    l.gen = (l.gen ?? 0) + 1;
    l.dormant = true;
    if (l.token) this.tokens.delete(l.token);
    l.token = undefined;
    l.adapter.stop();
  }

  private setStatus(live: Live, status: SessionInfo['status']) {
    if (live.info.status === status || live.info.status === 'ended') return;
    live.info.status = status;
    if (status === 'idle' && live.relaunch) { live.relaunch = false; queueMicrotask(() => { if (live.info.status === 'idle') this.sleep(live); }); }
    if (status === 'idle') live.idleSince = Date.now();
    else delete live.idleSince;
    this.publish({ type: 'session.status', sessionId: live.info.id, status });
  }

  private get(id: string): Live | undefined {
    const live = this.sessions.get(id);
    if (!live) this.publish({ type: 'error', sessionId: id, message: '없는 세션' });
    return live;
  }

  /** 공용 PC 화면에 터미널 창 띄우기. 창은 PC 앞 사람만 쓸 수 있으므로 대시보드에서는 거부한다. */
  private async terminal(agent: AgentKind, sessionId: string | undefined, workdir: string | undefined, origin: CommandOrigin, profile?: boolean) {
    if (origin.via !== 'local' && !origin.trusted) {
      this.publish({ type: 'error', agent, message: '터미널 창은 공용 PC 앞에서만 열 수 있음' });
      return;
    }
    if (!this.openTerminal) return this.publish({ type: 'error', agent, message: '터미널 열기가 설정되지 않음' });
    const live = sessionId ? this.sessions.get(sessionId) : undefined;
    const dir = live ? live.info.workdir : this.resolveWorkdir(workdir);
    if (!dir) {
      this.publish({ type: 'error', agent, message: `작업 폴더는 ${this.workspaceRoot} 안의 있는 폴더여야 함: ${workdir}` });
      return;
    }
    try {
      await this.openTerminal(agent, dir, profile);
      this.publish({ type: 'notice', agent, message: `터미널을 열었음: ${dir}` });
    } catch (err) {
      this.publish({ type: 'error', agent, message: `터미널 열기 실패: ${(err as Error).message}` });
    }
  }

  /** 프리셋 폴더: 뿌리 바로 아래 이름(비우면 뿌리). 없으면 만든다. 경로 탈출은 거부 */
  private ensureFolder(name: string): string | null {
    if (!name) return this.workspaceRoot;
    if (/[\\/:*?"<>|]/.test(name) || name === '.' || name === '..') return null;
    const dir = join(this.workspaceRoot, name);
    mkdirSync(dir, { recursive: true });
    return this.resolveWorkdir(name);
  }

  /** 작업 폴더는 workspaceRoot 아래 실제로 있는 폴더만 허용한다(경로 탈출 거부). */
  /**
   * 작업 폴더 뿌리 밖의 폴더 — PC 앞 화면(local)에서 사람이 직접 고른 것만. 대시보드에서는 안 된다.
   * 드라이브·파일 시스템 뿌리, Agent Hub 기록·키(data) 폴더와 그것을 품은 폴더는 안 된다.
   */
  private outsideDir(d: string, origin: CommandOrigin): string | { error: string } {
    if (origin.via !== 'local' && !origin.trusted) return { error: `작업 폴더 뿌리 밖의 폴더는 PC 앞에서만 연결할 수 있음: ${d}` };
    if (!isAbsolute(d)) return { error: `연결할 수 없는 폴더(작업 폴더 뿌리 밖은 찾아보기로 고르세요): ${d}` };
    const abs = resolve(d);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) return { error: `없는 폴더: ${d}` };
    if (dirname(abs) === abs) return { error: '드라이브 전체는 연결할 수 없음. 그 안의 폴더를 고르세요' };
    const data = resolve(this.logDir, '..');
    const inside = (a: string, b: string) => { const r = relative(a, b); return !r.startsWith('..') && !isAbsolute(r); }; // b 가 a 안(같음 포함)
    if (inside(abs, data) || inside(data, abs)) return { error: 'Agent Hub 기록·키가 든 폴더는 연결할 수 없음' };
    return abs;
  }

  private resolveWorkdir(workdir: string | undefined): string | null {
    const dir = resolve(this.workspaceRoot, workdir ?? '.');
    const rel = relative(this.workspaceRoot, dir);
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
    return dir;
  }

  private publish(ev: HostEvent) {
    const sessionId = 'sessionId' in ev ? ev.sessionId : ev.type === 'session.created' ? ev.session.id : undefined;
    let remotes = false; // 원격 접속 목록이 바뀜 — 이 이벤트 뒤에 목록을 알린다
    if (sessionId) {
      const live = this.sessions.get(sessionId);
      if (live) {
        // 실시간 조각 글은 기록·재전송하지 않는다(완성본만 남긴다). 원격 접속 목록도 기록에서 모은 것이라 남기지 않는다
        const isPartial = (ev.type === 'agent.text' && ev.partial) || ev.type === 'session.remotes';
        if (!isPartial) {
          this.stamp(ev);
          live.history.push(ev);
          // 넘치면 오래된 것부터 버리되 만든 기록(맨 앞 session.created)은 남긴다
          if (live.history.length > HISTORY_CAP) live.history.splice(live.history[0]?.type === 'session.created' ? 1 : 0, 1);
          appendFileSync(join(this.logDir, `${sessionId}.jsonl`), JSON.stringify({ at: new Date().toISOString(), ...ev }) + '\n');
          remotes = this.trackRemote(live, ev);
        }
      }
    }
    for (const l of this.listeners) l(ev);
    if (remotes && sessionId) this.publish({ type: 'session.remotes', sessionId, remotes: this.remotesOf(sessionId) });
  }
}

/** 지시 앞에 붙는 역할 한 줄(화면·기록에는 남지 않는다) */
export function aboutNote(about?: string): string {
  return `[이 작업 역할: ${about ? about.replace(/\s+/g, ' ') : '비어 있음'}]`;
}

/**
 * 원격 접속으로 온 글이 입력 세션을 거치나: 바깥 시스템(업무 웹의 채팅 호출 등)은 자기 머리줄·규칙을 붙여 보내니 바로 간다.
 * 다른 PC Agent Hub 에서 사람이 보낸 글("Agent Hub <PC> · 사람")만 거친다. via 가 없으면(이 PC 화면) 거친다
 */
export function viaThroughIntake(via?: { app: string; label: string }): boolean {
  return !via || (via.app.startsWith('Agent Hub ') && via.label === '사람');
}

/** 사람이 쓴 지시인가(다른 작업·예약·입력 세션이 보낸 것은 아님) */
export function isHumanOrigin(user: string): boolean {
  return !(user.startsWith('작업 ') || user === '예약' || user === '입력' || user === '입력 요청');
}

/** 프로세스 번호 → 자식 번호들(리눅스 /proc, macOS ps). 알 수 없으면 null — 그때는 아무것도 내리지 않는다 */
function childMap(): Map<number, number[]> | null {
  const m = new Map<number, number[]>();
  const put = (pid: number, ppid: number) => { const a = m.get(ppid); if (a) a.push(pid); else m.set(ppid, [pid]); };
  try {
    if (process.platform === 'linux') {
      for (const d of readdirSync('/proc')) {
        if (!/^\d+$/.test(d)) continue;
        try {
          const st = readFileSync(`/proc/${d}/stat`, 'utf8');
          const rest = st.slice(st.lastIndexOf(')') + 2).split(' '); // 이름에 괄호 · 공백이 있어도
          if (rest[0] === 'Z') continue; // 좀비는 살아 있는 것이 아니다
          put(Number(d), Number(rest[1]));
        } catch {}
      }
      return m;
    }
    if (process.platform === 'darwin') {
      const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
      if (r.status !== 0) return null;
      for (const line of r.stdout.split('\n')) { const [a, b] = line.trim().split(/\s+/).map(Number); if (a && b) put(a, b); }
      return m;
    }
  } catch {}
  return null; // Windows 등: CLI 가 셸을 거쳐 떠서 아래 프로세스로 가릴 수 없다
}
function hasLiveChildren(kids: Map<number, number[]>, pid: number): boolean {
  return (kids.get(pid) ?? []).length > 0;
}

/** 사람 글이 통째로 컨텍스트 정리 부탁인지(다른 지시에 섞인 말은 아님) */
export function isCompactRequest(text: string): boolean {
  const t = text.trim().replace(/[.!?~。！]+$/u, '').replace(/\s+/g, ' ').toLowerCase();
  if (/^\/(compact|compress|컨텍스트 ?정리)$/.test(t)) return true;
  if (/^(compact|compress)( (the )?(context|conversation|chat))?( please)?$/.test(t)) return true;
  return /^(지금까지 )?(컨텍스트|대화 ?기록|대화)(를|을)? ?(좀 )?(정리|압축|요약 ?정리)(해 ?(줘|주세요|줄래|봐)|하자|해|해라|요망|부탁(해|합니다)?)?$/.test(t);
}

/** 바깥 운영 알림(설정의 opsAlert). 같은 key 는 풀릴 때까지 받는 쪽이 한 번만 알린다 */
export type OpsAlert = (a: { key: string; problem?: string; since?: string; action?: string; resolved?: boolean }) => void;
/** 예약 결과 글이 실패인지(보낸 뒤 실패로 끝남 · 다시 띄우지 못함 · 작업이 없음) */
export function scheduleFailed(result: string): boolean {
  return /(^|→ )실패|다시 띄우지 못함|작업이 없어/.test(result);
}
