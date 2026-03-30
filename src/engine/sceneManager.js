import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { Octree } from 'three/addons/math/Octree.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { modelGroup, getCamera, getRenderer, setControls, getLightingManager, requestRender, fitCameraToScene, setOnBeforeRender } from './threeEngine.js';
import { createFPSControls } from './fpsControls.js';
import { createOrbitControls } from './orbitControls.js';
import { createToggleControls } from './toggleControls.js';
import { loadGeoJSON, disposeGeoJSONGroup, geoToScene } from './geojsonLoader.js';
import { createArchScene, stepPhysics, destroyArchScene } from './physicsScene.js';
import { loadDaeScene, stepDae, destroyDaeScene } from './daeScene.js';

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('/draco/gltf/');
const loader = new GLTFLoader();
loader.setDRACOLoader(dracoLoader);

// ── Cache des GLTFs (LRU, max 3 modèles en VRAM) ─────────────────────────────
// Les modèles déjà chargés sont conservés en mémoire pour ré-affichage instantané.
// Au-delà de MAX_CACHE_SIZE, le moins récemment utilisé est disposé (VRAM libérée).
const MAX_CACHE_SIZE = 3;
const gltfCache  = new Map();  // path → gltf
const cacheOrder = [];         // LRU : moins récent en tête

// ── Cache des Octrees (par pageId) ────────────────────────────────────────────
// Un octree est invalide si l'un de ses GLTFs a été évincé ; il est alors
// supprimé automatiquement et reconstruit à la prochaine visite.
const octreeCache = new Map(); // pageId → { octree: Octree, paths: Set<string> }

// ── Cache des géométries fusionnées (par pageId) ──────────────────────────────
// Pages avec mergeGeometry:true → tous les meshes (même matériau) sont fusionnés
// en un seul draw call. Le résultat est mis en cache pour ré-affichage instantané.
// Invalidé automatiquement si l'un de ses GLTFs est évincé du LRU.
const mergedCache = new Map(); // pageId → { group: THREE.Group, paths: Set<string> }

function disposeMerged(entry) {
  entry.group.traverse((child) => {
    if (child.isMesh) child.geometry.dispose(); // géométries seulement (matériaux = gltfCache)
  });
}

// Dispose explicite d'un objet — couvre toutes les maps PBR standard et avancées
// (MeshStandardMaterial + MeshPhysicalMaterial : clearcoat, sheen, transmission…)
function disposeObject(obj) {
  const TEXTURE_MAPS = [
    // Standard PBR
    'map', 'normalMap', 'roughnessMap', 'metalnessMap',
    'emissiveMap', 'aoMap', 'envMap', 'bumpMap',
    'displacementMap', 'alphaMap', 'lightMap',
    // MeshPhysicalMaterial
    'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap',
    'sheenColorMap', 'sheenRoughnessMap',
    'specularIntensityMap', 'specularColorMap',
    'transmissionMap', 'thicknessMap',
    'iridescenceMap', 'iridescenceThicknessMap',
  ];
  obj.traverse((child) => {
    if (child.isMesh) {
      child.geometry.dispose();
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((m) => {
        TEXTURE_MAPS.forEach((key) => { if (m[key]) m[key].dispose(); });
        m.dispose();
      });
    }
  });
}

function updateLRU(path) {
  const idx = cacheOrder.indexOf(path);
  if (idx !== -1) cacheOrder.splice(idx, 1);
  cacheOrder.push(path); // le plus récent en queue
  while (cacheOrder.length > MAX_CACHE_SIZE) {
    const evicted = cacheOrder.shift();
    const old = gltfCache.get(evicted);
    if (old) disposeObject(old.scene);
    gltfCache.delete(evicted);
    // Invalider les octrees et géométries fusionnées qui dépendent du GLTF évincé
    for (const [pageId, entry] of octreeCache) {
      if (entry.paths.has(evicted)) octreeCache.delete(pageId);
    }
    for (const [pageId, entry] of mergedCache) {
      if (entry.paths.has(evicted)) {
        disposeMerged(entry);
        mergedCache.delete(pageId);
      }
    }
  }
}

async function loadGLTFCached(path) {
  if (gltfCache.has(path)) {
    updateLRU(path);
    return gltfCache.get(path);
  }
  const gltf = await new Promise((resolve, reject) => {
    loader.load(path, resolve, undefined, reject);
  });
  gltfCache.set(path, gltf);
  updateLRU(path);
  return gltf;
}

// Pins adaptatifs : groupes dont le scale est mis à jour chaque frame
let activePinGroups = []; // { group: THREE.Group, naturalPoleH: number }
const _pinWorldPos  = new THREE.Vector3(); // pré-alloué, réutilisé chaque frame
const PIN_SCREEN_FRACTION = 0.06; // fraction de la hauteur écran visée pour chaque pin

// Compteur pour annuler les chargements obsolètes si l'utilisateur change de page.
let loadGeneration = 0;
// Drapeau : un chargement est-il en cours ? (utilisé pour le debounce conditionnel)
let isLoading = false;

// Callback appelé par App.jsx pour suivre l'état de chargement
let onLoadingChange = null;
export function setLoadingCallback(cb) { onLoadingChange = cb; }

// Réinitialise la scène physique sans changer de page
export function resetPhysicsScene() {
  import('./physicsScene.js').then(({ resetArchScene }) => {
    resetArchScene();
    requestRender();
  });
}

// ── Nettoyage des modèles actuels ─────────────────────────────────────────────
// On détache du groupe sans disposer : les GLTFs restent dans le cache LRU.
function clearModels() {
  while (modelGroup.children.length > 0) {
    modelGroup.remove(modelGroup.children[0]);
  }
}

// ── Cache des groupes GeoJSON (par URL) ──────────────────────────────────────
// Pas de LRU : les fichiers GeoJSON sont légers, on les conserve en mémoire.
// Invalidé uniquement par clearCache().
const geojsonCache = new Map(); // key → { group: THREE.Group, center: [cLon, cLat] }

async function loadGeoJSONCached(url, addGround) {
  const key = addGround ? url : `${url}::no-ground`;
  if (geojsonCache.has(key)) return geojsonCache.get(key);
  const result = await loadGeoJSON(url, { addGround });
  geojsonCache.set(key, result);
  return result;
}

// Vide complètement le cache et libère la VRAM.
export function clearCache() {
  for (const entry of mergedCache.values()) disposeMerged(entry);
  mergedCache.clear();
  for (const { group } of geojsonCache.values()) disposeGeoJSONGroup(group);
  geojsonCache.clear();
  for (const gltf of gltfCache.values()) {
    disposeObject(gltf.scene);
  }
  gltfCache.clear();
  cacheOrder.length = 0;
  octreeCache.clear();
}

// ── Fusion de géométries statiques ────────────────────────────────────────────
// Regroupe les meshes de sourceGroup par matériau + jeu d'attributs, bake leurs
// transforms world en géométrie et fusionne → 1 draw call par matériau unique.
// SkinnedMesh ignorés (transforms non-linéaires).
function buildMergedGroup(sourceGroup) {
  const byKey = new Map(); // `${mat.uuid}::${attrKeys}` → { material, geometries[], castShadow, receiveShadow }

  sourceGroup.traverse((child) => {
    if (!child.isMesh || child.isSkinnedMesh) return;
    child.updateWorldMatrix(true, false);
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    mats.forEach((mat) => {
      const attrKeys = Object.keys(child.geometry.attributes).sort().join(',');
      const key = `${mat.uuid}::${attrKeys}`;
      if (!byKey.has(key)) {
        byKey.set(key, { material: mat, geometries: [], castShadow: child.castShadow, receiveShadow: child.receiveShadow });
      }
      const geo = child.geometry.clone();
      geo.applyMatrix4(child.matrixWorld); // bake le transform world
      byKey.get(key).geometries.push(geo);
    });
  });

  const group = new THREE.Group();
  for (const { material, geometries, castShadow, receiveShadow } of byKey.values()) {
    let merged = null;
    try {
      merged = mergeGeometries(geometries);
    } catch {
      // Attributs incompatibles → fallback meshes individuels (géométries déjà baked)
    }
    if (merged) {
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow    = castShadow;
      mesh.receiveShadow = receiveShadow;
      group.add(mesh);
      geometries.forEach((g) => g.dispose()); // libère les clones intermédiaires
    } else {
      geometries.forEach((geo) => {
        const mesh = new THREE.Mesh(geo, material);
        mesh.castShadow    = castShadow;
        mesh.receiveShadow = receiveShadow;
        group.add(mesh);
      });
    }
  }
  return group;
}

// ── Pin de carte procédural (tige + tête sphérique + label texte) ────────────

function makeTextSprite(text, color) {
  const canvas   = document.createElement('canvas');
  const ctx      = canvas.getContext('2d');
  const fontSize = 64;
  const padding  = 20;
  const radius   = 18;

  ctx.font = `bold ${fontSize}px Arial, sans-serif`;
  const tw = ctx.measureText(text).width;
  canvas.width  = Math.ceil(tw + padding * 2);
  canvas.height = Math.ceil(fontSize + padding * 2);

  // Fond arrondi coloré
  ctx.fillStyle = color ?? '#e63946';
  ctx.beginPath();
  ctx.moveTo(radius, 0);
  ctx.lineTo(canvas.width - radius, 0);
  ctx.quadraticCurveTo(canvas.width, 0, canvas.width, radius);
  ctx.lineTo(canvas.width, canvas.height - radius);
  ctx.quadraticCurveTo(canvas.width, canvas.height, canvas.width - radius, canvas.height);
  ctx.lineTo(radius, canvas.height);
  ctx.quadraticCurveTo(0, canvas.height, 0, canvas.height - radius);
  ctx.lineTo(0, radius);
  ctx.quadraticCurveTo(0, 0, radius, 0);
  ctx.closePath();
  ctx.fill();

  // Texte blanc
  ctx.font         = `bold ${fontSize}px Arial, sans-serif`;
  ctx.fillStyle    = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, padding, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  const mat     = new THREE.SpriteMaterial({ map: texture, depthTest: false });
  const sprite  = new THREE.Sprite(mat);
  // Ratio d'aspect : le sprite fera `labelH` de haut en unités monde
  sprite.userData.aspect = canvas.width / canvas.height;
  return sprite;
}

function createPinMarker(marker) {
  const group  = new THREE.Group();
  const poleH  = marker.poleHeight ?? 30;
  const headR  = poleH * 0.14;
  const color  = marker.color ?? '#e63946';
  const mat    = new THREE.MeshStandardMaterial({ color: new THREE.Color(color) });

  // Tige
  const stemGeo = new THREE.CylinderGeometry(poleH * 0.025, poleH * 0.025, poleH, 8);
  const stem    = new THREE.Mesh(stemGeo, mat);
  stem.position.y = poleH / 2;
  stem.castShadow = true;
  group.add(stem);

  // Tête sphérique
  const headGeo = new THREE.SphereGeometry(headR, 16, 12);
  const head    = new THREE.Mesh(headGeo, mat);
  head.position.y = poleH + headR;
  head.castShadow = true;
  group.add(head);

  // Label texte (sprite billboard)
  if (marker.label) {
    const labelH  = poleH * 0.45;
    const sprite  = makeTextSprite(marker.label, color);
    sprite.scale.set(sprite.userData.aspect * labelH, labelH, 1);
    sprite.position.y = poleH + headR * 2 + labelH * 0.65;
    group.add(sprite);
  }

  return group;
}

// ── Chargement d'une page complète ───────────────────────────────────────────
export async function loadPage(pageConfig) {
  // Page d'aide : vider la scène, aucun modèle ni contrôles 3D.
  if (pageConfig.controls === 'help') {
    clearModels();
    setControls(null);
    requestRender();
    if (onLoadingChange) onLoadingChange(false);
    return;
  }

  const gen = ++loadGeneration;

  // Debounce conditionnel : n'attendre 100 ms que si un chargement est déjà
  // en cours, pour laisser le temps à une navigation rapide de l'annuler.
  // Les navigations vers des pages déjà cachées ne subissent aucun délai.
  if (isLoading) {
    await new Promise((r) => setTimeout(r, 100));
    if (gen !== loadGeneration) return;
  }

  isLoading = true;
  if (onLoadingChange) onLoadingChange(true);

  // 1. Vider la scène et désactiver les contrôles
  destroyArchScene();            // no-op si aucune scène physique active
  destroyDaeScene();             // no-op si aucune scène DAE active
  clearModels();
  modelGroup.scale.set(1, 1, 1); // réinitialise le scale éventuel d'une page GeoJSON précédente
  setControls(null);
  activePinGroups = [];
  setOnBeforeRender(null);

  // 2a. Page physique (cannon-es) ──────────────────────────────────────────────
  if (pageConfig.controls === 'physics') {
    createArchScene(modelGroup);

    const camPhys   = getCamera();
    const rendPhys  = getRenderer();
    const camPos    = pageConfig.cameraPosition
      ? new THREE.Vector3(...pageConfig.cameraPosition)
      : new THREE.Vector3(0, 5, 15);
    const target    = pageConfig.orbitTarget ?? { x: 0, y: 3, z: 0 };
    const orbitPhys = createOrbitControls(camPhys, rendPhys, camPos, target);

    // Combine physics step + orbit dans un seul contrôleur
    setControls({
      update(delta) {
        orbitPhys.update(delta);
        stepPhysics(delta);
        return true; // toujours redessiner tant que la physique tourne
      },
      dispose() {
        orbitPhys.dispose();
        destroyArchScene();
      },
    });

    const lmPhys = getLightingManager();
    if (lmPhys) {
      const boxPhys = new THREE.Box3().setFromObject(modelGroup);
      if (!boxPhys.isEmpty()) {
        lmPhys.fitShadowToScene(boxPhys);
        fitCameraToScene(boxPhys, camPos.length());
      }
    }

    requestRender();
    isLoading = false;
    if (onLoadingChange) onLoadingChange(false);
    return;
  }

  // 2b. Page DAE : charger le fichier Collada avec son animation de caméra
  if (pageConfig.controls === 'dae') {
    let hasCamTrack;
    try {
      ({ hasCamTrack } = await loadDaeScene(pageConfig.dae, modelGroup));
    } catch (err) {
      console.error('[sceneManager] Erreur DAE :', err);
      isLoading = false;
      if (onLoadingChange) onLoadingChange(false);
      return;
    }
    if (gen !== loadGeneration) { isLoading = false; return; }

    const camDae  = getCamera();
    const rendDae = getRenderer();

    // Orbit pour naviguer librement quand l'animation est en pause
    const camPosDae = pageConfig.cameraPosition
      ? new THREE.Vector3(...pageConfig.cameraPosition)
      : new THREE.Vector3(0, 2, 10);
    const targetDae = pageConfig.orbitTarget ?? { x: 0, y: 0, z: 0 };
    const orbitDae  = createOrbitControls(camDae, rendDae, camPosDae, targetDae);

    setControls({
      update(delta) {
        // stepDae passe la caméra Three.js seulement si l'anim pilote la caméra
        const animActive = stepDae(delta, hasCamTrack ? camDae : null);
        // Orbit actif uniquement quand l'animation ne pilote pas la caméra
        if (!animActive) orbitDae.update(delta);
        return animActive;
      },
      dispose() {
        orbitDae.dispose();
        destroyDaeScene();
      },
    });

    const lmDae = getLightingManager();
    if (lmDae) {
      const boxDae = new THREE.Box3().setFromObject(modelGroup);
      if (!boxDae.isEmpty()) {
        lmDae.fitShadowToScene(boxDae);
        fitCameraToScene(boxDae, camPosDae.length());
      }
    }
    if (pageConfig.ambiance && lmDae) lmDae.setAmbiance(pageConfig.ambiance);

    requestRender();
    isLoading = false;
    if (onLoadingChange) onLoadingChange(false);
    return;
  }

  // 2c. Page GeoJSON : charger/parser le fichier GeoJSON à la place des GLTFs
  if (pageConfig.geojson) {
    let rawGroup, center;
    try {
      ({ group: rawGroup, center } = await loadGeoJSONCached(pageConfig.geojson, pageConfig.ground !== false));
    } catch (err) {
      console.error('[sceneManager] Erreur GeoJSON :', err);
      isLoading = false;
      if (onLoadingChange) onLoadingChange(false);
      return;
    }
    if (gen !== loadGeneration) { isLoading = false; return; }

    // Fusion optionnelle des géométries GeoJSON uniquement (hors marqueurs)
    if (pageConfig.mergeGeometry) {
      const cachedMerge = mergedCache.get(pageConfig.id);
      if (cachedMerge) {
        modelGroup.add(cachedMerge.group);
      } else {
        rawGroup.updateMatrixWorld(true);
        const mergedGroup = buildMergedGroup(rawGroup);
        modelGroup.add(mergedGroup);
        mergedCache.set(pageConfig.id, {
          group: mergedGroup,
          paths: new Set([pageConfig.geojson]),
        });
      }
    } else {
      modelGroup.add(rawGroup);
    }

    // ── Marqueurs 3D (modèles GLB ou drapeaux positionnés par lat/lon) ─────────
    if (pageConfig.markers?.length) {
      const flagMarkers = pageConfig.markers.filter((m) => m.flag || !m.path);
      const gltfMarkers = pageConfig.markers.filter((m) => !m.flag && m.path);

      let markerGLTFs = [];
      if (gltfMarkers.length) {
        try {
          markerGLTFs = await Promise.all(gltfMarkers.map((m) => loadGLTFCached(m.path)));
        } catch (err) {
          console.warn('[sceneManager] Erreur marqueur :', err);
        }
      }
      if (gen !== loadGeneration) { isLoading = false; return; }

      markerGLTFs.forEach((gltf, i) => {
        const marker = gltfMarkers[i];
        const root   = gltf.scene;
        root.position.copy(geoToScene(marker.lon, marker.lat, center[0], center[1], marker.altitude ?? 0));
        if (marker.scale    != null) root.scale.setScalar(marker.scale);
        if (marker.rotation)         root.rotation.set(...marker.rotation);
        root.traverse((child) => {
          if (child.isMesh) {
            child.castShadow    = pageConfig.shadows !== false;
            child.receiveShadow = pageConfig.shadows !== false;
          }
        });
        modelGroup.add(root);
      });

      flagMarkers.forEach((marker) => {
        const naturalPoleH = marker.poleHeight ?? 30;
        const pin = createPinMarker(marker);
        pin.position.copy(geoToScene(marker.lon, marker.lat, center[0], center[1], marker.altitude ?? 0));
        modelGroup.add(pin);
        activePinGroups.push({ group: pin, naturalPoleH });
      });

      if (activePinGroups.length > 0) {
        setOnBeforeRender(() => {
          const cam        = getCamera();
          const tan2       = 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
          const pageScaleX = modelGroup.scale.x || 1;
          for (const { group, naturalPoleH } of activePinGroups) {
            group.getWorldPosition(_pinWorldPos);
            const dist     = cam.position.distanceTo(_pinWorldPos);
            const desired  = dist * tan2 * PIN_SCREEN_FRACTION;
            group.scale.setScalar(desired / (pageScaleX * naturalPoleH));
          }
        });
      }
    }

    // Appliquer le scale global de la carte (ex. 0.001 pour passer de mètres à km)
    if (pageConfig.scale != null) modelGroup.scale.setScalar(pageConfig.scale);

    // Désactiver les ombres si demandé (sans muter le groupe caché partagé)
    if (pageConfig.shadows === false) {
      modelGroup.traverse((child) => {
        if (child.isMesh || child.isLine) {
          child.castShadow    = false;
          child.receiveShadow = false;
        }
      });
    }

    const camGeo  = getCamera();
    const rendGeo = getRenderer();
    const camPos  = pageConfig.cameraPosition
      ? new THREE.Vector3(...pageConfig.cameraPosition)
      : new THREE.Vector3(0, 150, 200);
    const target  = pageConfig.orbitTarget ?? { x: 0, y: 0, z: 0 };

    const lmGeo = getLightingManager();
    if (lmGeo) {
      const boxGeo = new THREE.Box3().setFromObject(modelGroup);
      if (!boxGeo.isEmpty()) {
        if (pageConfig.shadows !== false) lmGeo.fitShadowToScene(boxGeo);
        fitCameraToScene(boxGeo, camPos.length()); // tient compte de la distance caméra
      }
    }

    setControls(createOrbitControls(camGeo, rendGeo, camPos, target));

    if (pageConfig.ambiance && lmGeo) lmGeo.setAmbiance(pageConfig.ambiance);
    requestRender();
    isLoading = false;
    if (onLoadingChange) onLoadingChange(false);
    return;
  }

  // 2. Charger tous les modèles en parallèle (cache si déjà visité)
  let loadedGLTFs;
  try {
    loadedGLTFs = await Promise.all(
      pageConfig.models.map((m) => loadGLTFCached(m.path))
    );
  } catch (err) {
    console.error('[sceneManager] Erreur de chargement :', err);
    isLoading = false;
    if (onLoadingChange) onLoadingChange(false);
    return;
  }

  // Si une nouvelle navigation a eu lieu pendant le chargement, on abandonne
  if (gen !== loadGeneration) {
    isLoading = false;
    return;
  }

  // 3. Appliquer les transforms à chaque root GLTF
  loadedGLTFs.forEach((gltf, i) => {
    const cfg  = pageConfig.models[i];
    const root = gltf.scene;

    if (cfg.position) root.position.set(...cfg.position);
    if (cfg.rotation) root.rotation.set(...cfg.rotation);
    if (cfg.scale !== undefined) root.scale.setScalar(cfg.scale);

    root.traverse((child) => {
      if (child.isMesh) {
        child.castShadow    = (pageConfig.shadows !== false) && (cfg.castShadow    ?? true);
        child.receiveShadow = (pageConfig.shadows !== false) && (cfg.receiveShadow ?? true);
      }
    });
  });

  // 4. Octree (FPS / toggle) : réutilisé depuis le cache si disponible,
  //    reconstruit uniquement à la première visite ou après une éviction LRU.
  const needsOctree = pageConfig.controls === 'fps' || pageConfig.controls === 'toggle';
  let builtOctree = null;
  if (needsOctree) {
    const cached = octreeCache.get(pageConfig.id);
    if (cached) {
      builtOctree = cached.octree;
    } else {
      builtOctree = new Octree();
      const paths = new Set();
      loadedGLTFs.forEach((gltf, i) => {
        if (pageConfig.models[i].enableCollisions) {
          paths.add(pageConfig.models[i].path);
          gltf.scene.updateMatrixWorld(true);
          builtOctree.fromGraphNode(gltf.scene);
        }
      });
      octreeCache.set(pageConfig.id, { octree: builtOctree, paths });
    }
  }

  // 5. Ajouter tous les modèles au groupe de la scène
  //    Si mergeGeometry est activé : fusionne les meshes statiques par matériau
  //    pour réduire le nombre de draw calls (pages orbit/visualisation uniquement).
  if (pageConfig.mergeGeometry) {
    const cachedMerge = mergedCache.get(pageConfig.id);
    if (cachedMerge) {
      modelGroup.add(cachedMerge.group);
    } else {
      loadedGLTFs.forEach((gltf) => modelGroup.add(gltf.scene));
      modelGroup.updateMatrixWorld(true);
      const mergedGroup = buildMergedGroup(modelGroup);
      clearModels();
      modelGroup.add(mergedGroup);
      mergedCache.set(pageConfig.id, {
        group: mergedGroup,
        paths: new Set(pageConfig.models.map((m) => m.path)),
      });
    }
  } else {
    loadedGLTFs.forEach((gltf) => modelGroup.add(gltf.scene));
  }

  // 6. Adapter le frustum de la shadow camera et le camera.far à la scène
  const lm = getLightingManager();
  if (lm) {
    const box = new THREE.Box3().setFromObject(modelGroup);
    if (!box.isEmpty()) {
      lm.fitShadowToScene(box);
      fitCameraToScene(box); // ajuste camera.far pour éviter le clipping
    }
  }

  // 7. Activer les bons contrôles
  const camera   = getCamera();
  const renderer = getRenderer();

  if (pageConfig.controls === 'fps') {
    const startPos = pageConfig.startPosition
      ? new THREE.Vector3(...pageConfig.startPosition)
      : new THREE.Vector3(0, 10, 0);
    setControls(createFPSControls(camera, renderer, builtOctree, startPos));
  } else if (pageConfig.controls === 'toggle') {
    const startPos = pageConfig.startPosition
      ? new THREE.Vector3(...pageConfig.startPosition)
      : new THREE.Vector3(0, 2, 10);
    const camPos = pageConfig.cameraPosition
      ? new THREE.Vector3(...pageConfig.cameraPosition)
      : new THREE.Vector3(10, 8, 20);
    const target = pageConfig.orbitTarget ?? { x: 0, y: 0, z: 0 };
    setControls(createToggleControls(camera, renderer, builtOctree, {
      startPosition:  startPos,
      cameraPosition: camPos,
      orbitTarget:    target,
    }));
  } else {
    const camPos = pageConfig.cameraPosition
      ? new THREE.Vector3(...pageConfig.cameraPosition)
      : new THREE.Vector3(0, 2, 10);
    const target = pageConfig.orbitTarget ?? { x: 0, y: 0, z: 0 };
    setControls(createOrbitControls(camera, renderer, camPos, target));
  }

  // 8. Ambiance lumineuse (transition douce si définie dans le JSON)
  if (pageConfig.ambiance && lm) lm.setAmbiance(pageConfig.ambiance);

  // 9. Demander un rendu immédiat
  requestRender();

  isLoading = false;
  if (onLoadingChange) onLoadingChange(false);
}
