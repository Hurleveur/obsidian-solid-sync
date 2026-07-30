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
	markReadOnly,
	matchesLocal,
	migrateSettings,
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

// --- folder overlap -------------------------------------------------------
const pods = [
	{ url: 'https://a.example/', folder: 'Pod' },
	{ url: 'https://b.example/', folder: 'Work/Shared' },
];

// Free folders.
assert.equal(folderClash(pods, 2, 'Other'), null);
assert.equal(folderClash(pods, 2, 'Podx'), null, 'a shared prefix is not an overlap');
assert.equal(folderClash(pods, 2, 'Work/Other'), null, 'siblings are fine');

// Taken, in every direction.
assert.equal(folderClash(pods, 2, 'Pod'), 'Pod', 'exactly the same folder');
assert.equal(folderClash(pods, 2, 'Pod/friend'), 'Pod', 'nested inside another');
assert.equal(folderClash(pods, 2, 'Work'), 'Work/Shared', 'a parent of another');

// A pod never clashes with itself, or it could not be edited.
assert.equal(folderClash(pods, 0, 'Pod'), null);

// An empty folder is "not configured yet", not a clash with every other pod.
assert.equal(folderClash(pods, 2, ''), null);
assert.equal(
	folderClash([{ url: 'https://a.example/', folder: '' }], 1, 'Pod'),
	null,
);

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
