import {
  AmbientLight,
  Box3,
  DirectionalLight,
  Group,
  Mesh,
  PerspectiveCamera,
  Scene,
  SkinnedMesh,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type Object3D,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { create } from 'zustand';
import type { IconModel } from './itemView.js';

/**
 * Item icons rendered from the real KayKit meshes. One small offscreen WebGL renderer draws each
 * model once to a transparent PNG, which is cached by key and shown as a plain <img>. Renders are
 * queued and done one per frame so opening the bag never stalls the game loop.
 */

const SIZE = 128;

interface IconStore {
  urls: Record<string, string>;
  /** Models that could not be loaded; their drawn icon stays. */
  failed: Record<string, true>;
}

export const useModelIcons = create<IconStore>(() => ({ urls: {}, failed: {} }));

let renderer: WebGLRenderer | null = null;
const loader = new GLTFLoader();
const files = new Map<string, Promise<Group>>();
const queued = new Set<string>();
const queue: { key: string; model: IconModel }[] = [];
let pumping = false;

function load(url: string): Promise<Group> {
  let p = files.get(url);
  if (!p) {
    p = loader.loadAsync(url).then((g) => g.scene);
    files.set(url, p);
  }
  return p;
}

function getRenderer(): WebGLRenderer | null {
  if (renderer) return renderer;
  try {
    renderer = new WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
  } catch {
    // No WebGL (or too many contexts): the drawn icons are used instead.
    return null;
  }
  renderer.setPixelRatio(1);
  renderer.setSize(SIZE, SIZE, false);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = SRGBColorSpace;
  return renderer;
}

/** A detached copy of the named mesh (or the whole file), reset to sit at the origin. */
function extract(scene: Group, node: string | undefined): Object3D | null {
  const source = node ? scene.getObjectByName(node) : scene;
  if (!source) return null;
  const copy = source.clone(true);
  copy.position.set(0, 0, 0);
  copy.rotation.set(0, 0, 0);
  copy.scale.set(1, 1, 1);
  copy.visible = true;
  copy.traverse((o) => {
    o.visible = true;
  });
  // Skinned parts (a hat bound to the head) would follow the source rig's bones; a plain mesh with
  // the same geometry draws them in their bind pose instead.
  const skinned: SkinnedMesh[] = [];
  copy.traverse((o) => {
    if (o instanceof SkinnedMesh) skinned.push(o);
  });
  for (const sm of skinned) {
    const plain = new Mesh(sm.geometry, sm.material);
    plain.position.copy(sm.position);
    plain.quaternion.copy(sm.quaternion);
    plain.scale.copy(sm.scale);
    if (sm === copy) return plain;
    sm.parent?.add(plain);
    sm.removeFromParent();
  }
  return copy;
}

async function renderOne(key: string, model: IconModel): Promise<void> {
  const r = getRenderer();
  if (!r) {
    useModelIcons.setState((s) => ({ failed: { ...s.failed, [key]: true } }));
    return;
  }
  const file = await load(model.url);
  const object = extract(file, model.node);
  if (!object) {
    useModelIcons.setState((s) => ({ failed: { ...s.failed, [key]: true } }));
    return;
  }
  const scene = new Scene();
  const pivot = new Group();
  pivot.add(object);
  scene.add(pivot);

  // Lay the model's longest axis along the icon's diagonal, like a weapon laid on a D2 grid.
  const box = new Box3().setFromObject(pivot);
  const size = box.getSize(new Vector3());
  const long = size.y >= size.x && size.y >= size.z ? 'y' : size.x >= size.z ? 'x' : 'z';
  if (long === 'x') pivot.rotation.z = Math.PI / 2;
  if (long === 'z') pivot.rotation.x = Math.PI / 2;
  pivot.rotation.y += ((model.spin ?? 30) * Math.PI) / 180;
  const tall = Math.max(size.x, size.y, size.z);
  // Long things lean 45 degrees; compact ones (helmets) stay upright.
  if (tall > 2.2 * Math.min(size.x, size.y, size.z) && long !== 'z') pivot.rotation.z += -Math.PI / 4;
  pivot.updateMatrixWorld(true);
  const fitted = new Box3().setFromObject(pivot);
  const centre = fitted.getCenter(new Vector3());
  pivot.position.sub(centre);
  const extent = fitted.getSize(new Vector3());
  // The bounding sphere of a long diagonal weapon wastes the corners; framing a bit tighter fills the cell.
  const radius = (extent.length() / 2) * 0.78;

  const camera = new PerspectiveCamera(30, 1, radius * 0.1, radius * 20);
  const dist = radius / Math.sin((30 * Math.PI) / 360);
  camera.position.set(0.35 * dist, 0.25 * dist, dist);
  camera.lookAt(0, 0, 0);

  scene.add(new AmbientLight(0xffffff, 1.6));
  const key1 = new DirectionalLight(0xfff2dd, 3.2);
  key1.position.set(2, 3, 4);
  scene.add(key1);
  // Rim light from behind so dark handles still read against the dark cell.
  const rim = new DirectionalLight(0xbfd4ff, 2.2);
  rim.position.set(-3, 2, -4);
  scene.add(rim);

  r.render(scene, camera);
  const url = r.domElement.toDataURL('image/png');
  scene.traverse((o) => {
    if (o instanceof Mesh) {
      // Geometry and materials are shared with the cached file, so only the clone's wrapper goes.
      o.removeFromParent();
    }
  });
  useModelIcons.setState((s) => ({ urls: { ...s.urls, [key]: url } }));
}

function pump(): void {
  if (pumping) return;
  pumping = true;
  const step = (): void => {
    const next = queue.shift();
    if (!next) {
      pumping = false;
      return;
    }
    renderOne(next.key, next.model)
      .catch(() => useModelIcons.setState((s) => ({ failed: { ...s.failed, [next.key]: true } })))
      .finally(() => requestAnimationFrame(step));
  };
  requestAnimationFrame(step);
}

/** Asks for an icon; cheap to call on every render, only the first request queues work. */
export function requestModelIcon(key: string, model: IconModel): void {
  if (queued.has(key)) return;
  queued.add(key);
  queue.push({ key, model });
  pump();
}

/** Frees the GPU context, for the dev page or tests that tear the UI down. */
export function disposeIconRenderer(): void {
  renderer?.dispose();
  renderer?.forceContextLoss();
  renderer = null;
}
