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

// Non-notes are ignored.
assert.equal(isSyncTrigger(`${F}/image.png`, F, false), false);

// Conflict copies are local scratch and must never start a sync.
assert.equal(
	isSyncTrigger(`${F}/note (pod conflict 2026-07-23T10-19-29-517Z).md`, F, false),
	false,
);

// The plugin's own writes must not retrigger it — this is the infinite loop guard.
assert.equal(isSyncTrigger(`${F}/note.md`, F, true), false);

// An unset folder must not make every vault edit trigger a sync.
assert.equal(isSyncTrigger('note.md', '', false), false);

console.log('trigger rules: all checks passed');
