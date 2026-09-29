import { ENEMIES, ENEMY_TYPE_IDS, MINION_DEFS, MINION_TYPE_IDS } from '@rune/shared';
import { Group } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { ENEMY_ASSETS, MINION_ASSETS } from '../render/characters.js';
import { enemyModel, minionModel, uniqueMaterials, type Rig } from '../render/models.js';

/**
 * Monsters with no model file: models.ts builds them from primitives at runtime. The Assets tab
 * lists them so they can be viewed and exported as .glb for editing in Blender.
 */
export interface BuiltinModel {
  id: string;
  label: string;
  /** Collision radius in world units; the rig is built at radius 1 and scaled by this in game. */
  radius: number;
  build: () => Rig;
}

export const BUILTIN_MODELS: BuiltinModel[] = [
  ...ENEMY_TYPE_IDS.filter((id) => ENEMY_ASSETS[id] === undefined).map((id) => {
    const def = ENEMIES[id];
    return { id, label: def.name, radius: def.radius, build: () => enemyModel(id, def.color) };
  }),
  ...MINION_TYPE_IDS.filter((id) => MINION_ASSETS[id] === undefined).map((id) => {
    const def = MINION_DEFS[id];
    return { id: `minion_${id}`, label: `${def.name} (minion)`, radius: def.radius, build: () => minionModel(id, def.color) };
  }),
];

/** At game size the player is 54 units tall; KayKit heroes are about 1.8 m, so 30 units make a metre. */
const UNITS_PER_METRE = 30;

/** Builds the model at its in-game size, in world units. */
export function buildBuiltin(m: BuiltinModel): Rig {
  const rig = m.build();
  rig.root.scale.multiplyScalar(m.radius);
  uniqueMaterials(rig.root);
  return rig;
}

/** Downloads the model as a binary glTF in metres, facing +x with its feet at the origin, as the game builds it. */
export async function exportBuiltin(m: BuiltinModel): Promise<void> {
  const rig = buildBuiltin(m);
  const wrap = new Group();
  wrap.name = m.id;
  wrap.scale.setScalar(1 / UNITS_PER_METRE);
  wrap.add(rig.root);
  const data = await new GLTFExporter().parseAsync(wrap, { binary: true });
  if (!(data instanceof ArrayBuffer)) throw new Error('Exporter returned JSON instead of a binary file');
  const url = URL.createObjectURL(new Blob([data], { type: 'model/gltf-binary' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${m.id}.glb`;
  a.click();
  // Revoked on the next task: some browsers start the download only after the click handler returns.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
