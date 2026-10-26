import { useState, type FormEvent } from 'react';
import { backend } from './lib/backend';

export function AuthScreen() {
  const [email, setEmail] = useState('');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr('');
    if (!agree) {
      setErr('下の内容に同意すると、ログインできます。');
      return;
    }
    setBusy(true);
    try {
      await backend.signInWithEmail(email.trim());
      setSent(true);
    } catch (x) {
      setErr('メールを送れませんでした。アドレスを確かめて、もう一度試してください。');
      console.error(x);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="box">
        <h1>Orbit</h1>
        <p>感情が軌道になる、わたしの宇宙。続けるには、メールアドレスでログインしてください。パスワードは要りません。</p>
        {sent ? (
          <p className="ok" role="status">
            {email} にログイン用のリンクを送りました。メールを開いてリンクを押してください。
          </p>
        ) : (
          <form onSubmit={submit}>
            <label htmlFor="email" style={{ display: 'none' }}>
              メールアドレス
            </label>
            <input id="email" type="email" required autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <label className="consent">
              <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
              <span>
                公開中は、あなたの星の言葉と色が、匿名の番号（例 #4821）で他のユーザーに表示されることに同意します。メールアドレスは表示されません。ブラックホールの星は共有されません。非公開にすれば、いつでも止められます。
              </span>
            </label>
            {err && (
              <div className="err" role="alert">
                {err}
              </div>
            )}
            <button className="btn primary" type="submit" disabled={busy}>
              {busy ? '送信中…' : 'ログイン用リンクを送る'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
