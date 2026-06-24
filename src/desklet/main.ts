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
declare const location: { href: string; search: string; host: string; protocol: string; pathname: string };
declare const history: { replaceState(state: unknown, title: string, url: string): void };
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

/** Instrument-style 3-letter role codes (no emoji). */
const ROLE_CODE: Record<string, string> = {
  Project: 'PRJ', Actions: 'ACT', Status: 'STA', Capture: 'CAP', Logs: 'LOG', AI: 'AI',
};

/** Crisp line-art icons by action kind (stroke = currentColor). */
const ICONS: Record<string, string> = {
  app: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><circle cx="6.2" cy="6.5" r="0.4" fill="currentColor"/></svg>',
  url: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18"/></svg>',
  script: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3"/><path d="M13 15h4"/></svg>',
  ssh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h11"/><path d="M11 4l3 3-3 3"/><path d="M20 17H9"/><path d="M13 20l-3-3 3-3"/></svg>',
  default: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6l8 6-8 6z"/></svg>',
};

function fmt(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

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
  private firstConnect: boolean;
  private staleTimer = 0;
  private pingTimer = 0;
  private context: Record<string, unknown> = {};
  /** correlationId -> tile element awaiting an outcome. */
  private pending = new Map<string, any>();

  /** freshToken: true only right after pairing — the single-use session token is
   *  valid for exactly one connect. A session loaded from storage uses the
   *  token-less device-ledger reconnect path instead. */
  constructor(private session: Session, freshToken: boolean) {
    this.firstConnect = freshToken;
  }

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
    this.setStatus('connecting…', 'connecting');
    let opened = false;
    const ws = new WebSocket(this.url(this.firstConnect));
    this.ws = ws;
    ws.onopen = () => {
      opened = true;
      this.firstConnect = false;
      this.backoff = 500;
      this.lastContext = Date.now();
      this.setStatus('live', 'live');
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
      // The session token is single-use. If a token attempt never opened, stop
      // retrying it and fall back to the token-less reconnect (device-ledger) path.
      if (!opened) this.firstConnect = false;
      this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect(): void {
    this.setStatus('reconnecting…', 'reconnecting');
    const delay = Math.min(this.backoff, RECONNECT_CAP_MS);
    this.backoff = Math.min(this.backoff * 2, RECONNECT_CAP_MS);
    setTimeout(() => this.connect(), delay);
  }

  private onFrame(frame: any): void {
    if (frame.kind === 'context') {
      this.lastContext = Date.now();
      const before = JSON.stringify(this.context['workspace.availableActions']);
      // Merge deltas into the running view (IFC-DCF-046: render full current context).
      Object.assign(this.context, frame.payload.deltaFields ?? {});
      if (JSON.stringify(this.context['workspace.availableActions']) !== before) this.renderActions();
      this.renderContext(frame.payload);
      // Stale only when the host marks the data stale (degraded). A healthy link
      // refreshes lastContext via the host pulse, so the 10s gap check won't fire.
      el('stale').style.display = frame.payload.stale ? 'flex' : 'none';
    } else if (frame.kind === 'ack') {
      const status = String(frame.payload?.status ?? 'ok');
      const ok = status === 'SUCCESS';
      const tile = this.pending.get(frame.correlationId);
      if (tile) {
        this.pending.delete(frame.correlationId);
        tile.setAttribute('data-st', ok ? 'ok' : 'bad');
        setTimeout(() => tile.removeAttribute('data-st'), 1600);
      }
      this.log(`${ok ? '✓' : '✕'} ${status.toLowerCase()}`, ok ? 'ok' : 'bad');
    } else if (frame.kind === 'control' && frame.payload?.type === 'role') {
      // The host re-binds the role on reconnect after a switch — adopt it so the
      // display (label + role-specific actions) matches the streamed context.
      const role = frame.payload.role;
      if (role && role !== this.session.role) {
        this.session.role = role;
        saveSession(this.session);
        this.context = {}; // drop the previous role's view; new role's context follows
        this.renderShell();
        this.renderContext();
        this.log(`role changed → ${role}`);
      }
    }
  }

  private checkStale(): void {
    if (Date.now() - this.lastContext > STALENESS_MS) el('stale').style.display = 'flex';
  }

  private dispatchAction(action: any, tile: any): void {
    if (!this.ws || this.ws.readyState !== 1) return this.log('not connected', 'bad');
    const correlationId = `c-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    tile.setAttribute('data-st', 'running');
    this.pending.set(correlationId, tile);
    this.ws.send(JSON.stringify({ kind: 'intent', correlationId, payload: { type: 'action', data: { actionId: action.id } } }));
    this.log(`→ ${action.label}`);
  }

  // --- Rendering ---------------------------------------------------------------

  private renderShell(): void {
    el('role').textContent = this.session.role;
    el('role-sub').textContent = 'desklet';
    el('role-badge').textContent = ROLE_CODE[this.session.role] ?? '··';
    el('device').textContent = this.session.deviceId;
    el('context-title').textContent = `${this.session.role} context`;
    this.renderActions();
  }

  private renderActions(): void {
    const view = el('actions-view');
    if (this.session.role !== 'Actions') {
      view.classList.add('hidden');
      return;
    }
    view.classList.remove('hidden');
    const list = (this.context['workspace.availableActions'] as any[]) ?? [];
    const grid = el('tiles');
    grid.innerHTML = '';
    if (!list.length) {
      grid.innerHTML = '<div class="empty">No actions configured — edit config/actions.json on the host.</div>';
      return;
    }
    for (const a of list) {
      const tile = document.createElement('div');
      tile.className = 'tile';
      const ic = document.createElement('div'); ic.className = 'ic'; ic.innerHTML = ICONS[a.kind] ?? ICONS['default'];
      const lbl = document.createElement('div'); lbl.className = 'lbl'; lbl.textContent = a.label ?? a.id;
      const kind = document.createElement('div'); kind.className = 'kind'; kind.textContent = a.kind ?? '';
      const state = document.createElement('div'); state.className = 'state';
      tile.append(ic, lbl, kind, state);
      tile.onclick = () => this.dispatchAction(a, tile);
      grid.appendChild(tile);
    }
  }

  private renderContext(payload?: any): void {
    const wrap = el('context-cards');
    wrap.innerHTML = '';
    const keys = Object.keys(this.context).filter((k) => k !== 'workspace.availableActions');
    if (!keys.length) {
      wrap.innerHTML = '<div class="empty">waiting for context…</div>';
    } else {
      for (const k of keys) {
        const card = document.createElement('div'); card.className = 'card';
        const kd = document.createElement('div'); kd.className = 'k';
        kd.textContent = k.replace(/^workspace\./, '').replace(/([A-Z])/g, ' $1').trim();
        const vd = document.createElement('div'); vd.className = 'v'; vd.textContent = fmt(this.context[k]);
        card.append(kd, vd);
        wrap.appendChild(card);
      }
    }
    if (payload) el('version').textContent = `v${payload.version} · ${(payload.digest ?? '').slice(0, 8)}`;
  }

  private setStatus(text: string, state: string): void {
    el('status').textContent = text;
    el('status-wrap').setAttribute('data-s', state);
    document.body.setAttribute('data-s', state); // drives the signal-rail node pulse
  }

  private log(msg: string, cls = ''): void {
    const row = document.createElement('div');
    row.className = 'row' + (cls ? ' ' + cls : '');
    const t = document.createElement('time'); t.textContent = new Date().toLocaleTimeString();
    const m = document.createElement('span'); m.textContent = msg;
    row.append(t, m);
    el('log').prepend(row);
  }
}

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const ott = params.get('ott');
  let session = loadSession();
  let freshToken = false;

  if (ott) {
    try {
      session = await pair(ott);
      freshToken = true; // single-use token is valid for exactly the next connect
    } catch (err) {
      // The OTT is single-use and short-lived, so on a page refresh it's already
      // dead. If we already have a paired session, reconnect with it (device
      // ledger) instead of failing; only surface an error if we have nothing.
      if (!session) {
        el('status').textContent = 'pairing failed: ' + (err as Error).message;
        el('pair-hint').style.display = 'block';
        return;
      }
    }
    // Strip the OTT from the URL so a refresh doesn't re-attempt a dead pairing.
    try {
      history.replaceState(null, '', location.pathname);
    } catch {
      /* ignore */
    }
  }

  if (!session) {
    el('status').textContent = 'unpaired';
    el('pair-hint').style.display = 'block';
    return;
  }
  new DeskletClient(session, freshToken).start();
}

window.addEventListener('DOMContentLoaded', () => void boot());
