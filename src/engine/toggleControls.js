import * as THREE from 'three';
import { createFPSControls } from './fpsControls.js';
import { createOrbitControls } from './orbitControls.js';
import { requestRender } from './threeEngine.js';

const _dir = new THREE.Vector3();

/**
 * Contrôles hybrides FPS ↔ Orbit avec bascule via Tab.
 *
 * @param {THREE.Camera}        camera
 * @param {THREE.WebGLRenderer} renderer
 * @param {Octree|null}         octree
 * @param {Object}              opts
 * @param {THREE.Vector3}       opts.startPosition   – position initiale joueur (FPS)
 * @param {THREE.Vector3}       opts.cameraPosition  – position initiale caméra (Orbit)
 * @param {{ x,y,z }}           opts.orbitTarget     – cible initiale orbit
 * @returns {{ update(delta:number):boolean, dispose():void }}
 */
export function createToggleControls(camera, renderer, octree, opts = {}) {
  const {
    startPosition  = new THREE.Vector3(0, 2, 10),
    cameraPosition = new THREE.Vector3(10, 8, 20),
    orbitTarget    = { x: 0, y: 0, z: 0 },
  } = opts;

  let mode   = 'fps';
  let active = createFPSControls(camera, renderer, octree, startPosition);

  // ── HUD ────────────────────────────────────────────────────────────────────
  const hud = document.createElement('div');
  hud.style.cssText = [
    'position:fixed',
    'bottom:22px',
    'left:50%',
    'transform:translateX(-50%)',
    'background:rgba(0,0,0,0.52)',
    'color:#fff',
    'font-family:ui-monospace,monospace',
    'font-size:12px',
    'padding:5px 16px',
    'border-radius:999px',
    'pointer-events:none',
    'user-select:none',
    'z-index:200',
    'letter-spacing:0.06em',
    'white-space:nowrap',
    'border:1px solid rgba(255,255,255,0.12)',
    'backdrop-filter:blur(6px)',
  ].join(';');
  document.body.appendChild(hud);

  const updateHUD = () => {
    const fpsPart   = mode === 'fps'
      ? '<span style="color:#7df;font-weight:700">⬤ FPS</span>'
      : '<span style="opacity:0.38">FPS</span>';
    const orbitPart = mode === 'orbit'
      ? '<span style="color:#fd7;font-weight:700">⬤ Orbit</span>'
      : '<span style="opacity:0.38">Orbit</span>';
    hud.innerHTML = `${fpsPart}&nbsp;&nbsp;<span style="opacity:0.28">|</span>&nbsp;&nbsp;${orbitPart}&nbsp;&nbsp;<span style="opacity:0.32; font-size:10px">[G]</span>`;
  };
  updateHUD();

  // ── Bascule ────────────────────────────────────────────────────────────────
  const switchMode = () => {
    if (mode === 'fps') {
      // FPS → Orbit : pivot 5 unités devant le joueur
      const pos = camera.position.clone();
      camera.getWorldDirection(_dir);
      const target = pos.clone().addScaledVector(_dir, 5);

      active.dispose();
      active = createOrbitControls(camera, renderer, pos,
        { x: target.x, y: target.y, z: target.z },
      );
      mode = 'orbit';

    } else {
      // Orbit → FPS : place le joueur sous la caméra courante
      // La capsule FPS : bas = start+(0, 0.35, 0), yeux = start+(0, 1.6, 0)
      // → pour garder les yeux au niveau de la caméra : start.y = cam.y - 1.6
      const startPos = camera.position.clone();
      startPos.y = Math.max(camera.position.y - 1.6, 0.5);

      active.dispose();
      active = createFPSControls(camera, renderer, octree, startPos);
      mode = 'fps';
    }

    updateHUD();
    requestRender();
  };

  const onKeyDown = (e) => {
    if (e.code === 'KeyG') {
      e.preventDefault();
      switchMode();
    }
  };
  window.addEventListener('keydown', onKeyDown);

  return {
    update(delta) {
      return active ? active.update(delta) : false;
    },

    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      if (active) active.dispose();
      if (hud.parentNode) hud.parentNode.removeChild(hud);
    },
  };
}
