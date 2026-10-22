# src/rtc — haxlite-rtc

Minimal pure-TypeScript WebRTC **data-channel** stack for HaxBall hosts (haxlite Edge,
dedicated hosts, and hosts behind NAT: full ICE with STUN gathering). Replaces
node-datachannel/libdatachannel there. No native addons:
`node:dgram` + `node:crypto` only (Node ≥ 22, or Bun: on Bun the UDP I/O goes through the
native socket inside `dgram`, see Design notes).

Scope (HaxBall needs nothing else): the browser is always the **offerer** and the DTLS
**client**; we are an **ICE-lite**, **DTLS 1.2 server**, **SCTP** endpoint with the three
pre-negotiated channels of the official client (`ro` id 0, `ru` id 1, `uu` id 2, no DCEP).

ICE: by default a **full agent in the controlled role** (`ice-agent.ts`: our own connectivity
checks to the remote candidates, triggered checks, prflx, RFC 7675 consent) with host + srflx
candidates gathered once per endpoint (`gather.ts`, STUN from the shared socket). `iceLite: true`
keeps the original ICE-lite behaviour. See docs/10 §2.1.

```
UDP socket (one per family, shared by all sessions)
 └─ demux (RFC 7983 first byte): 0–3 STUN → session by USERNAME ufrag
                                 20–63 DTLS → session by remote address (validated by ICE)
     └─ RtcSession: ICE-lite (stun.ts) → DTLS 1.2 server (dtls/) → SctpAssociation (sctp/, R2)
```

Owners: R1 everything in `src/rtc/` except `src/rtc/sctp/` (R2) · tests `test/rtc/` (R1),
`test/rtc-interop/` (R3).

## Public API (`src/rtc/index.ts`)

```ts
import { RtcEndpoint, RtcCertificate, acquireSharedEndpoint } from './rtc/index.js';

const ep = await RtcEndpoint.listen({
  port: 40000,                    // default 0 (ephemeral)
  address: '0.0.0.0',             // bind address; default: wildcard of the family of publicAddresses
  ipv6: false,                    // default false: IPv4 only (no udp6, no IPv6 candidates, no AAAA); IPv6 headers cost ≈ +19 % egress
  publicAddresses: ['203.0.113.7'], // optional (full ICE): host candidates instead of the interfaces; required with iceLite
  iceServers: ['stun:stun.l.google.com:19302'], // srflx gathering + UDP turn: relay (default none)
  candidatePolicy: 'public',      // interface addresses announced / remote classes checked ('public' | 'private' | 'all' | fn)
  iceLite: false,                 // true: a=ice-lite, no checks, no gathering
  gatherRefreshMs: 60_000,        // older srflx result → refreshed in the background (sessions still get it at once)
  publicPort: 40000,              // optional: advertised port when a 1:1 NAT maps it (default: bound port)
  certificate: RtcCertificate.generate(), // optional; default: RtcCertificate.processDefault() (one per process, generated synchronously)
  certificateFile: '/var/lib/haxlite/dtls.pem', // optional: load/persist the identity (RtcCertificate.loadOrCreate)
  cipherSuites: ['chacha20', 'aes128gcm', 'aes256gcm'], // DTLS server preference (the default, Node and Bun)
  idleTimeoutMs: 30_000,          // no ICE consent (authenticated binding) for this long → close('timeout')
  handshakeTimeoutMs: 20_000,     // session not open this long after createSession → close('handshake-timeout')
  maxSessions: 10_000,
});

const s = ep.createSession(offerSdp);   // throws RtcSdpError on an unusable offer
s.answerSdp;            // answer with the known candidates (a=end-of-candidates once gathering is complete); '' once DTLS connects
s.localCandidates;      // ['candidate:1 1 udp 2130706431 203.0.113.7 40000 typ host', …] (no "a=")
s.mid;                  // mid of the data m-line (for trickle signaling)
s.addRemoteCandidate('candidate:…');  // full ICE: our checks go there (ICE-lite: hint only)
s.gatheringComplete;    // false while a STUN round runs: rest via s.onLocalCandidate / s.onGatheringComplete
s.onOpen = () => {};    // DTLS connected + SCTP association up (channels 0/1/2 usable)
s.onMessage = (channelId, data) => {}; // data: Uint8Array, the receiver may keep it
s.onClose = (reason) => {};            // once; never called after a local close()
s.onChannelClose = (channelId) => {};  // the browser closed one channel (dc.close() → stream reset); session still open
s.send(0, bytes);       // false if not open / buffer full; bytes may be reused after return
s.remoteAddress;        // { address, port } of the nominated pair, or null
s.bufferedAmount;      // bytes accepted by send() and not yet acknowledged, every channel (0 once closed): a peer that keeps it high is not reading
s.close();              // sends SCTP ABORT/close_notify best effort, idempotent
await ep.close();       // closes every session ('endpoint-closed') and the socket(s)
ep.stats();             // counters (see RtcEndpointStats in index.ts), packetErrors included
s.cork(); s.send(…); s.send(…); s.uncork(); // bundle several messages into one SCTP packet / DTLS record

// one endpoint (one UDP socket) per process and configuration, refcounted (src/rtc/shared.ts)
const lease = acquireSharedEndpoint({ port: 0, publicAddresses: ['203.0.113.7'] });
const shared = await lease.ready; … await lease.release(); // the last release closes it
```

`onMessage` data is only valid during the callback (the SCTP layer delivers views into a reused
scratch buffer: `transientDelivery`); copy what you keep.

`onClose` reasons: `'remote-close'` (DTLS close_notify), `'timeout'` (ICE consent), `'handshake-timeout'`, `'dtls-alert:<n>'`
(fatal alert received), `'dtls-error:<what>'` (we aborted the handshake: e.g.
`'dtls-error:fingerprint-mismatch'`, `'dtls-error:no-client-certificate'`), `'sctp:<reason>'`
(R2: `shutdown`, `abort`, `timeout`, `init-timeout`…), `'endpoint-closed'`. A local `close()` is
never reported.

More `onClose` reasons: `'dtls-error:internal-<message>'` (a failure while resending a handshake flight), `'dtls-error:sequence-exhausted'` (the 48-bit write sequence of an epoch ran out: closed asynchronously, no alert is sent), `'sctp:internal-error'` (a bug in a timer-driven send; also passed to `onError`), `'sctp:message-too-large'` (a message filled the receive buffer and already exceeds `maxReceiveMessageSize`) and `'error'` (5 datagrams in a row threw in the session, or its 1 Hz timer check threw). The endpoint discards a datagram whose processing throws, counts it in `ep.stats().packetErrors` and logs it with `console.error('[haxlite/rtc] error processing a …')` at most every 10 s; TURN and ICE-tick errors are logged as `[haxlite/rtc] error in …` without a rate limit. `s.bufferedAmount` is what `PeerLink.queuedBytes` reports to `HostTransport`, which closes a peer that keeps it above `maxPeerBufferedBytes` (1 MiB) for `peerBufferedTimeoutMs` (10 s) with the reason `'stalled'`; a custom backend has to report it for that limit to apply.

## Contract with R2 — `SctpAssociation` (`src/rtc/sctp/index.ts`)

`RtcEndpoint` uses R2's `SctpAssociation` by default (static import). The subset the session
relies on is `SctpAssociationOptions` / `SctpAssociationLike` in `src/rtc/types.ts`; R2's class
satisfies it structurally (R2's own options type is a superset):

```ts
new SctpAssociation({
  send(packet: Uint8Array): void,   // one SCTP packet → one DTLS record, encrypted synchronously
                                    // (R2 may reuse the buffer after the call)
  channels: [{id:0,ordered:true},{id:1,ordered:false},{id:2,ordered:false,maxRetransmits:0}],
  maxMessageSize,                   // peer's a=max-message-size (sends above it are refused)
  maxReceiveMessageSize: 262144,    // ours
  localPort: 5000, remotePort,      // a=sctp-port of answer / offer
  onMessage(channelId, data),       // receiver may keep `data`
  onOpen(), onClose(reason),        // reason → session onClose('sctp:<reason>')
  onError(err),                     // exceptions from the callbacks above
});
assoc.input(record)   // one decrypted DTLS application-data record (fresh buffer, may be kept)
assoc.send(channelId, data): boolean
assoc.close()         // no onClose afterwards
```

* The association is constructed **when the DTLS handshake completes** (the browser sends INIT
  right away; R2 may also send its own).
* Path MTU: SCTP packets ≤ 1200 bytes (DTLS adds 29 bytes with AES-GCM, IP/UDP ≤ 48).
* All callbacks run synchronously from `input()`/timers on the main thread.
* Defensive limits against a peer that already joined (all preserve what the official client sends): `COOKIE-ECHO` is only processed as the first chunk of a packet (RFC 9260 §5.1); at most 2 RE-CONFIG request parameters per packet (`MAX_RECONF_REQS`), the rest are ignored; the gap blocks of a SACK get a budget equal to the TSNs between the cumulative ack and the last one sent; a FORWARD-TSN gets `4 × rxCap` pending-map reads per packet (`FWD_WORK_PER_SLOT`). The advertised `a_rwnd` is `receiveBufferSize` (default 1 MiB) minus what is held; the next in-order TSN is admitted with one more message of margin (`receiveBufferSize + maxReceiveMessageSize`), and a message that fills that buffer and already exceeds `maxReceiveMessageSize` closes the association with `'message-too-large'`. A failure in a timer-driven send closes it with `'internal-error'`.
* `RtcEndpoint.listen({ dataLayer })` accepts any other factory `(opts) => SctpAssociationLike`;
  `rawDataLayer` (one DTLS record = one message, `[u8 channel][payload]`) is used by the DTLS
  tests against `openssl s_client`.

## Design notes

* **ICE-lite** (RFC 8445 §2.5): we never send checks; we answer Binding requests whose
  USERNAME is `ourUfrag:theirUfrag`, with valid MESSAGE-INTEGRITY (HMAC-SHA1, our pwd) and
  FINGERPRINT, from a controlling agent. Each authenticated source becomes a *validated*
  address of that session; DTLS is only accepted from validated addresses. USE-CANDIDATE
  nominates (= `remoteAddress`). NAT rebinding: only through a new authenticated binding.
  Consent: the browser keeps sending bindings (~every 2.5–5 s); none for `idleTimeoutMs` →
  close. Such an address is **not proven**: every joining client knows our password (it is in
  its answer) and could spoof a victim's source, hence the DTLS cookie is on by default here.
* **Full ICE** (default, `ice-agent.ts`): an address is validated only once OUR check to it got
  an authenticated, symmetric success (RFC 8445 §7.2.5.3); a request triggers that check, and
  its USE-CANDIDATE nominates when the check succeeds (§7.3.1.5). DTLS arriving meanwhile from
  the authenticated source is held (≤ 4 datagrams) and processed on success, and a request on
  an in-progress check retransmits it at once (§7.3.1.4): no extra round trip per join.
* **DTLS 1.2 server** (RFC 6347, `dtls/server.ts`): with full ICE no HelloVerifyRequest — the
  first ClientHello gets flight 4 (RFC 6347 §4.2.1 allows it; the cookie only proves address
  ownership, which our own connectivity check already proved): one client RTT less per join.
  Handshake flights only go to the (validated) address of the ClientHello that started the
  handshake. With ICE-lite the HMAC cookie exchange (bound to the remote address and the
  ClientHello parameters) is on by default: addresses there are only vouched for by Binding
  requests. `helloVerify` (RtcEndpointOptions / RtcBackendOptions) overrides either default. A
  retransmitted ClientHello re-sends flight 4 unchanged (rate-limited); an unsolicited cookie is
  ignored. Suite preference (`defaultSuites` in `dtls/crypto.ts`, same on Node and Bun):
  `TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256` — Chromium 141 offers and negotiates it —
  then AES_128_GCM / AES_256_GCM (all three exercised against OpenSSL; `cipherSuites` changes
  the order). On Bun, AES-GCM wins a per-record micro-benchmark but costs ~21 % more CPU end to
  end (a native cipher object per record wakes Bun's mimalloc scavenger; docs/10 §6.7). `chacha: 'node'` falls back to the JS AEAD
  on Bun (no `chacha20-poly1305` in its node:crypto). ChaCha20-Poly1305 records use `dtls/chacha.ts`: a pure-JS,
  constant-time (ARX + 13-bit-limb Poly1305, no secret-dependent branches or tables),
  allocation-free AEAD that encrypts the record in the shared send buffer and decrypts in place
  in the received datagram (tag verified first); RFC 8439 vectors + millions of random cases
  against node:crypto in test/rtc/chacha.test.ts. AES-GCM stays on node:crypto (one native
  cipher object per record, key kept as a `KeyObject`; AES is never done in JS). HMAC keys (STUN
  MESSAGE-INTEGRITY local/remote, the PRF secret, the SCTP state cookie) are `KeyObject`s too:
  on Node 26 that is 6–11× cheaper per operation, neutral on Bun (docs/10 §6.7). x25519 preferred / secp256r1;
  extended_master_secret **required** (RFC 7627, fatal handshake_failure otherwise);
  renegotiation_info (initial handshake only, renegotiation refused); mandatory client
  certificate whose hash must equal the SDP `a=fingerprint` (constant-time compare; fatal
  `bad_certificate` → `onClose('dtls-error:fingerprint-mismatch')`), its CertificateVerify
  checked (ECDSA or RSA-PKCS#1, SHA-256/384/512); epochs 0/1, 48-bit sequence numbers,
  64-entry anti-replay window, records that fail AEAD are silently dropped; flight
  retransmission (1 s doubling to 8 s, and on peer retransmissions, rate-limited);
  fragmentation of our flights to the MTU and reassembly of the client's (fragmented
  ClientHello included, bounded sizes); alerts; close_notify both ways. No resumption, no
  compression, no DTLS 1.0.
* **DTLS 1.3**: Chromium 141 with `WebRTC-ForceDtls13` offers 1.3 via `supported_versions`;
  we answer a plain DTLS 1.2 ServerHello (no downgrade sentinel: we are not 1.3-capable), and
  Chromium connects with 1.2 (test/rtc/chromium-dtls.test.ts; also with the dtls13 interop
  condition after the HelloVerifyRequest was dropped).
* **DTLS record numbers and failures.** Server epoch-0 records (flight 4 and its retransmissions) are numbered from 0 without `helloVerify` (full ICE). With `helloVerify` they continue from the record sequence number of the ClientHello that carries the cookie (its low 32 bits, only when the high 16 are 0; otherwise from 0), so the client's anti-replay window does not drop flight 4 for repeating the HelloVerifyRequest's number (RFC 6347 §4.2.1). Write sequence numbers are 48-bit per epoch; running out closes the session (`dtls-error:sequence-exhausted`) instead of wrapping (RFC 6347 §4.1). A failure while resending a flight closes that session only (`dtls-error:internal-…`) and never reaches the event loop.
* **TURN relay peers** (`ice-agent.ts`): a session makes relay pairs (and permissions) for at most `MAX_RELAY_PEERS` = 4 live distinct signaled remote addresses and `MAX_RELAY_PEERS_TOTAL` = 8 over its life (a failed or evicted peer frees its slot); peer-reflexive relay pairs do not count. Cloudflare relays for only ~10 peer addresses per allocation (docs/10 §2.2), so one offer cannot use up an allocation. `IceAgent.describe()` reports `relay`. Address classes (`classifyIp`, `gather.ts`): IPv4-compatible `::a.b.c.d` is `reserved`; NAT64 `64:ff9b::/96` and 6to4 `2002::/16` take the class of the embedded IPv4 when it is not public, so `candidatePolicy: 'public'` sends them no checks.
* Self-signed ECDSA P-256 certificate built with a minimal DER encoder (`cert.ts`), one per
  process by default, generated synchronously (≈ 1 ms; `generateAsync` remains). `loadOrCreate`
  uses synchronous file I/O too: an idle room never starts the libuv thread pool for it.
* Hot path without per-packet garbage of our own: sends are synchronous, records are sealed into
  one endpoint-wide scratch buffer (replaced if the kernel ever queues a send) and sent through
  cached exact-length views; received records are decrypted in place and handed to SCTP as
  `(datagram, off, len)`. UDP I/O (`udp.ts`, `UdpIo`): on Node it talks to the socket's
  `UDPWrap` with one reused `SendWrap` (falls back to `dgram` if the internals differ); what
  remains is the `Buffer` + `rinfo` Node creates per received datagram. On Bun it uses the
  native socket held inside `dgram` (direct `send`, `reload` receive handler without `rinfo`),
  and `beginUdpBatch()`/`endUdpBatch()` collect the datagrams of one bundler flush in a per-socket
  ring (64 × 2 KiB) sent with one `sendMany` (`sendmmsg` on Linux); a no-op on Node.
