import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, cpSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { SHARED_READONLY } from './presets.ts';

/**
 * Agent Hub 스킬 — 회사 업무 절차를 스킬(SKILL.md)로 모아 두는 곳: data/skills/<이름>/SKILL.md
 * 프리셋 세션은 계정 스킬 대신 여기 스킬 중 프리셋이 고른 것만 쓴다.
 *  - Claude: 세션마다 플러그인 폴더를 만들어 --plugin-dir 로 꽂는다
 *  - Codex : 전용 프로필(CODEX_HOME)/skills 에 넣는다
 * SKILL.md 형식은 Claude·Codex 공통(Agent Skills).
 */
export interface HubSkill { name: string; description: string; body: string; shared?: true }

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/; // 스킬 이름 규칙(소문자·숫자·-)

export class HubSkillStore {
  readonly dir: string;
  private sharedDir: string | null = null; // 공유 레포의 skills 폴더(읽기 전용). 같은 이름이면 이쪽이 이긴다
  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  list(): HubSkill[] {
    const shared = this.sharedDir ? readSkills(this.sharedDir).map((s) => ({ ...s, shared: true as const })) : [];
    const local = readSkills(this.dir).filter((s) => !shared.some((x) => x.name === s.name));
    return [...shared, ...local].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 공유 레포의 skills 폴더를 붙이거나(null 이면) 뗀다 */
  setSharedDir(dir: string | null) {
    this.sharedDir = dir && existsSync(dir) ? dir : null;
  }

  isShared(name: string): boolean {
    return Boolean(this.sharedDir && NAME_RE.test(name) && existsSync(join(this.sharedDir, name, 'SKILL.md')));
  }

  /** 이 PC 스킬 중 같은 이름이 있으면 -mine 을 붙여 남긴다. 바꿨으면 true */
  renameLocal(name: string): boolean {
    if (!NAME_RE.test(name) || !existsSync(join(this.dir, name, 'SKILL.md'))) return false;
    let n = '';
    for (let i = 1; i < 100 && (!n || existsSync(join(this.dir, n))); i++) n = `${name.slice(0, 55)}-mine${i > 1 ? i : ''}`;
    renameSync(join(this.dir, name), join(this.dir, n));
    const md = join(this.dir, n, 'SKILL.md');
    writeFileSync(md, readFileSync(md, 'utf8').replace(/^name:\s*.+$/m, `name: ${n}`));
    return true;
  }

  /** 스킬 폴더(공유본이 있으면 공유본) */
  private pathOf(name: string): string {
    return this.isShared(name) ? join(this.sharedDir!, name) : join(this.dir, name);
  }

  save(input: unknown): HubSkill {
    const v = (input ?? {}) as Record<string, unknown>;
    const name = typeof v.name === 'string' ? v.name.trim() : '';
    if (!NAME_RE.test(name)) throw new Error('스킬 이름은 영문 소문자·숫자·- (예: quote-writing)');
    if (this.isShared(name)) throw new Error(SHARED_READONLY);
    const description = typeof v.description === 'string' ? v.description.trim().replace(/\s+/g, ' ') : '';
    if (!description || description.length > 1024) throw new Error('설명(언제 쓰는 스킬인지)을 1~1024자로 적어 주세요');
    const body = typeof v.body === 'string' ? v.body.trim() : '';
    if (!body || body.length > 50000) throw new Error('스킬 내용을 적어 주세요');
    mkdirSync(join(this.dir, name), { recursive: true });
    // 설명에 따옴표·콜론이 있어도 깨지지 않게 큰따옴표로 감싼다
    writeFileSync(join(this.dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`);
    return { name, description, body };
  }

  remove(name: string) {
    if (!NAME_RE.test(name)) return;
    if (this.isShared(name)) throw new Error(SHARED_READONLY);
    rmSync(join(this.dir, name), { recursive: true, force: true });
  }

  /** 고른 스킬만(없으면 전부) — 이름 목록 */
  pick(names?: string[]): string[] {
    const all = this.list().map((s) => s.name);
    return names ? all.filter((n) => names.includes(n)) : all;
  }

  /** Claude 용: 고른 스킬을 담은 플러그인 폴더를 만든다(--plugin-dir). 스킬이 없으면 null */
  buildPlugin(target: string, names: string[]): string | null {
    rmSync(target, { recursive: true, force: true });
    if (!names.length) return null;
    mkdirSync(join(target, '.claude-plugin'), { recursive: true });
    writeFileSync(join(target, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'agent-hub', version: '1.0.0', description: 'Agent Hub 스킬' }));
    for (const n of names) cpSync(this.pathOf(n), join(target, 'skills', n), { recursive: true });
    return target;
  }

  /** Codex 용: 전용 프로필의 skills 폴더를 고른 스킬로 맞춘다 */
  syncTo(skillsDir: string, names: string[]) {
    rmSync(skillsDir, { recursive: true, force: true });
    mkdirSync(skillsDir, { recursive: true });
    for (const n of names) cpSync(this.pathOf(n), join(skillsDir, n), { recursive: true });
  }
}

/** 폴더 안의 <이름>/SKILL.md 들 */
export function readSkills(dir: string): HubSkill[] {
  const out: HubSkill[] = [];
  for (const n of safeList(dir)) {
    const md = join(dir, n, 'SKILL.md');
    if (!existsSync(md)) continue;
    const text = readFileSync(md, 'utf8').replace(/^\uFEFF/, '');
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    const get = (k: string) => m?.[1].match(new RegExp(`^${k}:\\s*(.+)$`, 'm'))?.[1].trim().replace(/^["']|["']$/g, '');
    out.push({ name: get('name') ?? n, description: get('description') ?? '', body: (m?.[2] ?? text).trim() });
  }
  return out;
}

function safeList(d: string): string[] {
  try {
    return readdirSync(d).filter((n) => {
      try {
        return statSync(join(d, n)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}
