<p align="center"><img src=".github/assets/hero.svg" alt="Grapevine: lets your desktop apps find each other and talk, privately, right on your computer. Pear Drops tells Stream Multiview it's farming, and Stream Multiview signs its Kick players out and says so" width="100%"></p>

# Grapevine

Lets desktop apps on the same computer find each other and talk to each other directly. Nothing goes online, and there's no account or server.

It's how [**Pear Drops**](https://github.com/StreamOrchard/pear-drops) tells [**Stream Multiview**](https://github.com/GlowingPear/stream-window-multiview) when it's farming drops, so multiview's Kick players sign out and leave the drop credit to Pear Drops. Any app that installs it can join in.

[![Tests](https://github.com/StreamOrchard/grapevine/actions/workflows/test.yml/badge.svg)](https://github.com/StreamOrchard/grapevine/actions/workflows/test.yml) [![npm](https://img.shields.io/npm/v/@streamorchard/grapevine?color=4cf56a)](https://www.npmjs.com/package/@streamorchard/grapevine) ![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey) ![License](https://img.shields.io/badge/license-GPL--3.0-blue)

https://github.com/user-attachments/assets/1bedcc05-8f5e-4a8b-8b31-21494aff8df9

---

## What it does

- **Finds apps.** Each app listens on a socket in one private folder (a named pipe on Windows), so apps see each other as they start and stop.
- **Connects safely.** Two apps pair the first time you switch the link on in both, and after that prove it's them every time. Web pages, other computers and unpaired programs can't connect.
- **Talks.** Apps send each other events ("farming PixelPear now") and answer requests, as [JSON-RPC 2.0](https://www.jsonrpc.org/specification). Every message is checked against its schema.
- **Copes with updates.** Each feature is a versioned _capability_. Apps agree the newest version both support, and when one is out of date, they say which one to update.
- **Recovers.** If an app quits or crashes, the other knows at once, and they reconnect when it's back.

It has no dependencies, needs nothing from Electron, and runs on Windows, macOS and Linux with Node 22 or later. [`PROTOCOL.md`](PROTOCOL.md) has the whole protocol.

## Install

```sh
npm install @streamorchard/grapevine
```

## Use it

Say what your app speaks in its `package.json`. It's the one place it's written, and every release tag keeps it, which is how `grapevine-check` knows what each release shipped (see [Recording releases](#recording-releases)):

```json
"grapevine": { "app": "com.streamorchard.peardrops", "provides": { "drops.farming": "1.0" }, "uses": { "players": "1.0" } }
```

```js
const { app, safeStorage } = require('electron');
const path = require('path');
const { createLink, fileKeyStore } = require('@streamorchard/grapevine');
const { grapevine } = require('./package.json');

const link = createLink({
  app: {
    id: 'com.streamorchard.peardrops', // your app's install id
    slug: 'pear-drops', // its socket name
    name: 'Pear Drops',
    version: app.getVersion(),
    icon: path.join(__dirname, 'icon.png'),
  },
  provides: grapevine.provides, // what it tells other apps
  uses: grapevine.uses, // what it listens to
  allowed: (appId) => settings.connectedApps[appId]?.enabled === true, // your Connected apps switches
  // Pairing keys, encrypted with the system keychain. encrypt and decrypt may return promises:
  // start() waits for the saved keys to be decrypted.
  keys: fileKeyStore(path.join(app.getPath('userData'), 'grapevine.json'), {
    encrypt: async (t) => (await safeStorage.encryptStringAsync(t)).toString('base64'),
    decrypt: async (t) => (await safeStorage.decryptStringAsync(Buffer.from(t, 'base64'))).result,
  }),
  appDataDir: app.getPath('appData'), // to show "Not installed" for apps that aren't
  confirmPairing: true, // a first pairing waits for your user's Allow on the card (see below)
});

await link.start();

// Tell every app that subscribed. seq and at are added for you, and the last one also answers
// drops.farming.get. Everything past progress is optional: it's what a widget would show.
link.publish('drops.farming.changed', {
  state: 'farming',
  account: { platform: 'kick', user: 'pearfan' },
  channel: { platform: 'kick', slug: 'pixelpear', name: 'PixelPear', avatar: 'https://files.kick.com/…/pixelpear.webp' },
  stream: { title: 'Neon Rush ranked, chill vibes', viewers: 1240 },
  drop: {
    campaign: 'Neon Rush Launch Week',
    category: 'Neon Rush',
    progress: { done: 48, total: 120, unit: 'minutes' },
    image: 'https://files.kick.com/…/neon-rush.webp',
    endsAt: '2026-10-21T18:00:00Z',
    rewards: {
      claimed: 1,
      total: 3,
      items: [
        { name: 'Pear Badge', required: 30, state: 'claimed' },
        { name: 'Hype Rocket Emote', required: 60, state: 'locked', unlocksAt: '2026-10-18T09:24:00Z' },
        { name: 'Neon Crown', required: 120, state: 'locked', unlocksAt: '2026-10-18T10:24:00Z' },
      ],
    },
    next: { name: 'Hype Rocket Emote', required: 60, unlocksAt: '2026-10-18T09:24:00Z' },
    doneAt: '2026-10-18T10:24:00Z',
  },
});

// A click on another app's widget asks to see Pear Drops.
link.handle('drops.farming.show', () => {
  mainWindow.show();
  return { shown: true };
});

// Hear what the other apps provide.
link.on('event', (fromAppId, name, params) => {
  if (name === 'players.changed') console.log(params.platforms.kick?.signedIn);
});

// Ask one of them something.
const players = await link.request('com.glowingpear.streammultiview', 'players.get');

// On the other side, an app showing a farming widget (Stream Multiview, say):
//   link.on('event', (from, name, f) => name === 'drops.farming.changed' && drawWidget(f));
//   widget.onclick = () => link.request('com.streamorchard.peardrops', 'drops.farming.show');

// When a Connected apps switch changes:
link.refresh();

// When the app quits:
await link.stop();
```

Editors suggest every event's fields and underline mistakes, in plain JavaScript too. The types come from the schemas.

### A Connected apps page

`link.peers()` lists every known app with what its card needs, and `link.on('change', …)` says when to draw it again.

| Field                                 |                                                                                                                  |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `name`, `summary`, `icon`, `download` | The app's logo (bundled, so it shows even when it isn't installed), one line about it, and where to get it       |
| `installed`                           | Whether its data folder exists (with `appDataDir`)                                                               |
| `enabled`                             | Your switch for it                                                                                               |
| `status`                              | `off`, `waiting`, `connected`, `pair-again`, `incompatible`, or `confirm` (it asks to pair: show **Allow**)      |
| `reason`                              | Why it's waiting: `switched-off` (its own switch is off), `disconnected-there`, `confirm-there` (Allow it there) |
| `asking`                              | For `confirm`: `{ name, version }`, as the asking app says in its hello                                          |
| `keyHeldBy`                           | For `pair-again`: `us` means show **Pair again** here, `them` means it's pressed in the other app                |
| `version`, `report.text`              | While connected: its version, and "Works" or what's missing ("update Pear Drops to 0.1.7 or later")              |
| `pairedAt`, `keysEncrypted`           | When they paired, and whether keys are stored encrypted                                                          |
| `formerIds`                           | Ids the app had before a rename                                                                                  |
| `shares`                              | What the two apps share: `{ out, in }`, capabilities this app provides that it uses, and the other way round     |

Three calls go with buttons on the card:

- **Test:** `await link.test(appId)`. Connected, it's a round trip, `{ ok: true, ms, version, text }`, with `text` like "Stream Multiview 0.4.0 answered in 3 ms". Otherwise it tries straight away, from this side too, and says why it couldn't: `{ ok: false, reason, text }`. `reason` is one of:
  - `not-running`: "Stream Multiview isn't open"
  - `switched-off`: its Connect switch is off
  - `off`: this app's is
  - `pair-again`: with where to press it
  - `incompatible`: which app to update
  - `confirm`: it asks to pair, press Allow here; `confirm-there`: press Allow in that app
  - `no-answer`, `not-started`, `unknown`
- **Disconnect:** `link.disconnect(appId)`. Turn your own switch for that app off too.
- **Pair again:** `link.pairAgain(appId)`.
- **Allow**, with `confirmPairing`: `link.allowPairing(appId)`. A first pairing (or one after Pair again) only happens once the user allows it: until then the card's `status` is `confirm`, with `asking` saying who asks, and the other app's card says `confirm-there`. Allow lasts two minutes; Pair again counts as one. The connecting app tries again within 30 seconds. Without `confirmPairing`, the first app to answer to that id pairs, while your switch is on (see "Security" in `PROTOCOL.md`).

### An activity log

`link.on('message', …)` hears every message your app sends to or receives from another app, the hello included, so a page can show what goes between them. Nothing is worked out for it until something listens.

| Field       |                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `at`        | When it was sent or received (`Date.now()`)                                                                      |
| `app`       | The other app's id, as your app knows it. `null` until its hello arrives (when the other app connected to yours) |
| `dir`       | `out` (sent) or `in` (received)                                                                                  |
| `kind`      | `request`, `reply`, `error` (a reply with an error) or `event`                                                   |
| `method`    | The method. For a reply or error, the method of the request it answers (`null` if that isn't known)              |
| `id`        | The JSON-RPC id, for requests, replies and errors                                                                |
| `ms`        | Replies and errors: how long since the request. Received, the round trip; sent, how long your app took to answer |
| `bytes`     | Its size on the wire                                                                                             |
| `data`      | The params of a request or event, the result of a reply, or `{ code, message }` of an error                      |
| `truncated` | `true` when the message was over 16 KB: its `data` is left out                                                   |

`link.hello` and `link.auth` and their replies have no `data`: they carry the nonces, proofs and pairing keys. Nor does anything received before the other app has proved the pairing: anything could be on the other end then, so it's only what kind of message it is and its size (the method is named only for `link.hello`, `link.auth`, `link.bye` and `link.ping`). Messages over the limit (50 a second) aren't in the log at all.

```js
link.on('message', (m) => {
  // "in  event drops.farming.changed from com.streamorchard.peardrops (1290 bytes)"
  // "out reply players.get to com.streamorchard.peardrops in 2 ms"
  const time = m.ms === undefined ? '' : ` in ${m.ms} ms`;
  activity.push(`${m.dir.padEnd(3)} ${m.kind} ${m.method ?? '?'} ${m.dir === 'in' ? 'from' : 'to'} ${m.app ?? 'an app'}${time} (${m.bytes} bytes)`);
});
```

### In your app's tests

A stand-in plays the other app, at any version, so your tests don't need it installed:

```js
const { standInPeer } = require('@streamorchard/grapevine/stand-in-peer');
const peer = await standInPeer({ as: 'com.glowingpear.streammultiview', dir: testDir, uses: { 'drops.farming': '1.0' } });
peer.link.on('event', (from, name, params) => {
  /* … */
});
```

Give your app the same `GRAPEVINE_DIR` (or `place: { env: { GRAPEVINE_DIR: testDir } }`), so tests never touch the real folder.

As a process of its own, for launch tests, it prints a JSON line for everything that happens and takes commands on stdin:

```js
// The installed copy, by its path: never `npx grapevine-stand-in`, which would fetch a package of
// that name from npm if Grapevine weren't installed.
const child = spawn(process.execPath, [
  require.resolve('@streamorchard/grapevine/stand-in-peer'),
  '--as',
  'com.glowingpear.streammultiview',
  '--dir',
  testDir,
  '--uses',
  'drops.farming@1.0',
  '--provides',
  'players@1.0',
]);
```

Example messages for every capability version, good and bad, are in `@streamorchard/grapevine/fixtures`. Check that what your app sends passes them.

## Capabilities

| Capability          | Provided by      | What it says                                                                                                                                                                       |
| ------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `drops.farming` 1.0 | Pear Drops       | Whether it's farming: the channel, stream and drop, with pictures and every reward's state and when it unlocks, enough for a widget. Also `show`, to bring Pear Drops to the front |
| `rewards.daily` 1.0 | Pear Drops       | A daily reward's progress: earning (minutes of the hour), ready, or claimed, and when it resets. Also `show`, to bring Pear Drops forward with it open                             |
| `players` 1.0       | Stream Multiview | Its players by site: signed in or not, and which channels are open                                                                                                                 |

To add one:

1. Write `schemas/<name>/1.json`, with an example of each event in `fixtures/<name>/1/`, good and bad.
2. Run `npm run types`.

To change one, follow [the version rules](PROTOCOL.md#versions): additions are a minor version, anything else a new major alongside the old one.

## Adding an app

Add it to `src/known-apps.js` with:

- its id and slug
- a one-line summary
- a 256×256 logo in `assets/apps/`
- its download page and its data folder's name
- the capabilities it `provides` and `uses`

Every app that updates Grapevine then shows it on its Connected apps page, with what the two would share. `link.peers()` gives that as `shares`, from this list until they meet and from the hello after.

When it ships a release that uses Grapevine, record it (next section).

## Recording releases

Once an app ships a capability version, Grapevine records it. From then on that version can't change in place, and other apps can say which release to update to.

Give the app a script for it, in its `package.json`:

```json
"scripts": { "grapevine:check": "grapevine-check" }
```

Then, in the app's repo, at the start of every change:

```sh
npm run grapevine:check
```

Use the script, not `npx grapevine-check`: in a checkout where Grapevine isn't installed yet, `npx` would fetch and run whatever package on npm has that name. `npm run` only uses what's installed.

- **It reads** the `grapevine` field from each of the app's release tags (`v*`), and Grapevine's record from GitHub (the installed copy if it's offline, or with `--offline`).
- **It lists** any capability version a release shipped that isn't recorded yet, with the command to record it, e.g. `npm run released -- com.streamorchard.peardrops 0.1.6 drops.farming@1.0 players@1.0`.
- **That command runs in a Grapevine checkout** (its `app-shipped` skill), followed by a pull request and a patch release.
- **`--strict`** exits 1 while something is unrecorded, for CI.

## Renaming an app

If your app's id changes, list the old one: `createLink({ app: { id: 'com.new.id', formerIds: ['com.old.id'], … } })`. Apps paired with it carry on without pairing again. Then add the new id to `src/known-apps.js`, with the old one in its `formerIds`.

When another app was renamed, `link.currentId(oldId)` gives its new id, so you can move your own settings across (its Connect switch, say). [`PROTOCOL.md`](PROTOCOL.md#renaming-an-app) has the details.

## Developing

```sh
npm test               # every test, real sockets included
npm run test:coverage  # with the coverage minimums
npm run lint           # ESLint and Prettier
npm run format         # fix what lint can
npm run types          # types/capabilities.d.ts from the schemas
npm run check          # the types are up to date, and tsc finds no type errors
npm run released -- <app id> <version>   # an app shipped a release using Grapevine (see Adding an app)
```

CI runs the tests on Windows, macOS and Linux, again on Node 22 (the oldest supported, and the one in Electron 38), and lint, types and coverage on Linux.

Dependabot opens weekly pull requests for the dev dependencies and the GitHub Actions (`.github/dependabot.yml`; all the Actions ones together, in one). Patch and minor updates, and new major versions of Actions, merge themselves once the required checks pass (`.github/workflows/dependabot-automerge.yml`); other majors wait for review.

**Releasing:**

1. In a pull request, change `version` in `package.json` and add a section to `CHANGELOG.md`.
2. Once it's merged, publish a GitHub release tagged `v<version>`.
3. The **Publish** workflow tests it and publishes it to npm, with provenance. No npm token is stored anywhere.

## License

[GPL-3.0](LICENSE). Apps that use Grapevine must be GPL-compatible.
