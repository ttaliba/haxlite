# src/rtc — haxlite-rtc

Minimal pure-TypeScript WebRTC **data-channel** stack for servers with a public IP (haxlite
Edge, dedicated hosts). Replaces node-datachannel/libdatachannel there. No native addons:
`node:dgram` + `node:crypto` only (Node ≥ 22).

Scope (HaxBall needs nothing else): the browser is always the **offerer** and the DTLS
**client**; we are an **ICE-lite**, **DTLS 1.2 server**, **SCTP** endpoint with the three
pre-negotiated channels of the official client (`ro` id 0, `ru` id 1, `uu` id 2, no DCEP).

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
  publicAddresses: ['203.0.113.7'], // the ONLY addresses ever put in SDP/candidates (IP literals, v4 and/or v6)
  publicPort: 40000,              // optional: advertised port when a 1:1 NAT maps it (default: bound port)
  certificate: RtcCertificate.generate(), // optional; default: RtcCertificate.processDefault() (one per process, keygen off-thread)
  certificateFile: '/var/lib/haxlite/dtls.pem', // optional: load/persist the identity (RtcCertificate.loadOrCreate)
  cipherSuites: ['chacha20', 'aes128gcm', 'aes256gcm'], // DTLS server preference (this is the default)
  idleTimeoutMs: 30_000,          // no ICE consent (authenticated binding) for this long → close('timeout')
  handshakeTimeoutMs: 20_000,     // session not open this long after createSession → close('handshake-timeout')
  maxSessions: 10_000,
});

const s = ep.createSession(offerSdp);   // throws RtcSdpError on an unusable offer
s.answerSdp;            // complete answer (a=ice-lite, candidates included, a=end-of-candidates)
s.localCandidates;      // ['candidate:1 1 udp 2130706431 203.0.113.7 40000 typ host', …] (no "a=")
s.mid;                  // mid of the data m-line (for trickle signaling)
s.addRemoteCandidate('candidate:…');  // optional hint only (ICE-lite: peer-reflexive is normal)
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
  close.
* **DTLS 1.2 server** (RFC 6347, `dtls/server.ts`): HMAC cookie (HelloVerifyRequest, bound to
  the remote address and the ClientHello parameters) before any handshake state;
  `TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256` preferred — Chromium 141 offers and
  negotiates it — then AES_128_GCM / AES_256_GCM (all three exercised against OpenSSL;
  `cipherSuites` changes the order). ChaCha20-Poly1305 records use `dtls/chacha.ts`: a pure-JS,
  constant-time (ARX + 13-bit-limb Poly1305, no secret-dependent branches or tables),
  allocation-free AEAD that encrypts the record in the shared send buffer and decrypts in place
  in the received datagram (tag verified first); RFC 8439 vectors + millions of random cases
  against node:crypto in test/rtc/chacha.test.ts. AES-GCM stays on node:crypto (one native
  cipher object per record; AES is never done in JS). x25519 preferred / secp256r1;
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
  we answer a plain DTLS 1.2 ServerHello (no downgrade sentinel: we are not 1.3-capable) after
  a HelloVerifyRequest, and Chromium connects with 1.2 (test/rtc/chromium-dtls.test.ts).
* Self-signed ECDSA P-256 certificate built with a minimal DER encoder (`cert.ts`); key
  generation and signing on the libuv thread pool (`generateAsync`), one per process by default.
* Hot path without per-packet garbage of our own: sends are synchronous (dgram `lookup` option =
  literal pass-through, no `dns.lookup`/`nextTick` per datagram), records are sealed into one
  endpoint-wide scratch buffer (replaced if the kernel ever queues a send) and sent through cached
  exact-length views; received records are decrypted in place and handed to SCTP as
  `(datagram, off, len)`. What remains is Node's own `dgram` bookkeeping per datagram.
