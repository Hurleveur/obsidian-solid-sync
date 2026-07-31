/**
 * Minimal Solid client: client-credentials login with DPoP, and container walking.
 *
 * Uses WebCrypto only — no @inrupt/* dependencies. The pod server converts RDF to
 * JSON-LD via content negotiation, so no RDF parser is needed either.
 */

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface PodResource {
	url: string;
	isContainer: boolean;
	modified: string;
	contentType: string;
	/** Bytes, or 0 when the server does not publish it. */
	size: number;
}

const b64url = (bytes: Uint8Array | string): string => {
	const bin =
		typeof bytes === 'string'
			? bytes
			: Array.from(bytes, (b) => String.fromCharCode(b)).join('');
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function signJwt(
	key: CryptoKeyPair,
	header: object,
	payload: object,
): Promise<string> {
	const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
	const sig = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' },
		key.privateKey,
		new TextEncoder().encode(data),
	);
	return `${data}.${b64url(new Uint8Array(sig))}`;
}

/** Anonymous fetcher — enough to read any public pod. */
export const anonymousFetch: Fetcher = (url, init) => fetch(url, init);

/**
 * Logs in with client credentials (created in the pod's account page) and returns
 * a fetcher that signs every request with a fresh DPoP proof. Re-authenticates once
 * on 401 so a long sync outliving the access token still completes.
 */
export async function createFetcher(
	issuer: string,
	clientId: string,
	clientSecret: string,
): Promise<Fetcher> {
	const key = await crypto.subtle.generateKey(
		{ name: 'ECDSA', namedCurve: 'P-256' },
		false,
		['sign', 'verify'],
	);
	const pub = await crypto.subtle.exportKey('jwk', key.publicKey);
	const jwk = { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y };

	const proof = (htu: string, htm: string) =>
		signJwt(
			key,
			{ alg: 'ES256', typ: 'dpop+jwt', jwk },
			{
				htu,
				htm,
				jti: crypto.randomUUID(),
				iat: Math.floor(Date.now() / 1000),
			},
		);

	const tokenUrl = new URL('/.oidc/token', issuer).href;
	const getToken = async (): Promise<string> => {
		const res = await fetch(tokenUrl, {
			method: 'POST',
			headers: {
				authorization: `Basic ${b64url(
					`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`,
				)}`,
				'content-type': 'application/x-www-form-urlencoded',
				dpop: await proof(tokenUrl, 'POST'),
			},
			body: 'grant_type=client_credentials&scope=webid',
		});
		if (!res.ok) {
			throw new Error(
				`Solid login failed (${res.status}). Check the client ID and secret.`,
			);
		}
		return ((await res.json()) as { access_token: string }).access_token;
	};

	let token = await getToken();
	let mintedAt = Date.now();

	const send = (url: string, init: RequestInit, method: string) =>
		proof(url, method).then((dpop) =>
			fetch(url, {
				...init,
				method,
				headers: {
					...init.headers,
					authorization: `DPoP ${token}`,
					dpop,
				},
			}),
		);

	return async (url, init = {}) => {
		const method = init.method ?? 'GET';
		const res = await send(url, init, method);
		// A pod that does not honour our issuer answers 401 to everything, so
		// without this a foreign container would mint a token per resource.
		if (res.status !== 401 || Date.now() - mintedAt < FRESH_TOKEN_MS) return res;
		token = await getToken();
		mintedAt = Date.now();
		return send(url, init, method);
	};
}

/** A 401 sooner than this after minting is a refusal, not an expiry. */
const FRESH_TOKEN_MS = 10_000;

/**
 * Mints client credentials through the pod's account API, so the user never has to
 * find them by hand. The password is used for this one exchange and never stored.
 */
export async function createClientCredentials(
	issuer: string,
	email: string,
	password: string,
): Promise<{ clientId: string; clientSecret: string }> {
	async function call<T>(
		what: string,
		url: string,
		init: RequestInit = {},
	): Promise<T> {
		const res = await fetch(url, init);
		if (!res.ok) throw new Error(`${what} failed (${res.status})`);
		return (await res.json()) as T;
	}

	type Controls = { controls: Record<string, Record<string, string>> };
	const authHeader = (token: string) => ({
		authorization: `CSS-Account-Token ${token}`,
	});
	const index = new URL('/.account/', issuer).href;
	const control = (c: Controls, group: string, name: string) => {
		const url = c.controls[group]?.[name];
		if (!url) throw new Error(`This pod has no ${group}.${name} endpoint.`);
		return url;
	};

	const anon = await call<Controls>('Reading account controls', index);
	const { authorization } = await call<{ authorization: string }>(
		'Login',
		control(anon, 'password', 'login'),
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ email, password }),
		},
	);

	const account = await call<Controls>('Reading account', index, {
		headers: authHeader(authorization),
	});
	const { webIdLinks } = await call<{
		webIdLinks?: Record<string, unknown>;
	}>('Reading WebID', control(account, 'account', 'webId'), {
		headers: authHeader(authorization),
	});
	const webId = Object.keys(webIdLinks ?? {})[0];
	if (!webId) throw new Error('No WebID found on this account.');

	const created = await call<{ id: string; secret: string }>(
		'Creating credentials',
		control(account, 'account', 'clientCredentials'),
		{
			method: 'POST',
			headers: {
				...authHeader(authorization),
				'content-type': 'application/json',
			},
			body: JSON.stringify({ name: 'obsidian-solid-sync', webId }),
		},
	);

	return { clientId: created.id, clientSecret: created.secret };
}

const IANA = 'http://www.w3.org/ns/iana/media-types/';
const MA_FORMAT = 'http://www.w3.org/ns/ma-ont#format';
const LDP_CONTAINS = 'http://www.w3.org/ns/ldp#contains';
const DC_MODIFIED = 'http://purl.org/dc/terms/modified';
const POSIX_SIZE = 'http://www.w3.org/ns/posix/stat#size';

type JsonLdNode = Record<string, unknown> & { '@id'?: string };

/**
 * Collects a predicate across every node sharing an @id. The server splits one
 * subject over several JSON-LD nodes, so looking at only the first loses triples.
 */
function collect(graph: JsonLdNode[], id: string, predicate: string): unknown[] {
	return graph
		.filter((n) => n['@id'] === id)
		.flatMap((n): unknown[] => {
			const v: unknown = n[predicate];
			return Array.isArray(v) ? (v as unknown[]) : v === undefined ? [] : [v];
		});
}

/**
 * A resource's media type, whichever way the server says it. Community Solid
 * Server states it as a plain `ma-ont#format` value; others type the resource
 * with an IANA class. Reading only one leaves `contentType` empty, and an empty
 * one makes every RDF resource look like an opaque attachment.
 */
function mediaTypeOf(graph: JsonLdNode[], url: string): string {
	const format = collect(graph, url, MA_FORMAT)[0] as { '@value'?: string } | undefined;
	if (format?.['@value']) return format['@value'];
	const iana = collect(graph, url, '@type')
		.map(String)
		.find((t) => t.startsWith(IANA));
	return iana ? iana.slice(IANA.length).replace(/#Resource$/, '') : '';
}

function describe(graph: JsonLdNode[], url: string): PodResource {
	const modified = collect(graph, url, DC_MODIFIED)[0] as
		| { '@value'?: string }
		| undefined;
	const size = collect(graph, url, POSIX_SIZE)[0] as
		| { '@value'?: string }
		| undefined;
	return {
		url,
		isContainer: url.endsWith('/'),
		modified: modified?.['@value'] ?? '',
		// Absent on servers that do not publish it — 0 then means "unknown", and
		// an unknown size must never look oversized.
		size: Number(size?.['@value'] ?? 0),
		contentType: mediaTypeOf(graph, url),
	};
}

/**
 * Whether we may write here, read off `WAC-Allow: user="read write", public="read"`.
 *
 * `undefined` means the server did not say — the header is part of WAC, and a pod
 * running ACP omits it. Unknown must not read as "no": the caller tries the write
 * and learns from the 403 instead.
 */
export function canWriteFrom(headers: Headers): boolean | undefined {
	const header = headers.get('wac-allow');
	if (!header) return undefined;
	const modes = /user\s*=\s*"([^"]*)"/i.exec(header)?.[1] ?? '';
	return modes.split(/\s+/).includes('write');
}

/** Lists one container's direct children, and what we may do with it. */
export async function listContainer(
	fetcher: Fetcher,
	url: string,
): Promise<{ children: PodResource[]; canWrite: boolean | undefined }> {
	const res = await fetcher(url, {
		headers: { Accept: 'application/ld+json' },
	});
	if (!res.ok) throw new Error(`${res.status} listing ${url}`);
	const graph = (await res.json()) as JsonLdNode[];
	return {
		children: collect(graph, url, LDP_CONTAINS)
			.map((c) => (c as { '@id': string })['@id'])
			.map((child) => describe(graph, child)),
		canWrite: canWriteFrom(res.headers),
	};
}

/**
 * Walks a container recursively. Unreadable sub-containers are reported, not fatal.
 * `canWrite` describes the root — permissions can differ per sub-container, but the
 * root is what a push to a new note has to go through.
 */
export async function walk(
	fetcher: Fetcher,
	root: string,
): Promise<{
	resources: PodResource[];
	unreadable: string[];
	canWrite: boolean | undefined;
}> {
	const resources: PodResource[] = [];
	const unreadable: string[] = [];
	const queue = [root];
	const seen = new Set(queue);
	let canWrite: boolean | undefined;

	while (queue.length) {
		const url = queue.shift() as string;
		let children: PodResource[];
		try {
			const listing = await listContainer(fetcher, url);
			children = listing.children;
			if (url === root) canWrite = listing.canWrite;
		} catch {
			unreadable.push(url);
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
