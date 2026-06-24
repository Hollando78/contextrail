/**
 * ContextRail desklet — zero-state browser/PWA client. (ARC-REQ-002)
 *
 * Holds no credentials and no executable capability (SYS-REQ-001): it pairs with
 * a one-time token, receives a short-lived session token, renders its single
 * assigned role from streamed context, and dispatches high-level intents. On
 * disconnect it reconnects with exponential back-off (capped 30 s) and re-binds
 * its role from the host without re-pairing. (SUB-DCF-051..055, SUB-KWD-068/074)
 */
declare const navigator: { userAgent: string };
declare const location: { href: string; search: string; host: string; protocol: string };
declare const localStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void };
declare const document: any;
declare const window: any;
declare function fetch(url: string, init?: any): Promise<any>;
declare const WebSocket: any;
declare function setTimeout(fn: () => void, ms: number): number;

const RECONNECT_CAP_MS = 30_000;
const STALENESS_MS = 10_000;

interface Session {
  sessionToken: string;
  fingerprint: string;
  deviceId: string;
  role: string;
}

const el = (id: string) => document.getElementById(id);

function randomSeed(): string {
  let seed = localStorage.getItem('cr_seed');
  if (!seed) {
    seed = Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
    localStorage.setItem('cr_seed', seed);
  }
  return seed;
}

function loadSession(): Session | null {
  const raw = localStorage.getItem('cr_session');
  return raw ? (JSON.parse(raw) as Session) : null;
}

function saveSession(s: Session): void {
  localStorage.setItem('cr_session', JSON.stringify(s));
}

async function pair(ott: string): Promise<Session> {
  const res = await fetch('/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ott, fingerprintParts: { ua: navigator.userAgent, seed: randomSeed() } }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: 'pairing failed' }));
    throw new Error(err.message || err.error || 'pairing rejected');
  }
  const data = await res.json();
  const session: Session = {
    sessionToken: data.sessionToken,
    fingerprint: data.fingerprint,
    deviceId: data.deviceId,
    role: data.role,
  };
  saveSession(session);
  return session;
}

class DeskletClient {
  private ws: any;
  private backoff = 500;
  private lastContext = 0;
  private firstConnect = true;
  private staleTimer = 0;
  private pingTimer = 0;
  private readonly context: Record<string, unknown> = {};

  constructor(private session: Session) {}

  start(): void {
    this.renderShell();
    this.connect();
    this.staleTimer = window.setInterval(() => this.checkStale(), 1000);
  }

  private url(useToken: boolean): string {
    // wss on the LAN (TLS), ws on a loopback http dev tab (localhost = secure context).
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const base = `${scheme}://${location.host}/`;
    const q = new URLSearchParams({ fp: this.session.fingerprint, deviceId: this.session.deviceId });
    if (useToken) q.set('token', this.session.sessionToken);
    return `${base}?${q.toString()}`;
  }

  private connect(): void {
    this.setStatus('connecting…');
    const ws = new WebSocket(this.url(this.firstConnect));
    this.ws = ws;
    ws.onopen = () => {
      this.firstConnect = false;
      this.backoff = 500;
      this.lastContext = Date.now();
      this.setStatus('live');
      // App-level keepalive: the host marks a desklet stale after 5 s without
      // liveness, and browser auto-pong isn't reliable on mobile, so send our own
      // ping every 2 s. The gateway treats kind:'ping' as a liveness signal.
      if (this.pingTimer) window.clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => {
        if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ kind: 'ping' }));
      }, 2000);
    };
    ws.onmessage = (ev: any) => this.onFrame(JSON.parse(ev.data));
    ws.onclose = () => {
      if (this.pingTimer) window.clearInterval(this.pingTimer);
      this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect(): void {
    this.setStatus('reconnecting…');
    const delay = Math.min(this.backoff, RECONNECT_CAP_MS);
    this.backoff = Math.min(this.backoff * 2, RECONNECT_CAP_MS);
    setTimeout(() => this.connect(), delay);
  }

  private onFrame(frame: any): void {
    if (frame.kind === 'context') {
      this.lastContext = Date.now();
      // Merge deltas into the running view (IFC-DCF-046: render full current context).
      Object.assign(this.context, frame.payload.deltaFields ?? {});
      this.renderContext(frame.payload);
      // Stale only when the host marks the data stale (degraded). A healthy link
      // refreshes lastContext via the host pulse, so the 10s gap check won't fire.
      el('stale').style.display = frame.payload.stale ? 'block' : 'none';
    } else if (frame.kind === 'ack') {
      this.log(`intent ${frame.correlationId}: ${frame.payload?.status ?? 'ok'}`);
    }
  }

  private checkStale(): void {
    if (Date.now() - this.lastContext > STALENESS_MS) el('stale').style.display = 'block';
  }

  dispatchIntent(type: string, data: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== 1) return this.log('not connected');
    const correlationId = `c-${Date.now()}`;
    this.ws.send(JSON.stringify({ kind: 'intent', correlationId, payload: { type, data } }));
    this.log(`→ ${type}`);
  }

  // --- Rendering ---------------------------------------------------------------

  private renderShell(): void {
    el('role').textContent = this.session.role;
    el('device').textContent = this.session.deviceId;
    const actions = el('actions');
    actions.innerHTML = '';
    if (this.session.role === 'Actions') {
      for (const profile of ['launch-ide', 'open-project-urls', 'restore-layout']) {
        const b = document.createElement('button');
        b.textContent = profile;
        b.onclick = () => this.dispatchIntent('launch-tool', { profile });
        actions.appendChild(b);
      }
    }
  }

  private renderContext(payload: any): void {
    const pre = el('context');
    pre.textContent = JSON.stringify(this.context, null, 2);
    el('version').textContent = `v${payload.version} · ${payload.digest?.slice(0, 8) ?? ''}`;
  }

  private setStatus(s: string): void {
    el('status').textContent = s;
  }

  private log(msg: string): void {
    const line = document.createElement('div');
    line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
    el('log').prepend(line);
  }
}

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const ott = params.get('ott');
  let session = loadSession();

  try {
    if (ott) session = await pair(ott);
  } catch (err) {
    el('status').textContent = 'pairing failed: ' + (err as Error).message;
    el('pair-hint').style.display = 'block';
    return;
  }

  if (!session) {
    el('status').textContent = 'unpaired';
    el('pair-hint').style.display = 'block';
    return;
  }
  new DeskletClient(session).start();
}

window.addEventListener('DOMContentLoaded', () => void boot());
