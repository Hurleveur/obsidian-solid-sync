/**
 * A folder deleted on the pod, and the vault folder its notes lived in. Creates and
 * deletes `pr-scratch/` in the pod, so use a scratch pod.
 *
 *   POD_URL=… POD_ID=… POD_SECRET=… node test/prune.mjs
 *
 * The bug this guards against: a sync trashed each note the pod no longer had, one by
 * one, and left the folders they sat in. A project folder deleted on the team pod
 * stayed in every member's vault as an empty husk.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from './obsidian-stub.mjs';
import { runSync, createFetcher, walk, DEFAULT_SETTINGS } from './sync.bundle.mjs';

const POD = process.env.POD_URL;
const id = process.env.POD_ID;
const secret = process.env.POD_SECRET;
assert(POD && id && secret, 'POD_URL, POD_ID and POD_SECRET required');

const f = await createFetcher(new URL(POD).origin, id, secret);
const ROOT = new URL('pr-scratch/', POD).href;
const put = async (rel, body) => {
	const res = await f(new URL(rel, ROOT).href, {
		method: 'PUT',
		headers: { 'content-type': 'text/markdown' },
		body,
	});
	assert.ok(res.ok, `seeding ${rel} (${res.status})`);
};
// Deepest first: a container must be empty before it can go.
const remove = async (...rels) => {
	for (const rel of rels) {
		const res = await f(new URL(rel, ROOT).href, { method: 'DELETE' });
		assert.ok(res.ok, `deleting ${rel} (${res.status})`);
	}
};
const purge = async () => {
	const { resources } = await walk(f, ROOT).catch(() => ({ resources: [] }));
	for (const r of resources) await f(r.url, { method: 'DELETE' });
};
await purge();

const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-vault-'));
const vault = new Vault(vaultRoot);
const plugin = {
	app: { vault, fileManager: { trashFile: (file) => vault.trash(file) } },
	settings: {
		...structuredClone(DEFAULT_SETTINGS),
		issuer: new URL(POD).origin,
		pods: [{ url: ROOT, folder: 'Pod' }],
		clientId: id,
		clientSecret: secret,
		syncOnStartup: false,
		history: false,
	},
	state: {},
	saveState: async () => {},
	saveSettings: async () => {},
};
const abs = (p) => path.join(vaultRoot, p);
const ok = (n) => console.log(`  ok  ${n}`);

await put('gone/a.md', '# a\n');
await put('gone/deep/b.md', '# b\n');
await put('keep/c.md', '# c\n');
await put('keep/d.md', '# d\n');
await put('dot/e.md', '# e\n');
console.log('1. first sync:', await runSync(plugin));
assert.ok(fs.existsSync(abs('Pod/gone/deep/b.md')), 'nested note pulled');
fs.mkdirSync(abs('Pod/mine'));
fs.writeFileSync(abs('Pod/dot/.hidden'), 'not in the index');

// --- 2. a folder deleted whole on the pod -----------------------------------
await remove('gone/deep/b.md', 'gone/deep/', 'gone/a.md', 'gone/', 'keep/d.md', 'dot/e.md');
const second = await runSync(plugin);
console.log('2. pod lost gone/, keep/d.md, dot/e.md:', second);
assert.ok(!fs.existsSync(abs('Pod/gone')), 'emptied folder and its emptied child are trashed');
ok('a folder deleted on the pod leaves no empty folder behind');
assert.ok(fs.existsSync(abs('Pod/keep/c.md')), 'a folder with a surviving note stays');
ok('a folder that still holds a note stays');
assert.ok(fs.existsSync(abs('Pod/dot/.hidden')), 'a dotfile the index cannot see keeps its folder');
ok('a folder holding only an unindexed dotfile stays');
assert.ok(fs.existsSync(abs('Pod/mine')), 'an empty folder this run did not empty stays');
ok('an empty folder the user made is left alone');
assert.match(second, /6 trashed locally/, 'four notes and two folders trashed, and counted');

// --- 3. the pod folder itself is never trashed ------------------------------
fs.rmSync(abs('Pod/mine'), { recursive: true });
fs.rmSync(abs('Pod/dot'), { recursive: true });
await remove('keep/c.md', 'keep/');
const third = await runSync(plugin);
console.log('3. pod lost its last note:', third);
assert.ok(!fs.existsSync(abs('Pod/keep')), 'the last emptied folder is trashed');
assert.ok(fs.existsSync(abs('Pod')), 'the pod folder stays, even empty');
ok('the pod folder survives losing every note');

await purge();
await f(ROOT, { method: 'DELETE' });
fs.rmSync(vaultRoot, { recursive: true });
console.log('prune: all passed');
