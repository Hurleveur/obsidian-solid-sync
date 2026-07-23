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

const BINARY = /^(image|audio|video|font)\//;

/**
 * Whether a vault event should schedule a sync. Kept separate from the timer
 * plumbing so the rules stay testable: only notes inside the synced folder count,
 * conflict copies are local scratch, and the plugin's own writes must not
 * retrigger it while a run is in flight.
 */
export function isSyncTrigger(
	path: string,
	folder: string,
	busy: boolean,
): boolean {
	if (busy || !folder) return false;
	if (!path.startsWith(`${folder}/`) || !path.endsWith('.md')) return false;
	return !CONFLICT_COPY.test(path);
}

/** Conflict copies live in the synced folder but are local scratch — never pushed. */
const CONFLICT_COPY = / \(pod conflict [^)]*\)\.md$/;

const conflictPath = (path: string, podModified: string) =>
	path.replace(
		/\.md$/,
		` (pod conflict ${podModified.replace(/[:.]/g, '-') || 'unknown'}).md`,
	);

const isMarkdown = (r: PodResource) =>
	r.contentType === 'text/markdown' || r.url.endsWith('.md');

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

async function writeNote(vault: Vault, path: string, content: string) {
	const dir = path.slice(0, path.lastIndexOf('/'));
	if (dir && !(await vault.adapter.exists(dir))) {
		await vault.createFolder(dir);
	}
	const existing = vault.getFileByPath(path);
	if (existing) {
		await vault.modify(existing, content);
		return existing;
	}
	return vault.create(path, content);
}

export async function runSync(plugin: SolidSyncPlugin): Promise<string> {
	const { podUrl, folder, clientId, clientSecret, pushDeletions } =
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
	const { resources, unreadable } = await walk(fetcher, root);
	const remote = new Map<string, PodResource>();
	for (const r of resources) {
		if (BINARY.test(r.contentType)) {
			report.skipped.push(`${r.url} (${r.contentType})`);
			continue;
		}
		// Every note must end in .md or the vault will not see it as a note —
		// and an invisible note reads as "deleted locally" on the next sync.
		const rel = decodeURIComponent(r.url.slice(root.length));
		const path = `${base}/${rel.endsWith('.md') ? rel : `${rel}.md`}`;
		const clash = remote.get(path);
		if (clash) {
			report.skipped.push(`${r.url} (same note name as ${clash.url})`);
			continue;
		}
		remote.set(path, r);
	}

	const local = new Map<string, TFile>();
	for (const file of vault.getMarkdownFiles()) {
		if (
			file.path.startsWith(`${base}/`) &&
			!CONFLICT_COPY.test(file.path)
		) {
			local.set(file.path, file);
		}
	}

	// A renamed or unmounted folder makes every note look deleted at once. Refuse to
	// mirror that onto the pod — one wrong sync should not be able to empty it.
	const missingLocally = Object.keys(state).filter(
		(p) => remote.has(p) && !local.has(p),
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
		const r = remote.get(path);
		const f = local.get(path);
		const prev = state[path];

		if (r && f) {
			const podChanged = !prev || prev.pod !== r.modified;
			const localChanged = !prev || prev.local !== f.stat.mtime;
			if (podChanged && localChanged) {
				const podCopy = await readRemote(fetcher, r);
				if (podCopy === null) {
					report.skipped.push(`${path} (no read access)`);
					continue;
				}
				// Named after the pod revision, so repeated syncs refresh one copy
				// instead of breeding a new file every run.
				await writeNote(vault, conflictPath(path, r.modified), podCopy);
				// Both versions are now on disk, so stop re-reporting: mark each
				// side as seen. The note keeps its local text, the pod keeps its
				// own, and whichever the user edits next wins normally.
				state[path] = {
					url: r.url,
					pod: r.modified,
					local: f.stat.mtime,
					readOnly: !isMarkdown(r),
				};
				report.conflicts.push(path);
			} else if (podChanged) {
				await pull(vault, fetcher, r, path, state, report);
			} else if (localChanged) {
				if (prev?.readOnly || !authenticated) {
					report.skipped.push(`${path} (local edit, read-only)`);
				} else {
					await push(fetcher, vault, f, prev.url, state);
					pushedPaths.push(path);
					report.pushed++;
				}
			}
		} else if (r && !f) {
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
				await pull(vault, fetcher, r, path, state, report);
			}
		} else if (!r && f) {
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
): Promise<string | null> {
	const res = await fetcher(r.url);
	if (!res.ok) return null;
	const body = await res.text();
	return isMarkdown(r) ? body : wrapNonMarkdown(r, body);
}

async function pull(
	vault: Vault,
	fetcher: Fetcher,
	r: PodResource,
	path: string,
	state: SyncState,
	report: Report,
) {
	const content = await readRemote(fetcher, r);
	if (content === null) {
		report.skipped.push(`${r.url} (no read access)`);
		return;
	}
	const file = await writeNote(vault, path, content);
	state[path] = {
		url: r.url,
		pod: r.modified,
		local: file.stat.mtime,
		readOnly: !isMarkdown(r),
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
	const res = await fetcher(url, {
		method: 'PUT',
		headers: { 'content-type': 'text/markdown' },
		body: await vault.read(file),
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
