import {
  Bone,
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Matrix3,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Skeleton,
  SkinnedMesh,
  Sphere,
  Vector3,
  type Material,
  type Object3D,
} from 'three';
import type { Rig } from './parts.js';
import { injectRim, type ShaderSource } from '../nightRim.js';

/**
 * Turns a model built from dozens of primitives into one or two skinned meshes. Every pivot the
 * animator moves becomes a bone and every part is rigidly bound to its pivot's bone, so a monster
 * draws in one call per material class instead of one per part, while the animator keeps rotating
 * the same named pivots. Colour, roughness, metalness and glow move into vertex attributes; the
 * compiled geometry and materials are built once per monster type and shared by every copy.
 */

/** The smallest main-colour channel; part colours are stored relative to it (see partColour). */
const MIN_CHANNEL = 0.02;
/**
 * The darkest a non-glowing part may be, as linear luminance: sRGB 0x30. Near-black parts had
 * nothing for the low night fill to show, so at night only a monster's eyes were left.
 */
export const ALBEDO_FLOOR = new Color(0x303030).r;
/** Animated limbs reach past the rest pose, and a corpse lies flat, so culling needs slack. */
const CULL_SLACK = 2;

interface Part {
  geometry: BufferGeometry;
  /** Part vertices to rig space. */
  matrix: Matrix4;
  bone: number;
  material: MeshStandardMaterial;
}

interface Template {
  root: Group;
  skeleton: Skeleton;
  rig: Rig;
}

const templates = new Map<string, Template>();

/**
 * The shader addition every rig material shares. Roughness and metalness become per-vertex
 * factors on a material set to 1; the glow adds on top of the material's own emissive, so the hit
 * flash and the status tints (which write the material's emissive) still work, and a corpse's
 * zeroed emissive intensity also puts its eyes out.
 */
function patchRigShader(this: Material, shader: ShaderSource): void {
  patchRig(this, shader);
}

function patchEnemyRigShader(this: Material, shader: ShaderSource): void {
  patchRig(this, shader);
  injectRim(shader);
}

function patchRig(material: Material, shader: ShaderSource): void {
  const self = material;
  shader.uniforms.uRigGlow = {
    get value(): number {
      return self instanceof MeshStandardMaterial && self.emissiveIntensity <= 0 ? 0 : 1;
    },
  };
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec2 rigRM;\nattribute vec3 rigGlow;\nvarying vec2 vRigRM;\nvarying vec3 vRigGlow;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRigRM = rigRM;\nvRigGlow = rigGlow;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec2 vRigRM;\nvarying vec3 vRigGlow;\nuniform float uRigGlow;')
    .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor *= vRigRM.x;')
    .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor *= vRigRM.y;')
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vRigGlow * uRigGlow;');
}

/** Exported for tests: the shader hook and program key a rig's material gets. */
export function rigShaderHook(enemy: boolean): { hook: (this: Material, shader: ShaderSource) => void; key: string } {
  return enemy ? { hook: patchEnemyRigShader, key: 'rig-enemy' } : { hook: patchRigShader, key: 'rig' };
}

function rigMaterial(main: Color, opacity: number, enemy: boolean): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ color: main, vertexColors: true, roughness: 1, metalness: 1, flatShading: true, emissive: 0, emissiveIntensity: 1 });
  if (opacity < 1) {
    m.transparent = true;
    m.opacity = opacity;
    m.side = DoubleSide;
    // A see-through body (the ghost family) drawn at order 0 wrote depth and hid the spell effects
    // drawn after it, which sit behind or inside the ghost.
    m.depthWrite = false;
    // Two-pass double-sided transparency flips the material's side and sets needsUpdate twice per
    // draw, rebuilding the program parameters each frame; one pass draws both faces for free.
    m.forceSinglePass = true;
  }
  const { hook, key } = rigShaderHook(enemy);
  m.onBeforeCompile = hook;
  m.customProgramCacheKey = () => key;
  return m;
}

/** The part's colour relative to the material's, so colour times vertex colour is the part colour. */
function partColour(part: Color, main: Color, out: Color): Color {
  return out.setRGB(part.r / Math.max(MIN_CHANNEL, main.r), part.g / Math.max(MIN_CHANNEL, main.g), part.b / Math.max(MIN_CHANNEL, main.b));
}

/** Lifts a colour darker than ALBEDO_FLOOR to it, keeping its hue. Writes into `out`. */
export function floorAlbedo(c: Color, out: Color): Color {
  const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  if (lum >= ALBEDO_FLOOR) return out.copy(c);
  if (lum <= 1e-5) return out.setRGB(ALBEDO_FLOOR, ALBEDO_FLOOR, ALBEDO_FLOOR);
  return out.copy(c).multiplyScalar(ALBEDO_FLOOR / lum);
}

const tmpV = new Vector3();
const tmpN = new Matrix3();
const tmpC = new Color();
const tmpF = new Color();

function mergeParts(parts: readonly Part[], main: Color, floor: boolean): BufferGeometry {
  const flat = parts.map((p) => (p.geometry.index ? p.geometry.toNonIndexed() : p.geometry));
  let count = 0;
  for (const g of flat) count += g.getAttribute('position').count;
  const pos = new Float32Array(count * 3);
  const nrm = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const rm = new Float32Array(count * 2);
  const glow = new Float32Array(count * 3);
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  let v = 0;
  parts.forEach((p, i) => {
    const g = flat[i];
    if (!g) return;
    const gp = g.getAttribute('position');
    const gn = g.getAttribute('normal');
    tmpN.getNormalMatrix(p.matrix);
    const e = p.material.emissive;
    const ei = p.material.emissiveIntensity;
    const glows = ei > 0 && (e.r > 0 || e.g > 0 || e.b > 0);
    // Glowing parts (eyes, runes) keep their colour: the floor is for what the light has to show.
    const c = partColour(glows || !floor ? p.material.color : floorAlbedo(p.material.color, tmpF), main, tmpC);
    for (let k = 0; k < gp.count; k++, v++) {
      const o = v * 3;
      tmpV.fromBufferAttribute(gp, k).applyMatrix4(p.matrix);
      pos[o] = tmpV.x;
      pos[o + 1] = tmpV.y;
      pos[o + 2] = tmpV.z;
      tmpV.fromBufferAttribute(gn, k).applyMatrix3(tmpN).normalize();
      nrm[o] = tmpV.x;
      nrm[o + 1] = tmpV.y;
      nrm[o + 2] = tmpV.z;
      col[o] = c.r;
      col[o + 1] = c.g;
      col[o + 2] = c.b;
      glow[o] = e.r * ei;
      glow[o + 1] = e.g * ei;
      glow[o + 2] = e.b * ei;
      rm[v * 2] = p.material.roughness;
      rm[v * 2 + 1] = p.material.metalness;
      skinIndex[v * 4] = p.bone;
      skinWeight[v * 4] = 1;
    }
  });
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(pos, 3));
  out.setAttribute('normal', new BufferAttribute(nrm, 3));
  out.setAttribute('color', new BufferAttribute(col, 3));
  out.setAttribute('rigRM', new BufferAttribute(rm, 2));
  out.setAttribute('rigGlow', new BufferAttribute(glow, 3));
  out.setAttribute('skinIndex', new BufferAttribute(skinIndex, 4));
  out.setAttribute('skinWeight', new BufferAttribute(skinWeight, 4));
  out.computeBoundingSphere();
  for (const g of flat) if (!parts.some((p) => p.geometry === g)) g.dispose();
  return out;
}

/** The colour covering the most vertices: what the hit flash brightens the whole model with. */
function dominant(parts: readonly Part[]): Color {
  const weight = new Map<number, { c: Color; n: number }>();
  for (const p of parts) {
    const key = p.material.color.getHex();
    const n = p.geometry.getAttribute('position').count * Math.abs(p.matrix.determinant());
    const w = weight.get(key);
    if (w) w.n += n;
    else weight.set(key, { c: p.material.color, n });
  }
  let best: { c: Color; n: number } | undefined;
  for (const w of weight.values()) if (!best || w.n > best.n) best = w;
  return (best?.c ?? new Color(1, 1, 1)).clone();
}

/** Compiles a freshly built rig into a skinned template. The raw rig is consumed. */
function compile(raw: Rig, enemy: boolean): Template {
  const root = raw.root;
  const savedPos = root.position.clone();
  const savedQuat = root.quaternion.clone();
  const savedScale = root.scale.clone();
  root.position.set(0, 0, 0);
  root.quaternion.identity();
  root.scale.set(1, 1, 1);
  root.updateMatrixWorld(true);

  const animated = new Set<Object3D>([raw.body, ...raw.extras]);
  for (const o of [raw.head, raw.jaw, raw.armL, raw.armR, raw.legL, raw.legR, raw.tail]) if (o) animated.add(o);

  const bones: Bone[] = [];
  const boneOf = new Map<Object3D, Bone>();
  const parts: Part[] = [];
  const out = new Group();
  const visit = (node: Object3D, parentBone: Bone | null, parent: Object3D): void => {
    const isMesh = node instanceof Mesh;
    let bone = parentBone;
    if (!isMesh || animated.has(node)) {
      bone = new Bone();
      bone.name = `b${bones.length}`;
      bone.position.copy(node.position);
      // The animator adds Euler offsets, so the bone must decompose its rotation in the same order.
      bone.rotation.order = node.rotation.order;
      bone.quaternion.copy(node.quaternion);
      bone.scale.copy(node.scale);
      bone.userData = { ...node.userData };
      bone.visible = node.visible;
      bones.push(bone);
      boneOf.set(node, bone);
      parent.add(bone);
    }
    if (node instanceof Mesh && node.material instanceof MeshStandardMaterial && node.visible && bone) {
      parts.push({ geometry: node.geometry, matrix: node.matrixWorld.clone(), bone: bones.indexOf(bone), material: node.material });
    }
    for (const c of node.children) visit(c, bone, bone ?? parent);
  };
  for (const c of root.children) visit(c, null, out);
  out.updateMatrixWorld(true);
  const skeleton = new Skeleton(bones);

  const groups = new Map<number, Part[]>();
  for (const p of parts) {
    const key = p.material.transparent ? p.material.opacity : 1;
    const list = groups.get(key) ?? [];
    list.push(p);
    groups.set(key, list);
  }
  for (const [opacity, list] of groups) {
    // Floored like the parts, or a near-black main colour would scale every part down with it. Only
    // enemies: the floor is there so monsters show at night, and heroes and minions keep the dark
    // colours they were given (they carry or stand in the hero's light).
    const dom = dominant(list);
    const main = enemy ? floorAlbedo(dom, new Color()) : dom;
    const geometry = mergeParts(list, main, enemy);
    const m = new SkinnedMesh(geometry, rigMaterial(main, opacity, enemy));
    m.castShadow = true;
    m.bind(skeleton, new Matrix4());
    const sphere = geometry.boundingSphere ?? new Sphere();
    m.boundingSphere = new Sphere(sphere.center.clone(), sphere.radius * CULL_SLACK);
    out.add(m);
  }

  // The rest-pose extent, for death poses that lay the body on the ground (motion.ts).
  const extent = new Box3();
  for (const c of out.children) {
    if (!(c instanceof SkinnedMesh)) continue;
    c.geometry.computeBoundingBox();
    if (c.geometry.boundingBox) extent.union(c.geometry.boundingBox);
  }
  out.userData.extent = [extent.min.x, extent.max.x, extent.min.y, extent.max.y, extent.min.z, extent.max.z];
  out.position.copy(savedPos);
  out.quaternion.copy(savedQuat);
  out.scale.copy(savedScale);
  const pick = (o: Object3D | null): Object3D | null => (o ? (boneOf.get(o) ?? null) : null);
  const body = boneOf.get(raw.body) ?? bones[0] ?? new Bone();
  const rig: Rig = {
    ...raw,
    root: out,
    body,
    legL: pick(raw.legL),
    legR: pick(raw.legR),
    armL: pick(raw.armL),
    armR: pick(raw.armR),
    head: pick(raw.head),
    jaw: pick(raw.jaw),
    tail: pick(raw.tail),
    extras: raw.extras.map((e) => boneOf.get(e)).filter((e): e is Bone => e !== undefined),
    owned: [],
    motion: null,
  };
  return { root: out, skeleton, rig };
}

function instantiate(t: Template): Rig {
  const root = t.root.clone(true);
  const src: Object3D[] = [];
  const dst: Object3D[] = [];
  t.root.traverse((o) => src.push(o));
  root.traverse((o) => dst.push(o));
  const map = new Map<Object3D, Object3D>();
  src.forEach((o, i) => {
    const d = dst[i];
    if (d) map.set(o, d);
  });
  const bones = t.skeleton.bones.map((b) => {
    const d = map.get(b);
    return d instanceof Bone ? d : new Bone();
  });
  const skeleton = new Skeleton(bones, t.skeleton.boneInverses);
  root.traverse((o) => {
    if (o instanceof SkinnedMesh) o.bind(skeleton, o.bindMatrix);
  });
  const pick = (o: Object3D | null): Object3D | null => (o ? (map.get(o) ?? null) : null);
  const r = t.rig;
  return {
    ...r,
    root,
    body: map.get(r.body) ?? root,
    legL: pick(r.legL),
    legR: pick(r.legR),
    armL: pick(r.armL),
    armR: pick(r.armR),
    head: pick(r.head),
    jaw: pick(r.jaw),
    tail: pick(r.tail),
    extras: r.extras.map((e) => map.get(e)).filter((e): e is Object3D => e !== undefined),
    owned: [skeleton],
    motion: null,
  };
}

/**
 * A ready-to-place copy of the rig `build` makes, compiled once per key. Geometry and materials are
 * shared by every copy with the same key; each copy has its own bones and skeleton. `enemy` adds
 * the night rim; the key must tell enemy and friendly builds apart.
 */
export function compiledRig(key: string, build: () => Rig, enemy = false): Rig {
  let t = templates.get(key);
  if (!t) {
    t = compile(build(), enemy);
    templates.set(key, t);
  }
  return instantiate(t);
}
