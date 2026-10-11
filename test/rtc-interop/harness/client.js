// Browser side of the haxlite-rtc interop harness (plain JS, runs in the page).
//
// The WebRTC usage below is a line-by-line transcription of the official
// HaxBall web client (game-min.js, classes `Ca` = negotiating
// RTCPeerConnection, `dc` = join through the master WebSocket, `Pb` =
// established connection; see docs/01-red-y-salas.md §2.3–§3):
//
//  * `new RTCPeerConnection({iceServers}, {mandatory:{OfferToReceiveAudio:false,OfferToReceiveVideo:false}})`
//  * three channels created up front, in order, `{id: i, negotiated: true, ordered}`
//    plus `maxRetransmits: 0` when unreliable, labels ro/ru/uu, `binaryType = 'arraybuffer'`
//  * offer = `createOffer()` result (NOT localDescription: no candidates inside),
//    `setLocalDescription`, wait for gathering ≤ 1000 ms, then open the WS and send
//    the offer + candidates gathered so far, trickle the rest, `[0]` when gathering ends
//  * negotiation timeout 10 s from WS open, 4 s once the answer arrives (10 s on a
//    "reverse" retry); any channel close/message during negotiation = failure
//  * remote answer candidates are added after setRemoteDescription resolves;
//    trickled ones straight away (`addIceCandidate`, errors ignored only in `Rj`)
//  * connected = channel 0 `open`; afterwards (`Pb`): 10 s inactivity timeout
//    (any message on any channel refreshes it), ICE `closed`/`failed` or any
//    channel `close` → `pc.close()`, sends on a non-open channel ≠ 0 fall back to 0.
//
// Signaling uses JSON over a local WebSocket instead of the master's
// `[u8 type] + deflateRaw(...)` framing; the content and timing are the same.
//
// Harness additions (not in the official client): a tag in the signaling
// URL so the server can match peers, receive statistics, and a control
// WebSocket used by the self-test page.
import { Kind, Recorder, makeMsg, now, summarize } from './wire.js';

export const CHANNELS = [
  { name: 'ro', reliable: true, ordered: true },
  { name: 'ru', reliable: true, ordered: false },
  { name: 'uu', reliable: false, ordered: false },
];
const LEGACY_CONSTRAINTS = { mandatory: { OfferToReceiveAudio: false, OfferToReceiveVideo: false } };
export const OFFICIAL_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

/** `Ec.Zm(promise, ms)`: rejects after ms. */
function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Official class `Ca`: the negotiating RTCPeerConnection. */
class Negotiator {
  constructor(iceServers, channels) {
    this.timer = null;
    this.remoteCandDelay = 0; // `xk` (2500 on the host side for reverse joins)
    this.candidates = []; // `ig`
    this.channels = []; // `cd`
    this.onOpen = null; // `Hd`
    this.onCandidate = null; // `xg`
    this.onFail = null; // `kd`
    this.pc = new RTCPeerConnection({ iceServers }, LEGACY_CONSTRAINTS);
    let resolveGathered;
    this.gathered = new Promise((r) => (resolveGathered = r)); // `jg`
    this.pc.onicecandidate = (e) => {
      if (e.candidate == null) resolveGathered(this.candidates);
      else {
        const c = e.candidate;
        if (c.candidate != null && c.candidate !== '') {
          if (this.onCandidate != null) this.onCandidate(c);
          this.candidates.push(c);
        }
      }
    };
    for (const ch of channels) this.addChannel(ch);
  }
  /** `bj`: (re)arm the negotiation timeout. */
  arm(ms) {
    if (ms == null) ms = 10000;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail('timeout'), ms);
  }
  /** `No`: offer + gathering (≤ 1 s). */
  async createOffer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    try {
      await withTimeout(this.gathered, 1000);
    } catch {}
    return offer;
  }
  /** `Mo`. */
  addChannel(spec) {
    const id = this.channels.length;
    const init = { id, negotiated: true, ordered: spec.ordered };
    if (!spec.reliable) init.maxRetransmits = 0;
    const dc = this.pc.createDataChannel(spec.name, init);
    dc.binaryType = 'arraybuffer';
    if (id === 0)
      dc.onopen = () => {
        if (this.onOpen != null) this.onOpen();
      };
    dc.onclose = () => this.fail('channel-closed');
    dc.onmessage = () => this.fail('early-message');
    this.channels.push(dc);
  }
  /** `Rj`. */
  addCandidateLater(c) {
    setTimeout(() => {
      if (this.pc.iceConnectionState !== 'closed' && this.pc.signalingState !== 'closed') this.pc.addIceCandidate(c).catch(() => {});
    }, this.remoteCandDelay);
  }
  /** `Xh`. */
  fail(why) {
    const f = this.onFail;
    this.close();
    if (f != null) f(why);
  }
  /** `la`. */
  close() {
    this.detach();
    this.pc.close();
  }
  /** `nk`. */
  detach() {
    clearTimeout(this.timer);
    this.onOpen = this.onCandidate = this.onFail = null;
    this.pc.onicecandidate = null;
    this.pc.ondatachannel = null;
    this.pc.onsignalingstatechange = null;
    this.pc.oniceconnectionstatechange = null;
    for (const dc of this.channels) dc.onopen = dc.onclose = dc.onmessage = null;
  }
}

/** Official class `Pb`: an established connection. */
export class Connection {
  constructor(neg, opts) {
    neg.detach();
    this.pc = neg.pc;
    this.channels = neg.channels;
    this.open = true; // `Ed`
    this.inactivityMs = opts.inactivityMs ?? 10000; // `pr`
    this.lastRx = performance.now(); // `Xm`
    this.closeReason = null;
    this.onClose = null; // `tf`
    this.onMessage = null; // `zg` (harness: (chIndex, data))
    this.rec = new Recorder();
    this.rec.verify = opts.verify ?? true;
    this.connectedAt = now();
    this.sendSeq = [0, 0, 0];
    this.sendFailures = 0;
    this.fallbacks = 0;
    if (Number.isFinite(this.inactivityMs)) {
      const tick = () => {
        const left = this.inactivityMs - (performance.now() - this.lastRx);
        if (left <= 0) this.close('inactivity');
        else {
          clearTimeout(this.idleTimer);
          this.idleTimer = setTimeout(tick, left + 1000);
        }
      };
      tick();
    }
    this.pc.oniceconnectionstatechange = () => {
      const s = this.pc.iceConnectionState;
      if (s === 'closed' || s === 'failed') this.close('ice-' + s);
    };
    this.channels.forEach((dc, i) => {
      dc.onmessage = (e) => {
        if (!this.open) return;
        this.lastRx = performance.now();
        const d = e.data;
        const bytes = typeof d === 'string' ? d : new Uint8Array(d);
        this.rec.record(i, bytes);
        if (this.onMessage != null) this.onMessage(i, bytes);
      };
      dc.onclose = () => this.close('channel-closed:' + i);
    });
  }
  /** `Vb`: send on channel `i`, falling back to channel 0 if `i` is not open. */
  send(i, bytes) {
    if (!this.open) return false;
    let dc = this.channels[i];
    if (i !== 0 && dc.readyState !== 'open') {
      dc = this.channels[0];
      this.fallbacks++;
    }
    if (dc.readyState !== 'open') return false;
    try {
      dc.send(bytes);
      return true;
    } catch (e) {
      this.sendFailures++;
      console.log(String(e));
      return false;
    }
  }
  /** Sends `n` Data messages of `size` bytes on channel `i` (seq continues per channel). */
  burst(i, n, size) {
    let ok = 0;
    for (let k = 0; k < n; k++) if (this.send(i, makeMsg(Kind.Data, this.sendSeq[i]++, size))) ok++;
    return ok;
  }
  /** `la`. */
  close(reason = 'local') {
    clearTimeout(this.idleTimer);
    if (!this.open) return;
    this.open = false;
    this.closeReason = reason;
    this.pc.close();
    if (this.onClose != null) this.onClose(reason);
  }
  /** Close one data channel only (browser-side channel close scenario). */
  closeChannel(i) {
    this.channels[i].close();
  }
  state() {
    return {
      open: this.open,
      closeReason: this.closeReason,
      ice: this.pc.iceConnectionState,
      conn: this.pc.connectionState,
      channels: this.channels.map((d) => d.readyState),
      sent: this.sendSeq.slice(),
      sendFailures: this.sendFailures,
      fallbacks: this.fallbacks,
      buffered: this.channels.map((d) => d.bufferedAmount),
      maxMessageSize: this.pc.sctp ? this.pc.sctp.maxMessageSize : null,
    };
  }
}

/**
 * Official class `dc`: joins through the signaling WebSocket. Resolves with a
 * {@link Connection} or rejects with the failure reason.
 */
export function join(opts) {
  const iceServers = opts.iceServers ?? [];
  const reverse = opts.reverse ?? false; // `yh`
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    let ws = null;
    let answered = false; // `Jh`
    let done = false;
    let neg = new Negotiator(iceServers, CHANNELS);
    const cleanup = () => {
      if (ws != null) {
        ws.onclose = ws.onmessage = ws.onerror = ws.onopen = null;
        ws.close();
        ws = null;
      }
      if (neg != null) {
        neg.close();
        neg = null;
      }
    };
    const fail = (why) => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error(why));
    };
    const sendSig = (m) => {
      if (ws != null) ws.send(JSON.stringify(m));
    };
    neg.onFail = (why) => fail('negotiation:' + why);
    neg.onOpen = () => {
      if (done) return;
      done = true;
      const c = new Connection(neg, opts);
      c.joinMs = performance.now() - t0;
      neg = null;
      cleanup();
      resolve(c);
    };
    (async () => {
      try {
        const offer = await neg.createOffer();
        if (done) return;
        ws = new WebSocket(opts.signalUrl + (opts.signalUrl.includes('?') ? '&' : '?') + 'tag=' + encodeURIComponent(opts.tag));
        ws.binaryType = 'arraybuffer';
        ws.onclose = (e) => {
          if (!answered) fail('ws-close:' + e.code);
        };
        ws.onerror = () => {
          if (!answered) fail('ws-error');
        };
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data);
          if (m.t === 'answer') {
            // `Zh`
            neg.arm(reverse ? 10000 : 4000);
            answered = true;
            const cands = m.cands.map((c) => new RTCIceCandidate(c));
            neg.pc
              .setRemoteDescription(new RTCSessionDescription({ sdp: m.sdp, type: 'answer' }))
              .then(() => {
                for (const c of cands) neg.pc.addIceCandidate(c);
              })
              .catch(() => fail('set-remote'));
          } else if (m.t === 'cand') {
            // `Yh`
            if (neg != null) neg.pc.addIceCandidate(new RTCIceCandidate(m.c));
          }
        };
        ws.onopen = () => {
          neg.arm();
          // `Qi`: [1][u8 reverse][sdp][candidates][joinData]
          sendSig({ t: 'offer', reverse: reverse ? 1 : 0, sdp: offer.sdp, cands: neg.candidates.map((c) => c.toJSON()), version: 9 });
          neg.onCandidate = (c) => sendSig({ t: 'cand', c: c.toJSON() }); // `Ni`
          neg.gathered.then(() => sendSig({ t: 'done' })); // `Uc(0)`
        };
      } catch (e) {
        fail('offer:' + e);
      }
    })();
  });
}

/** Harness driver exposed as `window.hx` (called by Playwright and the self-test page). */
export class Harness {
  constructor(base) {
    this.base = base; // e.g. ws://127.0.0.1:port
    this.conns = [];
    this.errors = [];
    this.bench = null;
  }
  /** Joins `n` connections in parallel; returns their indexes (or error strings). */
  async connect(n, opts = {}) {
    const tagPrefix = opts.tagPrefix ?? 'p' + Math.random().toString(36).slice(2, 8);
    const jobs = [];
    for (let k = 0; k < n; k++) {
      const tag = `${tagPrefix}-${this.conns.length + k}`;
      jobs.push(
        join({ ...opts, signalUrl: this.base + '/client', tag }).then(
          (c) => {
            c.tag = tag;
            return c;
          },
          (e) => {
            this.errors.push(tag + ': ' + e.message);
            return null;
          },
        ),
      );
    }
    const out = await Promise.all(jobs);
    const res = [];
    for (const c of out) {
      if (c == null) {
        res.push(null);
        continue;
      }
      this.conns.push(c);
      res.push({ index: this.conns.length - 1, tag: c.tag, joinMs: c.joinMs });
    }
    return res;
  }
  burst(i, ch, n, size) {
    return this.conns[i].burst(ch, n, size);
  }
  stats(i) {
    const c = this.conns[i];
    return { tag: c.tag, state: c.state(), rx: c.rec.snapshot(false) };
  }
  allStats() {
    return this.conns.map((_, i) => this.stats(i));
  }
  close(i) {
    this.conns[i].close('test');
  }
  closeChannel(i, ch) {
    this.conns[i].closeChannel(ch);
  }

  /**
   * HaxBall-like client traffic on every open connection (official cadence,
   * docs/04): ping on uu every `pingMs` (1 s), inputs on ro at `inputHz`
   * (input changes, Poisson), 13–20 B messages. Latency samples are kept.
   */
  startBench({ pingMs = 1000, inputHz = 8, inputSize = 17 } = {}) {
    this.stopBench();
    const timers = [];
    this.conns.forEach((c, idx) => {
      if (!c.open) return;
      c.rec.verify = false;
      c.rec.origin = (Math.random() * 0x7fffffff) | 0;
      c.rec.resetLatency();
      let pingSeq = 0;
      let inSeq = 0;
      const jitterStart = Math.random() * pingMs;
      timers.push(
        setTimeout(() => {
          timers.push(setInterval(() => c.send(2, makeMsg(Kind.Ping, pingSeq++, 17)), pingMs));
        }, jitterStart),
      );
      const scheduleInput = () => {
        const dt = (-Math.log(1 - Math.random()) * 1000) / inputHz;
        timers.push(
          setTimeout(() => {
            if (!c.open) return;
            const m = makeMsg(Kind.Input, inSeq++, Math.max(17, inputSize));
            new DataView(m.buffer).setUint32(13, c.rec.origin);
            c.send(0, m);
            scheduleInput();
          }, dt),
        );
      };
      scheduleInput();
    });
    this.bench = { timers };
  }
  stopBench() {
    if (this.bench == null) return;
    for (const t of this.bench.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.bench = null;
  }
  /** Latency samples of every connection, summarized (ms) plus raw arrays if asked. */
  benchLatency(raw = false) {
    const all = { ping: [], input: [], oneWay: [] };
    for (const c of this.conns) {
      all.ping.push(...c.rec.lat.ping);
      all.input.push(...c.rec.lat.input);
      all.oneWay.push(...c.rec.lat.oneWay);
    }
    const out = { ping: summarize(all.ping), input: summarize(all.input), oneWay: summarize(all.oneWay) };
    if (raw) out.raw = all;
    return out;
  }
  closedCount() {
    return this.conns.filter((c) => !c.open).length;
  }
}
