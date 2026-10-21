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

1. **Settings → Solid Pod Sync → Log in**, at the top. Enter your server
   (`https://pod.example.eu`), email and password. This mints a client-credentials
   token through the server's account API; the password is used once and never
   stored. If your account has several pods, pick yours: the token acts as that pod's
   WebID.
2. The login then offers what to sync, and **Start syncing** sets it up:
   - your pod, at a folder of this vault (`team/<your short name>` when your team
     lists you, otherwise `team/<the pod's name>`). The folder is only where the notes are kept
     in Obsidian; nothing on the pod changes.
   - your team, when your profile names one, with every member listed — see
     [Team roster](#team-roster).

   **Not now** keeps you logged in with nothing added.
3. After that, **Sync now** from the command palette or the ribbon icon.
4. **Add pod** adds any other pod you can read: first the vault folder, then the
   pod's address (`https://pod.example.eu/you/`). Public pods need no login, read-only.
   `/` as the folder is the whole vault — see
   [The whole vault as one pod](#the-whole-vault-as-one-pod), and set **Ignore**
   first if you go that way. Give each pod its own folder — the same folder twice is
   refused, because a note in two pods' folders would be pushed to the wrong one.
   Filing one pod's folder *inside* another's is fine — see
   [A pod inside a pod's folder](#a-pod-inside-a-pods-folder).
5. Removing a pod keeps its notes and forgets its sync history, so pointing a new pod
   at that folder later starts clean. Notes belonging to a pod filed inside it are
   left alone.

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

### The whole vault as one pod

Enter `/` as the folder and the pod mirrors the vault itself rather than a folder in
it. Everything above still holds: a pod filed at `Solid/` keeps its own notes, and
the root pod stops at that boundary like any other. The row says so as you type it,
and warns while nothing is ignored yet — `/` is the one entry that reads like a
folder name and means the whole vault.

Do set **Ignore** before doing this. A vault usually contains a good deal that has no
business in a pod — attachments, exports, a plugin's scratch folder — and at the root
all of it is in scope at once.

The vault's own dot-folders are never in scope, whatever the ignore list says. That
is where Obsidian keeps its configuration, this plugin's `data.json` among it, and
your pod credentials are in that file.

### Ignoring files

**Settings → Solid Pod Sync → Ignore** takes one pattern per line, in the shape
`.gitignore` uses:

| Pattern | Matches |
| --- | --- |
| `Attachments/` | a folder of that name and everything in it, wherever it sits |
| `*.png` | that kind of file, at any depth |
| `Notes/Media/` | that one place, counted from the vault root |
| `# a note to yourself` | nothing; a line starting with `#` is a comment |

A pattern containing a slash names a path from the vault root. One without names a
file or folder wherever it turns up. Matching ignores case. `!` negation, `**` and
escaped metacharacters are not supported.

An ignored path is not part of any pod, in both directions: never uploaded, never
pulled down, and never read as a note you deleted — so adding a rule deletes nothing,
on either side. The two copies simply stop being compared. Remove the rule and the
next run picks the path up again from scratch.

The box counts as you type — how many patterns are set, and how many of the files
currently in your pod folders they leave out. Whether `*.png` really catches your
attachments is worth knowing before the sync rather than from its summary afterwards.

The list applies to every pod. Ignored files are counted in the summary rather than
listed under **Status**: a rule doing its job is not something to act on, and at the
vault root there can be thousands of them.

## When it syncs

| Trigger | Default |
| --- | --- |
| **Sync now** — ribbon icon, command palette, or the settings button | Always available |
| Right after a successful login | Always |
| **Sync on startup** — on plugin load, not periodic | Off |
| **Sync after changes** — about 10 seconds after you add, edit, rename or delete a file in any synced folder, once a burst of edits settles. Sends only your changes (see below) | Off |

A sync you start and the startup sync are full: every folder of every pod is listed, and
changes flow both ways. A sync after changes is scoped. It sends what changed in the vault
since it last synced (edits, new files, deletions), and lists only the folders those files
sit in, so an edit costs a request or two rather than a listing of every pod. A note someone
else edited on the pod in the meantime is still filed as a conflict, never overwritten. An
edit that could not be sent, offline for instance, is sent by the next one.

There is no polling, and a scoped sync pulls nothing, so pod-side changes arrive on the next
full sync: at startup, or when you select **Sync now**.

A sync you start (ribbon, command, **Sync now**) shows a notice while it works, then its
counts. An automatic run shows its outcome only when it differs from the last one shown, so
an offline vault reports the failure once rather than after every edit. Conflicts always show.

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
| Changed on both, but the pod still holds what was last synced | Pushed. Only the pod's timestamp moved — each file's state keeps a hash of the bytes last sent or received, so a stale timestamp (a cached listing, most often) is never read as someone else's edit |
| Changed on both, different bytes | Nothing is overwritten. The pod version is saved as `note (pod conflict …).md` beside yours — same for attachments, keeping their extension; edit your copy to resolve |
| Deleted on pod | Local note moved to trash, recoverable |
| Deleted locally | Pod copy kept, unless **Delete on pod** is enabled. It is not pulled again — see **Restore deleted notes** below |
| Many notes missing at once | All pod deletions refused — a renamed or unmounted folder cannot empty your pod. Counted per pod, so adding pods never weakens the guard |
| Pod refuses the write | Reported as skipped with the status the pod gave (`PUT refused: 403`), that pod's copy left alone, the run carries on. `no write access per pod root` instead means the pod root said you may only read, so nothing was sent |
| A folder cannot be listed | A dropped network, a 403 from a tightened ACL or a server error all look like an empty folder. Everything under it is frozen for the run instead — nothing pulled, pushed, trashed or deleted — and the folder is reported with the reason (`listing failed: 403`, `listing failed: network error: …`). The next run that can list it carries on normally. The pod root failing freezes the whole folder |
| Vault refuses the name | A pod name is not a vault name — `:` and `?` are ordinary in a URL and illegal in an Obsidian file name. That one resource is reported as skipped and retried on the next run; every other resource in the container syncs normally |
| Pod pointed at another container | The folder's sync history named the old container, so it is forgotten and the new one is pulled in full. Files the old container left and you never touched are its copies: replaced where the new container has that name, moved to trash where it does not. Anything you edited is yours and is kept |
| Matches an ignore pattern | Left alone on both sides — not pushed, not pulled, not deleted, not read as missing. Counted in the summary rather than listed as skipped |

### Why a file was skipped

Every summary ends in a count of files the run left alone, and the count on its own
never says which or why. **Settings → Solid Pod Sync → Status** lists them under the
count, one line per file: no read access, over the size limit, a local edit the pod
refused, a name another resource already took, a name the vault itself will not
accept. A healthy run skips nothing and the list is not shown.

Every resource a run does not sync is named there, bar the ones an ignore rule
excluded — those are your own instruction, and the summary carries their count. A
line naming a *folder* or a container URL rather than a file is the other exception:
that pod, or that container inside it, could not be listed, and every note under it
was left exactly as it was on both sides.

### Restore deleted notes

Deleting a note or attachment locally is remembered, so it is not pulled back on the
next sync — otherwise a deletion could never stick with **Delete on pod** off. The
cost is that it can never come back either, and every run keeps reporting it as
skipped.

**Settings → Solid Pod Sync → Restore deleted notes → Restore** forgets those
deletions and syncs, pulling back everything the pods still have. It touches nothing
that is already in the vault, and nothing on the pods.

## Sync log

Without git, nothing says who changed a shared note. So after each sync, the plugin
appends one line for every note this device uploaded or deleted on the pod to
`_sync-log/<name>.md` inside the synced folder, then uploads that file:

```
- 2026-10-19T16:40:12Z pushed projects/kanban.md
- 2026-10-19T16:40:12Z deleted old/draft.md
```

`<name>` is the first part of your WebID's path (`https://pod.example/alex/profile/card#me`
gives `alex.md`), so each person writes only their own file. Pulls are not logged — they
are someone else's push, already in that person's file. The log is not counted in the
sync summary and does not itself trigger a sync.

It is on by default; turn it off with **Keep a sync log** in the settings. A pod you
cannot write gets no log. If the log cannot be written or uploaded, the run still
finishes and the problem shows in the skip list.

It only records what this plugin did. Changes made by other apps straight to the pod
are not logged, and there is no undo: the log says what happened, it does not keep the
old text.

## Local history

A bad sync (a pull over text you wanted, a deletion pushed by mistake, a pod wiped)
needs something to put back. So before the plugin overwrites or deletes a file, in
your vault or on a pod, it stores the bytes it is about to replace:

```
.obsidian/plugins/solid-sync/history/
  blobs/<sha256>   the contents, once per distinct content
  journal.jsonl    one line per event
```

The first run with history on also stores every note (`.md`) already in a synced
folder (`baseline`). Attachments are left out of it — they are most of the bytes and
rarely edited — and stored only once one is about to be overwritten or deleted.
Nothing is compressed or pruned. A line looks like this, with `action` one of `baseline`, `pushed`,
`pulled`, `deleted-local`, `deleted-pod` or `conflict`:

```
{"at":"2026-10-19T16:40:12.000Z","pod":"https://pod.example/alex/notes/","path":"Pod/kanban.md","action":"pulled","before":"<hash>","after":"<hash>"}
```

`before` is the hash of what was replaced, `after` of what took its place (`null` for
none). For `pushed` and `deleted-pod` those are the pod's bytes, otherwise the vault's.

It stays on this device: the folder is inside a dot-folder, which never syncs, and
nothing uploads it. If a copy cannot be written, that file is skipped and named in the
skip list, so nothing is overwritten without its backup. There is no pruning and no
restore button yet, and a large vault is stored in full once. Turn it off with **Keep
local history** in the settings.

To restore by hand, find the file's line in `journal.jsonl`, take the `before` hash,
and copy `blobs/<hash>` over the file (or upload it to the pod).

## Sharing a note

A note in your own pod can be opened to other people from its properties:

```yaml
---
share: [neil, nicolas]      # may read it
share-write: [neil]         # may read and edit it
---
```

Each name comes from the [team roster](#team-roster), or from **Team members** in the
settings, one per line, a name and that person's WebID
(`neil https://pod.example/neil/profile/card#me`). A name in both means the Team members
line. A WebID can also be written in the property itself.

The plugin applies the properties when this device uploads the note, by writing the
note's own access list (`.acl`) on the pod: you with full control, and the people
named. Removing both properties deletes that list, so the note is back to whatever its
folder allows. Notes beside it are not affected.

A **folder note** shares its whole folder instead: the note named like its folder and
inside it (`business/business.md`), as the Folder Notes plugin makes them. Everything
in the folder, including notes added later, gets the same access. The note at the top
of your pod is the exception: the plugin skips it and names it in the skip list.
Sharing the whole pod is left to your pod provider's own tools, because a mistake in
the pod's top access list locks you out of everything in it.

- **It replaces the folder's access, it does not add to it.** A note shared with Neil
  inside a folder Nicolas can read is no longer readable by Nicolas. The same holds
  one level up: a shared folder no longer follows what the folder above it allows.
- **Only your own pod.** A note in someone else's pod is skipped with a reason.
- **Only edits made on this device.** Properties that arrive in a pull were written by
  whoever could edit the note; applying them would let anyone with write access hand
  out access, which only the owner may do.
- **A name the plugin does not know stops the whole note**, rather than sharing it
  with some of the people listed.
- **If the access list was changed by something else** (another Solid app, the
  server's admin), it is left as it is and the note is named once in the skip list.
  Change the note's sharing properties again to replace it.

The properties are not rewritten from the pod: they say what was asked, not what
another app may have changed since.

## Team roster

A team that keeps its member list on a pod can have everyone's pod synced without
adding them one by one. The login offers it, with the team's name and members shown;
afterwards, the **Team sync** toggle turns it on and off. The plugin finds the list
the way [solid-backoffice](https://github.com/nicolasdb/solid-backoffice) does: your
profile names each team you belong to (`org:memberOf`), and each team's `config.ttl`
names its member list (`hs:roster`). Nothing is read or added while it is off. A team your profile does not name
can still be used by pasting its list's address into **Team roster**, for example
`https://pod.example/team/membres.ttl`; that address then replaces the search.

The list is the one solid-backoffice writes when an admin accepts someone: a
`foaf:member` line naming each person's WebID, and a `foaf:nick` line giving each a
short name. While team sync is on, every sync reads it and:

- adds each member's pod as a row synced at `team/<short name>`, unless a row already
  syncs that pod;
- adds the team's shared pod at `projects`, and a second team's at
  `projects/<team name>`. The shared pod is the one `config.ttl` names with
  `hs:vault`; without one, the `vault/` folder beside `config.ttl`, if you can read it;
- lets `share:` and `share-write:` name members by their short name;
- removes a row it added once the list stops naming that person. Their notes stay in
  the vault; only the syncing stops.

Rows you added by hand are never changed, and a row the plugin added can be edited
like any other. What each pod lets you read or write is still up to that pod: being
on the list grants nothing.

Your own pod is on the list too, so a vault where you have only logged in gets a
row for it at `team/<your short name>` as well. Turning the toggle off removes the
rows it added; their notes stay, and rows you added by hand are kept.

The list is usually readable by members only. When it, your profile or a team's
`config.ttl` cannot be read (offline, or you have not been accepted yet), the last
rows stay as they were and the skip list says so. Removing a team from your profile
is leaving it here: its rows stop syncing on the next run.

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

The write suites need a pod to throw away, and a local
[Community Solid Server](https://github.com/CommunitySolidServer/CommunitySolidServer)
is the cheapest one. It is worth using a real server rather than a stub: the plugin
has already been caught out once by how a real one publishes media types, which no
hand-written fixture would have said.

```bash
echo '[{ "email": "t@example.com", "password": "testpassword", "pods": [{ "name": "first" }] }]' > seed.json
npx @solid/community-server@7 -p 3000 -c @css:config/default.json -f ./data --seedConfig seed.json
```

Credentials come from the same account API the plugin's **Log in** button uses —
`createClientCredentials('http://localhost:3000', 't@example.com', 'testpassword')`
returns the id and secret the suites want. They are minted per WebID, so one set
reaches one pod: for two containers, use two folders inside it.

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

Pointing a pod at another container without changing its vault folder — writes
`rp-*` resources into two containers, which may be two folders in one scratch pod
(client credentials are minted per WebID, so two pods usually means two identities):

```bash
POD_URL=…/rp-a/ POD_URL_2=…/rp-b/ POD_ID=… POD_SECRET=… node test/repoint.mjs
```

One resource the vault refuses, and the container behind it — writes `uw-*`
resources. Checks that a path Obsidian will not write costs that path alone, names
itself in the skip list and is retried, and that a file on disk the index has not
seen is written rather than throwing:

```bash
POD_URL=… POD_ID=… POD_SECRET=… node test/unwritable.mjs
```

New notes whose names hold URL-reserved characters (`,` `;` `&` `=` `+` `$` `@`) —
writes `nm-*` resources. Checks that each one is pushed rather than reported as
"no write access", lands under its own name, and that the next run settles:

```bash
POD_URL=… POD_ID=… POD_SECRET=… node test/names.mjs
```

A container that stops answering — writes `ur-*` resources and ACLs under them, so a
local server running WAC. Checks that a 403 folder, a network error on one container
and an unlistable root each leave every synced note in place rather than trashing it,
that the next readable run carries on, and that a refused PUT reports its status:

```bash
POD_URL=… POD_ID=… POD_SECRET=… node test/unreadable.mjs
```

Conflicts against our own uploads — writes `cf-*` resources, through a fetch that
caches like desktop Obsidian's. Checks that a listing re-read after a push is the
pod as it is now — a stale one lacked a note just pushed, which then read as deleted
and was trashed — that a listing stale anyway still writes no conflict copy, that a
real edit on the pod still conflicts, and that an edit landing mid-upload is pushed
on the next run:

```bash
POD_URL=… POD_ID=… POD_SECRET=… node test/conflict.mjs
```

Listing a pod — writes a `wk-scratch/` tree. Checks that a level's container
listings go out together, at most 8 at a time, and that the walk still returns
exactly what a one-by-one walk does, in the same order, including a container
that refuses its listing:

```bash
POD_URL=… POD_ID=… POD_SECRET=… node test/walk.mjs
```

Scoped syncs — writes an `sc-scratch/` tree. Checks that a sync after changes sends
nothing when nothing changed, lists only the edited note's folder, pulls nothing, still
files a conflict when the pod changed too, pushes into a folder the pod lacks, pushes a
deletion, sends an edit that failed offline on the next run, and leaves a synced note
whose folder 404s for a full run:

```bash
POD_URL=… POD_ID=… POD_SECRET=… node test/scoped.mjs
```

The sync log — writes `sl-*` resources. Checks that pushes and pod deletions are
appended below earlier lines, that pulls, a read-only pod, a refused log and the
off switch write nothing, and that the log neither pulls back nor starts a sync:

```bash
POD_URL=… POD_ID=… POD_SECRET=… node test/synclog.mjs
```

Sharing a note — writes `sh-*` resources and their ACLs, and needs a second account
on the same server as the guest (add it to `seed.json`). Checks that `share` and
`share-write` grant what they say to the guest and nothing beside the note, that
unsharing deletes the ACL, that an ACL changed outside the plugin is reported once and
replaced by the next edit, that an unknown name or a pulled note applies nothing, and
that a property value cannot add its own grant:

```bash
POD_URL=… POD_ID=… POD_SECRET=… GUEST_ID=… GUEST_SECRET=… node test/share.mjs
```

Team roster — writes `tm-*` resources in the first pod and rewrites the second pod's
top access list so the first account can read it, so both pods must be throwaway
(two accounts in `seed.json`). Checks that the list's members arrive at
`team/<short name>`, that a pod already in a row gets no second one, that short names
work in `share:`, that with team sync off the list is not read, that an unreadable
list keeps the rows, that a member removed
from the list stops syncing while their notes stay, and that the list is found from
the profile alone (it adds and removes an `org:memberOf` line in the first account's
profile):

```bash
POD_URL=… POD_ID=… POD_SECRET=… MEMBER_POD=… MEMBER_ID=… MEMBER_SECRET=… node test/team.mjs
```

Login — drives the login dialog against the account API with two throwaway accounts
on one password: one owning two pods (add a second pod to it in `seed.json`), one
owning one. Checks that the pod picked is the WebID the token acts as, that your pod
lands at the folder given and is not added twice, that a team listing you puts your
pod at `team/<short name>` and its shared pod at `projects`, that **Not now** adds
nothing, that the Team sync toggle adds and removes the team, and that a wrong
password mints nothing. It writes `lg-team/` in the one-pod account and adds, then
removes, an `org:memberOf` line in its profile:

```bash
SERVER=http://localhost:3000 TWO_EMAIL=… ONE_EMAIL=… PASSWORD=… node test/login.mjs
```

Local history — writes `hi-*` resources into two containers of one scratch pod. Checks
that the baseline covers every mapped note and no attachment, that a pull, a push over a pod copy, a
pushed deletion and a remote deletion each leave the replaced bytes in `blobs/`, that a
failing history write skips the path and changes neither side, and that the off switch
stores nothing:

```bash
POD_URL=… POD_ID=… POD_SECRET=… node test/history.mjs
```

Ignore rules through a whole sync, with the vault root as the folder — writes `ig-*`
resources. Checks that an ignored file is neither pushed nor pulled, that adding a
rule for a path already synced deletes nothing on either side, and that the vault's
own dot-folders stay out of the pod:

```bash
POD_URL=… POD_ID=… POD_SECRET=… node test/ignore-sync.mjs
```

Trigger rules, access parsing, settings migration, content comparison, the restore
list, ignore-pattern shapes, the vault root as a folder, what a removed pod takes
with it, the settings tab's section order and confirm dialogs, and startup scheduling one
sync rather than one per file, no network needed:

```bash
node test/trigger.mjs
node test/startup.mjs
node test/access.mjs
node test/settings-ui.mjs
node test/ignore.mjs
```

Both pods can be local. [Community Solid Server](https://github.com/CommunitySolidServer/CommunitySolidServer)
serves two accounts from one instance, and a second account's pod is read-only to
you by default — which is exactly the case worth testing.

## Notes

- Tested against Community Solid Server. The account API used for **Log in** is
  CSS-specific; other servers need their credentials pasted in by hand.
