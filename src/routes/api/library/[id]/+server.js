import { json, error } from '@sveltejs/kit';
import { getViews, getItems, LIBRARY_PAGE_SIZE } from '$lib/server/jellyfin.js';

// JSON pages for the library infinite scroll. The id is validated against the
// user's actual views so this can't be used to enumerate arbitrary folders.
export async function GET({ params, url, locals }) {
    const views = await getViews(locals.session);
    const view = views.find((candidate) => candidate.id === params.id);
    if (!view) error(404, 'Library not found');

    const startIndex = Math.max(0, Number(url.searchParams.get('startIndex')) || 0);
    const result = await getItems(locals.session, {
        parentId: view.id,
        recursive: true,
        includeItemTypes: view.collectionType === 'movies' ? 'Movie' : 'Series',
        sortBy: 'SortName',
        sortOrder: 'Ascending',
        startIndex,
        limit: LIBRARY_PAGE_SIZE,
        enableImageTypes: 'Primary',
    });

    return json({
        items: result?.Items ?? [],
        total: result?.TotalRecordCount ?? 0,
    });
}
