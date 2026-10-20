// Pre-recorded action lines. These are short, locally shipped clips, so they
// cost nothing and never touch a provider. They only ever play when the dynamic
// TTS reply is idle, they respect the shared output gain, and a per-category
// cooldown plus no-immediate-repeat selection keeps them from turning into a loop.
export const VOICE_COOLDOWN_MS = 25_000;
export const VOICE_MIN_GAP_MS = 5_000;
/** Below this RMS the clip counts as silence, so ambient noise cannot hold the mouth open. */
export const VOICE_NOISE_GATE = 0.012;
/** Seconds. The mouth opens faster than it closes, which is what reads as speech. */
export const VOICE_ATTACK_SECONDS = 0.035;
export const VOICE_RELEASE_SECONDS = 0.12;
/** A normal spoken RMS is small; this scales it into a visible 0..1 mouth opening. */
export const VOICE_RMS_GAIN = 4.5;

/** Only deliberate actions speak; ambient states stay silent by design. */
export const ACTION_VOICE = Object.freeze({
  'session-start': 'greeting',
  'thanks': 'greeting',
  'pat-gentle': 'pat', 'pat-angry': 'pat', 'pat-dark': 'pat',
  'eat': 'eat',
  'happy': 'happy', 'affectionate': 'happy', 'encourage': 'happy',
  'heart-eyes': 'happy', 'success': 'happy', 'dance': 'happy',
  'rest': 'sleepy', 'sad': 'sleepy',
  'error': 'tired', 'dejected': 'tired',
  'angry': 'pouty', 'curious': 'curious', 'whale': 'surprised'
});

const safeName = value => typeof value === 'string' && value.length > 0 && value.length < 128
  && !value.includes('/') && !value.includes('\\') && !value.includes(':') && !value.includes('\0')
  && value !== '.' && value !== '..';

/** Accepts only plain clip file names, so a manifest can never point outside the voice directory. */
export function parseVoiceManifest(value) {
  const categories = {};
  const source = value && typeof value === 'object' ? value.categories : null;
  if (!source || typeof source !== 'object') return { version: 0, categories, files: 0 };
  for (const [category, lines] of Object.entries(source)) {
    if (!/^[a-z][a-z0-9-]{1,23}$/.test(category) || !Array.isArray(lines)) continue;
    const accepted = [];
    for (const line of lines) {
      const file = typeof line === 'string' ? line : line?.file;
      if (!safeName(file) || !/\.(?:wav|mp3|m4a|ogg|caf)$/i.test(file)) continue;
      accepted.push({ file, text: typeof line?.text === 'string' ? line.text : '' });
    }
    if (accepted.length) categories[category] = accepted;
  }
  return { version: 1, categories, files: Object.values(categories).reduce((total, lines) => total + lines.length, 0) };
}

/**
 * @param base     directory URL that holds the manifest and clip files
 * @param gain     reads the shared output gain (0 while muted)
 * @param busy     true while the dynamic TTS reply owns the output
 * @param fetcher  replaced in tests
 * @param now      replaced in tests
 */
export function createVoiceLines({ base, gain = () => 1, busy = () => false, fetcher = (...args) => fetch(...args), now = () => performance.now(), contextFactory } = {}) {
  const stats = { enabled: false, files: 0, spoken: 0, skippedBusy: 0, skippedCooldown: 0, skippedSilent: 0, skippedUnmapped: 0, failed: 0, lastCategory: null, lastFile: null };
  let manifest = { version: 0, categories: {}, files: 0 };
  let context = null, active = null, lastPlayedAt = -Infinity, lastSampleAt = 0;
  const lastFileAt = new Map(), lastByCategory = new Map();

  const openContext = () => {
    if (context) return context;
    try { context = contextFactory ? contextFactory() : new (globalThis.AudioContext ?? globalThis.webkitAudioContext)(); } catch { context = null; }
    return context;
  };
  /** Releases the nodes of a finished reservation. Safe to call more than once. */
  function releaseGraph(current) {
    try { current.source?.disconnect?.(); } catch {}
    try { current.analyser?.disconnect?.(); } catch {}
    try { current.gain?.disconnect?.(); } catch {}
    current.source = null; current.analyser = null; current.gain = null;
  }
  /** Settles the waiting playback promise exactly once, whatever ended the clip. */
  function settlePlayback(current) {
    if (current.settled) return;
    current.settled = true;
    const done = current.resolve; current.resolve = null;
    if (done) done();
  }
  /** Frees the reservation so the next action is allowed, and settles whatever is waiting. */
  function abandon(current) {
    if (!current) return;
    current.stopped = true; current.started = false; current.level = 0; current.mouth = 0;
    if (active === current) active = null;
    releaseGraph(current);
    settlePlayback(current);
  }
  function stop() {
    const current = active; if (!current) return;
    active = null;
    try { current.source.onended = null; current.source.stop(); } catch {}
    abandon(current);
  }
  async function play(line, reservation) {
    const audio = openContext();
    // Every failure below abandons the reservation, so a broken clip can never leave the feature
    // permanently busy: the next action is always allowed to try.
    if (!audio) { stats.failed++; abandon(reservation); return false; }
    let bytes;
    try {
      const response = await fetcher(new URL(line.file, base)).catch(() => null);
      if (!response?.ok) { stats.failed++; abandon(reservation); return false; }
      bytes = await response.arrayBuffer();
    } catch { stats.failed++; abandon(reservation); return false; }
    const decoded = await audio.decodeAudioData(bytes).catch(() => null);
    if (!decoded) { stats.failed++; abandon(reservation); return false; }
    // stop() or a newer request owns the output now, so this decode is discarded.
    if (active !== reservation) { stats.skippedBusy++; releaseGraph(reservation); settlePlayback(reservation); return false; }
    if (audio.state === 'suspended') await audio.resume().catch(() => {});
    // stop() may have run while resume() was pending; starting now would play cancelled audio.
    if (active !== reservation || reservation.stopped) { stats.skippedBusy++; releaseGraph(reservation); settlePlayback(reservation); return false; }
    const source = audio.createBufferSource(), level = audio.createGain();
    // Source -> analyser -> the same shared gain -> destination. The analyser only observes, so the
    // volume path (and mute) behaves exactly as before.
    // A context without an analyser (a stripped-down test double, say) still plays the clip; it
    // simply cannot report a waveform, and the mouth stays shut rather than inventing a value.
    let analyser = null;
    try { analyser = audio.createAnalyser?.() ?? null; } catch { analyser = null; }
    if (analyser) { analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0; }
    source.buffer = decoded;
    if (analyser) { source.connect(analyser); analyser.connect(level); } else { source.connect(level); }
    level.connect(audio.destination);
    level.gain.value = gain();
    reservation.source = source; reservation.gain = level; reservation.analyser = analyser;
    reservation.started = true; reservation.level = 0; reservation.mouth = 0;
    lastSampleAt = audio.currentTime;
    await new Promise(resolve => {
      // stop() needs this handle to settle the promise it interrupts.
      reservation.resolve = resolve;
      // A natural end releases the whole graph as well, and shares the idempotent settlement so a
      // stop() racing the end cannot resolve the same promise twice.
      const finish = () => abandon(reservation);
      source.onended = finish;
      try { source.start(); } catch { finish(); }
    });
    return true;
  }

  // Reused buffer: sampling happens once per drawn frame, so it must not allocate.
  let timeDomain = null;
  /**
   * The local clip's contribution to the mouth, read from the real waveform.
   *
   * The clock is the AudioContext's own `currentTime`, the same one the clip is played on, so the
   * smoothing cannot drift against the audio. Nothing is reported as playing until the buffer has
   * actually started: while the clip is still being fetched or decoded this returns
   * `{playing: false, mouth: 0}`, and a muted, stopped, ended or failed clip always returns mouth 0.
   */
  function sample() {
    const current = active;
    if (!current || !current.started || current.stopped) return { playing: false, mouth: 0 };
    const audio = context;
    if (!audio) return { playing: false, mouth: 0 };
    // The shared gain can change mid-clip, so the actual node is synchronised every frame instead of
    // being set once at start: muting must really silence the output, not just close the mouth.
    const output = gain();
    if (Number.isFinite(output) && current.gain?.gain) current.gain.gain.value = output;
    const analyser = current.analyser;
    if (!analyser) { current.level = 0; current.mouth = 0; return { playing: true, mouth: 0 }; }
    if (!timeDomain || timeDomain.length !== analyser.fftSize) timeDomain = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(timeDomain);
    let sum = 0, finite = true;
    for (let index = 0; index < timeDomain.length; index += 1) {
      const value = timeDomain[index];
      if (!Number.isFinite(value)) { finite = false; break; }
      sum += value * value;
    }
    const now = audio.currentTime;
    if (!finite || !Number.isFinite(now)) {
      // A broken waveform or clock must not poison the smoothing with NaN for the rest of the clip.
      current.level = 0; current.mouth = 0;
      return { playing: true, mouth: 0 };
    }
    // The mouth follows the amplitude *after* the shared gain, which is what the listener hears.
    const rms = Math.sqrt(sum / timeDomain.length) * (Number.isFinite(output) ? Math.abs(output) : 0);
    if (!Number.isFinite(rms)) { current.level = 0; current.mouth = 0; return { playing: true, mouth: 0 }; }

    const delta = Math.max(0, Math.min(0.25, now - lastSampleAt));
    lastSampleAt = now;
    if (!Number.isFinite(current.level)) current.level = 0;
    const target = rms <= VOICE_NOISE_GATE ? 0 : Math.min(1, (rms - VOICE_NOISE_GATE) * VOICE_RMS_GAIN);
    const rate = target > current.level ? VOICE_ATTACK_SECONDS : VOICE_RELEASE_SECONDS;
    const blend = rate <= 0 ? 1 : 1 - Math.exp(-delta / rate);
    current.level += (target - current.level) * blend;
    // Snap the tail to a true zero: an imperceptible residue would still be "the mouth is not
    // closed" to anything measuring it, and the requirement is a clean 0 in silence and at the end.
    if (current.level < 2e-3) current.level = 0;
    current.mouth = current.level;
    return { playing: true, mouth: current.mouth };
  }

  return {
    stats,
    get enabled() { return stats.enabled; },
    get playing() { return Boolean(active); },
    sample,
    /** Reads the shipped manifest. A missing manifest simply leaves the feature off. */
    async load() {
      const response = await fetcher(new URL('lines.json', base)).catch(() => null);
      if (!response?.ok) return false;
      const parsed = parseVoiceManifest(await response.json().catch(() => null));
      manifest = parsed; stats.files = parsed.files; stats.enabled = parsed.files > 0;
      return stats.enabled;
    },
    /** Plays one action line. False whenever it is unmapped, off, muted, busy or cooling down. */
    async action(actionId) {
      const category = ACTION_VOICE[actionId];
      if (!stats.enabled || !category) { if (!category) stats.skippedUnmapped++; return false; }
      const lines = manifest.categories[category];
      if (!lines?.length) { stats.skippedUnmapped++; return false; }
      if (gain() === 0) { stats.skippedSilent++; return false; }
      if (busy() || active) { stats.skippedBusy++; return false; }
      const at = now();
      if (at - lastPlayedAt < VOICE_MIN_GAP_MS || at - (lastByCategory.get(category) ?? -Infinity) < VOICE_COOLDOWN_MS) { stats.skippedCooldown++; return false; }
      const fresh = lines.filter(line => at - (lastFileAt.get(line.file) ?? -Infinity) > VOICE_COOLDOWN_MS);
      const pool = fresh.length ? fresh : lines;
      const line = pool[Math.floor(Math.random() * pool.length)];
      lastPlayedAt = at; lastByCategory.set(category, at); lastFileAt.set(line.file, at);
      stats.lastCategory = category; stats.lastFile = line.file;
      // Reserve the output synchronously so two actions in the same tick cannot overlap.
      const reservation = { source: null, gain: null, analyser: null, category, started: false, stopped: false, settled: false, resolve: null, level: 0, mouth: 0 };
      active = reservation;
      const spoke = await play(line, reservation);
      if (spoke) stats.spoken++;
      return spoke;
    },
    stop,
    dispose() { stop(); try { context?.close?.(); } catch {} context = null; }
  };
}
