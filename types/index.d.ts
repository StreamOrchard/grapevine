// The types of what an app calls. The message types come from the schemas (capabilities.d.ts).
import { EventEmitter } from 'events';
import type { Events, Methods } from './capabilities';

export * from './capabilities';

/** Which events and methods there are, and what they hold, comes from the schemas. */
export type EventName = keyof Events;
export type MethodName = keyof Methods;
/** An event's own fields: `seq` and `at` are added by publish(). */
export type EventData<E extends EventName> = Omit<Events[E], 'seq' | 'at'>;

export interface AppInfo {
  /** The app's install id, like com.example.app */
  id: string;
  /** Ids it had before a rename (up to 10), so apps paired with it then still know it. Sent as [] until then. */
  formerIds?: string[];
  /** Its socket name: a-z, 0-9 and dashes */
  slug: string;
  name: string;
  version: string;
  summary?: string;
  /** A PNG data URL, or the path of a PNG file */
  icon?: string;
  homepage?: string;
  download?: string;
}

export interface KeyStore {
  /** Whether keys are encrypted at rest */
  encrypted?: boolean;
  /** Settles once every saved key is decrypted (start() waits for it) */
  ready?: Promise<void>;
  get(appId: string): { key: string; pairedAt?: string } | null;
  set(appId: string, key: string): void;
  delete(appId: string): void;
}

export interface Place {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  uid?: number;
}

export interface Timing {
  handshakeMs: number;
  pingMs: number;
  pongMs: number;
  rateMax: number;
  strikes: number;
  pollMs: number;
  backoffMs: number[];
}

export interface KnownApp {
  id: string;
  /** Ids it had before a rename */
  formerIds: string[];
  slug: string;
  name: string;
  summary: string;
  /** A bundled 256×256 PNG */
  icon: string;
  homepage: string;
  download: string;
  /** Its folder in the OS's app data folder */
  dataFolder: string;
  /** The capabilities it provides and uses (names), so a card can say what linking would do */
  provides: string[];
  uses: string[];
  /** "capability@major.minor" (or "protocol@N") -> the app version that first had it */
  firstRelease: Record<string, string>;
}

export interface LinkOptions {
  app: AppInfo;
  /** Capabilities this app provides, e.g. { 'drops.farming': '1.0' } */
  provides?: Record<string, string | string[]>;
  /** Capabilities this app uses, e.g. { players: '1.0' } */
  uses?: Record<string, string | string[]>;
  /** Whether its Connected apps switch for that app is on */
  allowed: (appId: string) => boolean;
  /** Where pairing keys are kept: fileKeyStore() (in memory if left out) */
  keys?: KeyStore;
  /** The OS's app data folder, to tell whether known apps are installed */
  appDataDir?: string;
  place?: Place;
  schemaDirs?: string[];
  knownApps?: KnownApp[];
  timing?: Partial<Timing>;
  /** Throw on a message that doesn't fit its schema (default: when NODE_ENV is "test") */
  strict?: boolean;
  /** A first pairing (or one after Pair again) waits for the user's Allow: allowPairing() */
  confirmPairing?: boolean;
  log?: (level: 'info' | 'warn' | 'error', text: string) => void;
}

export interface Report {
  state: 'works' | 'limited' | 'incompatible';
  missing: { capability: string; update: { app: string; appId: string; version: string | null } }[];
  update?: { app: string; appId: string; version: string | null };
  /** One line for the card, e.g. "Works, with a feature missing: update Pear Drops to 0.1.7 or later" */
  text: string;
}

export interface Peer {
  /** The id this app knows it by */
  id: string;
  formerIds: string[];
  name: string;
  summary: string;
  /** Path of its bundled logo */
  icon: string;
  homepage: string;
  download: string;
  /** Whether it looks installed; null without appDataDir */
  installed: boolean | null;
  /** Whether this app's switch for it is on */
  enabled: boolean;
  /** 'confirm': it asks to pair, and waits for Allow (confirmPairing) */
  status: 'off' | 'waiting' | 'connected' | 'pair-again' | 'incompatible' | 'confirm';
  /** e.g. 'switched-off' (its own switch is off), 'disconnected-there', 'confirm-there' (Allow it in that app) */
  reason: string | null;
  /** For 'confirm': who asks, as its hello says */
  asking: { name: string; version: string } | null;
  /** For 'pair-again': which app holds the old key, so where to press Pair again */
  keyHeldBy: 'us' | 'them' | null;
  /** Its version, while connected */
  version: string | null;
  report: Report | null;
  /** What the two apps share: `out`, capabilities this app provides that it uses; `in`, ones it provides that this app uses */
  shares: { out: string[]; in: string[] };
  pairedAt: string | null;
  keysEncrypted: boolean;
}

export type TestResult =
  | { ok: true; ms: number; version: string; text: string }
  | {
      ok: false;
      reason: 'unknown' | 'off' | 'not-started' | 'not-running' | 'switched-off' | 'pair-again' | 'incompatible' | 'confirm' | 'confirm-there' | 'no-answer';
      /** In words, for the card: "Stream Multiview isn't open" */
      text: string;
    };

/** One message sent to or received from another app, for an activity log (the link's 'message' event). */
export interface Message {
  /** Date.now() when it was sent or received */
  at: number;
  /** The other app's id as this app knows it; null while not yet known (before its hello arrives) */
  app: string | null;
  dir: 'out' | 'in';
  /** 'error' is a reply with an error; 'event' a notification */
  kind: 'request' | 'reply' | 'error' | 'event';
  /** The method; for a reply or error, the method of the request it answers, or null if unknown */
  method: string | null;
  /** The JSON-RPC id, for requests, replies and errors */
  id?: string | number | null;
  /** Replies and errors: ms since the request (in: the round trip; out: how long this app took to answer) */
  ms?: number;
  /** Its size on the wire, newline included */
  bytes: number;
  /**
   * The params (request, event), the result (reply), or `{ code, message }` (error). Left out for
   * link.hello and link.auth and their replies: they carry nonces, proofs and pairing keys. Also left out
   * for anything received before the other app has proved the pairing, and when over 16 KB (truncated).
   */
  data?: unknown;
  /** The message was over 16 KB: its data is left out */
  truncated?: boolean;
}

export interface CallContext {
  appId: string;
  app: AppInfo;
  major: number;
}

export declare class Link extends EventEmitter {
  constructor(opts: LinkOptions);
  /** Listens for other apps and starts looking for them. */
  start(): Promise<void>;
  /** Says goodbye to every app and stops listening. */
  stop(): Promise<void>;
  /** Call after a Connected apps switch changes. */
  refresh(): void;
  /** Tells every subscribed app something changed; returns the params as sent. */
  publish<E extends EventName>(event: E, data: EventData<E>): Events[E];
  publish(event: string, data: Record<string, unknown>): Record<string, unknown>;
  /** Answers a method of a capability this app provides. */
  handle<M extends MethodName>(method: M, fn: (params: Methods[M]['params'], ctx: CallContext) => Methods[M]['result'] | Promise<Methods[M]['result']>): void;
  handle(method: string, fn: (params: any, ctx: CallContext) => unknown): void;
  /** Asks a connected app something. */
  request<M extends MethodName>(appId: string, method: M, params?: Methods[M]['params'], opts?: { timeout?: number }): Promise<Methods[M]['result']>;
  request(appId: string, method: string, params?: Record<string, unknown>, opts?: { timeout?: number }): Promise<unknown>;
  /** Disconnect on a card: both apps forget the pairing. Switch this app's own setting off too. */
  disconnect(appId: string): Promise<void>;
  /** Pair again on a card: forgets this app's old key (and allows a new pairing, with confirmPairing). */
  pairAgain(appId: string): void;
  /** Allow on a card (confirmPairing): a new pairing with that app may happen in the next two minutes. */
  allowPairing(appId: string): void;
  isConnected(appId: string): boolean;
  /** Test on a card: checks the link now, and says how it went. Tries straight away when not connected. */
  test(appId: string, opts?: { timeout?: number }): Promise<TestResult>;
  /** Its current id, given any id it has had: for moving your own settings across after another app is renamed. */
  currentId(appId: string): string;
  /** Every known app, for the Connected apps page. */
  peers(): Peer[];

  on(event: 'event', listener: <E extends EventName>(from: string, name: E, params: Events[E]) => void): this;
  on(event: 'connected', listener: (appId: string) => void): this;
  on(event: 'disconnected', listener: (appId: string, reason: string) => void): this;
  on(event: 'unpaired', listener: (appId: string) => void): this;
  on(event: 'change', listener: () => void): this;
  on(event: 'log', listener: (level: 'info' | 'warn' | 'error', text: string) => void): this;
  /** Every message sent or received, for an activity log. Only built while something listens. */
  on(event: 'message', listener: (m: Message) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
}

export declare function createLink(opts: LinkOptions): Link;

export declare class GrapevineError extends Error {
  constructor(code: number, message: string, data?: unknown);
  code: number;
  data: unknown;
  toJSON(): { code: number; message: string; data?: unknown };
}

export declare const CODES: Readonly<{
  PARSE_ERROR: -32700;
  INVALID_REQUEST: -32600;
  METHOD_NOT_FOUND: -32601;
  INVALID_PARAMS: -32602;
  INTERNAL_ERROR: -32603;
  NOT_PAIRED: -32001;
  NOT_AGREED: -32002;
  UNSUPPORTED: -32003;
  TOO_MANY: -32004;
  SWITCHED_OFF: -32005;
  CLOSED: -32099;
  TIMEOUT: -32098;
}>;

export declare const PROTOCOL: { min: number; max: number };
export declare const KNOWN_APPS: KnownApp[];

/** What a key store's decrypt gives: the key, or the key and whether to encrypt it again (the system's key changed) */
export type Opened = string | { text: string; reEncrypt?: boolean };

/** Keys in a small file in the app's data folder, encrypted with encrypt/decrypt (e.g. Electron's safeStorage) when given, at once or as a promise. */
export declare function fileKeyStore(
  file: string,
  crypt?: { encrypt?: (text: string) => string | Promise<string>; decrypt?: (stored: string) => Opened | Promise<Opened> },
): KeyStore;
export declare function memoryKeyStore(): KeyStore;
export declare function isInstalled(app: KnownApp, appDataDir: string): boolean;
export declare function iconDataUrl(file: string): string;

export declare const paths: {
  linkDir(place?: Place): string;
  socketDir(place?: Place): string;
  socketPath(slug: string, place?: Place): string;
  listSlugs(place?: Place): string[];
};
