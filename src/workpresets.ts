import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * 프리셋 — 작업 환경. 새 작업을 시작할 때 고른다.
 *  - folder    : 작업 폴더(작업 폴더 뿌리 아래 이름, 비우면 뿌리)
 *  - extraDirs : 함께 연결할 폴더들
 *  - guidelines: 폴더 구조·작업 방식 지침. 메인과 하위 에이전트의 첫 지시에 붙는다
 * (역할·AI·툴은 "에이전트"가 맡는다.)
 */
export interface WorkPreset {
  id: string;
  name: string;
  description: string;
  folder: string;
  extraDirs: string[];
  guidelines: string;
  mainAgent?: string; // 이 프리셋으로 시작할 때 기본 메인 에이전트(에이전트 id). 없으면 기본(Claude)
  agents?: string[]; // 이 작업에서 맡길 수 있는 하위 에이전트(에이전트 id). 없으면 전부
}

export class WorkPresetStore {
  private file: string;
  private items: WorkPreset[] = [];

  constructor(file: string) {
    this.file = file;
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        this.items = Array.isArray(raw) ? (raw.map((p) => validate(p, p?.id)).filter(Boolean) as WorkPreset[]) : [];
      } catch {
        this.items = [];
      }
    }
  }

  list(): WorkPreset[] {
    return this.items.map((p) => ({ ...p, extraDirs: [...p.extraDirs] }));
  }

  find(key: string): WorkPreset | undefined {
    const k = key.trim().toLowerCase();
    return this.items.find((p) => p.id === key || p.name.toLowerCase() === k);
  }

  save(input: unknown): WorkPreset {
    const existing = typeof (input as any)?.id === 'string' ? this.items.find((p) => p.id === (input as any).id) : undefined;
    const p = validate(input, existing?.id ?? randomUUID().slice(0, 8), true)!;
    if (this.items.some((x) => x.id !== p.id && x.name.toLowerCase() === p.name.toLowerCase())) throw new Error(`같은 이름의 프리셋이 있음: ${p.name}`);
    this.items = existing ? this.items.map((x) => (x.id === p.id ? p : x)) : [...this.items, p];
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.items, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
    return p;
  }

  remove(id: string) {
    const n = this.items.length;
    this.items = this.items.filter((p) => p.id !== id);
    if (this.items.length === n) return;
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.items, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
  }
}

const FOLDER_RE = /^[^\\/:*?"<>|\x00-\x1f]{1,60}$/; // 뿌리 바로 아래 폴더 이름 하나

function validate(v: any, id: string, strict = false): WorkPreset | null {
  const fail = (m: string) => {
    if (strict) throw new Error(m);
    return null;
  };
  if (!v || typeof v !== 'object') return fail('프리셋 형식이 맞지 않음');
  const name = typeof v.name === 'string' ? v.name.trim() : '';
  if (!name || name.length > 40) return fail('이름은 1~40자');
  const folder = typeof v.folder === 'string' ? v.folder.trim() : '';
  if (folder && (!FOLDER_RE.test(folder) || folder === '.' || folder === '..')) return fail(`쓸 수 없는 폴더 이름: ${folder}`);
  const extraDirs = Array.isArray(v.extraDirs)
    ? [...new Set(v.extraDirs.filter((d: unknown): d is string => typeof d === 'string' && FOLDER_RE.test(d.trim()) && !['.', '..'].includes(d.trim())).map((d: string) => d.trim()))].filter((d) => d !== folder).slice(0, 10)
    : [];
  const guidelines = typeof v.guidelines === 'string' ? v.guidelines.trim() : '';
  if (guidelines.length > 20000) return fail('지침은 20000자까지');
  const description = typeof v.description === 'string' ? v.description.trim().slice(0, 200) : '';
  const ID = /^[\w-]{1,40}$/;
  const mainAgent = typeof v.mainAgent === 'string' && ID.test(v.mainAgent) ? v.mainAgent : undefined;
  const agents = Array.isArray(v.agents) ? [...new Set(v.agents.filter((a: unknown): a is string => typeof a === 'string' && ID.test(a)))].slice(0, 50) : undefined;
  return { id, name, description, folder, extraDirs: extraDirs as string[], guidelines, ...(mainAgent ? { mainAgent } : {}), ...(agents ? { agents: agents as string[] } : {}) };
}

/** 첫 지시 앞에 붙일 작업 환경 지침 */
export function withGuidelines(p: WorkPreset, text: string): string {
  return p.guidelines ? `[작업 환경: ${p.name}]\n${p.guidelines}\n\n${text}` : text;
}
