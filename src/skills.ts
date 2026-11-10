import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentKind } from './protocol.ts';

/**
 * 세션에 적용되는 스킬(지침) 목록 — 그 CLI 가 실제로 읽는 폴더를 그대로 본다(보기 전용).
 *  - Claude: ~/.claude/skills (계정 동기화 스킬은 한 단계 안쪽), <작업 폴더>/.claude/skills
 *  - Codex : ~/.codex/skills, ~/.agents/skills(공용), <작업 폴더>/.agents/skills
 *  - Gemini: 스킬 개념 없음(GEMINI.md 를 지침으로 읽음) → <작업 폴더>/GEMINI.md 가 있으면 표시
 * SKILL.md 맨 위 name·description 만 읽는다.
 */
export interface SkillInfo { name: string; description: string; where: string }

export function skillsFor(agent: AgentKind, workdir: string, home = homedir()): SkillInfo[] {
  const out: SkillInfo[] = [];
  const add = (dir: string, where: string, nested = false) => out.push(...scan(dir, where, nested));
  if (agent === 'claude') {
    add(join(home, '.claude', 'skills'), '계정', true);
    add(join(workdir, '.claude', 'skills'), '작업 폴더');
  } else if (agent === 'codex') {
    add(join(home, '.codex', 'skills'), '계정');
    add(join(home, '.agents', 'skills'), '공용');
    add(join(workdir, '.agents', 'skills'), '작업 폴더');
  } else {
    if (existsSync(join(workdir, 'GEMINI.md'))) out.push({ name: 'GEMINI.md', description: '작업 폴더의 Gemini 지침 파일', where: '작업 폴더' });
  }
  // 같은 이름은 하나로(작업 폴더가 계정보다 우선)
  const seen = new Map<string, SkillInfo>();
  for (const s of out) seen.set(s.name, s);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function scan(dir: string, where: string, nested: boolean, depth = 0): SkillInfo[] {
  const out: SkillInfo[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    const p = join(dir, n);
    try {
      if (!statSync(p).isDirectory()) continue;
    } catch {
      continue;
    }
    const md = join(p, 'SKILL.md');
    if (existsSync(md)) {
      const fm = front(md);
      out.push({ name: fm.name ?? n, description: fm.description ?? '', where });
    } else if (nested && depth < 3) out.push(...scan(p, where, nested, depth + 1));
  }
  return out;
}

function front(file: string): { name?: string; description?: string } {
  try {
    const m = readFileSync(file, 'utf8').replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return {};
    const get = (k: string) => m[1].match(new RegExp(`^${k}:\\s*(.+)$`, 'm'))?.[1].trim().replace(/^["']|["']$/g, '');
    const d = get('description');
    return { name: get('name'), description: d && d.length > 200 ? d.slice(0, 200) + '…' : d };
  } catch {
    return {};
  }
}
