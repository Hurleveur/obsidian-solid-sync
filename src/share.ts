/**
 * Sharing a note from its properties: `share: [neil]` lets those people read it,
 * `share-write: [...]` lets them edit it too. The plugin turns that into the note's
 * own `.acl` on the pod when the note is pushed. A folder note (`Folder/Folder.md`)
 * shares its folder and everything in it instead.
 *
 * A note's own `.acl` replaces its folder's entirely, so every one written here names
 * the pod's owner with full control: the server's owner override cannot be relied on
 * (see docs/plans/team-features.md, chunk 2).
 *
 * Only a property edited on this device is applied. One that arrives in a pull was
 * written by whoever could edit the note, and applying it would let anyone with
 * Write grant access, which only Control may do.
 */

import { getFrontMatterInfo, parseYaml } from 'obsidian';
import { NO_CACHE, type Fetcher } from './solid';

/** What this device last made of a note's sharing on the pod. */
export interface ShareRecord {
	/** The access asked for, as `shareKey` writes it; '' for none. */
	key: string;
	/** The `.acl`'s ETag after our write, or the one we found and left; null for none. */
	etag: string | null;
}

export interface Wanted {
	read: string[];
	write: string[];
}

/** `name https://pod.example/name/profile/card#me`, one member per line. */
export function parseMembers(lines: string[]): Map<string, string> {
	const members = new Map<string, string>();
	for (const line of lines) {
		const [name, webId] = line.trim().split(/\s+/);
		if (name && webId) members.set(name.toLowerCase(), webId);
	}
	return members;
}

/**
 * A WebID safe to write into Turtle between `<` and `>`. The URL parser percent-encodes
 * `>`, `"` and spaces, so a value from a note cannot close the IRI and add its own
 * grant (`…#me>; acl:mode acl:Control`).
 */
function webIdOf(value: string): string | null {
	try {
		const url = new URL(value);
		return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
	} catch {
		return null;
	}
}

/**
 * The access a note's properties ask for, as WebIDs, or a reason it cannot be read.
 * Each entry is a member's name or a WebID; someone in both lists gets write.
 */
export function wantedAccess(note: string, members: Map<string, string>): Wanted | string {
	const info = getFrontMatterInfo(note);
	let props: unknown = null;
	if (info.exists) {
		try {
			props = parseYaml(info.frontmatter);
		} catch {
			return 'properties do not parse';
		}
	}
	const list = (key: string): string[] | string => {
		const value = (props as Record<string, unknown> | null)?.[key];
		const names = value == null ? [] : Array.isArray(value) ? value : [value];
		const ids: string[] = [];
		for (const name of names) {
			const text = String(name).trim();
			const id = webIdOf(members.get(text.toLowerCase()) ?? text);
			if (!id) return `${key}: "${text}" is not a team member or a WebID`;
			ids.push(id);
		}
		return ids;
	};
	const write = list('share-write');
	if (typeof write === 'string') return write;
	const read = list('share');
	if (typeof read === 'string') return read;
	return {
		read: [...new Set(read)].filter((id) => !write.includes(id)).sort(),
		write: [...new Set(write)].sort(),
	};
}

export const shareKey = (w: Wanted) =>
	w.read.length || w.write.length ? JSON.stringify(w) : '';

/**
 * The pod our WebID's profile sits in. shortcut: assumes the Community Solid Server
 * layout (`<pod>/profile/card#me`); read `pim:storage` from the profile once another
 * server is in use.
 */
export const ownPod = (webId: string) => new URL('../', webId).href;

/**
 * The resource a pushed note's properties govern: the note, or for a folder note
 * (`Folder/Folder.md`) its folder. shortcut: assumes the Folder Notes plugin's
 * default naming inside the folder; read its settings if a vault names them otherwise.
 */
export function sharedTarget(path: string, noteUrl: string): string {
	const parts = path.split('/');
	return parts.length > 1 && parts[parts.length - 1] === `${parts[parts.length - 2]}.md`
		? new URL('./', noteUrl).href
		: noteUrl;
}

function aclTurtle(owner: string, target: string, w: Wanted): string {
	// A folder's rules also cover what is inside it, now and later (acl:default).
	const scope = target.endsWith('/') ? `acl:accessTo <${target}>; acl:default <${target}>` : `acl:accessTo <${target}>`;
	const rule = (id: string, agents: string[], modes: string) =>
		`<#${id}> a acl:Authorization; acl:agent ${agents.map((a) => `<${a}>`).join(', ')};\n` +
		`  ${scope}; acl:mode ${modes}.\n`;
	return (
		'@prefix acl: <http://www.w3.org/ns/auth/acl#>.\n' +
		rule('owner', [owner], 'acl:Read, acl:Write, acl:Control') +
		(w.write.length ? rule('write', w.write, 'acl:Read, acl:Write') : '') +
		(w.read.length ? rule('read', w.read, 'acl:Read') : '')
	);
}

const versionOf = (headers: Headers) =>
	headers.get('etag') ?? headers.get('last-modified');

/** The `.acl`'s current version, null when there is none. Throws on any other answer. */
async function aclVersion(fetcher: Fetcher, aclUrl: string): Promise<string | null> {
	const res = await fetcher(aclUrl, { method: 'HEAD', headers: NO_CACHE });
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`reading its sharing refused: ${res.status}`);
	return versionOf(res.headers);
}

/**
 * Brings the `.acl` of a pushed note, or of the folder it is the note of, in line
 * with what its properties ask for. Returns the record to keep and, when the
 * properties were not applied, why. Throws only on a network error, which the caller
 * reports for this note alone.
 *
 * An `.acl` that changed since this device last wrote it is left as it is and
 * reported once; the record takes its version, so the next edit of the note's
 * sharing replaces it.
 */
export async function applySharing(
	fetcher: Fetcher,
	target: string,
	wanted: Wanted,
	prev: ShareRecord | undefined,
): Promise<{ record?: ShareRecord; skip?: string }> {
	const key = shareKey(wanted);
	if (key === (prev?.key ?? '')) return {};
	const owner = fetcher.webId;
	if (!owner) return { skip: 'sharing not applied: the login token names no WebID' };
	if (!target.startsWith(ownPod(owner))) {
		return { skip: 'sharing not applied: only notes in your own pod can be shared' };
	}
	// Above the pod's top `.acl` sits the server's, not the owner's, so unsharing has
	// nothing of theirs to fall back to, and one bad write locks them out of the pod.
	if (target === ownPod(owner)) {
		return { skip: 'sharing not applied: the top of your pod is not shared from a note' };
	}

	const head = await fetcher(target, { method: 'HEAD', headers: NO_CACHE });
	const link = /<([^>]*)>\s*;\s*rel="?acl"?/.exec(head.headers.get('link') ?? '')?.[1];
	if (!link) return { skip: 'sharing not applied: the pod names no ACL for it' };
	const aclUrl = new URL(link, target).href;

	const found = await aclVersion(fetcher, aclUrl);
	if (found !== (prev?.etag ?? null)) {
		return {
			record: { key, etag: found },
			skip: 'sharing changed outside the plugin, left as it is; edit share or share-write again to replace it',
		};
	}
	const res = key
		? await fetcher(aclUrl, {
				method: 'PUT',
				headers: { 'content-type': 'text/turtle' },
				body: aclTurtle(owner, target, wanted),
			})
		: found === null
			? null
			: await fetcher(aclUrl, { method: 'DELETE' });
	if (res && !res.ok) return { skip: `sharing not applied: ${res.status}` };
	return { record: { key, etag: key ? await aclVersion(fetcher, aclUrl) : null } };
}
