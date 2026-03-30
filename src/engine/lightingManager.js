import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';

// ── Presets d'ambiance ────────────────────────────────────────────────────────
//
// hemisphere – HemisphereLight : simule le ciel (sky) et le rebond sol (ground)
// sun        – DirectionalLight principale (soleil)
// background – couleur de fond de la scène
// fog        – THREE.Fog { color, near, far } ou null
// envIntensity – intensité de l'IBL (image-based lighting via scene.environment)
// exposure   – toneMappingExposure du renderer (post-processing global)
//
const PRESETS = {

  // ── Jour standard (extérieur, lumière médiane) ───────────────────────────────
  neutral: {
    hemisphere:   { sky: 0xc8dff5, ground: 0x8f7e5e, intensity: 0.6 },
    sun:          { color: 0xfff4e0, intensity: 4,   position: [8, 20, 5]    },
    background:   null, // → ciel EXR
    fog:          null,
    envIntensity: 1.0,
    exposure:     1.0,
  },

  // ── Heure dorée / coucher de soleil ─────────────────────────────────────────
  warm: {
    hemisphere:   { sky: 0xff9040, ground: 0x5c2a0a, intensity: 0.5 },
    sun:          { color: 0xff8c20, intensity: 6,   position: [12, 4, 5]   },
    background:   0xd45000,
    fog:          { color: 0xb83800, near: 30, far: 100 },
    envIntensity: 0.6,
    exposure:     1.3,
  },

  // ── Ciel couvert / hiver (lumière douce et diffuse) ──────────────────────────
  cold: {
    hemisphere:   { sky: 0xd8eaff, ground: 0x6080a0, intensity: 0.8 },
    sun:          { color: 0xe0eeff, intensity: 2.5, position: [2, 20, 0]   },
    background:   0x90b0d0,
    fog:          { color: 0x9bbce0, near: 50, far: 180 },
    envIntensity: 1.5,
    exposure:     0.85,
  },

  // ── Studio noir, fort contraste (éclairage de galerie) ──────────────────────
  dramatic: {
    hemisphere:   { sky: 0x111111, ground: 0x000000, intensity: 0.03 },
    sun:          { color: 0xffffff, intensity: 20,  position: [5, 10, 2]   },
    background:   0x040404,
    fog:          null,
    envIntensity: 0.03,
    exposure:     0.65,
  },

  // ── Nuit (clair de lune) ────────────────────────────────────────────────────
  night: {
    hemisphere:   { sky: 0x0a1528, ground: 0x040810, intensity: 0.12 },
    sun:          { color: 0x4060aa, intensity: 0.4, position: [-4, 12, -8] },
    background:   0x010306,
    fog:          { color: 0x060c18, near: 18, far: 65 },
    envIntensity: 0.04,
    exposure:     0.5,
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function smoothstep(t) { return t * t * (3 - 2 * t); }
function lerp(a, b, t)  { return a + (b - a) * t; }

function toColor(v) {
  return v instanceof THREE.Color ? v.clone() : new THREE.Color(v);
}

/** Convertit un preset brut en objets Three.js prêts à l'interpolation. */
function livePreset(p) {
  return {
    hemisphere: {
      sky:       toColor(p.hemisphere.sky),
      ground:    toColor(p.hemisphere.ground),
      intensity: p.hemisphere.intensity,
    },
    sun: {
      color:     toColor(p.sun.color),
      intensity: p.sun.intensity,
      position:  new THREE.Vector3(...p.sun.position),
    },
    background:   p.background !== null ? toColor(p.background) : null,
    fog:          p.fog ? { color: toColor(p.fog.color), near: p.fog.near, far: p.fog.far } : null,
    envIntensity: p.envIntensity,
    exposure:     p.exposure,
  };
}

// ── LightingManager ───────────────────────────────────────────────────────────

export class LightingManager {
  #scene;
  #renderer;
  #hemi;         // HemisphereLight  (ciel / sol)
  #sun;          // DirectionalLight (soleil + ombres)
  #envMap;       // PMREMEnvironment texture (IBL)
  #skyTexture;   // Texture EXR équirectangulaire (fond de ciel)
  #current    = 'neutral';
  #transition = null; // { from, to, duration, elapsed }

  constructor(scene, renderer) {
    this.#scene    = scene;
    this.#renderer = renderer;

    // ── Image Based Lighting (IBL) + ciel EXR ──────────────────────────────
    // Fallback procédural le temps que l'EXR se charge.
    const pmremFallback  = new THREE.PMREMGenerator(renderer);
    this.#envMap         = pmremFallback.fromScene(new RoomEnvironment()).texture;
    pmremFallback.dispose();
    scene.environment    = this.#envMap;

    new EXRLoader().load('/autumn_field_puresky_1k.exr', (texture) => {
      texture.mapping  = THREE.EquirectangularReflectionMapping;
      this.#skyTexture = texture;

      // Différer la génération PMREM (calcul GPU lourd) au prochain moment
      // d'inactivité du navigateur pour ne pas bloquer le rendu initial.
      const applyPMREM = () => {
        const pmrem  = new THREE.PMREMGenerator(renderer);
        const envMap = pmrem.fromEquirectangular(texture).texture;
        pmrem.dispose();
        if (this.#envMap) this.#envMap.dispose();
        this.#envMap      = envMap;
        scene.environment = envMap;
        if (this.#current === 'neutral') scene.background = texture;
      };

      if (typeof requestIdleCallback !== 'undefined') {
        requestIdleCallback(applyPMREM, { timeout: 2000 });
      } else {
        setTimeout(applyPMREM, 0);
      }
    });

    // ── Lumière hémisphérique (ciel / rebond sol) ───────────────────────────
    // Remplace l'AmbientLight plate : produit un dégradé directionnel réaliste.
    this.#hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 0.6);

    // ── Soleil (DirectionalLight avec ombres VSM) ───────────────────────────
    this.#sun = new THREE.DirectionalLight(0xffffff, 4);
    this.#sun.position.set(8, 20, 5);
    this.#sun.castShadow            = true;
    this.#sun.shadow.mapSize.set(1024, 1024);
    this.#sun.shadow.bias           = -0.001;
    this.#sun.shadow.normalBias     = 0.02; // réduit les artefacts sur surfaces courbes
    const sc = this.#sun.shadow.camera;
    sc.near = 0.5; sc.far = 200;
    sc.left = sc.bottom = -40;
    sc.right = sc.top   =  40;

    scene.add(this.#hemi, this.#sun);

    // Applique le preset neutre immédiatement (sans transition)
    this.#applyInstant('neutral');
  }

  // ── API publique ─────────────────────────────────────────────────────────────

  /**
   * Change l'ambiance avec une transition en douceur.
   * @param {'neutral'|'warm'|'cold'|'dramatic'|'night'} name
   * @param {number} duration  Durée de la transition en secondes (défaut 1.5)
   */
  setAmbiance(name, duration = 1.5) {
    if (!PRESETS[name]) {
      console.warn(
        `[LightingManager] Ambiance "${name}" inconnue.\n` +
        `Disponibles : ${LightingManager.presets.join(', ')}`
      );
      return;
    }
    this.#transition = {
      from:     this.#snapshot(),
      to:       livePreset(PRESETS[name]),
      duration: Math.max(0.01, duration),
      elapsed:  0,
    };
    this.#current = name;
  }

  /** Appelé chaque frame par le moteur. Retourne true si une transition est en cours. */
  update(delta) {
    if (!this.#transition) return false;

    this.#transition.elapsed += delta;
    const t = Math.min(this.#transition.elapsed / this.#transition.duration, 1);
    this.#lerp(this.#transition.from, this.#transition.to, t);

    if (t >= 1) this.#transition = null;
    return true;
  }

  /** Nom de l'ambiance courante. */
  get currentAmbiance() { return this.#current; }

  /** Liste de tous les noms de presets disponibles. */
  static get presets() { return Object.keys(PRESETS); }

  dispose() {
    this.#scene.remove(this.#hemi, this.#sun);
    this.#hemi.dispose();
    this.#sun.dispose();
    if (this.#envMap)    this.#envMap.dispose();
    if (this.#skyTexture) this.#skyTexture.dispose();
    this.#scene.environment          = null;
    this.#scene.fog                  = null;
    this.#scene.environmentIntensity = 1;
    this.#renderer.toneMappingExposure = 1;
  }

  /**
   * Adapte le frustum de la shadow camera à la bounding box de la scène.
   * Évite les ombres aliasées (frustum trop grand) ou manquantes (trop petit).
   * @param {THREE.Box3} box
   */
  fitShadowToScene(box) {
    const center = new THREE.Vector3();
    const size   = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);
    const radius = Math.max(size.x, size.y, size.z) * 0.6;
    const sc = this.#sun.shadow.camera;
    sc.left = sc.bottom = -radius;
    sc.right = sc.top   =  radius;
    sc.far = this.#sun.position.distanceTo(center) + radius * 2;
    sc.updateProjectionMatrix();
  }

  // ── Méthodes privées ─────────────────────────────────────────────────────────

  /** Applique un preset sans transition (t=1 direct). */
  #applyInstant(name) {
    const p = PRESETS[name];

    this.#hemi.color.set(p.hemisphere.sky);
    this.#hemi.groundColor.set(p.hemisphere.ground);
    this.#hemi.intensity = p.hemisphere.intensity;

    this.#sun.color.set(p.sun.color);
    this.#sun.intensity = p.sun.intensity;
    this.#sun.position.set(...p.sun.position);

    if (p.background === null) {
      this.#scene.background = this.#skyTexture ?? new THREE.Color(0x7fb8d8);
    } else {
      this.#scene.background = new THREE.Color(p.background);
    }
    this.#scene.environmentIntensity = p.envIntensity;
    this.#renderer.toneMappingExposure = p.exposure;

    this.#scene.fog = p.fog
      ? new THREE.Fog(new THREE.Color(p.fog.color), p.fog.near, p.fog.far)
      : null;
  }

  /** Capture l'état courant de toutes les lumières. */
  #snapshot() {
    const fog = this.#scene.fog;
    return {
      hemisphere: {
        sky:       this.#hemi.color.clone(),
        ground:    this.#hemi.groundColor.clone(),
        intensity: this.#hemi.intensity,
      },
      sun: {
        color:     this.#sun.color.clone(),
        intensity: this.#sun.intensity,
        position:  this.#sun.position.clone(),
      },
      background:   this.#scene.background instanceof THREE.Color
        ? this.#scene.background.clone()
        : null, // texture EXR — pas d'interpolation couleur
      fog: fog
        ? { color: fog.color.clone(), near: fog.near, far: fog.far }
        : null,
      envIntensity: this.#scene.environmentIntensity ?? 1,
      exposure:     this.#renderer.toneMappingExposure,
    };
  }

  /** Interpolation lissée entre deux états à la progression t ∈ [0,1]. */
  #lerp(from, to, t) {
    const e = smoothstep(t);

    // Hémisphérique (ciel + sol)
    this.#hemi.color.copy(from.hemisphere.sky).lerp(to.hemisphere.sky, e);
    this.#hemi.groundColor.copy(from.hemisphere.ground).lerp(to.hemisphere.ground, e);
    this.#hemi.intensity = lerp(from.hemisphere.intensity, to.hemisphere.intensity, e);

    // Soleil
    this.#sun.color.copy(from.sun.color).lerp(to.sun.color, e);
    this.#sun.intensity = lerp(from.sun.intensity, to.sun.intensity, e);
    this.#sun.position.copy(from.sun.position).lerp(to.sun.position, e);

    // Fond
    if (to.background === null) {
      // Retour vers le ciel EXR : snap à t=1
      if (t >= 1) this.#scene.background = this.#skyTexture ?? new THREE.Color(0x7fb8d8);
    } else if (from.background === null) {
      // Départ depuis le ciel EXR : interpoler vers la couleur cible
      if (!(this.#scene.background instanceof THREE.Color)) {
        this.#scene.background = new THREE.Color(0x7fb8d8);
      }
      this.#scene.background.lerp(to.background, e);
    } else {
      if (!(this.#scene.background instanceof THREE.Color)) {
        this.#scene.background = from.background.clone();
      }
      this.#scene.background.copy(from.background).lerp(to.background, e);
    }

    // IBL + exposition
    this.#scene.environmentIntensity       = lerp(from.envIntensity, to.envIntensity, e);
    this.#renderer.toneMappingExposure     = lerp(from.exposure,     to.exposure,     e);

    // Brouillard
    if (to.fog) {
      if (!this.#scene.fog) {
        this.#scene.fog = new THREE.Fog(to.fog.color.clone(), to.fog.near, to.fog.far);
      }
      const fc = from.fog ?? to.fog;
      this.#scene.fog.color.copy(fc.color).lerp(to.fog.color, e);
      this.#scene.fog.near = lerp(fc.near, to.fog.near, e);
      this.#scene.fog.far  = lerp(fc.far,  to.fog.far,  e);
    } else if (this.#scene.fog && from.fog) {
      // Fondu-sortie : repousser le brouillard très loin puis le supprimer
      const FAR = 1e5;
      this.#scene.fog.near = lerp(from.fog.near, FAR, e);
      this.#scene.fog.far  = lerp(from.fog.far,  FAR, e);
      if (t >= 1) this.#scene.fog = null;
    }
  }
}
