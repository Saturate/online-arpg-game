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
import { applyGrit } from './grit.js';
import { lampLevel, lighting, nightFactor, overcast } from './daylight.js';
import { buildWorld, type BuiltWorld } from './props.js';
import { useSettings } from '../ui/settings.js';
import { fadeUniforms } from './occluderFade.js';

const DEG = Math.PI / 180;

/** Screen-space basis vectors on the ground, used to turn WASD into world directions. */
export interface GroundBasis {
  right: Vec2;
  up: Vec2;
}

// Before any material compiles; see grit.ts.
applyGrit();

const MOONLIGHT = new Color(0x7488c8);
/** The sun's colour under heavy cloud: grey and cold. */
const CLOUDLIGHT = new Color(0x9aa0a8);

interface Lighting {
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
  // Dark and gritty, D2 Act 1 and PoE, but a clear day is sunny: the gloom comes from the grade,
  // the weather (overcast spells dim it) and the night, not from a permanently dim sun.
  town: { sky: 0xc4b69c, groundLight: 0x3a2e20, hemi: 1.45, ambient: 0.6, sun: 2.7, sunColor: 0xffd6a0, exposure: 1.6, playerLight: 2.2 },
  wilds: { sky: 0xa6aeb6, groundLight: 0x30251a, hemi: 1.3, ambient: 0.55, sun: 2.55, sunColor: 0xf2e4ca, exposure: 1.52, playerLight: 2.0 },
  arena: { sky: 0x9aa8d0, groundLight: 0x3a2a1c, hemi: 1.0, ambient: 0.6, sun: 1.6, sunColor: 0xffe2c0, exposure: 1.3, playerLight: 2.2 },
  // Underground: almost no sky, torches and the hero's own light do the work.
  dungeon: { sky: 0x6a7aa0, groundLight: 0x2a2018, hemi: 0.7, ambient: 0.45, sun: 0.5, sunColor: 0x8090c0, exposure: 1.3, playerLight: 1.8, playerDecay: 0 },
  staging: { sky: 0x7a80a0, groundLight: 0x2a2018, hemi: 0.85, ambient: 0.5, sun: 0.6, sunColor: 0x9098c0, exposure: 1.3, playerLight: 1.6, playerDecay: 0 },
  flat: { sky: 0xffffff, groundLight: 0x444444, hemi: 1, ambient: 0.6, sun: 1.5, sunColor: 0xffffff, exposure: 1.1, playerLight: 1 },
};

export class WorldScene {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: OrthographicCamera;
  readonly basis: GroundBasis;
  private readonly sun: DirectionalLight;
  private readonly playerLight: PointLight;
  private readonly hemi: HemisphereLight;
  private readonly ambient: AmbientLight;
  /** The theme's daytime lighting; night is blended from it outdoors. */
  private readonly base: Lighting;
  private readonly outdoors: boolean;
  private readonly sunDay = new Color();
  private lastNight = -1;
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
  /** Reading the host's size every frame forces a layout; an observer flags the rare real change instead. */
  private readonly resizeObserver: ResizeObserver;
  private sizeDirty = true;
  private readonly projected = new Vector3();

  constructor(
    private readonly host: HTMLElement,
    def: WorldMap,
  ) {
    const light = LIGHTING[def.theme];
    this.base = light;
    this.outdoors = def.theme === 'town' || def.theme === 'wilds' || def.theme === 'arena';
    this.sunDay.setHex(light.sunColor);
    this.renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = light.exposure;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    host.appendChild(this.renderer.domElement);

    this.scene.background = new Color(COLORS.background);
    this.scene.fog = new Fog(COLORS.background, VIEW.cameraDistance * 0.9, VIEW.cameraDistance * 1.6);
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 1, VIEW.cameraDistance * 3);

    const yaw = VIEW.yawDegrees * DEG;
    const pitch = VIEW.pitchDegrees * DEG;
    this.offset = new Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(VIEW.cameraDistance);
    fadeUniforms.uFadeDir.value.set(this.offset.x, this.offset.z).normalize();
    // Forward on the ground is the camera's look direction flattened; right is perpendicular to it.
    const up = { x: -Math.sin(yaw), y: -Math.cos(yaw) };
    this.basis = { up, right: { x: -up.y, y: up.x } };

    this.hemi = new HemisphereLight(light.sky, light.groundLight, light.hemi);
    this.ambient = new AmbientLight(0x505060, light.ambient);
    this.scene.add(this.hemi, this.ambient);
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
    this.resizeObserver = new ResizeObserver(() => {
      this.sizeDirty = true;
    });
    this.resizeObserver.observe(host);
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  addShake(amount: number): void {
    if (!useSettings.getState().options.screenShake) return;
    this.shake = Math.min(20, this.shake + amount);
  }

  resize(): void {
    this.sizeDirty = false;
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
    this.applyDaylight();
    fadeUniforms.uFadeCenter.value.set(x, 0, y);
    this.world.update(this.time, x, y);
  }

  /**
   * Outdoors the light follows the time of day: at night the sun turns to faint blue moonlight,
   * the sky dims, and lamps and the hero's own light carry the scene, D2 style. Underground is
   * lit by torches either way.
   */
  private applyDaylight(): void {
    const night = this.outdoors ? nightFactor() : 0;
    const cloud = this.outdoors ? overcast() : 0;
    lampLevel.value = 1 + night * 1.4 + cloud * 0.3;
    // The light only changes over minutes; skipping unchanged frames saves the uniform churn.
    const key = night + lighting.nightBrightness * 10 + cloud * 100;
    if (Math.abs(key - this.lastNight) < 0.002) return;
    this.lastNight = key;
    const b = this.base;
    const mix = (day: number, dark: number) => day + (dark - day) * night;
    // How much light night keeps is the admin's call (nightBrightness): 0 is pitch, 1 is daylight.
    const keep = 0.3 + 0.7 * lighting.nightBrightness;
    // Cloud mostly takes the sun away and flattens the light; the sky light dims less, so an
    // overcast day is grey and shadowless rather than dark.
    const sunCloud = 1 - 0.5 * cloud;
    const skyCloud = 1 - 0.1 * cloud;
    this.hemi.intensity = mix(b.hemi, b.hemi * keep) * skyCloud;
    // Cloud scatters light: flat fill rises a little while the sun fades.
    this.ambient.intensity = mix(b.ambient, b.ambient * Math.min(1, keep + 0.2)) * (1 + 0.25 * cloud);
    this.sun.intensity = mix(b.sun, b.sun * keep * 0.8) * sunCloud;
    this.sun.color.copy(this.sunDay).lerp(CLOUDLIGHT, cloud * 0.7).lerp(MOONLIGHT, night);
    // The hero's light becomes the D2 light radius: brighter and slower to fall off.
    this.playerLight.intensity = mix(b.playerLight, b.playerLight * 3);
    this.playerLight.distance = mix(520, 700);
    this.playerLight.decay = mix(b.playerDecay ?? 1.4, 0.9);
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
    if (this.sizeDirty) this.resize();
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
    const v = this.projected.set(x, height, y).project(this.camera);
    return { x: ((v.x + 1) / 2) * this.width, y: ((1 - v.y) / 2) * this.height };
  }

  /** Room changes rebuild the whole scene, so everything on the GPU for this one is released. */
  dispose(): void {
    this.resizeObserver.disconnect();
    this.world.dispose();
    this.scene.traverse((o) => {
      if (o instanceof Mesh) o.geometry.dispose();
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
