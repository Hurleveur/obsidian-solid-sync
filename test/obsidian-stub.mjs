// Minimal stand-in for the Obsidian API, backed by a real folder on disk.
import fs from 'node:fs';
import path from 'node:path';

export const normalizePath = (p) => p.replace(/\/+$/, '');

// Stands in for Obsidian's requestUrl, backed by Node's fetch, so the node test
// suite exercises the same requestUrl-shaped path the plugin runs in Obsidian.
export async function requestUrl(opts) {
	const res = await fetch(opts.url, {
		method: opts.method ?? 'GET',
		headers: opts.headers,
		body: opts.body,
	});
	const arrayBuffer = await res.arrayBuffer();
	const text = Buffer.from(arrayBuffer).toString('utf8');
	if (opts.throw !== false && (res.status < 200 || res.status >= 300)) {
		throw new Error(`Request failed, status ${res.status}`);
	}
	return {
		status: res.status,
		headers: Object.fromEntries(res.headers.entries()),
		arrayBuffer,
		text,
		get json() {
			return JSON.parse(text);
		},
	};
}
export class Notice {
	constructor(msg) {
		if (msg) console.log('  [notice]', String(msg).replace(/\n/g, ' | '));
	}
	setMessage(m) {
		console.log('  [notice]', m);
	}
	hide() {}
}
export class Modal {}
export class PluginSettingTab {}
export class Setting {}
export class Plugin {}
export class App {}
export class TFile {}

export class Vault {
	constructor(root) {
		this.root = root;
		this.adapter = {
			exists: async (p) => fs.existsSync(path.join(root, p)),
		};
	}
	abs(p) {
		return path.join(this.root, p);
	}
	file(p) {
		const st = fs.statSync(this.abs(p));
		return {
			path: p,
			stat: { mtime: st.mtimeMs, size: st.size },
			extension: path.extname(p).slice(1),
		};
	}
	async createFolder(p) {
		fs.mkdirSync(this.abs(p), { recursive: true });
	}
	getFileByPath(p) {
		return fs.existsSync(this.abs(p)) ? this.file(p) : null;
	}
	async create(p, data) {
		fs.mkdirSync(path.dirname(this.abs(p)), { recursive: true });
		fs.writeFileSync(this.abs(p), data);
		return this.file(p);
	}
	async modify(f, data) {
		fs.writeFileSync(this.abs(f.path), data);
	}
	async read(f) {
		return fs.readFileSync(this.abs(f.path), 'utf8');
	}
	async createBinary(p, data) {
		return this.create(p, Buffer.from(data));
	}
	async modifyBinary(f, data) {
		fs.writeFileSync(this.abs(f.path), Buffer.from(data));
	}
	async readBinary(f) {
		const b = fs.readFileSync(this.abs(f.path));
		return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
	}
	getFiles(filter = () => true) {
		const out = [];
		const walk = (dir) => {
			if (!fs.existsSync(this.abs(dir))) return;
			for (const e of fs.readdirSync(this.abs(dir), { withFileTypes: true })) {
				const rel = dir ? `${dir}/${e.name}` : e.name;
				if (e.isDirectory()) walk(rel);
				else if (filter(e.name)) out.push(this.file(rel));
			}
		};
		walk('');
		return out;
	}
	getMarkdownFiles() {
		return this.getFiles((n) => n.endsWith('.md'));
	}
	trashed = [];
	trash(f) {
		this.trashed.push(f.path);
		fs.unlinkSync(this.abs(f.path));
	}
}
