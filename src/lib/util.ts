import type { Kind, StarData } from '../types';

export const TAU = Math.PI * 2;
export const DAY = 864e5;
export const HOUR = 36e5;

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const rnd = (a: number, b: number) => a + Math.random() * (b - a);

export const hueDist = (a: number, b: number) => {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
};
export const hueLerp = (a: number, b: number, k: number) => {
  const d = ((b - a + 540) % 360) - 180;
  return (a + d * k + 360) % 360;
};

export const KINDS: Record<Kind, { label: string; hint: string }> = {
  star: { label: '恒星', hint: '強い想い、核心的な発想。中心の近くで強く光ります。' },
  planet: { label: '惑星', hint: '思考のまとまり、テーマ。' },
  satellite: { label: '衛星', hint: '細かい感情の揺れ。直前に置いた恒星か惑星のまわりを回ります。' },
  meteor: { label: '流星群', hint: '一時的な衝動や、外からの刺激。細長い軌道を横切ります。' },
  blackhole: { label: 'ブラックホール', hint: '重すぎる感情や記憶、沈黙。他者には共有されません。' },
  wormhole: { label: 'ワームホール', hint: '予期せぬ繋がり。過去に置いた星のどれかと線で結ばれます。' },
};
export const KIND_ORDER: Kind[] = ['star', 'planet', 'satellite', 'meteor', 'blackhole', 'wormhole'];

interface Preset {
  k?: string;
  hue: number;
  e: number;
  binary?: boolean;
}
const PRESETS: Preset[] = [
  { k: '不安', hue: 272, e: 0.34, binary: true },
  { k: '期待', hue: 208, e: 0.74 },
  { k: '喜', hue: 46, e: 0.18 },
  { k: '嬉', hue: 46, e: 0.18 },
  { k: '怒', hue: 6, e: 0.5 },
  { k: '悲', hue: 226, e: 0.22 },
  { k: '孤独', hue: 242, e: 0.12 },
  { k: '寂', hue: 238, e: 0.14 },
  { k: 'あの人', hue: 322, e: 0.08, binary: true },
  { k: '好き', hue: 334, e: 0.16, binary: true },
  { k: '愛', hue: 340, e: 0.14, binary: true },
  { k: '安心', hue: 162, e: 0.1 },
  { k: '希望', hue: 188, e: 0.3 },
  { k: '恐', hue: 288, e: 0.46 },
  { k: '疲', hue: 215, e: 0.1 },
  { k: '嫉妬', hue: 132, e: 0.4 },
  { k: '感謝', hue: 52, e: 0.12 },
];

export function hashHue(s: string): number {
  let h = 7;
  for (const c of s) h = (h * 31 + (c.codePointAt(0) ?? 0)) >>> 0;
  return h % 360;
}

export function preset(word: string): { hue: number; e: number; binary: boolean } {
  for (const p of PRESETS) if (p.k && word.includes(p.k)) return { hue: p.hue, e: p.e, binary: !!p.binary };
  return { hue: hashHue(word), e: 0.15 + (hashHue(word + 'e') % 40) / 100, binary: false };
}

export function hueName(h: number): string {
  if (h < 20 || h >= 345) return '赤';
  if (h < 65) return '橙';
  if (h < 160) return '緑';
  if (h < 200) return '青緑';
  if (h < 250) return '青';
  if (h < 300) return '紫';
  return '桃';
}

export function ago(t: number): string {
  const d = Math.max(0, Date.now() - t);
  if (d < 6e4) return 'たった今';
  if (d < HOUR) return Math.floor(d / 6e4) + '分前';
  if (d < DAY) return Math.floor(d / HOUR) + '時間前';
  if (d < DAY * 30) return Math.floor(d / DAY) + '日前';
  return Math.floor(d / (DAY * 30)) + 'か月前';
}

/** 言葉・かたち・強さから、新しい星のパラメータを作る(idはDB保存時に付く)。 */
export function makeSpec(
  word: string,
  kind: Kind,
  intensity: number,
  existing: StarData[],
): Omit<StarData, 'id'> {
  const p = preset(word);
  let parentId: string | null = null;
  if (kind === 'satellite') {
    const c = existing.filter((s) => s.kind === 'star' || s.kind === 'planet');
    if (c.length) parentId = c[c.length - 1].id;
  }
  let a: number;
  let e: number;
  switch (kind) {
    case 'star':
      a = rnd(3.2, 5);
      e = clamp(p.e, 0.05, 0.4);
      break;
    case 'planet':
      e = p.e;
      a = e > 0.5 ? rnd(5.5, 8) : rnd(5.8, 11.5);
      break;
    case 'satellite':
      a = parentId ? rnd(1.9, 2.8) : rnd(2.2, 3.2);
      e = 0.12;
      break;
    case 'meteor':
      a = rnd(8.5, 13);
      e = rnd(0.84, 0.9);
      break;
    case 'blackhole':
      a = rnd(7, 11);
      e = rnd(0.06, 0.2);
      break;
    default:
      a = rnd(9.5, 13.5);
      e = rnd(0.15, 0.35);
  }
  const incl = kind === 'satellite' ? rnd(-0.9, 0.9) : rnd(-0.55, 0.55);
  const now = Date.now();
  let linkId: string | null = null;
  if (kind === 'wormhole') {
    const c = existing.filter((s) => s.kind !== 'wormhole');
    if (c.length) linkId = c[Math.floor(Math.random() * c.length)].id;
  }
  return {
    word,
    kind,
    hue: p.hue,
    e,
    incl,
    node: rnd(0, TAU),
    a,
    intensity,
    binary: p.binary && (kind === 'star' || kind === 'planet'),
    parentId,
    linkId,
    history: [{ t: now, e, incl, hue: p.hue }],
    created: now,
  };
}
