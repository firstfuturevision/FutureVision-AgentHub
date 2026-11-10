import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnCli } from './spawn.ts';
import type { SessionInfo } from '../protocol.ts';
import type { AgentAdapter, Emit, ImagePart, StartContext } from './types.ts';

export interface ClaudeOptions {
  command: string; // 'claude' 또는 시험용 가짜 CLI
  extraArgs?: string[]; // command 앞에 붙는 인자(예: node 스크립트 경로)
  permissionMode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  model?: string;
}

/**
 * Claude Code 를 `-p` stream-json 모드로 세션 동안 계속 띄워 둔다.
 * 입력: 한 줄에 사용자 메시지 JSON 하나. 출력: 한 줄에 이벤트 JSON 하나.
 * (2.1.283 에서 형식 확인 — docs/DESIGN.md §5)
 */
export class ClaudeAdapter implements AgentAdapter {
  private opts: ClaudeOptions;
  private proc: ChildProcess | null = null;
  private emit: Emit = () => {};
  private stopped = false;
  private stderrTail: string[] = [];
  private partialText = '';
  claudeSessionId: string | null = null; // 나중에 --resume 으로 이어 가기용

  constructor(opts: ClaudeOptions) {
    this.opts = opts;
  }

  async start(session: SessionInfo, emit: Emit, ctx: StartContext = {}) {
    this.emit = emit;
    const args = [
      ...(this.opts.extraArgs ?? []),
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', this.opts.permissionMode,
    ];
    for (const d of ctx.extraDirs ?? []) args.push('--add-dir', d); // 연결 폴더
    if (ctx.pluginDir) args.push('--plugin-dir', ctx.pluginDir); // 프리셋: Agent Hub 스킬
    const model = session.model ?? this.opts.model;
    if (model) args.push('--model', model);
    if (ctx.configDir) {
      // MCP 는 Agent Hub 가 정한 것만: 메인이면 hub(clink·프리셋) + 설정의 툴. 계정의 MCP 설정은 읽지 않는다(--strict-mcp-config).
      // 붙인 서버의 도구는 묻지 않고 쓰게 한다 — -p 모드에는 대화형 승인이 없고, 툴은 사람이 설정에서 직접 넣은 것이라서.
      const servers: Record<string, unknown> = {};
      if (ctx.mcp) servers[ctx.mcp.name] = { type: 'http', url: ctx.mcp.url };
      for (const t of ctx.tools ?? []) {
        servers[t.name] = t.type === 'http' ? { type: 'http', url: t.url } : { type: 'stdio', command: t.command, args: t.args ?? [] };
      }
      mkdirSync(ctx.configDir, { recursive: true });
      const file = join(ctx.configDir, `${session.id}.json`);
      writeFileSync(file, JSON.stringify({ mcpServers: servers }));
      args.push('--mcp-config', file, '--strict-mcp-config');
      const allowed = Object.keys(servers).map((n) => `mcp__${n}`);
      if (allowed.length) args.push('--allowedTools', allowed.join(','));
    }

    this.proc = spawnCli(this.opts.command, args, session.workdir, ctx.env);

    createInterface({ input: this.proc.stdout! }).on('line', (line) => this.onLine(line));
    createInterface({ input: this.proc.stderr! }).on('line', (line) => {
      this.stderrTail.push(line);
      if (this.stderrTail.length > 20) this.stderrTail.shift();
    });
    this.proc.on('error', (err) => {
      this.emit({ type: 'error', message: `Claude 실행 실패: ${err.message}` });
    });
    this.proc.on('exit', (code) => {
      const tail = this.stderrTail.slice(-3).join(' / ');
      const reason = this.stopped ? '사용자가 종료함' : `Claude 프로세스 종료 (code ${code})${tail ? `: ${tail}` : ''}`;
      this.emit({ type: 'session.ended', reason });
    });
  }

  send(text: string, images: ImagePart[] = []) {
    if (!this.proc?.stdin?.writable) {
      this.emit({ type: 'error', message: 'Claude 프로세스가 입력을 받을 수 없음' });
      return;
    }
    // 이미지는 Anthropic 메시지 형식의 image 블록으로, 글보다 앞에
    const content = [
      ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } })),
      { type: 'text', text },
    ];
    const msg = { type: 'user', message: { role: 'user', content } };
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  respondPermission() {
    // -p 모드는 대화형 승인이 없다. 승인 흐름은 다음 단계(permission-prompt 도구 또는 ACP).
    this.emit({ type: 'error', message: 'Claude 승인 응답은 아직 지원하지 않음' });
  }

  stop() {
    this.stopped = true;
    this.proc?.stdin?.end();
    const p = this.proc;
    setTimeout(() => { if (p && p.exitCode === null) p.kill(); }, 3000);
  }

  /** Claude stream-json 한 줄 → 공통 이벤트 */
  private onLine(line: string) {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return; // JSON 이 아닌 줄은 무시
    }
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init' && typeof ev.session_id === 'string') this.claudeSessionId = ev.session_id;
        return;

      case 'stream_event': {
        const d = ev.event;
        if (d?.type === 'content_block_delta' && d.delta?.type === 'text_delta') {
          this.partialText += d.delta.text;
          this.emit({ type: 'agent.text', text: this.partialText, partial: true });
        }
        return;
      }

      case 'assistant': {
        if (ev.parent_tool_use_id) return; // 하위 에이전트 내부 대화는 화면에 올리지 않는다
        if (ev.error) {
          const msg = ev.message?.content?.find((b: any) => b.type === 'text')?.text ?? String(ev.error);
          this.partialText = '';
          this.emit({ type: 'error', message: msg });
          return;
        }
        for (const block of ev.message?.content ?? []) {
          if (block.type === 'text' && block.text) {
            this.partialText = '';
            this.emit({ type: 'agent.text', text: block.text, partial: false });
          } else if (block.type === 'tool_use') {
            this.emit({ type: 'agent.tool', toolId: block.id, name: block.name, input: block.input });
          }
        }
        return;
      }

      case 'user': {
        if (ev.parent_tool_use_id) return;
        const content = ev.message?.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (block.type === 'tool_result') {
            this.emit({
              type: 'agent.tool_result',
              toolId: block.tool_use_id,
              ok: !block.is_error,
              summary: summarize(block.content),
            });
          }
        }
        return;
      }

      case 'result':
        this.partialText = '';
        this.emit({
          type: 'turn.done',
          durationMs: Number(ev.duration_ms ?? 0),
          costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null,
          isError: Boolean(ev.is_error),
        });
        return;
    }
  }
}

function summarize(content: unknown): string {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) text = content.map((c: any) => (c?.type === 'text' ? c.text : '')).join(' ');
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > 200 ? text.slice(0, 200) + '…' : text;
}
