import * as THREE from 'three';
import { waterTextures } from '../ProceduralTextures.js';

const clock = { value: 0 };

/**
 * Sea and river surface: glossy, slightly see-through, with two ripple
 * layers drifting across each other. Ripples are sampled in world space
 * (wrapped every 2048 m for precision; meshes must not be rotated), so the sea plane can follow the car
 * without the waves sliding along with it.
 */
export function waterMaterial({ color = 0x1b4a63, opacity = 0.9 } = {}) {
  const mat = new THREE.MeshStandardMaterial({
    color, roughness: 0.06, metalness: 0, transparent: true, opacity,
    normalMap: waterTextures().normalMap, normalScale: new THREE.Vector2(0.35, 0.35),
    envMapIntensity: 1.3, depthWrite: false
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.waterTime = clock;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vWaterXZ;')
      .replace('#include <begin_vertex>', /* glsl */ `
        #include <begin_vertex>
        vWaterXZ = mod(modelMatrix[3].xz, 2048.0) + transformed.xz; // see TerrainMaterial
      `);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float waterTime;\nvarying vec2 vWaterXZ;')
      .replace('vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;', /* glsl */ `
        vec3 mapN = normalize(
          texture2D(normalMap, vWaterXZ * 0.0625 + waterTime * vec2(0.011, 0.007)).xyz * 2.0 - 1.0 +
          texture2D(normalMap, vWaterXZ * 0.03125 - waterTime * vec2(0.006, 0.012)).xyz * 2.0 - 1.0
        );
      `);
  };
  mat.customProgramCacheKey = () => 'water';
  return mat;
}

export function tickWater() {
  clock.value = performance.now() / 1000;
}
