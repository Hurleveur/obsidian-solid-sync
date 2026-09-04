/**
 * Ignore rules through a whole sync, with the vault root as the pod folder. Creates
 * and deletes `ig-*` resources, so use a scratch container.
 *
 *   POD_URL=… POD_ID=… POD_SECRET=… node test/ignore-sync.mjs
 *
 * The unit suite pins what the patterns match. This pins what the sync does with
 * them, which is a different question and the one with teeth:
 *
 *  - An ignored vault file is not pushed, and an ignored pod resource is not pulled.
 *    Half a rule is worse than none, because it looks like it worked.
 *  - A path ignored *after* it was already synced has state naming it. That entry is
 *    in neither side's map on the next run, so it reads as a note deleted locally —
 *    and with pod deletions on, that reading deletes the pod's copy. Adding an ignore
 *    rule must never delete anything.
 *  - The vault's own dot-folders stay out of the pod whatever the rules say. At the
 *    root that is `.obsidian/plugins/solid-sync/data.json` and the pod credentials in
 *    it, which is the one file that must never reach a pod.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from './obsidian-stub.mjs';
import { createFetcher, runSync, walk } from './sync.bundle.mjs';

const POD = process.env.POD_URL;
const id = process.env.POD_ID;
const secret = process.env.POD_SECRET;
assert(POD && id && secret, 'POD_URL, POD_ID and POD_SECRET required');

const f = await createFetcher(new URL(POD).origin, id, secret);
const root = POD.endsWith('/') ? POD : `${POD}/`;

const names = async () =>
	(await walk(f, root)).resources
		.map((r) => r.url.slice(root.length))
		.filter((n) => n.startsWith('ig-'))
		.sort();

// Start clean: this suite proves things are *absent* from the pod, and a leftover
// from an earlier run is exactly what would make that proof pass for the wrong reason.
for (const n of await names()) {
	await f(root + n, { method: 'DELETE' });
}

const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solid-ignore-'));
const vault = new Vault(vaultDir);
const write = (rel, body) => {
	fs.mkdirSync(path.dirname(vault.abs(rel)), { recursive: true });
	fs.writeFileSync(vault.abs(rel), body);
};

const plugin = {
	app: {
		vault,
		fileManager: { trashFile: async (file) => vault.trash(file) },
	},
	settings: {
		issuer: new URL(POD).origin,
		clientId: id,
		clientSecret: secret,
		// The whole vault, as one pod. This is what `/` in the folder box means, and
		// it is also the only configuration in which an ignore rule really matters.
		pods: [{ url: root, folder: '/' }],
		pushDeletions: true,
		maxFileMB: 10,
		ignore: ['ig-attachments/', '*.png'],
	},
	state: {},
	lastSkipped: [],
	saveState: async () => {},
};

// --- a run at the vault root, with rules in place ---------------------------
write('ig-note.md', '# kept\n');
write('ig-attachments/ig-photo.jpg', 'not a real jpeg');
write('ig-shot.png', 'not a real png');
write('.obsidian/plugins/solid-sync/data.json', '{"clientSecret":"must-not-leave"}');

let summary = await runSync(plugin);
console.log(' ', summary);

let onPod = await names();
assert.deepEqual(onPod, ['ig-note.md'], 'only the note goes to the pod');
assert.match(summary, /1 pushed/);
// Counted, not listed: the skip list is for what the user has to act on, and a rule
// doing its job is not that.
assert.match(summary, /ignored/);
assert.equal(
	plugin.lastSkipped.some((line) => /ig-photo|ig-shot|data\.json/.test(line)),
	false,
	'an ignored path is not reported as a skip',
);
assert.equal(
	Object.keys(plugin.state).some((p) => /ig-photo|ig-shot|\.obsidian/.test(p)),
	false,
	'and it is not recorded as synced either',
);

// --- an ignored resource on the pod is not pulled ---------------------------
await f(`${root}ig-remote.png`, {
	method: 'PUT',
	headers: { 'content-type': 'image/png' },
	body: 'not a real png',
});
await f(`${root}ig-remote.md`, {
	method: 'PUT',
	headers: { 'content-type': 'text/markdown' },
	body: '# pulled\n',
});
summary = await runSync(plugin);
console.log(' ', summary);
assert.equal(fs.existsSync(vault.abs('ig-remote.md')), true, 'the note is pulled');
assert.equal(
	fs.existsSync(vault.abs('ig-remote.png')),
	false,
	'the ignored resource is not — an ignore rule is not a one-way rule',
);
assert.deepEqual(await names(), ['ig-note.md', 'ig-remote.md', 'ig-remote.png']);

// --- a rule added after the fact --------------------------------------------
// The dangerous one. `ig-note.md` is synced and has a state entry; ignoring it now
// puts it in neither side's map, which is indistinguishable from the user deleting
// it — and pod deletions are on.
assert.ok(plugin.state['ig-note.md'], 'precondition: it was synced');
plugin.settings.ignore.push('ig-note.md');

summary = await runSync(plugin);
console.log(' ', summary);
assert.deepEqual(
	await names(),
	['ig-note.md', 'ig-remote.md', 'ig-remote.png'],
	'adding an ignore rule deletes nothing on the pod',
);
assert.equal(fs.existsSync(vault.abs('ig-note.md')), true, 'nor in the vault');
assert.equal(
	plugin.state['ig-note.md'],
	undefined,
	'and the history goes, so the entry cannot be acted on by a later run',
);
assert.equal(
	plugin.lastSkipped.some((line) => line.includes('ig-note.md')),
	false,
	'it is ignored, not skipped — the skip list must stay actionable',
);

// Removing the rule again rediscovers both copies rather than reading a record of
// them from before the rule existed. The bytes match, so this is a plain re-record
// and not a conflict copy.
plugin.settings.ignore = plugin.settings.ignore.filter((p) => p !== 'ig-note.md');
summary = await runSync(plugin);
console.log(' ', summary);
assert.ok(plugin.state['ig-note.md'], 'un-ignoring picks the path back up');
assert.equal(
	fs.readdirSync(vaultDir).some((n) => n.includes('pod conflict')),
	false,
	'and does it without inventing a conflict against itself',
);

for (const n of await names()) {
	await f(root + n, { method: 'DELETE' });
}
fs.rmSync(vaultDir, { recursive: true, force: true });
console.log('ignore through a sync: all checks passed');
