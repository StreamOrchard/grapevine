// Where an app keeps its pairing keys: one small file in its own data folder, private to the user,
// encrypted with the app's own encrypt/decrypt (Electron's safeStorage) when it has them.
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * @typedef {object} KeyStore
 * @property {boolean} [encrypted] whether keys are encrypted at rest
 * @property {Promise<void>} [ready] settles once every saved key is decrypted (start() waits for it)
 * @property {(id: string) => {key: string, pairedAt?: string} | null} get
 * @property {(id: string, key: string) => void} set
 * @property {(id: string) => void} delete
 */

/**
 * @param {any} v
 * @returns {v is PromiseLike<string>}
 */
function isPromise(v) {
  return typeof v?.then === 'function';
}

/**
 * @param {string} file e.g. <userData>/grapevine.json
 * @param {{encrypt?: (text: string) => string | Promise<string>, decrypt?: (stored: string) => string | Promise<string>}} [crypt]
 *   encrypt returns text to store (base64, say) and decrypt reverses it, either at once or as a
 *   promise (Electron's encryptStringAsync and decryptStringAsync). Without them, keys are stored as they are.
 * @returns {KeyStore}
 */
function fileKeyStore(file, { encrypt, decrypt } = {}) {
  /** @type {Record<string, {key?: string, pairedAt: string, encrypted?: boolean}>} */
  let peers = {};
  try {
    peers = JSON.parse(fs.readFileSync(file, 'utf8')).peers ?? {};
  } catch {}
  const crypt = !!(encrypt && decrypt);
  /** Each encrypted key as it is, once decrypted. One that can't be decrypted isn't here. */
  const plain = new Map();

  // A key still being encrypted isn't written until it is: never as it is.
  const save = () => {
    const kept = Object.fromEntries(Object.entries(peers).filter(([, p]) => p.key !== undefined));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ peers: kept }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file); // all at once: a crash never leaves half a file
  };

  // Decrypt the saved keys up front, so get() can answer at once. A key paired again (or removed)
  // meanwhile isn't overwritten by the old one.
  const opening = Object.entries(peers)
    .filter(([, p]) => p.encrypted && crypt)
    .map(([id, p]) => {
      const keep = (key) => peers[id] === p && plain.set(id, key);
      try {
        const out = decrypt(p.key);
        if (!isPromise(out)) return keep(out);
        return out.then(keep, () => {}); // can't decrypt (another user, a new keychain): as good as not paired
      } catch {}
    });
  const ready = Promise.all(opening).then(() => {});

  return {
    /** Whether keys are encrypted at rest, for the card to say so if not. */
    encrypted: crypt,
    ready,
    get(id) {
      const p = peers[id];
      if (!p) return null;
      if (!p.encrypted && p.key !== undefined) return { key: p.key, pairedAt: p.pairedAt };
      return plain.has(id) ? { key: plain.get(id), pairedAt: p.pairedAt } : null;
    },
    set(id, key) {
      const pairedAt = new Date().toISOString();
      if (!crypt) {
        peers[id] = { key, pairedAt };
        return save();
      }
      /** @type {{key?: string, pairedAt: string, encrypted: true}} */
      const p = { pairedAt, encrypted: true };
      peers[id] = p;
      plain.set(id, key);
      const stored = (text) => {
        if (peers[id] !== p) return; // paired again, or removed, since
        p.key = text;
        save();
      };
      const out = encrypt(key);
      if (isPromise(out))
        out.then(stored, () => {}); // can't encrypt: kept for this run only
      else stored(out);
    },
    delete(id) {
      if (!(id in peers)) return;
      delete peers[id];
      plain.delete(id);
      save();
    },
  };
}

/** Keys kept in memory only: for tests and the stand-in peer. @returns {KeyStore} */
function memoryKeyStore() {
  const peers = new Map();
  return {
    encrypted: false,
    get: (id) => peers.get(id) ?? null,
    set: (id, key) => void peers.set(id, { key, pairedAt: new Date().toISOString() }),
    delete: (id) => void peers.delete(id),
  };
}

module.exports = { fileKeyStore, memoryKeyStore };
