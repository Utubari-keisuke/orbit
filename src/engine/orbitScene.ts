import * as THREE from 'three';
import type { CrossResult, Kind, StarData, Visitor } from '../types';
import { TAU, DAY, clamp, rnd, hueDist, hueLerp } from '../lib/util';

THREE.ColorManagement.enabled = false;

const N = 128; // orbit line segments
const MN = 22; // meteor trail points
const GLOWK: Record<Kind, number> = { star: 9, planet: 4.5, satellite: 4, blackhole: 6, wormhole: 4.5, meteor: 3 };

export interface SceneEvents {
  onMood?: (hue: number, warm: number) => void;
}

export interface CrossPlan {
  type: CrossResult;
  target: StarData | null;
  next: { e: number; incl: number; hue: number } | null;
}

interface Fade {
  m: THREE.Material;
  o: number;
}

interface Entry {
  d: StarData;
  vis: number;
  visT: number;
  wob: number;
  wph: number;
  M: number;
  n: number;
  size: number;
  flash: number;
  pHue: number;
  cur: { e: number; incl: number; hue: number };
  tgt: { e: number; incl: number; hue: number };
  fade: Fade[];
  ghosts: THREE.Group[];
  pivot: THREE.Group;
  body: THREE.Object3D;
  holder: THREE.Object3D;
  line: THREE.LineLoop;
  lbl: HTMLDivElement;
  mesh?: THREE.Mesh;
  mesh2?: THREE.Mesh;
  comp?: THREE.Mesh;
  ring?: THREE.Mesh;
  ring2?: THREE.Mesh;
  pts?: THREE.Points;
  glowS?: THREE.Sprite;
  linkLine?: THREE.Line;
  baseCol: THREE.Color;
}

interface Guest {
  hue: number;
  visitor: Visitor;
  state: 'approach' | 'crossed' | 'leaving';
  a: number;
  aT: number;
  ecc: number;
  M: number;
  vis: number;
  visT: number;
  pivot: THREE.Group;
  body: THREE.Object3D;
  geo: THREE.BufferGeometry;
  line: THREE.LineLoop;
  mesh: THREE.Mesh;
  glow: THREE.Sprite;
  comps: THREE.Mesh[];
  lbl: HTMLDivElement;
  crossedAt: number;
}

function kepler(M: number, e: number): number {
  let E = M + e * Math.sin(M);
  for (let i = 0; i < 6; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  return E;
}
function orbitPos(a: number, e: number, M: number, out: THREE.Vector3): void {
  const En = kepler(M, e);
  out.set(a * (Math.cos(En) - e), 0, a * Math.sqrt(1 - e * e) * Math.sin(En));
}
function ellipseInto(geo: THREE.BufferGeometry, a: number, e: number): void {
  const b = a * Math.sqrt(1 - e * e);
  const p = geo.attributes.position.array as Float32Array;
  for (let i = 0; i < N; i++) {
    const t = (i / N) * TAU;
    p[i * 3] = a * (Math.cos(t) - e);
    p[i * 3 + 1] = 0;
    p[i * 3 + 2] = b * Math.sin(t);
  }
  geo.attributes.position.needsUpdate = true;
}
function newLineGeo(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  return g;
}
function hsl(h: number, s: number, l: number): THREE.Color {
  return new THREE.Color().setHSL((((h % 360) + 360) % 360) / 360, s, l);
}
function sizeOf(d: StarData): number {
  const i = d.intensity;
  switch (d.kind) {
    case 'star':
      return 0.5 + 0.55 * i;
    case 'planet':
      return 0.28 + 0.4 * i;
    case 'satellite':
      return 0.12 + 0.16 * i;
    case 'blackhole':
      return 0.45 + 0.35 * i;
    case 'wormhole':
      return 0.5 + 0.3 * i;
    default:
      return 0.5 + 0.5 * i;
  }
}

export class OrbitScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(55, 1, 0.1, 500);
  private cam = { yaw: 0.7, pitch: 0.52, dist: 32, idleUntil: 0, init: false };
  private entries = new Map<string, Entry>();
  private guest: Guest | null = null;
  private rings: { m: THREE.Mesh; t: number }[] = [];
  private links: { l: THREE.Line; A: THREE.Object3D; B: Entry; t: number }[] = [];
  private cutoff = Infinity;
  private ghostsOn = true;
  private glowTex: THREE.CanvasTexture;
  private nebula!: THREE.Points;
  private heart = new THREE.Group();
  private heartCore!: THREE.Mesh;
  private heartG1!: THREE.Sprite;
  private heartG2!: THREE.Sprite;
  private heartLight = new THREE.PointLight(0xb9a8ff, 4, 0, 0);
  private heartLbl: HTMLDivElement;
  private moodCur = 258;
  private moodT = { hue: 258, warm: 0.3 };
  private moodAcc = 1;
  private reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private ptr = new Map<number, { x: number; y: number }>();
  private pinch = 0;
  private raf = 0;
  private last = performance.now();
  private T = 0;
  private bottomInset = 0;
  private ro: ResizeObserver;
  private v3 = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private ringGeo = new THREE.RingGeometry(0.94, 1, 72);

  constructor(
    private container: HTMLElement,
    private labels: HTMLElement,
    private ev: SceneEvents = {},
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setClearColor(0x07060f, 1);
    container.appendChild(this.renderer.domElement);
    this.glowTex = this.makeGlowTex();
    this.buildBackdrop();
    this.buildHeart();
    this.heartLbl = document.createElement('div');
    this.heartLbl.className = 'lbl heart';
    this.heartLbl.textContent = 'わたし';
    labels.appendChild(this.heartLbl);
    this.bindInput();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    this.raf = requestAnimationFrame(this.loop);
  }

  /* ----------------------------- public API ----------------------------- */

  /** 下部UIの高さ。カメラ中心をその分だけ持ち上げて、星が隠れないようにする。 */
  setBottomInset(px: number): void {
    this.bottomInset = px;
    this.resize();
  }

  setStars(stars: StarData[]): void {
    for (const E of [...this.entries.values()]) this.removeEntry(E);
    for (const s of [...stars].sort((a, b) => a.created - b.created)) {
      const E = this.buildEntry(s);
      E.vis = 0.6;
    }
    this.applyCutoff();
  }

  addStar(s: StarData): void {
    const E = this.buildEntry(s);
    E.vis = 0;
    E.flash = 1;
    this.applyCutoff();
  }

  /** 履歴や色が変わった星を反映する。軌道は滑らかに動く。 */
  updateStar(s: StarData): void {
    const E = this.entries.get(s.id);
    if (!E) return;
    E.d = s;
    this.buildGhosts(E);
    this.applyCutoff();
  }

  removeStar(id: string): void {
    const ids = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const E of this.entries.values()) {
        if (E.d.parentId && ids.has(E.d.parentId) && !ids.has(E.d.id)) {
          ids.add(E.d.id);
          grew = true;
        }
      }
    }
    for (const x of ids) {
      const E = this.entries.get(x);
      if (E) this.removeEntry(E);
    }
  }

  /** null で「いま」。数値なら、その時点の宇宙を表示する。 */
  setCutoff(ms: number | null): void {
    this.cutoff = ms === null ? Infinity : ms;
    this.applyCutoff();
  }

  setGhosts(on: boolean): void {
    this.ghostsOn = on;
  }

  hasVisitor(): boolean {
    return this.guest !== null;
  }

  showVisitor(v: Visitor): void {
    if (this.guest) return;
    const hue = v.stars[0]?.hue ?? 260;
    const g: Guest = {
      hue,
      visitor: v,
      state: 'approach',
      a: 20,
      aT: 10.5,
      ecc: rnd(0.2, 0.36),
      M: rnd(0, TAU),
      vis: 0,
      visT: 1,
      pivot: new THREE.Group(),
      body: new THREE.Object3D(),
      geo: newLineGeo(),
      line: undefined as unknown as THREE.LineLoop,
      mesh: undefined as unknown as THREE.Mesh,
      glow: undefined as unknown as THREE.Sprite,
      comps: [],
      lbl: document.createElement('div'),
      crossedAt: 0,
    };
    g.pivot.rotation.order = 'YXZ';
    g.pivot.rotation.y = rnd(0, TAU);
    g.pivot.rotation.x = rnd(-0.7, 0.7);
    g.pivot.add(g.body);
    g.line = new THREE.LineLoop(
      g.geo,
      new THREE.LineBasicMaterial({ color: hsl(hue, 0.8, 0.7), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    g.line.frustumCulled = false;
    g.pivot.add(g.line);
    g.mesh = new THREE.Mesh(new THREE.SphereGeometry(0.45, 20, 14), new THREE.MeshBasicMaterial({ color: hsl(hue, 0.7, 0.85), transparent: true }));
    g.body.add(g.mesh);
    g.glow = this.newGlow(g.body, 0.8);
    g.glow.material.color.copy(hsl(hue, 0.9, 0.6));
    g.glow.scale.set(5, 5, 1);
    v.stars.slice(1).forEach((s) => {
      const c = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10), new THREE.MeshBasicMaterial({ color: hsl(s.hue, 0.8, 0.75), transparent: true }));
      g.body.add(c);
      g.comps.push(c);
    });
    this.scene.add(g.pivot);
    g.lbl.className = 'lbl guest';
    g.lbl.textContent = v.stars[0]?.word ?? '';
    g.lbl.style.color = `hsl(${hue} 80% 80%)`;
    this.labels.appendChild(g.lbl);
    this.guest = g;
  }

  /** 見送る(回避・時間切れ)。軌道はゆっくり遠ざかる。 */
  dismissVisitor(): void {
    const g = this.guest;
    if (!g) return;
    g.state = 'leaving';
    g.aT = 48;
    g.visT = 0;
  }

  /** 交差する。結果の種類と対象の星、新しい軌道の値を返す(保存は呼び出し側)。 */
  cross(): CrossPlan | null {
    const g = this.guest;
    if (!g || g.state !== 'approach') return null;
    g.state = 'crossed';
    g.crossedAt = performance.now();
    const vh = g.hue;
    const list = [...this.entries.values()].filter((E) => E.visT > 0.5 && E.vis > 0.5);
    this.guest!.body.getWorldPosition(this.v3);
    const ep = this.v3.clone();
    if (!list.length) {
      for (let k = 0; k < 3; k++) this.addRing(new THREE.Vector3(), vh, k * 0.35);
      return { type: 'resonance', target: null, next: null };
    }
    let best = list[0];
    let worst = list[0];
    for (const E of list) {
      if (hueDist(E.cur.hue, vh) < hueDist(best.cur.hue, vh)) best = E;
      if (hueDist(E.cur.hue, vh) > hueDist(worst.cur.hue, vh)) worst = E;
    }
    let type: CrossResult = 'fusion';
    let target = list[Math.floor(Math.random() * list.length)];
    if (hueDist(best.cur.hue, vh) < 45) {
      type = 'resonance';
      target = best;
    } else if (hueDist(worst.cur.hue, vh) > 140) {
      type = 'interference';
      target = worst;
    }
    const d = target.d;
    let next: { e: number; incl: number; hue: number };
    if (type === 'resonance') {
      next = { e: Math.max(0.04, d.e * 0.6), incl: d.incl * 0.7, hue: d.hue };
      target.wob = 1;
    } else if (type === 'interference') {
      next = { e: Math.min(0.9, d.e + 0.26), incl: clamp(d.incl + rnd(-0.5, 0.5), -1.2, 1.2), hue: d.hue };
      target.wob = 1.8;
    } else {
      next = { e: clamp(d.e + rnd(-0.1, 0.1), 0.05, 0.85), incl: d.incl, hue: hueLerp(d.hue, vh, 0.35) };
      target.wob = 1;
    }
    target.flash = 1;
    target.body.getWorldPosition(this.v3);
    const tp = this.v3.clone();
    for (let k = 0; k < 3; k++) this.addRing(tp, target.cur.hue, k * 0.35);
    this.addRing(ep, vh, 0.2);
    this.addRing(ep, vh, 0.6);
    this.addLink(g.body, target, vh);
    return { type, target: d, next };
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.renderer.dispose();
    this.container.removeChild(this.renderer.domElement);
    this.labels.textContent = '';
  }

  /* ------------------------------- backdrop ------------------------------ */

  private makeGlowTex(): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.25, 'rgba(255,255,255,.45)');
    gr.addColorStop(0.6, 'rgba(255,255,255,.1)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  }

  private newGlow(parent: THREE.Object3D, op: number): THREE.Sprite {
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.glowTex, color: 0xffffff, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    parent.add(s);
    return s;
  }

  private buildBackdrop(): void {
    const mkPoints = (n: number, place: (i: number, pos: Float32Array, col: Float32Array, c: THREE.Color) => void, size: number, opacity: number) => {
      const pos = new Float32Array(n * 3);
      const col = new Float32Array(n * 3);
      const c = new THREE.Color();
      for (let i = 0; i < n; i++) place(i, pos, col, c);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const p = new THREE.Points(
        g,
        new THREE.PointsMaterial({ size, sizeAttenuation: false, map: this.glowTex, vertexColors: true, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      p.frustumCulled = false;
      this.scene.add(p);
      return p;
    };
    this.nebula = mkPoints(
      900,
      (i, pos, col, c) => {
        const r = 12 + Math.pow(Math.random(), 0.75) * 44;
        const th = Math.random() * TAU;
        pos[i * 3] = Math.cos(th) * r;
        pos[i * 3 + 1] = (Math.random() - 0.5) * 2 * r * 0.28;
        pos[i * 3 + 2] = Math.sin(th) * r;
        c.setHSL(rnd(0.62, 0.8), 0.6, rnd(0.04, 0.12));
        col[i * 3] = c.r;
        col[i * 3 + 1] = c.g;
        col[i * 3 + 2] = c.b;
      },
      46,
      0.5,
    );
    mkPoints(
      1100,
      (i, pos, col, c) => {
        const v = new THREE.Vector3(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).normalize().multiplyScalar(rnd(160, 240));
        pos[i * 3] = v.x;
        pos[i * 3 + 1] = v.y;
        pos[i * 3 + 2] = v.z;
        c.setHSL(rnd(0.55, 0.75), 0.5, rnd(0.35, 0.8));
        col[i * 3] = c.r;
        col[i * 3 + 1] = c.g;
        col[i * 3 + 2] = c.b;
      },
      3,
      0.9,
    );
    [3, 6, 9, 12].forEach((r, i) => {
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k < 96; k++) {
        const a = (k / 96) * TAU;
        pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
      }
      this.scene.add(
        new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x9a8cff, transparent: true, opacity: 0.07 - i * 0.01 })),
      );
    });
  }

  private buildHeart(): void {
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    this.scene.add(this.heartLight);
    this.scene.add(this.heart);
    this.heartCore = new THREE.Mesh(new THREE.SphereGeometry(0.8, 32, 20), new THREE.MeshBasicMaterial({ color: 0xd9d2ff }));
    this.heart.add(this.heartCore);
    this.heartG1 = this.newGlow(this.heart, 0.9);
    this.heartG2 = this.newGlow(this.heart, 0.35);
    this.heartG2.scale.set(15, 15, 1);
  }

  /* -------------------------------- input ------------------------------- */

  private bindInput(): void {
    const cv = this.renderer.domElement;
    cv.style.touchAction = 'none';
    cv.addEventListener('pointerdown', (e) => {
      try {
        cv.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      this.ptr.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.cam.idleUntil = performance.now() + 5000;
      if (this.ptr.size === 2) {
        const p = [...this.ptr.values()];
        this.pinch = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      }
    });
    cv.addEventListener('pointermove', (e) => {
      const p = this.ptr.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      this.cam.idleUntil = performance.now() + 5000;
      if (this.ptr.size === 1) {
        this.cam.yaw -= dx * 0.005;
        this.cam.pitch = clamp(this.cam.pitch + dy * 0.005, -1.4, 1.4);
      } else if (this.ptr.size === 2) {
        const q = [...this.ptr.values()];
        const d = Math.hypot(q[0].x - q[1].x, q[0].y - q[1].y);
        if (this.pinch > 0) this.cam.dist = clamp((this.cam.dist * this.pinch) / d, 10, 95);
        this.pinch = d;
      }
    });
    const end = (e: PointerEvent) => {
      this.ptr.delete(e.pointerId);
      this.pinch = 0;
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.cam.dist = clamp(this.cam.dist * Math.exp(e.deltaY * 0.001), 10, 95);
        this.cam.idleUntil = performance.now() + 5000;
      },
      { passive: false },
    );
  }

  private resize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.setViewOffset(w, h, 0, Math.round(this.bottomInset * 0.45), w, h);
    this.camera.updateProjectionMatrix();
    if (!this.cam.init) {
      this.cam.dist = w / h < 1 ? clamp((30 / (w / h)) * 0.9, 34, 64) : 32;
      this.cam.init = true;
    }
  }

  /* ------------------------------- entries ------------------------------ */

  private addFade(E: Entry, m: THREE.Material, o: number): void {
    m.transparent = true;
    E.fade.push({ m, o });
  }

  private buildMesh(E: Entry): void {
    const d = E.d;
    const k = d.kind;
    if (k === 'meteor') {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MN * 3), 3));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MN * 3), 3));
      E.pts = new THREE.Points(
        g,
        new THREE.PointsMaterial({ size: 0.6, map: this.glowTex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      E.pts.frustumCulled = false;
      E.pivot.add(E.pts);
      E.glowS = this.newGlow(E.body, 0.7);
      this.addFade(E, E.glowS.material, 0.7);
      return;
    }
    const geo = new THREE.SphereGeometry(1, 28, 18);
    if (k === 'star') {
      E.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
      E.glowS = this.newGlow(E.body, 0.85);
      this.addFade(E, E.glowS.material, 0.85);
    } else if (k === 'planet' || k === 'satellite') {
      E.mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0 }));
      E.glowS = this.newGlow(E.body, 0.45);
      this.addFade(E, E.glowS.material, 0.45);
    } else if (k === 'blackhole') {
      E.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x000000 }));
      const rm = () => new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
      E.ring = new THREE.Mesh(new THREE.RingGeometry(1.5, 2.7, 64), rm());
      E.ring.rotation.x = Math.PI / 2.4;
      E.ring2 = new THREE.Mesh(new THREE.RingGeometry(1.08, 1.3, 64), rm());
      E.ring2.rotation.x = Math.PI / 2.4;
      E.body.add(E.ring, E.ring2);
      this.addFade(E, E.ring.material as THREE.Material, 0.8);
      this.addFade(E, E.ring2.material as THREE.Material, 0.55);
      E.glowS = this.newGlow(E.body, 0.25);
      this.addFade(E, E.glowS.material, 0.25);
    } else {
      const tm = () => new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending, depthWrite: false });
      E.mesh = new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.12, 12, 48), tm());
      E.mesh2 = new THREE.Mesh(new THREE.TorusGeometry(0.8, 0.08, 12, 40), tm());
      E.body.add(E.mesh2);
      this.addFade(E, E.mesh2.material as THREE.Material, 0.7);
      E.glowS = this.newGlow(E.body, 0.5);
      this.addFade(E, E.glowS.material, 0.5);
    }
    this.addFade(E, E.mesh!.material as THREE.Material, k === 'wormhole' ? 0.85 : 1);
    E.body.add(E.mesh!);
    if (d.binary) {
      E.comp = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
      E.body.add(E.comp);
      this.addFade(E, E.comp.material as THREE.Material, 1);
    }
  }

  private paint(E: Entry): void {
    const h = E.cur.hue;
    const k = E.d.kind;
    const hn = h / 360;
    E.pHue = h;
    (E.line.material as THREE.LineBasicMaterial).color.setHSL(hn, 0.7, 0.62);
    if (E.glowS) E.glowS.material.color.setHSL(hn, 0.9, 0.58);
    if (k === 'star') (E.mesh!.material as THREE.MeshBasicMaterial).color.setHSL(hn, 0.65, 0.86);
    else if (k === 'planet' || k === 'satellite') {
      const m = E.mesh!.material as THREE.MeshStandardMaterial;
      m.color.setHSL(hn, 0.5, 0.5);
      m.emissive.setHSL(hn, 0.8, 0.2);
    } else if (k === 'blackhole') {
      (E.ring!.material as THREE.MeshBasicMaterial).color.setHSL(hn, 0.9, 0.6);
      (E.ring2!.material as THREE.MeshBasicMaterial).color.setHSL(((h + 25) % 360) / 360, 0.4, 0.88);
    } else if (k === 'wormhole') {
      (E.mesh!.material as THREE.MeshBasicMaterial).color.setHSL(hn, 0.7, 0.62);
      (E.mesh2!.material as THREE.MeshBasicMaterial).color.setHSL(((h + 40) % 360) / 360, 0.6, 0.75);
    } else if (k === 'meteor') E.baseCol.setHSL(hn, 0.9, 0.72);
    if (E.comp) (E.comp.material as THREE.MeshBasicMaterial).color.setHSL(((h + 25) % 360) / 360, 0.7, 0.82);
    E.lbl.style.color = `hsl(${Math.round(h)} 80% 78%)`;
  }

  private buildGhosts(E: Entry): void {
    for (const g of E.ghosts) {
      g.parent?.remove(g);
      const l = g.userData.line as THREE.LineLoop;
      l.geometry.dispose();
      (l.material as THREE.Material).dispose();
    }
    E.ghosts = [];
    const hist = E.d.history;
    for (let i = 0; i < hist.length - 1; i++) {
      const s = hist[i];
      const grp = new THREE.Group();
      grp.rotation.order = 'YXZ';
      grp.rotation.y = E.d.node;
      grp.rotation.x = s.incl;
      const geo = newLineGeo();
      ellipseInto(geo, E.d.a, s.e);
      const mat = new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.35, gapSize: 0.3, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false });
      mat.color.setHSL(s.hue / 360, 0.6, 0.7);
      const line = new THREE.LineLoop(geo, mat);
      line.computeLineDistances();
      line.frustumCulled = false;
      grp.add(line);
      grp.userData.line = line;
      grp.visible = false;
      E.holder.add(grp);
      E.ghosts.push(grp);
    }
  }

  private buildEntry(d: StarData): Entry {
    const E: Entry = {
      d,
      vis: 0,
      visT: 1,
      wob: 0,
      wph: rnd(0, TAU),
      M: rnd(0, TAU),
      n: 1.5 / Math.pow(d.a, 1.5),
      size: sizeOf(d),
      flash: 0,
      pHue: -999,
      cur: { e: d.e, incl: d.incl, hue: d.hue },
      tgt: { e: d.e, incl: d.incl, hue: d.hue },
      fade: [],
      ghosts: [],
      pivot: new THREE.Group(),
      body: new THREE.Object3D(),
      holder: this.scene,
      line: undefined as unknown as THREE.LineLoop,
      lbl: document.createElement('div'),
      baseCol: new THREE.Color(),
    };
    E.pivot.rotation.order = 'YXZ';
    E.pivot.rotation.y = d.node;
    E.pivot.rotation.x = d.incl;
    E.pivot.add(E.body);
    const parent = d.parentId ? this.entries.get(d.parentId) : undefined;
    E.holder = parent ? parent.body : this.scene;
    E.holder.add(E.pivot);
    E.line = new THREE.LineLoop(newLineGeo(), new THREE.LineBasicMaterial({ transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false }));
    E.line.frustumCulled = false;
    E.pivot.add(E.line);
    E.fade.push({ m: E.line.material as THREE.Material, o: 0.32 });
    this.buildMesh(E);
    E.lbl.className = 'lbl';
    E.lbl.textContent = d.word;
    this.labels.appendChild(E.lbl);
    ellipseInto(E.line.geometry, d.a, d.e);
    this.paint(E);
    this.buildGhosts(E);
    if (d.kind === 'wormhole' && d.linkId) {
      E.linkLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
        new THREE.LineBasicMaterial({ transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      E.linkLine.frustumCulled = false;
      this.scene.add(E.linkLine);
    }
    this.entries.set(d.id, E);
    return E;
  }

  private removeEntry(E: Entry): void {
    E.holder.remove(E.pivot);
    for (const g of E.ghosts) g.parent?.remove(g);
    E.pivot.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | undefined;
      mat?.dispose?.();
    });
    if (E.linkLine) {
      this.scene.remove(E.linkLine);
      E.linkLine.geometry.dispose();
    }
    E.lbl.remove();
    this.entries.delete(E.d.id);
  }

  private applyCutoff(): void {
    for (const E of this.entries.values()) {
      const d = E.d;
      let s = d.history[0] ?? { t: d.created, e: d.e, incl: d.incl, hue: d.hue };
      for (const hh of d.history) {
        if (hh.t <= this.cutoff) s = hh;
        else break;
      }
      E.visT = d.created <= this.cutoff ? 1 : 0;
      E.tgt.e = s.e;
      E.tgt.incl = s.incl;
      E.tgt.hue = s.hue;
    }
  }

  private stepEntry(E: Entry, dt: number, t: number): void {
    const k = 1 - Math.exp(-dt * 2.4);
    let dirty = false;
    const de = E.tgt.e - E.cur.e;
    const di = E.tgt.incl - E.cur.incl;
    if (Math.abs(de) > 1e-4 || Math.abs(di) > 1e-4) {
      E.cur.e += de * k;
      E.cur.incl += di * k;
      dirty = true;
    }
    if (hueDist(E.tgt.hue, E.cur.hue) > 0.2) E.cur.hue = hueLerp(E.cur.hue, E.tgt.hue, k);
    E.vis += (E.visT - E.vis) * (1 - Math.exp(-dt * 3));
    E.flash = Math.max(0, E.flash - dt * 0.7);
    E.wob = Math.max(0, E.wob - dt * 0.1);
    E.M += E.n * dt;
    const show = E.vis > 0.01;
    E.pivot.visible = show;
    for (const g of E.ghosts) g.visible = this.ghostsOn && E.vis > 0.3;
    if (!show) return;
    const eEff = clamp(E.cur.e + Math.sin(t * 2.3 + E.wph) * 0.07 * E.wob, 0, 0.93);
    E.pivot.rotation.x = E.cur.incl + Math.sin(t * 3.1 + E.wph) * 0.12 * E.wob;
    if (dirty || E.wob > 0.001) ellipseInto(E.line.geometry, E.d.a, eEff);
    if (hueDist(E.cur.hue, E.pHue) > 0.5) this.paint(E);
    orbitPos(E.d.a, eEff, E.M, E.body.position);
    const pulse = 1 + (this.reduce ? 0.02 : 0.06) * Math.sin(t * 2.2 + E.wph);
    const s = E.size * (0.35 + 0.65 * E.vis) * pulse;
    E.mesh?.scale.setScalar(s);
    if (E.ring && E.ring2) {
      E.ring.scale.setScalar(s);
      E.ring2.scale.setScalar(s);
      E.ring.rotation.z += dt * 0.6;
      E.ring2.rotation.z -= dt * 0.9;
    }
    if (E.d.kind === 'wormhole' && E.mesh && E.mesh2) {
      E.mesh.rotation.x += dt * 0.8;
      E.mesh2.rotation.y += dt * 1.1;
      E.mesh2.scale.setScalar(s);
    }
    if (E.glowS) {
      const g = GLOWK[E.d.kind] * E.size * (1 + E.flash * 1.6) * pulse;
      E.glowS.scale.set(g, g, 1);
    }
    if (E.comp) {
      const r = E.size * 2.3;
      const ang = t * 1.9 + E.wph;
      E.comp.position.set(Math.cos(ang) * r, Math.sin(ang * 0.7) * r * 0.25, Math.sin(ang) * r);
      E.comp.scale.setScalar(s * 0.45);
    }
    if (E.pts) {
      const pa = E.pts.geometry.attributes.position.array as Float32Array;
      const ca = E.pts.geometry.attributes.color.array as Float32Array;
      const bc = E.baseCol;
      for (let i = 0; i < MN; i++) {
        orbitPos(E.d.a, eEff, E.M - i * 0.045, this.tmp);
        pa[i * 3] = this.tmp.x;
        pa[i * 3 + 1] = this.tmp.y;
        pa[i * 3 + 2] = this.tmp.z;
        const f = Math.pow(1 - i / MN, 1.6) * E.vis;
        ca[i * 3] = bc.r * f;
        ca[i * 3 + 1] = bc.g * f;
        ca[i * 3 + 2] = bc.b * f;
      }
      E.pts.geometry.attributes.position.needsUpdate = true;
      E.pts.geometry.attributes.color.needsUpdate = true;
    }
    for (const f of E.fade) f.m.opacity = f.o * E.vis;
  }

  private postEntry(E: Entry, w: number, h: number): void {
    if (E.linkLine) {
      const other = E.d.linkId ? this.entries.get(E.d.linkId) : undefined;
      if (other && E.vis > 0.3 && other.vis > 0.3) {
        E.linkLine.visible = true;
        const p = E.linkLine.geometry.attributes.position.array as Float32Array;
        E.body.getWorldPosition(this.v3);
        p[0] = this.v3.x;
        p[1] = this.v3.y;
        p[2] = this.v3.z;
        other.body.getWorldPosition(this.v3);
        p[3] = this.v3.x;
        p[4] = this.v3.y;
        p[5] = this.v3.z;
        E.linkLine.geometry.attributes.position.needsUpdate = true;
        (E.linkLine.material as THREE.LineBasicMaterial).color.setHSL(E.cur.hue / 360, 0.7, 0.65);
      } else E.linkLine.visible = false;
    }
    this.placeLabel(E.lbl, E.body, E.vis, w, h, 16 + E.size * 10);
  }

  private placeLabel(el: HTMLElement, obj: THREE.Object3D, vis: number, w: number, h: number, dy: number): void {
    if (vis < 0.05) {
      el.style.opacity = '0';
      return;
    }
    obj.getWorldPosition(this.v3);
    this.v3.project(this.camera);
    if (this.v3.z > 1) {
      el.style.opacity = '0';
      return;
    }
    const x = (this.v3.x * 0.5 + 0.5) * w;
    const y = (-this.v3.y * 0.5 + 0.5) * h;
    el.style.transform = `translate(${x.toFixed(1)}px,${(y + dy).toFixed(1)}px) translateX(-50%)`;
    el.style.opacity = (0.9 * vis).toFixed(2);
  }

  private computeMood(): { hue: number; warm: number } {
    let sx = 0;
    let sy = 0;
    let w = 0;
    let warm = 0;
    const nowT = Date.now();
    for (const E of this.entries.values()) {
      if (E.visT < 0.5) continue;
      const d = E.d;
      const ref = isFinite(this.cutoff) ? this.cutoff : nowT;
      const age = Math.max(0, (ref - d.created) / DAY);
      const ww = d.intensity * (0.3 + 0.7 * Math.exp(-age / 12)) * (d.kind === 'blackhole' ? 0.5 : 1);
      const hh = E.tgt.hue;
      sx += Math.cos((hh * Math.PI) / 180) * ww;
      sy += Math.sin((hh * Math.PI) / 180) * ww;
      w += ww;
      if (hh >= 330 || hh <= 75) warm += ww;
    }
    if (w <= 0) return { hue: 258, warm: 0.3 };
    return { hue: ((Math.atan2(sy, sx) * 180) / Math.PI + 360) % 360, warm: warm / w };
  }

  /* ------------------------------ visitor + fx --------------------------- */

  private addRing(pos: THREE.Vector3, hue: number, delay: number): void {
    const m = new THREE.Mesh(
      this.ringGeo,
      new THREE.MeshBasicMaterial({ color: hsl(hue, 0.8, 0.65), transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    m.rotation.x = Math.PI / 2;
    m.position.copy(pos);
    this.scene.add(m);
    this.rings.push({ m, t: -delay });
  }

  private addLink(A: THREE.Object3D, B: Entry, hue: number): void {
    const l = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: hsl(hue, 0.8, 0.7), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    l.frustumCulled = false;
    this.scene.add(l);
    this.links.push({ l, A, B, t: 0 });
  }

  private stepGuest(dt: number, now: number): void {
    const g = this.guest;
    if (!g) return;
    const k = 1 - Math.exp(-dt * (g.state === 'leaving' ? 0.5 : 0.35));
    g.a += (g.aT - g.a) * k;
    g.vis += (g.visT - g.vis) * (1 - Math.exp(-dt * (g.visT ? 1.2 : 1.6)));
    g.M += (1.5 / Math.pow(g.a, 1.5)) * dt;
    ellipseInto(g.geo, g.a, g.ecc);
    orbitPos(g.a, g.ecc, g.M, g.body.position);
    (g.line.material as THREE.LineBasicMaterial).opacity = 0.5 * g.vis;
    (g.mesh.material as THREE.MeshBasicMaterial).opacity = g.vis;
    g.glow.material.opacity = 0.8 * g.vis;
    g.comps.forEach((c, i) => {
      const an = now / 700 + i * 2.4;
      c.position.set(Math.cos(an) * 1.1, Math.sin(an * 0.8) * 0.3, Math.sin(an) * 1.1);
      (c.material as THREE.MeshBasicMaterial).opacity = g.vis;
    });
    if (g.state === 'crossed' && now - g.crossedAt > 22000) this.dismissVisitor();
    if (g.state === 'leaving' && g.vis < 0.02) {
      this.scene.remove(g.pivot);
      g.pivot.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        (m.material as THREE.Material | undefined)?.dispose?.();
      });
      g.lbl.remove();
      this.guest = null;
    }
  }

  private stepFx(dt: number): void {
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.t += dt;
      if (r.t < 0) continue;
      const p = r.t / 2.6;
      if (p >= 1) {
        this.scene.remove(r.m);
        (r.m.material as THREE.Material).dispose();
        this.rings.splice(i, 1);
        continue;
      }
      r.m.scale.setScalar(0.5 + p * 13);
      (r.m.material as THREE.MeshBasicMaterial).opacity = (1 - p) * 0.7;
    }
    for (let i = this.links.length - 1; i >= 0; i--) {
      const L = this.links[i];
      L.t += dt;
      if (L.t > 5 || !this.guest || !this.entries.has(L.B.d.id)) {
        this.scene.remove(L.l);
        L.l.geometry.dispose();
        (L.l.material as THREE.Material).dispose();
        this.links.splice(i, 1);
        continue;
      }
      const pa = L.l.geometry.attributes.position.array as Float32Array;
      L.A.getWorldPosition(this.v3);
      pa[0] = this.v3.x;
      pa[1] = this.v3.y;
      pa[2] = this.v3.z;
      L.B.body.getWorldPosition(this.v3);
      pa[3] = this.v3.x;
      pa[4] = this.v3.y;
      pa[5] = this.v3.z;
      L.l.geometry.attributes.position.needsUpdate = true;
      (L.l.material as THREE.LineBasicMaterial).opacity = Math.sin(Math.min(1, L.t / 5) * Math.PI) * 0.8;
    }
  }

  /* --------------------------------- loop -------------------------------- */

  private loop = (now: number): void => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.T += dt;
    const cam = this.cam;
    if (!this.reduce && now > cam.idleUntil) cam.yaw += dt * 0.04;
    this.nebula.rotation.y += dt * 0.004;
    this.moodAcc += dt;
    if (this.moodAcc > 0.5) {
      this.moodAcc = 0;
      this.moodT = this.computeMood();
      this.ev.onMood?.(this.moodT.hue, this.moodT.warm);
    }
    this.moodCur = hueLerp(this.moodCur, this.moodT.hue, 1 - Math.exp(-dt * 1.2));
    const hp = 1 + (this.reduce ? 0.02 : 0.07) * Math.sin(this.T * 1.7);
    this.heartCore.scale.setScalar(hp);
    (this.heartCore.material as THREE.MeshBasicMaterial).color.setHSL(this.moodCur / 360, 0.55, 0.8);
    this.heartG1.material.color.setHSL(this.moodCur / 360, 0.9, 0.6);
    this.heartG2.material.color.setHSL(this.moodCur / 360, 0.8, 0.45);
    this.heartG1.scale.setScalar(6 * hp);
    this.heartLight.color.setHSL(this.moodCur / 360, 0.6, 0.7);
    (this.nebula.material as THREE.PointsMaterial).color.setHSL(this.moodCur / 360, 0.5, 0.82);
    for (const E of this.entries.values()) this.stepEntry(E, dt, this.T);
    this.stepGuest(dt, now);
    this.stepFx(dt);
    const cp = Math.cos(cam.pitch);
    this.camera.position.set(Math.sin(cam.yaw) * cp * cam.dist, Math.sin(cam.pitch) * cam.dist, Math.cos(cam.yaw) * cp * cam.dist);
    this.camera.lookAt(0, 0, 0);
    this.scene.updateMatrixWorld();
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    for (const E of this.entries.values()) this.postEntry(E, w, h);
    if (this.guest) this.placeLabel(this.guest.lbl, this.guest.body, this.guest.vis, w, h, 18);
    this.placeLabel(this.heartLbl, this.heart, 1, w, h, 22);
    this.renderer.render(this.scene, this.camera);
  };
}
