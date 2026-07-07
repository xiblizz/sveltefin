import { json } from '@sveltejs/kit';
import { getSessions } from '$lib/server/jellyfin.js';
import { imgUrl, ticksToSeconds } from '$lib/img.js';

// Active playback sessions for the header streams widget. Jellyfin scopes
// GET /Sessions itself: admins see everything, regular users only their own.
// Only a hand-picked subset of SessionInfoDto leaves this route — never
// tokens, server URLs, or the raw DTO.

const PLAY_METHODS = {
    DirectPlay: 'Direct Play',
    DirectStream: 'Direct Stream',
    Transcode: 'Transcode'
};

export async function GET({ locals }) {
    const sessions = (await getSessions(locals.session)) ?? [];

    const streams = sessions
        .filter((s) => s.NowPlayingItem)
        .map((s) => {
            const item = s.NowPlayingItem;
            const isEpisode = item.Type === 'Episode';
            const videoStream = (item.MediaStreams ?? []).find((stream) => stream.Type === 'Video');
            return {
                id: s.Id,
                userName: s.UserName ?? '',
                client: s.Client ?? '',
                device: s.DeviceName ?? '',
                remoteEndPoint: s.RemoteEndPoint ?? '',
                title: isEpisode ? (item.SeriesName ?? item.Name) : item.Name,
                subtitle: isEpisode
                    ? [episodeCode(item), item.Name].filter(Boolean).join(' · ')
                    : (item.ProductionYear ?? ''),
                poster: imgUrl(item, 'Primary', { maxWidth: 120 }),
                positionSeconds: Math.floor(ticksToSeconds(s.PlayState?.PositionTicks)),
                runtimeSeconds: Math.floor(ticksToSeconds(item.RunTimeTicks)),
                isPaused: Boolean(s.PlayState?.IsPaused),
                playMethod: PLAY_METHODS[s.PlayState?.PlayMethod] ?? null,
                videoCodec: (s.TranscodingInfo?.VideoCodec ?? videoStream?.Codec)?.toUpperCase() ?? null,
                bitrate: s.TranscodingInfo?.Bitrate ?? videoStream?.BitRate ?? null
            };
        });

    return json({ streams });
}

function episodeCode(item) {
    if (item.ParentIndexNumber == null || item.IndexNumber == null) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `S${pad(item.ParentIndexNumber)}E${pad(item.IndexNumber)}`;
}
