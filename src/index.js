// Grapevine: lets desktop apps on the same computer find each other and talk, privately.
// createLink() is all an app uses: start it, publish what it provides, listen for what it uses,
// and show peers() on its Connected apps page. PROTOCOL.md describes what goes over the wire.
'use strict';

const fs = require('fs');
const net = require('net');
const { EventEmitter } = require('events');
const paths = require('./paths');
const hs = require('./handshake');
const { Connection, TIMING } = require('./connection');
const { Schemas } = require('./schema');
const { CODES, GrapevineError } = require('./errors');
const { KNOWN_APPS, isInstalled, iconDataUrl } = require('./known-apps');
const { compatibility, incompatible } = require('./report');
const { fileKeyStore, memoryKeyStore } = require('./keys');

const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];
const POLL_MS = 5000;
// confirmPairing: Allow (or Pair again) lets a new pairing happen for this long. An app asking to pair shows
// as 'confirm' until it hasn't asked for this long (it asks again at least every 30 s, BACKOFF_MS).
const ALLOW_MS = 2 * 60_000;
const ASKING_MS = 75_000;

/**
 * @typedef {object} LinkOptions
 * @property {{id: string, slug: string, name: string, version: string, formerIds?: string[], summary?: string, icon?: string, homepage?: string, download?: string}} app
 *   This app, as other apps will see it. `icon` may be a PNG data URL or a file path.
 * @property {Record<string, string | string[]>} [provides] capabilities this app provides, e.g. { 'drops.farming': '1.0' }
 * @property {Record<string, string | string[]>} [uses] capabilities it uses, e.g. { players: '1.0' }
 * @property {(appId: string) => boolean} allowed whether its Connected apps switch for that app is on
 * @property {ReturnType<typeof fileKeyStore>} [keys] where pairing keys are kept (fileKeyStore(); in memory if left out)
 * @property {string} [appDataDir] the OS's app data folder (Electron's app.getPath('appData')), to tell whether known apps are installed
 * @property {import('./paths').Place} [place] for tests: the platform and environment to work out paths from
 * @property {string[]} [schemaDirs] extra schema folders, for capabilities that aren't in this package yet
 * @property {typeof KNOWN_APPS} [knownApps]
 * @property {Partial<typeof TIMING> & {pollMs?: number, backoffMs?: number[]}} [timing]
 * @property {boolean} [strict] throw on a message that doesn't match its schema (default: when NODE_ENV is "test")
 * @property {boolean} [confirmPairing] a first pairing needs your user's Allow (allowPairing) or Pair again first
 * @property {(level: 'info' | 'warn' | 'error', text: string) => void} [log]
 */

class Link extends EventEmitter {
  /** @param {LinkOptions} opts */
  constructor(opts) {
    super();
    const icon = opts.app.icon && !opts.app.icon.startsWith('data:') ? iconDataUrl(opts.app.icon) : opts.app.icon;
    // formerIds: ids this app had before a rename, so apps paired with it then still know it. Sent every time, [] until then.
    this.self = { ...opts.app, formerIds: opts.app.formerIds ?? [], ...(icon ? { icon } : {}) };
    const problems = hs.checkApp(this.self);
    if (problems.length) throw new Error(`createLink: ${problems.join('; ')}`);
    this.mine = { provides: hs.normalizeList(opts.provides), uses: hs.normalizeList(opts.uses) };
    this.allowedFn = opts.allowed;
    this.keys = opts.keys ?? memoryKeyStore();
    this.appDataDir = opts.appDataDir ?? null;
    this.place = opts.place ?? {};
    this.schemas = Schemas.load(opts.schemaDirs);
    const mine = new Set([this.self.id, ...this.self.formerIds]);
    this.knownApps = (opts.knownApps ?? KNOWN_APPS).filter((a) => !mine.has(a.id) && !(a.formerIds ?? []).some((i) => mine.has(i)));
    this.timing = { ...TIMING, pollMs: POLL_MS, backoffMs: BACKOFF_MS, ...opts.timing };
    this.strict = opts.strict ?? process.env.NODE_ENV === 'test';
    this.confirmPairing = !!opts.confirmPairing;
    /** @type {Map<string, number>} app id -> until when a new pairing with it may be kept (confirmPairing) */
    this.mayPairUntil = new Map();
    this.logFn = opts.log ?? (() => {});
    for (const cap of [...Object.keys(this.mine.provides), ...Object.keys(this.mine.uses)]) {
      const listed = [...(this.mine.provides[cap] ?? []), ...(this.mine.uses[cap] ?? [])];
      for (const v of listed) if (!this.schemas.get(cap, hs.parseVersion(v).major)) throw new Error(`createLink: no schema for ${cap} ${v}`);
    }
    /** @type {Map<string, InstanceType<typeof Connection>>} ready connections, by the other app's id */
    this.conns = new Map();
    /** @type {Set<InstanceType<typeof Connection>>} connections still saying hello */
    this.opening = new Set();
    /** @type {Map<string, {status: string, keyHeldBy?: string, theirProtocol?: any, reason?: string, theirApp?: any, at?: number}>} why an app isn't connected */
    this.why = new Map();
    this.retry = new Map(); // app id -> { attempts, at }
    this.latest = new Map(); // event -> its last params
    this.seq = new Map();
    this.handlers = new Map();
    this.running = false;
  }

  // ------------------------------------------------------------------ starting and stopping

  /** Listens for other apps and starts looking for them. */
  async start() {
    if (this.running) return;
    // Keys decrypted with an async decrypt: until then a paired app would look unpaired.
    await this.keys.ready;
    paths.ensureDir(this.place);
    this.socketPath = paths.socketPath(this.self.slug, this.place);
    await this.listen();
    this.running = true;
    const platform = this.place.platform ?? process.platform;
    if (platform === 'win32') await this.listenLegacy();
    if (platform !== 'win32') {
      try {
        this.watcher = fs.watch(paths.socketDir(this.place), () => this.pollSoon());
        this.watcher.on('error', () => {});
      } catch {}
    }
    this.pollTimer = setInterval(() => this.poll(), this.timing.pollMs);
    this.pollTimer.unref?.();
    this.poll();
  }

  /** @returns {Promise<void>} */
  listen() {
    const platform = this.place.platform ?? process.platform;
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.accept(socket));
      const go = () =>
        server.listen(this.socketPath, () => {
          // The socket can vanish before this runs (its folder removed): start() fails, rather than
          // an exception the app can't catch.
          try {
            if (platform !== 'win32') fs.chmodSync(this.socketPath, 0o600);
          } catch (err) {
            server.close();
            return reject(err);
          }
          this.server = server;
          resolve();
        });
      server.on('error', (/** @type {NodeJS.ErrnoException} */ err) => {
        if (err.code !== 'EADDRINUSE' || platform === 'win32') return reject(err);
        // A socket file is there already. If nothing answers, a crash left it: replace it.
        const probe = net.createConnection(this.socketPath);
        probe.once('connect', () => {
          probe.destroy();
          reject(new GrapevineError(CODES.INTERNAL_ERROR, `Another copy of ${this.self.name} is already using Grapevine`));
        });
        probe.once('error', () => {
          try {
            fs.unlinkSync(this.socketPath);
          } catch {}
          go();
        });
      });
      go();
    });
  }

  /**
   * Windows: answers on the pipe name an older Grapevine uses too, so a copy of the other app that has one
   * still finds this one. Only if that name is free: someone else holding it changes nothing here.
   * Resolves once it's answering there (or couldn't), so start() only returns when both names are.
   * @returns {Promise<void>}
   */
  listenLegacy() {
    const server = net.createServer((socket) => this.accept(socket));
    this.legacyServer = server; // kept at once, so a stop() straight after still closes it
    return new Promise((resolve) => {
      server.once('error', (err) => {
        if (this.legacyServer === server) this.legacyServer = null;
        this.log('warn', `Not answering on the older pipe name as well: ${err.message}`);
        resolve();
      });
      server.listen(paths.legacyPipe(this.self.slug, this.place), () => resolve());
    });
  }

  /** Says goodbye to every app and stops listening. */
  async stop() {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.pollTimer);
    clearTimeout(this.pollSoonTimer);
    this.watcher?.close();
    for (const c of [...this.opening, ...this.conns.values()]) c.bye(`${this.self.name} quit`);
    await /** @type {Promise<void>} */ (new Promise((resolve) => this.server.close(() => resolve())));
    const legacy = this.legacyServer;
    this.legacyServer = null;
    if (legacy) await /** @type {Promise<void>} */ (new Promise((resolve) => legacy.close(() => resolve())));
    if ((this.place.platform ?? process.platform) !== 'win32') {
      try {
        fs.unlinkSync(this.socketPath);
      } catch {}
    }
  }

  /** Call after a Connected apps switch changes: closes connections switched off, looks for ones switched on. */
  refresh() {
    for (const [, c] of this.conns) if (!this.allowedAny(c.peerIds)) c.bye(`Switched off in ${this.self.name}`);
    for (const c of this.opening) if (c.peerIds.length && !this.allowedAny(c.peerIds)) c.close('Switched off');
    for (const a of this.knownApps) if (this.allowedAny(this.idsOf(a.id))) this.retry.delete(a.id);
    this.poll();
    this.changed();
  }

  allowed(id) {
    try {
      return !!this.allowedFn(id);
    } catch {
      return false;
    }
  }

  /** Whether the switch is on under any of an app's ids (it may still be saved under a former one). */
  allowedAny(ids) {
    return ids.some((id) => this.allowed(id));
  }

  /** A known app's id and its former ids; just the id for an app that isn't known. */
  idsOf(id) {
    const app = this.knownApps.find((a) => a.id === id || (a.formerIds ?? []).includes(id));
    return app ? [app.id, ...(app.formerIds ?? [])] : [id];
  }

  /** The id this app knows another one by (its known-apps entry, matched on any id either side lists), and every id it has had. */
  resolve(app) {
    const theirs = [app.id, ...(app.formerIds ?? [])];
    const known = this.knownApps.find((a) => [a.id, ...(a.formerIds ?? [])].some((i) => theirs.includes(i)));
    const id = known?.id ?? app.id;
    return { id, ids: [...new Set([...(known ? this.idsOf(known.id) : []), ...theirs])] };
  }

  /** The pairing key, under whichever of these ids it was filed. */
  findKey(ids) {
    for (const id of ids) {
      const k = this.keys.get(id);
      if (k) return k;
    }
    return null;
  }

  /**
   * The id to use for an app: its current id, given any it has had. For moving an app's own
   * settings across after the other app was renamed: settings[link.currentId(old)] = settings[old].
   */
  currentId(id) {
    for (const c of this.conns.values()) if (c.peerIds.includes(id)) return c.peerId;
    return this.idsOf(id)[0];
  }

  // ------------------------------------------------------------------ finding apps

  pollSoon() {
    clearTimeout(this.pollSoonTimer);
    this.pollSoonTimer = setTimeout(() => this.poll(), 100);
    this.pollSoonTimer.unref?.();
  }

  /**
   * Connects to apps that are running and switched on. Of two apps, the one whose slug sorts first
   * connects and the other waits, so they don't both connect at once. (Slugs, not ids: an app's id
   * may change, its socket's name doesn't.)
   */
  poll() {
    if (!this.running) return;
    const slugs = new Set(paths.listSlugs(this.place));
    for (const app of this.knownApps) {
      if (!slugs.has(app.slug) || !this.allowedAny(this.idsOf(app.id)) || this.conns.has(app.id) || this.self.slug > app.slug) continue;
      if ([...this.opening].some((c) => (c.expectedId ?? c.peerId) === app.id)) continue;
      const r = this.retry.get(app.id);
      if (r && Date.now() < r.at) continue;
      this.connect(app);
    }
  }

  connect(app) {
    const socket = net.createConnection(paths.findSocket(app.slug, this.place));
    const conn = new Connection(socket, this.host(), { initiator: true, expectedId: app.id });
    this.track(conn);
    socket.once('connect', () => conn.start());
  }

  accept(socket) {
    this.track(new Connection(socket, this.host(), { initiator: false }));
  }

  track(conn) {
    this.opening.add(conn);
    conn.on('status', (s) => {
      const id = conn.expectedId ?? (s.peer ? this.resolve(s.peer).id : conn.peerId);
      if (!id) return;
      this.why.set(id, { ...s, peer: undefined, theirApp: s.peer, at: Date.now() });
      this.changed();
    });
    conn.on('ready', () => this.onReady(conn));
    conn.on('event', (name, params) => this.emit('event', conn.peerId, name, params));
    conn.on('unpaired', () => {
      this.why.set(conn.peerId, { status: 'waiting', reason: 'disconnected-there' });
      this.emit('unpaired', conn.peerId);
    });
    conn.on('close', (reason, wasReady) => this.onClose(conn, reason, wasReady));
  }

  onReady(conn) {
    this.opening.delete(conn);
    const id = conn.peerId;
    const other = this.conns.get(id);
    if (other) {
      // Both connected at once: keep the one made by the app whose slug sorts first.
      const firstOf = (c) => (c.initiator ? this.self.slug : c.peer.slug);
      const [keep, drop] = firstOf(conn) <= firstOf(other) ? [conn, other] : [other, conn];
      this.conns.set(id, keep);
      drop.bye('duplicate');
      return;
    }
    this.conns.set(id, conn);
    this.why.delete(id);
    this.retry.delete(id);
    this.log('info', `Connected to ${conn.peer.name}`);
    this.emit('connected', id);
    this.changed();
  }

  onClose(conn, reason, wasReady) {
    this.opening.delete(conn);
    const id = conn.peerId ?? conn.expectedId;
    if (id && this.conns.get(id) === conn) {
      this.conns.delete(id);
      this.emit('disconnected', id, reason);
    }
    if (conn.initiator && id) {
      const attempts = wasReady ? 0 : (this.retry.get(id)?.attempts ?? 0) + 1;
      const wait = this.timing.backoffMs[Math.min(Math.max(attempts - 1, 0), this.timing.backoffMs.length - 1)];
      this.retry.set(id, { attempts, at: Date.now() + (wasReady ? this.timing.backoffMs[0] : wait) });
    }
    this.changed();
  }

  // ------------------------------------------------------------------ what connections ask of the link

  host() {
    return {
      self: this.self,
      mine: this.mine,
      keys: this.keys,
      allowed: (ids) => this.allowedAny(ids),
      idsOf: (id) => this.idsOf(id),
      resolve: (app) => this.resolve(app),
      findKey: (ids) => this.findKey(ids),
      ...(this.confirmPairing
        ? {
            mayPair: (ids) => ids.some((i) => (this.mayPairUntil.get(i) ?? 0) > Date.now()),
            paired: (id) => {
              for (const i of this.idsOf(id)) this.mayPairUntil.delete(i);
            },
          }
        : {}),
      schemas: this.schemas,
      timing: this.timing,
      log: (level, text) => this.log(level, text),
      // The activity log: only built while something listens for it.
      watching: () => this.listenerCount('message') > 0,
      message: (conn, m) => this.emit('message', m),
      call: (conn, method, params) => this.call(conn, method, params),
      subscribe: (conn, events) => {
        const offered = new Set();
        for (const [cap, { major }] of conn.agreed.outgoing) for (const e of Object.keys(this.schemas.get(cap, major)?.events ?? {})) offered.add(e);
        conn.subscribed = new Set(events.filter((e) => offered.has(e)));
        return [...conn.subscribed];
      },
      afterSubscribe: (conn) => {
        for (const e of conn.subscribed) if (this.latest.has(e)) this.sendEvent(conn, e, this.latest.get(e));
      },
    };
  }

  async call(conn, method, params) {
    const cap = this.schemas.capabilityOf(method);
    if (!cap) throw new GrapevineError(CODES.METHOD_NOT_FOUND, `No such method: ${method}`);
    const agreed = conn.agreed.outgoing.get(cap);
    if (!agreed) throw new GrapevineError(CODES.NOT_AGREED, `${cap} wasn't agreed on this connection`);
    const bad = this.schemas.validate(cap, agreed.major, 'params', method, params);
    if (bad.length)
      throw new GrapevineError(bad[0].includes("isn't part of") ? CODES.METHOD_NOT_FOUND : CODES.INVALID_PARAMS, `Invalid params: ${bad.join('; ')}`, {
        problems: bad,
      });
    let result;
    const fn = this.handlers.get(method);
    if (fn) result = await fn(params, { appId: conn.peerId, app: conn.peer, major: agreed.major });
    else {
      // A "<capability>.get" with no handler answers with the last "<capability>.changed".
      const latest = method === `${cap}.get` ? this.latest.get(`${cap}.changed`) : undefined;
      if (!latest) throw new GrapevineError(CODES.METHOD_NOT_FOUND, `${this.self.name} doesn't answer ${method} yet`);
      result = latest;
    }
    const wrong = this.schemas.validate(cap, agreed.major, 'result', method, result);
    if (wrong.length) {
      this.log('error', `${method} answered with an invalid result: ${wrong.join('; ')}`);
      if (this.strict) throw new Error(`${method} returned an invalid result: ${wrong.join('; ')}`);
      throw new GrapevineError(CODES.INTERNAL_ERROR, `${this.self.name} gave an invalid answer`);
    }
    return result;
  }

  sendEvent(conn, event, params) {
    const cap = this.schemas.capabilityOf(event);
    const { major } = conn.agreed.outgoing.get(cap) ?? {};
    if (major === undefined) return;
    const problems = this.schemas.validate(cap, major, 'event', event, params);
    if (problems.length) return this.log('error', `Not sent: ${event} doesn't fit ${cap} ${major}: ${problems.join('; ')}`);
    conn.rpc.notify(event, params);
  }

  // ------------------------------------------------------------------ what apps call

  /**
   * Tells every subscribed app something changed. `data` is the event's fields; `seq` and `at` are
   * added. The last one is kept, for apps that subscribe later and for "<capability>.get".
   * @returns {object} the params as sent
   */
  publish(event, data) {
    const cap = this.schemas.capabilityOf(event);
    if (!cap || !this.mine.provides[cap]) throw new Error(`${event} isn't part of a capability ${this.self.name} provides`);
    const seq = (this.seq.get(event) ?? 0) + 1;
    this.seq.set(event, seq);
    const params = { ...data, seq, at: new Date().toISOString() };
    const top = Math.max(...this.mine.provides[cap].map((v) => hs.parseVersion(v).major));
    const problems = this.schemas.validate(cap, top, 'event', event, params);
    if (problems.length) {
      this.log('error', `${event} doesn't fit ${cap} ${top}: ${problems.join('; ')}`);
      if (this.strict) throw new Error(`${event} doesn't fit its schema: ${problems.join('; ')}`);
    }
    this.latest.set(event, params);
    for (const c of this.conns.values()) if (c.subscribed.has(event)) this.sendEvent(c, event, params);
    return params;
  }

  /** Answers a method of a capability this app provides: fn(params, { appId, app, major }) -> result. */
  handle(method, fn) {
    this.handlers.set(method, fn);
  }

  /** Asks a connected app something. Rejects with a GrapevineError (CLOSED if it isn't connected). */
  async request(appId, method, params = {}, opts) {
    const conn = this.conns.get(this.currentId(appId));
    if (!conn) throw new GrapevineError(CODES.CLOSED, `Not connected to ${appId}`);
    const cap = this.schemas.capabilityOf(method);
    const agreed = cap && conn.agreed.incoming.get(cap);
    if (!agreed) throw new GrapevineError(CODES.NOT_AGREED, `${method} isn't agreed with ${conn.peer.name}`);
    const bad = this.schemas.validate(cap, agreed.major, 'params', method, params);
    if (bad.length) throw new GrapevineError(CODES.INVALID_PARAMS, `Invalid params: ${bad.join('; ')}`, { problems: bad });
    const result = await conn.rpc.request(method, params, opts);
    const wrong = this.schemas.validate(cap, agreed.major, 'result', method, result);
    if (wrong.length) throw new GrapevineError(CODES.INTERNAL_ERROR, `${conn.peer.name} gave an invalid answer: ${wrong.join('; ')}`);
    return result;
  }

  /** Disconnect on a card: tells the other app to forget the pairing, and forgets it here. Switch this app's own setting off too. */
  async disconnect(appId) {
    const id = this.currentId(appId);
    const conn = this.conns.get(id);
    if (conn) {
      await conn.rpc.request('link.unpair', {}, { timeout: 2000 }).catch(() => {});
      conn.close('Disconnected');
    }
    for (const i of new Set([...this.idsOf(id), ...(conn?.peerIds ?? [])])) this.keys.delete(i);
    this.why.delete(id);
    this.changed();
  }

  /** "Pair again" on a card: forgets this app's old key, so the next connection pairs afresh (allowed, with confirmPairing). */
  pairAgain(appId) {
    const id = this.currentId(appId);
    for (const i of this.idsOf(id)) this.keys.delete(i);
    this.allowPairing(id);
  }

  /**
   * "Allow" on a card, with confirmPairing: a new pairing with that app may happen in the next two minutes.
   * Without confirmPairing, pairing needs no Allow and this only tries again now.
   */
  allowPairing(appId) {
    const id = this.currentId(appId);
    if (this.confirmPairing) this.mayPairUntil.set(id, Date.now() + ALLOW_MS);
    this.why.delete(id);
    this.retry.delete(id);
    this.poll();
    this.changed();
  }

  /**
   * Test on a card: checks the link to that app now, and says how it went in words. Connected, a
   * round trip and back; otherwise it tries straight away (from this side too, whichever app
   * normally connects) and says why it couldn't.
   * @returns {Promise<{ok: true, ms: number, version: string, text: string} | {ok: false, reason: string, text: string}>}
   *   reason: 'unknown' | 'off' | 'not-started' | 'not-running' | 'switched-off' | 'pair-again' | 'incompatible' | 'confirm' | 'confirm-there' | 'no-answer'
   */
  async test(appId, { timeout = 4000 } = {}) {
    const id = this.currentId(appId);
    const app = this.knownApps.find((a) => a.id === id);
    if (!app) return { ok: false, reason: 'unknown', text: `${appId} isn't an app Grapevine knows` };
    if (!this.allowedAny(this.idsOf(id))) return { ok: false, reason: 'off', text: `Switched off here: switch on Connect with ${app.name} first` };
    if (!this.running) return { ok: false, reason: 'not-started', text: `${this.self.name} isn't listening for other apps yet` };
    if (!this.conns.has(id)) {
      if (!paths.listSlugs(this.place).includes(app.slug)) return { ok: false, reason: 'not-running', text: `${app.name} isn't open` };
      this.retry.delete(id);
      this.why.delete(id);
      const trying = () => [...this.opening].some((c) => (c.expectedId ?? c.peerId) === id);
      if (!trying()) this.connect(app);
      await /** @type {Promise<void>} */ (
        new Promise((resolve) => {
          const done = () => {
            clearTimeout(timer);
            this.off('change', check);
            resolve();
          };
          const check = () => (this.conns.has(id) || this.why.has(id) || !trying()) && done();
          const timer = setTimeout(done, timeout);
          this.on('change', check);
          check();
        })
      );
    }
    const conn = this.conns.get(id);
    if (!conn) {
      const why = this.why.get(id);
      if (why?.status === 'pair-again') {
        return { ok: false, reason: 'pair-again', text: `The pairing doesn't match: press Pair again ${why.keyHeldBy === 'them' ? `in ${app.name}` : 'here'}` };
      }
      if (why?.status === 'incompatible') {
        return { ok: false, reason: 'incompatible', text: incompatible(this.self, why.theirApp ?? app, hs.PROTOCOL, why.theirProtocol ?? hs.PROTOCOL).text };
      }
      if (why?.reason === 'switched-off') return { ok: false, reason: 'switched-off', text: `${app.name} is open, but its Connect switch is off` };
      if (why?.status === 'confirm') return { ok: false, reason: 'confirm', text: `${app.name} asks to pair: press Allow here` };
      if (why?.reason === 'confirm-there') return { ok: false, reason: 'confirm-there', text: `Allow the pairing in ${app.name}` };
      return { ok: false, reason: 'no-answer', text: `${app.name} is open, but didn't answer` };
    }
    const started = performance.now();
    try {
      await conn.rpc.request('link.ping', {}, { timeout });
    } catch {
      return { ok: false, reason: 'no-answer', text: `${app.name} didn't answer` };
    }
    const ms = Math.max(1, Math.round(performance.now() - started));
    return { ok: true, ms, version: conn.peer.version, text: `${app.name} ${conn.peer.version} answered in ${ms} ms` };
  }

  isConnected(appId) {
    return this.conns.has(this.currentId(appId));
  }

  /**
   * What this app and another share: `out`, capabilities this app provides that it uses; `in`,
   * ones it provides that this app uses. Agreed in the hello while connected; from the known-apps
   * list otherwise, so a card can say what linking would do before the two have met.
   */
  sharesWith(app, conn) {
    if (conn) return { out: [...conn.agreed.outgoing.keys()].sort(), in: [...conn.agreed.incoming.keys()].sort() };
    const mine = (list) => (cap) => cap in list;
    return {
      out: (app.uses ?? []).filter(mine(this.mine.provides)).sort(),
      in: (app.provides ?? []).filter(mine(this.mine.uses)).sort(),
    };
  }

  /**
   * Every known app, for the Connected apps page:
   * status 'off' (its switch is off) | 'waiting' | 'connected' | 'pair-again' | 'incompatible'.
   */
  peers() {
    return this.knownApps.map((app) => {
      const conn = this.conns.get(app.id);
      const why = this.why.get(app.id);
      const enabled = this.allowedAny(this.idsOf(app.id));
      const paired = this.findKey(this.idsOf(app.id));
      let status = !enabled ? 'off' : conn ? 'connected' : (why?.status ?? 'waiting');
      if (status === 'connected' && !conn) status = 'waiting';
      if (status === 'confirm' && Date.now() - (why?.at ?? 0) > ASKING_MS) status = 'waiting'; // it stopped asking
      let report = null;
      if (conn) report = compatibility(this.self, conn.peer, conn.agreed);
      else if (status === 'incompatible' && why?.theirProtocol) report = incompatible(this.self, why.theirApp ?? app, hs.PROTOCOL, why.theirProtocol);
      return {
        id: app.id,
        formerIds: app.formerIds ?? [],
        name: app.name,
        summary: app.summary,
        icon: app.icon,
        homepage: app.homepage,
        download: app.download,
        installed: this.appDataDir ? isInstalled(app, this.appDataDir) : null,
        enabled,
        status,
        reason: status === 'confirm' ? null : (why?.reason ?? null),
        keyHeldBy: status === 'pair-again' ? (why?.keyHeldBy ?? null) : null,
        asking: status === 'confirm' && why?.theirApp ? { name: why.theirApp.name, version: why.theirApp.version } : null,
        version: conn?.peer.version ?? null,
        report,
        shares: this.sharesWith(app, conn),
        pairedAt: paired?.pairedAt ?? null,
        keysEncrypted: !!this.keys.encrypted,
      };
    });
  }

  changed() {
    this.emit('change');
  }

  log(level, text) {
    this.logFn(level, text);
    this.emit('log', level, text);
  }
}

/** @param {LinkOptions} opts */
const createLink = (opts) => new Link(opts);

module.exports = { createLink, Link, CODES, GrapevineError, KNOWN_APPS, fileKeyStore, memoryKeyStore, isInstalled, iconDataUrl, PROTOCOL: hs.PROTOCOL, paths };
