/**
 * Sharing a note from its properties. Creates and deletes `sh-*` resources and writes
 * their ACLs, so use a scratch pod on a local server that runs WAC (the default CSS
 * config does), with a second account on the same server as the guest.
 *
 *   POD_URL=… POD_ID=… POD_SECRET=… GUEST_ID=… GUEST_SECRET=… node test/share.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from './obsidian-stub.mjs';
import { runSync, createFetcher, ownPod, wantedAccess, parseMembers } from './sync.bundle.mjs';

const POD = process.env.POD_URL;
const { POD_ID, POD_SECRET, GUEST_ID, GUEST_SECRET } = process.env;
assert(POD && POD_ID && POD_SECRET && GUEST_ID && GUEST_SECRET, 'POD_URL, POD_ID, POD_SECRET, GUEST_ID and GUEST_SECRET required');

const ROOT = new URL('sh-scratch/', POD).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NO_CACHE = { 'cache-control': 'no-cache' };
const owner = await createFetcher(new URL(POD).origin, POD_ID, POD_SECRET);
const guest = await createFetcher(new URL(POD).origin, GUEST_ID, GUEST_SECRET);
assert.ok(owner.webId && guest.webId && owner.webId !== guest.webId, 'two identities');

const ok = (n) => console.log(`  ok  ${n}`);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'share-vault-'));
const vault = new Vault(root);
const plugin = {
	app: { vault, fileManager: { trashFile: (file) => vault.trash(file) } },
	// Every key, by hand: a key missing here reads as undefined inside runSync.
	settings: {
		issuer: new URL(POD).origin,
		pods: [{ url: ROOT, folder: 'Pod' }],
		clientId: POD_ID,
		clientSecret: POD_SECRET,
		pushDeletions: true,
		syncOnStartup: false,
		syncOnChange: false,
		syncLog: false,
		history: false,
		maxFileMB: 10,
		ignore: [],
		members: [`Guest ${guest.webId}`],
	},
	state: {},
	lastSkipped: [],
	saveState: async () => {},
	saveSettings: async () => {},
};
const note = (p, props) =>
	fs.writeFileSync(path.join(root, 'Pod', p), `${props ? `---\n${props}\n---\n` : ''}# ${p} ${Date.now()}\n`);
const sync = async (label) => {
	const result = await runSync(plugin);
	console.log(`  ${label.padEnd(24)}: ${result}`);
	for (const line of plugin.lastSkipped) console.log('     skipped:', line);
	// Pod timestamps can be second-granular; keep each step in its own second.
	await sleep(1100);
	return result;
};
const status = async (who, p, init = {}) =>
	(await who(`${ROOT}${p}`, { headers: NO_CACHE, ...init })).status;
const guestWrite = (p) =>
	status(guest, p, { method: 'PUT', headers: { 'content-type': 'text/markdown' }, body: '# guest\n' });
const aclVersion = async (p) => {
	const res = await owner(`${ROOT}${p}.acl`, { method: 'HEAD', headers: NO_CACHE });
	return res.status === 404 ? null : res.headers.get('etag');
};
const skipFor = (p) => plugin.lastSkipped.find((l) => l.startsWith(`Pod/${p} `));

try {
	// --- 0. the parts with no server ---------------------------------------------
	const members = parseMembers(['Neil https://pod.example/neil/profile/card#me']);
	assert.deepEqual(wantedAccess('---\nshare: [neil, Neil]\nshare-write: neil\n---\n', members), {
		read: [],
		write: ['https://pod.example/neil/profile/card#me'],
	});
	assert.match(wantedAccess('---\nshare: [bob]\n---\n', members), /"bob" is not a team member/);
	const sneaky = wantedAccess('---\nshare: ["https://x.example/#me>; acl:mode acl:Control"]\n---\n', members);
	assert.ok(!sneaky.read[0].includes('>') && !sneaky.read[0].includes(' '), 'an IRI cannot be closed early');
	assert.equal(ownPod('https://pod.example/alex/profile/card#me'), 'https://pod.example/alex/');
	ok('properties resolve to WebIDs, and a value cannot break out of its IRI');

	// The pod folder must exist before a sync will push into it.
	const made = await owner(ROOT, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: '' });
	assert.ok(made.ok, `creating ${ROOT} (${made.status})`);
	fs.mkdirSync(path.join(root, 'Pod'), { recursive: true });
	note('sh-read.md', 'share: [guest]');
	note('sh-write.md', 'share-write: [guest]');
	note('sh-private.md');
	await sync('1. first push');
	assert.deepEqual(plugin.lastSkipped, [], 'nothing skipped');

	// --- 1. share and share-write reach the pod ---------------------------------
	assert.equal(await status(guest, 'sh-read.md'), 200, 'guest reads the shared note');
	assert.equal(await guestWrite('sh-read.md'), 403, 'but may not edit it');
	assert.equal(await status(guest, 'sh-private.md'), 403, 'the note beside it stays private');
	assert.equal(await guestWrite('sh-write.md'), 205, 'share-write lets the guest edit');
	assert.equal(await status(owner, 'sh-read.md.acl'), 200, 'the owner keeps control of the ACL');
	assert.equal(await status(guest, 'sh-read.md.acl'), 403, 'the guest may not read the ACL');
	ok('share grants read, share-write grants write, nothing else moves');

	// --- 2. an edit that leaves the properties alone leaves the ACL alone --------
	await sync('2. pull guest edit'); // the guest's edit of sh-write.md comes back first
	const before = await aclVersion('sh-read.md');
	note('sh-read.md', 'share: [guest]');
	await sync('2. body edit');
	assert.equal(await aclVersion('sh-read.md'), before, 'ACL untouched');
	ok('unchanged properties cost no ACL write');

	// --- 3. unsharing removes the note's own ACL ---------------------------------
	note('sh-read.md');
	await sync('3. unshare');
	assert.equal(await aclVersion('sh-read.md'), null, 'ACL deleted');
	assert.equal(await status(guest, 'sh-read.md'), 403, 'guest refused again');
	assert.equal(await status(owner, 'sh-read.md'), 200, 'owner still reads');
	ok('removing the properties hands the note back to its folder');

	// --- 4. an ACL changed outside the plugin is left alone, once ---------------
	const outside = await owner(`${ROOT}sh-write.md.acl`, {
		method: 'PUT',
		headers: { 'content-type': 'text/turtle' },
		body: `@prefix acl: <http://www.w3.org/ns/auth/acl#>.
<#o> a acl:Authorization; acl:agent <${owner.webId}>; acl:accessTo <./sh-write.md>; acl:mode acl:Read, acl:Write, acl:Control.
<#g> a acl:Authorization; acl:agent <${guest.webId}>; acl:accessTo <./sh-write.md>; acl:mode acl:Read.`,
	});
	assert.ok(outside.ok, `outside ACL (${outside.status})`);
	const theirs = await aclVersion('sh-write.md');
	note('sh-write.md', 'share: [guest]');
	await sync('4. outside change');
	assert.match(skipFor('sh-write.md') ?? '', /sharing changed outside the plugin/);
	assert.equal(await aclVersion('sh-write.md'), theirs, 'their ACL kept');
	note('sh-write.md', 'share: [guest]');
	await sync('4. same sharing again');
	assert.equal(skipFor('sh-write.md'), undefined, 'reported once');
	assert.equal(await aclVersion('sh-write.md'), theirs, 'still theirs: the properties did not change');
	note('sh-write.md', 'share-write: [guest]');
	await sync('4. new sharing');
	assert.equal(skipFor('sh-write.md'), undefined);
	assert.notEqual(await aclVersion('sh-write.md'), theirs, 'replaced by the next change');
	assert.equal(await guestWrite('sh-write.md'), 205, 'and it says write again');
	ok('an outside change is reported, then replaced by the next edit');

	// --- 5. a name nobody knows applies nothing ---------------------------------
	note('sh-private.md', 'share: [guest, nobody]');
	await sync('5. unknown name');
	assert.match(skipFor('sh-private.md') ?? '', /"nobody" is not a team member/);
	assert.equal(await aclVersion('sh-private.md'), null, 'no partial ACL');
	ok('an unknown name stops the whole note, not just that name');

	// --- 6. properties that arrive in a pull are not applied ----------------------
	const put = await owner(`${ROOT}sh-pulled.md`, {
		method: 'PUT',
		headers: { 'content-type': 'text/markdown' },
		body: '---\nshare: [guest]\n---\n# from elsewhere\n',
	});
	assert.ok(put.ok);
	await sync('6. pull');
	assert.equal(await aclVersion('sh-pulled.md'), null, 'no ACL written for a pulled note');
	assert.equal(await status(guest, 'sh-pulled.md'), 403);
	ok('only a device that pushes the properties applies them');

	// --- 7. a pull keeps what this device knows of the note's ACL ----------------
	// sh-write.md was pulled in step 5 (the guest's edit in step 4).
	note('sh-write.md');
	await sync('7. unshare after pull');
	assert.equal(await aclVersion('sh-write.md'), null, 'ACL deleted');
	assert.equal(await status(guest, 'sh-write.md'), 403);
	ok('a note pulled since it was shared can still be unshared');
} finally {
	for (const p of ['sh-read.md', 'sh-write.md', 'sh-private.md', 'sh-pulled.md']) {
		await owner(`${ROOT}${p}.acl`, { method: 'DELETE' });
		await owner(`${ROOT}${p}`, { method: 'DELETE' });
	}
	await owner(ROOT, { method: 'DELETE' });
	fs.rmSync(root, { recursive: true, force: true });
}
