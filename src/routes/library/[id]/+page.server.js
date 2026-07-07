import { error } from '@sveltejs/kit';
import { getItems, LIBRARY_PAGE_SIZE } from '$lib/server/jellyfin.js';

export async function load({ locals, params, parent }) {
    const { views } = await parent();
    const view = views.find((candidate) => candidate.id === params.id);
    if (!view) error(404, 'Library not found');

    const result = await getItems(locals.session, {
        parentId: view.id,
        recursive: true,
        includeItemTypes: view.collectionType === 'movies' ? 'Movie' : 'Series',
        sortBy: 'SortName',
        sortOrder: 'Ascending',
        startIndex: 0,
        limit: LIBRARY_PAGE_SIZE,
        enableImageTypes: 'Primary',
    });

    return {
        view,
        items: result?.Items ?? [],
        total: result?.TotalRecordCount ?? 0,
    };
}
