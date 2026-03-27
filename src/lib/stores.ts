import { writable } from 'svelte/store';
import { Themes } from './enums/theme';

export const direction = writable<DirectionSetting>('rl');
export const theme = writable(Themes.Default);
export const analyticsAllowed = writable(false);
