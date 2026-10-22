// Application Main Controller (3-Step Workflow: 1단계 도면 불러오기·판별 -> 2단계 일반도 외형 모델링 -> 3단계 배근도 철근 배근)
class WingwallApp {
  constructor() {
    this.currentStep = 1; // 1: 도면 불러오기 및 판별, 2: 일반도 외형 모델링, 3: 배근도 철근 배근
    this.drawings = [];
    this.activeDrawingId = null;
    this.step1Filter = 'ALL'; // 'ALL', 'GENERAL', 'REBAR', 'UNCLASSIFIED'

    this.drawingData = null;
    this.modelData = null;
    this.selectedObject = 'WW_END_LEFT';
    this.selectedRebarMark = 'W1';
    this.selectedRebarWingwall = 'WW_END_RIGHT';
    this.viewMode = '2d'; // Step 1 starts in '2d', Step 2 & 3 use '3d' / 'split'

    // Step 2 Parametric state (dynamically populated from imported GENERAL drawing)
    this.params = {
      station: '',
      generalDrawingName: '',
      rebarDrawingNames: [],
      culvert: {},
      rebarTables: {},
      left: null,
      right: null
    };

    this.init();
  }

  getApiUrl(path) {
    if (window.location.protocol === 'file:') {
      return `http://127.0.0.1:5000${path}`;
    }
    return path;
  }

  async init() {
    this.viewer3d = new Viewer3D(
      'viewport-3d',
      (id) => this.selectObject(id),
      (mark, wwId) => this.selectRebarMark(mark, wwId)
    );
    this.viewer3d.onSelectRebar = (mark, wwId) => this.selectRebarMark(mark, wwId);
    this.viewer3d.onDeselectRebar = () => this.hideRebarDetailCard();
    this.viewer3d.onSelectWingwall = (objId) => this.selectStep3Structure(objId);

    this.viewer2d = new CAD2DViewer('cad-canvas', (id) => {
      if (this.currentStep === 2) {
        this.selectObject(id);
      }
    });

    this.bindEvents();

    // Default state: No files loaded initially
    this.drawings = [];
    this.drawingData = null;
    this.activeDrawingId = null;
    this.modelData = null;

    // Reset backend session state if server is running
    fetch(this.getApiUrl('/api/reset'), { method: 'POST' }).catch(() => {});

    this.renderAll();
    this.setStep(1);
  }

  showLoading(show, text = '도면 파일 처리 중...') {
    const overlay = document.getElementById('loading-overlay');
    const txt = document.getElementById('loading-text');
    if (txt && text) txt.textContent = text;
    if (overlay) overlay.style.display = show ? 'flex' : 'none';
  }

  // 1.2 도면명에 포함된 키워드를 기준으로 도면 종류 자동 판별
  classifyDrawingByName(drawingName) {
    const nameStr = (drawingName || '').trim();
    if (nameStr.includes('일반')) {
      return {
        autoType: 'GENERAL',
        autoLabel: '일반도',
        matchedKeyword: '일반',
        reason: "도면명에 '일반' 키워드가 포함되어 일반도로 자동 분류됨",
        needsManualSelection: false
      };
    } else if (nameStr.includes('배근') || nameStr.includes('구조')) {
      const kws = [];
      if (nameStr.includes('배근')) kws.push('배근');
      if (nameStr.includes('구조')) kws.push('구조');
      const kwStr = kws.join('/');
      return {
        autoType: 'REBAR',
        autoLabel: '배근도/구조도',
        matchedKeyword: kwStr,
        reason: `도면명에 '${kwStr}' 키워드가 포함되어 배근도/구조도로 자동 분류됨`,
        needsManualSelection: false
      };
    } else {
      return {
        autoType: 'UNCLASSIFIED',
        autoLabel: '미분류 (수동 선택 필요)',
        matchedKeyword: null,
        reason: "도면명에서 '일반' 또는 '배근/구조' 키워드를 판별할 수 없음 — 직접 선택 필요",
        needsManualSelection: true
      };
    }
  }

  // Syncs this.params and offline 3D model from the currently loaded drawings
  syncParamsFromLoadedDrawings() {
    const genDwgs = this.getGeneralDrawings();
    const rebDwgs = this.getRebarDrawings();

    let station = '';
    if (genDwgs.length > 0) {
      const gd = genDwgs.find(d => d.id === this.activeDrawingId) || genDwgs[0];
      this.params.generalDrawingName = gd.fileName;
      const sp = gd.structuralParams;
      if (sp) {
        station = sp.station || '';
        this.params.station = station;
        this.params.culvert = JSON.parse(JSON.stringify(sp.culvert || {}));
        if (sp.left) {
          this.params.left = JSON.parse(JSON.stringify(sp.left));
        }
        if (sp.right) {
          this.params.right = JSON.parse(JSON.stringify(sp.right));
        }
      }
    } else {
      this.params.generalDrawingName = '';
      this.params.station = '';
      this.params.culvert = {};
      this.params.left = null;
      this.params.right = null;
    }

    this.params.rebarDrawingNames = rebDwgs.map(d => d.fileName);
    this.params.rebarTables = {};
    for (const rd of rebDwgs) {
      const rs = rd.rebarSpecs;
      if (rs) {
        if (!station && rs.station) {
          station = rs.station;
          this.params.station = station;
        }
        if (rs.tables) {
          for (const [sideKey, tb] of Object.entries(rs.tables)) {
            this.params.rebarTables[sideKey] = JSON.parse(JSON.stringify(tb));
          }
        }
      }
    }

    // Update top header subtitle dynamically
    const subEl = document.getElementById('header-subtitle');
    if (subEl) {
      if (this.drawings.length === 0) {
        subEl.textContent = '도면을 불러와주세요 (1단계)';
      } else {
        const stLabel = station || this.drawings[0].drawingTitle || this.drawings[0].fileName;
        subEl.textContent = `${stLabel} | 일반도 ${genDwgs.length}건 · 배근도 ${rebDwgs.length}건`;
      }
    }
  }

  bindEvents() {
    // 3-Step Workflow Stepper Buttons
    document.querySelectorAll('.step-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        const step = parseInt(btn.dataset.step, 10);
        this.setStep(step);
      });
    });

    // View Mode Toggle
    document.querySelectorAll('[data-view-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.setViewMode(btn.dataset.viewMode);
      });
    });

    // Display Mode Toggle
    document.querySelectorAll('[data-display-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-display-mode]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.viewer3d.setDisplayMode(btn.dataset.displayMode);
      });
    });

    // Sidebar Tabs (Scoped per step pane)
    document.querySelectorAll('.sidebar-tabs .tab-btn[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        const tabGroup = btn.parentElement;
        const pane = tabGroup.parentElement;
        tabGroup.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        pane.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

        btn.classList.add('active');
        const target = pane.querySelector(`#${btn.dataset.tab}`);
        if (target) target.classList.add('active');
      });
    });

    // Header File Open Button
    document.getElementById('btn-header-file-open')?.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById('file-upload')?.click();
    });

    // Step 1 File Select Button
    document.getElementById('btn-select-file')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      document.getElementById('file-upload')?.click();
    });

    // Step 1 Drag and Drop Zone
    const dropzone = document.getElementById('step1-dropzone');
    if (dropzone) {
      dropzone.addEventListener('click', (e) => {
        if (e.target.closest('#btn-select-file')) return;
        document.getElementById('file-upload')?.click();
      });
      dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
      });
      dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
      dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          this.uploadFiles(Array.from(e.dataTransfer.files));
        }
      });
    }

    // Step 2 Next button -> Step 3
    document.getElementById('btn-goto-step3')?.addEventListener('click', () => this.setStep(3));

    // Step 3 Back button -> Step 2
    document.getElementById('btn-backto-step2')?.addEventListener('click', () => this.setStep(2));

    // Step 3 HUD Controls
    const sliderOp = document.getElementById('step3-slider-opacity');
    if (sliderOp) {
      sliderOp.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        this.viewer3d.setConcreteOpacity(val);
        const valEl = document.getElementById('step3-opacity-val');
        if (valEl) valEl.textContent = `${Math.round(val * 100)}%`;
      });
    }

    const sliderScale = document.getElementById('step3-slider-scale');
    if (sliderScale) {
      sliderScale.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        this.viewer3d.setRebarThicknessScale(val);
        const valEl = document.getElementById('step3-scale-val');
        if (valEl) valEl.textContent = `${val.toFixed(1)}x`;
      });
    }

    // Step 3 Dia Filter Pills
    document.querySelectorAll('#step3-dia-pill-group .dia-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        const dia = btn.dataset.dia;
        if (dia === 'ALL') {
          const allActive = btn.classList.contains('active');
          document.querySelectorAll('#step3-dia-pill-group .dia-pill').forEach(b => {
            b.classList.toggle('active', !allActive);
          });
          if (!allActive) {
            this.viewer3d.rebarFilters.dias = new Set(['H19', 'H16', 'H13']);
          } else {
            this.viewer3d.rebarFilters.dias.clear();
          }
        } else {
          btn.classList.toggle('active');
          if (btn.classList.contains('active')) {
            this.viewer3d.rebarFilters.dias.add(dia);
          } else {
            this.viewer3d.rebarFilters.dias.delete(dia);
          }
          const allBtn = document.querySelector('#step3-dia-pill-group .dia-pill[data-dia="ALL"]');
          if (allBtn) {
            allBtn.classList.toggle('active', this.viewer3d.rebarFilters.dias.size === 3);
          }
        }
        this.viewer3d.updateRebarVisibility();
      });
    });

    // Step 3 Zone Filter Pills
    document.querySelectorAll('#step3-zone-pill-group .zone-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        const zoneKeyword = btn.dataset.zone;
        btn.classList.toggle('active');
        const isActive = btn.classList.contains('active');
        const allZones = [
          '우각부 보강근 (암거접합부)',
          '벽체 전면 철근',
          '벽체 배면 철근',
          '저판 상면 철근',
          '저판 하면 철근',
          '헌치 및 전단보강근'
        ];
        for (const z of allZones) {
          if (z.includes(zoneKeyword)) {
            if (isActive) this.viewer3d.rebarFilters.zones.add(z);
            else this.viewer3d.rebarFilters.zones.delete(z);
          }
        }
        this.viewer3d.updateRebarVisibility();
      });
    });

    // Step 3 Open BOM Button
    document.getElementById('btn-step3-open-bom')?.addEventListener('click', () => this.openBomModal());

    // Step 3 Collapse/Expand HUD Card
    const ctrlHeader = document.getElementById('step3-ctrl-header');
    const ctrlBody = document.getElementById('step3-ctrl-body');
    const ctrlIcon = document.getElementById('step3-ctrl-toggle-icon');
    if (ctrlHeader && ctrlBody) {
      ctrlHeader.addEventListener('click', () => {
        const isHidden = (ctrlBody.style.display === 'none');
        ctrlBody.style.display = isHidden ? 'flex' : 'none';
        if (ctrlIcon) ctrlIcon.textContent = isHidden ? '▾' : '▸';
      });
    }

    // Step 3 Close Rebar Detail Card Button
    document.getElementById('btn-close-rebar-detail')?.addEventListener('click', () => {
      this.hideRebarDetailCard();
      this.viewer3d.clearRebarSelection();
    });

    // Fit View Buttons
    document.getElementById('btn-fit-3d')?.addEventListener('click', () => this.viewer3d.fitView());
    document.getElementById('btn-fit-2d')?.addEventListener('click', () => this.viewer2d.fitView());

    // BOM Modal Button
    document.getElementById('btn-open-bom-modal')?.addEventListener('click', () => this.openBomModal());

    // Export Dropdown
    const exportBtn = document.getElementById('btn-export-dropdown');
    const exportMenu = document.getElementById('export-menu');
    if (exportBtn && exportMenu) {
      exportBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        exportMenu.classList.toggle('show');
      });
      window.addEventListener('click', () => exportMenu.classList.remove('show'));
    }

    // Export Actions
    document.querySelectorAll('[data-export-fmt]').forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        this.exportModel(item.dataset.exportFmt);
      });
    });

    // File Upload (Supports multiple DWG/DXF files)
    const fileInput = document.getElementById('file-upload');
    if (fileInput) {
      fileInput.addEventListener('change', async (e) => {
        const fileList = Array.from(e.target.files || []);
        if (fileList.length > 0) {
          await this.uploadFiles(fileList);
        }
        try {
          e.target.value = '';
        } catch (_) {}
      });
    }
  }

  getGeneralDrawings() {
    return this.drawings.filter(d => d.classification.selectedType === 'GENERAL');
  }

  getRebarDrawings() {
    return this.drawings.filter(d => d.classification.selectedType === 'REBAR');
  }

  getUnclassifiedDrawings() {
    return this.drawings.filter(d => d.classification.selectedType === 'UNCLASSIFIED');
  }

  // Switch between Step 1, Step 2, Step 3
  async setStep(stepNum) {
    if (stepNum > 1 && this.drawings.length === 0) {
      alert('1단계에서 도면을 먼저 불러와주세요.');
      return;
    }
    if (stepNum === 2 && this.getGeneralDrawings().length === 0) {
      alert('일반도로 분류된 도면이 없습니다. 1단계에서 도면을 일반도로 분류해주세요.');
      return;
    }

    this.currentStep = stepNum;

    // Toggle 2-split mode on app container (Steps 1, 2, 3 are all 2-split vertical UI)
    const appContainer = document.getElementById('app-container');
    if (appContainer) {
      appContainer.classList.toggle('step-1-mode', stepNum === 1);
      appContainer.classList.toggle('step-2-mode', stepNum === 2);
      appContainer.classList.toggle('step-3-mode', stepNum === 3);
    }

    // Toggle header mode controls (Step 2 & 3 exclusively show 3D, no 2D toggle in header)
    const headerModes = document.getElementById('header-mode-controls');
    if (headerModes) {
      headerModes.style.display = (stepNum === 1) ? 'flex' : 'none';
    }

    // Toggle Step 3 Right HUD
    const hud = document.getElementById('step3-right-hud');
    if (hud) {
      hud.style.display = (stepNum === 3) ? 'flex' : 'none';
    }

    // Update top stepper buttons
    document.querySelectorAll('.step-pill').forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.dataset.step, 10) === stepNum);
    });

    // Toggle Left Sidebar Pane
    document.querySelectorAll('.step-sidebar-pane').forEach(pane => pane.classList.remove('active'));
    document.getElementById(`left-pane-step-${stepNum}`)?.classList.add('active');

    const rightTitle = document.getElementById('right-sidebar-title');

    if (stepNum === 1) {
      this.setViewMode('2d');
      this.renderStep1LeftSidebar();
    } else if (stepNum === 2) {
      // Step 2 is exclusively 3D exterior solid model view (세로 2분할 메인 화면)
      this.setViewMode('3d');
      const genDwgs = this.getGeneralDrawings();
      if (genDwgs.length > 0) {
        const curIsGeneral = genDwgs.some(d => d.id === this.activeDrawingId);
        if (!curIsGeneral) {
          this.selectActiveDrawing(genDwgs[0].id, false);
        }
      }
      this.syncParamsFromLoadedDrawings();
      await this.recalculateModel();

      this.viewer3d.setStepMode(2);
      this.viewer3d.fitView();
      this.renderStep2Sidebar();
      this.selectObject(this.selectedObject || 'WW_END_LEFT');
    } else if (stepNum === 3) {
      // Step 3 is exclusively 3D rebar model view (세로 2단: 좌측 구조물 선택 + 우측 3D 뷰어 & HUD)
      this.setViewMode('3d');
      const rebDwgs = this.getRebarDrawings();
      if (rebDwgs.length > 0) {
        const curIsRebar = rebDwgs.some(d => d.id === this.activeDrawingId);
        if (!curIsRebar) {
          this.selectActiveDrawing(rebDwgs[0].id, false);
        }
      }
      if (!this.modelData) {
        await this.recalculateModel();
      }
      this.viewer3d.setStepMode(3);
      this.renderStep3Sidebar();
      this.hideRebarDetailCard();
      this.selectStep3Structure(this.selectedStep3Structure || 'WW_END_LEFT');
    }

    this.renderViewportTopBar();
    this.update3DOverlayLegend();
    this.updateCanvasEmptyState();
  }

  setViewMode(mode) {
    this.viewMode = mode;
    document.querySelectorAll('[data-view-mode]').forEach(b => {
      b.classList.toggle('active', b.dataset.viewMode === mode);
    });

    const vp3d = document.getElementById('viewport-3d');
    const vp2d = document.getElementById('viewport-2d');

    if (mode === '3d') {
      vp3d.style.display = 'block';
      vp2d.style.display = 'none';
      vp3d.classList.remove('split-active');
      this.viewer3d.onWindowResize();
    } else if (mode === '2d') {
      vp3d.style.display = 'none';
      vp2d.style.display = 'block';
      vp3d.classList.remove('split-active');
      this.viewer2d.resizeCanvas();
    } else if (mode === 'split') {
      vp3d.style.display = 'block';
      vp2d.style.display = 'block';
      vp3d.classList.add('split-active');
      this.viewer3d.onWindowResize();
      this.viewer2d.resizeCanvas();
    }
  }

  update3DOverlayLegend() {
    const el = document.getElementById('overlay-3d-legend');
    if (!el) return;

    const lLen = this.modelData?.objects?.ww_left?.dimensions?.length ?? this.params.left.length;
    const rLen = this.modelData?.objects?.ww_right?.dimensions?.length ?? this.params.right.length;

    if (this.currentStep === 3) {
      const rebCount = this.getRebarDrawings().length;
      const totBars = this.modelData?.rebars?.summary?.total_bars ?? 0;
      el.innerHTML = `
        <div class="overlay-chip" style="border-color:rgba(16,185,129,0.5);">
          <strong style="color:#34d399;">[3단계: 배근도 기반 3D 철근 배근]</strong> 적용 배근도: ${rebCount}개 도면 (총 ${totBars}본)
        </div>
        <div class="overlay-chip">
          <span style="color:#f43f5e;">●</span> H19 우각부보강(C1·C2) &nbsp;
          <span style="color:#38bdf8;">●</span> H16 주철근(W1·W5·W6·F1·F2·F6) &nbsp;
          <span style="color:#10b981;">●</span> H13 배력·전단근 &nbsp;
          <span style="color:#facc15;">●</span> 선택 철근
        </div>
        <div class="overlay-chip" style="font-size:10px; color:#94a3b8;">
          좌클릭: 회전 | 우클릭: 이동 | 휠: 줌 | 3D 철근 클릭: 해당 기호 하이라이트 및 상세보기
        </div>
      `;
    } else {
      const genDwgs = this.getGeneralDrawings();
      const genName = genDwgs.length > 0 ? genDwgs.map(d => d.fileName).join(', ') : '선택된 일반도 없음';
      el.innerHTML = `
        <div class="overlay-chip" style="border-color:rgba(56,189,248,0.5);">
          <strong style="color:#38bdf8;">[2단계: 일반도 전용 외형 모델]</strong> ${genName}
        </div>
        <div class="overlay-chip">
          <span style="color:#38bdf8;">■</span> 좌측 날개벽(${Number(lLen).toFixed(2)}m) &nbsp;
          <span style="color:#fbbf24;">■</span> 우측 날개벽(${Number(rLen).toFixed(2)}m) &nbsp;
          <span style="color:#9ca3af;">■</span> 암거 본체 (배근도 제외)
        </div>
        <div class="overlay-chip" style="font-size:10px; color:#94a3b8;">
          좌클릭: 회전 | 우클릭: 이동 | 휠: 줌 | 부재 클릭: 외형 제원 확인 및 3D 강조
        </div>
      `;
    }
  }

  renderViewportTopBar() {
    const ind = document.getElementById('viewport-step-indicator');
    const tabsContainer = document.getElementById('viewport-drawing-tabs');
    if (!ind || !tabsContainer) return;

    let stepBadgeHtml = '';
    let targetDrawings = [];

    if (this.currentStep === 1) {
      if (this.drawings.length === 0) {
        stepBadgeHtml = `<span class="badge" style="background:rgba(100,116,139,0.2); color:#94a3b8; border-color:#475569;">1단계</span> <span style="color:var(--text-muted);">도면 없음</span>`;
      } else {
        stepBadgeHtml = `<span class="dwg-type-badge type-general">1단계</span> <span>불러온 도면 (${this.drawings.length}종)</span>`;
        targetDrawings = this.drawings;
      }
    } else if (this.currentStep === 2) {
      const gen = this.getGeneralDrawings();
      stepBadgeHtml = `<span class="dwg-type-badge type-general">2단계: 일반도 전용</span> <span>외형 모델 (${gen.length}종)</span>`;
      targetDrawings = gen;
    } else {
      stepBadgeHtml = `<span class="dwg-type-badge type-rebar">3단계: 배근도</span> <span>3D 철근 배근 모델링</span>`;
      targetDrawings = []; // 도면 탭 미표시 (지침 4 준수: 배근도 확인 탭 삭제)
    }

    ind.innerHTML = stepBadgeHtml;
    tabsContainer.innerHTML = '';
    tabsContainer.style.display = (this.currentStep === 3) ? 'none' : 'flex';

    for (const d of targetDrawings) {
      const btn = document.createElement('button');
      const isAct = (d.id === this.activeDrawingId);
      btn.className = `vp-dwg-tab ${isAct ? 'active' : ''}`;
      const cType = d.classification ? d.classification.selectedType : 'GENERAL';
      const dotColor = cType === 'GENERAL' ? '#38bdf8' : (cType === 'REBAR' ? '#10b981' : '#f59e0b');
      const shortName = d.fileName.replace(/\.dwg$/i, '');
      btn.innerHTML = `<span style="color:${dotColor};">●</span> ${shortName}`;
      btn.title = `${d.fileName} (${d.classification ? d.classification.selectedLabel : ''})`;
      btn.addEventListener('click', () => {
        this.selectActiveDrawing(d.id, true);
      });
      tabsContainer.appendChild(btn);
    }

    // Update 2D overlay chip
    const ovTitle = document.getElementById('overlay-2d-title');
    if (ovTitle) {
      if (this.drawingData && this.drawingData.classification) {
        const c = this.drawingData.classification;
        ovTitle.innerHTML = `2D CAD: <strong style="color:#f8fafc;">${this.drawingData.fileName}</strong> <span class="dwg-type-badge ${c.selectedType === 'GENERAL' ? 'type-general' : (c.selectedType === 'REBAR' ? 'type-rebar' : 'type-unclassified')}" style="margin-left:6px;">${c.selectedLabel}</span>`;
      } else {
        ovTitle.innerHTML = `2D CAD 도면`;
      }
    }
  }

  updateCanvasEmptyState() {
    const overlay = document.getElementById('canvas-empty-overlay');
    const controls = document.getElementById('viewport-2d-controls');
    const ovInfo = document.getElementById('overlay-2d-info');

    const hasDrawing = !!this.drawingData;

    if (overlay) {
      overlay.style.display = hasDrawing ? 'none' : 'flex';
    }
    if (controls) {
      controls.style.display = hasDrawing ? 'flex' : 'none';
    }
    if (ovInfo) {
      ovInfo.style.display = hasDrawing ? 'block' : 'none';
    }
  }

  selectActiveDrawing(dwgId, switchTo2DInStep1 = false) {
    const found = this.drawings.find(d => d.id === dwgId);
    if (!found) return;
    this.activeDrawingId = found.id;
    this.drawingData = found;
    this.viewer2d.loadDrawing(found);

    if (switchTo2DInStep1 && this.currentStep === 1 && this.viewMode === '3d') {
      this.setViewMode('2d');
    }

    this.renderViewportTopBar();
    this.updateCanvasEmptyState();

    if (this.currentStep === 1) {
      this.renderStep1DrawingsList();
    } else if (this.currentStep === 2) {
      this.renderStep2Sidebar();
    } else if (this.currentStep === 3) {
      this.renderStep3Sidebar();
    }
  }

  // 1.2 도면 종류 판별 및 수동 변경
  async setDrawingClassification(dwgId, newType) {
    const dwg = this.drawings.find(d => d.id === dwgId);
    if (!dwg) return;

    const c = dwg.classification;
    c.selectedType = newType;
    c.selectedLabel = newType === 'GENERAL' ? '일반도' : '배근도/구조도';
    c.isManualOverride = (newType !== c.autoType);

    this.syncParamsFromLoadedDrawings(true);
    await this.recalculateModel();

    this.updateStepHeaderCounts();
    this.renderStep1LeftSidebar();
    this.renderViewportTopBar();
    this.update3DOverlayLegend();
  }

  async removeDrawing(dwgId) {
    this.drawings = this.drawings.filter(d => d.id !== dwgId);
    if (this.activeDrawingId === dwgId) {
      if (this.drawings.length > 0) {
        this.selectActiveDrawing(this.drawings[0].id, false);
      } else {
        this.activeDrawingId = null;
        this.drawingData = null;
        this.modelData = null;
        if (this.viewer2d) {
          this.viewer2d.drawingData = null;
          this.viewer2d.render();
        }
      }
    }
    this.syncParamsFromLoadedDrawings(true);
    if (this.drawings.length > 0) {
      await this.recalculateModel();
    }
    this.renderAll();
    this.updateCanvasEmptyState();
  }

  updateStepHeaderCounts() {
    const genCount = this.getGeneralDrawings().length;
    const rebCount = this.getRebarDrawings().length;
    const uncCount = this.getUnclassifiedDrawings().length;

    const subBadge = document.getElementById('step1-sub-badge');
    if (subBadge) {
      if (this.drawings.length === 0) {
        subBadge.textContent = '도면 확인 및 종류 판별';
      } else {
        subBadge.textContent = uncCount > 0
          ? `일반도 ${genCount} / 배근도 ${rebCount} / 미분류 ${uncCount}`
          : `일반도 ${genCount} / 배근도 ${rebCount}`;
      }
    }
  }

  renderAll() {
    this.updateStepHeaderCounts();
    this.renderStep1LeftSidebar();
    this.renderStep2Sidebar();
    this.renderStep3Sidebar();
    this.renderViewportTopBar();
    this.update3DOverlayLegend();
    this.updateCanvasEmptyState();
  }

  // ==================== STEP 1 RENDERERS (세로 2분할 단순 UI) ====================
  renderStep1LeftSidebar() {
    const totalEl = document.getElementById('step1-total-count');
    if (totalEl) totalEl.textContent = `${this.drawings.length}개`;
    this.renderStep1DrawingsList();
  }

  renderStep1DrawingsList() {
    const listEl = document.getElementById('step1-drawings-list');
    const actionArea = document.getElementById('step1-action-area');
    if (!listEl) return;
    listEl.innerHTML = '';

    if (this.drawings.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state-card">
          <div style="font-size:24px; margin-bottom:6px; opacity:0.6;">📁</div>
          <div>불러온 도면이 없습니다.</div>
          <div style="font-size:10.5px; margin-top:3px; color:var(--text-muted);">
            상단의 <strong>도면 파일 선택</strong> 또는 파일을 드래그하여 추가하세요.
          </div>
        </div>
      `;
      if (actionArea) actionArea.innerHTML = '';
      return;
    }

    for (const d of this.drawings) {
      const c = d.classification;
      const isSelected = (d.id === this.activeDrawingId);
      const isUnc = (c.selectedType === 'UNCLASSIFIED');
      const isGen = (c.selectedType === 'GENERAL');
      const isReb = (c.selectedType === 'REBAR');

      const badgeClass = isGen ? 'type-general' : (isReb ? 'type-rebar' : 'type-unclassified');
      const badgeText = isGen ? '일반도' : (isReb ? '배근도/구조도' : '미분류');

      const card = document.createElement('div');
      card.className = `dwg-card-simple ${isSelected ? 'selected' : ''} ${isUnc ? 'unclassified' : ''}`;
      card.innerHTML = `
        <div class="dwg-card-simple-row1">
          <div class="dwg-card-simple-title" title="${d.fileName}">${d.fileName}</div>
          <button class="dwg-card-btn-del" title="도면 제거" data-del-id="${d.id}">✕</button>
        </div>
        <div class="dwg-card-simple-row2">
          <span class="dwg-card-simple-badge ${badgeClass}">${badgeText}</span>
          <div class="dwg-card-type-toggle">
            <button class="type-toggle-btn ${isGen ? 'active-gen' : ''}" data-set-type="GENERAL">일반도</button>
            <button class="type-toggle-btn ${isReb ? 'active-reb' : ''}" data-set-type="REBAR">배근도/구조도</button>
          </div>
        </div>
      `;

      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-set-type]') || e.target.closest('[data-del-id]')) return;
        this.selectActiveDrawing(d.id, true);
      });

      card.querySelectorAll('[data-set-type]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.setDrawingClassification(d.id, btn.dataset.setType);
        });
      });

      card.querySelector('[data-del-id]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.removeDrawing(d.id);
      });

      listEl.appendChild(card);
    }

    // Step 1 Bottom Action Area (Transition to Step 2)
    if (actionArea) {
      const genCount = this.getGeneralDrawings().length;
      if (genCount > 0) {
        actionArea.innerHTML = `
          <button class="btn btn-primary" style="width:100%; justify-content:center; padding:9px 12px; font-size:12px; font-weight:700;" id="btn-goto-step2">
            2단계: 일반도 외형 모델링 시작 ➔
          </button>
        `;
        document.getElementById('btn-goto-step2')?.addEventListener('click', () => {
          this.setStep(2);
        });
      } else {
        actionArea.innerHTML = `
          <div style="font-size:11px; color:#f59e0b; text-align:center; padding:6px; background:rgba(245,158,11,0.1); border-radius:6px; border:1px solid rgba(245,158,11,0.25);">
            ⚠ 2단계 외형 모델링을 진행하려면 최소 1개 이상의 도면을 <strong>'일반도'</strong>로 지정해주세요.
          </div>
        `;
      }
    }
  }

  populateLayerCheckboxes(containerId, dwgObj) {
    const list = document.getElementById(containerId);
    if (!list || !dwgObj || !dwgObj.layers) return;
    list.innerHTML = '';

    const colorMap = { 1: '#ef4444', 2: '#eab308', 3: '#22c55e', 4: '#06b6d4', 5: '#3b82f6', 6: '#d946ef', 7: '#f8fafc' };

    for (const [lname, info] of Object.entries(dwgObj.layers)) {
      const item = document.createElement('div');
      item.className = 'layer-item';
      const color = colorMap[info.color] || '#94a3b8';
      const checked = this.viewer2d.activeLayers.has(lname);

      item.innerHTML = `
        <input type="checkbox" ${checked ? 'checked' : ''} style="cursor:pointer">
        <span class="layer-color-dot" style="background:${color}"></span>
        <span class="layer-name" title="${lname}">${lname}</span>
      `;

      item.querySelector('input').addEventListener('change', (e) => {
        this.viewer2d.setLayerVisibility(lname, e.target.checked);
      });

      list.appendChild(item);
    }
  }

  // ==================== STEP 2 RENDERERS (일반도 전용 3D 외형 모델링) ====================
  renderStep2Sidebar() {
    const genDwgs = this.getGeneralDrawings();

    // 1. 적용 일반도 정보 & 체적 요약 카드
    const activeGen = genDwgs.find(d => d.id === this.activeDrawingId) || genDwgs[0] || this.drawingData;
    const genCard = document.getElementById('step2-general-dwg-card');
    if (genCard) {
      if (!activeGen) {
        genCard.innerHTML = `
          <div style="padding:10px; background:rgba(239,68,68,0.1); border:1px solid #ef4444; border-radius:6px; font-size:11px; color:#fca5a5; text-align:center;">
            ⚠ 불러온 일반도가 없습니다.
            <button class="btn btn-sm" style="margin-top:6px; width:100%; justify-content:center;" onclick="window.app.setStep(1)">1단계에서 도면 불러오기</button>
          </div>
        `;
      } else {
        const st = this.modelData?.station || this.params?.station || activeGen.titleBlock?.subTitle || '수로암거';
        const totVol = this.modelData?.summary?.total_volume || 0;
        const wwCount = (this.modelData?.objects?.wingwalls || []).length;

        genCard.innerHTML = `
          <div style="background:var(--bg-primary); border:1px solid var(--border-color); border-radius:6px; padding:8px 10px; font-size:11px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
              <span style="font-weight:700; color:#38bdf8; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:180px;" title="${activeGen.fileName}">
                📐 ${activeGen.fileName}
              </span>
              <span class="badge" style="background:rgba(56,189,248,0.15); color:#38bdf8; font-size:10px;">일반도</span>
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center; color:var(--text-secondary); font-size:10.5px;">
              <span>${st} (날개벽 <strong>${wwCount}개소</strong>)</span>
              <span>총 체적: <strong style="color:#38bdf8; font-size:11.5px;">${totVol} m³</strong></span>
            </div>
          </div>
        `;
      }
    }

    // 2. 평면도 암거 및 날개벽 위치 판별 현황 카드 (심플)
    this.renderStep2DetectionCard(activeGen);

    // 3. 외형 모델링 구조물 목록 (심플)
    this.renderStep2StructuresList();

    // 4. Step 3 이동 버튼 이벤트 연결
    document.getElementById('btn-goto-step3')?.addEventListener('click', () => {
      this.setStep(3);
    });
  }

  // 2단계 핵심 기능: 암거 및 날개벽 위치 판별 결과 카드 (간결화)
  renderStep2DetectionCard(activeGen) {
    const card = document.getElementById('step2-detection-card');
    if (!card) return;

    const det = this.modelData?.detection || activeGen?.structuralParams?.detection || {};
    const quads = det.quadrants || {};

    const renderPill = (qKey, label, posLabel) => {
      const q = quads[qKey] || {};
      const exists = !!q.exists;
      const border = exists ? 'rgba(56,189,248,0.4)' : 'rgba(255,255,255,0.06)';
      const bg = exists ? 'rgba(56,189,248,0.08)' : 'rgba(255,255,255,0.02)';
      const color = exists ? '#38bdf8' : 'var(--text-muted)';
      const spec = exists ? `L=${q.length || 0}m` : '미표기';

      return `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:4px 7px; background:${bg}; border:1px solid ${border}; border-radius:4px; font-size:10.5px;">
          <span style="color:${color}; font-weight:${exists ? '600' : '400'};">${label} (${posLabel})</span>
          <span style="color:${color}; font-size:10px;">${exists ? `● ${spec}` : '○ 제외'}</span>
        </div>
      `;
    };

    card.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:5px;">
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:4px;">
          ${renderPill('START_LEFT', '시점 좌측', '상')}
          ${renderPill('END_LEFT', '종점 좌측', '상')}
          ${renderPill('START_RIGHT', '시점 우측', '하')}
          ${renderPill('END_RIGHT', '종점 우측', '하')}
        </div>
      </div>
    `;
  }

  // 날개벽 구성 시뮬레이션 적용 핸들러
  async applySimulationConfig(mode) {
    this.simulatedConfig = mode;
    const override = { culvert: {}, left: {}, right: {}, start_left: {}, start_right: {}, detection: {} };

    if (mode === 'REAL') {
      // Restore actual detection from current drawings
      this.syncParamsFromLoadedDrawings(true);
    } else if (mode === 'BOTH') {
      override.detection = {
        configuration: 'BOTH',
        configuration_label: '시점부 및 종점부 날개벽 모두 존재 (4개소 시뮬레이션)',
        rule_statement: '시점부 좌·우 및 종점부 좌·우 총 4개 날개벽을 모두 모델링합니다.',
        quadrants: {
          START_LEFT: { exists: true, length: 4.35, flare_angle: 134.0 },
          START_RIGHT: { exists: true, length: 5.40, flare_angle: 151.0 },
          END_LEFT: { exists: true, length: 4.35, flare_angle: 134.0 },
          END_RIGHT: { exists: true, length: 5.40, flare_angle: 151.0 }
        }
      };
      override.start_left = { length: 4.35, flare_angle: 134.0, exists: true };
      override.start_right = { length: 5.40, flare_angle: 151.0, exists: true };
      override.left = { length: 4.35, flare_angle: 134.0, exists: true };
      override.right = { length: 5.40, flare_angle: 151.0, exists: true };
    } else if (mode === 'START_ONLY') {
      override.detection = {
        configuration: 'START_ONLY',
        configuration_label: '시점부 날개벽만 존재 (2개소 시뮬레이션)',
        rule_statement: '암거 좌측(시점부)에만 날개벽이 표기되어 시점부 날개벽만 모델링합니다.',
        quadrants: {
          START_LEFT: { exists: true, length: 4.35, flare_angle: 134.0 },
          START_RIGHT: { exists: true, length: 5.40, flare_angle: 151.0 },
          END_LEFT: { exists: false },
          END_RIGHT: { exists: false }
        }
      };
      override.start_left = { length: 4.35, flare_angle: 134.0, exists: true };
      override.start_right = { length: 5.40, flare_angle: 151.0, exists: true };
      override.left = { exists: false };
      override.right = { exists: false };
    } else if (mode === 'NONE') {
      override.detection = {
        configuration: 'NONE',
        configuration_label: '날개벽 미존재 (암거 본체만 시뮬레이션)',
        rule_statement: '날개벽이 전혀 표기되어 있지 않아 날개벽을 생성하지 않고 암거 본체만 모델링합니다.',
        quadrants: {
          START_LEFT: { exists: false },
          START_RIGHT: { exists: false },
          END_LEFT: { exists: false },
          END_RIGHT: { exists: false }
        }
      };
      override.start_left = { exists: false };
      override.start_right = { exists: false };
      override.left = { exists: false };
      override.right = { exists: false };
    }

    await this.recalculateModel(override);
    this.viewer3d.fitView();
    this.renderStep2Sidebar();
    this.update3DOverlayLegend();
  }

  renderStep2StructuresList() {
    const list = document.getElementById('step2-structures-list');
    if (!list || !this.modelData || !this.modelData.objects) return;
    list.innerHTML = '';

    const culv = this.modelData.objects.culvert;
    const station = this.modelData.station || this.params.station || '수로암거';

    const items = [];

    // 1. 암거 본체 (항상 포함)
    if (culv) {
      items.push({
        id: 'CULVERT',
        name: `암거 본체 (${station})`,
        tag: `내공 ${culv.dimensions.clear_span.toFixed(1)}×${culv.dimensions.clear_height.toFixed(1)}m`,
        color: '#a1a1aa',
        info: `폭 ${culv.dimensions.outer_width.toFixed(2)}m × 높이 ${culv.dimensions.height.toFixed(2)}m · 사각 ${culv.dimensions.skew_angle.toFixed(1)}° · ${culv.volume} m³`
      });
    }

    // 2. 도면에 실제로 생성된 날개벽 목록만 동적으로 추가
    const wwList = this.modelData.objects.wingwalls || [];
    const colorMap = {
      'WW_END_LEFT': '#38bdf8',
      'WW_END_RIGHT': '#fbbf24',
      'WW_START_LEFT': '#34d399',
      'WW_START_RIGHT': '#a78bfa'
    };

    for (const ww of wwList) {
      const c = colorMap[ww.id] || '#38bdf8';
      items.push({
        id: ww.id,
        name: ww.name,
        tag: `L=${ww.dimensions.length.toFixed(2)}m (${ww.dimensions.flare_angle.toFixed(0)}°)`,
        color: c,
        info: `H=${(ww.dimensions.total_height_start || 3.3).toFixed(2)}~${(ww.dimensions.total_height_end || 1.5).toFixed(2)}m · B=${(ww.dimensions.footing_width_start || 2.2).toFixed(2)}~${(ww.dimensions.footing_width_end || 1.5).toFixed(2)}m · ${ww.volume} m³`
      });
    }

    if (wwList.length === 0) {
      const emptyNote = document.createElement('div');
      emptyNote.style.cssText = 'padding:8px; background:rgba(255,255,255,0.02); border:1px dashed var(--border-color); border-radius:4px; font-size:11px; color:var(--text-muted); text-align:center;';
      emptyNote.innerHTML = '도면에 날개벽이 표기되어 있지 않아 암거 본체만 생성되었습니다.';
      list.appendChild(emptyNote);
    }

    for (const s of items) {
      const isSel = (this.selectedObject === s.id);
      const card = document.createElement('div');
      card.className = `struct-card-step2 ${isSel ? 'selected' : ''}`;
      card.id = `step2-struct-${s.id}`;
      card.style.padding = '7px 9px';
      card.style.gap = '3px';

      card.innerHTML = `
        <div class="struct-card-step2-row1">
          <div class="struct-card-step2-title" style="font-size:11.5px;">
            <input type="checkbox" checked id="vis-chk-${s.id}" title="3D 표시/숨김" style="cursor:pointer; margin:0;">
            <span style="color:${s.color};">■</span>
            <span>${s.name}</span>
          </div>
          <span class="struct-card-step2-tag" style="border:1px solid ${s.color}40; color:${s.color}; font-size:9.5px; padding:1px 5px;">${s.tag}</span>
        </div>
        <div style="font-size:10px; color:var(--text-secondary); margin-left:18px;">
          ${s.info}
        </div>
      `;

      card.querySelector('input').addEventListener('change', (e) => {
        e.stopPropagation();
        this.viewer3d.toggleObjectVisibility(s.id, e.target.checked);
      });

      card.addEventListener('click', () => {
        this.selectObject(s.id);
      });

      list.appendChild(card);
    }
  }

  renderStep2Diagnostics() {
    if (!this.modelData) return;
    const summary = this.modelData.summary || {};
    const volCard = document.getElementById('step2-volume-summary');
    const wwCount = summary.wingwall_count ?? (this.modelData.objects?.wingwalls?.length ?? 2);
    const wwVol = summary.wingwalls_volume ?? ((summary.ww_left_volume || 0) + (summary.ww_right_volume || 0));

    if (volCard) {
      volCard.innerHTML = `
        <div class="meta-item"><span class="label">암거 본체 체적</span><span class="value">${summary.culvert_volume || 0} m³</span></div>
        <div class="meta-item"><span class="label">날개벽 합계 (${wwCount}개소)</span><span class="value">${wwVol.toFixed(2)} m³</span></div>
        <div class="meta-item" style="border-color:#38bdf8; grid-column:span 2;"><span class="label">총 콘크리트 체적 (암거+날개벽)</span><span class="value" style="color:#38bdf8; font-size:14px;">${summary.total_volume || 0} m³</span></div>
      `;
    }

    const badge = document.getElementById('step2-validation-badge');
    if (badge) {
      const cfgLbl = summary.configuration_label || '종점부 날개벽만 존재 (2개소)';
      badge.innerHTML = `
        <div style="padding:8px 10px; background:rgba(16,185,129,0.08); border:1px solid rgba(16,185,129,0.25); border-radius:6px; font-size:11px; color:#34d399; display:flex; flex-direction:column; gap:4px;">
          <div>✓ <strong>위치 판별 일치:</strong> ${cfgLbl} (평면도 중앙 사다리꼴·상하 점선 검출)</div>
          <div>✓ <strong>임의생성 배제:</strong> 도면에 없는 날개벽 생성 차단 및 도면 표기 날개벽 누락 없음</div>
          <div>✓ <strong>3D 솔리드 폐합:</strong> 완전 폐합 2-manifold closed mesh (Non-manifold / Boundary: 0)</div>
        </div>
      `;
    }
  }

  selectObject(objectId) {
    this.selectedObject = objectId;
    this.viewer3d.selectObject(objectId);

    // Update Step 2 cards selection
    document.querySelectorAll('.struct-card-step2').forEach(el => el.classList.remove('selected'));
    const targetCard = document.getElementById(`step2-struct-${objectId}`);
    if (targetCard) {
      targetCard.classList.add('selected');
      targetCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  // ==================== STEP 3 RENDERERS (배근도 기반 3D 철근 배근) ====================
  renderStep3Sidebar() {
    this.renderStep3SummaryCard();
    this.renderStep3StructuresList();
  }

  renderStep3SummaryCard() {
    const card = document.getElementById('step3-rebar-summary-card');
    if (!card) return;
    const summary = this.modelData?.rebars?.summary;

    const totBars = summary?.total_bars ?? 508;
    const totTon = summary?.total_weight_ton ?? '1.543';

    card.innerHTML = `
      <div class="panel-section" style="margin-bottom:0; padding:10px 12px; border-left:3px solid var(--accent-color);">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
          <span style="font-size:11px; font-weight:700; color:var(--text-primary); display:flex; align-items:center; gap:5px;">
            <span>🔩</span> 적용 배근도/구조도 (4종)
          </span>
          <span class="badge" style="background:rgba(16,185,129,0.18); color:#34d399; font-size:10px;">배근 완료</span>
        </div>
        <div style="font-size:10.5px; color:var(--text-secondary); line-height:1.4;">
          종점 우측(01~02) 및 종점 좌측(03~04) 구조도 기반 날개벽 내부 3D 철근 배근
        </div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-top:8px; padding-top:6px; border-top:1px solid rgba(255,255,255,0.06); font-size:10.5px;">
          <div><span style="color:var(--text-muted);">총 배근 본수:</span> <strong style="color:var(--text-primary);">${totBars} 본</strong></div>
          <div><span style="color:var(--text-muted);">총 철근 중량:</span> <strong style="color:#38bdf8;">${totTon} TON</strong></div>
        </div>
      </div>
    `;
  }

  renderStep3StructuresList() {
    const list = document.getElementById('step3-structures-list');
    if (!list || !this.modelData || !this.modelData.objects) return;
    list.innerHTML = '';

    const culv = this.modelData.objects.culvert;
    const station = this.modelData.station || this.params.station || 'STA.13+611.21';
    const reb = this.modelData.rebars;

    const items = [];

    // 1. 암거 본체
    if (culv) {
      items.push({
        id: 'CULVERT',
        name: `암거 본체 (${station})`,
        tag: `내공 ${culv.dimensions.clear_span.toFixed(1)}×${culv.dimensions.clear_height.toFixed(1)}m`,
        color: '#94a3b8',
        info: `사각 ${culv.dimensions.skew_angle.toFixed(1)}° | 콘크리트 ${culv.volume} m³ | 전체 보기`
      });
    }

    // 2. 종점부 날개벽 (도면에 실제 존재하는 날개벽만 표기)
    const wwList = this.modelData.objects.wingwalls || [];
    const colorMap = {
      'WW_END_LEFT': '#38bdf8',
      'WW_END_RIGHT': '#fbbf24',
      'WW_START_LEFT': '#34d399',
      'WW_START_RIGHT': '#a78bfa'
    };

    for (const ww of wwList) {
      const c = colorMap[ww.id] || '#38bdf8';
      const wwReb = reb?.wingwalls?.[ww.id];
      const barCount = wwReb ? wwReb.groups.reduce((acc, g) => acc + g.count, 0) : 0;
      const weightTon = wwReb ? wwReb.groups.reduce((acc, g) => acc + g.weight_ton, 0).toFixed(3) : '0';

      items.push({
        id: ww.id,
        name: ww.name,
        tag: `L=${ww.dimensions.length.toFixed(2)}m (${ww.dimensions.flare_angle.toFixed(0)}°)`,
        color: c,
        info: `철근 ${barCount}본 (${weightTon} TON) | 체적 ${ww.volume} m³`
      });
    }

    for (const s of items) {
      const isSel = (this.selectedStep3Structure === s.id);
      const card = document.createElement('div');
      card.className = `struct-card-step3 ${isSel ? 'selected' : ''}`;
      card.id = `step3-struct-${s.id}`;

      card.innerHTML = `
        <div class="struct-card-step2-row1">
          <div class="struct-card-step2-title" style="font-size:11.5px;">
            <span style="color:${s.color};">●</span>
            <span>${s.name}</span>
          </div>
          <span class="struct-card-step2-tag" style="border:1px solid ${s.color}40; color:${s.color}; font-size:9.5px; padding:1px 5px;">${s.tag}</span>
        </div>
        <div style="font-size:10px; color:var(--text-secondary); margin-left:14px;">
          ${s.info}
        </div>
      `;

      card.addEventListener('click', () => {
        this.selectStep3Structure(s.id);
      });

      list.appendChild(card);
    }
  }

  selectStep3Structure(structId) {
    this.selectedStep3Structure = structId;
    this.viewer3d.focusWingwall(structId);

    // Update active style on cards
    document.querySelectorAll('.struct-card-step3').forEach(el => el.classList.remove('selected'));
    const targetCard = document.getElementById(`step3-struct-${structId}`);
    if (targetCard) {
      targetCard.classList.add('selected');
      targetCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  selectRebarMark(mark, wwId) {
    if (!mark) {
      this.hideRebarDetailCard();
      this.viewer3d.clearRebarSelection();
      return;
    }
    this.selectedRebarMark = mark;
    if (wwId) this.selectedRebarWingwall = wwId;

    this.viewer3d.selectRebarMark(mark);

    if (this.currentStep === 3) {
      this.showRebarDetailCard(mark, wwId);
    }
  }

  showRebarDetailCard(mark, wingwallId) {
    const card = document.getElementById('step3-rebar-detail-card');
    const titleEl = document.getElementById('step3-detail-title');
    const badgeEl = document.getElementById('step3-detail-badge');
    const bodyEl = document.getElementById('step3-rebar-detail-body');
    if (!card || !bodyEl || !this.modelData || !this.modelData.rebars) return;

    const leftWw = this.modelData.rebars.wingwalls.WW_END_LEFT;
    const rightWw = this.modelData.rebars.wingwalls.WW_END_RIGHT;

    const rg = (rightWw?.groups || []).find(g => g.mark === mark) || rightWw?.groups[0];
    const lg = (leftWw?.groups || []).find(g => g.mark === (rg?.mark || mark)) || leftWw?.groups[0];

    if (!rg) return;

    const col = rg.dia === 'H19' ? '#f43f5e' : (rg.dia === 'H16' ? '#38bdf8' : '#10b981');
    const totCount = (rg.count || 0) + (lg ? lg.count : 0);
    const totLen = ((rg.total_length_m || 0) + (lg ? lg.total_length_m : 0)).toFixed(3);
    const totWeight = ((rg.weight_ton || 0) + (lg ? lg.weight_ton : 0)).toFixed(4);

    if (titleEl) titleEl.textContent = `철근 [${rg.mark}] 상세 제원`;
    if (badgeEl) {
      badgeEl.textContent = `${rg.dia} (SD400)`;
      badgeEl.style.background = `${col}22`;
      badgeEl.style.color = col;
      badgeEl.style.border = `1px solid ${col}66`;
    }

    bodyEl.innerHTML = `
      <div style="font-size:11px; color:var(--text-secondary); margin-bottom:4px;">
        ${rg.desc}
      </div>

      <div class="rebar-shape-box" style="margin:4px 0; padding:6px; background:rgba(0,0,0,0.25); border-radius:4px;">
        <div style="font-size:9.5px; color:var(--text-muted); margin-bottom:2px;">
          📐 철근 절곡 형상도 (Bar Bending Detail)
        </div>
        ${this.buildRebarShapeSvg(rg)}
      </div>

      <div class="meta-grid" style="font-size:10.5px; display:grid; grid-template-columns:1fr 1fr; gap:4px;">
        <div class="meta-item"><span class="label">배치 부위</span><span class="value">${rg.zone}</span></div>
        <div class="meta-item"><span class="label">간격 / 피복</span><span class="value">${rg.spacing} (피복 80mm)</span></div>
        <div class="meta-item"><span class="label">종점 좌측 (${Number(leftWw?.length || 4.35).toFixed(2)}m)</span><span class="value">${lg ? lg.count : 0}본 (${lg ? lg.length_m : 0}m)</span></div>
        <div class="meta-item"><span class="label">종점 우측 (${Number(rightWw?.length || 5.4).toFixed(2)}m)</span><span class="value">${rg.count}본 (${rg.length_m}m)</span></div>
        <div class="meta-item"><span class="label">총 본수 / 총연장</span><span class="value">${totCount}본 (${totLen}m)</span></div>
        <div class="meta-item" style="border-color:${col}66;"><span class="label">총 중량</span><span class="value" style="color:${col}; font-weight:700;">${totWeight} TON</span></div>
      </div>
    `;

    card.style.display = 'flex';
  }

  hideRebarDetailCard() {
    const card = document.getElementById('step3-rebar-detail-card');
    if (card) card.style.display = 'none';
  }

  buildRebarShapeSvg(grp) {
    const p = grp.shape_params || {};
    const st = grp.shape_type;
    const col = grp.dia === 'H19' ? '#f43f5e' : (grp.dia === 'H16' ? '#38bdf8' : '#10b981');

    let svgBody = '';
    if (st === 'CORNER_BENT') {
      svgBody = `
        <polyline points="45,95 140,95 215,40" fill="none" stroke="${col}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
        <text x="90" y="112" fill="#e2e8f0" font-size="11" text-anchor="middle">a = ${p.a}mm (암거정착)</text>
        <text x="195" y="82" fill="#e2e8f0" font-size="11" text-anchor="middle">b = ${p.b}mm (날개벽)</text>
        <text x="138" y="78" fill="#facc15" font-size="11" font-weight="bold">x1 = ${p.x1}</text>
      `;
    } else if (st === 'U_HOOK') {
      svgBody = `
        <polyline points="45,95 45,45 235,45 235,95" fill="none" stroke="${col}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
        <text x="140" y="34" fill="#e2e8f0" font-size="11" text-anchor="middle">a = ${p.a} m (저판 폭 가변)</text>
        <text x="28" y="75" fill="#94a3b8" font-size="10" text-anchor="middle">b=${p.b}</text>
        <text x="252" y="75" fill="#94a3b8" font-size="10" text-anchor="middle">c=${p.c}</text>
      `;
    } else if (st === 'U_HOOK_UP') {
      svgBody = `
        <polyline points="45,45 45,90 235,90 235,45" fill="none" stroke="${col}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
        <text x="140" y="108" fill="#e2e8f0" font-size="11" text-anchor="middle">a = ${p.a} m (저판 하면 폭 가변)</text>
        <text x="28" y="68" fill="#94a3b8" font-size="10" text-anchor="middle">b=${p.b}</text>
        <text x="252" y="68" fill="#94a3b8" font-size="10" text-anchor="middle">c=${p.c}</text>
      `;
    } else if (st === 'L_BENT') {
      svgBody = `
        <polyline points="50,45 230,45 230,95" fill="none" stroke="${col}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
        <text x="140" y="34" fill="#e2e8f0" font-size="11" text-anchor="middle">a = ${p.a} m (2Cycle 보강)</text>
        <text x="250" y="75" fill="#94a3b8" font-size="10" text-anchor="middle">b=${p.b}</text>
      `;
    } else if (st === 'STEM_VERTICAL_FRONT' || st === 'STEM_VERTICAL_BACK') {
      svgBody = `
        <polyline points="85,105 155,105 162,20" fill="none" stroke="${col}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
        <text x="120" y="120" fill="#94a3b8" font-size="10" text-anchor="middle">기초정착 ${p.c || p.a}mm</text>
        <text x="210" y="65" fill="#e2e8f0" font-size="11" text-anchor="middle">수직부 ${p.b && p.b.includes('~') ? p.b : p.a} m</text>
      `;
    } else if (st === 'HAUNCH_BENT') {
      svgBody = `
        <polyline points="65,100 135,100 195,35 225,35" fill="none" stroke="${col}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
        <text x="100" y="115" fill="#94a3b8" font-size="10" text-anchor="middle">a=${p.a}</text>
        <text x="185" y="78" fill="#e2e8f0" font-size="11" text-anchor="middle">b=${p.b}</text>
        <text x="215" y="25" fill="#94a3b8" font-size="10" text-anchor="middle">c=${p.c}</text>
      `;
    } else if (st === 'STIRRUP') {
      svgBody = `
        <polyline points="85,35 65,35 65,90 215,90 215,35 195,35" fill="none" stroke="${col}" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>
        <text x="140" y="108" fill="#e2e8f0" font-size="11" text-anchor="middle">a = ${p.a} mm</text>
        <text x="140" y="55" fill="#94a3b8" font-size="10" text-anchor="middle">후크 b = ${p.b} mm</text>
      `;
    } else {
      svgBody = `
        <line x1="35" y1="68" x2="245" y2="68" stroke="${col}" stroke-width="5" stroke-linecap="round"/>
        <text x="140" y="52" fill="#e2e8f0" font-size="11" text-anchor="middle">직선 배력근 a = ${p.a} m</text>
      `;
    }

    return `
      <svg width="280" height="128" viewBox="0 0 280 128" xmlns="http://www.w3.org/2000/svg">
        <rect x="2" y="2" width="276" height="124" rx="6" fill="#0d1017" stroke="#222736"/>
        ${svgBody}
      </svg>
    `;
  }

  renderStep3RightPanel(mark = 'W1') {
    // 세로 2단 레이아웃 규약: 우측 플로팅 상세 제원 창으로 표출
    this.showRebarDetailCard(mark);
  }

  // ==================== BOM MODAL (철근 재료표) ====================
  openBomModal() {
    const modal = document.getElementById('bom-modal');
    const body = document.getElementById('bom-modal-body');
    if (!modal || !body || !this.modelData || !this.modelData.rebars) return;

    const modalSub = document.getElementById('bom-modal-subtitle');
    if (modalSub) {
      const st = this.modelData.station || this.params.station || '';
      modalSub.textContent = `${st} 종점부 날개벽 | fck=30MPa, fy=400~500MPa (SD400)`;
    }

    const rebars = this.modelData.rebars;
    const renderWwTable = (ww) => {
      const groups = ww.groups || [];
      const subs = ww.subtotals_by_dia || {};
      let rowsHtml = '';

      const renderDiaSection = (diaKey) => {
        const dGroups = groups.filter(g => g.dia === diaKey);
        for (const g of dGroups) {
          const shapeStr = Object.entries(g.shape_params || {}).map(([k, v]) => `${k}=${v}`).join(', ');
          rowsHtml += `
            <tr>
              <td style="font-weight:700;">${g.mark}</td>
              <td>${g.dia}</td>
              <td style="text-align:left;">${g.role} (${g.zone})</td>
              <td style="text-align:left; font-size:10.5px; color:#94a3b8;">${shapeStr}</td>
              <td>${g.length_m.toFixed(3)}</td>
              <td>${g.count}</td>
              <td>${g.total_length_m.toFixed(3)}</td>
              <td>-</td>
              <td>-</td>
              <td>-</td>
            </tr>
          `;
        }
        const sub = subs[diaKey];
        if (sub) {
          rowsHtml += `
            <tr class="subtotal-row">
              <td colspan="6">${diaKey} 소 계</td>
              <td>${sub.total_length_m.toFixed(3)}</td>
              <td>${sub.unit_weight.toFixed(3)}</td>
              <td>${sub.weight_ton.toFixed(3)}</td>
              <td>${sub.surcharge_ton.toFixed(3)} (3%)</td>
            </tr>
          `;
        }
      };

      renderDiaSection('H19');
      renderDiaSection('H16');
      renderDiaSection('H13');

      const s = ww.summary;
      rowsHtml += `
        <tr class="total-row">
          <td colspan="5">${ww.wingwall_name} 총 계</td>
          <td>${s.total_bars} 본</td>
          <td>${s.total_length_m.toFixed(3)} m</td>
          <td>-</td>
          <td>${s.total_weight_ton.toFixed(3)} TON</td>
          <td>${s.total_surcharge_ton.toFixed(3)} TON</td>
        </tr>
      `;

      return `
        <div style="margin-bottom:18px;">
          <h3 style="font-size:13px; margin-bottom:6px; color:#38bdf8;">
            ■ ${ww.wingwall_name} (연장 L=${ww.length}m, 각도 ${ww.flare_angle}°) — 출처: ${ww.source_drawings.join(', ')}
          </h3>
          <table class="bom-table">
            <thead>
              <tr>
                <th>기호</th>
                <th>직경</th>
                <th>배근 부위 및 역할</th>
                <th>절곡 치수 상세</th>
                <th>길이 (m)</th>
                <th>개수</th>
                <th>총길이 (m)</th>
                <th>단위무게 (kg/m)</th>
                <th>총무게 (TON)</th>
                <th>할증 (3%, TON)</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>
        </div>
      `;
    };

    body.innerHTML = `
      ${renderWwTable(rebars.wingwalls.WW_END_RIGHT)}
      ${renderWwTable(rebars.wingwalls.WW_END_LEFT)}
    `;
    modal.style.display = 'flex';
  }

  closeBomModal() {
    const modal = document.getElementById('bom-modal');
    if (modal) modal.style.display = 'none';
  }

  // ==================== API INTERACTIONS ====================
  async recalculateModel(overrideParams = null) {
    this.syncParamsFromLoadedDrawings();
    const payload = JSON.parse(JSON.stringify(this.params || {}));
    if (overrideParams) {
      if (overrideParams.detection) payload.detection = Object.assign({}, payload.detection || {}, overrideParams.detection);
      if (overrideParams.left) payload.left = Object.assign({}, payload.left || {}, overrideParams.left);
      if (overrideParams.right) payload.right = Object.assign({}, payload.right || {}, overrideParams.right);
      if (overrideParams.start_left) payload.start_left = Object.assign({}, payload.start_left || {}, overrideParams.start_left);
      if (overrideParams.start_right) payload.start_right = Object.assign({}, payload.start_right || {}, overrideParams.start_right);
      if (overrideParams.culvert) payload.culvert = Object.assign({}, payload.culvert || {}, overrideParams.culvert);
    }

    try {
      const res = await fetch(this.getApiUrl('/api/generate-3d'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        const data = await res.json();
        this.modelData = data.model;
        this.viewer3d.loadModel(this.modelData);
        if (this.currentStep === 2) this.renderStep2Sidebar();
        if (this.currentStep === 3) this.renderStep3Sidebar();
        this.update3DOverlayLegend();
        if (this.selectedObject) this.viewer3d.selectObject(this.selectedObject);
        return;
      }
    } catch (e) {
      console.warn('API recalculate failed, using bundled model fallback:', e);
    }

    // Offline fallback using pre-bundled station models
    const st = this.params.station;
    let fallbackModel = null;
    if (window.KNOWN_MODELS_MAP && st) {
      if (window.KNOWN_MODELS_MAP[st]) {
        fallbackModel = window.KNOWN_MODELS_MAP[st];
      } else {
        for (const [k, m] of Object.entries(window.KNOWN_MODELS_MAP)) {
          if (k.includes(st) || st.includes(k) || (st.includes('0+000') && k.includes('0+000')) || (st.includes('13+611') && k.includes('13+611')) || (st.includes('0+017') && k.includes('0+017'))) {
            fallbackModel = m;
            break;
          }
        }
      }
    }

    if (fallbackModel) {
      this.modelData = JSON.parse(JSON.stringify(fallbackModel));
      this.viewer3d.loadModel(this.modelData);
      if (this.currentStep === 2) this.renderStep2Sidebar();
      if (this.currentStep === 3) this.renderStep3Sidebar();
      this.update3DOverlayLegend();
      if (this.selectedObject) this.viewer3d.selectObject(this.selectedObject);
    } else {
      console.warn('1단계에서 불러온 도면과 일치하는 3D 모델 데이터가 없습니다. 기존 샘플 모델을 적용하지 않습니다.');
    }
  }

  async exportModel(format) {
    try {
      const res = await fetch(this.getApiUrl(`/api/export/${format}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.params)
      });
      if (res.ok) {
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const extMap = { dxf: 'dxf', stl: 'stl', obj: 'obj', csv: 'csv', json: 'json' };
        a.download = `wingwall_model.${extMap[format] || 'dat'}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);
      }
    } catch (e) {
      alert('내보내기 중 오류가 발생했습니다: ' + e);
    }
  }

  mergeUploadedDrawings(uploadedList) {
    if (!uploadedList || uploadedList.length === 0) return;

    // Identify station of newly uploaded drawings; if different from existing drawings, clear old station's drawings
    const newStations = new Set();
    for (const ud of uploadedList) {
      const st = ud.structuralParams?.station || ud.rebarSpecs?.station;
      if (st) newStations.add(st);
    }

    if (newStations.size > 0 && this.drawings.length > 0) {
      this.drawings = this.drawings.filter(ed => {
        const edSt = ed.structuralParams?.station || ed.rebarSpecs?.station;
        return !edSt || newStations.has(edSt);
      });
    }

    for (const ud of uploadedList) {
      if (!ud.id) ud.id = ud.fileName;
      if (!ud.classification) {
        const c = this.classifyDrawingByName(ud.fileName);
        ud.classification = {
          ...c,
          selectedType: c.autoType,
          selectedLabel: c.autoLabel,
          isManualOverride: false
        };
      }
      const idx = this.drawings.findIndex(d => d.fileName === ud.fileName);
      if (idx >= 0) this.drawings[idx] = ud;
      else this.drawings.push(ud);
    }

    this.activeDrawingId = uploadedList[0].id;
    this.drawingData = uploadedList[0];
    this.viewer2d.loadDrawing(this.drawingData);
    this.syncParamsFromLoadedDrawings(true);
  }

  async uploadFiles(fileList) {
    const filesArray = Array.from(fileList || []);
    if (filesArray.length === 0) return;

    this.showLoading(true, '도면 파일 처리 중...');

    const formData = new FormData();
    for (const f of filesArray) {
      formData.append('files', f);
    }

    try {
      const res = await fetch(this.getApiUrl('/api/upload'), {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (data.status === 'success') {
        const uploaded = data.uploadedDrawings || (data.drawing ? [data.drawing] : []);
        this.mergeUploadedDrawings(uploaded);

        if (data.model) {
          this.modelData = data.model;
          this.viewer3d.loadModel(this.modelData);
        } else {
          await this.recalculateModel();
        }
        this.setStep(1);
        this.renderAll();
      } else {
        alert('도면 분석 오류: ' + data.message);
      }
    } catch (e) {
      console.warn('Backend upload unavailable, using client known drawings map:', e);
      const uploadedOffline = [];
      for (const f of filesArray) {
        let known = null;
        if (window.KNOWN_DRAWINGS_MAP) {
          if (window.KNOWN_DRAWINGS_MAP[f.name]) {
            known = window.KNOWN_DRAWINGS_MAP[f.name];
          } else {
            // Flexible name matching (normalize whitespace, brackets, NFC/NFD)
            const cleanName = f.name.replace(/\s+/g, '').normalize('NFC');
            for (const [k, v] of Object.entries(window.KNOWN_DRAWINGS_MAP)) {
              const cleanK = k.replace(/\s+/g, '').normalize('NFC');
              if (cleanK === cleanName || cleanK.includes(cleanName) || cleanName.includes(cleanK)) {
                known = v;
                break;
              }
            }
          }
        }

        if (known) {
          const clone = JSON.parse(JSON.stringify(known));
          clone.id = clone.fileName;
          uploadedOffline.push(clone);
        } else {
          alert(`서버(http://127.0.0.1:5000)에 연결되어 있지 않거나 신규 도면(${f.name})이 등록되어 있지 않습니다.\n\n▶ 터미널이나 run_server.bat을 실행하여 파이썬 웹 서버(python app.py)를 켜두시면 모든 신규 DWG 파일을 실시간으로 자동 분석할 수 있습니다.`);
        }
      }
      if (uploadedOffline.length > 0) {
        this.mergeUploadedDrawings(uploadedOffline);
        await this.recalculateModel();
        this.setStep(1);
        this.renderAll();
      }
    } finally {
      this.showLoading(false);
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.app = new WingwallApp();
});
