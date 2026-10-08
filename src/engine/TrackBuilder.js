import * as THREE from 'three';

/**
 * 3D Procedural Track & Circuit Environment Builder.
 * Constructs track mesh, kerbs, barriers, checkpoints, and environment props.
 */
export class TrackBuilder {
  constructor(scene) {
    this.scene = scene;
    this.trackGroup = new THREE.Group();
    this.scene.add(this.trackGroup);

    this.trackSpline = null;
    this.checkpoints = [];
    this.totalTrackLength = 0;
    this.currentTrackId = 'apex';
  }

  buildTrack(trackId = 'apex', weather = 'clear') {
    // Clear existing track assets
    while (this.trackGroup.children.length > 0) {
      const obj = this.trackGroup.children[0];
      if (obj.geometry) obj.geometry.dispose();
      this.trackGroup.remove(obj);
    }

    this.currentTrackId = trackId;
    this.checkpoints = [];

    // Define Track Control Points (Spline Path)
    let points = [];
    if (trackId === 'apex') {
      // Apex Raceway (Monza style circuit with straight start/finish)
      points = [
        new THREE.Vector3(0, 0, 0),        // Start / Finish
        new THREE.Vector3(0, 0, 180),      // Main Straight
        new THREE.Vector3(-50, 0, 260),    // Turn 1 Apex
        new THREE.Vector3(-160, 0, 240),   // Turn 2 Out
        new THREE.Vector3(-220, 0, 140),   // Chicane
        new THREE.Vector3(-180, 0, 20),    // Hairpin Entry
        new THREE.Vector3(-100, 0, -80),   // Hairpin Apex
        new THREE.Vector3(-180, 0, -200),  // Back Straight
        new THREE.Vector3(-240, 0, -320),  // High Speed Curve
        new THREE.Vector3(-120, 0, -380),  // Sector 2 Turn
        new THREE.Vector3(0, 0, -360),     // Fast Sweeper
        new THREE.Vector3(140, 0, -280),   // Turn 9
        new THREE.Vector3(180, 0, -160),   // Sector 3 Hairpin
        new THREE.Vector3(100, 0, -60),    // Final Corner Entry
        new THREE.Vector3(0, 0, -60)       // Final Corner Exit -> Straight to Start
      ];
    } else if (trackId === 'city') {
      points = [
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, 220),
        new THREE.Vector3(-100, 0, 300),
        new THREE.Vector3(-240, 0, 260),
        new THREE.Vector3(-280, 0, 100),
        new THREE.Vector3(-200, 0, -80),
        new THREE.Vector3(-80, 0, -200),
        new THREE.Vector3(120, 0, -220),
        new THREE.Vector3(220, 0, -80),
        new THREE.Vector3(0, 0, -60)
      ];
    } else {
      points = [
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 4, 200),
        new THREE.Vector3(-120, 10, 280),
        new THREE.Vector3(-260, 4, 200),
        new THREE.Vector3(-260, -4, 60),
        new THREE.Vector3(-160, -8, -140),
        new THREE.Vector3(-40, -2, -260),
        new THREE.Vector3(140, 6, -280),
        new THREE.Vector3(220, 8, -120),
        new THREE.Vector3(0, 0, -60)
      ];
    }

    // Catmull-Rom Curve for smooth track geometry
    this.trackSpline = new THREE.CatmullRomCurve3(points, true, 'centripetal');
    this.totalTrackLength = this.trackSpline.getLength();

    // Build Track Surface Ribbon Geometry
    const trackWidth = 26;
    const numSegments = 400;
    const trackGeo = new THREE.BufferGeometry();

    const positions = [];
    const uvs = [];
    const normals = [];

    const splinePoints = this.trackSpline.getSpacedPoints(numSegments);
    const frenetFrames = this.trackSpline.computeFrenetFrames(numSegments, true);

    for (let i = 0; i <= numSegments; i++) {
      const p = splinePoints[i % numSegments];
      const tangent = frenetFrames.tangents[i % numSegments];
      const normal = frenetFrames.normals[i % numSegments];
      const binormal = frenetFrames.binormals[i % numSegments];

      // Side vector orthogonal to track direction
      const side = new THREE.Vector3().crossVectors(tangent, new THREE.Vector3(0, 1, 0)).normalize();

      // Left and right vertices of track
      const leftP = new THREE.Vector3().copy(p).addScaledVector(side, -trackWidth / 2);
      const rightP = new THREE.Vector3().copy(p).addScaledVector(side, trackWidth / 2);

      positions.push(leftP.x, leftP.y, leftP.z);
      positions.push(rightP.x, rightP.y, rightP.z);

      normals.push(0, 1, 0, 0, 1, 0);

      const u = i / 10; // Repeat texture along track length
      uvs.push(0, u);
      uvs.push(1, u);
    }

    const indices = [];
    for (let i = 0; i < numSegments; i++) {
      const idx = i * 2;
      indices.push(idx, idx + 1, idx + 2);
      indices.push(idx + 1, idx + 3, idx + 2);
    }

    trackGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    trackGeo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    trackGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    trackGeo.setIndex(indices);

    // Track Material
    let roadColor = 0x222225;
    let roughness = 0.6;
    if (trackId === 'city') {
      roadColor = 0x15151a;
      roughness = weather === 'rainy' ? 0.1 : 0.4;
    } else if (trackId === 'desert') {
      roadColor = 0x332822;
      roughness = 0.8;
    }

    const trackMat = new THREE.MeshStandardMaterial({
      color: roadColor,
      roughness: roughness,
      metalness: 0.2
    });

    const trackMesh = new THREE.Mesh(trackGeo, trackMat);
    trackMesh.receiveShadow = true;
    this.trackGroup.add(trackMesh);

    // Build Kerbs & Barriers along track edge
    this.buildTrackBorders(splinePoints, frenetFrames, numSegments, trackWidth, trackId);

    // Build Props, Environment Terrain, and Start Arch
    this.buildEnvironment(trackId);

    // Setup Checkpoints for Lap Timing & Sector Split
    const numCheckpoints = 12;
    for (let i = 0; i < numCheckpoints; i++) {
      const t = i / numCheckpoints;
      const pt = this.trackSpline.getPoint(t);
      this.checkpoints.push({
        index: i,
        position: pt,
        isStartFinish: i === 0,
        sector: Math.floor((i / numCheckpoints) * 3) + 1
      });
    }

    return this.trackSpline;
  }

  buildTrackBorders(splinePoints, frenetFrames, numSegments, trackWidth, trackId) {
    const kerbRedMat = new THREE.MeshStandardMaterial({ color: 0xef4444, roughness: 0.4 });
    const kerbWhiteMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.4 });
    const neonBarrierMat = new THREE.MeshBasicMaterial({ color: 0x06b6d4 });

    for (let i = 0; i < numSegments; i += 2) {
      const p = splinePoints[i];
      const tangent = frenetFrames.tangents[i];
      const side = new THREE.Vector3().crossVectors(tangent, new THREE.Vector3(0, 1, 0)).normalize();

      const leftEdge = new THREE.Vector3().copy(p).addScaledVector(side, -trackWidth / 2 - 0.4);
      const rightEdge = new THREE.Vector3().copy(p).addScaledVector(side, trackWidth / 2 + 0.4);

      if (trackId === 'city') {
        // Neon Glow Barriers
        const barrierGeo = new THREE.BoxGeometry(0.2, 0.8, 3.5);
        const barrierL = new THREE.Mesh(barrierGeo, neonBarrierMat);
        barrierL.position.copy(leftEdge);
        barrierL.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), tangent);
        this.trackGroup.add(barrierL);

        const barrierR = new THREE.Mesh(barrierGeo, neonBarrierMat);
        barrierR.position.copy(rightEdge);
        barrierR.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), tangent);
        this.trackGroup.add(barrierR);
      } else {
        // Racing Red/White Kerbs
        const kerbGeo = new THREE.BoxGeometry(0.8, 0.15, 2.5);
        const mat = (i / 2) % 2 === 0 ? kerbRedMat : kerbWhiteMat;

        const kerbL = new THREE.Mesh(kerbGeo, mat);
        kerbL.position.copy(leftEdge);
        kerbL.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), tangent);
        this.trackGroup.add(kerbL);

        const kerbR = new THREE.Mesh(kerbGeo, mat);
        kerbR.position.copy(rightEdge);
        kerbR.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), tangent);
        this.trackGroup.add(kerbR);
      }
    }
  }

  buildEnvironment(trackId) {
    if (trackId === 'apex') {
      // Grass Terrain
      const terrainGeo = new THREE.PlaneGeometry(1200, 1200);
      const terrainMat = new THREE.MeshStandardMaterial({ color: 0x1e3a1e, roughness: 0.9 });
      const terrain = new THREE.Mesh(terrainGeo, terrainMat);
      terrain.rotation.x = -Math.PI / 2;
      terrain.position.y = -0.1;
      terrain.receiveShadow = true;
      this.trackGroup.add(terrain);

      // Start / Finish Line Arch
      this.createStartArch(new THREE.Vector3(0, 0, 0));
    } else if (trackId === 'city') {
      // City Ground & Skyscrapers
      const groundGeo = new THREE.PlaneGeometry(1000, 1000);
      const groundMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0f, roughness: 0.9 });
      const ground = new THREE.Mesh(groundGeo, groundMat);
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = -0.1;
      this.trackGroup.add(ground);

      // Procedural City Buildings around track
      const bldgMat = new THREE.MeshStandardMaterial({ color: 0x11111d, roughness: 0.3, metalness: 0.8 });
      for (let i = 0; i < 40; i++) {
        const h = 40 + Math.random() * 120;
        const w = 20 + Math.random() * 30;
        const bldgGeo = new THREE.BoxGeometry(w, h, w);
        const bldg = new THREE.Mesh(bldgGeo, bldgMat);

        const angle = Math.random() * Math.PI * 2;
        const dist = 120 + Math.random() * 300;
        bldg.position.set(Math.cos(angle) * dist, h / 2, Math.sin(angle) * dist);
        this.trackGroup.add(bldg);
      }

      this.createStartArch(new THREE.Vector3(0, 0, 0));
    } else if (trackId === 'desert') {
      // Sand Terrain & Rock Formations
      const sandGeo = new THREE.PlaneGeometry(1200, 1200);
      const sandMat = new THREE.MeshStandardMaterial({ color: 0x9a6b43, roughness: 0.95 });
      const sand = new THREE.Mesh(sandGeo, sandMat);
      sand.rotation.x = -Math.PI / 2;
      sand.position.y = -0.1;
      sand.receiveShadow = true;
      this.trackGroup.add(sand);

      this.createStartArch(new THREE.Vector3(0, 0, 0));
    }
  }

  createStartArch(position) {
    const archGroup = new THREE.Group();
    archGroup.position.copy(position);

    const metalMat = new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.9, roughness: 0.2 });
    const bannerMat = new THREE.MeshBasicMaterial({ color: 0xdc2626 });

    // Pillars
    const p1 = new THREE.Mesh(new THREE.BoxGeometry(1, 8, 1), metalMat);
    p1.position.set(-11, 4, 0);

    const p2 = new THREE.Mesh(new THREE.BoxGeometry(1, 8, 1), metalMat);
    p2.position.set(11, 4, 0);

    // Crossbar
    const bar = new THREE.Mesh(new THREE.BoxGeometry(23, 1.5, 1.2), metalMat);
    bar.position.set(0, 7.5, 0);

    // Banner Text Plate
    const banner = new THREE.Mesh(new THREE.BoxGeometry(16, 1.0, 0.1), bannerMat);
    banner.position.set(0, 7.5, 0.65);

    archGroup.add(p1, p2, bar, banner);
    this.trackGroup.add(archGroup);
  }

  getClosestPointOnTrack(position) {
    if (!this.trackSpline) return { point: position, progress: 0, distanceFromCenter: 0 };

    // Sample points to find nearest spline parameter t (2D XZ distance)
    let minDistanceSq = Infinity;
    let closestT = 0;
    const samples = 400;

    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const pt = this.trackSpline.getPoint(t);
      const dx = pt.x - position.x;
      const dz = pt.z - position.z;
      const distSq = dx * dx + dz * dz;
      if (distSq < minDistanceSq) {
        minDistanceSq = distSq;
        closestT = t;
      }
    }

    const closestPt = this.trackSpline.getPoint(closestT);
    const dist2D = Math.sqrt(minDistanceSq);

    return {
      point: closestPt,
      tangent: this.trackSpline.getTangent(closestT),
      progress: closestT,
      distanceFromCenter: dist2D
    };
  }
}
