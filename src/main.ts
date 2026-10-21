import { Notice, Plugin, TAbstractFile } from 'obsidian';
import {
	migrateSettings,
	SolidSyncSettingTab,
	type SolidSyncSettings,
} from './settings';
import { ignoreMatcher, isSyncTrigger, runSync, type SyncState } from './sync';

/** Wait for a burst of edits to settle before syncing. */
const CHANGE_DEBOUNCE_MS = 10_000;

/** Vault events arriving just after a run are the run's own writes. */
const QUIET_AFTER_SYNC_MS = 2_000;

/** Outcome of the last run, kept on disk so a failure is visible after the notice fades. */
export interface LastRun {
	at: string;
	result?: string;
	error?: string;
	/** One line per file the run left alone, saying which and why. */
	skipped?: string[];
}

interface PluginData extends SolidSyncSettings {
	state?: SyncState;
	lastRun?: LastRun;
}

export default class SolidSyncPlugin extends Plugin {
	settings!: SolidSyncSettings;
	state: SyncState = {};
	lastRun?: LastRun;
	/** Filled by the run in flight; only a completed one reaches `lastRun`. */
	lastSkipped: string[] = [];
	private syncing = false;
	private pending?: number;
	private quietUntil = 0;
	/** A trigger-worthy edit landed while a run was already past that file. */
	private missedDuringSync = false;
	private lastNotice = '';

	async onload() {
		await this.loadSettings();

		this.addRibbonIcon('refresh-cw', 'Sync pod', () => this.sync(true));
		this.addCommand({
			id: 'sync-now',
			name: 'Sync now',
			callback: () => this.sync(true),
		});
		this.addSettingTab(new SolidSyncSettingTab(this.app, this));

		this.register(() => window.clearTimeout(this.pending));

		// Until layout-ready Obsidian fires `create` for every existing file, and each
		// one would schedule a sync on top of the startup one.
		this.app.workspace.onLayoutReady(() => {
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
			if (this.settings.syncOnStartup && (this.settings.pods.length || this.settings.teamSync)) void this.sync(false, true);
		});
	}

	/** Debounced sync in response to a vault change. */
	private scheduleSync(path: string) {
		if (!this.settings.syncOnChange) return;
		const ignored = ignoreMatcher(this.settings.ignore);
		const triggers = this.settings.pods.some((pod) =>
			isSyncTrigger(path, pod.folder, false, ignored),
		);
		if (!triggers) return;
		if (this.syncing) {
			// The run already read this file's old state; nothing left in it will
			// see this edit. `sync()`'s `finally` schedules one follow-up once it's
			// done, rather than the edit being silently lost.
			this.missedDuringSync = true;
			return;
		}
		if (Date.now() < this.quietUntil) return;
		window.clearTimeout(this.pending);
		this.pending = window.setTimeout(
			() => void this.sync(),
			CHANGE_DEBOUNCE_MS,
		);
	}

	/**
	 * `manual`: the user asked, so the run shows progress and its outcome even if unchanged.
	 * `full`: visit the whole pod; otherwise only what changed in the vault (see `runSync`).
	 */
	async sync(manual = false, full = manual) {
		if (this.syncing) {
			new Notice('Solid sync already running.');
			return;
		}
		this.syncing = true;
		this.missedDuringSync = false;
		// This run covers any edit still waiting on its debounce.
		window.clearTimeout(this.pending);
		const notice = manual ? new Notice('Syncing pod…', 0) : null;
		try {
			const result = await runSync(this, !full);
			this.lastRun = {
				at: new Date().toISOString(),
				result,
				skipped: this.lastSkipped,
			};
			this.notify(`Solid sync: ${result}`, notice);
		} catch (e) {
			this.lastRun = {
				at: new Date().toISOString(),
				error: (e as Error).message,
			};
			this.notify(`Solid sync failed: ${(e as Error).message}`, notice);
			console.error(e);
		} finally {
			this.syncing = false;
			this.quietUntil = Date.now() + QUIET_AFTER_SYNC_MS;
			await this.saveSettings();
			window.setTimeout(() => notice?.hide(), 8000);
			if (this.missedDuringSync) {
				// Same debounce as any other change; an unchanged file won't push
				// again (state already carries its synced mtime and hash), so this
				// costs nothing when nothing after the last read actually moved.
				window.clearTimeout(this.pending);
				this.pending = window.setTimeout(
					() => void this.sync(),
					CHANGE_DEBOUNCE_MS,
				);
			}
		}
	}

	/** An automatic run repeating the last outcome (offline, every edit) stays silent. */
	private notify(msg: string, notice: Notice | null) {
		if (notice) notice.setMessage(msg);
		else if (msg !== this.lastNotice) new Notice(msg, 8000);
		this.lastNotice = msg;
	}

	async loadSettings() {
		const data = ((await this.loadData()) ?? {}) as Partial<PluginData>;
		const { state, lastRun, ...saved } = data;
		this.settings = migrateSettings(saved);
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
