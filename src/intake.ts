import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 입력 세션(설정 → 기억 → 입력 세션): 이 PC 에 하나. "입력 거치기"를 켠 작업에 사람이 쓴 지시는 그 작업 AI 로 바로 가지 않고 여기로 먼저 온다.
 * 입력 세션은 지시를 정리해(역할에 맞나·앞 지시·기억·사내 문서와 어긋나나·범위와 끝나는 조건) intake_forward 로 작업에 넘기거나,
 * 확인이 필요하면 intake_ask 로 그 작업 화면에 묻는다. 작업은 정리본과 사람 원문을 함께 받는다(잘못 정리해도 원문이 남게).
 */
export interface IntakeLog { at: string; state: 'forwarded' | 'asked' | 'routed'; request: string; taskId: string; task: string; target?: string; original: string; text: string }
interface Saved { model: string; sessionId?: string; recent?: IntakeLog[]; newTasksOn?: boolean }
export interface IntakeRequest { id: string; taskId: string; original: string; attachments?: { path: string; name: string; mime: string; size: number }[]; at: number; question?: string }

export const DEFAULT_INTAKE_MODEL = 'opus';

export class IntakeStore {
  private file: string;
  private s: Saved = { model: DEFAULT_INTAKE_MODEL };
  /** 아직 넘기지 않은 요청(id → 요청). 다시 켜면 사라진다 — 그때는 사람이 다시 보낸다 */
  pending = new Map<string, IntakeRequest>();
  private seq = 0;

  constructor(file: string) {
    this.file = file;
    try {
      if (existsSync(file)) {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        this.s = { model: typeof raw.model === 'string' && raw.model ? raw.model.slice(0, 80) : DEFAULT_INTAKE_MODEL, ...(typeof raw.sessionId === 'string' ? { sessionId: raw.sessionId } : {}), recent: Array.isArray(raw.recent) ? raw.recent.slice(-50) : [], newTasksOn: raw.newTasksOn === true };
      }
    } catch {}
  }

  get model() { return this.s.model; }
  /** 새 작업을 입력 거치기 켠 채로(처음 설치는 꺼짐 — 지시마다 한 번 더 거쳐 늦고 비용이 들어, 쓰는 사람이 켠다) */
  get newTasksOn() { return Boolean(this.s.newTasksOn); }
  setNewTasksOn(on: unknown) { if (typeof on === 'boolean') { this.s.newTasksOn = on; this.save(); } }
  get sessionId() { return this.s.sessionId; }
  public() { return { model: this.s.model, sessionId: this.s.sessionId ?? null, pending: this.pending.size, newTasksOn: this.newTasksOn, recent: [...(this.s.recent ?? [])].reverse() }; }

  /** 설정 → 입력에 보이는 최근 기록(넘김·물음, 50개까지) */
  log(x: Omit<IntakeLog, 'at'>) {
    this.s.recent = [...(this.s.recent ?? []), { ...x, at: new Date().toISOString(), original: x.original.slice(0, 2000), text: x.text.slice(0, 4000) }].slice(-50);
    this.save();
  }

  setModel(model: unknown) {
    const m = String(model ?? '').trim().slice(0, 80);
    if (!m) throw new Error('모델을 고르세요');
    this.s.model = m;
    this.save();
  }

  setSession(id: string | undefined) {
    if (id) this.s.sessionId = id;
    else delete this.s.sessionId;
    this.save();
  }

  add(r: Omit<IntakeRequest, 'id' | 'at'>): IntakeRequest {
    const id = `r${Date.now().toString(36)}${(this.seq++).toString(36)}`;
    const req = { ...r, id, at: Date.now() };
    this.pending.set(id, req);
    // 오래된 것은 버린다(하루)
    for (const [k, v] of this.pending) if (Date.now() - v.at > 86_400_000) this.pending.delete(k);
    return req;
  }

  /** 그 작업에서 질문하고 답을 기다리는 요청 */
  askingIn(taskId: string): IntakeRequest | undefined {
    return [...this.pending.values()].reverse().find((r) => r.taskId === taskId && r.question);
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.s, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
  }
}

/** 입력 세션이 받는 요청 글 */
export function intakePrompt(r: IntakeRequest, task: { name: string; about?: string; recent?: string; lastReport?: string; context?: string }, answerTo?: IntakeRequest): string {
  const lines = [
    `[입력 요청 ${r.id}] 작업 "${task.name}" 에 사람이 쓴 지시다. 바로 일하지 말고 정리해서 넘긴다.`,
    `작업 역할: ${task.about || '비어 있음(새 작업이면 지시만 보고 정리하고, 이미 있는 작업의 역할에 더 맞으면 intake_forward 의 session 에 그 작업 이름을 주어 그쪽으로 보낸다)'}`,
    ...(task.recent ? [`그 작업의 앞 지시: ${task.recent}`] : []),
    ...(task.lastReport ? [`그 작업의 마지막 보고(앞부분): ${task.lastReport}`] : []),
    ...(task.context ? [`그 작업의 컨텍스트: ${task.context}`] : []),
    ...(answerTo ? [`이 글은 앞 요청 ${answerTo.id} 에서 물은 것("${answerTo.question}")에 대한 사람의 답이다. 앞 원문: ${answerTo.original}`] : []),
    '',
    '[사람 원문]',
    r.original,
    ...(r.attachments?.length ? ['', '[첨부 — 작업 폴더 기준 경로]', ...r.attachments.map((a) => `- ${a.path}`)] : []),
    '',
    '할 일: (1) 무엇을 하려는지, 이 작업 역할에 맞는지 본다(아니면 session_list 의 역할을 보고 맞는 작업을 고른다) (2) 앞 지시·[기억]·[공통 지침]·사내 문서와 어긋나는지 본다 (3) 범위·할 일·끝나는 조건·지킬 규칙을 채워 지시를 구체화한다.',
    `그다음 intake_forward(request: "${r.id}", instruction, session?) 로 넘긴다. 확인 기준(되돌리기 어려움·돈·바깥 공개·앞 지시와 어긋남·뜻이 둘 이상)에 걸릴 때만 intake_ask(request: "${r.id}", question) 로 묻는다. 정리본은 짧게, 원문은 함께 가니 옮겨 적지 않는다.`,
    '넘기기 전에 정리(intake_forward 의 compact: true): 컨텍스트가 많이 찼고(대략 60% 넘음) 이번 지시가 앞 일과 이어지지 않는 새 일일 때만. 앞 일의 후속(고쳐 달라·이어서·방금 그거)이거나, 그 작업이 일하는 중·승인 대기이거나, 컨텍스트가 넉넉하거나 크기를 모르면 정리하지 않는다. 애매하면 정리하지 않는다. 다른 작업으로 보낼 때는 받는 작업 기준이다(session_list 의 context).',
  ];
  return lines.join('\n');
}

/** 작업이 받는 글: 정리본 + 사람 원문 */
export function forwardedText(instruction: string, original: string): string {
  return `[입력 세션이 정리한 지시]\n${instruction.trim()}\n\n[사람 원문]\n${original.trim()}`;
}
