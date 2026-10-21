/**
 * A scoped run — what an edit triggers — visits only paths changed in the vault,
 * against listings of their own folders, and still refuses to overwrite a pod-side
 * edit. Creates and deletes `sc-scratch/`, so use a scratch pod on a local server.
 *
 *   POD_URL=… POD_ID=… POD_SECRET=… node test/scoped.mjs
 *
 * Why it exists: every edit used to list every container of every pod, twice when
 * it pushed, and against a pod answering in half a second that was most of a minute.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from './obsidian-stub.mjs';
import { runSync, createFetcher, migrateSettings } from './sync.bundle.mjs';

const POD = process.env.POD_URL;
const id = process.env.POD_ID;
const secret = process.env.POD_SECRET;
assert(POD && id && secret, 'POD_URL, POD_ID and POD_SECRET required');

const ROOT = new URL('sc-scratch/', POD).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every request the plugin sends under ROOT, and a switch to take the pod away.
const realFetch = globalThis.fetch;
let requests = [];
let offline = false;
globalThis.fetch = async (url, init = {}) => {
	if (String(url).startsWith(ROOT)) {
		if (offline) throw new TypeError('fetch failed');
		requests.push(`${(init.method ?? 'GET').toUpperCase()} ${String(url).slice(ROOT.length) || '/'}`);
	}
	return realFetch(url, init);
};

const f = await createFetcher(new URL(POD).origin, id, secret);
const podPut = async (rel, text) => {
	const res = await f(ROOT + rel, { method: 'PUT', headers: { 'content-type': 'text/markdown' }, body: text });
	assert(res.ok, `PUT ${rel}: ${res.status}`);
};
const podBody = async (rel) => {
	const res = await f(ROOT + rel);
	return res.ok ? await res.text() : null;
};

const ok = (n) => console.log(`  ok  ${n}`);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-vault-'));
const vault = new Vault(root);
// Obsidian's TFile.stat is one object it updates in place; read it live.
const snapshot = vault.file.bind(vault);
vault.file = (p) =>
	Object.defineProperty(snapshot(p), 'stat', {
		get: () => {
			const st = fs.statSync(vault.abs(p));
			return { mtime: st.mtimeMs, size: st.size };
		},
	});
const plugin = {
	root,
	vault,
	app: { vault, fileManager: { trashFile: (file) => vault.trash(file) } },
	settings: migrateSettings({
		issuer: new URL(POD).origin,
		pods: [{ url: ROOT, folder: 'Pod' }],
		clientId: id,
		clientSecret: secret,
		pushDeletions: true,
		syncLog: false,
		history: false,
	}),
	state: {},
	lastSkipped: [],
	saveState: async () => {},
	saveSettings: async () => {},
};
const local = (p) => path.join(root, 'Pod', p);
const write = (p, text) => {
	fs.mkdirSync(path.dirname(local(p)), { recursive: true });
	fs.writeFileSync(local(p), text);
};
const read = (p) => (fs.existsSync(local(p)) ? fs.readFileSync(local(p), 'utf8') : null);
const sync = async (label, scoped) => {
	requests = [];
	const result = await runSync(plugin, scoped);
	console.log(`  ${label.padEnd(26)}: ${result}`);
	for (const line of plugin.lastSkipped) console.log('     skipped:', line);
	// Pod timestamps can be second-granular; keep each step in its own second.
	await sleep(1100);
	return result;
};
const listed = () => requests.filter((r) => r.startsWith('GET ') && r.endsWith('/'));

try {
	await podPut('a.md', 'a v1\n');
	await podPut('sub/b.md', 'b v1\n');
	await podPut('other/c.md', 'c v1\n');
	await podPut('far/away/d.md', 'd v1\n');
	await sync('1. first full run', false);
	assert.equal(read('a.md'), 'a v1\n');
	assert.equal(read('far/away/d.md'), 'd v1\n', 'full run reached every folder');
	ok('a full run pulls every folder');

	// 2. Nothing changed in the vault: not one request to the pod.
	await sync('2. scoped, nothing dirty', true);
	assert.deepEqual(requests, [], 'a scoped run with nothing to push touched the pod');
	ok('a scoped run with nothing changed sends nothing');

	// 3. One local edit, while a teammate edits a note elsewhere on the pod.
	write('a.md', 'a v2 local\n');
	await podPut('other/c.md', 'c v2 pod\n');
	const r3 = await sync('3. scoped, one edit', true);
	assert.match(r3, /0 pulled, 1 pushed/);
	assert.equal(await podBody('a.md'), 'a v2 local\n', 'the edit reached the pod');
	assert.equal(read('other/c.md'), 'c v1\n', 'a scoped run pulled a note it was not asked about');
	assert.deepEqual(listed(), ['GET /', 'GET /'], 'scoped run listed more than the edited note\'s folder');
	ok('a scoped run pushes the edit and lists only its folder');

	// 4. The pod change arrives on the next full run.
	await sync('4. full run', false);
	assert.equal(read('other/c.md'), 'c v2 pod\n');
	ok('a full run pulls what the scoped run left');

	// 5. Both sides edited the same note: still a conflict copy, never an overwrite.
	write('sub/b.md', 'b v2 local\n');
	await podPut('sub/b.md', 'b v2 pod\n');
	await sync('5. scoped, both edited', true);
	assert.equal(await podBody('sub/b.md'), 'b v2 pod\n', 'a scoped run overwrote a pod-side edit');
	const copies = fs.readdirSync(local('sub')).filter((n) => n.includes('pod conflict'));
	assert.equal(copies.length, 1, `expected one conflict copy, got ${copies}`);
	ok('a scoped run files a pod-side edit as a conflict');
	for (const c of copies) fs.unlinkSync(local(`sub/${c}`));

	// 6. A new note in a folder the pod does not have yet.
	write('new/deeper/e.md', 'e v1\n');
	const r6 = await sync('6. scoped, new folder', true);
	assert.match(r6, /1 pushed/);
	assert.equal(await podBody('new/deeper/e.md'), 'e v1\n');
	ok('a scoped run pushes a note into a folder the pod lacks');

	// 7. A local deletion, with pushDeletions on.
	fs.unlinkSync(local('a.md'));
	await sync('7. scoped, deletion', true);
	assert.equal(await podBody('a.md'), null, 'the deletion did not reach the pod');
	ok('a scoped run pushes a deletion');

	// 8. An edit made offline is not lost: the next scoped run, online, pushes it.
	write('sub/b.md', 'b v3 offline\n');
	offline = true;
	await sync('8. scoped, offline', true);
	offline = false;
	assert.equal(await podBody('sub/b.md'), 'b v2 pod\n');
	await sync('8. scoped, back online', true);
	assert.equal(await podBody('sub/b.md'), 'b v3 offline\n', 'an edit made offline was dropped');
	ok('an edit that failed offline is pushed by the next scoped run');

	// 9. A synced note whose folder is gone from the pod. A scoped run sees only a
	// 404, which a missing pod would answer too; trashing is a full run's call.
	write('far/away/d.md', 'd v2 local\n');
	await f(`${ROOT}far/away/d.md`, { method: 'DELETE' });
	await f(`${ROOT}far/away/`, { method: 'DELETE' });
	await sync('9. scoped, folder gone', true);
	assert.deepEqual(vault.trashed, [], 'a scoped run trashed a note on a 404');
	assert.equal(read('far/away/d.md'), 'd v2 local\n');
	assert.match(plugin.lastSkipped.join('\n'), /far\/away\/d\.md \(its folder is not on the pod/);
	ok('a scoped run leaves a note under a missing folder for a full run');
} finally {
	globalThis.fetch = realFetch;
	for (const rel of ['a.md', 'sub/b.md', 'other/c.md', 'far/away/d.md', 'new/deeper/e.md']) {
		await f(ROOT + rel, { method: 'DELETE' });
	}
	for (const c of ['far/away/', 'far/', 'sub/', 'other/', 'new/deeper/', 'new/', '']) {
		await f(ROOT + c, { method: 'DELETE' });
	}
	fs.rmSync(root, { recursive: true, force: true });
}
console.log('scoped sync: all passed');
