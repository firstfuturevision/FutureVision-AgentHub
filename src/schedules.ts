import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * 예약 — 작업 하나에 걸어 두는 "정한 시각에 이 지시를 보내기".
 * 시각은 이 PC 의 현지 시간. JSON 파일 하나로 저장(의존성 없음).
 *  - once     : 날짜·시각 한 번
 *  - daily    : 매일 그 시각
 *  - weekdays : 월~금 그 시각
 *  - weekly   : 매주 그 요일 그 시각
 *  - interval : 저장한 때부터 N분마다(5분~7일). 그때 작업이 아직 일하는 중이면 그 차례는 건너뛴다(지시가 쌓이지 않게)
 * 실행할 때 작업이 진행 중이면 그 작업에 보내고, 끝났으면 포크해서(앞 대화 이어받음) 보낸다.
 * 포크했으면 예약도 새 작업으로 옮겨 간다 — 예약은 작업을 따라간다.
 * 호스트가 꺼져 있던 동안 지난 시각은 몰아서 실행하지 않고 건너뛴다.
 */
export type Repeat = 'once' | 'daily' | 'weekdays' | 'weekly' | 'interval';

export interface Schedule {
  id: string;
  sessionId: string;
  prompt: string;
  repeat: Repeat;
  time: string; // HH:MM
  date?: string; // once: YYYY-MM-DD
  weekday?: number; // weekly: 0=일 … 6=토
  every?: number; // interval: 몇 분마다
  enabled: boolean;
  nextAt: string | null; // 다음 실행 시각(ISO). 없으면 더 실행하지 않음
  lastAt?: string;
  lastResult?: string; // 마지막 실행 결과 한 줄
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REPEATS: Repeat[] = ['once', 'daily', 'weekdays', 'weekly', 'interval'];
export const MIN_EVERY = 5; // 분 — 이보다 잦으면 에이전트에게 지시가 쌓인다
const MAX_EVERY = 7 * 24 * 60;

/** from 보다 뒤의 다음 실행 시각. 없으면 null(지난 한 번짜리) */
export function nextRun(s: Pick<Schedule, 'repeat' | 'time' | 'date' | 'weekday' | 'every'>, from: Date): Date | null {
  if (s.repeat === 'interval') return new Date(from.getTime() + (s.every ?? 60) * 60_000);
  const [h, m] = s.time.split(':').map(Number);
  if (s.repeat === 'once') {
    const [y, mo, d] = (s.date ?? '').split('-').map(Number);
    const at = new Date(y, mo - 1, d, h, m, 0, 0);
    return at.getTime() > from.getTime() ? at : null;
  }
  for (let i = 0; i < 8; i++) {
    const at = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, h, m, 0, 0);
    if (at.getTime() <= from.getTime()) continue;
    const wd = at.getDay();
    if (s.repeat === 'weekdays' && (wd === 0 || wd === 6)) continue;
    if (s.repeat === 'weekly' && wd !== s.weekday) continue;
    return at;
  }
  return null;
}

export class ScheduleStore {
  private file: string;
  private items: Schedule[] = [];

  constructor(file: string, now = new Date()) {
    this.file = file;
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        this.items = Array.isArray(raw) ? (raw.map((s) => validate(s, s?.id)).filter(Boolean) as Schedule[]) : [];
      } catch {
        this.items = [];
      }
    }
    // 꺼져 있던 동안 지난 시각은 건너뛰고 다음 시각으로
    let changed = false;
    for (const s of this.items) {
      if (s.nextAt && Date.parse(s.nextAt) <= now.getTime()) {
        s.nextAt = s.enabled ? (nextRun(s, now)?.toISOString() ?? null) : s.nextAt;
        if (s.enabled) {
          s.lastResult = '호스트가 꺼져 있어 건너뜀';
          changed = true;
        }
      }
    }
    if (changed) this.flush();
  }

  list(): Schedule[] {
    return this.items.map((s) => ({ ...s }));
  }

  forSession(sessionId: string): Schedule[] {
    return this.list().filter((s) => s.sessionId === sessionId);
  }

  /** 새로 만들거나(id 없음) 고친다 */
  save(input: unknown, now = new Date()): Schedule {
    const existing = typeof (input as any)?.id === 'string' ? this.items.find((s) => s.id === (input as any).id) : undefined;
    const s = validate({ ...existing, ...(input as object) }, existing?.id ?? randomUUID().slice(0, 8), true)!;
    s.nextAt = s.enabled ? (nextRun(s, now)?.toISOString() ?? null) : null;
    if (s.enabled && !s.nextAt) throw new Error('이미 지난 시각');
    if (existing) {
      s.lastAt = existing.lastAt;
      s.lastResult = existing.lastResult;
    }
    this.items = existing ? this.items.map((x) => (x.id === s.id ? s : x)) : [...this.items, s];
    this.flush();
    return { ...s };
  }

  remove(id: string) {
    const n = this.items.length;
    this.items = this.items.filter((s) => s.id !== id);
    if (this.items.length !== n) this.flush();
  }

  removeForSession(sessionId: string) {
    const n = this.items.length;
    this.items = this.items.filter((s) => s.sessionId !== sessionId);
    if (this.items.length !== n) this.flush();
  }

  /** now 기준으로 실행할 차례가 된 것 */
  due(now: Date): Schedule[] {
    return this.list().filter((s) => s.enabled && s.nextAt && Date.parse(s.nextAt) <= now.getTime());
  }

  /** 실행 기록. 작업이 포크됐으면 sessionId 를 새 작업으로 옮긴다. 한 번짜리는 끝나면 꺼진다. */
  markRun(id: string, at: Date, result: string, sessionId?: string) {
    const s = this.items.find((x) => x.id === id);
    if (!s) return;
    s.lastAt = at.toISOString();
    s.lastResult = result;
    if (sessionId) s.sessionId = sessionId;
    s.nextAt = nextRun(s, at)?.toISOString() ?? null;
    if (!s.nextAt) s.enabled = false;
    this.flush();
  }

  /**
   * 같은 시각에 몰린 예약을 10분씩 나눈다. 시각마다 처음 것은 그대로 두고, 나머지는 비어 있는 다음 10분 자리로 옮긴다.
   * 간격 예약과 꺼진 예약은 그대로. 옮긴 예약 목록을 돌려준다
   */
  spread(stepMin = 10): Schedule[] {
    const on = this.items.filter((x) => x.enabled && x.repeat !== 'interval' && x.time);
    const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    const toTime = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const used = new Set(on.map((x) => toMin(x.time!)));
    const seen = new Set<number>();
    const moved: Schedule[] = [];
    for (const x of [...on].sort((a, b) => toMin(a.time!) - toMin(b.time!))) {
      const m = toMin(x.time!);
      if (!seen.has(m)) { seen.add(m); continue; }
      let n = m + stepMin;
      while (used.has(n % 1440)) n += stepMin;
      used.add(n % 1440);
      seen.add(n % 1440);
      moved.push(this.save({ ...x, time: toTime(n % 1440) }));
    }
    return moved;
  }

  /** 실행한 차례가 끝난 뒤 결과만 고친다(다음 실행 시각은 그대로) */
  markResult(id: string, result: string) {
    const s = this.items.find((x) => x.id === id);
    if (!s) return;
    s.lastResult = result.slice(0, 200);
    this.flush();
  }

  private flush() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.items, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
  }
}

function validate(v: any, id: string, strict = false): Schedule | null {
  const fail = (m: string) => {
    if (strict) throw new Error(m);
    return null;
  };
  if (!v || typeof v !== 'object') return fail('예약 형식이 맞지 않음');
  const sessionId = typeof v.sessionId === 'string' ? v.sessionId : '';
  if (!sessionId) return fail('작업이 없음');
  const prompt = typeof v.prompt === 'string' ? v.prompt.trim().slice(0, 4000) : '';
  if (!prompt) return fail('보낼 지시를 적어 주세요');
  if (!REPEATS.includes(v.repeat)) return fail('반복은 한 번·매일·평일·매주·간격 중 하나');
  const interval = v.repeat === 'interval';
  if (!interval && (typeof v.time !== 'string' || !TIME_RE.test(v.time))) return fail('시각은 HH:MM');
  const out: Schedule = {
    id,
    sessionId,
    prompt,
    repeat: v.repeat,
    time: interval ? '' : v.time,
    enabled: v.enabled !== false,
    nextAt: typeof v.nextAt === 'string' ? v.nextAt : null,
    ...(typeof v.lastAt === 'string' ? { lastAt: v.lastAt } : {}),
    ...(typeof v.lastResult === 'string' ? { lastResult: v.lastResult.slice(0, 200) } : {}),
  };
  if (v.repeat === 'once') {
    if (typeof v.date !== 'string' || !DATE_RE.test(v.date) || Number.isNaN(Date.parse(v.date))) return fail('날짜는 YYYY-MM-DD');
    out.date = v.date;
  }
  if (interval) {
    const every = Number(v.every);
    if (!Number.isInteger(every) || every < MIN_EVERY || every > MAX_EVERY) return fail(`간격은 ${MIN_EVERY}분 이상, 7일 이하`);
    out.every = every;
  }
  if (v.repeat === 'weekly') {
    const wd = Number(v.weekday);
    if (!Number.isInteger(wd) || wd < 0 || wd > 6) return fail('요일을 골라 주세요');
    out.weekday = wd;
  }
  return out;
}
