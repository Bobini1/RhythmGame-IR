export enum AvailableLocales {
	Polish = 'pl-PL',
	English_US = 'en-US',
	Chinese_Simplified = 'zh-CN'
}

export const LocaleNativeNames = {
	[AvailableLocales.Polish]: 'Polski',
	[AvailableLocales.English_US]: 'English',
	[AvailableLocales.Chinese_Simplified]: '简体中文'
} satisfies Record<AvailableLocales, string>;
