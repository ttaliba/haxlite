/**
 * The per-session relay peer cap counts live relay peers: once the relay
 * pairs of earlier candidates have failed, a candidate trickled after a
 * network change still gets a relay pair. A lifetime cap bounds the churn.
 */
import { describe, expect, it } from 'vitest';
import type { UdpIo } from '../../src/rtc/udp.js';
import { parseCandidate } from '../../src/rtc/sdp.js';
import { IceAgent, IceScheduler, MAX_RELAY_PEERS, MAX_RELAY_PEERS_TOTAL, type RelayIo } from '../../src/rtc/ice-agent.js';

const cand = (address: string, port: number) => parseCandidate(`candidate:1 1 udp 1686052607 ${address} ${port} typ srflx raddr 0.0.0.0 rport 0 generation 0`)!;

function harness(relayOnly: boolean) {
  let t = 1_000_000;
  const sock = { tag: 'sock' } as unknown as UdpIo;
  const relay = { family: 4, ready: true, permit: () => {}, send: () => true };
  const io = relay as unknown as RelayIo;
  const sched = new IceScheduler({
    send: () => {},
    now: () => t,
    sockets: [{ sock, family: 4, bindAddress: '0.0.0.0' }],
    policy: 'public',
    relays: [io],
    ...(relayOnly ? { relayOnly: true } : null),
  });
  const agent = new IceAgent(sched, { localUfrag: 'ours', remoteUfrag: 'cLnT', remoteKey: Buffer.from('clientpasswordclientpwd0'), onCheckSucceeded() {}, onConsent() {} }, [io]);
  /** Runs the checks (nobody answers) until every pair has failed. */
  const failAll = () => {
    for (let i = 0; i < 2000 && agent.describe().some((p) => p.state !== 'failed'); i++) {
      t += 50;
      agent.tick(t);
    }
    expect(agent.describe().every((p) => p.state === 'failed')).toBe(true);
  };
  const relayPairs = () => agent.describe().filter((p) => p.relay);
  return { agent, sched, failAll, relayPairs };
}

describe('relay peers: live count', () => {
  for (const relayOnly of [true, false]) {
    it(`relay${relayOnly ? '-only' : ' + direct'}: a candidate trickled after the earlier ones failed gets a relay pair`, () => {
      const h = harness(relayOnly);
      try {
        for (let i = 0; i < MAX_RELAY_PEERS; i++) h.agent.addRemote(cand(`198.51.100.${i + 1}`, 5000));
        expect(h.relayPairs().length).toBe(MAX_RELAY_PEERS);
        // While they are live, a new one is still refused.
        h.agent.addRemote(cand('203.0.113.50', 6000));
        expect(h.relayPairs().some((p) => p.address === '203.0.113.50')).toBe(false);
        h.failAll();
        // New network: its srflx arrives by trickle.
        h.agent.addRemote(cand('203.0.113.77', 7000));
        const fresh = h.relayPairs().filter((p) => p.address === '203.0.113.77');
        expect(fresh.length).toBe(1);
        expect(fresh[0]!.state).toBe('waiting');
      } finally {
        h.agent.close();
        h.sched.close();
      }
    });
  }

  it('a session cannot churn through more than the lifetime cap of relay peers', () => {
    const h = harness(true);
    try {
      let k = 0;
      for (let round = 0; round < 6; round++) {
        for (let i = 0; i < MAX_RELAY_PEERS; i++, k++) h.agent.addRemote(cand(`198.51.${100 + (k >> 8)}.${(k & 0xff) + 1}`, 5000));
        h.failAll();
      }
      expect(h.relayPairs().length).toBe(MAX_RELAY_PEERS_TOTAL);
    } finally {
      h.agent.close();
      h.sched.close();
    }
  });
});
