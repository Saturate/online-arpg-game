/**
 * The admin page's Model check on a local file, for model work outside the browser:
 *
 *   pnpm model:check <file.glb> [--height N] [--static] [--floats]
 *
 * Prints one pass or warn line per check (with the fix on warnings) and exits non-zero on any
 * warning. --height is the game height the model would get (its AssetDef height, in world units;
 * a hero is 54): it is checked against the range the tuner accepts and turned into a scale.
 * --static is for a model that never moves (a tower, a totem): it needs no walk or run clip.
 * --floats is for a floater or burrower, whose lowest part is meant to hang below the rest.
 */
import { readFileSync } from 'node:fs';
import { checkGlb } from '../apps/client/src/admin/monsters/checkGlb.js';
import { MODEL_HEIGHT } from '../packages/shared/src/index.js';

const HERO_HEIGHT = 54;

function usage(): never {
  console.error('usage: pnpm model:check <file.glb> [--height N] [--static] [--floats]');
  process.exit(2);
}

const args = process.argv.slice(2);
const at = args.indexOf('--height');
const heightArg = at >= 0 ? args[at + 1] : undefined;
if (at >= 0 && heightArg === undefined) usage();
const file = args.find((a, i) => !a.startsWith('--') && (at < 0 || i !== at + 1));
if (file === undefined) usage();

const { report, clips, roles } = await checkGlb(readFileSync(file), { static: args.includes('--static'), floats: args.includes('--floats') });
const lines = [
  `${file}`,
  `  ${report.triangles} triangles, height ${report.height.toFixed(3)} in the file, ${report.animation} animation, faces ${report.facing.axis ?? 'unknown'} (${report.facing.source})`,
  `  clips: ${clips.map((c) => `${c.name} ${c.seconds.toFixed(2)}s`).join(', ') || 'none'}`,
  `  roles: ${Object.entries(roles).map(([role, clip]) => `${role}=${clip}`).join(', ') || 'none'}`,
];
let warnings = 0;
for (const c of report.checks) {
  if (c.status === 'warn') warnings++;
  lines.push(`${c.status === 'pass' ? 'pass' : 'WARN'}  ${c.title}: ${c.detail}${c.fix ? `\n      fix: ${c.fix}` : ''}`);
}
if (heightArg !== undefined) {
  const height = Number(heightArg);
  if (!Number.isFinite(height) || height < MODEL_HEIGHT.min || height > MODEL_HEIGHT.max) {
    warnings++;
    lines.push(`WARN  Height: ${heightArg} is outside the ${MODEL_HEIGHT.min} to ${MODEL_HEIGHT.max} game units a model can be given.`);
  } else if (report.height > 0) {
    lines.push(`pass  Height: at ${height} game units, 1 file unit is ${(height / report.height).toFixed(1)} game units; ${Math.round((height / HERO_HEIGHT) * 100)}% of a hero.`);
  }
}
console.log(lines.join('\n'));
console.log(warnings === 0 ? 'All checks pass.' : `${warnings} warning${warnings === 1 ? '' : 's'}.`);
process.exit(warnings === 0 ? 0 : 1);
