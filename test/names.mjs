/**
 * New notes whose names carry URL-reserved characters. Creates and deletes `nm-*`
 * resources, so use a scratch pod.
 *
 *   POD_URL=… POD_ID=… POD_SECRET=… node test/names.mjs
 *
 * The bug this guards against: a new note's URL was built with `encodeURI`, which
 * leaves `,` `;` `&` `=` `+` `$` `@` `:` as they are. The server stores the name with
 * those characters escaped, so the DPoP proof, signed over the raw URL, no longer
 * matched the one the server checked. The PUT came back 401 and the note was
 * reported as "no write access" on a container the user could write.
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
const ROOT = new URL('nm-scratch/', POD).href;
const NOTES = [
	'Aug 2, 2026.md',
	'a & b = c.md',
	'one+two.md',
	'semi;colon.md',
	'at@home $5.md',
	'café.md',
	'sub, dir/inner, note.md',
];
const BINARY = 'sub, dir/Image, 06_03 PM.png';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'names-vault-'));
const vault = new Vault(root);
const plugin = {
	app: { vault, fileManager: { trashFile: (file) => vault.trash(file) } },
	settings: {
		issuer: new URL(POD).origin,
		pods: [{ url: ROOT, folder: 'Pod' }],
		clientId: id,
		clientSecret: secret,
		pushDeletions: false,
		syncOnStartup: false,
		maxFileMB: 10,
		syncOnChange: false,
		ignore: [],
	},
	state: {},
	lastSkipped: [],
	saveState: async () => {},
	saveSettings: async () => {},
};
const ok = (n) => console.log(`  ok  ${n}`);

// A failed run exits before its cleanup; clear what it may have left.
const podUrl = (n) => ROOT + n.split('/').map(encodeURIComponent).join('/');
for (const n of [...NOTES, BINARY]) await f(podUrl(n), { method: 'DELETE' });
await f(ROOT, { method: 'PUT', headers: { 'content-type': 'text/turtle' } });
for (const n of NOTES) await vault.create(`Pod/${n}`, `# ${n}\n`);
await vault.createBinary(`Pod/${BINARY}`, PNG);

// --- 1. every new note is pushed ------------------------------------------------
const first = await runSync(plugin);
console.log('1. push :', first);
assert.deepEqual(plugin.lastSkipped, [], 'nothing skipped');
assert.match(first, new RegExp(`^0 pulled, ${NOTES.length + 1} pushed`));
ok('reserved characters in a name do not read as a refused write');

// --- 2. each one landed under its own name, byte for byte -----------------------
for (const n of NOTES) {
	const entry = plugin.state[`Pod/${n}`];
	assert.ok(entry, `state entry for ${n}`);
	const res = await f(entry.url);
	assert.equal(res.status, 200, `${n} readable at ${entry.url}`);
	assert.equal(await res.text(), `# ${n}\n`, `${n} content`);
	assert.equal(decodeURIComponent(entry.url.slice(ROOT.length)), n, `${n} name`);
}
const bin = await f(plugin.state[`Pod/${BINARY}`].url);
assert.ok(Buffer.from(await bin.arrayBuffer()).equals(PNG), 'binary bytes');
ok('the pod holds every note under the name it has in the vault');

// --- 3. the next run sees nothing to do -----------------------------------------
const second = await runSync(plugin);
console.log('3. again:', second);
assert.match(second, /^0 pulled, 0 pushed/, 'the URL we pushed to is the one the listing returns');
assert.deepEqual(plugin.lastSkipped, []);
ok('a second run settles: no pull, no push, no conflict copy');

for (const p of Object.keys(plugin.state)) await f(plugin.state[p].url, { method: 'DELETE' });
await f(new URL('sub%2C%20dir/', ROOT).href, { method: 'DELETE' });
await f(ROOT, { method: 'DELETE' });
fs.rmSync(root, { recursive: true, force: true });
console.log('\nreserved names: all checks passed');
