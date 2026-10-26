'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileKeyStore, memoryKeyStore } = require('../src/keys');
const { KNOWN_APPS, isInstalled, iconDataUrl, byId, bySlug } = require('../src/known-apps');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gv-keys-')), 'sub', 'grapevine.json');

test('keys in a file: kept between launches, private, and removed when asked', () => {
  const file = tmpFile();
  const a = fileKeyStore(file);
  assert.equal(a.get('x'), null);
  a.set('x', 'S0VZ');
  assert.equal(a.get('x').key, 'S0VZ');
  assert.match(a.get('x').pairedAt, /^\d{4}-/);
  assert.equal(fileKeyStore(file).get('x').key, 'S0VZ', 'read back by the next launch');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  a.delete('nobody'); // nothing to do
  a.delete('x');
  assert.equal(fileKeyStore(file).get('x'), null);
  assert.equal(a.encrypted, false);
});

test('with encrypt and decrypt, a key is never stored as it is; one that can’t be decrypted counts as unpaired', () => {
  const file = tmpFile();
  const crypt = { encrypt: (t) => Buffer.from(t).toString('hex'), decrypt: (t) => Buffer.from(t, 'hex').toString() };
  const s = fileKeyStore(file, crypt);
  assert.equal(s.encrypted, true);
  s.set('x', 'secret');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('secret'));
  assert.equal(s.get('x').key, 'secret');
  const broken = fileKeyStore(file, {
    encrypt: crypt.encrypt,
    decrypt: () => {
      throw new Error('another keychain');
    },
  });
  assert.equal(broken.get('x'), null);
  fs.writeFileSync(file, 'not json');
  assert.equal(fileKeyStore(file).get('x'), null, 'a broken file is as good as empty');
});

test('with an async encrypt and decrypt (Electron’s encryptStringAsync), keys are read back once ready, and never stored as they are', async () => {
  const file = tmpFile();
  const crypt = { encrypt: async (t) => Buffer.from(t).toString('hex'), decrypt: async (t) => Buffer.from(t, 'hex').toString() };
  const s = fileKeyStore(file, crypt);
  assert.equal(s.encrypted, true);
  s.set('x', 'secret');
  assert.equal(s.get('x').key, 'secret', 'at once, before it is encrypted');
  assert.ok(!fs.existsSync(file), 'not written before it is encrypted');
  await new Promise((r) => setImmediate(r));
  assert.ok(!fs.readFileSync(file, 'utf8').includes('secret'));
  const next = fileKeyStore(file, crypt);
  assert.equal(next.get('x'), null, 'not until it is decrypted');
  await next.ready;
  assert.equal(next.get('x').key, 'secret', 'read back by the next launch');
  const broken = fileKeyStore(file, { encrypt: crypt.encrypt, decrypt: async () => Promise.reject(new Error('another keychain')) });
  await broken.ready;
  assert.equal(broken.get('x'), null, 'one that can’t be decrypted counts as unpaired');
  const failing = fileKeyStore(file, { encrypt: async () => Promise.reject(new Error('no keychain')), decrypt: crypt.decrypt });
  await failing.ready;
  failing.set('y', 'other');
  await new Promise((r) => setImmediate(r));
  assert.equal(failing.get('y').key, 'other', 'one that can’t be encrypted is kept for this run');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('other'), 'and never written');
});

test('a key paired again or removed while the saved ones are decrypting isn’t brought back', async () => {
  const file = tmpFile();
  const hex = (t) => Buffer.from(t).toString('hex');
  fileKeyStore(file, { encrypt: hex, decrypt: (t) => Buffer.from(t, 'hex').toString() }).set('x', 'old');
  fileKeyStore(file, { encrypt: hex, decrypt: (t) => Buffer.from(t, 'hex').toString() }).set('y', 'gone');
  const opening = [];
  const s = fileKeyStore(file, { encrypt: async (t) => hex(t), decrypt: (t) => new Promise((r) => opening.push(() => r(Buffer.from(t, 'hex').toString()))) });
  s.set('x', 'new');
  s.delete('y');
  for (const open of opening) open();
  await s.ready;
  assert.equal(s.get('x').key, 'new');
  assert.equal(s.get('y'), null);
});

test('keys in memory', () => {
  const m = memoryKeyStore();
  m.set('a', 'k');
  assert.equal(m.get('a').key, 'k');
  m.delete('a');
  assert.equal(m.get('a'), null);
});

test('known apps: each has what its card needs, and whether it is installed comes from its data folder', () => {
  for (const app of KNOWN_APPS) {
    for (const k of ['id', 'slug', 'name', 'summary', 'icon', 'homepage', 'download', 'dataFolder']) assert.ok(app[k], `${app.name}: ${k}`);
    for (const cap of [...app.provides, ...app.uses])
      assert.ok(require('../src/schema').Schemas.load().capabilityOf(`${cap}.x`) === cap, `${app.name}: ${cap} has a schema`);
    assert.ok(fs.existsSync(app.icon), `${app.name}: its logo is bundled`);
    assert.match(iconDataUrl(app.icon), /^data:image\/png;base64,iVBOR/);
  }
  assert.equal(byId('com.streamorchard.peardrops').slug, 'pear-drops');
  assert.equal(bySlug('stream-multiview').name, 'Stream Multiview');
  assert.equal(byId('nope'), null);
  assert.equal(bySlug('nope'), null);
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-appdata-'));
  assert.equal(isInstalled(KNOWN_APPS[0], appData), false);
  fs.mkdirSync(path.join(appData, KNOWN_APPS[0].dataFolder));
  assert.equal(isInstalled(KNOWN_APPS[0], appData), true);
});
