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
    this.wingwallNameSprites = [];
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
    this.clearWingwallNameSprites();

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

    // Build wingwall 3D structure name sprites (Requirement 3.2.2 & 3.3)
    this.buildWingwallNameSprites();

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

    // Section markers and labels hidden to keep 3D model clean (Requirement 2.2.2 & 2.2.3)
    for (const line of this.sectionMarkers) {
      line.visible = false;
    }
    for (const sp of this.labelSprites) {
      sp.visible = false;
    }
    for (const sp of this.rebarLabelSprites) {
      sp.visible = isStep3;
    }
    this.updateWingwallNameSpritesVisibility();

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

  selectRebarMark(mark, targetWingwallId) {
    const wwId = targetWingwallId || this.selectedWingwallFocus;
    this.selectedRebarMark = mark;
    this.selectedRebarWingwall = wwId;
    this.clearRebarLabels();
    for (const sp of this.wingwallNameSprites) sp.visible = false;

    for (const grpObj of this.rebarMeshes) {
      const u = grpObj.userData;
      const mat = u.mat;
      const isTargetWingwall = (u.wingwallId === wwId);
      const isTargetBar = isTargetWingwall && (u.mark === mark);

      if (isTargetBar) {
        // 오직 선택된 날개벽에 속한 철근만 정상 색상 및 하이라이트 활성화
        mat.transparent = false;
        mat.opacity = 1.0;
        mat.color.setHex(0xfacc15); // 밝은 골드 하이라이트
        mat.emissive.setHex(0xf59e0b);
        mat.emissiveIntensity = 0.65;

        // 선택된 날개벽의 해당 철근 위치에 3D 텍스트 레이블 생성
        const polys = u.groupData.polylines;
        if (polys && polys.length > 0) {
          const midPoly = polys[Math.floor(polys.length / 2)];
          const pt = midPoly[Math.floor(midPoly.length / 2)];
          if (pt) {
            const wwName = (wwId === 'WW_END_LEFT') ? '종점좌' : '종점우';
            const labelText = `[${u.mark}] ${u.dia} (${wwName})`;
            const sp = this.createTextSprite(labelText, 0xfacc15);
            sp.position.set(pt[0], pt[1], pt[2] + 0.55);
            this.scene.add(sp);
            this.rebarLabelSprites.push(sp);
          }
        }
      } else {
        mat.emissive.setHex(0x000000);
        mat.emissiveIntensity = 0;
        if (isTargetWingwall) {
          // 선택된 날개벽 내 다른 철근은 정상 선명도 유지
          mat.transparent = false;
          mat.opacity = 1.0;
          mat.color.setHex(u.baseColor);
        } else {
          // 다른 날개벽의 철근(동일 철근기호 포함)은 비활성화(흐릿한 0.10 불투명도)
          mat.transparent = true;
          mat.opacity = 0.10;
          mat.color.setHex(0x64748b);
        }
      }
    }
  }

  // 좌측 바에서 날개벽/암거 이름을 클릭한 경우에만 기본 구도 변경 (Requirement 3.5.2)
  focusWingwall(wingwallId, updateCamera = false) {
    this.selectedWingwallFocus = wingwallId;

    if (updateCamera) {
      if (wingwallId === 'CULVERT' || !wingwallId) {
        this.fitView();
      } else {
        const targetMesh = this.meshes[wingwallId];
        if (targetMesh && targetMesh.group) {
          const box = new THREE.Box3().setFromObject(targetMesh.group);
          if (!box.isEmpty()) {
            const center = new THREE.Vector3();
            const size = new THREE.Vector3();
            box.getCenter(center);
            box.getSize(size);
            const maxDim = Math.max(size.x, size.y, size.z);
            this.controls.target.copy(center);
            this.camera.position.set(center.x + maxDim * 1.5, center.y - maxDim * 1.4, center.z + maxDim * 1.1);
            this.camera.lookAt(center);
            this.controls.update();
          }
        }
      }
    }

    this.applyWingwallVisuals(wingwallId);
  }

  // 카메라 구도를 변경하지 않고 콘크리트 및 철근의 시각적 활성/비활성 상태만 갱신
  applyWingwallVisuals(wingwallId) {
    const isCulvert = (wingwallId === 'CULVERT' || !wingwallId);

    // 1. 콘크리트 솔리드 외형
    for (const id in this.meshes) {
      const m = this.meshes[id];
      const mat = m.group.userData.mat;
      const edgesMat = m.group.userData.edgesMat;

      if (isCulvert) {
        mat.transparent = true;
        mat.opacity = (id === 'CULVERT') ? Math.min(0.20, this.concreteOpacity * 0.7) : this.concreteOpacity;
        mat.color.setHex((id === 'CULVERT') ? 0x94a3b8 : (id === 'WW_END_LEFT' ? 0x38bdf8 : 0xfbbf24));
        if (edgesMat) {
          edgesMat.transparent = true;
          edgesMat.opacity = 0.35;
        }
      } else {
        if (id === wingwallId) {
          mat.transparent = true;
          mat.opacity = this.concreteOpacity;
          mat.color.setHex(id === 'WW_END_LEFT' ? 0x38bdf8 : 0xfbbf24);
          if (edgesMat) {
            edgesMat.transparent = true;
            edgesMat.opacity = 0.50;
          }
        } else {
          // 비선택 구조물: 옅고 흐릿하게 비활성화 (위치 파악용 유지)
          mat.transparent = true;
          mat.opacity = 0.08;
          mat.color.setHex(0x475569);
          if (edgesMat) {
            edgesMat.transparent = true;
            edgesMat.opacity = 0.12;
          }
        }
      }
    }

    // 2. 철근군
    for (const grpObj of this.rebarMeshes) {
      const u = grpObj.userData;
      if (isCulvert) {
        u.mat.transparent = false;
        u.mat.opacity = 1.0;
        if (u.mark !== this.selectedRebarMark) {
          u.mat.color.setHex(u.baseColor);
        }
      } else {
        if (u.wingwallId === wingwallId) {
          u.mat.transparent = false;
          u.mat.opacity = 1.0;
          if (u.mark !== this.selectedRebarMark) {
            u.mat.color.setHex(u.baseColor);
          }
        } else {
          // 다른 날개벽 철근 비활성화
          u.mat.transparent = true;
          u.mat.opacity = 0.10;
          u.mat.color.setHex(0x64748b);
        }
      }
    }

    // 3. 날개벽 이름 텍스트 라벨 (Requirement 3.2.2 & 3.3)
    this.updateWingwallNameSpritesVisibility();
  }

  // 화면 클릭이나 선택 해제 시 카메라 시점을 유지한 채 철근 하이라이트만 초기화 (Requirement 3.5.1)
  clearRebarSelection() {
    this.selectedRebarMark = null;
    this.selectedRebarWingwall = null;
    this.clearRebarLabels();
    this.applyWingwallVisuals(this.selectedWingwallFocus || 'CULVERT');
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
      const mat = new THREE.LineBasicMaterial({ color: s.color, linewidth: 2 });
      const line = new THREE.Line(geom, mat);
      line.visible = false;
      this.scene.add(line);
      this.sectionMarkers.push(line);
      // Requirement 2.2.3: 단면 0-0 텍스트 표기 삭제 (스프라이트 미생성)
    }
  }

  addAnnotations(objects) {
    // Requirement 2.2.2: 암거본체 선택 시 날개벽 구조물 이름만 표출 (불필요한 EL/스테이션 텍스트 미생성)
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
    sprite.scale.set(3.6, 0.72, 1);
    sprite.userData.aspect = 320 / 64; // 5.0
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

  // Requirement 3.2.2 & 3.3: 암거본체 선택 시 날개벽 구조물 이름만 3D 모델 위에 표시
  buildWingwallNameSprites() {
    this.clearWingwallNameSprites();
    const wwItems = [
      { id: 'WW_END_LEFT', name: '종점부 좌측 날개벽', color: 0x38bdf8 },
      { id: 'WW_END_RIGHT', name: '종점부 우측 날개벽', color: 0xfbbf24 }
    ];

    for (const item of wwItems) {
      const meshObj = this.meshes[item.id] || this.meshes[item.id.toLowerCase()];
      if (!meshObj || !meshObj.group) continue;
      const box = new THREE.Box3().setFromObject(meshObj.group);
      if (box.isEmpty()) continue;
      const center = new THREE.Vector3();
      box.getCenter(center);
      const sprite = this.createTextSprite(item.name, item.color);
      sprite.position.set(center.x, center.y, box.max.z + 0.65);
      sprite.userData.wingwallId = item.id;
      sprite.visible = false;
      this.scene.add(sprite);
      this.wingwallNameSprites.push(sprite);
    }
  }

  clearWingwallNameSprites() {
    for (const sp of this.wingwallNameSprites) {
      this.scene.remove(sp);
    }
    this.wingwallNameSprites = [];
  }

  updateWingwallNameSpritesVisibility() {
    if (this.stepMode !== 2 && this.stepMode !== 3) {
      for (const sp of this.wingwallNameSprites) sp.visible = false;
      return;
    }
    const currentFocus = (this.stepMode === 3) ? this.selectedWingwallFocus : this.selectedObjectId;
    const isCulvert = (!currentFocus || currentFocus === 'CULVERT');
    for (const sp of this.wingwallNameSprites) {
      if (isCulvert) {
        // 암거본체 선택 시 날개벽 구조물의 이름만 표시 (Requirement 2.2.2 & 3.2.2)
        sp.visible = true;
      } else {
        // 특정 날개벽 선택 시 해당 날개벽 이름만 표시
        sp.visible = (sp.userData.wingwallId === currentFocus);
      }
    }
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
    this.updateWingwallNameSpritesVisibility();
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

  // Requirement 2.4: 3D 모델이 메인 화면 표시 영역의 약 80%를 차지하도록 초기 표시 크기(카메라 거리) 조정
  fitView(coverage = 0.80) {
    const box = new THREE.Box3();
    for (const id in this.meshes) {
      if (this.meshes[id] && this.meshes[id].group) {
        box.expandByObject(this.meshes[id].group);
      }
    }
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 1.0);

    const fov = this.camera.fov * (Math.PI / 180);
    const aspect = this.camera.aspect || ((this.container && this.container.clientHeight) ? (this.container.clientWidth / this.container.clientHeight) : 1.6);

    const halfFovV = fov / 2;
    const halfFovH = Math.atan(Math.tan(halfFovV) * aspect);
    const limitingHalfFov = Math.min(halfFovV, halfFovH);

    // 거리 산출: 바운딩 구가 뷰포트의 제한 치수 대비 약 80%를 차지하도록 배치
    const targetDist = (radius / coverage) / Math.sin(limitingHalfFov);

    const dir = new THREE.Vector3(1.0, -1.0, 0.78).normalize();
    const camPos = center.clone().add(dir.multiplyScalar(targetDist));

    this.controls.target.copy(center);
    this.camera.position.copy(camPos);
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
        let chosenHit = null;
        for (const h of hits) {
          const hitWwId = h.object.userData.wingwallId;
          if (this.selectedWingwallFocus && this.selectedWingwallFocus !== 'CULVERT') {
            if (hitWwId === this.selectedWingwallFocus) {
              chosenHit = h;
              break;
            }
          } else {
            chosenHit = h;
            break;
          }
        }

        if (chosenHit) {
          const hitObj = chosenHit.object;
          const mark = hitObj.userData.mark || hitObj.parent?.userData?.mark;
          const hitWwId = hitObj.userData.wingwallId || hitObj.parent?.userData?.wingwallId;

          // Requirement 3.4.1: 선택된 날개벽에 속한 철근만 선택 허용
          if (this.selectedWingwallFocus && this.selectedWingwallFocus !== 'CULVERT') {
            if (hitWwId !== this.selectedWingwallFocus) {
              return;
            }
          }

          if (mark && hitWwId) {
            this.selectRebarMark(mark, hitWwId);
            if (this.onSelectRebar) this.onSelectRebar(mark, hitWwId);
            return;
          }
        }
      }

      // Requirement 3.5.1: 빈 바닥 클릭 시 카메라 구도를 절대 초기화하지 않고 철근 선택만 해제
      this.clearRebarSelection();
      if (this.onDeselectRebar) this.onDeselectRebar();
      return;
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

    // Requirement 3.3: 줌 확대/축소 시에도 3D 텍스트 크기 일정 유지 (Screen-space constant size)
    const sprites = [...this.rebarLabelSprites, ...this.labelSprites, ...this.wingwallNameSprites];
    for (const sp of sprites) {
      if (sp && sp.visible) {
        const dist = this.camera.position.distanceTo(sp.position);
        const baseScale = dist * 0.040;
        const aspect = sp.userData.aspect || 5.0;
        sp.scale.set(baseScale * aspect, baseScale, 1);
      }
    }

    this.renderer.render(this.scene, this.camera);
  }
}
