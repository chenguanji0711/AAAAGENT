// Frame cadence for the desktop pet.
//
// The renderer must draw on a budget the user picked, not on whatever the display does. A naive
// `if (now - last > budget)` gate halves a 60 Hz budget on a 75 Hz display (37.5 Hz) because two
// 13.3 ms display frames only just exceed 16.7 ms. This scheduler instead accumulates elapsed
// time, draws when the budget is met, and carries the remainder, so a 75 Hz clock yields 60 Hz
// and never drifts.
//
// Two rules keep it honest when the clock is not trustworthy:
//   * a hidden window resyncs instead of banking time, so becoming visible again cannot burst;
//   * a stall longer than two budgets grants exactly one frame and drops the backlog.
//
// The reported statistics come from frames that were really drawn and really timed, over a
// bounded window, so they cannot creep upwards forever or invent a number.

const RATE_BUDGETS = {
	'60': 1000 / 60,
	eco: 1000 / 30,
	high: 0,
};

const MAX_SAMPLES = 300;
// Absorbs floating-point noise in the millisecond clock: without it a frame interval that is a
// hair under the budget draws every other frame, which is exactly the 30 Hz bug we are fixing.
const EPSILON = 1e-6;
// A gap beyond this is a stall, not a missed cadence.
const STALL_FACTOR = 2;

export class FrameScheduler {
	constructor(options = {}) {
		this.rate = '60';
		this.budget = RATE_BUDGETS['60'];
		this.last = null;
		this.accumulated = 0;
		this.stamps = [];
		this.renderTimes = [];
		this.frames = 0;
		this.configure(options);
	}

	/** Unknown rates are ignored rather than throwing: a bad saved value must not stop the pet. */
	configure(options = {}) {
		const rate = options?.rate;
		if (typeof rate === 'string' && Object.prototype.hasOwnProperty.call(RATE_BUDGETS, rate)) {
			this.rate = rate;
			this.budget = RATE_BUDGETS[rate];
		}
		return this.rate;
	}

	/**
	 * Decides whether this display frame should be drawn.
	 * Returns false for a duplicate, NaN or backwards clock, and for a hidden window.
	 */
	tick(timestampMs, { visible = true } = {}) {
		if (!Number.isFinite(timestampMs)) return false;
		if (visible === false) {
			// Resync while hidden: the time spent invisible must never be replayed as frames.
			this.last = timestampMs;
			this.accumulated = 0;
			return false;
		}
		if (this.last === null) {
			this.last = timestampMs;
			this.accumulated = 0;
			this.count(timestampMs);
			return true;
		}
		const delta = timestampMs - this.last;
		// A repeated or rewound clock is refused without moving the reference, so the next honest
		// frame is still measured against the last accepted one.
		if (!(delta > 0)) return false;
		this.last = timestampMs;

		if (this.budget === 0) {
			this.count(timestampMs);
			return true;
		}
		if (delta > this.budget * STALL_FACTOR) {
			// Long stall: one frame now, no backlog afterwards.
			this.accumulated = 0;
			this.count(timestampMs);
			return true;
		}
		this.accumulated += delta;
		if (this.accumulated < this.budget - EPSILON) return false;
		this.accumulated = Math.max(0, this.accumulated - this.budget);
		this.count(timestampMs);
		return true;
	}

	/** Records how long the draw took, in milliseconds. Bogus values are ignored. */
	record(renderMs) {
		if (!Number.isFinite(renderMs) || renderMs < 0) return;
		this.renderTimes.push(renderMs);
		if (this.renderTimes.length > MAX_SAMPLES) this.renderTimes.shift();
	}

	stats() {
		const stamps = this.stamps;
		let fps = 0;
		if (stamps.length >= 2) {
			const span = (stamps[stamps.length - 1] - stamps[0]) / 1000;
			if (span > 0) fps = (stamps.length - 1) / span;
		}
		const render = this.renderTimes;
		let p95RenderMs = 0;
		let meanRenderMs = 0;
		if (render.length > 0) {
			const sorted = [...render].sort((a, b) => a - b);
			p95RenderMs = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
			meanRenderMs = render.reduce((sum, value) => sum + value, 0) / render.length;
		}
		return {
			rate: this.rate,
			fps: Math.round(fps * 100) / 100,
			samples: render.length,
			p95RenderMs,
			meanRenderMs: Math.round(meanRenderMs * 1000) / 1000,
			frames: this.frames,
			window: stamps.length,
		};
	}

	count(timestampMs) {
		this.frames += 1;
		this.stamps.push(timestampMs);
		if (this.stamps.length > MAX_SAMPLES) this.stamps.shift();
	}
}

export { MAX_SAMPLES, RATE_BUDGETS };
