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

function fmtUptime(sec: unknown): string {
  if (typeof sec !== 'number') return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return (d ? d + 'd ' : '') + (h || d ? h + 'h ' : '') + m + 'm';
}

const gb = (mb: number): string => (mb / 1024).toFixed(1);

/** Trim the noisy logger scope prefixes for the Logs stream. */
function shortScope(scope: string): string {
  return (scope ?? '').replace(/^contextrail:/, '').replace(/^sub:/, '');
}

/** A capture timestamp shown as time today, else short date + time. */
function fmtWhen(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
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
  /** correlationId -> callback invoked with the dispatch outcome. */
  private pending = new Map<string, (ok: boolean, status: string) => void>();
  /** rolling CPU samples for the Status sparkline. */
  private cpuHistory: number[] = [];

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
      const beforeActions = JSON.stringify(this.context['workspace.availableActions']);
      // Merge deltas into the running view (IFC-DCF-046: render full current context).
      Object.assign(this.context, frame.payload.deltaFields ?? {});
      // Actions re-render only when the action set changes, so an in-flight tile's
      // running/ok/bad state isn't wiped by a routine host pulse. Other roles
      // re-render from their dynamic containers (inputs/scroll are preserved).
      if (this.session.role === 'Actions') {
        if (JSON.stringify(this.context['workspace.availableActions']) !== beforeActions) this.renderActions();
      } else {
        this.renderRole();
      }
      el('version').textContent = `v${frame.payload.version} · ${(frame.payload.digest ?? '').slice(0, 8)}`;
      // Stale only when the host marks the data stale (degraded). A healthy link
      // refreshes lastContext via the host pulse, so the 10s gap check won't fire.
      el('stale').style.display = frame.payload.stale ? 'flex' : 'none';
    } else if (frame.kind === 'ack') {
      const status = String(frame.payload?.status ?? 'ok');
      const ok = status === 'SUCCESS';
      const cb = this.pending.get(frame.correlationId);
      if (cb) {
        this.pending.delete(frame.correlationId);
        cb(ok, status);
      }
      this.log(`${ok ? 'ok' : 'fail'} · ${status.toLowerCase()}`, ok ? 'ok' : 'bad');
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

  private cid(): string {
    return `c-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  }

  private dispatchAction(action: any, tile: any): void {
    if (!this.ws || this.ws.readyState !== 1) return this.log('not connected', 'bad');
    const correlationId = this.cid();
    tile.setAttribute('data-st', 'running');
    this.pending.set(correlationId, (ok) => {
      tile.setAttribute('data-st', ok ? 'ok' : 'bad');
      setTimeout(() => tile.removeAttribute('data-st'), 1600);
    });
    this.ws.send(JSON.stringify({ kind: 'intent', correlationId, payload: { type: 'action', data: { actionId: action.id } } }));
    this.log(`→ ${action.label}`);
  }

  /** Send a Capture-role note; clears the field on confirmed capture. */
  private sendCapture(): void {
    const ta = el('cap-input');
    const text = (ta?.value ?? '').trim();
    if (!text) return;
    if (!this.ws || this.ws.readyState !== 1) return this.setHint('cap-hint', 'not connected');
    const correlationId = this.cid();
    this.pending.set(correlationId, (ok) => {
      if (ok) { ta.value = ''; this.setHint('cap-hint', 'captured', true); }
      else this.setHint('cap-hint', 'capture failed', true);
    });
    this.ws.send(JSON.stringify({ kind: 'intent', correlationId, payload: { type: 'capture', data: { text } } }));
    this.setHint('cap-hint', 'saving…');
  }

  /** Send an AI-role query (from the box or a suggestion chip). */
  private sendAi(query?: string): void {
    const ta = el('ai-input');
    const text = (query ?? ta?.value ?? '').trim();
    if (!text) return;
    if (!this.ws || this.ws.readyState !== 1) return this.log('not connected', 'bad');
    const correlationId = this.cid();
    this.pending.set(correlationId, () => {}); // the answer arrives via aiContext
    this.ws.send(JSON.stringify({ kind: 'intent', correlationId, payload: { type: 'ai-query', data: { query: text } } }));
    if (!query && ta) ta.value = '';
  }

  private setHint(id: string, text: string, revert = false): void {
    const node = el(id);
    if (!node) return;
    node.textContent = text;
    if (revert) setTimeout(() => { if (el(id)) el(id).textContent = 'stored on the host'; }, 1800);
  }

  // --- Rendering ---------------------------------------------------------------

  /** role -> its purpose-built view section id. */
  private static readonly VIEWS: Record<string, string> = {
    Actions: 'actions-view', Status: 'status-view', Project: 'project-view',
    Logs: 'logs-view', Capture: 'capture-view', AI: 'ai-view',
  };

  private renderShell(): void {
    const role = this.session.role;
    el('role').textContent = role;
    el('role-sub').textContent = 'desklet';
    el('role-badge').textContent = ROLE_CODE[role] ?? '··';
    el('device').textContent = this.session.deviceId;
    el('context-title').textContent = `${role} context`;
    const active = DeskletClient.VIEWS[role];
    for (const id of ['actions-view', 'status-view', 'project-view', 'logs-view', 'capture-view', 'ai-view']) {
      el(id).classList.toggle('hidden', id !== active);
    }
    // The generic context-view is only a fallback for an unrecognised role.
    el('context-view').classList.toggle('hidden', !!active);
    this.wireInputs();
    this.renderRole();
  }

  /** Idempotently bind the Capture/AI composer controls. */
  private wireInputs(): void {
    const capSend = el('cap-send'); if (capSend) capSend.onclick = () => this.sendCapture();
    const aiSend = el('ai-send'); if (aiSend) aiSend.onclick = () => this.sendAi();
    const capIn = el('cap-input');
    if (capIn) capIn.onkeydown = (e: any) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') this.sendCapture(); };
    const aiIn = el('ai-input');
    if (aiIn) aiIn.onkeydown = (e: any) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') this.sendAi(); };
    const pfToggle = el('pf-toggle');
    if (pfToggle) pfToggle.onclick = () => { const f = el('propose-form'); if (f) f.classList.toggle('hidden'); };
    const pfSend = el('pf-send');
    if (pfSend) pfSend.onclick = () => this.sendPropose();
  }

  /** Propose a new action (Actions role) for operator approval on the host. */
  private sendPropose(): void {
    const hint = el('pf-hint');
    const label = (el('pf-label')?.value ?? '').trim();
    const kind = el('pf-kind')?.value ?? 'app';
    const target = (el('pf-target')?.value ?? '').trim();
    if (!label || !target) { if (hint) hint.textContent = 'label and target are required'; return; }
    if (!this.ws || this.ws.readyState !== 1) { if (hint) hint.textContent = 'not connected'; return; }
    const correlationId = this.cid();
    this.pending.set(correlationId, (ok, status) => {
      if (!hint) return;
      if (ok) {
        el('pf-label').value = ''; el('pf-target').value = '';
        el('propose-form').classList.add('hidden');
        hint.textContent = 'proposed — awaiting operator approval';
      } else {
        hint.textContent = status === 'DENIED' ? 'not permitted for this role' : 'proposal rejected';
      }
    });
    this.ws.send(JSON.stringify({ kind: 'intent', correlationId, payload: { type: 'action-propose', data: { label, kind, target } } }));
    if (hint) hint.textContent = 'sending…';
  }

  /** Render the active role's view from current context. */
  private renderRole(): void {
    switch (this.session.role) {
      case 'Actions': this.renderActions(); break;
      case 'Status': this.renderStatus(); break;
      case 'Project': this.renderProject(); break;
      case 'Logs': this.renderLogs(); break;
      case 'Capture': this.renderCapture(); break;
      case 'AI': this.renderAI(); break;
      default: this.renderContext();
    }
  }

  // --- Project: operator dashboard ---------------------------------------------

  private renderProject(): void {
    const c = this.context;
    const pulse = c['workspace.hostPulse'] as { uptimeSec: number } | undefined;
    const mode = String(c['workspace.hostMode'] ?? '—');
    const dev = c['workspace.devices'] as { live: number; paired: number } | undefined;

    const hero = el('prj-hero');
    hero.innerHTML = '<div class="eyebrow">Active project</div><div class="name"></div><div class="meta"></div>';
    hero.querySelector('.name').textContent = String(c['workspace.activeProject'] ?? '—');
    const meta = hero.querySelector('.meta');
    const addMeta = (label: string, val: string) => {
      const s = document.createElement('span'); s.textContent = label + ' ';
      const b = document.createElement('b'); b.textContent = val; s.appendChild(b); meta.appendChild(s);
    };
    addMeta('mode', mode);
    addMeta('uptime', fmtUptime(pulse?.uptimeSec));
    if (dev) addMeta('devices', `${dev.live} live / ${dev.paired} paired`);

    const paired = (c['workspace.pairedDevices'] as Array<{ deviceId: string; role: string }>) ?? [];
    const dl = el('prj-devices'); dl.innerHTML = '';
    if (!paired.length) dl.innerHTML = '<div class="empty">No devices paired yet.</div>';
    else for (const d of paired) {
      const card = document.createElement('div'); card.className = 'card';
      const row = document.createElement('div'); row.className = 'dev-row';
      const rc = document.createElement('div'); rc.className = 'rc'; rc.textContent = ROLE_CODE[d.role] ?? d.role;
      const did = document.createElement('div'); did.className = 'did'; did.textContent = d.deviceId;
      row.append(rc, did); card.appendChild(row); dl.appendChild(card);
    }

    const vits = el('prj-vitals'); vits.innerHTML = '';
    const rows: [string, string][] = [
      ['cores', String(c['workspace.cores'] ?? '—')],
      ['platform', String(c['workspace.platform'] ?? '—')],
      ['load 1m', String(c['workspace.load'] ?? '—')],
      ['mode', mode],
    ];
    for (const [k, v] of rows) {
      const card = document.createElement('div'); card.className = 'card';
      const kd = document.createElement('div'); kd.className = 'k'; kd.textContent = k;
      const vd = document.createElement('div'); vd.className = 'v'; vd.textContent = v;
      card.append(kd, vd); vits.appendChild(card);
    }
  }

  // --- Logs: live stream + command history -------------------------------------

  private renderLogs(): void {
    const logs = (this.context['workspace.logs'] as Array<{ ts: string; level: string; scope: string; msg: string }>) ?? [];
    const stream = el('log-stream'); stream.innerHTML = '';
    if (!logs.length) stream.innerHTML = '<div class="empty" style="padding:13px">No log activity yet.</div>';
    else for (const r of logs) {
      const row = document.createElement('div'); row.className = 'logrow';
      const t = document.createElement('time'); t.textContent = (r.ts ?? '').slice(11, 19);
      const lv = document.createElement('span'); lv.className = 'lv ' + r.level; lv.textContent = r.level;
      const lm = document.createElement('div'); lm.className = 'lm';
      const sc = document.createElement('span'); sc.className = 'sc'; sc.textContent = shortScope(r.scope) + ' ';
      lm.append(sc, document.createTextNode(r.msg));
      row.append(t, lv, lm); stream.appendChild(row);
    }
    stream.scrollTop = stream.scrollHeight;

    const hist = (this.context['workspace.commandHistory'] as any[]) ?? [];
    const ch = el('cmd-history'); ch.innerHTML = '';
    if (!hist.length) ch.innerHTML = '<div class="empty">No commands run yet.</div>';
    else for (const h of [...hist].reverse().slice(0, 12)) {
      const card = document.createElement('div'); card.className = 'card';
      const kd = document.createElement('div'); kd.className = 'k';
      kd.textContent = String(h.status ?? '—') + (h.exitCode != null ? ` · exit ${h.exitCode}` : '');
      const vd = document.createElement('div'); vd.className = 'v';
      vd.textContent = `${h.intentId ?? ''}${h.elapsedMs != null ? ` · ${h.elapsedMs}ms` : ''}\n${(h.at ?? '').slice(11, 19)}`;
      card.append(kd, vd); ch.appendChild(card);
    }
  }

  // --- Capture: notes ----------------------------------------------------------

  private renderCapture(): void {
    const caps = (this.context['workspace.captures'] as Array<{ id: string; text: string; at: string }>) ?? [];
    const list = el('cap-list'); list.innerHTML = '';
    if (!caps.length) { list.innerHTML = '<div class="empty">No captures yet — your notes will appear here.</div>'; return; }
    for (const cp of caps) {
      const card = document.createElement('div'); card.className = 'card note';
      const txt = document.createElement('div'); txt.className = 'txt'; txt.textContent = cp.text;
      const t = document.createElement('time'); t.textContent = fmtWhen(cp.at);
      card.append(txt, t); list.appendChild(card);
    }
  }

  // --- AI: on-host assistant ---------------------------------------------------

  private renderAI(): void {
    const sg = (this.context['workspace.aiSuggestions'] as Array<{ label: string; query: string }>) ?? [];
    const chips = el('ai-suggest'); chips.innerHTML = '';
    for (const s of sg) {
      const c = document.createElement('div'); c.className = 'chip'; c.textContent = s.label;
      c.onclick = () => this.sendAi(s.query); chips.appendChild(c);
    }
    const thread = (this.context['workspace.aiContext'] as Array<{ role: string; text: string }>) ?? [];
    const t = el('ai-thread'); t.innerHTML = '';
    for (const m of thread) {
      const d = document.createElement('div'); d.className = 'msg ' + (m.role === 'you' ? 'you' : 'assistant');
      d.textContent = m.text; t.appendChild(d);
    }
  }

  // --- Status: resource monitor ------------------------------------------------

  private renderStatus(): void {
    const c = this.context;
    const cpu = typeof c['workspace.cpu'] === 'number' ? (c['workspace.cpu'] as number) : null;
    if (cpu != null) { this.cpuHistory.push(cpu); if (this.cpuHistory.length > 48) this.cpuHistory.shift(); }
    const mem = c['workspace.memory'] as { pct: number; usedMB: number; totalMB: number } | undefined;
    const disk = c['workspace.disk'] as { pct: number; usedGB: number; totalGB: number } | undefined;

    const meters = el('meters'); meters.innerHTML = '';
    meters.appendChild(this.meter('CPU', cpu, cpu != null ? cpu + '%' : '—', this.sparkSvg(), ''));
    meters.appendChild(this.meter('Memory', mem?.pct ?? null, mem ? mem.pct + '%' : '—', '', mem ? `${gb(mem.usedMB)} / ${gb(mem.totalMB)} GB` : ''));
    meters.appendChild(this.meter('Disk', disk?.pct ?? null, disk ? disk.pct + '%' : '—', '', disk ? `${disk.usedGB} / ${disk.totalGB} GB` : 'n/a'));

    const dev = c['workspace.devices'] as { live: number; paired: number } | undefined;
    const proc = c['workspace.hostProc'] as { rssMB: number } | undefined;
    const ro = el('readouts'); ro.innerHTML = '';
    const rows: [string, string][] = [
      ['uptime', fmtUptime(c['workspace.uptime'])],
      ['load 1m', String(c['workspace.load'] ?? '—')],
      ['cores', String(c['workspace.cores'] ?? '—')],
      ['host rss', proc ? proc.rssMB + ' MB' : '—'],
      ['mode', String(c['workspace.hostMode'] ?? '—')],
      ['devices', dev ? `${dev.live} live / ${dev.paired} paired` : '—'],
      ['platform', String(c['workspace.platform'] ?? '—')],
      ['cpu', String(c['workspace.cpuModel'] ?? '—')],
    ];
    for (const [k, v] of rows) {
      const card = document.createElement('div'); card.className = 'card';
      const kd = document.createElement('div'); kd.className = 'k'; kd.textContent = k;
      const vd = document.createElement('div'); vd.className = 'v'; vd.textContent = v;
      card.append(kd, vd); ro.appendChild(card);
    }
  }

  private meter(label: string, pct: number | null, valText: string, sparkHtml: string, sub: string): any {
    const card = document.createElement('div'); card.className = 'card meter';
    const p = pct == null ? 0 : pct;
    if (p >= 90) card.classList.add('fault'); else if (p >= 70) card.classList.add('warn');
    const head = document.createElement('div'); head.className = 'head';
    const lbl = document.createElement('div'); lbl.className = 'lbl'; lbl.textContent = label;
    const val = document.createElement('div'); val.className = 'val'; val.textContent = valText;
    head.append(lbl, val);
    const bar = document.createElement('div'); bar.className = 'track';
    const fill = document.createElement('div'); fill.className = 'fill'; fill.style.width = p + '%';
    bar.appendChild(fill);
    card.append(head, bar);
    if (sparkHtml) { const s = document.createElement('div'); s.className = 'spark'; s.innerHTML = sparkHtml; card.appendChild(s); }
    if (sub) { const d = document.createElement('div'); d.className = 'sub'; d.textContent = sub; card.appendChild(d); }
    return card;
  }

  private sparkSvg(): string {
    const h = this.cpuHistory;
    if (h.length < 2) return '';
    const n = h.length;
    const pts = h.map((v, i) => `${((i / (n - 1)) * 100).toFixed(2)},${(100 - v).toFixed(2)}`).join(' ');
    return `<svg viewBox="0 0 100 100" preserveAspectRatio="none"><polyline class="area" points="0,100 ${pts} 100,100"/><polyline points="${pts}"/></svg>`;
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
