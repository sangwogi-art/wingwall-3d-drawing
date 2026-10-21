class CAD2DViewer {
  constructor(canvasId, onSelectCallback) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext('2d');
    this.onSelect = onSelectCallback;

    this.drawingData = null;
    this.activeLayers = new Set();
    this.highlightedView = null;
    this.needsFit = true;

    // View transform: pan & zoom
    this.scale = 1.0;
    this.offsetX = 0;
    this.offsetY = 0;
    this.isDragging = false;
    this.startX = 0;
    this.startY = 0;

    this.initEvents();
  }

  initEvents() {
    this.canvas.addEventListener('mousedown', (e) => {
      this.isDragging = true;
      this.startX = e.clientX - this.offsetX;
      this.startY = e.clientY - this.offsetY;
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;
      this.offsetX = e.clientX - this.startX;
      this.offsetY = e.clientY - this.startY;
      this.render();
    });

    window.addEventListener('mouseup', () => {
      this.isDragging = false;
    });

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const zoomFactor = e.deltaY < 0 ? 1.15 : 0.87;
      const newScale = Math.max(0.1, Math.min(this.scale * zoomFactor, 30.0));

      this.offsetX = mouseX - (mouseX - this.offsetX) * (newScale / this.scale);
      this.offsetY = mouseY - (mouseY - this.offsetY) * (newScale / this.scale);
      this.scale = newScale;

      this.render();
    });

    this.canvas.addEventListener('click', (e) => {
      if (Math.abs(e.clientX - (this.startX + this.offsetX)) > 5) return;
      this.handleClick(e);
    });

    window.addEventListener('resize', () => this.resizeCanvas());
  }

  resizeCanvas() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (w === 0 || h === 0) return;

    this.canvas.width = w;
    this.canvas.height = h;
    if (this.needsFit) {
      this.fitView();
      this.needsFit = false;
    } else {
      this.render();
    }
  }

  loadDrawing(drawingData) {
    if (!drawingData) return;
    this.drawingData = drawingData;
    this.activeLayers = new Set(Object.keys(drawingData.layers || {}));
    this.highlightedView = null;
    this.needsFit = true;

    const parent = this.canvas.parentElement;
    if (parent && parent.clientWidth > 0 && parent.clientHeight > 0) {
      this.canvas.width = parent.clientWidth;
      this.canvas.height = parent.clientHeight;
      this.fitView();
      this.needsFit = false;
    }
  }

  setLayerVisibility(layerName, isVisible) {
    if (isVisible) {
      this.activeLayers.add(layerName);
    } else {
      this.activeLayers.delete(layerName);
    }
    this.render();
  }

  fitView() {
    if (!this.drawingData || !this.drawingData.bounds) return;
    if (this.canvas.width === 0 || this.canvas.height === 0) {
      this.needsFit = true;
      return;
    }
    const b = this.drawingData.bounds;
    const dwgW = Math.max(10, b.max_x - b.min_x);
    const dwgH = Math.max(10, b.max_y - b.min_y);

    const pad = 44;
    const scaleX = (this.canvas.width - pad * 2) / dwgW;
    const scaleY = (this.canvas.height - pad * 2) / dwgH;
    this.scale = Math.max(0.1, Math.min(scaleX, scaleY));

    this.offsetX = (this.canvas.width - dwgW * this.scale) / 2 - b.min_x * this.scale;
    this.offsetY = (this.canvas.height + dwgH * this.scale) / 2 + b.min_y * this.scale;

    this.render();
  }

  zoomToView(viewId) {
    this.highlightedView = viewId;
    if (!this.drawingData || !this.drawingData.views || !this.drawingData.views[viewId]) {
      this.render();
      return;
    }
    if (this.canvas.width > 0 && this.canvas.height > 0) {
      const [bx0, by0, bx1, by1] = this.drawingData.views[viewId].bbox;
      const vw = Math.max(10, bx1 - bx0);
      const vh = Math.max(10, by1 - by0);
      const pad = 60;
      const scaleX = (this.canvas.width - pad * 2) / vw;
      const scaleY = (this.canvas.height - pad * 2) / vh;
      this.scale = Math.max(0.2, Math.min(scaleX, scaleY, 12.0));
      this.offsetX = (this.canvas.width - vw * this.scale) / 2 - bx0 * this.scale;
      this.offsetY = (this.canvas.height + vh * this.scale) / 2 + by0 * this.scale;
    }
    this.render();
  }

  worldToScreen(x, y) {
    return {
      x: x * this.scale + this.offsetX,
      y: -y * this.scale + this.offsetY
    };
  }

  screenToWorld(sx, sy) {
    return {
      x: (sx - this.offsetX) / this.scale,
      y: -(sy - this.offsetY) / this.scale
    };
  }

  highlightView(viewId) {
    this.highlightedView = viewId;
    this.render();
  }

  handleClick(e) {
    if (!this.drawingData || !this.drawingData.views) return;
    const rect = this.canvas.getBoundingClientRect();
    const world = this.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);

    for (const [vid, view] of Object.entries(this.drawingData.views)) {
      const [bx0, by0, bx1, by1] = view.bbox;
      if (world.x >= bx0 && world.x <= bx1 && world.y >= by0 && world.y <= by1) {
        this.highlightedView = vid;
        this.render();
        if (view.wingwall && this.onSelect) {
          this.onSelect(view.wingwall);
        } else if (vid === 'PLAN' && this.onSelect) {
          this.onSelect('WW_END_LEFT');
        }
        return;
      }
    }
  }

  render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    if (!this.drawingData) return;

    ctx.lineWidth = Math.max(1.0, 0.75 * this.scale);

    for (const ent of this.drawingData.entities || []) {
      if (!this.activeLayers.has(ent.layer)) continue;

      ctx.strokeStyle = ent.color || '#cccccc';
      ctx.fillStyle = ent.color || '#cccccc';

      if (ent.type === 'LINE') {
        const p1 = this.worldToScreen(ent.p1[0], ent.p1[1]);
        const p2 = this.worldToScreen(ent.p2[0], ent.p2[1]);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      } else if (ent.type === 'LWPOLYLINE') {
        if (!ent.points || ent.points.length === 0) continue;
        ctx.beginPath();
        const p0 = this.worldToScreen(ent.points[0][0], ent.points[0][1]);
        ctx.moveTo(p0.x, p0.y);
        for (let i = 1; i < ent.points.length; i++) {
          const pt = this.worldToScreen(ent.points[i][0], ent.points[i][1]);
          ctx.lineTo(pt.x, pt.y);
        }
        if (ent.closed) ctx.closePath();
        ctx.stroke();
      } else if (ent.type === 'TEXT') {
        const pos = this.worldToScreen(ent.pos[0], ent.pos[1]);
        const fontSize = Math.max(7, ent.height * this.scale * 0.85);
        if (fontSize < 3.5) continue;
        ctx.font = `${Math.min(fontSize, 26)}px -apple-system, "Malgun Gothic", sans-serif`;
        ctx.fillText(ent.text, pos.x, pos.y);
      } else if (ent.type === 'ARC' || ent.type === 'CIRCLE') {
        const c = this.worldToScreen(ent.center[0], ent.center[1]);
        const r = ent.radius * this.scale;
        ctx.beginPath();
        if (ent.type === 'CIRCLE') {
          ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
        } else {
          const sAngle = -THREE.MathUtils.degToRad(ent.end_angle);
          const eAngle = -THREE.MathUtils.degToRad(ent.start_angle);
          ctx.arc(c.x, c.y, r, sAngle, eAngle);
        }
        ctx.stroke();
      }
    }

    // Draw View Boundary Boxes & Labels
    for (const [vid, view] of Object.entries(this.drawingData.views || {})) {
      const [bx0, by0, bx1, by1] = view.bbox;
      const pTopLeft = this.worldToScreen(bx0, by1);
      const pBotRight = this.worldToScreen(bx1, by0);
      const w = pBotRight.x - pTopLeft.x;
      const h = pBotRight.y - pTopLeft.y;

      const isHigh = (this.highlightedView === vid);
      ctx.strokeStyle = isHigh ? '#38bdf8' : (view.is_excluded ? '#ef4444' : 'rgba(148, 163, 184, 0.45)');
      ctx.lineWidth = isHigh ? 2.5 : 1.0;
      ctx.setLineDash(view.is_excluded ? [4, 4] : (isHigh ? [] : [3, 3]));
      ctx.strokeRect(pTopLeft.x, pTopLeft.y, w, h);
      ctx.setLineDash([]);

      if (isHigh) {
        ctx.fillStyle = 'rgba(56, 189, 248, 0.06)';
        ctx.fillRect(pTopLeft.x, pTopLeft.y, w, h);
      }

      ctx.fillStyle = isHigh ? '#38bdf8' : (view.is_excluded ? '#ef4444' : '#94a3b8');
      ctx.font = 'bold 11px -apple-system, "Malgun Gothic", sans-serif';
      ctx.fillText(view.name, pTopLeft.x + 6, pTopLeft.y + 15);
    }

    // Draw Plan View Culvert & Wingwall Quadrant Overlay if available
    const planView = this.drawingData.views?.PLAN;
    const det = this.drawingData.structuralParams?.detection || planView?.detection;
    if (planView && det && det.culvert_bounds) {
      const cb = det.culvert_bounds;
      const midY = cb.center_y || 416.5;
      const startX = cb.start_x || 106.91;
      const endX = cb.end_x || 162.93;

      const pC0 = this.worldToScreen(startX, cb.top_dashed_y || 426.5);
      const pC1 = this.worldToScreen(endX, cb.bot_dashed_y || 406.5);
      const cW = pC1.x - pC0.x;
      const cH = pC1.y - pC0.y;

      ctx.strokeStyle = 'rgba(56, 189, 248, 0.7)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(pC0.x, pC0.y, cW, cH);
      ctx.setLineDash([]);

      ctx.fillStyle = 'rgba(56, 189, 248, 0.08)';
      ctx.fillRect(pC0.x, pC0.y, cW, cH);

      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 10px -apple-system, "Malgun Gothic", sans-serif';
      ctx.fillText('🏢 암거 판별 (내공 2.0m & 점선)', pC0.x + 4, pC0.y - 4);

      // Label detected wingwalls
      const quads = det.quadrants || {};
      if (quads.END_LEFT?.exists) {
        const pEL = this.worldToScreen(endX + 5, midY + 28);
        ctx.fillStyle = '#38bdf8';
        ctx.fillText('🟢 종점부 좌측 날개벽 (L=4.35m, 134°)', pEL.x, pEL.y);
      }
      if (quads.END_RIGHT?.exists) {
        const pER = this.worldToScreen(endX + 5, midY - 32);
        ctx.fillStyle = '#fbbf24';
        ctx.fillText('🟢 종점부 우측 날개벽 (L=5.40m, 151°)', pER.x, pER.y);
      }
      if (!quads.START_LEFT?.exists) {
        const pSL = this.worldToScreen(startX - 50, midY + 28);
        ctx.fillStyle = 'rgba(148, 163, 184, 0.6)';
        ctx.fillText('⚪ 시점부 좌측 (미표기)', pSL.x, pSL.y);
      }
      if (!quads.START_RIGHT?.exists) {
        const pSR = this.worldToScreen(startX - 50, midY - 32);
        ctx.fillStyle = 'rgba(148, 163, 184, 0.6)';
        ctx.fillText('⚪ 시점부 우측 (미표기)', pSR.x, pSR.y);
      }
    }
  }
}
