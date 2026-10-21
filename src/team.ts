/**
 * The team's pods, from the roster a collective keeps (solid-backoffice,
 * `membres.ttl`): `<group> foaf:member <WebID>` and `<WebID> foaf:nick "name"`.
 * Each member's pod becomes a row at `team/<nick>`, and each nick a name that
 * `share:` may use. The roster grants nothing; what a row can do is still the pod's
 * `.acl` (see docs/plans/team-features.md, chunk 3).
 *
 * The roster is found the way the backoffice finds it: the user's profile names
 * each collective (`org:memberOf`), and the collective's `config.ttl` names its
 * roster (`hs:roster`). The Team roster setting, when filled, replaces that walk.
 */

import type SolidSyncPlugin from './main';
import type { PodConfig } from './settings';
import { ownPod } from './share';
import { NO_CACHE, type Fetcher } from './solid';
import { folderClash, ownedBy } from './sync';

const FOAF = 'http://xmlns.com/foaf/0.1/';
const MEMBER_OF = 'http://www.w3.org/ns/org#memberOf';
// solid-backoffice's own namespace, provisional there too (its src/lib/vocab.ts).
const HS_ROSTER = 'https://pod.nicolasdb.eu/hyperscope/vocab#roster';

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

/**
 * Everyone the roster lists with a nick. A member with none has no folder name.
 * `group`, when known, is the collective the members must belong to.
 */
export function rosterMembers(text: string, rosterUrl: string, group?: string): Member[] {
	const triples = parseTriples(text, rosterUrl);
	const nicks = new Map(
		triples.filter(([, p]) => p === `${FOAF}nick`).map(([s, , o]) => [s, o]),
	);
	const seen = new Set<string>();
	const members: Member[] = [];
	for (const [s, p, webId] of triples) {
		const nick = nicks.get(webId);
		if (p !== `${FOAF}member` || (group && s !== group) || seen.has(webId) || !nick) continue;
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

export async function readRoster(
	fetcher: Fetcher,
	rosterUrl: string,
	group?: string,
): Promise<Member[]> {
	const res = await fetcher(rosterUrl, {
		headers: { Accept: 'text/turtle', ...NO_CACHE },
	});
	if (!res.ok) throw new Error(`roster not readable (${res.status})`);
	return rosterMembers(await res.text(), rosterUrl, group);
}

async function readTriples(fetcher: Fetcher, url: string): Promise<[string, string, string][]> {
	const res = await fetcher(url, { headers: { Accept: 'text/turtle', ...NO_CACHE } });
	if (!res.ok) throw new Error(`${url} not readable (${res.status})`);
	return parseTriples(await res.text(), url);
}

/**
 * The roster of each collective the profile says this WebID belongs to, with the
 * collective's `foaf:name` when it has one. A collective whose config names no
 * roster is left out; one that cannot be read throws, since leaving it out would
 * read as having left it.
 * shortcut: the profile goes through the roster's small Turtle reader, so a profile
 * with blank nodes (other providers) cannot be read; take `n3` then.
 */
export async function discoverRosters(
	fetcher: Fetcher,
	webId: string,
): Promise<{ group: string; roster: string; name?: string }[]> {
	const docOf = (iri: string) => iri.replace(/#.*/, '');
	const profile = await readTriples(fetcher, docOf(webId));
	const groups = new Set(
		profile.filter(([s, p]) => s === webId && p === MEMBER_OF).map(([, , o]) => o),
	);
	const found: { group: string; roster: string; name?: string }[] = [];
	for (const group of groups) {
		if (!/^https?:\/\//.test(group)) continue;
		const config = await readTriples(fetcher, docOf(group));
		const about = (p: string) => config.find(([s, q]) => s === group && q === p)?.[2];
		const roster = about(HS_ROSTER);
		if (roster && /^https?:\/\//.test(roster)) found.push({ group, roster, name: about(`${FOAF}name`) });
	}
	return found;
}

/**
 * Everyone on the team: the `roster` address if one is set, otherwise the rosters
 * of the profile's collectives. `names` says where they came from, for the user.
 * Throws when any of it cannot be read.
 */
export async function findTeam(
	fetcher: Fetcher,
	roster: string,
): Promise<{ names: string[]; members: Member[] }> {
	if (!roster && !fetcher.webId) return { names: [], members: [] };
	const rosters = roster
		? [{ roster, group: undefined, name: roster }]
		: await discoverRosters(fetcher, fetcher.webId as string);
	const members: Member[] = [];
	for (const r of rosters) {
		for (const m of await readRoster(fetcher, r.roster, r.group)) {
			if (!members.some((k) => k.webId === m.webId)) members.push(m);
		}
	}
	return { names: rosters.map((r) => r.name ?? r.group ?? r.roster), members };
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
 * Brings the pod rows and share names in line with `members`: `[]` removes every
 * row the roster added, which is how team sync is turned off. Notes stay.
 */
export async function setTeam(plugin: SolidSyncPlugin, members: Member[]): Promise<string[]> {
	const merged = mergeRoster(plugin.settings.pods, members);
	const team = memberLines(members);
	// Every full run with team sync on gets here: write settings only on a change.
	const same =
		!merged.removed.length &&
		merged.pods.length === plugin.settings.pods.length &&
		team.join('\n') === (plugin.settings.team ?? []).join('\n');
	if (same) return merged.skipped;
	plugin.settings.pods = merged.pods;
	plugin.settings.team = team;
	// The same as removing a row by hand: the notes stay, their sync history goes.
	for (const row of merged.removed) {
		for (const path of ownedBy(plugin.state, row.folder, merged.pods)) {
			delete plugin.state[path];
		}
	}
	await plugin.saveSettings();
	return merged.skipped;
}

/**
 * Reads the team and applies it. An unreadable roster, profile or config (offline,
 * not a member yet) keeps the last rows and names: a failed read says nothing about
 * who left, and dropping rows on it would stop syncing everyone's pod at once.
 */
export async function applyRoster(
	plugin: SolidSyncPlugin,
	fetcher: Fetcher,
	skipped: string[],
): Promise<void> {
	const { roster } = plugin.settings;
	// Logged out, there is no profile to read: an empty team here would drop every row.
	if (!roster && !fetcher.webId) return;
	let members: Member[];
	try {
		({ members } = await findTeam(fetcher, roster));
	} catch (e) {
		skipped.push(`team roster ${roster || 'from your profile'} (${(e as Error).message}; last team kept)`);
		return;
	}
	skipped.push(...(await setTeam(plugin, members)));
}
