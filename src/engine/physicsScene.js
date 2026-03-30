import * as THREE from 'three';
import * as CANNON from 'cannon-es';

// ── Paramètres de l'arche ─────────────────────────────────────────────────────
const N_VOUSSOIRS = 11;      // impair → clé de voûte centrée
const R_IN        = 3.0;     // rayon intérieur (m)
const R_OUT       = 4.6;     // rayon extérieur (m)
const DEPTH       = 1.8;     // profondeur Z
const MASS        = 10;      // masse par voussoir (kg)
const FRICTION    = 0.75;
const RESTITUTION = 0.0;
const SPRING_H    = 2.0;     // hauteur de la naissance de l'arche (m)

// ── Matériaux Three.js (singletons) ──────────────────────────────────────────
const MAT_STONE    = new THREE.MeshStandardMaterial({ color: 0xc8bba6, roughness: 0.9, metalness: 0.0 });
const MAT_KEYSTONE = new THREE.MeshStandardMaterial({ color: 0xe8c87a, roughness: 0.6, metalness: 0.15 });
const MAT_BASE     = new THREE.MeshStandardMaterial({ color: 0x9a8e80, roughness: 1.0, metalness: 0.0 });
const MAT_GROUND   = new THREE.MeshStandardMaterial({ color: 0xd4c5a9, roughness: 1.0, metalness: 0.0 });

// ── État module-level ─────────────────────────────────────────────────────────
let world      = null;
let archGroup  = null;         // THREE.Group contenant tous les meshes de la scène
let pairs      = [];           // [{ body: CANNON.Body, mesh: THREE.Mesh }]

// ── Construction ──────────────────────────────────────────────────────────────
export function createArchScene(modelGroup) {
    // Monde physique
    world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
    world.broadphase    = new CANNON.SAPBroadphase(world);
    world.solver.iterations = 40;
    world.allowSleep    = true;

    const matStone  = new CANNON.Material({ friction: FRICTION,       restitution: RESTITUTION });
    const matGround = new CANNON.Material({ friction: FRICTION + 0.1, restitution: 0 });
    world.addContactMaterial(new CANNON.ContactMaterial(matStone,  matStone,  { friction: FRICTION,       restitution: RESTITUTION }));
    world.addContactMaterial(new CANNON.ContactMaterial(matStone,  matGround, { friction: FRICTION + 0.1, restitution: 0 }));

    pairs     = [];
    archGroup = new THREE.Group();
    modelGroup.add(archGroup);

    // ── Sol ───────────────────────────────────────────────────────────────────
    const groundBody = new CANNON.Body({ mass: 0, material: matGround });
    groundBody.addShape(new CANNON.Plane());
    groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    world.addBody(groundBody);

    const groundMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2),
        MAT_GROUND,
    );
    groundMesh.receiveShadow = true;
    archGroup.add(groundMesh);

    // ── Constantes géométriques partagées ────────────────────────────────────
    const R_MID     = (R_IN + R_OUT) / 2;
    const halfH     = (R_OUT - R_IN) / 2;
    const angleStep = Math.PI / N_VOUSSOIRS;
    const halfD     = DEPTH / 2;
    const keyIdx    = Math.floor(N_VOUSSOIRS / 2);

    // ── Culées (abutments) statiques ─────────────────────────────────────────
    // Le dessus des culées s'aligne exactement sous le bas des voussoirs de naissance
    const abutHalfX = 1.2;
    const abutHalfY = (SPRING_H + R_MID * Math.sin(angleStep / 2) - halfH) / 2;
    const abutHalfZ = DEPTH / 2 + 0.3;

    for (const side of [-1, 1]) {
        const cx = side * (R_OUT + abutHalfX + 0.05);
        const body = new CANNON.Body({ mass: 0, material: matGround });
        body.addShape(new CANNON.Box(new CANNON.Vec3(abutHalfX, abutHalfY, abutHalfZ)));
        body.position.set(cx, abutHalfY, 0);
        world.addBody(body);

        const mesh = new THREE.Mesh(
            new THREE.BoxGeometry(abutHalfX * 2, abutHalfY * 2, abutHalfZ * 2),
            MAT_BASE,
        );
        mesh.position.set(cx, abutHalfY, 0);
        mesh.castShadow    = true;
        mesh.receiveShadow = true;
        archGroup.add(mesh);
    }

    // ── Voussoirs ─────────────────────────────────────────────────────────────

    for (let i = 0; i < N_VOUSSOIRS; i++) {
        const angleMid = (i + 0.5) * angleStep;
        const halfW = R_MID * Math.sin(angleStep / 2) * 0.995;
        const cx = R_MID * Math.cos(angleMid);
        const cy = SPRING_H + R_MID * Math.sin(angleMid);

        // Corps physique
        const body = new CANNON.Body({ mass: MASS, material: matStone });
        body.addShape(new CANNON.Box(new CANNON.Vec3(halfW, halfH, halfD)));
        body.position.set(cx, cy, 0);
        body.quaternion.setFromEuler(0, 0, angleMid);
        body.linearDamping  = 0.4;
        body.angularDamping = 0.6;
        world.addBody(body);

        // Mesh Three.js
        const mesh = new THREE.Mesh(
            new THREE.BoxGeometry(halfW * 2, halfH * 2, halfD * 2),
            i === keyIdx ? MAT_KEYSTONE : MAT_STONE,
        );
        mesh.castShadow    = true;
        mesh.receiveShadow = true;
        archGroup.add(mesh);

        pairs.push({ body, mesh });

        // Ajout des contraintes entre voussoirs adjacents
        if (i > 0) {
            const prevBody = pairs[i-1].body;
            const constraint = new CANNON.PointToPointConstraint(
                prevBody,
                new CANNON.Vec3(halfW, 0, 0),
                body,
                new CANNON.Vec3(-halfW, 0, 0)
            );
            world.addConstraint(constraint);
        }
    }

    return archGroup;
}

// ── Mise à jour (appelée chaque frame) ────────────────────────────────────────
export function stepPhysics(delta) {
    if (!world) return;
    world.step(1 / 60, Math.min(delta, 0.05), 3);
    for (const { body, mesh } of pairs) {
        mesh.position.copy(body.position);
        mesh.quaternion.copy(body.quaternion);
    }
}

// ── Reset : reconstruction complète ───────────────────────────────────────────
export function resetArchScene() {
    if (!archGroup) return;
    const parent = archGroup.parent;
    if (!parent) return;
    destroyArchScene();
    createArchScene(parent);
}

// ── Nettoyage ─────────────────────────────────────────────────────────────────
export function destroyArchScene() {
    if (world) {
        [...world.bodies].forEach((b) => world.removeBody(b));
        [...world.constraints].forEach((c) => world.removeConstraint(c));
        world = null;
    }
    if (archGroup) {
        archGroup.traverse((child) => {
            if (child.isMesh) child.geometry.dispose();
        });
        if (archGroup.parent) archGroup.parent.remove(archGroup);
        archGroup = null;
    }
    pairs = [];
}

export function isArchActive() { return world !== null; }
