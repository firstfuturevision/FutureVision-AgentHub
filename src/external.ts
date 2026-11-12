import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { UUID_RE } from './protocol.ts';

/**
 * 이 PC 의 Claude Code 세션 찾기 — Claude Code 가 남기는 대화 기록(~/.claude/projects/<폴더>/<대화 id>.jsonl)을 읽는다.
 *  - 기록은 수십 MB 가 되기도 해서 앞(폴더·첫 지시)과 끝(마지막 말)만 읽는다.
 *  - 프로그램이 -p 로 띄운 세션(Agent Hub 작업 포함)은 뺀다 — 사람이 직접 연 세션만.
 *    첫 지시의 turnOrigin 이 'sdk' 면 프로그램이 보낸 것. entrypoint 는 띄운 쪽 환경을 물려받아 믿을 수 없다(2.1.283 확인).
 *  - 이어 가기는 그 대화 id 로 `claude --resume` 을 띄운다(SessionManager). 여기는 읽기만 한다.
 */
export interface ExternalSession {
  id: string;
  cwd: string; // 그 세션의 작업 폴더
  title: string; // 첫 지시
  last: string; // 마지막 말(사람이든 Claude 든)
  at: string; // 기록이 마지막으로 바뀐 때(ISO)
  active: boolean; // 방금(2분 안)까지 쓰던 세션 — 원래 창이 아직 쓰는 중일 수 있다
  folderOk: boolean; // 작업 폴더가 아직 있는가(없으면 이어 갈 수 없음)
}
/** 가져온 대화 한 줄: 사람 지시·Claude 답·도구 사용(파일 수정·명령 실행 등)·도구 결과 */
export type ExternalMessage =
  | { role: 'user' | 'assistant'; text: string }
  | { role: 'tool'; id: string; name: string; input: Record<string, string> }
  | { role: 'tool_result'; id: string; ok: boolean; summary: string };

/** 도구 입력은 화면 한 줄에 쓸 것만(파일·명령·패턴 등) — Write 의 파일 내용 같은 큰 값은 버린다 */
const TOOL_KEYS = ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'description', 'skill', 'subagent_type'];
function toolInput(input: any): Record<string, string> {
  if (!input || typeof input !== 'object') return {};
  for (const k of TOOL_KEYS) if (typeof input[k] === 'string') return { [k]: clip(input[k], 200) };
  const first = Object.entries(input).find(([, v]) => typeof v === 'string');
  return first ? { [first[0]]: clip(first[1] as string, 200) } : {};
}
function resultSummary(c: any): string {
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n') : '';
  return clip(text.split('\n').map((l: string) => l.trim()).find(Boolean) ?? '', 160);
}

const HEAD = 256 * 1024;
const TAIL = 512 * 1024;
const READ_TAIL = 3 * 1024 * 1024;
const ACTIVE_MS = 2 * 60 * 1000;
const MAX_TEXT = 4000;

/** Claude Code 의 설정 폴더(기록이 있는 곳) */
export const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

const dirs = (d: string) => { try { return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } };

/** 그 대화 id 의 기록 파일(없으면 null). 대화 id 는 폴더와 상관없이 하나다 */
export function claudeTranscript(home: string, id: string): string | null {
  if (!UUID_RE.test(id)) return null;
  const root = join(home, 'projects');
  for (const d of dirs(root)) {
    const f = join(root, d, `${id}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

function readRange(file: string, start: number, len: number): string {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, start);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** 조각의 JSON 줄들. 중간부터 읽었으면 잘린 첫 줄과 끝 줄은 버린다 */
function parse(chunk: string, cutHead: boolean): any[] {
  const lines = chunk.split('\n');
  if (cutHead) lines.shift();
  const out: any[] = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch {}
  }
  return out;
}

const clip = (s: string, n = MAX_TEXT) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 사람이 쓴 지시(도구 결과·명령 출력·시스템 알림·요약은 뺀다) */
export function promptText(j: any): string | null {
  if (j?.type !== 'user' || j.isSidechain || j.isMeta || j.isCompactSummary || j.message?.role !== 'user') return null;
  const c = j.message.content;
  let text = '';
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    if (c.some((b: any) => b?.type === 'tool_result')) return null;
    text = c.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n');
  }
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!text || text.startsWith('<') || text.startsWith('Caveat:') || text.startsWith('[Request interrupted')) return null;
  return text;
}

/** Claude 의 답(글만) */
export function replyText(j: any): string | null {
  if (j?.type !== 'assistant' || j.isSidechain || !Array.isArray(j.message?.content)) return null;
  const text = j.message.content.filter((b: any) => b?.type === 'text' && b.text).map((b: any) => b.text).join('\n').trim();
  return text || null;
}

interface Summary { cwd: string; title: string; last: string; skip: boolean }

export class ClaudeHistory {
  private home: string;
  private cache = new Map<string, { key: string; s: Summary }>();

  constructor(home = claudeHome()) {
    this.home = home;
  }

  /** 최근에 쓴 세션부터. skip: 이미 Agent Hub 작업인 대화 id */
  list(skip: Set<string> = new Set(), limit = 40): ExternalSession[] {
    const root = join(this.home, 'projects');
    const files: { file: string; id: string; mtime: number; size: number }[] = [];
    for (const d of dirs(root)) {
      let names: string[] = [];
      try { names = readdirSync(join(root, d)); } catch { continue; }
      for (const n of names) {
        const id = n.slice(0, -6);
        if (!n.endsWith('.jsonl') || !UUID_RE.test(id) || skip.has(id.toLowerCase())) continue;
        try {
          const st = statSync(join(root, d, n));
          if (st.isFile() && st.size > 0) files.push({ file: join(root, d, n), id: id.toLowerCase(), mtime: st.mtimeMs, size: st.size });
        } catch {}
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    const out: ExternalSession[] = [];
    for (const f of files) {
      if (out.length >= limit) break;
      const s = this.summary(f.file, f.size, f.mtime);
      if (!s || s.skip || !s.title) continue;
      let folderOk = false;
      try { folderOk = Boolean(s.cwd) && statSync(s.cwd).isDirectory(); } catch {}
      out.push({ id: f.id, cwd: s.cwd, title: clip(s.title, 120), last: clip(s.last, 200), at: new Date(f.mtime).toISOString(), active: Date.now() - f.mtime < ACTIVE_MS, folderOk });
    }
    return out;
  }

  /**
   * 가져오기: 그 세션의 폴더·첫 지시와 대화 끝부분 — 사람 지시와 Claude 의 답(최대 max 개),
   * 그 사이의 도구 사용(파일 수정·명령 실행 등)과 결과까지. AI 는 --resume 으로 전부 기억하고, 이것은 사람이 볼 화면용.
   */
  read(id: string, max = 30): { cwd: string; title: string; messages: ExternalMessage[] } | null {
    const file = claudeTranscript(this.home, id);
    if (!file) return null;
    let st;
    try { st = statSync(file); } catch { return null; }
    const s = this.summary(file, st.size, st.mtimeMs);
    if (!s) return null;
    const start = Math.max(0, st.size - READ_TAIL);
    const messages: ExternalMessage[] = [];
    const pushText = (role: 'user' | 'assistant', text: string) => {
      const prev = messages.at(-1);
      // 한 답이 여러 줄로 나뉘어 기록된다 — 바로 이어진 답 글은 하나로
      if (role === 'assistant' && prev?.role === 'assistant') prev.text = clip(`${prev.text}\n\n${text}`);
      else messages.push({ role, text: clip(text) });
    };
    for (const j of parse(readRange(file, start, st.size - start), start > 0)) {
      if (j?.isSidechain) continue;
      const p = promptText(j);
      if (p !== null) { pushText('user', p); continue; }
      const c = j?.message?.content;
      if (!Array.isArray(c)) continue;
      if (j.type === 'assistant') {
        for (const b of c) {
          if (b?.type === 'text' && b.text?.trim()) pushText('assistant', b.text.trim());
          else if (b?.type === 'tool_use' && typeof b.name === 'string') messages.push({ role: 'tool', id: String(b.id ?? ''), name: b.name, input: toolInput(b.input) });
        }
      } else if (j.type === 'user') {
        for (const b of c) if (b?.type === 'tool_result') messages.push({ role: 'tool_result', id: String(b.tool_use_id ?? ''), ok: !b.is_error, summary: resultSummary(b.content) });
      }
    }
    // 끝에서 글(지시·답) max 개가 들어가는 곳부터. 도구 결과로 시작하면 그 앞 도구가 없으니 뺀다
    let from = 0;
    for (let i = messages.length - 1, n = 0; i >= 0; i--) {
      const r = messages[i].role;
      if ((r === 'user' || r === 'assistant') && ++n > max) { from = i + 1; break; }
    }
    while (from < messages.length && messages[from].role === 'tool_result') from++;
    return { cwd: s.cwd, title: s.title, messages: messages.slice(from) };
  }

  private summary(file: string, size: number, mtime: number): Summary | null {
    const key = `${size}:${mtime}`;
    const hit = this.cache.get(file);
    if (hit?.key === key) return hit.s;
    let s: Summary;
    try {
      const head = parse(readRange(file, 0, Math.min(size, HEAD)), false);
      const tailStart = Math.max(0, size - TAIL);
      const tail = tailStart > 0 ? parse(readRange(file, tailStart, size - tailStart), true) : head;
      const cwd = head.find((j) => typeof j.cwd === 'string')?.cwd ?? tail.find((j) => typeof j.cwd === 'string')?.cwd ?? '';
      let title = '';
      let bySdk = false;
      for (const j of head) { const p = promptText(j); if (p) { title = p.replace(/\s+/g, ' '); bySdk = j.turnOrigin === 'sdk' || j.entrypoint === 'sdk-cli'; break; } }
      let last = '';
      for (let i = tail.length - 1; i >= 0 && !last; i--) last = (promptText(tail[i]) ?? replyText(tail[i]) ?? '').replace(/\s+/g, ' ');
      s = { cwd, title, last, skip: bySdk };
    } catch {
      return null;
    }
    this.cache.set(file, { key, s });
    return s;
  }
}
