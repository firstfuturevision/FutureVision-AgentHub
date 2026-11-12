import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, existsSync, statSync, readFileSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join, resolve, relative, isAbsolute, extname, basename } from 'node:path';
import { AGENTS, MODEL_RE } from './protocol.ts';
import type { AgentKind, Attachment, ClientCommand, CommandOrigin, ContextItem, HostEvent, SessionInfo, SessionRole } from './protocol.ts';
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
  adapter: AgentAdapter;
  history: HostEvent[]; // 나중에 붙은 화면이 이어서 볼 수 있게
  token?: string; // main 만: MCP 주소의 비밀 토큰
  turn: Turn | null; // worker 만: 메인이 기다리는 차례
  carry?: string; // 복제한 작업: 첫 지시에 붙일 원래 대화
  role?: Preset; // 에이전트로 시작한 세션: 첫 지시에 붙일 역할 지침
  guide?: WorkPreset; // 프리셋(작업 환경)으로 시작한 세션: 첫 지시에 붙일 지침
  merges?: { label: string; text: string }[]; // 포크·분담에서 공유받은 것: 다음 지시에 붙일 내용
  ctx?: { label: string; chars: number }[]; // 이번 CLI 에 이미 넣은 것(앞 대화, 공유) — 다시 띄우면 비운다
  gen?: number; // 몇 번째로 띄운 CLI 인지 — 설정을 바꿔 다시 띄우면 앞 CLI 의 이벤트는 버린다
  dormant?: boolean; // 호스트를 다시 켜서 CLI 가 아직 없음 — 다음 지시 때 띄운다
  resume?: string; // 다음에 띄울 CLI 가 이어 갈 Claude 대화 id(--resume)
}

const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_INLINE_IMAGE = 5 * 1024 * 1024; // 이보다 큰 이미지는 경로로만 알린다
const MAX_ATTACHMENT = 50 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
function formatSize(n: number): string {
  return n < 1024 ? `${n}B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** 대화 기록 → 줄(사람·에이전트 말, 합친 포크). upTo: 사람 지시 몇 번째 차례까지(그다음 지시 앞에서 끊음) */
function conversation(history: HostEvent[], upTo?: number): string[] {
  const lines: string[] = [];
  let users = 0;
  for (const e of history) {
    if (e.type === 'user.message') {
      if (upTo !== undefined && users >= upTo) break;
      users++;
      lines.push(`사람(${e.from}): ${e.text}`);
    } else if (e.type === 'agent.text' && !e.partial) lines.push(`에이전트: ${e.text}`);
    else if (e.type === 'session.merged') lines.push(`[${e.kind === 'split' ? '분담' : '포크'} 공유: ${e.title}]\n${e.text}`);
  }
  return lines;
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
  /** 권한 묻지 않기(모든 작업) — 설정 → 연동. 켜면 모든 작업의 도구 권한을 묻지 않고 허용한다(작업별 설정보다 앞선다) */
  autoApproveAll = false;
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
    claudeHome?: string; // Claude Code 설정 폴더(시험용). 기본 CLAUDE_CONFIG_DIR 또는 ~/.claude
  }) {
    this.claudeHome = opts.claudeHome ?? claudeHome();
    this.claudeCode = new ClaudeHistory(this.claudeHome);
    this.schedules = opts.schedules;
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
        if (e.type === 'session.renamed') info.customTitle = e.title;
        if (e.type === 'session.dirs') info.extraDirs = e.dirs;
        if (e.type === 'session.cli') info.cliSessionId = e.cliSessionId;
        if (e.type === 'session.configured') Object.assign(info, { agent: e.session.agent, model: e.session.model, preset: e.session.preset, workPreset: e.session.workPreset, autoApprove: e.session.autoApprove });
      }
      // 길면 최근 것만. 만든 기록(session.created)은 꼭 남긴다 — 없으면 화면이 그 작업을 모른다
      const history = events.length > HISTORY_CAP ? [created, ...events.slice(-(HISTORY_CAP - 1)).filter((e) => e !== created)] : events;
      this.trimLog(f, lines, info);
      const live: Live = { info, adapter: new UnavailableAdapter('다시 띄우기 전'), history, turn: null };
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
  private trimLog(file: string, lines: string[], info: SessionInfo) {
    const path = join(this.logDir, file);
    try {
      if (statSync(path).size <= LOG_TRIM_BYTES || lines.length <= HISTORY_CAP) return;
      const archive = join(this.logDir, 'archive');
      mkdirSync(archive, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      writeFileSync(join(archive, `${file.replace(/\.jsonl$/, '')}-${stamp}.jsonl.gz`), gzipSync(lines.join('\n') + '\n'));
      const head = JSON.stringify({ at: info.createdAt, type: 'session.created', session: { ...info, status: 'idle' } });
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
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((l) => l.info);
  }

  info(id: string): SessionInfo | undefined {
    return this.sessions.get(id)?.info;
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
    const live = this.sessions.get(sessionId);
    if (!live) throw new Error('없는 세션');
    if (data.length > MAX_ATTACHMENT) throw new Error(`파일이 너무 큼(최대 ${formatSize(MAX_ATTACHMENT)})`);
    const safe = (rawName || '파일').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(-120) || '파일';
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
    const dir = join(live.info.workdir, '첨부');
    mkdirSync(dir, { recursive: true });
    let name = `${stamp}-${safe}`;
    for (let n = 2; existsSync(join(dir, name)); n++) name = `${stamp}-${n}-${safe}`;
    writeFileSync(join(dir, name), data);
    return { path: `첨부/${name}`, name: rawName || safe, mime: /^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime : 'application/octet-stream', size: data.length };
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
      asksPermission: !(i.autoApprove || this.autoApproveAll),
      schedules: this.schedules?.forSession(i.id).length ?? 0,
      localTime: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }

  /** 메인이 자기 작업(오른쪽 작업 정보의 "예약")에 걸린 예약을 본다 */
  scheduleListByMain(mainId: string) {
    if (!this.schedules) throw new Error('예약 기능이 없음');
    if (!this.sessions.has(mainId)) throw new Error('없는 작업');
    return this.schedules.forSession(mainId);
  }

  /** 메인이 자기 작업에 예약을 걸거나(id 없이) 고친다. 다른 작업의 예약은 건드리지 못한다 */
  scheduleSaveByMain(mainId: string, a: Record<string, unknown>) {
    if (!this.schedules) throw new Error('예약 기능이 없음');
    if (!this.sessions.has(mainId)) throw new Error('없는 작업');
    if (typeof a.id === 'string' && a.id && !this.schedules.forSession(mainId).some((s) => s.id === a.id)) throw new Error(`이 작업의 예약이 아님: ${a.id}`);
    const s = this.schedules.save({ ...a, sessionId: mainId });
    this.schedulesChanged();
    return s;
  }

  scheduleDeleteByMain(mainId: string, id: string) {
    if (!this.schedules) throw new Error('예약 기능이 없음');
    if (!this.schedules.forSession(mainId).some((s) => s.id === id)) throw new Error(`이 작업의 예약이 아님: ${id}`);
    this.schedules.remove(id);
    this.schedulesChanged();
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
      if (live.dormant) continue;
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
        const atts = cmd.attachments?.filter((a) => this.attachmentPath(live, a.path)) ?? [];
        this.publish({ type: 'user.message', sessionId: cmd.sessionId, text: cmd.text, from: origin.user, ...(atts.length ? { attachments: atts } : {}) });
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
        live.info.customTitle = cmd.title;
        this.publish({ type: 'session.renamed', sessionId: cmd.sessionId, title: cmd.title });
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
        await this.forkLive(live, origin, ' (분담)', undefined, 'split');
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
      splitLines: kind === 'split' ? conversation(live.history).length : undefined,
      copiedFrom: kind === 'copy' ? o.id : undefined, // 복사: 공유 없음
      customTitle: o.customTitle ? `${o.customTitle}${suffix}` : undefined,
      extraDirs: o.extraDirs,
      autoApprove: o.autoApprove,
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
      // 간격 예약: 앞 차례의 일이 아직 안 끝났으면 이번 차례는 건너뛴다(지시가 쌓이지 않게)
      const st = this.sessions.get(s.sessionId)?.info.status;
      if (s.repeat === 'interval' && (st === 'working' || st === 'starting')) {
        this.schedules.markRun(s.id, now, '작업 중이라 건너뜀');
        this.schedulesChanged();
        continue;
      }
      this.scheduleRunning.add(s.id);
      try {
        const r = await this.runScheduled(s.sessionId, s.prompt);
        this.schedules.markRun(s.id, now, r.result, r.sessionId);
      } catch (err) {
        this.schedules.markRun(s.id, now, `실패: ${(err as Error).message}`);
      } finally {
        this.scheduleRunning.delete(s.id);
      }
      this.schedulesChanged();
    }
  }

  /** 같은 작업에 보낸다. 끝났거나 호스트를 다시 켜서 쉬는 작업이면 다시 띄워 앞 대화를 붙여 이어 간다. */
  private async runScheduled(sessionId: string, prompt: string): Promise<{ result: string; sessionId?: string }> {
    const live = this.sessions.get(sessionId);
    if (!live) return { result: '작업이 없어 건너뜀' };
    const woke = live.dormant;
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
        autoApprove: Boolean(preset?.autoApprove || main.info.autoApprove), // 메인이 묻지 않으면 맡긴 일도 묻지 않는다
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
    cliSessionId?: string; // 가져온 Claude Code 대화 — 첫 CLI 부터 --resume 으로 이어 간다
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
      ...(o.autoApprove ? { autoApprove: true } : {}),
      ...(o.cliSessionId ? { cliSessionId: o.cliSessionId, imported: true } : {}),
      title: o.title ?? (o.role === 'main' ? '메인 에이전트' : `${o.agent} 작업`),
      workdir: o.workdir,
      requestedBy: o.origin.user,
      via: o.origin.via,
      createdAt: new Date().toISOString(),
      status: 'starting',
    };
    const live: Live = { info, adapter: this.makeAdapter(o.agent), history: [], turn: null, ...(o.cliSessionId ? { resume: o.cliSessionId } : {}) };
    this.sessions.set(info.id, live);
    this.publish({ type: 'session.created', session: info });
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
    const ctx: StartContext = { tools, configDir, env, authMethod: launch?.authMethod, extraDirs: o.extraDirs, pluginDir, ...(live.resume ? { resume: live.resume } : {}) };
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
   * 화면에는 대화 끝부분을 먼저 보여 준다. 이 PC 화면(사무실 원격 포함)에서만, FV 대시보드에서는 안 된다.
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
    info.status = 'starting';
    this.publish({ type: 'session.configured', sessionId: info.id, session: { ...info } });
    live.adapter = this.makeAdapter(agent);
    await this.launch(live);
  }

  private fromAdapter(live: Live, ev: AdapterEvent) {
    if (live.dormant) return;
    if (ev.type === 'session.cli') {
      // 대화 id 는 바뀔 때만 기록(다시 켠 뒤 --resume 에 쓴다)
      if (live.info.cliSessionId === ev.cliSessionId) return;
      live.info.cliSessionId = ev.cliSessionId;
    }
    const auto = ev.type === 'permission.request' && (live.info.autoApprove || this.autoApproveAll);
    const full = { ...ev, sessionId: live.info.id, ...(auto ? { auto: true } : {}) } as HostEvent;
    this.publish(full);
    // 권한 묻지 않기(이 작업 또는 모든 작업): 요청과 허용을 기록에만 남기고 바로 허용한다
    if (ev.type === 'permission.request' && auto) {
      this.publish({ type: 'permission.resolved', sessionId: live.info.id, requestId: ev.requestId, allow: true, by: '자동 허용' });
      live.adapter.respondPermission(ev.requestId, true);
    }
    const turn = live.turn;
    if (turn) {
      if (ev.type === 'agent.text' && !ev.partial) turn.texts.push(ev.text);
      if (ev.type === 'error') turn.errors.push(ev.message);
      if (ev.type === 'turn.done') turn.done = { isError: ev.isError, costUsd: ev.costUsd };
      if (ev.type === 'session.ended') turn.ended = ev.reason;
      if (turn.done || turn.ended) for (const w of [...turn.waiters]) w();
    }
    if (ev.type === 'turn.done') {
      // 차례가 끝났는데 답하지 않은 승인 요청이 남아 있으면 더는 답할 곳이 없다 — "승인 대기"로 남지 않게 닫는다
      this.closePerms(live, '차례 끝남');
      this.setStatus(live, 'idle');
      this.share(live);
    }
    if (ev.type === 'session.ended') {
      // CLI 가 꺼짐: 작업은 대기로 남기고 다음 지시 때 다시 띄운다(wake)
      live.dormant = true;
      if (live.token) this.tokens.delete(live.token);
      live.token = undefined;
      this.closePerms(live, 'CLI 꺼짐'); // 꺼진 CLI 에서 묻던 것은 거부로 정리
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
  /** 답이 끝날 때마다: 포크 → 원본, 분담한 쪽 → 원본, 원본 → 분담한 쪽들 */
  private share(live: Live) {
    if (live.info.role === 'worker') return;
    const get = (id?: string) => (id ? this.sessions.get(id) : undefined);
    const fork = get(live.info.forkedFrom);
    if (fork) this.shareTo(live, fork, 'fork');
    const origin = get(live.info.splitFrom);
    if (origin) {
      this.shareTo(live, origin, 'split');
      // 메인을 거쳐 다른 분담들에게도 바로(메인이 다시 답할 때까지 기다리지 않는다). 메인 쪽 보낸 표시가 앞으로 가서 나중에 겹쳐 가지 않는다
      for (const s of this.sessions.values()) if (s.info.splitFrom === origin.info.id && s !== live) this.shareTo(origin, s, 'split');
    }
    for (const s of this.sessions.values()) if (s.info.splitFrom === live.info.id) this.shareTo(live, s, 'split');
  }

  /**
   * from 의 대화 중 지난번에 target 에게 보낸 뒤로 새로 생긴 것을 target 기록에 남기고, 진행 중이면 다음 지시에 붙인다.
   * target 에게서 받은 공유는 빼고 센다(양쪽 공유가 서로 메아리치지 않게).
   */
  private shareTo(from: Live, target: Live, kind: 'fork' | 'split') {
    const lines = conversation(from.history.filter((e) => !(e.type === 'session.merged' && e.fromId === target.info.id)));
    const prev = target.history.filter((e) => e.type === 'session.merged' && e.fromId === from.info.id).at(-1);
    // 처음 보낼 때: 원본 → 분담이면 분담할 때까지의 대화는 이미 이어받았으니 그 뒤부터
    const base = target.info.splitFrom === from.info.id ? (target.info.splitLines ?? 0) : 0;
    const fresh = lines.slice(prev && prev.type === 'session.merged' ? prev.lines : base);
    if (!fresh.length) return;
    const firstUser = from.history.find((e) => e.type === 'user.message');
    const title = from.info.customTitle ?? (firstUser && firstUser.type === 'user.message' ? firstUser.text.slice(0, 40) : kind === 'split' ? '분담' : '포크');
    const text = tail(fresh.join('\n'));
    this.publish({ type: 'session.merged', sessionId: target.info.id, fromId: from.info.id, title, text, lines: lines.length, ...(kind === 'split' ? { kind } : {}) });
    const head = kind === 'split'
      ? `[분담 공유: ${title} — 같은 일을 나눠 맡은 쪽이 그사이 진행한 대화. 겹치지 않게 반영한다]`
      : `[포크 공유: ${title} — 원본에서 갈라져 따로 진행한 대화. 결과를 반영한다]`;
    (target.merges ??= []).push({ label: `${kind === 'split' ? '분담' : '포크'} 공유 · ${title}`, text: `${head}\n${text}` });
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

  private setStatus(live: Live, status: SessionInfo['status']) {
    if (live.info.status === status || live.info.status === 'ended') return;
    live.info.status = status;
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
    if (sessionId) {
      const live = this.sessions.get(sessionId);
      if (live) {
        // 실시간 조각 글은 기록·재전송하지 않는다(완성본만 남긴다).
        const isPartial = ev.type === 'agent.text' && ev.partial;
        if (!isPartial) {
          this.stamp(ev);
          live.history.push(ev);
          // 넘치면 오래된 것부터 버리되 만든 기록(맨 앞 session.created)은 남긴다
          if (live.history.length > HISTORY_CAP) live.history.splice(live.history[0]?.type === 'session.created' ? 1 : 0, 1);
          appendFileSync(join(this.logDir, `${sessionId}.jsonl`), JSON.stringify({ at: new Date().toISOString(), ...ev }) + '\n');
        }
      }
    }
    for (const l of this.listeners) l(ev);
  }
}
