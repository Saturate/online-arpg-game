# Guilds

Status: Planned. Owner decisions from 2026-09-30; nothing is built yet.

## What it does

A guild is a group of accounts with ranks, a shared stash, a tag on nameplates and its own chat channel. Every character on a member account is in the guild.

- **Ranks:** Leader, Officer, Member.
- **Guild window (G):** roster (rank, class, level, online and zone), invite, promote and demote, kick, leave, a message of the day, and the guild log.
- **Tag:** 2 to 5 characters shown before the name on nameplates and in chat.
- **Guild chat:** `/g`.
- **Guild stash:** tabs like the personal stash, opened from the same stash chest in town.

## Why

- **Membership is per account,** not per character, so switching characters never drops you out of your guild. This matches the account stash, which all of an account's characters already share.
- **Founding costs gold** (about 1000, a config value) and the guild gets one free stash tab. More tabs are bought by a Leader or Officer with their own gold, like personal tabs, up to a cap of about 10. Both are gold sinks.
- **At most 50 members.**
- **Invites go only to online players,** from the guild window or by right-clicking a player, and are accepted or declined like party invites (see [chat-and-parties.md](chat-and-parties.md)).
- **Rank powers:**
  - Leader: everything, including disbanding the guild and handing leadership to someone else. Only the Leader promotes a Member to Officer.
  - Officer: invites, kicks Members, and manages stash tabs (buy, rename, recolour, set permissions).
  - Member: uses the stash as each tab's permissions allow.
- **Tab permissions are per tab and per rank:** view, deposit, withdraw.
- **The guild log** records joins, leaves, rank changes, and every stash deposit and withdrawal, so a missing item can be traced.

## How

Planned shape, to be confirmed when it is built:

- **The guild stash is one shared server-side object,** held by the manager (`apps/server/src/manager.ts` level), not by a room, because members in different rooms and world instances touch it at the same time.
- **Every stash move is one transaction** with the character involved, the same rule the account stash and the trader already follow ([stash.md](stash.md), [items.md](items.md)).
- **Bound items cannot be deposited,** for the same reason they cannot go into the account stash: a new character must not farm starter gear for another account.
- **Tabs reuse the stash tab model** from the stash tabs feature, which is being built now.
- **Build order:** after stash tabs are merged. A server and data agent plus a UI agent, then a review and a browser QA pass with two accounts.
- **Parallel with loot piles:** the two features own separate files. Guilds own guild data, the guild stash and the guild window; loot piles own ground loot, pickup, the loot window and ground rendering ([loot.md](loot.md)).

## Limits and open questions

- **Item safety review needed before it ships:** a fresh-eyes loss and duplication review, including two members taking the same item at the same moment from different rooms.
- The exact founding price and tab cap are "about" values in the owner's brief; they become config numbers when built.
- **Disbanding (owner, 2026-10-02):** a guild can only disband with an empty stash, so nothing is lost; the Leader hands items out first.
- **A Leader who leaves (owner, 2026-10-02):** on account deletion, or after 30 days without a login, leadership passes to the longest-serving Officer, else the longest-serving Member.
- **Founding price and tab cap** become live tuning numbers (base numbers, owner's rule).
