/**
 * Conflict copies of notes only we edit. Creates and deletes `cf-*` resources, so
 * use a scratch pod on a local server.
 *
 *   POD_URL=… POD_ID=… POD_SECRET=… node test/conflict.mjs
 *
 * The bug this guards against: desktop Obsidian's `requestUrl` goes through
 * Chromium's HTTP cache, and a pod sends `Last-Modified` with no `Cache-Control`,
 * so the listing re-read after a push came back from before the push. State kept
 * the pod's old timestamp, the next edit read as "both sides changed", and our own
 * previous upload landed as a "(pod conflict …)" copy — and a note pushed for the
 * first time was missing from that listing, so it read as deleted on the pod and
 * was trashed locally. Node's fetch has no cache, so the stub never showed it; the
 * fetch wrapper below plays Chromium's part.
 *
 * Obsidian also updates a `TFile`'s `stat` in place, where the stub hands out a
 * snapshot. Section 4 needs the live one: an edit landing mid-upload used to be
 * read back off it and marked synced without ever being sent.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from './obsidian-stub.mjs';
import { runSync, createFetcher, walk } from './sync.bundle.mjs';

const POD = process.env.POD_URL;
const id = process.env.POD_ID;
const secret = process.env.POD_SECRET;
assert(POD && id && secret, 'POD_URL, POD_ID and POD_SECRET required');

const ROOT = new URL('cf-scratch/', POD).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Chromium's part ----------------------------------------------------------
// `cache` null: straight to the network. `honourNoCache` false: every repeated GET
// is served from the cache, whatever the request says — the worst case, which only
// the hash backstop survives.
const realFetch = globalThis.fetch;
let cache = null;
let honourNoCache = true;
let onPut = null;
globalThis.fetch = async (url, init = {}) => {
	const method = (init.method ?? 'GET').toUpperCase();
	if (method === 'PUT' && onPut) await onPut(String(url));
	if (method !== 'GET' || !cache) return realFetch(url, init);
	const key = String(url);
	const noCache =
		honourNoCache &&
		/no-cache/i.test(new Headers(init.headers).get('cache-control') ?? '');
	const hit = cache.get(key);
	if (hit && !noCache) return new Response(hit.body, hit.init);
	const res = await realFetch(url, init);
	const body = await res.arrayBuffer();
	const resInit = { status: res.status, headers: [...res.headers] };
	if (res.ok) cache.set(key, { body, init: resInit });
	return new Response(body, resInit);
};

const f = await createFetcher(new URL(POD).origin, id, secret);
/** What the pod really says, past any cache. */
const truth = async () => {
	const saved = cache;
	cache = null;
	try {
		return new Map((await walk(f, ROOT)).resources.map((r) => [r.url, r.modified]));
	} finally {
		cache = saved;
	}
};
const podBody = async (url) => {
	const saved = cache;
	cache = null;
	try {
		return await (await f(url)).text();
	} finally {
		cache = saved;
	}
};

const ok = (n) => console.log(`  ok  ${n}`);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-vault-'));
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
	settings: {
		issuer: new URL(POD).origin,
		pods: [{ url: ROOT, folder: 'Pod' }],
		clientId: id,
		clientSecret: secret,
		pushDeletions: false,
		syncOnStartup: false,
		syncOnChange: false,
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
const conflictCopies = () =>
	fs
		.readdirSync(root, { recursive: true })
		.filter((p) => String(p).includes('pod conflict'));
/** One sync, as a user with a fresh Chromium cache entry lifetime would see it. */
const sync = async (label, { freshCache = false } = {}) => {
	if (freshCache && cache) cache.clear();
	const result = await runSync(plugin);
	console.log(`  ${label.padEnd(24)}: ${result}`);
	for (const line of plugin.lastSkipped) console.log('     skipped:', line);
	// A listing cached from before a push lacks the new note, which then reads as
	// deleted on the pod — worse than a conflict copy.
	assert.deepEqual(vault.trashed, [], `${label}: nothing trashed`);
	// Pod timestamps can be second-granular; keep each step in its own second.
	await sleep(1100);
	return result;
};
const created = [];
const note = (name) => {
	created.push(name);
	return { p: `Pod/${name}`, url: `${ROOT}${name}` };
};

try {
	// A container that does not exist is a failed listing, not an empty one.
	const seed = await f(`${ROOT}${note('cf-seed.md').p.slice(4)}`, {
		method: 'PUT',
		headers: { 'content-type': 'text/markdown' },
		body: '# seed\n',
	});
	assert.ok(seed.ok, `seeding (${seed.status})`);

	// --- 1. a cache that honours no-cache -------------------------------------
	cache = new Map();
	honourNoCache = true;
	{
		const { p, url } = note('cf-honour.md');
		write(p, '# one\n');
		await sync('1. new note');
		write(p, '# two\n');
		await sync('1. first edit');
		assert.equal(
			plugin.state[p].pod,
			(await truth()).get(url),
			'state holds the post-upload pod timestamp, not the cached one',
		);
		write(p, '# three\n');
		await sync('1. second edit');
		assert.deepEqual(conflictCopies(), [], 'no conflict copy');
		assert.equal(await podBody(url), '# three\n', 'the pod has the last edit');
	}
	ok('a no-cache listing records the pod as it is after our push');

	// --- 2. a cache that ignores every header -----------------------------------
	cache = new Map();
	honourNoCache = false;
	{
		const { p, url } = note('cf-stale.md');
		write(p, '# one\n');
		await sync('2. new note', { freshCache: true });
		write(p, '# two\n');
		await sync('2. first edit', { freshCache: true });
		write(p, '# three\n');
		await sync('2. second edit', { freshCache: true });
		assert.deepEqual(conflictCopies(), [], 'no conflict copy');
		assert.equal(await podBody(url), '# three\n', 'the pod has the last edit');
	}
	ok('with the listing stale anyway, the content hash still knows our own upload');

	// --- 3. a real change on the pod still conflicts ----------------------------
	{
		const { p, url } = note('cf-real.md');
		write(p, '# one\n');
		await sync('3. new note', { freshCache: true });
		const put = await f(url, {
			method: 'PUT',
			headers: { 'content-type': 'text/markdown' },
			body: '# someone else\n',
		});
		assert.ok(put.ok, `remote edit (${put.status})`);
		await sleep(1100);
		write(p, '# mine\n');
		await sync('3. both edited', { freshCache: true });
		assert.equal(conflictCopies().length, 1, 'one conflict copy');
		assert.equal(fs.readFileSync(path.join(root, p), 'utf8'), '# mine\n');
	}
	ok('a genuine second writer is still a conflict');
	for (const c of conflictCopies()) fs.rmSync(path.join(root, c));

	// --- 4. an edit landing while the upload is in flight -----------------------
	cache = null;
	{
		const { p, url } = note('cf-midflight.md');
		write(p, '# one\n');
		await sync('4. new note');
		write(p, '# two\n');
		onPut = async (u) => {
			if (u !== url) return;
			onPut = null;
			await sleep(20);
			write(p, '# edited during upload\n');
		};
		await sync('4. upload + edit');
		assert.equal(await podBody(url), '# two\n', 'the upload sent what it read');
		await sync('4. next run');
		assert.equal(
			await podBody(url),
			'# edited during upload\n',
			'the mid-upload edit reaches the pod on the next run',
		);
	}
	ok('an edit made during an upload is pushed on the next run, not marked synced');
} finally {
	globalThis.fetch = realFetch;
	for (const n of created) await f(`${ROOT}${n}`, { method: 'DELETE' });
	await f(ROOT, { method: 'DELETE' });
	fs.rmSync(root, { recursive: true, force: true });
}
