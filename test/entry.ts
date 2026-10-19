export * from '../src/sync';
export * from '../src/solid';
export * from '../src/share';
export { folderNote, migrateSettings, SolidSyncSettingTab } from '../src/settings';
// The stub's Modal records what opens; re-exported so tests share its instance.
export { Modal } from 'obsidian';
export { default as SolidSyncPlugin } from '../src/main';
