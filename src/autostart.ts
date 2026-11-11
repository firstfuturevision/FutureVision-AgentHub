import { execFile } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
// @ts-ignore — 시작 설정 스크립트는 그냥 JS(.mjs)
import { plan, apply } from '../scripts/setup.mjs';

/**
 * 연동의 "자동 실행" — 이 PC 사용자가 로그인하면 Agent Hub 를 뒤에서 켠다(관리자 권한 없이 이 사용자만).
 * npm run setup 이 만드는 것 중 자동 시작 하나만 켜고 끈다(바탕화면·시작 메뉴 아이콘은 그대로).
 *  - Windows : 시작프로그램 폴더의 "Agent Hub.lnk" (창 없이 --background)
 *  - macOS   : ~/Library/LaunchAgents 의 LaunchAgent
 *  - 리눅스  : ~/.config/autostart/agent-hub.desktop
 * 바뀐 것은 다음 로그인부터 적용된다.
 */
export interface AutoStartStatus { supported: boolean; enabled: boolean }

export class AutoStart {
  private root: string;
  private node: string;
  private platform: NodeJS.Platform;
  private home: string;
  private startupDir: string; // Windows 시작프로그램 폴더(시험·화면 확인용으로 바꿀 수 있다)

  constructor(opts: { root: string; node?: string; platform?: NodeJS.Platform; home?: string; startupDir?: string }) {
    this.root = opts.root;
    this.node = opts.node ?? process.execPath;
    this.platform = opts.platform ?? process.platform;
    this.home = opts.home ?? homedir();
    this.startupDir = opts.startupDir ?? join(process.env.APPDATA ?? join(this.home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  }

  /** macOS·리눅스: 자동 시작 파일 하나 */
  private file(): { path: string; content: string; mode?: number } | undefined {
    const files = plan({ platform: this.platform, home: this.home, root: this.root, node: this.node }) as { path: string; content: string; mode?: number }[];
    return files.find((f) => f.path.includes('LaunchAgents') || f.path.includes('autostart'));
  }

  private path(): string | undefined {
    return this.platform === 'win32' ? join(this.startupDir, 'Agent Hub.lnk') : this.file()?.path;
  }

  status(): AutoStartStatus {
    const p = this.path();
    return { supported: Boolean(p), enabled: Boolean(p && existsSync(p)) };
  }

  async set(enabled: boolean): Promise<AutoStartStatus> {
    const p = this.path();
    if (!p) throw new Error('이 운영체제에서는 자동 실행을 켤 수 없음');
    if (!enabled) {
      rmSync(p, { force: true });
      return this.status();
    }
    if (this.platform === 'win32') await this.windowsShortcut(p);
    else apply([this.file()]);
    return this.status();
  }

  /** 바로가기(.lnk)는 PowerShell 의 WScript.Shell 로 만든다. 값은 환경 변수로만 넘긴다 */
  private windowsShortcut(lnk: string): Promise<void> {
    const script = `$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path (Split-Path -LiteralPath $env:AH_LNK) | Out-Null
$l = (New-Object -ComObject WScript.Shell).CreateShortcut($env:AH_LNK)
$l.TargetPath = $env:AH_NODE
$l.Arguments = '"' + $env:AH_LAUNCH + '" --background'
$l.WorkingDirectory = $env:AH_ROOT
$l.WindowStyle = 7
$l.Description = 'Agent Hub'
$l.Save()`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return new Promise((ok, fail) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
        env: { ...process.env, AH_LNK: lnk, AH_NODE: this.node, AH_LAUNCH: join(this.root, 'scripts', 'launch.mjs'), AH_ROOT: this.root },
        windowsHide: true,
        timeout: 30_000,
      }, (e, _out, err) => (e ? fail(new Error(String(err).trim().split('\n')[0] || e.message)) : ok()));
    });
  }
}
