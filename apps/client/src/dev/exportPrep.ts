import {
  AnimationClip,
  Color,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PropertyBinding,
  Quaternion,
  QuaternionKeyframeTrack,
  SkinnedMesh,
  Vector3,
  VectorKeyframeTrack,
  type BufferGeometry,
  type KeyframeTrack,
  type Material,
  type Skeleton,
} from 'three';

/**
 * The pure half of the dev tools' .glb export: turns a model as the game holds it (world units,
 * facing +x, transforms stacked on wrapper nodes) into what Blender should open (metres, facing
 * glTF +Z, which is Blender's Front view, with every wrapper transform baked into the parts).
 * No DOM here, so the tests run it in node.
 */

/** At game size the player is 54 units tall; KayKit heroes are about 1.8 m, so 30 units make a metre. */
export const UNITS_PER_METRE = 30;

/** Turning the game's +x forward to glTF +Z: -90 degrees about Y. The game turns +Z files back by +90 (assets.ts build()). */
export const TO_GLTF_FORWARD = -Math.PI / 2;

/**
 * The transform from the game's frame to the export frame: `turn` radians about Y, then world units
 * to metres. Procedural rigs face +x and need the turn; model files already face +Z and do not.
 */
export function exportFrame(turn: number, unitsPerMetre = UNITS_PER_METRE): Matrix4 {
  return new Matrix4().makeRotationY(turn).multiply(new Matrix4().makeScale(1 / unitsPerMetre, 1 / unitsPerMetre, 1 / unitsPerMetre));
}

function uniformScale(s: Vector3): number {
  if (Math.abs(s.x - s.y) > 1e-6 * Math.abs(s.x) || Math.abs(s.x - s.z) > 1e-6 * Math.abs(s.x)) {
    throw new Error(`Cannot bake a non-uniform scale (${s.x}, ${s.y}, ${s.z}) into the parts`);
  }
  return s.x;
}

function trackTarget(root: Object3D, trackName: string): { node: Object3D; property: string } | null {
  const { nodeName, propertyName } = PropertyBinding.parseTrackName(trackName);
  const node: unknown = PropertyBinding.findNode(root, nodeName);
  return node instanceof Object3D ? { node, property: propertyName } : null;
}

function descendants(o: Object3D): Set<Object3D> {
  const out = new Set<Object3D>();
  o.traverse((c) => out.add(c));
  return out;
}

/**
 * Moves `model` under a fresh identity root named `name`, with `frame` times the model's own
 * transform baked in: the model's children take the rotation, offset and scale, and the uniform
 * scale is pushed on down into every descendant's position and every vertex. Blender then opens
 * the parts with their transforms applied instead of a stack of scaled empties.
 *
 * Skinned meshes get their bind matrices conjugated by the same scale, and position tracks are
 * rewritten to match. Tracks on nodes that are gone (hidden parts removed earlier) are dropped.
 * Geometry and skeleton matrices are copied before they change: the game shares them between
 * every instance, and this tab's viewer keeps drawing its own copy.
 */
export function bakeExportTransform(model: Object3D, clips: readonly AnimationClip[], frame: Matrix4, name: string): { root: Group; clips: AnimationClip[] } {
  model.updateMatrix();
  const p = frame.clone().multiply(model.matrix);
  const t = new Vector3();
  const q = new Quaternion();
  const sv = new Vector3();
  p.decompose(t, q, sv);
  const s = uniformScale(sv);
  const S = new Matrix4().makeScale(s, s, s);
  const Sinv = new Matrix4().makeScale(1 / s, 1 / s, 1 / s);

  const direct = new Set(model.children);
  const inside = descendants(model);
  inside.delete(model);

  // Tracks first, while their names still resolve inside the original model.
  const outClips = clips.map((clip) => {
    const tracks: KeyframeTrack[] = [];
    for (const track of clip.tracks) {
      const target = trackTarget(model, track.name);
      if (!target || target.node === model || !inside.has(target.node)) continue;
      const values = Float32Array.from(track.values);
      if (target.property === 'position') {
        const v = new Vector3();
        for (let i = 0; i < values.length; i += 3) {
          v.set(values[i] ?? 0, values[i + 1] ?? 0, values[i + 2] ?? 0).multiplyScalar(s);
          if (direct.has(target.node)) v.applyQuaternion(q).add(t);
          values.set([v.x, v.y, v.z], i);
        }
        tracks.push(new VectorKeyframeTrack(track.name, Array.from(track.times), Array.from(values)));
      } else if (target.property === 'quaternion' && direct.has(target.node)) {
        const k = new Quaternion();
        for (let i = 0; i < values.length; i += 4) {
          k.set(values[i] ?? 0, values[i + 1] ?? 0, values[i + 2] ?? 0, values[i + 3] ?? 1).premultiply(q);
          values.set([k.x, k.y, k.z, k.w], i);
        }
        tracks.push(new QuaternionKeyframeTrack(track.name, Array.from(track.times), Array.from(values)));
      } else {
        tracks.push(track.clone());
      }
    }
    return new AnimationClip(clip.name, clip.duration, tracks);
  });

  const geometries = new Map<BufferGeometry, BufferGeometry>();
  const skeletons = new Set<Skeleton>();
  for (const o of inside) {
    if (direct.has(o)) {
      o.position.multiplyScalar(s).applyQuaternion(q).add(t);
      o.quaternion.premultiply(q);
    } else {
      o.position.multiplyScalar(s);
    }
    if (o instanceof Mesh) {
      const known = geometries.get(o.geometry);
      if (known) o.geometry = known;
      else {
        const g = o.geometry.clone();
        g.scale(s, s, s);
        geometries.set(o.geometry, g);
        o.geometry = g;
      }
    }
    if (o instanceof SkinnedMesh) {
      if (!skeletons.has(o.skeleton)) {
        skeletons.add(o.skeleton);
        o.skeleton.boneInverses = o.skeleton.boneInverses.map((m) => S.clone().multiply(m).multiply(Sinv));
      }
      o.bindMatrix.premultiply(S).multiply(Sinv);
      o.bindMatrixInverse.copy(o.bindMatrix).invert();
    }
  }

  const root = new Group();
  root.name = name;
  for (const c of [...model.children]) root.add(c);
  model.removeFromParent();
  root.updateMatrixWorld(true);
  return { root, clips: outClips };
}

/**
 * Moves the uniform scale of inner nodes (a rig's body scaled to its size) down into their
 * children, top down, so pivots open in Blender at scale 1 and only the leaves carry a scale,
 * which applyLeafTransforms then bakes. A node's own scale track (a breathing body) is divided by
 * the scale it gives away; its children's position and scale tracks are multiplied by it. Nodes
 * with bones below or a non-uniform scale keep theirs.
 */
export function pushDownScales(root: Object3D, clips: AnimationClip[]): number {
  const tracks = new Map<Object3D, { position: KeyframeTrack[]; scale: KeyframeTrack[] }>();
  for (const clip of clips) {
    for (const track of clip.tracks) {
      const target = trackTarget(root, track.name);
      if (!target || (target.property !== 'position' && target.property !== 'scale')) continue;
      const entry = tracks.get(target.node) ?? { position: [], scale: [] };
      entry[target.property].push(track);
      tracks.set(target.node, entry);
    }
  }
  const times = (list: readonly KeyframeTrack[] | undefined, k: number): void => {
    for (const t of list ?? []) for (let i = 0; i < t.values.length; i++) t.values[i] = (t.values[i] ?? 0) * k;
  };
  let n = 0;
  root.traverse((o) => {
    if (o === root || o.children.length === 0) return;
    const s = o.scale.x;
    if (Math.abs(s - 1) < 1e-9 || Math.abs(o.scale.y - s) > 1e-9 || Math.abs(o.scale.z - s) > 1e-9) return;
    let skinned = false;
    o.traverse((c) => {
      if (c.type === 'Bone' || c instanceof SkinnedMesh) skinned = true;
    });
    if (skinned) return;
    o.scale.set(1, 1, 1);
    times(tracks.get(o)?.scale, 1 / s);
    for (const c of o.children) {
      c.position.multiplyScalar(s);
      c.scale.multiplyScalar(s);
      times(tracks.get(c)?.position, s);
      times(tracks.get(c)?.scale, s);
    }
    n++;
  });
  root.updateMatrixWorld(true);
  return n;
}

/**
 * Bakes the rotation and scale of every leaf mesh into its vertices, so Blender shows each part
 * with only a location (procedural parts are unit spheres and boxes scaled per node, which Blender
 * would open as, say, scale 0.42, 0.9, 0.38). A mesh an animation turns keeps its rotation and
 * gives up only its scale; skinned meshes, meshes with children and meshes an animation scales
 * keep their transform.
 */
export function applyLeafTransforms(root: Object3D, clips: readonly AnimationClip[]): number {
  const turned = new Set<Object3D>();
  const scaled = new Set<Object3D>();
  for (const clip of clips) {
    for (const track of clip.tracks) {
      const target = trackTarget(root, track.name);
      if (target?.property === 'quaternion') turned.add(target.node);
      if (target?.property === 'scale') scaled.add(target.node);
    }
  }
  let n = 0;
  const m = new Matrix4();
  const none = new Quaternion();
  root.traverse((o) => {
    if (!(o instanceof Mesh) || o instanceof SkinnedMesh || o.children.length > 0 || scaled.has(o)) return;
    const keepTurn = turned.has(o);
    const identity = (keepTurn || o.quaternion.equals(none)) && o.scale.equals(new Vector3(1, 1, 1));
    // A mirrored scale would turn the faces inside out once baked; leave it to the node.
    if (identity || o.scale.x * o.scale.y * o.scale.z < 0) return;
    m.compose(new Vector3(), keepTurn ? none : o.quaternion, o.scale);
    const g = o.geometry.clone();
    g.applyMatrix4(m);
    o.geometry = g;
    if (!keepTurn) o.quaternion.identity();
    o.scale.set(1, 1, 1);
    n++;
  });
  root.updateMatrixWorld(true);
  return n;
}

/**
 * Takes out what should not reach Blender: hidden parts (KayKit heroes carry every weapon and the
 * game hides all but one), the game's userData (walk phases, arm rests, asset ids would all turn
 * into custom properties), and gives unnamed parts names that say where they sit.
 */
export function cleanForExport(root: Object3D): void {
  const hidden: Object3D[] = [];
  root.traverse((o) => {
    if (!o.visible && o !== root) hidden.push(o);
  });
  for (const h of hidden) h.removeFromParent();
  const counts = new Map<string, number>();
  const visit = (o: Object3D, owner: string): void => {
    if (o.name === '' && o !== root) {
      const kind = o instanceof Mesh ? 'mesh' : 'pivot';
      const key = `${owner}_${kind}`;
      const n = counts.get(key) ?? 0;
      counts.set(key, n + 1);
      o.name = `${key}${n}`;
    }
    o.userData = {};
    for (const c of o.children) visit(c, o === root || o.name === '' ? owner : o.name);
  };
  // Not the model's id: "thorn_beast_mesh0" would read as a horn to the Model check's facing guess.
  visit(root, 'part');
}

/**
 * Names the original nodes had in the file, keyed by the names three gave them. GLTFLoader strips
 * dots (`upperarm.l` becomes `upperarml`), which breaks Blender's left and right mirroring, and
 * keeps the original in userData.name. Collect this before cleanForExport clears userData.
 */
export function originalNames(root: Object3D): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  root.traverse((o) => taken.add(o.name));
  root.traverse((o) => {
    const orig: unknown = o.userData.name;
    if (typeof orig !== 'string' || orig === o.name || taken.has(orig)) return;
    // Only a name the loader changed by sanitising, not one it made unique with a suffix.
    if (PropertyBinding.sanitizeNodeName(orig) !== o.name) return;
    out.set(o.name, orig);
    taken.add(orig);
  });
  return out;
}

/** Hex colour of a three colour, as shown in the game's source (sRGB). */
function hex(c: Color): string {
  return `#${c.getHexString()}`;
}

function materialKey(m: MeshStandardMaterial): string {
  return [
    m.name,
    m.color.getHex(),
    m.emissive.getHex(),
    m.emissiveIntensity,
    m.metalness,
    m.roughness,
    m.opacity,
    m.transparent,
    m.side,
    m.map?.uuid ?? '',
    m.emissiveMap?.uuid ?? '',
    m.normalMap?.uuid ?? '',
  ].join('|');
}

/**
 * Merges identical materials and names the unnamed ones by colour. The game gives every mesh of a
 * procedural monster its own copy (hit flashes change them per entity), which Blender would list
 * as dozens of "Material_12" slots with the same colour.
 */
export function mergeMaterials(root: Object3D): number {
  const seen = new Map<string, MeshStandardMaterial>();
  const pick = (m: Material): Material => {
    if (!(m instanceof MeshStandardMaterial)) return m;
    if (m.name === '') m.name = m.emissive.getHex() !== 0 && m.emissiveIntensity > 0 ? `${hex(m.color)} glow ${hex(m.emissive)}` : hex(m.color);
    const key = materialKey(m);
    const found = seen.get(key);
    if (found) return found;
    seen.set(key, m);
    return m;
  };
  root.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    o.material = Array.isArray(o.material) ? o.material.map(pick) : pick(o.material);
  });
  return seen.size;
}

/**
 * The game draws procedural models flat-shaded (a material setting glTF cannot carry), so Blender
 * would smooth them. Splitting the shared vertices and computing per-face normals bakes the faceted
 * look into the geometry. Copies first: the rig's geometries are shared with every monster in game.
 */
export function bakeFlatShading(root: Object3D): void {
  root.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    const flat = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    flat.computeVertexNormals();
    o.geometry = flat;
  });
}

// ---------------------------------------------------------------------------------------------
// Colour work for monsters built on hero models

function toLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function toSrgb(c: number): number {
  const v = Math.min(1, Math.max(0, c));
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

/**
 * The corruption repaint from assets.ts (corruptMaterial), on one linear colour: drain it to 20%
 * of its hue, then multiply by the tint and 1.25. The same maths as the shader, so a texture baked
 * with it matches what the game draws.
 */
export function corruptColour(rgb: readonly [number, number, number], tint: Color): [number, number, number] {
  const [r, g, b] = rgb;
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  const mix = (c: number): number => luma + (c - luma) * 0.2;
  return [mix(r) * tint.r * 1.25, mix(g) * tint.g * 1.25, mix(b) * tint.b * 1.25];
}

/**
 * Bakes the repaint into sRGB RGBA pixels in place. `base` is the material colour (linear) the
 * texture is multiplied by in the shader, so the result goes with a white material colour.
 */
export function corruptPixels(data: Uint8ClampedArray, base: Color, tint: Color): void {
  for (let i = 0; i < data.length; i += 4) {
    const lin: [number, number, number] = [
      toLinear((data[i] ?? 0) / 255) * base.r,
      toLinear((data[i + 1] ?? 0) / 255) * base.g,
      toLinear((data[i + 2] ?? 0) / 255) * base.b,
    ];
    const [r, g, b] = corruptColour(lin, tint);
    data[i] = Math.round(toSrgb(r) * 255);
    data[i + 1] = Math.round(toSrgb(g) * 255);
    data[i + 2] = Math.round(toSrgb(b) * 255);
  }
}

/** The tint of a material the game repainted with corruptMaterial, read back from its program cache key. */
export function corruptTint(m: MeshStandardMaterial): Color | null {
  const match = /^corrupt-(\d+)$/.exec(m.customProgramCacheKey());
  return match?.[1] === undefined ? null : new Color(Number(match[1]));
}

// ---------------------------------------------------------------------------------------------
// GLB post-processing

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The JSON chunk of a binary glTF. */
export function readGlbJson(glb: ArrayBuffer): Record<string, unknown> {
  const view = new DataView(glb);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('Not a binary glTF');
  const length = view.getUint32(12, true);
  if (view.getUint32(16, true) !== CHUNK_JSON) throw new Error('First GLB chunk is not JSON');
  const json: unknown = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, length)));
  if (!isRecord(json)) throw new Error('GLB JSON is not an object');
  return json;
}

/** Replaces the JSON chunk of a binary glTF and keeps the binary chunk as it was. */
export function writeGlbJson(glb: ArrayBuffer, json: Record<string, unknown>): ArrayBuffer {
  const view = new DataView(glb);
  const oldLength = view.getUint32(12, true);
  const rest = new Uint8Array(glb, 20 + oldLength);
  const text = new TextEncoder().encode(JSON.stringify(json));
  const padded = Math.ceil(text.length / 4) * 4;
  const out = new Uint8Array(12 + 8 + padded + rest.length);
  const w = new DataView(out.buffer);
  w.setUint32(0, GLB_MAGIC, true);
  w.setUint32(4, 2, true);
  w.setUint32(8, out.length, true);
  w.setUint32(12, padded, true);
  w.setUint32(16, CHUNK_JSON, true);
  out.fill(0x20, 20, 20 + padded);
  out.set(text, 20);
  out.set(rest, 20 + padded);
  return out.buffer;
}

/**
 * Final touches three's exporter cannot make: node names back to the file's originals (animation
 * channels point at node indices, so renaming is safe) and the scene named after the model
 * instead of three's "AuxScene".
 */
export function finishGlb(glb: ArrayBuffer, names: ReadonlyMap<string, string>, sceneName: string): ArrayBuffer {
  const json = readGlbJson(glb);
  const nodes: unknown[] = Array.isArray(json.nodes) ? json.nodes : [];
  for (const n of nodes) {
    if (!isRecord(n) || typeof n.name !== 'string') continue;
    const orig = names.get(n.name);
    if (orig !== undefined) n.name = orig;
  }
  const scenes: unknown[] = Array.isArray(json.scenes) ? json.scenes : [];
  for (const s of scenes) if (isRecord(s)) s.name = sceneName;
  return writeGlbJson(glb, json);
}
