import { ACCOUNT_RULES } from '@rune/shared';
import { useState, type FormEvent } from 'react';
import { api } from '../net/api.js';
import { useUi } from './store.js';
import { patternHint } from './validity.js';

export function Login() {
  const setSession = useUi((s) => s.setSession);
  const notice = useUi((s) => s.connectionError);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = mode === 'login' ? await api.login(username, password) : await api.register(username, password);
    setBusy(false);
    if (res.ok) setSession(res.data.token, res.data.username);
    else setError(res.error);
  };

  return (
    <main className="picker account">
      <h1>Allan's ARPG</h1>
      <p className="tagline">{mode === 'login' ? 'Log in to your account' : 'Create an account'}</p>
      {(error ?? notice) && <p className="error">{error ?? notice}</p>}
      <form className="account-form" onSubmit={(e) => void submit(e)}>
        <label>
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            name="username"
            autoComplete="username"
            maxLength={16}
            pattern={ACCOUNT_RULES.usernamePattern.source}
            {...patternHint('3 to 16 letters, digits or underscores')}
            required
            autoFocus
          />
        </label>
        <label>
          Password
          <input
            type="password"
            name="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            minLength={ACCOUNT_RULES.passwordMin}
            maxLength={ACCOUNT_RULES.passwordMax}
            required
          />
        </label>
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Please wait' : mode === 'login' ? 'Log in' : 'Create account'}
        </button>
      </form>
      <button
        type="button"
        className="guest-play"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          void api.guest().then((res) => {
            setBusy(false);
            if (res.ok) setSession(res.data.token, res.data.username);
            else setError(res.error);
          });
        }}
      >
        Play as guest
      </button>
      <p className="hint">
        {mode === 'login' ? 'No account yet? ' : 'Already have an account? '}
        <button
          type="button"
          className="link"
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login');
            setError(null);
          }}
        >
          {mode === 'login' ? 'Create one' : 'Log in'}
        </button>
      </p>
    </main>
  );
}
