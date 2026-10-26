export type Kind = 'star' | 'planet' | 'satellite' | 'meteor' | 'blackhole' | 'wormhole';

export interface Snapshot {
  t: number; // epoch ms
  e: number;
  incl: number;
  hue: number;
}

export interface StarData {
  id: string;
  word: string;
  kind: Kind;
  hue: number;
  e: number;
  incl: number;
  node: number;
  a: number;
  intensity: number;
  binary: boolean;
  parentId: string | null;
  linkId: string | null;
  history: Snapshot[];
  created: number; // epoch ms
}

export interface VisitorStar {
  word: string;
  hue: number;
}

export interface Visitor {
  handle: string;
  stars: VisitorStar[];
}

export type CrossAction = 'cross' | 'avoid' | 'timeout';
export type CrossResult = 'resonance' | 'interference' | 'fusion';

export interface CrossLog {
  id: string;
  t: number;
  handle: string;
  hue: number;
  action: CrossAction;
  result: CrossResult | null;
  starWord: string | null;
  note: string | null;
}

export interface Profile {
  handle: string;
  isPublic: boolean;
}
