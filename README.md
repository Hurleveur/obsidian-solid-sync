# Solid Pod Sync

Syncs a [Solid](https://solidproject.org/) pod container with a vault folder, as
ordinary markdown notes — so search, backlinks, graph and Bases all work on them.

Built on the official `obsidian-sample-plugin` scaffold. No runtime dependencies:
DPoP authentication uses WebCrypto, and RDF is read as JSON-LD through the pod's own
content negotiation, so no `@inrupt/*` client and no RDF parser are bundled.

## Setup

1. **Settings → Solid Pod Sync**, set the container URL (`https://pod.example.eu/you/`)
   and the vault folder.
2. Public pods work immediately, read-only. For your own pod, select **Log in** and
   enter your pod account email and password. This mints a client-credentials token
   through the pod's account API; the password is used once and never stored.
3. Run **Sync now** from the command palette, or select the ribbon icon.

## When it syncs

| Trigger | Default |
| --- | --- |
| **Sync now** — ribbon icon, command palette, or the settings button | Always available |
| Right after a successful login | Always |
| **Sync on startup** — on plugin load, not periodic | Off |
| **Sync after changes** — about 10 seconds after you add, edit, rename or delete a file in the folder, once a burst of edits settles | Off |

There is no polling. Pod-side changes arrive on the next sync, so leave **Sync after changes** on if you edit from more than one place.

## How it works

- `.md` resources sync both ways, byte for byte, with no injected frontmatter.
- Attachments — images, PDFs, HTML, audio, video, anything else with an extension —
  sync both ways as bytes, keeping their own filename, so `![[picture.png]]` in a note
  resolves on every machine. Anything over the size limit — 10 MB by default,
  settable, 0 to disable — is reported as skipped and left untouched on both sides,
  never mistaken for a deletion.
- Other text resources (turtle, JSON-LD, plain text) are pulled read-only into a note
  with the source fenced and `solid-url` in the properties. Local edits to those are
  never pushed.
- Resources without an extension become `<name>.md` notes — a pod's own `README` is
  stored exactly this way.

## Sync rules

Change detection compares each side against the state recorded at the last sync, so
no clock comparison between machines is needed. Assumes one editor at a time.

| Situation | Result |
| --- | --- |
| Changed on pod only | Pulled |
| Changed locally only | Pushed |
| Changed on both | Nothing is overwritten. The pod version is saved as `note (pod conflict …).md` beside yours — same for attachments, keeping their extension; edit your copy to resolve |
| Deleted on pod | Local note moved to trash, recoverable |
| Deleted locally | Pod copy kept, unless **Delete on pod** is enabled |
| Many notes missing at once | All pod deletions refused — a renamed or unmounted folder cannot empty your pod |

## Sharing it

A plugin is two files in `<vault>/.obsidian/plugins/solid-sync/`: `main.js` and
`manifest.json`. Nothing else is needed at runtime — this one adds no CSS.

- **Send it to one person**: `npm run build`, then share those files. They drop the
  folder into their vault and enable it under **Settings → Community plugins**.
- **Install from GitHub**: push this repo, create a release whose tag exactly matches
  the `version` in `manifest.json` (no leading `v`), and attach `main.js` and
  `manifest.json` as individual assets. Others install it with
  [BRAT](https://github.com/TfTHacker/obsidian42-brat) by entering the repo name — no
  review process, and BRAT keeps it updated.
- **Inside a shared vault repo**: commit the code files — never `data.json`,
  which holds the token — and add the plugin
  id to `community-plugins.json` so it arrives enabled. Vaults usually gitignore
  `.obsidian/` wholesale; a bootstrap folder like `.obsidian_template` and a
  script that copies code files while leaving each person's `data.json` alone is
  cleaner than punching exceptions into the ignore rules.
- **Community plugin store**: submit a pull request to
  [obsidian-releases](https://github.com/obsidianmd/obsidian-releases). Reviewed by the
  Obsidian team; `npm run lint` covers most of what they check.

**Publishing to the store is the intent**, once a person has read the code
end to end. It writes to a pod and deletes notes, so it should not go out to
strangers on a machine review alone. Worth settling before submitting:

- The `fetch` warnings under [Notes](#notes) — reviewers ask why `requestUrl`
  is not used, so the answer belongs in the PR.
- The **Log in** flow is Community Solid Server specific. Other servers need
  credentials pasted by hand, which the settings UI should say plainly.
- Sync behaviour under a second editor. The single-editor assumption holds for
  a private pod and is stated, but a store listing reaches people who will
  ignore it.

## Credentials

**Log in** exchanges your pod account password, once, for a client-credentials
token. The password is never stored. The token is, in the plugin's `data.json`
inside `.obsidian/` — in plain text.

That is deliberate, and it is what every Obsidian plugin does: there is no
secret storage API in Obsidian, on desktop or mobile. Obfuscating the token
would only hide it from a casual reader, since the key doing the hiding would
ship in `main.js` beside it.

What actually reduces exposure, and is done instead:

- **The token never enters a repo.** `.obsidian/` is conventionally gitignored,
  and this plugin is distributed without a `data.json`, so nothing to leak.
- **It is a token, not your password**, scoped to one pod account and revocable
  from that account's page without changing anything else.
- **Deleting on the pod is off by default**, so a leaked token that is not
  noticed immediately still cannot destroy pod content through this plugin.

### Why not the OS keychain

Electron exposes `safeStorage`, which would encrypt the token against the
system keyring, and some plugins reach for it through `require('electron')`.
Not here, for three reasons:

1. **It is not Obsidian API.** Reaching into Electron internals is unsupported,
   breaks without warning on an Obsidian upgrade, and would fail review for the
   community plugin store.
2. **It is desktop-only.** There is no `safeStorage` on mobile, so the mobile
   build would need the plaintext path anyway — two code paths, one of which is
   still the plaintext one.
3. **It defends a narrow case.** The keyring is unlocked by your own login
   session, so anything running as you can still read the token. It helps only
   against an offline copy of the vault — a stolen disk, or a backup. Treat
   `data.json` the way you treat `~/.ssh/id_ed25519` and that case is covered by
   full-disk encryption, which is a better fix than an app-level one.

If the vault does end up somewhere it should not, revoke the token from the pod
account page. That is a stronger guarantee than any local encryption.

## Tests

Run against a real pod. Read-only, any public pod:

```bash
npm run build
npx esbuild test/entry.ts --bundle --format=esm --platform=node \
  --outfile=test/sync.bundle.mjs --alias:obsidian=./test/obsidian-stub.mjs
POD_URL=https://pod.example.eu/someone/ node test/public.mjs
```

Full read/write suite — creates and deletes `e2e-*` resources, so use a scratch pod:

```bash
POD_URL=… POD_ID=… POD_SECRET=… node test/e2e.mjs
```

Trigger rules, no network needed:

```bash
node test/trigger.mjs
```

## Notes

- Uses `fetch` rather than Obsidian's `requestUrl`, which the linter warns about.
  Pods send `Access-Control-Allow-Origin: app://obsidian.md`, so CORS is not an
  obstacle, and DPoP proofs need per-request control that `requestUrl` does not give.
- Tested against Community Solid Server. The account API used for **Log in** is
  CSS-specific; other servers need their credentials pasted in by hand.
