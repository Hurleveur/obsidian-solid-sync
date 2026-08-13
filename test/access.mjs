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
	markReadOnly,
	matchesLocal,
	migrateSettings,
	nestedFolders,
	staleBindings,
	stripReadOnly,
	unwrapNonMarkdown,
	wrapNonMarkdown,
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

// --- state left by a pod pointed at a different container ------------------
// Taken from a real vault: a folder was pulled from one pod, the row was then
// repointed at another, and the entries kept naming the first. Their paths then
// read as notes deleted locally, so what the new pod holds there is skipped on
// every run and never pulled.
const alex = 'https://pod.example.eu/alex/';
const other = 'https://pod.example.eu/hyperscope/';
const nothingClaimed = () => false;
const repointed = {
	'Pod/README.md': { url: `${other}README`, pod: '', local: 1 },
	'Pod/profile/card.md': { url: `${other}profile/card`, pod: '', local: 1 },
	'Pod/shared/memory.md': { url: `${alex}shared/memory.md`, pod: '', local: 1 },
	'Elsewhere/note.md': { url: `${other}note.md`, pod: '', local: 1 },
};
assert.deepEqual(
	staleBindings(repointed, 'Pod', alex, nothingClaimed),
	['Pod/README.md', 'Pod/profile/card.md'],
	'exactly the entries naming the pod that is no longer mirrored here',
);
// Another pod's folder is another pod's business, even when its entries are stale
// for it too — this run only knows what its own root should contain.
assert.deepEqual(staleBindings(repointed, 'Elsewhere', other, nothingClaimed), []);
// The folder is a path segment, not a string prefix: `Pod2` is not inside `Pod`.
assert.deepEqual(
	staleBindings({ 'Pod2/x.md': { url: `${other}x.md`, pod: '', local: 1 } }, 'Pod', alex, nothingClaimed),
	[],
);
// And neither is a container whose name merely starts with ours.
assert.deepEqual(
	staleBindings({ 'Pod/x.md': { url: 'https://pod.example.eu/alexandre/x.md', pod: '', local: 1 } }, 'Pod', alex, nothingClaimed),
	['Pod/x.md'],
	'a longer pod name is a different pod',
);
// A pod filed inside this folder holds entries naming its own container, which is
// exactly what "not ours" looks like from here. Dropping them would take another
// pod's history with it, and the notes behind it — they belong to the innermost
// folder, and this pod does not get a say.
const inner = nestedFolders([{ url: other, folder: 'Pod/nicolas' }], 'Pod');
assert.deepEqual(inner, ['Pod/nicolas/'], 'the inner folder is the one claimed');
assert.deepEqual(
	staleBindings(
		{ 'Pod/nicolas/README.md': { url: `${other}README`, pod: '', local: 1 } },
		'Pod',
		alex,
		(p) => inner.some((n) => p.startsWith(n)),
	),
	[],
	'the inner pod’s entries are never the outer pod’s to forget',
);

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

// --- the fenced wrapper is ours, and only the body is the pod's ------------
const wrap = (props, body) =>
	`---\nsolid-url: https://pod.example.eu/x/README\n${props}---\n\n\`\`\`plain\n${body}\n\`\`\`\n`;

assert.deepEqual(unwrapNonMarkdown(wrap('solid-content-type: text/turtle\n', '<#a> <#b> "c".')), {
	contentType: 'text/turtle',
	body: '<#a> <#b> "c".',
});

// Notes pulled by an older version carry `solid-readonly: true`. Dropping that
// line from the wrapper must not read as the resource itself having changed —
// which is what bred a conflict copy against the note's own former format.
const legacy = wrap('solid-content-type: text/plain\nsolid-readonly: true\n', 'hello');
assert.notEqual(legacy, wrap('solid-content-type: text/plain\n', 'hello'));
assert.equal(unwrapNonMarkdown(legacy)?.body, 'hello');
assert.equal(
	unwrapNonMarkdown(legacy)?.body,
	unwrapNonMarkdown(wrap('solid-content-type: text/plain\n', 'hello'))?.body,
	'same body, different wrapper — never a conflict',
);

// A multi-line body keeps every line, and an empty one round-trips.
assert.equal(unwrapNonMarkdown(wrap('solid-content-type: text/plain\n', 'a\n\nb'))?.body, 'a\n\nb');
assert.equal(unwrapNonMarkdown(wrap('solid-content-type: text/plain\n', ''))?.body, '');

// Not a wrapped note at all, or a fence the user broke: refuse, never guess.
assert.equal(unwrapNonMarkdown('# an ordinary note\n'), null);
assert.equal(unwrapNonMarkdown('---\nsolid-content-type: text/plain\n---\n\nno fence\n'), null);

// --- solid-readonly states a permission, never a kind ---------------------
// The whole point of the property: it answers "may I edit this", so it tracks
// what the pod said about this resource and nothing about it being RDF.
const res = { url: 'https://pod.example.eu/x/card', contentType: 'text/turtle' };

assert.doesNotMatch(
	wrapNonMarkdown(res, '<#a> <#b> "c".', true),
	/solid-readonly/,
	'our own resource is never labelled read-only',
);
assert.match(
	wrapNonMarkdown(res, '<#a> <#b> "c".', false),
	/^solid-readonly: true$/m,
	"a resource the pod refuses us says so",
);
assert.doesNotMatch(
	wrapNonMarkdown(res, '<#a> <#b> "c".', undefined),
	/solid-readonly/,
	'an ACP server sent no WAC-Allow — it refused nothing, so claim nothing',
);

// A markdown note carries the same answer, as one property and never a fence —
// fencing it would break the links, embeds and graph the notes exist for.
assert.equal(markReadOnly('# hello\n'), '---\nsolid-readonly: true\n---\n# hello\n');
assert.equal(stripReadOnly(markReadOnly('# hello\n')), '# hello\n');

// A note with properties of its own keeps one block, not two — a second one is
// not frontmatter, it is body text with dashes in it.
const own = '---\ntitle: mine\ntags: [a]\n---\n# hello\n';
assert.equal(markReadOnly(own), '---\nsolid-readonly: true\ntitle: mine\ntags: [a]\n---\n# hello\n');
assert.equal(stripReadOnly(markReadOnly(own)), own, 'the note gets its own properties back');

// Never marked, or marked and pushed already: leave it exactly as it is.
assert.equal(stripReadOnly('# hello\n'), '# hello\n');
assert.equal(stripReadOnly(own), own);
assert.equal(stripReadOnly(''), '');
// Only our own property is removed, never a `solid-readonly` further down.
const notOurs = '---\ntitle: mine\nsolid-readonly: true\n---\nx\n';
assert.equal(stripReadOnly(notOurs), notOurs);

// Whatever the label, the body round-trips and the type is preserved.
for (const canWrite of [true, false, undefined]) {
	assert.deepEqual(unwrapNonMarkdown(wrapNonMarkdown(res, 'x\ny', canWrite)), {
		contentType: 'text/turtle',
		body: 'x\ny',
	});
}

console.log('access rules: all checks passed');
