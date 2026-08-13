# obsidian-solid-sync

`AGENTS.md` is the upstream Obsidian sample's generic guidance. This file is what
is true about *this* plugin.

## Testing

- Test against a local Community Solid Server, never a hand-written stub. Setup and
  credential minting: README § Tests.
- Rebuild the test bundle after every `src/` change or the suites run stale code:
  `npx esbuild test/entry.ts --bundle --format=esm --platform=node --outfile=test/sync.bundle.mjs --alias:obsidian=./test/obsidian-stub.mjs`
- `public.mjs`, `restore.mjs` and `e2e.mjs` need a pod **root** — they assert on
  `README` and `profile/`, which a bare scratch subcontainer does not have.
- `repoint.mjs` needs two containers. Client credentials are minted per WebID, so
  use two folders inside one pod, never two pods.
- Confirm a new sync test fails with its fix removed. A repoint scenario built on an
  untouched file passes either way — the plain pull branch rewrites state on its own.
- The stub is the *host*, not the server: it may fake what Obsidian does to us.
  `vault.unindexed` holds paths on disk the index denies, and `create` throws on an
  existing path, both as the real vault behaves.
- A bug only reproducible in real Obsidian is still reproducible here — model the API
  difference in the stub rather than concluding the plugin logic is clean.

## Sync invariants

- `state` is keyed by vault path, not by URL. Anything reading `state[path]` must
  check the entry's `url` still starts with this pod's root.
- Anything walking `state` under a pod's folder must skip `claimed()` paths — a
  nested pod's entries name its own container and are not this pod's to drop.
- Record the local mtime `writeFile` returns, never one read off a `TFile` captured
  before the write; the pre-write stat makes the pull read as a local edit.
- Nothing in the per-path loop may throw out of it. One resource failing must cost
  that resource only — it used to end the container, silently, on every later run.
- Every path a run leaves alone or removes must say so — a `report.skipped` line or
  a `report.deleted*` counter. The summary string carries counts only. A skip naming
  a folder rather than a file means a whole pod was unreachable, nothing less.
- A pod name is not a vault name: `:` `?` `*` `"` `<` `>` `|` are legal in a URL and
  rejected by Obsidian. Assume any single write can fail on a name the pod accepted.
- `getFileByPath`/`getFiles` answer from Obsidian's index, `adapter.exists` from the
  disk, and they disagree — `create` throws on a path already on disk. Check both.
- Removing a pod row must drop its state entries (`ownedBy`), or they strand under a
  folder no run visits again.

## Installing a build

- Copy `main.js` and `manifest.json` into **both** plugin dirs of
  `~/Documents/GitHub/sandbox-office-vault`: `.obsidian/plugins/solid-sync/` (live,
  gitignored) and `.obsidian_template/plugins/solid-sync/` (tracked). Never `data.json`.
- Obsidian caches plugin code — a new `main.js` does nothing until the plugin is
  disabled and re-enabled.
- That vault is a shared repo and is usually dirty with other people's work. Stage
  only the files you changed.

## Credentials

- Never copy `clientId`/`clientSecret` out of a vault's `data.json` into a scratch
  file, command line or env. Mint throwaway ones against a local CSS instead.
- Redact `clientSecret` whenever quoting `data.json`.
