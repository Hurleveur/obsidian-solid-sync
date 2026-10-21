# Team features: sync log, permissions from notes, vault preset

Written 2026-10-19. The office vault dropped git for pods, so three gaps git used to
cover now fall to this plugin. One chunk at a time, each verified before the next.

## Chunk 1 — sync log (approved)

**Why.** Without git nobody can tell who changed a shared note and when. `/aggregate`
needs that, and server-side versioning (Nicolas) is not there yet.

**What.** At the end of each pod's run, append one entry per path this device pushed
or deleted on the pod to `<pod folder>/_sync-log/<writer>.md`, then push that file in
the same run. `<writer>` is the WebID's pod name (`https://pod.example/alex/profile/card#me`
→ `alex`). One file per writer, so two people never write the same file.

Entry shape, newest last, one line each:
`- 2026-10-19T16:40:12Z pushed projects/hypercampus/kanban.md`
(`pushed` | `deleted`). Pulls are not logged: they are someone else's push, already
in that person's file.

**Constraints.**
- The log file never logs itself, and the summary counts are unchanged.
- Only on a pod we can write (`canWriteFrom`). A read-only pod gets no log.
- Appending fails → `report.skipped` line, never a thrown run (CLAUDE.md invariants).
- A setting, on by default, to turn it off.

**Files.** `src/sync.ts`, `src/settings.ts`, `test/` (new suite against a local CSS),
`README.md` (user-facing section).

**Done.** New suite passes against a local Community Solid Server and is seen failing
with the feature removed; existing suites still pass; `npm run build` and `npm run lint`
clean; README documents it.

**Gap it leaves.** Writes that bypass the plugin (Hyperscope, other Solid apps) are not
logged. No undo — that stays server-side versioning.

## Chunk 1b — local history, a backup of everything synced (approved)

**Why.** The pod log says who wrote what, not what it said. If a sync goes wrong
(a bad pull, a delete pushed by mistake, a pod wiped) there must be a copy to put back.

**What.** A local, append-only history in `.obsidian/plugins/solid-sync/history/`,
never synced to any pod:
- `blobs/<sha256>` — file contents, stored once per distinct content (the same
  sha256 the sync state already uses), so unchanged files cost nothing twice.
- `journal.jsonl` — one line per event: time, pod, vault path, action
  (`baseline` | `pushed` | `pulled` | `deleted-local` | `deleted-pod` | `conflict`),
  hash before, hash after.

**Baseline.** The first run with history on, before touching anything, stores every
file under every mapped folder and writes one `baseline` line each. After that,
any byte the sync is about to overwrite or delete, locally or on the pod, is in
`blobs/` first.

**Constraints.**
- Code lives in `src/history.ts`; `sync.ts` (past 1000 lines) only calls into it.
- Writes are atomic (temp file, then rename). A history write failing stops that
  path's overwrite or delete (`report.skipped`), never the whole run, and never
  goes ahead without its backup.
- Setting, on by default. No pruning yet (office vault baseline ≈ 130 MB).

**Files.** `src/history.ts` (new), `src/sync.ts`, `src/settings.ts`,
`test/history.mjs` (local CSS), `README.md`.

**Done.** Suite against a local CSS shows: baseline covers every mapped file; a
pull that changes a note leaves the old bytes in `blobs/`; a pushed deletion
leaves the pod's last bytes in `blobs/`; a history write failure skips that
path. Seen failing with the feature removed. Existing suites, build and lint clean.

**Gap it leaves.** No restore UI: a file comes back by copying its blob by hash
from the journal. A restore command is the next step if this gets used.

## Chunk 2 — permissions from a note's properties (approved, design pending)

**Feasible.** `pod.nicolasdb.eu` runs Community Solid Server with WAC (`.acl` per
resource, `Link: rel="acl"`). The plugin already reads `WAC-Allow`; when it reports
`control`, the plugin may write the resource's `.acl`.

**Hard part.** A resource's own `.acl` replaces the inherited one entirely. Writing one
must carry the owner's full control over, or the owner locks themselves out.

Decided 2026-10-19: `share: [nicolas, neil]` grants read, `share-write: [...]` write,
by team name resolved to a WebID through the member list (chunk 3). Notes first;
folders (folder note → container `.acl`) after. Until chunk 3's list exists, names
come from a **Team members** setting (`name WebID` per line); a WebID may also be
written directly.

Notes: built 2026-10-19 (`src/share.ts`, `test/share.mjs` against a local CSS).
Applied on push only, own pod only. Checked live 2026-10-19 with 0.6.0 on
`pod.nicolasdb.eu`: `share` naming the `claude-alex` agent let it read the note,
and removing the property refused it again; nothing skipped. Write grants were not
checked live.

Folders: built 2026-10-19. A folder note (`Folder/Folder.md`, the Folder Notes
plugin's default) shares its folder through the container's `.acl`, with
`acl:default` so later notes inherit it. Decided 2026-10-19: the pod's top folder
note is refused, since unsharing it would fall back to the server's rules, not the
owner's, and a bad write there locks the owner out of the whole pod; and a shared
folder replaces what it inherits rather than adding to it. Checked live 2026-10-19
with 0.7.0 on `pod.nicolasdb.eu`: sharing a folder note with the `claude-alex` agent
let it list the folder and read a note in it, and one added later; removing the
property refused both. The top-of-pod refusal was checked locally only.

Decided 2026-10-19: no write-back for now; the plugin warns instead, as suggested
below. The question was whether a pull writes the pod's real ACL back into the
property. The property sits in the note's text, so it already travels between
devices with the note; write-back only matters when an ACL changes outside the
plugin (another Solid app, the server's admin).
- For it: the property never lies. Without it, a note can show `share: [neil]`
  while the pod lets someone else read it, and the property is the only place
  the team looks.
- Against it: an ACL change does not change the note, so no pull notices it;
  catching one means reading every note's `.acl` on every run (≈200 extra
  requests for the office vault). Only someone with Control can read an `.acl`,
  so only the owner could write back. Rewriting a note because its ACL changed
  edits its text, which pushes it again and can collide with a real edit. An
  ACL can name WebIDs outside the member list (the `claude-alex` agent), which
  team names cannot express. And when the property and the ACL both changed,
  one must win.
- Suggested by Claude: no write-back for now. The property is the request; the
  plugin applies it when the note is pushed. Before overwriting an `.acl` it
  compares it with what it last wrote, and if someone else changed it, it leaves
  it and says so in the skipped list. A "who can read this note" command can read
  the ACL on demand later if it is missed.

**What the servers do (checked 2026-10-19).**
- Local CSS 7.2: deleting an `.acl` needs Write on its container as well as
  Control (`ParentContainerReader`, the WAC rule for deletes). An ACL that takes
  Write away can be rewritten through its own Control, but not deleted. This was
  why `unreadable.mjs` failed; fixed in `8cf4fd5`.
- The owner override, which lets a pod's owner read and rewrite any `.acl` in it
  (`OwnerPermissionReader`), depends on the server's storage-location setting.
  Under `config/default.json` (`storage/location/root.json`) only the server root
  counts as a storage, so the override finds no pod and never applies: an `.acl`
  that leaves the owner out locks the owner out of the `.acl` too. Under
  `config/file.json` (`storage/location/pod.json`) the same owner-less `.acl`
  still lets the owner read and rewrite it, and that rewrite recovers the folder.
  Both were checked locally.
- `pod.nicolasdb.eu`, live, on a throwaway `alex/acl-probe-…/` folder since deleted:
  a per-note `a.md.acl` naming the owner (Read, Write, Control) and one guest
  (Read) let the guest read `a.md` while `b.md` beside it stayed refused.
  Deleting that `.acl` removed the guest's access again, and the owner kept full
  rights throughout. The guest was the `claude-alex` agent WebID.
- 2026-09-28, same server: an `.acl` that left the owner out locked the owner out
  of the folder and of the `.acl` itself. It was still locked on 2026-10-19: a
  token for `alex/profile/card#me` got 403 on reading that `.acl`. The server root
  advertises `pim:Storage` as well as `alex/`, the way the root layout does. The
  likely cause is a root storage-location config. That is to confirm with
  Nicolas; switching to `storage/location/pod.json` would turn the override on.
  The leftover is `alex/acl-test-1790599365365/`, which only Nicolas can remove
  until then.

**Constraints this sets.**
- Every `.acl` the plugin writes names the owner with Read, Write and Control, and
  never relies on an owner override.
- Unsharing a note deletes its `.acl`, so the note inherits from its folder again.
  This works only while the owner has Write on the folder, which an owner-inclusive
  ACL guarantees.
- A note's ACL is at the URL its `Link: rel="acl"` header names (`<note>.acl` on
  CSS). Read it from the header and never build it by hand.

## Chunk 3 — vault preset handed out from a website (roster built and found from the profile, zip pending)

**Constraint.** Obsidian never downloads a missing plugin on its own: a plugin runs only
if its `main.js` and `manifest.json` sit in `.obsidian/plugins/<id>/`. "Fetch, don't
store" therefore means fetch when the zip is built, not when the vault opens.

Decided 2026-10-19: a GitHub Action builds one generic zip (config plus the plugins'
latest release files fetched at build time) and the website hands it out. Nothing
personal is in it.

The pods come after login, automatically. Solid has no "which pods may I reach"
query, so the plugin reads the team's own description of itself.

Decided 2026-10-19: the plugin reads the roster Nicolas's backoffice already keeps
(`nicolasdb/solid-backoffice`, solid-kit ADR 006) rather than a list of our own. A
`team.json` was proposed first and dropped: it would have been a second member list.

**What exists, live on `pod.nicolasdb.eu` (read 2026-10-19).**
- `hyperscope/config.ttl`, public: `<#hyperscope> a hs:Collective; hs:roster
  <membres.ttl>; …`. Field by field: solid-backoffice
  `docs/reference/collective-files.md`.
- `hyperscope/membres.ttl` (972 bytes, changed 2026-10-12), members only, written by
  the backoffice when an admin accepts someone:
  `<config.ttl#hyperscope> foaf:member <WebID>` and `<WebID> foaf:nick "nicolas"`.
  The nick is set at acceptance and never changed once used.
- The roster grants nothing; access stays in per-WebID `.acl`s, as here.

**Plugin side.**
- One setting, the team's `config.ttl` URL, the same for everyone, so it ships in
  the generic zip.
- Each run: `config.ttl`, then `hs:roster`, then members and nicks. Each member's pod
  (`ownPod(webId)`) becomes a row at `team/<nick>`; the nicks also replace the Team
  members setting for `share:`.
- A row the plugin added is marked, so hand-added rows are never touched; a
  hand-added row with the same URL is taken over and moved to `team/<nick>`.
- A row gone from the roster stops syncing; its local files stay.
- Roster unreadable (offline, 403, not a member yet) keeps the last rows, one
  skipped line.
- Turtle, not JSON: a reader for these two small files, no new dependency if a
  line-level parse holds; checked against the live files before choosing.
- Names follow the nicks: if Alexandre's nick is not `alexandre`, the folder is renamed
  rather than the nick (decided 2026-10-19).

Built 2026-10-20 (`src/team.ts`, `test/team.mjs` against a local CSS), changed from
the plan above in three ways:
- The setting is the roster's own URL, not `config.ttl`'s. `config.ttl` would only
  have pointed at it, since `hs:vault` is not there either. Reading `config.ttl` can
  be added if a team's roster ever moves.
- A hand row with the same pod URL is left as it is rather than taken over and moved
  to `team/<nick>`; the roster only adds rows for pods no row syncs yet. Moving a row
  means moving its notes in the vault, which was not needed to get the team synced.
  Renaming `team/nicolas/pod` and the others stays a later, separate step.
- The Turtle reader handles prefixes, IRIs, prefixed names, plain strings and
  `; , .`, and refuses anything else as unreadable, rather than reading part of it.
  No dependency added.
A roster WebID must be http(s) and a nick must match the backoffice's own rule
(`[a-z0-9][a-z0-9-]{0,39}`), since both end up in a URL or a vault path.

**Not yet checked live.** `alex/profile/card#me` gets 403 on `membres.ttl`, so on
Alexandre's device the roster only adds a skip line until he is accepted. Expected
on `pod.nicolasdb.eu`, to check by trial:
- The hand row for `nicolasdb/` moved from `team/nicolas/pod` to `team/nicolas` on
  2026-10-20, on Omarchy only. Its notes came from the pod through the plugin, but on
  2026-10-20 `nicolasdb/` refused alex everything, profile included (403; anonymous
  401). `hyperscope_ndb/` is public-read, its profile has `foaf:name "nicolasdb"` and
  `org:memberOf` HyperScope, and its `shared/` holds the same files: Nicolas's pod
  appears to have moved there. Repointing the hand row to `hyperscope_ndb/` avoids the
  roster's `team/nicolas` row clashing with it.
- The projects pod, `hyperscope/vault/`, is not a member's pod, so it stays a hand
  row.
- The git-era notes under `team/nicolas/` (`activity/`, `tasks.md`, `profile.md`)
  now sit inside the `nicolasdb/` row. While its root is 403 nothing moves. Once
  alex can read it they are new local notes: pushed into Nicolas's pod if alex can
  write there, listed as skipped on every run if not.

Alexandre was accepted by 2026-10-21: `alex/profile/card#me` reads `membres.ttl`
(200, `WAC-Allow: user="read"`), which lists `nicolas` (`hyperscope_ndb/`),
`chabi-vdb` (`chabivdb/`) and `alex`. The `nicolasdb/` hand row was repointed to
`hyperscope_ndb/` before then.

Built 2026-10-21: the roster is found, not typed. A logged-in run reads the profile's
`org:memberOf`, each collective's `config.ttl`, and its `hs:roster`, the walk the
backoffice's `loadCollective` makes; the Team roster setting, when filled, replaces
it. Members must belong to that collective (`foaf:member` from its IRI). Any of the
three documents unreadable keeps the last team; a profile naming no collective drops
the roster's rows. Settings are written only when the team changed. Login falls back
to the stored `issuer`, so a vault template carrying only `issuer` needs no row:
logging in brings the user's own pod at `team/<nick>` and every member's. Checked
locally (`test/team.mjs` §5, seen failing without the walk and without the collective
check) and live 2026-10-21 against `pod.nicolasdb.eu` (read only): alex's profile led
to HyperScope's roster and its three nicks.

Still open, for Nicolas:
- `config.ttl` names no vault, so the `hyperscope/vault/` → `projects/` row stays by
  hand (or in the template). A property such as `hs:vault` would let the walk add it.
- Accepting grants Read on the roster and the collective's shared folders, not on
  `vault/`, and no Write; each new member's access there is granted by hand.
- `config.ttl` says members share by granting the collective's agent (`hs:agent`)
  in `hs:bundleFolder`, not each other. A member's pod row at `team/<nick>` reads only
  what that member shared with the reader; a fresh pod shows a 403 skip.
