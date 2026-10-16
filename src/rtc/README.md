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
  iceServers: ['stun:stun.l.google.com:19302'], // srflx gathering (default none; TURN entries ignored)
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
s.close();              // sends SCTP ABORT/close_notify best effort, idempotent
await ep.close();       // closes every session ('endpoint-closed') and the socket(s)
ep.stats();             // counters (see RtcEndpointStats in index.ts)
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
