/**
 * The team roster: each member's pod becomes a row at `team/<nick>`, and nicks become
 * `share:` names. Needs two accounts on one local server that runs WAC (the default
 * CSS config does): POD is the vault owner's pod, MEMBER_POD the other member's. The
 * suite writes `tm-*` resources in POD and rewrites MEMBER_POD's top `.acl` so the
 * owner can read it, so both must be throwaway pods.
 *
 *   POD_URL=… POD_ID=… POD_SECRET=… MEMBER_POD=… MEMBER_ID=… MEMBER_SECRET=… node test/team.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from './obsidian-stub.mjs';
import { runSync, createFetcher, rosterMembers, mergeRoster, parseTriples } from './sync.bundle.mjs';

const POD = process.env.POD_URL;
const { POD_ID, POD_SECRET, MEMBER_POD, MEMBER_ID, MEMBER_SECRET } = process.env;
assert(POD && POD_ID && POD_SECRET && MEMBER_POD && MEMBER_ID && MEMBER_SECRET, 'POD_URL, POD_ID, POD_SECRET, MEMBER_POD, MEMBER_ID and MEMBER_SECRET required');

const NO_CACHE = { 'cache-control': 'no-cache' };
const owner = await createFetcher(new URL(POD).origin, POD_ID, POD_SECRET);
const member = await createFetcher(new URL(POD).origin, MEMBER_ID, MEMBER_SECRET);
assert.ok(owner.webId && member.webId && owner.webId !== member.webId, 'two identities');

const ok = (n) => console.log(`  ok  ${n}`);
const ROSTER = new URL('tm-team/membres.ttl', POD).href;
const OWN = new URL('tm-own/', POD).href;
const put = (who, url, body, type = 'text/turtle') =>
	who(url, { method: 'PUT', headers: { 'content-type': type }, body });
// What solid-backoffice's addMemberText writes: one statement per line, full IRIs.
const backoffice = (people) =>
	'@prefix foaf: <http://xmlns.com/foaf/0.1/> .\n' +
	people
		.map(
			([id, nick]) =>
				`<config.ttl#team> <http://xmlns.com/foaf/0.1/member> <${id}> .\n<${id}> <http://xmlns.com/foaf/0.1/nick> "${nick}" .\n`,
		)
		.join('');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-vault-'));
const vault = new Vault(root);
const plugin = {
	app: { vault, fileManager: { trashFile: (file) => vault.trash(file) } },
	// Every key, by hand: a key missing here reads as undefined inside runSync.
	settings: {
		issuer: new URL(POD).origin,
		// A hand row on the owner's own pod, as alex/ at team/alexandre today.
		pods: [{ url: POD, folder: 'Mine' }],
		clientId: POD_ID,
		clientSecret: POD_SECRET,
		pushDeletions: false,
		syncOnStartup: false,
		syncOnChange: false,
		syncLog: false,
		history: false,
		maxFileMB: 10,
		ignore: [],
		members: [],
		roster: ROSTER,
		team: [],
	},
	state: {},
	lastSkipped: [],
	saveState: async () => {},
	saveSettings: async () => {},
};
const sync = async (label) => {
	const result = await runSync(plugin);
	console.log(`  ${label.padEnd(24)}: ${result}`);
	for (const line of plugin.lastSkipped) console.log('     skipped:', line);
	return result;
};
const rowFor = (folder) => plugin.settings.pods.find((p) => p.folder === folder);

try {
	// --- 0. the parts with no server ---------------------------------------------
	const base = 'https://pod.example/team/membres.ttl';
	const alice = 'https://pod.example/alice/profile/card#me';
	assert.deepEqual(rosterMembers(backoffice([[alice, 'alice']]), base), [{ webId: alice, nick: 'alice' }]);
	// Hand-written: prefixed names, `;` and `,`, a relative IRI, comments, PREFIX.
	const hand = `# a comment: with a colon
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
<config.ttl#team> a foaf:Group ; foaf:member <../alice/profile/card#me>, <https://pod.example/bob/profile/card#me> .
<../alice/profile/card#me> foaf:nick "alice" .
<https://pod.example/bob/profile/card#me> foaf:nick "Bob/../x" .
<config.ttl#team> foaf:member <file:///etc/profile/card#me> .
<file:///etc/profile/card#me> foaf:nick "etc" .
`;
	assert.deepEqual(rosterMembers(hand, base), [{ webId: alice, nick: 'alice' }], 'a nick that is no folder name, or a WebID that is no web address, is dropped');
	assert.throws(() => parseTriples('<a> <b> [ <c> <d> ] .', base), /unreadable Turtle/);
	assert.throws(() => parseTriples('<a> x:b <c> .', base), /undefined prefix "x:"/);
	assert.throws(() => parseTriples('<a> <b> <c>', base), /unreadable Turtle/);
	const merged = mergeRoster(
		[
			{ url: 'https://pod.example/alice/', folder: 'By hand' },
			{ url: 'https://pod.example/gone/', folder: 'team/gone', roster: true },
			{ url: 'https://pod.example/other/', folder: 'team/bob' },
		],
		[
			{ webId: alice, nick: 'alice' },
			{ webId: 'https://pod.example/bob/profile/card#me', nick: 'bob' },
			{ webId: 'https://pod.example/carol/profile/card#me', nick: 'carol' },
		],
	);
	assert.deepEqual(merged.pods.map((p) => p.folder), ['By hand', 'team/bob', 'team/carol'], 'hand rows kept, gone dropped, carol added');
	assert.deepEqual(merged.removed.map((p) => p.folder), ['team/gone']);
	assert.match(merged.skipped[0], /^team\/bob \(team member bob: "team\/bob" is already/);
	ok('roster parsing and merging');

	// --- 1. the member's pod arrives at team/<nick> ------------------------------
	// The member lets the owner read their whole pod, as nicolasdb/ lets alex today.
	const acl = `@prefix acl: <http://www.w3.org/ns/auth/acl#> .
<#owner> a acl:Authorization; acl:agent <${member.webId}>; acl:accessTo <./>; acl:default <./>; acl:mode acl:Read, acl:Write, acl:Control .
<#team> a acl:Authorization; acl:agent <${owner.webId}>; acl:accessTo <./>; acl:default <./>; acl:mode acl:Read .
`;
	assert.equal((await put(member, `${MEMBER_POD}.acl`, acl)).status < 300, true, 'member pod shared with the owner');
	assert.ok((await put(member, `${MEMBER_POD}tm-hello.md`, '# hello from the member\n', 'text/markdown')).ok);
	assert.ok((await put(owner, `${OWN}tm-mine.md`, '# mine\n', 'text/markdown')).ok);
	assert.ok((await put(owner, ROSTER, backoffice([[owner.webId, 'owner'], [member.webId, 'neil']]))).ok);

	await sync('first run');
	const row = rowFor('team/neil');
	assert.deepEqual(row, { url: MEMBER_POD, folder: 'team/neil', roster: true, access: 'read' });
	assert.ok(fs.existsSync(path.join(root, 'team/neil/tm-hello.md')), 'member note pulled');
	assert.equal(rowFor('team/owner'), undefined, "the owner's pod already has a row: no second one");
	assert.ok(fs.existsSync(path.join(root, 'Mine/tm-own/tm-mine.md')), 'hand row still syncs');
	assert.ok(!plugin.lastSkipped.some((l) => l.startsWith('team roster')), 'roster read');
	assert.deepEqual(plugin.settings.team, [`owner ${owner.webId}`, `neil ${member.webId}`]);
	ok('member pods synced at team/<nick>');

	// --- 2. nicks are share: names -----------------------------------------------
	fs.writeFileSync(path.join(root, 'Mine/tm-own/tm-shared.md'), '---\nshare: [neil]\n---\n# for neil\n');
	await sync('share with a nick');
	assert.equal((await member(`${OWN}tm-shared.md`, { headers: NO_CACHE })).status, 200, 'neil can read it');
	assert.ok(!plugin.lastSkipped.some((l) => l.includes('tm-shared')), 'no sharing skip');
	ok('share: [nick] grants the member');

	// --- 3. unreadable roster keeps the team -------------------------------------
	const pods = JSON.stringify(plugin.settings.pods);
	plugin.settings.roster = new URL('tm-team/missing.ttl', POD).href;
	await sync('roster missing');
	assert.equal(JSON.stringify(plugin.settings.pods), pods, 'rows kept');
	assert.match(plugin.lastSkipped.find((l) => l.startsWith('team roster')) ?? '', /roster not readable \(404\); last team kept/);
	plugin.settings.roster = ROSTER;
	ok('unreadable roster keeps the last rows');

	// --- 4. leaving the roster stops the row, keeps the notes --------------------
	assert.ok(Object.keys(plugin.state).some((p) => p.startsWith('team/neil/')), 'state exists before');
	assert.ok((await put(owner, ROSTER, backoffice([[owner.webId, 'owner']]))).ok);
	await sync('neil left');
	assert.equal(rowFor('team/neil'), undefined, 'row gone');
	assert.ok(fs.existsSync(path.join(root, 'team/neil/tm-hello.md')), 'notes stay');
	assert.ok(!Object.keys(plugin.state).some((p) => p.startsWith('team/neil/')), 'state dropped');
	assert.deepEqual(plugin.settings.team, [`owner ${owner.webId}`]);
	ok('a member gone from the roster stops syncing');

	console.log('\nall team checks passed');
} finally {
	await owner(`${OWN}tm-shared.md.acl`, { method: 'DELETE' });
	for (const p of ['tm-own/tm-mine.md', 'tm-own/tm-shared.md', 'tm-team/membres.ttl', 'tm-own/', 'tm-team/']) {
		await owner(new URL(p, POD).href, { method: 'DELETE' });
	}
	await member(`${MEMBER_POD}tm-hello.md`, { method: 'DELETE' });
	fs.rmSync(root, { recursive: true, force: true });
}
