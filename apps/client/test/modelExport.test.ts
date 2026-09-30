import {
  AnimationClip,
  AnimationMixer,
  Bone,
  BoxGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
  Vector3,
  VectorKeyframeTrack,
  QuaternionKeyframeTrack,
} from 'three';
import { Document, NodeIO } from '@gltf-transform/core';
import { describe, expect, it } from 'vitest';
import {
  applyLeafTransforms,
  bakeExportTransform,
  cleanForExport,
  corruptColour,
  dedupeImages,
  corruptPixels,
  exportFrame,
  finishGlb,
  mergeMaterials,
  originalNames,
  pushDownScales,
  readGlb,
  readGlbJson,
  TO_GLTF_FORWARD,
  UNITS_PER_METRE,
  writeGlbJson,
} from '../src/dev/exportPrep.js';
import { BUILTIN_MODELS, prepareBuiltin } from '../src/dev/builtinModels.js';
import { checkModel, guessRoles } from '../src/admin/monsters/modelChecks.js';

/** World positions of every vertex under `root`, skinning included, in traversal order. */
function vertices(root: Object3D): Vector3[] {
  root.updateMatrixWorld(true);
  const out: Vector3[] = [];
  root.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    const pos = o.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) out.push(o.getVertexPosition(i, new Vector3()).applyMatrix4(o.matrixWorld));
  });
  return out;
}

function expectClose(a: Vector3[], b: Vector3[], eps = 1e-5): void {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => {
    const w = b[i] ?? new Vector3(Number.NaN, 0, 0);
    expect(v.distanceTo(w)).toBeLessThan(eps);
  });
}

/** A game-style rig: a scaled root facing +x, an animated pivot, and a non-uniformly scaled part. */
function gameRig(): { model: Group; clip: AnimationClip; nose: Mesh } {
  const model = new Group();
  model.scale.setScalar(15);
  const body = new Group();
  body.name = 'body';
  body.position.set(0, 1, 0);
  model.add(body);
  const torso = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0x555555 }));
  torso.scale.set(1.2, 0.6, 0.5);
  torso.rotation.z = 0.3;
  body.add(torso);
  // The nose marks the front: the game's rigs face +x.
  const nose = new Mesh(new BoxGeometry(0.2, 0.2, 0.2), new MeshStandardMaterial({ color: 0x777777 }));
  nose.name = 'nose';
  nose.position.set(0.8, 0.1, 0);
  body.add(nose);
  const clip = new AnimationClip('Idle', 1, [
    new VectorKeyframeTrack('body.position', [0, 0.5, 1], [0, 1, 0, 0, 1.2, 0, 0, 1, 0]),
    new QuaternionKeyframeTrack('body.quaternion', [0, 1], [...new Quaternion().toArray(), ...new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.4).toArray()]),
  ]);
  return { model, clip, nose };
}

function poseAt(root: Object3D, clip: AnimationClip, t: number): Vector3[] {
  const mixer = new AnimationMixer(root);
  mixer.clipAction(clip).play();
  mixer.setTime(t);
  return vertices(root);
}

describe('bakeExportTransform', () => {
  it('turns +x forward into glTF +Z, converts to metres and leaves an identity root', () => {
    const { model, clip, nose } = gameRig();
    const frame = exportFrame(TO_GLTF_FORWARD);
    const { root } = bakeExportTransform(model, [clip], frame, 'wolf');
    expect(root.name).toBe('wolf');
    expect(root.position.length()).toBe(0);
    expect(root.quaternion.equals(new Quaternion())).toBe(true);
    expect(root.scale.equals(new Vector3(1, 1, 1))).toBe(true);
    const at = nose.getWorldPosition(new Vector3());
    // 0.8 units ahead at scale 15 is 12 world units, 0.4 m, now along +Z.
    expect(at.z).toBeCloseTo((0.8 * 15) / UNITS_PER_METRE, 6);
    expect(Math.abs(at.x)).toBeLessThan(1e-9);
  });

  it('keeps every vertex where the frame puts it, at rest and through the animation', () => {
    const frame = exportFrame(TO_GLTF_FORWARD);
    const expected = (t: number): Vector3[] => {
      const { model, clip } = gameRig();
      const wrap = new Group();
      wrap.applyMatrix4(frame);
      wrap.add(model);
      return poseAt(wrap, clip, t);
    };
    for (const t of [0, 0.25, 0.5, 0.9]) {
      const { model, clip } = gameRig();
      const { root, clips } = bakeExportTransform(model, [clip], frame, 'm');
      const baked = clips[0];
      if (!baked) throw new Error('clip lost');
      expectClose(poseAt(root, baked, t), expected(t));
    }
  });

  it('bakes the scale into positions and vertices instead of leaving it on nodes', () => {
    const { model, clip } = gameRig();
    const { root } = bakeExportTransform(model, [clip], exportFrame(0), 'm');
    root.traverse((o) => {
      if (o.name === 'body') expect(o.scale.x).toBe(1);
    });
    expect(vertices(root).every((v) => v.length() < 2)).toBe(true);
  });

  it('copies geometry, so the game model it came from is left alone', () => {
    const { model, clip, nose } = gameRig();
    const geo = nose.geometry;
    const before = Array.from(geo.getAttribute('position').array);
    bakeExportTransform(model, [clip], exportFrame(TO_GLTF_FORWARD), 'm');
    expect(nose.geometry).not.toBe(geo);
    expect(Array.from(geo.getAttribute('position').array)).toEqual(before);
  });

  it('drops tracks for nodes that are not in the model', () => {
    const { model, clip } = gameRig();
    const stray = new AnimationClip('Idle', 1, [...clip.tracks, new VectorKeyframeTrack('gone.position', [0, 1], [0, 0, 0, 1, 0, 0])]);
    const { clips } = bakeExportTransform(model, [stray], exportFrame(0), 'm');
    expect(clips[0]?.tracks.map((t) => t.name)).toEqual(['body.position', 'body.quaternion']);
  });

  it('refuses a non-uniform scale it cannot push into the parts', () => {
    const { model, clip } = gameRig();
    model.scale.set(1, 2, 1);
    expect(() => bakeExportTransform(model, [clip], exportFrame(0), 'm')).toThrow(/non-uniform/);
  });

  it('keeps a skinned mesh skinned the same way, scaled with its bones', () => {
    const build = (): { model: Group; clip: AnimationClip } => {
      const model = new Group();
      const hip = new Bone();
      hip.name = 'hip';
      hip.position.set(0, 1, 0);
      const knee = new Bone();
      knee.name = 'knee';
      knee.position.set(0, -0.5, 0);
      hip.add(knee);
      const geo = new BoxGeometry(0.2, 1, 0.2, 1, 2, 1);
      geo.translate(0, 0.5, 0);
      const pos = geo.getAttribute('position');
      const idx: number[] = [];
      const w: number[] = [];
      for (let i = 0; i < pos.count; i++) {
        const low = pos.getY(i) < 0.5;
        idx.push(low ? 1 : 0, 0, 0, 0);
        w.push(1, 0, 0, 0);
      }
      geo.setAttribute('skinIndex', new Uint16BufferAttribute(idx, 4));
      geo.setAttribute('skinWeight', new Float32BufferAttribute(w, 4));
      const skinned = new SkinnedMesh(geo, new MeshStandardMaterial());
      skinned.name = 'leg';
      model.add(hip, skinned);
      model.updateMatrixWorld(true);
      skinned.bind(new Skeleton([hip, knee]));
      model.position.y = 0.1;
      model.scale.setScalar(20);
      const clip = new AnimationClip('Walk', 1, [new QuaternionKeyframeTrack('knee.quaternion', [0, 1], [0, 0, 0, 1, ...new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.8).toArray()])]);
      return { model, clip };
    };
    const frame = exportFrame(TO_GLTF_FORWARD);
    for (const t of [0, 0.6]) {
      const a = build();
      const wrap = new Group();
      wrap.applyMatrix4(frame);
      wrap.add(a.model);
      const expected = poseAt(wrap, a.clip, t);
      const b = build();
      const { root, clips } = bakeExportTransform(b.model, [b.clip], frame, 'm');
      const clip = clips[0];
      if (!clip) throw new Error('clip lost');
      expectClose(poseAt(root, clip, t), expected);
    }
  });
});

describe('pushDownScales and applyLeafTransforms', () => {
  it('leave every part at scale 1 and only a location, with the shape unchanged', () => {
    const { model, clip } = gameRig();
    const body = model.getObjectByName('body');
    if (!body) throw new Error('no body');
    body.scale.setScalar(1.3);
    const { root, clips } = bakeExportTransform(model, [clip], exportFrame(TO_GLTF_FORWARD), 'm');
    const baked = clips[0];
    if (!baked) throw new Error('clip lost');
    const before = [0, 0.5].map((t) => poseAt(root, baked, t));
    expect(pushDownScales(root, clips)).toBe(1);
    expect(applyLeafTransforms(root, clips)).toBe(2);
    root.traverse((o) => {
      expect(o.scale.equals(new Vector3(1, 1, 1))).toBe(true);
      if (o instanceof Mesh) expect(o.quaternion.equals(new Quaternion())).toBe(true);
    });
    [0, 0.5].forEach((t, i) => expectClose(poseAt(root, baked, t), before[i] ?? []));
  });
});

describe('cleanForExport', () => {
  it('removes hidden parts, clears userData and names anonymous parts by where they sit', () => {
    const root = new Group();
    root.name = 'thorn_beast';
    root.userData.assetId = 'x';
    const body = new Group();
    body.name = 'body';
    body.userData.phase = 2;
    const part = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    const hidden = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    hidden.name = '1H_Axe_Offhand';
    hidden.visible = false;
    const loose = new Group();
    body.add(part, hidden);
    root.add(body, loose);
    cleanForExport(root);
    expect(root.getObjectByName('1H_Axe_Offhand')).toBeUndefined();
    expect(part.name).toBe('body_mesh0');
    // Never the model id: the Model check reads names like "thorn_beast_pivot0" as a horn.
    expect(loose.name).toBe('part_pivot0');
    root.traverse((o) => expect(Object.keys(o.userData)).toEqual([]));
  });
});

describe('mergeMaterials', () => {
  it('shares identical copies and names them by colour', () => {
    const root = new Group();
    const a = new MeshStandardMaterial({ color: 0x6a6a72 });
    const eye = new MeshStandardMaterial({ color: 0x000000, emissive: 0xffe060, emissiveIntensity: 2 });
    for (const m of [a, a.clone(), a.clone(), eye, eye.clone()]) root.add(new Mesh(new BoxGeometry(), m));
    expect(mergeMaterials(root)).toBe(2);
    const names = new Set<string>();
    root.traverse((o) => {
      if (o instanceof Mesh && o.material instanceof MeshStandardMaterial) names.add(o.material.name);
    });
    expect([...names].sort()).toEqual(['#000000 glow #ffe060', '#6a6a72']);
  });
});

describe('corruption bake', () => {
  it('drains the hue to a fifth and multiplies by the tint, like the shader', () => {
    const tint = new Color(0x8ac060);
    const [r, g, b] = corruptColour([0.5, 0.5, 0.5], tint);
    expect(r).toBeCloseTo(0.5 * tint.r * 1.25, 6);
    expect(g).toBeCloseTo(0.5 * tint.g * 1.25, 6);
    expect(b).toBeCloseTo(0.5 * tint.b * 1.25, 6);
    const white = new Color(1, 1, 1);
    const [rr, gg] = corruptColour([1, 0, 0], white);
    const luma = 0.299;
    expect(rr).toBeCloseTo((luma + (1 - luma) * 0.2) * 1.25, 6);
    expect(gg).toBeCloseTo(luma * 0.8 * 1.25, 6);
  });

  it('writes sRGB pixels and keeps alpha', () => {
    const px = new Uint8ClampedArray([200, 40, 40, 128]);
    corruptPixels(px, new Color(1, 1, 1), new Color(0xffffff));
    expect(px[3]).toBe(128);
    // Mostly drained: red and green end up much closer than they started.
    expect(Math.abs((px[0] ?? 0) - (px[1] ?? 0))).toBeLessThan(160 / 2);
  });
});

describe('GLB post-processing', () => {
  function glb(json: object, bin: Uint8Array): ArrayBuffer {
    const text = new TextEncoder().encode(JSON.stringify(json));
    const jl = Math.ceil(text.length / 4) * 4;
    const bl = Math.ceil(bin.length / 4) * 4;
    const out = new Uint8Array(12 + 8 + jl + 8 + bl);
    const v = new DataView(out.buffer);
    v.setUint32(0, 0x46546c67, true);
    v.setUint32(4, 2, true);
    v.setUint32(8, out.length, true);
    v.setUint32(12, jl, true);
    v.setUint32(16, 0x4e4f534a, true);
    out.fill(0x20, 20, 20 + jl);
    out.set(text, 20);
    v.setUint32(20 + jl, bl, true);
    v.setUint32(24 + jl, 0x004e4942, true);
    out.set(bin, 28 + jl);
    return out.buffer;
  }

  it('puts back the dotted names three stripped and names the scene, keeping the binary chunk', () => {
    const bin = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const file = glb({ asset: { version: '2.0' }, scenes: [{ name: 'AuxScene', nodes: [0] }], nodes: [{ name: 'handslotr' }, { name: 'Rig' }] }, bin);
    const out = finishGlb(file, new Map([['handslotr', 'handslot.r']]), 'skel_minion');
    const json = readGlbJson(out);
    expect(json.nodes).toEqual([{ name: 'handslot.r' }, { name: 'Rig' }]);
    expect(json.scenes).toEqual([{ name: 'skel_minion', nodes: [0] }]);
    expect(new Uint8Array(out).slice(-8)).toEqual(bin);
    expect(new DataView(out).getUint32(8, true)).toBe(out.byteLength);
    expect(readGlbJson(writeGlbJson(out, json))).toEqual(json);
  });

  it('only restores a name the loader sanitised, and never onto a name already in use', () => {
    const root = new Group();
    const a = new Object3D();
    a.name = 'handslotr';
    a.userData.name = 'handslot.r';
    const b = new Object3D();
    b.name = 'Knife_1';
    b.userData.name = 'Knife';
    const c = new Object3D();
    c.name = 'Knife';
    c.userData.name = 'Knife';
    root.add(a, b, c);
    expect([...originalNames(root)]).toEqual([['handslotr', 'handslot.r']]);
  });
});

describe('dedupeImages', () => {
  const png = (b64: string) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  const RED = png('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==');
  const GREY_PX = png('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==');

  /** A body and a weapon, each with its own copy of the same atlas, and a shield with another image. */
  async function file(): Promise<Uint8Array> {
    const doc = new Document();
    const buffer = doc.createBuffer();
    const scene = doc.createScene('Scene');
    const parts: [string, Uint8Array][] = [['body', RED], ['weapon', RED.slice()], ['shield', GREY_PX]];
    parts.forEach(([name, image], i) => {
      const tex = doc.createTexture(`${name}_atlas`).setImage(image).setMimeType('image/png');
      const mat = doc.createMaterial(name).setBaseColorTexture(tex).setEmissiveTexture(i === 0 ? tex : null);
      const prim = doc
        .createPrimitive()
        .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array([i, 0, 0, i + 1, 0, 0, i, 1, 0])).setBuffer(buffer))
        .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array([0, 0, 1, 0, 0, 1])).setBuffer(buffer))
        .setMaterial(mat);
      scene.addChild(doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim)));
    });
    return new NodeIO().writeBinary(doc);
  }

  const ab = (u: Uint8Array): ArrayBuffer => {
    const out = new ArrayBuffer(u.byteLength);
    new Uint8Array(out).set(u);
    return out;
  };

  it('stores an image repeated byte for byte once, with the file still reading the same', async () => {
    const before = await file();
    const images = readGlb(ab(before)).json.images;
    expect(Array.isArray(images) && images.length).toBe(3);
    const out = dedupeImages(ab(before));
    expect(out.byteLength).toBeLessThan(before.byteLength);
    const { json } = readGlb(out);
    expect(Array.isArray(json.images) && json.images.length).toBe(2);
    expect(Array.isArray(json.textures) && json.textures.length).toBe(2);

    const doc = await new NodeIO().readBinary(new Uint8Array(out));
    const byName = (n: string) => doc.getRoot().listMaterials().find((m) => m.getName() === n);
    const body = byName('body')?.getBaseColorTexture();
    expect(body).toBeTruthy();
    expect(byName('weapon')?.getBaseColorTexture()).toBe(body);
    expect(byName('body')?.getEmissiveTexture()).toBe(body);
    expect(byName('shield')?.getBaseColorTexture()?.getImage()).toEqual(GREY_PX);
    expect(body?.getImage()).toEqual(RED);
    // Geometry survives the repacked binary chunk.
    const positions = doc.getRoot().listNodes().map((n) => [n.getName(), [...(n.getMesh()?.listPrimitives()[0]?.getAttribute('POSITION')?.getArray() ?? [])]]);
    expect(positions).toEqual([
      ['body', [0, 0, 0, 1, 0, 0, 0, 1, 0]],
      ['weapon', [1, 0, 0, 2, 0, 0, 1, 1, 0]],
      ['shield', [2, 0, 0, 3, 0, 0, 2, 1, 0]],
    ]);
  });

  it('leaves a file with no repeated image untouched', async () => {
    const doc = new Document();
    doc.createBuffer();
    doc.createTexture('only').setImage(RED).setMimeType('image/png');
    const bytes = ab(await new NodeIO().writeBinary(doc));
    expect(dedupeImages(bytes)).toBe(bytes);
  });
});

describe('exported built-in monsters', () => {
  // The Model check reads "horn" in thorn_beast and horned_charger as a head part, and the wisp is
  // a ball whose orbiting sparks it takes for eyes; their facing guesses say nothing about the export.
  const guessless = ['thorn_beast', 'horned_charger', 'will_o_wisp'];
  it.each(BUILTIN_MODELS.map((m) => [m.id, m] as const))('%s passes facing, loops and roles in the Model check', (id, m) => {
    const { root, clips } = prepareBuiltin(m);
    const roles = guessRoles(clips.map((c) => c.name));
    const report = checkModel({ scene: root, clips, json: {}, bytes: 0, roles });
    const status = (id: string) => report.checks.find((c) => c.id === id)?.status;
    expect(status('loops')).toBe('pass');
    // Towers and totems never move, so they have no walk; every other role must be there.
    if (m.speed > 0) expect(status('roles')).toBe('pass');
    else expect(report.checks.find((c) => c.id === 'roles')?.detail).toBe('No clip for walk or run.');
    expect(status('rootMotion')).toBe('pass');
    // Only a guess from the parts; when it can tell, it must say +Z.
    if (!guessless.includes(id) && report.facing.axis !== null && report.facing.source !== 'body shape') expect(report.facing.axis).toBe('+z');
    // Metres: somewhere between a rat and the Treant King (about 6 m), not world units or centimetres.
    expect(report.height).toBeGreaterThan(0.2);
    expect(report.height).toBeLessThan(10);
    for (const c of clips) for (const t of c.tracks) for (const time of t.times) expect(Math.abs(time * 30 - Math.round(time * 30))).toBeLessThan(1e-4);
  });

  it('carries no scaled or turned wrapper and no userData', () => {
    const m = BUILTIN_MODELS[0];
    if (!m) throw new Error('no built-in models');
    const { root } = prepareBuiltin(m);
    expect(root.name).toBe(m.id);
    root.traverse((o) => {
      expect(o.scale.equals(new Vector3(1, 1, 1))).toBe(true);
      expect(Object.keys(o.userData)).toEqual([]);
    });
  });
});
