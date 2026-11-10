import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import type { AgentKind } from './protocol.ts';

/**
 * 연동의 "설치" — Claude·Codex·Gemini CLI 가 이 PC 에 있는지 보고, 없으면 터미널 창에서 npm 으로 설치한다.
 * npm 전역 설치는 사용자 폴더(%APPDATA%\npm)에 깔리므로 관리자 권한이 필요 없다.
 * Codex 는 로그인용 codex 와 세션용 codex-acp 둘 다 있어야 한다.
 */
export const PACKAGES: Record<AgentKind, string[]> = {
  claude: ['@anthropic-ai/claude-code'],
  codex: ['@openai/codex', '@agentclientprotocol/codex-acp'],
  gemini: ['@google/gemini-cli'],
};

/** PATH(와 Windows 의 PATHEXT)에서 명령을 찾는다. 절대 경로면 그 파일이 있는지만 본다. */
export function findCommand(cmd: string, path = process.env.PATH ?? ''): string | undefined {
  if (!cmd) return undefined;
  const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase())] : [''];
  const dirs = isAbsolute(cmd) ? [''] : path.split(delimiter).filter(Boolean);
  for (const d of dirs) {
    for (const e of exts) {
      const p = d ? join(d, cmd + e) : cmd + e;
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

/** 각 AI 의 설치 여부. commands: 그 AI 가 쓰는 명령들(설정값) */
export function cliStatus(commands: Record<AgentKind, string[]>): Record<AgentKind, { installed: boolean; missing: string[] }> {
  const out = {} as Record<AgentKind, { installed: boolean; missing: string[] }>;
  for (const [a, cmds] of Object.entries(commands) as [AgentKind, string[]][]) {
    const missing = cmds.filter((c) => !findCommand(c));
    out[a] = { installed: missing.length === 0, missing };
  }
  return out;
}

export function installCommand(agent: AgentKind): string {
  return `npm install -g ${PACKAGES[agent].join(' ')}`;
}
