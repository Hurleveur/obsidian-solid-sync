/**
 * Access discovery and folder-overlap rules. No network.
 *
 *   node test/access.mjs
 */
import assert from 'node:assert/strict';
import { canWriteFrom, folderClash, migrateSettings } from './sync.bundle.mjs';

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

console.log('access rules: all checks passed');
