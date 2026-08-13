/**
 * One resource the vault will not take, and the rest of the container behind it.
 * Creates and deletes `uw-*` resources, so use a scratch pod.
 *
 *   POD_URL=… POD_ID=… POD_SECRET=… node test/unwritable.mjs
 *
 * The bug this guards against: a pod name is not a vault name. `:` and `?` are
 * ordinary in a URL and illegal in an Obsidian file name, and a path can also be on
 * disk while absent from the index, which makes `create` throw on a file that is
 * plainly there. Either one used to escape the per-path decision and end the whole
 * container: every path after it went unpulled, unpushed and unmentioned, with only
 * the folder named. Iteration order is stable, so the same resource killed the same
 * run every time and the notes behind it never arrived at all.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from './obsidian-stub.mjs';
import { runSync, createFetcher } from './sync.bundle.mjs';

const POD = process.env.POD_URL;
const id = process.env.POD_ID;
const secret = process.env.POD_SECRET;
assert(POD && id && secret, 'POD_URL, POD_ID and POD_SECRET required');

const f = await createFetcher(new URL(POD).origin, id, secret);
const ROOT = new URL('uw-scratch/', POD).href;
const NAMES = ['uw-1.md', 'uw-2.md', 'uw-3.md', 'uw-4.md', 'uw-5.md', 'uw-6.md'];
for (const n of NAMES) {
	const res = await f(`${ROOT}${n}`, {
		method: 'PUT',
		headers: { 'content-type': 'text/markdown' },
		body: `# ${n}\n`,
	});
	assert.ok(res.ok, `seeding ${n} (${res.status})`);
}

const ok = (n) => console.log(`  ok  ${n}`);
const vaults = [];
function newPlugin() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unwritable-vault-'));
	vaults.push(root);
	const vault = new Vault(root);
	return {
		root,
		vault,
		app: { vault, fileManager: { trashFile: (file) => vault.trash(file) } },
		settings: {
			issuer: new URL(POD).origin,
			pods: [{ url: ROOT, folder: 'Pod' }],
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
const pulled = (plugin) =>
	plugin.vault
		.getFiles()
		.map((x) => x.path.slice('Pod/'.length))
		.sort();

// --- 1. a path the vault refuses costs that path and no other ---------------
const refused = newPlugin();
const REFUSED = 'Pod/uw-3.md';
const realCreate = refused.vault.create.bind(refused.vault);
// Stands in for Obsidian rejecting a name the pod is happy with. The reason does not
// matter to the guard being tested — only that one path throws and the others do not.
refused.vault.create = async (p, data) => {
	if (p === REFUSED) throw new Error('name contains illegal characters');
	return realCreate(p, data);
};

console.log('1. one path refused:', await runSync(refused));
for (const line of refused.lastSkipped) console.log('     skipped:', line);

assert.deepEqual(
	pulled(refused),
	NAMES.filter((n) => `Pod/${n}` !== REFUSED),
	'every other resource in the container still arrives',
);
ok('one unwritable path does not abandon the container');

assert.ok(
	refused.lastSkipped.some((l) => l.startsWith(`${REFUSED} (`)),
	'the path that failed is named, rather than only the folder it is in',
);
assert.deepEqual(
	refused.lastSkipped.filter((l) => l.startsWith('Pod (')),
	[],
	'and the failure is not reported as the whole folder being skipped',
);
ok('the skip names the resource and says why');

// Nothing was recorded for it, so the next run tries again rather than reading the
// missing file as a note deleted locally and leaving the pod copy alone forever.
assert.equal(refused.state[REFUSED], undefined, 'no state entry for a failed path');
const again = await runSync(refused);
console.log('2. and again       :', again);
assert.ok(
	refused.lastSkipped.some((l) => l.startsWith(`${REFUSED} (`)),
	'still reported on the next run',
);
assert.match(again, /^0 pulled/, 'while everything that did land stays settled');
ok('a failed path is retried and re-reported, never silently accepted');

// --- 2. on disk, but not in the index ---------------------------------------
// The two views of a vault come apart in normal use — a note arriving from git or
// another sync, anything under a dot-folder, the index not yet caught up. `create`
// throws on a path already on disk, so this used to be the same fatal exception.
const stale = newPlugin();
fs.mkdirSync(path.join(stale.root, 'Pod'), { recursive: true });
fs.writeFileSync(path.join(stale.root, 'Pod/uw-2.md'), '# an older copy\n');
stale.vault.unindexed.add('Pod/uw-2.md');

console.log('3. unindexed file  :', await runSync(stale));
for (const line of stale.lastSkipped) console.log('     skipped:', line);

assert.equal(
	fs.readFileSync(path.join(stale.root, 'Pod/uw-2.md'), 'utf8'),
	'# uw-2.md\n',
	'the pod copy is written over the untracked one rather than throwing',
);
assert.deepEqual(
	stale.lastSkipped,
	[],
	'and nothing is skipped: the file was writable all along',
);
ok('a file on disk the index has not seen is written, not fatal');

// The index catches up, which is what makes the divergence transient in a real vault.
stale.vault.unindexed.clear();
const settled = await runSync(stale);
console.log('4. index caught up :', settled);
assert.match(
	settled,
	/^0 pulled, 0 pushed/,
	'the mtime recorded through the adapter matches what the index reports, so the note we just wrote does not read as a local edit',
);
ok('the run settles once the index sees the file');

for (const n of NAMES) await f(`${ROOT}${n}`, { method: 'DELETE' });
await f(ROOT, { method: 'DELETE' });
for (const root of vaults) fs.rmSync(root, { recursive: true, force: true });
console.log('\nunwritable paths: all checks passed');
