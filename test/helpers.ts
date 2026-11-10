import type { HostEvent } from '../src/protocol.ts';

/** 이벤트 목록에서 조건에 맞는 첫 이벤트가 나올 때까지 기다린다. */
export function waitFor(events: HostEvent[], pred: (e: HostEvent) => boolean, ms = 5000): Promise<any> {
  return new Promise((ok, fail) => {
    const t0 = Date.now();
    const tick = () => {
      const hit = events.find(pred);
      if (hit) return ok(hit);
      if (Date.now() - t0 > ms) return fail(new Error('시간 초과: ' + JSON.stringify(events.map((e) => e.type))));
      setTimeout(tick, 20);
    };
    tick();
  });
}
