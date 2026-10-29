import * as THREE from 'three';
import { grassTextures, dirtTextures, sandTextures, stoneTextures } from '../ProceduralTextures.js';

/**
 * Four-way splatted ground for the endless road: grass, dirt, sand and rock,
 * weighted per vertex by `aSplat` (the landscape the road passes through,
 * slopes, beaches, river banks). `aExtra.x` bleaches the grass to straw for
 * dry country, `aExtra.y` darkens wet sand at the water's edge.
 *
 * Like the circuit terrain, each surface is sampled at two scales with the
 * coarse one taking over in the distance, rock is projected tri-planar, and
 * blend edges follow the textures' own light and dark so surfaces interlock.
 * Texture coordinates come from world position modulo a large period, so
 * they stay precise however far the road has gone.
 */
export function endlessTerrainMaterial() {
  const grass = grassTextures();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      tGrass: { value: grass.map }, tDirt: { value: dirtTextures().map },
      tSand: { value: sandTextures().map }, tRock: { value: stoneTextures().map }
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */ `
        #include <common>
        attribute vec4 aSplat;
        attribute vec2 aExtra;
        varying vec4 vSplat;
        varying vec2 vExtra;
        varying vec3 vGroundPos;
        varying vec3 vGroundNormal;
      `)
      .replace('#include <begin_vertex>', /* glsl */ `
        #include <begin_vertex>
        vSplat = aSplat;
        vExtra = aExtra;
        // Texture space wraps every 2048 m to keep float precision (every scale below fits a whole
        // number of tiles in that). Wrap the mesh origin, not each vertex, so no triangle straddles a seam.
        vGroundPos = vec3(mod(modelMatrix[3].x, 2048.0) + transformed.x, (modelMatrix * vec4(transformed, 1.0)).y,
          mod(modelMatrix[3].z, 2048.0) + transformed.z);
        vGroundNormal = normalize(mat3(modelMatrix) * objectNormal);
      `);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */ `
        #include <common>
        uniform sampler2D tGrass;
        uniform sampler2D tDirt;
        uniform sampler2D tSand;
        uniform sampler2D tRock;
        varying vec4 vSplat;
        varying vec2 vExtra;
        varying vec3 vGroundPos;
        varying vec3 vGroundNormal;
        float groundLuma(vec3 c) { return dot(c, vec3(0.333)); }
        vec3 twoScale(sampler2D t, vec2 uv, float far) {
          return mix(texture2D(t, uv).rgb, texture2D(t, uv * 0.1875 + 0.37).rgb, far);
        }
      `)
      .replace('#include <map_fragment>', /* glsl */ `
        float far = smoothstep(20.0, 300.0, length(vViewPosition)) * 0.8;
        vec2 wuv = vGroundPos.xz * 0.125;
        vec3 cGrass = twoScale(tGrass, wuv, far);
        cGrass = mix(cGrass, vec3(groundLuma(cGrass)) * vec3(1.55, 1.3, 0.75), vExtra.x * 0.85);
        vec3 cDirt = twoScale(tDirt, wuv * 1.25, far);
        vec3 cSand = twoScale(tSand, wuv * 0.875, far) * (1.0 - vExtra.y * 0.35);
        vec3 tw = pow(abs(normalize(vGroundNormal)), vec3(4.0));
        tw /= tw.x + tw.y + tw.z;
        vec3 rp = vGroundPos * 0.03125;
        vec3 cRock = texture2D(tRock, rp.zy).rgb * tw.x + texture2D(tRock, rp.xz).rgb * tw.y + texture2D(tRock, rp.xy).rgb * tw.z;
        // Height blend: a surface's bright bits poke through first
        vec4 w = vSplat * (vec4(groundLuma(cGrass), groundLuma(cDirt), groundLuma(cSand), groundLuma(cRock)) + 0.35);
        w = pow(max(w, vec4(0.0)), vec4(6.0));
        w /= max(w.x + w.y + w.z + w.w, 1e-5);
        diffuseColor.rgb *= cGrass * w.x + cDirt * w.y + cSand * w.z + cRock * w.w;
      `);
  };
  mat.customProgramCacheKey = () => 'endless-terrain';
  return mat;
}
