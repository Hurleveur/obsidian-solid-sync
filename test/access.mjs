/**
 * Access discovery and folder-overlap rules. No network.
 *
 *   node test/access.mjs
 */
import assert from 'node:assert/strict';
import {
	canWriteFrom,
	deletedLocally,
	folderClash,
	listContainer,
	matchesLocal,
	migrateSettings,
	nestedFolders,
} from './sync.bundle.mjs';

// --- WAC-Allow ------------------------------------------------------------
const wac = (value) => canWriteFrom(new Headers(value ? { 'WAC-Allow': value } : {}));

assert.equal(wac('user="read write", public="read"'), true);
assert.equal(wac('user="read append write control"'), true);
assert.equal(wac('user="read", public="read"'), false);
assert.equal(wac('user="", public="read"'), false, 'no modes at all is not write');

// Only our own modes count — a world-writable container we may only read is
// still read-only for us.
assert.equal(wac('user="read", public="read write"'), false);

// Case and spacing vary between servers.
assert.equal(wac('USER = "read write"'), true);

// Absent means the server did not say — an ACP pod sends no such header. This
// must stay undefined, not false, or we would refuse to push to a pod that
// would have accepted it.
assert.equal(wac(''), undefined);
assert.equal(wac('public="read"'), false, 'header present but no user group');

// --- folder collision -----------------------------------------------------
const pods = [
	{ url: 'https://a.example/', folder: 'Pod' },
	{ url: 'https://b.example/', folder: 'Work/Shared' },
];

// Free folders.
assert.equal(folderClash(pods, 2, 'Other'), null);
assert.equal(folderClash(pods, 2, 'Podx'), null, 'a shared prefix is not a collision');
assert.equal(folderClash(pods, 2, 'Work/Other'), null, 'siblings are fine');

// Only the very same folder is refused — with two pods on one folder there is no
// innermost, so neither could own a note in it.
assert.equal(folderClash(pods, 2, 'Pod'), 'Pod', 'exactly the same folder');

// Nesting is how one pod is filed inside another, in both directions.
assert.equal(folderClash(pods, 2, 'Pod/friend'), null, 'inside another pod');
assert.equal(folderClash(pods, 2, 'Work'), null, 'around another pod');

// A pod never clashes with itself, or it could not be edited.
assert.equal(folderClash(pods, 0, 'Pod'), null);

// An empty folder is "not configured yet", not a clash with every other pod.
assert.equal(folderClash(pods, 2, ''), null);
assert.equal(
	folderClash([{ url: 'https://a.example/', folder: '' }], 1, 'Pod'),
	null,
);

// --- who owns a path when folders nest ------------------------------------
// Every prefix ends in a slash, so the caller can use it with startsWith.
const nestedPods = [
	{ url: 'https://a.example/', folder: 'Pod' },
	{ url: 'https://b.example/', folder: 'Pod/nicolas' },
	{ url: 'https://c.example/', folder: 'Pod/deep/nested' },
	{ url: 'https://d.example/', folder: 'Podx' },
	{ url: 'https://e.example/', folder: 'Other' },
];

assert.deepEqual(
	nestedFolders(nestedPods, 'Pod'),
	['Pod/nicolas/', 'Pod/deep/nested/'],
	'a pod gives up every folder filed inside its own, at any depth',
);
assert.deepEqual(
	nestedFolders(nestedPods, 'Podx'),
	[],
	'a sibling sharing a prefix takes nothing',
);
assert.deepEqual(
	nestedFolders(nestedPods, 'Pod/nicolas'),
	[],
	'the innermost pod gives up nothing to the one around it',
);
assert.deepEqual(nestedFolders(nestedPods, 'Other'), []);

// The claim is the folder, not the pod: a row still missing its URL must not have
// its notes swept up and pushed to the pod above it.
assert.deepEqual(nestedFolders([{ url: '', folder: 'Pod/nicolas' }], 'Pod'), [
	'Pod/nicolas/',
]);
assert.deepEqual(
	nestedFolders([{ url: 'https://b.example/', folder: '' }], 'Pod'),
	[],
	'a row with no folder claims nothing',
);

// A pod is never inside itself, or it would own none of its own notes.
assert.deepEqual(nestedFolders([{ url: 'https://a.example/', folder: 'Pod' }], 'Pod'), []);

// Nothing is configured yet, or the pod is the whole vault.
assert.deepEqual(nestedFolders(nestedPods, ''), []);
assert.deepEqual(nestedFolders(nestedPods, '/'), []);

// --- reading a media type off a container listing --------------------------
// Servers say it in two different ways and an empty content type is not
// harmless: it classifies RDF as an opaque attachment, so it is pulled as bytes
// instead of a read-only note and a local edit gets pushed back.
const listing = async (nodes) =>
	listContainer(
		async () =>
			new Response(JSON.stringify(nodes), {
				headers: { 'content-type': 'application/ld+json' },
			}),
		'https://a.example/pod/',
	);
const contains = {
	'@id': 'https://a.example/pod/',
	'http://www.w3.org/ns/ldp#contains': [{ '@id': 'https://a.example/pod/note' }],
};

// Community Solid Server: a plain ma-ont#format value.
const ma = await listing([
	contains,
	{
		'@id': 'https://a.example/pod/note',
		'http://www.w3.org/ns/ma-ont#format': [{ '@value': 'text/turtle' }],
	},
]);
assert.equal(ma.children[0].contentType, 'text/turtle');

// Servers that type the resource with an IANA class instead.
const iana = await listing([
	contains,
	{
		'@id': 'https://a.example/pod/note',
		'@type': [
			'http://www.w3.org/ns/ldp#Resource',
			'http://www.w3.org/ns/iana/media-types/text/turtle#Resource',
		],
	},
]);
assert.equal(iana.children[0].contentType, 'text/turtle');

// Said neither way: unknown, and unknown must stay empty rather than guessed.
const silent = await listing([contains, { '@id': 'https://a.example/pod/note' }]);
assert.equal(silent.children[0].contentType, '');

// --- migrating off the single-pod settings --------------------------------
// An existing user must come back with the same pod, still logged in, or their
// next sync would re-download everything into a folder they no longer sync.
const old = migrateSettings({
	podUrl: 'https://pod.example.eu/alex/',
	folder: 'Notes',
	clientId: 'token',
	clientSecret: 'secret',
	pushDeletions: true,
	maxFileMB: 25,
});
assert.deepEqual(old.pods, [{ url: 'https://pod.example.eu/alex/', folder: 'Notes' }]);
assert.equal(old.issuer, 'https://pod.example.eu', 'the issuer is the pod origin');
assert.equal(old.clientId, 'token', 'the token survives — no second login');
assert.equal(old.pushDeletions, true, 'and so do the other settings');
assert.equal(old.maxFileMB, 25);

// A fresh install has no pod and no issuer to guess.
assert.deepEqual(migrateSettings({}).pods, []);
assert.equal(migrateSettings({}).issuer, '');

// Already migrated: the list wins and the stale podUrl is dropped.
const already = migrateSettings({
	podUrl: 'https://old.example/alex/',
	pods: [{ url: 'https://new.example/alex/', folder: 'Pod' }],
	issuer: 'https://new.example',
});
assert.equal(already.pods.length, 1);
assert.equal(already.pods[0].url, 'https://new.example/alex/');
assert.equal(already.issuer, 'https://new.example');
assert.ok(!('podUrl' in already), 'the legacy key does not linger in saved data');

// --- restoring locally deleted notes --------------------------------------
// Only the entries whose file is gone, and the state itself is left alone —
// the caller decides what to drop.
const state = {
	'Pod/kept.md': { url: 'https://a.example/kept' },
	'Pod/gone.md': { url: 'https://a.example/gone' },
	'Pod/image.png': { url: 'https://a.example/image.png' },
};
const onDisk = new Set(['Pod/kept.md']);
assert.deepEqual(
	deletedLocally(state, (path) => onDisk.has(path)),
	['Pod/gone.md', 'Pod/image.png'],
	'attachments count too, not just notes',
);
assert.equal(Object.keys(state).length, 3, 'reads the state, never edits it');
assert.deepEqual(deletedLocally({}, () => false), []);
assert.deepEqual(
	deletedLocally(state, () => true),
	[],
	'nothing to restore when every file is present',
);

// --- a conflict needs different bytes, not just a different timestamp ------
const vaultOf = (text, bytes) => ({
	read: async () => text,
	readBinary: async () => bytes,
});
const bin = (...n) => new Uint8Array(n).buffer;

assert.equal(await matchesLocal(vaultOf('same'), {}, 'same'), true);
assert.equal(await matchesLocal(vaultOf('local'), {}, 'pod'), false);
assert.equal(
	await matchesLocal(vaultOf('trailing\n'), {}, 'trailing'),
	false,
	'whitespace is a real difference — never normalise it away',
);

// Attachments are compared byte for byte, and length alone is not enough.
assert.equal(await matchesLocal(vaultOf('', bin(1, 2, 3)), {}, bin(1, 2, 3)), true);
assert.equal(await matchesLocal(vaultOf('', bin(1, 2, 3)), {}, bin(1, 2, 4)), false);
assert.equal(await matchesLocal(vaultOf('', bin(1, 2)), {}, bin(1, 2, 3)), false);
assert.equal(await matchesLocal(vaultOf('', bin()), {}, bin()), true, 'both empty');

console.log('access rules: all checks passed');
