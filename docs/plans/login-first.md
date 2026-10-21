# Login first

A new user should get from an empty vault to a syncing one by logging in, with no
pod row typed by hand. Asked 2026-10-21.

## What the login does

1. **Server, email, password.** The account API (CSS `/.account/`) logs in and lists
   the account's pods (`controls.account.pod`) and WebIDs (`controls.account.webId`).
2. **Which pod** — only when the account has more than one. The token is minted for
   the WebID inside the chosen pod, so picking a pod also picks who you act as.
   Exactly one token is minted per login: every mint leaves a client-credentials
   entry on the account.
3. **Setup.** The credentials are saved first, so closing the dialog here leaves you
   logged in with nothing added. The screen offers:
   - your pod, at a folder (`team/<nick>` when your team's roster lists you, else
     `team/<pod name>`), unless a row already syncs it;
   - your team, when your profile names one, with every member's nick shown — the
     agreement to the list of people that turning team sync on is.

Shared pods (added 2026-10-21): a team's shared pod goes to `projects`, a second
team's to `projects/<team name>`, members (you included) to `team/<nick>`. It is
read from `hs:vault` in `config.ttl` — not in the backoffice vocab yet, proposed to
Nicolas — and until then guessed as `vault/` beside `config.ttl`, used only if
readable.

## The settings tab

- Order: Account, Status, Team sync, Pods, then the rest. Team roster moves down
  beside Team members: it is an override, not a step.
- Team sync is a toggle (asked 2026-10-21, replacing the button and its confirm):
  on reads the team and adds its rows at once, off removes them.
- One blue (CTA) button per state, the next step: logged out → Log in; otherwise →
  Sync now. Logged in with nothing to sync, the step is the toggle (no blue).
- Greyed when it cannot work: Sync now with nothing to sync, the Team sync toggle
  and Log out while logged out.

## Chunks

| Chunk | Files | Done when |
|---|---|---|
| Account API split | `src/solid.ts` | `logInToAccount` lists pods and WebIDs against a local CSS; `createClientCredentials` unchanged for callers |
| Dialog and tab | `src/settings.ts`, `test/obsidian-stub.mjs` | `test/settings-ui.mjs` asserts order, CTA and disabled per state |
| Live login | `test/login.mjs` | against a local CSS: a two-pod account picks its second pod, the token acts as that pod's WebID, the row lands; a roster lists the user and the team is offered |
| Docs | `README.md` | Setup reads as: log in, pick pod, done |
