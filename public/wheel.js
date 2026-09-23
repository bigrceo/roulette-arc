// ===========================================================================
//  $ROULETTE — roue 3D du hero. Three.js, tout est procedural : aucun
//  modele externe, aucune texture telechargee, aucune licence a citer.
//
//  API :  window.ROULETTE.setState('idle' | 'locked' | 'paid')
//    idle    la roue tourne lentement, la bille roule
//    locked  la roue s'emballe (bloc annonce)
//    paid    la roue ralentit, la bille tombe dans une case et s'y cale
// ===========================================================================

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const ORDER = [0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];
const RED = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const N = ORDER.length;
const TAU = Math.PI * 2;

const REDUCED = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const host = document.getElementById("wheel-3d");
if (!host) throw new Error("wheel-3d introuvable");

// ---------------------------------------------------------------------------
// Renderer, scene, camera
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
// plein ecran + bloom : on plafonne le pixel ratio pour rester fluide
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, host.clientWidth < 700 ? 1.25 : 1.6));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.setClearColor(0x000000, 0);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
host.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x0b0a09, 0.016);

const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
const CAM_BASE = new THREE.Vector3(0, 9.2, 10.4);
// data-look-y decale la roue vers le haut du cadre (le titre vit en bas)
const LOOK_Y = Number(host.dataset.lookY ?? 0.1);
camera.position.copy(CAM_BASE);
camera.lookAt(0, LOOK_Y, 0);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------
const wood = new THREE.MeshPhysicalMaterial({
  color: 0x3a1410, roughness: 0.42, metalness: 0.0, clearcoat: 0.55, clearcoatRoughness: 0.28, sheen: 0.15, sheenColor: 0x6a2418,
  envMapIntensity: 0.9,
});
const woodDark = new THREE.MeshPhysicalMaterial({ color: 0x24100b, roughness: 0.5, clearcoat: 0.45, clearcoatRoughness: 0.35, envMapIntensity: 0.55 });
const gold = new THREE.MeshPhysicalMaterial({ color: 0xc9a44a, metalness: 1.0, roughness: 0.22, envMapIntensity: 1.4, clearcoat: 0.3 });
const goldDim = new THREE.MeshPhysicalMaterial({ color: 0x9a7a2c, metalness: 1.0, roughness: 0.38, envMapIntensity: 1.1 });
const ivory = new THREE.MeshPhysicalMaterial({ color: 0xf3ead6, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.2 });
// le sol n'existe que pour recevoir l'ombre : le noir du site passe a travers
const felt = new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.55 });

// grain de bois procedural : quelques anneaux concentriques en bump
function woodBump(size = 512) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = x - size * 0.5, dy = y - size * 0.5;
    const r = Math.sqrt(dx * dx + dy * dy);
    const v = 128 + 40 * Math.sin(r * 0.55 + Math.sin(x * 0.03) * 2) + 20 * Math.sin(r * 2.1) + (Math.random() - 0.5) * 18;
    const i = (y * size + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.max(0, Math.min(255, v));
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
const bump = woodBump();
wood.bumpMap = bump; wood.bumpScale = 0.02;
woodDark.bumpMap = bump; woodDark.bumpScale = 0.01;

// ---------------------------------------------------------------------------
// Geometrie
// ---------------------------------------------------------------------------
const lathe = (pts, mat, seg = 128) => {
  const m = new THREE.Mesh(new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg), mat);
  m.castShadow = m.receiveShadow = true;
  return m;
};

const R_OUT = 5.3, R_TRACK_OUT = 4.55, R_TRACK_IN = 3.9, R_POCKET_OUT = 3.82, R_POCKET_IN = 2.95;
const Y_TOP = 0.62, Y_TRACK_IN = 0.28, Y_POCKET = -0.14;

// cuvette en bois (fixe)
const bowl = lathe([
  [R_OUT + 0.15, -0.55], [R_OUT + 0.15, 0.35], [R_OUT, Y_TOP], [R_OUT - 0.5, Y_TOP + 0.02],
  [R_TRACK_OUT, Y_TOP - 0.06], [R_TRACK_IN, Y_TRACK_IN], [R_POCKET_OUT + 0.04, Y_POCKET + 0.12], [R_POCKET_OUT + 0.04, Y_POCKET - 0.2],
  [R_POCKET_IN - 0.3, Y_POCKET - 0.2], [R_POCKET_IN - 0.3, Y_POCKET - 0.6], [0, Y_POCKET - 0.6],
], woodDark);
scene.add(bowl);

// liseré doré sur le rebord
const rimRing = new THREE.Mesh(new THREE.TorusGeometry(R_OUT - 0.22, 0.045, 12, 160), gold);
rimRing.rotation.x = Math.PI / 2; rimRing.position.y = Y_TOP + 0.02; scene.add(rimRing);
const trackRing = new THREE.Mesh(new THREE.TorusGeometry(R_TRACK_IN + 0.02, 0.03, 10, 160), goldDim);
trackRing.rotation.x = Math.PI / 2; trackRing.position.y = Y_TRACK_IN + 0.01; scene.add(trackRing);

// 8 deflecteurs en losange sur la piste de la bille
for (let i = 0; i < 8; i++) {
  const d = new THREE.Mesh(new THREE.OctahedronGeometry(0.11, 0), gold);
  const a = (i / 8) * TAU;
  const r = (R_TRACK_OUT + R_TRACK_IN) / 2;
  d.position.set(Math.cos(a) * r, Y_TOP - 0.14, Math.sin(a) * r);
  d.scale.set(1.6, 0.6, 1);
  d.rotation.y = -a;
  d.castShadow = true;
  scene.add(d);
}

// --- partie tournante ------------------------------------------------------
const rotor = new THREE.Group();
scene.add(rotor);

// anneau des numeros : texture canvas projetee en polaire
function numbersTexture() {
  const W = 4096, H = 256;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  const sw = W / N;
  for (let i = 0; i < N; i++) {
    const n = ORDER[i];
    g.fillStyle = n === 0 ? "#1f7a3c" : RED.has(n) ? "#9c1b22" : "#151311";
    g.fillRect(i * sw, 0, sw + 1, H);
    // fond de case legerement plus sombre au fond (pres du cone)
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "rgba(0,0,0,.35)"); grad.addColorStop(0.5, "rgba(0,0,0,0)"); grad.addColorStop(1, "rgba(0,0,0,.25)");
    g.fillStyle = grad; g.fillRect(i * sw, 0, sw + 1, H);
    // numero, lu depuis l'exterieur
    g.save();
    g.translate(i * sw + sw / 2, H * 0.78);
    g.rotate(Math.PI / 2);
    g.fillStyle = "#f3e9d2";
    g.font = "600 92px 'IBM Plex Mono', Menlo, monospace";
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(String(n), 0, 0);
    g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  t.wrapS = THREE.RepeatWrapping;
  return t;
}
const ringGeo = new THREE.RingGeometry(R_POCKET_IN, R_POCKET_OUT, N * 6, 1);
{
  // UV polaires : u = angle, v = rayon
  const pos = ringGeo.attributes.position, uv = ringGeo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    const a = (Math.atan2(y, x) + TAU) % TAU;
    const r = Math.sqrt(x * x + y * y);
    // v=1 vers l'exterieur, on inverse pour que le chiffre soit lisible de l'exterieur
    uv.setXY(i, 1 - a / TAU, 1 - (r - R_POCKET_IN) / (R_POCKET_OUT - R_POCKET_IN));
  }
  uv.needsUpdate = true;
}
const pocketMat = new THREE.MeshPhysicalMaterial({ map: numbersTexture(), roughness: 0.35, clearcoat: 0.7, clearcoatRoughness: 0.15, envMapIntensity: 0.8 });
const pocketRing = new THREE.Mesh(ringGeo, pocketMat);
pocketRing.rotation.x = -Math.PI / 2;
pocketRing.position.y = Y_POCKET;
pocketRing.receiveShadow = true;
rotor.add(pocketRing);

// frettes dorees entre les cases
const fretGeo = new THREE.BoxGeometry(R_POCKET_OUT - R_POCKET_IN, 0.16, 0.05);
for (let i = 0; i < N; i++) {
  const a = ((i + 0.5) / N) * TAU; // frontiere entre deux cases
  const f = new THREE.Mesh(fretGeo, gold);
  const r = (R_POCKET_OUT + R_POCKET_IN) / 2;
  f.position.set(Math.cos(a) * r, Y_POCKET + 0.08, -Math.sin(a) * r);
  f.rotation.y = a;
  f.castShadow = true;
  rotor.add(f);
}
// paroi exterieure des cases (petit mur dore)
const wall = new THREE.Mesh(new THREE.CylinderGeometry(R_POCKET_OUT + 0.02, R_POCKET_OUT + 0.02, 0.2, 160, 1, true), goldDim);
wall.position.y = Y_POCKET + 0.1; wall.material.side = THREE.DoubleSide; rotor.add(wall);

// cone central en bois avec inserts dores, puis tourelle
const cone = lathe([[R_POCKET_IN, Y_POCKET], [R_POCKET_IN - 0.05, Y_POCKET + 0.02], [2.1, 0.18], [1.25, 0.5], [0.75, 0.78], [0.62, 0.8]], wood);
rotor.add(cone);
const coneRing = new THREE.Mesh(new THREE.TorusGeometry(2.1, 0.028, 8, 160), gold);
coneRing.rotation.x = Math.PI / 2; coneRing.position.y = 0.2; rotor.add(coneRing);
const coneRing2 = new THREE.Mesh(new THREE.TorusGeometry(R_POCKET_IN - 0.02, 0.03, 8, 160), gold);
coneRing2.rotation.x = Math.PI / 2; coneRing2.position.y = Y_POCKET + 0.02; rotor.add(coneRing2);

const turret = lathe([[0.62, 0.8], [0.62, 0.95], [0.42, 1.02], [0.3, 1.2], [0.24, 1.55], [0.3, 1.62], [0.24, 1.72], [0.3, 2.05], [0.2, 2.12], [0, 2.12]], gold, 64);
rotor.add(turret);
const knob = new THREE.Mesh(new THREE.SphereGeometry(0.3, 32, 24), gold);
knob.position.y = 2.36; knob.castShadow = true; rotor.add(knob);
// poignees en croix
for (let i = 0; i < 4; i++) {
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.5, 16), gold);
  arm.rotation.z = Math.PI / 2; arm.rotation.y = (i / 4) * TAU; arm.position.y = 1.62;
  const g = new THREE.Group(); g.add(arm);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 12), gold);
  tip.position.set(0.78, 1.62, 0); g.add(tip);
  g.rotation.y = (i / 4) * TAU;
  rotor.add(g);
}

// --- bille -----------------------------------------------------------------
const ball = new THREE.Mesh(new THREE.SphereGeometry(0.17, 32, 24), ivory);
ball.castShadow = true;
scene.add(ball);

// --- tapis et ombre --------------------------------------------------------
const table = new THREE.Mesh(new THREE.CircleGeometry(14, 64), felt);
table.rotation.x = -Math.PI / 2; table.position.y = -0.56; table.receiveShadow = true;
scene.add(table);

// ---------------------------------------------------------------------------
// Lumieres : salon feutre, chaud, une clef au-dessus, un rebond dore
// ---------------------------------------------------------------------------
scene.add(new THREE.AmbientLight(0x4a3a2a, 0.35));
const key = new THREE.SpotLight(0xffd9a8, 260, 40, Math.PI / 5, 0.55, 1.6);
key.position.set(3.5, 12, 5); key.target.position.set(0, 0, 0);
key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.0004; key.shadow.radius = 4;
scene.add(key, key.target);
const rimL = new THREE.PointLight(0xb8912f, 60, 30, 1.8); rimL.position.set(-7, 3.5, -5); scene.add(rimL);
const fill = new THREE.PointLight(0xb01e28, 28, 30, 2); fill.position.set(6, 2, -7); scene.add(fill);

// ---------------------------------------------------------------------------
// Post-process : bloom discret sur l'or
// ---------------------------------------------------------------------------
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.28, 0.7, 0.86);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ---------------------------------------------------------------------------
// Etat et animation
// ---------------------------------------------------------------------------
const SPEED = { idle: 0.55, locked: 2.6, paid: 0 };
let state = "idle";
let wheelSpeed = SPEED.idle;         // rad/s
let wheelAngle = 0;
let ballAngle = 0;
let ballSpeed = -1.9;                // rad/s, sens inverse
let ballR = (R_TRACK_OUT + R_TRACK_IN) / 2 + 0.05;
let ballY = Y_TOP - 0.02;
let dropT = 0;                        // progression de la chute (paid)
let landedOffset = null;              // angle de la case ou la bille est tombee (repere rotor)
const pocketR = (R_POCKET_OUT + R_POCKET_IN) / 2 + 0.05;

function setState(s) {
  if (!SPEED.hasOwnProperty(s) || s === state) return;
  state = s;
  if (s !== "paid") { dropT = 0; landedOffset = null; }
}
window.ROULETTE = { setState, get state() { return state; } };

const pointer = { x: 0, y: 0 };
window.addEventListener("pointermove", (e) => {
  pointer.x = (e.clientX / window.innerWidth - 0.5) * 2;
  pointer.y = (e.clientY / window.innerHeight - 0.5) * 2;
}, { passive: true });

function resize() {
  const w = host.clientWidth, h = host.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  camera.aspect = w / h;
  // sur mobile on recule un peu pour garder la roue entiere
  const k = cameraK();
  camera.position.copy(CAM_BASE).multiplyScalar(k);
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

const clock = new THREE.Clock();
let visible = true;
document.addEventListener("visibilitychange", () => { visible = !document.hidden; if (visible) clock.getDelta(); });

function step(dt) {
  // vitesse cible avec inertie
  const target = SPEED[state];
  const ease = state === "locked" ? 1.4 : state === "paid" ? 0.9 : 0.8;
  wheelSpeed += (target - wheelSpeed) * Math.min(1, dt * ease);
  wheelAngle += wheelSpeed * dt;
  rotor.rotation.y = wheelAngle;

  if (state === "paid") {
    // la bille ralentit, descend sur le cone, puis se cale dans une case
    dropT = Math.min(1, dropT + dt * 0.55);
    const t = dropT;
    const ease2 = t * t * (3 - 2 * t);
    if (landedOffset === null && t > 0.75) {
      // case sous la bille au moment ou elle touche l'anneau, en repere rotor
      const rel = ((ballAngle - wheelAngle) % TAU + TAU) % TAU;
      landedOffset = Math.round(rel / (TAU / N)) * (TAU / N);
    }
    if (landedOffset === null) {
      ballSpeed += (wheelSpeed * 0.6 - ballSpeed) * Math.min(1, dt * 0.9);
      ballAngle += ballSpeed * dt;
    } else {
      ballAngle = wheelAngle + landedOffset; // solidaire de la roue
    }
    ballR = THREE.MathUtils.lerp((R_TRACK_OUT + R_TRACK_IN) / 2 + 0.05, pocketR, ease2);
    ballY = THREE.MathUtils.lerp(Y_TOP - 0.02, Y_POCKET + 0.17, ease2) + Math.sin(t * Math.PI * 3) * (1 - t) * 0.12;
  } else {
    const targetBall = state === "locked" ? -5.2 : -1.9;
    ballSpeed += (targetBall - ballSpeed) * Math.min(1, dt * 0.7);
    ballAngle += ballSpeed * dt;
    ballR += ((R_TRACK_OUT + R_TRACK_IN) / 2 + 0.05 - ballR) * Math.min(1, dt * 2);
    ballY += (Y_TOP - 0.02 - ballY) * Math.min(1, dt * 2);
  }
  ball.position.set(Math.cos(ballAngle) * ballR, ballY, -Math.sin(ballAngle) * ballR);

  // legere parallaxe camera
  const px = pointer.x * 0.45, py = pointer.y * 0.25;
  camera.position.x += ((camera.position.x - px) * 0 + (CAM_BASE.x * cameraK() + px) - camera.position.x) * Math.min(1, dt * 2);
  camera.position.y += ((CAM_BASE.y * cameraK() - py) - camera.position.y) * Math.min(1, dt * 2);
  camera.lookAt(0, LOOK_Y, 0);
}
// recul de la camera selon le ratio du cadre : plus c'est etroit, plus on recule
function cameraK() { const w = host.clientWidth, h = host.clientHeight; const a = w / Math.max(1, h); return Math.min(2.6, Math.max(1.5, 1.8 * Math.pow(1.6 / a, 0.35))); }

function frame() {
  requestAnimationFrame(frame);
  if (!visible) return;
  const dt = Math.min(0.05, clock.getDelta());
  step(dt);
  composer.render();
}

if (REDUCED) {
  // une seule image, immobile
  step(0.016);
  composer.render();
} else {
  frame();
}
host.classList.add("ready");
