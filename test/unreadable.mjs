/**
 * A container that stops answering, and the notes already synced from it. Creates
 * and deletes `ur-*` resources and writes ACLs under them, so use a scratch pod on
 * a local server that runs WAC (the default CSS config does).
 *
 *   POD_URL=… POD_ID=… POD_SECRET=… node test/unreadable.mjs
 *
 * The bug this guards against: a container whose listing failed was left out of the
 * pod map, so every note synced from it read as "deleted on the pod" and was trashed.
 * A laptop suspending mid-sync did it to a whole meetings folder (network error), and
 * a friend tightening a sub-folder's ACL did it to theirs (403). The skip said
 * "(no access)" either way.
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
const ROOT = new URL('ur-scratch/', POD).href;
const WEBID = new URL('profile/card#me', POD).href;
const SEED = ['open/a.md', 'locked/b.md', 'locked/c.md', 'ro/d.md'];
for (const n of SEED) {
	const res = await f(`${ROOT}${n}`, {
		method: 'PUT',
		headers: { 'content-type': 'text/markdown' },
		body: `# ${n}\n`,
	});
	assert.ok(res.ok, `seeding ${n} (${res.status})`);
}

// An ACL naming only the modes given, for us. The owner keeps Control over ACLs
// whatever they say, which is how the suite takes them off again.
const acl = (container, modes) =>
	f(`${ROOT}${container}.acl`, {
		method: 'PUT',
		headers: { 'content-type': 'text/turtle' },
		body: `@prefix acl: <http://www.w3.org/ns/auth/acl#>.
<#me> a acl:Authorization; acl:agent <${WEBID}>;
  acl:accessTo <./>; acl:default <./>; acl:mode ${modes}.`,
	});

const ok = (n) => console.log(`  ok  ${n}`);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unreadable-vault-'));
const vault = new Vault(root);
const plugin = {
	root,
	vault,
	app: { vault, fileManager: { trashFile: (file) => vault.trash(file) } },
	settings: {
		issuer: new URL(POD).origin,
		pods: [{ url: ROOT, folder: 'Pod' }],
		clientId: id,
		clientSecret: secret,
		pushDeletions: true,
		syncOnStartup: false,
		maxFileMB: 10,
	},
	state: {},
	lastSkipped: [],
	saveState: async () => {},
	saveSettings: async () => {},
};
const onDisk = (p) => fs.existsSync(path.join(root, p));
const LOCKED = ['Pod/locked/b.md', 'Pod/locked/c.md'];

// The stub's requestUrl is Node's fetch, so a thrown fetch is a dropped network.
const realFetch = globalThis.fetch;
const dropNetwork = (match) => {
	globalThis.fetch = (url, init) =>
		match(String(url)) ? Promise.reject(new Error('fetch failed')) : realFetch(url, init);
};

try {
	console.log('0. first sync    :', await runSync(plugin));
	for (const p of LOCKED) assert.ok(plugin.state[p], `${p} synced`);

	// --- 1. a 403 on a sub-container -------------------------------------------
	assert.ok((await acl('locked/', 'acl:Control')).ok, 'locking locked/');
	fs.writeFileSync(path.join(root, 'Pod/locked/new.md'), '# written while locked\n');
	console.log('1. 403 folder    :', await runSync(plugin));
	for (const line of plugin.lastSkipped) console.log('     skipped:', line);
	assert.deepEqual(vault.trashed, [], 'nothing trashed');
	for (const p of LOCKED) {
		assert.ok(onDisk(p), `${p} still on disk`);
		assert.ok(plugin.state[p], `${p} keeps its state entry`);
	}
	assert.ok(
		plugin.lastSkipped.includes(
			`${ROOT}locked/ (listing failed: 403, local copies left as they are)`,
		),
		'the skip gives the status, not "no access"',
	);
	assert.ok(
		!plugin.lastSkipped.some((l) => l.startsWith('Pod/locked/')),
		'no per-file attempt under the frozen folder',
	);
	ok('a 403 folder freezes its notes instead of trashing them');

	// --- 2. the network dropping on one container ------------------------------
	assert.ok((await f(`${ROOT}locked/.acl`, { method: 'DELETE' })).ok, 'unlocking');
	dropNetwork((u) => u.startsWith(`${ROOT}locked/`));
	console.log('2. network drop  :', await runSync(plugin));
	globalThis.fetch = realFetch;
	assert.deepEqual(vault.trashed, [], 'nothing trashed');
	for (const p of LOCKED) assert.ok(onDisk(p), `${p} still on disk`);
	assert.ok(
		plugin.lastSkipped.some((l) =>
			l.startsWith(`${ROOT}locked/ (listing failed: network error: fetch failed`),
		),
		'the skip names the network error',
	);
	ok('a network error freezes the same way');

	// --- 3. the root itself failing ---------------------------------------------
	dropNetwork((u) => u === ROOT);
	console.log('3. root down     :', await runSync(plugin));
	globalThis.fetch = realFetch;
	assert.deepEqual(vault.trashed, [], 'nothing trashed');
	for (const p of [...LOCKED, 'Pod/open/a.md']) assert.ok(onDisk(p), `${p} kept`);
	ok('an unlistable root freezes the whole folder');

	// --- 4. back to normal -------------------------------------------------------
	console.log('4. readable again:', await runSync(plugin));
	assert.deepEqual(vault.trashed, [], 'nothing trashed');
	assert.ok((await f(`${ROOT}locked/new.md`)).ok, 'the note held back is pushed now');
	ok('the next readable run carries on where the frozen ones stopped');

	// --- 5. a folder we may read but not write -----------------------------------
	assert.ok((await acl('ro/', 'acl:Read, acl:Control')).ok, 'making ro/ read-only');
	fs.writeFileSync(path.join(root, 'Pod/ro/new.md'), '# refused\n');
	await runSync(plugin);
	assert.ok(
		plugin.lastSkipped.includes('Pod/ro/new.md (new note, PUT refused: 403)'),
		`a refused PUT carries its status: ${plugin.lastSkipped}`,
	);
	ok('a refused write says 403, not "no write access"');
} finally {
	globalThis.fetch = realFetch;
	await f(`${ROOT}ro/.acl`, { method: 'DELETE' });
	await f(`${ROOT}locked/.acl`, { method: 'DELETE' });
	for (const n of [...SEED, 'locked/new.md', 'ro/new.md']) {
		await f(`${ROOT}${n}`, { method: 'DELETE' });
	}
	for (const c of ['open/', 'locked/', 'ro/', '']) {
		await f(`${ROOT}${c}`, { method: 'DELETE' });
	}
	fs.rmSync(root, { recursive: true, force: true });
}
