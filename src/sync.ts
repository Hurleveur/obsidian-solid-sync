/**
 * Two-way sync between pod containers and vault folders, one folder per pod.
 *
 * Assumes a single editor at a time: change detection compares each side against
 * the state recorded at the last sync, so no clock comparison between machines is
 * needed. When both sides moved, nothing is overwritten — the pod copy is written
 * beside the local one for the user to merge.
 *
 * Every pod is addressed with the same identity, and each one decides what that
 * identity may do. Write access is discovered, never configured: what a pod refuses
 * is reported and recorded, never retried into an error that stops the run.
 */

import { Notice, TFile, Vault, normalizePath } from 'obsidian';
import type SolidSyncPlugin from './main';
import type { PodConfig } from './settings';
import {
	anonymousFetch,
	createFetcher,
	walk,
	type Fetcher,
	type PodResource,
} from './solid';

export interface FileState {
	url: string;
	pod: string;
	local: number;
}

export type SyncState = Record<string, FileState>;

interface Report {
	pulled: number;
	pushed: number;
	deletedLocal: number;
	deletedRemote: number;
	conflicts: string[];
	skipped: string[];
}

/**
 * How a pod resource is represented in the vault.
 *  note    — markdown, stored verbatim
 *  wrapped — RDF and other pod text, fenced inside a note
 *  raw     — everything else (images, PDFs, HTML, audio), copied byte for byte
 */
type Kind = 'note' | 'wrapped' | 'raw';

/** Pod text worth reading as source rather than as an opaque attachment. */
const WRAPPED =
	/^(text\/(turtle|plain)|application\/((ld\+)?json|n-triples|n-quads|trig|rdf\+xml))$/;

const EXTENSION = /\.[a-z0-9]+$/i;

function classify(r: PodResource, rel: string): Kind {
	if (r.contentType === 'text/markdown' || rel.endsWith('.md')) return 'note';
	// A resource with no extension is a pod RDF resource (profile/card and the
	// like), even when the server declines to say so.
	if (WRAPPED.test(r.contentType) || !EXTENSION.test(rel)) return 'wrapped';
	return 'raw';
}

const MIME: Record<string, string> = {
	md: 'text/markdown',
	txt: 'text/plain',
	html: 'text/html',
	htm: 'text/html',
	css: 'text/css',
	csv: 'text/csv',
	json: 'application/json',
	ttl: 'text/turtle',
	pdf: 'application/pdf',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	avif: 'image/avif',
	bmp: 'image/bmp',
	svg: 'image/svg+xml',
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	m4a: 'audio/mp4',
	ogg: 'audio/ogg',
	flac: 'audio/flac',
	mp4: 'video/mp4',
	webm: 'video/webm',
	mov: 'video/quicktime',
	mkv: 'video/x-matroska',
};

const mimeOf = (path: string) =>
	MIME[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

/**
 * Whether a vault event should schedule a sync. Kept separate from the timer
 * plumbing so the rules stay testable: only files inside the synced folder count,
 * conflict copies are local scratch, and the plugin's own writes must not
 * retrigger it while a run is in flight.
 */
export function isSyncTrigger(
	path: string,
	folder: string,
	busy: boolean,
): boolean {
	if (busy || !folder) return false;
	if (!path.startsWith(`${folder}/`)) return false;
	return !CONFLICT_COPY.test(path);
}

/**
 * The folder another pod already claims, if `folder` would overlap it — `null` when
 * it is free. Sync scans a folder with `startsWith`, so two pods sharing one, or one
 * nested in another, would each treat the other's notes as its own and push them to
 * the wrong pod. Sibling names that merely share a prefix are fine.
 */
export function folderClash(
	pods: PodConfig[],
	index: number,
	folder: string,
): string | null {
	const f = normalizePath(folder);
	if (!f || f === '/') return null;
	for (const [i, pod] of pods.entries()) {
		if (i === index || !pod.folder) continue;
		const other = normalizePath(pod.folder);
		if (f === other || f.startsWith(`${other}/`) || other.startsWith(`${f}/`)) {
			return other;
		}
	}
	return null;
}

/** Conflict copies live in the synced folder but are local scratch — never pushed. */
const CONFLICT_COPY = / \(pod conflict [^)]*\)(\.[^./]+)?$/;

/** Tag goes before the extension, so the copy stays the same kind of file. */
function conflictPath(path: string, podModified: string): string {
	const tag = ` (pod conflict ${podModified.replace(/[:.]/g, '-') || 'unknown'})`;
	const dot = path.lastIndexOf('.');
	return dot > path.lastIndexOf('/')
		? path.slice(0, dot) + tag + path.slice(dot)
		: path + tag;
}

const fence = (contentType: string) =>
	({ 'text/turtle': 'turtle', 'application/ld+json': 'json' })[contentType] ??
	contentType.split('/')[1]?.replace(/^.*\+/, '') ??
	'text';

/** Non-markdown pod text becomes a note with its source fenced and the URL in properties. */
function wrapNonMarkdown(r: PodResource, body: string): string {
	return [
		'---',
		`solid-url: ${r.url}`,
		`solid-content-type: ${r.contentType || 'unknown'}`,
		'---',
		'',
		'```' + fence(r.contentType),
		body.trimEnd(),
		'```',
		'',
	].join('\n');
}

const WRAP_PATTERN =
	/^---\n(?:.*\n)*?solid-content-type: (.+)\n(?:.*\n)*?---\n\n```[^\n]*\n([\s\S]*?)\n```\n?$/;

/**
 * Reverses `wrapNonMarkdown`, so an edit to the fenced source can be sent back.
 * Tolerates extra properties, including `solid-readonly: true` from notes pulled
 * by an older version: the wrapper is ours, and only the fenced body is the pod's.
 */
export function unwrapNonMarkdown(
	note: string,
): { body: string; contentType: string } | null {
	const m = WRAP_PATTERN.exec(note);
	return m ? { contentType: m[1] ?? '', body: m[2] ?? '' } : null;
}

async function writeFile(
	vault: Vault,
	path: string,
	content: string | ArrayBuffer,
) {
	const dir = path.slice(0, path.lastIndexOf('/'));
	if (dir && !(await vault.adapter.exists(dir))) {
		await vault.createFolder(dir);
	}
	const text = typeof content === 'string';
	const existing = vault.getFileByPath(path);
	if (existing) {
		if (text) await vault.modify(existing, content);
		else await vault.modifyBinary(existing, content);
		return existing;
	}
	return text ? vault.create(path, content) : vault.createBinary(path, content);
}

/**
 * Both sides changed since the last sync — but only their timestamps are known to
 * differ, and a re-save with no edit or a pod re-serialising a resource moves a
 * timestamp without moving a byte. Comparing content is what stops those from
 * breeding a conflict copy identical to the note it sits beside.
 */
export async function matchesLocal(
	vault: Vault,
	file: TFile,
	podCopy: string | ArrayBuffer,
): Promise<boolean> {
	if (typeof podCopy === 'string') return podCopy === (await vault.read(file));
	const local = new Uint8Array(await vault.readBinary(file));
	const pod = new Uint8Array(podCopy);
	return local.length === pod.length && local.every((b, i) => b === pod[i]);
}

/**
 * Synced paths whose vault file is gone. Each is read as a local deletion on every
 * run and, with pod deletions off, skipped forever — so the pod copy is never
 * pulled again. Dropping the state entry is what makes the next sync fetch it back.
 */
export function deletedLocally(
	state: SyncState,
	exists: (path: string) => boolean,
): string[] {
	return Object.keys(state).filter((path) => !exists(path));
}

export async function runSync(plugin: SolidSyncPlugin): Promise<string> {
	const { issuer, clientId, clientSecret, pods } = plugin.settings;
	const configured = pods.filter((p) => p.url && p.folder);
	const first = configured[0];
	if (!first) {
		throw new Error('Add a pod container URL and a vault folder first.');
	}

	const authenticated = Boolean(clientId && clientSecret);
	// One identity for every pod: Solid-OIDC has each pod resolve our WebID back to
	// this issuer, so the token minted here is what we present everywhere.
	const fetcher: Fetcher = authenticated
		? await createFetcher(
				issuer || new URL(first.url).origin,
				clientId,
				clientSecret,
			)
		: anonymousFetch;

	const report: Report = {
		pulled: 0,
		pushed: 0,
		deletedLocal: 0,
		deletedRemote: 0,
		conflicts: [],
		skipped: [],
	};

	// A half-filled row is easy to leave behind after selecting Add pod, and
	// silently syncing nothing looks identical to the pod being empty.
	for (const pod of pods) {
		if (!pod.url) report.skipped.push(`${pod.folder || 'a pod'} (no URL set)`);
		else if (!pod.folder) report.skipped.push(`${pod.url} (no vault folder set)`);
	}

	for (const pod of configured) {
		try {
			await syncPod(plugin, pod, fetcher, report, authenticated);
		} catch (e) {
			// One unreachable pod must not stop the others.
			report.skipped.push(`${pod.folder} (${(e as Error).message})`);
		}
	}

	await plugin.saveState();
	return summarize(report, authenticated);
}

async function syncPod(
	plugin: SolidSyncPlugin,
	pod: PodConfig,
	fetcher: Fetcher,
	report: Report,
	authenticated: boolean,
): Promise<void> {
	const { pushDeletions, maxFileMB } = plugin.settings;
	const root = pod.url.endsWith('/') ? pod.url : `${pod.url}/`;
	const base = normalizePath(pod.folder);

	const vault = plugin.app.vault;
	const state: SyncState = plugin.state;

	// --- gather both sides, keyed by vault path -------------------------------
	// Too big to move, on either side. Such a path is left out of the whole
	// decision below: not synced, but not read as a deletion either, so neither
	// copy is touched.
	const limit = Number(maxFileMB) > 0 ? Number(maxFileMB) * 1024 * 1024 : 0;
	const oversize = new Set<string>();
	const tooBig = (path: string, bytes: number, where: string) => {
		// Written as "not over" so an unknown size never blocks a sync.
		if (!limit || !(bytes > limit)) return false;
		if (!oversize.has(path)) {
			oversize.add(path);
			report.skipped.push(
				`${path} (${(bytes / 1024 / 1024).toFixed(1)} MB ${where}, over the ${maxFileMB} MB limit)`,
			);
		}
		return true;
	};

	const { resources, unreadable, canWrite } = await walk(fetcher, root);
	// An ACP server sends no WAC-Allow, so `undefined` means "the pod did not say".
	// Assume we may write and let the first 403 settle it, rather than refusing to
	// push against a pod that would have accepted it.
	const writable = authenticated && canWrite !== false;
	pod.access = writable ? 'write' : 'read';

	const remote = new Map<string, { r: PodResource; kind: Kind }>();
	for (const r of resources) {
		const rel = decodeURIComponent(r.url.slice(root.length));
		const kind = classify(r, rel);
		// A note must end in .md or the vault will not see it as a note — and an
		// invisible note reads as "deleted locally" on the next sync. Attachments
		// keep their own name, which is what the embed link in a note points at.
		const path = `${base}/${kind === 'raw' || rel.endsWith('.md') ? rel : `${rel}.md`}`;
		if (tooBig(path, r.size, 'on pod')) continue;
		const clash = remote.get(path);
		if (clash) {
			report.skipped.push(`${r.url} (same name as ${clash.r.url})`);
			continue;
		}
		remote.set(path, { r, kind });
	}

	const local = new Map<string, TFile>();
	for (const file of vault.getFiles()) {
		if (
			file.path.startsWith(`${base}/`) &&
			!CONFLICT_COPY.test(file.path) &&
			!tooBig(file.path, file.stat.size, 'in the vault')
		) {
			local.set(file.path, file);
		}
	}

	// A renamed or unmounted folder makes every note look deleted at once. Refuse to
	// mirror that onto the pod — one wrong sync should not be able to empty it.
	// Counted within this pod's folder only: measured against every pod's state, a
	// wiped folder would stop tripping the guard as soon as other pods were added.
	const known = Object.keys(state).filter((p) => p.startsWith(`${base}/`));
	const missingLocally = known.filter(
		(p) => remote.has(p) && !local.has(p) && !oversize.has(p),
	);
	const massDeletion =
		missingLocally.length > 3 && missingLocally.length > known.length / 2;

	// --- decide per path ------------------------------------------------------
	const pushedPaths: string[] = [];
	for (const path of new Set([...remote.keys(), ...local.keys(), ...known])) {
		if (oversize.has(path)) continue;
		const entry = remote.get(path);
		const r = entry?.r;
		const f = local.get(path);
		const prev = state[path];

		if (entry && r && f) {
			const podChanged = !prev || prev.pod !== r.modified;
			const localChanged = !prev || prev.local !== f.stat.mtime;
			if (podChanged && localChanged) {
				const podCopy = await readRemote(fetcher, r, entry.kind);
				if (podCopy === null) {
					report.skipped.push(`${path} (no read access)`);
					continue;
				}
				let local = f.stat.mtime;
				if (!(await matchesLocal(vault, f, podCopy))) {
					// A wrapped note's frontmatter and fence are ours, not the pod's, so
					// changing how we write them is not a change to the resource. Only
					// the fenced body decides: rewrite the wrapper when that is all that
					// moved, rather than announcing a conflict against ourselves.
					const body = unwrapNonMarkdown(await vault.read(f))?.body;
					const podBody =
						typeof podCopy === 'string'
							? unwrapNonMarkdown(podCopy)?.body
							: undefined;
					if (entry.kind === 'wrapped' && body !== undefined && body === podBody) {
						local = (await writeFile(vault, path, podCopy)).stat.mtime;
					} else {
						// Named after the pod revision, so repeated syncs refresh one copy
						// instead of breeding a new file every run.
						await writeFile(vault, conflictPath(path, r.modified), podCopy);
						report.conflicts.push(path);
					}
				}
				// Mark each side as seen whether or not a copy was written. The note
				// keeps its local text, the pod keeps its own, and whichever the user
				// edits next wins normally.
				state[path] = {
					url: r.url,
					pod: r.modified,
					local,
				};
			} else if (podChanged) {
				await pull(vault, fetcher, entry, path, state, report);
			} else if (localChanged) {
				// Gated on `authenticated`, not `writable`, and not on the resource's
				// kind: writing an existing resource — RDF or not — needs permission on
				// that resource, which a pod can grant without granting the container,
				// or without the container saying so at all. What we are wrapping never
				// decides this, only the pod's own answer does. The cost of being wrong
				// is one refused PUT, once per edit.
				const wrapped =
					entry.kind === 'wrapped'
						? unwrapNonMarkdown(await vault.read(f))
						: null;
				if (!authenticated) {
					markUnpushable(state, path, r.url, f.stat.mtime, r.modified);
					report.skipped.push(`${path} (local edit, no credentials)`);
				} else if (entry.kind === 'wrapped' && !wrapped) {
					// Say what is actually wrong. Reporting this as refused access would
					// blame the pod for a note whose fenced source block was reshaped.
					markUnpushable(state, path, r.url, f.stat.mtime, r.modified);
					report.skipped.push(
						`${path} (local edit, fenced source block no longer parses)`,
					);
				} else if (
					await push(fetcher, vault, f, prev.url, state, wrapped ?? undefined)
				) {
					pushedPaths.push(path);
					report.pushed++;
				} else {
					markUnpushable(state, path, prev.url, f.stat.mtime, r.modified);
					report.skipped.push(`${path} (local edit, no write access)`);
				}
			}
		} else if (entry && r && !f) {
			if (prev) {
				// Deleted locally since the last sync.
				if (!pushDeletions || !writable || massDeletion) {
					report.skipped.push(
						massDeletion
							? `${path} (many notes missing at once, pod left untouched)`
							: `${path} (deleted locally, kept on pod)`,
					);
				} else if ((await fetcher(r.url, { method: 'DELETE' })).ok) {
					delete state[path];
					report.deletedRemote++;
				} else {
					// Keep the state entry: dropping it would make the next run read
					// the surviving pod copy as new and pull the note back silently.
					report.skipped.push(`${path} (deleted locally, pod refused)`);
				}
			} else {
				await pull(vault, fetcher, entry, path, state, report);
			}
		} else if (!entry && f) {
			if (prev) {
				// Deleted on the pod since the last sync — recoverable from trash.
				await plugin.app.fileManager.trashFile(f);
				delete state[path];
				report.deletedLocal++;
			} else if (!writable) {
				report.skipped.push(
					`${path} (new note, ${authenticated ? 'no write access' : 'no credentials'})`,
				);
			} else {
				const url = root + encodeURI(path.slice(base.length + 1));
				if (await push(fetcher, vault, f, url, state)) {
					pushedPaths.push(path);
					report.pushed++;
				} else {
					report.skipped.push(`${path} (new note, no write access)`);
				}
			}
		} else {
			delete state[path];
		}
	}

	// Pushed resources have a new server timestamp; refresh it so the next run
	// does not read them back as remote changes.
	if (pushedPaths.length) {
		const fresh = new Map(
			(await walk(fetcher, root)).resources.map((r) => [r.url, r]),
		);
		for (const path of pushedPaths) {
			const entry = state[path];
			const file = local.get(path);
			if (entry && file) {
				entry.pod = fresh.get(entry.url)?.modified ?? '';
				entry.local = file.stat.mtime;
			}
		}
	}

	for (const url of unreadable) {
		report.skipped.push(`${url} (no access)`);
	}
}

/**
 * Records a local edit we were not allowed to send, marking both sides seen so the
 * note keeps the user's text and the skip is reported once rather than in every
 * summary from here on. Nothing here is permanent: `local` catches up to the
 * current mtime, so the next *edit* tries again — the pod's answer is never cached
 * past the one attempt it was given for.
 */
function markUnpushable(
	state: SyncState,
	path: string,
	url: string,
	local: number,
	pod: string,
) {
	state[path] = { url, pod, local };
}

/**
 * A container can be listable while its members are not, so an unreadable
 * resource is normal on someone else's pod — report it and carry on.
 */
async function readRemote(
	fetcher: Fetcher,
	r: PodResource,
	kind: Kind,
): Promise<string | ArrayBuffer | null> {
	const res = await fetcher(r.url);
	if (!res.ok) return null;
	if (kind === 'raw') return res.arrayBuffer();
	const body = await res.text();
	return kind === 'note' ? body : wrapNonMarkdown(r, body);
}

async function pull(
	vault: Vault,
	fetcher: Fetcher,
	{ r, kind }: { r: PodResource; kind: Kind },
	path: string,
	state: SyncState,
	report: Report,
) {
	const content = await readRemote(fetcher, r, kind);
	if (content === null) {
		report.skipped.push(`${r.url} (no read access)`);
		return;
	}
	const file = await writeFile(vault, path, content);
	state[path] = {
		url: r.url,
		pod: r.modified,
		local: file.stat.mtime,
	};
	report.pulled++;
}

/**
 * Writes one file to the pod. Returns false when the pod refused it, rather than
 * throwing: a read-only pod refuses every write, and one refusal must not abandon
 * the rest of the run — the remaining files, and every pod after this one.
 *
 * `wrapped` is the already-unwrapped body of a fenced note: what is on disk is our
 * frontmatter and fence, not the pod bytes, so the caller takes those off first and
 * hands over what the resource itself holds — along with the content type the fence
 * recorded, which beats what `mimeOf` guesses from a path that always ends in `.md`.
 */
async function push(
	fetcher: Fetcher,
	vault: Vault,
	file: TFile,
	url: string,
	state: SyncState,
	wrapped?: { body: string; contentType: string },
): Promise<boolean> {
	let type = mimeOf(file.path);
	let body: string | ArrayBuffer;
	if (wrapped) {
		// `unknown` is what the wrapper writes when the pod never declared a type,
		// and it is not a media type — sending it back would be a malformed header.
		// The `.md` the path ends in is our own invention, so text/plain over it.
		type =
			wrapped.contentType && wrapped.contentType !== 'unknown'
				? wrapped.contentType
				: 'text/plain';
		body = wrapped.body;
	} else {
		body = type === 'text/markdown' ? await vault.read(file) : await vault.readBinary(file);
	}
	const res = await fetcher(url, {
		method: 'PUT',
		headers: { 'content-type': type },
		body,
	});
	if (!res.ok) return false;
	state[file.path] = { url, pod: '', local: file.stat.mtime };
	return true;
}

function summarize(report: Report, authenticated: boolean): string {
	const parts = [`${report.pulled} pulled`, `${report.pushed} pushed`];
	if (report.deletedLocal) parts.push(`${report.deletedLocal} trashed locally`);
	if (report.deletedRemote) parts.push(`${report.deletedRemote} deleted on pod`);
	if (report.conflicts.length) {
		parts.push(`${report.conflicts.length} conflicts`);
		new Notice(
			`Solid sync conflicts (pod copy saved beside your note):\n${report.conflicts.join('\n')}`,
			10000,
		);
	}
	if (report.skipped.length) parts.push(`${report.skipped.length} skipped`);
	if (!authenticated) parts.push('read-only (no credentials)');
	return parts.join(', ');
}
