/**
 * Shared pagination types for GraphQL.
 */
import builder from '../builder';

// Generic paginated result — we build concrete versions per type
export interface PaginatedResult<T> {
	items: T[];
	totalCount: number;
	hasNextPage: boolean;
	hasPreviousPage: boolean;
}

export const PageInfoType = builder.objectRef<{
	hasNextPage: boolean;
	hasPreviousPage: boolean;
	totalCount: number;
}>('PageInfo').implement({
	fields: (t) => ({
		hasNextPage: t.exposeBoolean('hasNextPage'),
		hasPreviousPage: t.exposeBoolean('hasPreviousPage'),
		totalCount: t.exposeInt('totalCount')
	})
});

/**
 * Creates a paginated wrapper type for a given object type.
 */
export function createPaginatedType<T>(
	name: string,
	itemRef: Parameters<typeof builder.objectRef<T>>[0] extends string ? never : any,
	_itemType: { new (): T } | ((...args: any[]) => T) | undefined = undefined
) {
	return builder
		.objectRef<PaginatedResult<T>>(`Paginated${name}`)
		.implement({
			fields: (t) => ({
				items: t.field({
					type: [itemRef],
					resolve: (parent) => parent.items
				}),
				pageInfo: t.field({
					type: PageInfoType,
					resolve: (parent) => ({
						hasNextPage: parent.hasNextPage,
						hasPreviousPage: parent.hasPreviousPage,
						totalCount: parent.totalCount
					})
				})
			})
		});
}

