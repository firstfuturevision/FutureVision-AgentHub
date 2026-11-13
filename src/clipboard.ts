// 화면 제어의 클립보드: 원격으로 보는 사람이 이 PC 의 클립보드 글을 가져오고(get) 자기 글을 넣는다(set).
// 리눅스는 clipboard-x11.py(X11 · GNOME Wayland 의 XWayland), Windows 는 PowerShell, macOS 는 pbcopy · pbpaste. 설치할 것 없음.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** 한 번에 주고받는 글 상한(X 클립보드를 한 번에 넘길 수 있는 크기 안쪽) */
export const CLIP_MAX = 200_000;

type Run = (cmd: string, args: string[], input?: string) => Promise<string>;

export class Clipboard {
  private serving: ChildProcess | null = null;
  private script: string;
  private platform: NodeJS.Platform;

  constructor(opts: { script: string; platform?: NodeJS.Platform }) {
    this.script = opts.script;
    this.platform = opts.platform ?? process.platform;
  }

  /** 리눅스: 서비스로 켜져 DISPLAY · XAUTHORITY 가 없을 수 있다 — 이 사용자의 XWayland 인증 파일을 찾아 채운다 */
  private env(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    if (this.platform !== 'linux') return env;
    env.DISPLAY ||= ':0';
    if (!env.XAUTHORITY) {
      const dir = `/run/user/${process.getuid?.() ?? 1000}`;
      try {
        const f = readdirSync(dir).find((n) => n.startsWith('.mutter-Xwaylandauth.'));
        if (f) env.XAUTHORITY = join(dir, f);
      } catch {}
    }
    return env;
  }

  private run: Run = (cmd, args, input) => new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: this.env(), windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error('클립보드가 답하지 않음')); }, 8000);
    p.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
    p.stderr.setEncoding('utf8').on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `클립보드 명령 실패(${code})`));
    });
    p.stdin.end(input ?? '');
  });

  /** 이 PC 클립보드의 글 */
  async get(): Promise<string> {
    let text: string;
    if (this.platform === 'linux') text = await this.run('python3', [this.script, 'get']);
    else if (this.platform === 'win32') {
      text = await this.run('powershell', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $t = Get-Clipboard -Raw; if ($t) { [Console]::Out.Write($t) }']);
    } else if (this.platform === 'darwin') text = await this.run('pbpaste', []);
    else throw new Error('이 운영체제에서는 클립보드를 다룰 수 없음');
    return text.length > CLIP_MAX ? text.slice(0, CLIP_MAX) : text;
  }

  /** 이 PC 클립보드에 글을 넣는다(그다음 원격 화면에서 Ctrl+V) */
  async set(text: string): Promise<void> {
    if (typeof text !== 'string') throw new Error('글이 없음');
    if (text.length > CLIP_MAX) throw new Error(`글이 너무 김(${CLIP_MAX.toLocaleString()}자까지)`);
    if (this.platform === 'win32') {
      await this.run('powershell', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::InputEncoding=[Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())'], text);
      return;
    }
    if (this.platform === 'darwin') { await this.run('pbcopy', [], text); return; }
    if (this.platform !== 'linux') throw new Error('이 운영체제에서는 클립보드를 다룰 수 없음');
    if (!existsSync(this.script)) throw new Error('클립보드 도우미 파일 없음');
    // X 클립보드는 가진 프로그램이 살아 있어야 붙는다: 도우미가 "ok" 를 쓴 뒤에도 남아 답하게 두고, 새로 넣으면 앞 것은 끈다
    this.serving?.kill();
    const p = spawn('python3', [this.script, 'serve'], { env: this.env(), stdio: ['pipe', 'pipe', 'pipe'] });
    this.serving = p;
    await new Promise<void>((resolve, reject) => {
      let err = '';
      const timer = setTimeout(() => { p.kill(); reject(new Error('클립보드가 답하지 않음')); }, 8000);
      p.stderr.setEncoding('utf8').on('data', (d) => { err += d; });
      p.stdout.setEncoding('utf8').on('data', (d: string) => { if (d.includes('ok')) { clearTimeout(timer); resolve(); } });
      p.on('error', (e) => { clearTimeout(timer); reject(e); });
      p.on('close', (code) => { clearTimeout(timer); if (this.serving === p) this.serving = null; reject(new Error(err.trim() || `클립보드 명령 실패(${code})`)); });
      p.stdin.end(text);
    });
    p.unref();
  }

  stop() {
    this.serving?.kill();
    this.serving = null;
  }
}
