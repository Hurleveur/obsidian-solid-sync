/**
 * Plugin startup schedules exactly one sync. No network.
 *
 *   node test/startup.mjs
 */
import assert from 'node:assert/strict';
import { SolidSyncPlugin } from './sync.bundle.mjs';

// Timers recorded, never run: the test fires what it needs by hand.
const timers = new Map();
let nextId = 1;
globalThis.window = {
	setTimeout: (fn) => (timers.set(nextId, fn), nextId++),
	clearTimeout: (id) => timers.delete(id),
};

const handlers = {};
let layoutReady;
const app = {
	vault: { on: (name, cb) => ((handlers[name] ??= []).push(cb), {}) },
	workspace: { onLayoutReady: (cb) => (layoutReady = cb) },
};
const emit = (name, path) => (handlers[name] ?? []).forEach((cb) => cb({ path }));

const plugin = new SolidSyncPlugin(app);
plugin.data = {
	// Unreachable on purpose: a run fails fast, which is all `sync()` needs here.
	issuer: 'http://127.0.0.1:9',
	pods: [{ url: 'http://127.0.0.1:9/alex/', folder: 'team/alexandre' }],
	syncOnStartup: false,
	syncOnChange: true,
};
await plugin.onload();

// Obsidian fires `create` for every existing file while the vault loads, before
// layout-ready. None of those may schedule a sync.
emit('create', 'team/alexandre/tasks.md');
emit('create', 'team/alexandre/profile.md');
assert.equal(timers.size, 0, 'vault-load create events scheduled a sync');

layoutReady();
emit('modify', 'team/alexandre/tasks.md');
assert.equal(timers.size, 1, 'an edit after layout-ready schedules one sync');

// A run that starts covers the edit already waiting: its debounced call must not
// fire into the run and report "already running".
const run = plugin.sync();
assert.equal(timers.size, 0, 'starting a run cancels the pending one');
await run;
assert.match(plugin.lastRun.error ?? plugin.lastRun.result, /./, 'the run finished');

console.log('startup: all passed');
