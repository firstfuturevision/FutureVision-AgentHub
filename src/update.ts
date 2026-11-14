import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Agent Hub 업데이트 — 정한 레포에서 새 버전을 받아 다시 켠다.
 *  - 자동: 매일 정한 시각(기본 새벽 4시)에 확인하고 받는다. 진행 중인 작업이 없을 때 다시 켠다.
 *  - 수동: 매일 확인만 해서 "새 버전 있음"을 보여 주고, 받는 건 사람이 버튼으로.
 * 이 PC 에서 고친 파일이나 레포에 없는 커밋이 있으면 받지 않는다(덮어쓰지 않음). 앞으로만 감기(fast-forward)만 한다.
 * 레포 설정(origin 등)은 바꾸지 않는다 — 주소에서 바로 받아 refs/remotes/hub-update/<브랜치> 에 둔다.
 * 다시 켜기는 실행기(scripts/launch.mjs)로 띄웠을 때만 된다. 아니면 "다시 켜야 적용"만 알린다.
 */
export type UpdateMode = 'auto' | 'manual';
export type UpdateState = 'unknown' | 'latest' | 'available' | 'blocked' | 'notgit' | 'error' | 'ready';

export interface UpdatePublic {
  repo: string;
  defaultRepo: string;
  mode: UpdateMode;
  hour: number;
  state: UpdateState;
  message?: string;
  current?: string;
  latest?: string;
  behind?: number;
  lastCheck?: string;
  checking: boolean;
  canRestart: boolean;
  waiting: boolean; // 받아 두었고, 진행 중인 작업이 끝나길 기다려 다시 켠다
  codeChanged: boolean; // 켠 뒤로 서버 코드가 바뀜 — 다시 켜야 반영된다
  autoRestartCode: boolean; // 바뀐 코드면 작업이 모두 10분 쉴 때 저절로 다시 켠다
}

type Status = { state: UpdateState; message?: string; current?: string; latest?: string; behind?: number };
interface Saved { repo?: string; mode?: UpdateMode; hour?: number; lastCheck?: string; last?: Status }

const REPO_RE = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[A-Za-z0-9._\/-]+$/;
const REF_ROOT = 'refs/remotes/hub-update';

export class Updater {
  private root: string;
  private file: string;
  private defaultRepo: string;
  private gitEnv: () => Record<string, string>;
  private busy: () => boolean;
  private restart?: () => void;
  private saved: Saved = {};
  private st: Status = { state: 'unknown' };
  private running?: Promise<void>;
  private restartPending = false;
  private bootStamp: number; // 켤 때 서버 코드(src/, 실행기)의 마지막 수정 시각 — 그 뒤 바뀌었으면 "새 코드 있음"
  private stampCache?: { at: number; value: number };
  private onChange?: () => void;

  private autoRestartCode: boolean; // 서버 코드가 바뀌었고 모든 작업이 10분 넘게 쉬면 저절로 다시 켠다
  private idleSince?: number;

  constructor(opts: { root: string; file: string; defaultRepo: string; gitEnv?: () => Record<string, string>; busy?: () => boolean; restart?: () => void; onChange?: () => void; autoRestartCode?: boolean }) {
    this.root = resolve(opts.root);
    this.file = opts.file;
    this.defaultRepo = opts.defaultRepo;
    this.gitEnv = opts.gitEnv ?? (() => ({}));
    this.busy = opts.busy ?? (() => false);
    this.restart = opts.restart;
    this.bootStamp = codeStamp(opts.root);
    this.autoRestartCode = opts.autoRestartCode ?? true;
    this.onChange = opts.onChange;
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, 'utf8'));
        if (typeof raw?.repo === 'string' && REPO_RE.test(raw.repo)) this.saved.repo = raw.repo;
        if (raw?.mode === 'manual' || raw?.mode === 'auto') this.saved.mode = raw.mode;
        if (Number.isInteger(raw?.hour) && raw.hour >= 0 && raw.hour <= 23) this.saved.hour = raw.hour;
        if (typeof raw?.lastCheck === 'string') this.saved.lastCheck = raw.lastCheck;
        // 마지막 확인 결과를 되살린다. 받아 둔 업데이트는 다시 켜졌으니 최신
        if (raw?.last && typeof raw.last.state === 'string') this.st = raw.last.state === 'ready' ? { ...raw.last, state: 'latest', message: undefined } : raw.last;
      } catch {}
    }
  }

  get repo() { return this.saved.repo ?? this.defaultRepo; }
  get mode(): UpdateMode { return this.saved.mode ?? 'auto'; }
  get hour() { return this.saved.hour ?? 4; }

  public(): UpdatePublic {
    return {
      repo: this.repo,
      defaultRepo: this.defaultRepo,
      mode: this.mode,
      hour: this.hour,
      ...this.st,
      lastCheck: this.saved.lastCheck,
      checking: Boolean(this.running),
      canRestart: Boolean(this.restart),
      waiting: this.restartPending && Boolean(this.restart),
      codeChanged: this.codeChanged(),
      autoRestartCode: this.autoRestartCode,
    };
  }

  /** repo: 빈 문자열 = 기본 레포 */
  set(input: { repo?: unknown; mode?: unknown; hour?: unknown }) {
    const next = { ...this.saved };
    if (input.repo !== undefined) {
      const r = typeof input.repo === 'string' ? input.repo.trim().replace(/\/+$/, '') : '';
      if (r && !REPO_RE.test(r)) throw new Error('레포 주소 형식이 맞지 않음(https://github.com/조직/레포)');
      if (r && r !== this.defaultRepo) next.repo = r;
      else delete next.repo;
      if (next.repo !== this.saved.repo) this.st = { state: 'unknown' }; // 레포가 바뀌면 다시 확인
    }
    if (input.mode === 'auto' || input.mode === 'manual') next.mode = input.mode;
    if (input.hour !== undefined) {
      if (!Number.isInteger(input.hour) || (input.hour as number) < 0 || (input.hour as number) > 23) throw new Error('시각은 0~23');
      next.hour = input.hour as number;
    }
    this.saved = next;
    this.save();
  }

  private save() {
    this.saved.last = this.st.state === 'unknown' ? undefined : this.st;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.saved, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
  }

  private git(args: string[]): Promise<{ code: number; out: string; err: string }> {
    return new Promise((ok) => {
      execFile('git', ['-C', this.root, ...args], {
        env: { ...process.env, ...this.gitEnv(), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
        windowsHide: true,
        timeout: 120_000,
      }, (e, out, err) => ok({ code: e ? (typeof (e as any).code === 'number' ? (e as any).code : -1) : 0, out: String(out).trim(), err: String(err).trim() }));
    });
  }

  private once(fn: () => Promise<void>): Promise<void> {
    if (this.running) return this.running;
    this.running = fn().finally(() => {
      this.running = undefined;
      this.save(); // 확인 결과를 남긴다(다시 켜도 보이게)
      this.onChange?.();
    });
    this.onChange?.();
    return this.running;
  }

  /** 새 버전이 있는지만 본다 */
  check(): Promise<void> {
    return this.once(() => this.doCheck());
  }

  /** 새 버전을 받고, 받았으면 다시 켤 준비 */
  apply(): Promise<void> {
    return this.once(async () => {
      const ref = await this.doCheck();
      if (this.st.state !== 'available' || !ref) return;
      const m = await this.git(['merge', '--ff-only', ref]);
      if (m.code !== 0) {
        this.st = { ...this.st, state: 'blocked', message: `받지 못함: ${lastLine(m.err) || '앞으로 감기 불가'}` };
        return;
      }
      const current = (await this.git(['rev-parse', '--short', 'HEAD'])).out;
      this.st = { state: 'ready', current, latest: current, behind: 0, message: `${this.st.behind}개 받음` };
      this.restartPending = true;
    }).then(() => this.maybeRestart());
  }

  private async doCheck(): Promise<string | undefined> {
    this.saved.lastCheck = new Date().toISOString();
    this.save();
    const top = await this.git(['rev-parse', '--show-toplevel']);
    if (top.code !== 0 || resolve(top.out).toLowerCase() !== this.root.toLowerCase()) {
      this.st = { state: 'notgit', message: '이 폴더는 레포에서 받은(git clone) 폴더가 아님' };
      return;
    }
    const head = await this.git(['ls-remote', '--symref', this.repo, 'HEAD']);
    if (head.code !== 0) {
      this.st = { state: 'error', message: `레포에 닿지 못함: ${lastLine(head.err)}` };
      return;
    }
    const branch = head.out.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m)?.[1] ?? 'main';
    const ref = `${REF_ROOT}/${branch}`;
    const f = await this.git(['fetch', '--no-tags', '--quiet', this.repo, `+refs/heads/${branch}:${ref}`]);
    if (f.code !== 0) {
      this.st = { state: 'error', message: `받아오지 못함: ${lastLine(f.err)}` };
      return;
    }
    const current = (await this.git(['rev-parse', '--short', 'HEAD'])).out || undefined;
    const latest = (await this.git(['rev-parse', '--short', ref])).out || undefined;
    const behind = Number((await this.git(['rev-list', '--count', `HEAD..${ref}`])).out) || 0;
    const ahead = Number((await this.git(['rev-list', '--count', `${ref}..HEAD`])).out) || 0;
    const dirty = (await this.git(['status', '--porcelain', '--untracked-files=no'])).out;
    const base = { current, latest, behind };
    if (this.st.state === 'ready' && behind === 0) return ref; // 받았고 다시 켜기를 기다리는 중
    if (behind === 0) this.st = { ...base, state: 'latest' };
    else if (ahead > 0) this.st = { ...base, state: 'blocked', message: '이 PC 에 레포에 없는 커밋이 있어 받지 않음' };
    else if (dirty) this.st = { ...base, state: 'blocked', message: '이 PC 에서 고친 파일이 있어 받지 않음' };
    else this.st = { ...base, state: 'available' };
    return ref;
  }

  /** 켠 뒤로 이 폴더의 서버 코드가 바뀌었나(이 PC 에서 고치거나 git 으로 받은 것). 화면 코드(ui/)는 새로 고침이면 되므로 보지 않는다 */
  codeChanged(): boolean {
    const now = Date.now();
    if (!this.stampCache || now - this.stampCache.at > 10_000) this.stampCache = { at: now, value: codeStamp(this.root) };
    return this.stampCache.value > this.bootStamp;
  }

  /** 바뀐 코드로 다시 켠다: now 면 바로, 아니면 진행 중인 작업이 끝난 뒤(1분마다 확인) */
  restartForCode(now: boolean): boolean {
    if (!this.restart || !this.codeChanged()) return false;
    this.restartPending = true;
    if (now) this.restartNow();
    else this.maybeRestart();
    this.onChange?.();
    return true;
  }

  /** 받아 둔 업데이트로 지금 다시 켠다(진행 중인 작업이 있어도 — 대화는 다시 켠 뒤 이어진다) */
  restartNow() {
    if (!this.restartPending || !this.restart) return;
    this.restartPending = false;
    this.restart();
  }

  /** 받아 둔 업데이트가 있고, 진행 중인 작업이 없으면 다시 켠다 */
  maybeRestart() {
    if (this.restartPending && this.restart && !this.busy()) {
      this.restartPending = false;
      this.restart();
    }
  }

  /** 마지막으로 지난 "정한 시각" */
  lastSlot(now: Date): Date {
    const d = new Date(now);
    d.setHours(this.hour, 0, 0, 0);
    if (d > now) d.setDate(d.getDate() - 1);
    return d;
  }

  /** 1분마다 부른다. 정한 시각이 지났는데 그 뒤로 확인한 적이 없으면 확인(자동이면 받기까지) */
  async tick(now = new Date()) {
    const last = this.saved.lastCheck ? new Date(this.saved.lastCheck) : undefined;
    if (!this.running && (!last || last < this.lastSlot(now))) {
      if (this.mode === 'auto') await this.apply();
      else await this.check();
    }
    // 바뀐 서버 코드: 작업이 모두 10분 넘게 쉬면 다시 켠다(이 PC 에서 고치는 동안 옛 서버로 남지 않게)
    if (this.autoRestartCode && this.restart && this.codeChanged()) {
      if (this.busy()) this.idleSince = undefined;
      else if ((this.idleSince ??= now.getTime()) && now.getTime() - this.idleSince >= IDLE_RESTART_MS) this.restartPending = true;
    }
    this.maybeRestart();
  }
}

const IDLE_RESTART_MS = 10 * 60_000;

/** 서버 코드의 마지막 수정 시각(ms): src/ 아래 모든 파일과 실행기 */
export function codeStamp(root: string): number {
  let max = 0;
  const walk = (dir: string) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      const p = join(dir, n);
      try {
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else if (st.mtimeMs > max) max = st.mtimeMs;
      } catch {}
    }
  };
  walk(join(root, 'src'));
  for (const f of ['scripts/launch.mjs', 'package.json']) try { max = Math.max(max, statSync(join(root, f)).mtimeMs); } catch {}
  return max;
}

function lastLine(s: string) {
  return s.split('\n').filter(Boolean).pop() ?? '';
}
