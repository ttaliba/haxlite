/**
 * Real Chromium against a server behind a (simulated) NAT: the server binds
 * 127.0.0.1 only, announces no host candidate and reaches the browser only
 * through the userspace NAT of test/rtc/nat-sim.ts (port-restricted
 * filtering: unsolicited datagrams to the NAT's external port are dropped
 * until the server has sent something to that exact address). Its srflx
 * candidate comes from a fake STUN server on the public side, queried
 * through the NAT. The browser gets a STUN server too (as the official
 * client does) so it has a usable srflx candidate.
 *
 * haxlite-rtc (full ICE) must connect thanks to its own connectivity checks;
 * the controls show the NAT really blocks (no checks → no connection), and
 * node-datachannel (`ndc`, libjuice full ICE) behind the very same NAT is the
 * reference. `npm run test:interop` (RTC_INTEROP_BACKENDS / RTC_INTEROP_CONDITIONS
 * do not apply here).
 */
import os from 'node:os';
import type { Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromiumAvailable, launchChromium, openHarnessPage } from './harness/browser.js';
import { InteropServer } from './harness/server.js';
import { PageClient } from './suite.js';
import { FakeStunServer, UdpNat, type NatOptions } from '../rtc/nat-sim.js';
import { rtcAvailable } from './harness/backends.js';

const PUBLIC = Object.values(os.networkInterfaces())
  .flat()
  .find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
const skip = !chromiumAvailable() ? 'Chromium build not found' : PUBLIC === undefined ? 'no non-loopback IPv4 interface' : !rtcAvailable() ? 'no src/rtc' : null;

interface Setup {
  srv: InteropServer;
  nat: UdpNat;
  stun: FakeStunServer;
}

async function startBehindNat(backend: 'rtc' | 'ndc', nat: NatOptions, o: { forward?: boolean; lite?: boolean } = {}): Promise<Setup> {
  const stun = await FakeStunServer.start(PUBLIC!);
  const n = new UdpNat({ insideAddress: '127.0.0.1', outsideAddress: PUBLIC!, ...nat });
  const a = await n.alias({ address: stun.address, port: stun.port });
  const stunUrl = `stun:${a.address}:${a.port}`;
  const srv = await InteropServer.start({
    backend,
    address: '127.0.0.1',
    nat: n,
    forwardRemoteCandidates: o.forward ?? true,
    rtc: o.lite
      ? // ICE-lite cannot gather: announce what the NAT would map (an external port nobody opened)
        { iceLite: true, publicAddresses: [PUBLIC!], publicPort: 9 }
      : { publicAddresses: undefined, iceServers: [stunUrl] },
    ndc: { iceServers: [stunUrl], bindAddress: '127.0.0.1' },
  });
  return { srv, nat: n, stun };
}

describe.skipIf(skip !== null)(`Chromium ⇄ server behind a simulated NAT${skip ? ` (skipped: ${skip})` : ''}`, () => {
  let browser: Browser;
  let browserReveal: Browser;
  let browserStun: FakeStunServer;
  const open: Setup[] = [];

  beforeAll(async () => {
    browser = await launchChromium();
    browserReveal = await launchChromium({ revealHostIps: true });
    browserStun = await FakeStunServer.start(PUBLIC!);
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await browserReveal?.close();
    browserStun?.close();
    for (const s of open) {
      await s.srv.close();
      s.nat.close();
      s.stun.close();
    }
  }, 60_000);

  async function joinThrough(s: Setup, b: Browser, withStun: boolean) {
    open.push(s);
    const pc = new PageClient(await openHarnessPage(b, s.srv.url));
    const iceServers = withStun ? [{ urls: `stun:${browserStun.address}:${browserStun.port}` }] : [];
    const [j] = await pc.page.evaluate(
      ([ice]) => (globalThis as unknown as { hx: { connect(n: number, o: object): Promise<({ tag: string; index: number } | null)[]> } }).hx.connect(1, { iceServers: ice }),
      [iceServers] as const,
    );
    return { pc, j, errors: await pc.errors() };
  }

  async function expectData(s: Setup, pc: PageClient, j: { tag: string; index: number }) {
    const p = await s.srv.peer(j.tag);
    await p.whenOpen(10_000, true);
    p.burst(0, 20, 64);
    for (let i = 0; i < 100; i++) {
      const st = await pc.stats(j.index);
      if (st.rx.ch[0]!.data >= 20) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect((await pc.stats(j.index)).rx.ch[0]!.data).toBe(20);
    // everything went through the NAT: the server sees the browser at a NAT alias
    expect(p.remoteAddress).toBe('127.0.0.1');
    expect(s.nat.stats.in).toBeGreaterThan(10);
    expect(s.nat.stats.out).toBeGreaterThan(10);
    if (process.env.RTC_INTEROP_VERBOSE) console.log('[nat]', JSON.stringify(s.nat.stats), JSON.stringify(s.srv.handle.stats()));
  }

  it('rtc (full ICE), port-restricted NAT, browser with mDNS host + STUN srflx', async () => {
    const s = await startBehindNat('rtc', {});
    const { pc, j, errors } = await joinThrough(s, browser, true);
    expect(j, `join failed: ${errors.join('; ')} / ${s.srv.errors.join('; ')}`).toBeTruthy();
    await expectData(s, pc, j!);
    const st = s.srv.handle.stats() as { ice: { checksSent: number; checksSucceeded: number }; reflexive: string[] };
    expect(st.reflexive[0]).toMatch(new RegExp(`^${PUBLIC!.replace(/\./g, '\\.')}:`));
    expect(st.ice.checksSucceeded).toBeGreaterThan(0);
  }, 30_000);

  it('rtc (full ICE), port-restricted NAT, browser revealing its host IP, no STUN', async () => {
    const s = await startBehindNat('rtc', {});
    const { pc, j, errors } = await joinThrough(s, browserReveal, false);
    expect(j, `join failed: ${errors.join('; ')} / ${s.srv.errors.join('; ')}`).toBeTruthy();
    await expectData(s, pc, j!);
  }, 30_000);

  it('rtc (full ICE), symmetric NAT (address+port-dependent mapping)', async () => {
    const s = await startBehindNat('rtc', { mapping: 'address-port-dependent' });
    const { pc, j, errors } = await joinThrough(s, browser, true);
    expect(j, `join failed: ${errors.join('; ')} / ${s.srv.errors.join('; ')}`).toBeTruthy();
    await expectData(s, pc, j!);
  }, 30_000);

  it('control: rtc full ICE without the browser candidates (no checks possible) fails behind the NAT', async () => {
    const s = await startBehindNat('rtc', {}, { forward: false });
    const { j } = await joinThrough(s, browser, true);
    expect(j).toBeNull();
    expect(s.nat.stats.dropped).toBeGreaterThan(0);
  }, 30_000);

  it('control: rtc ICE-lite behind the NAT fails', async () => {
    const s = await startBehindNat('rtc', {}, { lite: true });
    const { j } = await joinThrough(s, browser, true);
    expect(j).toBeNull();
  }, 30_000);

  it('reference: ndc (libdatachannel full ICE) behind the same NAT', async () => {
    const s = await startBehindNat('ndc', {});
    const { pc, j, errors } = await joinThrough(s, browser, true);
    expect(j, `join failed: ${errors.join('; ')} / ${s.srv.errors.join('; ')}`).toBeTruthy();
    await expectData(s, pc, j!);
  }, 30_000);
});
