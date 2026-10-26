import { useEffect, useMemo, useRef, useState } from 'react';
import type { CrossLog, StarData } from './types';
import { KINDS, ago } from './lib/util';

const RESULT_NAME: Record<string, string> = { resonance: '共鳴', interference: '干渉', fusion: '融合' };

function Armed({ label, armedLabel, onGo, danger = false }: { label: string; armedLabel: string; onGo: () => void; danger?: boolean }) {
  const [armed, setArmed] = useState(false);
  const tm = useRef(0);
  useEffect(() => () => window.clearTimeout(tm.current), []);
  return (
    <button
      type="button"
      className={'btn' + (armed || danger ? ' danger' : '')}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          tm.current = window.setTimeout(() => setArmed(false), 3200);
        } else {
          window.clearTimeout(tm.current);
          setArmed(false);
          onGo();
        }
      }}
    >
      {armed ? armedLabel : label}
    </button>
  );
}

interface Props {
  open: boolean;
  stars: StarData[];
  crossings: CrossLog[];
  handle: string;
  email: string;
  mode: 'supabase' | 'local';
  onClose: () => void;
  onDelete: (id: string) => void;
  onWipe: () => void;
  onSignOut: () => void;
}

export function Drawer({ open, stars, crossings, handle, email, mode, onClose, onDelete, onWipe, onSignOut }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [open, onClose]);

  const items = useMemo(() => {
    const a: { t: number; star?: StarData; log?: CrossLog }[] = [];
    stars.forEach((s) => a.push({ t: s.created, star: s }));
    crossings.forEach((l) => a.push({ t: l.t, log: l }));
    return a.sort((x, y) => y.t - x.t);
  }, [stars, crossings]);
  const crossCount = crossings.filter((c) => c.action === 'cross').length;

  return (
    <aside id="drawer" className={open ? 'open' : ''} aria-label="星図のログ" aria-hidden={!open}>
      <header>
        <h2>星図のログ</h2>
        <button ref={closeRef} className="btn" type="button" onClick={onClose}>
          閉じる
        </button>
      </header>
      <div id="counts">
        星 {stars.length} ・ 交差 {crossCount}
      </div>
      <ul id="logList">
        {items.length === 0 && <li className="empty">まだ何もありません。言葉を与えると、最初の星が生まれます。</li>}
        {items.map((it) =>
          it.star ? (
            <li key={'s' + it.star.id}>
              <span className="dot" style={{ ['--h' as string]: it.star.hue }} />
              <div className="meta">
                <div className="t">{it.star.word}</div>
                <div className="s">
                  {KINDS[it.star.kind].label} ・ {ago(it.star.created)}
                  {it.star.history.length > 1 ? ` ・ 軌道の変化 ${it.star.history.length - 1}回` : ''}
                </div>
              </div>
              <Armed label="削除" armedLabel="本当に削除" onGo={() => onDelete(it.star!.id)} />
            </li>
          ) : (
            <li key={'c' + it.log!.id}>
              <span className="dot" style={{ ['--h' as string]: it.log!.hue }} />
              <div className="meta">
                <div className="t">
                  Orbit {it.log!.handle}
                  {it.log!.action === 'cross' ? ` と${RESULT_NAME[it.log!.result ?? 'fusion']}` : it.log!.action === 'avoid' ? ' を回避' : ' を見送り'}
                </div>
                <div className="s">
                  {ago(it.log!.t)}
                  {it.log!.note ? ` ・ ${it.log!.note}` : ''}
                </div>
              </div>
            </li>
          ),
        )}
      </ul>
      <footer>
        <p className="who">
          {mode === 'supabase' ? `あなたの番号 ${handle} ・ ${email}` : 'ローカルモード（この端末のみ。他者はデモ用の仮想データ）'}
        </p>
        <p>他のユーザーには、あなたの番号と、星の言葉・色だけが見えます。メールアドレスと、ブラックホールの星は見えません。</p>
        <Armed label="星とログをすべて消す" armedLabel="本当にすべて消す" onGo={onWipe} />
        {mode === 'supabase' && (
          <button className="btn" type="button" onClick={onSignOut}>
            ログアウト
          </button>
        )}
      </footer>
    </aside>
  );
}
