/**
 * End-to-end check against a real pod. Verifies pull, push, conflict handling and
 * both delete directions. Requires POD_URL; POD_ID/POD_SECRET enable the write half.
 *
 *   node test/e2e.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from './obsidian-stub.mjs';
import { runSync } from './sync.bundle.mjs';
import { createFetcher, anonymousFetch } from './sync.bundle.mjs';

const POD = process.env.POD_URL;
const ID = process.env.POD_ID;
const SECRET = process.env.POD_SECRET;
assert(POD, 'POD_URL required');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solid-vault-'));
const vault = new Vault(root);
const plugin = {
	app: { vault, fileManager: { trashFile: (f) => vault.trash(f) } },
	settings: {
		podUrl: POD,
		folder: 'Pod',
		clientId: ID ?? '',
		clientSecret: SECRET ?? '',
		pushDeletions: true,
		syncOnStartup: false,
	},
	state: {},
	saveState: async () => {},
	saveSettings: async () => {},
};

const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const write = (p, s) => {
	fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
	fs.writeFileSync(path.join(root, p), s);
};
const fetcher = ID ? await createFetcher(POD, ID, SECRET) : anonymousFetch;
const put = (rel, body, type = 'text/markdown') =>
	fetcher(new URL(rel, POD).href, {
		method: 'PUT',
		headers: { 'content-type': type },
		body,
	});
const del = (rel) => fetcher(new URL(rel, POD).href, { method: 'DELETE' });
const ok = (name) => console.log(`  ok  ${name}`);

console.log('vault:', root);

// 1. pull ------------------------------------------------------------------
await put('e2e-pull.md', '# from pod\n');
await put('e2e-data.ttl', '<#a> <#b> "c".\n', 'text/turtle');
console.log('1. pull:', await runSync(plugin));
assert.equal(read('Pod/e2e-pull.md'), '# from pod\n');
ok('markdown pulled verbatim');
const wrapped = read('Pod/e2e-data.ttl.md');
assert.match(wrapped, /solid-readonly: true/);
assert.match(wrapped, /```turtle\n<#a> <#b> "c"\.\n```/);
ok('turtle pulled as a read-only note with fenced source');

// 1b. extensionless markdown (the pod's own README is stored this way) -------
// It must land on a .md path, or the vault cannot see it and the next sync
// mistakes it for a locally deleted note and wipes it from the pod.
if (ID) {
	await put('e2e-noext', '# no extension\n');
	await runSync(plugin);
	assert.equal(read('Pod/e2e-noext.md'), '# no extension\n');
	await runSync(plugin);
	await runSync(plugin);
	assert.equal(
		(await fetcher(new URL('e2e-noext', POD).href)).status,
		200,
		'extensionless resource survives repeated syncs',
	);
	ok('extensionless markdown maps to a .md note and is not deleted');
}

// 2. no-op -----------------------------------------------------------------
const second = await runSync(plugin);
assert.match(second, /^0 pulled, 0 pushed/);
ok('second run is a no-op');

if (!ID) {
	console.log('\nno credentials — write tests skipped');
	process.exit(0);
}

// 3. push new local note ---------------------------------------------------
write('Pod/e2e-local.md', '# from obsidian\n');
console.log('3. push:', await runSync(plugin));
const pushed = await fetcher(new URL('e2e-local.md', POD).href);
assert.equal(await pushed.text(), '# from obsidian\n');
ok('new local note pushed to pod');
assert.match(await runSync(plugin), /^0 pulled, 0 pushed/);
ok('pushed note does not bounce back on next run');

// 4. local edit pushes -----------------------------------------------------
write('Pod/e2e-local.md', '# edited locally\n');
await runSync(plugin);
assert.equal(
	await (await fetcher(new URL('e2e-local.md', POD).href)).text(),
	'# edited locally\n',
);
ok('local edit pushed');

// 5. remote edit pulls -----------------------------------------------------
await put('e2e-local.md', '# edited on pod\n');
await runSync(plugin);
assert.equal(read('Pod/e2e-local.md'), '# edited on pod\n');
ok('remote edit pulled');

// 6. read-only note is never pushed ----------------------------------------
write('Pod/e2e-data.ttl.md', 'tampered\n');
const roRun = await runSync(plugin);
assert.match(roRun, /skipped/);
assert.equal(
	await (await fetcher(new URL('e2e-data.ttl', POD).href)).text(),
	'<#a> <#b> "c".\n',
);
ok('edit to a read-only note is skipped, pod untouched');
await runSync(plugin);

// 7. conflict: both sides change -------------------------------------------
write('Pod/e2e-local.md', '# local version\n');
await put('e2e-local.md', '# pod version\n');
const conflictRun = await runSync(plugin);
assert.match(conflictRun, /1 conflicts/);
assert.equal(read('Pod/e2e-local.md'), '# local version\n');
const copy = fs
	.readdirSync(path.join(root, 'Pod'))
	.find((f) => f.includes('pod conflict'));
assert.ok(copy, 'conflict copy written');
assert.equal(read(`Pod/${copy}`), '# pod version\n');
ok('conflict keeps local, saves pod copy beside it');

const copies = () =>
	fs.readdirSync(path.join(root, 'Pod')).filter((f) => f.includes('pod conflict'));
assert.match(await runSync(plugin), /^0 pulled, 0 pushed/);
assert.doesNotMatch(await runSync(plugin), /conflict/);
assert.deepEqual(copies(), [copy], 'exactly one conflict copy after re-syncs');
ok('a reported conflict is not reported again, and breeds no extra files');
assert.equal(
	(await fetcher(new URL(encodeURI(copy), POD).href)).status,
	404,
	'conflict copy must never reach the pod',
);
ok('conflict copy is not pushed to the pod');
fs.unlinkSync(path.join(root, 'Pod', copy));

// resolve the conflict the way a user would: keep local, push it
write('Pod/e2e-local.md', '# local version resolved\n');
await runSync(plugin);
assert.equal(
	await (await fetcher(new URL('e2e-local.md', POD).href)).text(),
	'# local version resolved\n',
);
assert.match(await runSync(plugin), /^0 pulled, 0 pushed/);
ok('editing the local note resolves the conflict');

// 8. remote delete trashes local -------------------------------------------
await del('e2e-pull.md');
await runSync(plugin);
assert.ok(!fs.existsSync(path.join(root, 'Pod/e2e-pull.md')));
assert.ok(vault.trashed.includes('Pod/e2e-pull.md'));
ok('remote delete trashes the local note (recoverable)');

// 9. local delete removes remote (opt-in) ----------------------------------
fs.unlinkSync(path.join(root, 'Pod/e2e-local.md'));
await runSync(plugin);
assert.equal((await fetcher(new URL('e2e-local.md', POD).href)).status, 404);
ok('local delete removes the pod resource when enabled');

// 10. same, with the option off --------------------------------------------
await put('e2e-keep.md', '# keep me\n');
await runSync(plugin);
plugin.settings.pushDeletions = false;
fs.unlinkSync(path.join(root, 'Pod/e2e-keep.md'));
const kept = await runSync(plugin);
assert.match(kept, /skipped/);
assert.equal((await fetcher(new URL('e2e-keep.md', POD).href)).status, 200);
ok('with deletions off, the pod copy survives');

// 11. mass deletion is refused ---------------------------------------------
plugin.settings.pushDeletions = true;
await runSync(plugin);
const before = (await import('./sync.bundle.mjs')).walk;
fs.rmSync(path.join(root, 'Pod'), { recursive: true });
const wiped = await runSync(plugin);
assert.match(wiped, /skipped/);
const survivors = (await before(fetcher, POD)).resources.length;
assert.ok(survivors >= 3, `pod kept its resources (${survivors})`);
assert.equal((await fetcher(new URL('README', POD).href)).status, 200);
ok('a wiped folder does not empty the pod');

// cleanup ------------------------------------------------------------------
await del('e2e-noext');
await del('e2e-keep.md');
await del('e2e-data.ttl');
fs.rmSync(root, { recursive: true, force: true });
console.log('\nall checks passed');
