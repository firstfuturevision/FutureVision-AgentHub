import { AGENTS } from './protocol.ts';
import type { AgentKind } from './protocol.ts';
import type { SessionManager } from './sessions.ts';
import type { Preset } from './presets.ts';
import { SCREEN_TOOLS, SCREEN_INSTRUCTION, SHOW_IMAGE_TOOL, handleScreenTool } from './screen-tools.ts';

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
  '사람이 프리셋(작업 환경: 작업 폴더·함께 연결할 폴더·작업 방식 지침·기본 메인 에이전트)을 만들거나 고치거나 지워 달라고 하면 preset_list / preset_save / preset_delete 를 쓴다. 에이전트와 프리셋은 다른 것이다.',
  '사람이 프리셋·에이전트·스킬·툴을 "공유 레포에 올려 달라"고 하면 share_push 로 이름을 주어 올린다(사람 승인 후). 목록의 shared=true 는 이미 공유받은 것이라 고칠 수 없다.',
  '사람이 예약("매일 ○시에", "매주 월요일에" 등)을 부탁하면 새 작업을 만들지 말고 schedule_save 로 건다. 다른 작업(예: 영업)에 걸어 달라면 session 에 그 작업 이름을 준다. 권한·모델 같은 이 작업의 설정은 짐작하지 말고 session_info 로 확인한다. Agent Hub 의 HTTP 주소나 코드를 직접 건드려 작업·예약을 만들지 않는다.',
  '다른 작업(왼쪽 작업 목록의 작업)에 알릴 일이 있거나 사람이 "○○ 작업에 전해 줘"라고 하면 session_list 로 이름을 확인하고 session_send 로 보낸다. 분담을 만들어 달라면 session_split 으로 만든다. 사람에게 복사해 붙여 달라고 하지 않는다.',
  SCREEN_INSTRUCTION,
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

/** 지금 작업의 설정·예약 — 예약은 늘 "지금 이 작업"에 건다(새 작업을 만들지 않는다) */
export const TASK_TOOLS = [
  {
    name: 'session_info',
    title: '이 작업의 설정',
    description: '지금 이 작업의 설정을 본다: 권한 묻지 않기(autoApproveThisTask = 이 작업, autoApproveAllTasks = 모든 작업, asksPermission = 결국 승인을 묻는지), 모델, 작업 폴더, 걸린 예약 수, 이 PC 의 현지 시각. 설정을 짐작하지 말고 이것으로 확인한다.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'schedule_list',
    title: '예약 보기',
    description: '예약을 본다. 기본은 지금 이 작업(오른쪽 작업 정보의 "예약" 칸), session 을 주면 그 작업, all=true 면 모든 작업의 예약(왼쪽 "예약" 탭에 보이는 것).',
    inputSchema: { type: 'object', properties: { session: { type: 'string', description: '다른 작업 이름 또는 id' }, all: { type: 'boolean', description: 'true 면 모든 작업' } }, additionalProperties: false },
  },
  {
    name: 'schedule_save',
    title: '이 작업에 예약 걸기·고치기',
    description: '지금 이 작업에 "정한 시각에 이 지시를 보내기"를 건다(id 없이) 또는 고친다(id 와 함께). 사람이 "매일 ○시에 해줘" 같은 예약을 부탁하면 새 작업을 만들지 말고 이것으로 이 작업에 건다. 시각은 이 PC 현지 시간(session_info 의 localTime). 예약 실행은 사람이 없을 때 돌 수 있으니 session_info 의 asksPermission 이 true 면 사람에게 알려 준다.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '고칠 때만: schedule_list 의 id' },
        session: { type: 'string', description: '다른 작업에 걸 때만: 그 작업 이름(session_list 의 name) 또는 id. 없으면 이 작업' },
        prompt: { type: 'string', description: '그 시각에 이 작업에 보낼 지시(사람이 보낸 것처럼 들어온다)' },
        repeat: { type: 'string', enum: ['once', 'daily', 'weekdays', 'weekly', 'interval'], description: 'once=한 번, daily=매일, weekdays=평일(월~금), weekly=매주, interval=N분마다' },
        time: { type: 'string', description: 'HH:MM (interval 이 아니면 필수)' },
        date: { type: 'string', description: 'once 일 때 YYYY-MM-DD' },
        weekday: { type: 'integer', description: 'weekly 일 때 0=일 … 6=토' },
        every: { type: 'integer', description: 'interval 일 때 몇 분마다(5 이상)' },
        enabled: { type: 'boolean', description: '기본 true. false 면 걸어 두되 쉰다' },
      },
      required: ['prompt', 'repeat'],
      additionalProperties: false,
    },
  },
  {
    name: 'schedule_delete',
    title: '이 작업의 예약 지우기',
    description: '예약 하나를 지운다(schedule_list 의 id). 다른 작업의 예약이면 session 에 그 작업 이름.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, session: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'session_list',
    title: '작업 목록',
    description: '이 Agent Hub 의 메인 작업들(왼쪽 작업 목록)을 본다: 이름, id 앞 8자, 상태, 분담해 온 원본, 예약 수. 다른 작업에 보내거나 예약을 걸기 전에 이름을 확인한다.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'session_send',
    title: '다른 작업에 보내기',
    description: '다른 작업에 지시나 알림을 보낸다. 그 작업 대화에 "작업 <이 작업 이름>"이 보낸 글로 들어가고, 그 작업이 일하는 중이면 지금 차례가 끝난 뒤 받는다. 답은 기다리지 않는다(그 작업이 분담이면 결과가 공유로 돌아온다).',
    inputSchema: { type: 'object', properties: { session: { type: 'string', description: '받을 작업 이름(session_list 의 name) 또는 id' }, text: { type: 'string', description: '보낼 글. 받는 쪽이 앞 대화를 모르니 필요한 맥락을 함께 적는다' } }, required: ['session', 'text'], additionalProperties: false },
  },
  {
    name: 'session_split',
    title: '분담 만들기',
    description: '작업을 분담해 이름을 붙인 새 작업을 만든다. 분담은 앞 대화를 이어받고, 원본과 서로 한 일(사람 지시와 마지막 보고)을 주고받는다. from 이 없으면 이 작업을 분담한다. 만든 뒤 첫 지시는 session_send 로.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: '새 분담의 이름(작업 목록에 보임)' }, from: { type: 'string', description: '분담할 작업 이름 또는 id(없으면 이 작업)' } }, required: ['name'], additionalProperties: false },
  },
];

/** 프리셋(작업 환경)·공유 도구 */
export const WORK_TOOLS = [
  {
    name: 'preset_list',
    title: '프리셋 목록',
    description: '지금 있는 프리셋(작업 환경) 전체. 에이전트는 이름으로 보인다. shared=true 는 공유 레포에서 받은 것(고칠 수 없음).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'preset_save',
    title: '프리셋 만들기·고치기',
    description: '프리셋(작업 환경)을 만들거나(id 없이) 고친다(id 또는 이름과 함께, 바꾸지 않는 항목도 모두 다시 준다). 모든 직원이 쓰는 설정이라 저장 전에 사람 승인 화면이 뜬다.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '고칠 때만: preset_list 의 id' },
        name: { type: 'string', description: '프리셋 이름(40자 이내). 예: 견적 작업' },
        description: { type: 'string', description: '언제 쓰는 프리셋인지 한 줄' },
        folder: { type: 'string', description: '작업 폴더: 작업 폴더 뿌리 바로 아래 폴더 이름. 비우면 뿌리' },
        extraDirs: { type: 'array', items: { type: 'string' }, description: '함께 연결할 폴더 이름들(뿌리 바로 아래)' },
        guidelines: { type: 'string', description: '폴더 구조·작업 방식 지침. 메인과 하위 에이전트의 첫 지시에 붙는다' },
        mainAgent: { type: 'string', description: '선택: 이 프리셋으로 시작할 때 기본 메인 에이전트 이름' },
        agents: { type: 'array', items: { type: 'string' }, description: '선택: 이 작업에서 맡길 수 있는 하위 에이전트 이름들. 없으면 전부' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'preset_delete',
    title: '프리셋 지우기',
    description: '프리셋(작업 환경)을 지운다(이름 또는 id). 사람 승인 후에만 지워진다.',
    inputSchema: { type: 'object', properties: { preset: { type: 'string', description: '지울 프리셋의 이름 또는 id' } }, required: ['preset'], additionalProperties: false },
  },
  {
    name: 'share_push',
    title: '공유 레포에 올리기',
    description: '이 PC 의 프리셋·에이전트·스킬·툴 하나를 회사 공유 레포에 올린다(이름으로). 사람 승인 후 올라가고, 올리면 이 PC 것은 공유본(읽기 전용)으로 바뀐다. 키·토큰이 들어 있으면 거절된다.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['presets', 'agents', 'skills', 'tools'], description: 'presets=프리셋, agents=에이전트, skills=스킬, tools=툴' },
        name: { type: 'string', description: '올릴 것의 이름' },
      },
      required: ['kind', 'name'],
      additionalProperties: false,
    },
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
      return ok({ tools: [clinkTool(sessions.presetsForMain(mainId)), ...PRESET_TOOLS, ...WORK_TOOLS, ...TASK_TOOLS, ...SCREEN_TOOLS, SHOW_IMAGE_TOOL] });
    case 'tools/call': {
      const a = msg.params?.arguments ?? {};
      const text = (t: string, isError = false) => ok({ content: [{ type: 'text', text: t }], isError });
      // 화면 제어 도구(screen_*)
      const scr = await handleScreenTool(String(msg.params?.name ?? ''), a, mainId, sessions.screen);
      if (scr) return ok(scr);
      switch (msg.params?.name) {
        case 'session_info':
          try {
            const info = sessions.sessionInfoByMain(mainId);
            return ok({ content: [{ type: 'text', text: JSON.stringify(info, null, 2) }], structuredContent: info });
          } catch (err) {
            return text((err as Error).message, true);
          }
        case 'schedule_list':
          try {
            const list = sessions.scheduleListByMain(mainId, a.session, a.all === true);
            return ok({ content: [{ type: 'text', text: list.length ? JSON.stringify(list, null, 2) : '걸린 예약 없음' }], structuredContent: { schedules: list } });
          } catch (err) {
            return text((err as Error).message, true);
          }
        case 'schedule_save':
          try {
            const s = sessions.scheduleSaveByMain(mainId, a);
            return text(`예약함(id ${s.id}, 작업 ${s.task}): ${s.repeat}${s.time ? ` ${s.time}` : ''}${s.every ? ` ${s.every}분마다` : ''}, 다음 실행 ${s.nextAt ? new Date(s.nextAt).toLocaleString('ko-KR') : '없음'}. 그 작업의 오른쪽 "예약" 칸과 왼쪽 "예약" 탭에 보인다.`);
          } catch (err) {
            return text(`예약 안 됨: ${(err as Error).message}`, true);
          }
        case 'schedule_delete':
          try {
            sessions.scheduleDeleteByMain(mainId, typeof a.id === 'string' ? a.id : '', a.session);
            return text('예약을 지움');
          } catch (err) {
            return text(`지우지 않음: ${(err as Error).message}`, true);
          }
        case 'session_list': {
          const list = sessions.taskList();
          return ok({ content: [{ type: 'text', text: JSON.stringify(list, null, 2) }], structuredContent: { sessions: list } });
        }
        case 'session_send':
          try {
            return text(await sessions.taskSendByMain(mainId, a.session, a.text));
          } catch (err) {
            return text(`안 보냄: ${(err as Error).message}`, true);
          }
        case 'session_split':
          try {
            return text(await sessions.taskSplitByMain(mainId, a.name, a.from));
          } catch (err) {
            return text(`못 만듦: ${(err as Error).message}`, true);
          }
        case 'show_image':
          try {
            return text(await sessions.showImage(mainId, a));
          } catch (err) {
            return text(`못 띄움: ${(err as Error).message}`, true);
          }
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
        case 'preset_list': {
          const list = sessions.workPresetList();
          return ok({ content: [{ type: 'text', text: list.length ? JSON.stringify(list, null, 2) : '프리셋 없음' }], structuredContent: { presets: list } });
        }
        case 'preset_save':
          try {
            const p = await sessions.workPresetSaveByMain(mainId, a);
            return text(`저장함: 프리셋 "${p.name}" (id ${p.id}, 폴더 ${p.folder || '뿌리'}). 새 작업 화면에서 고를 수 있다.`);
          } catch (err) {
            return text(`저장 안 됨: ${(err as Error).message}`, true);
          }
        case 'preset_delete':
          try {
            const p = await sessions.workPresetDeleteByMain(mainId, typeof a.preset === 'string' ? a.preset : '');
            return text(`지움: 프리셋 "${p.name}"`);
          } catch (err) {
            return text(`지우지 않음: ${(err as Error).message}`, true);
          }
        case 'share_push':
          try {
            return text(await sessions.sharePushByMain(mainId, a.kind, typeof a.name === 'string' ? a.name : ''));
          } catch (err) {
            return text(`올리지 않음: ${(err as Error).message}`, true);
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
