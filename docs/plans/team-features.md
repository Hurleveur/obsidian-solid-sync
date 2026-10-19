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
folders (folder note → container `.acl`) after.

Still open: does a pull write the pod's real ACL back into the property.

**What the servers do (checked 2026-10-19).**
- Local CSS 7.2, default config: the pod owner can always read and rewrite any
  `.acl` (`OwnerPermissionReader`), but deleting one also needs Write on its
  container (`ParentContainerReader`, the WAC rule for deletes). An ACL that takes
  Write away can be rewritten but not deleted. This was why `unreadable.mjs`
  failed; fixed in `8cf4fd5`.
- `pod.nicolasdb.eu`, live, on a throwaway `alex/acl-probe-…/` folder since deleted:
  a per-note `a.md.acl` naming the owner (Read, Write, Control) and one guest
  (Read) let the guest read `a.md` while `b.md` beside it stayed refused.
  Deleting that `.acl` removed the guest's access again, and the owner kept full
  rights throughout. The guest was the `claude-alex` agent WebID.
- 2026-09-28, same server: an `.acl` that left the owner out locked the owner out
  of the folder and of the `.acl` itself. Either this server has no owner override
  or `alex` is not recorded as the pod's owner (to ask Nicolas). The leftover is
  `alex/acl-test-1790599365365/`, which only Nicolas can remove.

**Constraints this sets.**
- Every `.acl` the plugin writes names the owner with Read, Write and Control, and
  never relies on an owner override.
- Unsharing a note deletes its `.acl`, so the note inherits from its folder again.
  This works only while the owner has Write on the folder, which an owner-inclusive
  ACL guarantees.
- A note's ACL is at the URL its `Link: rel="acl"` header names (`<note>.acl` on
  CSS). Read it from the header and never build it by hand.

## Chunk 3 — vault preset handed out from a website (design pending)

**Constraint.** Obsidian never downloads a missing plugin on its own: a plugin runs only
if its `main.js` and `manifest.json` sit in `.obsidian/plugins/<id>/`. "Fetch, don't
store" therefore means fetch when the zip is built, not when the vault opens.

Decided 2026-10-19: a GitHub Action builds one generic zip (config plus the plugins'
latest release files fetched at build time) and the website hands it out. Nothing
personal is in it.

The pods come after login, automatically: the website knows which pods each member
can reach and serves that list; the plugin reads it and adds the rows itself. Solid
has no "which pods may I reach" query, so this list is the website's to keep — it is
the operator, so it can.

Still open: the list's URL and shape (to agree with Nicolas), and what the plugin
does when a row it added disappears from the list.
