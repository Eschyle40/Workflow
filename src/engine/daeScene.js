import * as THREE from 'three';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';
import { requestRender } from './threeEngine.js';

const colladaLoader = new ColladaLoader();

// ── État de la scène DAE active ───────────────────────────────────────────────
let mixer        = null;
let action       = null;
let duration     = 0;
let isPlaying    = false;
let currentTime  = 0;
let loadedRoot   = null; // root THREE.Object3D du collada
let hasCamTrack  = false; // l'animation pilote-t-elle une caméra ?

// Callbacks vers React (DaePlayer)
let onTimeUpdate = null; // (currentTime, duration) => void
let onPlayState  = null; // (isPlaying) => void

export function setDaeCallbacks(cbTime, cbPlay) {
  onTimeUpdate = cbTime;
  onPlayState  = cbPlay;
}

// ── Chargement ────────────────────────────────────────────────────────────────
export async function loadDaeScene(path, modelGroup) {
  destroyDaeScene();

  const collada = await new Promise((resolve, reject) => {
    colladaLoader.load(path, resolve, undefined, reject);
  });

  // Le viewer cherche les clips dans scene.animations ET collada.animations
  const root  = collada.scene;
  const clips = (root.animations?.length ? root.animations : null)
             ?? collada.animations
             ?? [];

  // DoubleSide sur tous les matériaux (corrige les faces dont les normales sont inversées)
  root.traverse((o) => {
    if (o.isMesh) {
      o.castShadow    = true;
      o.receiveShadow = true;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => { if (m) m.side = THREE.DoubleSide; });
    }
  });

  modelGroup.add(root);
  loadedRoot = root;

  // ── Mixer + action ────────────────────────────────────────────────────────
  if (clips.length > 0) {
    mixer    = new THREE.AnimationMixer(root);
    duration = clips[0].duration;
    action   = mixer.clipAction(clips[0]);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    // Démarrer en pause au temps 0
    action.play();
    action.paused = true;

    // L'animation pilote-t-elle une caméra ? (même détection que le viewer)
    hasCamTrack = clips[0].tracks.some((t) =>
      t.name.toLowerCase().includes('position') ||
      t.name.toLowerCase().includes('quaternion')
    );
  }

  currentTime = 0;
  isPlaying   = false;
  if (onTimeUpdate) onTimeUpdate(0, duration);
  if (onPlayState)  onPlayState(false);

  return { duration, hasCamTrack };
}

// ── Mise à jour chaque frame (appelée via setOnBeforeRender dans sceneManager) ─
// Retourne true si un rendu est nécessaire ce frame.
export function stepDae(dt, threeCamera) {
  if (!mixer) return false;

  if (isPlaying) {
    // Avance le mixer de façon incrémentale (comme le viewer : animMixer.update(dt))
    mixer.update(dt);
    currentTime = Math.min(mixer.time, duration);

    // Override caméra Three.js : cherche la caméra dans la scène DAE
    if (hasCamTrack && threeCamera && loadedRoot) {
      loadedRoot.traverse((o) => {
        if (o.isCamera) {
          threeCamera.position.copy(o.getWorldPosition(new THREE.Vector3()));
          threeCamera.quaternion.copy(o.getWorldQuaternion(new THREE.Quaternion()));
        }
      });
    }

    if (onTimeUpdate) onTimeUpdate(currentTime, duration);

    // Fin de clip → passage en pause
    if (currentTime >= duration) {
      isPlaying = false;
      if (onPlayState) onPlayState(false);
    }

    return true;
  }

  return false;
}

// ── Contrôles de lecture ──────────────────────────────────────────────────────
export function daePlay() {
  if (!action || currentTime >= duration) return;
  action.paused = false;
  isPlaying     = true;
  if (onPlayState) onPlayState(true);
  requestRender();
}

export function daePause() {
  if (!action) return;
  action.paused = true;
  isPlaying     = false;
  if (onPlayState) onPlayState(false);
}

export function daeTogglePlay() {
  if (isPlaying) daePause(); else daePlay();
}

export function daeSeek(time) {
  if (!mixer || !action) return;
  const t = Math.max(0, Math.min(time, duration));
  // Pause + setTime absolu (comme le viewer : animAction.paused + animMixer.setTime)
  action.paused = true;
  mixer.setTime(t);
  currentTime = t;
  if (onTimeUpdate) onTimeUpdate(currentTime, duration);
  requestRender();
}

export function daeRestart() {
  daeSeek(0);
  daePlay();
}

export function getDaeIsPlaying() { return isPlaying; }
export function getDaeDuration()  { return duration; }
export function getDaeTime()      { return currentTime; }

// ── Nettoyage ─────────────────────────────────────────────────────────────────
export function destroyDaeScene() {
  if (mixer) {
    if (action) action.stop();
    mixer.stopAllAction();
    mixer.uncacheRoot(mixer.getRoot?.() ?? loadedRoot);
    mixer = null;
  }
  action      = null;
  loadedRoot  = null;
  duration    = 0;
  currentTime = 0;
  isPlaying   = false;
  hasCamTrack = false;
  onTimeUpdate = null;
  onPlayState  = null;
}
