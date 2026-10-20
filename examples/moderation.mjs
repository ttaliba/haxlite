// Moderation reference for haxlite rooms:
//  - persistent bans in a JSON file (auth + IPs + CIDR ranges), re-applied at
//    start-up before any WebRTC work (IP/CIDR) and, for a banned `auth` that
//    comes back from a new IP, by re-applying the native kick-ban on join
//    (which records the new IP too: the `conn` IP and the public address of
//    the selected ICE pair, see `transport.verifiedIpBans`);
//  - quarantine: players whose `auth` was never seen before cannot chat for a
//    while (their messages are dropped with onPlayerChat → false);
//  - mute/unmute, ban/unban/banrange commands for admins;
//  - no anonymous players (allowNullAuth: false), per-IP join rate limit and
//    at most 2 simultaneous connections per IP (async pre-join hook).
//
//   HAXBALL_TOKEN=thr1.xxxx ADMIN_AUTHS=<your auth> node examples/moderation.mjs
//
// Your auth (public id) is shown at https://www.haxball.com/playerauth
import { readFile, rename, writeFile } from 'node:fs/promises';
import { HBInit } from 'haxlite';

const token = process.env.HAXBALL_TOKEN;
if (!token) {
  console.error('Set HAXBALL_TOKEN (https://www.haxball.com/headlesstoken)');
  process.exit(1);
}
const DATA_FILE = process.env.MODERATION_FILE ?? './moderation.json';
const ADMIN_AUTHS = new Set((process.env.ADMIN_AUTHS ?? '').split(',').filter(Boolean));
const QUARANTINE_MS = Number(process.env.QUARANTINE_MS ?? 2 * 60_000);
const MAX_CONNECTIONS_PER_IP = 2;
const haxlite = process.env.HAXLITE_OPTIONS ? JSON.parse(process.env.HAXLITE_OPTIONS) : {};

// ---------------------------------------------------------------- persistence

/**
 * @typedef {{ id: number, name: string, auth: string | null, ips: string[], cidr: string | null,
 *             reason: string, by: string, at: number }} StoredBan
 * @typedef {{ nextBanId: number, bans: StoredBan[], known: Record<string, number> }} Store
 */

/** @returns {Promise<Store>} */
async function load() {
  try {
    return JSON.parse(await readFile(DATA_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return { nextBanId: 1, bans: [], known: {} };
  }
}

const store = await load();
let saving = Promise.resolve();

/** Atomic write (tmp + rename), serialized. */
function save() {
  saving = saving.then(async () => {
    const tmp = `${DATA_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(store, null, 2));
    await rename(tmp, DATA_FILE);
  });
  return saving;
}

const banByAuth = (auth) => (auth === null ? undefined : store.bans.find((b) => b.auth === auth));

// ---------------------------------------------------------------- room

const room = await HBInit({
  roomName: 'haxlite (moderated)',
  maxPlayers: 20,
  public: true,
  noPlayer: true,
  token,
  haxlite: {
    ...haxlite,
    // players whose identity proof fails would join with auth = null: refuse them
    allowNullAuth: false,
    // at most 3 join attempts per IP in a burst, then one every 15 s
    joinRateLimit: { capacity: 3, msPerToken: 15_000 },
    // runs before any WebRTC object exists; may be async (e.g. ask a database)
    onJoinRequest: async (req) => {
      let sameIp = 0;
      for (const p of room.getPlayerList()) if (room.haxlite.getPlayerConnection(p.id)?.ip === req.ip) sameIp++;
      if (sameIp >= MAX_CONNECTIONS_PER_IP) return { reject: 4100 }; // shown as "The room is full."
      return true;
    },
  },
});
room.onRoomLink = (link) => console.log(`Room link: ${link}`);

// Re-apply stored IP and CIDR bans: rejected at signaling time (code 4102),
// before any WebRTC work. Banned auths are handled on join (below).
for (const ban of store.bans) applyNetworkBan(ban);

/** @param {StoredBan} ban */
function applyNetworkBan(ban) {
  const note = `#${ban.id} ${ban.name}`;
  for (const ip of ban.ips) if (!room.haxlite.bans.isIpBanned(ip)) room.haxlite.bans.addIp(ip, note);
  if (ban.cidr !== null) room.haxlite.bans.addRange(ban.cidr, note);
}

// ---------------------------------------------------------------- joins

/** Players muted for this session (by player id). */
const muted = new Set();

room.onPlayerJoin = (player) => {
  const ban = banByAuth(player.auth);
  if (ban !== undefined) {
    // A banned auth coming from an IP we did not know: re-apply the native
    // kick-ban (bans this connection's `conn` IP and the public address of its
    // ICE pair) and remember the new IPs. `srflxIps` are declared by the client
    // and not verified (a hostile client can list somebody else's address
    // there): persist `conn.remoteAddress` instead if you ban shared addresses.
    const conn = room.haxlite.getPlayerConnection(player.id);
    room.kickPlayer(player.id, `Banned: ${ban.reason}`, true);
    if (conn !== null) {
      for (const ip of [conn.ip, ...conn.srflxIps]) if (!ban.ips.includes(ip)) ban.ips.push(ip);
      void save();
    }
    console.log(`re-banned ${player.name} (ban #${ban.id})`);
    return;
  }
  if (ADMIN_AUTHS.has(player.auth)) room.setPlayerAdmin(player.id, true);
  if (!(player.auth in store.known)) {
    store.known[player.auth] = Date.now();
    void save();
    room.sendAnnouncement('Welcome! New players can chat after a short while.', player.id, 0xffcc00);
  }
};

room.onPlayerLeave = (player) => muted.delete(player.id);

function inQuarantine(playerId) {
  const auth = room.haxlite.getPlayerConnection(playerId)?.auth ?? null;
  if (auth === null) return true;
  const first = store.known[auth];
  return first === undefined || Date.now() - first < QUARANTINE_MS;
}

// ---------------------------------------------------------------- chat + commands

const commands = {
  /** !ban <playerId> [reason] — kick-ban and persist (auth + IPs). */
  ban(admin, [id, ...reason]) {
    const target = room.getPlayer(Number(id));
    if (target === null) return 'No such player.';
    const conn = room.haxlite.getPlayerConnection(target.id);
    const ban = {
      id: store.nextBanId++,
      name: target.name,
      auth: conn?.auth ?? null,
      // conn.srflxIps are declared by the client (unverified); conn.remoteAddress is the ICE pair's address
      ips: conn === null ? [] : [conn.ip, ...conn.srflxIps],
      cidr: null,
      reason: reason.join(' ') || 'banned',
      by: admin.name,
      at: Date.now(),
    };
    store.bans.push(ban);
    void save();
    room.kickPlayer(target.id, ban.reason, true); // native ban for this session (official clearBan works)
    return `Ban #${ban.id} for ${target.name}.`;
  },
  /** !banrange <cidr> [reason] — e.g. !banrange 203.0.113.0/24 */
  banrange(admin, [cidr, ...reason]) {
    const ban = { id: store.nextBanId, name: cidr, auth: null, ips: [], cidr, reason: reason.join(' ') || 'range', by: admin.name, at: Date.now() };
    try {
      applyNetworkBan(ban);
    } catch (err) {
      return String(err.message);
    }
    store.nextBanId++;
    store.bans.push(ban);
    void save();
    return `Ban #${ban.id}: range ${cidr}.`;
  },
  /** !unban <banId> */
  unban(_admin, [id]) {
    const i = store.bans.findIndex((b) => b.id === Number(id));
    if (i < 0) return 'No such ban.';
    const [ban] = store.bans.splice(i, 1);
    void save();
    // drop every live entry that bans one of its IPs / its range (native kick-bans included)
    for (const rec of room.haxlite.bans.list()) {
      if (rec.ips.some((ip) => ban.ips.includes(ip)) || (ban.cidr !== null && rec.range === ban.cidr)) room.haxlite.bans.remove(rec.id);
    }
    return `Ban #${ban.id} (${ban.name}) removed.`;
  },
  bans() {
    if (store.bans.length === 0) return 'No bans.';
    return store.bans.map((b) => `#${b.id} ${b.name} (${b.reason})`).join(' · ');
  },
  mute(_admin, [id]) {
    muted.add(Number(id));
    return `Player ${id} muted.`;
  },
  unmute(_admin, [id]) {
    muted.delete(Number(id));
    return `Player ${id} unmuted.`;
  },
};

room.onPlayerChat = (player, message) => {
  if (message.startsWith('!')) {
    const [name, ...args] = message.slice(1).trim().split(/\s+/);
    const cmd = commands[name.toLowerCase()];
    if (cmd !== undefined) {
      const reply = player.admin ? cmd(player, args) : 'Admins only.';
      room.sendAnnouncement(reply, player.id, 0xaaaaaa);
      return false;
    }
  }
  if (muted.has(player.id)) {
    room.sendAnnouncement('You are muted.', player.id, 0xff6666);
    return false;
  }
  if (inQuarantine(player.id)) {
    room.sendAnnouncement('New players cannot chat yet.', player.id, 0xffcc00);
    return false;
  }
  return true;
};

process.once('SIGINT', async () => {
  await saving;
  await room.haxlite.stop();
});
