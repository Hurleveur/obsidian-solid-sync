/**
 * Local history: the bytes a sync overwrites or deletes are stored before it does.
 * Creates and deletes `hi-*` resources, so use a scratch pod on a local server.
 *
 *   POD_URL=… POD_ID=… POD_SECRET=… node test/history.mjs
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from './obsidian-stub.mjs';
import { runSync, createFetcher } from './sync.bundle.mjs';

const POD = process.env.POD_URL;
const id = process.env.POD_ID;
const secret = process.env.POD_SECRET;
assert(POD && id && secret, 'POD_URL, POD_ID and POD_SECRET required');

const ROOT = new URL('hi-scratch/', POD).href;
const ROOT2 = new URL('hi-scratch2/', POD).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const f = await createFetcher(new URL(POD).origin, id, secret);
const ok = (n) => console.log(`  ok  ${n}`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-vault-'));
const vault = new Vault(root);
const plugin = {
	app: { vault, fileManager: { trashFile: (file) => vault.trash(file) } },
	// Every key, by hand: a key missing here reads as undefined inside runSync.
	settings: {
		issuer: new URL(POD).origin,
		pods: [
			{ url: ROOT, folder: 'Pod' },
			{ url: ROOT2, folder: 'Other' },
		],
		clientId: id,
		clientSecret: secret,
		pushDeletions: true,
		syncOnStartup: false,
		syncOnChange: false,
		syncLog: false,
		history: true,
		maxFileMB: 10,
		ignore: [],
	},
	state: {},
	lastSkipped: [],
	saveState: async () => {},
	saveSettings: async () => {},
};

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const HIST = path.join(root, '.obsidian/plugins/solid-sync/history');
const blob = (hash) => {
	const p = path.join(HIST, 'blobs', hash);
	return fs.existsSync(p) ? fs.readFileSync(p) : null;
};
const journal = () =>
	fs.existsSync(path.join(HIST, 'journal.jsonl'))
		? fs.readFileSync(path.join(HIST, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
		: [];
const events = (action, p) => journal().filter((e) => e.action === action && e.path === p);
const write = (p, data) => {
	fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
	fs.writeFileSync(path.join(root, p), data);
};
const local = (p) => fs.readFileSync(path.join(root, p));
const podPut = (rel, body, type = 'text/markdown') =>
	f(ROOT + rel, { method: 'PUT', headers: { 'content-type': type }, body });
const podGet = async (rel) => {
	const res = await f(ROOT + rel, { headers: { 'cache-control': 'no-cache' } });
	return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
};
const sync = async (label) => {
	const result = await runSync(plugin);
	console.log(`  ${label.padEnd(26)}: ${result}`);
	for (const line of plugin.lastSkipped) console.log('     skipped:', line);
	await sleep(1100); // pod timestamps can be second-granular
	return result;
};
const BIN = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

try {
	assert.ok((await podPut('hi-seed.md', '# seed\n')).ok, 'seeding');
	// The second folder's container has to exist, or its listing fails.
	assert.ok((await f(ROOT2 + 'hi-p.md', { method: 'PUT', headers: { 'content-type': 'text/markdown' }, body: '# p\n' })).ok);

	// --- 1. baseline covers every mapped file, before anything changes ----------
	write('Pod/hi-a.md', '# a1\n');
	write('Pod/hi-c.md', '# c1\n');
	write('Pod/deep/hi-b.md', '# b1\n');
	write('Pod/hi-bin.png', BIN);
	write('Other/hi-o.md', '# o1\n');
	write('Loose/hi-x.md', '# not in any pod\n');
	await sync('1. first run');
	const base = journal().filter((e) => e.action === 'baseline');
	assert.deepEqual(
		base.map((e) => `${e.pod === ROOT ? 'P' : e.pod === ROOT2 ? 'O' : '?'} ${e.path}`).sort(),
		['O Other/hi-o.md', 'P Pod/deep/hi-b.md', 'P Pod/hi-a.md', 'P Pod/hi-c.md'],
		'one baseline line per mapped note, none for an attachment, Loose/ or the pod-only note',
	);
	for (const e of base) {
		assert.equal(e.before, null);
		assert.match(e.at, /^\d{4}-\d\d-\d\dT/);
		assert.deepEqual(blob(e.after), local(e.path), `${e.path}: blob holds the file`);
		assert.equal(sha(blob(e.after)), e.after, 'blob is named by its hash');
	}
	assert.equal(blob(sha(BIN)), null, 'attachments are not in the baseline');
	assert.deepEqual(plugin.lastSkipped, []);
	// The pod never sees the history.
	const listing = await (await f(ROOT, { headers: { 'cache-control': 'no-cache' } })).text();
	assert.ok(!/blobs|journal|history/.test(listing), 'history is not on the pod');
	ok('baseline covers every mapped note and nothing else');

	// --- 2. a later run adds no second baseline ----------------------------------
	await sync('2. nothing to do');
	assert.equal(journal().filter((e) => e.action === 'baseline').length, 4);
	ok('baseline runs once per pod folder');

	// --- 3. a pull that changes a note keeps the old local bytes -----------------
	assert.deepEqual(local('Pod/hi-seed.md'), Buffer.from('# seed\n'));
	await podPut('hi-seed.md', '# seed v2\n');
	await sleep(1100);
	await sync('3. pod edit pulled');
	assert.equal(local('Pod/hi-seed.md').toString(), '# seed v2\n');
	assert.equal(blob(sha('# seed\n'))?.toString(), '# seed\n', 'old local bytes in blobs/');
	const pulled = events('pulled', 'Pod/hi-seed.md').at(-1);
	assert.equal(pulled.before, sha('# seed\n'));
	assert.equal(pulled.after, sha('# seed v2\n'));
	ok('a pull leaves the replaced local bytes in blobs/');

	// --- 4. a push over a pod copy keeps the pod's bytes -------------------------
	write('Pod/hi-a.md', '# a2\n');
	await sync('4. push a2');
	write('Pod/hi-a.md', '# a3\n');
	assert.equal(blob(sha('# a2\n')), null, 'a2 only ever lived on the pod and in the vault, not yet in blobs');
	await sync('4. push a3 over a2');
	assert.equal((await podGet('hi-a.md')).toString(), '# a3\n');
	assert.equal(blob(sha('# a2\n'))?.toString(), '# a2\n', 'the pod’s last bytes kept');
	const pushed = events('pushed', 'Pod/hi-a.md').at(-1);
	assert.equal(pushed.before, sha('# a2\n'));
	assert.equal(pushed.after, sha('# a3\n'));
	ok('a push over the pod copy keeps the pod bytes');

	// --- 5. a pushed deletion keeps the pod's last bytes -------------------------
	write('Pod/deep/hi-b.md', '# b2\n');
	await sync('5. push b2');
	fs.unlinkSync(path.join(root, 'Pod/deep/hi-b.md'));
	assert.equal(blob(sha('# b2\n')), null);
	assert.match(await sync('5. delete b'), /1 deleted on pod/);
	assert.equal(await podGet('deep/hi-b.md'), null, 'gone from the pod');
	assert.equal(blob(sha('# b2\n'))?.toString(), '# b2\n', 'its last pod bytes survive');
	const del = events('deleted-pod', 'Pod/deep/hi-b.md').at(-1);
	assert.equal(del.before, sha('# b2\n'));
	assert.equal(del.after, null);
	ok('a pushed deletion leaves the pod’s last bytes in blobs/');

	// --- 6. a deletion on the pod, applied locally, keeps the local bytes --------
	assert.ok((await f(ROOT + 'hi-seed.md', { method: 'DELETE' })).ok);
	await sleep(1100);
	assert.equal(blob(sha('# seed v2\n')), null);
	await sync('6. pod deletion applied');
	assert.deepEqual(vault.trashed, ['Pod/hi-seed.md']);
	assert.equal(blob(sha('# seed v2\n'))?.toString(), '# seed v2\n');
	assert.equal(events('deleted-local', 'Pod/hi-seed.md').at(-1).before, sha('# seed v2\n'));
	ok('a deletion applied locally keeps the local bytes');

	// Bytes the baseline never saw, or the blob already exists and nothing is written.
	const BIN2 = Buffer.from(BIN).reverse();
	write('Pod/hi-c.md', '# c2\n');
	write('Pod/hi-bin.png', BIN2);
	await sync('6b. push c2 and bin2');
	assert.deepEqual(blob(sha(BIN)), BIN, 'an attachment left out of the baseline is stored once overwritten');

	// --- 7. a history write that fails stops that path, on both sides -------------
	const realWrite = vault.adapter.writeBinary;
	vault.adapter.writeBinary = async (p, data) => {
		if (p.includes('/blobs/')) throw new Error('disk full');
		return realWrite(p, data);
	};
	// (a) a pull over a local file
	await podPut('hi-c.md', '# c-from-pod\n');
	await sleep(1100);
	// (b) a push over a pod copy
	write('Pod/hi-a.md', '# a4\n');
	// (c) a pushed deletion
	fs.unlinkSync(path.join(root, 'Pod/hi-bin.png'));
	const lines = journal().length;
	await sync('7. history write failing');
	const skipped = plugin.lastSkipped.join('\n');
	for (const p of ['Pod/hi-c.md', 'Pod/hi-a.md', 'Pod/hi-bin.png']) {
		assert.match(skipped, new RegExp(`${p.replace('.', '\\.')} \\(history write failed: disk full\\)`), `${p} reported`);
	}
	assert.equal(local('Pod/hi-c.md').toString(), '# c2\n', '(a) local file untouched');
	assert.equal((await podGet('hi-c.md')).toString(), '# c-from-pod\n', '(a) pod untouched');
	assert.equal(local('Pod/hi-a.md').toString(), '# a4\n', '(b) local file untouched');
	assert.equal((await podGet('hi-a.md')).toString(), '# a3\n', '(b) pod copy not overwritten');
	assert.deepEqual(await podGet('hi-bin.png'), BIN2, '(c) pod copy not deleted');
	assert.equal(journal().length, lines, 'no journal line for what did not happen');
	ok('a failed history write skips that path and changes neither side');

	// --- 8. the next run, history working again, does what was held back ---------
	vault.adapter.writeBinary = realWrite;
	await sync('8. retry');
	assert.equal(local('Pod/hi-c.md').toString(), '# c-from-pod\n');
	assert.equal(blob(sha('# c2\n'))?.toString(), '# c2\n');
	assert.equal((await podGet('hi-a.md')).toString(), '# a4\n');
	assert.equal(blob(sha('# a3\n'))?.toString(), '# a3\n');
	assert.equal(await podGet('hi-bin.png'), null);
	assert.deepEqual(blob(sha(BIN2)), BIN2);
	assert.deepEqual(plugin.lastSkipped, []);
	ok('the held-back paths go through once the backup can be written');

	// --- 9. off means off ---------------------------------------------------------
	plugin.settings.history = false;
	const before = journal().length;
	write('Pod/hi-a.md', '# a5\n');
	await sync('9. history off');
	assert.equal(journal().length, before, 'no journal line');
	assert.equal(blob(sha('# a4\n')), null, 'nothing stored');
	ok('the setting turns the history off');
} finally {
	for (const rel of ['hi-seed.md', 'hi-a.md', 'hi-c.md', 'hi-bin.png', 'deep/hi-b.md', 'deep/', '']) {
		await f(ROOT + rel, { method: 'DELETE' });
	}
	for (const rel of ['hi-o.md', 'hi-p.md', '']) await f(ROOT2 + rel, { method: 'DELETE' });
}
console.log('history: all passed');
