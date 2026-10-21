/**
 * `walk` lists a level's containers together and still returns exactly what the
 * one-by-one walk did, in the same order. Creates and deletes `wk-scratch/`, so use
 * a scratch pod on a local server.
 *
 *   POD_URL=… POD_ID=… POD_SECRET=… node test/walk.mjs
 *
 * Order matters: two resources mapping to one vault path keep the first one seen,
 * so a walk that came back reordered would change which one syncs.
 */
import assert from 'node:assert/strict';
import { createFetcher, listContainer, walk } from './sync.bundle.mjs';

const POD = process.env.POD_URL;
const id = process.env.POD_ID;
const secret = process.env.POD_SECRET;
assert(POD && id && secret, 'POD_URL, POD_ID and POD_SECRET required');

const ROOT = new URL('wk-scratch/', POD).href;
const fetcher = await createFetcher(new URL(POD).origin, id, secret);

const files = [
	'top.md',
	'a/one.md',
	'a/deep/two.md',
	'a/deep/deeper/three.md',
	'b/four.md',
	'c/five.md',
	'd/six.md',
	'e/seven.md',
	'f/eight.md',
	'g/nine.md',
	'h/ten.md',
	'i/eleven.md',
	'denied/hidden.md',
];
for (const f of files) {
	const res = await fetcher(ROOT + f, {
		method: 'PUT',
		headers: { 'content-type': 'text/markdown' },
		body: `# ${f}\n`,
	});
	assert(res.ok, `PUT ${f}: ${res.status}`);
}

// One container answers 403, as a tightened ACL would. Every listing is held a
// moment so overlapping ones are visible.
let inFlight = 0;
let maxInFlight = 0;
const slow = Object.assign(
	async (url, init) => {
		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		try {
			await new Promise((r) => setTimeout(r, 30));
			if (url === `${ROOT}denied/`) return new Response('', { status: 403 });
			return await fetcher(url, init);
		} finally {
			inFlight--;
		}
	},
	{ webId: fetcher.webId },
);

// The one-by-one walk, as it was before listings overlapped.
async function serialWalk(f, root) {
	const resources = [];
	const unreadable = [];
	const queue = [root];
	const seen = new Set(queue);
	let canWrite;
	while (queue.length) {
		const url = queue.shift();
		let children;
		try {
			const listing = await listContainer(f, url);
			children = listing.children;
			if (url === root) canWrite = listing.canWrite;
		} catch (e) {
			unreadable.push({ url, reason: e.status ? String(e.status) : `network error: ${e.message}` });
			continue;
		}
		for (const child of children) {
			if (seen.has(child.url)) continue;
			seen.add(child.url);
			if (child.isContainer) queue.push(child.url);
			else resources.push(child);
		}
	}
	return { resources, unreadable, canWrite };
}

try {
	const expected = await serialWalk(slow, ROOT);
	assert.equal(maxInFlight, 1, 'the reference walk overlapped its own listings');
	// Population first: a match over an empty walk proves nothing.
	assert.equal(expected.resources.length, files.length - 1, 'reference walk missed files');
	assert.deepEqual(expected.unreadable.map((u) => u.url), [`${ROOT}denied/`]);

	maxInFlight = 0;
	const actual = await walk(slow, ROOT);
	assert.deepEqual(actual, expected, 'walk result differs from the one-by-one walk');
	assert(maxInFlight > 1, `listings never overlapped (max in flight ${maxInFlight})`);
	assert(maxInFlight <= 8, `more than 8 listings in flight (${maxInFlight})`);
	console.log(`walk: all passed (max ${maxInFlight} listings in flight)`);
} finally {
	for (const f of [...files].reverse()) await fetcher(ROOT + f, { method: 'DELETE' });
	for (const c of ['a/deep/deeper/', 'a/deep/', 'a/', 'b/', 'c/', 'd/', 'e/', 'f/', 'g/', 'h/', 'i/', 'denied/', ''])
		await fetcher(ROOT + c, { method: 'DELETE' });
}
