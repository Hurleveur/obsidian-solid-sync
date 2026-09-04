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
// Just enough DOM for the settings tab to render into: children, text and
// classes are recorded, nothing is drawn.
const makeEl = () => ({
	children: [],
	settings: [],
	text: '',
	classes: new Set(),
	createEl(tag, opts) {
		const child = makeEl();
		child.tag = tag;
		if (opts?.text) child.text = opts.text;
		this.children.push(child);
		return child;
	},
	createDiv() {
		return this.createEl('div');
	},
	createSpan() {
		return this.createEl('span');
	},
	empty() {
		this.children.length = 0;
		this.settings.length = 0;
		this.text = '';
	},
	setText(t) {
		this.text = t;
	},
	appendText(t) {
		this.text += t;
	},
	addClass(...cs) {
		for (const c of cs) this.classes.add(c);
	},
	toggleClass(c, on) {
		if (on) this.classes.add(c);
		else this.classes.delete(c);
	},
});

export function setIcon(el, icon) {
	el.icon = icon;
}

export class Modal {
	static opened = [];
	constructor(app) {
		this.app = app;
		this.contentEl = makeEl();
	}
	setTitle(t) {
		this.title = t;
	}
	open() {
		Modal.opened.push(this);
		this.onOpen?.();
	}
	close() {
		this.onClose?.();
	}
	onOpen() {}
	onClose() {}
}

export class PluginSettingTab {
	constructor(app, plugin) {
		this.app = app;
		this.plugin = plugin;
		this.containerEl = makeEl();
	}
}

/** Records a button/text/toggle component; the tab wires callbacks onto it. */
class Component {
	constructor(kind) {
		this.kind = kind;
		this.inputEl = {};
		this.buttonEl = makeEl();
	}
	setButtonText(t) {
		this.buttonText = t;
		return this;
	}
	setCta() {
		return this;
	}
	setIcon(i) {
		this.icon = i;
		return this;
	}
	setTooltip(t) {
		this.tooltip = t;
		return this;
	}
	setDisabled(d) {
		this.disabled = d;
		return this;
	}
	setPlaceholder(p) {
		this.placeholder = p;
		return this;
	}
	setValue(v) {
		this.value = v;
		return this;
	}
	onChange(cb) {
		this.changed = cb;
		return this;
	}
	onClick(cb) {
		this.clicked = cb;
		return this;
	}
}

export class Setting {
	constructor(containerEl) {
		this.nameEl = makeEl();
		this.descEl = makeEl();
		this.components = [];
		containerEl?.settings?.push(this);
	}
	setName(n) {
		this.name = n;
		return this;
	}
	setDesc(d) {
		this.desc = d;
		this.descEl.setText(String(d));
		return this;
	}
	setHeading() {
		this.heading = true;
		return this;
	}
	add(kind, cb) {
		const c = new Component(kind);
		cb(c);
		this.components.push(c);
		return this;
	}
	addButton(cb) {
		return this.add('button', cb);
	}
	addExtraButton(cb) {
		return this.add('extra-button', cb);
	}
	addText(cb) {
		return this.add('text', cb);
	}
	addToggle(cb) {
		return this.add('toggle', cb);
	}
	addTextArea(cb) {
		return this.add('textarea', cb);
	}
}

export class Plugin {}
export class App {}
export class TFile {}

export class Vault {
	constructor(root) {
		this.root = root;
		this.adapter = {
			exists: async (p) => fs.existsSync(path.join(root, p)),
			write: async (p, data) => {
				fs.mkdirSync(path.dirname(this.abs(p)), { recursive: true });
				fs.writeFileSync(this.abs(p), data);
			},
			writeBinary: async (p, data) => this.adapter.write(p, Buffer.from(data)),
			stat: async (p) => {
				if (!fs.existsSync(this.abs(p))) return null;
				const st = fs.statSync(this.abs(p));
				return { mtime: st.mtimeMs, size: st.size, type: 'file' };
			},
		};
	}
	/**
	 * Paths that are on disk but absent from the index — the real vault's two views of
	 * a file do come apart (a note arriving from git or another sync, a dot-folder, the
	 * index simply not caught up), and `create` throws on a path that already exists.
	 */
	unindexed = new Set();
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
		if (this.unindexed.has(p)) return null;
		return fs.existsSync(this.abs(p)) ? this.file(p) : null;
	}
	async create(p, data) {
		if (fs.existsSync(this.abs(p))) {
			throw new Error(`File already exists: ${p}`);
		}
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
				else if (filter(e.name) && !this.unindexed.has(rel))
					out.push(this.file(rel));
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
