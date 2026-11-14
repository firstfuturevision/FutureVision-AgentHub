import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 연결마다 사용 한도(설정 → 연동). Claude Code 는 응답마다 stream-json 의 rate_limit_event 로
 * 한도 창(5시간·주간 등)의 사용률·다시 차는 때를 알려 준다(2.1.325 확인). 작업이 받을 때마다 로그인별로 모아 두고,
 * "지금 확인"은 그 로그인으로 아주 작은 요청(haiku, 한 단어)을 보내 바로 받는다.
 *  - 로그인 구분: default = 기본 로그인(계정 설정), agent = 에이전트 로그인(전용 프로필), apikey = API 키
 *  - API 키는 한도 창이 없어 Agent Hub 가 그 키로 쓴 금액(result 의 total_cost_usd)을 날마다 센다
 *  - Codex·Gemini 는 공식으로 알 길이 없어 "확인 불가"(쓴 차례 수만)
 */
export type Account = 'default' | 'agent' | 'apikey';
export interface LimitWindow { utilization: number | null; resetsAt: number | null; status: string }
export interface AccountLimits { at: string; status?: string; windows?: Record<string, LimitWindow>; overage?: string; turns?: number; costDay?: string; costUsd?: number }
type State = Record<string, AccountLimits>; // "claude:default" → …

export class LimitStore {
  private file: string;
  private s: State = {};
  private saving: NodeJS.Timeout | null = null;
  onChange?: () => void;

  constructor(file: string) {
    this.file = file;
    try { if (existsSync(file)) this.s = JSON.parse(readFileSync(file, 'utf8')) ?? {}; } catch {}
  }

  public() { return this.s; }

  /** rate_limit_event 의 rate_limit_info 를 받아 둔다 */
  record(agent: string, account: Account, info: any) {
    if (!info || typeof info !== 'object') return;
    const windows: Record<string, LimitWindow> = {};
    const uw = info.unifiedWindows && typeof info.unifiedWindows === 'object' ? info.unifiedWindows : {};
    for (const [k, w] of Object.entries<any>(uw)) windows[k] = { utilization: typeof w?.utilization === 'number' ? w.utilization : null, resetsAt: typeof w?.resetsAt === 'number' ? w.resetsAt : null, status: String(w?.status ?? '') };
    if (typeof info.rateLimitType === 'string' && !windows[info.rateLimitType]) windows[info.rateLimitType] = { utilization: typeof info.utilization === 'number' ? info.utilization : null, resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : null, status: String(info.status ?? '') };
    const key = `${agent}:${account}`;
    this.s[key] = { ...this.s[key], at: new Date().toISOString(), status: String(info.status ?? ''), windows: { ...this.s[key]?.windows, ...windows }, ...(info.overageStatus ? { overage: String(info.overageStatus) } : {}) };
    this.changed();
  }

  /** 차례 하나 끝: 쓴 차례 수, API 키면 오늘 쓴 금액 */
  turn(agent: string, account: Account, costUsd: number | null) {
    const key = `${agent}:${account}`;
    const day = new Date().toISOString().slice(0, 10);
    const e = { ...this.s[key], at: this.s[key]?.at ?? new Date().toISOString() };
    e.turns = (e.turns ?? 0) + 1;
    if (account === 'apikey' && typeof costUsd === 'number') {
      if (e.costDay !== day) { e.costDay = day; e.costUsd = 0; }
      e.costUsd = Math.round(((e.costUsd ?? 0) + costUsd) * 10000) / 10000;
    }
    this.s[key] = e;
    this.changed();
  }

  private changed() {
    this.onChange?.();
    if (this.saving) return;
    this.saving = setTimeout(() => {
      this.saving = null;
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        writeFileSync(`${this.file}.tmp`, JSON.stringify(this.s, null, 2));
        renameSync(`${this.file}.tmp`, this.file);
      } catch {}
    }, 2000);
    this.saving.unref?.();
  }
}

/** 그 로그인으로 아주 작은 요청을 보내 rate_limit_event 를 받는다(돈·한도를 아주 조금 쓴다) */
export function probeClaudeLimits(command: string, env: Record<string, string>, timeoutMs = 90_000): Promise<any> {
  return new Promise((ok, fail) => {
    const p = spawn(command, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'haiku'], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'], shell: process.platform === 'win32' && !/[\\/]/.test(command), windowsHide: true });
    let buf = '';
    let info: any = null;
    const timer = setTimeout(() => { p.kill(); fail(new Error('Claude CLI 가 답하지 않음')); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); fail(e); });
    p.stdout!.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try { const j = JSON.parse(line); if (j.type === 'rate_limit_event') info = j.rate_limit_info; } catch {}
      }
    });
    p.on('exit', () => { clearTimeout(timer); info ? ok(info) : fail(new Error('한도 정보를 받지 못함(API 키 연결이거나 옛 CLI)')); });
    p.stdin!.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'ok' } })}\n`);
  });
}
