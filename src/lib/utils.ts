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
	// If the path is an absolute URL (has a scheme) or protocol-relative (//),
	// or other schemes like mailto:, tel:, etc., don't modify it.
	try {
		// new URL will succeed for absolute URLs like "https://..." and throw for relative paths
		new URL(path);
		return path;
	} catch {
		// Not an absolute URL — continue
	}

	// Protocol-relative URLs ("//example.com") or other schemes ("mailto:") should be left alone
	if (path.startsWith('//') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) {
		return path;
	}

	// Normalize to ensure a leading slash
	const normalizedPath = path.startsWith('/') ? path : `/${path}`;

	const prefix = langPrefix();

	// Avoid double-prefixing if path already starts with the language prefix
	if (prefix && (normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`))) {
		return normalizedPath;
	}

	return `${prefix}${normalizedPath}`;
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
