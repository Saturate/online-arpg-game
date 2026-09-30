import { describe, expect, it } from 'vitest';
import { Color, MeshStandardMaterial, ShaderLib } from 'three';
import { ALBEDO_FLOOR, floorAlbedo, rigShaderHook } from '../src/render/rigs/compile.js';
import { addNightRim, injectRim, NIGHT_RIM, nightRim, type ShaderSource } from '../src/render/nightRim.js';

function shader(): ShaderSource {
  return { uniforms: {}, vertexShader: ShaderLib.physical.vertexShader, fragmentShader: ShaderLib.physical.fragmentShader };
}

const luminance = (c: Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

describe('albedo floor', () => {
  it('lifts a near-black part to sRGB 0x30 and keeps its hue', () => {
    const out = floorAlbedo(new Color(0x100804), new Color());
    expect(luminance(out)).toBeCloseTo(ALBEDO_FLOOR, 5);
    expect(out.r).toBeGreaterThan(out.g);
    expect(out.g).toBeGreaterThan(out.b);
  });

  it('turns pure black into a dark grey and leaves brighter parts alone', () => {
    expect(floorAlbedo(new Color(0x000000), new Color()).getHex()).toBe(0x303030);
    const mid = new Color(0x806040);
    expect(floorAlbedo(mid, new Color()).equals(mid)).toBe(true);
  });
});

describe('night rim', () => {
  it('goes on enemy rigs after the emissive include, and not on heroes or minions', () => {
    const material = new MeshStandardMaterial({ emissiveIntensity: 1 });
    const enemy = rigShaderHook(true);
    const friend = rigShaderHook(false);
    expect(enemy.key).not.toBe(friend.key);
    const e = shader();
    enemy.hook.call(material, e);
    const f = shader();
    friend.hook.call(material, f);
    const at = e.fragmentShader.indexOf('#include <emissivemap_fragment>');
    const rim = e.fragmentShader.indexOf('float rimF = 1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);');
    expect(rim).toBeGreaterThan(at);
    expect(e.fragmentShader).toContain('totalEmissiveRadiance += vec3(0.42, 0.48, 0.66) * uRim * pow(rimF, 2.5);');
    expect(f.fragmentShader).not.toContain('rimF');
  });

  it('follows the night: zero by day, 0.28 at deep night', () => {
    const e = shader();
    rigShaderHook(true).hook.call(new MeshStandardMaterial(), e);
    const uniform = e.uniforms.uRim;
    nightRim.value = 0;
    expect(uniform?.value).toBe(0);
    nightRim.value = NIGHT_RIM;
    expect(uniform?.value).toBeCloseTo(0.28);
    nightRim.value = 0;
  });

  it('keeps a KayKit material program apart and scales its rim', () => {
    const m = new MeshStandardMaterial();
    m.customProgramCacheKey = () => 'corrupt-1';
    addNightRim(m);
    expect(m.customProgramCacheKey()).toBe('corrupt-1|rim');
    const s = shader();
    injectRim(s, 0.8);
    nightRim.value = NIGHT_RIM;
    expect(s.uniforms.uRim?.value).toBeCloseTo(0.28 * 0.8);
    nightRim.value = 0;
  });
});
