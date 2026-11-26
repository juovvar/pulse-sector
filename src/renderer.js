/**
 * Renderer: todo el dibujado en Canvas.
 * Dimensiones de frames verificadas sobre los PNG reales de assets/.
 * Si una imagen no carga (o el modo debug está activo) se dibujan siluetas + hitboxes.
 * En IDLE el lienzo es negro sólido: el escenario solo se pinta en estados de partida.
 */
import {
  WORLD, HoundState, PLATFORM_THICKNESS, TILE, arena, PlatformKind, POWERS, POWER_DURATION,
  CharacterType, CHARACTERS, BossState, BOSS_NAME, UfoState, UFO, SWORD, BossShot, LeapImpact,
} from './entities.js';
import { GameState, Phase } from './gameLoop.js';
import { ENERGY_GATE } from './audioEngine.js';

const STAGE = './assets/stage/industrial_zone_tileset';
const HOUND_DIR = './assets/enemies/Hell-Hound-Files/Hell-Hound-Files/PNG';
const KNIGHT_DIR = './assets/player/main/character';

/**
 * Caballero: frames sueltos ampliados ×16 (1 píxel de arte = bloque de 16×16).
 * Se reducen una vez al cargar (vecino más cercano) a lienzos pequeños, normal y espejado.
 * Ancla = pies (en píxeles de arte, medida sobre los PNG); el personaje mira a la derecha.
 * (Los frames de `move/` no son un ciclo: el personaje sale del cuadro, así que no se usan.)
 */
const KNIGHT_SCALE = 16;
const KNIGHT_ANIMS = {
  idle: { dir: 'idle', prefix: 'i', frames: [1, 2], fps: 3, loop: true, src: [800, 560], anchor: [25, 34] },
  walk: { dir: 'run', prefix: 'k', frames: [1, 2, 3, 4, 5, 6, 7, 8], fps: 14, loop: true, src: [800, 480], anchor: [25, 29] },
  jump: { dir: 'run', prefix: 'k', frames: [1], fps: 1, loop: false, src: [800, 480], anchor: [25, 27] },
  attack: { dir: 'attack', prefix: 'a', frames: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], fps: 13 / SWORD.pose, loop: false, src: [800, 560], anchor: [25, 34] },
};
const knightKey = (anim, n) => `knight_${anim}_${n}`;

const ASSET_PATHS = {
  background: `${STAGE}/2 Background/Background.png`,
  floorTop: `${STAGE}/1 Tiles/IndustrialTile_05.png`,
  // Pasarela de 16 px (mitad superior del tile): tapa izquierda, centro, tapa derecha.
  platformLeft: `${STAGE}/1 Tiles/IndustrialTile_74.png`,
  platformMid: `${STAGE}/1 Tiles/IndustrialTile_75.png`,
  platformRight: `${STAGE}/1 Tiles/IndustrialTile_76.png`,
  // Placas macizas de 16 px para escalones: tapa izq., centro, tapa der. y centro con junta.
  plateLeft: `${STAGE}/1 Tiles/IndustrialTile_77.png`,
  plateMid: `${STAGE}/1 Tiles/IndustrialTile_78.png`,
  plateRight: `${STAGE}/1 Tiles/IndustrialTile_79.png`,
  plateSeam: `${STAGE}/1 Tiles/IndustrialTile_80.png`,
  // Viga de celosía (16 px) que se intercala en las pasarelas largas.
  girder: `${STAGE}/1 Tiles/IndustrialTile_18.png`,
  // Columna vertical: se recorta su franja central para los puntales.
  pillar: `${STAGE}/1 Tiles/IndustrialTile_61.png`,
  player: './assets/player/alt/pixel_character_spritesheets/pixel_character_pale_blue_original.png',
  houndIdle: `${HOUND_DIR}/hell-hound-idle.png`,
  houndRun: `${HOUND_DIR}/hell-hound-run.png`,
  houndJump: `${HOUND_DIR}/hell-hound-jump.png`,
};
for (const [anim, def] of Object.entries(KNIGHT_ANIMS)) {
  for (const n of def.frames) ASSET_PATHS[knightKey(anim, n)] = `${KNIGHT_DIR}/${def.dir}/${def.prefix}${n}.png`;
}

/**
 * Hoja del jugador: rejilla 8×8 de 48×48. Las filas ya vienen orientadas:
 * [filaDerecha, filaIzquierda]. Los pies quedan en y≈40 dentro del frame.
 */
const PLAYER_SPRITE = {
  image: 'player',
  frameW: 48,
  frameH: 48,
  anchorX: 24,
  anchorY: 40,
  anims: {
    idle: { rows: [0, 1], frames: 5, fps: 6, loop: true },
    walk: { rows: [3, 2], frames: 8, fps: 12, loop: true },
    shoot: { rows: [5, 4], frames: 5, fps: 20, loop: true },
    death: { rows: [6, 7], frames: 8, fps: 10, loop: false },
  },
};

/** Tiras horizontales del Hell Hound (mira a la izquierda en el PNG). */
const HOUND_SPRITE = {
  idle: { image: 'houndIdle', frameW: 64, frameH: 32, frames: 6, fps: 8, loop: true },
  run: { image: 'houndRun', frameW: 67, frameH: 32, frames: 5, fps: 12, loop: true },
  jump: { image: 'houndJump', frameW: 65, frameH: 48, frames: 6, fps: 10, loop: false },
};

const COLORS = {
  veil: 'rgba(6, 8, 16, 0.38)',
  floorFallback: '#2a2f4a',
  floorEdge: '#5b6488',
  platformFallback: '#3a2f55',
  player: '#7fd4ff',
  hound: '#ff4b3a',
  bullet: '#fff36b',
  hitbox: '#38ff9c',
  oneWay: '#38d4ff',
  accent: '#ff3b5c',
  text: '#f2f4ff',
  muted: 'rgba(242, 244, 255, 0.55)',
  overlay: 'rgba(4, 5, 10, 0.72)',
  outline: '#0b0d16',
};

/** Iconos 3×5 de los poderes (1 = píxel encendido): » ráfaga, → perforante, + sobrecarga. */
const POWER_ICONS = {
  RAPID: ['100', '110', '011', '110', '100'],
  PIERCE: ['010', '001', '111', '001', '010'],
  OVERDRIVE: ['000', '010', '111', '010', '000'],
};

const IDLE_CONTROLS = [
  'A/D ←/→ mover   W/↑/ESPACIO saltar   S/↓ bajar de plataforma',
  'RATÓN apuntar   CLIC/J atacar   P pausa   F pantalla completa   H hitboxes',
  'OVNI (racha alta): súbete de un salto · WASD volar · CLIC/J láser',
];

const CREDITS = [
  'Hell Hound por Luis Zuno (@ansimuz), CC-BY 3.0 · Personaje por thekingphoenix y Bonsaiheldin, CC0',
  'Caballero: set de sprites incluido en assets/player/main · Industrial Zone Tileset (OpenGameArt)',
];

/** Corazón 7×6 para el HUD de vida. */
const HEART = ['0110110', '1111111', '1111111', '0111110', '0011100', '0001000'];

const SHAKE_PIXELS = 3;

/** Puntales bajo las plataformas: ancho y columna de origen dentro de IndustrialTile_61. */
const STRUT_W = 10;
const STRUT_SRC_X = 11;
const PREVIEW_TINT = 'rgba(56, 212, 255, 0.8)';

const platformSig = (p) => `${p.x}:${p.y}:${p.w}`;

export function formatTime(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ img, ok: true });
    img.onerror = () => {
      console.warn(`[renderer] No se pudo cargar ${src}; se usará silueta de respaldo.`);
      resolve({ img: null, ok: false });
    };
    img.src = encodeURI(src);
  });
}

/* ------------------------------------------------------------------ */
/* Pixel art procedural                                                */
/*   Se pintan formas con un id de material sobre una rejilla y        */
/*   `bakePixels` las hornea en un sprite con sombreado en rampa       */
/*   (luz arriba, sombra abajo, tramado en las transiciones) y         */
/*   contorno de 1 px. Se hornea una vez y se cachea.                  */
/* ------------------------------------------------------------------ */

const OUTLINE = '#0b0d16';

class PixelGrid {
  /** (ox, oy): posición del origen local dentro de la rejilla. */
  constructor(w, h, ox, oy) {
    this.w = w;
    this.h = h;
    this.ox = ox;
    this.oy = oy;
    this.m = new Array(w * h).fill(null);
  }

  set(x, y, mat) {
    const X = Math.round(x + this.ox);
    const Y = Math.round(y + this.oy);
    if (X < 0 || Y < 0 || X >= this.w || Y >= this.h) return;
    this.m[Y * this.w + X] = mat;
  }

  /** Material en coordenadas locales. */
  at(x, y) {
    return this.cell(Math.round(x + this.ox), Math.round(y + this.oy));
  }

  /** Material en coordenadas de rejilla. */
  cell(X, Y) {
    if (X < 0 || Y < 0 || X >= this.w || Y >= this.h) return null;
    return this.m[Y * this.w + X];
  }

  rect(x, y, w, h, mat) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, mat);
  }

  /** Elipse rellena; `clip(x, y)` opcional limita qué píxeles se pintan. */
  ellipse(cx, cy, rx, ry, mat, clip = null) {
    const ex = rx + 0.5;
    const ey = ry + 0.5;
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x - cx) / ex;
        const dy = (y - cy) / ey;
        if (dx * dx + dy * dy > 1) continue;
        if (clip && !clip(x, y)) continue;
        this.set(x, y, mat);
      }
    }
  }

  /** Trazo grueso por una polilínea con radio que va de r0 a r1 (cuernos, cola, patas). */
  tube(points, r0, r1, mat) {
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    }
    let run = 0;
    for (let i = 1; i < points.length; i++) {
      const [ax, ay] = points[i - 1];
      const [bx, by] = points[i];
      const len = Math.hypot(bx - ax, by - ay);
      for (let t = 0; t <= len; t += 0.5) {
        const f = total ? (run + t) / total : 0;
        const r = r0 + (r1 - r0) * f;
        this.ellipse(ax + ((bx - ax) * t) / (len || 1), ay + ((by - ay) * t) / (len || 1), r, r, mat);
      }
      run += len;
    }
  }

  /** Línea de 1 px por una polilínea. `only` = pinta solo sobre píxeles ya ocupados. */
  line(points, mat, only = false) {
    for (let i = 1; i < points.length; i++) {
      const [ax, ay] = points[i - 1];
      const [bx, by] = points[i];
      const n = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay)) * 2));
      for (let k = 0; k <= n; k++) {
        const x = ax + ((bx - ax) * k) / n;
        const y = ay + ((by - ay) * k) / n;
        if (only && !this.at(x, y)) continue;
        this.set(x, y, mat);
      }
    }
  }

  /** Polígono relleno (prueba de punto en polígono sobre el centro de cada píxel). */
  poly(points, mat) {
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) {
      for (let x = Math.floor(Math.min(...xs)); x <= Math.ceil(Math.max(...xs)); x++) {
        let inside = false;
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
          const [xi, yi] = points[i];
          const [xj, yj] = points[j];
          if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        }
        if (inside) this.set(x, y, mat);
      }
    }
  }

  /** Sustituye el material `from` por `to` donde `test(x, y)` (coordenadas locales). */
  recolor(from, to, test) {
    for (let Y = 0; Y < this.h; Y++) {
      for (let X = 0; X < this.w; X++) {
        if (this.m[Y * this.w + X] !== from) continue;
        if (test(X - this.ox, Y - this.oy)) this.m[Y * this.w + X] = to;
      }
    }
  }
}

/** Hash determinista 0..1 por píxel (manchas, desgaste) para que el horneado sea estable. */
const hash2 = (x, y) => {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
};

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/**
 * Hornea la rejilla. `ramps[mat]` es un color plano ('#rrggbb') o una rampa
 * [luz, base, sombra, sombra profunda]. Devuelve { canvas, ox, oy }.
 */
function bakePixels(grid, ramps) {
  const { w, h } = grid;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  const img = g.createImageData(w, h);
  const solid = (X, Y) => grid.cell(X, Y) !== null;
  const rgbCache = new Map();
  const rgb = (hex) => {
    let c = rgbCache.get(hex);
    if (!c) {
      c = hexToRgb(hex);
      rgbCache.set(hex, c);
    }
    return c;
  };

  // Extensión vertical de cada tramo macizo por columna: da el volumen (luz arriba, sombra abajo).
  const top = new Int16Array(w * h);
  const bottom = new Int16Array(w * h);
  for (let X = 0; X < w; X++) {
    let Y = 0;
    while (Y < h) {
      if (!solid(X, Y)) {
        Y++;
        continue;
      }
      const start = Y;
      while (Y < h && solid(X, Y)) Y++;
      for (let k = start; k < Y; k++) {
        top[k * w + X] = start;
        bottom[k * w + X] = Y - 1;
      }
    }
  }

  for (let Y = 0; Y < h; Y++) {
    for (let X = 0; X < w; X++) {
      const mat = grid.cell(X, Y);
      let color = null;
      if (mat === null) {
        // Contorno: hueco con algún vecino macizo (4-vecindad).
        if (solid(X - 1, Y) || solid(X + 1, Y) || solid(X, Y - 1) || solid(X, Y + 1)) color = OUTLINE;
      } else {
        const ramp = ramps[mat] ?? '#ff00ff';
        if (typeof ramp === 'string') {
          color = ramp;
        } else {
          const i = Y * w + X;
          const span = Math.max(1, bottom[i] - top[i]);
          // Tramado en damero en las fronteras entre tonos.
          const t = (Y - top[i]) / span + (((X + Y) & 1) ? 0.035 : -0.035);
          let idx = t < 0.2 ? 0 : t < 0.58 ? 1 : t < 0.84 ? 2 : 3;
          const up = grid.cell(X, Y - 1);
          if (up === null) idx = span > 3 ? 0 : 1;                  // filo superior iluminado
          if (!solid(X, Y + 1)) idx = 3;                            // base en sombra
          else if (!solid(X + 1, Y) && idx < 2) idx += 1;           // luz desde arriba-izquierda
          // Costura entre piezas: el material de debajo se oscurece un tono.
          if (up !== null && up !== mat && typeof ramps[up] !== 'string') idx = Math.max(idx, 2);
          color = ramp[idx];
        }
      }
      if (!color) continue;
      const [r, gg, b] = rgb(color);
      const o = (Y * w + X) * 4;
      img.data[o] = r;
      img.data[o + 1] = gg;
      img.data[o + 2] = b;
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return { canvas, ox: grid.ox, oy: grid.oy };
}

/* ---------------- Coloso Alfa ---------------- */

const BOSS_RAMPS = {
  p1: {
    body: ['#74304a', '#4e1b32', '#381222', '#230a14'],
    far: ['#4c1a2a', '#36111f', '#270b16', '#17060c'],
    plate: ['#cc5c74', '#922e48', '#641a31', '#3c0d1b'],
    belly: ['#ac4450', '#802634', '#5e1826', '#3a0c16'],
    bellyDark: '#4a1220',
    jaw: ['#5e223a', '#42152c', '#2f0e1d', '#1c0610'],
    bone: ['#fff6dc', '#e8d8b0', '#bfa97c', '#7d6c4a'],
    claw: '#e8d8b0',
    tooth: '#fff6dc',
    mouth: '#2a0408',
    socket: '#14040a',
    lava: '#ff6b3a',
  },
  p2: {
    body: ['#963440', '#641a2a', '#460f1c', '#2a0811'],
    far: ['#601826', '#440f1a', '#300a12', '#1c050a'],
    plate: ['#ffe08a', '#ff9a3c', '#d8582a', '#8e2c1a'],
    belly: ['#ffd47a', '#ffb347', '#d98a2c', '#8c5018'],
    bellyDark: '#b8602a',
    jaw: ['#6e2234', '#4c1424', '#360e1a', '#20060e'],
    bone: ['#fff8e4', '#f2e6c4', '#c8b080', '#806a44'],
    claw: '#f2e6c4',
    tooth: '#ffffff',
    mouth: '#5a1008',
    socket: '#1c0408',
    lava: '#fff36b',
  },
};

/** Lomo: puntos de anclaje de las placas dorsales (x, y de la superficie superior). */
const BOSS_SPINE = [[-28, -33], [-21, -35], [-14, -37], [-7, -38], [0, -38], [7, -41], [14, -42]];
/** Ojo (coordenadas locales, sin desplazamientos de pose). */
const BOSS_EYE = [34, -41];
const BOSS_GRID = { w: 108, h: 72, ox: 54, oy: 66 };

/**
 * Pinta el Coloso mirando a la derecha con los pies en (0, 0).
 * @param {{step:number, crouch:number, jaw:number, lean:number, phase2:boolean}} o
 */
function paintColossus({ step, crouch, jaw, lean, phase2 }) {
  const g = new PixelGrid(BOSS_GRID.w, BOSS_GRID.h, BOSS_GRID.ox, BOSS_GRID.oy);
  const oy = crouch;
  const ox = lean;
  const l1 = step ? -2 : 0;
  const l2 = step ? 0 : -2;

  /** Pata: muslo → caña → zarpa con garras. `front` = mano delantera (mira hacia delante). */
  const leg = (x, lift, mat, front) => {
    const k = front ? 1 : -1;
    g.tube([[x, -18 + oy], [x + k, -9 + lift / 2], [x + (front ? 2 : 0), -3 + lift]], 4, 2.6, mat);
    g.ellipse(x + (front ? 3 : 1), -1 + lift, 4, 1.4, mat);
    for (let c = 0; c < 3; c++) g.set(x + (front ? 3 : 0) + c * 2, 0 + lift, 'claw');
  };

  // Patas del lado lejano (más oscuras) por detrás del cuerpo.
  leg(-24, l1, 'far', false);
  leg(12 + ox, l2, 'far', true);

  // Cola acorazada que se estrecha hacia la punta.
  g.tube([[-26 + ox, -30 + oy], [-35 + ox, -34 + oy], [-42 + ox, -41 + oy], [-47 + ox, -48 + oy]], 5, 1.4, 'body');
  g.poly([[-49 + ox, -50 + oy], [-44 + ox, -47 + oy], [-50 + ox, -44 + oy]], 'plate');

  // Torso, cuartos traseros y pecho.
  g.ellipse(-8 + ox, -27 + oy, 24, 11, 'body');
  g.ellipse(-20 + ox, -24 + oy, 9, 9, 'body');
  g.ellipse(12 + ox, -29 + oy, 14, 13, 'body');
  g.ellipse(14 + ox, -23 + oy, 8, 9, 'body');

  // Vientre segmentado.
  g.ellipse(-4 + ox, -18 + oy, 19, 4, 'belly', (x, y) => y >= -20 + oy);
  for (const sx of [-18, -13, -8, -3, 2, 7]) g.line([[sx + ox, -21 + oy], [sx + 1 + ox, -14 + oy]], 'bellyDark', true);
  g.recolor('bellyDark', 'belly', (x, y) => g.at(x, y + 1) === null); // sin costura en el borde

  // Hombrera y placa de la cadera.
  g.ellipse(14 + ox, -31 + oy, 7, 4, 'plate', (x, y) => y <= -29 + oy);
  g.ellipse(-20 + ox, -29 + oy, 6, 3, 'plate', (x, y) => y <= -28 + oy);

  // Patas del lado cercano, por delante.
  leg(-16, l2, 'body', false);
  leg(20 + ox, l1, 'body', true);

  // Boca abierta (se pinta antes que hocico y mandíbula para que quede dentro).
  if (jaw > 0) g.rect(33 + ox, -33 + oy, 14, jaw + 3, 'mouth');

  // Cuello, cráneo y hocico.
  g.ellipse(24 + ox, -36 + oy, 8, 9, 'body');
  g.ellipse(31 + ox, -40 + oy, 10, 7.5, 'body');
  g.ellipse(41 + ox, -35 + oy, 8, 4, 'body');
  g.set(48 + ox, -36 + oy, 'body');

  // Colmillos superiores.
  for (const tx of [38, 41, 44]) {
    g.set(tx + ox, -31 + oy, 'tooth');
    if (jaw > 1) g.set(tx + ox, -30 + oy, 'tooth');
  }

  // Mandíbula (baja al rugir o al preparar la volea).
  g.ellipse(39 + ox, -29 + oy + jaw, 8.5, 2.2, 'jaw');
  if (jaw > 1) for (const tx of [37, 42]) g.set(tx + ox, -31 + oy + jaw, 'tooth');

  // Ceja acorazada y cuernos curvados hacia atrás.
  g.tube([[25 + ox, -46 + oy], [32 + ox, -47 + oy], [38 + ox, -42 + oy]], 2, 1.2, 'plate');
  g.tube([[27 + ox, -46 + oy], [24 + ox, -52 + oy], [19 + ox, -56 + oy], [13 + ox, -57 + oy]], 2.6, 0.8, 'bone');
  g.tube([[34 + ox, -46 + oy], [35 + ox, -51 + oy], [32 + ox, -55 + oy]], 1.8, 0.7, 'bone');
  g.ellipse(BOSS_EYE[0] + ox, BOSS_EYE[1] + oy, 2.4, 1.4, 'socket');

  // Placas dorsales: crestas que se alternan en altura.
  BOSS_SPINE.forEach(([x, y], i) => {
    const hgt = i % 2 ? 7 : 5;
    const px = x + ox;
    const py = y + oy + 2;
    g.poly([[px - 3.5, py], [px + 3, py], [px - 2.5, py - hgt]], 'plate');
  });

  // Fase 2: grietas de lava sobre el lomo y el pecho.
  if (phase2) {
    g.line([[-26 + ox, -30 + oy], [-20 + ox, -27 + oy], [-14 + ox, -31 + oy], [-8 + ox, -26 + oy], [-2 + ox, -30 + oy], [4 + ox, -27 + oy]], 'lava', true);
    g.line([[8 + ox, -36 + oy], [12 + ox, -31 + oy], [17 + ox, -34 + oy], [20 + ox, -28 + oy]], 'lava', true);
    g.line([[26 + ox, -41 + oy], [29 + ox, -38 + oy]], 'lava', true);
  }
  return g;
}

/* ---------------- OVNI ---------------- */

const UFO_RAMPS = {
  hull: ['#e8ecf8', '#aab0ca', '#6e7698', '#3e4466'],
  hullTop: ['#f6f8ff', '#cacee2', '#8a90a8', '#5b6488'],
  under: ['#8a90a8', '#5b6488', '#3e4466', '#262a40'],
  burnt: ['#7a7486', '#4e4a5a', '#363240', '#221e2a'],
  emit: '#38ff9c',
  socket: '#1a1d2c',
  vent: '#11131e',
  glass: ['#a8f0ff', '#3a9ccc', '#1f6494', '#103a60'],
  glassBroken: ['#5a7a8a', '#2a4a60', '#1a3046', '#0e1c2c'],
  crack: '#d8f6ff',
};
/** Luces del aro (x local, ancho 2) y su fila. */
const UFO_LIGHTS = [-17, -9, -1, 7, 15];

function paintUfoHull(damaged) {
  const g = new PixelGrid(52, 16, 26, 6);
  g.ellipse(0, 4, 14, 2.4, 'under');
  g.ellipse(0, 0.5, 23, 3.2, 'hull');
  g.ellipse(0, -2, 17, 2.4, 'hullTop', (x, y) => y <= -1);
  g.ellipse(0, 6.4, 5, 1, 'emit', (x, y) => y >= 6);
  for (const vx of [-11, -7, 7, 11]) g.set(vx, 5, 'vent');
  for (const lx of UFO_LIGHTS) {
    g.set(lx, 0, 'socket');
    g.set(lx + 1, 0, 'socket');
  }
  if (damaged) {
    // Chamuscado irregular, emisor apagado y una muesca en el aro.
    for (const mat of ['hull', 'hullTop', 'under']) g.recolor(mat, 'burnt', (x, y) => hash2(Math.floor(x / 4), Math.floor(y / 2)) < 0.4 || hash2(x, y) < 0.06);
    g.recolor('emit', 'vent', () => true);
    for (const [x, y] of [[18, -1], [19, -1], [20, 0], [21, 0], [19, 0]]) g.set(x, y, null);
  }
  return g;
}

function paintUfoDome(damaged) {
  const g = new PixelGrid(24, 14, 12, 13);
  g.ellipse(0, -3.5, 10, 8, damaged ? 'glassBroken' : 'glass', (x, y) => y <= -2);
  if (damaged) {
    g.line([[-2, -11], [0, -8], [-1, -6], [2, -4]], 'crack', true);
    g.line([[0, -8], [4, -9]], 'crack', true);
  }
  return g;
}

/* ---------------- primitivas de efectos ---------------- */

/** Disco relleno pixelado (una fillRect por fila). */
function pixelDisk(ctx, cx, cy, r) {
  if (r < 0.5) return;
  const R = Math.round(r);
  for (let y = -R; y <= R; y++) {
    const half = Math.floor(Math.sqrt(Math.max(0, r * r - y * y)));
    ctx.fillRect(cx - half, cy + y, half * 2 + 1, 1);
  }
}

/** Anillo pixelado entre rIn y rOut. */
function pixelRing(ctx, cx, cy, rOut, rIn) {
  if (rOut < 0.5) return;
  const R = Math.round(rOut);
  for (let y = -R; y <= R; y++) {
    const xo = Math.floor(Math.sqrt(Math.max(0, rOut * rOut - y * y)));
    const xi = Math.abs(y) < rIn ? Math.floor(Math.sqrt(rIn * rIn - y * y)) : -1;
    if (xi < 0) ctx.fillRect(cx - xo, cy + y, xo * 2 + 1, 1);
    else {
      ctx.fillRect(cx - xo, cy + y, xo - xi, 1);
      ctx.fillRect(cx + xi + 1, cy + y, xo - xi, 1);
    }
  }
}


export class Renderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.canvas.width = WORLD.width;
    this.canvas.height = WORLD.height;
    this.ctx = canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;
    this.images = {};
    this.debug = false;
    this.idleInfo = {
      track: '',
      status: 'SIN CANCIÓN · Carga un archivo de audio',
      character: CharacterType.SHOOTER,
      ready: false,
    };
    /** Zonas clicables del frame actual (coordenadas lógicas): { x, y, w, h, action, value? }. */
    this.hitAreas = [];
    /** Aviso temporal sobre el lienzo (sustituye a la antigua línea de estado del DOM). */
    this.toastInfo = null;
    /** Sprites procedurales ya horneados (jefe, OVNI) y sus versiones teñidas. */
    this.bossSprites = new Map();
    this.tintCache = new WeakMap();
    this.ufoSprites = {
      hull: bakePixels(paintUfoHull(false), UFO_RAMPS),
      hullDamaged: bakePixels(paintUfoHull(true), UFO_RAMPS),
      dome: bakePixels(paintUfoDome(false), UFO_RAMPS),
      domeDamaged: bakePixels(paintUfoDome(true), UFO_RAMPS),
    };
    /** Frames del caballero ya reducidos: { anim: [{ r, l }] } o null si faltan. */
    this.knight = null;

    // Lienzo auxiliar para teñir frames (destello de impacto / aviso de emboscada).
    this.tintCanvas = document.createElement('canvas');
    this.tintCanvas.width = 72;
    this.tintCanvas.height = 48;
    this.tintCtx = this.tintCanvas.getContext('2d');

    // Sprites pre-renderizados por plataforma (cubierta + puntales). Las plataformas son objetos
    // nuevos en cada rotación, así que la caché se invalida sola.
    this.platformSprites = new WeakMap();
    this.previewSprites = new WeakMap();
    this.sortedLists = new WeakMap();
  }

  async loadAssets() {
    const entries = await Promise.all(
      Object.entries(ASSET_PATHS).map(async ([key, src]) => [key, await loadImage(src)]),
    );
    for (const [key, { img }] of entries) this.images[key] = img;
    this.knight = this.#buildKnightFrames();
    const missing = entries.filter(([, r]) => !r.ok).map(([key]) => key);
    // Los frames del caballero se resumen en una sola entrada.
    const knightMissing = missing.some((k) => k.startsWith('knight_'));
    return [...missing.filter((k) => !k.startsWith('knight_')), ...(knightMissing ? ['caballero'] : [])];
  }

  /** Reduce los PNG ×16 del caballero a lienzos pequeños (normal + espejo). null si falta alguno. */
  #buildKnightFrames() {
    const out = {};
    for (const [anim, def] of Object.entries(KNIGHT_ANIMS)) {
      const [sw, sh] = def.src;
      const w = sw / KNIGHT_SCALE;
      const h = sh / KNIGHT_SCALE;
      out[anim] = [];
      for (const n of def.frames) {
        const img = this.images[knightKey(anim, n)];
        if (!img) return null;
        const make = (mirror) => {
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          const g = c.getContext('2d');
          g.imageSmoothingEnabled = false;
          if (mirror) {
            g.translate(w, 0);
            g.scale(-1, 1);
          }
          g.drawImage(img, 0, 0, sw, sh, 0, 0, w, h);
          return c;
        };
        out[anim].push({ r: make(false), l: make(true) });
      }
    }
    return out;
  }

  /** Texto y selección de la pantalla IDLE (lo actualiza main). */
  setIdleInfo(info = {}) {
    this.idleInfo = { ...this.idleInfo, ...info };
  }

  /** Muestra un aviso breve en la parte inferior del lienzo (texto vacío = lo quita). */
  toast(text, seconds = 4) {
    this.toastInfo = text ? { text, until: performance.now() / 1000 + seconds, seconds } : null;
  }

  /** Acción bajo el punto (coordenadas lógicas) o null. */
  hitTest(x, y) {
    for (let i = this.hitAreas.length - 1; i >= 0; i--) {
      const a = this.hitAreas[i];
      if (x >= a.x && x < a.x + a.w && y >= a.y && y < a.y + a.h) return a;
    }
    return null;
  }

  /** @param {import('./gameLoop.js').GameLoop} game */
  draw(game) {
    const { ctx } = this;
    ctx.imageSmoothingEnabled = false;
    this.hitAreas = [];
    this.pointer = game.aim;

    // IDLE: negro sólido, sin escenario detrás.
    if (game.state === GameState.IDLE) {
      this.#drawIdle();
      this.#drawToast();
      return;
    }

    // Micro-shake: desplazamiento entero (pixel art nítido) que no afecta al HUD.
    const mag = game.state === GameState.PAUSED ? 0 : game.shake * SHAKE_PIXELS;
    const sx = Math.round((Math.random() * 2 - 1) * mag);
    const sy = Math.round((Math.random() * 2 - 1) * mag);

    ctx.save();
    ctx.translate(sx, sy);
    this.#drawBackground(game.beatFlash, game.bassPulse);
    this.#drawFloor(game.bassPulse);
    this.#drawPlatforms(game);
    this.#drawPickups(game.pickups);

    if (game.boss) this.#drawBossTelegraph(game.boss);
    for (const h of game.hounds) this.#drawHound(h);
    if (game.boss) this.#drawBoss(game.boss, game.beatFlash);
    if (game.ufo) this.#drawUfo(game.ufo, game.player);
    if (!game.player.mount) {
      this.#drawPlayer(game.player);
      this.#drawSlash(game.player);
      this.#drawPlayerPowerBar(game.player);
    }
    if (game.boss && !game.player.mount) this.#drawPerchWarning(game.boss, game.player);
    this.#drawHazards(game.hazards);
    this.#drawBullets(game.bullets);
    this.#drawExplosions(game.explosions);
    this.#drawParticles(game.particles);
    ctx.restore();

    if (game.screenFlash > 0) {
      ctx.fillStyle = `rgba(255, 246, 220, ${0.65 * game.screenFlash})`;
      ctx.fillRect(0, 0, WORLD.width, WORLD.height);
    }

    this.#drawRhythmBar(game.lastSample, game.beatFlash);
    this.#drawVitals(game);
    this.#drawPowerHud(game.player);
    this.#drawUfoHud(game);
    this.#drawBossBar(game);
    this.#drawSegment(game);
    this.#drawRebuildTag(game);
    this.#drawBreakBanner(game);
    this.#drawOverlay(game);
    this.#drawToast();
    this.#drawCrosshair(game);
  }

  /* ---------------- pantalla IDLE ---------------- */

  #drawIdle() {
    const { ctx } = this;
    const cx = WORLD.width / 2;
    const now = performance.now() / 1000;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, WORLD.width, WORLD.height);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.accent;
    ctx.font = 'bold 22px monospace';
    ctx.fillText('PULSE SECTOR', cx, 22);
    ctx.fillRect(cx - 90, 36, 180, 1);

    const { track, status, character, ready } = this.idleInfo;
    ctx.font = '10px monospace';
    ctx.fillStyle = COLORS.text;
    ctx.fillText(status, cx, 47);
    if (track) {
      ctx.fillStyle = COLORS.muted;
      ctx.font = '9px monospace';
      const name = track.length > 60 ? `${track.slice(0, 57)}…` : track;
      ctx.fillText(`♪ ${name}`, cx, 59);
    }

    // Tarjetas: Tirador, Caballero y un sector bloqueado (contenido futuro).
    const cardW = 150;
    const cardH = 128;
    const gap = 14;
    const left = Math.round(cx - (cardW * 3 + gap * 2) / 2);
    const top = 70;
    const order = [CharacterType.SHOOTER, CharacterType.KNIGHT];
    order.forEach((type, i) => {
      const x = left + i * (cardW + gap);
      this.#drawCharacterCard(type, i + 1, x, top, cardW, cardH, type === character, now);
      this.hitAreas.push({ x, y: top, w: cardW, h: cardH, action: 'character', value: type });
    });
    this.#drawLockedCard(left + 2 * (cardW + gap), top, cardW, cardH, now);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '8px monospace';
    ctx.fillStyle = COLORS.muted;
    ctx.fillText('1 / 2  ·  ← →  ELEGIR PERSONAJE', cx, top + cardH + 10);

    // Botones: cargar canción y jugar.
    const by = top + cardH + 18;
    this.#button(cx - 154, by, 150, 16, 'CARGAR CANCIÓN · L', 'load', { primary: !ready });
    const blink = Math.floor(now * 2) % 2 === 0;
    this.#button(cx + 4, by, 150, 16, ready ? '▶ JUGAR · ENTER' : 'CARGA UNA CANCIÓN', 'start', {
      enabled: ready, primary: ready && blink,
    });

    ctx.fillStyle = COLORS.muted;
    ctx.font = '8px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const lx = cx - 170;
    IDLE_CONTROLS.forEach((line, i) => ctx.fillText(line, lx, by + 30 + i * 10));

    ctx.textAlign = 'center';
    ctx.font = '7px monospace';
    ctx.fillStyle = 'rgba(242, 244, 255, 0.35)';
    CREDITS.forEach((line, i) => ctx.fillText(line, cx, WORLD.height - 24 + i * 9));
  }

  /** Botón pixel dibujado en el lienzo; si está activo registra su zona clicable. */
  #button(x, y, w, h, label, action, { enabled = true, primary = false, value } = {}) {
    const { ctx } = this;
    const ptr = this.pointer;
    const hot = enabled && ptr?.active && ptr.x >= x && ptr.x < x + w && ptr.y >= y && ptr.y < y + h;
    let bg = 'rgba(255, 255, 255, 0.04)';
    let fg = enabled ? COLORS.text : COLORS.muted;
    let line = enabled ? 'rgba(242, 244, 255, 0.7)' : 'rgba(242, 244, 255, 0.2)';
    if (primary && enabled) {
      bg = COLORS.accent;
      fg = '#000000';
      line = COLORS.accent;
    }
    if (hot) {
      bg = COLORS.text;
      fg = '#000000';
      line = COLORS.text;
    }
    ctx.fillStyle = bg;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = line;
    ctx.fillRect(x, y, w, 1);
    ctx.fillRect(x, y + h - 1, w, 1);
    ctx.fillRect(x, y, 1, h);
    ctx.fillRect(x + w - 1, y, 1, h);
    ctx.fillStyle = fg;
    ctx.font = 'bold 8px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + Math.round(w / 2), y + Math.round(h / 2) + 1);
    if (enabled) this.hitAreas.push({ x, y, w, h, action, value });
  }

  /** Aviso temporal en la parte inferior del lienzo. */
  #drawToast() {
    const t = this.toastInfo;
    if (!t) return;
    const left = t.until - performance.now() / 1000;
    if (left <= 0) {
      this.toastInfo = null;
      return;
    }
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = Math.min(1, left / 0.5);
    ctx.font = '8px monospace';
    const w = Math.min(WORLD.width - 16, Math.ceil(ctx.measureText(t.text).width) + 16);
    const x = Math.round(WORLD.width / 2 - w / 2);
    const y = WORLD.height - 40;
    ctx.fillStyle = 'rgba(4, 5, 10, 0.88)';
    ctx.fillRect(x, y, w, 13);
    ctx.fillStyle = COLORS.accent;
    ctx.fillRect(x, y, 2, 13);
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(t.text, WORLD.width / 2, y + 7);
    ctx.restore();
  }

  /** Tarjeta de personaje con vista previa animada. */
  #drawCharacterCard(type, key, x, y, w, h, selected, now) {
    const { ctx } = this;
    const def = CHARACTERS[type];
    ctx.fillStyle = selected ? 'rgba(255, 59, 92, 0.12)' : 'rgba(255, 255, 255, 0.04)';
    ctx.fillRect(x, y, w, h);
    // Marco (doble y con esquinas que laten si está seleccionada).
    ctx.fillStyle = selected ? COLORS.accent : 'rgba(255, 255, 255, 0.25)';
    ctx.fillRect(x, y, w, 1);
    ctx.fillRect(x, y + h - 1, w, 1);
    ctx.fillRect(x, y, 1, h);
    ctx.fillRect(x + w - 1, y, 1, h);
    if (selected) {
      const o = Math.floor(now * 4) % 2;
      ctx.fillRect(x - 2 - o, y - 2 - o, 6, 2);
      ctx.fillRect(x - 2 - o, y - 2 - o, 2, 6);
      ctx.fillRect(x + w - 4 + o, y - 2 - o, 6, 2);
      ctx.fillRect(x + w + o, y - 2 - o, 2, 6);
      ctx.fillRect(x - 2 - o, y + h + o, 6, 2);
      ctx.fillRect(x - 2 - o, y + h - 4 + o, 2, 6);
      ctx.fillRect(x + w - 4 + o, y + h + o, 6, 2);
      ctx.fillRect(x + w + o, y + h - 4 + o, 2, 6);
    }

    // Tecla
    ctx.fillStyle = selected ? COLORS.accent : COLORS.muted;
    ctx.fillRect(x + 6, y + 6, 11, 11);
    ctx.fillStyle = '#000000';
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(key), x + 12, y + 12);

    // Peana + vista previa (pies en `footY`).
    const footY = y + 66;
    const midX = x + Math.round(w / 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.fillRect(midX - 22, footY, 44, 2);
    if (type === CharacterType.KNIGHT) {
      // Alterna reposo y tajo para enseñar el ataque.
      const cycle = now % 2.4;
      const attacking = selected && cycle > 1.6;
      const anim = attacking ? 'attack' : 'idle';
      const t = attacking ? (cycle - 1.6) * (SWORD.pose / 0.8) : now;
      this.#drawKnightFrame(midX, footY, anim, t, 1, def.color);
    } else {
      const shooting = selected && now % 2.4 > 1.6;
      this.#drawShooterFrame(midX, footY, shooting ? 'shoot' : 'idle', now, 1);
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = selected ? def.color : COLORS.text;
    ctx.font = 'bold 11px monospace';
    ctx.fillText(def.label, midX, y + 80);
    ctx.fillStyle = COLORS.muted;
    ctx.font = '8px monospace';
    def.lines.forEach((line, i) => ctx.fillText(line, midX, y + 94 + i * 10));
    ctx.fillStyle = selected ? COLORS.text : COLORS.muted;
    ctx.fillText(`${def.attack} · ${'♥'.repeat(def.maxHp)}`, midX, y + 118);
  }

  /** Tarjeta apagada: gancho de contenido futuro, claramente intencional. */
  #drawLockedCard(x, y, w, h, now) {
    const { ctx } = this;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.02)';
    ctx.fillRect(x, y, w, h);
    // Marco discontinuo
    ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
    for (let i = 0; i < w; i += 6) {
      ctx.fillRect(x + i, y, 3, 1);
      ctx.fillRect(x + i, y + h - 1, 3, 1);
    }
    for (let i = 0; i < h; i += 6) {
      ctx.fillRect(x, y + i, 1, 3);
      ctx.fillRect(x + w - 1, y + i, 1, 3);
    }
    // Candado pixel art
    const mx = x + Math.round(w / 2);
    const ly = y + 34;
    ctx.fillStyle = 'rgba(242, 244, 255, 0.35)';
    ctx.fillRect(mx - 6, ly, 2, 10);
    ctx.fillRect(mx + 4, ly, 2, 10);
    ctx.fillRect(mx - 6, ly - 2, 12, 2);
    ctx.fillRect(mx - 9, ly + 10, 18, 14);
    ctx.fillStyle = '#000000';
    ctx.fillRect(mx - 1, ly + 14, 2, 5);
    // Señal de "en construcción" que pulsa despacio
    ctx.fillStyle = `rgba(56, 212, 255, ${0.35 + 0.25 * Math.sin(now * 2)})`;
    ctx.fillRect(mx - 20, ly + 30, 40, 1);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.muted;
    ctx.font = 'bold 11px monospace';
    ctx.fillText('SECTOR 02', mx, y + 80);
    ctx.font = '8px monospace';
    ctx.fillText('Nuevo personaje y arena', mx, y + 94);
    ctx.fillText('en reconstrucción', mx, y + 104);
    ctx.fillStyle = COLORS.oneWay;
    ctx.fillText('PRÓXIMAMENTE', mx, y + 118);
  }

  /** Frame del tirador con los pies en (x, y). */
  #drawShooterFrame(x, y, anim, time, facing) {
    const img = this.images[PLAYER_SPRITE.image];
    const def = PLAYER_SPRITE.anims[anim] ?? PLAYER_SPRITE.anims.idle;
    if (!img) {
      this.#silhouette({ x: x - 7, y: y - 28, w: 14, h: 28 }, COLORS.player, facing);
      return;
    }
    const row = def.rows[facing > 0 ? 0 : 1];
    const col = this.#frameIndex(def, time);
    const { frameW: w, frameH: h, anchorX, anchorY } = PLAYER_SPRITE;
    this.ctx.drawImage(img, col * w, row * h, w, h, Math.round(x - anchorX), Math.round(y - anchorY), w, h);
  }

  /** Frame del caballero con los pies en (x, y); silueta + espada si faltan los PNG. */
  #drawKnightFrame(x, y, anim, time, facing, color = CHARACTERS.KNIGHT.color) {
    const { ctx } = this;
    const def = KNIGHT_ANIMS[anim] ?? KNIGHT_ANIMS.idle;
    const frames = this.knight?.[anim] ?? this.knight?.idle;
    if (!frames) {
      const box = { x: x - 7, y: y - 28, w: 14, h: 28 };
      this.#silhouette(box, color, facing);
      ctx.fillStyle = '#e8ecff';
      const sx = facing > 0 ? x + 7 : x - 9;
      ctx.fillRect(Math.round(sx), Math.round(y - 30), 2, 16);
      return null;
    }
    const i = this.#frameIndex({ ...def, frames: frames.length }, time);
    const frame = frames[i];
    const canvas = facing > 0 ? frame.r : frame.l;
    const ax = facing > 0 ? def.anchor[0] : canvas.width - def.anchor[0];
    ctx.drawImage(canvas, Math.round(x - ax), Math.round(y - def.anchor[1]));
    return canvas;
  }

  /* ---------------- escenario ---------------- */

  #drawBackground(flash, pulse) {
    const { ctx } = this;
    const pad = SHAKE_PIXELS + 1;
    const bg = this.images.background;
    if (bg) ctx.drawImage(bg, -pad, -pad, WORLD.width + pad * 2, WORLD.height + pad * 2);
    else {
      ctx.fillStyle = '#1b2036';
      ctx.fillRect(-pad, -pad, WORLD.width + pad * 2, WORLD.height + pad * 2);
    }
    // El velo se aclara levemente con los graves.
    ctx.fillStyle = `rgba(6, 8, 16, ${0.42 - 0.1 * Math.min(1, pulse)})`;
    ctx.fillRect(-pad, -pad, WORLD.width + pad * 2, WORLD.height + pad * 2);

    if (flash > 0) {
      ctx.fillStyle = `rgba(255, 59, 92, ${0.06 * flash})`;
      ctx.fillRect(-pad, -pad, WORLD.width + pad * 2, WORLD.groundY + pad);
    }
  }

  #drawFloor(pulse) {
    const { ctx } = this;
    const tile = this.images.floorTop;
    if (tile) {
      for (let x = -TILE; x < WORLD.width + TILE; x += tile.width) {
        for (let y = WORLD.groundY; y < WORLD.height + TILE; y += tile.height) {
          ctx.drawImage(tile, x, y);
        }
      }
    } else {
      ctx.fillStyle = COLORS.floorFallback;
      ctx.fillRect(-TILE, WORLD.groundY, WORLD.width + TILE * 2, WORLD.height - WORLD.groundY + TILE);
      ctx.fillStyle = COLORS.floorEdge;
      ctx.fillRect(-TILE, WORLD.groundY, WORLD.width + TILE * 2, 2);
    }
    // Borde del suelo que respira con los graves.
    ctx.fillStyle = `rgba(255, 59, 92, ${0.35 * Math.min(1, pulse)})`;
    ctx.fillRect(-TILE, WORLD.groundY, WORLD.width + TILE * 2, 1);
  }

  /* ---------------- plataformas (sprites cacheados) ---------------- */

  /** Lista ordenada de arriba abajo (cacheada por array): las bajas tapan el pie de los puntales. */
  #sortedTopDown(list) {
    let sorted = this.sortedLists.get(list);
    if (!sorted) {
      sorted = [...list].sort((a, b) => a.y - b.y);
      this.sortedLists.set(list, sorted);
    }
    return sorted;
  }

  /** Puntales: 1 (piezas cortas) o 2 (≥ 4 tiles), desde la cara inferior hasta la superficie de debajo. */
  #strutsFor(p, all) {
    const xs = p.w >= TILE * 4
      ? [p.x + 10, p.x + p.w - 10 - STRUT_W]
      : [p.x + Math.floor((p.w - STRUT_W) / 2)];
    return xs.map((x) => {
      const cx = x + STRUT_W / 2;
      let bottom = WORLD.groundY;
      for (const q of all) {
        if (q === p || q.y <= p.y + PLATFORM_THICKNESS) continue;
        if (cx >= q.x && cx < q.x + q.w && q.y < bottom) bottom = q.y;
      }
      return { x, top: p.y + PLATFORM_THICKNESS, bottom };
    });
  }

  #paintStrut(c, x, y, len) {
    const pillar = this.images.pillar;
    if (pillar) {
      for (let yy = 0; yy < len; yy += TILE) {
        const hh = Math.min(TILE, len - yy);
        c.drawImage(pillar, STRUT_SRC_X, 0, STRUT_W, hh, x, y + yy, STRUT_W, hh);
      }
    } else {
      c.fillStyle = '#2b3150';
      c.fillRect(x, y, STRUT_W, len);
      c.fillStyle = '#454d75';
      c.fillRect(x + 1, y, 1, len);
    }
    // Abrazaderas cada 16 px, cartela bajo la cubierta y zapata en el apoyo.
    c.fillStyle = '#1a1e33';
    for (let yy = 8; yy < len - 4; yy += 16) c.fillRect(x - 1, y + yy, STRUT_W + 2, 2);
    c.fillRect(x - 3, y, STRUT_W + 6, 2);
    c.fillRect(x - 2, y + len - 2, STRUT_W + 4, 2);
  }

  /** Tile de cubierta para la posición `i` de `n` según el tipo de plataforma. */
  #deckTile(kind, i, n) {
    const im = this.images;
    const first = i === 0;
    const last = i === n - 1;
    if (kind === PlatformKind.STEP) {
      return first ? im.plateLeft : last ? im.plateRight : i % 2 ? im.plateSeam : im.plateMid;
    }
    if (kind === PlatformKind.CATWALK) {
      return first ? im.platformLeft : last ? im.platformRight : i % 3 === 0 ? im.girder : im.platformMid;
    }
    return first ? im.platformLeft : last ? im.platformRight : im.platformMid;
  }

  #paintDeck(c, p) {
    const n = Math.round(p.w / TILE);
    const tiles = Array.from({ length: n }, (_, i) => this.#deckTile(p.kind, i, n));
    if (tiles.every(Boolean)) {
      tiles.forEach((img, i) => c.drawImage(img, i * TILE, 0));
    } else {
      c.fillStyle = p.kind === PlatformKind.STEP ? '#4a3f6e' : COLORS.platformFallback;
      c.fillRect(0, 0, p.w, PLATFORM_THICKNESS);
      c.fillStyle = COLORS.floorEdge;
      c.fillRect(0, 0, p.w, 2);
      for (let x = TILE; x < p.w; x += TILE) c.fillRect(x, 3, 1, PLATFORM_THICKNESS - 4);
    }
    // Labio superior legible (la superficie que se pisa).
    c.fillStyle = 'rgba(255, 255, 255, 0.22)';
    c.fillRect(2, 1, p.w - 4, 1);
    // Chevrones ▲ en la cara inferior: "se atraviesa desde abajo".
    c.fillStyle = 'rgba(56, 212, 255, 0.75)';
    for (let cx = TILE / 2; cx < p.w; cx += TILE) {
      c.fillRect(cx, 12, 1, 1);
      c.fillRect(cx - 1, 13, 3, 1);
    }
    // Remaches en los extremos de las placas.
    if (p.kind === PlatformKind.STEP) {
      c.fillStyle = 'rgba(255, 255, 255, 0.35)';
      for (const x of [4, p.w - 5]) {
        c.fillRect(x, 4, 1, 1);
        c.fillRect(x, 10, 1, 1);
      }
    }
  }

  /** Sprite (cubierta + puntales oscurecidos) de una plataforma dentro de su disposición `all`. */
  #platformSprite(p, all) {
    let sprite = this.platformSprites.get(p);
    if (sprite) return sprite;
    const struts = this.#strutsFor(p, all);
    const h = Math.max(PLATFORM_THICKNESS, ...struts.map((st) => st.bottom - p.y));
    const canvas = document.createElement('canvas');
    canvas.width = p.w;
    canvas.height = h;
    const c = canvas.getContext('2d');
    c.imageSmoothingEnabled = false;
    for (const st of struts) this.#paintStrut(c, st.x - p.x, st.top - p.y, st.bottom - st.top);
    // Los puntales quedan en segundo plano: oscurecidos para no leerse como paredes.
    c.globalCompositeOperation = 'source-atop';
    c.fillStyle = 'rgba(6, 8, 16, 0.5)';
    c.fillRect(0, 0, p.w, h);
    c.globalCompositeOperation = 'source-over';
    this.#paintDeck(c, p);
    sprite = { canvas, x: p.x, y: p.y };
    this.platformSprites.set(p, sprite);
    return sprite;
  }

  /** Versión teñida de cian para la vista previa de la siguiente disposición. */
  #previewSprite(p, all) {
    let sprite = this.previewSprites.get(p);
    if (sprite) return sprite;
    const base = this.#platformSprite(p, all);
    const canvas = document.createElement('canvas');
    canvas.width = base.canvas.width;
    canvas.height = base.canvas.height;
    const c = canvas.getContext('2d');
    c.imageSmoothingEnabled = false;
    c.drawImage(base.canvas, 0, 0);
    c.globalCompositeOperation = 'source-atop';
    c.fillStyle = PREVIEW_TINT;
    c.fillRect(0, 0, canvas.width, canvas.height);
    sprite = { canvas, x: p.x, y: p.y };
    this.previewSprites.set(p, sprite);
    return sprite;
  }

  #drawPlatforms(game) {
    const { ctx } = this;
    const pulse = game.bassPulse;
    const flash = game.beatFlash;
    const warn = game.platformWarning;
    const platforms = arena.platforms;
    const next = warn > 0 ? game.nextPlatforms : null;
    const nextSigs = next ? new Set(next.map(platformSig)) : null;
    // Durante el aviso, solo las pasarelas que van a desaparecer parpadean (cada vez más rápido).
    const blinkOff = warn > 0 && Math.floor((game.warnTime ?? 0) * (8 + warn * 10)) % 2 === 0;

    for (const p of this.#sortedTopDown(platforms)) {
      const vanishing = nextSigs !== null && !nextSigs.has(platformSig(p));
      const sprite = this.#platformSprite(p, platforms);
      ctx.save();
      if (vanishing && blinkOff) ctx.globalAlpha = 0.3;
      ctx.drawImage(sprite.canvas, sprite.x, sprite.y);

      // Las luces rojas de la pasarela pulsan con los graves y el beat (y con el aviso si va a desaparecer).
      const lights = p.kind === PlatformKind.STEP ? 0.6 : 1;
      const glow = Math.min(1, (0.6 * pulse + 0.4 * flash) * lights + (vanishing ? 0.8 * warn : 0));
      if (glow > 0.02) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = `rgba(255, 59, 92, ${0.45 * glow})`;
        ctx.fillRect(p.x + 3, p.y + 4, p.w - 6, 8);
        ctx.fillStyle = `rgba(255, 59, 92, ${0.18 * glow})`;
        ctx.fillRect(p.x + 3, p.y + PLATFORM_THICKNESS, p.w - 6, 2);
      }
      ctx.restore();

      // Las que se mantienen en la siguiente disposición se marcan con un filo cian fijo.
      if (nextSigs && !vanishing) {
        ctx.fillStyle = COLORS.oneWay;
        ctx.fillRect(p.x + 2, p.y, p.w - 4, 1);
      }

      if (this.debug) {
        ctx.strokeStyle = COLORS.hitbox;
        ctx.lineWidth = 1;
        ctx.strokeRect(p.x + 0.5, p.y + 0.5, p.w - 1, PLATFORM_THICKNESS - 1);
        ctx.fillStyle = COLORS.oneWay;
        ctx.fillRect(p.x, p.y, p.w, 1);
        ctx.font = '6px monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`y${p.y} h${WORLD.groundY - p.y} ${p.kind}`, p.x + 2, p.y - 1);
      }
    }

    // Vista previa: las piezas nuevas aparecen teñidas de cian con un barrido de abajo arriba.
    if (next) {
      const currentSigs = new Set(platforms.map(platformSig));
      const incoming = this.#sortedTopDown(next).filter((p) => !currentSigs.has(platformSig(p)));
      const reveal = Math.round(WORLD.height * Math.min(1, warn * 1.25));
      const top = WORLD.height - reveal;

      ctx.save();
      ctx.beginPath();
      ctx.rect(-TILE, top, WORLD.width + TILE * 2, reveal);
      ctx.clip();
      ctx.globalAlpha = 0.2 + 0.45 * warn;
      for (const p of incoming) {
        const sprite = this.#previewSprite(p, next);
        ctx.drawImage(sprite.canvas, sprite.x, sprite.y);
      }
      ctx.restore();

      // Contornos discontinuos de las piezas nuevas (siempre visibles durante el aviso).
      ctx.save();
      ctx.globalAlpha = 0.25 + 0.75 * warn;
      ctx.fillStyle = COLORS.oneWay;
      for (const p of incoming) {
        for (let x = p.x; x < p.x + p.w; x += 6) {
          const w = Math.min(3, p.x + p.w - x);
          ctx.fillRect(x, p.y, w, 1);
          ctx.fillRect(x, p.y + PLATFORM_THICKNESS - 1, w, 1);
        }
        for (let y = p.y; y < p.y + PLATFORM_THICKNESS; y += 4) {
          ctx.fillRect(p.x, y, 1, 2);
          ctx.fillRect(p.x + p.w - 1, y, 1, 2);
        }
      }
      // Línea de barrido.
      if (reveal < WORLD.height) {
        ctx.globalAlpha = 0.5;
        ctx.fillRect(0, top, WORLD.width, 1);
      }
      ctx.restore();
    }

    if (this.debug) {
      ctx.fillStyle = COLORS.oneWay;
      ctx.fillRect(0, WORLD.groundY, WORLD.width, 1);
      ctx.fillStyle = COLORS.hitbox;
      ctx.font = '6px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(`motif ${arena.motif ?? '-'} · ${platforms.length} plataformas`, 8, 64);
    }
  }

  #drawPickups(pickups) {
    const { ctx } = this;
    for (const p of pickups) {
      if (p.blinking && Math.floor(p.age * 12) % 2 === 0) continue;
      const def = POWERS[p.type];
      const bob = p.onGround ? Math.round(Math.sin(p.age * 5) * 1.5) : 0;
      const x = Math.round(p.x) - 5;
      const y = Math.round(p.y) - 12 + bob;
      // Halo
      ctx.save();
      ctx.globalAlpha = 0.25 + 0.15 * Math.sin(p.age * 8);
      ctx.fillStyle = def.color;
      ctx.fillRect(x - 2, y - 2, 14, 14);
      ctx.restore();
      // Cápsula con contorno
      ctx.fillStyle = COLORS.outline;
      ctx.fillRect(x - 1, y - 1, 12, 12);
      ctx.fillStyle = def.color;
      ctx.fillRect(x, y, 10, 10);
      ctx.fillStyle = COLORS.outline;
      ctx.fillRect(x + 2, y + 2, 6, 6);
      // Icono 3×5
      ctx.fillStyle = def.color;
      const icon = POWER_ICONS[p.type];
      for (let r = 0; r < icon.length; r++) {
        for (let c = 0; c < 3; c++) {
          if (icon[r][c] === '1') ctx.fillRect(x + 3 + c, y + 2 + r, 1, 1);
        }
      }
      if (this.debug) this.#hitbox(p.hitbox());
    }
  }

  /* ---------------- personajes ---------------- */

  #frameIndex(def, time) {
    const i = Math.floor(time * def.fps);
    return def.loop ? i % def.frames : Math.min(def.frames - 1, i);
  }

  #drawPlayer(p) {
    const { ctx } = this;
    if (p.invulnerable > 0 && !p.dead && Math.floor(p.invulnerable * 20) % 2 === 0) return;

    if (this.debug) {
      this.#silhouette(p.hitbox(), p.isKnight ? CHARACTERS.KNIGHT.color : COLORS.player, p.facing);
    } else if (p.isKnight) {
      if (p.dead) {
        // Sin frames de muerte: el reposo parpadea en rojo y se desvanece.
        ctx.save();
        ctx.globalAlpha = Math.max(0.25, 1 - p.animTime / 1.2);
        const frames = this.knight?.idle;
        if (frames && Math.floor(p.animTime * 10) % 2 === 0) {
          const c = p.facing > 0 ? frames[0].r : frames[0].l;
          const tinted = this.#tinted(c, 0, 0, c.width, c.height, COLORS.accent);
          const ax = p.facing > 0 ? KNIGHT_ANIMS.idle.anchor[0] : c.width - KNIGHT_ANIMS.idle.anchor[0];
          ctx.drawImage(tinted, 0, 0, c.width, c.height, Math.round(p.x - ax), Math.round(p.y - KNIGHT_ANIMS.idle.anchor[1]), c.width, c.height);
        } else {
          this.#drawKnightFrame(p.x, p.y, 'idle', 0, p.facing);
        }
        ctx.restore();
      } else {
        this.#drawKnightFrame(p.x, p.y, p.anim, p.animTime, p.facing);
      }
    } else {
      this.#drawShooterFrame(p.x, p.y, p.anim, p.animTime, p.facing);
    }
    if (this.debug) {
      this.#hitbox(p.hitbox());
      const sb = p.slash ? p.slashHitbox() : null;
      if (sb) {
        ctx.save();
        ctx.globalAlpha = p.slashActive ? 1 : 0.3;
        ctx.strokeStyle = COLORS.accent;
        ctx.strokeRect(Math.round(sb.x) + 0.5, Math.round(sb.y) + 0.5, sb.w - 1, sb.h - 1);
        ctx.restore();
      }
    }
  }

  /** Efecto de tajo: arco de píxeles que barre de arriba abajo delante del caballero. */
  #drawSlash(p) {
    const s = p.slash;
    if (!s || p.dead) return;
    const { ctx } = this;
    const sweep = Math.min(1, s.age / SWORD.active);
    const fade = s.age <= SWORD.active ? 1 : Math.max(0, 1 - (s.age - SWORD.active) / (SWORD.pose - SWORD.active));
    if (fade <= 0) return;
    const ox = p.x;
    const oy = p.y - 21;
    const start = s.angle - s.dir * 1.15;
    const span = s.dir * 2.3;
    const steps = 22;
    ctx.save();
    for (let i = 0; i <= steps * sweep; i++) {
      const f = i / steps;
      const a = start + span * f;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      // El borde exterior brilla más; la cola del arco se apaga.
      const tail = Math.max(0.2, 1 - (sweep - f) * 1.6);
      ctx.globalAlpha = fade * tail;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(Math.round(ox + cos * (s.reach - 2)), Math.round(oy + sin * (s.reach - 2)), 2, 2);
      ctx.fillStyle = '#38d4ff';
      ctx.fillRect(Math.round(ox + cos * (s.reach - 6)), Math.round(oy + sin * (s.reach - 6)), 2, 1);
      ctx.globalAlpha = fade * tail * 0.5;
      ctx.fillRect(Math.round(ox + cos * (s.reach - 11)), Math.round(oy + sin * (s.reach - 11)), 1, 1);
    }
    ctx.restore();
  }

  /** Copia el frame al lienzo auxiliar y lo tiñe de `color` respetando su alfa. */
  #tinted(img, sx, sy, w, h, color) {
    const t = this.tintCtx;
    t.imageSmoothingEnabled = false;
    t.globalCompositeOperation = 'source-over';
    t.clearRect(0, 0, this.tintCanvas.width, this.tintCanvas.height);
    t.drawImage(img, sx, sy, w, h, 0, 0, w, h);
    t.globalCompositeOperation = 'source-atop';
    t.fillStyle = color;
    t.fillRect(0, 0, w, h);
    return this.tintCanvas;
  }

  #drawHound(h) {
    const { ctx } = this;
    const def = HOUND_SPRITE[h.anim] ?? HOUND_SPRITE.run;
    const img = this.images[def.image];

    ctx.save();
    if (h.state === HoundState.DEAD) ctx.globalAlpha = Math.max(0, 1 - h.stateTime / 0.5);

    if (img && !this.debug) {
      const col = this.#frameIndex(def, h.animTime);
      const w = def.frameW;
      const hgt = def.frameH;
      const x = Math.round(h.x);
      const y = Math.round(h.y);
      // El PNG mira a la izquierda: volteamos cuando corre hacia la derecha.
      ctx.translate(x, y);
      if (h.dir > 0) ctx.scale(-1, 1);

      let source = img;
      let sx = col * w;
      if (h.hitFlash > 0) {
        source = this.#tinted(img, sx, 0, w, hgt, '#ffffff');
        sx = 0;
      } else if (h.state === HoundState.WINDUP && Math.floor(h.stateTime * 30) % 2 === 0) {
        source = this.#tinted(img, sx, 0, w, hgt, COLORS.accent);
        sx = 0;
      }
      ctx.drawImage(source, sx, 0, w, hgt, -Math.floor(w / 2), -hgt, w, hgt);
    } else {
      const color = h.hitFlash > 0 ? '#ffffff' : COLORS.hound;
      this.#silhouette(h.hitbox(), color, h.dir);
    }
    ctx.restore();

    if (this.debug) {
      this.#hitbox(h.hitbox());
      ctx.fillStyle = COLORS.hitbox;
      ctx.font = '6px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(h.state, Math.round(h.x), Math.round(h.y - 26));
    }
  }

  #drawBullets(bullets) {
    const { ctx } = this;
    for (const b of bullets) {
      const n = b.size;
      let color = COLORS.bullet;
      if (n > 2) color = POWERS.OVERDRIVE.color;
      else if (b.pierce > 0 || b.hit.size) color = POWERS.PIERCE.color;
      // Estela: dos píxeles detrás, en sentido contrario a la velocidad.
      ctx.save();
      ctx.fillStyle = color;
      for (let k = 1; k <= 2; k++) {
        ctx.globalAlpha = 0.45 / k;
        ctx.fillRect(Math.round(b.x - b.ux * k * 3 - n / 2), Math.round(b.y - b.uy * k * 3 - n / 2), n, n);
      }
      ctx.restore();
      ctx.fillStyle = color;
      ctx.fillRect(Math.round(b.x - n / 2), Math.round(b.y - n / 2), n, n);
      if (this.debug) this.#hitbox(b.hitbox());
    }
  }

  #drawParticles(particles) {
    const { ctx } = this;
    ctx.save();
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, 1 - p.age / p.life);
      ctx.fillStyle = p.color;
      ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
    }
    ctx.restore();
  }

  /** Silueta de respaldo: cuerpo + marca de orientación. */
  #silhouette(box, color, facing) {
    const { ctx } = this;
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(box.x), Math.round(box.y), box.w, box.h);
    ctx.fillStyle = '#0b0d16';
    const eyeX = facing > 0 ? box.x + box.w - 5 : box.x + 2;
    ctx.fillRect(Math.round(eyeX), Math.round(box.y + 3), 3, 3);
  }

  #hitbox(box) {
    const { ctx } = this;
    ctx.strokeStyle = COLORS.hitbox;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(box.x) + 0.5, Math.round(box.y) + 0.5, box.w - 1, box.h - 1);
  }

  /* ---------------- jefe final (pixel art procedural) ---------------- */

  /** Pose discreta del Coloso a partir de su estado (clave de la caché de sprites). */
  #bossPose(b) {
    const moving = Math.abs(b.vx) > 1;
    const stride = b.state === BossState.CHARGE ? 22 : 9;
    const step = moving ? Math.floor(b.animTime * stride) % 2 : 0;
    const crouch = b.state === BossState.SLAM_WINDUP || b.state === BossState.LEAP_WINDUP ? 4
      : b.state === BossState.CHARGE_WINDUP ? 2 : 0;
    const lean = b.state === BossState.CHARGE || b.state === BossState.LEAP ? 3 : 0;
    const jaw = b.state === BossState.VOLLEY_WINDUP ? Math.round(b.windupProgress * 4)
      : b.state === BossState.VOLLEY || b.state === BossState.ROAR ? 4 : 0;
    return { step, crouch, jaw, lean, phase2: b.phase2 };
  }

  #bossSprite(pose) {
    const key = `${pose.step}|${pose.crouch}|${pose.jaw}|${pose.lean}|${pose.phase2 ? 2 : 1}`;
    let sprite = this.bossSprites.get(key);
    if (!sprite) {
      sprite = bakePixels(paintColossus(pose), pose.phase2 ? BOSS_RAMPS.p2 : BOSS_RAMPS.p1);
      this.bossSprites.set(key, sprite);
    }
    return sprite;
  }

  /** Silueta teñida (destello de impacto, telegrafía) cacheada por sprite y color. */
  #tintOf(canvas, color) {
    let byColor = this.tintCache.get(canvas);
    if (!byColor) {
      byColor = new Map();
      this.tintCache.set(canvas, byColor);
    }
    let t = byColor.get(color);
    if (!t) {
      t = document.createElement('canvas');
      t.width = canvas.width;
      t.height = canvas.height;
      const g = t.getContext('2d');
      g.drawImage(canvas, 0, 0);
      g.globalCompositeOperation = 'source-atop';
      g.fillStyle = color;
      g.fillRect(0, 0, t.width, t.height);
      byColor.set(color, t);
    }
    return t;
  }

  #drawBoss(b, beat) {
    const { ctx } = this;
    const dead = b.state === BossState.DEAD;
    const pose = this.#bossPose(b);
    const sprite = this.#bossSprite(pose);
    const windBlink = b.isWindup && Math.floor(b.stateTime * 16) % 2 === 0;

    ctx.save();
    if (dead) ctx.globalAlpha = Math.max(0, 1 - b.stateTime / 1.6);
    ctx.translate(Math.round(b.x), Math.round(b.y));
    if (b.dir < 0) ctx.scale(-1, 1);
    const dx = -sprite.ox;
    const dy = -sprite.oy;
    if (b.hitFlash > 0) {
      ctx.drawImage(this.#tintOf(sprite.canvas, '#ffffff'), dx, dy);
    } else if (dead && Math.floor(b.stateTime * 12) % 2 === 0) {
      ctx.drawImage(this.#tintOf(sprite.canvas, COLORS.accent), dx, dy);
    } else {
      ctx.drawImage(sprite.canvas, dx, dy);
      if (windBlink) {
        // Telegrafía: velo rojo sobre el sprite (se sigue leyendo el detalle debajo).
        const a = ctx.globalAlpha;
        ctx.globalAlpha = a * 0.55;
        ctx.drawImage(this.#tintOf(sprite.canvas, COLORS.accent), dx, dy);
        ctx.globalAlpha = a;
      }
    }

    if (!dead && b.hitFlash <= 0) {
      // Ojo emisivo con halo (late con el beat).
      const ex = BOSS_EYE[0] + pose.lean;
      const ey = BOSS_EYE[1] + pose.crouch;
      const eye = b.phase2 ? '#ffffff' : beat > 0.5 ? '#ffffff' : '#fff36b';
      ctx.fillStyle = b.phase2 ? 'rgba(255, 179, 71, 0.45)' : 'rgba(255, 243, 107, 0.35)';
      ctx.fillRect(ex - 2, ey - 1, 5, 3);
      ctx.fillStyle = eye;
      ctx.fillRect(ex - 1, ey, 3, 1);
      ctx.fillRect(ex, ey - 1, 1, 1);
    }

    // Fase 2: crin de llamas sobre las placas del lomo.
    if (b.phase2 && !dead) {
      BOSS_SPINE.forEach(([x, y], i) => {
        const h = 2 + ((Math.floor(b.animTime * 14) + i * 3) % 4);
        const px = x - 2 + pose.lean;
        const py = y + pose.crouch - (i % 2 ? 6 : 4);
        ctx.fillStyle = i % 2 ? '#ff6b3a' : '#fff36b';
        ctx.fillRect(px, py - h, 2, h);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(px, py - 1, 1, 1);
      });
    }
    ctx.restore();

    // "!" de aviso sobre la cabeza durante cualquier telegrafía.
    if (b.isWindup && Math.floor(b.stateTime * 10) % 2 === 0) {
      const x = Math.round(b.x + b.dir * 26);
      const y = Math.round(b.y - 74);
      ctx.fillStyle = COLORS.outline;
      ctx.fillRect(x - 2, y - 1, 5, 12);
      ctx.fillStyle = '#fff36b';
      ctx.fillRect(x - 1, y, 3, 7);
      ctx.fillRect(x - 1, y + 8, 3, 2);
    }
    if (this.debug) {
      this.#hitbox(b.hitbox());
      ctx.fillStyle = COLORS.hitbox;
      ctx.font = '6px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`${b.state} perch ${b.perchTime.toFixed(1)}`, Math.round(b.x), Math.round(b.y - 60));
    }
  }

  /** Telegrafía sobre el suelo (se dibuja detrás de los personajes). */
  #drawBossTelegraph(b) {
    const { ctx } = this;
    const p = b.windupProgress;
    const gy = WORLD.groundY;
    if (b.state === BossState.CHARGE_WINDUP) {
      // Chevrones que se encienden en la dirección de la embestida.
      for (let k = 0; k < 7; k++) {
        const on = p * 7 > k;
        const x = Math.round(b.x + b.dir * (44 + k * 22));
        if (x < 0 || x > WORLD.width) continue;
        ctx.fillStyle = on ? COLORS.accent : 'rgba(255, 59, 92, 0.25)';
        for (let i = 0; i < 4; i++) {
          ctx.fillRect(x + b.dir * i * 2, gy - 14 + i * 2, 2, 2);
          ctx.fillRect(x + b.dir * i * 2, gy - 2 - i * 2, 2, 2);
        }
      }
    } else if (b.state === BossState.SLAM_WINDUP || b.state === BossState.SLAM) {
      // Zona de impacto: corchetes en el suelo que se cierran.
      const x = Math.round(b.slamTargetX);
      const half = Math.round(48 - 18 * (b.state === BossState.SLAM ? 1 : p));
      const on = Math.floor(b.stateTime * 12) % 2 === 0;
      ctx.fillStyle = on ? COLORS.accent : '#fff36b';
      ctx.fillRect(x - half, gy - 2, 10, 2);
      ctx.fillRect(x + half - 10, gy - 2, 10, 2);
      ctx.fillRect(x - half, gy - 8, 2, 6);
      ctx.fillRect(x + half - 2, gy - 8, 2, 6);
      ctx.fillStyle = 'rgba(255, 59, 92, 0.18)';
      ctx.fillRect(x - half, gy - 1, half * 2, 1);
      // Flechas laterales: avisan de las ondas de choque.
      ctx.fillStyle = 'rgba(255, 179, 71, 0.7)';
      for (const d of [-1, 1]) {
        const ax = x + d * (half + 8);
        ctx.fillRect(ax, gy - 4, d * 8, 1);
        ctx.fillRect(ax + d * 6, gy - 5, d * 2, 3);
      }
    } else if (b.state === BossState.LEAP_WINDUP || (b.state === BossState.LEAP && !b.leapImpacted)) {
      // Salto directo a la altura del jugador: corchetes sobre su plataforma + columna de aviso.
      const x = Math.round(b.leapTargetX);
      const ty = Math.round(b.leapTargetY);
      const locked = b.leapLocked;
      const half = Math.round(44 - 16 * (b.state === BossState.LEAP ? 1 : p));
      const on = Math.floor(b.stateTime * (locked ? 20 : 10)) % 2 === 0;
      ctx.fillStyle = on ? COLORS.accent : '#fff36b';
      ctx.fillRect(x - half, ty - 2, 10, 2);
      ctx.fillRect(x + half - 10, ty - 2, 10, 2);
      ctx.fillRect(x - half, ty - 12, 2, 10);
      ctx.fillRect(x + half - 2, ty - 12, 2, 10);
      // Techo del corchete: la zona de impacto también cubre la altura del jugador.
      ctx.fillRect(x - half, ty - 46, 10, 2);
      ctx.fillRect(x + half - 10, ty - 46, 10, 2);
      ctx.fillRect(x - half, ty - 46, 2, 8);
      ctx.fillRect(x + half - 2, ty - 46, 2, 8);
      ctx.fillStyle = locked ? 'rgba(255, 59, 92, 0.28)' : 'rgba(255, 59, 92, 0.14)';
      ctx.fillRect(x - half, ty - 44, half * 2, 42);
      // Columna punteada desde el jefe hasta el objetivo (sube con el aviso).
      if (b.state === BossState.LEAP_WINDUP) {
        const bx = Math.round(b.x);
        const by = Math.round(b.y - 48);
        const steps = 12;
        const lit = Math.round(steps * p);
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const px = Math.round(bx + (x - bx) * t);
          const py = Math.round(by + (ty - 24 - by) * t - Math.sin(t * Math.PI) * 40);
          ctx.fillStyle = i <= lit ? COLORS.accent : 'rgba(255, 59, 92, 0.25)';
          ctx.fillRect(px - 1, py - 1, 2, 2);
        }
      }
      if (locked && on) {
        // Mira fijada sobre el objetivo.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x - 1, ty - 30, 2, 8);
        ctx.fillRect(x - 4, ty - 27, 8, 2);
      }
    } else if (b.state === BossState.VOLLEY_WINDUP) {
      // Brasas que convergen en la boca.
      const m = b.mouth;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + b.stateTime * 4;
        const r = Math.round(4 + 22 * (1 - p));
        ctx.fillStyle = i % 2 ? '#fff36b' : '#ff6b3a';
        ctx.fillRect(Math.round(m.x + Math.cos(a) * r), Math.round(m.y + Math.sin(a) * r), 2, 2);
      }
    }
  }

  #drawHazards(hazards) {
    const { ctx } = this;
    for (const z of hazards) {
      if (z instanceof BossShot) this.#drawFireball(z);
      else if (z instanceof LeapImpact) this.#drawLeapImpact(z);
      else this.#drawShockwave(z);
      if (this.debug) this.#hitbox(z.hitbox());
    }
  }

  /** Bola de fuego: estela, contorno, halo, núcleo desplazado hacia donde avanza. */
  #drawFireball(z) {
    const { ctx } = this;
    const x = Math.round(z.x);
    const y = Math.round(z.y);
    const sp = Math.hypot(z.vx, z.vy) || 1;
    const ux = z.vx / sp;
    const uy = z.vy / sp;
    const flick = Math.floor(z.age * 20) % 2;
    ctx.save();
    for (let k = 3; k >= 1; k--) {
      ctx.globalAlpha = 0.55 / k;
      ctx.fillStyle = k === 1 ? '#ffb347' : '#ff6b3a';
      const s = 5 - k;
      ctx.fillRect(Math.round(x - ux * k * 4 - s / 2), Math.round(y - uy * k * 4 - s / 2), s, s);
    }
    ctx.restore();
    ctx.fillStyle = COLORS.outline;
    pixelDisk(ctx, x, y, 4.6);
    ctx.fillStyle = '#d8402a';
    pixelDisk(ctx, x, y, 3.6);
    ctx.fillStyle = '#ff8a3a';
    pixelDisk(ctx, x + Math.round(ux), y + Math.round(uy), flick ? 2.6 : 2.2);
    ctx.fillStyle = flick ? '#fff36b' : '#ffffff';
    pixelDisk(ctx, x + Math.round(ux * 1.5), y + Math.round(uy * 1.5), 1.2);
  }

  /** Impacto del salto del jefe: destello rectangular + anillos pixelados que se abren. */
  #drawLeapImpact(z) {
    const { ctx } = this;
    const k = Math.min(1, z.age / z.life);
    const x = z.x;
    const y = z.y;
    ctx.save();
    ctx.globalAlpha = 1 - k * 0.6;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x - 30, y - 40, 60, 40);
    ctx.fillStyle = '#fff36b';
    ctx.fillRect(x - 36, y - 4, 72, 4);
    const r = Math.round(20 + 40 * k);
    ctx.fillStyle = k < 0.5 ? '#ff3b5c' : '#ffb347';
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      ctx.fillRect(Math.round(x + Math.cos(a) * r) - 1, Math.round(y - 20 + Math.sin(a) * r * 0.6) - 1, 3, 3);
    }
    ctx.restore();
  }

  /** Aviso de "acampada": barra roja sobre el jugador que se llena antes del salto del jefe. */
  #drawPerchWarning(b, player) {
    if (player.dead || !b.canBeHit) return;
    const f = b.perchFrac;
    const winding = b.state === BossState.LEAP_WINDUP;
    if (f < 0.5 && !winding) return;
    const { ctx } = this;
    const x = Math.round(player.x);
    const y = Math.round(player.y - 44);
    const w = 20;
    const fill = winding ? w : Math.round(w * (f - 0.5) * 2);
    ctx.fillStyle = COLORS.outline;
    ctx.fillRect(x - w / 2 - 1, y - 1, w + 2, 4);
    ctx.fillStyle = 'rgba(255, 59, 92, 0.25)';
    ctx.fillRect(x - w / 2, y, w, 2);
    ctx.fillStyle = COLORS.accent;
    ctx.fillRect(x - w / 2, y, fill, 2);
    if ((f >= 0.8 || winding) && Math.floor(performance.now() / (winding ? 60 : 120)) % 2 === 0) {
      ctx.fillStyle = COLORS.outline;
      ctx.fillRect(x - 2, y - 13, 5, 11);
      ctx.fillStyle = COLORS.accent;
      ctx.fillRect(x - 1, y - 12, 3, 6);
      ctx.fillRect(x - 1, y - 5, 3, 2);
    }
  }

  /** Onda de choque: lengua de fuego a ras de suelo con el frente más alto. */
  #drawShockwave(z) {
    const { ctx } = this;
    const x = Math.round(z.x);
    const gy = WORLD.groundY;
    const d = z.dir;
    const flick = Math.floor(z.age * 24) % 2;
    // Alturas por columna de 2 px, del frente (índice 0) hacia atrás.
    const profile = flick ? [6, 11, 14, 12, 8, 5, 3] : [7, 12, 13, 10, 7, 4, 2];
    profile.forEach((h, i) => {
      const cx = x + d * (6 - i * 2) - (d < 0 ? 1 : 0);
      ctx.fillStyle = COLORS.outline;
      ctx.fillRect(cx - 1, gy - h - 1, 4, h + 1);
    });
    profile.forEach((h, i) => {
      const cx = x + d * (6 - i * 2) - (d < 0 ? 1 : 0);
      const core = Math.round(h * 0.35);
      const mid = Math.round(h * 0.7);
      ctx.fillStyle = '#ff3b5c';
      ctx.fillRect(cx, gy - h, 2, 1);
      ctx.fillStyle = '#ff6b3a';
      ctx.fillRect(cx, gy - h + 1, 2, h - mid);
      ctx.fillStyle = '#ffb347';
      ctx.fillRect(cx, gy - mid, 2, mid - core);
      ctx.fillStyle = i < 4 ? '#fff36b' : '#ffb347';
      ctx.fillRect(cx, gy - core, 2, core);
    });
    ctx.fillStyle = 'rgba(255, 107, 58, 0.4)';
    ctx.fillRect(x - d * 14 - 3, gy - 3, 6, 3);
    ctx.fillRect(x - d * 22 - 2, gy - 2, 4, 2);
  }

  /* ---------------- OVNI ---------------- */

  #drawUfo(u, player) {
    const { ctx } = this;
    const x = Math.round(u.x);
    const y = Math.round(u.y);
    const gy = WORLD.groundY;
    const crashing = u.state === UfoState.CRASHING;

    // Haz de abducción: bandas tramadas que invitan a subir.
    if (u.boardable) {
      const a = 0.08 + 0.06 * Math.sin(u.age * 6);
      const scroll = Math.floor(u.age * 20) % 4;
      for (let yy = y + 8; yy < gy; yy += 2) {
        const w = Math.round(10 + ((yy - y) / (gy - y)) * 34);
        const left = x - Math.floor(w / 2);
        if ((yy + scroll) % 4 < 2) {
          ctx.fillStyle = `rgba(56, 255, 156, ${a})`;
          ctx.fillRect(left, yy, w, 2);
        } else {
          ctx.fillStyle = `rgba(56, 255, 156, ${a * 2})`;
          for (let xx = left + ((yy >> 1) & 1); xx < left + w; xx += 4) ctx.fillRect(xx, yy, 1, 1);
        }
      }
    }

    // Láser (detrás del casco).
    if (u.laser) this.#drawLaser(u.laser, u.age);

    const hull = crashing ? this.ufoSprites.hullDamaged : this.ufoSprites.hull;
    const dome = crashing ? this.ufoSprites.domeDamaged : this.ufoSprites.dome;
    const tilt = crashing ? u.tilt : 0;

    ctx.save();
    if (u.state === UfoState.LEAVING) ctx.globalAlpha = Math.max(0.3, Math.min(1, (u.y + 40) / 120));

    // Cúpula (escora con la mitad izquierda del casco).
    ctx.drawImage(dome.canvas, x - dome.ox, y - dome.oy + tilt);
    if (u.piloted) {
      const color = player.isKnight ? CHARACTERS.KNIGHT.color : CHARACTERS.SHOOTER.color;
      ctx.fillStyle = color;
      ctx.fillRect(x - 3, y - 9, 6, 6);
      ctx.fillStyle = '#e0c8a0';
      ctx.fillRect(x - 1 + (player.facing > 0 ? 1 : -1), y - 7, 3, 2);
      // El cristal vuelve a cubrir al piloto (algo translúcido).
      const a = ctx.globalAlpha;
      ctx.globalAlpha = a * 0.35;
      ctx.drawImage(dome.canvas, x - dome.ox, y - dome.oy + tilt);
      ctx.globalAlpha = a;
    }
    if (!crashing) {
      // Reflejo diagonal en el cristal.
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.fillRect(x - 6, y - 9, 1, 2);
      ctx.fillRect(x - 5, y - 10, 2, 1);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.fillRect(x - 7, y - 7, 1, 2);
      ctx.fillRect(x + 5, y - 6, 1, 1);
    }

    // Casco: al caer, cada mitad se desplaza 1 px en sentido contrario (escora a tirones).
    const half = Math.floor(hull.canvas.width / 2);
    const hx = x - hull.ox;
    const hy = y - hull.oy;
    ctx.drawImage(hull.canvas, 0, 0, half, hull.canvas.height, hx, hy + tilt, half, hull.canvas.height);
    ctx.drawImage(hull.canvas, half, 0, hull.canvas.width - half, hull.canvas.height, hx + half, hy - tilt, hull.canvas.width - half, hull.canvas.height);

    // Luces del aro que ciclan (al caer, parpadean en rojo).
    const lights = ['#ff3b5c', '#fff36b', '#38ff9c', '#38d4ff', '#ff3bd4'];
    const phase = Math.floor(u.age * 8);
    UFO_LIGHTS.forEach((lx, i) => {
      const side = lx < 0 ? tilt : -tilt;
      if (crashing) {
        if ((phase + i) % 2) return;
        ctx.fillStyle = '#ff3b5c';
      } else {
        ctx.fillStyle = lights[(phase + i) % lights.length];
      }
      ctx.fillRect(x + lx, y + side, 2, 1);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.fillRect(x + lx, y + side, 1, 1);
    });
    ctx.restore();

    if (u.boardable && Math.floor(u.age * 4) % 2 === 0) {
      ctx.fillStyle = '#38ff9c';
      ctx.font = 'bold 8px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText('¡SÚBETE!', x, y - 15);
    }
    if (u.piloted) {
      const frac = Math.max(0, u.pilotLeft / UFO.pilotTime);
      ctx.fillStyle = COLORS.outline;
      ctx.fillRect(x - 13, y - 19, 26, 4);
      ctx.fillStyle = frac < 0.25 && Math.floor(u.age * 10) % 2 ? '#ffffff' : '#38ff9c';
      ctx.fillRect(x - 12, y - 18, Math.round(24 * frac), 2);
    }
    if (this.debug) {
      this.#hitbox(u.boardBox());
    }
  }

  /** Rayo: halo ancho, cuerpo magenta, núcleo blanco, fogonazo en la boca y estrella de impacto. */
  #drawLaser(L, age) {
    const { ctx } = this;
    const len = Math.hypot(L.x1 - L.x0, L.y1 - L.y0);
    const pulse = Math.floor(age * 30) % 2;
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = '#ff3bd4';
    const outer = pulse ? 5 : 4;
    for (let t = 0; t <= len; t += 2) {
      ctx.fillRect(Math.round(L.x0 + L.ux * t) - (outer >> 1), Math.round(L.y0 + L.uy * t) - (outer >> 1), outer, outer);
    }
    ctx.globalAlpha = 0.85;
    const mid = pulse ? 3 : 2;
    for (let t = 0; t <= len; t += 2) {
      ctx.fillRect(Math.round(L.x0 + L.ux * t) - 1, Math.round(L.y0 + L.uy * t) - 1, mid, mid);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ffffff';
    for (let t = 0; t <= len; t += 1) {
      ctx.fillRect(Math.round(L.x0 + L.ux * t), Math.round(L.y0 + L.uy * t), 1, 1);
    }
    // Fogonazo en el emisor.
    const ox = Math.round(L.x0);
    const oy = Math.round(L.y0);
    ctx.fillStyle = '#ff3bd4';
    pixelDisk(ctx, ox, oy, 2.6);
    ctx.fillStyle = '#ffffff';
    pixelDisk(ctx, ox, oy, 1.2);
    // Estrella de impacto: cruz con brazos que laten + diagonales cortas.
    const ix = Math.round(L.x1);
    const iy = Math.round(L.y1);
    const arm = 4 + pulse * 2;
    ctx.fillStyle = '#ff3bd4';
    pixelDisk(ctx, ix, iy, 3.2);
    ctx.fillRect(ix - arm, iy, arm * 2 + 1, 1);
    ctx.fillRect(ix, iy - arm, 1, arm * 2 + 1);
    ctx.fillStyle = '#38d4ff';
    for (const [dx, dy] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) ctx.fillRect(ix + dx * (1 + pulse), iy + dy * (1 + pulse), 1, 1);
    ctx.fillStyle = '#ffffff';
    pixelDisk(ctx, ix, iy, 1.4);
    ctx.restore();
  }

  /** Explosiones: destello central, anillos escalonados que se expanden y humo al final. */
  #drawExplosions(list) {
    if (!list?.length) return;
    const { ctx } = this;
    ctx.save();
    for (const e of list) {
      const t = Math.min(1, e.age / e.life);
      const ease = 1 - (1 - t) ** 3;
      const r = Math.max(2, e.radius * ease);
      const x = Math.round(e.x);
      const y = Math.round(e.y);
      if (t < 0.35) {
        const k = 1 - t / 0.35;
        ctx.globalAlpha = k;
        ctx.fillStyle = '#ff6b3a';
        pixelDisk(ctx, x, y, r * 0.75);
        ctx.fillStyle = '#ffb347';
        pixelDisk(ctx, x, y, r * 0.55);
        ctx.fillStyle = '#fff36b';
        pixelDisk(ctx, x, y, r * 0.38);
        ctx.fillStyle = '#ffffff';
        pixelDisk(ctx, x, y, r * 0.2);
      }
      ctx.globalAlpha = Math.max(0, 1 - t);
      const thick = Math.max(2, Math.round(e.radius * 0.05));
      ctx.fillStyle = '#ffffff';
      pixelRing(ctx, x, y, r, r - thick);
      ctx.fillStyle = '#fff36b';
      pixelRing(ctx, x, y, r - thick, r - thick * 2);
      ctx.fillStyle = '#ff6b3a';
      pixelRing(ctx, x, y, r - thick * 2, r - thick * 3);
      if (t > 0.45) {
        ctx.globalAlpha = 0.5 * (1 - t) / 0.55;
        ctx.fillStyle = '#3a3f55';
        pixelRing(ctx, x, y, r * 1.06 + 2, r * 1.06 - 1);
      }
    }
    ctx.restore();
  }

  /* ---------------- HUD: racha, OVNI y jefe ---------------- */


  /** Vida (corazones), racha y bajas: sustituyen al antiguo HUD del DOM. */
  #drawVitals(game) {
    const { ctx } = this;
    const p = game.player;
    const hot = game.streak >= 8;
    const x = 148;
    const y = 6;
    const w = 92;
    ctx.fillStyle = 'rgba(4, 5, 10, 0.6)';
    ctx.fillRect(x, y, w, 24);
    const low = p.hp <= 1 && !p.dead && Math.floor(performance.now() / 180) % 2 === 0;
    for (let i = 0; i < p.maxHp; i++) {
      const hx = x + 5 + i * 9;
      const hy = y + 3;
      const full = i < p.hp;
      for (let r = 0; r < HEART.length; r++) {
        for (let c = 0; c < HEART[r].length; c++) {
          if (HEART[r][c] !== '1') continue;
          // Sombra 1 px abajo-derecha, relleno y brillo en la esquina superior izquierda.
          ctx.fillStyle = COLORS.outline;
          ctx.fillRect(hx + c + 1, hy + r + 1, 1, 1);
        }
      }
      for (let r = 0; r < HEART.length; r++) {
        for (let c = 0; c < HEART[r].length; c++) {
          if (HEART[r][c] !== '1') continue;
          if (full) ctx.fillStyle = low ? '#ffffff' : r >= 3 ? '#b8203c' : COLORS.accent;
          else ctx.fillStyle = 'rgba(242, 244, 255, 0.16)';
          ctx.fillRect(hx + c, hy + r, 1, 1);
        }
      }
      if (full) {
        ctx.fillStyle = '#ffd0d8';
        ctx.fillRect(hx + 1, hy + 1, 1, 1);
      }
    }
    ctx.font = '7px monospace';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillStyle = hot ? COLORS.accent : COLORS.muted;
    ctx.fillText(`RACHA ${game.streak}`, x + 5, y + 14);
    ctx.textAlign = 'right';
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(`BAJAS ${game.kills}`, x + w - 4, y + 14);
  }

  #drawUfoHud(game) {
    const u = game.ufo;
    if (!u || !u.piloted) return;
    const { ctx } = this;
    const frac = Math.max(0, Math.min(1, u.pilotLeft / UFO.pilotTime));
    const x = 8;
    const y = game.player.power ? 66 : 42;
    const w = 110;
    ctx.fillStyle = 'rgba(4, 5, 10, 0.6)';
    ctx.fillRect(x - 4, y - 4, w + 30, 20);
    ctx.fillStyle = '#38ff9c';
    ctx.font = '7px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('OVNI · LÁSER', x, y - 1);
    ctx.textAlign = 'right';
    ctx.fillText(`${u.pilotLeft.toFixed(1)}s`, x + w + 22, y - 1);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(x, y + 8, w, 3);
    if (u.pilotLeft > 1 || Math.floor(u.pilotLeft * 10) % 2 === 0) {
      ctx.fillStyle = '#38ff9c';
      ctx.fillRect(x, y + 8, Math.round(w * frac), 3);
    }
  }

  #drawBossBar(game) {
    const b = game.boss;
    if (!b) {
      this.bossGhost = 1;
      return;
    }
    const { ctx } = this;
    const w = 220;
    const x = Math.round(WORLD.width / 2 - w / 2);
    const y = 42;
    const frac = b.hpFrac;
    // Barra "fantasma" que alcanza a la real con retraso (se lee el daño hecho).
    this.bossGhost = Math.max(frac, (this.bossGhost ?? 1) - 0.006);
    ctx.fillStyle = 'rgba(4, 5, 10, 0.7)';
    ctx.fillRect(x - 4, y - 12, w + 8, 21);
    ctx.font = 'bold 7px monospace';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.text;
    ctx.fillText(BOSS_NAME, x, y - 10);
    if (b.phase2) {
      ctx.textAlign = 'right';
      ctx.fillStyle = Math.floor(b.animTime * 6) % 2 ? '#ff6b3a' : '#fff36b';
      ctx.fillText('FASE 2 · FURIA', x + w, y - 10);
    }
    ctx.fillStyle = COLORS.outline;
    ctx.fillRect(x - 1, y - 1, w + 2, 7);
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(x, y, w, 5);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, y, Math.round(w * this.bossGhost), 5);
    ctx.fillStyle = b.phase2 ? '#ff6b3a' : COLORS.accent;
    if (b.state === BossState.INTRO) ctx.fillStyle = 'rgba(255, 59, 92, 0.5)';
    ctx.fillRect(x, y, Math.round(w * frac), 5);
    // Marca del 50 %: cambio de fase.
    ctx.fillStyle = '#fff36b';
    ctx.fillRect(x + Math.round(w / 2), y - 2, 1, 9);
  }

  /* ---------------- HUD en canvas ---------------- */

  #drawRhythmBar(sample, flash) {
    const { ctx } = this;
    const x = 8;
    const y = 16;
    const w = 110;
    const h = 4;

    ctx.fillStyle = 'rgba(4, 5, 10, 0.6)';
    ctx.fillRect(x - 4, y - 4, w + 30, 22);
    // Borde del panel que late con el beat.
    if (flash > 0) {
      ctx.fillStyle = `rgba(255, 59, 92, ${0.6 * flash})`;
      ctx.fillRect(x - 4, y + 17, w + 30, 1);
    }

    // Graves
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = flash > 0.5 ? COLORS.text : COLORS.accent;
    ctx.fillRect(x, y, Math.round(w * Math.min(1, sample.bass)), h);
    // Umbral adaptativo
    ctx.fillStyle = COLORS.text;
    ctx.fillRect(x + Math.round(w * Math.min(1, sample.bassThreshold)), y - 1, 1, h + 2);

    // Medios
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(x, y + 8, w, h);
    ctx.fillStyle = COLORS.player;
    ctx.fillRect(x, y + 8, Math.round(w * Math.min(1, sample.mid)), h);

    // Puerta de ruido: por debajo de esta marca no hay beats ni spawns.
    ctx.fillStyle = 'rgba(56, 255, 156, 0.7)';
    ctx.fillRect(x + Math.round(w * ENERGY_GATE), y - 2, 1, h + 12);

    // Indicador de beat (gris si la puerta está cerrada); crece un píxel con el beat.
    const grow = flash > 0.5 ? 1 : 0;
    ctx.fillStyle = sample.gated
      ? 'rgba(242, 244, 255, 0.15)'
      : `rgba(255, 59, 92, ${0.25 + 0.75 * flash})`;
    ctx.fillRect(x + w + 8 - grow, y - grow, 12 + grow * 2, 12 + grow * 2);
  }

  /** Panel del poder activo bajo la barra de ritmo: etiqueta + barra de duración (máx. 5 s). */
  #drawPowerHud(player) {
    const power = player.power;
    if (!power) return;
    const { ctx } = this;
    const def = POWERS[power.type];
    const frac = Math.max(0, Math.min(1, power.remaining / POWER_DURATION));
    const x = 8;
    const y = 42;
    const w = 110;
    ctx.fillStyle = 'rgba(4, 5, 10, 0.6)';
    ctx.fillRect(x - 4, y - 4, w + 30, 20);
    ctx.fillStyle = def.color;
    ctx.font = '7px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(def.label, x, y - 1);
    ctx.textAlign = 'right';
    ctx.fillText(`${power.remaining.toFixed(1)}s`, x + w + 22, y - 1);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(x, y + 8, w, 3);
    // Parpadea en el último segundo.
    if (power.remaining > 1 || Math.floor(power.remaining * 10) % 2 === 0) {
      ctx.fillStyle = def.color;
      ctx.fillRect(x, y + 8, Math.round(w * frac), 3);
    }
  }

  /** Barrita de duración sobre la cabeza del jugador. */
  #drawPlayerPowerBar(player) {
    const power = player.power;
    if (!power || player.dead) return;
    const { ctx } = this;
    const frac = Math.max(0, Math.min(1, power.remaining / POWER_DURATION));
    const x = Math.round(player.x) - 8;
    const y = Math.round(player.y) - 38;
    ctx.fillStyle = COLORS.outline;
    ctx.fillRect(x - 1, y - 1, 18, 4);
    ctx.fillStyle = POWERS[power.type].color;
    ctx.fillRect(x, y, Math.round(16 * frac), 2);
  }

  #drawRebuildTag(game) {
    const warn = game.platformWarning;
    if (warn <= 0 || game.state !== GameState.PLAYING) return;
    const { ctx } = this;
    const cx = WORLD.width / 2;
    if (Math.floor(warn * 12) % 2 === 0) {
      ctx.fillStyle = COLORS.oneWay;
      ctx.font = 'bold 8px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText('▲ REESTRUCTURANDO ▲', cx, 8);
    }
    // Cuenta atrás: tres pips que se apagan hasta el cambio.
    const left = Math.ceil((1 - warn) * 3);
    for (let i = 0; i < 3; i++) {
      const x = cx - 10 + i * 8;
      ctx.fillStyle = COLORS.outline;
      ctx.fillRect(x - 1, 19, 6, 4);
      ctx.fillStyle = i < left ? COLORS.oneWay : 'rgba(56, 212, 255, 0.2)';
      ctx.fillRect(x, 20, 4, 2);
    }
  }

  /** Mirilla pixel-art en la posición del ratón; se abre al disparar. */
  #drawCrosshair(game) {
    if (game.state !== GameState.PLAYING || !game.aim.active) return;
    const { ctx } = this;
    ctx.imageSmoothingEnabled = false;
    const x = Math.round(game.aim.x);
    const y = Math.round(game.aim.y);
    const gap = 2 + Math.round(3 * game.aimPulse);
    const len = 3;
    const parts = [
      [x - gap - len, y, len, 1],
      [x + gap + 1, y, len, 1],
      [x, y - gap - len, 1, len],
      [x, y + gap + 1, 1, len],
      [x, y, 1, 1],
    ];
    if (this.debug) {
      const s = game.player.shoulder;
      ctx.save();
      ctx.strokeStyle = 'rgba(56, 255, 156, 0.5)';
      ctx.beginPath();
      ctx.moveTo(Math.round(s.x) + 0.5, Math.round(s.y) + 0.5);
      ctx.lineTo(x + 0.5, y + 0.5);
      ctx.stroke();
      ctx.restore();
    }
    ctx.fillStyle = COLORS.outline;
    for (const [px, py, w, h] of parts) ctx.fillRect(px - 1, py - 1, w + 2, h + 2);
    ctx.fillStyle = game.aimPulse > 0.4 ? COLORS.bullet : '#ffffff';
    for (const [px, py, w, h] of parts) ctx.fillRect(px, py, w, h);
  }

  /** Barra superior: progreso del segmento de la ronda actual. */
  #drawSegment(game) {
    const { ctx } = this;
    const h = 3;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(0, 0, WORLD.width, h);
    ctx.fillStyle = COLORS.accent;
    ctx.fillRect(0, 0, Math.round(WORLD.width * game.segmentProgress), h);

    // Marcas de ronda: una muesca por ronda completada.
    const n = game.roundCount;
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = i < game.roundIndex || game.state === GameState.VICTORY ? COLORS.accent : 'rgba(255,255,255,0.25)';
      ctx.fillRect(WORLD.width - 8 - (n - i) * 6, 8, 4, 4);
    }

    ctx.fillStyle = COLORS.text;
    ctx.font = '8px monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    const label = game.bossRound && game.phase === Phase.FIGHT
      ? `RONDA ${game.round}/${n} · JEFE`
      : `RONDA ${game.round}/${n} · ${formatTime(game.segmentRemaining)}`;
    ctx.fillText(label, WORLD.width - 10 - n * 6, 7);
  }

  #drawBreakBanner(game) {
    if (game.state !== GameState.PLAYING || game.phase !== Phase.BREAK) return;
    const { ctx } = this;
    const cx = WORLD.width / 2;
    const cy = WORLD.height / 2 - 30;
    ctx.fillStyle = 'rgba(4, 5, 10, 0.55)';
    ctx.fillRect(0, cy - 22, WORLD.width, 44);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.text;
    ctx.font = 'bold 20px monospace';
    ctx.fillText(`RONDA ${game.round}`, cx, cy - 4);
    ctx.fillStyle = COLORS.muted;
    ctx.font = '9px monospace';
    const final = game.isFinalRound();
    let sub;
    if (game.roundIndex === 0 || game.starting) sub = final ? 'RONDA FINAL · SE ACERCA EL COLOSO ALFA' : 'PREPÁRATE';
    else sub = `SEGMENTO SUPERADO · SIGUIENTE EN ${Math.max(1, Math.ceil(game.breakTimer))}`;
    ctx.fillText(sub, cx, cy + 14);
    if (final && !game.starting && game.roundIndex > 0) {
      ctx.fillStyle = Math.floor(performance.now() / 250) % 2 ? COLORS.accent : '#fff36b';
      ctx.font = 'bold 9px monospace';
      ctx.fillText('⚠ RONDA FINAL · JEFE DEL SECTOR ⚠', cx, cy + 28);
    }
  }


  #drawOverlay(game) {
    const { ctx } = this;
    const cx = WORLD.width / 2;
    if (game.state === GameState.PAUSED) {
      ctx.fillStyle = COLORS.overlay;
      ctx.fillRect(0, 0, WORLD.width, WORLD.height);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = COLORS.text;
      ctx.font = 'bold 24px monospace';
      ctx.fillText('PAUSA', cx, WORLD.height / 2 - 62);
      const bw = 170;
      const bx = Math.round(cx - bw / 2);
      const by = Math.round(WORLD.height / 2 - 38);
      const items = [
        ['REANUDAR · P', 'resume'],
        ['REINICIAR · R', 'restart'],
        ['MENÚ · M', 'menu'],
        [document.fullscreenElement ? 'SALIR DE PANTALLA COMPLETA · F' : 'PANTALLA COMPLETA · F', 'fullscreen'],
      ];
      items.forEach(([label, action], i) => {
        this.#button(bx, by + i * 22, bw, 16, label, action, { primary: i === 0 });
      });
      return;
    }
    const won = game.state === GameState.VICTORY;
    if (!won && game.state !== GameState.GAME_OVER) return;

    ctx.fillStyle = COLORS.overlay;
    ctx.fillRect(0, 0, WORLD.width, WORLD.height);
    const w = 300;
    const h = 184;
    const x = Math.round(cx - w / 2);
    const y = Math.round(WORLD.height / 2 - h / 2);
    ctx.fillStyle = 'rgba(4, 5, 10, 0.9)';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = won ? '#38ff9c' : COLORS.accent;
    ctx.fillRect(x, y, w, 2);
    ctx.fillRect(x, y + h - 2, w, 2);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 22px monospace';
    ctx.fillText(won ? 'SECTOR DESPEJADO' : 'CAÍDA', cx, y + 22);
    ctx.fillStyle = COLORS.muted;
    ctx.font = '9px monospace';
    ctx.fillText(won ? 'El Coloso Alfa ha caído · el pulso se calma' : 'El sector te ha superado esta vez', cx, y + 40);

    const bossLabel = game.bossDefeated ? 'DERROTADO' : game.boss ? 'EN PIE' : 'NO ALCANZADO';
    const rows = [
      ['RONDAS SUPERADAS', `${game.roundsCleared}/${game.roundCount}`],
      ['BAJAS', String(game.kills)],
      ['RACHA MÁXIMA', String(game.bestStreak)],
      ['PERSONAJE', CHARACTERS[game.character]?.label ?? '-'],
      ['JEFE', bossLabel],
    ];
    ctx.font = '9px monospace';
    rows.forEach(([k, v], i) => {
      const ry = y + 58 + i * 14;
      ctx.textAlign = 'left';
      ctx.fillStyle = COLORS.muted;
      ctx.fillText(k, x + 40, ry);
      ctx.textAlign = 'right';
      ctx.fillStyle = COLORS.text;
      ctx.fillText(v, x + w - 40, ry);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
      ctx.fillRect(x + 40, ry + 6, w - 80, 1);
    });

    const blink = Math.floor(performance.now() / 500) % 2 === 0;
    this.#button(x + 30, y + h - 44, 116, 16, 'REINTENTAR · R', 'restart', { primary: blink });
    this.#button(x + w - 146, y + h - 44, 116, 16, 'MENÚ · M', 'menu');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(56, 212, 255, 0.7)';
    ctx.font = '8px monospace';
    ctx.fillText(won ? 'SECTOR 02 · PRÓXIMAMENTE' : 'Consejo: los ataques del jefe siguen el pulso', cx, y + h - 14);
  }
}
