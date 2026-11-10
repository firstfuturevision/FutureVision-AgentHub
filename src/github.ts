import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { findCommand } from './install.ts';

/**
 * 연동의 GitHub — GitHub CLI(gh) 로 회사 계정에 로그인한다.
 * 로그인 정보는 Agent Hub 전용 폴더(data/profiles/gh, GH_CONFIG_DIR)에만 둔다. 이 PC 사람의 개인 gh 설정과 섞이지 않는다.
 * Agent Hub 가 띄우는 세션에만 GH_CONFIG_DIR 과 git 자격 증명(gh) 을 환경 변수로 넣는다. 전역 git 설정은 건드리지 않는다.
 * 토큰은 gh 가 저장하고, 화면에는 계정 이름만 보낸다.
 */
export interface GitHubStatus { installed: boolean; version?: string; login?: string; error?: string; pending?: { code: string; url: string } }

/** gh 가 PATH 에 없을 때 찾아볼 곳(방금 설치해 서버의 PATH 에 아직 없는 경우) */
const KNOWN = process.platform === 'win32'
  ? [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'GitHub CLI', 'gh.exe'), join(process.env.LOCALAPPDATA ?? '', 'Programs', 'GitHub CLI', 'gh.exe')]
  : ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'];

/** 리눅스: 있는 패키지 관리자로. 관리자 비밀번호(sudo)는 열린 터미널 창에서 사람이 넣는다 */
export function linuxGhInstall(has: (cmd: string) => boolean): string {
  if (has('apt-get')) return 'sudo apt-get update && sudo apt-get install -y gh';
  if (has('dnf')) return 'sudo dnf install -y gh';
  if (has('pacman')) return 'sudo pacman -S --needed github-cli';
  if (has('zypper')) return 'sudo zypper install -y gh';
  if (has('brew')) return 'brew install gh';
  throw new Error('패키지 관리자를 찾지 못함. https://cli.github.com 에서 설치해 주세요');
}

export class GitHub {
  readonly configDir: string;
  private cmd: string[]; // 시험용으로 바꿀 수 있다(예: node fake-gh.mjs)
  private known: string[];
  private pending?: { child: ChildProcess; code?: string; url?: string };

  constructor(configDir: string, opts: { cmd?: string[]; known?: string[] } = {}) {
    this.configDir = configDir;
    this.cmd = opts.cmd ?? ['gh'];
    this.known = opts.known ?? KNOWN;
  }

  private run(args: string[]): Promise<{ code: number; out: string; err: string; missing: boolean }> {
    return new Promise((ok) => {
      const [bin, ...pre] = this.cmd;
      execFile(bin, [...pre, ...args], { env: { ...process.env, GH_CONFIG_DIR: this.configDir, GH_PROMPT_DISABLED: '1' }, windowsHide: true, timeout: 15_000 }, (e, out, err) => {
        const code = e ? (typeof (e as any).code === 'number' ? (e as any).code : -1) : 0;
        ok({ code, out: String(out), err: String(err), missing: (e as any)?.code === 'ENOENT' });
      });
    });
  }

  /** gh 가 PATH 에 없고 알려진 곳에 있으면 이 서버의 PATH 앞에 붙인다(이후 세션·터미널도 찾게) */
  private ensurePath() {
    if (this.cmd[0] !== 'gh') return;
    for (const p of this.known) {
      if (!p || !existsSync(p)) continue;
      const dir = dirname(p);
      const parts = (process.env.PATH ?? '').split(delimiter);
      if (!parts.some((x) => x.toLowerCase() === dir.toLowerCase())) process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ''}`;
      return;
    }
  }

  async status(): Promise<GitHubStatus> {
    let v = await this.run(['--version']);
    if (v.missing) {
      this.ensurePath();
      v = await this.run(['--version']);
    }
    if (v.missing || v.code !== 0) return { installed: false };
    const pending = this.pending?.code && this.pending.url ? { pending: { code: this.pending.code, url: this.pending.url } } : {};
    const version = v.out.match(/gh version (\S+)/)?.[1];
    const s = await this.run(['auth', 'status', '--hostname', 'github.com', '--json', 'hosts']);
    try {
      const entries: any[] = JSON.parse(s.out)?.hosts?.['github.com'] ?? [];
      const e = entries.find((x) => x?.active) ?? entries[0];
      if (e?.state === 'success' && typeof e.login === 'string') return { installed: true, version, login: e.login, ...pending };
      if (e) return { installed: true, version, error: '로그인이 만료됐거나 토큰이 맞지 않음', ...pending };
    } catch {}
    return { installed: true, version, ...pending };
  }

  async logout(): Promise<void> {
    this.cancelLogin();
    const st = await this.status();
    if (!st.login) return;
    const r = await this.run(['auth', 'logout', '--hostname', 'github.com', '--user', st.login]);
    if (r.code !== 0) throw new Error(r.err.trim() || '로그아웃 실패');
  }

  /** 터미널 창에서 돌릴 설치 명령. 설치 중 확인 창(약관·관리자 권한)은 사람이 직접 누른다. */
  installCommand(): string {
    if (process.platform === 'win32') return 'winget install --id GitHub.cli -e --source winget';
    if (process.platform === 'darwin') return 'brew install gh';
    return linuxGhInstall((c) => Boolean(findCommand(c)));
  }

  /**
   * 로그인 시작 — gh 를 화면 없이 띄워 일회용 코드와 승인 주소를 받는다. 사람이 브라우저에서 코드를 넣고 승인하면 gh 가 스스로 끝난다.
   * 대화형이 아니라서 gh 가 전역 git 설정을 바꾸자고 묻지 않는다. 토큰은 Agent Hub 전용 폴더의 파일에만(--insecure-storage, 개인 자격 증명 저장소와 섞이지 않게).
   */
  startLogin(): Promise<{ code: string; url: string }> {
    this.cancelLogin();
    mkdirSync(this.configDir, { recursive: true });
    const [bin, ...pre] = this.cmd;
    const child = spawn(bin, [...pre, 'auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--insecure-storage'], {
      env: { ...process.env, GH_CONFIG_DIR: this.configDir },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const p: { child: ChildProcess; code?: string; url?: string } = { child };
    this.pending = p;
    return new Promise((ok, fail) => {
      let text = '';
      const timer = setTimeout(() => { this.cancelLogin(); fail(new Error('GitHub 로그인 코드를 받지 못함')); }, 20_000);
      const read = (d: Buffer) => {
        text += d.toString();
        p.code ??= text.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/)?.[1];
        p.url ??= text.match(/https:\/\/\S+\/login\/device\S*/)?.[0];
        if (p.code && p.url) { clearTimeout(timer); ok({ code: p.code, url: p.url }); }
      };
      child.stdout!.on('data', read);
      child.stderr!.on('data', read);
      child.once('error', (e) => { clearTimeout(timer); if (this.pending === p) this.pending = undefined; fail(e); });
      child.once('exit', () => {
        clearTimeout(timer);
        if (this.pending === p) this.pending = undefined;
        if (!(p.code && p.url)) fail(new Error(text.trim().split('\n').pop() || 'GitHub 로그인 실패'));
      });
    });
  }

  cancelLogin() {
    if (!this.pending) return;
    this.pending.child.kill();
    this.pending = undefined;
  }

  /** 터미널에 넘길 환경 변수(비밀 아님) */
  terminalEnv(): Record<string, string> {
    mkdirSync(this.configDir, { recursive: true });
    return { GH_CONFIG_DIR: this.configDir };
  }

  /** Agent Hub 가 띄우는 세션에 넣을 환경 변수 — 로그인돼 있을 때만. github.com 의 git 자격 증명을 gh 로(이 프로세스에만) */
  sessionEnv(): Record<string, string> {
    if (!existsSync(join(this.configDir, 'hosts.yml'))) return {};
    return {
      GH_CONFIG_DIR: this.configDir,
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_0: '', // 다른 자격 증명 도우미(개인 계정)를 먼저 비운다
      GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_1: '!gh auth git-credential',
    };
  }
}
