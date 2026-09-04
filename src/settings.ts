import { App, Modal, Notice, PluginSettingTab, Setting, setIcon } from 'obsidian';
import type SolidSyncPlugin from './main';
import { createClientCredentials } from './solid';
import {
	deletedLocally,
	folderClash,
	ignoreMatcher,
	ownedBy,
	podPrefix,
} from './sync';

/** One pod container mirrored into one vault folder. */
export interface PodConfig {
	url: string;
	folder: string;
	/** What the last sync found we could do here. Discovered, never set by hand. */
	access?: 'read' | 'write';
}

export interface SolidSyncSettings {
	/** Origin of the pod you logged in to — the only place tokens are minted. */
	issuer: string;
	clientId: string;
	clientSecret: string;
	pods: PodConfig[];
	pushDeletions: boolean;
	syncOnStartup: boolean;
	syncOnChange: boolean;
	/** Files larger than this are left alone on both sides. 0 disables the limit. */
	maxFileMB: number;
	/**
	 * Vault paths no pod syncs, one `.gitignore`-flavoured pattern per entry. Applies
	 * to every pod: a pattern names what does not belong in a pod at all, and the same
	 * attachments folder should not need saying twice.
	 */
	ignore: string[];
}

export const DEFAULT_SETTINGS: SolidSyncSettings = {
	issuer: '',
	clientId: '',
	clientSecret: '',
	pods: [],
	pushDeletions: false,
	syncOnStartup: false,
	syncOnChange: false,
	maxFileMB: 10,
	ignore: [],
};

/** Settings written before pods were a list. Read once, then dropped. */
interface Legacy {
	podUrl?: string;
	folder?: string;
}

/**
 * Folds saved data into a complete settings object, moving a pre-list `podUrl` into
 * `pods[0]`. Sync state is keyed by vault path, so it survives the move untouched
 * and an upgrading user's next sync is a no-op rather than a re-download.
 */
export function migrateSettings(
	saved: Partial<SolidSyncSettings> & Legacy,
): SolidSyncSettings {
	const { podUrl, folder, ...rest } = saved;
	const settings: SolidSyncSettings = Object.assign({}, DEFAULT_SETTINGS, rest);
	// A saved `null` from an old build must not defeat the default, and neither must
	// a list saved as something that is not one — both are iterated without asking.
	if (!Array.isArray(settings.pods)) settings.pods = [];
	if (!Array.isArray(settings.ignore)) settings.ignore = [];
	if (podUrl && !settings.pods.length) {
		settings.pods = [{ url: podUrl, folder: folder ?? 'Pod' }];
		settings.issuer ||= new URL(podUrl).origin;
	}
	return settings;
}

/** Asks for pod account login once, to mint client credentials. Password is not stored. */
class LoginModal extends Modal {
	private email = '';
	private password = '';

	constructor(
		app: App,
		private issuer: string,
		private onDone: (creds: {
			clientId: string;
			clientSecret: string;
		}) => Promise<void>,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		this.setTitle('Log in to your pod');
		contentEl.createEl('p', {
			text: `Creates a token for ${this.issuer}. Your password is used once and never stored.`,
		});

		new Setting(contentEl)
			.setName('Email')
			.addText((t) => t.onChange((v) => (this.email = v)));
		new Setting(contentEl).setName('Password').addText((t) => {
			t.inputEl.type = 'password';
			t.onChange((v) => (this.password = v));
		});

		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText('Create token')
				.setCta()
				.onClick(async () => {
					btn.setDisabled(true).setButtonText('Working…');
					try {
						const creds = await createClientCredentials(
							this.issuer,
							this.email,
							this.password,
						);
						await this.onDone(creds);
						new Notice('Solid credentials saved.');
						this.close();
					} catch (e) {
						new Notice(
							`Solid login failed: ${(e as Error).message}`,
						);
						btn.setDisabled(false).setButtonText('Create token');
					}
				}),
		);
	}

	onClose() {
		this.contentEl.empty();
		this.password = '';
	}
}

/**
 * One irreversible action behind a second click, with what will and will not
 * happen spelled out. Closing any other way — Cancel, Escape, the X — cancels.
 */
class ConfirmModal extends Modal {
	private confirmed = false;

	constructor(
		app: App,
		title: string,
		private body: string,
		private cta: string,
		private onConfirm: () => unknown,
		private onCancel?: () => unknown,
	) {
		super(app);
		this.setTitle(title);
	}

	onOpen() {
		this.contentEl.createEl('p', { text: this.body });
		new Setting(this.contentEl)
			.addButton((btn) =>
				btn.setButtonText('Cancel').onClick(() => this.close()),
			)
			.addButton((btn) => {
				// setWarning() replacement, setDestructive(), needs a newer app
				// than minAppVersion — the class is what both of them set.
				btn.buttonEl.addClass('mod-warning');
				btn
					.setButtonText(this.cta)
					.onClick(async () => {
						this.confirmed = true;
						await this.onConfirm();
						this.close();
					});
			});
	}

	onClose() {
		this.contentEl.empty();
		if (!this.confirmed) this.onCancel?.();
	}
}

const isWebAddress = (url: string) => {
	try {
		return /^https?:$/.test(new URL(url).protocol);
	} catch {
		return false;
	}
};

/**
 * What a folder box means once it is typed, as the row's own note. `/` is the one
 * entry that does not look like what it does — it reads as a folder name and mirrors
 * the entire vault — so it says so, and says whether anything is being kept out of
 * it. Returns the message and whether it is a warning.
 */
export function folderNote(
	folder: string,
	ignore: string[],
): [string, boolean] {
	if (!folder) return ['Saved. Without a folder this pod is not synced.', true];
	if (podPrefix(folder) !== '') return ['Saved.', false];
	return ignore.length
		? ['Saved. This pod mirrors the whole vault; your ignore patterns apply.', false]
		: [
				'Saved. This pod mirrors the whole vault, and nothing is ignored yet — set Ignore below before you sync.',
				true,
			];
}

const accessText = (access: PodConfig['access']) =>
	access === 'write'
		? 'Read and write.'
		: access === 'read'
			? 'Read-only — new notes stay in the vault. An edit is still offered, in case that one note is shared with you.'
			: 'Access is checked on the first sync.';

export class SolidSyncSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: SolidSyncPlugin,
	) {
		super(app, plugin);
	}

	private async set<K extends keyof SolidSyncSettings>(
		key: K,
		value: SolidSyncSettings[K],
	) {
		this.plugin.settings[key] = value;
		await this.plugin.saveSettings();
	}

	/**
	 * What the ignore list costs right now, counted against the vault as it is. Typed
	 * patterns otherwise say nothing until a sync has run, and whether `*.png` really
	 * catches your attachments is exactly what you want to know before that rather
	 * than from the summary afterwards.
	 *
	 * ponytail: re-counted on every keystroke, over every file in every pod folder.
	 * A few regexes across a few thousand paths, so it does not need debouncing until
	 * someone's vault says otherwise.
	 */
	private ignoreCount(): string {
		const { ignore, pods } = this.plugin.settings;
		const rules = ignore.length === 1 ? '1 pattern' : `${ignore.length} patterns`;
		// Rendered without a vault by the settings tests, and by nothing else.
		const files = this.plugin.app.vault?.getFiles?.();
		if (!files) return `${rules}.`;
		const match = ignoreMatcher(ignore);
		const inScope = new Set<string>();
		const left = new Set<string>();
		for (const pod of pods) {
			if (!pod.folder) continue;
			const prefix = podPrefix(pod.folder);
			for (const file of files) {
				if (!file.path.startsWith(prefix)) continue;
				inScope.add(file.path);
				if (match(file.path, prefix)) left.add(file.path);
			}
		}
		if (!inScope.size) return `${rules}. No pod folder to apply them to yet.`;
		return `${rules}. ${left.size} of ${inScope.size} files in your pod folders are left out.`;
	}

	/**
	 * One row per pod, plus a button that adds another. `display()` re-runs from
	 * scratch every time, so a growing list needs nothing beyond re-displaying.
	 */
	private displayPods(containerEl: HTMLElement): void {
		const { pods } = this.plugin.settings;

		new Setting(containerEl)
			.setName('Pods')
			.setDesc(
				"Each container is mirrored into its own vault folder. Add any pod you can read — your own, a shared one, or a public one. A folder may sit inside another pod's folder: the innermost one owns its notes, and no other pod touches them. Use / for the whole vault, and set Ignore below before you do.",
			)
			.setHeading()
			.addButton((btn) =>
				btn
					.setButtonText('Add pod')
					.setCta()
					.onClick(async () => {
						pods.push({ url: '', folder: '' });
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		if (!pods.length) {
			containerEl.createEl('p', {
				text: 'No pods yet. Add pod is the first step: paste the address of any pod you can read, pick a vault folder for it, and its notes arrive on the next sync.',
			});
			return;
		}

		pods.forEach((pod, i) => {
			const row = new Setting(containerEl)
				.setName(`Pod ${i + 1}`)
				.setDesc(accessText(pod.access));
			// Typing saves on every keystroke; this line is where that shows.
			const note = row.descEl.createDiv();
			const show = (msg: string, warn: boolean) => {
				note.setText(msg);
				note.toggleClass('mod-warning', warn);
			};
			row
				.addText((t) =>
					t
						.setPlaceholder('https://pod.example.eu/alex/')
						.setValue(pod.url)
						.onChange(async (v) => {
							const url = v.trim();
							// Every pod path is built by appending to this, so the
							// trailing slash cannot be optional.
							pod.url = url && !url.endsWith('/') ? `${url}/` : url;
							// Permissions belong to the old URL, not this one.
							delete pod.access;
							await this.plugin.saveSettings();
							if (!url) show('Saved. The address is still empty.', true);
							else if (!isWebAddress(pod.url))
								show('Saved, but this is not a full address yet.', true);
							else show('Saved.', false);
						}),
				)
				.addText((t) =>
					t
						.setPlaceholder('Vault folder, or / for all of it')
						.setValue(pod.folder)
						.onChange(async (v) => {
							const folder = v.trim();
							const clash = folderClash(pods, i, folder);
							if (clash) {
								// Two pods sharing one folder would each try to push
								// the other's notes, so refuse rather than save.
								show(
									`"${clash}" is already another pod's folder, so this is not saved. A folder inside another pod's folder is fine.`,
									true,
								);
								return;
							}
							pod.folder = folder;
							await this.plugin.saveSettings();
							show(...folderNote(folder, this.plugin.settings.ignore));
						}),
				)
				.addExtraButton((btn) =>
					btn
						.setIcon('trash-2')
						.setTooltip('Remove this pod')
						.onClick(() => {
							new ConfirmModal(
								this.app,
								'Remove this pod?',
								'The connection goes; every note already in the vault stays where it is, and nothing on the pod is touched.',
								'Remove pod',
								async () => {
									const [removed] = pods.splice(i, 1);
									// The notes stay, and until now so did their sync
									// history — under a folder no pod owns, no run visits
									// those entries again to refresh or drop them. They
									// come back to life if that folder is ever synced
									// again, describing a pod nobody configured any more.
									if (removed?.folder) {
										for (const path of ownedBy(
											this.plugin.state,
											removed.folder,
											pods,
										)) {
											delete this.plugin.state[path];
										}
										await this.plugin.saveState();
									}
									await this.plugin.saveSettings();
									this.display();
								},
							).open();
						}),
				);
		});
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const last = this.plugin.lastRun;
		const status = new Setting(containerEl)
			.setName('Status')
			.addButton((btn) =>
				btn
					.setButtonText('Sync now')
					.setCta()
					.onClick(async () => {
						btn.setDisabled(true).setButtonText('Syncing…');
						await this.plugin.sync();
						this.display();
					}),
			);
		if (last) {
			// A failed run must not read like a good one after the notice fades.
			setIcon(status.descEl.createSpan(), last.error ? 'alert-triangle' : 'check');
			status.descEl.appendText(
				` ${last.error ?? last.result ?? ''} — ${new Date(last.at).toLocaleString()}`,
			);
			if (last.error) status.descEl.addClass('mod-warning');
		} else {
			status.setDesc('Not synced yet.');
		}

		// The count in the status line is the whole of what a skip used to say. Folded
		// away because a healthy run has none, and open is where you look when the
		// number is not the one you expected.
		if (last?.skipped?.length) {
			const details = containerEl.createEl('details');
			details.createEl('summary', {
				text: `${last.skipped.length} skipped — why`,
			});
			const list = details.createEl('ul');
			for (const line of last.skipped) list.createEl('li', { text: line });
		}

		this.displayPods(containerEl);

		new Setting(containerEl)
			.setName('Credentials')
			.setDesc(
				this.plugin.settings.clientId
					? `Token ${this.plugin.settings.clientId.slice(0, 16)}… from ${this.plugin.settings.issuer}. It identifies you to every pod above; each one decides what you may do.`
					: 'Without credentials every pod is read-only, which is enough for public ones.',
			)
			.addButton((btn) =>
				btn.setButtonText('Log in').onClick(() => {
					// Your account lives on one server; that one mints the token
					// every pod in the list is then addressed with.
					const url = this.plugin.settings.pods[0]?.url;
					if (!url) {
						new Notice('Add your own pod first.');
						return;
					}
					const issuer = new URL(url).origin;
					new LoginModal(this.app, issuer, async (creds) => {
						await this.set('issuer', issuer);
						await this.set('clientId', creds.clientId);
						await this.set('clientSecret', creds.clientSecret);
						this.display();
						// Logging in is when notes are expected to appear.
						await this.plugin.sync();
					}).open();
				}),
			)
			.addButton((btn) =>
				btn
					.setButtonText('Clear')
					.setDisabled(!this.plugin.settings.clientId)
					.onClick(() => {
						new ConfirmModal(
							this.app,
							'Clear credentials?',
							'The token is removed from this vault only; your pod account is untouched. Every pod becomes read-only until you log in again, and nothing is deleted on either side.',
							'Clear',
							async () => {
								await this.set('issuer', '');
								await this.set('clientId', '');
								await this.set('clientSecret', '');
								this.display();
							},
						).open();
					}),
			);

		new Setting(containerEl).setName('Syncing').setHeading();

		new Setting(containerEl).setName('Sync on startup').addToggle((t) =>
			t
				.setValue(this.plugin.settings.syncOnStartup)
				.onChange((v) => this.set('syncOnStartup', v)),
		);

		new Setting(containerEl)
			.setName('Sync after changes')
			.setDesc(
				'Syncs about 10 seconds after you add, edit, rename or delete a note in the folder. Waits for a burst of edits to settle.',
			)
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.syncOnChange)
					.onChange((v) => this.set('syncOnChange', v)),
			);

		new Setting(containerEl)
			.setName('Maximum file size (MB)')
			.setDesc(
				'Bigger files are reported as skipped and left untouched on both sides. 0 removes the limit.',
			)
			.addText((t) => {
				t.inputEl.type = 'number';
				t.inputEl.min = '0';
				t.setValue(String(this.plugin.settings.maxFileMB)).onChange((v) => {
					const n = Number(v);
					// A blank or nonsense box must not silently mean "no limit".
					return this.set(
						'maxFileMB',
						Number.isFinite(n) && n >= 0 ? n : DEFAULT_SETTINGS.maxFileMB,
					);
				});
			});

		const ignoreRow = new Setting(containerEl)
			.setName('Ignore')
			.setDesc(
				'One pattern per line, as in .gitignore: "Attachments/" for a folder wherever it sits, "*.png" for a kind of file, "Notes/Media/" for one exact place. A match is left alone on both sides — never uploaded, never pulled, never deleted. The vault\'s own dot-folders are always ignored, whatever is written here.',
			);
		const ignoreNote = ignoreRow.descEl.createDiv();
		ignoreNote.setText(this.ignoreCount());
		ignoreRow.addTextArea((t) => {
			t.inputEl.rows = 4;
			t.setPlaceholder('Attachments/\n*.png')
				.setValue(this.plugin.settings.ignore.join('\n'))
				// Kept as written until it is saved: trimming the box itself would
				// eat the newline the moment it is typed.
				.onChange(async (v) => {
					await this.set(
						'ignore',
						v
							.split('\n')
							.map((line) => line.trim())
							.filter(Boolean),
					);
					ignoreNote.setText(this.ignoreCount());
				});
		});

		new Setting(containerEl).setName('Deleted notes').setHeading();

		new Setting(containerEl)
			.setName('Delete on pod when a note is deleted')
			.setDesc('Off by default. Pod deletions cannot be undone.')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.pushDeletions).onChange((v) => {
					// Turning it off needs no confirm — that only stops future deletions.
					if (!v) {
						void this.set('pushDeletions', false);
						return;
					}
					new ConfirmModal(
						this.app,
						'Delete on the pod too?',
						'From now on, deleting a note in the vault also deletes it on its pod, and a pod deletion cannot be undone. Turning this off again only stops future deletions.',
						'Turn on',
						() => this.set('pushDeletions', true),
						() => t.setValue(false),
					).open();
				}),
			);

		new Setting(containerEl)
			.setName('Restore deleted notes')
			.setDesc(
				'Pulls back notes and attachments a pod still has but the vault no longer does. Deleting one locally otherwise stops it being pulled again, so it stays reported as skipped.',
			)
			.addButton((btn) =>
				btn.setButtonText('Restore').onClick(async () => {
					const { vault } = this.plugin.app;
					const gone = deletedLocally(
						this.plugin.state,
						(path) => vault.getAbstractFileByPath(path) !== null,
					);
					if (!gone.length) {
						new Notice('Nothing to restore — every synced note is in the vault.');
						return;
					}
					for (const path of gone) delete this.plugin.state[path];
					// Saved before syncing: a run that fails partway must not leave the
					// entries behind, or the next one reads them as deletions again.
					await this.plugin.saveSettings();
					await this.plugin.sync();
				}),
			);
	}
}
