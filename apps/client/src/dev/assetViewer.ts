import {
  AmbientLight,
  AnimationMixer,
  CapsuleGeometry,
  Color,
  DirectionalLight,
  GridHelper,
  HemisphereLight,
  LoopOnce,
  LoopRepeat,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  ACESFilmicToneMapping,
  Timer,
  WebGLRenderer,
  Box3,
  Vector3,
  type AnimationAction,
  type Object3D,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { instantiate, type AssetDef, type AssetInstance } from '../render/assets.js';

/** Height of the scale reference capsule: the player's size in world units. */
const PLAYER_HEIGHT = 54;

/**
 * Standalone three.js view for inspecting assets: a gallery of a whole category laid out in a
 * grid, or one asset with orbit controls and animation playback.
 */
export class AssetViewer {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly timer = new Timer();
  private readonly mixers: AnimationMixer[] = [];
  private placed: Object3D[] = [];
  private current: { inst: AssetInstance; mixer: AnimationMixer; action: AnimationAction | null } | null = null;
  private raf = 0;
  private disposed = false;
  /** Per-frame hook for procedural rigs, which animate in code instead of through a mixer. */
  private onFrame: ((dt: number) => void) | null = null;

  constructor(private readonly host: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    host.appendChild(this.renderer.domElement);
    this.scene.background = new Color(0x1a1a22);
    this.camera = new PerspectiveCamera(40, 1, 1, 20000);
    this.camera.position.set(160, 140, 220);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 20, 0);
    this.controls.enableDamping = true;

    this.scene.add(new HemisphereLight(0xdde6ff, 0x3a3020, 1.3), new AmbientLight(0xffffff, 0.3));
    const sun = new DirectionalLight(0xfff0d8, 2.2);
    sun.position.set(300, 500, 200);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -800, right: 800, top: 800, bottom: -800, far: 2000 });
    this.scene.add(sun);
    const ground = new Mesh(new PlaneGeometry(6000, 6000), new MeshStandardMaterial({ color: 0x4a5a3a, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground, new GridHelper(6000, 150, 0x3a4a2a, 0x3a4a2a));

    this.resize();
    const loop = (): void => {
      if (this.disposed) return;
      this.timer.update();
      const dt = this.timer.getDelta();
      for (const m of this.mixers) m.update(dt);
      this.onFrame?.(dt);
      this.controls.update();
      this.resize();
      this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private resize(): void {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    const c = this.renderer.domElement;
    if (c.width === Math.floor(w * this.renderer.getPixelRatio()) && c.height === Math.floor(h * this.renderer.getPixelRatio())) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private clear(): void {
    for (const p of this.placed) this.scene.remove(p);
    this.placed = [];
    this.mixers.length = 0;
    this.current = null;
    this.onFrame = null;
  }

  private scaleRef(x: number, z: number): void {
    const ref = new Mesh(new CapsuleGeometry(8, PLAYER_HEIGHT - 16, 4, 12), new MeshStandardMaterial({ color: 0xffd36b, transparent: true, opacity: 0.5 }));
    ref.position.set(x, PLAYER_HEIGHT / 2, z);
    this.scene.add(ref);
    this.placed.push(ref);
  }

  /** Lays a list of assets out in rows, largest first, with idle animations playing. */
  async showGallery(defs: AssetDef[]): Promise<void> {
    this.clear();
    const insts = await Promise.all(defs.map((d) => instantiate(d).catch(() => null)));
    const ok = insts.filter((i): i is AssetInstance => i !== null);
    const cols = Math.ceil(Math.sqrt(ok.length * 1.6));
    const cell = Math.max(60, ...ok.map((i) => i.def.height)) * 1.35;
    ok.forEach((inst, i) => {
      const x = (i % cols) * cell - ((cols - 1) * cell) / 2;
      const z = Math.floor(i / cols) * cell;
      inst.root.position.set(x, 0, z);
      inst.root.rotation.y = -Math.PI / 4;
      this.scene.add(inst.root);
      this.placed.push(inst.root);
      this.playRole(inst, 'idle');
    });
    this.scaleRef(-((cols + 1) * cell) / 2, 0);
    this.frame();
  }

  /** Points the camera so everything placed fits in view, looking down at the same angle as the game. */
  private frame(): void {
    const box = new Box3();
    for (const p of this.placed) box.expandByObject(p);
    if (box.isEmpty()) return;
    const center = box.getCenter(new Vector3());
    const size = box.getSize(new Vector3());
    const radius = Math.max(size.x, size.z, size.y * 1.5) * 0.42;
    const dist = radius / Math.sin((this.camera.fov * Math.PI) / 360) / Math.min(1, this.camera.aspect * 1.2);
    this.controls.target.copy(center);
    this.camera.position.set(center.x + dist * 0.45, center.y + dist * 0.7, center.z + dist * 0.55);
    this.camera.updateProjectionMatrix();
  }

  /** One asset in the middle, orbitable, with a player-height reference beside it. */
  async showSingle(def: AssetDef): Promise<string[]> {
    this.clear();
    const inst = await instantiate(def);
    this.scene.add(inst.root);
    this.placed.push(inst.root);
    this.scaleRef(-def.height * 0.6 - 30, 0);
    const mixer = new AnimationMixer(inst.root);
    this.mixers.push(mixer);
    this.current = { inst, mixer, action: null };
    this.playRole(inst, 'idle', mixer);
    const d = Math.max(90, def.height * 2.4);
    this.controls.target.set(0, def.height * 0.45, 0);
    this.camera.position.set(d * 0.7, def.height * 0.9 + 20, d);
    return inst.clips.map((c) => c.name);
  }

  /** An already built object (a procedural rig), shown like a single asset. */
  showObject(root: Object3D, onFrame: (dt: number) => void): void {
    this.clear();
    this.scene.add(root);
    this.placed.push(root);
    const height = new Box3().setFromObject(root).getSize(new Vector3()).y;
    this.scaleRef(-Math.max(40, height) * 0.6 - 30, 0);
    this.onFrame = onFrame;
    const d = Math.max(90, height * 2.4);
    this.controls.target.set(0, height * 0.45, 0);
    this.camera.position.set(d * 0.7, height * 0.9 + 20, d);
  }

  play(clipName: string, once: boolean): void {
    const cur = this.current;
    if (!cur) return;
    const clip = cur.inst.clips.find((c) => c.name === clipName);
    if (!clip) return;
    cur.action?.fadeOut(0.15);
    const action = cur.mixer.clipAction(clip);
    action.reset().setLoop(once ? LoopOnce : LoopRepeat, Infinity).fadeIn(0.15).play();
    action.clampWhenFinished = once;
    cur.action = action;
  }

  private playRole(inst: AssetInstance, role: 'idle', mixer?: AnimationMixer): void {
    const name = inst.def.clips?.[role];
    const clip = name ? inst.clips.find((c) => c.name === name) : undefined;
    if (!clip) return;
    const m = mixer ?? new AnimationMixer(inst.root);
    if (!mixer) this.mixers.push(m);
    const action = m.clipAction(clip);
    // Offset start times so a gallery of identical idles does not move in lockstep.
    action.time = Math.random() * clip.duration;
    action.play();
    if (this.current && mixer) this.current.action = action;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
