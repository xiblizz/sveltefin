import { error, redirect } from '@sveltejs/kit';
import { getItem, getSeasons, getEpisodes, getSimilar } from '$lib/server/jellyfin.js';

function resolutionLabel(video) {
	const width = video.Width ?? 0;
	const height = video.Height ?? 0;
	if (!width && !height) return null;
	if (width >= 3800 || height >= 2100) return '4K';
	if (width >= 1900 || height >= 1050) return '1080p';
	if (width >= 1260 || height >= 700) return '720p';
	return `${height}p`;
}

/**
 * Resolution / codec / audio languages for the hero facts row. Only playable
 * items (movies; series have no MediaSources) — returns null when there is
 * nothing to show.
 */
function mediaFacts(item) {
	const streams = item.MediaSources?.[0]?.MediaStreams ?? item.MediaStreams ?? [];
	const video = streams.find((stream) => stream.Type === 'Video');
	const audio = streams.filter((stream) => stream.Type === 'Audio');
	if (!video && !audio.length) return null;

	// De-dup by code, label with Jellyfin's server-localized name when present.
	const languages = [];
	const seen = new Set();
	for (const stream of audio) {
		const code = stream.Language ?? 'und';
		if (seen.has(code)) continue;
		seen.add(code);
		languages.push(stream.LocalizedLanguage ?? stream.Language?.toUpperCase() ?? 'Unknown');
	}

	return {
		resolution: video ? resolutionLabel(video) : null,
		videoCodec: video?.Codec?.toUpperCase() ?? null,
		// 'SDR' is the boring default — only call out HDR10/HLG/DoVi etc.
		videoRange: video?.VideoRangeType && video.VideoRangeType !== 'SDR' ? video.VideoRangeType : null,
		audioLanguages: languages
	};
}

export async function load({ locals, params, url }) {
	const session = locals.session;
	const item = await getItem(session, params.id);
	if (!item) error(404, 'Not found');

	// Seasons and episodes get folded into their series page.
	if (item.Type === 'Season') redirect(302, `/item/${item.SeriesId}?season=${item.Id}`);
	if (item.Type === 'Episode') redirect(302, `/item/${item.SeriesId}?season=${item.SeasonId}`);

	let seasons = [];
	let selectedSeason = null;
	let episodes = [];
	if (item.Type === 'Series') {
		seasons = (await getSeasons(session, item.Id))?.Items ?? [];
		const requested = url.searchParams.get('season');
		selectedSeason = seasons.find((season) => season.Id === requested) ?? seasons[0] ?? null;
		if (selectedSeason) {
			episodes = (await getEpisodes(session, item.Id, selectedSeason.Id))?.Items ?? [];
		}
	}

	const similarResult = await getSimilar(session, item.Id);

	return {
		item,
		mediaFacts: mediaFacts(item),
		seasons,
		selectedSeason,
		episodes,
		similar: similarResult?.Items ?? []
	};
}
