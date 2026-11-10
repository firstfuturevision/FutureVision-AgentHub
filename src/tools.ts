import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * 툴 — Agent Hub 가 띄우는 모든 세션(메인·작업자)에 붙이는 MCP 서버.
 * 계정에 설치된 도구가 아니라 여기서 정한 도구를 쓰게 하는 자리. JSON 파일 하나로 저장(의존성 없음).
 *  - http : 주소로 접속하는 MCP 서버
 *  - stdio: 명령을 실행해 표준 입출력으로 대화하는 MCP 서버(그 CLI 가 직접 실행, 셸을 거치지 않음)
 */
export interface Tool {
  id: string;
  name: string; // 에이전트가 보는 이름(도구 이름 앞에 붙음): 영문 소문자·숫자·-·_
  type: 'http' | 'stdio';
  url?: string; // http
  command?: string; // stdio
  args?: string[]; // stdio
  description: string;
  enabled: boolean;
}

const NAME_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const RESERVED = new Set(['hub']); // 메인의 clink 서버 이름

export class ToolStore {
  private file: string;
  private items: Tool[] = [];

  constructor(file: string) {
    this.file = file;
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        this.items = Array.isArray(raw) ? (raw.map((t) => validate(t, t?.id)).filter(Boolean) as Tool[]) : [];
      } catch {
        this.items = [];
      }
    }
  }

  list(): Tool[] {
    return this.items.map((t) => ({ ...t, args: t.args ? [...t.args] : undefined }));
  }

  enabled(): Tool[] {
    return this.list().filter((t) => t.enabled);
  }

  save(input: unknown): Tool {
    const existing = typeof (input as any)?.id === 'string' ? this.items.find((t) => t.id === (input as any).id) : undefined;
    const t = validate(input, existing?.id ?? randomUUID().slice(0, 8), true)!;
    if (this.items.some((x) => x.id !== t.id && x.name === t.name)) throw new Error(`같은 이름의 툴이 있음: ${t.name}`);
    this.items = existing ? this.items.map((x) => (x.id === t.id ? t : x)) : [...this.items, t];
    this.flush();
    return t;
  }

  remove(id: string) {
    const n = this.items.length;
    this.items = this.items.filter((t) => t.id !== id);
    if (this.items.length !== n) this.flush();
  }

  private flush() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.items, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
  }
}

function validate(v: any, id: string, strict = false): Tool | null {
  const fail = (m: string) => {
    if (strict) throw new Error(m);
    return null;
  };
  if (!v || typeof v !== 'object') return fail('툴 형식이 맞지 않음');
  const name = typeof v.name === 'string' ? v.name.trim() : '';
  if (!NAME_RE.test(name)) return fail('이름은 영문 소문자로 시작, 영문 소문자·숫자·-·_ 40자 이내 (예: figma, docs-search)');
  if (RESERVED.has(name)) return fail(`쓸 수 없는 이름: ${name}`);
  const description = typeof v.description === 'string' ? v.description.trim().slice(0, 200) : '';
  const enabled = v.enabled !== false;
  if (v.type === 'http') {
    const url = typeof v.url === 'string' ? v.url.trim() : '';
    let ok = false;
    try {
      ok = ['http:', 'https:'].includes(new URL(url).protocol);
    } catch {}
    if (!ok) return fail('주소는 http:// 또는 https:// 로 시작');
    return { id, name, type: 'http', url, description, enabled };
  }
  if (v.type === 'stdio') {
    const command = typeof v.command === 'string' ? v.command.trim() : '';
    if (!command || command.length > 300) return fail('실행할 명령을 적어 주세요');
    const args = Array.isArray(v.args) ? v.args.filter((a: unknown) => typeof a === 'string').map((a: string) => a.trim()).filter(Boolean).slice(0, 30) : [];
    return { id, name, type: 'stdio', command, args, description, enabled };
  }
  return fail('종류는 http 또는 stdio');
}
