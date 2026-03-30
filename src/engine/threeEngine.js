import * as THREE from 'three';
import Stats from 'three/addons/libs/stats.module.js';
import { LightingManager } from './lightingManager.js';

// ── Singletons module-level ──────────────────────────────────────────────────
// Ces objets sont créés une seule fois pour toute la durée de l'onglet.
// React peut monter/démonter ses composants sans jamais les détruire.

let renderer = null;
let scene = null;
let camera = null;
let timer = null;
let activeControls    = null; // { update(delta):bool, dispose() }
let onBeforeRender    = null; // hook optionnel appelé chaque frame
let lightingManager   = null; // LightingManager

// Rendu à la demande : on ne redessine que si quelque chose a changé
let needsRender = true;
export function requestRender() { needsRender = true; }

// ── Stats (dev uniquement) ────────────────────────────────────────────────────
let stats    = null;
let panelDC  = null; // draw calls
let panelTRI = null; // triangles (k)

// Groupe qui contiendra les modèles de la page courante
export const modelGroup = new THREE.Group();

// ── Initialisation (une seule fois) ─────────────────────────────────────────
export function initEngine() {
  if (renderer) return;

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace; // textures sRGB correctes

  scene = new THREE.Scene();
  scene.add(modelGroup);

  // Lumières gérées par LightingManager (preset 'neutral' appliqué au constructeur)
  lightingManager = new LightingManager(scene, renderer);

  camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );
  camera.rotation.order = 'YXZ';

  timer = new THREE.Timer();

  // ── Stats panels (dev uniquement) ──────────────────────────────────────────
  if (import.meta.env.DEV) {
    stats = new Stats();
    // Panneaux intégrés : 0 = FPS, 1 = MS (frame time), 2 = MB (heap JS)
    stats.showPanel(0);
    // Panneaux custom
    panelDC  = stats.addPanel(new Stats.Panel('DC',  '#ff8', '#330')); // draw calls
    panelTRI = stats.addPanel(new Stats.Panel('TRI', '#f8f', '#313')); // triangles (k)
    stats.dom.style.left  = 'auto';
    stats.dom.style.right = '0';
    document.body.appendChild(stats.dom);
    // Les counts renderer.info doivent être réinitialisés manuellement
    renderer.info.autoReset = false;
  }

  window.addEventListener('resize', onResize);

  startLoop();
}

// ── Attache / détache le canvas à un élément DOM ─────────────────────────────
export function mountCanvas(domElement) {
  if (!renderer) initEngine();
  if (renderer.domElement.parentElement !== domElement) {
    domElement.appendChild(renderer.domElement);
  }
}

export function unmountCanvas() {
  const el = renderer?.domElement;
  if (el?.parentElement) {
    el.parentElement.removeChild(el);
  }
}

// ── Boucle de rendu ──────────────────────────────────────────────────────────
// Plafond à 60 fps : la physique et les contrôles tournent à la fréquence native
// du RAF (120/144/240 Hz), mais l'appel GPU renderer.render() est limité à 60/s.
// Sur un écran 240 Hz cela divise la charge GPU par ~4 sans impact sur la fluidité.
const TARGET_FPS      = 120;
const FRAME_INTERVAL  = 1000 / TARGET_FPS; // ≈ 16.67 ms
let   lastRenderTime  = 0;

function startLoop() {
  const animate = (now) => {
    requestAnimationFrame(animate);
    if (stats) stats.begin();

    timer.update();
    const delta = timer.getDelta();
    const lightNeedsRender   = lightingManager.update(delta);
    const controlsNeedRender = activeControls ? activeControls.update(delta) : false;
    if (onBeforeRender) onBeforeRender(delta);

    const shouldRender = needsRender || lightNeedsRender || controlsNeedRender;
    const elapsed      = now - lastRenderTime;

    if (shouldRender && elapsed >= FRAME_INTERVAL) {
      renderer.render(scene, camera);
      // Correction de dérive : évite l'accumulation d'erreurs de timing
      lastRenderTime = now - (elapsed % FRAME_INTERVAL);
      if (stats) {
        panelDC.update(renderer.info.render.calls,     500);
        panelTRI.update(renderer.info.render.triangles / 1000, 2000);
        renderer.info.reset();
      }
      needsRender = false;
    }

    if (stats) stats.end();
  };
  animate(performance.now());
}

// ── API publique ─────────────────────────────────────────────────────────────
export function getScene()          { return scene; }
export function getCamera()         { return camera; }
export function getRenderer()       { return renderer; }
export function getLightingManager(){ return lightingManager; }

export function setControls(controls) {
  if (activeControls) activeControls.dispose();
  activeControls = controls;
}

export function setOnBeforeRender(fn) {
  onBeforeRender = fn;
}

// ── Resize ───────────────────────────────────────────────────────────────────
// Le canvas est redimensionné immédiatement pour éviter le glitch visuel.
// La mise à jour de la matrice de projection est débouncée (100 ms) car elle
// est bon marché et les micro-changements de taille pendant le drag ne méritent
// pas un recalcul à chaque pixel.
let resizeTimer;
function onResize() {
  if (!camera || !renderer) return;
  renderer.setSize(window.innerWidth, window.innerHeight);
  needsRender = true;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!camera || !renderer) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    needsRender = true;
  }, 100);
}

// ── Frustum dynamique ─────────────────────────────────────────────────────────
// Ajuste camera.far à la taille réelle de la scène pour éviter le clipping
// (far trop petit) ou la perte de précision du z-buffer (far trop grand).
export function fitCameraToScene(box, camDist = 0) {
  if (!camera || !box || box.isEmpty()) return;
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);
  // Couvre à la fois les grandes scènes (maxDim * 10) et les caméras lointaines
  // (caméra distante + demi-diagonale de scène, avec marge ×1.5).
  camera.far = Math.max(1000, maxDim * 10, (camDist + maxDim) * 1.5);
  camera.updateProjectionMatrix();
}
