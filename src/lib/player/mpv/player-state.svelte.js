// Reactive surface for UI built on top of the mpv backend. The component
// owns the worker/module lifecycle and feeds this object; consumers (buffer
// bar, cache indicator, controls) read the $state fields and never touch the
// cache internals.

export class MpvPlayerState {
	/** 'boot' | 'cache' | 'engine' | 'playing' | 'error' */
	phase = $state('boot');
	errorMessage = $state('');

	// Playback
	position = $state(0);
	duration = $state(0);
	paused = $state(true);
	idle = $state(true);

	// Tracks (wrapper "track-list" props; entries keep their BigInt ids)
	/** @type {any[]} */
	audioTracks = $state([]);
	/** @type {any[]} */
	subtitleTracks = $state([]);
	audioStream = $state(0); // current aid, 0 = none
	subtitleStream = $state(0); // current sid, 0 = off

	// Cache (mirrors cache-worker 'stats' messages)
	fileSize = $state(0);
	/** @type {Array<[number, number]>} merged cached byte ranges */
	ranges = $state([]);
	cachedBytes = $state(0);
	capacityBytes = $state(0);
	hits = $state(0);
	misses = $state(0);
	readPosition = $state(0);

	hitRate = $derived(this.hits + this.misses ? this.hits / (this.hits + this.misses) : 1);

	/** @param {any} msg cache-worker stats message */
	applyStats(msg) {
		this.fileSize = msg.fileSize;
		this.ranges = msg.ranges;
		this.cachedBytes = msg.cachedBytes;
		this.capacityBytes = msg.capacityBytes;
		this.hits = msg.hits;
		this.misses = msg.misses;
		this.readPosition = msg.position;
	}

	/** @param {string} message */
	fail(message) {
		this.phase = 'error';
		this.errorMessage = message;
	}
}
