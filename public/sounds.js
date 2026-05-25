// sounds.js — tiny Web Audio synth for UI/game sound effects. No audio
// files: every sound is generated at runtime from oscillators + gain
// envelopes, so there's nothing to download and nothing to license.
//
// Exposes a global `Sounds` object (browser) used by game.js. Respects an
// on/off preference in localStorage and lazily creates the AudioContext on
// first play (browsers block audio until a user gesture).

const Sounds = (() => {
  const PREF_KEY = 'geoguess.soundOn';
  let ctx = null;
  let enabled = localStorage.getItem(PREF_KEY) !== 'off'; // default on

  function ac() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) ctx = new AC();
    }
    // Resume if the browser suspended it before the first gesture.
    if (ctx && ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // Play a single tone. freq in Hz, dur in seconds, type is an oscillator
  // waveform, gain is peak volume, `when` is an offset from now.
  function tone(freq, dur, { type = 'sine', gain = 0.2, when = 0, glideTo = null } = {}) {
    const a = ac();
    if (!a) return;
    const t0 = a.currentTime + when;
    const osc = a.createOscillator();
    const g = a.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur);
    // Quick attack, exponential decay — keeps clicks/blips from popping.
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(a.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  // Short filtered-noise burst — used for the "pin drop" thunk.
  function noise(dur, { gain = 0.15, when = 0 } = {}) {
    const a = ac();
    if (!a) return;
    const t0 = a.currentTime + when;
    const frames = Math.floor(a.sampleRate * dur);
    const buf = a.createBuffer(1, frames, a.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    const src = a.createBufferSource();
    src.buffer = buf;
    const g = a.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    const lp = a.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1200;
    src.connect(lp).connect(g).connect(a.destination);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  const api = {
    isOn() {
      return enabled;
    },
    setOn(on) {
      enabled = !!on;
      localStorage.setItem(PREF_KEY, enabled ? 'on' : 'off');
      if (enabled) api.click(); // little confirmation blip
    },
    // Soft UI click for buttons.
    click() {
      if (!enabled) return;
      tone(420, 0.06, { type: 'triangle', gain: 0.12 });
    },
    // Pin drop: a quick descending blip + a soft thunk.
    pin() {
      if (!enabled) return;
      tone(680, 0.1, { type: 'sine', gain: 0.18, glideTo: 320 });
      noise(0.09, { gain: 0.12, when: 0.02 });
    },
    // Submit guess: a confident two-note rise.
    submit() {
      if (!enabled) return;
      tone(523, 0.09, { type: 'triangle', gain: 0.16 });
      tone(784, 0.12, { type: 'triangle', gain: 0.16, when: 0.08 });
    },
    // Round result: chord depends on how good the guess was (0..5000).
    roundResult(points) {
      if (!enabled) return;
      if (points >= 4000) {
        // Bright major arpeggio.
        [523, 659, 784, 1047].forEach((f, i) =>
          tone(f, 0.18, { type: 'triangle', gain: 0.16, when: i * 0.07 }),
        );
      } else if (points >= 1500) {
        [523, 659, 784].forEach((f, i) =>
          tone(f, 0.16, { type: 'triangle', gain: 0.15, when: i * 0.07 }),
        );
      } else {
        // Muted two-note "meh".
        tone(392, 0.16, { type: 'sine', gain: 0.14 });
        tone(349, 0.22, { type: 'sine', gain: 0.14, when: 0.12 });
      }
    },
    // Game over: a little fanfare.
    gameOver() {
      if (!enabled) return;
      [523, 659, 784, 1047, 784, 1047].forEach((f, i) =>
        tone(f, 0.2, { type: 'triangle', gain: 0.15, when: i * 0.1 }),
      );
    },
  };

  return api;
})();

// Dual export so Node tests could require() it if ever needed (no-ops there
// since there's no window/AudioContext).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Sounds;
}
