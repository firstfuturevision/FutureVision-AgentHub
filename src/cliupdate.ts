import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { findCommand } from './install.ts';
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
export interface UpdateNote { tool: string; from: string; to: string; lines: string[]; at: string; source: string }
interface Saved { enabled: boolean; hour: number; lastCheck?: string; lastResult?: string; notes?: UpdateNote[] }
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
  /** 올린 뒤 시험 실행(Claude: 아주 작은 요청). 실패하면 되돌린다. 돌려준 값은 한도 정보로 쓴다 */
  smokeClaude?: () => Promise<unknown>;
  onLimits?: (info: unknown) => void;
  /** 바뀐 내용 가져오기(시험에서는 바꿔 끼운다) */
  fetchText?: (url: string) => Promise<string>;
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
        this.s = { enabled: raw.enabled !== false, hour: Number.isInteger(raw.hour) && raw.hour >= 0 && raw.hour <= 23 ? raw.hour : 5, lastCheck: raw.lastCheck, lastResult: raw.lastResult, notes: Array.isArray(raw.notes) ? raw.notes.slice(-5) : [] };
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
    // Claude Code: 제 업데이트 명령(설치 방식마다 맞게 받는다). 올린 뒤 시험 실행, 실패하면 이전 버전으로
    if (installed.claude?.installed) {
      const before = new Set(this.opts.currentModels().map((m) => m.name));
      const cmd = this.opts.claudeCommand;
      const oldVer = parseVersion(await run(cmd, ['--version'], 30_000).catch(() => ''));
      const link = findCommand(cmd);
      let oldTarget: string | null = null;
      try { if (link && lstatSync(link).isSymbolicLink()) oldTarget = readlinkSync(link); } catch {}
      try {
        const out = await run(cmd, ['update'], 5 * 60_000);
        const m = out.match(/from\s+(\d+\.\d+\.\d+)\s+to\s+(?:version\s+)?(\d+\.\d+\.\d+)/i);
        if (m) {
          try {
            const info = await (this.opts.smokeClaude ?? (async () => run(cmd, ['--version'], 30_000)))();
            if (info && typeof info === 'object') this.opts.onLimits?.(info);
            done.push(`Claude Code ${m[1]} → ${m[2]}`);
            await this.note('Claude Code', m[1], m[2], 'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md', 'changelog');
          } catch (err) {
            // 시험 실패 → 이전 버전으로(정식 설치는 versions/ 를 가리키는 링크만 되돌리고, 아니면 npm 으로 그 버전)
            let back = '';
            try {
              if (link && oldTarget && existsSync(oldTarget)) { unlinkSync(link); symlinkSync(oldTarget, link); back = '되돌림'; }
              else if (oldVer) { await run('npm', ['install', '-g', `${PACKAGES.claude[0]}@${oldVer}`], 5 * 60_000); back = '되돌림'; }
            } catch (e) { back = `되돌리기도 실패(${(e as Error).message.slice(0, 80)})`; }
            failed.push(`Claude Code ${m[2]} 시험 실패(${(err as Error).message.slice(0, 100)}) → ${oldVer ?? '이전'} ${back || '되돌리지 못함'}`);
          }
        }
        const after = await this.opts.refreshModels();
        const fresh = after.map((x) => x.name).filter((n) => !before.has(n));
        const gone = [...before].filter((n) => !after.some((x) => x.name === n));
        if (before.size && (fresh.length || gone.length)) this.opts.notify(`Claude 모델 목록이 바뀌었어요${fresh.length ? ` · 새로: ${fresh.join(', ')}` : ''}${gone.length ? ` · 없어짐: ${gone.join(', ')}` : ''}`);
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
          // 시험: 그 명령이 버전을 말하는지. 안 되면 이전 버전으로
          const bin = agent === 'gemini' ? 'gemini' : pkg.endsWith('codex-acp') ? 'codex-acp' : 'codex';
          try { await run(bin, ['--version'], 60_000); } catch (err) {
            await run('npm', ['install', '-g', `${pkg}@${cur}`], 5 * 60_000).catch(() => {});
            failed.push(`${pkg} ${latest} 시험 실패 → ${cur} 로 되돌림`);
            continue;
          }
          done.push(`${pkg} ${cur} → ${latest}`);
          const repo = agent === 'gemini' ? 'google-gemini/gemini-cli' : 'openai/codex';
          if (!pkg.endsWith('codex-acp')) await this.note(pkg, cur, latest, `https://api.github.com/repos/${repo}/releases/latest`, 'release');
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

  /** 바뀐 내용 요약: 올라간 버전 사이의 변경 기록에서 Agent Hub 에 영향 줄 만한 줄(모델·한도·옵션·권한·없어진 것)을 앞에, 8줄까지 */
  private async note(tool: string, from: string, to: string, url: string, kind: 'changelog' | 'release') {
    let lines: string[] = [];
    try {
      const fetchText = this.opts.fetchText ?? (async (u: string) => { const r = await fetch(u, { signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'agent-hub' } }); if (!r.ok) throw new Error(String(r.status)); return r.text(); });
      const text = await fetchText(url);
      if (kind === 'changelog') {
        // "## 2.1.300" 머리 아래 글머리표. from 보다 크고 to 이하인 버전만
        let take = false;
        for (const l of text.split('\n')) {
          const h = l.match(/^#{1,3}\s*v?(\d+\.\d+\.\d+)/);
          if (h) { take = olderThan(from, h[1]) && !olderThan(to, h[1]); continue; }
          if (take && /^\s*[-*]\s+/.test(l)) lines.push(l.replace(/^\s*[-*]\s+/, '').trim());
        }
      } else {
        const body = String((JSON.parse(text) as { body?: string }).body ?? '');
        lines = body.split('\n').filter((l) => /^\s*[-*]\s+/.test(l)).map((l) => l.replace(/^\s*[-*]\s+/, '').trim());
      }
    } catch { lines = []; }
    const hot = /model|모델|rate.?limit|usage|limit|--[a-z]|flag|option|permission|deprecat|remov|stream-json|mcp/i;
    const picked = [...lines.filter((l) => hot.test(l)), ...lines.filter((l) => !hot.test(l))].slice(0, 8).map((l) => l.slice(0, 200));
    const n: UpdateNote = { tool, from, to, lines: picked, at: new Date().toISOString(), source: url };
    this.s.notes = [...(this.s.notes ?? []), n].slice(-5);
    if (picked.length) this.opts.notify(`${tool} ${from} → ${to} 바뀐 점: ${picked.slice(0, 3).join(' / ')}${picked.length > 3 ? ' …(설정 → 연동)' : ''}`);
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.s, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
  }
}
