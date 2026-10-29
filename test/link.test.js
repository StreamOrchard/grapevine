// Two real links over real sockets, and a raw client for what a well-behaved app never sends.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const hs = require('../src/handshake');
const { createLink, CODES, memoryKeyStore, fileKeyStore, paths, KNOWN_APPS } = require('../src');
const { LineReader, encode } = require('../src/framing');
const { LOG_DATA_MAX, QUEUE_MAX } = require('../src/connection');
const { PD, MV, FAST, tmpPlace, pair, once, until, sleep, raw } = require('./helpers');

const FARMING = {
  state: 'farming',
  account: { platform: 'kick', user: 'pearfan' },
  channel: { platform: 'kick', slug: 'pixelpear', name: 'PixelPear' },
  drop: null,
};
const PLAYERS = { platforms: { kick: { signedIn: false, mode: 'auto', account: null, open: [{ platform: 'kick', slug: 'pixelpear' }] } } };

/** Runs fn with a fresh folder, stopping every link it made. */
function withPlace(fn) {
  return async () => {
    const t = tmpPlace();
    const links = [];
    const track = (...ls) => (links.push(...ls), ls);
    try {
      await fn(t, track);
    } finally {
      for (const l of links) await l.stop().catch(() => {});
      t.cleanup();
    }
  };
}

/** Says hello as Stream Multiview from a raw client, and proves the pairing. */
async function rawHello(
  r,
  { app = MV, pair: wantPair = true, key, capabilities = { 'drops.farming': { uses: ['1.0'] }, players: { provides: ['1.0'] } } } = {},
) {
  const clientNonce = hs.nonce();
  r.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'link.hello',
    params: { protocol: { min: 1, max: 1 }, app, capabilities, auth: { nonce: clientNonce, pair: wantPair } },
  });
  const res = await r.next();
  if (res.error) return { res };
  const k = key ?? res.result.auth.key;
  assert.ok(hs.proofOk(k, 'server', clientNonce, res.result.auth.proof), 'the listener proved itself');
  r.send({ jsonrpc: '2.0', id: 2, method: 'link.auth', params: { proof: hs.proof(k, 'client', res.result.auth.nonce) } });
  const auth = await r.next();
  return { res, auth, key: k };
}

/** The next message from a raw client that isn't the listener's own subscribe request. */
async function nextOwn(r) {
  for (;;) {
    const m = await r.next();
    if (m?.method !== 'link.subscribe') return m;
  }
}

test(
  'two apps pair the first time, then trade events both ways and answer requests',
  withPlace(async ({ place }, track) => {
    const { pd, mv } = pair(place);
    track(pd, mv);
    await pd.start();
    assert.deepEqual(
      pd.peers().map((p) => [p.name, p.status]),
      [['Stream Multiview', 'waiting']],
    );
    assert.deepEqual(pd.peers()[0].shares, { out: ['drops.farming'], in: ['players'] }, 'before they meet: from the known-apps list');
    const { pd: alone } = pair(place, { pd: { provides: {}, uses: {} } });
    assert.deepEqual(alone.peers()[0].shares, { out: [], in: [] }, 'nothing in common');
    pd.publish('drops.farming.changed', FARMING); // before anyone is listening: kept for later
    const got = once(mv, 'event');
    await mv.start();
    await once(mv, 'connected');
    const [from, name, params] = await got;
    assert.equal(from, PD.id);
    assert.equal(name, 'drops.farming.changed');
    assert.equal(params.channel.slug, 'pixelpear', 'a new subscriber gets the latest state at once');
    assert.equal(params.seq, 1);

    const back = once(pd, 'event');
    mv.publish('players.changed', PLAYERS);
    assert.equal((await back)[2].platforms.kick.mode, 'auto');

    const next = once(mv, 'event');
    pd.publish('drops.farming.changed', { ...FARMING, state: 'paused', channel: null });
    assert.equal((await next)[2].seq, 2);
    assert.equal((await mv.request(PD.id, 'drops.farming.get')).state, 'paused', 'a .get with no handler answers with the last .changed');

    const [peer] = pd.peers();
    assert.deepEqual(peer.shares, { out: ['drops.farming'], in: ['players'] }, 'what they share, as agreed');
    assert.deepEqual(mv.peers()[0].shares, { out: ['players'], in: ['drops.farming'] });
    assert.equal(peer.status, 'connected');
    assert.equal(peer.version, '0.4.0');
    assert.equal(peer.report.text, 'Works');
    assert.match(peer.pairedAt, /^\d{4}-/);
    assert.ok(pd.isConnected(MV.id));
    assert.ok(pd.keys.get(MV.id).key === mv.keys.get(PD.id).key, 'both kept the same key');
  }),
);

test(
  'after a restart they connect with the key they kept, without pairing again; a stop is noticed at once',
  withPlace(async ({ place }, track) => {
    const keys = { pd: memoryKeyStore(), mv: memoryKeyStore() };
    const first = pair(place, { pd: { keys: keys.pd }, mv: { keys: keys.mv } });
    const { mv } = first;
    let { pd } = first;
    track(pd, mv);
    await pd.start();
    await mv.start();
    await once(mv, 'connected');
    const { key } = await until(() => keys.pd.get(MV.id), 'Pear Drops to keep the key'); // it connects, so it saves the key a moment later
    const gone = once(mv, 'disconnected');
    await pd.stop();
    assert.match((await gone)[1], /Pear Drops quit/);
    if (process.platform !== 'win32') assert.ok(!fs.existsSync(paths.socketPath(PD.slug, place)), 'its socket is removed');
    ({ pd } = pair(place, { pd: { keys: keys.pd } }));
    track(pd);
    await pd.start();
    await once(pd, 'connected');
    assert.equal(keys.pd.get(MV.id).key, key, 'the same key');
    await pd.stop();
    await pd.stop(); // twice is fine
    await mv.start(); // already running: nothing happens
  }),
);

test(
  'with keys decrypted asynchronously, start() waits for them: after a restart it connects with the kept key, not as unpaired',
  withPlace(async ({ place }, track) => {
    const file = path.join(place.env.GRAPEVINE_DIR, 'pd-grapevine.json');
    const slow = (t) => new Promise((r) => setTimeout(() => r(t), 50));
    const crypt = { encrypt: (t) => slow(Buffer.from(t).toString('hex')), decrypt: (t) => slow(Buffer.from(t, 'hex').toString()) };
    const mvKeys = memoryKeyStore();
    const first = pair(place, { pd: { keys: fileKeyStore(file, crypt) }, mv: { keys: mvKeys } });
    const { mv } = first;
    let { pd } = first;
    track(pd, mv);
    await pd.start();
    await mv.start();
    await once(mv, 'connected');
    const { key } = await until(() => mvKeys.get(PD.id), 'Stream Multiview to keep the key');
    await until(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('"encrypted": true'), 'Pear Drops to save its key, encrypted');
    await pd.stop();
    ({ pd } = pair(place, { pd: { keys: fileKeyStore(file, crypt) } }));
    track(pd);
    await pd.start();
    await once(pd, 'connected');
    assert.equal(pd.keys.get(MV.id).key, key, 'the same key');
    assert.equal(mvKeys.get(PD.id).key, key, 'not paired again');
  }),
);

test(
  'the switch: an app switched off is refused and shown as Off; switching it on connects, switching off disconnects',
  withPlace(async ({ place }, track) => {
    // Pear Drops connects (its slug sorts first), and Stream Multiview's switch is off.
    let mvAllows = false;
    const { pd, mv } = pair(place, { mv: { allowed: () => mvAllows } });
    track(pd, mv);
    await pd.start();
    await mv.start();
    await until(() => pd.peers()[0].reason === 'switched-off', 'Pear Drops to be refused');
    assert.equal(pd.peers()[0].status, 'waiting');
    assert.equal(mv.peers()[0].status, 'off');
    mvAllows = true;
    mv.refresh();
    await until(() => pd.isConnected(MV.id), 'connected once switched on');
    const gone = once(pd, 'disconnected');
    mvAllows = false;
    mv.refresh();
    assert.match((await gone)[1], /Switched off in Stream Multiview/);
    let pdAllows = true;
    const { pd: pd2 } = pair(place, { pd: { allowed: () => pdAllows } });
    assert.equal(pd2.peers()[0].status, 'waiting');
    pdAllows = false;
    assert.equal(pd2.peers()[0].status, 'off', "the connecting app's own switch off: Off");
    const throwing = createLink({
      app: PD,
      allowed: () => {
        throw new Error('settings not loaded');
      },
    });
    assert.equal(throwing.peers()[0].enabled, false, 'a switch that fails to answer counts as off');
  }),
);

test(
  'Disconnect: both apps forget the pairing',
  withPlace(async ({ place }, track) => {
    const { pd, mv } = pair(place);
    track(pd, mv);
    await pd.start();
    await mv.start();
    await once(mv, 'connected');
    const unpaired = once(pd, 'unpaired');
    await mv.disconnect(PD.id);
    assert.equal((await unpaired)[0], MV.id);
    assert.equal(mv.keys.get(PD.id), null);
    await until(() => pd.keys.get(MV.id) === null, 'Pear Drops to forget the key');
    assert.equal(pd.peers()[0].reason, 'disconnected-there');
    await pd.disconnect(MV.id); // not connected: just forgets
  }),
);

test(
  'Pair again: when one app lost its key, the card says which app to press it in, and pressing it pairs afresh',
  withPlace(async ({ place }, track) => {
    // Stream Multiview kept its key, Pear Drops lost it (reinstalled).
    const { pd, mv } = pair(place);
    track(pd, mv);
    mv.keys.set(PD.id, hs.newKey());
    await pd.start();
    await mv.start();
    await until(() => mv.peers()[0].status === 'pair-again' && pd.peers()[0].status === 'pair-again', 'both to need pairing again');
    assert.equal(mv.peers()[0].keyHeldBy, 'us');
    assert.equal(pd.peers()[0].keyHeldBy, 'them');
    mv.pairAgain(PD.id);
    await until(() => mv.isConnected(PD.id), 'paired afresh');

    // The other way round: Pear Drops kept a key, Stream Multiview lost its own.
    await mv.stop();
    const { mv: fresh } = pair(place);
    track(fresh);
    await fresh.start();
    await until(() => fresh.peers()[0].status === 'pair-again' && pd.peers()[0].keyHeldBy === 'us', 'the listener to hold the old key');
    assert.equal(fresh.peers()[0].keyHeldBy, 'them');
    pd.pairAgain(MV.id);
    await until(() => fresh.isConnected(PD.id), 'paired afresh');
  }),
);

test(
  'keys that differ fail the proof, and neither app trusts the other',
  withPlace(async ({ place }, track) => {
    const { pd, mv } = pair(place);
    track(pd, mv);
    pd.keys.set(MV.id, hs.newKey());
    mv.keys.set(PD.id, hs.newKey());
    await pd.start();
    await mv.start();
    await until(() => pd.peers()[0].status === 'pair-again', 'a wrong proof');
    assert.ok(!pd.isConnected(MV.id));
  }),
);

test(
  'one copy per app: a second one is refused, and a socket left by a crash is replaced',
  withPlace(async ({ place }, track) => {
    const { pd } = pair(place);
    const { pd: twin } = pair(place);
    track(pd);
    await pd.start();
    if (process.platform === 'win32') return;
    await assert.rejects(twin.start(), /Another copy of Pear Drops/);
    await pd.stop();
    paths.ensureDir(place); // (a short /tmp folder goes with its last app; a crash would have left it)
    fs.writeFileSync(paths.socketPath(PD.slug, place), ''); // a leftover, nobody listening
    const { pd: again } = pair(place);
    track(again);
    await again.start();
    assert.ok(fs.statSync(paths.socketPath(PD.slug, place)).isSocket());
  }),
);

test(
  'the hello is checked: bad fields, no protocol in common, and anything before it are refused',
  withPlace(async ({ place }, track) => {
    const { pd } = pair(place);
    track(pd);
    await pd.start();
    const sock = paths.socketPath(PD.slug, place);

    const early = await raw(sock);
    early.send({ jsonrpc: '2.0', id: 9, method: 'drops.farming.get', params: {} });
    assert.equal((await early.next()).error.code, CODES.NOT_PAIRED);
    early.close();

    const bad = await raw(sock);
    bad.send({ jsonrpc: '2.0', id: 1, method: 'link.hello', params: { app: { id: 'X' } } });
    const refusal = await bad.next();
    assert.equal(refusal.error.code, CODES.INVALID_PARAMS);
    assert.ok(refusal.error.data.problems.length > 3);
    assert.equal(await bad.next(), null, 'then closed');

    const future = await raw(sock);
    future.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'link.hello',
      params: { protocol: { min: 7, max: 9 }, app: MV, capabilities: {}, auth: { nonce: hs.nonce() } },
    });
    const no = await future.next();
    assert.equal(no.error.code, CODES.UNSUPPORTED);
    assert.deepEqual(no.error.data.protocol, hs.PROTOCOL);
    await until(() => pd.peers()[0].status === 'incompatible', 'shown as incompatible');
    assert.equal(pd.peers()[0].report.text, "Can't connect: update Pear Drops");

    const silent = await raw(sock);
    await until(() => silent.closed(), 'a connection that never says hello to be closed', 3000);
  }),
);

test(
  'messages that break the rules: not JSON, too long, or too many',
  withPlace(async ({ place }, track) => {
    const { pd } = pair(place, { pd: { timing: { ...FAST, rateMax: 5, strikes: 2 } } });
    track(pd);
    await pd.start();
    const sock = paths.socketPath(PD.slug, place);

    const junk = await raw(sock);
    junk.send('this is not json\n');
    assert.equal((await junk.next()).error.code, CODES.PARSE_ERROR);
    junk.send('[1]\n');
    assert.equal((await junk.next()).error.code, CODES.INVALID_REQUEST);
    junk.send(`${'x'.repeat(1024 * 1024 + 1)}\n`);
    assert.equal(await junk.next(), null, 'a line over 1 MiB closes the connection');

    const busy = await raw(sock);
    for (let i = 0; i < 8; i++) busy.send({ jsonrpc: '2.0', id: 100 + i, method: 'link.ping', params: {} });
    const replies = [];
    for (let m = await busy.next(); m; m = await busy.next().catch(() => null)) replies.push(m);
    assert.ok(
      replies.some((m) => m.error?.code === CODES.TOO_MANY),
      'told to slow down',
    );
    await sleep(1050);
    for (let i = 0; i < 8; i++) busy.send({ jsonrpc: '2.0', id: 200 + i, method: 'link.ping', params: {} });
    await until(() => busy.closed(), 'closed after going over the limit twice');
  }),
);

test(
  'once paired: only agreed capabilities, checked params, subscriptions with the latest state, and a goodbye',
  withPlace(async ({ place }, track) => {
    const { pd } = pair(place);
    track(pd);
    pd.handle('drops.farming.get', () => ({ ...FARMING, seq: 0, at: new Date().toISOString() }));
    await pd.start();
    pd.publish('drops.farming.changed', FARMING);
    const r = await raw(paths.socketPath(PD.slug, place));
    const { auth } = await rawHello(r);
    assert.deepEqual(auth.result, {});
    assert.ok(pd.keys.get(MV.id), 'paired');

    r.send({ jsonrpc: '2.0', id: 3, method: 'link.ping', params: {} });
    assert.deepEqual((await nextOwn(r)).result, {});
    r.send({ jsonrpc: '2.0', id: 4, method: 'link.subscribe', params: { events: ['drops.farming.changed', 'players.changed', 'nope'] } });
    assert.deepEqual((await nextOwn(r)).result, { subscribed: ['drops.farming.changed'] }, 'only what Pear Drops provides');
    const latest = await nextOwn(r);
    assert.equal(latest.method, 'drops.farming.changed');
    assert.equal(latest.params.state, 'farming');

    r.send({ jsonrpc: '2.0', id: 5, method: 'drops.farming.get', params: {} });
    assert.equal((await nextOwn(r)).result.seq, 0, 'its own handler answers');
    r.send({ jsonrpc: '2.0', id: 6, method: 'players.get', params: {} });
    assert.equal((await nextOwn(r)).error.code, CODES.NOT_AGREED, "Pear Drops doesn't provide players");
    r.send({ jsonrpc: '2.0', id: 7, method: 'nothing.at.all', params: {} });
    assert.equal((await nextOwn(r)).error.code, CODES.METHOD_NOT_FOUND);
    r.send({ jsonrpc: '2.0', id: 8, method: 'drops.farming.nope', params: {} });
    assert.equal((await nextOwn(r)).error.code, CODES.METHOD_NOT_FOUND);
    r.send({ jsonrpc: '2.0', id: 9, method: 'drops.farming.get', params: { x: 1 } }); // extra fields are fine
    assert.ok((await nextOwn(r)).result);

    // Events from it: only valid ones of capabilities Pear Drops uses get through.
    const heard = [];
    pd.on('event', (_f, name, params) => heard.push([name, params.seq]));
    r.send({ jsonrpc: '2.0', method: 'players.changed', params: { seq: 1, at: 'not a time', platforms: {} } });
    r.send({ jsonrpc: '2.0', method: 'drops.farming.changed', params: { ...FARMING, seq: 1, at: new Date().toISOString() } });
    r.send({ jsonrpc: '2.0', method: 'players.changed', params: { seq: 2, at: new Date().toISOString(), platforms: {} } });
    await until(() => heard.length === 1, 'the valid event');
    assert.deepEqual(heard, [['players.changed', 2]]);

    const gone = once(pd, 'disconnected');
    r.send({ jsonrpc: '2.0', method: 'link.bye', params: { reason: 'testing' } });
    assert.match((await gone)[1], /said goodbye \(testing\)/);
  }),
);

test(
  'a handler that fails, or answers with the wrong shape, gets an error back rather than bad data',
  withPlace(async ({ place }, track) => {
    const { pd, mv } = pair(place, { pd: { strict: false } });
    track(pd, mv);
    const logged = [];
    pd.on('log', (level, text) => logged.push(`${level}: ${text}`));
    pd.handle('drops.farming.get', () => ({ state: 'farming' }));
    await pd.start();
    await mv.start();
    await once(mv, 'connected');
    await assert.rejects(mv.request(PD.id, 'drops.farming.get'), (e) => e.code === CODES.INTERNAL_ERROR);
    assert.ok(logged.some((l) => /invalid result/.test(l)));
    pd.handle('drops.farming.get', () => {
      throw new Error('boom');
    });
    await assert.rejects(mv.request(PD.id, 'drops.farming.get'), (e) => e.code === CODES.INTERNAL_ERROR);
    assert.ok(logged.some((l) => /boom/.test(l)));
    pd.handle('drops.farming.get', () => {
      throw Object.assign(new (require('../src').GrapevineError)(CODES.TOO_MANY, 'busy'));
    });
    await assert.rejects(mv.request(PD.id, 'drops.farming.get'), (e) => e.code === CODES.TOO_MANY, 'its own code is kept');
    // Asking: not connected, not agreed, bad params, or a bad answer.
    await assert.rejects(pd.request('nobody', 'players.get'), (e) => e.code === CODES.CLOSED);
    await assert.rejects(mv.request(PD.id, 'players.get'), (e) => e.code === CODES.NOT_AGREED);
    await assert.rejects(mv.request(PD.id, 'drops.farming.get', /** @type {any} */ ('x')), (e) => e.code === CODES.INVALID_PARAMS);
    mv.handle('players.get', () => ({ seq: 0, at: new Date().toISOString(), platforms: { kick: { signedIn: 'yes' } } }));
    await assert.rejects(pd.request(MV.id, 'players.get'), (e) => e.code === CODES.INTERNAL_ERROR);
    // Publishing something that doesn't fit: logged, and not sent.
    const sent = pd.publish('drops.farming.changed', /** @type {any} */ ({ state: 1 }));
    assert.equal(sent.seq, 1);
    assert.ok(logged.some((l) => /doesn't fit/.test(l)));
  }),
);

test(
  'strict mode throws on a message that does not fit; nothing published yet means .get has no answer',
  withPlace(async ({ place }, track) => {
    const { pd, mv } = pair(place);
    track(pd, mv);
    assert.throws(() => pd.publish('drops.farming.changed', /** @type {any} */ ({ state: 1 })), /doesn't fit its schema/);
    assert.throws(() => pd.publish('players.changed', /** @type {any} */ (PLAYERS)), /isn't part of a capability Pear Drops provides/);
    assert.throws(() => pd.publish('nothing.changed', {}), /isn't part of a capability/);
    await pd.start();
    await mv.start();
    await once(mv, 'connected');
    await assert.rejects(mv.request(PD.id, 'drops.farming.get'), (e) => e.code === CODES.METHOD_NOT_FOUND && /doesn't answer/.test(e.message));
  }),
);

test('createLink checks the app it describes and the versions it lists', () => {
  assert.throws(() => createLink({ app: { ...PD, id: 'Bad Id' }, allowed: () => true }), /app\.id/);
  assert.throws(() => createLink({ app: PD, provides: { 'drops.farming': '9.0' }, allowed: () => true }), /no schema for drops\.farming 9\.0/);
  const withIcon = createLink({ app: { ...PD, icon: require('../src/known-apps').KNOWN_APPS[0].icon }, allowed: () => true });
  assert.match(withIcon.self.icon, /^data:image\/png;base64,/, 'a logo file is sent as a data URL');
});

test(
  'the connecting app: refused, an impostor, a wrong proof, or a hung app',
  withPlace(async ({ place }, track) => {
    // A raw "Stream Multiview" that answers however each case needs; Pear Drops connects to it.
    let behave = 'switched-off';
    const server = net.createServer((socket) => {
      const reader = new LineReader(
        (m) => {
          const send = (o) => socket.write(encode(o));
          if (m.method === 'link.hello') {
            if (behave === 'switched-off') return send({ jsonrpc: '2.0', id: m.id, error: { code: CODES.SWITCHED_OFF, message: 'off' } });
            if (behave === 'future')
              return send({ jsonrpc: '2.0', id: m.id, error: { code: CODES.UNSUPPORTED, message: 'no', data: { protocol: { min: 5, max: 5 } } } });
            const key = hs.newKey();
            const app = behave === 'impostor' ? { ...MV, id: 'com.someone.else' } : MV;
            const proofOf = behave === 'wrong-proof' ? hs.proof(hs.newKey(), 'server', m.params.auth.nonce) : hs.proof(key, 'server', m.params.auth.nonce);
            return send({
              jsonrpc: '2.0',
              id: m.id,
              result: { protocol: 1, app, capabilities: { players: { provides: ['1.0'] } }, auth: { proof: proofOf, nonce: hs.nonce(), key } },
            });
          }
          if (m.method === 'link.auth') return send({ jsonrpc: '2.0', id: m.id, result: {} });
          // 'hung': never answers a ping
        },
        () => {},
      );
      socket.on('data', (d) => reader.push(d));
      socket.on('error', () => {});
    });
    paths.ensureDir(place);
    await new Promise((r) => server.listen(paths.socketPath(MV.slug, place), r));
    try {
      const { pd } = pair(place);
      track(pd);
      await pd.start();
      await until(() => pd.peers()[0].reason === 'switched-off', 'refused: switched off there');
      behave = 'future';
      pd.refresh();
      await until(() => pd.peers()[0].status === 'incompatible', 'no protocol in common');
      assert.equal(pd.peers()[0].report.text, "Can't connect: update Pear Drops", 'it has the older protocol');
      behave = 'wrong-proof';
      pd.refresh();
      await until(() => pd.peers()[0].status === 'pair-again', 'a wrong proof');
      behave = 'impostor';
      pd.refresh();
      await sleep(150);
      assert.ok(!pd.isConnected(MV.id), 'an app with a different id is never trusted');
      behave = 'hung';
      pd.refresh();
      await until(() => pd.isConnected(MV.id), 'connected');
      const [, reason] = await once(pd, 'disconnected', 3000);
      assert.match(reason, /stopped answering/);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }),
);

test(
  'the listening app closes a connection that goes quiet, and keeps one connection when both connect',
  withPlace(async ({ place }, track) => {
    const { pd, mv } = pair(place);
    track(pd, mv);
    await pd.start();
    const r = await raw(paths.socketPath(PD.slug, place));
    await rawHello(r);
    await until(() => r.closed(), 'closed after three missed pings', 3000);

    pd.pairAgain(MV.id); // the raw client paired as Stream Multiview: start afresh for the real one
    await mv.start();
    await once(mv, 'connected');
    mv.connect({ id: PD.id, slug: PD.slug }); // Stream Multiview connects too, which it normally leaves to Pear Drops
    await sleep(300);
    assert.equal(pd.conns.size, 1);
    assert.equal(mv.conns.size, 1);
    assert.ok(mv.isConnected(PD.id) && pd.isConnected(MV.id), 'still connected, once');
  }),
);

const RENAMED = 'com.streamorchard.streammultiview';

test(
  'every hello says which ids the app had before: none, until it is renamed',
  withPlace(async ({ place }, track) => {
    const { pd } = pair(place);
    track(pd);
    await pd.start();
    const r = await raw(paths.socketPath(PD.slug, place));
    const { res } = await rawHello(r);
    assert.deepEqual(res.result.app.formerIds, []);
    assert.throws(() => createLink({ app: { ...MV, formerIds: [MV.id] }, allowed: () => true }), /formerIds/, 'not its own id');
  }),
);

test(
  'after a rename, an app that only knows the old id still connects with the old pairing',
  withPlace(async ({ place }, track) => {
    const keys = { pd: memoryKeyStore(), mv: memoryKeyStore() };
    const allowed = (id) => id === MV.id || id === PD.id; // Pear Drops' switch is saved under the old id
    const first = pair(place, { pd: { keys: keys.pd, allowed }, mv: { keys: keys.mv } });
    track(first.pd, first.mv);
    await first.pd.start();
    await first.mv.start();
    await until(() => keys.pd.get(MV.id) && keys.mv.get(PD.id), 'paired under the old id');
    await first.mv.stop();

    // Stream Multiview comes back renamed, saying what it was. Pear Drops hasn't updated Grapevine.
    const { mv: renamed } = pair(place, { mv: { keys: keys.mv, app: { id: RENAMED, formerIds: [MV.id] } } });
    track(renamed);
    await renamed.start();
    await until(() => first.pd.isConnected(MV.id), 'connected without pairing again');
    assert.equal(first.pd.peers()[0].status, 'connected');
    assert.equal(first.pd.currentId(MV.id), MV.id, 'Pear Drops still knows it by the old id');
    assert.equal(first.pd.isConnected(RENAMED), true, 'and it learned the new id from the hello');
    const heard = once(renamed, 'event');
    first.pd.publish('drops.farming.changed', FARMING);
    assert.equal((await heard)[2].state, 'farming');
  }),
);

test(
  'after a rename, an app that knows both ids finds the old pairing and switch, and gives the new id',
  withPlace(async ({ place }, track) => {
    const keys = { pd: memoryKeyStore(), mv: memoryKeyStore() };
    const allowed = (id) => id === MV.id || id === PD.id; // still saved under the old id
    const first = pair(place, { pd: { keys: keys.pd, allowed }, mv: { keys: keys.mv } });
    track(first.pd, first.mv);
    await first.pd.start();
    await first.mv.start();
    await until(() => keys.pd.get(MV.id) && keys.mv.get(PD.id), 'paired under the old id');
    await first.pd.stop();
    await first.mv.stop();

    // Both updated: Grapevine's list has Stream Multiview's new id, with the old one as a former id.
    const knownApps = KNOWN_APPS.map((a) => (a.id === MV.id ? { ...a, id: RENAMED, formerIds: [MV.id] } : a));
    const { pd, mv } = pair(place, {
      pd: { keys: keys.pd, allowed, knownApps },
      mv: { keys: keys.mv, knownApps, app: { id: RENAMED, formerIds: [MV.id] } },
    });
    track(pd, mv);
    assert.deepEqual(
      mv.peers().map((p) => p.name),
      ['Pear Drops'],
      'its own old entry is not another app',
    );
    const [card] = pd.peers();
    assert.equal(card.id, RENAMED);
    assert.deepEqual(card.formerIds, [MV.id]);
    assert.equal(card.enabled, true, 'the switch saved under the old id still counts');
    assert.ok(card.pairedAt, 'and so does the key');
    await pd.start();
    await mv.start();
    await until(() => pd.isConnected(RENAMED), 'connected without pairing again');
    assert.equal(pd.currentId(MV.id), RENAMED, 'the id to move its own settings to');
    assert.equal(pd.isConnected(MV.id), true, 'asking by the old id still works');
    assert.equal(mv.isConnected(PD.id), true);
    const players = once(pd, 'event');
    mv.publish('players.changed', PLAYERS);
    assert.equal((await players)[1], 'players.changed');
    assert.equal((await mv.request(PD.id, 'drops.farming.get').catch((e) => e)).code, CODES.METHOD_NOT_FOUND, 'requests work across the rename');
    await pd.disconnect(MV.id); // by the old id
    assert.equal(keys.pd.get(MV.id), null, 'every id is forgotten');
    assert.equal(keys.pd.get(RENAMED), null);
  }),
);

test(
  'a socket that goes before start() finishes makes start() fail, rather than an exception the app cannot catch',
  { skip: process.platform === 'win32' && 'pipes have no file to set permissions on' },
  withPlace(async ({ place }, t) => {
    const { pd } = pair(place);
    t(pd);
    const real = fs.chmodSync;
    fs.chmodSync = (file, mode) => {
      if (String(file).endsWith('.sock')) throw Object.assign(new Error(`ENOENT: no such file or directory, chmod '${file}'`), { code: 'ENOENT' });
      return real(file, mode);
    };
    try {
      await assert.rejects(pd.start(), /ENOENT/);
      assert.equal(pd.running, false);
    } finally {
      fs.chmodSync = real;
    }
    await pd.start(); // and it can start once things are back
    assert.equal(pd.running, true);
  }),
);

test(
  'Test on a card: a round trip when connected, and in words why not otherwise',
  withPlace(async ({ place }, track) => {
    let mvAllows = true;
    let pdAllows = true;
    const { pd, mv } = pair(place, { pd: { allowed: () => pdAllows }, mv: { allowed: () => mvAllows } });
    track(pd, mv);
    assert.deepEqual(await pd.test('com.nobody'), { ok: false, reason: 'unknown', text: "com.nobody isn't an app Grapevine knows" });
    assert.equal((await pd.test(MV.id)).reason, 'not-started');
    await pd.start();
    assert.deepEqual(await pd.test(MV.id), { ok: false, reason: 'not-running', text: "Stream Multiview isn't open" });

    // Stream Multiview tests first: it connects itself, though Pear Drops normally does.
    mvAllows = true;
    await mv.start();
    const fromMv = await mv.test(PD.id);
    assert.equal(fromMv.ok, true, JSON.stringify(fromMv));
    assert.ok(fromMv.ms >= 1);
    assert.equal(fromMv.version, '0.1.5');
    assert.match(fromMv.text, /^Pear Drops 0\.1\.5 answered in \d+ ms$/);
    await until(() => pd.conns.size === 1 && mv.conns.size === 1, 'one connection each, whoever connected');
    const fromPd = await pd.test(MV.id);
    assert.equal(fromPd.ok, true);
    assert.match(fromPd.text, /^Stream Multiview 0\.4\.0 answered in \d+ ms$/);

    // Its switch off: Pear Drops can't link, and says why.
    mvAllows = false;
    mv.refresh();
    await until(() => !pd.isConnected(MV.id), 'unlinked');
    assert.deepEqual(await pd.test(MV.id), { ok: false, reason: 'switched-off', text: 'Stream Multiview is open, but its Connect switch is off' });
    // This side's switch off.
    pdAllows = false;
    assert.equal((await pd.test(MV.id)).reason, 'off');
    pdAllows = true;
    mvAllows = true;

    // The pairing doesn't match: Pear Drops kept a key Stream Multiview lost.
    mv.keys.delete(PD.id);
    pd.keys.set(MV.id, hs.newKey());
    const bad = await pd.test(MV.id);
    assert.equal(bad.reason, 'pair-again');
    assert.equal(bad.text, "The pairing doesn't match: press Pair again here");
    const other = await mv.test(PD.id);
    assert.equal(other.reason, 'pair-again');
    assert.equal(other.text, "The pairing doesn't match: press Pair again in Pear Drops");
  }),
);

test(
  'Test: an app that connects but never answers, or one too old to link with',
  withPlace(async ({ place }, track) => {
    let behave = 'hung';
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      if (behave === 'silent') return; // takes the connection, says nothing
      const reader = new LineReader(
        (m) => {
          const send = (o) => socket.write(encode(o));
          if (m.method === 'link.hello' && behave === 'future')
            return send({ jsonrpc: '2.0', id: m.id, error: { code: CODES.UNSUPPORTED, message: 'no', data: { protocol: { min: 5, max: 5 } } } });
          if (m.method === 'link.hello') {
            const key = hs.newKey();
            return send({
              jsonrpc: '2.0',
              id: m.id,
              result: {
                protocol: 1,
                app: MV,
                capabilities: { players: { provides: ['1.0'] } },
                auth: { proof: hs.proof(key, 'server', m.params.auth.nonce), nonce: hs.nonce(), key },
              },
            });
          }
          if (m.method === 'link.auth') return send({ jsonrpc: '2.0', id: m.id, result: {} });
          // link.ping: no answer
        },
        () => {},
      );
      socket.on('data', (d) => reader.push(d));
    });
    paths.ensureDir(place);
    await new Promise((r) => server.listen(paths.socketPath(MV.slug, place), r));
    const { pd } = pair(place, { pd: { timing: { ...FAST, pingMs: 60_000 } } }); // no pings of its own in the way
    track(pd);
    try {
      await pd.start();
      await until(() => pd.isConnected(MV.id), 'connected');
      assert.deepEqual(await pd.test(MV.id, { timeout: 200 }), { ok: false, reason: 'no-answer', text: "Stream Multiview didn't answer" });
      for (const sk of sockets) sk.destroy();
      await until(() => !pd.isConnected(MV.id), 'dropped');
      behave = 'future';
      const old = await pd.test(MV.id, { timeout: 1000 });
      assert.equal(old.reason, 'incompatible');
      assert.equal(old.text, "Can't connect: update Pear Drops");
      behave = 'silent';
      const quiet = await pd.test(MV.id, { timeout: 300 });
      assert.equal(quiet.reason, 'no-answer');
      assert.equal(quiet.text, "Stream Multiview is open, but didn't answer");
    } finally {
      await pd.stop();
      for (const sk of sockets) sk.destroy();
      await new Promise((r) => server.close(r));
    }
  }),
);

// ------------------------------------------------------------------ the activity log

/** The line a message takes on the wire, in bytes. */
const wire = (m) => Buffer.byteLength(encode(m));

test(
  'the activity log: both apps see every message, from the hello to the goodbye, with no data for the hello and the proofs',
  withPlace(async ({ place }, track) => {
    const slow = { ...FAST, pingMs: 60_000 }; // no pings of their own in the way
    const { pd, mv } = pair(place, { pd: { timing: slow }, mv: { timing: slow } });
    track(pd, mv);
    const log = { pd: [], mv: [] };
    pd.on('message', (m) => log.pd.push(m));
    mv.on('message', (m) => log.mv.push(m));
    const { GrapevineError } = require('../src');
    pd.handle('drops.farming.get', () => ({ ...FARMING, seq: 0, at: new Date().toISOString() }));
    await pd.start();
    await mv.start();
    await Promise.all([until(() => pd.isConnected(MV.id), 'Pear Drops connected'), until(() => mv.isConnected(PD.id), 'Multiview connected')]);
    const find = (side, dir, kind, method) =>
      until(() => log[side].find((m) => m.dir === dir && m.kind === kind && m.method === method), `${side}: ${dir} ${kind} ${method}`);

    // The hello and the proofs: Pear Drops connects, so it knows who it expects; Multiview doesn't until the hello.
    const hello = await find('pd', 'out', 'request', 'link.hello');
    assert.equal(hello.app, MV.id);
    assert.equal(typeof hello.id, 'number');
    assert.ok(!('data' in hello), 'no nonce in the log');
    assert.ok(hello.bytes > 0 && typeof hello.at === 'number');
    const helloIn = await find('mv', 'in', 'request', 'link.hello');
    assert.equal(helloIn.app, null, "the listening app doesn't know who it is yet");
    assert.equal(helloIn.bytes, hello.bytes, 'the same line, both sides');
    assert.ok(!('ms' in helloIn));
    const helloReply = await find('mv', 'out', 'reply', 'link.hello');
    assert.equal(helloReply.app, PD.id);
    assert.equal(helloReply.id, hello.id);
    assert.ok(!('data' in helloReply), 'no pairing key in the log');
    assert.ok(helloReply.ms >= 0, 'how long Multiview took to answer');
    const helloBack = await find('pd', 'in', 'reply', 'link.hello');
    assert.ok(!('data' in helloBack) && helloBack.ms >= 0 && helloBack.app === MV.id);
    for (const [side, dir, kind] of [
      ['pd', 'out', 'request'],
      ['mv', 'in', 'request'],
      ['mv', 'out', 'reply'],
      ['pd', 'in', 'reply'],
    ]) {
      const auth = await find(side, dir, kind, 'link.auth');
      assert.ok(!('data' in auth), `${side}: no proof in the log`);
      assert.equal(auth.app, side === 'pd' ? MV.id : PD.id);
    }

    // Subscribing: each app subscribes to what it uses, and hears back how long the answer took.
    const sub = await find('pd', 'out', 'request', 'link.subscribe');
    assert.deepEqual(sub.data, { events: ['players.changed'] });
    const subIn = await find('mv', 'in', 'request', 'link.subscribe');
    assert.deepEqual(subIn.data, sub.data);
    const subReply = await find('pd', 'in', 'reply', 'link.subscribe');
    assert.deepEqual(subReply.data, { subscribed: ['players.changed'] });
    assert.equal(subReply.id, sub.id);
    assert.ok(subReply.ms >= 0, 'the round trip');
    await find('mv', 'out', 'reply', 'link.subscribe');
    await until(() => log.pd.filter((m) => m.dir === 'in' && m.method === 'link.subscribe').length, 'Multiview subscribed');
    assert.equal(
      log.pd.filter((m) => m.dir === 'in' && m.kind === 'request' && m.method === 'link.subscribe').length,
      1,
      'reported once, even if it came while proving',
    );

    // An event, out and in, with its data and size.
    const sent = pd.publish('drops.farming.changed', FARMING);
    const out = await find('pd', 'out', 'event', 'drops.farming.changed');
    const heard = await find('mv', 'in', 'event', 'drops.farming.changed');
    assert.deepEqual(out.data, sent);
    assert.deepEqual(heard.data, sent);
    assert.ok(!('id' in out) && !('ms' in out), 'an event has no id or ms');
    assert.equal(out.bytes, wire({ jsonrpc: '2.0', method: 'drops.farming.changed', params: sent }));
    assert.equal(heard.bytes, out.bytes);
    assert.equal(heard.app, PD.id);

    // A capability request and its reply.
    const result = await mv.request(PD.id, 'drops.farming.get');
    const ask = await find('mv', 'out', 'request', 'drops.farming.get');
    assert.deepEqual(ask.data, {});
    const answer = await find('mv', 'in', 'reply', 'drops.farming.get');
    assert.deepEqual(answer.data, result);
    assert.equal(answer.id, ask.id);
    assert.ok(answer.ms >= 0);
    const answered = await find('pd', 'out', 'reply', 'drops.farming.get');
    assert.deepEqual(answered.data, result);
    assert.ok(answered.ms >= 0, 'how long Pear Drops took');

    // An error: its code and message, never its data.
    pd.handle('drops.farming.get', () => {
      throw new GrapevineError(CODES.TOO_MANY, 'busy', { secret: 'pearfan' });
    });
    await assert.rejects(mv.request(PD.id, 'drops.farming.get'), (e) => e.code === CODES.TOO_MANY);
    for (const [side, dir] of [
      ['pd', 'out'],
      ['mv', 'in'],
    ]) {
      const err = await find(side, dir, 'error', 'drops.farming.get');
      assert.deepEqual(err.data, { code: CODES.TOO_MANY, message: 'busy' });
      assert.ok(err.ms >= 0 && typeof err.id === 'number');
    }

    // A ping, from Test on a card.
    assert.ok((await pd.test(MV.id)).ok);
    const ping = await find('pd', 'out', 'request', 'link.ping');
    assert.deepEqual(ping.data, {});
    const pong = await find('pd', 'in', 'reply', 'link.ping');
    assert.deepEqual(pong.data, {});
    assert.ok(pong.ms >= 0);
    await find('mv', 'in', 'request', 'link.ping');
    await find('mv', 'out', 'reply', 'link.ping');

    // Every message one app sent, the other received, the same size.
    const sentBy = log.pd.filter((m) => m.dir === 'out');
    await until(() => log.mv.filter((m) => m.dir === 'in').length >= sentBy.length, 'Multiview to hear it all');
    const heardBy = log.mv.filter((m) => m.dir === 'in');
    assert.deepEqual(
      heardBy.map((m) => [m.kind, m.method, m.bytes]),
      sentBy.map((m) => [m.kind, m.method, m.bytes]),
    );

    // The goodbye, and nothing after it.
    const conn = pd.conns.get(MV.id);
    await pd.stop();
    const bye = await find('pd', 'out', 'event', 'link.bye');
    assert.deepEqual(bye.data, { reason: 'Pear Drops quit' });
    assert.deepEqual((await find('mv', 'in', 'event', 'link.bye')).data, bye.data);
    assert.equal(conn.inflight.out.size + conn.inflight.in.size, 0, 'nothing kept after closing');
    const count = log.pd.length;
    conn.send({ jsonrpc: '2.0', method: 'link.bye', params: {} });
    assert.equal(log.pd.length, count, 'not sent after closing, so not reported');
  }),
);

test(
  'confirmPairing, on the listening app: a first pairing waits for Allow there, and the other app says where to press it',
  withPlace(async ({ place }, track) => {
    const mvKeys = memoryKeyStore(),
      pdKeys = memoryKeyStore();
    const { pd, mv } = pair(place, { mv: { confirmPairing: true, keys: mvKeys }, pd: { keys: pdKeys } });
    track(pd, mv);
    await mv.start();
    await pd.start();
    await until(() => mv.peers()[0].status === 'confirm', 'Stream Multiview asked');
    assert.deepEqual(mv.peers()[0].asking, { name: PD.name, version: PD.version });
    assert.equal(mv.peers()[0].reason, null);
    await until(() => pd.peers()[0].reason === 'confirm-there', 'Pear Drops told');
    assert.deepEqual(await pd.test(MV.id, { timeout: 300 }), { ok: false, reason: 'confirm-there', text: 'Allow the pairing in Stream Multiview' });
    assert.equal((await mv.test(PD.id, { timeout: 300 })).reason, 'confirm');
    assert.equal(mvKeys.get(PD.id), null, 'no key kept');
    assert.equal(pdKeys.get(MV.id), null);
    mv.allowPairing(PD.id);
    await until(() => mv.isConnected(PD.id), 'paired once allowed');
    assert.ok(mvKeys.get(PD.id) && pdKeys.get(MV.id));
    assert.equal(mv.mayPairUntil.size, 0, 'the Allow is used up');
    // already paired: no Allow needed to connect again
    await pd.stop();
    await until(() => !mv.isConnected(PD.id), 'gone');
    const again = pair(place, { pd: { keys: pdKeys } }).pd;
    track(again);
    await again.start();
    await until(() => mv.isConnected(PD.id), 'back without asking');
  }),
);

test(
  'confirmPairing, on the connecting app: it says hello, waits for Allow there, and neither app keeps a key until then; Pair again allows',
  withPlace(async ({ place }, track) => {
    const mvKeys = memoryKeyStore(),
      pdKeys = memoryKeyStore();
    const { pd, mv } = pair(place, { pd: { confirmPairing: true, keys: pdKeys }, mv: { keys: mvKeys } });
    track(pd, mv);
    await mv.start();
    await pd.start();
    await until(() => pd.peers()[0].status === 'confirm', 'Pear Drops asked');
    assert.deepEqual(pd.peers()[0].asking, { name: MV.name, version: MV.version });
    assert.equal(mvKeys.get(PD.id), null, 'the other app kept nothing either');
    // it stops asking: after a while it's just waiting again
    pd.why.get(MV.id).at = Date.now() - 80_000;
    assert.equal(pd.peers()[0].status, 'waiting');
    assert.equal(pd.peers()[0].asking, null);
    pd.pairAgain(MV.id);
    await until(() => pd.isConnected(MV.id), 'paired after Pair again');
    assert.ok(mvKeys.get(PD.id) && pdKeys.get(MV.id));
  }),
);

test('allowPairing without confirmPairing only tries again', async () => {
  const t = tmpPlace();
  try {
    const { pd } = pair(t.place);
    pd.allowPairing(MV.id);
    assert.equal(pd.mayPairUntil.size, 0);
    assert.equal(pd.peers()[0].status, 'waiting');
  } finally {
    t.cleanup();
  }
});

test(
  'Windows: an app also answers on the pipe name an older Grapevine uses, so an older copy of the other app finds it',
  { skip: process.platform !== 'win32' && 'named pipes' },
  withPlace(async ({ place }, track) => {
    const { mv } = pair(place);
    track(mv);
    const logs = [];
    mv.on('log', (level, text) => logs.push(`${level}: ${text}`));
    await mv.start();
    assert.notEqual(paths.legacyPipe(MV.slug, place), paths.socketPath(MV.slug, place));
    assert.ok(paths.listSlugs(place).includes(MV.slug));
    assert.deepEqual(
      logs.filter((l) => /older pipe/.test(l)),
      [],
      'it answers on the older name',
    );
    const r = await raw(paths.legacyPipe(MV.slug, place));
    const { auth } = await rawHello(r, { app: PD, capabilities: { 'drops.farming': { provides: ['1.0'] }, players: { uses: ['1.0'] } } });
    assert.deepEqual(auth.result, {}, 'paired over the older name');
    r.close();
    await mv.stop();
    // (raw() waits for the connection and doesn't take its error: a plain socket that says why it failed)
    const reach = (p) =>
      new Promise((resolve, reject) => {
        const s = net.createConnection(p);
        s.once('connect', () => (s.destroy(), resolve()));
        s.once('error', reject);
      });
    await assert.rejects(reach(paths.legacyPipe(MV.slug, place)), 'and stops answering on it');
  }),
);

test(
  'the activity log: before the pairing is proven, nothing from inside a message, whatever it claims to be; data too big is left out',
  withPlace(async ({ place }, track) => {
    const { pd } = pair(place, { pd: { timing: { ...FAST, pingMs: 60_000 } } });
    track(pd);
    const log = [];
    pd.on('message', (m) => log.push(m));
    await pd.start();
    const r = await raw(paths.socketPath(PD.slug, place));
    // anything at all, before a hello
    r.send({ jsonrpc: '2.0', method: 'players.changed', params: { note: 'x'.repeat(50_000) } });
    r.send({ jsonrpc: '2.0', id: 7, method: `made.up.${'y'.repeat(5000)}`, params: { note: 'pearfan' } });
    await until(() => log.filter((m) => m.dir === 'in').length === 2, 'both logged');
    const before = log.filter((m) => m.dir === 'in');
    assert.deepEqual(
      before.map((m) => [m.kind, m.method, 'data' in m, 'id' in m]),
      [
        ['event', null, false, false],
        ['request', null, false, false],
      ],
      'what it is and its size, no method name, id or data',
    );
    assert.ok(before[0].bytes > 50_000);
    r.close();

    log.length = 0;
    const r2 = await raw(paths.socketPath(PD.slug, place));
    await rawHello(r2);
    await until(() => log.some((m) => m.dir === 'out' && m.method === 'link.subscribe'), 'connected');
    const players = (n) => ({ ...structuredClone(PLAYERS), seq: n, at: new Date().toISOString() });
    r2.send({ jsonrpc: '2.0', method: 'players.changed', params: players(1) });
    const big = players(2);
    big.platforms.kick = { ...big.platforms.kick, open: Array.from({ length: 600 }, (_, i) => ({ platform: 'kick', slug: `pixelpear${i}` })) };
    r2.send({ jsonrpc: '2.0', method: 'players.changed', params: big });
    await until(() => log.filter((m) => m.method === 'players.changed').length === 2, 'both events');
    const [small, large] = log.filter((m) => m.method === 'players.changed');
    assert.deepEqual(small.data.platforms, PLAYERS.platforms, 'a normal one has its data');
    assert.ok(!('truncated' in small));
    assert.ok(large.bytes > LOG_DATA_MAX && !('data' in large) && large.truncated === true, 'a big one: truncated, no data');
    r2.close();
  }),
);

test(
  'while finishing the proofs, a flood from the other end closes the connection, and no key is kept',
  withPlace(async ({ place }, track) => {
    paths.ensureDir(place);
    // A stand-in that answers to Stream Multiview's socket, says hello properly, then floods instead of answering the proof.
    const server = net.createServer((socket) => {
      const reader = new LineReader(
        (m) => {
          if (m.method === 'link.auth') {
            for (let i = 0; i <= QUEUE_MAX; i++) socket.write(encode({ jsonrpc: '2.0', method: 'players.changed', params: {} }));
            return;
          }
          if (m.method !== 'link.hello') return;
          const key = hs.newKey();
          socket.write(
            encode({
              jsonrpc: '2.0',
              id: m.id,
              result: {
                protocol: 1,
                app: MV,
                capabilities: { players: { provides: ['1.0'] }, 'drops.farming': { uses: ['1.0'] } },
                agreed: { players: '1', 'drops.farming': '1' },
                auth: { proof: hs.proof(key, 'server', m.params.auth.nonce), nonce: hs.nonce(), key },
              },
            }),
          );
        },
        () => {},
      );
      socket.on('data', (d) => reader.push(d));
      socket.on('error', () => {});
      server.closed = once(socket, 'close');
    });
    const sock = paths.socketPath(MV.slug, place);
    await new Promise((res) => server.listen(sock, res));
    const keys = memoryKeyStore();
    const { pd } = pair(place, { pd: { keys, timing: { ...FAST, rateMax: 10_000, handshakeMs: 3000 } } });
    track(pd);
    try {
      await pd.start();
      await until(() => server.closed, 'a connection');
      const started = Date.now();
      await server.closed;
      assert.ok(Date.now() - started < 1500, 'closed by the flood, not the 3 s deadline');
      assert.equal(keys.get(MV.id), null, 'not paired');
      assert.equal(pd.isConnected(MV.id), false);
    } finally {
      await new Promise((res) => server.close(res));
    }
  }),
);

test(
  'the activity log: what a raw client sends, kept to the rules (nothing for a line that is not JSON, a reply to nothing, and what the limit drops)',
  withPlace(async ({ place }, track) => {
    const { pd } = pair(place, { pd: { timing: { ...FAST, rateMax: 5, strikes: 5, pingMs: 60_000 } } });
    track(pd);
    const log = [];
    pd.on('message', (m) => log.push(m));
    await pd.start();
    const sock = paths.socketPath(PD.slug, place);

    const junk = await raw(sock);
    junk.send('this is not json\n');
    await junk.next();
    junk.send('{"jsonrpc":"2.0"}\n'); // JSON, but neither a request, a reply nor an event
    await junk.next();
    assert.deepEqual(
      log.map((m) => [m.dir, m.kind, m.method, m.id]),
      [
        ['out', 'error', null, null],
        ['out', 'error', null, null],
      ],
      'only the replies: nothing for what it sent',
    );
    assert.ok(
      log.every((m) => !('data' in m) && !('ms' in m)),
      "before the hello, a reply to nothing known could be the hello's: no data",
    );
    junk.close();

    log.length = 0;
    const r = await raw(sock);
    await rawHello(r);
    await until(() => log.some((m) => m.dir === 'out' && m.method === 'link.subscribe'), 'its own subscribe');
    assert.deepEqual(
      log.filter((m) => m.method?.startsWith('link.')).map((m) => [m.dir, m.kind, m.method, m.app]),
      [
        ['in', 'request', 'link.hello', null],
        ['out', 'reply', 'link.hello', MV.id],
        ['in', 'request', 'link.auth', MV.id],
        ['out', 'reply', 'link.auth', MV.id],
        ['out', 'request', 'link.subscribe', MV.id],
      ],
    );
    // Once connected, a reply to nothing has its data, but no method or ms.
    const line = { jsonrpc: '2.0', id: 'nope', result: { channel: 'pixelpear' } };
    r.send(line);
    const stray = await until(() => log.find((m) => m.id === 'nope'), 'the stray reply');
    assert.deepEqual(stray, {
      at: stray.at,
      app: MV.id,
      dir: 'in',
      kind: 'reply',
      method: null,
      id: 'nope',
      bytes: wire(line),
      data: { channel: 'pixelpear' },
    });

    // Over the limit: not logged (nor kept), only the "slow down" each one gets.
    await sleep(1050);
    log.length = 0;
    for (let i = 0; i < 8; i++) r.send({ jsonrpc: '2.0', id: 100 + i, method: 'link.ping', params: {} });
    await until(() => log.filter((m) => m.dir === 'out').length === 8, 'eight answers');
    assert.equal(log.filter((m) => m.dir === 'in' && m.method === 'link.ping').length, 5, 'the five within the limit');
    const slowDown = log.filter((m) => m.kind === 'error');
    assert.equal(slowDown.length, 3);
    assert.ok(slowDown.every((m) => m.method === null && m.data.code === CODES.TOO_MANY && !('ms' in m)));
  }),
);

test(
  'the activity log costs nothing when no one listens, and forgets requests that are never answered',
  withPlace(async ({ place }, track) => {
    const { Connection } = require('../src/connection');
    const report = Connection.prototype.report;
    let built = 0;
    Connection.prototype.report = function (...args) {
      built += 1;
      return report.apply(this, args);
    };
    try {
      const { pd, mv } = pair(place);
      track(pd, mv);
      await pd.start();
      await mv.start();
      await once(mv, 'connected');
      pd.publish('drops.farming.changed', FARMING);
      await once(mv, 'event');
      await mv.request(PD.id, 'drops.farming.get');
      assert.equal(built, 0, 'no entries built');
      const conn = pd.conns.get(MV.id);
      assert.equal(conn.inflight.out.size + conn.inflight.in.size, 0, 'no requests kept');

      const log = [];
      const listen = (m) => log.push(m);
      mv.on('message', listen);
      await mv.request(PD.id, 'drops.farming.get');
      assert.ok(built > 0 && log.length === 2, 'built once someone listens');
      mv.off('message', listen);
      built = 0;
      await mv.request(PD.id, 'drops.farming.get');
      assert.equal(built, 0, 'and not after they stop');

      // Requests that never get a reply are forgotten after the request timeout, and past a cap.
      const map = new Map();
      conn.remember(map, 1, 'link.ping', 0);
      conn.remember(map, 2, 'link.ping', 5000);
      conn.remember(map, 3, 'link.ping', 20_000);
      assert.deepEqual([...map.keys()], [3], 'older than the request timeout');
      for (let i = 0; i < 1005; i++) conn.remember(map, `r${i}`, 'link.ping', 20_000);
      assert.equal(map.size, 1000, 'at most a thousand');
      assert.ok(!map.has(3) && map.has('r1004'));
      conn.remember(map, 'r1004', 'link.ping', 20_001); // a reused id moves to the end
      assert.equal([...map.keys()].at(-1), 'r1004');
    } finally {
      Connection.prototype.report = report;
    }
  }),
);

test(
  "a short /tmp folder (the shared folder's paths too long) goes with the last app in it, and an app starting as it goes makes it again",
  { skip: process.platform === 'win32' && 'named pipes, no folder' },
  withPlace(async ({ dir }, track) => {
    const place = { env: { GRAPEVINE_DIR: path.join(dir, 'a-very-long-folder-name-'.repeat(4)) } };
    const short = paths.socketDir(place);
    assert.notEqual(short, paths.linkDir(place), 'its paths are too long for the folder itself');
    try {
      const { pd, mv } = pair(place);
      track(pd, mv);
      await pd.start();
      await mv.start();
      await once(mv, 'connected');
      await pd.stop();
      assert.ok(fs.existsSync(short), "Multiview's socket keeps it");
      await mv.stop();
      assert.ok(!fs.existsSync(short), 'gone with the last one');
      // the folder removed between start()'s making it and listening in it
      const make = paths.ensureDir;
      let first = true;
      paths.ensureDir = (p) => {
        make(p);
        if (first) ((first = false), fs.rmdirSync(paths.socketDir(p)));
      };
      try {
        await pd.start();
      } finally {
        paths.ensureDir = make;
      }
      assert.ok(fs.existsSync(paths.socketPath(PD.slug, place)), 'listening, in the folder made again');
      await pd.stop();
    } finally {
      fs.rmSync(short, { recursive: true, force: true });
    }
  }),
);
