import type { MapTheme, Vec2, WorldMap } from '@rune/shared';
import {
  ACESFilmicToneMapping,
  AmbientLight,
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  Mesh,
  OrthographicCamera,
  PCFShadowMap,
  Plane,
  PointLight,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { COLORS, VIEW } from './config.js';
import { buildWorld, type BuiltWorld } from './props.js';
import { useSettings } from '../ui/settings.js';
import { fadeUniforms } from './occluderFade.js';

const DEG = Math.PI / 180;

/** Screen-space basis vectors on the ground, used to turn WASD into world directions. */
export interface GroundBasis {
  right: Vec2;
  up: Vec2;
}

interface Lighting {
  /** Background and fog colour. Outdoors a soft sky, so the edge of view reads as haze, not a void. */
  backdrop: number;
  sky: number;
  groundLight: number;
  hemi: number;
  ambient: number;
  sun: number;
  sunColor: number;
  exposure: number;
  playerLight: number;
  /** Falloff exponent for the hero's light. 0 keeps only the windowed falloff to its range, for lit-by-torch places. */
  playerDecay?: number;
}

/** Each theme gets its own time of day. */
const LIGHTING: Record<MapTheme, Lighting> = {
// Bright and friendly on purpose: the art is cute low-poly, so the lighting should be a sunny day, not grim.
  town: { backdrop: 0xcfe6ff, sky: 0xfff0d8, groundLight: 0x6a5a40, hemi: 1.6, ambient: 0.8, sun: 2.2, sunColor: 0xffe4b8, exposure: 1.28, playerLight: 1.2 },
  wilds: { backdrop: 0xcfe6ff, sky: 0xdcecff, groundLight: 0x6a5a40, hemi: 1.5, ambient: 0.75, sun: 2.3, sunColor: 0xfff4e0, exposure: 1.22, playerLight: 0.6 },
  arena: { backdrop: 0xe0dcff, sky: 0xd8dcff, groundLight: 0x5a4a38, hemi: 1.3, ambient: 0.8, sun: 1.9, sunColor: 0xffecd0, exposure: 1.35, playerLight: 1.6 },
  // Underground stays cosy rather than pitch black: torches do the mood, the ambient keeps it readable.
  dungeon: { backdrop: 0x3a3058, sky: 0xb0a8e8, groundLight: 0x4a3a50, hemi: 1.1, ambient: 0.8, sun: 0.8, sunColor: 0xc0b8f0, exposure: 1.35, playerLight: 1.8, playerDecay: 0 },
  staging: { backdrop: 0x3a3058, sky: 0xb8b0e8, groundLight: 0x4a3a50, hemi: 1.2, ambient: 0.8, sun: 0.9, sunColor: 0xc8c0f0, exposure: 1.35, playerLight: 1.6, playerDecay: 0 },
  flat: { backdrop: 0xe8eef4, sky: 0xffffff, groundLight: 0x444444, hemi: 1, ambient: 0.6, sun: 1.5, sunColor: 0xffffff, exposure: 1.1, playerLight: 1 },
};

export class WorldScene {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: OrthographicCamera;
  readonly basis: GroundBasis;
  private readonly sun: DirectionalLight;
  private readonly playerLight: PointLight;
  private readonly offset: Vector3;
  private readonly raycaster = new Raycaster();
  private readonly ground = new Plane(new Vector3(0, 1, 0), 0);
  private world: BuiltWorld;
  /** Editor gizmos: footprints, selection, brush previews. */
  readonly overlay = new Group();
  private shake = 0;
  private time = 0;
  private width = 1;
  private height = 1;

  constructor(
    private readonly host: HTMLElement,
    def: WorldMap,
  ) {
    const light = LIGHTING[def.theme];
    this.renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = light.exposure;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    host.appendChild(this.renderer.domElement);

    this.scene.background = new Color(light.backdrop);
    this.scene.fog = new Fog(light.backdrop, VIEW.cameraDistance * 0.9, VIEW.cameraDistance * 1.6);
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 1, VIEW.cameraDistance * 3);

    const yaw = VIEW.yawDegrees * DEG;
    const pitch = VIEW.pitchDegrees * DEG;
    this.offset = new Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(VIEW.cameraDistance);
    fadeUniforms.uFadeDir.value.set(this.offset.x, this.offset.z).normalize();
    // Forward on the ground is the camera's look direction flattened; right is perpendicular to it.
    const up = { x: -Math.sin(yaw), y: -Math.cos(yaw) };
    this.basis = { up, right: { x: -up.y, y: up.x } };

    this.scene.add(new HemisphereLight(light.sky, light.groundLight, light.hemi));
    this.scene.add(new AmbientLight(0x9098b0, light.ambient));
    this.sun = new DirectionalLight(light.sunColor, light.sun);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const e = VIEW.shadowExtent;
    Object.assign(this.sun.shadow.camera, { left: -e, right: e, top: e, bottom: -e, near: 10, far: 3000 });
    this.sun.shadow.bias = -0.0008;
    this.scene.add(this.sun, this.sun.target);

    // The player carries a warm light, so the area around them always reads well.
    this.playerLight = new PointLight(0xffd6a0, light.playerLight, 520, light.playerDecay ?? 1.4);
    this.scene.add(this.playerLight);

    this.world = buildWorld(def);
    this.scene.add(this.world.group, this.overlay);
    this.resize();
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  addShake(amount: number): void {
    if (!useSettings.getState().options.screenShake) return;
    this.shake = Math.min(20, this.shake + amount);
  }

  resize(): void {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    const halfH = VIEW.viewHeight / 2;
    const halfW = halfH * (w / h);
    Object.assign(this.camera, { left: -halfW, right: halfW, top: halfH, bottom: -halfH });
    this.camera.updateProjectionMatrix();
  }

  follow(x: number, y: number, dt: number): void {
    this.time += dt;
    this.shake = Math.max(0, this.shake - VIEW.shakeDecayPerSecond * dt * Math.max(1, this.shake));
    const sx = this.shake > 0 ? (Math.random() - 0.5) * this.shake : 0;
    const sz = this.shake > 0 ? (Math.random() - 0.5) * this.shake : 0;
    this.camera.position.set(x + this.offset.x + sx, this.offset.y, y + this.offset.z + sz);
    this.camera.lookAt(x + sx, 0, y + sz);
    this.sun.position.set(x - 400, 900, y + 250);
    this.sun.target.position.set(x, 0, y);
    this.playerLight.position.set(x, 120, y);
    fadeUniforms.uFadeCenter.value.set(x, 0, y);
    this.world.update(this.time, x, y);
  }

  /** Replaces the static world geometry, for the town editor's live preview. */
  rebuildWorld(def: WorldMap): void {
    this.world.dispose();
    this.scene.remove(this.world.group);
    this.world.group.traverse((o) => {
      if (o instanceof Mesh) o.geometry.dispose();
    });
    this.world = buildWorld(def);
    this.scene.add(this.world.group);
  }

  /** Camera zoom for the editor; 1 is the normal game view. */
  setZoom(zoom: number): void {
    this.camera.zoom = zoom;
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    this.resize();
    this.renderer.render(this.scene, this.camera);
  }

  /** Canvas pixel position to the point on the ground under it, in simulation coordinates. */
  screenToGround(px: number, py: number): Vec2 | null {
    const ndc = new Vector2((px / this.width) * 2 - 1, -(py / this.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new Vector3();
    if (!this.raycaster.ray.intersectPlane(this.ground, hit)) return null;
    return { x: hit.x, y: hit.z };
  }

  /** Simulation position (plus height) to canvas pixels, for DOM overlays like damage numbers. */
  project(x: number, y: number, height: number): Vec2 {
    const v = new Vector3(x, height, y).project(this.camera);
    return { x: ((v.x + 1) / 2) * this.width, y: ((1 - v.y) / 2) * this.height };
  }

  /** Room changes rebuild the whole scene, so everything on the GPU for this one is released. */
  dispose(): void {
    this.world.dispose();
    this.scene.traverse((o) => {
      if (o instanceof Mesh) o.geometry.dispose();
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
