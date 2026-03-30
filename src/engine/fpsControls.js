import * as THREE from 'three';
import { Octree } from 'three/addons/math/Octree.js';
import { Capsule } from 'three/addons/math/Capsule.js';

// ── Constantes physiques (style Source Engine / CS:GO) ───────────────────────
const MAX_SPEED       = 20;   // vitesse max au sol (unités/s)
const GROUND_ACCEL    = 50;  // accélération au sol – grande valeur = démarrage quasi-instantané
const GROUND_FRICTION = 5;    // friction au sol – arrêt net sans être trop abrupt
const STOP_SPEED      = 3;    // vitesse plancher pour le calcul de friction (évite la glisse)
const AIR_ACCEL       = 8;    // accélération en l'air (permet le strafing directionnel)
const AIR_SPEED_CAP   = 6;    // cap de la vitesse souhaitée en l'air (limite le gain horizontal)
const GRAVITY         = 30;
const JUMP_VELOCITY   = 12;
const STEPS_PER_FRAME = 5;    // sous-pas physique pour la stabilité

// ── Constantes de zoom (molette / trackpad) ───────────────────────────────────
const FOV_NORMAL     = 75;  // champ de vision par défaut (degrés)
const FOV_MIN        = 10;  // zoom maximum (téléobjectif)
const FOV_MAX        = 90;  // zoom minimum (grand angle)
const FOV_LERP_SPEED = 10;  // vitesse de transition FOV (transitions/s)

// ── Fonction accelerate() – cœur du modèle Quake/Source ─────────────────────
//
// Principe : on projette la vélocité actuelle sur la direction souhaitée.
// On n'accélère que pour combler le manque → pas de dépassement de vitesse,
// et le changement de direction est fluide (air-strafing possible).
//
//   vel       : THREE.Vector3 – modifié en place
//   wishDir   : THREE.Vector3 normalisé
//   wishSpeed : vitesse cible (unités/s)
//   accel     : taux d'accélération
//   dt        : pas de temps (s)
//
function accelerate(vel, wishDir, wishSpeed, accel, dt) {
  const currentSpeed = vel.dot(wishDir); // projection sur la direction souhaitée
  const addSpeed = wishSpeed - currentSpeed;
  if (addSpeed <= 0) return; // déjà assez rapide dans cette direction

  const accelAmount = Math.min(accel * wishSpeed * dt, addSpeed);
  vel.addScaledVector(wishDir, accelAmount);
}

// ── Friction linéaire (style Source) ─────────────────────────────────────────
// Contrairement à la version exponentielle du code d'origine, la friction
// linéaire donne un arrêt net et prévisible – caractéristique du feel CS:GO.
//
function applyFriction(vel, dt) {
  const speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z); // horizontal uniquement
  if (speed < 0.001) { vel.x = 0; vel.z = 0; return; }

  const drop = Math.max(speed, STOP_SPEED) * GROUND_FRICTION * dt;
  const newSpeed = Math.max(0, speed - drop);
  const scale = newSpeed / speed;
  vel.x *= scale;
  vel.z *= scale;
}

// ── Calcul de la direction souhaitée depuis les touches ───────────────────────
// On combine avant/arrière + gauche/droite en un seul vecteur normalisé,
// pour que les diagonales n'aillent pas plus vite (erreur classique).
//
const _camDir       = new THREE.Vector3();
const _camRight     = new THREE.Vector3();
const _wishDir      = new THREE.Vector3();
const _tmpTranslate = new THREE.Vector3(); // vecteur réutilisé dans la boucle physique (évite le GC)

function computeWishDir(camera, keys) {
  camera.getWorldDirection(_camDir);
  _camDir.y = 0;
  _camDir.normalize();

  // Droite = forward × up
  _camRight.crossVectors(_camDir, camera.up).normalize();

  let fwd = 0, side = 0;
  if (keys['KeyW'] || keys['ArrowUp'])    fwd  += 1;
  if (keys['KeyS'] || keys['ArrowDown'])  fwd  -= 1;
  if (keys['KeyD'] || keys['ArrowRight']) side += 1;
  if (keys['KeyA'] || keys['ArrowLeft'])  side -= 1;

  _wishDir
    .set(0, 0, 0)
    .addScaledVector(_camDir,   fwd)
    .addScaledVector(_camRight, side);

  const len = _wishDir.length();
  if (len > 0) _wishDir.divideScalar(len); // normalise, évite la vitesse diagonale ×√2

  return _wishDir;
}

/**
 * Crée un objet de contrôles FPS style CS:GO.
 *
 * @param {THREE.Camera}        camera
 * @param {THREE.WebGLRenderer} renderer
 * @param {Octree|null}         octree        – octree pré-construit par sceneManager
 * @param {THREE.Vector3}       startPosition
 * @returns {{ update(delta:number):void, dispose():void }}
 */
export function createFPSControls(camera, renderer, octree, startPosition) {
  const worldOctree = octree ?? new Octree();

  // ── Capsule joueur ────────────────────────────────────────────────────────
  const playerCollider = new Capsule(
    new THREE.Vector3(0, 0.35, 0), // bas (pieds)
    new THREE.Vector3(0, 1.6,  0), // haut (yeux)
    0.35                           // rayon
  );
  playerCollider.translate(startPosition ?? new THREE.Vector3(0, 10, 0));

  const playerVelocity = new THREE.Vector3();
  let playerOnFloor = false;

  camera.rotation.order = 'YXZ';
  camera.fov = FOV_NORMAL;
  camera.position.copy(playerCollider.end);

  // ── Clavier ───────────────────────────────────────────────────────────────
  const keys = {};

  const onKeyDown = (e) => { keys[e.code] = true; };
  const onKeyUp   = (e) => { keys[e.code] = false; };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup',   onKeyUp);

  // ── Pointer lock ──────────────────────────────────────────────────────────
  const onClick = () => renderer.domElement.requestPointerLock();
  renderer.domElement.addEventListener('click', onClick);

  // ── Zoom molette / trackpad ───────────────────────────────────────────────
  // La molette ajuste le FOV cible. La transition est lissée dans update().
  // Normalisation deltaMode : pixel (trackpad) → petits incréments ;
  //                           line  (souris)   → grands incréments par cran.
  let targetFOV = FOV_NORMAL;
  let currentFOV = FOV_NORMAL;

  const onWheel = (e) => {
    if (document.pointerLockElement !== renderer.domElement) return;
    e.preventDefault();
    const step = e.deltaMode === 0 ? e.deltaY * 0.05 : e.deltaY * 3;
    targetFOV = Math.max(FOV_MIN, Math.min(FOV_MAX, targetFOV + step));
  };
  // passive:false obligatoire pour pouvoir appeler preventDefault()
  window.addEventListener('wheel', onWheel, { passive: false });

  // Sensibilité souris proportionnelle au FOV :
  // plus le zoom est fort, plus le mouvement est précis (comme une vraie optique).
  const onMouseMove = (e) => {
    if (document.pointerLockElement !== renderer.domElement) return;
    const sens = 0.002 * (currentFOV / FOV_NORMAL);
    camera.rotation.y -= e.movementX * sens;
    camera.rotation.x -= e.movementY * sens;
    camera.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, camera.rotation.x));
  };
  document.addEventListener('mousemove', onMouseMove);

  // ── Collision capsule ↔ octree ────────────────────────────────────────────
  const resolveCollisions = () => {
    const result = worldOctree.capsuleIntersect(playerCollider);
    playerOnFloor = false;
    if (result) {
      playerOnFloor = result.normal.y > 0;
      if (!playerOnFloor) {
        // Annule la composante de vélocité dans le mur (glissement propre)
        playerVelocity.addScaledVector(result.normal, -result.normal.dot(playerVelocity));
      }
      if (result.depth >= 1e-10) {
        playerCollider.translate(result.normal.multiplyScalar(result.depth));
      }
    }
  };

  // ── Sous-pas physique ─────────────────────────────────────────────────────
  const stepPhysics = (dt) => {
    const wishDir  = computeWishDir(camera, keys);
    const hasInput = wishDir.lengthSq() > 0;

    if (playerOnFloor) {
      // 1. Friction horizontale (arrêt net)
      applyFriction(playerVelocity, dt);

      // 2. Accélération au sol (quasi-instantanée grâce à GROUND_ACCEL élevé)
      if (hasInput) {
        accelerate(playerVelocity, wishDir, MAX_SPEED, GROUND_ACCEL, dt);
      }

      // 3. Saut – déclenché à chaque sous-pas où Space est tenu ET on est au sol
      //    (auto-bhop : maintenir Space suffit pour rebondir en atterrissant)
      if (keys['Space']) {
        playerVelocity.y = JUMP_VELOCITY;
        playerOnFloor = false; // évite une double-résolution dans ce même pas
      }

    } else {
      // 1. Gravité
      playerVelocity.y -= GRAVITY * dt;

      // 2. Air-strafe : accélère latéralement mais cap bas pour ne pas voler
      if (hasInput) {
        accelerate(playerVelocity, wishDir, AIR_SPEED_CAP, AIR_ACCEL, dt);
      }
    }

    // 3. Déplacer + résoudre les collisions
    playerCollider.translate(_tmpTranslate.copy(playerVelocity).multiplyScalar(dt));
    resolveCollisions();

    // 4. Synchroniser la caméra avec la tête
    camera.position.copy(playerCollider.end);
  };

  // ── Interface publique ────────────────────────────────────────────────────
  return {
    update(delta) {
      // Physique en sous-pas
      const dt = Math.min(0.05, delta) / STEPS_PER_FRAME;
      for (let i = 0; i < STEPS_PER_FRAME; i++) {
        stepPhysics(dt);
      }

      // Transition FOV (lissée, en dehors des sous-pas physiques)
      currentFOV += (targetFOV - currentFOV) * Math.min(FOV_LERP_SPEED * delta, 1);
      if (Math.abs(currentFOV - camera.fov) > 0.01) {
        camera.fov = currentFOV;
        camera.updateProjectionMatrix();
      }

      return true; // la caméra peut bouger à chaque frame → rendu systématique
    },

    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup',   onKeyUp);
      window.removeEventListener('wheel',   onWheel);
      renderer.domElement.removeEventListener('click', onClick);
      document.removeEventListener('mousemove', onMouseMove);
      if (document.pointerLockElement === renderer.domElement) {
        document.exitPointerLock();
      }
      // Réinitialise le FOV pour ne pas polluer les autres modes
      camera.fov = FOV_NORMAL;
      camera.updateProjectionMatrix();
    },
  };
}
