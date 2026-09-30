import { Document, NodeIO, type Material, type Node } from '@gltf-transform/core';
import { MONSTER_MODEL_IDS } from '@rune/shared';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { checkGlb } from '../src/admin/monsters/checkGlb.js';
import { checkModel, guessRoles, type Check, type ModelReport } from '../src/admin/monsters/modelChecks.js';
import { ASSETS } from '../src/render/assets.js';

type Vec3 = [number, number, number];

interface Part {
  name: string;
  min: Vec3;
  max: Vec3;
  /** Linear RGB; omitted means the primitive has no material at all. */
  color?: Vec3;
  emissive?: Vec3;
  /** More primitives in the same mesh, each with its own material (feet in their own colour, say). */
  pieces?: { min: Vec3; max: Vec3; color: Vec3 }[];
}

interface Anim {
  name: string;
  node: string;
  path: 'translation' | 'rotation';
  times: number[];
  values: number[];
}

interface Fixture {
  parts: Part[];
  anims?: Anim[];
  /** Adds a one-bone skin to the first part. */
  skinned?: boolean;
  /** Extra triangles on the first part, to push the count up. */
  extraTriangles?: number;
}

/** A box as 8 corners and 12 triangles. */
function boxData(min: Vec3, max: Vec3): { positions: Float32Array; indices: Uint16Array } {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const positions = new Float32Array([x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1]);
  const faces = [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2];
  return { positions, indices: new Uint16Array(faces) };
}

async function build(f: Fixture): Promise<{ bytes: Uint8Array; parsed: Awaited<ReturnType<GLTFLoader['parseAsync']>> }> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('Scene');
  const root = doc.createNode('model');
  scene.addChild(root);
  const nodes = new Map<string, Node>();
  const materials = new Map<string, Material>();
  const materialFor = (color: Vec3, emissive?: Vec3): Material => {
    const key = `${color.join(',')}|${(emissive ?? [0, 0, 0]).join(',')}`;
    let mat = materials.get(key);
    if (!mat) {
      mat = doc.createMaterial(`mat_${materials.size}`).setBaseColorFactor([...color, 1]).setMetallicFactor(0);
      if (emissive) mat.setEmissiveFactor(emissive);
      materials.set(key, mat);
    }
    return mat;
  };
  f.parts.forEach((p, i) => {
    const { positions, indices } = boxData(p.min, p.max);
    let idx = indices;
    if (i === 0 && f.extraTriangles) {
      // Degenerate repeats of the first triangle are enough to count; nothing needs to draw them.
      idx = new Uint16Array(indices.length + f.extraTriangles * 3);
      idx.set(indices);
      for (let k = indices.length; k < idx.length; k++) idx[k] = k % 3;
    }
    const prim = doc
      .createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(idx).setBuffer(buffer));
    if (p.color) prim.setMaterial(materialFor(p.color, p.emissive));
    if (i === 0 && f.skinned) {
      const n = positions.length / 3;
      prim.setAttribute('JOINTS_0', doc.createAccessor().setType('VEC4').setArray(new Uint16Array(n * 4)).setBuffer(buffer));
      const weights = new Float32Array(n * 4);
      for (let v = 0; v < n; v++) weights[v * 4] = 1;
      prim.setAttribute('WEIGHTS_0', doc.createAccessor().setType('VEC4').setArray(weights).setBuffer(buffer));
    }
    const mesh = doc.createMesh(p.name).addPrimitive(prim);
    for (const piece of p.pieces ?? []) {
      const box = boxData(piece.min, piece.max);
      mesh.addPrimitive(
        doc
          .createPrimitive()
          .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(box.positions).setBuffer(buffer))
          .setIndices(doc.createAccessor().setType('SCALAR').setArray(box.indices).setBuffer(buffer))
          .setMaterial(materialFor(piece.color)),
      );
    }
    const node = doc.createNode(p.name).setMesh(mesh);
    root.addChild(node);
    nodes.set(p.name, node);
  });
  if (f.skinned) {
    const bone = doc.createNode('hips');
    root.addChild(bone);
    nodes.set('hips', bone);
    const ibm = doc.createAccessor().setType('MAT4').setArray(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])).setBuffer(buffer);
    const skin = doc.createSkin('rig').addJoint(bone).setInverseBindMatrices(ibm);
    nodes.get(f.parts[0]?.name ?? '')?.setSkin(skin);
  }
  for (const a of f.anims ?? []) {
    const target = nodes.get(a.node);
    if (!target) throw new Error(`no node ${a.node}`);
    const sampler = doc
      .createAnimationSampler()
      .setInput(doc.createAccessor().setType('SCALAR').setArray(new Float32Array(a.times)).setBuffer(buffer))
      .setOutput(doc.createAccessor().setType(a.path === 'rotation' ? 'VEC4' : 'VEC3').setArray(new Float32Array(a.values)).setBuffer(buffer));
    let anim = doc.getRoot().listAnimations().find((x) => x.getName() === a.name);
    if (!anim) anim = doc.createAnimation(a.name);
    anim.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(target).setTargetPath(a.path).setSampler(sampler));
  }
  const bytes = await new NodeIO().writeBinary(doc);
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const parsed = await new GLTFLoader().parseAsync(ab, '');
  return { bytes, parsed };
}

async function report(f: Fixture, bytesOverride?: number): Promise<ModelReport> {
  const { bytes, parsed } = await build(f);
  const names = parsed.animations.map((c) => c.name);
  return checkModel({ scene: parsed.scene, clips: parsed.animations, json: parsed.parser.json, bytes: bytesOverride ?? bytes.byteLength, roles: guessRoles(names) });
}

function check(r: ModelReport, id: Check['id']): Check {
  const c = r.checks.find((x) => x.id === id);
  if (!c) throw new Error(`no ${id} check`);
  return c;
}

const GREY: Vec3 = [0.3, 0.3, 0.3];
const Q0 = [0, 0, 0, 1];
const QTURN = [0, 0, 0.2, 0.98];
const loopAnim = (name: string, node: string): Anim => ({ name, node, path: 'rotation', times: [0, 0.5, 1], values: [...Q0, ...QTURN, ...Q0] });

/** An upright-ish four-legged body along Z with its head at +Z, every role mapped and looping. */
const GOOD: Fixture = {
  parts: [
    { name: 'body', min: [-0.3, 0.4, -0.8], max: [0.3, 0.9, 0.8], color: GREY },
    { name: 'leg_front', min: [-0.1, 0, 0.5], max: [0.1, 0.4, 0.7], color: GREY },
    { name: 'leg_back', min: [-0.1, 0, -0.7], max: [0.1, 0.4, -0.5], color: GREY },
    { name: 'head', min: [-0.2, 0.7, 0.8], max: [0.2, 1.1, 1.2], color: GREY },
  ],
  anims: ['Idle', 'Walk', 'Run', 'Attack', 'Hit', 'Death'].map((n) => loopAnim(n, 'leg_front')),
};

describe('model checks', () => {
  it('passes a clean model on every count', async () => {
    const r = await report(GOOD);
    expect(r.checks.filter((c) => c.status === 'warn')).toEqual([]);
    expect(r.facing).toEqual({ axis: '+z', source: 'named parts' });
    expect(r.animation).toBe('rigid');
    expect(r.triangles).toBe(48);
  });

  it('flags everything wrong with a dog-like export', async () => {
    const black: Vec3 = [0, 0, 0];
    const r = await report({
      parts: [
        { name: 'body', min: [-0.8, 0.4, -0.3], max: [0.8, 0.9, 0.3], color: black },
        { name: 'leg_front', min: [0.5, 0, -0.1], max: [0.7, 0.4, 0.1], color: black },
        { name: 'leg_back', min: [-0.7, 0, -0.1], max: [-0.5, 0.4, 0.1], color: black },
        { name: 'eye', min: [0.9, 0.8, -0.05], max: [1, 0.9, 0.05], color: black, emissive: [1, 0.7, 0.1] },
        { name: 'Cube', min: [-0.5, -0.2, -0.2], max: [0.5, 0.3, 0.2] },
      ],
      anims: [
        { name: 'Idle', node: 'body', path: 'translation', times: [0, 1], values: [0, 0, 0, 0, 0.02, 0] },
        { name: 'Walk', node: 'leg_front', path: 'rotation', times: [0, 1], values: [...Q0, ...QTURN] },
        { name: 'Attack', node: 'leg_front', path: 'rotation', times: [0, 1], values: [...Q0, ...Q0] },
      ],
    });
    expect(check(r, 'facing')).toMatchObject({ status: 'warn', detail: expect.stringMatching(/Faces \+X/) });
    expect(check(r, 'feet')).toMatchObject({ status: 'warn', detail: expect.stringMatching(/Cube/) });
    expect(check(r, 'colours')).toMatchObject({ status: 'warn', detail: expect.stringMatching(/^1 of 2 materials are black/) });
    expect(check(r, 'loops')).toMatchObject({ status: 'warn', detail: expect.stringMatching(/Idle.*Walk/) });
    expect(check(r, 'materials')).toMatchObject({ status: 'warn', detail: expect.stringMatching(/"Cube"/) });
    expect(check(r, 'roles')).toMatchObject({ status: 'warn', detail: 'No clip for hit, death.' });
    expect(check(r, 'rig')).toMatchObject({ status: 'pass', detail: expect.stringMatching(/Rigid/) });
    expect(r.animation).toBe('rigid');
  });

  it('reads feet with their own material as part of the mesh they belong to', async () => {
    const pads: Vec3 = [0.05, 0.045, 0.04];
    const r = await report({
      ...GOOD,
      parts: [
        {
          name: 'wolf',
          min: [-0.3, 0.2, -0.8],
          max: [0.3, 0.9, 0.8],
          color: GREY,
          pieces: [
            { min: [-0.2, 0, 0.5], max: [-0.1, 0.2, 0.6], color: pads },
            { min: [0.1, 0, -0.6], max: [0.2, 0.2, -0.5], color: pads },
          ],
        },
        { name: 'head', min: [-0.2, 0.7, 0.8], max: [0.2, 1.1, 1.2], color: GREY },
      ],
      anims: ['Idle', 'Walk', 'Run', 'Attack', 'Hit', 'Death'].map((n) => loopAnim(n, 'head')),
    });
    expect(check(r, 'feet')).toMatchObject({ status: 'pass', detail: 'Lowest point in the rest pose is at y = 0.' });
    expect(r.checks.filter((c) => c.status === 'warn')).toEqual([]);
  });

  it('still flags a separate part hanging below the feet', async () => {
    const r = await report({
      ...GOOD,
      parts: [...GOOD.parts, { name: 'stray', min: [-0.1, -0.3, -0.1], max: [0.1, -0.2, 0.1], color: GREY }],
    });
    expect(check(r, 'feet')).toMatchObject({ status: 'warn', detail: expect.stringMatching(/^"stray" reaches 0.3 below/) });
  });

  it('reads a textured file from disk bytes in node', async () => {
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (ch) => ch.charCodeAt(0));
    const doc = new Document();
    const buffer = doc.createBuffer();
    const { positions, indices } = boxData([-0.5, 0, -0.5], [0.5, 1, 0.5]);
    const tex = doc.createTexture('skin').setImage(png).setMimeType('image/png');
    // Black base colour under a texture: the texture decides the colour, so it must not warn.
    const mat = doc.createMaterial('textured').setBaseColorFactor([0, 0, 0, 1]).setBaseColorTexture(tex);
    const prim = doc
      .createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer))
      .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(16)).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(indices).setBuffer(buffer))
      .setMaterial(mat);
    doc.createScene('Scene').addChild(doc.createNode('blob').setMesh(doc.createMesh('blob').addPrimitive(prim)));
    const { report: r, clips } = await checkGlb(await new NodeIO().writeBinary(doc));
    expect(clips).toEqual([]);
    expect(check(r, 'colours').status).toBe('pass');
    expect(check(r, 'feet').status).toBe('pass');
  });

  it('warns about heavy meshes and big files', async () => {
    const r = await report({ ...GOOD, extraTriangles: 5000 }, 4 * 1024 * 1024);
    expect(check(r, 'triangles').status).toBe('warn');
    expect(check(r, 'size')).toMatchObject({ status: 'warn', detail: expect.stringMatching(/4 MB/) });
  });

  it('asks to check facing when it cannot tell', async () => {
    const r = await report({ parts: [{ name: 'blob', min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5], color: GREY }] });
    expect(r.facing.axis).toBeNull();
    expect(check(r, 'facing')).toMatchObject({ status: 'warn', detail: expect.stringMatching(/check facing/) });
    expect(check(r, 'rig')).toMatchObject({ status: 'warn' });
  });

  it('reads the long axis of an unnamed body as a hint only', async () => {
    const r = await report({ parts: [{ name: 'part_a', min: [-1, 0, -0.3], max: [1, 0.6, 0.3], color: GREY }] });
    expect(r.facing).toEqual({ axis: '+x', source: 'body shape' });
    expect(check(r, 'facing').status).toBe('warn');
  });

  it('spots root motion in a walk', async () => {
    const r = await report({
      ...GOOD,
      anims: [...(GOOD.anims ?? []).filter((a) => a.name !== 'Walk'), { name: 'Walk', node: 'body', path: 'translation', times: [0, 1], values: [0, 0, 0, 0, 0, 1.2] }],
    });
    expect(check(r, 'rootMotion')).toMatchObject({ status: 'warn', detail: expect.stringMatching(/Walk moves "body"/) });
  });

  it('tells skinned from rigid animation', async () => {
    const r = await report({ ...GOOD, skinned: true, anims: [loopAnim('Idle', 'hips')] });
    expect(r.animation).toBe('skinned');
    expect(check(r, 'rig').detail).toMatch(/Skinned/);
  });

  it('guesses roles from common clip names', () => {
    expect(guessRoles(['Idle_Combat', 'Walking_A', 'Running_A', '1H_Melee_Attack_Chop', 'Spellcast_Shoot', 'Hit_A', 'Death_A'])).toEqual({
      idle: 'Idle_Combat',
      walk: 'Walking_A',
      run: 'Running_A',
      attack: '1H_Melee_Attack_Chop',
      cast: 'Spellcast_Shoot',
      shoot: 'Spellcast_Shoot',
      hit: 'Hit_A',
      death: 'Death_A',
    });
  });
});

describe('model registry', () => {
  it('lists the same monster models the server accepts', () => {
    expect(ASSETS.filter((a) => a.category === 'monster').map((a) => a.id)).toEqual([...MONSTER_MODEL_IDS]);
  });
});
