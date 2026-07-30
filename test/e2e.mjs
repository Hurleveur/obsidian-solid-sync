/**
 * End-to-end check against a real pod. Verifies pull, push, conflict handling and
 * both delete directions. Requires POD_URL; POD_ID/POD_SECRET enable the write half.
 *
 * POD_URL_2 adds a second, read-only pod to the same run.
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
/** Any pod we cannot write to — a public one is ideal. Enables the last section. */
const POD_2 = process.env.POD_URL_2;
assert(POD, 'POD_URL required');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solid-vault-'));
const vault = new Vault(root);
const plugin = {
	app: { vault, fileManager: { trashFile: (f) => vault.trash(f) } },
	settings: {
		issuer: new URL(POD).origin,
		pods: [{ url: POD, folder: 'Pod' }],
		clientId: ID ?? '',
		clientSecret: SECRET ?? '',
		pushDeletions: true,
		syncOnStartup: false,
		maxFileMB: 10,
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
assert.doesNotMatch(wrapped, /solid-readonly/);
assert.match(wrapped, /```turtle\n<#a> <#b> "c"\.\n```/);
ok('turtle pulled as a fenced note, with no permission claim baked in');

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

// 5b. attachments travel as bytes, both ways -------------------------------
// A 1x1 PNG: small, but a real one — a text round trip would corrupt it.
const png = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64',
);
await put('e2e-pic.png', png, 'image/png');
await put('e2e-page.html', '<h1>hi</h1>\n', 'text/html');
await runSync(plugin);
assert.deepEqual(fs.readFileSync(path.join(root, 'Pod/e2e-pic.png')), png);
ok('pod image pulled byte for byte, keeping its name');
assert.equal(read('Pod/e2e-page.html'), '<h1>hi</h1>\n');
ok('html pulled as a file, not fenced into a note');

fs.writeFileSync(path.join(root, 'Pod/e2e-doc.pdf'), png); // bytes are bytes
await runSync(plugin);
const pdf = await fetcher(new URL('e2e-doc.pdf', POD).href);
assert.equal(pdf.headers.get('content-type')?.split(';')[0], 'application/pdf');
assert.deepEqual(Buffer.from(await pdf.arrayBuffer()), png);
ok('local attachment pushed with the right content type');
assert.match(await runSync(plugin), /^0 pulled, 0 pushed/);
ok('attachments do not bounce back on the next run');

// 5c. the size limit skips without deleting either copy ---------------------
// One byte, so both the pod image and a fresh local file are over it.
plugin.settings.maxFileMB = 1 / (1024 * 1024);
write('Pod/e2e-big-local.md', '# too big to push\n');
const limited = await runSync(plugin);
assert.match(limited, /skipped/);
assert.equal(
	(await fetcher(new URL('e2e-big-local.md', POD).href)).status,
	404,
	'oversized local file is not pushed',
);
assert.ok(
	fs.existsSync(path.join(root, 'Pod/e2e-pic.png')),
	'oversized pod file already in the vault is left alone, not trashed',
);
assert.equal(
	(await fetcher(new URL('e2e-pic.png', POD).href)).status,
	200,
	'oversized pod file is not deleted either',
);
ok('over the size limit: skipped on both sides, nothing removed');
fs.unlinkSync(path.join(root, 'Pod/e2e-big-local.md'));
plugin.settings.maxFileMB = 10;
await runSync(plugin);

// 6. editing a wrapped RDF note pushes the unwrapped body back -------------
// Read-only is a fact about what the pod says, never about what the note wraps.
write(
	'Pod/e2e-data.ttl.md',
	wrapped.replace('<#a> <#b> "c".', '<#a> <#b> "edited".'),
);
await runSync(plugin);
// The fence trims trailing whitespace on the way in, so a round trip through an
// edit does too — insignificant for turtle, and the price of editing as text.
const ttlAfterEdit = await fetcher(new URL('e2e-data.ttl', POD).href);
assert.equal(await ttlAfterEdit.text(), '<#a> <#b> "edited".');
assert.equal(ttlAfterEdit.headers.get('content-type')?.split(';')[0], 'text/turtle');
ok('editing a wrapped note pushes the unwrapped body back with its content type');
assert.match(await runSync(plugin), /^0 pulled, 0 pushed/);
ok('pushed wrapped note does not bounce back on the next run');

// 6b. a note wrapped by an older version is not a conflict against itself ----
// The frontmatter and fence are ours; only the fenced body is the pod's. Notes
// pulled before `solid-readonly` was dropped must have their wrapper refreshed,
// never announced as a conflict — nothing about the resource changed.
const legacyPath = 'Pod/e2e-data.ttl.md';
write(
	legacyPath,
	read(legacyPath).replace(
		/^(solid-content-type: .+)$/m,
		'$1\nsolid-readonly: true',
	),
);
// Move both sides' recorded state so the run takes the both-changed branch.
plugin.state[legacyPath].pod = 'stale';
plugin.state[legacyPath].local = 0;
assert.match(await runSync(plugin), /^1 pulled|^0 pulled, 0 pushed/);
assert.doesNotMatch(read(legacyPath), /solid-readonly/);
assert.equal(
	fs.readdirSync(path.join(root, 'Pod')).filter((f) => f.includes('conflict')).length,
	0,
	'a wrapper-only difference breeds no conflict copy',
);
ok('an older wrapper is refreshed in place, not reported as a conflict');

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

// 12. a read-only pod alongside a writable one -----------------------------
// The regression test for a refused write aborting the run: the read-only pod is
// listed first, so if its 403 threw, the writable pod would never be reached.
if (POD_2) {
	const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'solid-two-'));
	const vault2 = new Vault(root2);
	const two = {
		app: { vault: vault2, fileManager: { trashFile: (f) => vault2.trash(f) } },
		settings: {
			...plugin.settings,
			pushDeletions: true,
			pods: [
				{ url: POD_2, folder: 'Shared' },
				{ url: POD, folder: 'Pod' },
			],
		},
		state: {},
		saveState: async () => {},
		saveSettings: async () => {},
	};

	console.log('12. two pods:', await runSync(two));
	const shared = vault2.getFiles().filter((f) => f.path.startsWith('Shared/'));
	assert.ok(shared.length > 0, 'the read-only pod pulled into its own folder');
	assert.equal(two.settings.pods[0].access, 'read');
	assert.equal(two.settings.pods[1].access, 'write');
	ok('each pod is mirrored into its own folder, with access discovered');

	fs.appendFileSync(path.join(root2, shared[0].path), '\nnot mine to change\n');
	fs.writeFileSync(path.join(root2, 'Pod/e2e-two.md'), '# written past a 403\n');
	const mixed = await runSync(two);
	console.log('   mixed:', mixed);
	assert.match(mixed, /skipped/);
	assert.match(mixed, /1 pushed/);
	assert.equal(
		await (await fetcher(new URL('e2e-two.md', POD).href)).text(),
		'# written past a 403\n',
		'the writable pod is still synced after the read-only one refuses a write',
	);
	ok('a refused write skips that file and does not abandon the run');

	await del('e2e-two.md');
	fs.rmSync(root2, { recursive: true, force: true });
} else {
	console.log('\n12. POD_URL_2 unset — read-only pod test skipped');
}

// cleanup ------------------------------------------------------------------
await del('e2e-noext');
await del('e2e-keep.md');
await del('e2e-data.ttl');
await del('e2e-pic.png');
await del('e2e-page.html');
await del('e2e-doc.pdf');
fs.rmSync(root, { recursive: true, force: true });
console.log('\nall checks passed');
