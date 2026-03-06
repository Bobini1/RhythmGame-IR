import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { page } from '$app/state';
import { goto as svelteGoto } from '$app/navigation';

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/** Returns the current language prefix, e.g. "/pl-PL" or "" */
export function langPrefix(): string {
	return page.params.lang ? `/${page.params.lang}` : '';
}

/** Prepends the current language prefix to a path, e.g. "/signin" → "/pl-PL/signin" */
export function langHref(path: string): string {
	return `${langPrefix()}${path}`;
}

/** Like SvelteKit's goto() but automatically prepends the current language prefix */
export function langGoto(path: string, opts?: Parameters<typeof svelteGoto>[1]): ReturnType<typeof svelteGoto> {
	return svelteGoto(langHref(path), opts);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WithoutChild<T> = T extends { child?: any } ? Omit<T, 'child'> : T;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WithoutChildren<T> = T extends { children?: any } ? Omit<T, 'children'> : T;
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null };
