/**
 * main: orquestación de entrada, ciclo de vida y pantalla completa.
 * Toda la interfaz (menú, HUD, avisos, botones) se dibuja en el lienzo.
 */
import { AudioEngine } from './audioEngine.js';
import { GameLoop, GameState } from './gameLoop.js';
import { Renderer } from './renderer.js';
import { WORLD, CharacterType } from './entities.js';

const $ = (id) => document.getElementById(id);

const ui = {
  file: $('track-input'),
  canvas: $('stage'),
  stageWrap: $('stage-wrap'),
};

/* ---------------- entrada ---------------- */

const KEYMAP = {
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  KeyW: 'up',
  ArrowUp: 'up',
  Space: 'jump',
  KeyS: 'down',
  ArrowDown: 'down',
  KeyJ: 'fire',
};

class Input {
  constructor(canvas) {
    this.pressed = new Set();
    this.mouseFire = false;
    // Mirilla en coordenadas lógicas (576×324). Inactiva si el puntero no está sobre el canvas.
    this.aim = { x: WORLD.width / 2, y: WORLD.height / 2, active: false };

    const track = (e) => {
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return;
      this.aim.x = Math.max(0, Math.min(WORLD.width - 1, ((e.clientX - r.left) * WORLD.width) / r.width));
      this.aim.y = Math.max(0, Math.min(WORLD.height - 1, ((e.clientY - r.top) * WORLD.height) / r.height));
      this.aim.active = true;
    };
    canvas.addEventListener('pointermove', track);
    canvas.addEventListener('pointerdown', track);
    canvas.addEventListener('pointerleave', () => {
      this.aim.active = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => {
      const action = KEYMAP[e.code];
      if (action && game.state === GameState.PLAYING) e.preventDefault();
      if (action) this.pressed.add(action);
    });
    window.addEventListener('keyup', (e) => {
      const action = KEYMAP[e.code];
      if (action) this.pressed.delete(action);
    });
    window.addEventListener('blur', () => {
      this.pressed.clear();
      this.mouseFire = false;
      this.aim.active = false;
    });
    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.mouseFire = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseFire = false;
    });
  }

  snapshot() {
    return {
      left: this.pressed.has('left'),
      right: this.pressed.has('right'),
      // W/↑ saltan a pie; en el OVNI suben (sin que Espacio cuente como subir dos veces).
      jump: this.pressed.has('jump') || this.pressed.has('up'),
      up: this.pressed.has('up'),
      down: this.pressed.has('down'),
      fire: this.pressed.has('fire') || this.mouseFire,
      aim: { ...this.aim },
    };
  }
}

/* ---------------- sistemas ---------------- */

const audio = new AudioEngine();
const renderer = new Renderer(ui.canvas);
const input = new Input(ui.canvas);

// Atajos de prueba: ?boss arranca en la ronda final; ?ufo fuerza el OVNI con racha 3;
// ?platforms registra en consola por qué cambia cada disposición.
const params = new URLSearchParams(window.location.search);
const debugFlags = { boss: params.has('boss'), ufo: params.has('ufo'), platforms: params.has('platforms') };

const CHARACTER_ORDER = [CharacterType.SHOOTER, CharacterType.KNIGHT];
let selectedCharacter = CharacterType.SHOOTER;

const game = new GameLoop({
  audio,
  input,
  render: (g) => renderer.draw(g),
  onStateChange: syncControls,
  debug: debugFlags,
  onError: (err) => {
    console.error(err);
    setStatus('No se pudo reproducir el siguiente segmento. Pulsa P para reintentar.');
  },
});

/** La pista está analizada y tiene rondas listas. */
let trackReady = false;
let trackFailed = false;
let loadSeq = 0;

/* ---------------- estado y avisos (todo en el lienzo) ---------------- */

function setStatus(text, seconds = 5) {
  renderer.toast(text, seconds);
}

/** Estado de la canción en la pantalla IDLE del canvas. */
function setIdleStatus(status, track) {
  renderer.setIdleInfo(track === undefined ? { status } : { status, track });
}

function isTrackReady() {
  return audio.hasTrack && trackReady && !trackFailed;
}

function syncControls(state = game.state) {
  renderer.setIdleInfo({ ready: isTrackReady(), character: selectedCharacter });
  // Cursor nativo oculto (mirilla propia) solo durante la partida.
  ui.canvas.classList.toggle('is-playing', state === GameState.PLAYING);
  if (state === GameState.VICTORY || state === GameState.GAME_OVER) audio.pause();
}

/* ---------------- acciones ---------------- */

function selectCharacter(type) {
  if (!CHARACTER_ORDER.includes(type)) return;
  selectedCharacter = type;
  renderer.setIdleInfo({ character: type });
}

function cycleCharacter(step) {
  const i = CHARACTER_ORDER.indexOf(selectedCharacter);
  const n = CHARACTER_ORDER.length;
  selectCharacter(CHARACTER_ORDER[(i + step + n) % n]);
}

/** Vuelve al menú IDLE (selector de personaje) sin descargar la pista. */
function backToMenu() {
  if (game.state === GameState.IDLE) return;
  audio.pause();
  game.reset();
  game.setState(GameState.IDLE);
  setStatus('', 0);
  if (isTrackReady()) setIdleStatus(`LISTA · ${game.roundCount} ${game.roundCount === 1 ? 'RONDA' : 'RONDAS'} · Elige personaje y pulsa Jugar`);
  syncControls();
}

async function startRun() {
  if (!isTrackReady()) {
    setStatus('Primero carga una canción (L o arrastra un archivo de audio).');
    return;
  }
  try {
    await game.startRun(selectedCharacter);
    setStatus('', 0);
  } catch (err) {
    console.error(err);
    audio.pause();
    game.reset();
    game.setState(GameState.IDLE);
    setStatus('No se pudo reproducir la pista. Prueba con otro archivo.');
    setIdleStatus('ERROR · No se pudo reproducir la pista');
  }
}

async function togglePause() {
  if (game.state === GameState.PLAYING) {
    game.pause();
  } else if (game.state === GameState.PAUSED) {
    try {
      await game.resume();
      setStatus('', 0);
    } catch (err) {
      console.error(err);
      setStatus('No se pudo reanudar el audio.');
    }
  }
}

/** Abre el selector de archivos (debe llamarse desde un gesto del usuario). */
function pickTrack() {
  if (game.state !== GameState.IDLE) return;
  ui.file.click();
}

const AUDIO_EXT = /\.(mp3|wav|ogg|oga|opus|m4a|aac|flac|webm)$/i;
const isAudioFile = (file) => file && (file.type.startsWith('audio/') || AUDIO_EXT.test(file.name));

async function loadTrack(file) {
  if (!file) return;
  if (!isAudioFile(file)) {
    setStatus('Ese archivo no parece de audio.');
    return;
  }
  const seq = ++loadSeq;
  trackReady = false;
  trackFailed = false;

  const analysis = audio.loadFile(file);
  game.reset();
  game.setState(GameState.IDLE);
  setStatus('', 0);
  setIdleStatus('ANALIZANDO PISTA…', file.name);
  syncControls();

  const result = await analysis;
  if (seq !== loadSeq || !result || trackFailed) return;

  game.setSegments(result.segments);
  trackReady = true;
  const n = game.roundCount;
  const rounds = `${n} ${n === 1 ? 'ronda lista' : 'rondas listas'}`;
  if (result.fallback) setStatus(`No se pudo analizar la pista: ${rounds} repartidas por la canción.`, 6);
  setIdleStatus(`LISTA · ${rounds.toUpperCase()} · Elige personaje y pulsa Jugar`);
  syncControls();
}

/* ---------------- pantalla completa ---------------- */

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen?.();
    else await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
  } catch (err) {
    console.warn('[ui] Pantalla completa no disponible.', err);
    setStatus('El navegador no permite la pantalla completa aquí.');
  }
}

document.addEventListener('fullscreenchange', () => {
  // Salir de pantalla completa (Esc del navegador) en mitad de la partida la pausa.
  if (!document.fullscreenElement && game.state === GameState.PLAYING) game.pause();
  fitCanvas();
});

/* ---------------- eventos ---------------- */

ui.file.addEventListener('change', () => {
  const file = ui.file.files?.[0];
  ui.file.value = ''; // permite volver a elegir el mismo archivo
  loadTrack(file);
});

// Arrastrar y soltar un archivo de audio sobre la ventana (solo en el menú).
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  e.preventDefault();
  dragDepth += 1;
  if (game.state === GameState.IDLE) ui.stageWrap.classList.add('is-dropping');
});
window.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = game.state === GameState.IDLE ? 'copy' : 'none';
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) ui.stageWrap.classList.remove('is-dropping');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  ui.stageWrap.classList.remove('is-dropping');
  if (game.state !== GameState.IDLE) {
    setStatus('Vuelve al menú (M) para cambiar de canción.');
    return;
  }
  loadTrack(e.dataTransfer?.files?.[0]);
});

window.addEventListener('keydown', (e) => {
  const state = game.state;
  const ended = state === GameState.VICTORY || state === GameState.GAME_OVER;
  if (e.repeat && (e.code === 'KeyF' || e.code === 'KeyP' || e.code === 'Escape')) return;

  if (e.code === 'KeyF') {
    e.preventDefault();
    toggleFullscreen();
    return;
  }
  if (e.code === 'KeyH') {
    renderer.debug = !renderer.debug;
    return;
  }

  if (state === GameState.IDLE) {
    if (e.code === 'Digit1' || e.code === 'Numpad1') selectCharacter(CHARACTER_ORDER[0]);
    else if (e.code === 'Digit2' || e.code === 'Numpad2') selectCharacter(CHARACTER_ORDER[1]);
    else if (e.code === 'ArrowLeft' || e.code === 'KeyA') cycleCharacter(-1);
    else if (e.code === 'ArrowRight' || e.code === 'KeyD') cycleCharacter(1);
    else if (e.code === 'KeyL') pickTrack();
    else if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault();
      startRun();
    }
    return;
  }
  if (ended) {
    if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'KeyR') {
      e.preventDefault();
      startRun();
    } else if (e.code === 'KeyM' || e.code === 'Escape') {
      e.preventDefault();
      backToMenu();
    }
    return;
  }
  if (e.code === 'KeyP' || e.code === 'Escape') {
    e.preventDefault();
    togglePause();
  } else if (state === GameState.PAUSED && e.code === 'KeyM') {
    backToMenu();
  } else if (state === GameState.PAUSED && e.code === 'KeyR') {
    startRun();
  }
});

/** Coordenadas lógicas (576×324) de un evento de puntero sobre el lienzo. */
function toLogical(e) {
  const r = ui.canvas.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return {
    x: ((e.clientX - r.left) * WORLD.width) / r.width,
    y: ((e.clientY - r.top) * WORLD.height) / r.height,
  };
}

// Botones y tarjetas dibujados en el lienzo (menú, pausa, fin de partida).
ui.canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || game.state === GameState.PLAYING) return;
  const pt = toLogical(e);
  const hit = pt && renderer.hitTest(pt.x, pt.y);
  if (!hit) return;
  switch (hit.action) {
    case 'character':
      // Un segundo clic en la tarjeta elegida inicia la partida.
      if (hit.value === selectedCharacter && isTrackReady()) startRun();
      else selectCharacter(hit.value);
      break;
    case 'load':
      pickTrack();
      break;
    case 'start':
    case 'restart':
      startRun();
      break;
    case 'resume':
      togglePause();
      break;
    case 'menu':
      backToMenu();
      break;
    case 'fullscreen':
      toggleFullscreen();
      break;
    default:
      break;
  }
});

// Doble clic fuera de la partida: alterna pantalla completa (en partida, el clic dispara).
ui.canvas.addEventListener('dblclick', (e) => {
  if (game.state === GameState.PLAYING) return;
  const pt = toLogical(e);
  if (pt && renderer.hitTest(pt.x, pt.y)) return; // doble clic sobre un botón: no
  toggleFullscreen();
});

audio.onEnded = () => game.onTrackEnded();
audio.onError = () => {
  trackFailed = true;
  trackReady = false;
  setStatus('El navegador no puede decodificar este archivo de audio.');
  setIdleStatus('ERROR · Formato de audio no soportado');
  game.reset();
  game.setState(GameState.IDLE);
  syncControls();
};

// Pausa automática al perder el foco de la pestaña.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && game.state === GameState.PLAYING) game.pause();
});

// Libera el ObjectURL al cerrar.
window.addEventListener('pagehide', () => audio.unload());

/* ---------------- escalado a pantalla completa ---------------- */

/** Escala "contain" fraccionaria: llena la ventana manteniendo 16:9 (bandas negras si no encaja). */
function fitCanvas() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const scale = Math.min(w / WORLD.width, h / WORLD.height);
  ui.canvas.style.width = `${Math.floor(WORLD.width * scale)}px`;
  ui.canvas.style.height = `${Math.floor(WORLD.height * scale)}px`;
}
window.addEventListener('resize', fitCanvas);
fitCanvas();

/* ---------------- arranque ---------------- */

renderer.setIdleInfo({ status: 'SIN CANCIÓN · Pulsa L o arrastra un archivo de audio' });
const missing = await renderer.loadAssets();
if (missing.length) {
  setStatus(`Sprites no cargados (${missing.join(', ')}): usando siluetas de respaldo.`, 8);
}
syncControls();
game.start();
