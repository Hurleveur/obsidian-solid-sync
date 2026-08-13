/**
 * A pod pointed at a different container while keeping its vault folder. Creates and
 * deletes `rp-*` resources in both containers, so use scratch ones. Two containers
 * in a single pod are enough and are the easier thing to have: client credentials
 * are minted per WebID, so two pods usually means two identities.
 *
 *   POD_URL=…/scratch-a/ POD_URL_2=…/scratch-b/ POD_ID=… POD_SECRET=… \
 *     node test/repoint.mjs
 *
 * The bug this guards against: sync state is keyed by vault path, so entries left by
 * the first container name resources the second one does not have. Read as history
 * they invert every decision — the new container's resources look like notes deleted
 * locally and are skipped forever, the old container's look like notes the pod
 * deleted and are trashed, and a local edit is pushed to the container that no
 * longer owns the folder.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from './obsidian-stub.mjs';
import { runSync, createFetcher, walk } from './sync.bundle.mjs';

const A = process.env.POD_URL;
const B = process.env.POD_URL_2;
const id = process.env.POD_ID;
const secret = process.env.POD_SECRET;
assert(A && B && id && secret, 'POD_URL, POD_URL_2, POD_ID and POD_SECRET required');
assert.notEqual(A, B, 'the two containers must differ, or there is nothing to repoint');

const f = await createFetcher(new URL(A).origin, id, secret);
const put = async (container, rel, body) => {
	const res = await f(new URL(rel, container).href, {
		method: 'PUT',
		headers: { 'content-type': 'text/markdown' },
		body,
	});
	assert.ok(res.ok, `seeding ${rel} in ${container} (${res.status})`);
};

// Start from a known pair of containers. The very fault under test used to end a
// run by pushing one container's leftovers into the other, so a half-cleaned pod
// from an earlier run is exactly the state that would make this suite pass by
// finding what it should have been proving does not get there.
const purge = async (container) => {
	for (const r of (await walk(f, container)).resources) {
		if (r.url.slice(container.length).startsWith('rp-')) {
			await f(r.url, { method: 'DELETE' });
		}
	}
};
await purge(A);
await purge(B);

const FIRST = '# from the first container\n';
const SECOND = '# from the second container\n';
await put(A, 'rp-shared.md', FIRST);
await put(A, 'rp-only-a.md', '# only the first has this\n');
await put(B, 'rp-shared.md', SECOND);
await put(B, 'rp-only-b.md', '# only the second has this\n');

const ok = (n) => console.log(`  ok  ${n}`);
const vaults = [];
function newPlugin() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repoint-vault-'));
	vaults.push(root);
	const vault = new Vault(root);
	return {
		root,
		vault,
		app: { vault, fileManager: { trashFile: (file) => vault.trash(file) } },
		settings: {
			issuer: new URL(A).origin,
			pods: [{ url: A, folder: 'Pod' }],
			clientId: id,
			clientSecret: secret,
			pushDeletions: false,
			syncOnStartup: false,
			maxFileMB: 10,
		},
		state: {},
		lastSkipped: [],
		saveState: async () => {},
		saveSettings: async () => {},
	};
}
/** Exactly what editing the URL field of an existing pod row does. */
const repoint = (plugin) => {
	plugin.settings.pods[0].url = B;
	delete plugin.settings.pods[0].access;
};
const read = (plugin, rel) => fs.readFileSync(path.join(plugin.root, rel), 'utf8');
const has = (plugin, rel) => fs.existsSync(path.join(plugin.root, rel));
const conflicts = (plugin) =>
	plugin.vault.getFiles().map((x) => x.path).filter((p) => p.includes('conflict'));

// --- 1. an untouched folder follows the pod it is pointed at ---------------
const clean = newPlugin();
console.log('1. first container :', await runSync(clean));
assert.equal(read(clean, 'Pod/rp-shared.md'), FIRST);
assert.ok(has(clean, 'Pod/rp-only-a.md'));
ok('the first container is mirrored');

repoint(clean);
const moved = await runSync(clean);
console.log('2. after repointing:', moved);
for (const line of clean.lastSkipped) console.log('     skipped:', line);

assert.equal(
	read(clean, 'Pod/rp-shared.md'),
	SECOND,
	'the new container owns the path, rather than losing it to a conflict copy',
);
assert.ok(has(clean, 'Pod/rp-only-b.md'), 'and everything else it holds is pulled');
assert.deepEqual(conflicts(clean), [], 'nothing the user wrote is in question here');
ok('a file the old container left untouched is replaced, not fought over');

// A leftover the new container does not have is the old one's copy, and leaving it
// on disk is not neutral: with its state entry gone it reads next run as a note the
// user wrote, and gets pushed into a pod it never came from. Removed, and only ever
// to the trash — never a path the new container does have.
assert.deepEqual(
	clean.vault.trashed,
	['Pod/rp-only-a.md'],
	'the old container’s leftover, and nothing the new one holds',
);
assert.equal(has(clean, 'Pod/rp-only-a.md'), false);
ok('a file only the old container had is trashed, recoverably');

// The one that poisons a later push: `push` sends to the recorded URL, so an entry
// still naming the old container writes into a container this folder no longer
// mirrors — with the same credentials, and with no sign anything went wrong.
assert.deepEqual(
	Object.entries(clean.state).filter(([, e]) => !e.url.startsWith(B)),
	[],
	'no entry still points at the old container',
);
ok('every entry names the container now configured');

const settled = await runSync(clean);
console.log('3. next run        :', settled);
assert.match(
	settled,
	/^0 pulled, 0 pushed/,
	'the repointed folder is a no-op — nothing pulled again, and nothing of the old container sent to the new one',
);
ok('the run settles, and the old container’s data never reaches the new pod');

// --- 2. a path the user deleted locally still follows the new container ----
// The reported case, and the one that sticks: the other paths recover on their own
// because an untouched file takes the plain pull branch, which rewrites the entry.
// A path with no file left cannot — it reads as a deletion, is skipped as one, and
// what the new container holds there never arrives, on this run or any after it.
const deleted = newPlugin();
await runSync(deleted);
fs.unlinkSync(path.join(deleted.root, 'Pod/rp-shared.md'));
repoint(deleted);
console.log('4. deleted locally :', await runSync(deleted));
for (const line of deleted.lastSkipped) console.log('     skipped:', line);
assert.ok(
	has(deleted, 'Pod/rp-shared.md'),
	'the new container’s resource arrives, rather than being skipped as a deletion',
);
assert.equal(read(deleted, 'Pod/rp-shared.md'), SECOND, 'and it is the new one’s');
ok('a path deleted under the old container is not held against the new one');

// --- 3. but a file the user edited is still the user's ---------------------
// The mtime is the whole difference: matching what we recorded means nobody has
// touched the file since we wrote it, so it is the old pod's copy. Anything else is
// work, and work survives — including work on a path the new container never had,
// which is the one the stale entries used to trash as a pod-side deletion.
const edited = newPlugin();
await runSync(edited);
fs.writeFileSync(path.join(edited.root, 'Pod/rp-shared.md'), '# my own words\n');
fs.writeFileSync(path.join(edited.root, 'Pod/rp-only-a.md'), '# mine now\n');
repoint(edited);
const kept = await runSync(edited);
console.log('5. edited leftover :', kept);

assert.equal(read(edited, 'Pod/rp-shared.md'), '# my own words\n', 'the edit survives');
assert.match(kept, /1 conflicts/, 'and the new copy is offered beside it, not instead');
const copies = conflicts(edited);
assert.equal(copies.length, 1, 'exactly one conflict copy');
assert.equal(read(edited, copies[0]), SECOND, 'holding what the new container has');
ok('a leftover the user edited is kept, with the new copy beside it');

assert.deepEqual(edited.vault.trashed, [], 'and an edited leftover is never trashed');
assert.equal(read(edited, 'Pod/rp-only-a.md'), '# mine now\n');
ok('work on a path the new container never had survives the repointing');

for (const [container, rel] of [
	[A, 'rp-shared.md'],
	[A, 'rp-only-a.md'],
	[B, 'rp-shared.md'],
	[B, 'rp-only-b.md'],
])
	await f(new URL(rel, container).href, { method: 'DELETE' });
for (const root of vaults) fs.rmSync(root, { recursive: true, force: true });
console.log('\nrepointed pod: all checks passed');
