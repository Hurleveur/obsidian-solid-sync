/**
 * The sync log: what a run pushed or deleted, appended to `_sync-log/<writer>.md`.
 * Creates and deletes `sl-*` resources, so use a scratch pod on a local server.
 *
 *   POD_URL=… POD_ID=… POD_SECRET=… node test/synclog.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from './obsidian-stub.mjs';
import { runSync, createFetcher, isSyncTrigger } from './sync.bundle.mjs';

const POD = process.env.POD_URL;
const id = process.env.POD_ID;
const secret = process.env.POD_SECRET;
assert(POD && id && secret, 'POD_URL, POD_ID and POD_SECRET required');

const ROOT = new URL('sl-scratch/', POD).href;
const LOG_URL = `${ROOT}_sync-log/first.md`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// What a pod we may not write says about itself, and a pod that refuses the log.
const realFetch = globalThis.fetch;
let readOnlyHeader = false;
let refuseLog = false;
globalThis.fetch = async (url, init = {}) => {
	if (refuseLog && String(url).includes('_sync-log/') && init.method === 'PUT') {
		return new Response('no', { status: 403 });
	}
	const res = await realFetch(url, init);
	if (!readOnlyHeader || (init.method ?? 'GET') !== 'GET') return res;
	const headers = new Headers(res.headers);
	headers.set('wac-allow', 'user="read",public="read"');
	return new Response(await res.arrayBuffer(), { status: res.status, headers });
};

const f = await createFetcher(new URL(POD).origin, id, secret);
const podText = async (url) => {
	const res = await f(url, { headers: { 'cache-control': 'no-cache' } });
	return res.ok ? res.text() : null;
};
const ok = (n) => console.log(`  ok  ${n}`);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synclog-vault-'));
const vault = new Vault(root);
const plugin = {
	app: { vault, fileManager: { trashFile: (file) => vault.trash(file) } },
	// Every key, by hand: a key missing here reads as undefined inside runSync.
	settings: {
		issuer: new URL(POD).origin,
		pods: [{ url: ROOT, folder: 'Pod' }],
		clientId: id,
		clientSecret: secret,
		pushDeletions: true,
		syncOnStartup: false,
		syncOnChange: false,
		syncLog: true,
		maxFileMB: 10,
		ignore: [],
	},
	state: {},
	lastSkipped: [],
	saveState: async () => {},
	saveSettings: async () => {},
};
const write = (p, text) => {
	fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
	fs.writeFileSync(path.join(root, p), text);
};
const localLog = () =>
	fs.existsSync(path.join(root, 'Pod/_sync-log/first.md'))
		? fs.readFileSync(path.join(root, 'Pod/_sync-log/first.md'), 'utf8')
		: null;
const entries = (text) => (text ?? '').split('\n').filter(Boolean);
const sync = async (label) => {
	const result = await runSync(plugin);
	console.log(`  ${label.padEnd(24)}: ${result}`);
	for (const line of plugin.lastSkipped) console.log('     skipped:', line);
	assert.deepEqual(vault.trashed, [], `${label}: nothing trashed`);
	// Pod timestamps can be second-granular; keep each step in its own second.
	await sleep(1100);
	return result;
};
const ENTRY = (verb, p) =>
	new RegExp(`^- \\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ ${verb} ${p}$`);

try {
	const seed = await f(`${ROOT}sl-seed.md`, {
		method: 'PUT',
		headers: { 'content-type': 'text/markdown' },
		body: '# seed\n',
	});
	assert.ok(seed.ok, `seeding (${seed.status})`);

	// --- 1. a pull alone writes no log --------------------------------------
	assert.match(await sync('1. first pull'), /^1 pulled, 0 pushed$/);
	assert.equal(localLog(), null, 'a pull is someone else’s push: no log');
	assert.equal(await podText(LOG_URL), null, 'no log on the pod either');
	ok('pulls are not logged');

	// --- 2. a push is logged, and the counts stay the notes' ------------------
	write('Pod/sl-a.md', '# a\n');
	assert.match(await sync('2. new note'), /^0 pulled, 1 pushed$/);
	let log = localLog();
	assert.equal(entries(log).length, 1, 'one entry');
	assert.match(entries(log)[0], ENTRY('pushed', 'sl-a\\.md'));
	assert.equal(await podText(LOG_URL), log, 'the pod holds the same log');
	assert.deepEqual(plugin.lastSkipped, [], 'nothing skipped');
	ok('a pushed note is logged on both sides, counts unchanged');

	// --- 3. our own log is not read back as a change ---------------------------
	assert.match(await sync('3. nothing to do'), /^0 pulled, 0 pushed$/);
	assert.equal(localLog(), log, 'no new entry, nothing rewritten');
	ok('the log neither logs itself nor pulls back');

	// --- 4. append, never rewrite ----------------------------------------------
	write('Pod/sl-a.md', '# a2\n');
	write('Pod/deep/sl-b.md', '# b\n');
	assert.match(await sync('4. edit and add'), /^0 pulled, 2 pushed$/);
	const after = localLog();
	assert.ok(after.startsWith(log), 'older lines untouched');
	assert.equal(entries(after).length, 3);
	assert.match(entries(after)[1] + '\n' + entries(after)[2], /pushed (sl-a\.md|deep\/sl-b\.md)\n.*pushed (sl-a\.md|deep\/sl-b\.md)$/);
	assert.equal(await podText(LOG_URL), after);
	log = after;
	ok('later runs append below earlier lines');

	// --- 5. a deletion on the pod is logged --------------------------------------
	fs.unlinkSync(path.join(root, 'Pod/sl-a.md'));
	assert.match(await sync('5. delete'), /^0 pulled, 0 pushed, 1 deleted on pod$/);
	assert.match(entries(localLog()).at(-1), ENTRY('deleted', 'sl-a\\.md'));
	assert.ok(localLog().startsWith(log));
	log = localLog();
	ok('a deletion on the pod is logged');

	// --- 6. a fresh device pulls the log, then appends to it ---------------------
	// Same state-less device: the log arrives as a pulled note, not a conflict.
	plugin.state = {};
	fs.rmSync(path.join(root, 'Pod'), { recursive: true });
	await sync('6. fresh pull');
	assert.equal(localLog(), log, 'history came down with the pull');
	write('Pod/sl-c.md', '# c\n');
	await sync('6. then a push');
	assert.ok(localLog().startsWith(log) && entries(localLog()).length === entries(log).length + 1);
	log = localLog();
	ok('a new device appends to the history it pulled');

	// --- 7. a log the pod refuses costs one skip line, not the run ----------------
	refuseLog = true;
	write('Pod/sl-d.md', '# d\n');
	assert.match(await sync('7. log refused'), /^0 pulled, 1 pushed, 1 skipped$/);
	assert.match(plugin.lastSkipped[0], /_sync-log.*sync log: PUT refused: 403/);
	assert.equal(await podText(`${ROOT}sl-d.md`), '# d\n', 'the note itself landed');
	refuseLog = false;
	ok('a refused log is one skip line');

	// --- 8. a pod we cannot write gets no log -------------------------------------
	readOnlyHeader = true;
	const before = localLog();
	write('Pod/sl-c.md', '# c edited\n');
	await sync('8. read-only');
	assert.equal(localLog(), before, 'no entry on a read-only pod');
	readOnlyHeader = false;
	ok('a read-only pod is not logged');

	// --- 9. off means off ---------------------------------------------------------
	plugin.settings.syncLog = false;
	const kept = localLog();
	write('Pod/sl-e.md', '# e\n');
	assert.match(await sync('9. log off'), /^0 pulled, 1 pushed/);
	assert.equal(localLog(), kept, 'nothing appended');
	plugin.settings.syncLog = true;
	ok('the setting turns the log off');

	// --- 10. the log never starts a sync -------------------------------------------
	assert.equal(isSyncTrigger('Pod/_sync-log/first.md', 'Pod', false), false);
	assert.equal(isSyncTrigger('Pod/_sync-log/other.md', 'Pod', false), false);
	assert.equal(isSyncTrigger('Pod/sl-a.md', 'Pod', false), true);
	assert.equal(isSyncTrigger('_sync-log/me.md', '/', false), false, 'vault root pod');
	ok('log files are not sync triggers');
} finally {
	readOnlyHeader = false;
	refuseLog = false;
	for (const rel of [
		'sl-seed.md', 'sl-a.md', 'sl-c.md', 'sl-d.md', 'sl-e.md', 'deep/sl-b.md',
		'_sync-log/first.md', 'deep/', '_sync-log/', '',
	]) {
		await f(ROOT + rel, { method: 'DELETE' });
	}
}
console.log('synclog: all passed');
