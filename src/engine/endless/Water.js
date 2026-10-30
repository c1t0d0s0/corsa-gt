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

/**
 * River surface. The strip carries `aRiver` = (metres across from the centre
 * line, metres along the river, half width), from which the shader works out:
 *  - colour by depth: clear turquoise over the gravel at the edges, deepening
 *    to blue-green mid-stream, and see-through where it's shallow;
 *  - ripples that drift downstream, faster in the middle than at the banks;
 *  - a lace of foam along the banks.
 * Sky reflections are kept modest so the water keeps its colour instead of
 * turning to a grey sheen. Along-river distances wrap every 2048 m, which the
 * ripple scales tile into exactly.
 */
export function riverMaterial() {
  const srgb = (hex) => new THREE.Color(hex).convertSRGBToLinear();
  // Physical material for its specular controls: a weaker, faintly teal reflection keeps the
  // water's own colour showing even at the low angles it's seen at from the road
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.14, metalness: 0, transparent: true,
    normalMap: waterTextures().normalMap, normalScale: new THREE.Vector2(0.3, 0.3),
    envMapIntensity: 0.3, specularIntensity: 0.4, specularColor: 0xcfeee8, depthWrite: false
  });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      waterTime: clock,
      deepColor: { value: srgb(0x177f8c) },
      shallowColor: { value: srgb(0x62d0bd) },
      bedColor: { value: srgb(0xb6b08a) }
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aRiver;\nvarying vec3 vRiver;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRiver = aRiver;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */ `
        #include <common>
        uniform float waterTime;
        uniform vec3 deepColor;
        uniform vec3 shallowColor;
        uniform vec3 bedColor;
        varying vec3 vRiver;
      `)
      .replace('#include <color_fragment>', /* glsl */ `
        #include <color_fragment>
        float edge = clamp(abs(vRiver.x) / vRiver.z, 0.0, 1.0); // 0 mid-stream, 1 at the bank
        float depth = 1.0 - edge * edge;
        vec3 water = mix(shallowColor, deepColor, smoothstep(0.15, 0.85, depth));
        water = mix(bedColor, water, smoothstep(0.0, 0.35, depth)); // gravel showing through at the very edge
        // Foam: broken streaks that hug the banks and drift with the current
        float lace = texture2D(normalMap, vec2(vRiver.x * 0.09375, vRiver.y * 0.046875 - waterTime * 0.12)).r;
        float foam = smoothstep(0.78, 0.92, edge) * smoothstep(0.52, 0.66, lace);
        diffuseColor.rgb = mix(water, vec3(0.92), foam * 0.7);
        // Clear where shallow, fading out entirely where the water meets the bank
        diffuseColor.a = mix(0.4, 0.9, smoothstep(0.1, 0.7, depth)) * (1.0 - smoothstep(0.9, 0.98, edge)) + foam * 0.3;
      `)
      .replace('vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;', /* glsl */ `
        // Ripples carried downstream, quickest mid-stream
        float flow = 0.25 + 0.75 * (1.0 - clamp(abs(vRiver.x) / vRiver.z, 0.0, 1.0));
        vec3 mapN = normalize(
          texture2D(normalMap, vec2(vRiver.x * 0.0625, vRiver.y * 0.046875 - waterTime * 0.09 * flow)).xyz * 2.0 - 1.0 +
          texture2D(normalMap, vec2(vRiver.x * 0.125 + 0.37, vRiver.y * 0.09375 - waterTime * 0.21 * flow)).xyz * 2.0 - 1.0
        );
      `);
  };
  mat.customProgramCacheKey = () => 'river';
  return mat;
}
