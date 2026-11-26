/**
 * AudioEngine
 * - Carga temporal de un archivo local mediante ObjectURL (nada se sube ni se persiste).
 * - Enruta <audio> -> MediaElementSource -> AnalyserNode -> GainNode -> destination.
 *   (El gain va DESPUÉS del analizador: los fundidos no alteran la medición de energía.)
 * - Detecta picos de energía en graves (beats) y en medios con umbral adaptativo + cooldown,
 *   protegidos por una puerta de ruido absoluta (ENERGY_GATE).
 * - Análisis previo offline de la pista completa para elegir los segmentos más intensos (rondas).
 */

const FFT_SIZE = 1024;
const HISTORY_SECONDS = 1.0;      // ventana de la media móvil
const BASS_RANGE = [30, 150];     // Hz
const MID_RANGE = [150, 2000];    // Hz
const BEAT_SENSITIVITY = 1.35;    // k en (media + k·σ)
const BEAT_COOLDOWN = 0.25;       // s entre beats de graves
const MID_SENSITIVITY = 1.6;
const MID_COOLDOWN = 0.4;

/* Lectura "musical" de más alto nivel (para eventos como el cambio de plataformas). */
const SLOW_AVG_SECONDS = 4;       // constante de tiempo de las medias lentas
const FAST_AVG_SECONDS = 0.3;     // constante de tiempo de la energía rápida
const ACCENT_RATIO = 1.3;         // un acento es un beat ≥ 30 % por encima de los graves habituales
const ACCENT_MIN_BASS = 0.32;
const SURGE_DELTA = 0.12;         // subida de energía rápida sobre la media lenta (drop / sección)
const SURGE_COOLDOWN = 2;

/** Piso absoluto de energía normalizada (0..1). Por debajo nunca hay beat ni pico. */
export const ENERGY_GATE = 0.18;

/* ---------------- análisis previo ---------------- */

const ANALYSIS_RATE = 22050;      // decodificar a esta frecuencia basta para 30–2000 Hz
const WINDOW_SECONDS = 1;
export const SEGMENT_SECONDS = 25;
const DURATION_TIMEOUT_MS = 5000;
const MIN_ROUNDS = 3;
const EXTRA_ROUND_RATIO = 0.5;    // rondas 4ª y 5ª solo si su intensidad ≥ 50 % del tramo más intenso

class AdaptivePeakDetector {
  constructor({ sensitivity, cooldown }) {
    this.sensitivity = sensitivity;
    this.cooldown = cooldown;
    this.history = [];
    this.lastPeakAt = -Infinity;
    this.threshold = 0;
  }

  reset() {
    this.history.length = 0;
    this.lastPeakAt = -Infinity;
    this.threshold = 0;
  }

  /**
   * @param {number} value energía actual
   * @param {number} t instante en segundos
   * @param {boolean} armed false si la puerta de ruido está cerrada: se registra el valor
   *   (para que la media adaptativa no se desfase) pero nunca se dispara un pico.
   * @returns {boolean} true si `value` es un pico.
   */
  push(value, t, armed) {
    // Ventana temporal (independiente del framerate).
    this.history.push({ v: value, t });
    while (this.history.length && t - this.history[0].t > HISTORY_SECONDS) this.history.shift();

    const n = this.history.length;
    let mean = 0;
    for (const s of this.history) mean += s.v;
    mean /= n;
    let variance = 0;
    for (const s of this.history) variance += (s.v - mean) ** 2;
    const std = Math.sqrt(variance / n);

    this.threshold = mean + this.sensitivity * std;
    const isPeak =
      armed &&
      n > 10 &&
      value > this.threshold &&
      t - this.lastPeakAt >= this.cooldown;

    if (isPeak) this.lastPeakAt = t;
    return isPeak;
  }
}

/**
 * Energía RMS de graves y medios por ventana de 1 s.
 * Graves: paso bajo de 2 polos en cascada a 150 Hz. Medios: paso bajo 2000 Hz − graves.
 * @param {AudioBuffer} buffer
 * @returns {{t:number, bass:number, mid:number, score:number}[]}
 */
export function measureWindows(buffer) {
  const sr = buffer.sampleRate;
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  const chCount = channels.length;
  const n = buffer.length;

  const coeff = (fc) => 1 - Math.exp((-2 * Math.PI * fc) / sr);
  const aBass = coeff(BASS_RANGE[1]);
  const aMid = coeff(MID_RANGE[1]);
  const winSize = Math.max(1, Math.round(sr * WINDOW_SECONDS));

  const windows = [];
  let lb1 = 0;
  let lb2 = 0;
  let lm = 0;
  let sumB = 0;
  let sumM = 0;
  let count = 0;

  for (let i = 0; i < n; i++) {
    let x = 0;
    for (let c = 0; c < chCount; c++) x += channels[c][i];
    x /= chCount;

    lb1 += aBass * (x - lb1);
    lb2 += aBass * (lb1 - lb2);
    lm += aMid * (x - lm);
    const mid = lm - lb2;

    sumB += lb2 * lb2;
    sumM += mid * mid;
    count++;
    if (count === winSize || (i === n - 1 && count > winSize / 2)) {
      windows.push({ t: windows.length * WINDOW_SECONDS, bass: Math.sqrt(sumB / count), mid: Math.sqrt(sumM / count), score: 0 });
      sumB = 0;
      sumM = 0;
      count = 0;
    }
  }

  // Normalizamos por el máximo de la pista: solo importa la intensidad relativa.
  let maxB = 1e-9;
  let maxM = 1e-9;
  for (const w of windows) {
    if (w.bass > maxB) maxB = w.bass;
    if (w.mid > maxM) maxM = w.mid;
  }
  for (const w of windows) w.score = 0.6 * (w.bass / maxB) + 0.4 * (w.mid / maxM);
  return windows;
}

/** Número de rondas según la duración de la pista. */
export function roundCountFor(duration) {
  if (duration >= 150) return 5;
  if (duration >= 100) return 4;
  if (duration >= 60) return 3;
  return Math.max(1, Math.floor(duration / SEGMENT_SECONDS));
}

/**
 * Elige los segmentos no solapados más intensos y los ordena de menor a mayor intensidad.
 * @returns {{start:number, end:number, intensity:number}[]}
 */
export function pickSegments(windows, duration) {
  if (!(duration > 0) || windows.length === 0) return [];
  if (duration < SEGMENT_SECONDS + 1) return [{ start: 0, end: duration, intensity: 1 }];

  const span = Math.round(SEGMENT_SECONDS / WINDOW_SECONDS);
  const maxStart = windows.length - span;
  if (maxStart < 0) return [{ start: 0, end: duration, intensity: 1 }];

  // Suma deslizante del score sobre `span` ventanas.
  const sums = new Float64Array(maxStart + 1);
  let acc = 0;
  for (let i = 0; i < span; i++) acc += windows[i].score;
  sums[0] = acc;
  for (let s = 1; s <= maxStart; s++) {
    acc += windows[s + span - 1].score - windows[s - 1].score;
    sums[s] = acc;
  }

  const count = roundCountFor(duration);
  const taken = [];
  for (let k = 0; k < count; k++) {
    let best = -1;
    for (let s = 0; s <= maxStart; s++) {
      if (taken.some((t) => Math.abs(s - t) < span)) continue;
      if (best < 0 || sums[s] > sums[best]) best = s;
    }
    if (best < 0) break;
    taken.push(best);
  }

  // `taken` está en orden de intensidad descendente. Siempre conservamos hasta MIN_ROUNDS;
  // las rondas extra solo si son tramos intensos de verdad (no rellenos casi silenciosos).
  const best = taken.length ? sums[taken[0]] : 0;
  const kept = taken.filter((s, k) => k < MIN_ROUNDS || sums[s] >= best * EXTRA_ROUND_RATIO);

  return kept
    .map((s) => ({
      start: s * WINDOW_SECONDS,
      end: Math.min(duration, s * WINDOW_SECONDS + SEGMENT_SECONDS),
      intensity: sums[s] / span,
    }))
    .sort((a, b) => a.intensity - b.intensity);
}

/** Rondas equiespaciadas (cronológicas) cuando no se pudo decodificar la pista. */
export function fallbackSegments(duration) {
  if (!Number.isFinite(duration) || duration <= 0) {
    return [{ start: 0, end: Infinity, intensity: 0 }];
  }
  if (duration < SEGMENT_SECONDS + 1) return [{ start: 0, end: duration, intensity: 0 }];
  const count = roundCountFor(duration);
  const gap = (duration - count * SEGMENT_SECONDS) / count;
  const segments = [];
  for (let i = 0; i < count; i++) {
    const start = gap / 2 + i * (SEGMENT_SECONDS + gap);
    segments.push({ start, end: Math.min(duration, start + SEGMENT_SECONDS), intensity: 0 });
  }
  return segments;
}

/* ---------------- motor ---------------- */

export class AudioEngine {
  constructor() {
    this.context = null;
    this.analyser = null;
    this.gain = null;
    this.audio = null;
    this.source = null;
    this.objectUrl = null;
    this.fileName = '';
    this.freqData = null;
    this.onEnded = null;
    this.onError = null;
    /** @type {Promise<{segments:object[], fallback:boolean, duration:number}|null>|null} */
    this.analysis = null;
    this.loadToken = 0;

    this.bassDetector = new AdaptivePeakDetector({ sensitivity: BEAT_SENSITIVITY, cooldown: BEAT_COOLDOWN });
    this.midDetector = new AdaptivePeakDetector({ sensitivity: MID_SENSITIVITY, cooldown: MID_COOLDOWN });
    this.#resetAverages();
  }

  #resetAverages() {
    this.bassAvg = null;
    this.energyAvg = null;
    this.energyFast = null;
    this.lastSampleT = null;
    this.lastSurgeAt = -Infinity;
  }

  get hasTrack() {
    return this.audio !== null;
  }

  /**
   * Sustituye la pista actual por un archivo local. Libera la anterior.
   * Lanza el análisis previo; su resultado queda en `this.analysis`
   * (resuelve a `null` si otra carga lo dejó obsoleto).
   */
  loadFile(file) {
    this.unload();
    const token = ++this.loadToken;
    this.objectUrl = URL.createObjectURL(file);
    this.fileName = file.name;

    const audio = new Audio();
    audio.preload = 'auto';
    audio.src = this.objectUrl;
    // Ignoramos eventos de elementos ya descartados (p. ej. el `error` que lanza load() sin src).
    audio.addEventListener('ended', () => this.audio === audio && this.onEnded?.());
    audio.addEventListener('error', () => this.audio === audio && this.onError?.(audio.error));
    this.audio = audio;

    // Si el contexto ya existe (canción previa), conectamos de inmediato.
    if (this.context) this.#connect();
    this.resetDetectors();

    this.analysis = this.#analyze(file, token);
    return this.analysis;
  }

  async #analyze(file, token) {
    const stale = () => token !== this.loadToken;
    try {
      const data = await file.arrayBuffer();
      if (stale()) return null;
      const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!Offline) throw new Error('OfflineAudioContext no disponible');
      const offline = new Offline(1, 1, ANALYSIS_RATE);
      const buffer = await offline.decodeAudioData(data);
      if (stale()) return null;
      const windows = measureWindows(buffer);
      const segments = pickSegments(windows, buffer.duration);
      if (segments.length) {
        return { segments, fallback: false, duration: buffer.duration };
      }
    } catch (err) {
      console.warn('[audio] No se pudo analizar la pista; se usarán rondas equiespaciadas.', err);
    }
    if (stale()) return null;
    const duration = await this.#waitForDuration();
    if (stale()) return null;
    return { segments: fallbackSegments(duration), fallback: true, duration };
  }

  #waitForDuration() {
    const audio = this.audio;
    if (!audio) return Promise.resolve(0);
    if (Number.isFinite(audio.duration) && audio.duration > 0) return Promise.resolve(audio.duration);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        audio.removeEventListener('loadedmetadata', done);
        audio.removeEventListener('error', done);
        resolve(Number.isFinite(audio.duration) ? audio.duration : 0);
      };
      const timer = setTimeout(done, DURATION_TIMEOUT_MS);
      audio.addEventListener('loadedmetadata', done);
      audio.addEventListener('error', done);
    });
  }

  /** Detiene y libera la pista actual (ObjectURL incluido). */
  unload() {
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.audio = null;
    this.fileName = '';
    this.analysis = null;
  }

  /** Crea o reanuda el AudioContext. Llamar SOLO desde un gesto del usuario. */
  async ensureContext() {
    if (!this.context) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.context = new Ctx();
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = FFT_SIZE;
      this.analyser.smoothingTimeConstant = 0.5;
      this.gain = this.context.createGain();
      this.analyser.connect(this.gain);
      this.gain.connect(this.context.destination);
      this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
    }
    if (this.audio && !this.source) this.#connect();
    if (this.context.state === 'suspended') await this.context.resume();
  }

  #connect() {
    this.source = this.context.createMediaElementSource(this.audio);
    this.source.connect(this.analyser);
  }

  async play() {
    if (!this.audio) return;
    await this.ensureContext();
    await this.audio.play();
  }

  /** Salta a `t` y reproduce con un fundido de entrada corto (sin clics). */
  async playFrom(t, fadeIn = 0.25) {
    if (!this.audio) return;
    await this.ensureContext();
    this.#setGain(0);
    this.seek(t);
    await this.audio.play();
    this.fadeTo(1, fadeIn);
  }

  pause() {
    this.audio?.pause();
  }

  seek(t) {
    if (!this.audio) return;
    this.audio.currentTime = Math.max(0, t);
    this.resetDetectors();
  }

  #setGain(v) {
    if (!this.gain) return;
    const g = this.gain.gain;
    g.cancelScheduledValues(this.context.currentTime);
    g.setValueAtTime(v, this.context.currentTime);
  }

  fadeTo(v, secs) {
    if (!this.gain) return;
    const g = this.gain.gain;
    const now = this.context.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(v, now + Math.max(0.01, secs));
  }

  resetDetectors() {
    this.bassDetector.reset();
    this.midDetector.reset();
    this.#resetAverages();
  }

  get currentTime() {
    return this.audio?.currentTime ?? 0;
  }

  get duration() {
    const d = this.audio?.duration;
    return Number.isFinite(d) ? d : 0;
  }

  get progress() {
    const d = this.duration;
    return d > 0 ? Math.min(1, this.currentTime / d) : 0;
  }

  #bandEnergy([lowHz, highHz]) {
    const binHz = this.context.sampleRate / FFT_SIZE;
    const from = Math.max(1, Math.floor(lowHz / binHz));
    const to = Math.min(this.freqData.length - 1, Math.ceil(highHz / binHz));
    let sum = 0;
    for (let i = from; i <= to; i++) sum += this.freqData[i];
    return sum / ((to - from + 1) * 255);
  }

  /**
   * Lectura por frame.
   * `accent`: beat de graves claramente por encima de lo habitual en la canción.
   * `surge`: la energía sube de golpe respecto a la media lenta (drop, estribillo, cambio de sección).
   * @returns {{bass:number, mid:number, energy:number, gated:boolean, bassThreshold:number,
   *   beat:boolean, midPeak:boolean, accent:boolean, surge:boolean, bassAvg:number,
   *   energyAvg:number, progress:number}}
   */
  sample() {
    const idle = {
      bass: 0, mid: 0, energy: 0, gated: true, bassThreshold: 0,
      beat: false, midPeak: false, accent: false, surge: false, bassAvg: 0, energyAvg: 0,
      progress: this.progress,
    };
    if (!this.analyser || !this.audio || this.audio.paused) return idle;

    this.analyser.getByteFrequencyData(this.freqData);
    const bass = this.#bandEnergy(BASS_RANGE);
    const mid = this.#bandEnergy(MID_RANGE);
    const energy = Math.max(bass, mid);
    const t = this.audio.currentTime;

    // Puerta de ruido: sin energía suficiente no hay beat aunque el umbral adaptativo lo permita.
    const beat = this.bassDetector.push(bass, t, bass >= ENERGY_GATE);
    const midPeak = this.midDetector.push(mid, t, mid >= ENERGY_GATE);

    // Medias exponenciales por tiempo (independientes del framerate).
    const dt = this.lastSampleT === null ? 0 : Math.max(0, Math.min(0.25, t - this.lastSampleT));
    this.lastSampleT = t;
    const ema = (prev, v, tau) => (prev === null ? v : prev + (v - prev) * (1 - Math.exp(-dt / tau)));
    const bassAvgBefore = this.bassAvg ?? bass;
    this.bassAvg = ema(this.bassAvg, bass, SLOW_AVG_SECONDS);
    this.energyAvg = ema(this.energyAvg, energy, SLOW_AVG_SECONDS);
    this.energyFast = ema(this.energyFast, energy, FAST_AVG_SECONDS);

    const accent = beat && bass >= ACCENT_MIN_BASS && bass >= bassAvgBefore * ACCENT_RATIO;
    // Necesita algo de historia (≥ 1 s de detector) para no dispararse al arrancar el segmento.
    let surge = false;
    if (
      this.bassDetector.history.length > 30 &&
      this.energyFast - this.energyAvg >= SURGE_DELTA &&
      this.energyFast >= ENERGY_GATE &&
      t - this.lastSurgeAt >= SURGE_COOLDOWN
    ) {
      surge = true;
      this.lastSurgeAt = t;
    }

    return {
      bass,
      mid,
      energy,
      gated: energy < ENERGY_GATE,
      bassThreshold: this.bassDetector.threshold,
      beat,
      midPeak,
      accent,
      surge,
      bassAvg: this.bassAvg,
      energyAvg: this.energyAvg,
      progress: this.progress,
    };
  }
}
