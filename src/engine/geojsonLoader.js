import * as THREE from 'three';

// ── Constantes de projection ──────────────────────────────────────────────────
const METERS_PER_DEG_LAT = 111320;
function metersPerDegLon(lat) {
  return 111320 * Math.cos(lat * Math.PI / 180);
}

// ── Matériaux partagés (une seule instance pour toutes les features) ──────────
const MAT = {
  building: new THREE.MeshStandardMaterial({ color: 0xd4cec8, roughness: 0.80, metalness: 0.05 }),
  roof:     new THREE.MeshStandardMaterial({ color: 0xa89880, roughness: 0.70, metalness: 0.00 }),
  road:     new THREE.LineBasicMaterial   ({ color: 0x888888 }),
  water:    new THREE.MeshStandardMaterial({ color: 0x3a7cbf, roughness: 0.10, metalness: 0.30, transparent: true, opacity: 0.8 }),
  park:     new THREE.MeshStandardMaterial({ color: 0x4a8c5c, roughness: 0.90, metalness: 0.00 }),
  ground:   new THREE.MeshStandardMaterial({ color: 0xe0d8cc, roughness: 1.00, metalness: 0.00 }),
  default:  new THREE.MeshStandardMaterial({ color: 0xb0b0b0, roughness: 0.80, metalness: 0.00 }),
};

// ── Projection géographique ───────────────────────────────────────────────────
function findCenter(features) {
  let minLon =  Infinity, maxLon = -Infinity;
  let minLat =  Infinity, maxLat = -Infinity;

  const visit = (coords) => {
    if (typeof coords[0] === 'number') {
      if (minLon > coords[0]) minLon = coords[0];
      if (maxLon < coords[0]) maxLon = coords[0];
      if (minLat > coords[1]) minLat = coords[1];
      if (maxLat < coords[1]) maxLat = coords[1];
    } else coords.forEach(visit);
  };
  features.forEach((f) => { if (f.geometry) visit(f.geometry.coordinates); });
  return [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
}

/**
 * Convertit des coordonnées géographiques en position 3D scène,
 * dans le même repère que les géométries produites par loadGeoJSON.
 *
 * Convention issue du rotateX(-π/2) appliqué aux ExtrudeGeometry :
 *   est = +X  |  haut = +Y (altitude)  |  nord = −Z
 *
 * @param {number} lon
 * @param {number} lat
 * @param {number} cLon  longitude du centre GeoJSON (champ `center[0]` retourné par loadGeoJSON)
 * @param {number} cLat  latitude  du centre GeoJSON (champ `center[1]`)
 * @param {number} [altitude=0]  hauteur en mètres bruts (avant le scale global de la page)
 * @returns {THREE.Vector3}
 */
export function geoToScene(lon, lat, cLon, cLat, altitude = 0) {
  return new THREE.Vector3(
    (lon  - cLon) * metersPerDegLon(cLat),  // est  = +X
    altitude,                                // haut = +Y
    -(lat - cLat) * METERS_PER_DEG_LAT,     // nord = −Z
  );
}

// Projette (lon, lat) vers (x, y) en mètres relatifs au centre.
// Utilisé pour construire les THREE.Shape (plan XY).
function project(lon, lat, cLon, cLat) {
  return new THREE.Vector2(
    (lon - cLon) * metersPerDegLon(cLat),
    (lat - cLat) * METERS_PER_DEG_LAT,
  );
}

// ── Sélection du matériau ─────────────────────────────────────────────────────
function pickMaterial(feature) {
  const p  = feature.properties ?? {};
  const gt = feature.geometry.type;

  if (gt === 'LineString' || gt === 'MultiLineString') return MAT.road;
  if (gt === 'Point'      || gt === 'MultiPoint')      return MAT.default;

  const natural  = p.natural  ?? '';
  const leisure  = p.leisure  ?? '';
  const landuse  = p.landuse  ?? '';

  if (p.water || p.waterway || natural === 'water')                                     return MAT.water;
  if (natural === 'wood' || leisure === 'park' || leisure === 'garden'
      || landuse === 'grass' || landuse === 'meadow' || landuse === 'forest')           return MAT.park;
  if (p.building)                                                                        return MAT.building;
  return MAT.default;
}

function getHeight(properties) {
  const p = properties ?? {};
  if (p.height)                  return Math.max(parseFloat(p.height) || 4,   0.3);
  if (p['building:levels'])      return Math.max(parseInt(p['building:levels']) * 3.2, 4);
  if (p.building)                return 8;
  return 0.3; // parcs, eau, autres polygones plats
}

// ── Constructeurs de géométrie ────────────────────────────────────────────────
function ringToShape(ring, cLon, cLat) {
  return new THREE.Shape(ring.map(([lon, lat]) => project(lon, lat, cLon, cLat)));
}

function buildPolygon(geometry, properties, cLon, cLat) {
  const height = getHeight(properties);
  const [outer, ...holes] = geometry.coordinates;
  const shape = ringToShape(outer, cLon, cLat);
  holes.forEach((h) => shape.holes.push(ringToShape(h, cLon, cLat)));

  const geo = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
  // ExtrudeGeometry extrude le long de Z ; rotateX(-π/2) → Z-extrusion devient Y (haut)
  // et le plan XY de la forme devient le plan XZ (sol).
  geo.rotateX(-Math.PI / 2);
  return geo;
}

function buildLineString(geometry, cLon, cLat) {
  const pts = geometry.coordinates.map(([lon, lat]) => {
    const v = project(lon, lat, cLon, cLat);
    return new THREE.Vector3(v.x, 0.15, v.y); // légèrement au-dessus du sol
  });
  return new THREE.BufferGeometry().setFromPoints(pts);
}

// ── Chargement ────────────────────────────────────────────────────────────────

/**
 * Charge un fichier GeoJSON depuis `url` et retourne un THREE.Group
 * contenant la géométrie 3D correspondante.
 *
 * Conventions :
 *   – Polygones   → formes extrudées (hauteur issue de la propriété `height`)
 *   – LineStrings → lignes 3D au niveau du sol
 *   – Points      → sphères de 1 m de rayon
 *
 * Les coordonnées sont projetées en mètres par rapport au centroïde de la
 * bounding box, de sorte que la scène est toujours centrée sur (0, 0, 0).
 *
 * @param   {string}           url
 * @param   {{ addGround?: boolean }} [opts]  addGround=true ajoute un plan de sol automatique
 * @returns {Promise<{ group: THREE.Group, center: [number, number] }>}
 *          center = [cLon, cLat] — à passer à geoToScene() pour positionner des marqueurs
 */
export async function loadGeoJSON(url, { addGround = true } = {}) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`[geojsonLoader] HTTP ${resp.status} — ${url}`);
  const geojson = await resp.json();

  const features = geojson.type === 'FeatureCollection'
    ? geojson.features
    : [{ type: 'Feature', geometry: geojson, properties: {} }];

  const [cLon, cLat] = findCenter(features);
  const group = new THREE.Group();

  for (const feature of features) {
    if (!feature.geometry) continue;
    const { type, coordinates } = feature.geometry;
    const props = feature.properties ?? {};
    const mat   = pickMaterial(feature);

    try {
      if (type === 'Polygon') {
        const mesh = new THREE.Mesh(buildPolygon(feature.geometry, props, cLon, cLat), mat);
        mesh.castShadow    = true;
        mesh.receiveShadow = true;
        group.add(mesh);

      } else if (type === 'MultiPolygon') {
        coordinates.forEach((poly) => {
          const mesh = new THREE.Mesh(
            buildPolygon({ type: 'Polygon', coordinates: poly }, props, cLon, cLat),
            mat,
          );
          mesh.castShadow    = true;
          mesh.receiveShadow = true;
          group.add(mesh);
        });

      } else if (type === 'LineString') {
        group.add(new THREE.Line(buildLineString(feature.geometry, cLon, cLat), mat));

      } else if (type === 'MultiLineString') {
        coordinates.forEach((line) => {
          group.add(new THREE.Line(
            buildLineString({ type: 'LineString', coordinates: line }, cLon, cLat),
            mat,
          ));
        });

      } else if (type === 'Point') {
        const [lon, lat] = coordinates;
        const v   = project(lon, lat, cLon, cLat);
        const geo = new THREE.SphereGeometry(1, 8, 6);
        geo.translate(v.x, 1, v.y);
        group.add(new THREE.Mesh(geo, MAT.default));
      }
    } catch (err) {
      console.warn('[geojsonLoader] Feature ignorée :', err.message, feature);
    }
  }

  // Plan de sol légèrement sous Y=0 pour éviter le z-fighting (désactivable)
  if (addGround) {
    const bbox = new THREE.Box3().setFromObject(group);
    if (!bbox.isEmpty()) {
      const size = new THREE.Vector3();
      bbox.getSize(size);
      const cx = (bbox.min.x + bbox.max.x) / 2;
      const cz = (bbox.min.z + bbox.max.z) / 2;
      const gGeo = new THREE.PlaneGeometry(size.x * 1.4, size.z * 1.4);
      gGeo.rotateX(-Math.PI / 2);
      gGeo.translate(cx, -0.1, cz);
      const ground = new THREE.Mesh(gGeo, MAT.ground);
      ground.receiveShadow = true;
      group.add(ground);
    }
  }

  return { group, center: [cLon, cLat] };
}

/**
 * Libère les géométries d'un groupe GeoJSON.
 * Les matériaux sont des singletons de module : ils ne sont pas disposés.
 * @param {THREE.Group} group
 */
export function disposeGeoJSONGroup(group) {
  group.traverse((child) => {
    if (child.isMesh || child.isLine) child.geometry.dispose();
  });
}
