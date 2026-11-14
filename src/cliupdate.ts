import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentKind, ModelOption } from './protocol.ts';
import { PACKAGES } from './install.ts';
import { olderThan, parseVersion } from './models.ts';

/**
 * 작업자 프로그램 자동 업데이트(왼쪽 "예약" 맨 위) — Claude Code·Gemini CLI·Codex 새 버전을 하루 한 번 확인해 올린다.
 *  - 정한 시각(기본 05:00, Agent Hub 자기 업데이트 04:00 다음)이 지나면, 작업이 모두 쉴 때 한 번(자기 업데이트와 같은 방식). 하던 일은 끊지 않는다.
 *  - Claude Code 는 `claude update`(제 설치 방식대로), Gemini·Codex 는 설치돼 있을 때만 npm 최신과 견주어 `npm install -g`.
 *  - 올린 뒤 Claude 모델 목록을 다시 받고, 새 모델이 생기면 알린다. 실패하면 그대로 두고 알린다(설치 프로그램이 옛 버전을 지우지 않는다).
 *  - PC 마다 자기 것을 확인한다(연결된 PC 는 각자).
 */
type Run = (cmd: string, args: string[], timeoutMs: number) => Promise<string>;
interface Saved { enabled: boolean; hour: number; lastCheck?: string; lastResult?: string }
export interface CliUpdaterOptions {
  file: string;
  claudeCommand: string;
  /** 모델 목록 다시 받기(그 뒤의 목록) */
  refreshModels: () => Promise<ModelOption[]>;
  currentModels: () => ModelOption[];
  installed: () => Record<AgentKind, { installed: boolean }>;
  busy: () => boolean;
  notify: (message: string) => void;
  run?: Run;
}

const defaultRun: Run = (cmd, args, timeout) => new Promise((ok, fail) => {
  const shell = process.platform === 'win32' && !/[\\/]/.test(cmd);
  execFile(cmd, args, { shell, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => (err ? fail(new Error(`${String(stderr || err.message).trim().split('\n').slice(-2).join(' ')}`)) : ok(`${stdout}\n${stderr}`)));
});

export class CliUpdater {
  private file: string;
  private s: Saved = { enabled: true, hour: 5 };
  private running: Promise<string> | null = null;
  private opts: CliUpdaterOptions;

  constructor(opts: CliUpdaterOptions) {
    this.opts = opts;
    this.file = opts.file;
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8'));
        this.s = { enabled: raw.enabled !== false, hour: Number.isInteger(raw.hour) && raw.hour >= 0 && raw.hour <= 23 ? raw.hour : 5, lastCheck: raw.lastCheck, lastResult: raw.lastResult };
      }
    } catch {}
  }

  public() { return { ...this.s, running: Boolean(this.running) }; }

  set(v: { enabled?: unknown; hour?: unknown }) {
    if (typeof v.enabled === 'boolean') this.s.enabled = v.enabled;
    if (v.hour !== undefined) {
      if (!Number.isInteger(v.hour) || (v.hour as number) < 0 || (v.hour as number) > 23) throw new Error('시각은 0~23');
      this.s.hour = v.hour as number;
    }
    this.save();
  }

  /** 마지막으로 지난 "정한 시각" */
  private lastSlot(now: Date) {
    const d = new Date(now);
    d.setHours(this.s.hour, 0, 0, 0);
    if (d > now) d.setDate(d.getDate() - 1);
    return d;
  }

  /** 1분마다: 켜져 있고, 정한 시각 뒤로 아직 안 했고, 모두 쉬고 있으면 한다 */
  async tick(now = new Date()) {
    if (!this.s.enabled || this.running || this.opts.busy()) return;
    const last = this.s.lastCheck ? new Date(this.s.lastCheck) : undefined;
    if (last && last >= this.lastSlot(now)) return;
    await this.check(now);
  }

  /** 지금 확인하고 올리기(사람이 "지금 확인"을 누를 때도) */
  check(now = new Date()): Promise<string> {
    if (!this.running) this.running = this.doCheck(now).finally(() => { this.running = null; });
    return this.running;
  }

  private async doCheck(now: Date): Promise<string> {
    const run = this.opts.run ?? defaultRun;
    const done: string[] = [];
    const failed: string[] = [];
    const installed = this.opts.installed();
    // Claude Code: 제 업데이트 명령(설치 방식마다 맞게 받는다)
    if (installed.claude?.installed) {
      const before = new Set(this.opts.currentModels().map((m) => m.name));
      try {
        const out = await run(this.opts.claudeCommand, ['update'], 5 * 60_000);
        const m = out.match(/from\s+(\d+\.\d+\.\d+)\s+to\s+(?:version\s+)?(\d+\.\d+\.\d+)/i);
        if (m) done.push(`Claude Code ${m[1]} → ${m[2]}`);
        const after = await this.opts.refreshModels();
        const fresh = after.map((x) => x.name).filter((n) => !before.has(n));
        if (fresh.length && before.size) this.opts.notify(`새 Claude 모델을 고를 수 있어요: ${fresh.join(', ')}`);
      } catch (err) { failed.push(`Claude Code(${(err as Error).message.slice(0, 120)})`); }
    }
    // Gemini·Codex: npm 으로 깐 것만, 최신보다 옛것이면
    for (const agent of ['gemini', 'codex'] as AgentKind[]) {
      if (!installed[agent]?.installed) continue;
      for (const pkg of PACKAGES[agent]) {
        try {
          const latest = parseVersion(await run('npm', ['view', pkg, 'version'], 60_000));
          const ls = await run('npm', ['ls', '-g', pkg, '--depth=0', '--json'], 60_000).catch((e) => String((e as Error).message));
          const cur = parseVersion((ls.match(new RegExp(`"${pkg.replace(/[/@]/g, (c) => `\\${c}`)}"\\s*:\\s*\\{[^}]*"version"\\s*:\\s*"([^"]+)"`)) ?? [])[1] ?? '');
          if (!latest || !cur || !olderThan(cur, latest)) continue; // npm 으로 안 깔았거나 최신
          await run('npm', ['install', '-g', `${pkg}@latest`], 5 * 60_000);
          done.push(`${pkg} ${cur} → ${latest}`);
        } catch (err) { failed.push(`${pkg}(${(err as Error).message.slice(0, 120)})`); }
      }
    }
    const result = [done.length ? `올림: ${done.join(', ')}` : '새 버전 없음', ...(failed.length ? [`실패(그대로 둠): ${failed.join(', ')}`] : [])].join(' · ');
    this.s.lastCheck = now.toISOString();
    this.s.lastResult = result;
    this.save();
    if (done.length || failed.length) this.opts.notify(`작업자 프로그램 업데이트 — ${result}`);
    return result;
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.s, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
  }
}
