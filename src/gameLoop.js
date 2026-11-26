/**
 * GameLoop: estados, rondas por segmento de canción, spawner reactivo al ritmo,
 * plataformas que cambian con la música, poderes, OVNI, colisiones y efectos
 * (partículas, explosiones, shake, hit-stop).
 * El bucle rAF corre siempre (para animar la barra de ritmo y pantallas),
 * pero la simulación solo avanza en PLAYING.
 */
import {
  WORLD, Player, HellHound, HoundState, Particle, Pickup, PowerType, POWERS, overlaps,
  arena, setLayout, generateLayout, reanchorSurfaces,
  CharacterType, Boss, BossShot, BossState, LeapImpact, Ufo, UFO, segmentVsBox, Temperament,
} from './entities.js';

export const GameState = Object.freeze({
  IDLE: 'IDLE',
  PLAYING: 'PLAYING',
  PAUSED: 'PAUSED',
  VICTORY: 'VICTORY',
  GAME_OVER: 'GAME_OVER',
});

/** Fase dentro de PLAYING: combate sobre un segmento o respiro entre rondas. */
export const Phase = Object.freeze({ FIGHT: 'FIGHT', BREAK: 'BREAK' });

/**
 * Curva de dificultad continua: cada parámetro se interpola entre [d=0, d=1].
 * d sube como mucho 0,25 por ronda (ver `difficulty`), así que no hay saltos bruscos.
 */
const CURVE = Object.freeze({
  speed: [95, 130],
  maxAlive: [3, 6],
  spawnCooldown: [1.2, 0.75],
  pounceGap: [0.7, 0.45],   // cooldown global entre emboscadas
});

const HOUND_CAP = 6;            // techo absoluto de sabuesos vivos en pantalla
const HORDE_CAP = 10;           // techo mientras se pilota el OVNI (horda)
const HORDE_CAP_BOSS = 5;       // ídem en la ronda del jefe
const HORDE_OPENING = 6;        // oleada inicial al abordar (3 por cada lado)
const HORDE_OPENING_BOSS = 2;
const HORDE_COOLDOWN_MUL = 0.35;
const POST_BLAST_GRACE = 1.5;   // s sin apariciones tras la explosión del OVNI
const MIN_SPAWN_COOLDOWN = 0.7; // piso absoluto entre apariciones
const MAX_DIFFICULTY_STEP = 0.25;

const MAX_DT = 0.05;
const DROUGHT_TIME = 3.0;     // sin beats durante este tiempo (y con música sonando) forzamos un spawn
const DROUGHT_JITTER = 0.8;   // ± s de variación del spawn de reserva
const AMBUSH_DROUGHT = 1.6;   // emboscada de reserva si no hay beats
const SPAWN_MARGIN = 40;      // distancia fuera de pantalla
const WAVE_STAGGER = [26, 46]; // separación entre sabuesos de una misma oleada
const BOTH_SIDES_CHANCE = 0.25; // oleadas que entran por los dos bordes a la vez
const BREAK_TIME = 5;         // respiro entre rondas
const FADE_OUT = 0.35;        // fundido al final de cada segmento
const MAX_PARTICLES = 320;
const HIT_STOP = 0.04;

/*
 * Plataformas musicales (renovación continua): el cambio se arma cada frase corta de beats
 * (PHRASE_BEATS), o antes con un acento fuerte de graves / una subida de energía; nunca antes de
 * PLATFORM_MIN_GAP y, si la canción es plana, como mucho a los PLATFORM_MAX_GAP.
 * Tras el aviso, el cambio cae en un beat.
 */
const PLATFORM_MIN_GAP = 3.5;   // s mínimos entre cambios
const PLATFORM_MIN_GAP_BOSS = 5; // ídem en la ronda del jefe (su salto necesita leer el suelo)
const PLATFORM_MAX_GAP = 6;     // s máximos sin armar un cambio (+ aviso ≈ 7 s)
const PLATFORM_WARN = 0.9;      // s mínimos de aviso (vista previa) antes del cambio
const PLATFORM_WARN_MAX = 1.8;  // si no llega un beat, cambia igualmente
const PLATFORM_BOSS_WAIT = 2;   // s extra que se espera a que el jefe acabe una embestida/salto
const PHRASE_BEATS = 8;         // beats desde el último cambio que bastan para armar otro

const PICKUP_DROP_CHANCE = 0.14;
const PICKUP_PITY_KILLS = 10; // garantía: un poder como mucho cada 10 bajas sin premio
const PICKUP_IDLE_TIME = 12;  // s sin poderes en la arena → aparece uno
const MAX_PICKUPS = 2;

const BOSS_HOUND_CAP = 2;     // sabuesos de acompañamiento en la ronda del jefe
const UFO_STREAK = 8;         // racha mínima (bajas sin recibir daño) para que pueda aparecer
const UFO_CHANCE = 0.12;      // probabilidad por baja una vez alcanzada la racha
const UFO_COOLDOWN = 45;      // s mínimos entre apariciones

const FX = Object.freeze({
  spark: ['#fff36b', '#ffd23f', '#ffffff'],
  blood: ['#ff3b5c', '#ff6b3a', '#ffb347', '#7a1020'],
  muzzle: ['#fff36b', '#ffffff'],
  player: ['#7fd4ff', '#ffffff'],
  rebuild: ['#38d4ff', '#ffffff'],
  boss: ['#ff3b5c', '#ffb347', '#fff36b', '#3a1020'],
  laser: ['#ff3bd4', '#ffffff', '#38d4ff'],
  ufo: ['#38ff9c', '#38d4ff', '#ffffff'],
});

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const lerp = (a, b, t) => a + (b - a) * t;

export class GameLoop {
  /**
   * @param {object} deps
   * @param {import('./audioEngine.js').AudioEngine} deps.audio
   * @param {{ snapshot: () => object }} deps.input
   * @param {(game: GameLoop) => void} deps.render
   * @param {(state: string) => void} [deps.onStateChange]
   * @param {(err: unknown) => void} [deps.onError]
   * @param {{boss?:boolean, ufo?:boolean}} [deps.debug] atajos de prueba (?boss / ?ufo en la URL)
   */
  constructor({ audio, input, render, onStateChange, onError, debug }) {
    this.debug = { boss: false, ufo: false, platforms: false, ...debug };
    this.character = CharacterType.SHOOTER;
    this.audio = audio;
    this.input = input;
    this.render = render;
    this.onStateChange = onStateChange ?? (() => {});
    this.onError = onError ?? ((err) => console.error(err));

    this.state = GameState.IDLE;
    this.segments = [];
    this.player = new Player();
    this.runId = 0;
    this.aim = { x: WORLD.width / 2, y: WORLD.height / 2, active: false };
    this.aimPulse = 0;
    this.reset();
    this.lastSample = {
      bass: 0, mid: 0, energy: 0, gated: true, bassThreshold: 0, beat: false, midPeak: false, progress: 0,
    };

    this.lastTime = 0;
    this.frame = this.frame.bind(this);
  }

  start() {
    this.lastTime = performance.now();
    requestAnimationFrame(this.frame);
  }

  setState(next) {
    if (this.state === next) return;
    this.state = next;
    this.onStateChange(next);
  }

  /** @param {{start:number,end:number,intensity:number}[]} segments */
  setSegments(segments) {
    this.segments = segments.length ? segments : [{ start: 0, end: Infinity, intensity: 0 }];
  }

  /** Limpia la arena (no toca el audio) e invalida cualquier ronda pendiente de arrancar. */
  reset(character = this.character) {
    this.runId += 1;
    this.character = character;
    this.player.reset(character);
    this.boss = null;
    this.bossRound = false;
    this.bossDefeated = false;
    this.hazards = [];
    this.ufo = null;
    this.ufoCooldown = 0;
    this.ufoHorde = false;
    this.spawnGrace = 0;
    this.explosions = [];
    this.screenFlash = 0;
    this.streak = 0;
    this.bestStreak = 0;
    this.roundsCleared = 0;
    this.hounds = [];
    this.bullets = [];
    this.particles = [];
    this.pickups = [];
    this.kills = 0;
    this.roundIndex = 0;
    this.round = 1;
    this.phase = Phase.BREAK;
    this.breakTimer = 0;
    this.starting = false;
    this.fadingOut = false;
    this.trackEnded = false;
    this.sinceSpawn = 0;
    this.sinceBeat = 0;
    this.sinceAmbush = 0;
    this.pounceCooldown = 0;
    this.beatFlash = 0;
    this.bassPulse = 0;
    this.shake = 0;
    this.hitStop = 0;
    this.sinceSwap = 0;
    this.beatsSinceSwap = 0;
    this.warnTime = null;
    this.lastSwapReason = null;
    this.nextLayout = null;
    this.droughtLimit = DROUGHT_TIME;
    this.killsSinceDrop = 0;
    this.pickupIdle = 0;
    this.lastPowerType = null;
    this.#cfgCache = null;
    setLayout(generateLayout(this.currentLayout));
  }

  /* ---------------- rondas y dificultad ---------------- */

  get roundCount() {
    return Math.max(1, this.segments.length);
  }

  /** Dificultad 0..1 de la ronda actual; sube como mucho MAX_DIFFICULTY_STEP por ronda. */
  get difficulty() {
    const n = this.roundCount;
    if (n <= 1) return 0.5;
    return Math.min(1, this.roundIndex / Math.max(n - 1, 1 / MAX_DIFFICULTY_STEP));
  }

  #cfgCache = null;

  get roundConfig() {
    const d = this.difficulty;
    const boss = this.bossRound;
    const horde = this.ufoHorde;
    const c = this.#cfgCache;
    if (c?.d === d && c.boss === boss && c.horde === horde) return c;
    const cooldown = Math.max(MIN_SPAWN_COOLDOWN, lerp(...CURVE.spawnCooldown, d)) * (boss ? 2 : 1);
    this.#cfgCache = {
      d,
      boss,
      horde,
      speed: lerp(...CURVE.speed, d),
      // Con el jefe en escena solo hay un par de sabuesos de acompañamiento;
      // pilotando el OVNI llega una horda para aprovechar el láser.
      maxAlive: horde
        ? (boss ? HORDE_CAP_BOSS : HORDE_CAP)
        : boss ? BOSS_HOUND_CAP : Math.min(HOUND_CAP, Math.round(lerp(...CURVE.maxAlive, d))),
      cap: horde ? (boss ? HORDE_CAP_BOSS : HORDE_CAP) : HOUND_CAP,
      spawnCooldown: horde ? cooldown * HORDE_COOLDOWN_MUL : cooldown,
      waveSize: horde ? 2 : !boss && d >= 0.5 ? 2 : 1,
      midSpawns: horde || (!boss && d >= 0.75),
      aggression: d,
      maxPouncing: d >= 0.5 ? 2 : 1,
      pounceGap: lerp(...CURVE.pounceGap, d),
    };
    return this.#cfgCache;
  }

  #segmentEnd(seg) {
    if (Number.isFinite(seg.end)) return seg.end;
    return this.audio.duration || Infinity;
  }

  /** Segundos que quedan del segmento en curso (o duración completa del siguiente, en el respiro). */
  get segmentRemaining() {
    const seg = this.segments[this.roundIndex];
    if (!seg) return 0;
    if (this.bossRound && this.phase === Phase.FIGHT) return 0; // la ronda del jefe no tiene reloj
    const end = this.#segmentEnd(seg);
    if (!Number.isFinite(end)) return 0;
    if (this.phase === Phase.BREAK) return end - seg.start;
    return Math.max(0, end - this.audio.currentTime);
  }

  get segmentProgress() {
    const seg = this.segments[this.roundIndex];
    if (!seg || this.phase === Phase.BREAK) return 0;
    if (this.bossRound) return this.boss ? 1 - this.boss.hpFrac : 1;
    const end = this.#segmentEnd(seg);
    if (!Number.isFinite(end) || end <= seg.start) return 0;
    return Math.min(1, Math.max(0, (this.audio.currentTime - seg.start) / (end - seg.start)));
  }

  /** Disposición vigente (motivo + plataformas), referencia para generar la siguiente. */
  get currentLayout() {
    return { motif: arena.motif, platforms: arena.platforms };
  }

  /** Plataformas de la próxima disposición (solo durante el aviso), o null. */
  get nextPlatforms() {
    return this.nextLayout?.platforms ?? null;
  }

  /** 0..1 durante el aviso previo al cambio de plataformas; 0 fuera de él. */
  get platformWarning() {
    if (!this.nextPlatforms || this.warnTime === null) return 0;
    return Math.min(1, Math.max(0.001, this.warnTime / PLATFORM_WARN));
  }

  /** Arranca una partida desde la ronda 1. Llamar desde un gesto del usuario (política de autoplay). */
  /** ¿`i` es la ronda final (la del jefe)? */
  isFinalRound(i = this.roundIndex) {
    return i >= this.roundCount - 1;
  }

  async startRun(character = this.character) {
    if (!this.segments.length) throw new Error('La pista aún no tiene rondas');
    this.reset(character);
    this.setState(GameState.PLAYING);
    const first = this.debug.boss ? this.roundCount - 1 : 0;
    this.roundIndex = first;
    this.round = first + 1;
    await this.#beginRound(first);
  }

  async #beginRound(i) {
    const run = this.runId;
    this.roundIndex = i;
    this.round = i + 1;
    this.phase = Phase.BREAK;
    this.starting = true;
    try {
      await this.audio.playFrom(this.segments[i].start);
    } finally {
      if (run === this.runId) this.starting = false;
    }
    if (run !== this.runId) return; // se reinició o cambió la pista mientras arrancaba
    if (this.state !== GameState.PLAYING && this.state !== GameState.PAUSED) {
      this.audio.pause();
      return;
    }
    if (this.state === GameState.PAUSED) this.audio.pause();
    this.phase = Phase.FIGHT;
    this.fadingOut = false;
    this.trackEnded = false;
    this.sinceSpawn = 0;
    this.sinceBeat = 0;
    this.sinceAmbush = 0;
    this.sinceSwap = 0;
    this.beatsSinceSwap = 0;
    this.warnTime = null;
    this.nextLayout = null;
    this.pickupIdle = 0;
    this.spawnGrace = 0;
    // Ronda final: entra el jefe (una sola vez aunque el arranque se reintente).
    this.bossRound = this.isFinalRound(i);
    if (this.bossRound && !this.boss && !this.bossDefeated) {
      this.boss = new Boss(this.roundCount);
      this.addShake(0.6);
    }
  }

  #endRound() {
    this.audio.pause();
    this.roundsCleared += 1;
    this.#releaseUfo();
    this.ufo = null;
    this.ufoHorde = false;
    this.hazards = [];
    this.boss = null;
    this.player.slash = null;
    // La arena se limpia con una ráfaga por cada sabueso superviviente.
    for (const h of this.hounds) {
      if (h.state !== HoundState.DEAD) {
        h.kill();
        this.#burst(h.x, h.y - 12, 10, FX.blood);
      }
    }
    this.bullets = [];
    this.pickups = [];
    this.player.power = null;
    this.addShake(0.4);

    if (this.roundIndex + 1 >= this.roundCount) {
      this.setState(GameState.VICTORY);
      return;
    }
    // La disposición de la siguiente ronda ya se ve durante el respiro.
    this.nextLayout = null;
    this.warnTime = null;
    this.#swapPlatforms(generateLayout(this.currentLayout));
    this.phase = Phase.BREAK;
    this.breakTimer = BREAK_TIME;
    this.roundIndex += 1;
    this.round = this.roundIndex + 1;
  }

  /** La pista llegó a su fin (evento `ended`). */
  onTrackEnded() {
    if (this.phase !== Phase.FIGHT) return;
    if (this.bossRound && this.boss) {
      // El combate con el jefe no acaba con la música: el segmento vuelve a sonar en bucle.
      const run = this.runId;
      this.audio.playFrom(this.segments[this.roundIndex].start).then(() => {
        if (run === this.runId && this.state !== GameState.PLAYING) this.audio.pause();
      }).catch((err) => this.onError(err));
      return;
    }
    this.trackEnded = true;
  }

  pause() {
    if (this.state !== GameState.PLAYING) return;
    this.audio.pause();
    this.setState(GameState.PAUSED);
  }

  async resume() {
    if (this.state !== GameState.PAUSED) return;
    // En el respiro (o mientras arranca la ronda) el audio sigue parado; solo se descongela el juego.
    if (this.phase === Phase.FIGHT && !this.starting) await this.audio.play();
    this.setState(GameState.PLAYING);
  }

  /* ---------------- bucle ---------------- */

  frame(now) {
    const dt = Math.min(MAX_DT, (now - this.lastTime) / 1000);
    this.lastTime = now;

    const sample = this.audio.sample();
    this.lastSample = sample;
    this.beatFlash = Math.max(0, this.beatFlash - dt * 4);
    if (sample.beat) this.beatFlash = 1;
    this.bassPulse += (sample.bass - this.bassPulse) * Math.min(1, dt * 12);
    this.shake = Math.max(0, this.shake - dt * 2.5);
    this.aimPulse = Math.max(0, this.aimPulse - dt * 8);
    if (this.state !== GameState.PAUSED) this.screenFlash = Math.max(0, this.screenFlash - dt * 3);

    if (this.state === GameState.PLAYING) this.update(dt, sample);
    else if (this.state !== GameState.PAUSED) {
      this.#updateParticles(dt);
      this.#updateExplosions(dt);
    }

    this.render(this);
    requestAnimationFrame(this.frame);
  }

  update(dt, sample) {
    const input = this.input.snapshot();
    if (input.aim) this.aim = input.aim;

    if (this.hitStop > 0) {
      this.hitStop -= dt;
      return;
    }

    const fighting = this.phase === Phase.FIGHT;
    if (fighting) {
      this.#spawn(dt, sample);
      this.#ambush(dt, sample);
      this.#musicalPlatforms(dt, sample);
      this.#spawnTimedPickup(dt);
    } else if (!this.starting) {
      this.breakTimer -= dt;
      if (this.breakTimer <= 0) {
        this.#beginRound(this.roundIndex).catch((err) => {
          // Pausamos para no reintentar en cada frame; "Reanudar" vuelve a intentarlo.
          this.pause();
          this.onError(err);
        });
      }
    }

    // El OVNI se mueve antes que el jugador: si lo pilota, el jugador copia su posición.
    if (this.ufo) {
      const ufo = this.ufo;
      ufo.update(dt, input);
      // Se acabó el tiempo de vuelo: el piloto salta y el platillo cae en picado.
      if (ufo.piloted && ufo.pilotLeft <= 0) this.#crashUfo();
      if (ufo.crashing) this.#crashTrail(ufo);
      if (ufo.exploded) this.#ufoExplosion(ufo);
      if (!ufo.alive) {
        this.ufo = null;
        // Si se marchó sin estrellarse (fin de ronda, etc.) la horda también termina.
        this.ufoHorde = false;
      }
    }
    if (fighting) this.ufoCooldown = Math.max(0, this.ufoCooldown - dt);

    this.player.update(dt, input, (b) => this.#onShot(b));
    for (const b of this.bullets) b.update(dt);
    for (const h of this.hounds) h.update(dt, this.player);
    for (const p of this.pickups) p.update(dt);
    if (this.boss) this.#updateBoss(dt, sample);
    for (const z of this.hazards) z.update(dt);
    this.#updateParticles(dt);
    this.#updateExplosions(dt);

    this.#collide();

    this.bullets = this.bullets.filter((b) => b.alive);
    this.pickups = this.pickups.filter((p) => p.alive);
    this.hazards = this.hazards.filter((z) => z.alive);
    this.hounds = this.hounds.filter(
      (h) => h.alive && h.x > -SPAWN_MARGIN * 3 && h.x < WORLD.width + SPAWN_MARGIN * 3,
    );

    if (this.player.dead && this.player.onGround) {
      this.setState(GameState.GAME_OVER);
      return;
    }

    if (this.bossRound) {
      // La ronda final termina al caer el jefe (no con el segmento).
      if (fighting && this.boss && !this.boss.alive) {
        this.bossDefeated = true;
        this.#endRound();
      }
      return;
    }

    if (fighting && this.phase === Phase.FIGHT) {
      const seg = this.segments[this.roundIndex];
      const end = this.#segmentEnd(seg);
      const t = this.audio.currentTime;
      if (!this.fadingOut && t >= end - FADE_OUT) {
        this.fadingOut = true;
        this.audio.fadeTo(0, FADE_OUT);
      }
      if (t >= end || this.trackEnded) this.#endRound();
    }
  }

  get aliveHounds() {
    let n = 0;
    for (const h of this.hounds) if (h.state !== HoundState.DEAD) n++;
    return n;
  }

  #spawn(dt, sample) {
    this.sinceSpawn += dt;
    if (this.spawnGrace > 0) {
      this.spawnGrace -= dt;
      return;
    }
    // La sequía solo cuenta mientras la música suena con energía: en silencio no aparece nadie.
    if (!sample.gated) this.sinceBeat += dt;
    const cfg = this.roundConfig;
    const room = Math.min(cfg.maxAlive, cfg.cap) - this.aliveHounds;
    if (room <= 0 || this.sinceSpawn < cfg.spawnCooldown) return;

    let count = 0;
    if (sample.beat) count = cfg.waveSize + (cfg.horde && Math.random() < 0.5 ? 1 : 0);
    else if (sample.midPeak && cfg.midSpawns) count = 1;
    else if (!sample.gated && this.sinceBeat >= this.droughtLimit) count = 1;

    if (sample.beat) this.sinceBeat = 0;
    if (count === 0) return;

    this.#spawnHounds(Math.min(count, room), cfg);
    this.sinceSpawn = 0;
    this.sinceBeat = 0;
    this.droughtLimit = DROUGHT_TIME + rand(-DROUGHT_JITTER, DROUGHT_JITTER);
  }

  /**
   * Entra una oleada de `count` sabuesos: normalmente por un borde (preferentemente el más lejano
   * al jugador) y a veces por los dos a la vez. La separación entre ellos varía.
   */
  #spawnHounds(count, cfg, bothSides = count > 1 && Math.random() < BOTH_SIDES_CHANCE) {
    const farLeft = this.player.x > WORLD.width / 2;
    const fromLeft = Math.random() < (farLeft ? 0.6 : 0.4);
    let offL = SPAWN_MARGIN;
    let offR = SPAWN_MARGIN;
    for (let i = 0; i < count; i++) {
      const left = bothSides ? (i % 2 === 0) === fromLeft : fromLeft;
      const x = left ? -offL : WORLD.width + offR;
      if (left) offL += rand(...WAVE_STAGGER);
      else offR += rand(...WAVE_STAGGER);
      this.hounds.push(new HellHound(x, cfg));
    }
  }

  /** En un beat (o tras una sequía de beats), como mucho un sabueso elegible inicia una emboscada. */
  #ambush(dt, sample) {
    if (this.bossRound) return; // con el jefe no hay emboscadas: su telegrafía manda
    const cfg = this.roundConfig;
    this.pounceCooldown = Math.max(0, this.pounceCooldown - dt);
    if (!sample.gated) this.sinceAmbush += dt;
    const trigger = sample.beat
      || (sample.midPeak && Math.random() < 0.5)
      || (!sample.gated && this.sinceAmbush >= AMBUSH_DROUGHT);
    if (!trigger || this.pounceCooldown > 0) return;
    if (this.hounds.filter((h) => h.isPouncing).length >= cfg.maxPouncing) return;
    const candidates = this.hounds.filter((h) => h.canPounce(this.player));
    if (!candidates.length) return;
    // Elección ponderada: los acechadores y los más cercanos emboscan más, pero no siempre.
    const weights = candidates.map((h) => (h.temperament === Temperament.STALKER ? 2.5 : 1)
      / (0.5 + Math.abs(this.player.x - h.x) / 150));
    let r = Math.random() * weights.reduce((a, b) => a + b, 0);
    let chosen = candidates[candidates.length - 1];
    for (let i = 0; i < candidates.length; i++) {
      r -= weights[i];
      if (r <= 0) {
        chosen = candidates[i];
        break;
      }
    }
    chosen.pounce(this.player);
    this.pounceCooldown = cfg.pounceGap * rand(0.75, 1.35);
    this.sinceAmbush = 0;
  }

  /* ---------------- plataformas dinámicas ---------------- */

  /** ¿El jefe está a mitad de una embestida o un salto? (no cambiamos el suelo bajo su telegrafía) */
  get #bossBusy() {
    const s = this.boss?.state;
    return s === BossState.SLAM_WINDUP || s === BossState.SLAM
      || s === BossState.CHARGE_WINDUP || s === BossState.CHARGE
      || s === BossState.LEAP_WINDUP || s === BossState.LEAP;
  }

  /**
   * Cambio de plataformas guiado por la canción (solo en FIGHT):
   * 1) se ARMA con un acento de graves, una subida de energía, una frase larga de beats o,
   *    si la música es plana, al llegar a PLATFORM_MAX_GAP; nunca antes de PLATFORM_MIN_GAP;
   * 2) AVISO: vista previa de la nueva disposición durante ≥ PLATFORM_WARN;
   * 3) el cambio se aplica en el primer beat tras el aviso (o a PLATFORM_WARN_MAX sin beat).
   */
  #musicalPlatforms(dt, sample) {
    this.sinceSwap += dt;
    if (sample.beat) this.beatsSinceSwap += 1;

    if (this.warnTime !== null) {
      this.warnTime += dt;
      if (this.warnTime < PLATFORM_WARN) return;
      const busy = this.#bossBusy && this.warnTime < PLATFORM_WARN_MAX + PLATFORM_BOSS_WAIT;
      if (busy) return;
      if (sample.beat || this.warnTime >= PLATFORM_WARN_MAX) {
        const next = this.nextLayout ?? generateLayout(this.currentLayout);
        this.nextLayout = null;
        this.warnTime = null;
        this.sinceSwap = 0;
        this.beatsSinceSwap = 0;
        this.#swapPlatforms(next);
      }
      return;
    }

    if (this.sinceSwap < (this.bossRound ? PLATFORM_MIN_GAP_BOSS : PLATFORM_MIN_GAP)) return;
    let reason = null;
    if (sample.surge) reason = 'surge';
    else if (sample.accent) reason = 'accent';
    else if (sample.beat && this.beatsSinceSwap >= PHRASE_BEATS) reason = 'phrase';
    else if (this.sinceSwap >= PLATFORM_MAX_GAP) reason = 'max-gap';
    if (!reason) return;
    this.lastSwapReason = reason;
    if (this.debug.platforms) console.debug(`[platforms] ${reason} a ${this.sinceSwap.toFixed(1)} s`);
    this.nextLayout = generateLayout(this.currentLayout);
    this.warnTime = 0;
  }

  /** @param {{motif:string, platforms:object[]}} next */
  #swapPlatforms(next) {
    setLayout(next);
    // Quien pisaba una pasarela sigue apoyado si hay otra justo bajo sus pies; si no, cae limpio.
    reanchorSurfaces([this.player, ...this.hounds, ...this.pickups]);
    for (const p of arena.platforms) {
      for (let x = p.x + 4; x < p.x + p.w; x += 16) {
        this.#emit(new Particle(x, p.y, rand(-20, 20), rand(-60, -20), rand(0.2, 0.4), pick(FX.rebuild), 1, 200));
      }
    }
    this.addShake(0.2);
  }

  /* ---------------- poderes ---------------- */

  #randomPowerType() {
    const types = Object.values(PowerType).filter((t) => t !== this.lastPowerType);
    const t = pick(types);
    this.lastPowerType = t;
    return t;
  }

  #dropPickup(x, y) {
    if (this.pickups.length >= MAX_PICKUPS) return false;
    this.pickups.push(new Pickup(x, y, this.#randomPowerType(), -140));
    this.pickupIdle = 0;
    return true;
  }

  #onHoundKilled(h) {
    this.streak += 1;
    this.bestStreak = Math.max(this.bestStreak, this.streak);
    this.#maybeSpawnUfo();
    this.killsSinceDrop += 1;
    const lucky = Math.random() < PICKUP_DROP_CHANCE || this.killsSinceDrop >= PICKUP_PITY_KILLS;
    if (lucky && h.onScreen && this.#dropPickup(h.x, h.y - 6)) this.killsSinceDrop = 0;
  }

  /** Si la arena lleva un rato sin poderes, aparece uno en un punto accesible. */
  #spawnTimedPickup(dt) {
    if (this.pickups.length) {
      this.pickupIdle = 0;
      return;
    }
    this.pickupIdle += dt;
    if (this.pickupIdle < PICKUP_IDLE_TIME) return;
    const platforms = arena.platforms;
    let x;
    let y;
    if (platforms.length && Math.random() < 0.6) {
      const p = pick(platforms);
      x = p.x + rand(12, p.w - 12);
      y = p.y;
    } else {
      x = rand(48, WORLD.width - 48);
      y = WORLD.groundY;
    }
    this.pickups.push(new Pickup(x, y, this.#randomPowerType(), 0));
    this.pickupIdle = 0;
  }

  /* ---------------- disparo y colisiones ---------------- */

  #onShot(bullet) {
    this.bullets.push(bullet);
    this.aimPulse = 1;
    for (let i = 0; i < 2; i++) {
      const s = rand(40, 90);
      this.#emit(new Particle(
        bullet.x, bullet.y,
        bullet.ux * s + rand(-15, 15), bullet.uy * s + rand(-25, 25),
        rand(0.06, 0.12), pick(FX.muzzle), 1,
      ));
    }
    this.shake = Math.max(this.shake, 0.3);
  }

  /** Aplica daño a un sabueso con sus efectos. @returns {boolean} true si murió. */
  #damageHound(h, dir, damage, knock, fx, fy) {
    const killed = h.takeHit(dir, damage, knock);
    this.#sparks(fx, fy, -dir);
    if (killed) {
      this.kills += 1;
      this.#burst(h.x, h.y - 12, 14, FX.blood);
      this.addShake(0.5);
      this.hitStop = HIT_STOP;
      this.#onHoundKilled(h);
    } else {
      this.addShake(0.25);
    }
    return killed;
  }

  /** Aplica daño al jefe con sus efectos. */
  #damageBoss(dir, damage, fx, fy) {
    const boss = this.boss;
    if (!boss || !boss.canBeHit) return;
    const killed = boss.takeHit(dir, damage);
    this.#sparks(fx, fy, -dir);
    if (killed) {
      this.#burst(boss.x, boss.y - 24, 40, FX.boss);
      this.#explode(boss.x, boss.y - 24, 70, 1);
      this.addShake(1);
      this.hitStop = HIT_STOP * 3;
    } else {
      this.addShake(0.12);
    }
  }

  #updateBoss(dt, sample) {
    const boss = this.boss;
    boss.update(dt, this.player, sample.beat, (z) => this.hazards.push(z));
    if (boss.landed) {
      boss.landed = false;
      // El salto contra plataformas golpea a la altura del objetivo (no en el suelo).
      const leapHit = boss.state === BossState.LEAP;
      const y = leapHit ? boss.leapTargetY : WORLD.groundY;
      this.addShake(leapHit ? 0.9 : 0.7);
      for (let i = 0; i < (leapHit ? 16 : 10); i++) {
        this.#emit(new Particle(boss.x + rand(-30, 30), y, rand(-60, 60), rand(-90, -30), rand(0.3, 0.6), pick(['#5b6488', '#8a90a8', '#ffb347']), 2, 400));
      }
    }
    if (boss.enraged) {
      boss.enraged = false;
      this.addShake(1);
      this.#burst(boss.x, boss.y - 30, 24, FX.boss);
    }
    // Explosiones escalonadas durante la muerte del jefe.
    if (boss.state === 'DEAD' && Math.random() < dt * 14) {
      const ex = boss.x + rand(-30, 30);
      const ey = boss.y - rand(8, 40);
      this.#burst(ex, ey, 6, FX.boss);
      if (Math.random() < 0.5) this.#explode(ex, ey, rand(12, 22), 0.4);
      this.addShake(0.2);
    }
  }

  /* ---------------- OVNI ---------------- */

  #maybeSpawnUfo() {
    if (this.ufo || this.ufoCooldown > 0 || this.phase !== Phase.FIGHT || this.player.dead) return;
    const need = this.debug.ufo ? 3 : UFO_STREAK;
    const chance = this.debug.ufo ? 1 : UFO_CHANCE;
    if (this.streak < need || Math.random() >= chance) return;
    // Aparece en la mitad contraria a la del jugador: hay que ir a buscarlo.
    const x = this.player.x < WORLD.width / 2 ? rand(WORLD.width * 0.55, WORLD.width - 80) : rand(80, WORLD.width * 0.45);
    this.ufo = new Ufo(x);
    this.ufoCooldown = UFO_COOLDOWN;
  }

  /** Saca al piloto del platillo con la física normal (`kick` = impulso vertical). */
  #ejectPilot(ufo, kick = 0, invulnerable = 1) {
    const p = this.player;
    if (p.mount !== ufo) return;
    p.mount = null;
    p.x = Math.max(8, Math.min(WORLD.width - 8, ufo.x));
    p.y = Math.min(WORLD.groundY, ufo.y + 12);
    p.vx = 0;
    p.vy = kick;
    p.onGround = false;
    p.surface = null;
    p.dropTimer = 0;
    p.invulnerable = Math.max(p.invulnerable, invulnerable);
    this.#burst(ufo.x, ufo.y, 8, FX.ufo);
  }

  /** Desmonta limpiamente y el platillo se marcha (fin de ronda / nadie lo abordó). */
  #releaseUfo() {
    const ufo = this.ufo;
    if (!ufo) return;
    this.#ejectPilot(ufo);
    if (ufo.state !== 'LEAVING' && !ufo.crashing) ufo.release();
  }

  /** Fin del vuelo: el piloto salta con un pequeño impulso y el OVNI cae sin control. */
  #crashUfo() {
    const ufo = this.ufo;
    if (!ufo) return;
    this.#ejectPilot(ufo, -180, 1.2);
    ufo.crash();
    this.addShake(0.3);
    this.#sparks(ufo.x, ufo.y, Math.sign(ufo.vx) || 1);
  }

  /** Humo y chispas mientras el platillo cae. */
  #crashTrail(ufo) {
    if (Math.random() < 0.7) {
      this.#emit(new Particle(ufo.x + rand(-10, 10), ufo.y - 4, rand(-15, 15), rand(-50, -20), rand(0.4, 0.8), pick(['#3a3f55', '#5b6488', '#2a2f4a']), 2, -30));
    }
    if (Math.random() < 0.5) {
      this.#emit(new Particle(ufo.x + rand(-18, 18), ufo.y + rand(-4, 4), rand(-60, 60), rand(-60, 0), rand(0.15, 0.3), pick(['#ffb347', '#fff36b', '#ff6b3a']), 1, 300));
    }
  }

  /**
   * El OVNI choca contra el suelo: explosión que elimina a todos los sabuesos, castiga al jefe
   * (sin rematarlo) y borra sus proyectiles. Después el spawner vuelve a su ritmo normal.
   */
  #ufoExplosion(ufo) {
    const x = ufo.x;
    const y = WORLD.groundY - 4;
    this.#explode(x, y, 96, 0.9);
    this.screenFlash = 1;
    this.addShake(1);
    this.hitStop = HIT_STOP * 4;
    this.#burst(x, y - 6, 40, ['#ffffff', '#fff36b', '#ffb347', '#ff6b3a', '#38ff9c']);
    for (let i = 0; i < 16; i++) {
      // Escombros del casco.
      this.#emit(new Particle(x + rand(-12, 12), y - 8, rand(-180, 180), rand(-260, -80), rand(0.6, 1.1), pick(['#8a90a8', '#c8cce0', '#5b6488']), 2, 520));
    }

    for (const h of this.hounds) {
      if (h.state === HoundState.DEAD) continue;
      h.kill();
      h.vx = Math.sign(h.x - x || 1) * 160;
      h.vy = -140;
      this.kills += 1;
      this.streak += 1;
      if (h.onScreen) this.#burst(h.x, h.y - 12, 10, FX.blood);
    }
    this.bestStreak = Math.max(this.bestStreak, this.streak);
    if (this.boss?.canBeHit) {
      this.boss.blast(UFO.crashBlast);
      this.#burst(this.boss.x, this.boss.y - 24, 16, FX.boss);
    }
    for (const z of this.hazards) z.alive = false;

    this.ufoHorde = false;
    this.spawnGrace = POST_BLAST_GRACE;
    this.sinceSpawn = 0;
  }

  /** Explosión pixel (anillos expansivos) puramente visual. */
  #explode(x, y, radius, life) {
    if (this.explosions.length >= 12) this.explosions.shift();
    this.explosions.push({ x, y, age: 0, life, radius });
  }

  #updateExplosions(dt) {
    if (!this.explosions.length) return;
    for (const e of this.explosions) e.age += dt;
    this.explosions = this.explosions.filter((e) => e.age < e.life);
  }

  /** Al abordar: oleada inicial por los dos bordes y la horda queda activa mientras se vuela. */
  #startHorde() {
    this.ufoHorde = true;
    const cfg = this.roundConfig;
    const room = cfg.maxAlive - this.aliveHounds;
    const n = Math.min(room, this.bossRound ? HORDE_OPENING_BOSS : HORDE_OPENING);
    if (n > 0) this.#spawnHounds(n, cfg, n > 1);
    this.sinceSpawn = 0;
    this.spawnGrace = 0;
  }

  #collideUfo(pb) {
    const ufo = this.ufo;
    if (!ufo) return;
    if (!ufo.piloted) {
      if (ufo.boardable && !this.player.dead && !this.player.mount && overlaps(pb, ufo.boardBox())) {
        ufo.board();
        this.player.mount = ufo;
        this.player.power = null;
        this.#burst(ufo.x, ufo.y, 14, FX.ufo);
        this.addShake(0.3);
        this.#startHorde();
      }
      return;
    }
    const L = ufo.laser;
    if (!L) return;
    // Chispas en el punto de impacto del rayo.
    if (Math.random() < 0.6) {
      this.#emit(new Particle(L.x1, L.y1, rand(-60, 60), rand(-80, -10), rand(0.1, 0.25), pick(FX.laser), 1, 300));
    }
    if (!ufo.tickReady) return;
    const dir = Math.sign(L.ux) || 1;
    for (const h of this.hounds) {
      if (h.state === HoundState.DEAD) continue;
      if (segmentVsBox(L.x0, L.y0, L.x1, L.y1, h.hitbox())) {
        this.#damageHound(h, dir, UFO.laserDamage, 0.6, h.x, h.y - 12);
      }
    }
    if (this.boss?.canBeHit && segmentVsBox(L.x0, L.y0, L.x1, L.y1, this.boss.hitbox())) {
      this.#damageBoss(dir, UFO.laserDamage, this.boss.x, this.boss.y - 24);
    }
  }

  /** El jugador recibe daño (resetea la racha). */
  #hurtPlayer(fromX, damage = 1) {
    if (!this.player.takeHit(fromX, damage)) return false;
    this.streak = 0;
    this.addShake(damage > 1 ? 1 : 0.8);
    this.#burst(this.player.x, this.player.y - 14, 8, FX.player);
    if (damage > 1) this.#burst(this.player.x, this.player.y - 14, 12, FX.boss);
    return true;
  }

  #collide() {
    const boss = this.boss;
    for (const b of this.bullets) {
      if (!b.alive) continue;
      const bb = b.hitbox();
      for (const h of this.hounds) {
        if (h.state === HoundState.DEAD || b.hit.has(h)) continue;
        if (!overlaps(bb, h.hitbox())) continue;
        b.hit.add(h);
        this.#damageHound(h, b.dir, b.damage, b.knock, b.x, b.y);
        if (b.pierce > 0) {
          b.pierce -= 1;
        } else {
          b.alive = false;
          break;
        }
      }
      if (b.alive && boss?.canBeHit && !b.hit.has(boss) && overlaps(bb, boss.hitbox())) {
        b.hit.add(boss);
        this.#damageBoss(b.dir, b.damage, b.x, b.y);
        if (b.pierce > 0) b.pierce -= 1;
        else b.alive = false;
      }
    }

    // Tajo del caballero: golpea una vez a cada objetivo por tajo y desvía proyectiles del jefe.
    const slash = this.player.slashActive ? this.player.slash : null;
    if (slash) {
      const sb = this.player.slashHitbox();
      for (const h of this.hounds) {
        if (h.state === HoundState.DEAD || slash.hit.has(h) || !overlaps(sb, h.hitbox())) continue;
        slash.hit.add(h);
        this.#damageHound(h, slash.dir, slash.damage, slash.knock, h.x, h.y - 12);
      }
      if (boss?.canBeHit && !slash.hit.has(boss) && overlaps(sb, boss.hitbox())) {
        slash.hit.add(boss);
        this.#damageBoss(slash.dir, slash.damage * 1.5, Math.round(sb.x + sb.w / 2), Math.round(sb.y + sb.h / 2));
      }
      for (const z of this.hazards) {
        if (z instanceof BossShot && z.alive && overlaps(sb, z.hitbox())) {
          z.alive = false;
          this.#sparks(z.x, z.y, slash.dir);
        }
      }
    }

    const pb = this.player.hitbox();
    this.#collideUfo(pb);

    if (!this.player.mount) {
      for (const h of this.hounds) {
        if (h.canHurt && overlaps(pb, h.hitbox())) this.#hurtPlayer(h.x);
      }
      if (boss?.canHurt && overlaps(pb, boss.hitbox())) this.#hurtPlayer(boss.x);
      for (const z of this.hazards) {
        if (z.alive && overlaps(pb, z.hitbox()) && this.#hurtPlayer(z.x, z.damage ?? 1)) {
          if (z instanceof BossShot || z instanceof LeapImpact) z.alive = false;
        }
      }
    }

    if (this.player.dead) return;
    for (const p of this.pickups) {
      if (!p.alive || !overlaps(pb, p.hitbox())) continue;
      p.alive = false;
      this.player.givePower(p.type);
      const color = POWERS[p.type].color;
      this.#burst(p.x, p.y - 6, 10, [color, '#ffffff']);
      this.addShake(0.15);
    }
  }

  /* ---------------- efectos ---------------- */

  addShake(amount) {
    this.shake = Math.min(1, this.shake + amount);
  }

  #emit(p) {
    if (this.particles.length < MAX_PARTICLES) this.particles.push(p);
  }

  #sparks(x, y, dir) {
    for (let i = 0; i < 5; i++) {
      this.#emit(new Particle(x, y, dir * rand(40, 140), rand(-90, 30), rand(0.12, 0.25), pick(FX.spark), 1, 400));
    }
  }

  #burst(x, y, count, palette) {
    for (let i = 0; i < count; i++) {
      const a = rand(0, Math.PI * 2);
      const s = rand(40, 150);
      this.#emit(new Particle(x, y, Math.cos(a) * s, Math.sin(a) * s - 60, rand(0.3, 0.6), pick(palette), Math.random() < 0.35 ? 2 : 1, 380));
    }
    // Brasas lentas que flotan
    for (let i = 0; i < Math.ceil(count / 3); i++) {
      this.#emit(new Particle(x + rand(-8, 8), y, rand(-15, 15), rand(-50, -20), rand(0.5, 0.9), '#ff6b3a', 1, -20));
    }
  }

  #updateParticles(dt) {
    for (const p of this.particles) p.update(dt);
    this.particles = this.particles.filter((p) => p.alive);
  }
}
