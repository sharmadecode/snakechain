export type MsgHandler = (msg: Record<string, unknown>) => void;

export class Net {
  url: string;
  onMsg: MsgHandler;
  onClose: () => void;
  onOpen: () => void;
  private ws: WebSocket | null = null;
  private pingTimer: number | null = null;

  constructor(url: string, onMsg: MsgHandler, onOpen: () => void, onClose: () => void) {
    this.url = url;
    this.onMsg = onMsg;
    this.onOpen = onOpen;
    this.onClose = onClose;
  }

  connect(): void {
    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.onClose();
      return;
    }
    this.ws.onopen = () => {
      this.onOpen();
      this.pingTimer = window.setInterval(() => this.send({ t: "ping", n: Date.now() }), 5000);
    };
    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
        this.onMsg(msg);
      } catch {
        /* ignore malformed frames */
      }
    };
    this.ws.onclose = () => {
      if (this.pingTimer !== null) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.onClose();
    };
    this.ws.onerror = () => {
      try {
        this.ws?.close();
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
    try {
      this.ws?.close();
    } catch {
      /* noop */
    }
  }

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
