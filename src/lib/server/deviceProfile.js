// Conservative browser device profile sent with PlaybackInfo. Jellyfin compares
// this against the media's streams to decide direct play vs. transcode and to
// build the TranscodingUrl. Modeled on jellyfin-web's generic browser profile.
export const deviceProfile = {
	MaxStreamingBitrate: 20_000_000,
	MaxStaticBitrate: 100_000_000,
	MusicStreamingTranscodingBitrate: 384_000,
	DirectPlayProfiles: [
		{
			Container: 'mp4,m4v',
			Type: 'Video',
			VideoCodec: 'h264,hevc,av1,vp9',
			AudioCodec: 'aac,mp3,opus,flac'
		},
		{
			Container: 'webm',
			Type: 'Video',
			VideoCodec: 'vp8,vp9,av1',
			AudioCodec: 'opus,vorbis'
		}
	],
	TranscodingProfiles: [
		{
			Container: 'ts',
			Type: 'Video',
			VideoCodec: 'h264',
			AudioCodec: 'aac,mp3',
			Protocol: 'hls',
			Context: 'Streaming',
			MaxAudioChannels: '2',
			MinSegments: 1,
			BreakOnNonKeyFrames: true
		}
	],
	CodecProfiles: [
		{
			Type: 'Video',
			Codec: 'h264',
			Conditions: [
				{ Condition: 'LessThanEqual', Property: 'VideoLevel', Value: '52', IsRequired: false }
			]
		}
	],
	SubtitleProfiles: [
		{ Format: 'vtt', Method: 'External' },
		{ Format: 'srt', Method: 'External' }
	],
	ResponseProfiles: []
};
