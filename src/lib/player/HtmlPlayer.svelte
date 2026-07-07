<script>
    import { onMount } from 'svelte';
    import { browser } from '$app/environment';
    import { imgUrl } from '$lib/img.js';
    import { savedVolumeFraction, saveVolumeFraction } from './volume.js';

    /**
     * Native <video> backend: DirectPlay progressive files and HLS transcodes
     * (hls.js where the browser lacks native HLS). Extracted verbatim from the
     * watch page when the mpv backend was introduced.
     */
    let { data, controller = $bindable(), onplay, onpause, onended, ontimeupdate } = $props();

    let video;
    let hls = null;

    /** Show exactly one external <track> (or none); order matches data.subtitles. */
    function showTextTrack(index) {
        const tracks = video?.textTracks ?? [];
        data.subtitles.forEach((subtitle, i) => {
            if (tracks[i]) tracks[i].mode = subtitle.index === index ? 'showing' : 'disabled';
        });
    }

    controller = {
        getCurrentTime: () => video?.currentTime ?? 0,
        isPaused: () => video?.paused ?? true,
        seek: (seconds) => {
            if (video) video.currentTime = seconds;
        },
        setTextTrack: showTextTrack,
        togglePlay: () => {
            if (!video) return;
            if (video.paused) video.play();
            else video.pause();
        },
    };

    async function setupSource() {
        if (data.kind === 'hls' && !video.canPlayType('application/vnd.apple.mpegurl')) {
            const { default: Hls } = await import('hls.js');
            if (Hls.isSupported()) {
                hls = new Hls();
                hls.loadSource(data.src);
                hls.attachMedia(video);
            }
        } else {
            video.src = data.src;
        }

        if (data.startSeconds > 0) {
            const seek = () => {
                video.currentTime = data.startSeconds;
            };
            if (video.readyState >= 1) seek();
            else video.addEventListener('loadedmetadata', seek, { once: true });
        }
    }

    onMount(() => {
        setupSource();
        // Cleanup must be registered synchronously — an async onMount's return value is ignored.
        return () => {
            hls?.destroy();
        };
    });
</script>

<!-- svelte-ignore a11y_media_has_caption -->
<video
    bind:this={video}
    controls
    autoplay
    playsinline
    volume={browser ? savedVolumeFraction() : 0.5}
    onvolumechange={() => browser && saveVolumeFraction(video.volume)}
    poster={imgUrl(data.item, 'Backdrop', { maxWidth: 1600 }) ?? undefined}
    {onplay}
    {onpause}
    {onended}
    ontimeupdate={() => ontimeupdate?.(video?.currentTime ?? 0)}
>
    {#each data.subtitles as track (track.src)}
        <track
            kind="subtitles"
            src={track.src}
            label={track.label}
            srclang={track.lang}
            default={track.default}
        />
    {/each}
</video>

<style>
    video {
        width: 100%;
        height: auto;
        max-height: calc(100dvh - 9rem);
        background: #000;
        border-radius: 12px;
    }
</style>
