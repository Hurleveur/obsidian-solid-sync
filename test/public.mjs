/**
 * Read-only check against any public pod, no credentials.
 *
 *   POD_URL=https://pod.example.eu/someone/ node test/public.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from './obsidian-stub.mjs';
import { runSync } from './sync.bundle.mjs';

const POD = process.env.POD_URL;
assert(POD, 'POD_URL required');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solid-public-'));
const vault = new Vault(root);
const plugin = {
	app: { vault, fileManager: { trashFile: (f) => vault.trash(f) } },
	settings: {
		podUrl: POD,
		folder: 'Pod',
		clientId: '',
		clientSecret: '',
		pushDeletions: true, // must still be ignored without credentials
		syncOnStartup: false,
	},
	state: {},
	saveState: async () => {},
	saveSettings: async () => {},
};

const first = await runSync(plugin);
console.log('first :', first);
assert.match(first, /read-only \(no credentials\)/);
assert.match(first, /0 pushed/);

const notes = vault.getMarkdownFiles().map((f) => f.path);
assert.ok(notes.length > 0, 'at least one note pulled');
console.log('notes  :', notes.join('\n         '));

const second = await runSync(plugin);
console.log('second:', second);
assert.match(second, /^0 pulled, 0 pushed/, 'second run is a no-op');

// A local edit must never attempt a write against a pod we cannot write to.
fs.appendFileSync(path.join(root, notes[0]), '\nlocal scribble\n');
const third = await runSync(plugin);
assert.match(third, /skipped/);
assert.match(third, /0 pushed/);
console.log('third :', third);

fs.rmSync(root, { recursive: true, force: true });
console.log('\npublic pod checks passed');
