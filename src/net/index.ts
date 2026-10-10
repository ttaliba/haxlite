/**
 * src/net — networking (OWNER: engineer C): master server HTTP (/rs/api/host,
 * RoomInfo publish), signaling WebSocket (host side, deflated payloads),
 * WebRTC transport via node-datachannel (3 negotiated channels ro/ru/uu),
 * join handshake + ECDSA P-256 identity (node:crypto webcrypto), bans,
 * flood/token-bucket limits. See docs/01, docs/02 §2, docs/04.
 * No game logic here: deliver decoded messages to src/host.
 */
export {};
