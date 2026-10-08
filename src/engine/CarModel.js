import * as THREE from 'three';

/**
 * Photorealistic Smooth Curved 3D Mini Cooper JCW Model.
 * Constructed with rounded extrusions, smooth vertex normals, high clearcoat PBR materials,
 * rounded wheel arches, chrome halo LED rings, and smooth body contours.
 */
export class CarModel {
  constructor(options = {}) {
    this.bodyColor = options.bodyColor || 0xdc2626; // Chili Red
    this.roofColor = options.roofColor || 0xffffff; // Pure White Roof
    this.paintFinish = options.paintFinish || 'metallic';
    this.rimColor = options.rimColor || 0x111111;
    this.wingStyle = options.wingStyle || 'gt3';

    this.group = new THREE.Group();

    this.wheels = [];
    this.frontWheelSteerGroups = [];
    this.brakeLights = [];
    this.headlights = [];
    this.headlightSpotlights = [];
    this.bodyMesh = null;
    this.roofMesh = null;

    this.createSmoothMiniCooper();
  }

  createSmoothMiniCooper() {
    // 1. Showroom Quality PBR Materials
    const bodyMat = this.createPaintMaterial(this.bodyColor, this.paintFinish);
    const roofMat = new THREE.MeshPhysicalMaterial({
      color: this.roofColor,
      roughness: 0.08,
      metalness: 0.15,
      clearcoat: 1.0,
      clearcoatRoughness: 0.03
    });
    const blackTrimMat = new THREE.MeshStandardMaterial({
      color: 0x111113,
      roughness: 0.5,
      metalness: 0.2
    });
    const chromeMat = new THREE.MeshStandardMaterial({
      color: 0xf5f5f5,
      roughness: 0.05,
      metalness: 0.98
    });
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: 0x0f172a,
      roughness: 0.03,
      metalness: 0.95,
      transmission: 0.75,
      transparent: true,
      opacity: 0.8
    });
    const stripeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.15 });

    // --- 2. Curved Main Body Hull (Rounded Extrusion) ---
    const shape = new THREE.Shape();
    // Rounded side profile of Mini Cooper
    shape.moveTo(-1.75, -0.25);
    shape.lineTo(1.75, -0.25);
    shape.quadraticCurveTo(1.85, -0.25, 1.85, -0.05);
    shape.lineTo(1.85, 0.25);
    shape.quadraticCurveTo(1.85, 0.40, 1.65, 0.42);
    shape.lineTo(-1.65, 0.42);
    shape.quadraticCurveTo(-1.85, 0.40, -1.85, 0.25);
    shape.lineTo(-1.85, -0.05);
    shape.quadraticCurveTo(-1.85, -0.25, -1.75, -0.25);

    const extrudeSettings = {
      steps: 2,
      depth: 1.68,
      bevelEnabled: true,
      bevelThickness: 0.08,
      bevelSize: 0.08,
      bevelSegments: 6
    };

    const bodyGeo = new THREE.ExtrudeGeometry(shape, extrudeSettings);
    bodyGeo.rotateY(Math.PI / 2);
    bodyGeo.center();
    bodyGeo.computeVertexNormals();

    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.set(0, 0.52, 0);
    body.castShadow = true;
    body.receiveShadow = true;
    this.group.add(body);
    this.bodyMesh = body;

    // Smooth Lower Side Skirt
    const skirtGeo = new THREE.BoxGeometry(1.84, 0.14, 3.72, 4, 1, 8);
    const skirt = new THREE.Mesh(skirtGeo, blackTrimMat);
    skirt.position.y = 0.26;
    skirt.castShadow = true;
    this.group.add(skirt);

    // --- 3. Curved 3D Wheel Arches (Fender Flares) ---
    const fenderGeo = new THREE.TorusGeometry(0.40, 0.07, 16, 32, Math.PI);
    const fenderPositions = [
      { x: -0.90, y: 0.38, z: 1.15, rotY: Math.PI / 2 },
      { x: 0.90, y: 0.38, z: 1.15, rotY: -Math.PI / 2 },
      { x: -0.90, y: 0.38, z: -1.15, rotY: Math.PI / 2 },
      { x: 0.90, y: 0.38, z: -1.15, rotY: -Math.PI / 2 }
    ];
    fenderPositions.forEach(f => {
      const flare = new THREE.Mesh(fenderGeo, blackTrimMat);
      flare.position.set(f.x, f.y, f.z);
      flare.rotation.y = f.rotY;
      flare.castShadow = true;
      this.group.add(flare);
    });

    // --- 4. Smooth Hood & Cooper S Air Scoop ---
    const hoodGeo = new THREE.BoxGeometry(1.68, 0.18, 1.25, 4, 2, 4);
    const hoodPos = hoodGeo.attributes.position;
    for (let i = 0; i < hoodPos.count; i++) {
      const x = hoodPos.getX(i);
      const z = hoodPos.getZ(i);
      // Curve bonnet top
      if (z > 0) hoodPos.setY(i, hoodPos.getY(i) + (1.0 - (x * x) / 1.5) * 0.06);
    }
    hoodGeo.computeVertexNormals();

    const hood = new THREE.Mesh(hoodGeo, bodyMat);
    hood.position.set(0, 0.74, 1.05);
    hood.rotation.x = -0.06;
    hood.castShadow = true;
    this.group.add(hood);

    // Air Scoop
    const scoopGeo = new THREE.BoxGeometry(0.42, 0.05, 0.32);
    const scoop = new THREE.Mesh(scoopGeo, blackTrimMat);
    scoop.position.set(0, 0.86, 1.12);
    this.group.add(scoop);

    // Twin Racing Stripes
    [-0.44, 0.44].forEach(xPos => {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.02, 1.20), stripeMat);
      stripe.position.set(xPos, 0.86, 1.05);
      stripe.rotation.x = -0.06;
      this.group.add(stripe);
    });

    // --- 5. Curved Roof & Windows Canopy ---
    const cabinGeo = new THREE.BoxGeometry(1.54, 0.54, 1.95, 4, 4, 4);
    const cabinPos = cabinGeo.attributes.position;
    for (let i = 0; i < cabinPos.count; i++) {
      if (cabinPos.getY(i) > 0) {
        cabinPos.setX(i, cabinPos.getX(i) * 0.90);
        cabinPos.setZ(i, cabinPos.getZ(i) * 0.92);
      }
    }
    cabinGeo.computeVertexNormals();

    const cabin = new THREE.Mesh(cabinGeo, glassMat);
    cabin.position.set(0, 1.08, -0.15);
    cabin.castShadow = true;
    this.group.add(cabin);

    // Pillars
    [-0.74, 0.74].forEach(xPos => {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.48, 0.05), blackTrimMat);
      pillar.position.set(xPos, 1.08, 0.70);
      pillar.rotation.z = xPos > 0 ? 0.14 : -0.14;
      this.group.add(pillar);
    });

    // Smooth Roof Dome
    const roofGeo = new THREE.BoxGeometry(1.58, 0.08, 2.0, 4, 1, 4);
    const roof = new THREE.Mesh(roofGeo, roofMat);
    roof.position.set(0, 1.38, -0.15);
    roof.castShadow = true;
    this.group.add(roof);
    this.roofMesh = roof;

    // --- 6. Round Chrome LED Headlights (32 segments) ---
    const haloGeo = new THREE.TorusGeometry(0.18, 0.035, 16, 32);
    const lensGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.05, 32);
    lensGeo.rotateX(Math.PI / 2);
    const emissiveMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

    [-0.62, 0.62].forEach(xPos => {
      const headlightGroup = new THREE.Group();
      headlightGroup.position.set(xPos, 0.78, 1.66);
      headlightGroup.rotation.x = -0.12;

      const halo = new THREE.Mesh(haloGeo, chromeMat);
      const lens = new THREE.Mesh(lensGeo, emissiveMat);

      headlightGroup.add(halo, lens);
      this.group.add(headlightGroup);

      // Spotlights
      const spot = new THREE.SpotLight(0xffffff, 4.5, 70, Math.PI / 6, 0.4, 1);
      spot.position.set(xPos, 0.78, 1.68);
      spot.target.position.set(xPos, 0, 15);
      this.group.add(spot);
      this.group.add(spot.target);
      this.headlightSpotlights.push(spot);
    });

    // Lower Fog Lights
    [-0.55, 0.55].forEach(xPos => {
      const fogRim = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.02, 12, 24), chromeMat);
      fogRim.position.set(xPos, 0.40, 1.82);
      const fogLens = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.04, 24).rotateX(Math.PI / 2), emissiveMat);
      fogLens.position.set(xPos, 0.40, 1.82);
      this.group.add(fogRim, fogLens);
    });

    // --- 7. Front Hexagonal Grille & Badge ---
    const frame = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.34, 0.08), chromeMat);
    frame.position.set(0, 0.54, 1.81);
    this.group.add(frame);

    const grilleMesh = new THREE.Mesh(new THREE.BoxGeometry(1.08, 0.28, 0.09), new THREE.MeshStandardMaterial({ color: 0x08080a, roughness: 0.9 }));
    grilleMesh.position.set(0, 0.54, 1.81);
    this.group.add(grilleMesh);

    const badge = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.10), new THREE.MeshStandardMaterial({ color: 0xe11d48 }));
    badge.position.set(0.38, 0.54, 1.83);
    this.group.add(badge);

    // --- 8. Rear Union Jack Tail Lights & Dual Center Exhausts ---
    const brakeMat = new THREE.MeshStandardMaterial({
      color: 0x550000,
      emissive: 0xff0000,
      emissiveIntensity: 0.5,
      roughness: 0.2
    });

    [-0.64, 0.64].forEach(xPos => {
      const tailRim = new THREE.Mesh(new THREE.TorusGeometry(0.20, 0.035, 12, 24), chromeMat);
      tailRim.position.set(xPos, 0.76, -1.82);
      this.group.add(tailRim);

      const brakeLight = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.42, 0.08), brakeMat);
      brakeLight.position.set(xPos, 0.76, -1.81);
      this.group.add(brakeLight);
      this.brakeLights.push(brakeLight);
    });

    // Dual Exhausts
    const exhaustGeo = new THREE.CylinderGeometry(0.075, 0.075, 0.22, 20);
    exhaustGeo.rotateX(Math.PI / 2);
    [-0.11, 0.11].forEach(xPos => {
      const pipe = new THREE.Mesh(exhaustGeo, chromeMat);
      pipe.position.set(xPos, 0.24, -1.84);
      this.group.add(pipe);
    });

    // Side Mirrors
    [-0.92, 0.92].forEach(xPos => {
      const mirrorCapGeo = new THREE.SphereGeometry(0.14, 20, 16);
      mirrorCapGeo.scale(1.2, 0.9, 0.9);
      const mirrorCap = new THREE.Mesh(mirrorCapGeo, roofMat);
      mirrorCap.position.set(xPos > 0 ? xPos + 0.1 : xPos - 0.1, 0.96, 0.45);
      this.group.add(mirrorCap);
    });

    // Roof Spoiler
    const spoiler = new THREE.Mesh(new THREE.BoxGeometry(1.48, 0.08, 0.38), blackTrimMat);
    spoiler.position.set(0, 1.44, -1.08);
    spoiler.rotation.x = 0.14;
    spoiler.castShadow = true;
    this.group.add(spoiler);

    // --- 9. Multi-Spoke Alloy Wheels & Brembo Calipers ---
    const wheelPositions = [
      { x: -0.86, y: 0.35, z: 1.15, isFront: true },
      { x: 0.86, y: 0.35, z: 1.15, isFront: true },
      { x: -0.86, y: 0.35, z: -1.15, isFront: false },
      { x: 0.86, y: 0.35, z: -1.15, isFront: false }
    ];

    wheelPositions.forEach(pos => {
      const steerPivot = new THREE.Group();
      steerPivot.position.set(pos.x, pos.y, pos.z);

      const wheelMesh = this.createDetailedWheelMesh(chromeMat);
      steerPivot.add(wheelMesh);

      this.group.add(steerPivot);
      this.wheels.push(wheelMesh);

      if (pos.isFront) {
        this.frontWheelSteerGroups.push(steerPivot);
      }
    });

    // Soft Shadow
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(2.2, 4.1),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.02;
    this.group.add(shadow);
  }

  createPaintMaterial(colorHex, finishType) {
    let roughness = 0.10;
    let metalness = 0.40;
    let clearcoat = 1.00;

    if (finishType === 'matte') {
      roughness = 0.75;
      metalness = 0.1;
      clearcoat = 0.0;
    } else if (finishType === 'metallic') {
      roughness = 0.15;
      metalness = 0.90;
      clearcoat = 1.0;
    } else if (finishType === 'iridescent') {
      roughness = 0.10;
      metalness = 0.95;
      clearcoat = 1.0;
    }

    return new THREE.MeshPhysicalMaterial({
      color: colorHex,
      roughness: roughness,
      metalness: metalness,
      clearcoat: clearcoat,
      clearcoatRoughness: 0.03
    });
  }

  createDetailedWheelMesh(chromeMat) {
    const wheelGroup = new THREE.Group();

    // Tire Rubber
    const tireGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.26, 32);
    tireGeo.rotateZ(Math.PI / 2);
    const tire = new THREE.Mesh(tireGeo, new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.85 }));
    tire.castShadow = true;
    wheelGroup.add(tire);

    // Rim
    const rimGeo = new THREE.CylinderGeometry(0.25, 0.25, 0.27, 24);
    rimGeo.rotateZ(Math.PI / 2);
    const rimMat = new THREE.MeshStandardMaterial({ color: this.rimColor, roughness: 0.15, metalness: 0.92 });
    const rim = new THREE.Mesh(rimGeo, rimMat);
    wheelGroup.add(rim);

    // Spokes
    for (let i = 0; i < 5; i++) {
      const angle = (i / 5) * Math.PI * 2;
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.24, 0.03), chromeMat);
      spoke.position.set(0.13, Math.cos(angle) * 0.11, Math.sin(angle) * 0.11);
      spoke.rotation.x = angle;
      wheelGroup.add(spoke);
    }

    // Brake Rotor & Caliper
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(0.23, 0.23, 0.04, 24).rotateZ(Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x999999, metalness: 0.95, roughness: 0.2 })
    );
    wheelGroup.add(disc);

    const caliper = new THREE.Mesh(
      new THREE.BoxGeometry(0.07, 0.13, 0.11),
      new THREE.MeshStandardMaterial({ color: 0xe11d48, roughness: 0.3 })
    );
    caliper.position.set(0, 0.13, 0.04);
    wheelGroup.add(caliper);

    return wheelGroup;
  }

  updateCustomization(config) {
    if (config.bodyColor !== undefined) this.bodyColor = config.bodyColor;
    if (config.paintFinish !== undefined) this.paintFinish = config.paintFinish;
    if (this.bodyMesh) {
      this.bodyMesh.material = this.createPaintMaterial(this.bodyColor, this.paintFinish);
    }
  }

  updateAnimation(steerAngle, speedKmh, isBraking, dt) {
    const maxSteerRad = 0.45;
    const currentSteerRad = steerAngle * maxSteerRad;

    this.frontWheelSteerGroups.forEach(group => {
      group.rotation.y = -currentSteerRad;
    });

    const wheelRadius = 0.35;
    const speedMs = (speedKmh * 1000) / 3600;
    const rotationAngle = (speedMs / wheelRadius) * dt;

    this.wheels.forEach(wheel => {
      wheel.rotation.x += rotationAngle;
    });

    this.brakeLights.forEach(light => {
      if (isBraking) {
        light.material.emissiveIntensity = 2.5;
        light.material.color.setHex(0xff0000);
      } else {
        light.material.emissiveIntensity = 0.5;
        light.material.color.setHex(0x550000);
      }
    });
  }
}
