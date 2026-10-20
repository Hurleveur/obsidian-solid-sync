/**
 * The team's pods, from the roster a collective keeps (solid-backoffice,
 * `membres.ttl`): `<group> foaf:member <WebID>` and `<WebID> foaf:nick "name"`.
 * Each member's pod becomes a row at `team/<nick>`, and each nick a name that
 * `share:` may use. The roster grants nothing; what a row can do is still the pod's
 * `.acl` (see docs/plans/team-features.md, chunk 3).
 */

import type SolidSyncPlugin from './main';
import type { PodConfig } from './settings';
import { ownPod } from './share';
import { NO_CACHE, type Fetcher } from './solid';
import { folderClash, ownedBy } from './sync';

const FOAF = 'http://xmlns.com/foaf/0.1/';

export interface Member {
	webId: string;
	nick: string;
}

type Token =
	| { iri: string }
	| { literal: string }
	| { pname: string; local: string }
	| { word: string };

const TOKEN =
	/\s+|#[^\n]*|<([^>]*)>|"((?:[^"\\\n]|\\.)*)"(?:@[\w-]+|\^\^\S+)?|([A-Za-z][\w-]*)?:([\w-]*)|(@prefix|PREFIX|a|[;,.])/y;

function tokenize(text: string): Token[] {
	const tokens: Token[] = [];
	let pos = 0;
	while (pos < text.length) {
		TOKEN.lastIndex = pos;
		const m = TOKEN.exec(text);
		if (!m) throw new Error(`unreadable Turtle at character ${pos}`);
		pos = TOKEN.lastIndex;
		const [whole, iri, str, pname, local, word] = m;
		if (iri !== undefined) tokens.push({ iri });
		else if (str !== undefined) tokens.push({ literal: str.replace(/\\(.)/g, '$1') });
		else if (word !== undefined) tokens.push({ word });
		else if (whole.includes(':') && !/^[\s#]/.test(whole))
			tokens.push({ pname: pname ?? '', local: local ?? '' });
	}
	return tokens;
}

/**
 * Just enough Turtle for a roster: `@prefix`/`PREFIX`, IRIs, prefixed names, plain
 * strings, `a`, and `;` `,` `.`. Anything else (blank nodes, collections, long
 * strings) throws, so a file this cannot read is reported, never half-read.
 * shortcut: no full parser, to keep the plugin dependency-free; take `n3` if a
 * roster ever needs more.
 */
export function parseTriples(text: string, base: string): [string, string, string][] {
	const tokens = tokenize(text);
	const prefixes: Record<string, string> = {};
	const triples: [string, string, string][] = [];
	let i = 0;
	const fail = (): never => {
		throw new Error('unreadable Turtle statement');
	};
	const isWord = (w: string) => {
		const t = tokens[i];
		return t !== undefined && 'word' in t && t.word === w;
	};
	const term = (): string => {
		const t = tokens[i++] ?? fail();
		if ('iri' in t) return new URL(t.iri, base).href;
		if ('literal' in t) return t.literal;
		if ('pname' in t) {
			const ns = prefixes[t.pname];
			if (ns === undefined) throw new Error(`undefined prefix "${t.pname}:"`);
			return ns + t.local;
		}
		if (t.word === 'a') return 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
		return fail();
	};

	while (i < tokens.length) {
		if (isWord('@prefix') || isWord('PREFIX')) {
			const sparql = isWord('PREFIX');
			const name = tokens[i + 1];
			const iri = tokens[i + 2];
			if (!name || !('pname' in name) || name.local || !iri || !('iri' in iri)) return fail();
			prefixes[name.pname] = new URL(iri.iri, base).href;
			i += 3;
			if (!sparql) {
				if (!isWord('.')) fail();
				i++;
			}
			continue;
		}
		const s = term();
		do {
			const p = term();
			do triples.push([s, p, term()]);
			while (isWord(',') && ++i);
		} while (isWord(';') && ++i && !isWord('.'));
		if (!isWord('.')) fail();
		i++;
	}
	return triples;
}

/** Everyone the roster lists with a nick. A member with none has no folder name. */
export function rosterMembers(text: string, rosterUrl: string): Member[] {
	const triples = parseTriples(text, rosterUrl);
	const nicks = new Map(
		triples.filter(([, p]) => p === `${FOAF}nick`).map(([s, , o]) => [s, o]),
	);
	const seen = new Set<string>();
	const members: Member[] = [];
	for (const [, p, webId] of triples) {
		const nick = nicks.get(webId);
		if (p !== `${FOAF}member` || seen.has(webId) || !nick) continue;
		// A nick names a folder: the backoffice's own rule, checked again since this
		// file is someone else's and the value ends up in a vault path.
		if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(nick)) continue;
		// The WebID becomes a pod URL every sync reads, and writes to if it can.
		if (!/^https?:\/\//.test(webId)) continue;
		seen.add(webId);
		members.push({ webId, nick });
	}
	return members;
}

export async function readRoster(fetcher: Fetcher, rosterUrl: string): Promise<Member[]> {
	const res = await fetcher(rosterUrl, {
		headers: { Accept: 'text/turtle', ...NO_CACHE },
	});
	if (!res.ok) throw new Error(`roster not readable (${res.status})`);
	return rosterMembers(await res.text(), rosterUrl);
}

/**
 * The pod rows once the roster is applied: a member whose pod no row syncs yet gets
 * `team/<nick>`; a row the roster added and no longer lists goes. Rows added by hand
 * are never changed, and a member whose pod one already syncs gets no second row.
 * Returns the new rows, the ones dropped, and what could not be added.
 */
export function mergeRoster(
	pods: PodConfig[],
	members: Member[],
): { pods: PodConfig[]; removed: PodConfig[]; skipped: string[] } {
	const listed = new Set(members.map((m) => ownPod(m.webId)));
	const removed = pods.filter((p) => p.roster && !listed.has(p.url));
	const next = pods.filter((p) => !removed.includes(p));
	const skipped: string[] = [];
	for (const { webId, nick } of members) {
		const url = ownPod(webId);
		if (next.some((p) => p.url === url)) continue;
		const folder = `team/${nick}`;
		const clash = folderClash(next, next.length, folder);
		if (clash) {
			skipped.push(`${folder} (team member ${nick}: "${clash}" is already another pod's folder)`);
			continue;
		}
		next.push({ url, folder, roster: true });
	}
	return { pods: next, removed, skipped };
}

/** Nicks as `share:` names, in the `name WebID` form of the Team members setting. */
export const memberLines = (members: Member[]) =>
	members.map(({ nick, webId }) => `${nick} ${webId}`);

/**
 * Reads the roster and brings the pod rows and share names in line with it. An
 * unreadable roster (offline, not a member yet) keeps the last rows and names: a
 * failed read says nothing about who left, and dropping rows on it would stop
 * syncing everyone's pod at once.
 */
export async function applyRoster(
	plugin: SolidSyncPlugin,
	fetcher: Fetcher,
	skipped: string[],
): Promise<void> {
	const { roster } = plugin.settings;
	let members: Member[];
	try {
		members = await readRoster(fetcher, roster);
	} catch (e) {
		skipped.push(`team roster ${roster} (${(e as Error).message}; last team kept)`);
		return;
	}
	const merged = mergeRoster(plugin.settings.pods, members);
	skipped.push(...merged.skipped);
	plugin.settings.pods = merged.pods;
	plugin.settings.team = memberLines(members);
	// The same as removing a row by hand: the notes stay, their sync history goes.
	for (const row of merged.removed) {
		for (const path of ownedBy(plugin.state, row.folder, merged.pods)) {
			delete plugin.state[path];
		}
	}
	await plugin.saveSettings();
}
