import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as THREE from 'three';
import { modelGroup } from './threeEngine.js';

const _raycaster  = new THREE.Raycaster();
const _ndc        = new THREE.Vector2();
const _tmpOffset  = new THREE.Vector3(); // réutilisé dans l'animation du rayon (évite le GC)

/**
 * Crée un objet de contrôles Orbit style SolidWorks :
 *  – drag gauche     → rotation autour du pivot courant (aucune téléportation)
 *  – double-clic     → repositionne le pivot sur le point cliqué (transition animée)
 *  – scroll          → zoom vers le curseur (style SolidWorks)
 *  – drag droit/milieu → pan
 *
 * @param {THREE.Camera}        camera
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Vector3}       cameraPosition  – position initiale de la caméra
 * @param {{ x,y,z }}           target          – centre de rotation initial
 * @returns {{ update(delta:number):boolean, dispose():void }}
 */
export function createOrbitControls(camera, renderer, cameraPosition, target = { x: 0, y: 0, z: 0 }) {
  camera.position.copy(cameraPosition ?? new THREE.Vector3(0, 2, 10));

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(target.x, target.y, target.z);
  controls.enableDamping  = true;
  controls.dampingFactor  = 0.06;
  controls.minDistance    = 0.5;
  controls.maxDistance    = 500;
  controls.zoomToCursor   = true; // zoom vers le curseur, comme SolidWorks
  controls.update();

  // ── Rendu à la demande ────────────────────────────────────────────────────
  // On utilise une référence nommée pour pouvoir la retirer dans dispose().
  let _changed = false;
  const onControlsChange = () => { _changed = true; };
  controls.addEventListener('change', onControlsChange);

  // ── Pivot dynamique via double-clic ───────────────────────────────────────
  //
  // Un double-clic sur la géométrie repositionne le centre de rotation sur le
  // point touché. La transition est animée en douceur (lerp chaque frame) :
  // aucune téléportation visible.
  //
  let _pivotGoal  = null; // THREE.Vector3 cible du pivot | null
  let _radiusGoal = null; // distance caméra→pivot souhaitée | null
  const PIVOT_SPEED  = 8; // lerp speed pivot  (unités/s)
  const RADIUS_SPEED = 4; // lerp speed rayon  (unités/s)

  const el = renderer.domElement;

  // ── Double-clic : repositionne le pivot sur le point cliqué ──────────────
  const onDblClick = (e) => {
    const rect = el.getBoundingClientRect();
    _ndc.x = ((e.clientX - rect.left) / rect.width)  *  2 - 1;
    _ndc.y = ((e.clientY - rect.top)  / rect.height) * -2 + 1;
    _raycaster.setFromCamera(_ndc, camera);
    const hits = _raycaster.intersectObjects(modelGroup.children, true);
    if (hits.length > 0) _pivotGoal = hits[0].point.clone();
  };

  el.addEventListener('dblclick', onDblClick);

  // ── Touche F : recadre automatiquement le modèle dans le champ de vision ─
  // Calcule la sphère englobante du modèle, repositionne pivot + distance.
  const _bbox   = new THREE.Box3();
  const _sphere = new THREE.Sphere();

  const onKeyDown = (e) => {
    if (e.code !== 'KeyF') return;
    _bbox.setFromObject(modelGroup);
    if (_bbox.isEmpty()) return;
    _bbox.getBoundingSphere(_sphere);
    const fovRad   = (camera.fov * Math.PI / 180) / 2;
    const idealDist = (_sphere.radius / Math.sin(fovRad)) * 1.25;
    _pivotGoal  = _sphere.center.clone();
    _radiusGoal = idealDist;
  };

  window.addEventListener('keydown', onKeyDown);

  // ── Indicateur visuel du pivot (petit sprite croix) ───────────────────────
  const pivotSprite = makePivotSprite();
  modelGroup.parent?.add(pivotSprite);

  const updatePivotSprite = () => {
    if (!pivotSprite.parent) modelGroup.parent?.add(pivotSprite);
    pivotSprite.position.copy(controls.target);
    const dist  = camera.position.distanceTo(controls.target);
    const scale = Math.max(0.02, dist * 0.02);
    pivotSprite.scale.setScalar(scale);
  };

  return {
    /**
     * Appelé chaque frame par threeEngine.
     * Retourne true si la scène a changé (rendu nécessaire).
     */
    update(delta) {
      // Animation douce du pivot → aucune téléportation
      if (_pivotGoal) {
        const t = Math.min(PIVOT_SPEED * delta, 1);
        controls.target.lerp(_pivotGoal, t);
        if (controls.target.distanceTo(_pivotGoal) < 0.001) {
          controls.target.copy(_pivotGoal);
          _pivotGoal = null;
        }
      }

      // Animation du rayon (touche F – recadrage du modèle)
      // On réduit/augmente la distance caméra→pivot en préservant l'angle de vue.
      if (_radiusGoal !== null) {
        const offset  = _tmpOffset.copy(camera.position).sub(controls.target);
        const current = offset.length();
        const next    = current + ((_radiusGoal - current) * Math.min(RADIUS_SPEED * delta, 1));
        camera.position.copy(controls.target).addScaledVector(offset.normalize(), next);
        if (Math.abs(next - _radiusGoal) < 0.01) _radiusGoal = null;
      }

      controls.update();
      updatePivotSprite();

      // Lire _changed APRÈS controls.update() (l'event 'change' est émis dedans)
      const changed = _changed || (_pivotGoal !== null) || (_radiusGoal !== null);
      _changed = false;
      return changed;
    },

    dispose() {
      el.removeEventListener('dblclick', onDblClick);
      window.removeEventListener('keydown', onKeyDown);
      controls.removeEventListener('change', onControlsChange);
      if (pivotSprite.parent) pivotSprite.parent.remove(pivotSprite);
      pivotSprite.material.map?.dispose(); // libère la CanvasTexture (VRAM)
      pivotSprite.material.dispose();
      controls.dispose();
    },
  };
}

// ── Sprite de visualisation du pivot ─────────────────────────────────────────
function makePivotSprite() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width  = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const cx  = size / 2;
  const arm = size * 0.38;
  const w   = size * 0.06;

  ctx.clearRect(0, 0, size, size);

  // Contour blanc
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth   = w + 2;
  ctx.lineCap     = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - arm, cx); ctx.lineTo(cx + arm, cx);
  ctx.moveTo(cx, cx - arm); ctx.lineTo(cx, cx + arm);
  ctx.stroke();

  // Trait coloré
  ctx.strokeStyle = '#ff6b00';
  ctx.lineWidth   = w;
  ctx.beginPath();
  ctx.moveTo(cx - arm, cx); ctx.lineTo(cx + arm, cx);
  ctx.moveTo(cx, cx - arm); ctx.lineTo(cx, cx + arm);
  ctx.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  const mat     = new THREE.SpriteMaterial({
    map:         texture,
    depthTest:   false,
    transparent: true,
    opacity:     0.9,
  });
  return new THREE.Sprite(mat);
}
