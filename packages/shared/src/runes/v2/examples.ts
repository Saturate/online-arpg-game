import type { GrammarContext } from './rules.js';

export interface ExampleSpell {
  id: string;
  name: string;
  text: string;
  context?: Partial<GrammarContext>;
  note: string;
}

/** The plan's examples plus the edge cases the grammar answers; shared by the tests and the Spell Lab. */
export const EXAMPLE_SPELLS: readonly ExampleSpell[] = [
  { id: 'winter', name: 'Winter orb', text: 'orb[slow, every 0.2s] cold split(4) bolt[small]', note: 'Split after the release point splits the payload.' },
  { id: 'linked', name: 'Linked balls', text: 'orb lightning split(3) link', note: 'No release, so Split and Link stay on the orb.' },
  { id: 'shield', name: 'Orbit shield', text: 'orb lightning split(3) orbit link', note: 'The plan\'s "swap Link for Orbit plus Link".' },
  {
    id: 'endgame',
    name: 'Endgame embers',
    text: 'orb[onexpire] fire split(6) orb[onhit, homing] nova zone[long]',
    context: { multicast: 2 },
    note: 'Nova and Zone are cast together inside the payload, so this needs multicast 2.',
  },
  { id: 'fireball', name: 'Fireball', text: 'orb[onhit, -15% speed, +30% damage] fire nova[after 0.5s] zone[long]', note: 'The plan\'s starter Fireball.' },
  { id: 'multishot', name: 'Multishot', text: 'arrow split(5)', note: 'Five arrows at once.' },
  { id: 'rain', name: 'Rain of arrows', text: 'arrow[onexpire] split(6) arrow[small]', note: 'One arrow that bursts into six at the end of its flight.' },
  { id: 'frosttrap', name: 'Frost trap', text: 'trap[onhit] cold nova[large]', note: 'Payload inherits Cold.' },
  { id: 'lance', name: 'Beam lance', text: 'beam[onrelease] charge(3) split(3) bolt', note: 'Charge stays on the beam; Split goes to the bolts.' },
  { id: 'pulsebeam', name: 'Pulsing beam', text: 'beam[every 0.5s] nova', note: 'Explosions where the beam ends.' },
  { id: 'stackfire', name: 'Stacking fire pools', text: 'orb[onexpire] fire split(4) zone stack(3)', note: 'Stack lets the four zones stack up to 3 before merging.' },
  { id: 'trigger', name: 'Trigger rune form', text: 'bolt split(3) onhit fire nova', note: 'Split before the trigger rune splits the bolt; Fire after it still goes to the bolt.' },
  { id: 'aura', name: 'Fire aura', text: 'aura fire', note: 'Persistent shape.' },
  { id: 'bad-link', name: 'Bad: Link without Split', text: 'orb link', note: 'Error: link-needs-split.' },
  { id: 'bad-trailing', name: 'Bad: trailing trigger', text: 'bolt fire onhit', note: 'Error: trailing-release.' },
  { id: 'bad-multicast', name: 'Bad: two shapes, multicast 1', text: 'bolt nova', note: 'Error: multicast.' },
  { id: 'bad-cap', name: 'Bad: over the live cap', text: 'orb[every 0.2s] split(4) orb[every 0.2s] bolt', note: 'Error: entity-cap.' },
];
