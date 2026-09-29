import { AmbientLight, AnimationMixer, ArrowHelper, Box3, Color, DirectionalLight, Fog, HemisphereLight, Mesh, MeshStandardMaterial, PlaneGeometry, PointLight, Vector3, type AnimationClip, type Object3D } from 'three';
import { AssetViewer } from '../../dev/assetViewer.js';
import { assetById, instantiate } from '../../render/assets.js';
import { COLORS } from '../../render/config.js';
import { applyGrit } from '../../render/grit.js';

// Same grime pass as the game, and it must be in place before the first material compiles.
applyGrit();

/** The wilds' daytime rig from render/scene.ts, so a monster looks here the way it does outdoors. */
const DAY = { sky: 0xa6aeb6, ground: 0x30251a, hemi: 1.3, ambient: 0.55, sun: 2.55, sunColor: 0xf2e4ca, exposure: 1.52, lamp: 2 };
const MOONLIGHT = 0x7488c8;
/** The game's night at the default night brightness (0.6): see WorldScene.applyDaylight. */
const KEEP = 0.3 + 0.7 * 0.6;
const NIGHT_EXPOSURE = 0.8;
const NIGHT_DIM = 0.75;

export interface StageModel {
  root: Object3D;
  clips: AnimationClip[];
}

/**
 * The dev tools' asset viewer in the game's look: dark ground, the outdoor light rig with a night
 * version, the canvas grade, and a hero beside the model for scale.
 */
export class MonsterViewer extends AssetViewer {
  private readonly hemi = new HemisphereLight(DAY.sky, DAY.ground, DAY.hemi);
  private readonly ambient = new AmbientLight(0x505060, DAY.ambient);
  private readonly sun = new DirectionalLight(DAY.sunColor, DAY.sun);
  /** The hero's own light, which carries the scene at night as in the game. */
  private readonly lamp = new PointLight(0xffd6a0, DAY.lamp, 520, 1.4);
  private arrow: ArrowHelper | null = null;
  private token = 0;

  constructor(host: HTMLElement) {
    super(host);
    for (const o of this.studio) this.scene.remove(o);
    this.scene.background = new Color(COLORS.background);
    this.scene.fog = new Fog(COLORS.background, 700, 2600);
    const ground = new Mesh(new PlaneGeometry(20000, 20000), new MeshStandardMaterial({ color: 0x3a3428, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.sun.position.set(-400, 900, 250);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -400, right: 400, top: 400, bottom: -400, far: 3000 });
    this.lamp.position.set(40, 120, 60);
    this.scene.add(ground, this.hemi, this.ambient, this.sun, this.lamp);
    this.renderer.domElement.classList.add('mon-graded');
    this.setNight(false);
  }

  setNight(night: boolean): void {
    const mix = (day: number, dark: number) => (night ? dark : day);
    this.hemi.intensity = mix(DAY.hemi, DAY.hemi * KEEP) * mix(1, NIGHT_DIM);
    this.ambient.intensity = mix(DAY.ambient, DAY.ambient * Math.min(1, KEEP + 0.2)) * mix(1, NIGHT_DIM);
    this.sun.intensity = mix(DAY.sun, DAY.sun * KEEP * 0.8) * mix(1, NIGHT_DIM);
    this.sun.color.setHex(night ? MOONLIGHT : DAY.sunColor);
    this.lamp.intensity = mix(DAY.lamp, DAY.lamp * 3);
    this.lamp.distance = mix(520, 700);
    this.lamp.decay = mix(1.4, 0.9);
    this.renderer.toneMappingExposure = mix(DAY.exposure, DAY.exposure * NIGHT_EXPOSURE);
  }

  /**
   * Puts the model at the origin facing +x (game forward) with a hero beside it. `arrow` draws the
   * file's +Z, which the game turns to face forward, so a model facing elsewhere is plain to see.
   */
  async showModel(load: () => Promise<StageModel>, opts: { arrow: boolean }): Promise<string[]> {
    const token = ++this.token;
    const [model, hero] = await Promise.all([load(), heroModel()]);
    // A newer request finished first or is still loading; this one is stale.
    if (token !== this.token) return [];
    this.clear();
    if (this.arrow) this.scene.remove(this.arrow);
    this.arrow = null;
    this.scene.add(model.root);
    this.placed.push(model.root);
    const mixer = new AnimationMixer(model.root);
    this.mixers.push(mixer);
    this.current = { clips: model.clips, mixer, action: null };

    const size = new Box3().setFromObject(model.root).getSize(new Vector3());
    const height = Math.max(20, size.y);
    const beside = Math.max(size.z, size.x) / 2 + 36;
    if (hero) {
      hero.root.position.set(0, 0, beside);
      this.scene.add(hero.root);
      this.placed.push(hero.root);
      const heroMixer = new AnimationMixer(hero.root);
      const idle = hero.clips.find((c) => c.name === 'Idle');
      if (idle) heroMixer.clipAction(idle).play();
      this.mixers.push(heroMixer);
    }
    if (opts.arrow) {
      const length = Math.max(40, Math.max(size.x, size.z) * 0.9);
      this.arrow = new ArrowHelper(new Vector3(1, 0, 0), new Vector3(0, 3, 0), length, 0xffd36b, length * 0.2, length * 0.12);
      this.scene.add(this.arrow);
    }
    const d = Math.max(140, height * 2.6, beside * 3);
    this.controls.target.set(0, height * 0.42, beside / 2);
    this.camera.position.set(d * 0.75, d * 0.62, d * 0.95 + beside / 2);
    this.camera.updateProjectionMatrix();
    return model.clips.map((c) => c.name);
  }

  playClip(name: string, loop: boolean): void {
    this.play(name, !loop);
  }

  pause(paused: boolean): void {
    const a = this.current?.action;
    if (a) a.paused = paused;
  }

  scrub(time: number): void {
    const a = this.current?.action;
    if (!a) return;
    a.paused = true;
    a.time = Math.max(0, Math.min(time, a.getClip().duration));
  }

  clipState(): { name: string; time: number; duration: number; paused: boolean } | null {
    const a = this.current?.action;
    if (!a) return null;
    const clip = a.getClip();
    return { name: clip.name, time: a.time, duration: clip.duration, paused: a.paused };
  }
}

async function heroModel(): Promise<StageModel | null> {
  const def = assetById('hero_barbarian');
  if (!def) return null;
  try {
    return await instantiate(def);
  } catch {
    return null;
  }
}
