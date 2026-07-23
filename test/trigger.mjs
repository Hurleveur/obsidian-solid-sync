/**
 * Rules deciding whether a vault event schedules a sync. No network.
 *
 *   node test/trigger.mjs
 */
import assert from 'node:assert/strict';
import { isSyncTrigger } from './sync.bundle.mjs';

const F = 'team/alexandre/pod';

// Notes inside the folder trigger a sync.
assert.equal(isSyncTrigger(`${F}/note.md`, F, false), true);
assert.equal(isSyncTrigger(`${F}/deep/nested/note.md`, F, false), true);

// Everything outside it does not.
assert.equal(isSyncTrigger('other/note.md', F, false), false);
assert.equal(isSyncTrigger('team/alexandre/tasks.md', F, false), false);
assert.equal(isSyncTrigger(`${F}x/note.md`, F, false), false, 'prefix is not a match');
assert.equal(isSyncTrigger(F, F, false), false, 'the folder itself is not a note');

// Attachments sync too, so they trigger a run like any other file.
assert.equal(isSyncTrigger(`${F}/image.png`, F, false), true);
assert.equal(isSyncTrigger(`${F}/doc.pdf`, F, false), true);

// Conflict copies are local scratch and must never start a sync, whatever kind
// of file they are copies of.
assert.equal(
	isSyncTrigger(`${F}/note (pod conflict 2026-07-23T10-19-29-517Z).md`, F, false),
	false,
);
assert.equal(
	isSyncTrigger(`${F}/image (pod conflict 2026-07-23T10-19-29-517Z).png`, F, false),
	false,
);

// The plugin's own writes must not retrigger it — this is the infinite loop guard.
assert.equal(isSyncTrigger(`${F}/note.md`, F, true), false);

// An unset folder must not make every vault edit trigger a sync.
assert.equal(isSyncTrigger('note.md', '', false), false);

console.log('trigger rules: all checks passed');
