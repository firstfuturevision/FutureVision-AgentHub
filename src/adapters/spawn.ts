import { spawn, type ChildProcess } from 'node:child_process';

/**
 * CLI 실행. Windows 의 npm 전역 명령은 .cmd 라서 셸을 거쳐야 실행되는데,
 * 셸은 인자를 그냥 이어 붙이므로 공백 있는 값은 따옴표로 감싼다.
 * 사용자 입력은 절대 인자로 넘기지 않는다(stdin 으로만) — 인자는 설정값뿐이다.
 */
export function spawnCli(command: string, args: string[], cwd: string, env: Record<string, string> = {}): ChildProcess {
  const shell = process.platform === 'win32';
  const q = (s: string) => (shell && /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  return spawn(q(command), args.map(q), {
    cwd,
    env: { ...process.env, ...env }, // 연동(API 키 등)은 이 CLI 에만
    stdio: ['pipe', 'pipe', 'pipe'],
    shell,
    windowsHide: true,
  });
}
