# Chat and parties

Status: Live. Chat since 2026-09-28, parties and party worlds since 2026-09-29. Party frames and teleport to a member built 2026-09-30, not yet deployed.

## What it does

- **Enter** chats to everyone in your world instance. A line also shows as a speech bubble over the speaker's head for 6 s, when they are in your room.
- **Commands** (`/help` lists them):
  - `/w name message` (or `/whisper`) whispers anyone online.
  - `/p message` (or `/party`) talks to your party.
  - `/who` lists the players in your world.
  - `/invite name`, `/accept`, `/decline`, `/leave` for parties.
  - Staff only: `/goto name` (the `teleport` permission) and `/sandbox` (the `devTools` permission). Players who lack the permission get "Unknown command". See [accounts-admin.md](accounts-admin.md).
- **Parties:** invite by name from chat or from the Esc menu. The invitee sees a prompt, like D2's party request, and answers with a click or `/accept` / `/decline`. Joining moves you into the inviter's world if it has room. The party leader can open a **party world**, a private copy of the world with a seed the server picks, that only party members can enter (see [town.md](town.md), "Worlds and instances").
- **Party frames** sit under the minimap whenever you are in a party (hiding the minimap lifts them). One frame per other member: name, class colour (the left edge), level, a life bar, the state (In town, Wilds, Dungeon, Arena, Sandbox, Dead, Offline) and the zone name. Members anywhere count, not only those in your room. Offline members stay listed, dimmed, with the class and level last seen.
- **Teleport to a member:** click their frame ("Go to" shows on hover). A 3 s channel runs as a cast bar above the skill bar; moving (or dashing), taking damage, casting, dying or changing room breaks it with a notice saying why. Then you arrive beside them, in their room and world copy. Free, no cooldown. A frame whose teleport would be refused says why on hover, and a click gets the same reason from the server.
- **Minimap:** party members in the same map share vision and always show on it as ringed green dots. Members beyond the snapshot's reach (1100 units) still show, from the party status. A member standing past the drawn map's edge shows as an arrow on the edge pointing at them. The whole minimap (layout, fog, every marker and the edge arrows) is turned by the camera's yaw, so up on the minimap is up on screen and matches WASD; at the default 45 degree yaw a square map shows as a diamond. The layout and fog stay north-up offscreen and are turned with one canvas transform when drawn; markers are placed at their turned positions but drawn upright. The box grew from 200 to 220 px so the turned map keeps its size, and the party frames widened to match. There is no separate full map view: Tab only hides and shows the corner map.
- Party members near a kill share its XP ([characters.md](characters.md)).

## Why

- **Text is never HTML.** Chat is set only through React or `textContent`, so a message cannot inject markup.
- **The server cleans every line:** whitespace collapses to one space (newlines become spaces rather than vanishing), control and format characters (`\p{Cc}`, `\p{Cf}`, which include zero-width characters) are removed, and the line is capped at 200 characters (`CHAT_MAX_LENGTH`).
- **Flood limit:** 6 messages per 5 s per client (`CHAT_PER_WINDOW`, `CHAT_WINDOW_MS`), on top of the general 60 messages per second socket limit. Generous for talk, tight for spam.
- **Parties are kept by account, in memory,** so a reconnect stays in the party. A party holds at most `INSTANCE_CAPACITY` (8) members, the same as a world copy, so a whole party always fits in its world.
- **Seeds are never chosen by players.** A party world's seed comes from a server counter; the old player-chosen seed messages are ignored.
- **A party world is for the party only.** Leaving the party while inside it moves you to a public world. A party of one is dissolved; the last member keeps playing where they are, and the world loses its party tag.
- **Leadership passes on:** when the leader leaves, the first remaining member becomes leader.
- **Teleport rules (all on the server; the client only asks by name):** refused to yourself, to anyone not in your party, to an offline member, while you are dead, out of an Arena run (a scored run is left by town portal or dying), into an Arena run (runs take nobody who was not there at the start), into a builder's sandbox, into a dungeon run that holds anyone outside your party (that would skip their gate), into another party's world, and into a world copy that is full. Everything is checked when the channel starts and again when it ends, so a member who walks into the Arena during the channel is not followed. Same-room teleports just move you beside them.
- **Why a channel and not a cooldown:** 3 s standing still cannot be used to escape a fight, and costs nothing when travelling between fights. Standing still allows 6 units of drift (minions and other players push); regeneration never breaks it, only a life drop does.
- **Why a once-a-second status:** frames for members in other rooms need data the snapshot does not carry, and life at 1 Hz reads fine. Members in your own room take life from the snapshot instead, so the bar keeps up in a fight. A party of 2 costs about 140 bytes a second per member; a full party of 8 about 1.2 KB a second each (7 members of about 170 bytes).

## How

- Server: `apps/server/src/manager.ts`, `chat()` for chat and commands, `partyInvite`, `partyAnswer`, `partyLeave`, `goPartyWorld`, `sendParty`. Parties and pending invites live in the manager (`parties`, `invites`), not in rooms.
- Party frames and teleport: `sendPartyStatus` (every `PARTY_STATUS_TICKS`, once a second, and straight after any `sendParty`), `teleportRefusal` (the rules), `startTeleport` and `tickChannels` in the manager; `channelBreak` and the constants in `apps/server/src/partyTravel.ts`; `Room.memberView` reads a member's class, level, life, position, cast cooldown and dash. The arrival goes through `travelTo`, shared with staff `/goto`, which uses `move()`: the same save-on-exit room change as waypoints and portals.
- Validation: `cleanChat` and `CHAT_MAX_LENGTH` in `packages/shared/src/protocol/validate.ts`.
- Client: frames and the cast bar in `apps/client/src/ui/PartyFrames.tsx` and `party.css` (the fill is a CSS animation, nothing runs per frame); `partyStatus` and `teleport` in the UI store; far members and edge arrows in `render/minimap.ts`. The old top-right list now only shows yourself when solo, and the Arena score. `apps/client/src/ui/ChatBox.tsx`; speech bubbles in `apps/client/src/game/game.ts` (`BUBBLE_MS` 6000); the invite form and prompt in `apps/client/src/ui/EscMenu.tsx`; shared vision in `apps/client/src/render/minimap.ts`.
- Messages: `chat` (kinds `game`, `whisper`, `party`, `system`), `partyInvite`, `partyAnswer`, `partyLeave`, `partyWorld`, and the server's `party` message carrying `PartyInfo` (leader, members with online flags, whether a party world is open). `partyTeleport { name }` asks to teleport; `partyStatus { members }` (`PartyMemberStatus`: name, class, level, life, place, zone, position only when in the receiver's room, and `no`, the refusal reason) and `teleportChannel` (started with `to` and `seconds`, or ended with a `reason`, null on arrival) come back. The client checks both field by field (`isPartyStatus`, `isTeleportChannel`), since clicks act on them.
- Announcements from the admin page arrive as `system` chat lines prefixed "Announcement:".

Tests:

- `packages/shared/test/protocol.test.ts`: chat strips control and zero-width characters, collapses space and caps length.
- `apps/server/test/worlds.test.ts`: invite, join the inviter, open a party world together and leave back to public; only the leader opens a party world; staff teleport.
- `packages/shared/test/progression.test.ts`: party XP sharing.
- `apps/server/test/partyTeleport.test.ts`: the status message (once a second, place, zone, position only in the same room, offline members), the channel and arrival both ways with the save on the way, cancelling on moving, a hit and a cast, every refusal (yourself, strangers, the dead, offline, into and out of an Arena run, a dungeon run with strangers), and the re-check when the channel ends. `packages/shared/test/protocol.test.ts`: the status and channel validators and the request parser.

## Limits and open questions

- No chat history: a client sees only what arrived while it was connected.
- No mute or block list, and no profanity filter.
- Parties are lost on a server restart, since they live in memory.
- Offline and disconnected are one state: a dropped connection leaves the world at once, so there is no "reconnecting" state to show.
- The Arena gate shows as "Arena" on the frames, though a teleport there is allowed; only runs are refused.
- The minimap turn is fixed by `VIEW.yawDegrees`, since the camera never turns in play; a camera that turns would need the minimap to redraw on each change.
- The minimap already draws the whole map, so the edge arrow only shows for positions on or past the map border; the useful part is that members out of the snapshot's reach now show at all.
- Open: should teleport cost something (gold, a scroll) once the economy has sinks, and should a party leader be able to summon?
- Guild chat (`/g`) is planned with guilds ([guilds.md](guilds.md)).
