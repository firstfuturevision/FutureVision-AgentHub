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
  private permSeq = 0;
  private interrupting = false; // 멈춤을 보냈음 — 그 차례의 끝(error_during_execution)은 오류가 아니다
  private lastUsed = 0; // 메인 줄기의 마지막 응답이 받은 입력 토큰 — 지금 컨텍스트에 든 양
  private permissions = new Map<string, { requestId: string; input: unknown }>(); // 화면 요청 id → CLI 요청
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
      // 권한 묻지 않기면 확인 없이 실행(bypassPermissions). 아니면 설정값
      '--permission-mode', session.autoApprove ? 'bypassPermissions' : this.opts.permissionMode,
    ];
    // 물어야 하는 도구는 stdout 의 control_request(can_use_tool)로 오고, 화면의 허용·거부를 stdin 의 control_response 로 돌려준다
    if (!session.autoApprove) args.push('--permission-prompt-tool', 'stdio');
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

  respondPermission(requestId: string, allow: boolean) {
    const p = this.permissions.get(requestId);
    if (!p) return;
    this.permissions.delete(requestId);
    // 허용은 이번 한 번만(같은 폴더라도 다음에 또 묻는다) — 화면 버튼이 "허용"·"거부" 둘뿐이라서
    const response = allow ? { behavior: 'allow', updatedInput: p.input } : { behavior: 'deny', message: '사람이 거부함' };
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: p.requestId, response } });
  }

  /** 멈춤: stdin 의 control_request(interrupt). 이 차례는 result 로 끝나고 같은 프로세스가 다음 지시를 받는다(2.1.283 확인) */
  interrupt() {
    if (!this.proc?.stdin?.writable) return;
    for (const id of [...this.permissions.keys()]) this.respondPermission(id, false);
    this.interrupting = true;
    this.write({ type: 'control_request', request_id: `int${++this.permSeq}`, request: { subtype: 'interrupt' } });
  }

  private write(msg: unknown) {
    if (this.proc?.stdin?.writable) this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  stop() {
    this.stopped = true;
    for (const id of [...this.permissions.keys()]) this.respondPermission(id, false);
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
      case 'control_request': {
        const r = ev.request ?? {};
        if (r.subtype !== 'can_use_tool') {
          this.write({ type: 'control_response', response: { subtype: 'error', request_id: ev.request_id, error: `지원하지 않는 요청: ${r.subtype}` } });
          return;
        }
        const requestId = `c${++this.permSeq}`;
        this.permissions.set(requestId, { requestId: ev.request_id, input: r.input ?? {} });
        const what = r.description ?? brief(r.input);
        const why = r.decision_reason_type === 'workingDir' ? '작업 폴더 밖' : '';
        this.emit({ type: 'permission.request', requestId, tool: r.display_name ?? r.tool_name ?? '도구 실행', detail: [what, why].filter(Boolean).join(' · ') });
        return;
      }

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
        const u = ev.message?.usage;
        if (u) this.lastUsed = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens) + num(u.output_tokens);
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

      case 'result': {
        this.partialText = '';
        // 컨텍스트 창: 이 차례에 쓴 모델 중 가장 큰 것(하위 에이전트가 작은 모델을 썼을 수 있다)
        const windows = Object.values(ev.modelUsage ?? {}).map((m: any) => num(m?.contextWindow)).filter((n) => n > 0);
        if (this.lastUsed) this.emit({ type: 'context.usage', used: this.lastUsed, window: windows.length ? Math.max(...windows) : null });
        this.emit({
          type: 'turn.done',
          durationMs: Number(ev.duration_ms ?? 0),
          costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null,
          isError: Boolean(ev.is_error) && !this.interrupting,
        });
        this.interrupting = false;
        return;
      }
    }
  }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function brief(input: any): string {
  if (!input || typeof input !== 'object') return '';
  const v = input.file_path ?? input.path ?? input.command ?? input.url ?? input.query ?? input.pattern;
  const t = typeof v === 'string' ? v : '';
  return t.length > 200 ? t.slice(0, 200) + '…' : t;
}

function summarize(content: unknown): string {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) text = content.map((c: any) => (c?.type === 'text' ? c.text : '')).join(' ');
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > 200 ? text.slice(0, 200) + '…' : text;
}
