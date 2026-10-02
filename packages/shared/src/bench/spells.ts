import type { ClassId } from '../data/classes.js';

/**
 * The hand-picked spells the damage-per-Force balance test measures (test/forcePerDamage.test.ts)
 * and the admin balance bench shows. Kept in one list so the two always measure the same spells.
 * Without a class they are measured on the mage. They began as spells that once dealt far more per
 * Force than any starter, and neighbours of them.
 */
export const BALANCE_SPELLS: readonly { text: string; multicast?: number; classId?: ClassId }[] = [
  // Repeating payloads, then faster and nested variants.
  { text: 'nova[+50% size] lightning' },
  { text: 'orb[every 0.2s] lightning nova' },
  { text: 'zone[every 0.2s] lightning nova' },
  { text: 'zone[every 0.1s] lightning nova' },
  { text: 'zone[every 0.2s] lightning bolt[pierce 4]' },
  { text: 'orb[every 0.2s] lightning bolt' },
  { text: 'orb[every 0.2s] lightning zone' },
  { text: 'orb[every 0.2s] cold split(3) bolt' },
  // Split payloads and split parents that each release a full payload.
  { text: 'zone[every 0.2s] split(6) nova' },
  { text: 'orb[every 0.2s] lightning split(6) nova' },
  { text: 'orb[onhit] fire split(6) nova' },
  { text: 'bolt split(6) onhit fire nova' },
  { text: 'bolt[pierce 4] onhit fire nova' },
  // A ring of piercing orbs from a shape that sits on the pack: every copy lands.
  { text: 'zone[every 0.2s, +75% duration] cold split(2) orb[+50% size, +55% damage] lightning fire cold' },
  { text: 'bolt[onhit, +50% speed, +55% damage] lightning zone[every 0.2s, +55% damage, +75% duration] lightning split(3) orb[+55% damage, +50% size]', classId: 'ranger' },
  { text: 'bolt[onexpire] zone[+55% damage, +75% duration, +50% size] pulse fire cold orb split(2)', classId: 'ranger' },
  { text: 'zone[every 0.2s, +50% size, +75% duration] lightning fire orb[+50% size, +55% damage] split(3)' },
  { text: 'bolt[onhit, +50% speed] zone[every 0.2s, +50% size, +55% damage] lightning lightning bolt[+55% damage] cold split(6)', classId: 'ranger' },
  // One aimed shape from a shape that stays put: every spawn reaches the target.
  { text: 'zone[every 0.2s] lightning bolt', classId: 'ranger' },
  { text: 'zone[every 0.2s, +55% damage, +75% duration] fire lightning bolt', classId: 'ranger' },
  { text: 'nova[after 0.3s, +50% size, +55% damage] zone[+75% duration, +50% size, +55% damage] pulse lightning lightning bolt', classId: 'ranger' },
  { text: 'orb[onhit] lightning zone[every 0.2s, +75% duration, +55% damage] orb', multicast: 2 },
  // The Pulse rune against the every affix.
  { text: 'zone pulse lightning nova' },
  { text: 'orb pulse lightning nova' },
  { text: 'bolt pulse lightning nova' },
  // Multicast.
  { text: 'nova lightning nova fire', multicast: 2 },
  { text: 'nova lightning zone fire', multicast: 2 },
  { text: 'zone[every 0.2s] lightning nova zone', multicast: 2 },
  // Doubled and mixed infusions.
  { text: 'nova lightning lightning lightning' },
  { text: 'nova fire cold lightning' },
  { text: 'bolt fire fire fire fire' },
  { text: 'zone fire fire fire fire' },
  // Once-off payloads, plain and rolled.
  { text: 'nova[after 0.1s] lightning nova[after 0.1s] nova' },
  { text: 'zone[onexpire] lightning nova' },
  { text: 'dash[onland] lightning nova[+50% size]' },
  { text: 'bolt[after 0.3s] nova[+50% size, +55% damage]', classId: 'ranger' },
  { text: 'bolt[onhit] nova[+50% size, +55% damage] lightning lightning', classId: 'ranger' },
  { text: 'bolt[onhit] nova[+50% size, +55% damage] lightning lightning' },
  // Elements on a once-off payload.
  { text: 'bolt[after 0.3s] bolt lightning fire', classId: 'ranger' },
  { text: 'nova[onexpire] zone[after 0.3s, +55% damage] fire cold nova[+55% damage, +50% size] lightning' },
  { text: 'bolt[after 0.3s, +55% damage] nova[onexpire, +50% size, +55% damage] cold cold zone[+55% damage, +75% duration, +50% size] cold lightning', classId: 'ranger' },
  // Stationary roots with a payload, once the cheapest spells a waived first rune reached.
  { text: 'nova[onexpire, +55% damage] zone[+55% damage]', classId: 'warrior' },
  { text: 'zone[after 1.2s] nova[+55% damage]', classId: 'warrior' },
  { text: 'nova[+55% damage]', classId: 'warrior' },
  // Concentrated (one per shape): alone, with damage rolls and doubled infusions, beside Large, on payloads and multicast.
  { text: 'nova concentrated(60)' },
  { text: 'nova lightning concentrated(60)' },
  { text: 'nova[+55% damage] concentrated(60)', classId: 'warrior' },
  { text: 'nova[+55% damage] lightning lightning concentrated(60)' },
  { text: 'nova[+55% damage, +50% size] concentrated(60) large', classId: 'warrior' },
  { text: 'nova[+50% size] lightning large large concentrated(60)' },
  { text: 'zone[+55% damage, +75% duration] fire concentrated(60)' },
  { text: 'zone[+55% damage, +75% duration, +50% size] fire fire concentrated(60) large' },
  { text: 'bolt concentrated(60)', classId: 'ranger' },
  { text: 'bolt[+55% damage, pierce 3] lightning lightning concentrated(60)', classId: 'ranger' },
  { text: 'bolt[+55% damage, +50% speed] lightning concentrated(60) large', classId: 'ranger' },
  { text: 'bolt[onhit, +55% damage] concentrated(60) nova[+55% damage] lightning concentrated(60)', classId: 'ranger' },
  { text: 'nova lightning concentrated(60) nova fire concentrated(60)', multicast: 2 },
  { text: 'orb[+55% damage, +50% size] lightning concentrated(60)' },
  { text: 'bolt[onhit] fire nova[+55% damage] concentrated(60)', classId: 'ranger' },
  { text: 'bolt[onhit] nova[+55% damage, +50% size] lightning lightning concentrated(60) large', classId: 'ranger' },
  { text: 'zone[every 0.2s] lightning nova concentrated(60)' },
  { text: 'zone[every 0.2s, +55% damage, +75% duration] fire lightning bolt concentrated(60)', classId: 'ranger' },
  { text: 'orb[every 0.2s] cold split(3) bolt concentrated(60)' },
  { text: 'nova[onexpire] zone[after 0.3s, +55% damage] fire cold concentrated(60) nova[+55% damage, +50% size] lightning concentrated(60)' },
  { text: 'orb[onhit] fire concentrated(60) split(6) nova concentrated(60)' },
  // T1 rolls (the rare top tier): the worst payloads above at T1 damage and size, fast pulses, deep pierce.
  { text: 'nova[onexpire] zone[after 0.3s, +100% damage] fire cold nova[+100% damage, +50% size] lightning' },
  { text: 'nova[onexpire] zone[after 0.3s, +100% damage, +75% size, +100% duration] fire cold nova[+100% damage, +75% size] lightning' },
  { text: 'nova[onexpire] zone[after 0.3s, +100% damage] fire cold concentrated(60) nova[+100% damage, +75% size] lightning concentrated(60)' },
  { text: 'zone[after 0.7s, +38% duration] nova[+14% size, +100% damage] lightning lightning concentrated(60)' },
  { text: 'bolt[after 0.3s] nova[+75% size, +100% damage]', classId: 'ranger' },
  { text: 'bolt[onhit] nova[+75% size, +100% damage] lightning lightning concentrated(60) large', classId: 'ranger' },
  { text: 'bolt[pierce 4, +100% damage, +70% speed] lightning lightning', classId: 'ranger' },
  { text: 'zone[every 0.15s] lightning bolt', classId: 'ranger' },
  { text: 'zone[every 0.15s, +100% duration, +100% damage] fire lightning bolt', classId: 'ranger' },
  { text: 'orb[every 0.15s] cold split(5) bolt' },
  { text: 'zone[every 0.15s] lightning nova' },
  // Added damage (phase 1 of damage packets): flat elemental damage on top of the base range, at T1,
  // beside a T1 damage roll, one to three elements on one shape, on converted shapes and payloads.
  { text: 'bolt[adds 9 fire]', classId: 'ranger' },
  { text: 'bolt[adds 9 lightning, +100% damage]', classId: 'ranger' },
  { text: 'bolt[adds 9 fire, adds 9 cold, adds 9 lightning, +100% damage]', classId: 'ranger' },
  { text: 'orb[adds 9 fire, adds 9 cold, adds 9 lightning, +100% damage]', classId: 'warrior' },
  { text: 'nova[adds 9 fire, adds 9 cold, adds 9 lightning, +100% damage]', classId: 'warrior' },
  { text: 'bolt[adds 9 cold, +100% damage, pierce 4] lightning lightning', classId: 'ranger' },
  { text: 'nova[adds 9 fire, +100% damage] lightning concentrated(60)' },
  { text: 'orb[onhit, adds 9 fire, +100% damage] fire nova[adds 9 lightning, +75% size] lightning' },
  { text: 'bolt[onhit, adds 9 lightning] nova[adds 9 cold, adds 9 fire, +100% damage, +75% size] lightning lightning concentrated(60)', classId: 'ranger' },
  { text: 'zone[every 0.15s, adds 9 fire] lightning bolt[adds 9 cold, +100% damage]', classId: 'ranger' },
  { text: 'nova[onexpire] zone[after 0.3s, +100% damage, adds 9 fire] fire cold concentrated(60) nova[+100% damage, adds 9 lightning, adds 9 fire, +75% size] lightning concentrated(60)' },
  { text: 'dash[onland, adds 9 fire, +100% damage] nova[adds 9 lightning, +75% size]', classId: 'warrior' },
];
