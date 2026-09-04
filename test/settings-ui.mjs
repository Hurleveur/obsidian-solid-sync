/**
 * Settings tab rules: section order, and destructive actions held behind a
 * confirm. Renders against the stub — no network, no Obsidian.
 *
 *   node test/settings-ui.mjs
 */
import assert from 'node:assert/strict';
import { migrateSettings, Modal, SolidSyncSettingTab } from './sync.bundle.mjs';

const plugin = {
	app: {},
	// Two synced notes, one under each pod's folder: removing a pod has to take
	// its history with it and leave the other pod's alone.
	state: { 'Pod/kept.md': {}, 'Work/kept.md': {} },
	lastRun: { at: '2026-08-15T08:00:00.000Z', result: 'up to date' },
	settings: migrateSettings({
		pods: [
			{ url: 'https://a.example/', folder: 'Pod' },
			{ url: 'https://b.example/', folder: 'Work' },
		],
	}),
	async saveSettings() {},
	async saveState() {},
	async sync() {},
};

const tab = new SolidSyncSettingTab(plugin.app, plugin);
tab.display();

// The tab reads top to bottom: happening now, connected, how it syncs, rare.
const rows = () => tab.containerEl.settings;
assert.deepEqual(
	rows().map((s) => s.name),
	[
		'Status',
		'Pods',
		'Pod 1',
		'Pod 2',
		'Credentials',
		'Syncing',
		'Sync on startup',
		'Sync after changes',
		'Maximum file size (MB)',
		'Ignore',
		'Deleted notes',
		'Delete on pod when a note is deleted',
		'Restore deleted notes',
	],
);
assert.deepEqual(
	rows()
		.filter((s) => s.heading)
		.map((s) => s.name),
	['Pods', 'Syncing', 'Deleted notes'],
);

// The trash icon only asks — the pod goes when the confirm is accepted.
const trash = (name) =>
	rows()
		.find((s) => s.name === name)
		.components.find((c) => c.kind === 'extra-button');
await trash('Pod 1').clicked();
assert.equal(plugin.settings.pods.length, 2, 'nothing removed before the confirm');

const confirmButton = (modal, accept) =>
	modal.contentEl.settings[0].components.find(
		(c) => (c.buttonText !== 'Cancel') === accept,
	);
await confirmButton(Modal.opened.at(-1), true).clicked();
assert.equal(plugin.settings.pods.length, 1, 'accepted: the pod is removed');
assert.equal(plugin.settings.pods[0].folder, 'Work', 'and it was the right one');
assert.deepEqual(
	Object.keys(plugin.state),
	['Work/kept.md'],
	"the removed pod's sync history goes with it, the other pod's stays",
);

// Cancelling instead leaves the list exactly as it is.
await trash('Pod 1').clicked();
confirmButton(Modal.opened.at(-1), false).clicked();
assert.equal(plugin.settings.pods.length, 1);
assert.equal(plugin.settings.pods[0].folder, 'Work');

console.log('settings ui: all checks passed');
