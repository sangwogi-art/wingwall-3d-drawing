class Viewer3D {
  constructor(containerId, onSelectCallback, onSelectRebarCallback) {
    this.container = document.getElementById(containerId);
    this.onSelect = onSelectCallback;
    this.onSelectRebar = onSelectRebarCallback;
    this.meshes = {};
    this.rebarMeshes = [];
    this.rebarGroupRoot = null;
    this.sectionMarkers = [];
    this.labelSprites = [];
    this.rebarLabelSprites = [];
    this.displayMode = 'solid'; // 'solid', 'wireframe', 'transparent'
    this.stepMode = 2; // 2: Exterior only, 3: Exterior (ghosted) + 3D Rebars
    this.selectedObjectId = null;
    this.selectedRebarMark = null;
    this.concreteOpacity = 0.25;
    this.rebarScale = 1.4;

    this.rebarFilters = {
      wingwall: 'ALL', // 'ALL', 'WW_END_LEFT', 'WW_END_RIGHT'
      zones: new Set([
        '우각부 보강근 (암거접합부)',
        '벽체 전면 철근',
        '벽체 배면 철근',
        '저판 상면 철근',
        '저판 하면 철근',
        '헌치 및 전단보강근'
      ]),
      dias: new Set(['H19', 'H16', 'H13']),
      marks: new Set() // populated on load
    };

    this.init();
  }

  init() {
    const width = this.container.clientWidth || 800;
    const height = this.container.clientHeight || 600;

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0e1118);

    // Camera (Z is up)
    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(35, 20, 50);

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.container.appendChild(this.renderer.domElement);

    // Controls
    this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.target.set(16, 41, 35);

    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.70);
    this.scene.add(ambientLight);

    const dirLight1 = new THREE.DirectionalLight(0xffffff, 0.85);
    dirLight1.position.set(30, -20, 60);
    dirLight1.castShadow = true;
    dirLight1.shadow.mapSize.width = 2048;
    dirLight1.shadow.mapSize.height = 2048;
    this.scene.add(dirLight1);

    const dirLight2 = new THREE.DirectionalLight(0x93c5fd, 0.40);
    dirLight2.position.set(-20, 30, 40);
    this.scene.add(dirLight2);

    this.rebarGroupRoot = new THREE.Group();
    this.scene.add(this.rebarGroupRoot);

    // Ground Grid & Axes
    this.setupGridAndAxes();

    // Raycaster for object & rebar picking
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();

    this.renderer.domElement.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    window.addEventListener('resize', () => this.onWindowResize());

    this.animate();
  }

  setupGridAndAxes() {
    this.gridHelper = new THREE.GridHelper(50, 50, 0x3b82f6, 0x1e293b);
    this.gridHelper.rotation.x = Math.PI / 2;
    this.gridHelper.position.set(16, 41, 33.0);
    this.scene.add(this.gridHelper);

    this.axesGroup = new THREE.Group();
    this.axesGroup.position.set(5, 30, 33.0);
    const axes = new THREE.AxesHelper(5);
    this.axesGroup.add(axes);
    this.scene.add(this.axesGroup);
  }

  loadModel(modelData) {
    this.modelData = modelData;

    // Clear previous concrete meshes
    for (const key in this.meshes) {
      this.scene.remove(this.meshes[key].group);
    }
    this.meshes = {};
    this.clearSectionMarkers();

    const objects = modelData.objects || {};
    const botEl = objects.culvert?.dimensions?.bot_el ?? 33.404;
    if (this.gridHelper) this.gridHelper.position.set(16, 41, botEl - 0.35);
    if (this.axesGroup) this.axesGroup.position.set(5, 30, botEl - 0.35);

    const colorMap = {
      'CULVERT': { base: 0xa1a1aa, edge: 0x52525b },
      'WW_END_LEFT': { base: 0x38bdf8, edge: 0x0284c7 },
      'WW_END_RIGHT': { base: 0xfbbf24, edge: 0xd97706 },
      'WW_START_LEFT': { base: 0x34d399, edge: 0x059669 },
      'WW_START_RIGHT': { base: 0xa78bfa, edge: 0x7c3aed },
      'culvert': { base: 0xa1a1aa, edge: 0x52525b },
      'ww_left': { base: 0x38bdf8, edge: 0x0284c7 },
      'ww_right': { base: 0xfbbf24, edge: 0xd97706 }
    };

    const renderedIds = new Set();
    const candidateList = [];

    if (objects.culvert) candidateList.push(objects.culvert);
    if (Array.isArray(objects.wingwalls)) {
      candidateList.push(...objects.wingwalls);
    } else {
      for (const k in objects) {
        const o = objects[k];
        if (o && o.vertices && o.faces && o.id) {
          candidateList.push(o);
        }
      }
    }

    for (const obj of candidateList) {
      if (!obj || !obj.vertices || !obj.faces || renderedIds.has(obj.id)) continue;
      renderedIds.add(obj.id);

      const col = colorMap[obj.id] || colorMap[obj.name] || { base: 0x94a3b8, edge: 0x475569 };
      const meshGroup = this.createMeshGroup(obj, col);
      this.scene.add(meshGroup);
      this.meshes[obj.id] = {
        group: meshGroup,
        data: obj,
        baseColor: col.base,
        edgeColor: col.edge
      };
    }

    // Add Section Cut Markers & EL Labels
    this.addSectionMarkers(objects);
    this.addAnnotations(objects);

    // Load 3D Rebars if present
    if (modelData.rebars) {
      this.buildRebarMeshes(modelData.rebars);
    }

    this.applyStepVisualState();
    this.fitView();
  }

  createMeshGroup(obj, col) {
    const group = new THREE.Group();
    group.userData = { id: obj.id, name: obj.name };

    const geom = new THREE.BufferGeometry();
    const vertices = new Float32Array(obj.vertices.flat());
    const indices = [];
    for (const f of obj.faces) {
      indices.push(f[0], f[1], f[2]);
    }

    geom.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();

    const isCulvert = (obj.id === 'CULVERT');
    const mat = new THREE.MeshStandardMaterial({
      color: col.base,
      roughness: 0.6,
      metalness: 0.1,
      side: isCulvert ? THREE.DoubleSide : THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData = { id: obj.id, parentGroup: group };
    group.add(mesh);

    const edgesGeom = new THREE.EdgesGeometry(geom, 25);
    const edgesMat = new THREE.LineBasicMaterial({ color: col.edge, linewidth: 1.5 });
    const edgeLines = new THREE.LineSegments(edgesGeom, edgesMat);
    group.add(edgeLines);

    group.userData.mesh = mesh;
    group.userData.edgeLines = edgeLines;
    group.userData.mat = mat;
    group.userData.edgesMat = edgesMat;

    return group;
  }

  buildRebarMeshes(rebarData) {
    // Clear existing rebar meshes
    while (this.rebarGroupRoot.children.length > 0) {
      const child = this.rebarGroupRoot.children[0];
      this.rebarGroupRoot.remove(child);
    }
    this.rebarMeshes = [];
    this.clearRebarLabels();

    const diaColors = {
      'H19': 0xf43f5e, // Rose Red
      'H16': 0x38bdf8, // Sky Blue
      'H13': 0x10b981  // Emerald Green
    };

    this.rebarFilters.marks.clear();
    const unitCylGeom = new THREE.CylinderGeometry(1, 1, 1, 7, 1, false);
    const sphereGeom = new THREE.SphereGeometry(1.05, 6, 6);
    const yAxis = new THREE.Vector3(0, 1, 0);

    for (const [wwId, ww] of Object.entries(rebarData.wingwalls || {})) {
      for (const grp of ww.groups || []) {
        this.rebarFilters.marks.add(grp.mark);

        const baseColor = diaColors[grp.dia] || 0xeab308;
        const mat = new THREE.MeshStandardMaterial({
          color: baseColor,
          roughness: 0.35,
          metalness: 0.45
        });

        const groupContainer = new THREE.Group();
        groupContainer.userData = {
          isRebarGroup: true,
          wingwallId: wwId,
          mark: grp.mark,
          dia: grp.dia,
          zone: grp.zone,
          baseColor: baseColor,
          mat: mat,
          groupData: grp
        };

        const radiusMeters = (grp.dia_mm / 2000.0) * this.rebarScale;

        for (const poly of grp.polylines || []) {
          for (let i = 0; i < poly.length - 1; i++) {
            const p1 = new THREE.Vector3(poly[i][0], poly[i][1], poly[i][2]);
            const p2 = new THREE.Vector3(poly[i + 1][0], poly[i + 1][1], poly[i + 1][2]);
            const dir = new THREE.Vector3().subVectors(p2, p1);
            const len = dir.length();
            if (len < 1e-4) continue;

            const mid = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);
            const segMesh = new THREE.Mesh(unitCylGeom, mat);
            segMesh.position.copy(mid);
            segMesh.quaternion.setFromUnitVectors(yAxis, dir.clone().normalize());
            segMesh.scale.set(radiusMeters, len, radiusMeters);
            segMesh.userData = {
              isRebar: true,
              mark: grp.mark,
              wingwallId: wwId,
              parentRebarGroup: groupContainer
            };
            groupContainer.add(segMesh);

            if (i > 0) {
              const joint = new THREE.Mesh(sphereGeom, mat);
              joint.position.copy(p1);
              joint.scale.setScalar(radiusMeters);
              groupContainer.add(joint);
            }
          }
        }

        this.rebarGroupRoot.add(groupContainer);
        this.rebarMeshes.push(groupContainer);
      }
    }

    this.updateRebarVisibility();
  }

  setRebarThicknessScale(scaleVal) {
    this.rebarScale = scaleVal;
    if (this.modelData && this.modelData.rebars) {
      this.buildRebarMeshes(this.modelData.rebars);
      if (this.selectedRebarMark) {
        this.selectRebarMark(this.selectedRebarMark);
      }
    }
  }

  setConcreteOpacity(opacityVal) {
    this.concreteOpacity = opacityVal;
    if (this.stepMode === 3) {
      this.applyStepVisualState();
    }
  }

  setStepMode(stepNumber) {
    this.stepMode = stepNumber;
    this.applyStepVisualState();
  }

  applyStepVisualState() {
    const isStep3 = (this.stepMode === 3);

    // Show/hide 3D rebar group root
    if (this.rebarGroupRoot) {
      this.rebarGroupRoot.visible = isStep3;
    }

    // Section markers only in Step 2
    for (const line of this.sectionMarkers) {
      line.visible = !isStep3;
    }
    for (const sp of this.labelSprites) {
      sp.visible = !isStep3;
    }
    for (const sp of this.rebarLabelSprites) {
      sp.visible = isStep3;
    }

    // Concrete appearance
    for (const id in this.meshes) {
      const m = this.meshes[id];
      const mat = m.group.userData.mat;
      const edgesMat = m.group.userData.edgesMat;

      if (isStep3) {
        // In Step 3, wingwalls are semi-transparent ghosted shells so internal rebars shine through
        mat.wireframe = false;
        mat.transparent = true;
        mat.depthWrite = false;
        mat.opacity = (id === 'CULVERT') ? Math.min(0.18, this.concreteOpacity * 0.7) : this.concreteOpacity;
        mat.emissive.setHex(0x000000);
        mat.emissiveIntensity = 0;
        if (edgesMat) {
          edgesMat.transparent = true;
          edgesMat.opacity = 0.35;
        }
      } else {
        mat.depthWrite = true;
        if (edgesMat) {
          edgesMat.transparent = false;
          edgesMat.opacity = 1.0;
        }
        this.setDisplayMode(this.displayMode);
        this.selectObject(this.selectedObjectId);
      }
    }

    if (isStep3) {
      this.updateRebarVisibility();
    }
  }

  updateRebarVisibility() {
    for (const grpObj of this.rebarMeshes) {
      const u = grpObj.userData;
      const matchWw = (this.rebarFilters.wingwall === 'ALL' || u.wingwallId === this.rebarFilters.wingwall);
      const matchZone = this.rebarFilters.zones.has(u.zone);
      const matchDia = this.rebarFilters.dias.has(u.dia);
      const matchMark = this.rebarFilters.marks.has(u.mark);
      grpObj.visible = matchWw && matchZone && matchDia && matchMark;
    }
  }

  selectRebarMark(mark) {
    this.selectedRebarMark = mark;
    this.clearRebarLabels();

    for (const grpObj of this.rebarMeshes) {
      const u = grpObj.userData;
      const mat = u.mat;
      if (u.mark === mark) {
        mat.color.setHex(0xfacc15); // Bright highlight gold
        mat.emissive.setHex(0xf59e0b);
        mat.emissiveIntensity = 0.65;

        // Add floating 3D callout sprite at midpoint of first bar in group
        const polys = u.groupData.polylines;
        if (polys && polys.length > 0) {
          const midPoly = polys[Math.floor(polys.length / 2)];
          const pt = midPoly[Math.floor(midPoly.length / 2)];
          if (pt) {
            const labelText = `[${u.mark}] ${u.dia} (${u.groupData.role})`;
            const sp = this.createTextSprite(labelText, 0xfacc15);
            sp.position.set(pt[0], pt[1], pt[2] + 0.55);
            this.scene.add(sp);
            this.rebarLabelSprites.push(sp);
          }
        }
      } else {
        mat.color.setHex(u.baseColor);
        mat.emissive.setHex(0x000000);
        mat.emissiveIntensity = 0;
      }
    }
  }

  clearRebarLabels() {
    for (const sp of this.rebarLabelSprites) {
      this.scene.remove(sp);
    }
    this.rebarLabelSprites = [];
  }

  addSectionMarkers(objects) {
    this.clearSectionMarkers();

    const sections = [
      { name: '단면 A-A', pts: objects.ww_left?.sections_3d?.['A-A'], color: 0xef4444 },
      { name: '단면 B-B', pts: objects.ww_left?.sections_3d?.['B-B'], color: 0xf97316 },
      { name: '단면 C-C', pts: objects.ww_right?.sections_3d?.['C-C'], color: 0x10b981 },
      { name: '단면 D-D', pts: objects.ww_right?.sections_3d?.['D-D'], color: 0x8b5cf6 }
    ];

    for (const s of sections) {
      if (!s.pts) continue;
      const points = s.pts.map(p => new THREE.Vector3(p[0], p[1], p[2]));
      points.push(points[0].clone());

      const geom = new THREE.BufferGeometry().setFromPoints(points);
      const mat = new THREE.LineBasicMaterial({ color: s.color, linewidth: 3 });
      const line = new THREE.Line(geom, mat);
      this.scene.add(line);
      this.sectionMarkers.push(line);

      const topPt = points[4];
      if (topPt) {
        const sprite = this.createTextSprite(s.name, s.color);
        sprite.position.set(topPt.x, topPt.y, topPt.z + 0.6);
        this.scene.add(sprite);
        this.labelSprites.push(sprite);
      }
    }
  }

  addAnnotations(objects) {
    const wwL = objects.ww_left;
    const wwR = objects.ww_right;
    if (!wwL || !wwR) return;

    const ptA = wwL.sections_3d?.['A-A']?.[5] || [15.725, 42.650, wwL.dimensions.top_el_start];
    const ptB = wwL.sections_3d?.['B-B']?.[5] || [18.75, 45.77, wwL.dimensions.top_el_end];
    const ptD = wwR.sections_3d?.['D-D']?.[5] || [21.01, 38.02, wwR.dimensions.top_el_end];
    const stName = this.modelData?.station || '종점부';

    const elMarkers = [
      { text: `EL. ${wwL.dimensions.top_el_start.toFixed(3)} (암거 접합부)`, pos: ptA, color: 0x38bdf8 },
      { text: `EL. ${wwL.dimensions.top_el_end.toFixed(3)} (좌 말단 L=${wwL.dimensions.length}m)`, pos: ptB, color: 0x38bdf8 },
      { text: `EL. ${wwR.dimensions.top_el_end.toFixed(3)} (우 말단 L=${wwR.dimensions.length}m)`, pos: ptD, color: 0xfbbf24 },
      { text: `${stName} (종점부)`, pos: [16.0, 41.65, wwL.dimensions.top_el_start + 0.5], color: 0xffffff }
    ];

    for (const m of elMarkers) {
      const sprite = this.createTextSprite(m.text, m.color);
      sprite.position.set(m.pos[0], m.pos[1], m.pos[2] + 0.4);
      this.scene.add(sprite);
      this.labelSprites.push(sprite);
    }
  }

  createTextSprite(text, colorHex) {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = 'rgba(18, 21, 28, 0.88)';
    ctx.roundRect ? ctx.roundRect(4, 4, 312, 56, 8) : ctx.fillRect(4, 4, 312, 56);
    ctx.fill();
    ctx.strokeStyle = '#' + new THREE.Color(colorHex).getHexString();
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.font = 'bold 18px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 160, 32);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    const spriteMat = new THREE.SpriteMaterial({ map: texture, depthTest: false });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(3.6, 0.75, 1);
    return sprite;
  }

  clearSectionMarkers() {
    for (const line of this.sectionMarkers) {
      this.scene.remove(line);
    }
    this.sectionMarkers = [];

    for (const sprite of this.labelSprites) {
      this.scene.remove(sprite);
    }
    this.labelSprites = [];
  }

  selectObject(objectId) {
    this.selectedObjectId = objectId;
    if (this.stepMode === 3) return;
    for (const id in this.meshes) {
      const m = this.meshes[id];
      const mat = m.group.userData.mat;
      if (id === objectId) {
        mat.emissive = new THREE.Color(0x2563eb);
        mat.emissiveIntensity = 0.45;
      } else {
        mat.emissive = new THREE.Color(0x000000);
        mat.emissiveIntensity = 0;
      }
    }
  }

  toggleObjectVisibility(objectId, visible) {
    if (this.meshes[objectId]) {
      this.meshes[objectId].group.visible = visible;
    }
  }

  setDisplayMode(mode) {
    this.displayMode = mode;
    for (const id in this.meshes) {
      const mat = this.meshes[id].group.userData.mat;
      if (mode === 'wireframe') {
        mat.wireframe = true;
        mat.transparent = false;
        mat.opacity = 1.0;
        mat.depthWrite = true;
      } else if (mode === 'transparent') {
        mat.wireframe = false;
        mat.transparent = true;
        mat.opacity = 0.35;
        mat.depthWrite = false;
      } else {
        mat.wireframe = false;
        mat.transparent = false;
        mat.opacity = 1.0;
        mat.depthWrite = true;
      }
    }
  }

  fitView() {
    const box = new THREE.Box3();
    for (const id in this.meshes) {
      box.expandByObject(this.meshes[id].group);
    }
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);

    this.controls.target.copy(center);
    this.camera.position.set(center.x + maxDim * 1.35, center.y - maxDim * 1.35, center.z + maxDim * 1.05);
    this.camera.lookAt(center);
    this.controls.update();
  }

  onPointerDown(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);

    if (this.stepMode === 3) {
      const visibleRebarChildren = [];
      for (const grp of this.rebarMeshes) {
        if (grp.visible) {
          visibleRebarChildren.push(...grp.children);
        }
      }
      const hits = this.raycaster.intersectObjects(visibleRebarChildren, false);
      if (hits.length > 0) {
        const hitObj = hits[0].object;
        const mark = hitObj.userData.mark || hitObj.parent?.userData?.mark;
        if (mark) {
          this.selectRebarMark(mark);
          if (this.onSelectRebar) this.onSelectRebar(mark, hitObj.userData.wingwallId);
          return;
        }
      }
    }

    const meshes = Object.values(this.meshes).map(m => m.group.userData.mesh);
    const intersects = this.raycaster.intersectObjects(meshes);

    if (intersects.length > 0) {
      const hitMesh = intersects[0].object;
      const objId = hitMesh.userData.id;
      this.selectObject(objId);
      if (this.onSelect) this.onSelect(objId);
    }
  }

  onWindowResize() {
    if (!this.container) return;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width === 0 || height === 0) return;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
