/**
 * Settings tab rules: section order, and destructive actions held behind a
 * confirm. Renders against the stub — no network, no Obsidian.
 *
 *   node test/settings-ui.mjs
 */
import assert from 'node:assert/strict';
import {
	folderNote,
	migrateSettings,
	Modal,
	SolidSyncSettingTab,
} from './sync.bundle.mjs';

// --- what a folder box says once it is typed --------------------------------
// `/` is the one entry that does not look like what it does: it reads as a folder
// name and mirrors the whole vault. Saying only "Saved." is how someone syncs their
// entire vault, attachments and all, without being told that is what they asked for.
assert.deepEqual(folderNote('Pod', []), ['Saved.', false]);
assert.equal(folderNote('/', [])[1], true, 'the root with nothing ignored warns');
assert.match(folderNote('/', [])[0], /whole vault/);
assert.match(folderNote('/', [])[0], /nothing is ignored yet/);
assert.equal(
	folderNote('/', ['*.png'])[1],
	false,
	'with patterns set it states the fact without warning',
);
assert.match(folderNote('/', ['*.png'])[0], /whole vault/);
assert.equal(folderNote('', [])[1], true, 'no folder means this pod never syncs');

const files = [
	{ path: 'Pod/note.md' },
	{ path: 'Pod/Attachments/logo.png' },
	{ path: 'Pod/shot.PNG' },
	{ path: 'Work/task.md' },
	{ path: 'Elsewhere/outside.md' },
];

const plugin = {
	app: { vault: { getFiles: () => files } },
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
		'Keep a sync log',
		'Keep local history',
		'Maximum file size (MB)',
		'Ignore',
		'Team members',
		'Team sync',
		'Team roster',
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

// --- the ignore box says what it currently catches ---------------------------
// Counted against the vault as it stands, so a pattern that matches nothing shows
// that while you are typing it rather than in the summary of a run you already made.
const ignoreRow = () => rows().find((s) => s.name === 'Ignore');
const ignoreNote = () => ignoreRow().descEl.children.at(-1).text;
assert.match(ignoreNote(), /^0 patterns\. 0 of 4 files/, 'two pod folders, four files');

const ignoreBox = () =>
	ignoreRow().components.find((c) => c.kind === 'textarea');
await ignoreBox().changed('Attachments/\n*.png');
assert.deepEqual(plugin.settings.ignore, ['Attachments/', '*.png']);
assert.match(
	ignoreNote(),
	/^2 patterns\. 2 of 4 files/,
	'the png and the folder go; case does not matter, and Elsewhere is in no pod',
);

await ignoreBox().changed('  \n\n# only a comment\n');
assert.deepEqual(plugin.settings.ignore, ['# only a comment'], 'blank lines dropped');
assert.match(ignoreNote(), /^1 pattern\. 0 of 4 files/, 'a comment matches nothing');

assert.equal(plugin.settings.roster, '', 'no roster by default');
await rows()
	.find((s) => s.name === 'Team roster')
	.components.find((c) => c.kind === 'text')
	.changed('  https://pod.example/team/membres.ttl ');
assert.equal(plugin.settings.roster, 'https://pod.example/team/membres.ttl');

const confirmButton = (modal, accept) =>
	modal.contentEl.settings[0].components.find(
		(c) => (c.buttonText !== 'Cancel') === accept,
	);

// --- team sync is off until asked, and stopping it asks first ----------------
// Adding other people's pods is a choice: nothing reads the team until the button.
assert.equal(migrateSettings({}).teamSync, false, 'off by default');
// A fresh vault's lists are its own: adding a pod must not change the defaults.
migrateSettings({}).pods.push({ url: 'https://x.example/', folder: 'X' });
assert.deepEqual(migrateSettings({}).pods, [], 'defaults untouched');
assert.equal(migrateSettings({ roster: 'https://x.example/m.ttl' }).teamSync, true, 'a roster saved before the switch keeps syncing');
assert.equal(migrateSettings({ roster: 'https://x.example/m.ttl', teamSync: false }).teamSync, false);
const teamButton = () =>
	rows().find((s) => s.name === 'Team sync').components.find((c) => c.kind === 'button');
plugin.settings.teamSync = false;
tab.display();
assert.equal(teamButton().buttonText, 'Sync my team');
const modals = Modal.opened.length;
await teamButton().clicked();
assert.equal(Modal.opened.length, modals, 'logged out: a notice, no question');
assert.equal(plugin.settings.teamSync, false);

plugin.settings.teamSync = true;
plugin.settings.team = ['neil https://c.example/neil/profile/card#me'];
plugin.settings.pods.push({ url: 'https://c.example/neil/', folder: 'team/neil', roster: true });
plugin.state['team/neil/n.md'] = {};
tab.display();
assert.equal(teamButton().buttonText, 'Stop');
await teamButton().clicked();
assert.equal(plugin.settings.teamSync, true, 'nothing stops before the confirm');
await confirmButton(Modal.opened.at(-1), true).clicked();
assert.equal(plugin.settings.teamSync, false);
assert.deepEqual(plugin.settings.pods.map((p) => p.folder), ['Pod', 'Work'], 'the row team sync added goes, hand rows stay');
assert.deepEqual(plugin.settings.team, []);
assert.ok(!('team/neil/n.md' in plugin.state), 'its sync history goes with it');

// The trash icon only asks — the pod goes when the confirm is accepted.
const trash = (name) =>
	rows()
		.find((s) => s.name === name)
		.components.find((c) => c.kind === 'extra-button');
await trash('Pod 1').clicked();
assert.equal(plugin.settings.pods.length, 2, 'nothing removed before the confirm');

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

// --- logging in needs only a server, not a pod row ----------------------------
// The team comes from the login, so a fresh vault must be able to log in first.
const bare = {
	...plugin,
	app: { vault: { getFiles: () => [] } },
	state: {},
	settings: migrateSettings({}),
};
const bareTab = new SolidSyncSettingTab(bare.app, bare);
bareTab.display();
const modalCount = Modal.opened.length;
await bareTab.containerEl.settings
	.find((s) => s.name === 'Credentials')
	.components.find((c) => c.buttonText === 'Log in')
	.clicked();
assert.equal(Modal.opened.length, modalCount + 1, 'no pod: the login still opens');
const login = Modal.opened.at(-1);
const server = login.contentEl.settings.find((s) => s.name === 'Server').components[0];
assert.equal(server.value, '', 'nothing to guess from');
await server.changed('ftp://pod.example');
await login.contentEl.settings.at(-1).components[0].clicked();
assert.equal(bare.settings.issuer, '', 'a server that is no web address mints nothing');
await rows()
	.find((s) => s.name === 'Credentials')
	.components.find((c) => c.buttonText === 'Log in')
	.clicked();
assert.equal(
	Modal.opened.at(-1).contentEl.settings.find((s) => s.name === 'Server').components[0].value,
	'https://b.example',
	"with a pod, its server is the guess",
);

console.log('settings ui: all checks passed');
