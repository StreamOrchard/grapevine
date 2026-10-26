# What's new in Grapevine

## 0.11.0 (current)
- `fileKeyStore` takes an `encrypt` and `decrypt` that return promises, such as Electron's `safeStorage.encryptStringAsync` and `decryptStringAsync` (its synchronous methods are deprecated in Electron 45). Saved keys are decrypted up front, `link.start()` waits for them (`keys.ready`), and a key is only written once encrypted. Synchronous ones work as before, and keys saved with them still decrypt.

## 0.10.2
- Records that Stream Multiview 0.3.13 shipped `rewards.daily@1.0`: Stream Multiview's first release with it is 0.3.13, for "update Stream Multiview to 0.3.13 or later".

## 0.10.1
- Records that Pear Drops 0.1.12 shipped `rewards.daily@1.0`: that version can't change in place now, and Pear Drops' first release with it is 0.1.12, for "update Pear Drops to 0.1.12 or later".

## 0.10.0
- A new capability, `rewards.daily` 1.0: a daily reward's progress (earning, with minutes of the hour; ready; claimed; and when it resets), and `rewards.daily.show` to bring the app that tracks it to the front with it open. Claiming stays in that app. Pear Drops provides it, for Kick's Daily Reward, and Stream Multiview uses it for a toolbar chest.

## 0.9.1
- The GitHub org is now StreamOrchard (it was Stream-Orchard): the package's repository, homepage and issues links, Pear Drops' links in the known apps, and the record `grapevine-check` compares against all use the new name. Nothing apps send changes.

## 0.9.0
- `confirmPairing`, an opt-in option: a first pairing waits until the user presses Allow (`link.allowPairing(appId)`, for two minutes; Pair again counts as Allow). Until then the card's status is `confirm`, with who is asking, and the other app's card says to allow it there (`confirm-there`). Off by default; older apps just retry.
- The activity log (`link.on('message')`) shows nothing from inside a message until the other app has proven the pairing (only its kind and size, and the `link.*` handshake's names), leaves out data over 16 KB (`truncated: true`), and skips what the rate limit drops. At most 100 messages wait while the proof finishes.
- Windows: pipe names include a random secret only this user can read, so another user of the computer can't work one out and take it first. Apps also answer on, and look for, the older name, so copies with an older Grapevine still find them.
- macOS and Linux: a link isn't taken for the socket folder.

## 0.8.1
- Records that Stream Multiview 0.3.11 shipped `drops.farming@1.0` and `players@1.0`: those versions can't change in place now, and Stream Multiview's first release with them is 0.3.11, for "update Stream Multiview to 0.3.11 or later".

## 0.8.0
- `link.on('message', …)`, for an activity log: every message your app sends to or receives from another app, the hello included. Each one says when, which app, sent or received, whether it's a request, reply, error or event, its method, its size, and for a reply how long the answer took. Requests, replies and events include what they carry; an error only its code and message; the hello and the pairing proofs nothing, since they hold the pairing keys. Nothing is worked out for it unless the app listens.

## 0.7.3
- Records that Pear Drops 0.1.6 shipped `drops.farming@1.0` and `players@1.0`: those versions can't change in place now, and Pear Drops' first release with them is 0.1.6, for "update Pear Drops to 0.1.6 or later".

## 0.7.2
- The README starts the stand-in for launch tests from the installed package by its path, not with `npx`, which could fetch a package of that name.

## 0.7.1
- The docs run the check as an app's npm script (`npm run grapevine:check`), never `npx grapevine-check`, which would fetch a package of that name from npm when Grapevine isn't installed.

## 0.7.0
- `link.test(appId)`, for a Test button on a Connected apps card. Connected, a round trip and how long it took; otherwise it tries straight away, from either side, and says in words why it couldn't (not open, switched off there or here, the pairing doesn't match, which app to update, no answer).

## 0.6.0
- `npx grapevine-check`, run in an app's repo, lists the capability versions its releases have shipped that Grapevine hasn't recorded yet, with the command that records them. Apps declare what they speak in their `package.json`'s `grapevine` field.
- `npm run released` takes the versions a release declared, so it records what that release shipped.

## 0.5.1
- If an app's socket goes while its link is starting (its folder removed, say), `start()` fails with the error rather than throwing one the app can't catch.

## 0.5.0
- Each known app lists the capabilities it provides and uses, and `peers()` says what two apps share (`shares`), so an app's Connected apps page can describe any app without code of its own.
- `npm run released` records an app release that uses Grapevine: those capability versions can't change in place after that, and `firstRelease` fills in from it.
- The docs are checked against the schemas, and the repo has skills for changes, capabilities, pull requests, releases and recording an app's release.

## 0.4.0
- `drops.farming`'s `drop.rewards` can list every reward of the drop, with its picture, the minutes it unlocks at, whether it's claimed, ready or locked, and when a locked one should unlock. Enough for a widget to draw the reward track.

## 0.3.0
- `drops.farming` carries enough for another app to show it, in a top-bar widget say: the channel's picture, the stream's title and viewers, and the drop's picture, end, rewards claimed, the next reward and when it unlocks. All of them are optional.
- `drops.farming.show` asks the drops app to bring its window to the front.

## 0.2.0
- An app can be renamed: its hello lists the ids it had before (`formerIds`, `[]` until then), and apps paired with it carry on without pairing again. `link.currentId()` gives an app's new id from an old one.
- Of two apps, the one whose slug sorts first connects (it was the id), so a rename never changes which one connects.

## 0.1.1
- Published from GitHub with provenance: npm shows the commit and workflow that built it. The code is the same as 0.1.0.

## 0.1.0
- The first release: apps find each other through a private folder (named pipes on Windows), pair once with your OK in both, and trade versioned, schema-checked JSON-RPC messages.
- `drops.farming` 1.0 (Pear Drops) and `players` 1.0 (Stream Multiview).
- A Connected apps list with each app's logo, summary, download page, status and what's missing.
- A stand-in peer and example messages, for apps' own tests.
