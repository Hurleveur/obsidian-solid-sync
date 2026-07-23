/**
 * Two-way sync between a pod container and a vault folder.
 *
 * Assumes a single editor at a time: change detection compares each side against
 * the state recorded at the last sync, so no clock comparison between machines is
 * needed. When both sides moved, nothing is overwritten — the pod copy is written
 * beside the local one for the user to merge.
 */

import { Notice, TFile, Vault, normalizePath } from 'obsidian';
import type SolidSyncPlugin from './main';
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
	readOnly: boolean;
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
 *  wrapped — RDF and other pod text, fenced inside a read-only note
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

/** Read-only resources become notes with their source fenced and the URL in properties. */
function wrapNonMarkdown(r: PodResource, body: string): string {
	return [
		'---',
		`solid-url: ${r.url}`,
		`solid-content-type: ${r.contentType || 'unknown'}`,
		'solid-readonly: true',
		'---',
		'',
		'```' + fence(r.contentType),
		body.trimEnd(),
		'```',
		'',
	].join('\n');
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

export async function runSync(plugin: SolidSyncPlugin): Promise<string> {
	const { podUrl, folder, clientId, clientSecret, pushDeletions, maxFileMB } =
		plugin.settings;
	if (!podUrl || !folder) throw new Error('Set the pod URL and vault folder first.');

	const root = podUrl.endsWith('/') ? podUrl : `${podUrl}/`;
	const base = normalizePath(folder);
	const authenticated = Boolean(clientId && clientSecret);
	const fetcher: Fetcher = authenticated
		? await createFetcher(root, clientId, clientSecret)
		: anonymousFetch;

	const vault = plugin.app.vault;
	const state: SyncState = plugin.state;
	const report: Report = {
		pulled: 0,
		pushed: 0,
		deletedLocal: 0,
		deletedRemote: 0,
		conflicts: [],
		skipped: [],
	};

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

	const { resources, unreadable } = await walk(fetcher, root);
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
	const missingLocally = Object.keys(state).filter(
		(p) => remote.has(p) && !local.has(p) && !oversize.has(p),
	);
	const massDeletion =
		missingLocally.length > 3 &&
		missingLocally.length > Object.keys(state).length / 2;

	// --- decide per path ------------------------------------------------------
	const pushedPaths: string[] = [];
	for (const path of new Set([
		...remote.keys(),
		...local.keys(),
		...Object.keys(state),
	])) {
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
				// Named after the pod revision, so repeated syncs refresh one copy
				// instead of breeding a new file every run.
				await writeFile(vault, conflictPath(path, r.modified), podCopy);
				// Both versions are now on disk, so stop re-reporting: mark each
				// side as seen. The note keeps its local text, the pod keeps its
				// own, and whichever the user edits next wins normally.
				state[path] = {
					url: r.url,
					pod: r.modified,
					local: f.stat.mtime,
					readOnly: entry.kind === 'wrapped',
				};
				report.conflicts.push(path);
			} else if (podChanged) {
				await pull(vault, fetcher, entry, path, state, report);
			} else if (localChanged) {
				if (prev?.readOnly || !authenticated) {
					report.skipped.push(`${path} (local edit, read-only)`);
				} else {
					await push(fetcher, vault, f, prev.url, state);
					pushedPaths.push(path);
					report.pushed++;
				}
			}
		} else if (entry && r && !f) {
			if (prev) {
				// Deleted locally since the last sync.
				if (!pushDeletions || !authenticated || massDeletion) {
					report.skipped.push(
						massDeletion
							? `${path} (many notes missing at once, pod left untouched)`
							: `${path} (deleted locally, kept on pod)`,
					);
				} else {
					await fetcher(r.url, { method: 'DELETE' });
					delete state[path];
					report.deletedRemote++;
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
			} else if (!authenticated) {
				report.skipped.push(`${path} (new note, no credentials)`);
			} else {
				const url = root + encodeURI(path.slice(base.length + 1));
				await push(fetcher, vault, f, url, state);
				pushedPaths.push(path);
				report.pushed++;
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

	await plugin.saveState();
	for (const url of unreadable) {
		report.skipped.push(`${url} (no access)`);
	}
	return summarize(report, authenticated);
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
		readOnly: kind === 'wrapped',
	};
	report.pulled++;
}

async function push(
	fetcher: Fetcher,
	vault: Vault,
	file: TFile,
	url: string,
	state: SyncState,
) {
	const type = mimeOf(file.path);
	const res = await fetcher(url, {
		method: 'PUT',
		headers: { 'content-type': type },
		body:
			type === 'text/markdown'
				? await vault.read(file)
				: await vault.readBinary(file),
	});
	if (!res.ok) throw new Error(`${res.status} writing ${url}`);
	state[file.path] = {
		url,
		pod: '',
		local: file.stat.mtime,
		readOnly: false,
	};
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
