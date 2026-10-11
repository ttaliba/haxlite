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
import { RtcEndpoint, RtcCertificate } from './rtc/index.js';

const ep = await RtcEndpoint.listen({
  port: 40000,                    // default 0 (ephemeral)
  address: '0.0.0.0',             // bind address; default: wildcard of the family of publicAddresses
  publicAddresses: ['203.0.113.7'], // the ONLY addresses ever put in SDP/candidates (IP literals, v4 and/or v6)
  publicPort: 40000,              // optional: advertised port when a 1:1 NAT maps it (default: bound port)
  certificate: await RtcCertificate.generate(), // optional; default: one generated per endpoint
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
s.send(0, bytes);       // false if not open / buffer full; bytes may be reused after return
s.remoteAddress;        // { address, port } of the nominated pair, or null
s.close();              // sends SCTP ABORT/close_notify best effort, idempotent
await ep.close();       // closes every session ('endpoint-closed') and the socket(s)
ep.stats();             // counters (see RtcEndpointStats in index.ts)
```

`onClose` reasons: `'closed'` (local, not reported), `'remote-close'` (close_notify /
SCTP shutdown), `'timeout'` (ICE consent), `'handshake-timeout'`, `'dtls-alert:<n>'`
(fatal alert received), `'dtls-error:<what>'` (we aborted the handshake: e.g.
`'dtls-error:fingerprint-mismatch'`), `'sctp:<reason>'`, `'endpoint-closed'`.

## Contract with R2 — `SctpAssociation` (`src/rtc/sctp/index.ts`)

Types are in `src/rtc/types.ts` (`SctpAssociationOptions`, `SctpAssociationLike`); R2's class
must satisfy them structurally:

```ts
export class SctpAssociation implements SctpAssociationLike {
  constructor(opts: {
    send(packet: Uint8Array): void;     // one SCTP packet → one DTLS record. Synchronous: the
                                        // bytes are encrypted before return, R2 may reuse the buffer.
    channels: { id: number; ordered: boolean; maxRetransmits?: number }[];
       // always [{id:0,ordered:true},{id:1,ordered:false},{id:2,ordered:false,maxRetransmits:0}]
    maxMessageSize: number;             // min(offer a=max-message-size, ours = 262144)
    localPort?: number;                 // our sctp-port (5000)
    remotePort?: number;                // offer a=sctp-port (default 5000)
    onMessage(channelId: number, data: Uint8Array): void; // receiver may keep `data`
    onOpen(): void;                     // association established (channels usable)
    onClose(reason: string): void;      // ABORT / SHUTDOWN / timeout (once)
  });
  input(packet: Uint8Array): void;      // one decrypted DTLS application-data record; R2 may
                                        // keep views into it (it is freshly allocated per record)
  send(channelId: number, data: Uint8Array): boolean; // false when not open / buffer full
  close(): void;                        // graceful/abort, no onClose callback afterwards
}
```

* The association is constructed **when the DTLS handshake completes** (the browser, as DTLS
  client, normally sends INIT right away; R2 may also send its own INIT at construction).
* Path MTU: assume 1200 bytes of SCTP packet (DTLS adds ≤ 29 bytes, IP/UDP ≤ 48).
* All callbacks run on the main thread from within `input()`/timers; exceptions thrown by
  `onMessage` are caught by RtcSession.
* Until R2's module exists, `RtcEndpoint.listen({ dataLayer })` accepts any factory
  `(opts) => SctpAssociationLike` (tests use a raw echo layer: one DTLS record = one message on
  channel 0).

## Design notes

* **ICE-lite** (RFC 8445 §2.5): we never send checks; we answer Binding requests whose
  USERNAME is `ourUfrag:theirUfrag`, with valid MESSAGE-INTEGRITY (HMAC-SHA1, our pwd) and
  FINGERPRINT, from a controlling agent. Each authenticated source becomes a *validated*
  address of that session; DTLS is only accepted from validated addresses. USE-CANDIDATE
  nominates (= `remoteAddress`). NAT rebinding: only through a new authenticated binding.
  Consent: the browser keeps sending bindings (~every 2.5–5 s); none for `idleTimeoutMs` →
  close.
* **DTLS 1.2 server** (RFC 6347): stateless HMAC cookie (HelloVerifyRequest) before any
  allocation, `TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256` (+ AES_256_GCM_SHA384,
  CHACHA20_POLY1305), x25519/secp256r1, extended_master_secret required (RFC 7627),
  renegotiation_info, mandatory client certificate whose hash must equal the SDP
  `a=fingerprint` (else fatal `bad_certificate`), CertificateVerify checked, 64-entry
  anti-replay window per epoch, retransmission with exponential backoff, fragmentation and
  reassembly. A DTLS 1.3-capable browser (supported_versions) is answered with 1.2.
* Self-signed ECDSA P-256 certificate built with a minimal DER encoder (`cert.ts`).
