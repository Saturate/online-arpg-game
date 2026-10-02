import { describe, expect, it } from 'vitest';
import { isGuildDetail, isGuildSummary } from '../src/admin/guildsApi.js';

const summary = { id: 1, name: 'Ashen Watch', tag: 'ASH', createdAt: 1, members: 2, leader: { accountId: 7, username: 'ember', character: 'Ashcaller' }, tabs: 1, items: 3, stashReadable: true };

describe('admin guild answers', () => {
  it('accepts a guild list row, a guild without a Leader, and refuses a damaged one', () => {
    expect(isGuildSummary(summary)).toBe(true);
    expect(isGuildSummary({ ...summary, leader: null })).toBe(true);
    expect(isGuildSummary({ ...summary, stashReadable: 'yes' })).toBe(false);
  });

  it('checks the roster, tabs and log of a guild detail', () => {
    const detail = {
      ...summary,
      motd: '',
      roster: [{ accountId: 7, username: 'ember', rank: 'leader', joinedAt: 1, character: 'Ashcaller', classId: 'mage', level: 12, lastActive: 2, online: false }],
      tabList: [{ id: 1, name: 'Tab 1', items: 3 }],
      log: [{ id: 4, at: 3, kind: 'deposit', actor: 'Ashcaller', text: 'Ashcaller put a ring into Tab 1' }],
      moreLog: false,
    };
    expect(isGuildDetail(detail)).toBe(true);
    expect(isGuildDetail({ ...detail, roster: [{ ...detail.roster[0], rank: 'king' }] })).toBe(false);
    expect(isGuildDetail({ ...detail, log: [{ ...detail.log[0], kind: 'theft' }] })).toBe(false);
  });
});
