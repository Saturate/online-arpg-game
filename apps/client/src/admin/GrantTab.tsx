import { GRANT_LEVEL, GRANT_TEMPLATE_INFO, GRANT_TEMPLATES, ITEM_TIERS, MINION_DEFS, MINION_TYPE_IDS, ROLLABLE_RUNES, runeName, type AdminAccount, type GrantTemplate, type ItemTier, type MinionTypeId, type RuneId } from '@rune/shared';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { adminApi, type GrantResponse } from '../net/api.js';
import { cssColor, TIER_COLORS, UNIQUE_COLOR } from '../render/config.js';

/**
 * Owner only: makes one item and puts it on an offline character as pending, so it lands on their
 * next login. The server checks every field and refuses an account that is online.
 */
export function GrantTab({ token, notify }: { token: string; notify: (t: string) => void }) {
  const [accounts, setAccounts] = useState<AdminAccount[] | null>(null);
  const [username, setUsername] = useState('');
  const [characterId, setCharacterId] = useState<number | null>(null);
  const [template, setTemplate] = useState<GrantTemplate>('brothers_creation');
  const [tier, setTier] = useState<ItemTier>('relic');
  const [level, setLevel] = useState(1);
  const [minion, setMinion] = useState<MinionTypeId | ''>('');
  const [rune, setRune] = useState<RuneId | ''>('');
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<GrantResponse | null>(null);

  useEffect(() => {
    void adminApi.accounts(token).then((r) => (r.ok ? setAccounts(r.data) : notify(r.error)));
  }, [token, notify]);

  const account = useMemo(() => accounts?.find((a) => a.username.toLowerCase() === username.trim().toLowerCase()) ?? null, [accounts, username]);
  // A picked character that belongs to another account is not a choice any more.
  const character = account?.characters.find((c) => c.id === characterId) ?? null;
  const fixedTier = template === 'brothers_creation';

  const pickTemplate = useCallback((t: GrantTemplate) => {
    setTemplate(t);
    if (t === 'brothers_creation') setTier('relic');
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!account || !character) return;
    const what = template === 'brothers_creation' ? 'Brothers Creation' : `a ${tier} ${GRANT_TEMPLATE_INFO[template].name.toLowerCase()}`;
    if (!confirm(`Grant ${what} to ${account.username} / ${character.name}? It is a real, tradeable item.`)) return;
    setBusy(true);
    const r = await adminApi.grant(token, {
      username: account.username,
      characterId: character.id,
      template,
      tier: fixedTier ? 'relic' : tier,
      level,
      minion: template === 'vessel' && minion !== '' ? minion : null,
      rune: template === 'rune' && rune !== '' ? rune : null,
    });
    setBusy(false);
    if (!r.ok) return notify(r.error);
    setLast(r.data);
    notify(`Granted ${r.data.item.name} to ${r.data.character}; it arrives on their next login`);
  };

  if (!accounts) return <p className="muted">Loading</p>;
  return (
    <form className="adm-settings" onSubmit={(e) => void submit(e)}>
      <p className="muted">
        Makes one item and puts it on an offline character as pending: it moves into their stash or bag when they next log in. Accounts that are online are refused, so ask them to log out first. Every grant is written to the staff log.
      </p>
      <label className="adm-field wide">
        <span>Account</span>
        <input list="grant-accounts" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Account name" aria-label="Account" autoComplete="off" />
        <datalist id="grant-accounts">
          {accounts.map((a) => (
            <option key={a.id} value={a.username} />
          ))}
        </datalist>
        {username.trim() !== '' && !account && <small className="muted">No account by that name.</small>}
      </label>
      <label className="adm-field wide">
        <span>Character</span>
        <select value={character?.id ?? ''} onChange={(e) => setCharacterId(e.target.value === '' ? null : Number(e.target.value))} disabled={!account} aria-label="Character">
          <option value="">{account ? (account.characters.length ? 'Pick a character' : 'This account has no characters') : 'Pick an account first'}</option>
          {account?.characters.map((c) => (
            <option key={c.id} value={c.id} disabled={c.playedAt === 0}>
              {c.name} ({c.classId}, level {c.level}){c.playedAt === 0 ? ', never played' : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="adm-field wide">
        <span>Item</span>
        <select value={template} onChange={(e) => pickTemplate(GRANT_TEMPLATES.find((t) => t === e.target.value) ?? 'brothers_creation')} aria-label="Item">
          {GRANT_TEMPLATES.map((t) => (
            <option key={t} value={t}>
              {GRANT_TEMPLATE_INFO[t].name}
            </option>
          ))}
        </select>
      </label>
      <label className="adm-field">
        <span>Tier</span>
        <select value={fixedTier ? 'relic' : tier} disabled={fixedTier} onChange={(e) => setTier(ITEM_TIERS.find((t) => t === e.target.value) ?? 'common')} aria-label="Tier">
          {ITEM_TIERS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label className="adm-field">
        <span>Item level</span>
        <input type="number" min={GRANT_LEVEL.min} max={GRANT_LEVEL.max} step={1} value={level} onChange={(e) => setLevel(Math.max(GRANT_LEVEL.min, Math.min(GRANT_LEVEL.max, Math.round(Number(e.target.value) || 1))))} aria-label="Item level" />
        <small className="muted">Gates affix tiers as for a drop; the level requirement is two below it.</small>
      </label>
      {template === 'vessel' && (
        <label className="adm-field wide">
          <span>Minion</span>
          <select value={minion} onChange={(e) => setMinion(MINION_TYPE_IDS.find((m) => m === e.target.value) ?? '')} aria-label="Minion">
            <option value="">Random, as a drop</option>
            {MINION_TYPE_IDS.map((m) => (
              <option key={m} value={m}>
                {MINION_DEFS[m].name}
              </option>
            ))}
          </select>
        </label>
      )}
      {template === 'rune' && (
        <label className="adm-field wide">
          <span>Rune</span>
          <select value={rune} onChange={(e) => setRune(ROLLABLE_RUNES.find((r) => r === e.target.value) ?? '')} aria-label="Rune">
            <option value="">Random, as a drop</option>
            {ROLLABLE_RUNES.map((r) => (
              <option key={r} value={r}>
                {runeName(r)}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="adm-actions">
        <button type="submit" className="primary" disabled={busy || !account || !character}>
          Grant
        </button>
      </div>
      {last && (
        <p>
          Last grant:{' '}
          <b style={{ color: cssColor(last.item.kind === 'vessel' && last.item.fixedName ? UNIQUE_COLOR : TIER_COLORS[last.item.tier]) }}>{last.item.name}</b> to {last.character}, pending until their next login.
        </p>
      )}
    </form>
  );
}
