# Solid Pod Sync

Syncs [Solid](https://solidproject.org/) pod containers with vault folders, as
ordinary markdown notes — so search, backlinks, graph and Bases all work on them.

Add as many pods as you like: your own, a shared team container, a friend's public
notes. Each gets its own vault folder, and each decides for itself what you may do
there — see [Many pods, one identity](#many-pods-one-identity).

Built on the official `obsidian-sample-plugin` scaffold. No runtime dependencies:
DPoP authentication uses WebCrypto, and RDF is read as JSON-LD through the pod's own
content negotiation, so no `@inrupt/*` client and no RDF parser are bundled.

## Install

Not in the community plugin store yet, so the easiest route is BRAT, which installs
from this repo's releases and keeps the plugin updated afterwards.

### With BRAT

[BRAT](https://github.com/TfTHacker/obsidian42-brat) installs plugins straight from
GitHub releases. It is in the store itself, so it installs normally.

1. **Settings → Community plugins → Browse**, search **BRAT**, install and enable it.
2. Command palette → **BRAT: Plugins: Add a beta plugin for testing (with or without
   version)**.
3. Paste `Hurleveur/obsidian-solid-sync` — the full `https://github.com/…` URL works
   too. Leave the version on **Latest version**, keep **Enable after installing the
   plugin** checked, and select **Add plugin**.
4. It arrives enabled under **Community plugins**. Continue with [Setup](#setup).

"Beta" is only BRAT's word for anything outside the store. It installs whatever the
release holds, and these are ordinary tagged releases, not prereleases.

Updates are not automatic unless you turn on **Auto-update plugins at startup** in
BRAT's settings. Otherwise run **BRAT: Plugins: Check for updates to all beta plugins
and UPDATE** when you want them. Choosing a specific tag in step 3 instead of
**Latest version** pins it, and auto-update deliberately skips pinned plugins.

Once this is in the store, **BRAT: Plugins: Update a graduated plugin to stable
release and remove from BRAT** hands it over without reinstalling anything.

### By hand

Download `main.js` and `manifest.json` from the
[latest release](https://github.com/Hurleveur/obsidian-solid-sync/releases/latest) —
the two files individually, not the source zip — or build them with `npm run build`.
Put both in `<vault>/.obsidian/plugins/solid-sync/`, then refresh the list under
**Settings → Community plugins** and enable **Solid Pod Sync**. There is no
`styles.css`: the plugin adds no CSS.

## Setup

1. **Settings → Solid Pod Sync → Add pod**, then set the container URL
   (`https://pod.example.eu/you/`) and the vault folder it mirrors into.
2. Public pods work immediately, read-only. For your own pod, select **Log in** and
   enter your pod account email and password. This mints a client-credentials token
   through the pod's account API; the password is used once and never stored.
3. Run **Sync now** from the command palette, or select the ribbon icon.
4. Add more pods the same way. Give each its own folder — the same folder twice is
   refused, because a note in two pods' folders would be pushed to the wrong one.
   Filing one pod's folder *inside* another's is fine — see
   [A pod inside a pod's folder](#a-pod-inside-a-pods-folder).

## Many pods, one identity

You log in **once**, to your own pod. Solid-OIDC is built for this: every other pod
resolves your WebID back to that issuer, so the same token identifies you everywhere.
There is no per-pod password to manage.

What each pod then grants you is **discovered, never configured**. The first sync
reads the `WAC-Allow` header off the container listing it already fetches, and the
settings row shows what came back:

| Row says | Meaning |
| --- | --- |
| **Read and write** | Notes sync both ways, as below |
| **Read-only** | Notes are pulled. New notes stay in the vault |
| **Access is checked on the first sync** | Not synced yet |

Servers running ACP rather than WAC send no such header. Nothing breaks: the plugin
assumes it may write, tries, and records what the pod answers.

The badge describes the **container**, which is what creating and deleting needs.
Editing an existing note needs permission on that note, and the two can differ —
sharing one note out of a container you cannot otherwise write is an ordinary Solid
setup. So an edit is always attempted on a pod you are logged in to, even a
read-only one. Being wrong costs one refused request, once per edit.

### When you cannot write

A local edit that a pod refuses is **kept, never discarded**. It is reported as
skipped once, then marked as seen so it stops appearing in every later summary. The
note simply stays yours and diverges from the pod. If someone grants you access
later, your next edit to it pushes normally — nothing is permanently marked.

If the pod copy later changes too, the ordinary conflict rule applies — the pod
version is saved beside your note, and neither is overwritten.

A pod that refuses a write, or one that is unreachable, is reported and stepped over.
It never stops the other pods in the list from syncing.

### A pod inside a pod's folder

A pod's folder may sit inside another pod's folder, so the vault can be arranged the
way you think about it — your own pod at `Solid/`, someone else's filed under it at
`Solid/nicolas/`, whatever their URLs are.

**The innermost folder owns the notes in it.** The pod above stops at that boundary:
it does not pull there, does not push what it finds there, does not delete there, and
does not count those notes as missing. Nothing crosses between two pods because they
happen to be filed one inside the other — a pod only ever holds what is really its
own, which is the point of having separate pods at all.

This applies to what the outer pod already has, too. If your own pod holds a
container that lands on the inner pod's folder, those resources are reported as
skipped and left to the pod that owns that folder, rather than mixed in underneath
it.

Only giving two pods the **same** folder is refused: with no innermost pod, neither
could own a note in it.

## When it syncs

| Trigger | Default |
| --- | --- |
| **Sync now** — ribbon icon, command palette, or the settings button | Always available |
| Right after a successful login | Always |
| **Sync on startup** — on plugin load, not periodic | Off |
| **Sync after changes** — about 10 seconds after you add, edit, rename or delete a file in any synced folder, once a burst of edits settles | Off |

There is no polling. Pod-side changes arrive on the next sync, so leave **Sync after changes** on if you edit from more than one place.

## How it works

- `.md` resources sync both ways, byte for byte, with no injected frontmatter — except
  the read-only marker below, on notes the pod refuses you.
- Attachments — images, PDFs, HTML, audio, video, anything else with an extension —
  sync both ways as bytes, keeping their own filename, so `![[picture.png]]` in a note
  resolves on every machine. Anything over the size limit — 10 MB by default,
  settable, 0 to disable — is reported as skipped and left untouched on both sides,
  never mistaken for a deletion.
- Other text resources (turtle, JSON-LD, plain text) are pulled into a note with the
  source fenced and `solid-url` in the properties. Editing the fenced text pushes it
  back as that resource's own content type — same as an ordinary note, gated on
  permission, never on what it is.
- `solid-readonly: true` appears in a note's properties when **that resource's** own
  `WAC-Allow` said you may not write it — a friend's shared note, say. It is a reading
  of the pod's answer, not a rule the plugin enforces: your own resources are never
  labelled, a server that sends no header is never labelled either, and an edit is
  attempted regardless.

  This is the **one** exception to markdown being stored byte for byte, and it applies
  only where the pod refused. One property, never a fence, so links, embeds, graph and
  Bases keep working. It goes into the note's own properties if it has them, comes off
  again the moment access is granted, and is taken back off before any push. Only what
  the pod itself holds is compared between the two sides, so the label appearing or
  disappearing never reads as the resource changing.
- Resources without an extension become `<name>.md` notes — a pod's own `README` is
  stored exactly this way.

## Sync rules

Change detection compares each side against the state recorded at the last sync, so
no clock comparison between machines is needed. Assumes one editor at a time.

| Situation | Result |
| --- | --- |
| Changed on pod only | Pulled |
| Changed locally only | Pushed |
| Changed on both, same bytes | Nothing. A re-save with no edit, or a pod re-serialising a resource, moves a timestamp without moving a byte — content is compared before anything is written. For a fenced resource only the fenced body counts, so a change to how the wrapper is written is never read as a change to the resource |
| Changed on both, different bytes | Nothing is overwritten. The pod version is saved as `note (pod conflict …).md` beside yours — same for attachments, keeping their extension; edit your copy to resolve |
| Deleted on pod | Local note moved to trash, recoverable |
| Deleted locally | Pod copy kept, unless **Delete on pod** is enabled. It is not pulled again — see **Restore deleted notes** below |
| Many notes missing at once | All pod deletions refused — a renamed or unmounted folder cannot empty your pod. Counted per pod, so adding pods never weakens the guard |
| Pod refuses the write | Reported as skipped, that pod's copy left alone, the run carries on |
| Pod pointed at another container | The folder's sync history named the old container, so it is forgotten. The new container is pulled in full, rather than its resources being read as notes you deleted and your notes as ones it deleted |

### Why a file was skipped

Every summary ends in a count of files the run left alone, and the count on its own
never says which or why. **Settings → Solid Pod Sync → Status** lists them under the
count, one line per file: no read access, over the size limit, a local edit the pod
refused, a name another resource already took. A healthy run skips nothing and the
list is not shown.

### Restore deleted notes

Deleting a note or attachment locally is remembered, so it is not pulled back on the
next sync — otherwise a deletion could never stick with **Delete on pod** off. The
cost is that it can never come back either, and every run keeps reporting it as
skipped.

**Settings → Solid Pod Sync → Restore deleted notes → Restore** forgets those
deletions and syncs, pulling back everything the pods still have. It touches nothing
that is already in the vault, and nothing on the pods.

## Sharing it

A plugin is two files in `<vault>/.obsidian/plugins/solid-sync/`: `main.js` and
`manifest.json`. Nothing else is needed at runtime — this one adds no CSS.

- **Send it to one person**: `npm run build`, then share those files. They drop the
  folder into their vault and enable it under **Settings → Community plugins**.
- **Cut a release**: `npm version <x.y.z>`, then tag it with that exact version — no
  leading `v`, matching `manifest.json` — and attach `main.js` and `manifest.json` as
  individual assets, not a zip. That is all [BRAT](#with-brat) reads; a release
  missing `main.js` is refused with the release named in the error. No review process.
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
  from that account's page without changing anything else. It identifies you to
  every pod in the list, but grants nothing beyond what each of those pods had
  already granted your WebID.
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

Full read/write suite — creates and deletes `e2e-*` resources, so use a scratch pod.
Set `POD_URL_2` to any pod you cannot write to, and the suite also checks that a
read-only pod and a writable one sync in the same run:

```bash
POD_URL=… POD_ID=… POD_SECRET=… POD_URL_2=… node test/e2e.mjs
```

Conflict and restore rules — writes `rc-*` resources, same scratch pod. Checks that
matching bytes on both sides write no conflict copy, that differing bytes still do,
and that a locally deleted file stays deleted until its state entry is dropped:

```bash
POD_URL=… POD_ID=… POD_SECRET=… node test/restore.mjs
```

Trigger rules, access parsing, settings migration, content comparison and the
restore list, no network needed:

```bash
node test/trigger.mjs
node test/access.mjs
```

Both pods can be local. [Community Solid Server](https://github.com/CommunitySolidServer/CommunitySolidServer)
serves two accounts from one instance, and a second account's pod is read-only to
you by default — which is exactly the case worth testing.

## Notes

- Tested against Community Solid Server. The account API used for **Log in** is
  CSS-specific; other servers need their credentials pasted in by hand.
