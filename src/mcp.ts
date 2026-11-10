import { AGENTS } from './protocol.ts';
import type { AgentKind } from './protocol.ts';
import type { SessionManager } from './sessions.ts';
import type { Preset } from './presets.ts';

/**
 * 메인 에이전트에게 주는 MCP 서버 — 의존성 없이 손으로 구현한 최소 Streamable HTTP.
 * POST 한 번에 JSON-RPC 하나를 받고 application/json 으로 답한다(SSE 스트림은 쓰지 않음).
 * 도구는 clink 하나. 설계 출처: PAL MCP Server 의 clink (docs/DESIGN.md §5-1).
 */

const SERVER_INFO = { name: 'agent-hub', version: '0.2.0' };
const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = [
  '너는 Agent Hub 의 메인 에이전트다. 사람과 대화하며 일을 나누고, 작업자 AI 에게 clink 로 맡긴 뒤 결과를 검토해 보고한다.',
  '사람이 AI 나 모델을 지정하면(예: "Codex 로", "gemini-3-pro 로") 반드시 그대로 따른다. 지정이 없으면 일에 맞는 작업자를 고르거나 직접 한다.',
  '사람 글의 "@이름"은 그 이름의 에이전트(하위 에이전트)에게 맡기라는 뜻이다 → clink 의 preset 에 그 이름을 쓴다.',
  '사람 글에 [첨부 파일] 목록이 있으면 작업 폴더 기준 경로다. 하위 에이전트에게 맡길 때 필요한 첨부 경로를 지시에 적어 준다.',
  '작업자는 같은 작업 폴더에서 일한다. 같은 파일을 두 작업자에게 동시에 맡기지 않는다.',
  '새 일은 새 작업자에게(clink 에 continuation_id 없이) 맡긴다 — 앞 대화가 섞이지 않아 결과가 깨끗하고 비용이 적다. 같은 일의 후속(리뷰 반영, 이어서 더 깊게 등)일 때만 continuation_id 로 같은 작업자에게 이어서 시킨다.',
  '결과가 status=working 이면 아직 끝나지 않은 것이다(사람 승인 대기일 수 있음). 같은 continuation_id 로 prompt 없이 다시 불러 기다린다.',
  '작업자 결과를 그대로 믿지 말고 확인한 뒤, 누구에게 무엇을 맡겼고 무엇이 바뀌었는지 사람에게 짧게 보고한다.',
  '사람이 에이전트(하위 에이전트 역할)을 만들거나 고치거나 지워 달라고 하면 agent_list / agent_save / agent_delete 를 쓴다. 역할 지침은 할 일·하지 말 일·보고 형식·끝나는 조건이 드러나게 구체적으로 쓴다. 저장·삭제 전에 사람 승인 화면이 뜬다.',
].join('\n');

/** 프리셋 목록은 사람이 설정에서 바꾸므로 부를 때마다 새로 만든다 */
export function clinkTool(presets: Preset[]) {
  const names = presets.map((p) => p.name);
  return {
  name: 'clink',
  title: '작업자 AI 에게 일 맡기기',
  description:
    '다른 AI CLI(claude, gemini, codex)를 독립된 작업자로 띄워 일을 맡기고, 작업자가 이번 차례를 끝내면 최종 답을 돌려준다. ' +
    'continuation_id 를 주면 같은 작업자에게 이어서 지시한다(대화 맥락 유지). 작업자의 위험한 행동은 사람이 화면에서 승인한다.' +
    (presets.length ? ` 에이전트(역할): ${presets.map((p) => `"${p.name}"(${p.agent}${p.description ? ` — ${p.description}` : ''})`).join('; ')}` : ''),
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '작업자에게 줄 지시. 무엇을, 어디서, 끝나는 조건까지 구체적으로. 이어서 기다리기만 할 때는 비운다.' },
      ...(names.length
        ? { preset: { type: 'string', enum: names, description: '선택: 에이전트 이름 — AI·모델·역할 지침을 프리셋에서 가져온다(cli_name 불필요). 사람이 프리셋을 말하면 반드시 쓴다.' } }
        : {}),
      cli_name: { type: 'string', enum: [...AGENTS], description: '새 작업자일 때 맡길 AI. preset 을 쓰거나 사람이 고른 기본 작업자로 맡길 때는 비운다' },
      model: { type: 'string', description: '선택: 작업자 모델 (예: claude-sonnet-5-5, gpt-5.5-codex, gemini-3-pro). 없으면 그 CLI 기본 모델' },
      continuation_id: { type: 'string', description: '선택: 앞서 받은 continuation_id — 같은 작업자에게 이어서 지시하거나 기다린다' },
    },
    additionalProperties: false,
  },
  };
}

/** 프리셋 관리 도구 — 사람이 "프리셋 만들어 줘" 하면 메인이 쓴다. 저장·삭제는 사람 승인 후에만. */
const PRESET_FIELDS = {
  name: { type: 'string', description: '프리셋 이름(40자 이내). 예: 코드 리뷰어' },
  agent: { type: 'string', enum: [...AGENTS], description: '이 역할을 맡을 AI' },
  model: { type: 'string', description: '선택: 모델 id. 비우면 그 AI 의 기본 모델' },
  description: { type: 'string', description: '언제 이 프리셋을 쓰는지 한 줄(300자 이내) — 메인이 고를 때 본다' },
  instructions: { type: 'string', description: '작업자에게 줄 역할 지침: 할 일·하지 말 일·보고 형식·끝나는 조건(8000자 이내)' },
};
export const PRESET_TOOLS = [
  {
    name: 'agent_list',
    title: '에이전트 목록',
    description: '지금 있는 에이전트(하위 에이전트 역할) 전체를 돌려준다. 고치거나 지우기 전에 id 를 확인할 때 쓴다.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'agent_save',
    title: '에이전트 만들기·고치기',
    description:
      '에이전트을 만들거나(id 없이) 고친다(id 와 함께, 바꾸지 않는 항목도 모두 다시 준다). 모든 직원이 함께 쓰는 설정이라 저장 전에 사람에게 승인 화면이 뜨고, 거부되면 저장되지 않는다. ' +
      '이름·AI·역할이 분명하지 않으면 먼저 사람에게 물어본다.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: '고칠 때만: agent_list 의 id' }, ...PRESET_FIELDS }, required: ['name', 'agent', 'instructions'], additionalProperties: false },
  },
  {
    name: 'agent_delete',
    title: '에이전트 지우기',
    description: '에이전트을 지운다(이름 또는 id). 사람 승인 후에만 지워진다.',
    inputSchema: { type: 'object', properties: { preset: { type: 'string', description: '지울 프리셋의 이름 또는 id' } }, required: ['preset'], additionalProperties: false },
  },
];

type Rpc = { jsonrpc?: string; id?: number | string | null; method?: string; params?: any };

/** JSON-RPC 메시지 하나 처리. 알림(id 없음)이면 null(→ 202). */
export async function handleMcp(msg: Rpc, mainId: string, sessions: SessionManager): Promise<object | null> {
  const id = msg.id ?? null;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (msg.id === undefined) return null; // notifications/initialized 등

  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      // 사람이 화면에서 고른 작업자 기본 모델도 알려 준다
      const dw = sessions.info(mainId)?.defaultWorker;
      const picked = dw ? `${dw.agent}${dw.model ? `(${dw.model})` : ''}` : '';
      const presets = sessions.presetsForMain(mainId); // 이 메인이 맡길 수 있는 것만 알린다
      return ok({
        protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          INSTRUCTIONS +
          (picked ? `\n사람이 고른 기본 작업자: ${picked}. 사람이 다른 AI 를 말하지 않으면 이 작업자에게 맡긴다(clink 에 cli_name 을 비우면 자동으로 이 작업자).` : '') +
          (presets.length ? `\n맡길 수 있는 하위 에이전트: ${presets.map((p) => p.name).join(', ')}. 일이 에이전트 설명에 맞으면 clink 의 preset 에 그 이름을 쓴다.` : ''),
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: [clinkTool(sessions.presetsForMain(mainId)), ...PRESET_TOOLS] });
    case 'tools/call': {
      const a = msg.params?.arguments ?? {};
      const text = (t: string, isError = false) => ok({ content: [{ type: 'text', text: t }], isError });
      switch (msg.params?.name) {
        case 'clink':
          break;
        case 'agent_list': {
          const list = sessions.presetList();
          return ok({ content: [{ type: 'text', text: list.length ? JSON.stringify(list, null, 2) : '프리셋 없음' }], structuredContent: { presets: list } });
        }
        case 'agent_save':
          try {
            const p = await sessions.presetSaveByMain(mainId, a);
            return text(`저장함: "${p.name}" (id ${p.id}, ${p.agent}${p.model ? ` · ${p.model}` : ''}). 새 작업부터 clink 의 preset 으로 쓸 수 있다.`);
          } catch (err) {
            return text(`저장 안 됨: ${(err as Error).message}`, true);
          }
        case 'agent_delete':
          try {
            const p = await sessions.presetDeleteByMain(mainId, typeof a.preset === 'string' ? a.preset : '');
            return text(`지움: "${p.name}"`);
          } catch (err) {
            return text(`지우지 않음: ${(err as Error).message}`, true);
          }
        default:
          return fail(-32602, `모르는 도구: ${msg.params?.name}`);
      }
      try {
        const r = await sessions.clink(mainId, {
          prompt: typeof a.prompt === 'string' ? a.prompt : undefined,
          preset: typeof a.preset === 'string' && a.preset ? a.preset : undefined,
          cli_name: typeof a.cli_name === 'string' ? (a.cli_name as AgentKind) : undefined,
          model: typeof a.model === 'string' && a.model ? a.model : undefined,
          continuation_id: typeof a.continuation_id === 'string' && a.continuation_id ? a.continuation_id : undefined,
        });
        const head = `[${r.cli_name}${r.model ? ` · ${r.model}` : ''}] status=${r.status} continuation_id=${r.continuation_id} (${(r.duration_ms / 1000).toFixed(1)}초)`;
        return ok({
          content: [{ type: 'text', text: `${head}\n\n${r.content}` }],
          structuredContent: r,
          isError: r.status === 'failed' || r.status === 'ended',
        });
      } catch (err) {
        // 도구 실행 오류는 에이전트가 읽고 고칠 수 있게 결과로 돌려준다(프로토콜 오류 아님)
        return ok({ content: [{ type: 'text', text: `clink 오류: ${(err as Error).message}` }], isError: true });
      }
    }
    default:
      return fail(-32601, `지원하지 않는 메서드: ${msg.method}`);
  }
}
