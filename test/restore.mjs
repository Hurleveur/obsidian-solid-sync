/**
 * Conflict and restore rules, against a real pod. Creates and deletes `rc-*`
 * resources, so use a scratch pod.
 *
 *   POD_URL=... POD_ID=... POD_SECRET=... node test/restore.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from './obsidian-stub.mjs';
import { runSync, deletedLocally, createFetcher } from './sync.bundle.mjs';

const POD = process.env.POD_URL;
const a = { pod: POD, id: process.env.POD_ID, secret: process.env.POD_SECRET };
assert(POD && a.id && a.secret, 'POD_URL, POD_ID and POD_SECRET required — this suite writes');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-vault-'));
const vault = new Vault(root);
const plugin = {
	app: { vault, fileManager: { trashFile: (f) => vault.trash(f) } },
	settings: {
		issuer: new URL(POD).origin,
		pods: [{ url: POD, folder: 'Pod' }],
		clientId: a.id, clientSecret: a.secret,
		pushDeletions: false, syncOnStartup: false, maxFileMB: 10,
	},
	state: {},
	saveState: async () => {}, saveSettings: async () => {},
};
const f = await createFetcher(POD, a.id, a.secret);
const put = (rel, body, type = 'text/markdown') =>
	f(new URL(rel, POD).href, { method: 'PUT', headers: { 'content-type': type }, body });
const abs = (p) => path.join(root, p);
const ok = (n) => console.log(`  ok  ${n}`);
const files = () => fs.readdirSync(abs('Pod')).sort();

await put('rc-note.md', '# same on both sides\n');
await put('rc-pic.png', Buffer.from([137, 80, 78, 71, 1, 2, 3]), 'image/png');
console.log('1. first sync:', await runSync(plugin));
assert.equal(fs.readFileSync(abs('Pod/rc-note.md'), 'utf8'), '# same on both sides\n');
ok('note and attachment pulled');

// --- 2. both sides move, bytes identical: must NOT be a conflict -----------
// Rewrite each side with the same content it already has. The pod stamps a new
// dc:modified, the vault a new mtime — timestamp-only detection sees a conflict.
await put('rc-note.md', '# same on both sides\n');
fs.writeFileSync(abs('Pod/rc-note.md'), '# same on both sides\n');
fs.utimesSync(abs('Pod/rc-note.md'), new Date(), new Date(Date.now() + 5000));
const second = await runSync(plugin);
console.log('2. identical rewrite:', second);
assert.doesNotMatch(second, /conflict/, 'identical bytes are not a conflict');
assert.deepEqual(
	files().filter((n) => n.includes('conflict')),
	[],
	'no conflict copy written beside the note',
);
ok('a touched timestamp with unchanged bytes writes no conflict copy');

// --- 3. a real divergence still conflicts ---------------------------------
await put('rc-note.md', '# the pod moved on\n');
fs.writeFileSync(abs('Pod/rc-note.md'), '# but so did the vault\n');
const third = await runSync(plugin);
console.log('3. real divergence:', third);
assert.match(third, /1 conflicts/, 'different bytes still conflict');
const copies = files().filter((n) => n.includes('conflict'));
assert.equal(copies.length, 1, 'exactly one conflict copy');
assert.equal(
	fs.readFileSync(abs(`Pod/${copies[0]}`), 'utf8'),
	'# the pod moved on\n',
	'the copy holds the pod version',
);
assert.equal(
	fs.readFileSync(abs('Pod/rc-note.md'), 'utf8'),
	'# but so did the vault\n',
	'the note keeps the local version',
);
ok('a genuine divergence still writes the pod copy beside the note');

// --- 4. delete locally: skipped forever, never pulled back ----------------
fs.unlinkSync(abs('Pod/rc-pic.png'));
const fourth = await runSync(plugin);
console.log('4. after local delete:', fourth);
assert.equal(fs.existsSync(abs('Pod/rc-pic.png')), false, 'not silently re-downloaded');
assert.match(fourth, /skipped/);
const again = await runSync(plugin);
assert.equal(fs.existsSync(abs('Pod/rc-pic.png')), false, 'still gone on the next run');
ok('a locally deleted file stays deleted and keeps being skipped');

// --- 5. what the Restore button does --------------------------------------
const gone = deletedLocally(plugin.state, (p) => fs.existsSync(abs(p)));
assert.deepEqual(gone, ['Pod/rc-pic.png'], 'exactly the missing one');
for (const p of gone) delete plugin.state[p];
const fifth = await runSync(plugin);
console.log('5. after restore:', fifth);
assert.match(fifth, /1 pulled/);
assert.deepEqual(
	[...fs.readFileSync(abs('Pod/rc-pic.png'))],
	[137, 80, 78, 71, 1, 2, 3],
	'the attachment came back byte for byte',
);
ok('dropping the state entry pulls the deleted file back');

for (const rel of ['rc-note.md', 'rc-pic.png']) await f(new URL(rel, POD).href, { method: 'DELETE' });
console.log('restore + conflict: all checks passed');
