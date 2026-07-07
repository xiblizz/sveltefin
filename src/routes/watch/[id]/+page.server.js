import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getAdjacentEpisodes, getItem, getPlaybackInfo, getSkippableSegments } from '$lib/server/jellyfin.js';
import { deviceProfile } from '$lib/server/deviceProfile.js';
import { ticksToSeconds } from '$lib/img.js';

const DIRECT_CONTAINERS = ['mp4', 'm4v', 'webm'];

/** mpv backend is opt-in: needs vendored wasm build + COOP/COEP headers (docs/playback.md). */
function mpvEnabled() {
    return env.ENABLE_MPV_BACKEND === '1' || env.ENABLE_MPV_BACKEND === 'true';
}

/** Jellyfin-generated URLs can carry the user token as api_key — never let that reach the client. */
function proxied(jellyfinPath) {
    return (
        '/api/media' +
        jellyfinPath
            .replace(/^\//, '/')
            .replace(/([?&])(api_key|ApiKey)=[^&]*&?/g, '$1')
            .replace(/[?&]$/, '')
    );
}

function intParam(url, name) {
    const raw = url.searchParams.get(name);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isInteger(value) ? value : null;
}

export async function load({ locals, params, url }) {
    const session = locals.session;
    const item = await getItem(session, params.id);
    if (!item) error(404, 'Not found');

    // ?audio= / ?subtitle= pick explicit stream indices. A non-default audio
    // track always forces a transcode (browsers can't switch embedded audio).
    // Subtitles only force one when the chosen stream can't be delivered as an
    // external text track — then Jellyfin burns it in.
    const audioIndex = intParam(url, 'audio');
    const subtitleIndex = intParam(url, 'subtitle');

    let info = await getPlaybackInfo(session, item.Id, {
        DeviceProfile: deviceProfile,
        AutoOpenLiveStream: false,
    });
    let source = info?.MediaSources?.[0];
    if (!source) error(502, 'Jellyfin returned no playable media source');

    // Manual stream selection is a *renegotiation* against the concrete
    // MediaSourceId (jellyfin-web does the same second round trip) — a bare
    // AudioStreamIndex without MediaSourceId is not reliably applied and
    // Jellyfin keeps serving the default audio.
    const renegotiate = async (extra) => {
        info = await getPlaybackInfo(session, item.Id, {
            DeviceProfile: deviceProfile,
            AutoOpenLiveStream: false,
            MediaSourceId: source.Id,
            ...(audioIndex !== null ? { AudioStreamIndex: audioIndex } : {}),
            EnableDirectPlay: false,
            EnableDirectStream: false,
            ...extra,
        });
        source = info?.MediaSources?.[0];
        if (!source) error(502, 'Jellyfin returned no playable media source');
    };

    if (audioIndex !== null) await renegotiate({});

    const findSubtitle = (candidateSource) =>
        (candidateSource.MediaStreams ?? []).find(
            (stream) => stream.Type === 'Subtitle' && stream.Index === subtitleIndex,
        );

    let burnedSubtitle = -1;
    if (subtitleIndex !== null && subtitleIndex >= 0) {
        const chosen = findSubtitle(source);
        const isExternal = chosen?.DeliveryMethod === 'External' && Boolean(chosen?.DeliveryUrl);
        if (chosen && !isExternal) {
            await renegotiate({
                SubtitleStreamIndex: subtitleIndex,
                AlwaysBurnInSubtitleWhenTranscoding: true,
            });
            burnedSubtitle = subtitleIndex;
        }
    }

    let src;
    let playMethod;
    let kind = 'direct';
    let mpv = null;
    const container = (source.Container ?? '').split(',')[0];
    // mpv is the default backend when enabled; ?backend=html opts out (set by
    // the toggle and by MpvPlayer's automatic boot-failure fallback).
    const backendChoice = url.searchParams.get('backend');
    const wantMpv = mpvEnabled() && backendChoice !== 'html';

    if (wantMpv) {
        // Original file, untouched: libmpv decodes anything, so no container
        // or SupportsDirectPlay gate. static=true makes Jellyfin serve the
        // file as-is with Range support (proxied — the browser never sees
        // Jellyfin; the chunk cache fetches this same URL with Range headers).
        src = proxied(
            `/Videos/${item.Id}/stream?static=true&mediaSourceId=${source.Id}&playSessionId=${info.PlaySessionId}`,
        );
        playMethod = 'DirectPlay';
        kind = 'mpv';
        mpv = {
            cacheId: source.Id,
            filename: `${item.Id}.${container || 'mkv'}`,
            size: source.Size ?? null,
        };
    } else if (source.SupportsDirectPlay && DIRECT_CONTAINERS.includes(container)) {
        src = proxied(
            `/Videos/${item.Id}/stream.${container}?static=true&mediaSourceId=${source.Id}&playSessionId=${info.PlaySessionId}`,
        );
        playMethod = 'DirectPlay';
    } else if (source.TranscodingUrl) {
        src = proxied(source.TranscodingUrl);
        playMethod = 'Transcode';
        if (source.TranscodingSubProtocol === 'hls' || source.TranscodingUrl.includes('.m3u8')) {
            kind = 'hls';
        }
    } else if (source.SupportsDirectStream && audioIndex === null && burnedSubtitle === -1) {
        // Guarded: after a forced renegotiation, serving the static stream
        // would silently play the default audio / drop the burned subtitle.
        src = proxied(
            `/Videos/${item.Id}/stream?static=true&mediaSourceId=${source.Id}&playSessionId=${info.PlaySessionId}`,
        );
        playMethod = 'DirectStream';
    } else {
        error(502, 'No playback method available for this item');
    }

    const mediaStreams = source.MediaStreams ?? [];
    const audioTracks = mediaStreams
        .filter((stream) => stream.Type === 'Audio')
        .map((stream) => ({
            index: stream.Index,
            label: stream.DisplayTitle ?? stream.Language ?? `Track ${stream.Index}`,
        }));
    const subtitleTracks = mediaStreams
        .filter((stream) => stream.Type === 'Subtitle')
        .map((stream) => ({
            index: stream.Index,
            label: stream.DisplayTitle ?? stream.Language ?? `Subtitle ${stream.Index}`,
            external: stream.DeliveryMethod === 'External' && Boolean(stream.DeliveryUrl),
        }));

    const subtitles = mediaStreams
        .filter(
            (stream) =>
                stream.Type === 'Subtitle' && stream.DeliveryMethod === 'External' && stream.DeliveryUrl,
        )
        .map((stream) => ({
            index: stream.Index,
            label: stream.DisplayTitle ?? stream.Language ?? 'Subtitles',
            lang: stream.Language ?? 'und',
            src: proxied(stream.DeliveryUrl),
            default:
                burnedSubtitle === -1 &&
                (subtitleIndex !== null
                    ? stream.Index === subtitleIndex
                    : stream.Index === source.DefaultSubtitleStreamIndex),
        }));

    // Intro/outro markers (Jellyfin media segments, fed e.g. by the Intro Skipper plugin)
    const segments = (await getSkippableSegments(session, item.Id)).map((segment) => ({
        type: segment.Type,
        start: ticksToSeconds(segment.StartTicks),
        end: ticksToSeconds(segment.EndTicks),
    }));

    // Trickplay (seek-preview tile sheets, generated by Jellyfin per media
    // source and width). Only the mpv backend can use it — native <video>
    // controls expose no seekbar hover. Pick the widest set ≤ 320px.
    let trickplay = null;
    {
        const infos = Object.values(item.Trickplay?.[source.Id] ?? {});
        const info =
            infos.filter((candidate) => (candidate.Width ?? 0) <= 320).sort((a, b) => b.Width - a.Width)[0] ??
            infos[0];
        if (info?.Width && info.Interval > 0 && info.TileWidth > 0 && info.TileHeight > 0) {
            trickplay = {
                width: info.Width,
                height: info.Height,
                tileWidth: info.TileWidth, // thumbnails per row
                tileHeight: info.TileHeight, // thumbnails per column
                thumbnailCount: info.ThumbnailCount ?? 0,
                intervalMs: info.Interval,
                // sheet URL: `${urlBase}/${sheetIndex}.jpg?mediaSourceId=...`
                urlBase: `/api/media/Videos/${item.Id}/Trickplay/${info.Width}`,
                mediaSourceId: source.Id,
            };
        }
    }

    // Prev/next episode navigation (series-wide, so it crosses season
    // boundaries). Best-effort: a failure here must not break playback.
    let previousEpisode = null;
    let nextEpisode = null;
    if (item.Type === 'Episode' && item.SeriesId) {
        const adjacent =
            (await getAdjacentEpisodes(session, item.SeriesId, item.Id).catch(() => null))?.Items ??
            [];
        const at = adjacent.findIndex((episode) => episode.Id === item.Id);
        const strip = (episode) =>
            episode
                ? {
                      id: episode.Id,
                      name: episode.Name,
                      season: episode.ParentIndexNumber ?? null,
                      episode: episode.IndexNumber ?? null,
                  }
                : null;
        if (at !== -1) {
            previousEpisode = strip(adjacent[at - 1]);
            nextEpisode = strip(adjacent[at + 1]);
        }
    }

    const t = Number(url.searchParams.get('t'));
    const resume = url.searchParams.get('resume') === '1';
    return {
        item,
        src,
        kind,
        playMethod,
        mpv,
        mpvAvailable: mpvEnabled(),
        // The raw ?backend= choice, carried through reloads (track changes,
        // episode nav): the mpv default stays implicit, an explicit choice
        // ('html', or 'mpv' pinned via the toggle) sticks.
        backendParam: backendChoice,
        backendExplicit: backendChoice !== null,
        subtitles,
        audioTracks,
        subtitleTracks,
        audioParam: audioIndex,
        burnedSubtitle,
        currentAudio: audioIndex ?? source.DefaultAudioStreamIndex ?? audioTracks[0]?.index ?? -1,
        currentSubtitle:
            subtitleIndex ??
            subtitles.find((subtitle) => subtitle.default)?.index ??
            -1,
        segments,
        trickplay,
        previousEpisode,
        nextEpisode,
        mediaSourceId: source.Id,
        playSessionId: info.PlaySessionId,
        startSeconds: t > 0 ? t : resume ? ticksToSeconds(item.UserData?.PlaybackPositionTicks) : 0,
    };
}
