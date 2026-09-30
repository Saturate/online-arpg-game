# Chat and parties

Status: Live. Chat since 2026-09-28, parties and party worlds since 2026-09-29.

## What it does

- **Enter** chats to everyone in your world instance. A line also shows as a speech bubble over the speaker's head for 6 s, when they are in your room.
- **Commands** (`/help` lists them):
  - `/w name message` (or `/whisper`) whispers anyone online.
  - `/p message` (or `/party`) talks to your party.
  - `/who` lists the players in your world.
  - `/invite name`, `/accept`, `/decline`, `/leave` for parties.
  - Staff only: `/goto name` (the `teleport` permission) and `/sandbox` (the `devTools` permission). Players who lack the permission get "Unknown command". See [accounts-admin.md](accounts-admin.md).
- **Parties:** invite by name from chat or from the Esc menu. The invitee sees a prompt, like D2's party request, and answers with a click or `/accept` / `/decline`. Joining moves you into the inviter's world if it has room. The party leader can open a **party world**, a private copy of the world with a seed the server picks, that only party members can enter (see [town.md](town.md), "Worlds and instances").
- **Party frames** show every party member's name and life. Party members in the same map share minimap vision and always show on it. Party members near a kill share its XP ([characters.md](characters.md)).

## Why

- **Text is never HTML.** Chat is set only through React or `textContent`, so a message cannot inject markup.
- **The server cleans every line:** whitespace collapses to one space (newlines become spaces rather than vanishing), control and format characters (`\p{Cc}`, `\p{Cf}`, which include zero-width characters) are removed, and the line is capped at 200 characters (`CHAT_MAX_LENGTH`).
- **Flood limit:** 6 messages per 5 s per client (`CHAT_PER_WINDOW`, `CHAT_WINDOW_MS`), on top of the general 60 messages per second socket limit. Generous for talk, tight for spam.
- **Parties are kept by account, in memory,** so a reconnect stays in the party. A party holds at most `INSTANCE_CAPACITY` (8) members, the same as a world copy, so a whole party always fits in its world.
- **Seeds are never chosen by players.** A party world's seed comes from a server counter; the old player-chosen seed messages are ignored.
- **A party world is for the party only.** Leaving the party while inside it moves you to a public world. A party of one is dissolved; the last member keeps playing where they are, and the world loses its party tag.
- **Leadership passes on:** when the leader leaves, the first remaining member becomes leader.

## How

- Server: `apps/server/src/manager.ts`, `chat()` for chat and commands, `partyInvite`, `partyAnswer`, `partyLeave`, `goPartyWorld`, `sendParty`. Parties and pending invites live in the manager (`parties`, `invites`), not in rooms.
- Validation: `cleanChat` and `CHAT_MAX_LENGTH` in `packages/shared/src/protocol/validate.ts`.
- Client: `apps/client/src/ui/ChatBox.tsx`; speech bubbles in `apps/client/src/game/game.ts` (`BUBBLE_MS` 6000); the invite form and prompt in `apps/client/src/ui/EscMenu.tsx`; shared vision in `apps/client/src/render/minimap.ts`.
- Messages: `chat` (kinds `game`, `whisper`, `party`, `system`), `partyInvite`, `partyAnswer`, `partyLeave`, `partyWorld`, and the server's `party` message carrying `PartyInfo` (leader, members with online flags, whether a party world is open).
- Announcements from the admin page arrive as `system` chat lines prefixed "Announcement:".

Tests:

- `packages/shared/test/protocol.test.ts`: chat strips control and zero-width characters, collapses space and caps length.
- `apps/server/test/worlds.test.ts`: invite, join the inviter, open a party world together and leave back to public; only the leader opens a party world; staff teleport.
- `packages/shared/test/progression.test.ts`: party XP sharing.

## Limits and open questions

- No chat history: a client sees only what arrived while it was connected.
- No mute or block list, and no profanity filter.
- Parties are lost on a server restart, since they live in memory.
- Guild chat (`/g`) is planned with guilds ([guilds.md](guilds.md)).
