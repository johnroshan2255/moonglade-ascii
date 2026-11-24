// The ASCII renderer: owns render targets, the four cameras and the glyph atlas.
//
//  reflectCam (prio 0) -> reflectRT   only the "Reflect" layer, mirrored about the water plane
//  sceneCam   (prio 1) -> sceneRT     the world, at glyph-grid resolution (x1 or x2 supersample)
//  cellCam    (prio 2) -> cellRT      full-screen quad: 1 fragment per glyph cell
//  asciiCam   (prio 3) -> backbuffer  full-screen quad: glyph lookup at native resolution
//
// The expensive lit 3D shading therefore runs on ~10–40k pixels instead of millions,
// which is what makes this viable on old phones.

import * as pc from 'playcanvas';
import { GLYPHS, cellMaterial, compositeMaterial, blitMaterial } from './shaders.js';
import { quadMesh } from './meshes.js';

// glyph cell size in CSS px (w, h); ~0.6 aspect like a real terminal font
const CELL_CSS = { xs: [3, 5], s: [4, 6.5], m: [5, 8], l: [7, 11] };

function makeRT(device, name, w, h, { depth, linear }) {
  const tex = new pc.Texture(device, {
    name: `${name}-color`,
    width: w,
    height: h,
    format: pc.PIXELFORMAT_RGBA8,
    mipmaps: false,
    minFilter: linear ? pc.FILTER_LINEAR : pc.FILTER_NEAREST,
    magFilter: linear ? pc.FILTER_LINEAR : pc.FILTER_NEAREST,
    addressU: pc.ADDRESS_CLAMP_TO_EDGE,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });
  return new pc.RenderTarget({
    name,
    colorBuffer: tex,
    depth,
    origin: pc.RENDERTARGET_ORIGIN_BOTTOM,
  });
}

function destroyRT(rt) {
  if (!rt) return;
  rt.colorBuffer?.destroy();
  rt.destroy();
}

export class AsciiRenderer {
  constructor(app) {
    this.app = app;
    this.device = app.graphicsDevice;
    const layers = app.scene.layers;

    this.layerWorld = layers.getLayerByName('World');
    // drawn in a fixed order (MeshInstance.drawOrder): props and grass, then water, then the terrain
    // last, so the depth test rejects ground that something already covers
    this.layerWorld.opaqueSortMode = pc.SORTMODE_MANUAL;
    this.layerReflect = new pc.Layer({ name: 'Reflect' });
    this.layerCell = new pc.Layer({ name: 'AsciiCell', opaqueSortMode: pc.SORTMODE_NONE });
    this.layerComposite = new pc.Layer({ name: 'AsciiComposite', opaqueSortMode: pc.SORTMODE_NONE });
    layers.push(this.layerReflect);
    layers.push(this.layerCell);
    layers.push(this.layerComposite);

    const black = new pc.Color(0, 0, 0, 0);

    this.sceneCam = new pc.Entity('sceneCam');
    this.sceneCam.addComponent('camera', {
      clearColor: black,
      layers: [this.layerWorld.id],
      priority: 1,
      fov: 45,
      nearClip: 0.3,
      farClip: 120,
      frustumCulling: true,
      aspectRatioMode: pc.ASPECT_MANUAL,
      aspectRatio: 1,
    });
    app.root.addChild(this.sceneCam);

    this.reflectCam = new pc.Entity('reflectCam');
    this.reflectCam.addComponent('camera', {
      clearColor: black,
      layers: [this.layerReflect.id],
      priority: 0,
      fov: 45,
      nearClip: 0.3,
      farClip: 80,
      frustumCulling: true,
      aspectRatioMode: pc.ASPECT_MANUAL,
      aspectRatio: 1,
    });
    app.root.addChild(this.reflectCam);

    const quad = quadMesh(this.device);
    this.cellMat = cellMaterial();
    this.compMat = compositeMaterial();
    this.blitMat = blitMaterial();
    const mkQuad = (name, mat, layer) => {
      const mi = new pc.MeshInstance(quad, mat);
      mi.cull = false;
      const e = new pc.Entity(name);
      e.addComponent('render', { meshInstances: [mi], layers: [layer.id], castShadows: false, receiveShadows: false });
      app.root.addChild(e);
      return mi;
    };
    mkQuad('cellQuad', this.cellMat, this.layerCell);
    this.compMI = mkQuad('compositeQuad', this.compMat, this.layerComposite);

    const quadCam = (name, layer, priority) => {
      const e = new pc.Entity(name);
      e.addComponent('camera', {
        layers: [layer.id],
        priority,
        clearColorBuffer: false,
        clearDepthBuffer: false,
        clearStencilBuffer: false,
        frustumCulling: false,
      });
      app.root.addChild(e);
      return e;
    };
    this.cellCam = quadCam('cellCam', this.layerCell, 2);
    this.asciiCam = quadCam('asciiCam', this.layerComposite, 3);

    // remove the default World layer camera ordering issues: none of our quad layers use depth
    this.reflectAt = -1; // when the mirror was last drawn (s)
    this.glyphSize = 'm';
    this.ascii = true; // false = normal 3D view, same world, no glyph filter
    this.normalScale = 1; // normal mode: 3D resolution in CSS px multiplier (quality-driven)
    this.ss = 1;
    this.reflScale = 0;
    this.sizeKey = '';
    this.atlas = null;
    this.atlasKey = '';

    this.compMat.setParameter('uBgMix', 0.16);
    this.compMat.setParameter('uBg', new Float32Array([0.008, 0.008, 0.01]));
    this.blitMat.setParameter('uSharp', 0.3);
    this.blitMat.setParameter('uTexel', new Float32Array([0.001, 0.001]));
    this.blitMat.setParameter('uGlow', new Float32Array([0.5, 0.5, 0.1, 0]));
    this.cellMat.setParameter('uExposure', 3.2);
    this.cellMat.setParameter('uEdge', 0.3);
  }

  setOptions({ glyphSize, ss, reflScale, ascii, normalScale }) {
    if (glyphSize) this.glyphSize = glyphSize;
    if (ascii !== undefined) this.ascii = ascii;
    if (normalScale) this.normalScale = normalScale;
    if (ss) this.ss = ss;
    if (reflScale !== undefined) this.reflScale = reflScale;
  }

  /** Builds the glyph atlas at exactly the cell size in device pixels (no filtering needed). */
  buildAtlas(cw, ch) {
    const key = `${cw}x${ch}`;
    if (this.atlasKey === key) return;
    this.atlasKey = key;
    const chars = GLYPHS.chars;
    const canvas = document.createElement('canvas');
    canvas.width = cw * chars.length;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const px = Math.max(7, Math.round(ch * 0.95));
    ctx.font = `bold ${px}px ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", "Roboto Mono", "Courier New", monospace`;
    // squeeze horizontally if the font is wider than the cell
    const w = ctx.measureText('M').width;
    const sx = w > cw * 0.95 ? (cw * 0.95) / w : 1;
    for (let i = 0; i < chars.length; i++) {
      ctx.save();
      ctx.translate(i * cw + cw / 2, Math.round(ch / 2 + ch * 0.04));
      ctx.scale(sx, 1);
      ctx.fillText(chars[i], 0, 0);
      ctx.restore();
    }
    // Sharpen: tiny antialiased glyphs turn to mush, so push the coverage through a steep
    // contrast curve. Strokes come out crisp while keeping a 1px soft edge.
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = d[i] / 255;
      const t = Math.min(1, Math.max(0, (v - 0.18) / 0.5));
      const o = Math.round(t * t * (3 - 2 * t) * 255);
      d[i] = d[i + 1] = d[i + 2] = o;
    }
    ctx.putImageData(img, 0, 0);
    if (this.atlas) this.atlas.destroy();
    this.atlas = new pc.Texture(this.device, {
      name: 'glyphAtlas',
      width: canvas.width,
      height: canvas.height,
      format: pc.PIXELFORMAT_RGBA8,
      mipmaps: false,
      minFilter: pc.FILTER_NEAREST,
      magFilter: pc.FILTER_NEAREST,
      addressU: pc.ADDRESS_CLAMP_TO_EDGE,
      addressV: pc.ADDRESS_CLAMP_TO_EDGE,
    });
    this.atlas.setSource(canvas);
    this.compMat.setParameter('uAtlas', this.atlas);
  }

  /** Recreates render targets if the canvas size or quality options changed. Cheap no-op otherwise. */
  resize() {
    const d = this.device;
    const W = d.width, H = d.height;
    const dpr = d.maxPixelRatio || 1;
    const [cssW, cssH] = CELL_CSS[this.glyphSize] || CELL_CSS.m;
    // floor keeps every glyph legible even on 1x screens
    // below ~6x10 device px letters stop being letters (1x laptop screens)
    const cw = Math.max(6, Math.round(cssW * dpr));
    const ch = Math.max(10, Math.round(cssH * dpr));
    const key = `${W}x${H}:${cw}x${ch}:${this.ss}:${this.reflScale}:${this.ascii}:${this.normalScale}`;
    if (key === this.sizeKey) return false;
    this.sizeKey = key;

    destroyRT(this.sceneRT);
    destroyRT(this.cellRT);
    destroyRT(this.reflectRT);
    this.cellRT = null;
    this.reflectRT = null;
    if (!this.ascii) return this.resizeNormal(W, H, dpr);

    const cols = Math.ceil(W / cw), rows = Math.ceil(H / ch);
    this.cols = cols;
    this.rows = rows;
    this.cw = cw;
    this.ch = ch;
    this.buildAtlas(cw, ch);

    const sw = cols * this.ss, sh = rows * this.ss;
    this.sceneRT = makeRT(d, 'scene', sw, sh, { depth: true, linear: false });
    this.cellRT = makeRT(d, 'cells', cols, rows, { depth: false, linear: false });
    if (this.reflScale > 0) {
      this.reflectRT = makeRT(d, 'reflect', Math.max(8, Math.round(sw * this.reflScale)), Math.max(8, Math.round(sh * this.reflScale)), { depth: true, linear: true });
    }

    // the scene image is stretched over cols*cw x rows*ch device pixels
    const aspect = (cols * cw) / (rows * ch);
    this.sceneCam.camera.renderTarget = this.sceneRT;
    this.sceneCam.camera.aspectRatio = aspect;
    this.reflectCam.camera.aspectRatio = aspect;
    this.reflectCam.camera.renderTarget = this.reflectRT;
    this.reflectCam.enabled = !!this.reflectRT;
    this.cellCam.camera.renderTarget = this.cellRT;
    this.cellCam.enabled = true;
    this.compMI.material = this.compMat;

    this.cellMat.setParameter('uScene', this.sceneRT.colorBuffer);
    this.cellMat.setParameter('uSS', this.ss);
    this.compMat.setParameter('uCells', this.cellRT.colorBuffer);
    this.compMat.setParameter('uCell', new Float32Array([cw, ch]));
    this.compMat.setParameter('uScreenH', H);
    this.sceneSize = [sw, sh];
    return true;
  }

  /** Normal mode: render the 3D scene at a real resolution and show it directly. */
  resizeNormal(W, H, dpr) {
    const d = this.device;
    const k = Math.min(1, this.normalScale / dpr); // CSS px * normalScale, never above native
    const sw = Math.max(16, Math.round(W * k)), sh = Math.max(16, Math.round(H * k));
    this.sceneRT = makeRT(d, 'scene', sw, sh, { depth: true, linear: true });
    if (this.reflScale > 0) {
      const rs = this.reflScale * 0.5; // reflections are blurred by ripples anyway
      this.reflectRT = makeRT(d, 'reflect', Math.max(8, Math.round(sw * rs)), Math.max(8, Math.round(sh * rs)), { depth: true, linear: true });
    }
    const aspect = W / H;
    this.sceneCam.camera.renderTarget = this.sceneRT;
    this.sceneCam.camera.aspectRatio = aspect;
    this.reflectCam.camera.aspectRatio = aspect;
    this.reflectCam.camera.renderTarget = this.reflectRT;
    this.reflectCam.enabled = !!this.reflectRT;
    this.cellCam.enabled = false; // glyph pass off entirely
    this.compMI.material = this.blitMat;
    this.blitMat.setParameter('uScene', this.sceneRT.colorBuffer);
    this.blitMat.setParameter('uScreen', new Float32Array([W, H]));
    this.blitMat.setParameter('uTexel', new Float32Array([1 / sw, 1 / sh]));
    this.sceneSize = [sw, sh];
    return true;
  }

  /** Vertical FOV that keeps a sensible framing in portrait and landscape. */
  updateFov() {
    const aspect = this.sceneCam.camera.aspectRatio;
    // long-lens, slightly miniature framing
    const fov = aspect < 1 ? 50 : 34;
    this.sceneCam.camera.fov = fov;
    this.reflectCam.camera.fov = fov;
  }

  /**
   * Places the reflection camera: the main camera mirrored about y = waterY, built as a
   * rigid transform (up = -Y). That image equals the true mirror image flipped horizontally,
   * which the water shader undoes by sampling at (1 - u, v).
   */
  updateReflection(camPos, target, waterY, active, now = 0, force = false) {
    let on = active && !!this.reflectRT;
    // at very high frame rates the mirror does not need redrawing for every frame (75 times a
    // second at most: still every frame on a 60 Hz screen)
    if (on && !force && this.reflectAt >= 0 && now >= this.reflectAt && now - this.reflectAt < 1 / 75) on = false;
    this.reflectCam.enabled = on;
    if (!on) return;
    this.reflectAt = now;
    this.reflectCam.setPosition(camPos.x, 2 * waterY - camPos.y, camPos.z);
    this.reflectCam.lookAt(target.x, 2 * waterY - target.y, target.z, 0, -1, 0);
  }
}
