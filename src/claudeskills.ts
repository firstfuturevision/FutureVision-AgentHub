import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * 이 PC 의 Claude Code 스킬 전체 — 사람이 대시보드 · 화면에서 보고 고치는 용(에이전트가 스스로 고치는 기능이 아님).
 *  - personal: ~/.claude/skills/<이름>/SKILL.md. 계정 동기화(synced/…)는 읽기만(고쳐도 계정이 덮어씀)
 *  - project : 작업 폴더마다 <폴더>/.claude/skills/<이름>/SKILL.md (읽기 + 켜기 · 끄기)
 *  - plugin  : ~/.claude/plugins/installed_plugins.json 의 설치 폴더/skills. 읽기만, 켜기 · 끄기는 플러그인 단위(settings.json enabledPlugins)
 * 끄기: 스킬 폴더를 같은 자리의 skills-disabled/ 로 옮긴다 — Claude Code 가 그 폴더는 읽지 않는다. 켜면 되돌린다.
 */
export type SkillWhere = 'personal' | 'project' | 'plugin';
export interface ClaudeSkill {
  name: string; description: string; where: SkillWhere; enabled: boolean; editable: boolean;
  dir: string; // 스킬 폴더(이 PC 경로 — 보이기용)
  plugin?: string; // plugin 일 때 "이름@마켓"
  project?: string; // project 일 때 작업 폴더
  synced?: true; // 계정 동기화 스킬
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function front(file: string): { name?: string; description?: string; body: string } {
  try {
    const t = readFileSync(file, 'utf8').replace(/^﻿/, '');
    const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!m) return { body: t };
    const get = (k: string) => {
      const v = m[1].match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1]?.trim();
      if (!v) return undefined;
      try { return v.startsWith('"') ? JSON.parse(v) : v.replace(/^'(.*)'$/, '$1'); } catch { return v; }
    };
    return { name: get('name'), description: get('description'), body: t.slice(m[0].length).trim() };
  } catch {
    return { body: '' };
  }
}

function dirs(dir: string): string[] {
  try { return readdirSync(dir).filter((n) => { try { return statSync(join(dir, n)).isDirectory(); } catch { return false; } }); } catch { return []; }
}

export class ClaudeSkills {
  private home: string;
  private projects: () => string[];
  constructor(home = homedir(), projects: () => string[] = () => []) {
    this.home = home;
    this.projects = projects;
  }

  private get base() { return join(this.home, '.claude'); }
  private settingsFile() { return join(this.base, 'settings.json'); }
  private readSettings(): Record<string, any> { try { return JSON.parse(readFileSync(this.settingsFile(), 'utf8')); } catch { return {}; } }

  /** 한 skills 폴더(켜진 것)와 그 옆 skills-disabled(꺼진 것) */
  private scanPair(root: string, where: SkillWhere, extra: Partial<ClaudeSkill>, editable: boolean): ClaudeSkill[] {
    const out: ClaudeSkill[] = [];
    for (const [sub, enabled] of [['skills', true], ['skills-disabled', false]] as const) {
      const d = join(root, sub);
      for (const n of dirs(d)) {
        const md = join(d, n, 'SKILL.md');
        if (existsSync(md)) {
          const f = front(md);
          out.push({ name: f.name ?? n, description: f.description ?? '', where, enabled, editable, dir: join(d, n), ...extra });
        } else if (where === 'personal' && n === 'synced') {
          // 계정 동기화: synced/<계정>/<스킬> — 읽기만
          for (const acct of dirs(join(d, n))) for (const s of dirs(join(d, n, acct))) {
            const smd = join(d, n, acct, s, 'SKILL.md');
            if (existsSync(smd)) { const f = front(smd); out.push({ name: f.name ?? s, description: f.description ?? '', where, enabled, editable: false, synced: true, dir: join(d, n, acct, s), ...extra }); }
          }
        }
      }
    }
    return out;
  }

  list(): ClaudeSkill[] {
    const out: ClaudeSkill[] = [...this.scanPair(this.base, 'personal', {}, true)];
    for (const p of [...new Set(this.projects())]) out.push(...this.scanPair(join(p, '.claude'), 'project', { project: p }, false));
    // 플러그인: 설치 목록 + 켜짐(settings.enabledPlugins)
    const on = this.readSettings().enabledPlugins ?? {};
    let installed: Record<string, { installPath?: string }[]> = {};
    try { installed = JSON.parse(readFileSync(join(this.base, 'plugins', 'installed_plugins.json'), 'utf8')).plugins ?? {}; } catch {}
    for (const [key, list] of Object.entries(installed)) {
      const path = list?.at(-1)?.installPath;
      if (!path) continue;
      for (const n of dirs(join(path, 'skills'))) {
        const md = join(path, 'skills', n, 'SKILL.md');
        if (!existsSync(md)) continue;
        const f = front(md);
        out.push({ name: f.name ?? n, description: f.description ?? '', where: 'plugin', plugin: key, enabled: on[key] !== false, editable: false, dir: join(path, 'skills', n) });
      }
    }
    return out;
  }

  /** 개인 스킬 하나(내용까지). 계정 동기화 · 플러그인 · 작업 폴더 스킬도 읽기는 된다(where · plugin · project 로 고름) */
  read(q: { name: string; where?: SkillWhere; plugin?: string; project?: string }): ClaudeSkill & { body: string } {
    const s = this.list().find((x) => x.name === q.name && (x.where === (q.where ?? 'personal')) && (!q.plugin || x.plugin === q.plugin) && (!q.project || x.project === q.project));
    if (!s) throw new Error('없는 스킬');
    return { ...s, body: front(join(s.dir, 'SKILL.md')).body };
  }

  /** 개인 스킬 저장 · 새로 만들기(꺼져 있으면 꺼진 자리에) */
  save(input: unknown): ClaudeSkill {
    const v = (input ?? {}) as Record<string, unknown>;
    const name = typeof v.name === 'string' ? v.name.trim() : '';
    if (!NAME_RE.test(name)) throw new Error('스킬 이름은 영문 소문자 · 숫자 · - (예: quote-writing)');
    if (name === 'synced') throw new Error('쓸 수 없는 이름');
    const description = typeof v.description === 'string' ? v.description.trim().replace(/\s+/g, ' ') : '';
    if (!description || description.length > 1024) throw new Error('설명(언제 쓰는 스킬인지)을 1~1024자로');
    const body = typeof v.body === 'string' ? v.body.trim() : '';
    if (!body || body.length > 100000) throw new Error('스킬 내용을 적어 주세요');
    const off = join(this.base, 'skills-disabled', name);
    const dir = existsSync(join(off, 'SKILL.md')) ? off : join(this.base, 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`);
    return this.list().find((x) => x.where === 'personal' && x.dir === dir)!;
  }

  /** 개인 스킬 지우기(계정 동기화는 안 됨) */
  remove(name: string) {
    if (!NAME_RE.test(name) || name === 'synced') throw new Error('개인 스킬 이름이 아님');
    const hit = [join(this.base, 'skills', name), join(this.base, 'skills-disabled', name)].filter((d) => existsSync(join(d, 'SKILL.md')));
    if (!hit.length) throw new Error('없는 스킬');
    for (const d of hit) rmSync(d, { recursive: true, force: true });
  }

  /** 켜기 · 끄기. personal · project 는 스킬 폴더를 skills ↔ skills-disabled 로 옮기고, plugin 은 플러그인 통째로(settings.json) */
  setEnabled(q: { name?: string; where?: SkillWhere; plugin?: string; project?: string; enabled?: unknown }) {
    const enabled = q.enabled === true;
    if (q.enabled !== true && q.enabled !== false) throw new Error('enabled 는 true 나 false');
    if (q.where === 'plugin') {
      const key = String(q.plugin ?? '');
      if (!this.list().some((x) => x.where === 'plugin' && x.plugin === key)) throw new Error('설치되지 않은 플러그인');
      const s = this.readSettings();
      s.enabledPlugins = { ...(s.enabledPlugins ?? {}), [key]: enabled };
      writeFileSync(`${this.settingsFile()}.tmp`, JSON.stringify(s, null, 2));
      renameSync(`${this.settingsFile()}.tmp`, this.settingsFile());
      return;
    }
    const where = q.where ?? 'personal';
    const s = this.list().find((x) => x.where === where && x.name === q.name && (where !== 'project' || x.project === q.project));
    if (!s) throw new Error('없는 스킬');
    if (s.synced) throw new Error('계정 동기화 스킬은 여기서 켜고 끌 수 없음(Claude 계정 설정에서)');
    if (s.enabled === enabled) return;
    const root = where === 'project' ? join(s.project!, '.claude') : this.base;
    const folder = s.dir.split(/[\\/]/).pop()!;
    const to = join(root, enabled ? 'skills' : 'skills-disabled', folder);
    if (existsSync(to)) throw new Error('같은 이름의 스킬이 이미 반대쪽에 있음');
    mkdirSync(join(root, enabled ? 'skills' : 'skills-disabled'), { recursive: true });
    renameSync(s.dir, to);
  }
}
