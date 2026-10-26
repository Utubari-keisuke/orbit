import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { backend } from './lib/backend';
import { AuthScreen } from './AuthScreen';
import { Drawer } from './Drawer';
import { OrbitScene } from './engine/orbitScene';
import type { CrossLog, CrossResult, Kind, Profile, StarData, Visitor } from './types';
import { KINDS, KIND_ORDER, ago, hueName, makeSpec, preset } from './lib/util';

const APPROACH_MS = 45000;
const RESULT_LABEL: Record<CrossResult, string> = { resonance: '共鳴', interference: '干渉', fusion: '融合' };
const CHIPS = ['不安', '期待', '喜び', '孤独', 'あの人への想い', '怒り', '安心'];

type Encounter =
  | { phase: 'approach'; visitor: Visitor; key: number }
  | { phase: 'result'; visitor: Visitor; key: number; result: CrossResult | 'none'; text: string };

export function App() {
  const [user, setUser] = useState<{ email: string } | null | undefined>(undefined);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [stars, setStars] = useState<StarData[]>([]);
  const [crossings, setCrossings] = useState<CrossLog[]>([]);
  const [ready, setReady] = useState(false);
  const [loadErr, setLoadErr] = useState('');

  const [word, setWord] = useState('');
  const [kind, setKind] = useState<Kind>('planet');
  const [power, setPower] = useState(55);
  const [slider, setSlider] = useState(1000);
  const [ghosts, setGhosts] = useState(true);
  const [drawer, setDrawer] = useState(false);
  const [optsOpen, setOptsOpen] = useState(() => window.innerWidth > 700);
  const [toast, setToast] = useState('');
  const [mood, setMood] = useState({ hue: 258, warm: 0.3 });
  const [enc, setEnc] = useState<Encounter | null>(null);
  const [busy, setBusy] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<OrbitScene | null>(null);
  const toastTimer = useRef(0);
  const encTimer = useRef(0);
  const resultTimer = useRef(0);
  const nextAt = useRef(Date.now() + 9000);
  const seen = useRef<string[]>([]);
  const encRef = useRef<Encounter | null>(null);
  const starsRef = useRef<StarData[]>([]);
  const keyCounter = useRef(0);
  encRef.current = enc;
  starsRef.current = stars;

  const say = useCallback((m: string) => {
    setToast(m);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 4200);
  }, []);

  /* ---------- auth ---------- */
  useEffect(() => {
    let alive = true;
    const refresh = () =>
      backend.getUser().then((u) => {
        if (alive) setUser(u);
      });
    refresh();
    const off = backend.onAuthChange(refresh);
    return () => {
      alive = false;
      off();
    };
  }, []);

  /* ---------- load data ---------- */
  const email = user?.email;
  const loggedIn = !!user;
  useEffect(() => {
    if (!loggedIn) {
      setReady(false);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const p = await backend.ensureProfile();
        const [s, c] = await Promise.all([backend.loadStars(), backend.loadCrossings()]);
        if (!alive) return;
        setProfile(p);
        setStars(s);
        setCrossings(c);
        setReady(true);
      } catch (e) {
        console.error(e);
        if (alive) setLoadErr('データを読み込めませんでした。時間をおいて、ページを開き直してください。');
      }
    })();
    return () => {
      alive = false;
    };
  }, [loggedIn]);

  /* ---------- scene ---------- */
  useEffect(() => {
    if (!ready || !stageRef.current || !labelsRef.current) return;
    const scene = new OrbitScene(stageRef.current, labelsRef.current, {
      onMood: (hue, warm) => setMood({ hue, warm }),
    });
    sceneRef.current = scene;
    scene.setStars(starsRef.current);
    const dock = dockRef.current;
    const ro = new ResizeObserver(() => scene.setBottomInset(dock?.offsetHeight ?? 0));
    if (dock) ro.observe(dock);
    return () => {
      ro.disconnect();
      scene.dispose();
      sceneRef.current = null;
    };
  }, [ready]);

  useEffect(() => {
    sceneRef.current?.setGhosts(ghosts);
  }, [ghosts]);

  /* ---------- time slider ---------- */
  const cutoffMs = useMemo(() => {
    if (slider >= 995 || stars.length === 0) return null;
    const tMin = Math.min(...stars.map((s) => s.created));
    return tMin + ((Date.now() - tMin) * slider) / 1000;
  }, [slider, stars]);
  useEffect(() => {
    sceneRef.current?.setCutoff(cutoffMs);
  }, [cutoffMs]);

  /* ---------- encounters ---------- */
  const logCrossing = useCallback(async (entry: Omit<CrossLog, 'id' | 't'>) => {
    try {
      const saved = await backend.addCrossing(entry);
      setCrossings((c) => [saved, ...c].slice(0, 80));
    } catch (e) {
      console.error(e);
    }
  }, []);

  const spawn = useCallback(
    async (manual: boolean) => {
      const scene = sceneRef.current;
      if (!scene || scene.hasVisitor() || encRef.current) return;
      try {
        const v = await backend.nextVisitor(seen.current.slice(-6));
        if (!v || !sceneRef.current || sceneRef.current.hasVisitor()) {
          if (manual) say('いま、近くに別の軌道はありません。');
          nextAt.current = Date.now() + 60000;
          return;
        }
        seen.current.push(v.handle);
        scene.showVisitor(v);
        const key = ++keyCounter.current;
        setEnc({ phase: 'approach', visitor: v, key });
        window.clearTimeout(encTimer.current);
        encTimer.current = window.setTimeout(() => {
          const cur = encRef.current;
          if (cur && cur.key === key && cur.phase === 'approach') {
            sceneRef.current?.dismissVisitor();
            setEnc(null);
            nextAt.current = Date.now() + 45000;
            void logCrossing({ handle: v.handle, hue: v.stars[0]?.hue ?? 260, action: 'timeout', result: null, starWord: null, note: v.stars.map((s) => s.word).join('、') });
            say('その軌道は、静かに遠ざかっていきました。');
          }
        }, APPROACH_MS);
      } catch (e) {
        console.error(e);
        if (manual) say('他者の軌道を取得できませんでした。');
        nextAt.current = Date.now() + 60000;
      }
    },
    [logCrossing, say],
  );

  useEffect(() => {
    if (!ready || !profile?.isPublic) return;
    const id = window.setInterval(() => {
      if (!document.hidden && !encRef.current && Date.now() > nextAt.current) void spawn(false);
    }, 1500);
    return () => window.clearInterval(id);
  }, [ready, profile?.isPublic, spawn]);

  useEffect(
    () => () => {
      window.clearTimeout(encTimer.current);
      window.clearTimeout(resultTimer.current);
      window.clearTimeout(toastTimer.current);
    },
    [],
  );

  const endEncounter = () => {
    window.clearTimeout(encTimer.current);
    window.clearTimeout(resultTimer.current);
    sceneRef.current?.dismissVisitor();
    setEnc(null);
    nextAt.current = Date.now() + 45000 + Math.random() * 35000;
  };

  const avoid = () => {
    const cur = enc;
    if (!cur || cur.phase !== 'approach') return;
    void logCrossing({ handle: cur.visitor.handle, hue: cur.visitor.stars[0]?.hue ?? 260, action: 'avoid', result: null, starWord: null, note: cur.visitor.stars.map((s) => s.word).join('、') });
    endEncounter();
    say('回避しました。軌道は視界の外へ流れていきます。');
  };

  const reportVisitor = async () => {
    const cur = enc;
    if (!cur) return;
    try {
      await backend.report(cur.visitor.handle, 'ユーザーによる通報');
      say('通報しました。この軌道は、もう近づきません。');
    } catch (e) {
      console.error(e);
      say('通報を送れませんでした。時間をおいて、もう一度試してください。');
    }
    endEncounter();
  };

  const cross = async () => {
    const cur = enc;
    const scene = sceneRef.current;
    if (!cur || cur.phase !== 'approach' || !scene) return;
    window.clearTimeout(encTimer.current);
    const plan = scene.cross();
    if (!plan) return;
    const vh = cur.visitor.stars[0]?.hue ?? 260;
    let text: string;
    if (!plan.target || !plan.next) {
      text = 'まだ星のないあなたの宇宙に、他者の光だけが静かに差し込みました。';
    } else {
      const w = `「${plan.target.word}」`;
      text =
        plan.type === 'resonance'
          ? `${w}と色が近く、軌道が静かに寄り添いました。`
          : plan.type === 'interference'
            ? `${w}の軌道が、反対の色に大きく揺さぶられました。`
            : `${w}の色に、誰かの光が混ざりました。`;
      const updated: StarData = { ...plan.target, ...plan.next, history: [...plan.target.history, { t: Date.now(), ...plan.next }] };
      setStars((all) => all.map((s) => (s.id === updated.id ? updated : s)));
      scene.updateStar(updated);
      backend.updateStar(updated).catch((e) => {
        console.error(e);
        say('軌道の変化を保存できませんでした。');
      });
    }
    void logCrossing({ handle: cur.visitor.handle, hue: vh, action: 'cross', result: plan.type, starWord: plan.target?.word ?? null, note: text });
    setEnc({ phase: 'result', visitor: cur.visitor, key: cur.key, result: plan.type, text });
    window.clearTimeout(resultTimer.current);
    resultTimer.current = window.setTimeout(() => {
      setEnc((e) => (e && e.key === cur.key ? null : e));
      nextAt.current = Date.now() + 45000 + Math.random() * 35000;
    }, 9000);
  };

  /* ---------- stars ---------- */
  const addStar = async (e: FormEvent) => {
    e.preventDefault();
    const w = word.trim();
    if (!w) {
      say('まず、いまの気持ちを言葉にしてみてください。');
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      const spec = makeSpec(w, kind, power / 100, stars);
      const saved = await backend.insertStar(spec);
      setStars((s) => [...s, saved]);
      sceneRef.current?.addStar(saved);
      setSlider(1000);
      setWord('');
      let msg = `「${w}」が${KINDS[kind].label}になりました。`;
      if (saved.binary) msg = `「${w}」は、二つで一つの星になりました。`;
      const linked = saved.linkId ? stars.find((s) => s.id === saved.linkId) : undefined;
      if (linked) msg += `「${linked.word}」と繋がっています。`;
      say(msg);
    } catch (err) {
      console.error(err);
      say('星を保存できませんでした。通信を確かめて、もう一度試してください。');
    } finally {
      setBusy(false);
    }
  };

  const deleteStar = async (id: string) => {
    try {
      await backend.deleteStar(id);
    } catch (e) {
      console.error(e);
      say('削除できませんでした。');
      return;
    }
    const ids = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const s of starsRef.current) {
        if (s.parentId && ids.has(s.parentId) && !ids.has(s.id)) {
          ids.add(s.id);
          grew = true;
        }
      }
    }
    sceneRef.current?.removeStar(id);
    setStars((all) => all.filter((s) => !ids.has(s.id)).map((s) => (s.linkId && ids.has(s.linkId) ? { ...s, linkId: null } : s)));
  };

  const wipe = async () => {
    try {
      await backend.wipe();
    } catch (e) {
      console.error(e);
      say('削除できませんでした。');
      return;
    }
    setStars([]);
    setCrossings([]);
    sceneRef.current?.setStars([]);
    setSlider(1000);
    say('空の宇宙になりました。ここから、また始められます。');
  };

  const togglePublic = async () => {
    if (!profile) return;
    const next = !profile.isPublic;
    try {
      await backend.setPublic(next);
    } catch (e) {
      console.error(e);
      say('設定を変えられませんでした。');
      return;
    }
    setProfile({ ...profile, isPublic: next });
    if (!next) {
      if (enc) endEncounter();
      say('非公開にしました。誰の重力もこの宇宙を横切りません。あなたの星も、他者には見えません。');
    } else {
      nextAt.current = Date.now() + 8000;
      say('公開に戻しました。いつか誰かの重力が視界を横切ります。');
    }
  };

  /* ---------- render ---------- */
  if (user === undefined) return <div className="loading">ORBIT</div>;
  if (user === null) return <AuthScreen />;
  if (loadErr) return <div className="loading">{loadErr}</div>;
  if (!ready || !profile) return <div className="loading">ORBIT</div>;

  const temp = 20 + 16 * mood.warm;
  const timeLabel = cutoffMs === null ? 'いま' : `${ago(cutoffMs)}の自分`;
  const approach = enc?.phase === 'approach' ? enc : null;

  return (
    <>
      <div id="stage" ref={stageRef} />
      <div id="labels" ref={labelsRef} />
      <div id="ui">
        <header id="top">
          <div className="brand">
            <h1>Orbit</h1>
            <p className="sub">感情が軌道になる、わたしの宇宙</p>
            <p className="mood">
              <span>心の温度</span>
              <b>{temp.toFixed(1)}°</b>
              <i>{hueName(mood.hue)}</i>
            </p>
            {stars.length === 0 && <p className="intro">声も名前もない場所。言葉を与えると、感情が星になって回りはじめます。ドラッグで回転、ホイールかピンチで拡大。</p>}
          </div>
          <nav className="tools" aria-label="操作">
            <button className="btn" type="button" onClick={() => (profile.isPublic ? void spawn(true) : say('非公開の間は、誰の軌道も近づきません。'))}>
              探す
            </button>
            <button className="btn" type="button" aria-pressed={!profile.isPublic} onClick={togglePublic}>
              非公開
            </button>
            <button className="btn" type="button" aria-pressed={ghosts} onClick={() => setGhosts((g) => !g)}>
              残光
            </button>
            <button className="btn" type="button" onClick={() => setDrawer(true)}>
              星図
            </button>
          </nav>
        </header>

        {enc && (
          <section id="card" aria-live="polite">
            <p className="tag">
              <span>Orbit {enc.visitor.handle}</span>
            </p>
            <h2>誰かのOrbitが視界に入りました</h2>
            <ul className="words">
              {enc.visitor.stars.map((s, i) => (
                <li key={i}>
                  <span className="dot" style={{ ['--h' as string]: s.hue }} />
                  {s.word}
                </li>
              ))}
            </ul>
            {approach ? (
              <>
                <div className="btns">
                  <button className="btn primary" type="button" onClick={cross}>
                    交差する
                  </button>
                  <button className="btn" type="button" onClick={avoid}>
                    回避する
                  </button>
                </div>
                <div className="bar">
                  <i key={approach.key} />
                </div>
              </>
            ) : (
              enc.phase === 'result' && (
                <p className="result">
                  <b className={enc.result === 'none' ? '' : enc.result}>{enc.result === 'none' ? '' : RESULT_LABEL[enc.result]}</b>
                  {enc.text}
                </p>
              )
            )}
            {backend.mode === 'supabase' && (
              <div className="cardbtns2">
                <button className="btn" type="button" onClick={reportVisitor}>
                  通報して避ける
                </button>
              </div>
            )}
          </section>
        )}

        <div id="toast" className={toast ? 'on' : ''} role="status">
          {toast}
        </div>

        <div id="dock">
          <div className="dockin" ref={dockRef}>
            <div className="chips" aria-label="よくある気持ち">
              {CHIPS.map((c) => (
                <button key={c} type="button" className="chip" onClick={() => setWord(c)}>
                  <span className="dot" style={{ ['--h' as string]: preset(c).hue }} />
                  {c}
                </button>
              ))}
            </div>
            <form id="f" autoComplete="off" onSubmit={addStar}>
              <input id="word" name="word" maxLength={24} placeholder="いまの気持ちに言葉を与える" aria-label="気持ちの言葉" value={word} onChange={(e) => setWord(e.target.value)} />
              <button className="btn primary" type="submit" disabled={busy}>
                星にする
              </button>
            </form>
            <details className="opts" open={optsOpen} onToggle={(e) => setOptsOpen((e.currentTarget as HTMLDetailsElement).open)}>
              <summary>かたち・強さ・時間</summary>
              <div className="inner">
                <div className="kinds" role="group" aria-label="天体のかたち">
                  {KIND_ORDER.map((k) => (
                    <button key={k} type="button" className="btn" aria-pressed={kind === k} onClick={() => setKind(k)}>
                      {KINDS[k].label}
                    </button>
                  ))}
                </div>
                <p className="hint">{KINDS[kind].hint}</p>
                <div className="sliders">
                  <label>
                    強さ <input type="range" min={10} max={100} value={power} onChange={(e) => setPower(+e.target.value)} aria-label="気持ちの強さ" />
                  </label>
                  <label className="grow">
                    時間 <input type="range" min={0} max={1000} value={slider} onChange={(e) => setSlider(+e.target.value)} aria-label="過去にさかのぼる" />
                    <output>{timeLabel}</output>
                  </label>
                </div>
              </div>
            </details>
          </div>
        </div>

        <Drawer
          open={drawer}
          stars={stars}
          crossings={crossings}
          handle={profile.handle}
          email={email ?? ''}
          mode={backend.mode}
          onClose={() => setDrawer(false)}
          onDelete={deleteStar}
          onWipe={wipe}
          onSignOut={() => void backend.signOut()}
        />
      </div>
    </>
  );
}
