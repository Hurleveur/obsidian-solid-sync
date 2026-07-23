import { App, Modal, Notice, PluginSettingTab, Setting } from 'obsidian';
import type SolidSyncPlugin from './main';
import { createClientCredentials } from './solid';

export interface SolidSyncSettings {
	podUrl: string;
	folder: string;
	clientId: string;
	clientSecret: string;
	pushDeletions: boolean;
	syncOnStartup: boolean;
	syncOnChange: boolean;
	/** Files larger than this are left alone on both sides. 0 disables the limit. */
	maxFileMB: number;
}

export const DEFAULT_SETTINGS: SolidSyncSettings = {
	podUrl: '',
	folder: 'Pod',
	clientId: '',
	clientSecret: '',
	pushDeletions: false,
	syncOnStartup: false,
	syncOnChange: false,
	maxFileMB: 10,
};

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

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const last = this.plugin.lastRun;
		new Setting(containerEl)
			.setName('Status')
			.setDesc(
				last
					? `${last.error ?? last.result ?? ''} — ${new Date(last.at).toLocaleString()}`
					: 'Not synced yet.',
			)
			.addButton((btn) =>
				btn
					.setButtonText('Sync now')
					.setCta()
					.onClick(async () => {
						await this.plugin.sync();
						this.display();
					}),
			);

		new Setting(containerEl)
			.setName('Pod container URL')
			.setDesc(
				'The container to sync, for example https://pod.example.eu/alex/',
			)
			.addText((t) =>
				t
					.setPlaceholder('https://pod.example.eu/alex/')
					.setValue(this.plugin.settings.podUrl)
					.onChange((v) => this.set('podUrl', v.trim())),
			);

		new Setting(containerEl)
			.setName('Vault folder')
			.setDesc(
				'Notes are created here. Existing notes in it are synced to the pod.',
			)
			.addText((t) =>
				t
					.setValue(this.plugin.settings.folder)
					.onChange((v) => this.set('folder', v.trim())),
			);

		new Setting(containerEl)
			.setName('Credentials')
			.setDesc(
				this.plugin.settings.clientId
					? `Token ${this.plugin.settings.clientId.slice(0, 16)}… — writing enabled.`
					: 'Without credentials the pod is read-only, which is enough for public pods.',
			)
			.addButton((btn) =>
				btn.setButtonText('Log in').onClick(() => {
					const url = this.plugin.settings.podUrl;
					if (!url) {
						new Notice('Set the pod URL first.');
						return;
					}
					new LoginModal(
						this.app,
						new URL(url).origin,
						async (creds) => {
							await this.set('clientId', creds.clientId);
							await this.set('clientSecret', creds.clientSecret);
							this.display();
							// Logging in is when notes are expected to appear.
							await this.plugin.sync();
						},
					).open();
				}),
			)
			.addButton((btn) =>
				btn.setButtonText('Clear').onClick(async () => {
					await this.set('clientId', '');
					await this.set('clientSecret', '');
					this.display();
				}),
			);

		new Setting(containerEl)
			.setName('Delete on pod when a note is deleted')
			.setDesc('Off by default. Pod deletions cannot be undone.')
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.pushDeletions)
					.onChange((v) => this.set('pushDeletions', v)),
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
	}
}
