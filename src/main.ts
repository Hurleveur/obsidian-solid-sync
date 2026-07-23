import { Notice, Plugin, TAbstractFile } from 'obsidian';
import {
	DEFAULT_SETTINGS,
	SolidSyncSettingTab,
	type SolidSyncSettings,
} from './settings';
import { isSyncTrigger, runSync, type SyncState } from './sync';

/** Wait for a burst of edits to settle before syncing. */
const CHANGE_DEBOUNCE_MS = 10_000;

/** Vault events arriving just after a run are the run's own writes. */
const QUIET_AFTER_SYNC_MS = 2_000;

/** Outcome of the last run, kept on disk so a failure is visible after the notice fades. */
export interface LastRun {
	at: string;
	result?: string;
	error?: string;
}

interface PluginData extends SolidSyncSettings {
	state?: SyncState;
	lastRun?: LastRun;
}

export default class SolidSyncPlugin extends Plugin {
	settings!: SolidSyncSettings;
	state: SyncState = {};
	lastRun?: LastRun;
	private syncing = false;
	private pending?: number;
	private quietUntil = 0;

	async onload() {
		await this.loadSettings();

		this.addRibbonIcon('refresh-cw', 'Sync pod', () => this.sync());
		this.addCommand({
			id: 'sync-now',
			name: 'Sync now',
			callback: () => this.sync(),
		});
		this.addSettingTab(new SolidSyncSettingTab(this.app, this));

		const changed = (file: TAbstractFile) => this.scheduleSync(file.path);
		this.registerEvent(this.app.vault.on('create', changed));
		this.registerEvent(this.app.vault.on('modify', changed));
		this.registerEvent(this.app.vault.on('delete', changed));
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath: string) => {
				// A rename is a delete plus a create: either side may be in the folder.
				this.scheduleSync(oldPath);
				changed(file);
			}),
		);
		this.register(() => window.clearTimeout(this.pending));

		if (this.settings.syncOnStartup && this.settings.podUrl) {
			this.app.workspace.onLayoutReady(() => this.sync());
		}
	}

	/** Debounced sync in response to a vault change. */
	private scheduleSync(path: string) {
		if (!this.settings.syncOnChange) return;
		const busy = this.syncing || Date.now() < this.quietUntil;
		if (!isSyncTrigger(path, this.settings.folder, busy)) return;
		window.clearTimeout(this.pending);
		this.pending = window.setTimeout(
			() => void this.sync(),
			CHANGE_DEBOUNCE_MS,
		);
	}

	async sync() {
		if (this.syncing) {
			new Notice('Solid sync already running.');
			return;
		}
		this.syncing = true;
		const notice = new Notice('Syncing pod…', 0);
		try {
			const result = await runSync(this);
			this.lastRun = { at: new Date().toISOString(), result };
			notice.setMessage(`Solid sync: ${result}`);
		} catch (e) {
			this.lastRun = {
				at: new Date().toISOString(),
				error: (e as Error).message,
			};
			notice.setMessage(`Solid sync failed: ${(e as Error).message}`);
			console.error(e);
		} finally {
			this.syncing = false;
			this.quietUntil = Date.now() + QUIET_AFTER_SYNC_MS;
			await this.saveSettings();
			window.setTimeout(() => notice.hide(), 8000);
		}
	}

	async loadSettings() {
		const data = ((await this.loadData()) ?? {}) as Partial<PluginData>;
		const { state, lastRun, ...settings } = data;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, settings);
		this.state = state ?? {};
		this.lastRun = lastRun;
	}

	async saveSettings() {
		await this.saveData({
			...this.settings,
			lastRun: this.lastRun,
			state: this.state,
		});
	}

	async saveState() {
		await this.saveSettings();
	}
}
