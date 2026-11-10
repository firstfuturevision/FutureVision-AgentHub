import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, existsSync, statSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { AGENTS, MODEL_RE } from './protocol.ts';
import type { AgentKind, Attachment, ClientCommand, CommandOrigin, HostEvent, SessionInfo, SessionRole } from './protocol.ts';
import { UnavailableAdapter, type AgentAdapter, type AdapterEvent, type StartContext } from './adapters/types.ts';
import { withRole, type Preset, type PresetStore } from './presets.ts';
import type { ToolStore } from './tools.ts';
import type { AuthStore } from './auth.ts';
import type { HubSkillStore } from './hubskills.ts';
import { withGuidelines, type WorkPreset, type WorkPresetStore } from './workpresets.ts';
import { skillsFor, type SkillInfo } from './skills.ts';
import type { ScheduleStore } from './schedules.ts';

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
  merges?: string[]; // 포크에서 공유받은 것: 다음 지시에 붙일 내용
  gen?: number; // 몇 번째로 띄운 CLI 인지 — 설정을 바꿔 다시 띄우면 앞 CLI 의 이벤트는 버린다
}

const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_INLINE_IMAGE = 5 * 1024 * 1024; // 이보다 큰 이미지는 경로로만 알린다
const MAX_ATTACHMENT = 50 * 1024 * 1024;
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
    else if (e.type === 'session.merged') lines.push(`[포크 공유: ${e.title}]\n${e.text}`);
  }
  return lines;
}
const tail = (text: string) => (text.length > 8000 ? '…' + text.slice(-8000) : text);
/** 대화 기록 → 이어받기용 글(뒤쪽 8000자) */
function transcript(history: HostEvent[], upTo?: number): string {
  return tail(conversation(history, upTo).join('\n')) || '(대화 없음)';
}

const HISTORY_CAP = 2000;

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
  private scheduleRunning = new Set<string>(); // 실행 중인 예약(같은 예약이 겹쳐 돌지 않게)
  private asks = new Map<string, { sessionId: string; resolve: (allow: boolean) => void }>(); // 호스트가 사람에게 묻는 중인 것
  private order = new WeakMap<HostEvent, number>(); // 기록된 이벤트의 순서(다시 보낼 때 정렬)
  private seq = 0;
  private stamp(ev: HostEvent, ms = Date.now()) {
    this.order.set(ev, ms * 1000 + (this.seq++ % 1000));
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
  }) {
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
    this.makeAdapter = opts.makeAdapter;
    this.openTerminal = opts.openTerminal;
    this.mcpBaseUrl = opts.mcpBaseUrl;
    this.clinkWaitMs = opts.clinkWaitMs ?? 10 * 60 * 1000;
    mkdirSync(this.logDir, { recursive: true });
  }

  /**
   * 호스트를 다시 켰을 때 기록 파일(data/sessions/*.jsonl)에서 작업 목록·대화를 되살린다.
   * CLI 프로세스는 이미 없으므로 모두 "끝남"으로 복원한다(이어서 하려면 포크 → 앞 대화를 이어받음).
   * 삭제한 작업은 되살리지 않는다.
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
      try {
        events = readFileSync(join(this.logDir, f), 'utf8').split('\n').filter(Boolean).map((l) => {
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
        if (e.type === 'session.configured') Object.assign(info, { agent: e.session.agent, model: e.session.model, preset: e.session.preset, workPreset: e.session.workPreset, autoApprove: e.session.autoApprove });
      }
      const live: Live = { info, adapter: new UnavailableAdapter('끝난 작업'), history: events.slice(-HISTORY_CAP), turn: null };
      if (!events.some((e) => e.type === 'session.ended')) {
        const ended: HostEvent = { type: 'session.ended', sessionId: info.id, reason: '호스트를 다시 켜서 끝남. 이어서 하려면 포크' };
        this.stamp(ended);
        live.history.push(ended);
        appendFileSync(join(this.logDir, f), JSON.stringify({ at: new Date().toISOString(), ...ended }) + '\n');
      }
      info.status = 'ended';
      restored.push(live);
    }
    // 메인이 작업자보다 먼저 오도록(화면이 카드를 메인에 붙인다), 만든 순서대로
    restored.sort((a, b) => Number(a.info.role === 'worker') - Number(b.info.role === 'worker') || a.info.createdAt.localeCompare(b.info.createdAt));
    for (const l of restored) this.sessions.set(l.info.id, l);
    return restored.length;
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
    const byAgent = info?.preset ? this.presets?.find(info.preset.id)?.agents : undefined;
    const byPreset = info?.workPreset ? this.workPresets?.find(info.workPreset.id)?.agents : undefined;
    if (byAgent && byPreset) return byAgent.filter((a) => byPreset.includes(a));
    return byAgent ?? byPreset;
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

  /** 첨부 경로 → 실제 파일 경로(그 세션 작업 폴더의 첨부/ 안에 실제로 있을 때만) */
  private attachmentPath(live: Live, rel: string): string | null {
    const abs = resolve(live.info.workdir, rel);
    const r = relative(join(live.info.workdir, '첨부'), abs);
    if (r.startsWith('..') || isAbsolute(r) || !existsSync(abs)) return null;
    return abs;
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

  /** 세션 대화에 승인 카드를 띄우고 사람의 답을 기다린다. 세션이 끝나면 거부로 본다. */
  private askHuman(sessionId: string, tool: string, detail: string): Promise<boolean> {
    const live = this.sessions.get(sessionId);
    if (!live || live.info.status === 'ended') return Promise.resolve(false);
    const requestId = `hub${++this.askSeq}`;
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
      case 'user.message': {
        const live = this.get(cmd.sessionId);
        if (!live) return;
        if (live.info.status === 'ended') return this.publish({ type: 'error', sessionId: cmd.sessionId, message: '이미 끝난 세션' });
        const atts = cmd.attachments?.filter((a) => this.attachmentPath(live, a.path)) ?? [];
        this.publish({ type: 'user.message', sessionId: cmd.sessionId, text: cmd.text, from: origin.user, ...(atts.length ? { attachments: atts } : {}) });
        this.setStatus(live, 'working');
        // 첨부: 모든 파일은 작업 폴더 경로로 알려 주고(에이전트가 열어 봄), 이미지는 이미지째 함께 보낸다
        let text = cmd.text;
        if (atts.length) {
          const list = atts.map((a) => `- ${a.path.replace(/\\/g, '/')} (${a.mime}, ${formatSize(a.size)})`).join('\n');
          text = `${text}\n\n[첨부 파일 — 작업 폴더 기준 경로]\n${list}`.trim();
        }
        const images = atts
          .filter((a) => IMAGE_MIME.has(a.mime) && a.size <= MAX_INLINE_IMAGE)
          .map((a) => ({ mime: a.mime, data: readFileSync(this.attachmentPath(live, a.path)!).toString('base64') }));
        // 첫 지시에는 에이전트 역할 지침, 그 바깥에 작업 환경(프리셋) 지침을 붙인다
        if (live.role) {
          text = withRole(live.role, text);
          live.role = undefined;
        }
        if (live.guide) {
          text = withGuidelines(live.guide, text);
          live.guide = undefined;
        }
        // 복제한 작업의 첫 지시에는 원래 작업의 대화를 붙인다(화면·기록에는 사람이 쓴 글만)
        // 포크에서 공유받은 게 있으면 이번 지시 앞에 붙인다
        if (live.merges?.length) {
          text = `${live.merges.join('\n\n')}\n\n[이어서 할 일]\n${text}`;
          live.merges = undefined;
        }
        const carry = live.carry;
        live.carry = undefined;
        live.adapter.send(carry ? `[이전 대화 — 이 작업의 앞선 기록. 이어서 진행한다]\n${carry}\n\n[이어서 할 일]\n${text}` : text, images);
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
        // 메인을 끝내면 그 메인이 맡긴 작업자도 모두 끝낸다
        for (const w of this.sessions.values()) if (w.info.parentId === live.info.id && w.info.status !== 'ended') w.adapter.stop();
        live.adapter.stop();
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
          if (t.info.status !== 'ended') t.adapter.stop();
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
      case 'session.copy': {
        const live = this.get(cmd.sessionId);
        if (!live) return;
        if (live.info.role === 'worker') return this.publish({ type: 'error', sessionId: cmd.sessionId, message: '하위 에이전트는 복사할 수 없음' });
        await this.forkLive(live, origin, ' (사본)', undefined, false);
        return;
      }
      case 'terminal.open':
        await this.terminal(cmd.agent, cmd.sessionId, cmd.workdir, origin, cmd.profile);
        return;
    }
  }

  /**
   * 같은 설정·폴더로 새 작업을 만들고 지금까지의 대화를 이어받게 한다.
   * 에이전트·프리셋도 이어받는다(전용 프로필, 첫 지시의 역할·작업 환경 지침).
   */
  private async forkLive(live: Live, origin: CommandOrigin, suffix: string, upTo?: number, link = true): Promise<Live> {
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
      forkedFrom: link ? o.id : undefined, // 복사는 원본과 잇지 않는다(공유 없음)
      copiedFrom: link ? undefined : o.id,
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

  /** 진행 중인 작업이면 그대로 보내고, 끝난 작업이면 포크해서 보낸다. */
  private async runScheduled(sessionId: string, prompt: string): Promise<{ result: string; sessionId?: string }> {
    const live = this.sessions.get(sessionId);
    if (!live) return { result: '작업이 없어 건너뜀' };
    const origin: CommandOrigin = { via: 'local', user: '예약' };
    if (live.info.status !== 'ended') {
      await this.handle({ type: 'user.message', sessionId, text: prompt }, origin);
      return { result: '보냄' };
    }
    const copy = await this.forkLive(live, origin, '');
    if (copy.info.status === 'ended') return { result: '새 작업을 시작하지 못함', sessionId: copy.info.id };
    await this.handle({ type: 'user.message', sessionId: copy.info.id, text: prompt }, origin);
    return { result: '끝난 작업이라 이어서 새로 시작', sessionId: copy.info.id };
  }

  stopAll() {
    for (const live of this.sessions.values()) if (live.info.status !== 'ended') live.adapter.stop();
  }

  // ── clink: 메인 에이전트가 작업자에게 일을 맡긴다 (설계: docs/DESIGN.md §5-1) ──

  async clink(mainId: string, args: ClinkArgs): Promise<ClinkResult> {
    const main = this.sessions.get(mainId);
    if (!main || main.info.role !== 'main' || main.info.status === 'ended') throw new Error('메인 세션이 없거나 끝났음');
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
      if (worker.info.status === 'ended') {
        const end = worker.history.findLast((e) => e.type === 'session.ended');
        return this.result(worker, 'ended', end?.type === 'session.ended' ? `작업자 시작 실패: ${end.reason}` : '작업자가 끝났음', 0);
      }
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
    copiedFrom?: string;
    customTitle?: string;
    extraDirs?: string[];
    autoApprove?: boolean;
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
      copiedFrom: o.copiedFrom,
      customTitle: o.customTitle,
      extraDirs: o.extraDirs?.length ? o.extraDirs : undefined,
      ...(o.autoApprove ? { autoApprove: true } : {}),
      title: o.title ?? (o.role === 'main' ? '메인 에이전트' : `${o.agent} 작업`),
      workdir: o.workdir,
      requestedBy: o.origin.user,
      via: o.origin.via,
      createdAt: new Date().toISOString(),
      status: 'starting',
    };
    const live: Live = { info, adapter: this.makeAdapter(o.agent), history: [], turn: null };
    this.sessions.set(info.id, live);
    this.publish({ type: 'session.created', session: info });
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
    const ctx: StartContext = { tools, configDir, env, authMethod: launch?.authMethod, extraDirs: o.extraDirs, pluginDir };
    if (o.role === 'main' && this.mcpBaseUrl) {
      live.token = randomUUID().replace(/-/g, '');
      this.tokens.set(live.token, info.id);
      ctx.mcp = { name: 'hub', url: `${this.mcpBaseUrl}/${live.token}` };
    }
    const gen = (live.gen = (live.gen ?? 0) + 1);
    await live.adapter.start(info, (ev) => { if (live.gen === gen) this.fromAdapter(live, ev); }, ctx);
    if (live.gen === gen && live.info.status === 'starting') this.setStatus(live, 'idle');
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
    if (autoApprove && !info.autoApprove && origin.via !== 'local') return fail('권한 묻지 않기는 PC 앞에서만 켤 수 있음');

    live.gen = (live.gen ?? 0) + 1; // 앞 CLI 가 끝나며 보내는 이벤트는 버린다
    if (info.status !== 'ended') live.adapter.stop();
    if (live.token) this.tokens.delete(live.token);
    live.token = undefined;
    for (const [id, a] of this.asks) if (a.sessionId === info.id) { this.asks.delete(id); a.resolve(false); }
    // 새 CLI 에게 넘길 것: 지금까지의 대화(아직 못 보낸 이어받기가 있으면 그것도), 역할·작업 환경 지침
    const said = conversation(live.history);
    if (said.length) live.carry = [live.carry, tail(said.join('\n'))].filter(Boolean).join('\n');
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
    if (live.info.status === 'ended') return;
    const full = { ...ev, sessionId: live.info.id } as HostEvent;
    this.publish(full);
    // 권한 묻지 않기: 요청과 허용을 기록에만 남기고 바로 허용한다
    if (ev.type === 'permission.request' && live.info.autoApprove) {
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
      this.setStatus(live, 'idle');
      this.shareFork(live);
    }
    if (ev.type === 'session.ended') {
      live.info.status = 'ended';
      if (live.token) this.tokens.delete(live.token);
      // 끝난 세션에서 묻던 것은 거부로 정리
      for (const [id, a] of this.asks) if (a.sessionId === live.info.id) { this.asks.delete(id); a.resolve(false); }
    }
  }

  /**
   * 포크 공유: 포크의 답이 끝날 때마다 지난번 공유 뒤로 생긴 대화를 원본 기록에 남긴다.
   * 원본이 진행 중이면 다음 지시 앞에 붙어 간다(원본 에이전트를 바로 돌리지는 않음).
   * 원본이 끝났으면 기록에만 남아 원본을 다시 포크할 때 함께 이어받는다.
   * 포크의 포크는 바로 위 원본에 공유되고, 그 원본의 다음 답이 끝날 때 다시 위로 올라간다.
   */
  private shareFork(live: Live) {
    const parent = live.info.forkedFrom ? this.sessions.get(live.info.forkedFrom) : undefined;
    if (!parent || live.info.role !== 'main') return;
    const lines = conversation(live.history);
    const prev = parent.history.filter((e) => e.type === 'session.merged' && e.fromId === live.info.id).at(-1);
    const fresh = lines.slice(prev && prev.type === 'session.merged' ? prev.lines : 0);
    if (!fresh.length) return;
    const firstUser = live.history.find((e) => e.type === 'user.message');
    const title = live.info.customTitle ?? (firstUser && firstUser.type === 'user.message' ? firstUser.text.slice(0, 40) : '포크');
    const text = tail(fresh.join('\n'));
    this.publish({ type: 'session.merged', sessionId: parent.info.id, fromId: live.info.id, title, text, lines: lines.length });
    if (parent.info.status !== 'ended') (parent.merges ??= []).push(`[포크 공유: ${title} — 원본에서 갈라져 따로 진행한 대화. 결과를 반영한다]\n${text}`);
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
    if (origin.via !== 'local') {
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
    if (origin.via !== 'local') return { error: `작업 폴더 뿌리 밖의 폴더는 PC 앞에서만 연결할 수 있음: ${d}` };
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
          if (live.history.length > HISTORY_CAP) live.history.shift();
          appendFileSync(join(this.logDir, `${sessionId}.jsonl`), JSON.stringify({ at: new Date().toISOString(), ...ev }) + '\n');
        }
      }
    }
    for (const l of this.listeners) l(ev);
  }
}
