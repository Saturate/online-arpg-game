import { Bone, Box3, Group, Mesh, MeshStandardMaterial, Object3D, PropertyBinding, Quaternion, SkinnedMesh, Vector3, type AnimationClip, type Material } from 'three';
import type { AnimRole } from '../../render/assets.js';

/**
 * Checks for a model dropped into the admin page's Model check, before anyone commits it. Pure:
 * it reads a parsed glTF (three's scene and clips, plus the file's own JSON for what three hides,
 * like primitives without a material) and never touches the DOM, so the tests run it in node.
 */

export type CheckStatus = 'pass' | 'warn';

export interface Check {
  id: 'triangles' | 'size' | 'facing' | 'feet' | 'colours' | 'loops' | 'materials' | 'roles' | 'rootMotion' | 'rig';
  title: string;
  status: CheckStatus;
  detail: string;
  /** One line on how to fix it; only on warnings. */
  fix?: string;
}

export interface Facing {
  /** The direction the model seems to face, in the file's own axes; null when it cannot tell. */
  axis: '+x' | '-x' | '+z' | '-z' | null;
  source: 'skeleton' | 'named parts' | 'glowing parts' | 'body shape' | 'none';
}

export interface ModelReport {
  checks: Check[];
  facing: Facing;
  triangles: number;
  /** Rest-pose height in the file's units. */
  height: number;
  animation: 'skinned' | 'rigid' | 'none';
}

export interface ModelInput {
  scene: Object3D;
  clips: readonly AnimationClip[];
  /** The file's glTF JSON (GLTFLoader's parser.json). */
  json: unknown;
  bytes: number;
  roles: Partial<Record<AnimRole, string>>;
  flags?: ModelFlags;
}

/** What the file cannot say about itself, set by whoever checks it. */
export interface ModelFlags {
  /** Never moves (a tower or totem): no walk or run clip is needed. */
  static?: boolean;
  /** Floats or burrows: its lowest part is meant to hang below the rest. */
  floats?: boolean;
}

export const LIMITS = {
  triangles: 5000,
  bytes: 3 * 1024 * 1024,
  /** Linear luminance below this is black at night once the grade and fog are on. */
  darkLuminance: 0.01,
  /** Share of the height a part may reach below the rest before the model visibly floats. */
  strayBelow: 0.03,
  /** Horizontal root travel over a walk, as a share of the height, before it counts as root motion. */
  rootMotion: 0.1,
  /** First and last keys closer than this loop cleanly: a share of the height, and degrees. */
  loopMove: 0.0005,
  loopDegrees: 0.5,
} as const;

const ROLE_PATTERNS: [AnimRole, RegExp][] = [
  ['idle', /idle|stand|breath/i],
  ['walk', /walk/i],
  ['run', /run|sprint|gallop/i],
  ['attack', /attack|melee|slash|bite|chop|swing|claw|punch/i],
  ['cast', /cast|spell/i],
  ['shoot', /shoot|ranged|bow|throw|spit/i],
  ['hit', /hit|hurt|damage|flinch/i],
  ['death', /death|die|dead/i],
  ['dormant', /inactive|dormant|sleep/i],
  ['awaken', /awake/i],
  ['spawn', /spawn|emerge|rise/i],
];

/** First guess at the role mapping from clip names; the admin page lets it be changed. */
export function guessRoles(clipNames: readonly string[]): Partial<Record<AnimRole, string>> {
  const out: Partial<Record<AnimRole, string>> = {};
  for (const [role, re] of ROLE_PATTERNS) {
    const hit = clipNames.find((n) => re.test(n));
    if (hit !== undefined) out[role] = hit;
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function list(names: readonly string[], max = 4): string {
  const shown = names.slice(0, max).map((n) => `"${n}"`);
  return names.length > max ? `${shown.join(', ')} and ${names.length - max} more` : shown.join(', ');
}

function round(n: number, digits = 2): string {
  return String(Number(n.toFixed(digits)));
}

function meshes(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof Mesh) out.push(o);
  });
  return out;
}

function triangleCount(ms: readonly Mesh[]): number {
  let n = 0;
  for (const m of ms) {
    const g = m.geometry;
    const count = g.index ? g.index.count : (g.getAttribute('position')?.count ?? 0);
    n += Math.floor(count / 3);
  }
  return n;
}

/** Vertex-exact bounds in world space, skinning included, so a posed rig measures as it stands. */
function meshBox(m: Mesh): Box3 {
  const box = new Box3();
  const pos = m.geometry.getAttribute('position');
  if (!pos) return box;
  const v = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    m.getVertexPosition(i, v);
    box.expandByPoint(v.applyMatrix4(m.matrixWorld));
  }
  return box;
}

function label(o: Object3D): string {
  return o.name !== '' ? o.name : o.type;
}

// ---------------------------------------------------------------------------------------------

/** The words in a node name: "Skeleton_Minion_Eyes" and "EyeLeft.001" give eye(s) as a word of its own. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w !== '');
}

function hasWord(o: Object3D, words: ReadonlySet<string>): boolean {
  return nameWords(o.name).some((w) => words.has(w));
}

/** Whole words only: "thorn_beast" and "horned_charger" are model names, not horns. */
const HEAD_WORDS = new Set(['head', 'snout', 'muzzle', 'nose', 'eye', 'eyes', 'face', 'jaw', 'beak', 'mouth', 'skull', 'horn', 'horns']);
const TOE_WORDS = new Set(['toe', 'toes']);
const HIP_WORDS = new Set(['hips', 'hip', 'pelvis']);
/** Glowing bits that drift around the body: a wisp's sparks are not its eyes. */
const PARTICLE_WORDS = new Set(['orbit', 'spark', 'sparks', 'particle', 'particles', 'ember', 'embers', 'mote', 'motes']);

function horizontalAxis(v: Vector3): Facing['axis'] {
  if (Math.abs(v.x) > Math.abs(v.z)) return v.x > 0 ? '+x' : '-x';
  return v.z > 0 ? '+z' : '-z';
}

/** The mean offset of `points` from `from`, as an axis; null when it is under 8% of the model's reach. */
function facingFrom(points: Vector3[], from: Vector3, size: Vector3): Facing['axis'] {
  if (points.length === 0) return null;
  const mean = points.reduce((a, p) => a.add(p), new Vector3()).divideScalar(points.length).sub(from);
  const reach = Math.max(size.x, size.z);
  if (Math.hypot(mean.x, mean.z) < reach * 0.08) return null;
  return horizontalAxis(mean);
}

function worldPos(o: Object3D): Vector3 {
  return o.getWorldPosition(new Vector3());
}

/**
 * Reads the skeleton, which says more than the mesh: weapons and capes stretch the bounding box, but
 * toes always point forward from the foot, and a four-legged head bone sits ahead of the hips.
 */
function skeletonFacing(bones: readonly Bone[], size: Vector3): Facing['axis'] {
  const forward = new Vector3();
  for (const toe of bones.filter((b) => hasWord(b, TOE_WORDS))) {
    if (!(toe.parent instanceof Bone)) continue;
    const d = worldPos(toe).sub(worldPos(toe.parent));
    forward.x += d.x;
    forward.z += d.z;
  }
  // Clearly along one axis, or it says nothing (a toe bone straight below its foot, say).
  const along = Math.max(Math.abs(forward.x), Math.abs(forward.z));
  if (along > 0 && along > 2 * Math.min(Math.abs(forward.x), Math.abs(forward.z))) return horizontalAxis(forward);
  const hips = bones.find((b) => hasWord(b, HIP_WORDS));
  const heads = bones.filter((b) => hasWord(b, HEAD_WORDS));
  if (hips && heads.length > 0) return facingFrom(heads.map(worldPos), worldPos(hips), size);
  return null;
}

function estimateFacing(scene: Object3D, ms: readonly Mesh[], boxes: Map<Mesh, Box3>, center: Vector3, size: Vector3, height: number): Facing {
  const bones: Bone[] = [];
  scene.traverse((o) => {
    if (o instanceof Bone) bones.push(o);
  });
  const bySkeleton = skeletonFacing(bones, size);
  if (bySkeleton) return { axis: bySkeleton, source: 'skeleton' };
  // Offsets are taken from the hips when there are any: the box centre moves with every weapon.
  const hips = bones.find((b) => hasWord(b, HIP_WORDS));
  const from = hips ? worldPos(hips) : center;

  const named: Vector3[] = [];
  scene.traverse((o) => {
    if (o === scene || o instanceof Bone || !hasWord(o, HEAD_WORDS)) return;
    const box = o instanceof Mesh ? boxes.get(o) : undefined;
    named.push(box && !box.isEmpty() ? box.getCenter(new Vector3()) : worldPos(o));
  });
  const byName = facingFrom(named, from, size);
  if (byName) return { axis: byName, source: 'named parts' };

  // Glowing eyes are the usual tell on a model with anonymous part names. A glowing body (a wisp's
  // ball, a slime) is no eye, and neither are sparks drifting around it.
  const particle = (m: Mesh): boolean => {
    for (let o: Object3D | null = m; o && o !== scene; o = o.parent) if (hasWord(o, PARTICLE_WORDS)) return true;
    return false;
  };
  const eyeSized = (m: Mesh): boolean => {
    const box = boxes.get(m);
    if (!box || box.isEmpty()) return false;
    const s = box.getSize(new Vector3());
    return Math.max(s.x, s.y, s.z) < height * 0.25;
  };
  const glowing = ms.filter((m) => materialsOf(m).some((mat) => mat instanceof MeshStandardMaterial && mat.emissive.getHex() !== 0 && mat.emissiveIntensity > 0) && eyeSized(m) && !particle(m));
  const byGlow = facingFrom(
    glowing.map((m) => boxes.get(m)?.getCenter(new Vector3()) ?? worldPos(m)),
    from,
    size,
  );
  if (byGlow) return { axis: byGlow, source: 'glowing parts' };

  // A four-legged body is longer than it is wide; the sign stays unknown, so this is only a hint.
  if (size.y < Math.max(size.x, size.z) * 1.2) {
    if (size.x > size.z * 1.3) return { axis: '+x', source: 'body shape' };
    if (size.z > size.x * 1.3) return { axis: '+z', source: 'body shape' };
  }
  return { axis: null, source: 'none' };
}

/** Blender turns about its up axis (Z) that bring each facing to glTF +Z, which is Blender's -Y. */
const BLENDER_TURN: Record<'+x' | '-x' | '-z', string> = { '+x': '-90', '-x': '90', '-z': '180' };

function facingCheck(f: Facing): Check {
  const title = 'Facing';
  const fix = (axis: '+x' | '-x' | '-z') =>
    `In Blender rotate it ${BLENDER_TURN[axis]} degrees about Z so the head points at the Front view (-Y), apply rotation, and export again.`;
  if (f.axis === null) return { id: 'facing', title, status: 'warn', detail: 'Could not tell which way it faces: check facing against the arrow (+Z, the way the game expects).', fix: 'The head must point along the arrow; if not, turn it in Blender to face the Front view (-Y).' };
  if (f.source === 'body shape') {
    if (f.axis === '+z') return { id: 'facing', title, status: 'warn', detail: 'The body is longest along Z, as expected, but the shape cannot tell head from tail: check facing against the arrow.', fix: 'If the tail points along the arrow, rotate it 180 degrees about Blender Z.' };
    return { id: 'facing', title, status: 'warn', detail: 'The body is longest along X; the game expects it to face +Z. Check facing against the arrow.', fix: fix('+x') };
  }
  if (f.axis === '+z') return { id: 'facing', title, status: 'pass', detail: `Faces +Z, going by its ${f.source}.` };
  return { id: 'facing', title, status: 'warn', detail: `Faces ${f.axis.toUpperCase()} going by its ${f.source}; the game expects +Z.`, fix: fix(f.axis) };
}

/**
 * The glTF mesh node a drawn mesh belongs to. GLTFLoader draws each primitive (one per material)
 * as its own Mesh and, when a mesh has several, groups them under a Group standing for the node;
 * empty nodes load as plain Object3D and the scene root has no parent, so only that case is a Group
 * below the root. Without this, feet with a material of their own read as a separate, stray part.
 */
function partOf(m: Mesh): Object3D {
  const p = m.parent;
  return p instanceof Group && p.parent !== null ? p : m;
}

function feetCheck(ms: readonly Mesh[], boxes: Map<Mesh, Box3>, overall: Box3, height: number, floats: boolean): Check {
  const title = 'Feet';
  const parts = new Map<Object3D, { low: number; triangles: number }>();
  for (const m of ms) {
    const y = boxes.get(m)?.min.y;
    if (y === undefined || !Number.isFinite(y)) continue;
    const part = partOf(m);
    const p = parts.get(part) ?? { low: Number.POSITIVE_INFINITY, triangles: 0 };
    parts.set(part, { low: Math.min(p.low, y), triangles: p.triangles + triangleCount([m]) });
  }
  let lowest: Object3D | null = null;
  let total = 0;
  for (const [part, p] of parts) {
    total += p.triangles;
    if (lowest === null || p.low < (parts.get(lowest)?.low ?? p.low)) lowest = part;
  }
  let restLow = Number.POSITIVE_INFINITY;
  for (const [part, p] of parts) if (part !== lowest) restLow = Math.min(restLow, p.low);
  // Only the part holding the lowest point can float the rest. The main mesh (most of the
  // triangles) standing below a separate head or tail is just a model whose feet are in that mesh.
  const minor = lowest !== null && (parts.get(lowest)?.triangles ?? 0) * 2 < total;
  const hangs = lowest !== null && minor && Number.isFinite(restLow) && overall.min.y < restLow - height * LIMITS.strayBelow;
  if (hangs && floats && lowest !== null) {
    return { id: 'feet', title, status: 'pass', detail: `Floats or burrows: "${label(lowest)}" hangs ${round(restLow - overall.min.y)} below the rest and is what the game stands on the ground.` };
  }
  if (hangs && lowest !== null) {
    return {
      id: 'feet',
      title,
      status: 'warn',
      detail: `"${label(lowest)}" reaches ${round(restLow - overall.min.y)} below the rest of the model. The game stands the lowest point on the ground, so everything else floats.`,
      fix: 'Delete the stray part or move it up to the feet, then apply its transform.',
    };
  }
  const offset = Math.abs(overall.min.y) > height * 0.02 ? ` (${round(overall.min.y)} from the origin; the game moves it to the ground)` : '';
  return { id: 'feet', title, status: 'pass', detail: `Lowest point in the rest pose is at y = ${round(overall.min.y)}${offset}.` };
}

function materialsOf(m: Mesh): Material[] {
  return Array.isArray(m.material) ? m.material : [m.material];
}

function luminance(c: { r: number; g: number; b: number }): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

function coloursCheck(ms: readonly Mesh[], json: unknown): Check {
  const title = 'Base colours';
  const all = new Set<MeshStandardMaterial>();
  for (const m of ms) for (const mat of materialsOf(m)) if (mat instanceof MeshStandardMaterial) all.add(mat);
  // A texture decides its own colour, and a glowing part shows in the dark anyway.
  // GLTFLoader gives material-less meshes a default white one; count only the file's own.
  const total = isRecord(json) && Array.isArray(json.materials) ? json.materials.length : all.size;
  const dark = [...all].filter((mat) => !mat.map && luminance(mat.color) < LIMITS.darkLuminance && !(mat.emissive.getHex() !== 0 && mat.emissiveIntensity > 0));
  if (dark.length === 0) return { id: 'colours', title, status: 'pass', detail: `No black or near-black base colours in ${total} material${total === 1 ? '' : 's'}.` };
  return {
    id: 'colours',
    title,
    status: 'warn',
    detail: `${dark.length} of ${total} materials are black or near-black (${list(dark.map((d) => d.name || 'unnamed'))}): invisible at night.`,
    fix: 'Lift those base colours to a dark grey, #333333 or lighter.',
  };
}

function trackNode(scene: Object3D, trackName: string): Object3D | null {
  const { nodeName } = PropertyBinding.parseTrackName(trackName);
  const node: unknown = PropertyBinding.findNode(scene, nodeName);
  return node instanceof Object3D ? node : null;
}

function property(trackName: string): string {
  return PropertyBinding.parseTrackName(trackName).propertyName;
}

/** Worst mismatch between a looping clip's first and last pose, or null when it loops cleanly. */
function loopGap(clip: AnimationClip, height: number): string | null {
  for (const track of clip.tracks) {
    const size = track.getValueSize();
    const v = track.values;
    const last = v.length - size;
    if (last <= 0) continue;
    const prop = property(track.name);
    if (prop === 'quaternion') {
      const a = new Quaternion(v[0], v[1], v[2], v[3]);
      const b = new Quaternion(v[last], v[last + 1], v[last + 2], v[last + 3]);
      const deg = (a.angleTo(b) * 180) / Math.PI;
      if (deg > LIMITS.loopDegrees) return `${PropertyBinding.parseTrackName(track.name).nodeName} turns ${round(deg, 1)} degrees`;
      continue;
    }
    let worst = 0;
    for (let k = 0; k < size; k++) worst = Math.max(worst, Math.abs((v[k] ?? 0) - (v[last + k] ?? 0)));
    const limit = prop === 'position' ? height * LIMITS.loopMove : 0.001;
    if (worst > limit) return `${PropertyBinding.parseTrackName(track.name).nodeName} ${prop === 'position' ? 'moves' : 'changes'} ${round(worst, 4)}`;
  }
  return null;
}

function loopsCheck(clips: readonly AnimationClip[], roles: ModelInput['roles'], height: number): Check {
  const title = 'Looping clips';
  const bad: string[] = [];
  const checked: string[] = [];
  for (const role of ['idle', 'walk', 'run'] as const) {
    const name = roles[role];
    const clip = name === undefined ? undefined : clips.find((c) => c.name === name);
    if (!clip || checked.includes(clip.name)) continue;
    checked.push(clip.name);
    const gap = loopGap(clip, height);
    if (gap) bad.push(`${clip.name} (${gap} between first and last key)`);
  }
  if (checked.length === 0) return { id: 'loops', title, status: 'warn', detail: 'No idle, walk or run clip to check.', fix: 'Map the idle and walk or run roles to looping clips.' };
  if (bad.length === 0) return { id: 'loops', title, status: 'pass', detail: `${list(checked)} ${checked.length === 1 ? 'ends' : 'end'} where ${checked.length === 1 ? 'it starts' : 'they start'}.` };
  return { id: 'loops', title, status: 'warn', detail: `${bad.join('; ')}: the loop jumps each time it wraps.`, fix: 'Make the last keyframe a copy of the first (in Blender, copy frame 1 to the end frame).' };
}

function materialsCheck(json: unknown): Check {
  const title = 'Materials';
  const missing: string[] = [];
  const jsonMeshes: unknown[] = isRecord(json) && Array.isArray(json.meshes) ? json.meshes : [];
  const nodes: unknown[] = isRecord(json) && Array.isArray(json.nodes) ? json.nodes : [];
  jsonMeshes.forEach((mesh, i) => {
    if (!isRecord(mesh)) return;
    const primitives: unknown[] = Array.isArray(mesh.primitives) ? mesh.primitives : [];
    if (!primitives.some((p) => isRecord(p) && p.material === undefined)) return;
    const name = typeof mesh.name === 'string' ? mesh.name : `mesh ${i}`;
    const node = nodes.find((n) => isRecord(n) && n.mesh === i);
    const nodeName = isRecord(node) && typeof node.name === 'string' && node.name !== name ? ` (node "${node.name}")` : '';
    missing.push(`"${name}"${nodeName}`);
  });
  if (missing.length === 0) return { id: 'materials', title, status: 'pass', detail: 'Every mesh has a material.' };
  return { id: 'materials', title, status: 'warn', detail: `${missing.join(', ')} ${missing.length === 1 ? 'has' : 'have'} no material and would draw plain white.`, fix: 'Give it a material, or delete it if it is left over (a stray default cube, say).' };
}

function rolesCheck(roles: ModelInput['roles'], still: boolean): Check {
  const title = 'Required roles';
  const missing: string[] = [];
  if (!roles.idle) missing.push('idle');
  if (!still && !roles.walk && !roles.run) missing.push('walk or run');
  if (!roles.attack && !roles.cast && !roles.shoot) missing.push('attack, cast or shoot');
  if (!roles.hit) missing.push('hit');
  if (!roles.death) missing.push('death');
  if (missing.length === 0) return { id: 'roles', title, status: 'pass', detail: still ? 'Idle, an attack, hit and death are all mapped; it never moves, so it needs no walk.' : 'Idle, locomotion, an attack, hit and death are all mapped.' };
  return { id: 'roles', title, status: 'warn', detail: `No clip for ${missing.join(', ')}.`, fix: 'Add the missing clips in Blender (as NLA actions) or map an existing clip in the table.' };
}

function hasAnimatedAncestor(node: Object3D, animated: ReadonlySet<Object3D>): boolean {
  for (let p = node.parent; p; p = p.parent) if (animated.has(p)) return true;
  return false;
}

/** Largest horizontal distance the topmost animated nodes travel from their first key, in world units. */
function rootTravel(scene: Object3D, clip: AnimationClip): { node: string; distance: number } | null {
  const animated = new Set<Object3D>();
  for (const t of clip.tracks) {
    const n = trackNode(scene, t.name);
    if (n) animated.add(n);
  }
  let best: { node: string; distance: number } | null = null;
  for (const t of clip.tracks) {
    if (property(t.name) !== 'position') continue;
    const node = trackNode(scene, t.name);
    if (!node || hasAnimatedAncestor(node, animated)) continue;
    const parentWorld = node.parent?.matrixWorld;
    const at = (i: number) => {
      const p = new Vector3(t.values[i * 3], t.values[i * 3 + 1], t.values[i * 3 + 2]);
      return parentWorld ? p.applyMatrix4(parentWorld) : p;
    };
    const first = at(0);
    const keys = t.values.length / 3;
    for (let i = 1; i < keys; i++) {
      const p = at(i);
      const d = Math.hypot(p.x - first.x, p.z - first.z);
      if (!best || d > best.distance) best = { node: label(node), distance: d };
    }
  }
  return best;
}

function rootMotionCheck(scene: Object3D, clips: readonly AnimationClip[], roles: ModelInput['roles'], height: number): Check {
  const title = 'Root motion';
  const moving: string[] = [];
  const checked: string[] = [];
  for (const role of ['walk', 'run'] as const) {
    const name = roles[role];
    const clip = name === undefined ? undefined : clips.find((c) => c.name === name);
    if (!clip || checked.includes(clip.name)) continue;
    checked.push(clip.name);
    const travel = rootTravel(scene, clip);
    if (travel && travel.distance > height * LIMITS.rootMotion) moving.push(`${clip.name} moves "${travel.node}" ${round(travel.distance)} sideways`);
  }
  if (checked.length === 0) return { id: 'rootMotion', title, status: 'pass', detail: 'No walk or run clip mapped, so nothing to check.' };
  if (moving.length === 0) return { id: 'rootMotion', title, status: 'pass', detail: `${list(checked)} ${checked.length === 1 ? 'stays' : 'stay'} in place.` };
  return { id: 'rootMotion', title, status: 'warn', detail: `${moving.join('; ')}. The game moves the monster itself, so the model runs ahead and snaps back.`, fix: 'Export the walk in place: remove the root bone\'s forward translation.' };
}

export function checkModel(input: ModelInput): ModelReport {
  const { scene, clips, json, bytes, roles, flags = {} } = input;
  scene.updateMatrixWorld(true);
  const ms = meshes(scene);
  const boxes = new Map<Mesh, Box3>();
  const overall = new Box3();
  for (const m of ms) {
    const b = meshBox(m);
    boxes.set(m, b);
    overall.union(b);
  }
  const size = overall.isEmpty() ? new Vector3() : overall.getSize(new Vector3());
  const center = overall.isEmpty() ? new Vector3() : overall.getCenter(new Vector3());
  const height = size.y;
  const triangles = triangleCount(ms);
  const facing = estimateFacing(scene, ms, boxes, center, size, height);
  const skinned = ms.some((m) => m instanceof SkinnedMesh);
  const animation = skinned ? 'skinned' : clips.length > 0 ? 'rigid' : 'none';
  const mb = bytes / (1024 * 1024);

  const checks: Check[] = [
    triangles > LIMITS.triangles
      ? { id: 'triangles', title: 'Triangles', status: 'warn', detail: `${triangles} triangles, above the ${LIMITS.triangles} a monster can afford in a pack.`, fix: `Decimate in Blender (Modifiers, Decimate) to under ${LIMITS.triangles}.` }
      : { id: 'triangles', title: 'Triangles', status: 'pass', detail: `${triangles} triangles.` },
    bytes > LIMITS.bytes
      ? { id: 'size', title: 'File size', status: 'warn', detail: `${round(mb, 1)} MB, above 3 MB; every player downloads it.`, fix: 'Shrink textures to 1024 px or less, or bake colours into materials instead of textures.' }
      : { id: 'size', title: 'File size', status: 'pass', detail: `${bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${round(mb, 1)} MB`}.` },
    facingCheck(facing),
    feetCheck(ms, boxes, overall, height, flags.floats === true),
    coloursCheck(ms, json),
    loopsCheck(clips, roles, height),
    materialsCheck(json),
    rolesCheck(roles, flags.static === true),
    rootMotionCheck(scene, clips, roles, height),
    animation === 'none'
      ? { id: 'rig', title: 'Animation', status: 'warn', detail: 'The file has no animations.', fix: 'Add at least idle, walk, attack, hit and death clips.' }
      : { id: 'rig', title: 'Animation', status: 'pass', detail: animation === 'skinned' ? 'Skinned: meshes follow a skeleton.' : 'Rigid nodes: whole parts move, with no skeleton. Both work in the game.' },
  ];
  return { checks, facing, triangles, height, animation };
}
