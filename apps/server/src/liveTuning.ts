import { modelOverridesOf, MonsterTuning, type EnemyOverride, type EnemyTypeId, type MinionOverride, type MinionTypeId, type ServerMessage, type TuningOverrides } from '@rune/shared';
import type { TuningStore } from './tuningStore.js';

/**
 * The server's current monster and minion overrides. Every change makes a new MonsterTuning, which
 * the room manager hands to each room: new spawns read it, monsters already alive keep theirs.
 */
export class LiveTuning {
  current: MonsterTuning;

  constructor(private readonly store: TuningStore) {
    this.current = new MonsterTuning(store.load());
  }

  get overrides(): TuningOverrides {
    return this.current.overrides;
  }

  /** Model and height overrides for every game client; stats stay on the server. */
  modelsMessage(): ServerMessage {
    return { t: 'models', models: modelOverridesOf(this.current.overrides) };
  }

  /** Returns whether any model or height changed, so clients only hear about changes they draw. */
  setMonster(typeId: EnemyTypeId, o: EnemyOverride | null): boolean {
    const before = JSON.stringify(modelOverridesOf(this.overrides));
    const monsters = { ...this.overrides.monsters };
    if (o) monsters[typeId] = o;
    else delete monsters[typeId];
    this.store.save('monsters', typeId, o);
    return this.replace({ ...this.overrides, monsters }, before);
  }

  setMinion(typeId: MinionTypeId, o: MinionOverride | null): boolean {
    const before = JSON.stringify(modelOverridesOf(this.overrides));
    const minions = { ...this.overrides.minions };
    if (o) minions[typeId] = o;
    else delete minions[typeId];
    this.store.save('minions', typeId, o);
    return this.replace({ ...this.overrides, minions }, before);
  }

  private replace(next: TuningOverrides, modelsBefore: string): boolean {
    this.current = new MonsterTuning(next);
    return JSON.stringify(modelOverridesOf(next)) !== modelsBefore;
  }
}
