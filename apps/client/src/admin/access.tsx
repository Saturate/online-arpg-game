import { can, type Permission, type Role } from '@rune/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../net/api.js';
import './access.css';

export function readToken(): string | null {
  try {
    return localStorage.getItem('rune.session');
  } catch {
    return null;
  }
}

export interface StaffAccess {
  token: string;
  role: Role;
  username: string;
}

/**
 * Staff pages use the game's login. The server enforces every permission on its own endpoints; this
 * only keeps the pages out of sight for players, as the page code itself is public.
 */
export function StaffGate({ title, permission, children }: { title: string; permission: Permission; children: (access: StaffAccess) => ReactNode }) {
  const token = readToken();
  /** null while checking, the viewer's access when allowed, otherwise the reason to show. */
  const [access, setAccess] = useState<StaffAccess | string | null>(null);

  useEffect(() => {
    if (!token) return;
    void api.characters(token).then((r) => {
      if (r.ok) return setAccess(can(r.data.role, permission) ? { token, role: r.data.role, username: r.data.username } : 'This account does not have access to this page.');
      setAccess(r.status === 401 ? 'Your session expired. Log in to the game again.' : `Could not reach the server (${r.error}). Reload to retry.`);
    });
  }, [token, permission]);

  if (!token || typeof access === 'string') {
    return (
      <main className="staff-gate">
        <h1>{title}</h1>
        <p className="muted">{token && typeof access === 'string' ? access : 'Log in to the game first; this page uses the same login.'}</p>
        <a href="/">Go to the game</a>
      </main>
    );
  }
  if (access === null) return <main className="staff-gate muted">Checking access</main>;
  return children(access);
}
