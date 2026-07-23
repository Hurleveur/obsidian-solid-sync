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
| **Sync after changes** — about 10 seconds after you add, edit, rename or delete a note in the folder, once a burst of edits settles | Off |

There is no polling. Pod-side changes arrive on the next sync, so leave **Sync after changes** on if you edit from more than one place.

## How it works

- `.md` resources sync both ways, byte for byte, with no injected frontmatter.
- Other text resources (turtle, JSON-LD, plain text) are pulled read-only into a note
  with the source fenced and `solid-url` in the properties. Local edits to those are
  never pushed. Binary resources are skipped.
- Resources without a `.md` extension still become `<name>.md` notes — a pod's own
  `README` is stored exactly this way.

## Sync rules

Change detection compares each side against the state recorded at the last sync, so
no clock comparison between machines is needed. Assumes one editor at a time.

| Situation | Result |
| --- | --- |
| Changed on pod only | Pulled |
| Changed locally only | Pushed |
| Changed on both | Nothing is overwritten. The pod version is saved as `note (pod conflict …).md` beside yours; edit your note to resolve |
| Deleted on pod | Local note moved to trash, recoverable |
| Deleted locally | Pod copy kept, unless **Delete on pod** is enabled |
| Many notes missing at once | All pod deletions refused — a renamed or unmounted folder cannot empty your pod |

## Sharing it

A plugin is three files in `<vault>/.obsidian/plugins/solid-sync/`: `main.js`,
`manifest.json`, and `styles.css`. Nothing else is needed at runtime.

- **Send it to one person**: `npm run build`, then share those files. They drop the
  folder into their vault and enable it under **Settings → Community plugins**.
- **Install from GitHub**: push this repo, create a release whose tag exactly matches
  the `version` in `manifest.json` (no leading `v`), and attach `main.js` and
  `manifest.json` as individual assets. Others install it with
  [BRAT](https://github.com/TfTHacker/obsidian42-brat) by entering the repo name — no
  review process, and BRAT keeps it updated.
- **Community plugin store**: submit a pull request to
  [obsidian-releases](https://github.com/obsidianmd/obsidian-releases). Reviewed by the
  Obsidian team; `npm run lint` covers most of what they check.

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
- Credentials live in the plugin's `data.json` in your vault, in plain text. Revoke a
  token from your pod account page if the vault is ever shared.
- Tested against Community Solid Server. The account API used for **Log in** is
  CSS-specific; other servers need their credentials pasted in by hand.
