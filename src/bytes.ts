/**
 * 받은 조각을 모아 두는 줄 — 들어올 때마다 Buffer.concat 으로 처음부터 이어 붙이면 큰 메시지(화면 한 장 8MB)에서
 * 조각 수의 제곱만큼 복사한다(1920×1080 한 장에 100ms 넘게). 여기서는 꺼낼 때 한 번만 붙인다.
 */
export class ByteQueue {
  private parts: Buffer[] = [];
  length = 0;

  push(b: Buffer) {
    if (!b.length) return;
    this.parts.push(b);
    this.length += b.length;
  }

  /** 앞의 n 바이트(꺼내지 않음). 모자라면 null */
  peek(n: number): Buffer | null {
    if (this.length < n) return null;
    if (this.parts[0].length < n) this.merge(n);
    return this.parts[0].subarray(0, n);
  }

  /** 앞의 n 바이트를 꺼낸다. 모자라면 null */
  take(n: number): Buffer | null {
    if (this.length < n) return null;
    if (n === 0) return Buffer.alloc(0);
    if (this.parts[0].length < n) this.merge(n);
    const first = this.parts[0];
    const out = first.subarray(0, n);
    if (first.length === n) this.parts.shift();
    else this.parts[0] = first.subarray(n);
    this.length -= n;
    return out;
  }

  /** 앞 조각들을 적어도 n 바이트가 되게 하나로 */
  private merge(n: number) {
    let k = 0, got = 0;
    while (got < n) got += this.parts[k++].length;
    this.parts.splice(0, k, Buffer.concat(this.parts.slice(0, k), got));
  }

  clear() { this.parts = []; this.length = 0; }
}
