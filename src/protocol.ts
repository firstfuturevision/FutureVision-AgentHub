// 공통 이벤트 — 호스트·화면·대시보드가 모두 이 형식 하나로만 주고받는다.
// 설계: docs/DESIGN.md §4

export type AgentKind = 'claude' | 'gemini' | 'codex';

/** 첨부 파일 — 세션 작업 폴더의 첨부/ 에 저장된 것. path 는 작업 폴더 기준 */
export interface Attachment { path: string; name: string; mime: string; size: number }

/** 사람이 고른 기본 작업자 — 메인이 AI 를 정하지 않으면 이 AI·모델로 맡긴다 */
export interface DefaultWorker { agent: AgentKind; model?: string }
export interface ModelOption { id: string; name: string }

// main = 사람과 대화하며 일을 맡기는 메인, worker = 메인이 맡긴 작업자, direct = 사람이 AI 하나와 직접
export type SessionRole = 'main' | 'worker' | 'direct';

export interface SessionInfo {
  id: string;
  agent: AgentKind;
  role: SessionRole;
  parentId?: string; // worker 만: 맡긴 메인 세션
  model?: string; // 지정한 모델(없으면 CLI 기본)
  defaultWorker?: DefaultWorker; // main 만: 사람이 고른 기본 작업자 (clink 에 AI 지정이 없을 때 씀). 없으면 메인이 고른다
  preset?: { id: string; name: string }; // 쓴 에이전트(worker: 맡길 때, main: 메인으로 고른 것)
  workPreset?: { id: string; name: string }; // 작업 환경 프리셋(폴더 구조·작업 방식 지침)
  customTitle?: string; // 사람이 바꾼 이름(없으면 화면이 첫 마디로 이름을 짓는다)
  forkedFrom?: string; // 포크한 원래 세션 id(포크에서 한 일이 여기로 공유된다)
  splitFrom?: string; // 분담한 원래 세션 id(원본과 분담이 서로 한 일을 주고받는다)
  splitLines?: number; // 분담할 때 원본 대화 줄 수 — 원본 → 분담 공유는 그 뒤부터(앞은 이미 이어받음)
  copiedFrom?: string; // 복사한 원래 세션 id(대화는 이어받지만 공유하지 않음)
  extraDirs?: string[]; // 작업 폴더 말고 더 연결한 폴더(절대 경로, 작업 폴더 뿌리 안)
  autoApprove?: boolean; // 권한 묻지 않기 — 도구 실행 권한을 사람에게 묻지 않고 허용한다
  title: string;
  workdir: string;
  requestedBy: string; // 대시보드 사용자 이름, 로컬이면 'local'
  via: 'local' | 'dashboard';
  createdAt: string; // ISO
  status: 'starting' | 'idle' | 'working' | 'ended';
}

// 호스트 → 화면
export type HostEvent =
  | { type: 'session.created'; session: SessionInfo }
  | { type: 'session.status'; sessionId: string; status: SessionInfo['status'] }
  | { type: 'session.ended'; sessionId: string; reason: string } // CLI 가 꺼짐. 작업은 대기로 남고 다음 지시 때 다시 띄운다
  | { type: 'session.halted'; sessionId: string; by: string } // 멈춤(■): 하던 차례만 멈춤
  | { type: 'user.message'; sessionId: string; text: string; from: string; attachments?: Attachment[] }
  | { type: 'agent.text'; sessionId: string; text: string; partial: boolean }
  // CLI 가 알려 준 쓸 수 있는 모델 목록 (ACP session/new 의 models) — 화면 드롭다운을 실제 목록으로 바꾼다
  | { type: 'agent.models'; sessionId: string; agent: AgentKind; models: ModelOption[]; current: string | null }
  | { type: 'agent.tool'; sessionId: string; toolId: string; name: string; input: unknown }
  | { type: 'agent.tool_result'; sessionId: string; toolId: string; ok: boolean; summary: string }
  | { type: 'permission.request'; sessionId: string; requestId: string; tool: string; detail: string }
  | { type: 'permission.resolved'; sessionId: string; requestId: string; allow: boolean; by: string }
  | { type: 'turn.done'; sessionId: string; durationMs: number; costUsd: number | null; isError: boolean }
  | { type: 'notice'; agent?: AgentKind; message: string }
  | { type: 'presets.changed' } // 프리셋이 바뀜(화면·메인 어디서든) — 설정 화면이 다시 읽는다
  | { type: 'schedules.changed' } // 예약이 바뀌거나 실행됨 — 작업 정보 패널이 다시 읽는다
  | { type: 'session.renamed'; sessionId: string; title: string }
  | { type: 'session.deleted'; sessionId: string }
  | { type: 'session.dirs'; sessionId: string; dirs: string[] }
  // 에이전트 설정을 바꿈 — 메인 CLI 를 새 설정으로 다시 띄웠다(바뀐 SessionInfo 전체)
  | { type: 'session.configured'; sessionId: string; session: SessionInfo }
  // 포크 공유: 포크의 답이 끝날 때마다 새로 생긴 대화를 원본 기록에 남긴다. 원본이 진행 중이면 다음 지시에 붙어 간다.
  // lines = 지금까지 공유한 포크 대화 줄 수(다음엔 그 뒤만). 이름은 기록 파일과 맞추려고 merged 그대로
  | { type: 'session.merged'; sessionId: string; fromId: string; title: string; text: string; lines: number; kind?: 'split' } // kind 없으면 포크 공유
  // 컨텍스트: 에이전트가 지금 들고 있는 양(used 토큰 / window 컨텍스트 창). 모르면 window 는 null. used 0 은 새로 띄워 아직 없음
  | { type: 'context.usage'; sessionId: string; used: number; window: number | null }
  // 컨텍스트에 호스트가 넣은 것: 앞 대화, 포크·분담 공유. pending 이면 다음 지시에 붙어 간다. 바뀔 때마다 전체 목록
  | { type: 'context.items'; sessionId: string; items: ContextItem[] }
  | { type: 'error'; sessionId?: string; agent?: AgentKind; message: string };

export interface ContextItem { label: string; chars: number; pending: boolean }

// 화면 → 호스트
export type ClientCommand =
  | { type: 'session.create'; agent: AgentKind; role: 'main' | 'direct'; model?: string; defaultWorker?: DefaultWorker; preset?: string; workPreset?: string; workdir?: string; title?: string }
  | { type: 'user.message'; sessionId: string; text: string; attachments?: Attachment[] }
  | { type: 'permission.respond'; sessionId: string; requestId: string; allow: boolean }
  | { type: 'session.stop'; sessionId: string }
  | { type: 'session.rename'; sessionId: string; title: string }
  | { type: 'session.fork'; sessionId: string; upTo?: number } // 같은 설정·폴더로 새 작업을 만들고 대화를 이어받는다. upTo: 사람 지시 몇 번째 차례까지(없으면 전부)
  | { type: 'session.copy'; sessionId: string } // 대화까지 가져가는 사본. 원본과 잇지 않는다(공유 없음)
  | { type: 'session.split'; sessionId: string } // 분담: 포크처럼 이어받고, 원본과 서로 한 일을 주고받는다(양쪽 공유)
  | { type: 'session.delete'; sessionId: string } // 목록에서 지운다(작업자 포함, 돌고 있으면 끝냄). 기록 파일은 남긴다
  | { type: 'session.dirs'; sessionId: string; dirs: string[] } // 연결 폴더 바꾸기(작업 폴더 뿌리 아래 폴더 이름들)
  // 에이전트 설정 바꾸기: null = 없앰(기본), 없음 = 그대로. 메인 CLI 를 새 설정으로 다시 띄우고 지금까지의 대화를 다음 지시에 붙인다
  | { type: 'session.configure'; sessionId: string; agent?: AgentKind; model?: string | null; preset?: string | null; workPreset?: string | null; autoApprove?: boolean }
  // 공용 PC 화면에 진짜 터미널 창을 띄운다 — PC 앞(local)에서만 허용
  | { type: 'terminal.open'; agent: AgentKind; sessionId?: string; workdir?: string; profile?: boolean }; // profile: Agent Hub 전용 프로필로 로그인

// 명령을 보낸 쪽 — 로그인·권한 확인은 대시보드가 하고, 호스트는 결과만 받는다.
export interface CommandOrigin {
  via: 'local' | 'dashboard';
  user: string;
  trusted?: boolean; // PC 앞과 같은 권한(원격 접속에서 "PC 앞과 같은 권한"을 켰을 때)
}

export const AGENTS: readonly AgentKind[] = ['claude', 'gemini', 'codex'];
/** 모델 이름은 CLI 인자로 넘어가므로 안전한 글자만 허용한다 (예: claude-sonnet-5-5, gpt-5.5-codex, gemini-3-pro). */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\-\/\[\]]{0,79}$/;

/** 첨부: 최대 10개, 경로는 반드시 첨부/ 아래(상위 이동 불가) */
function parseAttachments(v: unknown): Attachment[] | undefined {
  if (!Array.isArray(v) || !v.length) return undefined;
  const out: Attachment[] = [];
  for (const a of v.slice(0, 10)) {
    if (!a || typeof a !== 'object') continue;
    const { path, name, mime, size } = a as Record<string, unknown>;
    if (typeof path !== 'string' || !/^첨부[\\/][^\\/]+$/.test(path) || path.includes('..')) continue;
    out.push({
      path,
      name: typeof name === 'string' ? name.slice(0, 200) : path.slice(3),
      mime: typeof mime === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime : 'application/octet-stream',
      size: typeof size === 'number' && size >= 0 ? size : 0,
    });
  }
  return out.length ? out : undefined;
}

function parseDefaultWorker(v: unknown): DefaultWorker | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const { agent, model } = v as Record<string, unknown>;
  if (!AGENTS.includes(agent as AgentKind)) return undefined;
  return { agent: agent as AgentKind, ...(typeof model === 'string' && MODEL_RE.test(model) ? { model } : {}) };
}

/** 바깥에서 들어온 JSON을 명령으로 확인한다. 모르는 모양은 null. */
export function parseCommand(raw: unknown): ClientCommand | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const str = (v: unknown) => typeof v === 'string' && v.length > 0;
  switch (c.type) {
    case 'session.create':
      if (!AGENTS.includes(c.agent as AgentKind)) return null;
      return {
        type: 'session.create',
        agent: c.agent as AgentKind,
        role: c.role === 'main' ? 'main' : 'direct', // worker 는 메인만 만들 수 있다
        model: str(c.model) && MODEL_RE.test(c.model as string) ? (c.model as string) : undefined,
        defaultWorker: parseDefaultWorker(c.defaultWorker),
        preset: str(c.preset) ? (c.preset as string).slice(0, 80) : undefined, // 메인으로 쓸 에이전트(id 또는 이름)
        workPreset: str(c.workPreset) ? (c.workPreset as string).slice(0, 80) : undefined, // 작업 환경 프리셋(폴더·지침)
        workdir: str(c.workdir) ? (c.workdir as string) : undefined,
        title: str(c.title) ? (c.title as string) : undefined,
      };
    case 'user.message': {
      const attachments = parseAttachments(c.attachments);
      // 글 없이 첨부만 보내도 된다
      if (!str(c.sessionId) || (!str(c.text) && !attachments)) return null;
      return { type: 'user.message', sessionId: c.sessionId as string, text: str(c.text) ? (c.text as string) : '', ...(attachments ? { attachments } : {}) };
    }
    case 'permission.respond':
      if (!str(c.sessionId) || !str(c.requestId) || typeof c.allow !== 'boolean') return null;
      return { type: 'permission.respond', sessionId: c.sessionId as string, requestId: c.requestId as string, allow: c.allow };
    case 'session.stop':
      if (!str(c.sessionId)) return null;
      return { type: 'session.stop', sessionId: c.sessionId as string };
    case 'session.rename': {
      const title = typeof c.title === 'string' ? c.title.trim().slice(0, 80) : '';
      if (!str(c.sessionId) || !title) return null;
      return { type: 'session.rename', sessionId: c.sessionId as string, title };
    }
    case 'session.dirs': {
      if (!str(c.sessionId) || !Array.isArray(c.dirs)) return null;
      const dirs = (c.dirs as unknown[]).filter((d): d is string => typeof d === 'string' && d.length > 0 && d.length < 300).slice(0, 10);
      return { type: 'session.dirs', sessionId: c.sessionId as string, dirs };
    }
    case 'session.configure': {
      if (!str(c.sessionId)) return null;
      // 문자열 = 그 값, null = 없앰, 없음 = 그대로
      const opt = (v: unknown) => (v === null ? null : str(v) ? (v as string).slice(0, 80) : undefined);
      const out: ClientCommand = { type: 'session.configure', sessionId: c.sessionId as string };
      if (c.agent !== undefined) {
        if (!AGENTS.includes(c.agent as AgentKind)) return null;
        out.agent = c.agent as AgentKind;
      }
      for (const k of ['model', 'preset', 'workPreset'] as const) {
        const v = opt(c[k]);
        if (k === 'model' && typeof v === 'string' && !MODEL_RE.test(v)) return null;
        if (v !== undefined) out[k] = v;
      }
      if (typeof c.autoApprove === 'boolean') out.autoApprove = c.autoApprove;
      return out;
    }
    case 'session.fork': {
      if (!str(c.sessionId)) return null;
      const upTo = Number.isInteger(c.upTo) && (c.upTo as number) >= 0 ? (c.upTo as number) : undefined;
      return { type: 'session.fork', sessionId: c.sessionId as string, ...(upTo !== undefined ? { upTo } : {}) };
    }
    case 'session.copy':
    case 'session.split':
    case 'session.delete':
      if (!str(c.sessionId)) return null;
      return { type: c.type, sessionId: c.sessionId as string };
    case 'terminal.open':
      if (!AGENTS.includes(c.agent as AgentKind)) return null;
      return {
        type: 'terminal.open',
        agent: c.agent as AgentKind,
        sessionId: str(c.sessionId) ? (c.sessionId as string) : undefined,
        workdir: str(c.workdir) ? (c.workdir as string) : undefined,
        profile: c.profile === true,
      };
    default:
      return null;
  }
}
