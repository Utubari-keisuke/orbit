import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { CrossLog, Profile, StarData, Visitor } from '../types';

export interface Backend {
  mode: 'supabase' | 'local';
  /** ログイン中のユーザー。未ログインなら null。 */
  getUser(): Promise<{ email: string } | null>;
  onAuthChange(cb: () => void): () => void;
  signInWithEmail(email: string): Promise<void>;
  signOut(): Promise<void>;
  ensureProfile(): Promise<Profile>;
  setPublic(isPublic: boolean): Promise<void>;
  loadStars(): Promise<StarData[]>;
  insertStar(spec: Omit<StarData, 'id'>): Promise<StarData>;
  updateStar(star: StarData): Promise<void>;
  deleteStar(id: string): Promise<void>;
  loadCrossings(): Promise<CrossLog[]>;
  addCrossing(log: Omit<CrossLog, 'id' | 't'>): Promise<CrossLog>;
  nextVisitor(excludeHandles: string[]): Promise<Visitor | null>;
  report(handle: string, reason: string): Promise<void>;
  wipe(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Supabase                                                            */
/* ------------------------------------------------------------------ */

interface StarRow {
  id: string;
  word: string;
  kind: StarData['kind'];
  hue: number;
  e: number;
  incl: number;
  node: number;
  a: number;
  intensity: number;
  is_binary: boolean;
  parent_id: string | null;
  link_id: string | null;
  history: StarData['history'];
  created_at: string;
}
interface CrossRow {
  id: string;
  other_handle: string;
  other_hue: number;
  action: CrossLog['action'];
  result: CrossLog['result'];
  star_word: string | null;
  note: string | null;
  created_at: string;
}

const fromStarRow = (r: StarRow): StarData => ({
  id: r.id,
  word: r.word,
  kind: r.kind,
  hue: r.hue,
  e: r.e,
  incl: r.incl,
  node: r.node,
  a: r.a,
  intensity: r.intensity,
  binary: r.is_binary,
  parentId: r.parent_id,
  linkId: r.link_id,
  history: Array.isArray(r.history) ? r.history : [],
  created: new Date(r.created_at).getTime(),
});
const fromCrossRow = (r: CrossRow): CrossLog => ({
  id: r.id,
  t: new Date(r.created_at).getTime(),
  handle: r.other_handle,
  hue: r.other_hue,
  action: r.action,
  result: r.result,
  starWord: r.star_word,
  note: r.note,
});

function fail(e: { message: string } | null): void {
  if (e) throw new Error(e.message);
}

function supabaseBackend(sb: SupabaseClient): Backend {
  const uid = async (): Promise<string> => {
    const { data } = await sb.auth.getUser();
    if (!data.user) throw new Error('ログインが必要です');
    return data.user.id;
  };
  return {
    mode: 'supabase',
    async getUser() {
      const { data } = await sb.auth.getSession();
      const u = data.session?.user;
      return u ? { email: u.email ?? '' } : null;
    },
    onAuthChange(cb) {
      const { data } = sb.auth.onAuthStateChange(() => cb());
      return () => data.subscription.unsubscribe();
    },
    async signInWithEmail(email) {
      const { error } = await sb.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.origin + window.location.pathname },
      });
      fail(error);
    },
    async signOut() {
      const { error } = await sb.auth.signOut();
      fail(error);
    },
    async ensureProfile() {
      const { data, error } = await sb.rpc('ensure_profile');
      fail(error);
      const p = data as { handle: string; is_public: boolean };
      return { handle: p.handle, isPublic: p.is_public };
    },
    async setPublic(isPublic) {
      const { error } = await sb.from('profiles').update({ is_public: isPublic }).eq('user_id', await uid());
      fail(error);
    },
    async loadStars() {
      const { data, error } = await sb.from('stars').select('*').order('created_at', { ascending: true });
      fail(error);
      return ((data ?? []) as StarRow[]).map(fromStarRow);
    },
    async insertStar(spec) {
      const { data, error } = await sb
        .from('stars')
        .insert({
          user_id: await uid(),
          word: spec.word,
          kind: spec.kind,
          hue: spec.hue,
          e: spec.e,
          incl: spec.incl,
          node: spec.node,
          a: spec.a,
          intensity: spec.intensity,
          is_binary: spec.binary,
          parent_id: spec.parentId,
          link_id: spec.linkId,
          history: spec.history,
        })
        .select('*')
        .single();
      fail(error);
      return fromStarRow(data as StarRow);
    },
    async updateStar(s) {
      const { error } = await sb
        .from('stars')
        .update({ e: s.e, incl: s.incl, hue: s.hue, history: s.history })
        .eq('id', s.id);
      fail(error);
    },
    async deleteStar(id) {
      const { error } = await sb.from('stars').delete().eq('id', id);
      fail(error);
    },
    async loadCrossings() {
      const { data, error } = await sb
        .from('crossings')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(80);
      fail(error);
      return ((data ?? []) as CrossRow[]).map(fromCrossRow);
    },
    async addCrossing(log) {
      const { data, error } = await sb
        .from('crossings')
        .insert({
          user_id: await uid(),
          other_handle: log.handle,
          other_hue: log.hue,
          action: log.action,
          result: log.result,
          star_word: log.starWord,
          note: log.note,
        })
        .select('*')
        .single();
      fail(error);
      return fromCrossRow(data as CrossRow);
    },
    async nextVisitor(exclude) {
      const { data, error } = await sb.rpc('random_orbit', { exclude_handles: exclude });
      fail(error);
      return (data as Visitor | null) ?? null;
    },
    async report(handle, reason) {
      const { error } = await sb.from('reports').insert({ reporter_id: await uid(), other_handle: handle, reason });
      fail(error);
    },
    async wipe() {
      const { error } = await sb.rpc('wipe_my_data');
      fail(error);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Local (Supabase未設定のとき。ブラウザ内だけで動き、他者はデモ用の仮想データ) */
/* ------------------------------------------------------------------ */

const LS_KEY = 'orbit.local.v2';
interface LocalState {
  isPublic: boolean;
  stars: StarData[];
  crossings: CrossLog[];
}
const DEMO_VISITORS: Visitor[] = [
  { handle: '#4821', stars: [{ word: '眠れない夜', hue: 222 }, { word: '静けさ', hue: 250 }, { word: '海', hue: 195 }] },
  { handle: '#0377', stars: [{ word: '焦り', hue: 18 }, { word: 'コーヒー', hue: 32 }] },
  { handle: '#9150', stars: [{ word: 'ひとりの時間', hue: 268 }, { word: '期待', hue: 208 }] },
  { handle: '#2264', stars: [{ word: '怒りたくない', hue: 356 }, { word: '深呼吸', hue: 170 }] },
  { handle: '#7038', stars: [{ word: '懐かしさ', hue: 36 }, { word: '夕焼け', hue: 14 }, { word: '古い曲', hue: 300 }] },
  { handle: '#5512', stars: [{ word: '震え', hue: 190 }, { word: '好きな曲', hue: 330 }] },
];

function localBackend(): Backend {
  const read = (): LocalState => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) return JSON.parse(raw) as LocalState;
    } catch {
      /* ignore */
    }
    return { isPublic: true, stars: [], crossings: [] };
  };
  const write = (s: LocalState) => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(s));
    } catch {
      /* ignore */
    }
  };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now());
  return {
    mode: 'local',
    async getUser() {
      return { email: 'この端末のみ' };
    },
    onAuthChange() {
      return () => undefined;
    },
    async signInWithEmail() {
      /* no-op */
    },
    async signOut() {
      /* no-op */
    },
    async ensureProfile() {
      return { handle: '#0000', isPublic: read().isPublic };
    },
    async setPublic(isPublic) {
      const s = read();
      s.isPublic = isPublic;
      write(s);
    },
    async loadStars() {
      return read().stars;
    },
    async insertStar(spec) {
      const s = read();
      const star: StarData = { ...spec, id: uuid() };
      s.stars.push(star);
      write(s);
      return star;
    },
    async updateStar(star) {
      const s = read();
      s.stars = s.stars.map((x) => (x.id === star.id ? star : x));
      write(s);
    },
    async deleteStar(id) {
      const s = read();
      const ids = new Set([id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const x of s.stars) {
          if (x.parentId && ids.has(x.parentId) && !ids.has(x.id)) {
            ids.add(x.id);
            grew = true;
          }
        }
      }
      s.stars = s.stars.filter((x) => !ids.has(x.id)).map((x) => (x.linkId && ids.has(x.linkId) ? { ...x, linkId: null } : x));
      write(s);
    },
    async loadCrossings() {
      return read().crossings;
    },
    async addCrossing(log) {
      const s = read();
      const c: CrossLog = { ...log, id: uuid(), t: Date.now() };
      s.crossings.unshift(c);
      s.crossings.length = Math.min(s.crossings.length, 80);
      write(s);
      return c;
    },
    async nextVisitor(exclude) {
      const pool = DEMO_VISITORS.filter((v) => !exclude.includes(v.handle));
      const list = pool.length ? pool : DEMO_VISITORS;
      return list[Math.floor(Math.random() * list.length)];
    },
    async report() {
      /* no-op */
    },
    async wipe() {
      const s = read();
      s.stars = [];
      s.crossings = [];
      write(s);
    },
  };
}

/* ------------------------------------------------------------------ */

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const backend: Backend =
  url && key ? supabaseBackend(createClient(url, key, { auth: { persistSession: true, detectSessionInUrl: true } })) : localBackend();
