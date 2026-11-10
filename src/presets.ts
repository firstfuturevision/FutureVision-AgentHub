import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AGENTS, MODEL_RE } from './protocol.ts';
import type { AgentKind } from './protocol.ts';

/**
 * 에이전트 프리셋 — 메인이 작업자에게 일을 맡길 때 고르는 "역할".
 * 설계 출처: PAL MCP Server clink 의 role 프리셋(역할별 시스템 지침). 의존성 없이 JSON 파일 하나로 저장.
 */
export interface Preset {
  id: string;
  name: string; // 사람·메인이 부르는 이름 (예: 코드 리뷰어)
  agent: AgentKind; // 어느 AI 로 돌릴지
  model?: string; // 없으면 그 AI 의 작업자 기본 모델
  description: string; // 메인이 언제 이 프리셋을 고를지
  instructions: string; // 작업자에게 주는 역할 지침
  agents?: string[]; // 이 프리셋이 메인일 때 맡길 수 있는 하위 에이전트(프리셋 id). 없으면 전부
  tools?: string[]; // 이 프리셋으로 뜬 세션에 붙일 툴(툴 id). 없으면 켜진 툴 전부, [] 이면 툴 없음
  skills?: string[]; // 쓸 Agent Hub 스킬 이름. 없으면 전부, [] 이면 없음(계정 스킬은 프리셋에서 안 읽힘)
  autoApprove?: boolean; // 권한 묻지 않기 — 이 에이전트로 뜬 세션은 도구 권한을 묻지 않고 허용
}

const LIMITS = { name: 40, description: 300, instructions: 8000 };

export class PresetStore {
  private file: string;
  private items: Preset[] = [];

  constructor(file: string) {
    this.file = file;
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        this.items = Array.isArray(raw) ? raw.map((p) => validate(p, p?.id)).filter(Boolean) as Preset[] : [];
      } catch {
        this.items = []; // 깨진 파일이면 비우고 시작(원본은 덮어쓰기 전까지 그대로)
      }
    }
  }

  list(): Preset[] {
    return this.items.map((p) => ({ ...p }));
  }

  /** id 또는 이름(대소문자·앞뒤 공백 무시)으로 찾기 */
  find(key: string): Preset | undefined {
    const k = key.trim().toLowerCase();
    return this.items.find((p) => p.id === key || p.name.toLowerCase() === k);
  }

  /** 저장하지 않고 형식·이름 중복만 확인(잘못이면 throw) */
  check(input: unknown) {
    const id = typeof (input as any)?.id === 'string' ? (input as any).id : '__new__';
    const p = validate(input, id, true)!;
    const dup = this.items.find((x) => x.id !== id && x.name.toLowerCase() === p.name.toLowerCase());
    if (dup) throw new Error(`같은 이름의 프리셋이 있음: ${p.name}`);
    if (id !== '__new__' && !this.items.some((x) => x.id === id)) throw new Error(`없는 프리셋 id: ${id}`);
  }

  /** 만들기·고치기. id 가 있으면 고친다. 잘못된 값이면 이유와 함께 throw. */
  save(input: unknown): Preset {
    const existing = typeof (input as any)?.id === 'string' ? this.items.find((p) => p.id === (input as any).id) : undefined;
    const p = validate(input, existing?.id ?? randomUUID().slice(0, 8), true);
    if (!p) throw new Error('프리셋 형식이 맞지 않음');
    const dup = this.items.find((x) => x.id !== p.id && x.name.toLowerCase() === p.name.toLowerCase());
    if (dup) throw new Error(`같은 이름의 프리셋이 있음: ${p.name}`);
    this.items = existing ? this.items.map((x) => (x.id === p.id ? p : x)) : [...this.items, p];
    this.flush();
    return p;
  }

  remove(id: string) {
    const before = this.items.length;
    this.items = this.items.filter((p) => p.id !== id);
    if (this.items.length !== before) this.flush();
  }

  private flush() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.items, null, 2));
    renameSync(tmp, this.file); // 쓰다 끊겨도 원본이 깨지지 않게
  }
}

/** 형식 검사. strict=true 면 이유를 throw, 아니면 null. */
function validate(v: any, id: string, strict = false): Preset | null {
  const fail = (msg: string) => {
    if (strict) throw new Error(msg);
    return null;
  };
  if (!v || typeof v !== 'object') return fail('프리셋 형식이 맞지 않음');
  const name = typeof v.name === 'string' ? v.name.trim() : '';
  if (!name || name.length > LIMITS.name) return fail(`이름은 1~${LIMITS.name}자`);
  if (!AGENTS.includes(v.agent)) return fail(`AI 는 ${AGENTS.join(', ')} 중 하나`);
  const model = typeof v.model === 'string' && v.model.trim() ? v.model.trim() : undefined;
  if (model && !MODEL_RE.test(model)) return fail(`쓸 수 없는 모델 이름: ${model}`);
  const description = typeof v.description === 'string' ? v.description.trim() : '';
  if (description.length > LIMITS.description) return fail(`설명은 ${LIMITS.description}자까지`);
  const instructions = typeof v.instructions === 'string' ? v.instructions.trim() : '';
  if (!instructions) return fail('역할 지침을 적어 주세요');
  if (instructions.length > LIMITS.instructions) return fail(`역할 지침은 ${LIMITS.instructions}자까지`);
  // 허용 목록: 배열이면 그 id 들만(빈 배열 = 아무것도), 없거나 null 이면 전부
  const ids = (x: unknown) =>
    Array.isArray(x) ? [...new Set(x.filter((s): s is string => typeof s === 'string' && /^[\w-]{1,40}$/.test(s)))].slice(0, 50) : undefined;
  const agents = ids(v.agents)?.filter((a) => a !== id); // 자기 자신은 부르지 않는다
  const tools = ids(v.tools);
  const skills = Array.isArray(v.skills) ? [...new Set(v.skills.filter((s: unknown): s is string => typeof s === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(s)))].slice(0, 100) : undefined;
  return { id, name, agent: v.agent, ...(model ? { model } : {}), description, instructions, ...(agents ? { agents } : {}), ...(tools ? { tools } : {}), ...(skills ? { skills } : {}), ...(v.autoApprove === true ? { autoApprove: true } : {}) };
}

/** 작업자에게 보내는 첫 지시 — 역할 지침을 앞에 붙인다(모든 CLI 에 똑같이 통하는 방법). */
export function withRole(preset: Preset, prompt: string): string {
  return `[역할: ${preset.name}]\n${preset.instructions}\n\n[맡긴 일]\n${prompt}`;
}
