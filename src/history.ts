/**
 * Local, append-only history of everything the sync replaces: the bytes a pull
 * overwrites or a remote deletion removes in the vault, and the bytes a push
 * overwrites or a pushed deletion removes on the pod. Lives in the plugin's own
 * folder, which no pod ever sees (nothing under a dot-folder syncs).
 *
 *   history/blobs/<sha256>   contents, once per distinct content
 *   history/journal.jsonl    one JSON line per event
 *   history/baselined/<key>  marker: this pod folder's starting files are stored
 *
 * shortcut: whole files, uncompressed, never pruned — a few hundred MB a year at
 * worst for a notes vault; add gzip (CompressionStream) and pruning if it grows past that.
 *
 * A backup that cannot be written throws, and the caller leaves that path alone —
 * a change must never go ahead without its copy. The journal is the index, not the
 * copy, so a journal line that fails is reported and never undoes anything.
 */

import type { DataAdapter } from 'obsidian';
import { NO_CACHE, type Fetcher } from './solid';

export type HistoryAction =
	| 'baseline'
	| 'pushed'
	| 'pulled'
	| 'deleted-local'
	| 'deleted-pod'
	| 'conflict';

/** SHA-256 hex digest — Web Crypto only, no dependency. */
export async function sha256Hex(data: string | ArrayBuffer): Promise<string> {
	const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(
		'',
	);
}

interface Event {
	path: string;
	action: HistoryAction;
	before: string | null;
	after: string | null;
}

export class History {
	private ready = new Set<string>();

	/**
	 * @param dir     the history folder, vault-relative
	 * @param pod     what the journal's `pod` field says: the container URL
	 * @param onError a journal line that could not be written, for the skip list
	 */
	constructor(
		private adapter: DataAdapter,
		private dir: string,
		private pod: string,
		private onError: (path: string, message: string) => void,
	) {}

	private async mkdir(dir: string) {
		if (this.ready.has(dir)) return;
		if (!(await this.adapter.exists(dir))) await this.adapter.mkdir(dir);
		this.ready.add(dir);
	}

	/** Atomic: written beside, then renamed, so a half-written blob never has a hash's name. */
	private async put(dir: string, name: string, data: ArrayBuffer | string) {
		await this.mkdir(dir);
		const path = `${dir}/${name}`;
		const tmp = `${path}.tmp`;
		if (typeof data === 'string') await this.adapter.write(tmp, data);
		else await this.adapter.writeBinary(tmp, data);
		await this.adapter.rename(tmp, path);
	}

	/** Stores bytes once and returns their hash. Throws if they could not be stored. */
	async keep(data: ArrayBuffer): Promise<string> {
		const hash = await sha256Hex(data);
		try {
			if (!(await this.adapter.exists(`${this.dir}/blobs/${hash}`))) {
				await this.mkdir(this.dir);
				await this.put(`${this.dir}/blobs`, hash, data);
			}
		} catch (e) {
			throw new Error(`history write failed: ${(e as Error).message}`);
		}
		return hash;
	}

	/** The vault file's current bytes, stored. `null` when nothing is there to lose. */
	async keepLocal(path: string): Promise<string | null> {
		if (!(await this.adapter.exists(path))) return null;
		return this.keep(await this.adapter.readBinary(path));
	}

	/**
	 * The pod's last bytes for a resource, stored. Fetched rather than assumed: the
	 * local copy is only the pod's when nothing was edited, and a push is exactly the
	 * case where something was.
	 */
	async keepPod(fetcher: Fetcher, url: string): Promise<string> {
		const res = await fetcher(url, { headers: NO_CACHE });
		if (!res.ok) {
			throw new Error(`history: pod copy unreadable (${res.status}), left as it is`);
		}
		return this.keep(await res.arrayBuffer());
	}

	/** One journal line. Never throws: the blob is the backup, this is only its index. */
	async log(
		path: string,
		action: HistoryAction,
		before: string | null,
		after: string | null,
	) {
		try {
			await this.append([{ path, action, before, after }]);
		} catch (e) {
			this.onError(path, `history journal: ${(e as Error).message}`);
		}
	}

	private async append(events: Event[]) {
		const at = new Date().toISOString();
		const text = events
			.map((e) => JSON.stringify({ at, pod: this.pod, ...e }) + '\n')
			.join('');
		await this.mkdir(this.dir);
		await this.adapter.append(`${this.dir}/journal.jsonl`, text);
	}

	/**
	 * The first run for this pod folder: every file already there is stored and gets
	 * one `baseline` line, before the sync changes anything. The marker is written last
	 * and only if every file made it, so an interrupted baseline starts over (blobs are
	 * deduplicated, and its lines were never written). Returns the paths that failed.
	 */
	async baseline(key: string, paths: string[]): Promise<{ path: string; message: string }[]> {
		const marker = `${this.dir}/baselined/${await sha256Hex(key)}`;
		if (await this.adapter.exists(marker)) return [];
		const events: Event[] = [];
		const failed: { path: string; message: string }[] = [];
		for (const path of paths) {
			try {
				const hash = await this.keepLocal(path);
				if (hash) events.push({ path, action: 'baseline', before: null, after: hash });
			} catch (e) {
				failed.push({ path, message: (e as Error).message });
			}
		}
		if (failed.length) return failed;
		try {
			await this.append(events);
			await this.put(`${this.dir}/baselined`, await sha256Hex(key), key);
		} catch (e) {
			return [{ path: this.dir, message: (e as Error).message }];
		}
		return [];
	}
}
