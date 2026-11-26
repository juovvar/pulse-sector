/**
 * Entidades de juego: datos + lógica. No conocen el canvas.
 * Cada entidad expone `anim` (clave de animación) y `animTime` (s) para el renderer,
 * y `hitbox()` (AABB en coordenadas de mundo) para colisiones.
 */

export const WORLD = Object.freeze({
  width: 576,
  height: 324,
  groundY: 292, // borde superior del suelo (y de los pies)
  gravity: 900,
});

export const Facing = Object.freeze({ LEFT: -1, RIGHT: 1 });

const lerp = (a, b, t) => a + (b - a) * t;

/* ------------------------------------------------------------------ */
/* Arena: suelo macizo + plataformas one-way (rotan durante la ronda)  */
/* ------------------------------------------------------------------ */

/** Superficie "suelo" en `entity.surface` (las plataformas usan su índice ≥ 0). */
export const GROUND = -1;
export const TILE = 32;
export const PLATFORM_THICKNESS = 16;
const COLS = WORLD.width / TILE; // 18 columnas; útiles 1..16 (x + w ≤ 544)
const MAX_END = COLS - 1;        // columna final (exclusiva) máxima: col + anchoTiles ≤ 17

/** Reglas de alcanzabilidad y equidad (salto del jugador ≈ 60 px; dejamos margen). */
export const LAYOUT_RULES = Object.freeze({
  maxStep: 48,        // desnivel máximo respecto a la superficie de apoyo
  minStep: 44,        // desnivel mínimo entre plataformas que se solapan en horizontal
  edge: TILE,         // pasillo libre junto a cada pared
  minGap: 64,         // separación horizontal mínima entre plataformas a alturas similares
  minOverlap: TILE,   // solape horizontal mínimo con la plataforma de apoyo (para subir en vertical)
  minY: 100,          // no invadir el HUD superior
  minCount: 4,        // composiciones, no piezas sueltas
  maxCount: 8,
  maxTiles: 40,       // tiles cubiertos en total: la arena no se satura
  entryBand: TILE * 2, // banda de entrada de los sabuesos (tras el pasillo `edge`) en cada lado
  entryMaxRise: 96,   // en esa banda solo tier 1-2: nada de "techos" altos sobre la entrada
  maxSimilarity: 0.5, // Jaccard máx. de celdas ocupadas respecto a la disposición anterior
  minChanged: 0.6,    // fracción mínima de plataformas nuevas respecto a la anterior
});

const STEPS = [44, 46, 48];

export const PlatformKind = Object.freeze({ DECK: 'deck', CATWALK: 'catwalk', STEP: 'step' });

/** Composiciones disponibles (una distinta en cada rotación). */
export const MOTIFS = Object.freeze(['stairs', 'bridge', 'ziggurat', 'fork', 'towers', 'terraces']);

/** Estado mutable de la arena. Leer siempre `arena.platforms` (cambia cada pocos segundos). */
export const arena = { platforms: [], motif: null };

const kindFor = (w) => (w >= TILE * 6 ? PlatformKind.CATWALK : PlatformKind.DECK);

/**
 * @param {{x:number,y:number,w:number,kind?:string}[]} platforms
 * @param {string|null} [motif]
 */
export function setPlatforms(platforms, motif = null) {
  arena.platforms = platforms.map((p) => Object.freeze({ x: p.x, y: p.y, w: p.w, kind: p.kind ?? kindFor(p.w) }));
  arena.motif = motif;
}

/** @param {{motif:string, platforms:{x:number,y:number,w:number,kind?:string}[]}} layout */
export function setLayout(layout) {
  setPlatforms(layout.platforms, layout.motif);
}

/** Plataforma por índice de `surface`, o null (protege de índices obsoletos tras una rotación). */
export function platformAt(surface) {
  return surface !== null && surface >= 0 ? arena.platforms[surface] ?? null : null;
}

/** Tras una rotación, nadie queda "anclado" a un índice viejo; `resolveLanding` lo re-apoya o cae. */
export function clearSurfaces(entities) {
  for (const e of entities) {
    if (e.surface !== null && e.surface >= 0) {
      e.surface = null;
      e.onGround = false;
    }
  }
}

const REANCHOR_TOLERANCE = 12; // px de diferencia de altura que se "absorben" al rotar

/**
 * Llamar justo después de `setPlatforms`: quien estaba de pie sobre una plataforma sigue apoyado
 * si la nueva disposición tiene una pasarela bajo sus pies a ≤ 12 px; si no, cae limpio
 * (nunca queda "dentro" de una pasarela recién aparecida atravesándola).
 * @param {{x:number,y:number,vy:number,onGround:boolean,surface:number|null,footHalf?:number}[]} entities
 */
export function reanchorSurfaces(entities) {
  const ps = arena.platforms;
  for (const e of entities) {
    if (e.surface === null || e.surface < 0) continue;
    const half = e.footHalf ?? 0;
    let best = -1;
    let bestD = Infinity;
    if (e.onGround) {
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i];
        if (e.x + half <= p.x || e.x - half >= p.x + p.w) continue;
        const d = Math.abs(p.y - e.y);
        if (d <= REANCHOR_TOLERANCE && d < bestD) {
          best = i;
          bestD = d;
        }
      }
    }
    if (best >= 0) {
      e.y = ps[best].y;
      e.vy = 0;
      e.surface = best;
      e.onGround = true;
    } else {
      e.surface = null;
      e.onGround = false;
    }
  }
}

/** Distancia horizontal entre dos tramos (negativa = solape). */
function spanGap(a, b) {
  return Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
}

/** ¿`p` tiene una superficie inferior desde la que se alcanza de un salto? (transitivo: el soporte está siempre ≥ 44 px más abajo) */
function hasSupport(p, all) {
  const R = LAYOUT_RULES;
  if (WORLD.groundY - p.y <= R.maxStep) return true;
  return all.some((q) => {
    if (q === p) return false;
    const dh = q.y - p.y;
    return dh >= R.minStep && dh <= R.maxStep && -spanGap(p, q) >= R.minOverlap;
  });
}

/** Valida una disposición: tamaño, bordes y bandas de entrada, solapes, separación y alcanzabilidad. */
export function validateLayout(ps) {
  const R = LAYOUT_RULES;
  if (ps.length < R.minCount || ps.length > R.maxCount) return false;
  let tiles = 0;
  let leftBand = 0;
  let rightBand = 0;
  for (const p of ps) {
    if (p.x < R.edge || p.x + p.w > WORLD.width - R.edge) return false;
    if (p.x % TILE !== 0 || p.w % TILE !== 0 || p.w < TILE * 3) return false;
    if (p.y < R.minY || WORLD.groundY - p.y < R.minStep) return false;
    if (!hasSupport(p, ps)) return false;
    tiles += p.w / TILE;
    const inLeft = p.x < R.edge + R.entryBand;
    const inRight = p.x + p.w > WORLD.width - R.edge - R.entryBand;
    if ((inLeft || inRight) && WORLD.groundY - p.y > R.entryMaxRise) return false;
    if (inLeft) leftBand++;
    if (inRight) rightBand++;
  }
  if (tiles > R.maxTiles || leftBand > 1 || rightBand > 1) return false;
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i];
      const b = ps[j];
      const dy = Math.abs(a.y - b.y);
      const gap = spanGap(a, b);
      if (gap < 0 && dy < R.minStep) return false;         // solape a poca distancia vertical
      if (dy < R.minStep && gap < R.minGap) return false;  // demasiado juntas a alturas similares
    }
  }
  return true;
}

const signature = (p) => `${p.x}:${p.y}:${p.w}`;

/** Número de plataformas de `next` que no existían en `prev`. */
function changedCount(next, prev) {
  const old = new Set(prev.map(signature));
  return next.filter((p) => !old.has(signature(p))).length;
}

/** Nivel aproximado (1..4) de una plataforma según su altura sobre el suelo. */
const tierOf = (y) => Math.round((WORLD.groundY - y) / 46);

function occupiedCells(ps) {
  const cells = new Set();
  for (const p of ps) {
    const t = tierOf(p.y);
    for (let c = p.x / TILE; c < (p.x + p.w) / TILE; c++) cells.add(`${c}:${t}`);
  }
  return cells;
}

/** Similitud de Jaccard (0..1) entre las celdas columna×nivel que ocupan dos disposiciones. */
export function layoutSimilarity(a, b) {
  const A = occupiedCells(a);
  const B = occupiedCells(b);
  let inter = 0;
  for (const c of A) if (B.has(c)) inter++;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

/**
 * ¿`next` es realmente distinta de `prev`? Motivo distinto, ≥ 60 % de plataformas nuevas
 * y poca superposición de celdas ocupadas.
 * @param {{motif:string|null, platforms:object[]}} next
 * @param {{motif:string|null, platforms:object[]} | null} prev
 */
export function isDistinct(next, prev) {
  const R = LAYOUT_RULES;
  if (!prev || !prev.platforms?.length) return true;
  if (prev.motif && next.motif === prev.motif) return false;
  if (changedCount(next.platforms, prev.platforms) < Math.ceil(R.minChanged * next.platforms.length)) return false;
  return layoutSimilarity(next.platforms, prev.platforms) <= R.maxSimilarity;
}

/* ---------------- generador por motivos ---------------- */

/** PRNG determinista (para los respaldos reproducibles). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rInt = (r, a, b) => a + Math.floor(r() * (b - a + 1));
const rPick = (r, arr) => arr[Math.floor(r() * arr.length)];

/** Pieza en unidades de rejilla: columna, ancho en tiles, nivel (1..4) y tipo opcional. */
const P = (c, wt, t, kind) => ({ c, wt, t, kind });

/**
 * Constructores de composiciones (orientadas "de izquierda a derecha"; luego se espejan al azar).
 * Devuelven piezas en rejilla o null si la combinación aleatoria no cabe.
 */
const BUILDERS = {
  /** Escalera progresiva desde un lado + contrapeso (con mirador opcional) en el otro. */
  stairs(r) {
    const n = rInt(r, 3, 4);
    const wt = rInt(r, 3, 4);
    const out = [];
    let c = rInt(r, 1, 2);
    for (let i = 0; i < n; i++) {
      out.push(P(c, wt, i + 1, PlatformKind.STEP));
      c += wt - rInt(r, 1, 2); // solape de 1-2 tiles con el escalón anterior
    }
    const cw = rInt(r, 3, 4);
    const cc = MAX_END - cw - rInt(r, 0, 1);
    out.push(P(cc, cw, 1));
    if (r() < 0.6) out.push(P(cc - rInt(r, 1, 2), 3, 2));
    return out;
  },

  /** Pasarela larga sobre dos pilonos, con mirador central y remate opcional. */
  bridge(r) {
    const wt = rInt(r, 7, 10);
    const bc = rInt(r, 3, MAX_END - 2 - wt);
    const lp = bc - rInt(r, 1, 2);
    const rp = bc + wt - 3 + rInt(r, 1, 2);
    const out = [P(lp, 3, 1), P(bc, wt, 2, PlatformKind.CATWALK), P(rp, 3, 1)];
    const lw = rInt(r, 3, 4);
    const lc = bc + rInt(r, 1, Math.max(1, wt - lw - 1));
    out.push(P(lc, lw, 3));
    if (r() < 0.4) out.push(P(lc + rInt(r, -1, 1), 3, 4));
    if (lp >= 6 && r() < 0.6) out.push(P(1, 3, 1));
    if (rp + 3 <= MAX_END - 5 && r() < 0.6) out.push(P(MAX_END - 3, 3, 1));
    return out;
  },

  /** Zigurat simétrico (a veces se rompe la simetría quitando una base). */
  ziggurat(r) {
    const b = rInt(r, 3, 4);
    const l = rInt(r, 2, 4);
    const rc = COLS - l - b;
    const cc = l + b - 1;
    const cw = rc + 1 - cc; // 4..10, siempre par → centrado exacto
    const out = [P(l, b, 1), P(rc, b, 1), P(cc, cw, 2)];
    const tw = Math.min(cw, rPick(r, [4, 6]));
    out.push(P((COLS - tw) / 2, tw, 3));
    const asym = r() < 0.35;
    if (asym) out.splice(rInt(r, 0, 1), 1);
    if (asym || r() < 0.5) out.push(P(rInt(r, 7, 8), 3, 4));
    return out;
  },

  /** Bifurcación: tronco central y dos ramas hacia fuera; hojas en tier 3. */
  fork(r) {
    const t = rInt(r, 5, 6);
    const tc = Math.floor((COLS - t) / 2) + rInt(r, -1, 1);
    const lw = rInt(r, 3, 5);
    const rw = rInt(r, 3, 5);
    const lc = tc + 1 - lw;
    const rc = tc + t - 1;
    const out = [P(tc, t, 1), P(lc, lw, 2), P(rc, rw, 2)];
    const leaf = (bc, bw) => P(Math.max(1, Math.min(MAX_END - 3, bc + rInt(r, -1, bw - 2))), 3, 3);
    const leftFirst = r() < 0.5;
    out.push(leftFirst ? leaf(lc, lw) : leaf(rc, rw));
    if (r() < 0.45) out.push(leftFirst ? leaf(rc, rw) : leaf(lc, lw));
    if (tc >= 6 && r() < 0.5) out.push(P(1, 3, 1));
    if (tc + t <= MAX_END - 5 && r() < 0.5) out.push(P(MAX_END - 3, 3, 1));
    return out;
  },

  /** Dos torres en zigzag de alturas distintas + pasarela baja central. */
  towers(r) {
    const nL = rInt(r, 2, 3);
    const nR = r() < 0.7 ? 5 - nL : nL;
    const offs = [0, 2, 1]; // zigzag hacia dentro: el nivel 3 nunca toca la banda de entrada
    const kL = nL === 3 ? 2 : rInt(r, 1, 2);
    const kR = nR === 3 ? 2 : rInt(r, 1, 2);
    const out = [];
    for (let i = 0; i < nL; i++) out.push(P(kL + offs[i], 3, i + 1));
    const cR = COLS - 3 - kR;
    for (let i = 0; i < nR; i++) out.push(P(cR - offs[i], 3, i + 1));
    const from = kL + 5;
    const avail = cR - 2 - from;
    if (avail < 4) return null;
    const w = rInt(r, 4, Math.min(6, avail));
    const c = from + rInt(r, 0, avail - w);
    out.push(P(c, w, 1));
    if (w >= 5 && r() < 0.5) out.push(P(c + Math.floor((w - 3) / 2), 3, 2));
    return out;
  },

  /** Niveles escalonados: pasarela compuesta abajo y tramos "a tresbolillo" sobre los huecos. */
  terraces(r) {
    const k = rInt(r, 2, 3);
    const widths = Array.from({ length: k }, (_, i) => (k === 3 && i === 1 ? rInt(r, 4, 5) : rInt(r, 3, 4)));
    const gaps = Array.from({ length: k - 1 }, () => rInt(r, 2, 3));
    const total = widths.reduce((a, b) => a + b, 0) + gaps.reduce((a, b) => a + b, 0);
    if (total > MAX_END - 1) return null;
    const out = [];
    const ends = [];
    const starts = [];
    let c = 1 + rInt(r, 0, MAX_END - 1 - total);
    for (let i = 0; i < k; i++) {
      out.push(P(c, widths[i], 1));
      starts.push(c);
      ends.push(c + widths[i]);
      c += widths[i] + (gaps[i] ?? 0);
    }
    const upper = [];
    for (let i = 0; i < k - 1; i++) {
      const piece = P(ends[i] - 1, gaps[i] + 2, 2);
      upper.push(piece);
      out.push(piece);
    }
    if (upper.length === 2) {
      if (r() < 0.7) out.push(P(upper[0].c + upper[0].wt - 1, upper[1].c + 1 - (upper[0].c + upper[0].wt - 1), 3));
    } else {
      out.push(P(upper[0].c + rInt(r, -1, 1), 3, 3));
    }
    return out;
  },
};

/** Convierte piezas de rejilla en plataformas (alturas de nivel aleatorias por disposición). */
function realize(spec, r, mirror) {
  const Y = [WORLD.groundY];
  for (let t = 1; t <= 4; t++) Y.push(Y[t - 1] - rPick(r, STEPS));
  return spec.map(({ c, wt, t, kind }) => {
    const col = mirror ? COLS - c - wt : c;
    return { x: col * TILE, y: Y[t], w: wt * TILE, kind: kind ?? kindFor(wt * TILE) };
  });
}

function buildMotif(motif, r) {
  const spec = BUILDERS[motif](r);
  if (!spec) return null;
  const platforms = realize(spec, r, r() < 0.5);
  return validateLayout(platforms) ? { motif, platforms } : null;
}

/** Respaldos reproducibles: dos disposiciones válidas por motivo (semillas fijas). */
const FALLBACK_LAYOUTS = Object.freeze(MOTIFS.flatMap((motif, i) => {
  const out = [];
  for (let seed = 1; seed < 2000 && out.length < 2; seed++) {
    const layout = buildMotif(motif, mulberry32(seed * 7919 + i * 104729));
    if (layout) out.push(Object.freeze(layout));
  }
  return out;
}));

const GEN_ATTEMPTS = 80;

/**
 * Genera una disposición nueva, válida y distinta de `prev` (motivo distinto, ≥ 60 % de piezas nuevas).
 * @param {{motif:string|null, platforms:{x:number,y:number,w:number}[]} | null} prev
 * @param {() => number} [rng]
 * @returns {{motif:string, platforms:{x:number,y:number,w:number,kind:string}[]}}
 */
export function generateLayout(prev = null, rng = Math.random) {
  const candidates = MOTIFS.filter((m) => m !== prev?.motif);
  for (let i = 0; i < GEN_ATTEMPTS; i++) {
    const layout = buildMotif(rPick(rng, candidates), rng);
    if (layout && isDistinct(layout, prev)) return layout;
  }
  let pool = FALLBACK_LAYOUTS.filter((l) => isDistinct(l, prev));
  if (!pool.length) pool = FALLBACK_LAYOUTS.filter((l) => l.motif !== prev?.motif);
  const pick = rPick(rng, pool.length ? pool : FALLBACK_LAYOUTS);
  return { motif: pick.motif, platforms: pick.platforms.map((p) => ({ ...p })) };
}

/** Compatibilidad: solo las plataformas, distintas de `prev` (se asume el motivo actual de la arena). */
export function generatePlatforms(prev = null) {
  return generateLayout(prev ? { motif: arena.motif, platforms: prev } : null).platforms;
}

/**
 * Autocomprobación (ejecutable desde la consola o Node): genera `n` disposiciones encadenadas y
 * verifica validez, distinción consecutiva, cobertura de motivos y respaldos.
 */
export function selfTestLayouts(n = 500) {
  const failures = [];
  const counts = Object.fromEntries(MOTIFS.map((m) => [m, 0]));
  let prev = null;
  let maxSimilarity = 0;
  let maxCount = 0;
  let minCount = Infinity;
  for (let i = 0; i < n; i++) {
    const l = generateLayout(prev);
    if (!validateLayout(l.platforms)) failures.push({ i, reason: 'inválida', layout: l });
    if (prev) {
      if (!isDistinct(l, prev)) failures.push({ i, reason: 'similar a la anterior', layout: l });
      maxSimilarity = Math.max(maxSimilarity, layoutSimilarity(l.platforms, prev.platforms));
    }
    counts[l.motif] += 1;
    maxCount = Math.max(maxCount, l.platforms.length);
    minCount = Math.min(minCount, l.platforms.length);
    prev = l;
  }
  for (const l of FALLBACK_LAYOUTS) {
    if (!validateLayout(l.platforms)) failures.push({ reason: 'respaldo inválido', layout: l });
  }
  const missing = MOTIFS.filter((m) => !counts[m]);
  const missingFallback = MOTIFS.filter((m) => !FALLBACK_LAYOUTS.some((l) => l.motif === m));
  return {
    ok: !failures.length && !missing.length && !missingFallback.length,
    runs: n,
    counts,
    platformsPerLayout: [minCount, maxCount],
    maxSimilarity: Number(maxSimilarity.toFixed(2)),
    fallbacks: FALLBACK_LAYOUTS.length,
    missing,
    missingFallback,
    failures: failures.slice(0, 10),
  };
}

/**
 * Integra la caída y resuelve el aterrizaje sobre suelo y plataformas one-way.
 * Solo se aterriza en una plataforma si se está cayendo y los pies venían por encima de ella.
 * @param {{x:number,y:number,vy:number,onGround:boolean,surface:number|null,dropTimer:number}} e
 * @param {number} prevY pies antes de integrar
 * @param {number} footHalf semiancho de los pies
 */
export function resolveLanding(e, prevY, footHalf) {
  e.onGround = false;
  e.surface = null;

  if (e.y >= WORLD.groundY) {
    e.y = WORLD.groundY;
    e.vy = 0;
    e.onGround = true;
    e.surface = GROUND;
    return;
  }
  if (e.vy < 0 || e.dropTimer > 0) return;

  const platforms = arena.platforms;
  for (let i = 0; i < platforms.length; i++) {
    const p = platforms[i];
    if (e.x + footHalf <= p.x || e.x - footHalf >= p.x + p.w) continue;
    if (prevY <= p.y + 0.01 && e.y >= p.y) {
      e.y = p.y;
      e.vy = 0;
      e.onGround = true;
      e.surface = i;
      return;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Poderes temporales                                                  */
/* ------------------------------------------------------------------ */

export const POWER_DURATION = 5; // s (máximo)

export const PowerType = Object.freeze({
  RAPID: 'RAPID',
  PIERCE: 'PIERCE',
  OVERDRIVE: 'OVERDRIVE',
});

export const POWERS = Object.freeze({
  [PowerType.RAPID]: Object.freeze({ label: 'RÁFAGA', color: '#fff36b' }),
  [PowerType.PIERCE]: Object.freeze({ label: 'PERFORANTE', color: '#38d4ff' }),
  [PowerType.OVERDRIVE]: Object.freeze({ label: 'SOBRECARGA', color: '#ff3bd4' }),
});

/* ------------------------------------------------------------------ */
/* Personajes jugables                                                 */
/* ------------------------------------------------------------------ */

export const CharacterType = Object.freeze({ SHOOTER: 'SHOOTER', KNIGHT: 'KNIGHT' });

export const CHARACTERS = Object.freeze({
  [CharacterType.SHOOTER]: Object.freeze({
    label: 'TIRADOR',
    lines: ['Disparo a distancia', 'Apunta con el ratón'],
    attack: 'CLIC / J  DISPARAR',
    color: '#7fd4ff',
    maxHp: 5,
  }),
  [CharacterType.KNIGHT]: Object.freeze({
    label: 'CABALLERO',
    lines: ['Tajo de espada frontal', 'Empuja a los cercanos'],
    attack: 'CLIC / J  TAJO',
    color: '#ffb347',
    maxHp: 6,
  }),
});

/** Espada del caballero: tajo corto frontal con ventana activa breve. */
export const SWORD = Object.freeze({
  cooldown: 0.3,
  rapidCooldown: 0.16,  // con RÁFAGA
  active: 0.14,         // s en los que el tajo golpea
  pose: 0.32,           // s que dura la animación/efecto del tajo
  reach: 38,
  pierceReach: 50,      // con PERFORANTE
  height: 36,
  damage: 1,
  knock: 2.6,
});

/* ------------------------------------------------------------------ */
/* Jugador                                                            */
/* ------------------------------------------------------------------ */

const PLAYER = Object.freeze({
  speed: 140,
  jumpVelocity: -330,
  maxHp: 5,
  fireInterval: 0.16,
  rapidInterval: 0.06,
  shootPoseTime: 0.25,     // tiempo que mantiene la pose de disparo
  invulnerableTime: 1.0,
  knockback: 160,
  dropTime: 0.15,          // tiempo ignorando plataformas al bajar
  hitbox: { w: 14, h: 28 },
  footHalf: 5,
  muzzle: { x: 19, y: -21 }, // relativo a los pies, mirando a la derecha (medido en el PNG)
  aimDeadzone: 2,
});

export class Player {
  constructor(character = CharacterType.SHOOTER) {
    this.reset(character);
  }

  reset(character = this.character ?? CharacterType.SHOOTER) {
    this.character = CHARACTERS[character] ? character : CharacterType.SHOOTER;
    this.x = WORLD.width / 2;
    this.y = WORLD.groundY;
    this.vx = 0;
    this.vy = 0;
    this.facing = Facing.RIGHT;
    this.maxHp = CHARACTERS[this.character].maxHp;
    this.hp = this.maxHp;
    this.onGround = true;
    this.surface = GROUND;
    this.dropTimer = 0;
    this.prevDown = false;
    this.fireCooldown = 0;
    this.shootPose = 0;
    this.invulnerable = 0;
    this.dead = false;
    /** @type {{type:string, remaining:number} | null} */
    this.power = null;
    /** Tajo en curso del caballero (o null). */
    this.slash = null;
    /** OVNI que pilota (o null): mientras tanto no hay gravedad ni colisión con el suelo. */
    this.mount = null;
    this.anim = 'idle';
    this.animTime = 0;
  }

  get isKnight() {
    return this.character === CharacterType.KNIGHT;
  }

  /** ¿El tajo está en su ventana activa (golpea)? */
  get slashActive() {
    return this.slash !== null && this.slash.age < SWORD.active;
  }

  /** AABB frontal del tajo: delante del caballero, desplazada en vertical según el ángulo. */
  slashHitbox() {
    const s = this.slash;
    if (!s) return null;
    const reach = s.reach;
    const cy = this.y + PLAYER.muzzle.y + Math.sin(s.angle) * 12;
    const x = s.dir > 0 ? this.x - 4 : this.x - reach + 4;
    return { x, y: cy - SWORD.height / 2, w: reach, h: SWORD.height };
  }

  get onPlatform() {
    return this.onGround && platformAt(this.surface) !== null;
  }

  /** Semiancho de los pies (lo usa `reanchorSurfaces` al rotar plataformas). */
  get footHalf() {
    return PLAYER.footHalf;
  }

  /** Otorga (o sustituye) el poder activo, siempre con la duración máxima. */
  givePower(type) {
    this.power = { type, remaining: POWER_DURATION };
  }

  hasPower(type) {
    return this.power !== null && this.power.type === type;
  }

  /** Hombro: origen del vector de apuntado. */
  get shoulder() {
    return { x: this.x, y: this.y + PLAYER.muzzle.y };
  }

  /**
   * @param {number} dt
   * @param {{left:boolean,right:boolean,jump:boolean,down:boolean,fire:boolean,
   *          aim?:{x:number,y:number,active:boolean}}} input
   * @param {(b:Bullet)=>void} spawnBullet
   */
  update(dt, input, spawnBullet) {
    this.invulnerable = Math.max(0, this.invulnerable - dt);
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    this.shootPose = Math.max(0, this.shootPose - dt);
    this.dropTimer = Math.max(0, this.dropTimer - dt);
    if (this.power) {
      this.power.remaining -= dt;
      if (this.power.remaining <= 0) this.power = null;
    }
    if (this.slash) {
      this.slash.age += dt;
      if (this.slash.age >= SWORD.pose) this.slash = null;
    }

    // A bordo del OVNI: la posición la dicta el platillo (se actualiza antes que el jugador).
    if (this.mount) {
      this.prevDown = input.down;
      this.x = this.mount.x;
      this.y = this.mount.seatY;
      this.vx = 0;
      this.vy = 0;
      this.onGround = false;
      this.surface = null;
      this.slash = null;
      this.shootPose = 0;
      this.#setAnim('idle', dt);
      return;
    }

    const downEdge = input.down && !this.prevDown;
    this.prevDown = input.down;

    if (this.dead) {
      this.vx *= 0.9;
      this.#integrate(dt);
      this.#setAnim('death', dt);
      return;
    }

    const aim = input.aim?.active ? input.aim : null;
    const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    if (aim) {
      // Con ratón, el sprite mira hacia la mirilla (se puede retroceder disparando).
      const dx = aim.x - this.x;
      if (Math.abs(dx) > PLAYER.aimDeadzone) this.facing = Math.sign(dx);
    } else if (dir !== 0) {
      this.facing = dir;
    }

    // Durante el knockback (en el aire tras impacto) respetamos el impulso.
    if (this.onGround || dir !== 0) this.vx = dir * PLAYER.speed;

    // Bajar de plataforma: S/↓ (al pulsar) o ↓ + salto. Nunca desde el suelo.
    if (this.onPlatform && (downEdge || (input.down && input.jump))) {
      this.dropTimer = PLAYER.dropTime;
      this.onGround = false;
      this.vy = 30;
    } else if (input.jump && this.onGround && !(input.down && this.onPlatform)) {
      this.vy = PLAYER.jumpVelocity;
      this.onGround = false;
    }

    if (input.fire && this.fireCooldown === 0) {
      if (this.isKnight) {
        this.fireCooldown = this.hasPower(PowerType.RAPID) ? SWORD.rapidCooldown : SWORD.cooldown;
        this.shootPose = SWORD.pose;
        this.#startSlash(aim);
      } else {
        this.fireCooldown = this.hasPower(PowerType.RAPID) ? PLAYER.rapidInterval : PLAYER.fireInterval;
        this.shootPose = PLAYER.shootPoseTime;
        spawnBullet(this.#makeBullet(aim));
      }
    }

    this.#integrate(dt);

    let next = 'idle';
    if (this.shootPose > 0) next = this.isKnight ? 'attack' : 'shoot';
    else if (!this.onGround) next = this.isKnight ? 'jump' : 'walk';
    else if (dir !== 0) next = 'walk';
    this.#setAnim(next, dt);
  }

  /** Inicia un tajo hacia la mirilla (limitado al lado al que mira) o en horizontal. */
  #startSlash(aim) {
    const s = this.shoulder;
    let angle = this.facing > 0 ? 0 : Math.PI;
    if (aim) {
      const dx = aim.x - s.x;
      const dy = aim.y - s.y;
      if (Math.hypot(dx, dy) > 4) {
        // Solo se inclina hasta ±60° respecto a la horizontal del lado al que mira.
        const a = Math.atan2(dy, Math.abs(dx));
        const clamped = Math.max(-1.05, Math.min(1.05, a));
        angle = this.facing > 0 ? clamped : Math.PI - clamped;
      }
    }
    const over = this.hasPower(PowerType.OVERDRIVE);
    this.slash = {
      age: 0,
      dir: this.facing,
      angle,
      reach: this.hasPower(PowerType.PIERCE) ? SWORD.pierceReach : SWORD.reach,
      damage: over ? 2 : SWORD.damage,
      knock: over ? SWORD.knock * 1.5 : SWORD.knock,
      hit: new Set(),
    };
    this.animTime = 0;
    this.anim = 'attack';
  }

  #makeBullet(aim) {
    const s = this.shoulder;
    let ux = this.facing;
    let uy = 0;
    if (aim) {
      const dx = aim.x - s.x;
      const dy = aim.y - s.y;
      const len = Math.hypot(dx, dy);
      if (len > 4) {
        ux = dx / len;
        uy = dy / len;
      }
    }
    const reach = PLAYER.muzzle.x;
    const opts = {};
    if (this.hasPower(PowerType.PIERCE)) opts.pierce = 3;
    if (this.hasPower(PowerType.OVERDRIVE)) Object.assign(opts, { damage: 2, knock: 2.5, size: 3 });
    return new Bullet(s.x + ux * reach, s.y + uy * reach, ux, uy, opts);
  }

  #integrate(dt) {
    const prevY = this.y;
    this.vy += WORLD.gravity * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    const half = PLAYER.hitbox.w / 2;
    this.x = Math.max(half, Math.min(WORLD.width - half, this.x));
    resolveLanding(this, prevY, PLAYER.footHalf);
  }

  #setAnim(name, dt) {
    if (this.anim !== name) {
      this.anim = name;
      this.animTime = 0;
    } else {
      this.animTime += dt;
    }
  }

  /** @returns {boolean} true si el golpe se aplicó. */
  takeHit(fromX, damage = 1) {
    if (this.invulnerable > 0 || this.dead || this.mount) return false;
    this.hp -= damage;
    this.invulnerable = PLAYER.invulnerableTime;
    const away = Math.sign(this.x - fromX) || 1;
    this.vx = away * PLAYER.knockback;
    this.vy = -180;
    this.onGround = false;
    if (this.hp <= 0) {
      this.hp = 0;
      this.dead = true;
    }
    return true;
  }

  hitbox() {
    const { w, h } = PLAYER.hitbox;
    return { x: this.x - w / 2, y: this.y - h, w, h };
  }
}

/* ------------------------------------------------------------------ */
/* Proyectil (dirección libre)                                         */
/* ------------------------------------------------------------------ */

const BULLET = Object.freeze({ speed: 420, hit: 4 });

export class Bullet {
  /**
   * @param {number} x
   * @param {number} y
   * @param {number} ux componente x del vector unitario
   * @param {number} uy componente y del vector unitario
   * @param {{pierce?:number, damage?:number, knock?:number, size?:number}} [opts]
   */
  constructor(x, y, ux, uy, opts = {}) {
    this.x = x;
    this.y = y;
    this.ux = ux;
    this.uy = uy;
    this.vx = ux * BULLET.speed;
    this.vy = uy * BULLET.speed;
    this.dir = Math.sign(ux) || 1; // para retroceso y chispas
    this.pierce = opts.pierce ?? 0;
    this.damage = opts.damage ?? 1;
    this.knock = opts.knock ?? 1;
    this.size = opts.size ?? 2;
    this.hit = new Set();
    this.alive = true;
  }

  update(dt) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    const m = BULLET.hit;
    if (this.x < -m || this.x > WORLD.width + m || this.y < -m || this.y > WORLD.groundY) {
      this.alive = false;
    }
  }

  hitbox() {
    const s = Math.max(BULLET.hit, this.size + 2);
    return { x: this.x - s / 2, y: this.y - s / 2, w: s, h: s };
  }
}

/* ------------------------------------------------------------------ */
/* Poder recogible                                                     */
/* ------------------------------------------------------------------ */

const PICKUP = Object.freeze({ life: 7, blinkTime: 1.5, size: 12, footHalf: 4 });

export class Pickup {
  constructor(x, y, type, vy = 0) {
    this.x = Math.max(16, Math.min(WORLD.width - 16, x));
    this.y = y;
    this.vx = 0;
    this.vy = vy;
    this.type = type;
    this.age = 0;
    this.life = PICKUP.life;
    this.onGround = false;
    this.surface = null;
    this.dropTimer = 0;
    this.alive = true;
  }

  get footHalf() {
    return PICKUP.footHalf;
  }

  get blinking() {
    return this.life - this.age < PICKUP.blinkTime;
  }

  update(dt) {
    this.age += dt;
    if (this.age >= this.life) this.alive = false;
    const prevY = this.y;
    this.vy += WORLD.gravity * dt;
    this.y += this.vy * dt;
    resolveLanding(this, prevY, PICKUP.footHalf);
  }

  hitbox() {
    const s = PICKUP.size;
    return { x: this.x - s / 2, y: this.y - s, w: s, h: s };
  }
}

/* ------------------------------------------------------------------ */
/* Partícula (datos puros; el renderer las dibuja como píxeles)        */
/* ------------------------------------------------------------------ */

export class Particle {
  constructor(x, y, vx, vy, life, color, size = 1, gravity = 0) {
    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.life = life;
    this.age = 0;
    this.color = color;
    this.size = size;
    this.gravity = gravity;
  }

  get alive() {
    return this.age < this.life;
  }

  update(dt) {
    this.age += dt;
    this.vy += this.gravity * dt;
    this.vx *= 1 - Math.min(1, dt * 3);
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    if (this.y > WORLD.groundY) {
      this.y = WORLD.groundY;
      this.vy *= -0.3;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Hell Hound — FSM                                                    */
/*   RUN -> LEAP (embestida) | CLIMB (subir a plataforma)              */
/*   RUN -> WINDUP -> POUNCE (emboscada)                               */
/*   HURT, DEAD                                                        */
/* ------------------------------------------------------------------ */

export const HoundState = Object.freeze({
  RUN: 'RUN',
  LEAP: 'LEAP',
  CLIMB: 'CLIMB',
  WINDUP: 'WINDUP',
  POUNCE: 'POUNCE',
  HURT: 'HURT',
  DEAD: 'DEAD',
});

const HOUND = Object.freeze({
  hp: 2,
  leapRange: [100, 125],      // [agresividad 0, agresividad 1]
  leapCooldown: [0.75, 0.45],
  pounceCooldown: [1.8, 1.0],
  leapVelocity: -230,
  leapSpeedFactor: 1.6,
  climbReach: 64,          // desnivel máximo que puede trepar de un salto
  climbMaxVy: -380,
  climbCooldown: 0.3,
  pounceVy: -300,
  pounceMaxVx: 270,
  pounceMinDist: 70,
  pounceMaxDist: 230,
  windupTime: 0.2,         // aviso (agachada roja): no se acorta, es lo que lo hace justo
  dropTime: 0.15,
  hurtTime: 0.12,
  deathTime: 0.5,
  knockback: 90,
  hitFlash: 0.1,
  leadTime: [0.25, 0.5],   // anticipación de la persecución (s), por individuo
  sprintDist: 130,
  sprintFactor: 1.4,
  speedJitter: [0.95, 1.25],
  leapJitter: 0.15,        // ±15 % de alcance de embestida por individuo
  cooldownJitter: [0.7, 1.2], // factor aleatorio en cada enfriamiento de salto/emboscada
  hesitateChance: 0.05,    // probabilidad por segundo de pararse a "olfatear" (solo en RUN, nunca el perseguidor)
  hesitateTime: [0.08, 0.16],
  hesitateSprint: 0.45,    // s de sprint tras la duda
  flankOffset: [36, 56],
  stalkRange: [90, 130],   // distancia que mantiene el acechador antes de lanzarse
  stalkBurst: [0.35, 0.7], // duración de cada arrancada del acechador
  stalkRest: [0.12, 0.3],  // duración de cada pausa del acechador
  stalkCommit: [1.0, 1.8], // tras este tiempo acechando de cerca, carga de verdad
  hitbox: { w: 40, h: 24 },
  footHalf: 12,
});

/** Temperamentos: deciden CÓMO se acerca cada sabueso (no cuánto aguanta). */
export const Temperament = Object.freeze({ CHASER: 'chaser', FLANKER: 'flanker', STALKER: 'stalker' });

const jitter = ([a, b]) => a + Math.random() * (b - a);

/** Reparto de temperamentos según la agresividad (0..1): más flanqueos y acechos al subir. */
function rollTemperament(a) {
  const w = { chaser: 0.7 - 0.15 * a, flanker: 0.15 + 0.075 * a, stalker: 0.15 + 0.075 * a };
  let r = Math.random() * (w.chaser + w.flanker + w.stalker);
  if ((r -= w.chaser) < 0) return Temperament.CHASER;
  if ((r -= w.flanker) < 0) return Temperament.FLANKER;
  return Temperament.STALKER;
}

/** Distancia horizontal de `x` al tramo de la plataforma `p` (0 si está dentro). */
function distToSpan(x, p) {
  if (x < p.x) return p.x - x;
  if (x > p.x + p.w) return x - (p.x + p.w);
  return 0;
}

/**
 * Plataforma a la que debería trepar un sabueso con pies en `houndY` para acercarse
 * al jugador: la del propio jugador si está a su alcance; si no, el escalón alcanzable
 * más cercano a él.
 */
function climbTarget(houndY, player) {
  const own = platformAt(player.surface);
  if (own) {
    const dh = houndY - own.y;
    if (dh > 0 && dh <= HOUND.climbReach) return own;
  }
  let best = null;
  let bestD = Infinity;
  for (const p of arena.platforms) {
    const dh = houndY - p.y;
    if (dh <= 0 || dh > HOUND.climbReach) continue;
    const d = distToSpan(player.x, p);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

export class HellHound {
  /**
   * @param {number} x posición inicial (fuera de pantalla)
   * @param {{speed:number, aggression?:number}} cfg parámetros de la ronda
   */
  constructor(x, cfg) {
    const a = Math.max(0, Math.min(1, cfg.aggression ?? 0));
    this.aggression = a;
    this.temperament = cfg.temperament ?? rollTemperament(a);
    this.leapRange = lerp(HOUND.leapRange[0], HOUND.leapRange[1], a) * (1 + (Math.random() * 2 - 1) * HOUND.leapJitter);
    this.leapCooldownTime = lerp(HOUND.leapCooldown[0], HOUND.leapCooldown[1], a);
    this.pounceCooldownTime = lerp(HOUND.pounceCooldown[0], HOUND.pounceCooldown[1], a);
    this.leadTime = jitter(HOUND.leadTime);

    this.x = x;
    this.y = WORLD.groundY;
    this.vx = 0;
    this.vy = 0;
    this.speed = cfg.speed * jitter(HOUND.speedJitter);
    this.dir = x < WORLD.width / 2 ? 1 : -1;
    // El flanqueador rodea al jugador hasta el lado contrario al de su entrada.
    this.flanking = this.temperament === Temperament.FLANKER;
    this.flankSide = -this.dir;
    this.flankOffset = jitter(HOUND.flankOffset);
    this.stalkRange = jitter(HOUND.stalkRange);
    this.stalkClock = jitter(HOUND.stalkBurst); // > 0: arrancada; < 0: pausa (acechador)
    this.stalkTime = 0;         // tiempo acechando de cerca (luego se compromete)
    this.stalkCommit = jitter(HOUND.stalkCommit);
    this.hesitate = 0;          // s restantes de duda
    this.sprintBoost = 0;       // s restantes de sprint tras la duda
    this.hp = HOUND.hp;
    this.state = HoundState.RUN;
    this.stateTime = 0;
    this.leapCooldown = 0.4 + Math.random() * 0.5;
    this.climbCooldown = 0;
    this.pounceCooldown = 0.6 + Math.random() * 0.8;
    this.dropTimer = 0;
    this.hitFlash = 0;
    this.onGround = true;
    this.surface = GROUND;
    this.alive = true;
    this.anim = 'run';
    this.animTime = 0;
  }

  get canHurt() {
    return this.state !== HoundState.HURT && this.state !== HoundState.DEAD;
  }

  get isPouncing() {
    return this.state === HoundState.WINDUP || this.state === HoundState.POUNCE;
  }

  get onScreen() {
    return this.x > 0 && this.x < WORLD.width;
  }

  get footHalf() {
    return HOUND.footHalf;
  }

  update(dt, player) {
    this.stateTime += dt;
    if (this.state !== HoundState.WINDUP) this.animTime += dt;
    this.leapCooldown = Math.max(0, this.leapCooldown - dt);
    this.climbCooldown = Math.max(0, this.climbCooldown - dt);
    this.pounceCooldown = Math.max(0, this.pounceCooldown - dt);
    this.dropTimer = Math.max(0, this.dropTimer - dt);
    this.hitFlash = Math.max(0, this.hitFlash - dt);

    switch (this.state) {
      case HoundState.RUN:
        this.#run(player, dt);
        break;
      case HoundState.LEAP:
      case HoundState.CLIMB:
      case HoundState.POUNCE:
        if (this.onGround && this.stateTime > 0.1) {
          if (this.state === HoundState.LEAP) this.leapCooldown = this.leapCooldownTime * jitter(HOUND.cooldownJitter);
          if (this.state === HoundState.CLIMB) this.climbCooldown = HOUND.climbCooldown * jitter(HOUND.cooldownJitter);
          if (this.state === HoundState.POUNCE) this.leapCooldown = this.leapCooldownTime * jitter(HOUND.cooldownJitter);
          this.#enter(HoundState.RUN, 'run');
        }
        break;
      case HoundState.WINDUP:
        this.vx = 0;
        // Si la plataforma desapareció bajo sus pies (rotación), cancela la emboscada: nada de saltos en el aire.
        if (!this.onGround) this.#enter(HoundState.RUN, 'run');
        else if (this.stateTime >= HOUND.windupTime) this.#launchPounce(player);
        break;
      case HoundState.HURT:
        this.vx *= 0.85;
        if (this.stateTime >= HOUND.hurtTime) this.#enter(HoundState.RUN, 'run');
        break;
      case HoundState.DEAD:
        this.vx *= 0.9;
        if (this.stateTime >= HOUND.deathTime) this.alive = false;
        break;
    }

    const prevY = this.y;
    this.vy += WORLD.gravity * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    resolveLanding(this, prevY, HOUND.footHalf);
  }

  /** ¿Está todavía aproximándose sin atacar (flanqueo o acecho)? Mientras, no embiste. */
  get #maneuvering() {
    return this.flanking || (this.temperament === Temperament.STALKER && this.stalkTime < this.stalkCommit);
  }

  /**
   * Objetivo horizontal según el temperamento. Solo cambia la aproximación: en cuanto terminan
   * la maniobra todos cierran y embisten igual (no esquivan ni aguantan más golpes).
   * @returns {{x:number, hold:boolean}} hold = quedarse quieto este frame (pausa del acechador)
   */
  #approach(player, baseX, dt) {
    if (player.dead || !this.onScreen) return { x: baseX, hold: false };
    const dist = Math.abs(player.x - this.x);
    if (this.flanking) {
      const side = this.flankSide;
      const flankX = Math.max(16, Math.min(WORLD.width - 16, player.x + side * this.flankOffset));
      const onSide = Math.sign(this.x - player.x) === side;
      // Ya rodeó (o se topó con el jugador o la pared): a partir de ahora va directo.
      if ((onSide && Math.abs(this.x - flankX) < 24) || dist < 36 || flankX <= 16 || flankX >= WORLD.width - 16) {
        this.flanking = false;
        return { x: baseX, hold: false };
      }
      return { x: flankX, hold: false };
    }
    if (this.temperament === Temperament.STALKER && this.stalkTime < this.stalkCommit) {
      if (dist > this.stalkRange + 30) return { x: baseX, hold: false }; // se acerca normal
      this.stalkTime += dt;
      // A distancia de acecho: arrancadas cortas y pausas, sin pegarse al jugador.
      if (this.stalkClock > 0) {
        this.stalkClock -= dt;
        if (this.stalkClock <= 0) this.stalkClock = -jitter(HOUND.stalkRest);
        const away = Math.sign(this.x - player.x) || 1;
        return { x: player.x + away * (this.stalkRange - 25), hold: false };
      }
      this.stalkClock += dt;
      if (this.stalkClock >= 0) this.stalkClock = jitter(HOUND.stalkBurst);
      return { x: this.x, hold: true };
    }
    return { x: baseX, hold: false };
  }

  #run(player, dt) {
    // Duda breve: se para a "olfatear" y luego arranca con un sprint.
    if (this.hesitate > 0) {
      this.hesitate = Math.max(0, this.hesitate - dt);
      this.vx = 0;
      this.dir = Math.sign(player.x - this.x) || this.dir;
      this.#setAnim('idle');
      if (this.hesitate === 0) this.sprintBoost = HOUND.hesitateSprint;
      return;
    }
    this.sprintBoost = Math.max(0, this.sprintBoost - dt);
    if (
      this.temperament !== Temperament.CHASER &&
      this.onGround && this.onScreen && !player.dead &&
      Math.abs(player.x - this.x) > 60 && Math.random() < HOUND.hesitateChance * dt
    ) {
      this.hesitate = jitter(HOUND.hesitateTime);
      return;
    }

    // Persecución con anticipación: apunta a donde estará el jugador.
    const lead = player.dead ? 0 : player.vx * this.leadTime * (0.5 + this.aggression);
    let goalX = Math.max(0, Math.min(WORLD.width, player.x + lead));
    const dy = player.y - this.y;
    let climb = null;
    let hold = false;
    if (Math.abs(dy) < 24) {
      const ap = this.#approach(player, goalX, dt);
      goalX = ap.x;
      hold = ap.hold;
    }

    if (!player.dead && player.onGround && dy < -20 && this.onGround) {
      // El jugador está por encima: buscar plataforma y colocarse bajo su tramo.
      const target = climbTarget(this.y, player);
      if (target) {
        const lo = target.x + 4;
        const hi = target.x + target.w - 4;
        if (this.x >= lo && this.x <= hi) {
          if (this.climbCooldown === 0) climb = target;
          goalX = Math.max(lo, Math.min(hi, player.x));
        } else {
          // Apuntamos un poco dentro del tramo: la tolerancia de llegada no debe dejarlo fuera.
          goalX = this.x < lo ? lo + 6 : hi - 6;
        }
        // Si ya está sobre una plataforma, no se despeña buscando el siguiente escalón.
        const own = platformAt(this.surface);
        if (own) goalX = Math.max(own.x - 6, Math.min(own.x + own.w + 6, goalX));
      }
    } else if (dy > 20 && platformAt(this.surface) && Math.abs(player.x - this.x) < 28) {
      // El jugador está justo debajo: atravesar la plataforma.
      this.dropTimer = HOUND.dropTime;
    }

    const dx = goalX - this.x;
    if (Math.abs(dx) > 3 && !hold) {
      this.dir = Math.sign(dx);
      const sprint = Math.abs(dx) > HOUND.sprintDist || this.sprintBoost > 0 ? HOUND.sprintFactor : 1;
      this.vx = this.dir * this.speed * sprint;
      this.#setAnim('run');
    } else {
      this.vx = 0;
      this.dir = Math.sign(player.x - this.x) || this.dir;
      this.#setAnim('idle');
    }

    if (climb) {
      const dh = this.y - climb.y;
      const vy = Math.max(HOUND.climbMaxVy, -Math.sqrt(2 * WORLD.gravity * (dh + 14)));
      // Aterrizaje apuntado dentro del tramo (lo más cerca posible del jugador).
      const landX = Math.max(climb.x + 24, Math.min(climb.x + climb.w - 24, player.x));
      const disc = vy * vy - 2 * WORLD.gravity * dh;
      const flight = disc > 0 ? (-vy + Math.sqrt(disc)) / WORLD.gravity : 0.5;
      const vx = (landX - this.x) / flight;
      this.vy = vy;
      this.vx = Math.max(-this.speed, Math.min(this.speed, vx));
      this.dir = Math.sign(this.vx) || Math.sign(player.x - this.x) || this.dir;
      this.onGround = false;
      this.#enter(HoundState.CLIMB, 'jump', true);
      return;
    }

    if (
      !player.dead &&
      Math.abs(player.x - this.x) < this.leapRange &&
      Math.abs(dy) < 24 &&
      this.leapCooldown === 0 &&
      !this.#maneuvering
    ) {
      this.dir = Math.sign(player.x + lead * 0.5 - this.x) || this.dir;
      this.vy = HOUND.leapVelocity;
      this.vx = this.dir * this.speed * HOUND.leapSpeedFactor;
      this.onGround = false;
      this.#enter(HoundState.LEAP, 'jump', true);
    }
  }

  /** ¿Puede emboscar al jugador ahora? */
  canPounce(player) {
    if (this.state !== HoundState.RUN || !this.onGround || this.pounceCooldown > 0) return false;
    if (player.dead || !this.onScreen) return false;
    const dist = Math.abs(player.x - this.x);
    const dy = player.y - this.y;
    return dist >= HOUND.pounceMinDist && dist <= HOUND.pounceMaxDist && dy >= -52 && dy <= 60;
  }

  /** Inicia la emboscada: breve agachada (aviso) y luego salto balístico hacia el jugador. */
  pounce(player) {
    this.dir = Math.sign(player.x - this.x) || this.dir;
    this.vx = 0;
    this.pounceCooldown = this.pounceCooldownTime * jitter(HOUND.cooldownJitter);
    this.hesitate = 0;
    // Una emboscada termina cualquier maniobra: a partir de aquí ataca directo.
    this.flanking = false;
    this.stalkTime = this.stalkCommit;
    this.#enter(HoundState.WINDUP, 'jump', true);
  }

  #launchPounce(player) {
    const vy = HOUND.pounceVy;
    const dy = player.y - this.y;
    const disc = vy * vy + 2 * WORLD.gravity * dy;
    const t = disc > 0 ? (-vy + Math.sqrt(disc)) / WORLD.gravity : (-2 * vy) / WORLD.gravity;
    // Anticipa a medias el movimiento del jugador (esquivable, pero castiga quedarse quieto).
    const targetX = player.x + player.vx * t * 0.5;
    const vx = (targetX - this.x) / Math.max(0.2, t);
    this.vx = Math.max(-HOUND.pounceMaxVx, Math.min(HOUND.pounceMaxVx, vx));
    this.vy = vy;
    this.dir = Math.sign(this.vx) || this.dir;
    this.onGround = false;
    this.#enter(HoundState.POUNCE, 'jump', true);
  }

  #enter(state, anim, restartAnim = false) {
    this.state = state;
    this.stateTime = 0;
    if (anim) this.#setAnim(anim, restartAnim);
  }

  #setAnim(anim, restart = false) {
    if (anim !== this.anim || restart) {
      this.anim = anim;
      this.animTime = 0;
    }
  }

  /** @returns {boolean} true si murió con este impacto. */
  takeHit(bulletDir, damage = 1, knockMul = 1) {
    if (this.state === HoundState.DEAD) return false;
    this.hp -= damage;
    this.hitFlash = HOUND.hitFlash;
    this.vx = bulletDir * HOUND.knockback * knockMul;
    if (this.onGround) this.vy = -60 * Math.min(2, knockMul);
    if (this.hp <= 0) {
      this.#enter(HoundState.DEAD, 'idle');
      return true;
    }
    this.#enter(HoundState.HURT, null);
    return false;
  }

  /** Muerte inmediata (fin de ronda). */
  kill() {
    if (this.state === HoundState.DEAD) return;
    this.hp = 0;
    this.hitFlash = HOUND.hitFlash;
    this.#enter(HoundState.DEAD, 'idle');
  }

  hitbox() {
    const { w, h } = HOUND.hitbox;
    return { x: this.x - w / 2, y: this.y - h, w, h };
  }
}

export function overlaps(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** ¿El segmento (x0,y0)-(x1,y1) cruza la caja `b`? (Liang–Barsky) */
export function segmentVsBox(x0, y0, x1, y1, b) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let t0 = 0;
  let t1 = 1;
  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return (
    clip(-dx, x0 - b.x) && clip(dx, b.x + b.w - x0) &&
    clip(-dy, y0 - b.y) && clip(dy, b.y + b.h - y0)
  );
}

/* ------------------------------------------------------------------ */
/* Boss final: Coloso Alfa                                             */
/*   INTRO -> IDLE -> {CHARGE | SLAM | VOLLEY}_WINDUP -> ataque         */
/*   -> RECOVER -> IDLE ...   (ROAR al bajar del 50 %), DEAD            */
/*   IDLE -> LEAP_WINDUP -> LEAP si el jugador acampa en plataformas   */
/* ------------------------------------------------------------------ */

export const BossState = Object.freeze({
  INTRO: 'INTRO',
  IDLE: 'IDLE',
  CHARGE_WINDUP: 'CHARGE_WINDUP',
  CHARGE: 'CHARGE',
  SLAM_WINDUP: 'SLAM_WINDUP',
  SLAM: 'SLAM',
  VOLLEY_WINDUP: 'VOLLEY_WINDUP',
  VOLLEY: 'VOLLEY',
  LEAP_WINDUP: 'LEAP_WINDUP', // castigo a quien se queda en plataformas: salto directo a su altura
  LEAP: 'LEAP',
  RECOVER: 'RECOVER',
  ROAR: 'ROAR',
  DEAD: 'DEAD',
});

export const BOSS_NAME = 'COLOSO ALFA';

const BOSS = Object.freeze({
  hpBase: 48,
  hpPerRound: 6,
  hitbox: { w: 60, h: 44 },
  walkSpeed: 46,
  keepDistance: 110,
  chargeSpeed: 270,
  introTime: 1.6,
  windup: { CHARGE: 0.75, SLAM: 0.85, VOLLEY: 0.65, LEAP: 1.0 },
  // Salto contra quien "acampa" en plataformas elevadas.
  perchLimit: 3.5,       // s seguidos en plataformas antes de que el jefe salte a por el jugador
  perchLimitP2: 2.6,     // ídem en fase 2
  perchDecay: 2,         // el contador baja al doble de velocidad pisando el suelo
  leapLock: 0.7,         // fracción del aviso a partir de la cual el objetivo queda fijado
  leapApex: 56,          // px que sube por encima de la altura objetivo
  leapMaxVx: 420,
  leapDamage: 2,
  leapRecover: 1.2,      // ventana de castigo tras el salto (más larga que la normal)
  impact: { w: 72, h: 48, life: 0.15 },
  recover: 0.75,
  idleMin: 0.9,          // descanso mínimo antes de atacar (espera al siguiente beat)
  idleDrought: 1.6,      // si no llega un beat, ataca igualmente
  slamVy: -430,
  slamMaxVx: 230,
  waveSpeed: 175,
  shotSpeed: 150,
  shotGravity: 110,
  roarTime: 0.9,
  deathTime: 1.6,
  hitFlash: 0.08,
  recoverDamage: 1.5,    // daño extra mientras se recupera (ventana de castigo)
  phase2: { speed: 1.3, windup: 0.72 },
});

/** Onda de choque a ras de suelo (se esquiva saltando o subiendo a una plataforma). */
export class Shockwave {
  constructor(x, dir, speed) {
    this.x = x;
    this.y = WORLD.groundY;
    this.dir = dir;
    this.vx = dir * speed;
    this.age = 0;
    this.alive = true;
  }

  update(dt) {
    this.age += dt;
    this.x += this.vx * dt;
    if (this.x < -20 || this.x > WORLD.width + 20) this.alive = false;
  }

  hitbox() {
    return { x: this.x - 6, y: WORLD.groundY - 14, w: 12, h: 14 };
  }
}

/** Impacto del salto del jefe a la altura de una plataforma: zona breve de daño alto. */
export class LeapImpact {
  constructor(x, y, damage = BOSS.leapDamage) {
    this.x = Math.round(x);
    this.y = Math.round(y);
    this.damage = damage;
    this.age = 0;
    this.life = BOSS.impact.life;
    this.alive = true;
  }

  update(dt) {
    this.age += dt;
    if (this.age >= this.life) this.alive = false;
  }

  hitbox() {
    const { w, h } = BOSS.impact;
    return { x: this.x - w / 2, y: this.y - h, w, h: h + 4 };
  }
}

/** Superficie (y) bajo `x` a la altura `y` o por debajo: plataforma más alta o el suelo. */
function surfaceBelow(x, y) {
  let best = WORLD.groundY;
  for (const p of arena.platforms) {
    if (x < p.x || x > p.x + p.w || p.y < y - 0.01) continue;
    if (p.y < best) best = p.y;
  }
  return best;
}

/** Proyectil de fuego lento con gravedad leve. */
export class BossShot {
  constructor(x, y, vx, vy) {
    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.age = 0;
    this.alive = true;
  }

  update(dt) {
    this.age += dt;
    this.vy += BOSS.shotGravity * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    if (this.y >= WORLD.groundY || this.x < -20 || this.x > WORLD.width + 20 || this.y < -40) this.alive = false;
  }

  hitbox() {
    return { x: this.x - 3, y: this.y - 3, w: 6, h: 6 };
  }
}

export class Boss {
  /** @param {number} roundCount nº de rondas de la pista (escala la vida) */
  constructor(roundCount = 3) {
    this.maxHp = BOSS.hpBase + BOSS.hpPerRound * Math.max(0, roundCount - 1);
    this.hp = this.maxHp;
    this.dir = Math.random() < 0.5 ? 1 : -1;
    this.x = this.dir > 0 ? -50 : WORLD.width + 50;
    this.y = WORLD.groundY;
    this.vx = 0;
    this.vy = 0;
    this.onGround = true;
    this.state = BossState.INTRO;
    this.stateTime = 0;
    this.animTime = 0;
    this.hitFlash = 0;
    this.phase2 = false;
    this.enraged = false;   // true un frame al entrar en fase 2 (lo consume gameLoop)
    this.landed = false;    // idem al aterrizar o chocar con la pared (temblor)
    this.lastAttack = null;
    this.chargesLeft = 0;
    this.slamTargetX = this.x;
    this.perchTime = 0;      // s que el jugador lleva "acampado" en plataformas elevadas
    this.leapTargetX = this.x;
    this.leapTargetY = WORLD.groundY;
    this.leapImpacted = false;
    this.recoverExtra = 0;   // s extra de RECOVER (tras el salto)
    this.alive = true;
  }

  get perchLimit() {
    return this.phase2 ? BOSS.perchLimitP2 : BOSS.perchLimit;
  }

  /** 0..1: cuánto falta para que el jefe salte a por el jugador acampado. */
  get perchFrac() {
    return Math.min(1, this.perchTime / this.perchLimit);
  }

  /** ¿El objetivo del salto ya está fijado? (último tramo del aviso) */
  get leapLocked() {
    return this.state === BossState.LEAP
      || (this.state === BossState.LEAP_WINDUP && this.windupProgress >= BOSS.leapLock);
  }

  /** Mide la "acampada": sube en plataformas, se congela en el aire, baja en el suelo. */
  #trackPerch(dt, player) {
    if (this.state === BossState.INTRO || this.state === BossState.DEAD) return;
    if (this.state === BossState.LEAP_WINDUP || this.state === BossState.LEAP) return;
    if (player.dead || player.mount) {
      this.perchTime = Math.max(0, this.perchTime - dt * BOSS.perchDecay);
      return;
    }
    if (player.onPlatform) this.perchTime += dt;
    else if (player.onGround) this.perchTime = Math.max(0, this.perchTime - dt * BOSS.perchDecay);
  }

  /** Copia la posición del jugador como objetivo (x limitada; y = superficie bajo sus pies). */
  #aimLeap(player) {
    this.leapTargetX = Math.max(40, Math.min(WORLD.width - 40, player.x));
    this.leapTargetY = player.onGround ? player.y : surfaceBelow(player.x, player.y);
  }

  #launchLeap() {
    const g = WORLD.gravity;
    const apexY = this.leapTargetY - BOSS.leapApex;
    const h = Math.max(BOSS.leapApex, this.y - apexY);
    const vy = -Math.sqrt(2 * g * h);
    const flight = -vy / g + Math.sqrt((2 * BOSS.leapApex) / g);
    this.vy = vy;
    this.vx = Math.max(-BOSS.leapMaxVx, Math.min(BOSS.leapMaxVx, (this.leapTargetX - this.x) / flight));
    this.dir = Math.sign(this.vx) || this.dir;
    this.onGround = false;
    this.leapImpacted = false;
    this.#enter(BossState.LEAP);
  }

  get speedMul() {
    return this.phase2 ? BOSS.phase2.speed : 1;
  }

  get isWindup() {
    return this.state.endsWith('_WINDUP');
  }

  get canHurt() {
    // Durante el salto el daño lo aplica el impacto (LeapImpact), no el roce del cuerpo.
    return this.state !== BossState.DEAD && this.state !== BossState.INTRO && this.state !== BossState.LEAP;
  }

  get canBeHit() {
    return this.state !== BossState.DEAD && this.state !== BossState.INTRO;
  }

  /** ¿Puede entrar en ROAR ahora? (no interrumpe embestidas ni saltos en el aire) */
  get #canRoar() {
    return this.onGround && this.state !== BossState.CHARGE && this.state !== BossState.LEAP;
  }

  get hpFrac() {
    return Math.max(0, this.hp / this.maxHp);
  }

  /** Fracción 0..1 del aviso en curso (para telegrafiar), 0 si no hay aviso. */
  get windupProgress() {
    if (!this.isWindup) return 0;
    return Math.min(1, this.stateTime / this.#windupTime(this.state.replace('_WINDUP', '')));
  }

  #windupTime(kind) {
    return BOSS.windup[kind] * (this.phase2 ? BOSS.phase2.windup : 1);
  }

  #enter(state) {
    if (state !== BossState.RECOVER) this.recoverExtra = 0;
    this.state = state;
    this.stateTime = 0;
  }

  /**
   * @param {number} dt
   * @param {Player} player
   * @param {boolean} beat hay beat de graves este frame (los ataques arrancan a ritmo)
   * @param {(h: Shockwave|BossShot) => void} emit
   */
  update(dt, player, beat, emit) {
    this.stateTime += dt;
    this.animTime += dt;
    this.hitFlash = Math.max(0, this.hitFlash - dt);
    const towardPlayer = Math.sign(player.x - this.x) || this.dir;
    this.#trackPerch(dt, player);

    switch (this.state) {
      case BossState.INTRO: {
        const targetX = this.dir > 0 ? 90 : WORLD.width - 90;
        const arrived = (this.dir > 0 && this.x >= targetX) || (this.dir < 0 && this.x <= targetX);
        this.vx = arrived ? 0 : this.dir * 60;
        if (arrived && this.stateTime >= BOSS.introTime) this.#enter(BossState.IDLE);
        break;
      }
      case BossState.IDLE: {
        this.dir = towardPlayer;
        // Mantiene una distancia media: ni encima del jugador ni lejos.
        const dist = Math.abs(player.x - this.x);
        if (dist > BOSS.keepDistance + 20) this.vx = this.dir * BOSS.walkSpeed * this.speedMul;
        else if (dist < BOSS.keepDistance - 30) this.vx = -this.dir * BOSS.walkSpeed * 0.6 * this.speedMul;
        else this.vx = 0;
        const minRest = BOSS.idleMin * (this.phase2 ? 0.55 : 1);
        if (this.stateTime >= minRest && (beat || this.stateTime >= minRest + BOSS.idleDrought)) {
          if (this.perchTime >= this.perchLimit && !player.dead && !player.mount) {
            this.#aimLeap(player);
            this.#enter(BossState.LEAP_WINDUP);
          } else {
            this.#chooseAttack(player);
          }
        }
        break;
      }
      case BossState.LEAP_WINDUP:
        this.vx = 0;
        this.dir = towardPlayer;
        // Sigue al jugador hasta el último tramo del aviso; luego el objetivo queda fijado.
        if (!this.leapLocked && !player.dead && !player.mount) this.#aimLeap(player);
        if (this.stateTime >= this.#windupTime('LEAP')) this.#launchLeap();
        break;
      case BossState.LEAP:
        if (!this.leapImpacted && this.stateTime > 0.1 && (this.vy > 0 || this.onGround)
          && this.y >= this.leapTargetY - 0.01) {
          this.leapImpacted = true;
          this.landed = true;
          this.perchTime = 0;
          emit(new LeapImpact(this.x, this.leapTargetY));
        }
        if (this.onGround && this.stateTime > 0.1) {
          this.vx = 0;
          if (!this.leapImpacted) {
            this.leapImpacted = true;
            this.perchTime = 0;
            emit(new LeapImpact(this.x, WORLD.groundY));
          }
          this.landed = true;
          this.recoverExtra = BOSS.leapRecover - BOSS.recover;
          this.#enter(BossState.RECOVER);
        }
        break;
      case BossState.CHARGE_WINDUP:
        this.vx = 0;
        if (this.chargesLeft <= 1 || !this.phase2) this.dir = towardPlayer;
        if (this.stateTime >= this.#windupTime('CHARGE')) this.#enter(BossState.CHARGE);
        break;
      case BossState.CHARGE: {
        this.vx = this.dir * BOSS.chargeSpeed * this.speedMul;
        const half = BOSS.hitbox.w / 2;
        const hitWall = (this.dir > 0 && this.x >= WORLD.width - half - 4) || (this.dir < 0 && this.x <= half + 4);
        if (hitWall || this.stateTime > 2.6) {
          this.x = Math.max(half + 4, Math.min(WORLD.width - half - 4, this.x));
          this.vx = 0;
          this.landed = true; // choque contra la pared: temblor
          this.chargesLeft -= 1;
          if (this.chargesLeft > 0) {
            // Fase 2: segunda embestida de vuelta, con un aviso más corto.
            this.dir = -this.dir;
            this.state = BossState.CHARGE_WINDUP;
            this.stateTime = this.#windupTime('CHARGE') * 0.4;
          } else {
            this.#enter(BossState.RECOVER);
          }
        }
        break;
      }
      case BossState.SLAM_WINDUP:
        this.vx = 0;
        this.dir = towardPlayer;
        this.slamTargetX = Math.max(40, Math.min(WORLD.width - 40, player.x));
        if (this.stateTime >= this.#windupTime('SLAM')) {
          const flight = (2 * -BOSS.slamVy) / WORLD.gravity;
          this.vy = BOSS.slamVy;
          this.vx = Math.max(-BOSS.slamMaxVx, Math.min(BOSS.slamMaxVx, (this.slamTargetX - this.x) / flight));
          this.onGround = false;
          this.#enter(BossState.SLAM);
        }
        break;
      case BossState.SLAM:
        if (this.onGround && this.stateTime > 0.1) {
          this.vx = 0;
          this.landed = true;
          const speeds = this.phase2 ? [BOSS.waveSpeed * 1.2, BOSS.waveSpeed * 0.7] : [BOSS.waveSpeed];
          for (const s of speeds) {
            emit(new Shockwave(this.x - 20, -1, s));
            emit(new Shockwave(this.x + 20, 1, s));
          }
          this.#enter(BossState.RECOVER);
        }
        break;
      case BossState.VOLLEY_WINDUP:
        this.vx = 0;
        this.dir = towardPlayer;
        if (this.stateTime >= this.#windupTime('VOLLEY')) {
          this.#fireVolley(player, emit);
          this.#enter(BossState.VOLLEY);
        }
        break;
      case BossState.VOLLEY:
        this.vx = 0;
        if (this.stateTime >= 0.35) this.#enter(BossState.RECOVER);
        break;
      case BossState.RECOVER:
        this.vx *= 0.8;
        if (this.stateTime >= (BOSS.recover + this.recoverExtra) * (this.phase2 ? 0.7 : 1)) {
          this.recoverExtra = 0;
          this.#enter(BossState.IDLE);
        }
        break;
      case BossState.ROAR:
        this.vx = 0;
        if (this.stateTime >= BOSS.roarTime) this.#enter(BossState.IDLE);
        break;
      case BossState.DEAD:
        this.vx = 0;
        if (this.stateTime >= BOSS.deathTime) this.alive = false;
        break;
    }

    // Física propia: ignora las plataformas (siempre pisa el suelo).
    this.vy += WORLD.gravity * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    if (this.state !== BossState.INTRO) {
      const half = BOSS.hitbox.w / 2;
      this.x = Math.max(half, Math.min(WORLD.width - half, this.x));
    }
    if (this.y >= WORLD.groundY) {
      this.y = WORLD.groundY;
      this.vy = 0;
      this.onGround = true;
    } else {
      this.onGround = false;
    }
  }

  /** Elige ataque según la posición del jugador, evitando repetir el anterior. */
  #chooseAttack(player) {
    const dist = Math.abs(player.x - this.x);
    const high = WORLD.groundY - player.y > 40;
    const weights = {
      CHARGE: high ? 1 : dist > 160 ? 3 : 2,
      SLAM: high ? 1 : 2,
      VOLLEY: high ? 3 : 1.5,
    };
    if (this.lastAttack) weights[this.lastAttack] *= 0.25;
    const total = weights.CHARGE + weights.SLAM + weights.VOLLEY;
    let r = Math.random() * total;
    let kind = 'VOLLEY';
    for (const k of ['CHARGE', 'SLAM', 'VOLLEY']) {
      r -= weights[k];
      if (r <= 0) {
        kind = k;
        break;
      }
    }
    this.lastAttack = kind;
    if (kind === 'CHARGE') this.chargesLeft = this.phase2 ? 2 : 1;
    this.#enter(BossState[`${kind}_WINDUP`]);
  }

  /** Boca: origen de la volea. */
  get mouth() {
    return { x: this.x + this.dir * 34, y: this.y - 30 };
  }

  #fireVolley(player, emit) {
    const m = this.mouth;
    const n = this.phase2 ? 7 : 5;
    const base = Math.atan2(player.y - 16 - m.y, player.x - m.x);
    const spread = this.phase2 ? 0.95 : 0.7;
    for (let i = 0; i < n; i++) {
      const a = base + spread * (i / (n - 1) - 0.5);
      const s = BOSS.shotSpeed * this.speedMul * (0.9 + 0.2 * Math.random());
      emit(new BossShot(m.x, m.y, Math.cos(a) * s, Math.sin(a) * s - 40));
    }
  }

  /** @returns {boolean} true si murió con este impacto. */
  takeHit(dir, damage = 1) {
    if (!this.canBeHit) return false;
    const mul = this.state === BossState.RECOVER ? BOSS.recoverDamage : 1;
    this.hp -= damage * mul;
    this.hitFlash = BOSS.hitFlash;
    if (this.state !== BossState.CHARGE && this.onGround) this.x += dir * 1.5;
    if (this.hp <= 0) {
      this.hp = 0;
      this.vy = 0;
      this.#enter(BossState.DEAD);
      return true;
    }
    if (!this.phase2 && this.hp <= this.maxHp / 2) {
      this.phase2 = true;
      this.enraged = true;
      if (this.#canRoar) this.#enter(BossState.ROAR);
    }
    return false;
  }

  /**
   * Daño de área que nunca remata (explosión del OVNI): quita `frac` de la vida máxima
   * sin bajar de 1 hp. Puede disparar la fase 2.
   */
  blast(frac) {
    if (!this.canBeHit) return;
    this.hp = Math.max(Math.min(this.hp, 1), this.hp - this.maxHp * frac);
    this.hitFlash = BOSS.hitFlash * 3;
    if (!this.phase2 && this.hp <= this.maxHp / 2) {
      this.phase2 = true;
      this.enraged = true;
      if (this.#canRoar) this.#enter(BossState.ROAR);
    }
  }

  hitbox() {
    const { w, h } = BOSS.hitbox;
    const crouch = this.state === BossState.SLAM_WINDUP ? 6 : 0;
    return { x: this.x - w / 2, y: this.y - h + crouch, w, h: h - crouch };
  }
}

/* ------------------------------------------------------------------ */
/* OVNI pilotable (evento raro por racha)                              */
/*   ARRIVING -> WAITING -> PILOTED -> LEAVING                         */
/* ------------------------------------------------------------------ */

export const UfoState = Object.freeze({
  ARRIVING: 'ARRIVING',
  WAITING: 'WAITING',
  PILOTED: 'PILOTED',
  LEAVING: 'LEAVING',
  CRASHING: 'CRASHING', // fin del vuelo: cae sin control y explota al tocar el suelo
});

export const UFO = Object.freeze({
  hoverY: 214,         // altura de espera: alcanzable de un salto desde el suelo
  waitTime: 7,
  pilotTime: 6,
  speed: 175,
  laserTick: 0.1,
  laserDamage: 1,
  laserLength: 700,
  crashGravity: 520,
  crashVy: -60,
  crashBlast: 0.15,    // fracción de la vida máxima del jefe que quita la explosión
});

export class Ufo {
  constructor(x) {
    this.x = Math.max(70, Math.min(WORLD.width - 70, x));
    this.y = -24;
    this.targetY = UFO.hoverY;
    this.state = UfoState.ARRIVING;
    this.stateTime = 0;
    this.age = 0;
    this.pilotLeft = UFO.pilotTime;
    this.laser = null;      // {x0,y0,x1,y1,ux,uy} mientras dispara
    this.laserClock = 0;
    this.tickReady = false;
    this.leaveDir = Math.random() < 0.5 ? -1 : 1;
    this.vx = 0;           // velocidad del último frame pilotado (inercia de la caída)
    this.vy = 0;
    this.tilt = 0;         // -1, 0, 1: escora discreta durante la caída
    this.exploded = false; // true el frame en que choca contra el suelo (lo consume gameLoop)
    this.alive = true;
  }

  get crashing() {
    return this.state === UfoState.CRASHING;
  }

  /** Se acabó el vuelo: el platillo pierde el control y cae en picado. */
  crash() {
    this.laser = null;
    this.vx = this.vx * 0.5 + (Math.random() * 2 - 1) * 50;
    if (Math.abs(this.vx) < 30) this.vx = (Math.random() < 0.5 ? -1 : 1) * 40;
    this.vy = UFO.crashVy;
    this.#enter(UfoState.CRASHING);
  }

  get piloted() {
    return this.state === UfoState.PILOTED;
  }

  get boardable() {
    return this.state === UfoState.WAITING || (this.state === UfoState.ARRIVING && this.y > this.targetY - 30);
  }

  /** Pies del piloto (sentado en la cúpula). */
  get seatY() {
    return this.y + 2;
  }

  /** Zona de abordaje generosa (incluye algo por debajo del casco). */
  boardBox() {
    return { x: this.x - 24, y: this.y - 12, w: 48, h: 34 };
  }

  hitbox() {
    return { x: this.x - 22, y: this.y - 10, w: 44, h: 18 };
  }

  board() {
    this.#enter(UfoState.PILOTED);
    this.pilotLeft = UFO.pilotTime;
  }

  /** Fin del vuelo (o de la espera): se marcha sin piloto. */
  release() {
    this.laser = null;
    this.#enter(UfoState.LEAVING);
  }

  #enter(state) {
    this.state = state;
    this.stateTime = 0;
  }

  /** @param {number} dt  @param {object} input snapshot de entrada */
  update(dt, input) {
    this.age += dt;
    this.stateTime += dt;
    this.tickReady = false;
    switch (this.state) {
      case UfoState.ARRIVING:
        this.y += (this.targetY - this.y) * Math.min(1, dt * 3);
        if (Math.abs(this.y - this.targetY) < 1) this.#enter(UfoState.WAITING);
        break;
      case UfoState.WAITING:
        this.y = this.targetY + Math.sin(this.age * 3) * 3;
        if (this.stateTime >= UFO.waitTime) this.release();
        break;
      case UfoState.PILOTED: {
        this.pilotLeft = Math.max(0, this.pilotLeft - dt);
        const mx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
        const my = (input.down ? 1 : 0) - (input.up || input.jump ? 1 : 0);
        const len = Math.hypot(mx, my) || 1;
        const px = this.x;
        const py = this.y;
        this.x = Math.max(24, Math.min(WORLD.width - 24, this.x + (mx / len) * UFO.speed * dt));
        this.y = Math.max(44, Math.min(WORLD.groundY - 30, this.y + (my / len) * UFO.speed * dt));
        if (dt > 0) {
          this.vx = (this.x - px) / dt;
          this.vy = (this.y - py) / dt;
        }
        this.#updateLaser(dt, input);
        break;
      }
      case UfoState.CRASHING: {
        this.vy += UFO.crashGravity * dt;
        this.x += this.vx * dt;
        this.y += this.vy * dt;
        if (this.x < 24 || this.x > WORLD.width - 24) {
          this.x = Math.max(24, Math.min(WORLD.width - 24, this.x));
          this.vx = -this.vx * 0.5;
        }
        // Escora a tirones: se lee como "fuera de control" sin rotar el pixel art.
        this.tilt = Math.floor(this.stateTime * 9) % 3 - 1;
        if (this.y >= WORLD.groundY - 6) {
          this.y = WORLD.groundY - 6;
          this.exploded = true;
          this.alive = false;
        }
        break;
      }
      case UfoState.LEAVING:
        this.y -= 140 * dt;
        this.x += this.leaveDir * 90 * dt;
        if (this.y < -40) this.alive = false;
        break;
    }
  }

  #updateLaser(dt, input) {
    if (!input.fire) {
      this.laser = null;
      this.laserClock = 0;
      return;
    }
    const x0 = this.x;
    const y0 = this.y + 8;
    let ux = 0;
    let uy = 1;
    const aim = input.aim?.active ? input.aim : null;
    if (aim) {
      const dx = aim.x - x0;
      const dy = aim.y - y0;
      const l = Math.hypot(dx, dy);
      if (l > 4) {
        ux = dx / l;
        uy = dy / l;
      }
    }
    // Recorta el rayo contra el suelo y los bordes del mundo.
    let t = UFO.laserLength;
    if (uy > 0) t = Math.min(t, (WORLD.groundY - y0) / uy);
    if (ux > 0) t = Math.min(t, (WORLD.width - x0) / ux);
    if (ux < 0) t = Math.min(t, -x0 / ux);
    if (uy < 0) t = Math.min(t, -y0 / uy);
    this.laser = { x0, y0, x1: x0 + ux * t, y1: y0 + uy * t, ux, uy };
    this.laserClock -= dt;
    if (this.laserClock <= 0) {
      this.laserClock += UFO.laserTick;
      this.tickReady = true;
    }
  }
}
