import { can, TOKEN_RULES, TOKEN_SCOPE_INFO, TOKEN_SCOPES, type AdminTokenInfo, type Role, type TokenScope } from '@rune/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { adminApi } from '../net/api.js';
import { searchId } from './tabs.js';

/**
 * Owner and admin: tokens for scripts and agents to call the admin API with. A token can do what
 * its scopes say and never more than its creator's role; the server enforces both. The full token
 * is shown once, right after it is made.
 */

const EXPIRY_CHOICES = [1, 7, 30, 90] as const;

function when(at: number | null): string {
  if (at === null) return 'never';
  return new Date(at).toLocaleString();
}

export function TokensTab({ token, role, notify }: { token: string; role: Role; notify: (t: string) => void }) {
  const [list, setList] = useState<AdminTokenInfo[] | null>(null);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ReadonlySet<TokenScope>>(new Set(['viewAdmin']));
  const [days, setDays] = useState<number>(30);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const offered = TOKEN_SCOPES.filter((s) => can(role, s));

  const load = useCallback(() => {
    void adminApi.tokens(token).then((r) => (r.ok ? setList(r.data) : notify(r.error)));
  }, [token, notify]);
  useEffect(load, [load]);

  const toggle = (s: TokenScope) => {
    if (s === 'viewAdmin') return;
    setScopes((cur) => {
      const next = new Set(cur);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const r = await adminApi.createToken(token, { name: name.trim(), scopes: offered.filter((s) => scopes.has(s)), days });
    setBusy(false);
    if (!r.ok) return notify(r.error);
    setCreated({ name: r.data.info.name, token: r.data.token });
    setName('');
    load();
  };

  const revoke = async (t: AdminTokenInfo) => {
    if (!confirm(`Revoke "${t.name}"? Anything using it stops working at once.`)) return;
    const r = await adminApi.revokeToken(token, t.id);
    notify(r.ok ? `Revoked "${t.name}"` : r.error);
    load();
  };

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(
      () => notify('Copied'),
      () => notify('Could not copy; select the token and copy it by hand'),
    );
  };

  return (
    <div>
      <p className="muted">
        Tokens let a script or an agent call the admin API with <span className="mono">Authorization: Bearer</span>. A token can do what its scopes say, never more than your role, and stops working when it expires, when it is revoked, or when your account is banned. Every call is written to the staff log with the token's name.
      </p>
      {created && (
        <div className="adm-secret" role="status">
          <p>
            Token <b>{created.name}</b>. Copy it now: it is shown only this once and the server keeps only a hash.
          </p>
          <div className="adm-toolbar">
            <input className="mono" readOnly value={created.token} aria-label="New token" onFocus={(e) => e.currentTarget.select()} />
            <button type="button" onClick={() => copy(created.token)}>
              Copy
            </button>
            <button type="button" onClick={() => setCreated(null)}>
              Done
            </button>
          </div>
        </div>
      )}
      <h2>New token</h2>
      <form className="adm-settings" onSubmit={(e) => void submit(e)}>
        <label className="adm-field wide">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="What uses it, for example claude" maxLength={32} aria-label="Token name" autoComplete="off" />
        </label>
        <fieldset>
          {offered.map((s) => (
            <label key={s} className="adm-check">
              <input type="checkbox" checked={scopes.has(s)} disabled={s === 'viewAdmin'} onChange={() => toggle(s)} aria-label={s} />
              <span>
                <span className="mono">{s}</span> <span className="muted">{TOKEN_SCOPE_INFO[s]}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <label className="adm-field wide">
          <span>Expires after</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Expiry">
            {EXPIRY_CHOICES.map((d) => (
              <option key={d} value={d}>
                {d === 1 ? '1 day' : `${d} days`}
              </option>
            ))}
          </select>
        </label>
        <div className="adm-actions">
          <button type="submit" className="primary" disabled={busy || !TOKEN_RULES.namePattern.test(name.trim())}>
            Create token
          </button>
        </div>
      </form>
      <h2>{role === 'owner' ? 'All tokens' : 'Your tokens'}</h2>
      {!list ? (
        <p className="muted">Loading</p>
      ) : list.length === 0 ? (
        <p className="muted">No tokens.</p>
      ) : (
        <table className="adm-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Scopes</th>
              <th>Made by</th>
              <th>Created</th>
              <th>Expires</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((t) => (
              <tr key={t.id} data-search-id={searchId('tokens', t.id)} tabIndex={-1}>
                <td>
                  {t.name} <span className="muted mono">{t.id}</span>
                  {t.expiresAt < Date.now() && <span className="badge red">expired</span>}
                </td>
                <td className="mono">{t.scopes.join(', ')}</td>
                <td>{t.createdBy}</td>
                <td>{when(t.createdAt)}</td>
                <td>{when(t.expiresAt)}</td>
                <td>{when(t.lastUsedAt)}</td>
                <td className="adm-row-actions">
                  <button type="button" className="danger small" onClick={() => void revoke(t)}>
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
