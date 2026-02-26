import { AvailableLocales } from '$lib/enums/available-locales';

export const localeCookieName = 'locale';
export const defaultLocale = AvailableLocales.English_US;
export const directionMap: Partial<Record<AvailableLocales, DirectionSetting>> = {
	[AvailableLocales.Polish]: 'rl',
	[AvailableLocales.English_US]: 'lr'
};
export const getDirection = (locale: AvailableLocales): DirectionSetting => {
	const directionSelection = directionMap[locale] ?? directionMap[defaultLocale]!;
	return directionSelection;
};
export const AppName: string = 'RhythmGame';
export const SupportEmail: string = 'bobini@rhythmgame.eu';
export const BaseUrl: string = 'https://rhythmgame.eu';
export const BaseDemoUrl: string = 'https://ssv5.templates.guylahav.com/';
export const Author: string = 'Tomasz Kalisiak';
export const TwitterUsername: string = '@bobini2';
export const TwitterSitename: string = '@bobini2';
