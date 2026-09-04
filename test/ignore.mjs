/**
 * Ignore rules, and the vault root as a pod folder. No network.
 *
 *   node test/ignore.mjs
 *
 * Two things are being pinned here. The first is that an ignore pattern means the
 * same on both sides — a path the user has excluded is not pushed, not pulled, and
 * not read as a note they deleted, which is the reading that would delete the pod
 * copy. The second is that `/` in the folder box is the whole vault rather than a
 * folder literally named `/`, which is what it used to be taken for.
 */
import assert from 'node:assert/strict';
import {
	folderClash,
	ignoreMatcher,
	isSyncTrigger,
	nestedFolders,
	ownedBy,
	podPrefix,
	isSyncTrigger as trigger,
} from './sync.bundle.mjs';

// --- podPrefix ---------------------------------------------------------------
// A folder is a prefix ending in a slash; the root is the empty prefix, because
// every path below is built by concatenating onto it.
assert.equal(podPrefix('Pod'), 'Pod/');
assert.equal(podPrefix('Pod/'), 'Pod/');
assert.equal(podPrefix('team/alexandre/pod'), 'team/alexandre/pod/');
assert.equal(podPrefix('/'), '', 'a lone slash is the vault root');
assert.equal(podPrefix(''), '', 'and so is nothing, though no caller passes it');

// --- pattern shapes ----------------------------------------------------------
const m = ignoreMatcher([
	'Attachments/',
	'*.png',
	'Notes/Media/',
	'  ', // blank lines are not patterns
	'# a comment',
]);
const ignored = (p) => m(p, '');

assert.equal(ignored('Attachments/logo.svg'), true, 'a folder, at the root');
assert.equal(
	ignored('Notes/Attachments/logo.svg'),
	true,
	'a bare name matches that folder wherever it sits',
);
assert.equal(ignored('Attachments'), true, 'the folder itself');
assert.equal(ignored('Attachmentsy/logo.svg'), false, 'prefix is not a match');
assert.equal(ignored('deep/nested/shot.png'), true, 'a kind of file, at any depth');
assert.equal(ignored('shot.PNG'), true, 'case-insensitive');
assert.equal(ignored('shot.png.md'), false, '* does not cross the extension');
assert.equal(ignored('Notes/Media/clip.mp4'), true, 'a pattern with a slash is a path');
assert.equal(
	ignored('Other/Notes/Media/clip.mp4'),
	false,
	'and that path is from the vault root, not from anywhere',
);
assert.equal(ignored('Notes/note.md'), false);
assert.equal(ignored('a comment'), false, 'a # line is not a pattern');

// A dot-folder is never the pod's business, whatever the ignore list says. This is
// the rule that keeps `.obsidian/plugins/solid-sync/data.json`, and the pod
// credentials in it, out of a pod when the whole vault is synced.
const none = ignoreMatcher([]);
assert.equal(none('.obsidian/workspace.json', ''), true);
assert.equal(none('.obsidian/plugins/solid-sync/data.json', ''), true);
assert.equal(none('.git/config', ''), true);
assert.equal(none('Notes/.hidden/x.md', ''), true);
assert.equal(none('Notes/note.md', ''), false);

// Measured below the pod's own folder, so a pod whose folder happens to be dotted
// still syncs. Only what is dotted *inside* it is out.
assert.equal(none('.private/note.md', '.private/'), false);
assert.equal(none('.private/.obsidian/x.json', '.private/'), true);

// --- trigger rules -----------------------------------------------------------
// An ignored file must not schedule a sync either. At the vault root this is the
// difference between a quiet plugin and one that syncs every ten seconds forever,
// because Obsidian rewrites its own config constantly.
assert.equal(trigger('.obsidian/workspace.json', '/', false, none), false);
assert.equal(trigger('note.md', '/', false, none), true, 'the root syncs everything');
assert.equal(trigger('deep/nested/note.md', '/', false, none), true);
assert.equal(trigger('Attachments/logo.png', '/', false, m), false);
assert.equal(trigger('Attachments/logo.png', '/', false), true, 'no matcher, no rule');
assert.equal(trigger('note.md', '/', true, none), false, 'busy still wins');
assert.equal(
	isSyncTrigger('note.md', '', false, none),
	false,
	'an unset folder is not the root',
);

// --- the root as a folder ----------------------------------------------------
const pods = (...folders) => folders.map((folder) => ({ url: 'u', folder }));

// Two pods cannot both mirror the vault root: there would be no innermost owner
// for any path in it. Typed differently is still the same folder.
assert.equal(folderClash(pods('/', 'Pod'), 1, '/'), '/');
assert.equal(folderClash(pods('Pod/', 'x'), 1, 'Pod'), 'Pod/');
assert.equal(folderClash(pods('/', 'Pod'), 0, '/'), null, 'not against itself');
assert.equal(folderClash(pods('/', 'Pod'), 1, 'Notes'), null);
assert.equal(folderClash(pods('/'), 0, ''), null, 'a half-typed row clashes with nothing');

// Every other pod sits inside the root one, and keeps its own notes.
assert.deepEqual(nestedFolders(pods('/', 'Work', 'Work/Deep'), '/'), [
	'Work/',
	'Work/Deep/',
]);
assert.deepEqual(nestedFolders(pods('/', 'Work'), 'Work'), [], 'nothing inside Work');
assert.deepEqual(nestedFolders(pods('/', 'Work'), '/'), ['Work/']);

// Removing the root pod drops its history — all of it bar what the pod still filed
// inside it owns.
const state = {
	'note.md': { url: 'u', pod: '', local: 0 },
	'Work/task.md': { url: 'u', pod: '', local: 0 },
};
assert.deepEqual(ownedBy(state, '/', pods('Work')), ['note.md']);
assert.deepEqual(ownedBy(state, '/', pods()), ['note.md', 'Work/task.md']);
// An unset folder owns nothing: read as the root, deleting a half-filled row would
// take every other pod's history with it.
assert.deepEqual(ownedBy(state, '', pods()), []);

console.log('ignore rules and root folder: all checks passed');
