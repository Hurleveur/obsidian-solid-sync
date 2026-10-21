/**
 * The login dialog against a real account API: from an empty vault, logging in
 * offers your pod (and asks which, when the account has several), mints the token
 * for the pod picked, and offers your team when your profile names one. Needs a
 * local CSS with two throwaway accounts on one password: TWO_EMAIL owning two pods,
 * ONE_EMAIL owning one. The suite writes `lg-team/` in ONE's pod and adds, then
 * removes, an `org:memberOf` in ONE's profile.
 *
 *   SERVER=http://localhost:3017 TWO_EMAIL=… ONE_EMAIL=… PASSWORD=… node test/login.mjs
 */
import assert from 'node:assert/strict';
import {
	createClientCredentials,
	createFetcher,
	findTeam,
	logInToAccount,
	migrateSettings,
	Modal,
	Notice,
	SolidSyncSettingTab,
} from './sync.bundle.mjs';

const { SERVER, TWO_EMAIL, ONE_EMAIL, PASSWORD } = process.env;
assert(SERVER && TWO_EMAIL && ONE_EMAIL && PASSWORD, 'SERVER, TWO_EMAIL, ONE_EMAIL and PASSWORD required');
const ok = (n) => console.log(`  ok  ${n}`);

const until = async (cond, what) => {
	for (let i = 0; i < 100; i++) {
		if (cond()) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	assert.fail(`timed out waiting for ${what}`);
};

// A vault with nothing set: no pod, no team, not logged in.
const bareVault = () => {
	const plugin = {
		app: { vault: { getFiles: () => [] } },
		state: {},
		settings: migrateSettings({}),
		synced: 0,
		async saveSettings() {},
		async saveState() {},
		async sync() {
			plugin.synced++;
		},
	};
	const tab = new SolidSyncSettingTab(plugin.app, plugin);
	tab.display();
	return { plugin, tab };
};
const row = (modal, name) => modal.contentEl.settings.find((s) => s.name === name);
const buttonIn = (modal, text) =>
	modal.contentEl.settings.flatMap((s) => s.components).find((c) => c.buttonText === text);

async function openLogin(tab, email) {
	await tab.containerEl.settings
		.find((s) => s.name === 'Account')
		.components.find((c) => /^Log in/.test(c.buttonText))
		.clicked();
	const modal = Modal.opened.at(-1);
	await row(modal, 'Server').components[0].changed(SERVER);
	await row(modal, 'Email').components[0].changed(email);
	const pw = row(modal, 'Password').components[0];
	await pw.changed(PASSWORD);
	return { modal, pw };
}

// --- 1. two pods: pick one, and the token acts as that pod's WebID -----------
{
	const two = await logInToAccount(SERVER, TWO_EMAIL, PASSWORD);
	assert.equal(two.pods.length, 2, 'the fixture account owns two pods');
	const [, second] = two.pods;

	const { plugin, tab } = bareVault();
	const { modal, pw } = await openLogin(tab, TWO_EMAIL);
	// Enter in the password box is the Log in button.
	pw.typed('Enter');
	await until(() => modal.title === 'Which pod is yours?', 'the pod choice');
	const pick = row(modal, 'Your pod').components[0];
	assert.deepEqual(pick.options.map(([v]) => v), two.pods);
	assert.equal(pick.value, two.pods[0], 'the first is preselected');
	await pick.changed(second);
	await buttonIn(modal, 'Continue').clicked();
	assert.equal(modal.title, 'What to sync');
	assert.ok(plugin.settings.clientId, 'the token is saved before the last screen');
	assert.ok(plugin.settings.webId.startsWith(second), `acts as ${plugin.settings.webId}`);
	const fetcher = await createFetcher(plugin.settings.issuer, plugin.settings.clientId, plugin.settings.clientSecret);
	assert.equal(fetcher.webId, plugin.settings.webId, 'the server agrees who the token is');
	ok('two pods: the one picked is who the token acts as');

	const folder = row(modal, 'Folder in this vault').components[0];
	assert.equal(folder.value, 'team/second', 'no team: team/<pod name> is the folder');
	assert.equal(row(modal, 'Folder in this vault').desc.includes(second), true);
	await folder.changed('  ');
	await buttonIn(modal, 'Start syncing').clicked();
	assert.equal(plugin.settings.pods.length, 0, 'no folder: nothing added');
	assert.match(row(modal, 'Folder in this vault').descEl.children.at(-1).text, /Pick a folder/);
	await folder.changed('Mine');
	await buttonIn(modal, 'Start syncing').clicked();
	assert.deepEqual(plugin.settings.pods, [{ url: second, folder: 'Mine' }]);
	assert.equal(plugin.settings.teamSync, false);
	assert.equal(plugin.synced, 1, 'and it syncs');
	ok('your pod lands as a row, at the folder you gave');

	// Logging in again with that pod synced offers nothing more: the dialog just closes.
	const again = await openLogin(tab, TWO_EMAIL);
	await buttonIn(again.modal, 'Log in').clicked();
	assert.equal(row(again.modal, 'Your pod').components[0].value, second, 'the synced pod is preselected');
	const tokenBefore = plugin.settings.clientId;
	await buttonIn(again.modal, 'Continue').clicked();
	assert.equal(again.modal.closed, true, 'no setup screen: the dialog closes');
	assert.match(Notice.shown.at(-1), /already syncs at Mine/);
	assert.notEqual(plugin.settings.clientId, tokenBefore, 'a new token is saved');
	assert.equal(plugin.settings.pods.length, 1, 'no second row');
	ok('logging in again with your pod synced adds nothing');
}

// --- 2. one pod in a team: no choice, the team offered with its names --------
{
	const own = await createClientCredentials(SERVER, ONE_EMAIL, PASSWORD);
	const owner = await createFetcher(SERVER, own.clientId, own.clientSecret);
	const POD = new URL('../', owner.webId).href;
	const CONFIG = `${POD}lg-team/config.ttl`;
	const put = (url, body) =>
		owner(url, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body });
	const memberOf = (op) =>
		owner(owner.webId.replace(/#.*/, ''), {
			method: 'PATCH',
			headers: { 'content-type': 'text/n3' },
			body: `@prefix solid: <http://www.w3.org/ns/solid/terms#>.
_:p a solid:InsertDeletePatch; solid:${op} { <${owner.webId}> <http://www.w3.org/ns/org#memberOf> <${CONFIG}#team> . }.`,
		});
	try {
		assert.ok((await put(CONFIG, '<#team> <https://pod.nicolasdb.eu/hyperscope/vocab#roster> <membres.ttl> ; <http://xmlns.com/foaf/0.1/name> "Lg team" .\n')).ok);
		assert.ok((await put(`${POD}lg-team/membres.ttl`,
			`<config.ttl#team> <http://xmlns.com/foaf/0.1/member> <${owner.webId}>, <https://pod.example/neil/profile/card#me> .\n` +
			`<${owner.webId}> <http://xmlns.com/foaf/0.1/nick> "me" .\n<https://pod.example/neil/profile/card#me> <http://xmlns.com/foaf/0.1/nick> "neil" .\n`)).ok);
		assert.ok((await memberOf('inserts')).ok);
		// The backoffice's layout: the shared pod is `vault/` beside config.ttl.
		const VAULT = `${POD}lg-team/vault/`;
		assert.ok((await put(`${VAULT}hello.md`, 'hello')).ok);

		const { plugin, tab } = bareVault();
		const { modal } = await openLogin(tab, ONE_EMAIL);
		await buttonIn(modal, 'Log in').clicked();
		assert.equal(modal.title, 'What to sync', 'one pod: no choice to make');
		assert.equal(row(modal, 'Folder in this vault').components[0].value, 'team/me', 'listed in the team: its folder');
		const team = row(modal, 'Sync Lg team');
		assert.ok(team, 'the team is offered by name');
		assert.match(team.desc, /2 members \(me, neil\) at team\/<their name>, and its shared pod at projects\//);
		assert.equal(team.components[0].value, true);
		await buttonIn(modal, 'Start syncing').clicked();
		assert.equal(modal.closed, true);
		assert.deepEqual(plugin.settings.pods, [
			{ url: POD, folder: 'team/me' },
			{ url: VAULT, folder: 'projects', roster: true },
			{ url: 'https://pod.example/neil/', folder: 'team/neil', roster: true },
		]);
		assert.equal(plugin.settings.teamSync, true);
		ok('one pod in a team: own pod at team/<nick>, shared pod at projects, others at team/<nick>');

		// Not now: logged in, nothing added.
		const later = bareVault();
		const second = await openLogin(later.tab, ONE_EMAIL);
		await buttonIn(second.modal, 'Log in').clicked();
		await buttonIn(second.modal, 'Not now').clicked();
		assert.ok(later.plugin.settings.clientId);
		assert.deepEqual(later.plugin.settings.pods, []);
		assert.equal(later.plugin.settings.teamSync, false);
		assert.equal(later.plugin.synced, 0);
		ok('Not now: logged in, nothing added');

		// The toggle, once logged in: on adds the whole team at once, off removes it.
		later.tab.display();
		const toggle = () =>
			later.tab.containerEl.settings.find((s) => s.name === 'Team sync').components.find((c) => c.kind === 'toggle');
		assert.equal(toggle().disabled, false);
		await toggle().changed(true);
		assert.equal(later.plugin.settings.teamSync, true);
		assert.deepEqual(later.plugin.settings.pods.map((p) => p.folder), ['projects', 'team/me', 'team/neil']);
		assert.equal(later.plugin.synced, 1, 'and it syncs');
		assert.equal(toggle().value, true, 'redrawn on');
		await toggle().changed(false);
		assert.deepEqual(later.plugin.settings.pods, [], 'off: every row it added goes');
		ok('Team sync toggle: on adds the team and its shared pod, off removes them');

		// A config naming its shared pod wins over the guess.
		assert.ok((await put(CONFIG, `<#team> <https://pod.nicolasdb.eu/hyperscope/vocab#roster> <membres.ttl> ; <https://pod.nicolasdb.eu/hyperscope/vocab#vault> <${POD}lg-elsewhere/> .\n`)).ok);
		assert.deepEqual((await findTeam(owner, '')).vaults, [{ url: `${POD}lg-elsewhere/`, name: 'lg-team' }], 'unnamed: called after its folder');
		ok('hs:vault names the shared pod');
	} finally {
		await memberOf('deletes');
		for (const p of ['lg-team/vault/hello.md', 'lg-team/vault/', 'lg-team/membres.ttl', 'lg-team/config.ttl', 'lg-team/']) {
			await owner(`${POD}${p}`, { method: 'DELETE' });
		}
	}
}

// --- 3. a wrong password says so and stays on the first screen ----------------
{
	const { plugin, tab } = bareVault();
	const { modal, pw } = await openLogin(tab, ONE_EMAIL);
	await pw.changed('wrong');
	await buttonIn(modal, 'Log in').clicked();
	assert.match(Notice.shown.at(-1), /^Solid login failed: Login failed \(\d+\)/);
	assert.equal(modal.title, 'Log in to your pod');
	assert.equal(buttonIn(modal, 'Log in').disabled, false, 'the button comes back');
	assert.equal(plugin.settings.clientId, '');
	ok('a wrong password mints nothing');
	await pw.changed(PASSWORD);
	await buttonIn(modal, 'Log in').clicked();
	assert.ok(plugin.settings.clientId, 'the same dialog logs in once corrected');
	ok('a corrected password works without reopening');
}

console.log('\nall login checks passed');
