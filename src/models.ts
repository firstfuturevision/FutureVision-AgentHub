import { spawn, execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ModelOption } from './protocol.ts';

/**
 * Claude 모델 목록·CLI 버전 — 코드에 고정해 두면 새 모델(예: Fable 5.2)이 나와도 안 보인다.
 *  - 모델: Claude Code CLI 에게 직접 묻는다(stream-json 의 control_request initialize → 응답의 models). 토큰을 쓰지 않는다.
 *    CLI 가 모르는 모델은 띄워도 "unrecognized_model" 로 거절되므로, CLI 가 아는 목록이 곧 쓸 수 있는 목록이다.
 *  - 버전: `claude --version` 과 npm 의 최신(@anthropic-ai/claude-code)을 견주어 새 버전이 있으면 연동에 업데이트 버튼(`claude update`).
 *  - 켤 때와 6시간마다 다시 묻고 data/claude-models.json 에 둔다(다음에 켤 때 바로 쓰게).
 */
export interface ClaudeCliState { models: ModelOption[]; version: string | null; latest: string | null; outdated: boolean; checkedAt: string | null; checking: boolean; error: string | null }

/** Windows 에서 이름만 준 명령(claude → claude.cmd)은 셸로. 경로를 준 명령은 셸 없이(경로의 빈칸이 깨지지 않게) */
const needShell = (cmd: string) => process.platform === 'win32' && !/[\\/]/.test(cmd);

/** "2.1.283 (Claude Code)" → "2.1.283" */
export const parseVersion = (s: string) => s.match(/\d+\.\d+\.\d+/)?.[0] ?? null;

/** a < b 인가(점으로 나눈 숫자 비교) */
export function olderThan(a: string, b: string): boolean {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  }
  return false;
}

/** CLI 의 initialize 응답 models → 화면 목록("default" 는 Agent Hub 의 "기본"과 겹쳐 뺀다) */
export function toOptions(models: unknown): ModelOption[] {
  if (!Array.isArray(models)) return [];
  return models
    .filter((m: any) => typeof m?.value === 'string' && m.value && m.value !== 'default')
    .map((m: any) => ({ id: m.value, name: typeof m.displayName === 'string' && m.displayName ? m.displayName : m.value }));
}

/** Claude CLI 에게 아는 모델을 묻는다 */
export function askClaudeModels(command: string, timeoutMs = 25000, prefix: string[] = []): Promise<ModelOption[]> {
  return new Promise((resolve, reject) => {
    const p = spawn(command, [...prefix, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], { shell: needShell(command), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let buf = '';
    const done = (err: Error | null, v?: ModelOption[]) => {
      clearTimeout(timer);
      try { p.stdin?.end(); p.kill(); } catch {}
      err ? reject(err) : resolve(v!);
    };
    const timer = setTimeout(() => done(new Error('Claude CLI 가 답하지 않음')), timeoutMs);
    p.on('error', (e) => done(e));
    p.on('exit', () => done(new Error('Claude CLI 가 모델 목록을 알려 주지 않고 끝남')));
    p.stdout!.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const j = JSON.parse(line);
          if (j.type === 'control_response' && (j.response?.request_id === 'agenthub-models' || j.request_id === 'agenthub-models')) {
            const r = j.response?.response ?? j.response;
            return done(null, toOptions(r?.models));
          }
        } catch {}
      }
    });
    p.stdin!.on('error', () => {});
    p.stdin!.write(JSON.stringify({ type: 'control_request', request_id: 'agenthub-models', request: { subtype: 'initialize' } }) + '\n');
  });
}

const run = (cmd: string, args: string[], timeout = 20000) => new Promise<string>((ok, fail) => {
  execFile(cmd, args, { shell: needShell(cmd), timeout, windowsHide: true }, (err, stdout) => (err ? fail(err) : ok(String(stdout))));
});

export class ClaudeCli {
  private file: string;
  private command: string;
  private prefix: string[];
  private latestOf: () => Promise<string | null>;
  private st: ClaudeCliState;
  private running: Promise<void> | null = null;
  onModels?: (models: ModelOption[]) => void;

  /** 시험용: prefix = 명령 앞에 붙일 인자(가짜 CLI 스크립트), latest = npm 최신 버전 묻기 대신 */
  constructor(opts: { command: string; file: string; prefix?: string[]; latest?: () => Promise<string | null> }) {
    this.command = opts.command;
    this.prefix = opts.prefix ?? [];
    this.latestOf = opts.latest ?? (() => run('npm', ['view', '@anthropic-ai/claude-code', 'version']).then(parseVersion));
    this.file = opts.file;
    let saved: Partial<ClaudeCliState> = {};
    try { if (existsSync(this.file)) saved = JSON.parse(readFileSync(this.file, 'utf8')); } catch {}
    this.st = {
      models: Array.isArray(saved.models) ? saved.models : [],
      version: saved.version ?? null,
      latest: saved.latest ?? null,
      outdated: false,
      checkedAt: saved.checkedAt ?? null,
      checking: false,
      error: null,
    };
    this.st.outdated = Boolean(this.st.version && this.st.latest && olderThan(this.st.version, this.st.latest));
  }

  get models() { return this.st.models; }
  public(): ClaudeCliState { return { ...this.st, checking: Boolean(this.running) }; }

  /** 다시 묻기(돌고 있으면 그것을 기다린다) */
  refresh(): Promise<void> {
    if (!this.running) {
      this.running = (async () => {
        const [models, version, latest] = await Promise.allSettled([
          askClaudeModels(this.command, 25000, this.prefix),
          run(this.command, [...this.prefix, '--version']).then(parseVersion),
          this.latestOf(),
        ]);
        if (models.status === 'fulfilled' && models.value.length) {
          this.st.models = models.value;
          this.onModels?.(models.value);
        }
        this.st.version = version.status === 'fulfilled' ? version.value : this.st.version;
        this.st.latest = latest.status === 'fulfilled' ? latest.value ?? this.st.latest : this.st.latest;
        this.st.outdated = Boolean(this.st.version && this.st.latest && olderThan(this.st.version, this.st.latest));
        this.st.error = models.status === 'rejected' ? (models.reason as Error).message : null;
        this.st.checkedAt = new Date().toISOString();
        try {
          mkdirSync(dirname(this.file), { recursive: true });
          const { models: m, version: v, latest: l, checkedAt } = this.st;
          writeFileSync(`${this.file}.tmp`, JSON.stringify({ models: m, version: v, latest: l, checkedAt }, null, 2));
          renameSync(`${this.file}.tmp`, this.file);
        } catch {}
      })().finally(() => { this.running = null; });
    }
    return this.running;
  }
}
