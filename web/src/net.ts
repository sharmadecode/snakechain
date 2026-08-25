export type MsgHandler = (msg: Record<string, unknown>) => void;
/** Close-code-aware disconnect callback (1013 = server/arena full). */
export type CloseHandler = (code: number) => void;

/** How long a CONNECTING socket may hang before we treat it as dead. */
const CONNECT_TIMEOUT_MS = 8000;

export class Net {
  url: string;
  onMsg: MsgHandler;
  onOpen: () => void;
  onClose: CloseHandler;
  private ws: WebSocket | null = null;
  private pingTimer: number | null = null;
  private connectTimer: number | null = null;

  constructor(url: string, onMsg: MsgHandler, onOpen: () => void, onClose: CloseHandler) {
    this.url = url;
    this.onMsg = onMsg;
    this.onOpen = onOpen;
    this.onClose = onClose;
  }

  connect(): void {
    // Supersede any previous socket first: overwriting the reference without
    // closing leaks the old socket AND lets its late handlers (onclose in
    // particular) clobber the fresh connection's state.
    this.destroySocket();

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.onClose(1006); // abnormal closure — construction failed synchronously
      return;
    }
    this.ws = ws;

    this.connectTimer = window.setTimeout(() => {
      // Server accepted TCP but never completed the handshake — abort so the
      // UI can show an error instead of hanging on "ENTERING ARENA…" forever.
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      if (this.ws !== ws) return; // superseded while connecting
      this.clearConnectTimer();
      this.onOpen();
      this.clearPingTimer();
      this.pingTimer = window.setInterval(() => this.send({ t: "ping", n: Date.now() }), 5000);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      try {
        const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
        this.onMsg(msg);
      } catch {
        if (import.meta.env.DEV) console.warn("[net] malformed frame dropped");
      }
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return; // a stale socket closed; the live one is fine
      this.destroySocket();
      this.onClose(ev.code);
    };
    ws.onerror = () => {
      if (this.ws !== ws) return;
      try {
        ws.close();
      } catch {
        /* noop */
      }
    };
  }

  send(obj: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  close(): void {
    this.destroySocket();
  }

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private destroySocket(): void {
    this.clearPingTimer();
    this.clearConnectTimer();
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    } catch {
      /* noop */
    }
  }

  private clearPingTimer(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }
}
