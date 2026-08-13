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

## Sync invariants

- `state` is keyed by vault path, not by URL. Anything reading `state[path]` must
  check the entry's `url` still starts with this pod's root.
- Anything walking `state` under a pod's folder must skip `claimed()` paths — a
  nested pod's entries name its own container and are not this pod's to drop.
- Record the local mtime from the file `writeFile` returns, never from a `TFile`
  captured before the write; the pre-write stat makes the pull read as a local edit.
- Every path a run leaves alone or removes must say so — a `report.skipped` line or
  a `report.deleted*` counter. The summary string carries counts only.

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
