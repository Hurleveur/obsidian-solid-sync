// Minimal stand-in for the Obsidian API, backed by a real folder on disk.
import fs from 'node:fs';
import path from 'node:path';

export const normalizePath = (p) => p.replace(/\/+$/, '');
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
		return { path: p, stat: { mtime: st.mtimeMs }, extension: 'md' };
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
	getMarkdownFiles() {
		const out = [];
		const walk = (dir) => {
			if (!fs.existsSync(this.abs(dir))) return;
			for (const e of fs.readdirSync(this.abs(dir), { withFileTypes: true })) {
				const rel = dir ? `${dir}/${e.name}` : e.name;
				if (e.isDirectory()) walk(rel);
				else if (e.name.endsWith('.md')) out.push(this.file(rel));
			}
		};
		walk('');
		return out;
	}
	trashed = [];
	trash(f) {
		this.trashed.push(f.path);
		fs.unlinkSync(this.abs(f.path));
	}
}
