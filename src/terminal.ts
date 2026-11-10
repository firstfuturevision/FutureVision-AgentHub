import { spawn, execFileSync } from 'node:child_process';
import { findCommand } from './install.ts';

/**
 * 공용 PC 화면에 진짜 터미널 창을 하나 띄워 CLI 를 대화형으로 실행한다.
 * 로그인(gemini, codex login, claude /login)이나 손으로 직접 만질 때 쓴다.
 *
 * 권한: 새 창은 호스트와 같은 권한으로 열린다. 호스트를 일반 사용자로 실행하면 일반 권한이다.
 * 관리자 권한으로 올리는 기능은 일부러 넣지 않는다(에이전트가 PC 전체를 바꿀 수 있게 되므로).
 * 명령은 설정값만 쓰고, 폴더는 SessionManager 가 workspaceRoot 안인지 확인한 값만 받는다.
 */
export function openTerminal(title: string, command: string, dir: string, env: Record<string, string> = {}): Promise<void> {
  // 비밀이 아닌 환경 변수만(전용 프로필 경로, Gemini 프로젝트 ID) 명령 앞에 붙인다. 셸 특수문자가 든 값은 버린다.
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k) || /["'&|<>^%`$\r\n]/.test(v)) continue;
    command = process.platform === 'win32' ? `set "${k}=${v}"&& ${command}` : `${k}='${v}' ${command}`;
  }
  if (process.platform === 'win32') return openWindows(title, command, dir);
  if (process.platform === 'darwin') {
    // 인자로 넘겨 AppleScript 안에서 quoted form 으로 감싼다 — 문자열 이어 붙이기 없음
    const script = [
      'on run argv',
      '  tell application "Terminal"',
      '    activate',
      '    do script "cd " & quoted form of (item 1 of argv) & " && " & (item 2 of argv)',
      '  end tell',
      'end run',
    ];
    return detached('osascript', [...script.flatMap((l) => ['-e', l]), dir, command]);
  }
  return openLinux(title, command, dir);
}

/**
 * 리눅스(Ubuntu 등): 이 PC 에 있는 터미널을 차례로 찾아 연다. 폴더·명령은 sh 의 인자로만 넘긴다(문자열 이어 붙이기 없음).
 * 명령이 끝나도 창이 닫히지 않게 셸을 이어서 띄운다.
 */
export function linuxTerminalArgs(title: string, command: string, dir: string, has: (cmd: string) => boolean): [string, string[]] | null {
  const script = ['sh', '-c', 'cd "$1" && eval "$2"; exec "${SHELL:-sh}"', 'sh', dir, command];
  if (has('gnome-terminal')) return ['gnome-terminal', ['--title', title, '--', ...script]];
  if (has('konsole')) return ['konsole', ['-p', `tabtitle=${title}`, '-e', ...script]];
  if (has('xfce4-terminal')) return ['xfce4-terminal', ['--title', title, '-x', ...script]];
  if (has('mate-terminal')) return ['mate-terminal', ['--title', title, '-x', ...script]];
  if (has('tilix')) return ['tilix', ['-t', title, '-e', ...script]];
  if (has('xterm')) return ['xterm', ['-T', title, '-e', ...script]];
  if (has('x-terminal-emulator')) return ['x-terminal-emulator', ['-e', ...script]];
  return null;
}

function openLinux(title: string, command: string, dir: string) {
  const found = linuxTerminalArgs(title, command, dir, (c) => Boolean(findCommand(c)));
  if (!found) return Promise.reject(new Error('터미널 프로그램을 찾지 못함(gnome-terminal, konsole, xterm 등)'));
  return detached(found[0], found[1]);
}

async function openWindows(title: string, command: string, dir: string) {
  try {
    // Windows Terminal: 새 창, 제목, 시작 폴더 지정. cmd /k 는 CLI 가 끝나도 창을 남긴다.
    await detached('wt.exe', ['-w', 'new', '--title', title, '-d', dir, 'cmd', '/k', command]);
  } catch {
    // Windows Terminal 이 없으면 기본 콘솔. start 는 첫 따옴표 인자를 제목으로 보므로 직접 따옴표를 붙인다.
    // 셸 특수문자가 든 값은 거부한다(주입 방지).
    for (const v of [title, dir, command]) if (/["&|<>^%\r\n]/.test(v)) throw new Error(`터미널 열기에 쓸 수 없는 문자: ${v}`);
    await detached('cmd.exe', ['/c', `start "${title}" /D "${dir}" cmd /k ${command}`], true);
  }
}

function detached(cmd: string, args: string[], verbatim = false): Promise<void> {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: verbatim });
    p.once('error', fail);
    p.once('spawn', () => {
      p.unref();
      ok();
    });
  });
}

/** 호스트가 관리자(root) 권한으로 돌고 있는지. 그렇다면 에이전트와 터미널도 전부 관리자 권한이다. */
export function isElevated(): boolean {
  if (process.platform === 'win32') {
    try {
      execFileSync('net', ['session'], { stdio: 'ignore', windowsHide: true });
      return true; // 관리자만 성공한다
    } catch {
      return false;
    }
  }
  return typeof process.getuid === 'function' && process.getuid() === 0;
}
