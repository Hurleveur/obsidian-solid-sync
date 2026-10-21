import { App, Modal, Notice, PluginSettingTab, Setting, setIcon } from 'obsidian';
import type SolidSyncPlugin from './main';
import { createFetcher, logInToAccount, webIdFor, type Account } from './solid';
import { findTeam, setTeam, VAULT_FOLDER, type Member, type SharedPod } from './team';
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
	/** Added from the team roster, and removed when the roster stops listing it. */
	roster?: boolean;
}

export interface SolidSyncSettings {
	/** Origin of the pod you logged in to — the only place tokens are minted. */
	issuer: string;
	clientId: string;
	clientSecret: string;
	/** Who the token acts as, for display. Saved at login. */
	webId: string;
	pods: PodConfig[];
	pushDeletions: boolean;
	syncOnStartup: boolean;
	syncOnChange: boolean;
	/** Append what this device pushed or deleted to `_sync-log/<you>.md` in each pod folder. */
	syncLog: boolean;
	/** Keep every file the sync overwrites or deletes, on this device only. */
	history: boolean;
	/** Files larger than this are left alone on both sides. 0 disables the limit. */
	maxFileMB: number;
	/**
	 * Vault paths no pod syncs, one `.gitignore`-flavoured pattern per entry. Applies
	 * to every pod: a pattern names what does not belong in a pod at all, and the same
	 * attachments folder should not need saying twice.
	 */
	ignore: string[];
	/** `name WebID` per line: who a note's `share` and `share-write` may name. */
	members: string[];
	/** Whether the team's member pods are synced at `team/<nick>`. Off until asked. */
	teamSync: boolean;
	/** A collective's `membres.ttl`, used instead of the ones the profile's teams name. */
	roster: string;
	/** `nick WebID` per member, from the last roster read. Discovered, never set by hand. */
	team: string[];
}

export const DEFAULT_SETTINGS: SolidSyncSettings = {
	issuer: '',
	clientId: '',
	clientSecret: '',
	webId: '',
	pods: [],
	pushDeletions: false,
	syncOnStartup: false,
	syncOnChange: false,
	syncLog: true,
	history: true,
	maxFileMB: 10,
	ignore: [],
	members: [],
	teamSync: false,
	roster: '',
	team: [],
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
	// Copied either way: a fresh vault would otherwise push into DEFAULT_SETTINGS' own.
	const list = <T>(v: T[]) => (Array.isArray(v) ? [...v] : []);
	settings.pods = list(settings.pods);
	settings.ignore = list(settings.ignore);
	settings.members = list(settings.members);
	settings.team = list(settings.team);
	// Before the switch existed, filling in a roster was turning team sync on.
	if (saved.teamSync === undefined) settings.teamSync = Boolean(settings.roster);
	if (podUrl && !settings.pods.length) {
		settings.pods = [{ url: podUrl, folder: folder ?? 'Pod' }];
		settings.issuer ||= new URL(podUrl).origin;
	}
	return settings;
}

/** What the login's last screen asks the tab to set up. */
export interface LoginSetup {
	/** Your own pod, to add as a row at `folder`; absent when a row syncs it already. */
	pod?: { url: string; folder: string };
	/** The team to turn team sync on with, as read during the login. */
	team?: { members: Member[]; vaults: SharedPod[] };
}

/**
 * Logs in, then sets up: server and password, which pod is yours (only when the
 * account has several), then your pod's folder and your team. Exactly one token is
 * minted, and it is saved before the last screen, so closing there leaves you logged
 * in with nothing added. The password is used once and never stored.
 */
class LoginModal extends Modal {
	private email = '';
	private password = '';

	constructor(
		app: App,
		private issuer: string,
		private plugin: SolidSyncPlugin,
		private onLogin: (
			creds: { clientId: string; clientSecret: string },
			issuer: string,
			webId: string,
		) => Promise<void>,
		private onSetup: (setup: LoginSetup) => Promise<void>,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		this.setTitle('Log in to your pod');
		contentEl.createEl('p', {
			text: 'Your account is on one server. Logging in creates a token there for this vault; your password is used once and never stored.',
		});

		new Setting(contentEl)
			.setName('Server')
			.setDesc('The address of the server that holds your account.')
			.addText((t) =>
				t
					.setPlaceholder('https://pod.example.eu')
					.setValue(this.issuer)
					.onChange((v) => (this.issuer = v.trim())),
			);
		new Setting(contentEl)
			.setName('Email')
			.addText((t) => t.onChange((v) => (this.email = v)));
		let submit = () => {};
		new Setting(contentEl).setName('Password').addText((t) => {
			t.inputEl.type = 'password';
			t.onChange((v) => (this.password = v));
			t.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
				if (e.key === 'Enter') submit();
			});
		});

		new Setting(contentEl).addButton((btn) => {
			submit = () => void btn.buttonEl.click();
			btn
				.setButtonText('Log in')
				.setCta()
				.onClick(async () => {
					let issuer: string;
					try {
						const url = new URL(this.issuer);
						if (!/^https?:$/.test(url.protocol)) throw new Error();
						issuer = url.origin;
					} catch {
						new Notice('Enter the address of your server first.');
						return;
					}
					btn.setDisabled(true).setButtonText('Logging in…');
					try {
						const account = await logInToAccount(issuer, this.email, this.password);
						if (this.closed) return;
						if (!account.webIds.length) throw new Error('No WebID found on this account.');
						if (account.pods.length > 1) this.choosePod(issuer, account);
						else await this.finish(issuer, account, account.pods[0]);
					} catch (e) {
						new Notice(`Solid login failed: ${(e as Error).message}`);
						btn.setDisabled(false).setButtonText('Log in');
					}
				});
		});
	}

	/** An account with several pods: the one picked is also who the token acts as. */
	private choosePod(issuer: string, account: Account) {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle('Which pod is yours?');
		const synced = account.pods.find((p) => this.plugin.settings.pods.some((r) => r.url === p));
		let pod = synced ?? account.pods[0] ?? '';
		new Setting(contentEl)
			.setName('Your pod')
			.setDesc('Your account has several. You act as the one you pick.')
			.addDropdown((d) => {
				for (const p of account.pods) d.addOption(p, p);
				d.setValue(pod).onChange((v) => (pod = v));
			});
		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText('Continue')
				.setCta()
				.onClick(async () => {
					btn.setDisabled(true).setButtonText('Logging in…');
					try {
						await this.finish(issuer, account, pod);
					} catch (e) {
						new Notice(`Solid login failed: ${(e as Error).message}`);
						btn.setDisabled(false).setButtonText('Continue');
					}
				}),
		);
	}

	/**
	 * Mints the one token, saves it, then offers your pod and your team. A retry after
	 * a failed save reuses the token already minted rather than leaving it orphaned.
	 */
	private async finish(issuer: string, account: Account, pod?: string) {
		const webId = webIdFor(account, pod);
		if (!webId) throw new Error(`No WebID of this account lives in ${pod ?? 'a pod'}.`);
		if (this.minted?.webId !== webId) {
			this.minted = { webId, creds: await account.mint(webId) };
		}
		const { creds } = this.minted;
		await this.onLogin(creds, issuer, webId);
		if (this.closed) return;

		const { pods, teamSync, roster } = this.plugin.settings;
		const row = pod ? pods.find((p) => p.url === pod) : undefined;
		// Best effort: a team that cannot be read is still one Team sync can retry.
		// Read even with team sync on: it names the folder your own pod goes in.
		let team: Awaited<ReturnType<typeof findTeam>> | undefined;
		let teamError = '';
		try {
			team = await findTeam(await createFetcher(issuer, creds.clientId, creds.clientSecret), roster);
		} catch (e) {
			teamError = (e as Error).message;
		}
		if (this.closed) return;
		const me = team?.members.find((m) => m.webId === webId);
		const offerTeam = !teamSync && Boolean(team?.members.length);
		if ((!pod || row) && !offerTeam) {
			new Notice(
				row ? `Logged in. Your pod already syncs at ${row.folder}.` : 'Logged in.',
			);
			this.close();
			return;
		}

		const { contentEl } = this;
		contentEl.empty();
		this.setTitle('What to sync');
		const podName = pod ? (new URL(pod).pathname.split('/').filter(Boolean).pop() ?? '') : '';
		let folder = me ? `team/${me.nick}` : podName;
		let withTeam = offerTeam;
		if (pod && row) {
			new Setting(contentEl).setName('Your pod').setDesc(`${pod} already syncs at ${row.folder}.`);
		} else if (pod) {
			const s = new Setting(contentEl)
				.setName('Folder in this vault')
				.setDesc(`Where the notes of your pod, ${pod}, are kept in Obsidian. Only this vault: nothing on the pod changes.`);
			const note = s.descEl.createDiv();
			s.addText((t) =>
				t
					.setPlaceholder('Folder, or / for the whole vault')
					.setValue(folder)
					.onChange((v) => {
						folder = v.trim();
						note.setText('');
					}),
			);
			this.folderNote = note;
		}
		if (team && offerTeam) {
			const nicks = team.members.map((m) => m.nick).join(', ');
			const shared = team.vaults.length ? `, and its shared pod at ${VAULT_FOLDER}/` : '';
			new Setting(contentEl)
				.setName(`Sync ${team.names.join(', ')}`)
				.setDesc(
					`Adds the pods of its ${team.members.length} members (${nicks}) at team/<their name>${shared}, and keeps them in step as people join and leave. Each pod still decides what you may read there.`,
				)
				.addToggle((t) => t.setValue(withTeam).onChange((v) => (withTeam = v)));
		} else if (teamError && !teamSync) {
			contentEl.createEl('p', { text: `Your team could not be read (${teamError}). Team sync in the settings can try again.` });
		}

		new Setting(contentEl)
			.addButton((btn) => btn.setButtonText('Not now').onClick(() => this.close()))
			.addButton((btn) =>
				btn
					.setButtonText('Start syncing')
					.setCta()
					.onClick(async () => {
						let add: LoginSetup['pod'];
						if (pod && !row) {
							const clash = folderClash(pods, pods.length, folder);
							const problem = !folder
								? 'Pick a folder for your pod.'
								: clash
									? `"${clash}" is already another pod's folder.`
									: '';
							if (problem) {
								this.folderNote?.setText(problem);
								this.folderNote?.addClass('mod-warning');
								return;
							}
							add = { url: pod, folder };
						}
						btn.setDisabled(true).setButtonText('Starting…');
						try {
							await this.onSetup({ pod: add, team: withTeam ? team : undefined });
							this.close();
						} catch (e) {
							new Notice(`Could not start syncing: ${(e as Error).message}`);
							btn.setDisabled(false).setButtonText('Start syncing');
						}
					}),
			);
	}

	private folderNote?: HTMLElement;
	private minted?: { webId: string; creds: { clientId: string; clientSecret: string } };
	// Closing mid-login leaves the work running; past this point it touches no screen.
	private closed = false;

	onClose() {
		this.closed = true;
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

	/**
	 * On reads the team at once, so a profile naming none says so now rather than at
	 * the next sync. Off removes the rows team sync added; notes stay, and rows added
	 * by hand are kept. `display()` afterwards shows the toggle as it really is.
	 */
	private async setTeamSync(on: boolean) {
		if (!on) {
			await this.set('teamSync', false);
			await setTeam(this.plugin, []);
			this.display();
			return;
		}
		const { issuer, clientId, clientSecret, roster } = this.plugin.settings;
		let found: Awaited<ReturnType<typeof findTeam>>;
		try {
			found = await findTeam(await createFetcher(issuer, clientId, clientSecret), roster);
		} catch (e) {
			new Notice(`Could not read your team: ${(e as Error).message}`);
			this.display();
			return;
		}
		if (!found.members.length) {
			new Notice('Your profile names no team with a member list.');
			this.display();
			return;
		}
		await this.set('teamSync', true);
		await setTeam(this.plugin, found.members, found.vaults);
		new Notice(`Syncing ${found.names.join(', ')}: ${found.members.map((m) => m.nick).join(', ')}.`);
		this.display();
		await this.plugin.sync(true);
		this.display();
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
				"Each pod is kept in its own folder of this vault. Logging in offers your own pod; add any other you can read — a shared one, or a public one. A folder may sit inside another pod's folder: the innermost one owns its notes, and no other pod touches them. Use / for the whole vault, and set Ignore below before you do.",
			)
			.setHeading()
			.addButton((btn) =>
				btn
					.setButtonText('Add pod')
					.onClick(async () => {
						pods.push({ url: '', folder: '' });
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		if (!pods.length) {
			containerEl.createEl('p', {
				text: this.plugin.settings.clientId
					? 'No pods yet. Log in again to be offered your own, or Add pod for any pod you can read.'
					: 'No pods yet. Log in above and your own pod is offered; Add pod is for any other pod you can read.',
			});
			return;
		}

		pods.forEach((pod, i) => {
			// Two rows, folder first: where the notes are in Obsidian, then where they
			// are online. One row of two bare boxes read as two halves of one address.
			const row = new Setting(containerEl)
				.setName(`Pod ${i + 1}: folder in this vault`)
				.setDesc('Where its notes are kept in Obsidian. Changing it changes nothing on the pod.');
			const web = new Setting(containerEl)
				.setName('Pod address')
				.setDesc(`Where the notes are stored online. ${accessText(pod.access)}`);
			// Typing saves on every keystroke; these lines are where that shows.
			const noteOf = (s: Setting) => {
				const el = s.descEl.createDiv();
				return (msg: string, warn: boolean) => {
					el.setText(msg);
					el.toggleClass('mod-warning', warn);
				};
			};
			const show = noteOf(row);
			const showUrl = noteOf(web);
			web.addText((t) =>
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
						if (!url) showUrl('Saved. The address is still empty.', true);
						else if (!isWebAddress(pod.url))
							showUrl('Saved, but this is not a full address yet.', true);
						else showUrl('Saved.', false);
					}),
			);
			row
				.addText((t) =>
					t
						.setPlaceholder('Folder, or / for the whole vault')
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

	/** Opens the login, guessing the server from whatever is already set. */
	private logIn() {
		const { issuer: known, pods, roster } = this.plugin.settings;
		const url = pods[0]?.url || roster || known;
		const guess = url && isWebAddress(url) ? new URL(url).origin : '';
		new LoginModal(
			this.app,
			guess,
			this.plugin,
			async (creds, issuer, webId) => {
				await this.set('issuer', issuer);
				await this.set('clientId', creds.clientId);
				await this.set('clientSecret', creds.clientSecret);
				await this.set('webId', webId);
				this.display();
			},
			async ({ pod, team }) => {
				if (pod) this.plugin.settings.pods.push(pod);
				if (team) this.plugin.settings.teamSync = true;
				await this.plugin.saveSettings();
				if (team) await setTeam(this.plugin, team.members, team.vaults);
				this.display();
				// Logging in is when notes are expected to appear, if any can. Not
				// awaited: the dialog closes now, and the status line shows the run.
				const { pods: rows, teamSync: on } = this.plugin.settings;
				if (rows.length || on) void this.plugin.sync(true).then(() => this.display());
			},
		).open();
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const { clientId, issuer, webId, pods, teamSync, team } = this.plugin.settings;
		const loggedIn = Boolean(clientId);
		const hasWork = teamSync || pods.some((p) => p.url && p.folder);

		// One blue button per state, the next step: Log in, then Sync now. Logged in with
		// nothing to sync, the step is the Team sync toggle, which takes no blue. A button
		// that cannot work yet is greyed rather than refusing later.
		new Setting(containerEl)
			.setName('Account')
			.setDesc(
				loggedIn
					? `Logged in${webId ? ` as ${webId}` : ''} on ${issuer}. Every pod below sees you as this; each one decides what you may do.`
					: 'Log in to sync your own pod and your team. Public pods work without it, read-only.',
			)
			.addButton((btn) => {
				btn.setButtonText(loggedIn ? 'Log in again' : 'Log in').onClick(() => this.logIn());
				if (!loggedIn) btn.setCta();
			})
			.addButton((btn) =>
				btn
					.setButtonText('Log out')
					.setDisabled(!loggedIn)
					.onClick(() => {
						new ConfirmModal(
							this.app,
							'Log out?',
							'The token is removed from this vault only; your pod account is untouched. Every pod becomes read-only until you log in again, and nothing is deleted on either side.',
							'Log out',
							async () => {
								await this.set('issuer', '');
								await this.set('clientId', '');
								await this.set('clientSecret', '');
								await this.set('webId', '');
								this.display();
							},
						).open();
					}),
			);

		const last = this.plugin.lastRun;
		const status = new Setting(containerEl)
			.setName('Status')
			.addButton((btn) => {
				btn.setButtonText('Sync now').setDisabled(!hasWork);
				if (hasWork && loggedIn) btn.setCta();
				btn.onClick(async () => {
					btn.setDisabled(true).setButtonText('Syncing…');
					await this.plugin.sync(true);
					this.display();
				});
			});
		if (last) {
			// A failed run must not read like a good one after the notice fades.
			setIcon(status.descEl.createSpan(), last.error ? 'alert-triangle' : 'check');
			status.descEl.appendText(
				` ${last.error ?? last.result ?? ''} — ${new Date(last.at).toLocaleString()}`,
			);
			if (last.error) status.descEl.addClass('mod-warning');
		} else {
			status.setDesc(
				hasWork
					? 'Not synced yet.'
					: loggedIn
						? 'Nothing to sync yet: turn on Team sync, or add a pod below.'
						: 'Nothing to sync yet: log in, or add a pod below.',
			);
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

		new Setting(containerEl)
			.setName('Team sync')
			.setDesc(
				teamSync
					? `On: ${team.length} members (${team.map((l) => l.split(' ')[0]).join(', ')}) at team/<their name>, and your team's shared pod at ${VAULT_FOLDER}/. Each sync adds whoever joins and stops syncing whoever leaves; their notes stay.`
					: loggedIn
						? `Adds everyone on your team at team/<their name>, and your team's shared pod at ${VAULT_FOLDER}/. Your profile says which team you are in.`
						: 'Log in first: your profile says which team you are in.',
			)
			.addToggle((t) =>
				t
					.setValue(teamSync)
					.setDisabled(!loggedIn && !teamSync)
					.onChange((v) => this.setTeamSync(v)),
			);

		this.displayPods(containerEl);


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
			.setName('Keep a sync log')
			.setDesc(
				'After each sync, notes this device uploaded or deleted on a pod you can write to are listed in _sync-log/ inside the folder, one file per person, so a team can see who changed what and when. Changes made by other apps are not recorded.',
			)
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.syncLog)
					.onChange((v) => this.set('syncLog', v)),
			);

		new Setting(containerEl)
			.setName('Keep local history')
			.setDesc(
				'Before a sync overwrites or deletes a note, here or on a pod, a copy is stored in this plugin\'s history folder, so a bad sync can be put back by hand. It never leaves this device and is never pruned.',
			)
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.history)
					.onChange((v) => this.set('history', v)),
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

		new Setting(containerEl)
			.setName('Team members')
			.setDesc(
				'One per line: a name, a space, then their WebID. A note in your own pod with "share: [name]" in its properties can be read by them, and "share-write: [name]" lets them edit it, once you edit and sync it. A WebID can be written there directly too.',
			)
			.addTextArea((t) => {
				t.inputEl.rows = 3;
				t.setPlaceholder('neil https://pod.example/neil/profile/card#me')
					.setValue(this.plugin.settings.members.join('\n'))
					.onChange(async (v) => {
						await this.set(
							'members',
							v
								.split('\n')
								.map((line) => line.trim())
								.filter(Boolean),
						);
					});
			});

		new Setting(containerEl)
			.setName('Team roster')
			.setDesc(
				'Optional. A member list (a membres.ttl) to use instead of the teams your profile names.',
			)
			.addText((t) =>
				t
					.setPlaceholder('https://pod.example/team/membres.ttl')
					.setValue(this.plugin.settings.roster)
					.onChange(async (v) => {
						await this.set('roster', v.trim());
					}),
			);

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
					await this.plugin.sync(true);
				}),
			);
	}
}
