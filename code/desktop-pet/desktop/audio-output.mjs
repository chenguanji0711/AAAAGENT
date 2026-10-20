// One output stage for every sound the pet makes: dynamic TTS replies and the
// pre-recorded action lines. Volume and mute live here so the two paths can
// never disagree, and the choice survives a restart through the native shell.
export const DEFAULT_AUDIO = Object.freeze({ muted: false, volume: 1 });
export const AUDIO_LIMITS = Object.freeze({ min: 0, max: 1 });

export function normalizeAudio(value) {
  const source = value && typeof value === 'object' ? value : {};
  const volume = Number(source.volume);
  return {
    muted: source.muted === true,
    volume: Number.isFinite(volume) ? Math.min(AUDIO_LIMITS.max, Math.max(AUDIO_LIMITS.min, volume)) : DEFAULT_AUDIO.volume
  };
}

/** Linear gain for any consumer. Muting is a real zero, so a muted pet is silent even mid-playback. */
export const gainOf = state => (state.muted ? 0 : state.volume);

/**
 * @param persist receives the normalized state whenever it changes. The host
 *   writes it to the native preference store; a browser preview uses localStorage.
 */
export function createAudioOutput({ initial, persist = () => {} } = {}) {
  let state = normalizeAudio(initial);
  const listeners = new Set();
  const publish = () => { const snapshot = { ...state }; for (const listener of [...listeners]) listener(snapshot); };
  return {
    get state() { return { ...state }; },
    get gain() { return gainOf(state); },
    get silent() { return gainOf(state) === 0; },
    /** Applies an incoming value and tells every listener; returns the accepted state. */
    set(next) {
      const wanted = normalizeAudio({ ...state, ...next });
      if (wanted.muted === state.muted && wanted.volume === state.volume) return this.state;
      state = wanted; persist(this.state); publish();
      return this.state;
    },
    receive(config) {
      const wanted = normalizeAudio(config);
      if (wanted.muted === state.muted && wanted.volume === state.volume) return this.state;
      state = wanted; publish();
      return this.state;
    },
    subscribe(listener) { listeners.add(listener); listener(this.state); return () => listeners.delete(listener); }
  };
}
