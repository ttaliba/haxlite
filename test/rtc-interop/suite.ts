/**
 * Real-browser interop scenarios, shared by every backend × network
 * condition. Run with `npm run test:interop` (env: RTC_INTEROP_BACKENDS=ndc,rtc,
 * RTC_INTEROP_CONDITIONS=loopback4,eth4,loopback6,lossy,dtls13, RTC_INTEROP_IDLE=0 to
 * skip the 40 s consent-freshness tests).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rtcAvailable, type BackendKind } from './harness/backends.js';
import { chromiumAvailable, launchChromium, openHarnessPage } from './harness/browser.js';
import { InteropServer, type ServerPeer } from './harness/server.js';
import type { ImpairOptions } from './harness/udp-proxy.js';
import type { ChannelStats, RecorderSnapshot } from './harness/wire.js';

export interface Condition {
  name: string;
  address: string;
  impair: ImpairOptions | null;
  /** Extra Chromium flags. */
  browserArgs?: string[];
  /** Reason to skip on this machine, or null. */
  skip: string | null;
}

/** 5 % loss, 5 ms + U(0, 30 ms) one-way delay, 2 % forced reorder, 1 % duplication (each direction). */
export const LOSSY: ImpairOptions = { loss: 0.05, delayMs: 5, jitterMs: 30, reorder: 0.02, reorderDelayMs: 25, duplicate: 0.01, seed: 0x4a5b };

export function conditions(): Condition[] {
  const ifs = os.networkInterfaces();
  const eth4 = Object.values(ifs)
    .flat()
    .find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
  const has6 = Object.values(ifs)
    .flat()
    .some((a) => a && a.family === 'IPv6' && a.address === '::1');
  const all: Condition[] = [
    { name: 'loopback4', address: '127.0.0.1', impair: null, skip: null },
    { name: 'eth4', address: eth4 ?? '0.0.0.0', impair: null, skip: eth4 ? null : 'no non-loopback IPv4 interface' },
    { name: 'loopback6', address: '::1', impair: null, skip: has6 ? null : 'IPv6 disabled on this machine (no ::1)' },
    { name: 'lossy', address: '127.0.0.1', impair: LOSSY, skip: null },
    // Chromium offering DTLS 1.3 (field trial; the default in upcoming releases)
    { name: 'dtls13', address: '127.0.0.1', impair: null, browserArgs: ['--force-fieldtrials=WebRTC-ForceDtls13/Enabled/'], skip: null },
  ];
  const want = process.env.RTC_INTEROP_CONDITIONS?.split(',');
  return want ? all.filter((c) => want.includes(c.name)) : all;
}

export function backendSkip(kind: BackendKind): string | null {
  const want = process.env.RTC_INTEROP_BACKENDS?.split(',');
  if (want && !want.includes(kind)) return 'not selected (RTC_INTEROP_BACKENDS)';
  if (!chromiumAvailable()) return 'Chromium build not found';
  if (kind === 'rtc' && !rtcAvailable()) return 'src/rtc/index.ts or src/rtc/sctp/index.ts not present yet';
  return null;
}

export async function until(fn: () => boolean | Promise<boolean>, timeoutMs: number, stepMs = 50): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Measured facts (close-detection times, uu delivery…), written to $RTC_INTEROP_REPORT (JSON) if set. */
const observations: Record<string, unknown>[] = [];
function observe(o: Record<string, unknown>): void {
  observations.push({ ...o, at: new Date().toISOString() });
  if (process.env.RTC_INTEROP_VERBOSE) console.log('[observe]', JSON.stringify(o));
}
afterAll(() => {
  const f = process.env.RTC_INTEROP_REPORT;
  if (!f || observations.length === 0) return;
  let prev: unknown[] = [];
  try {
    prev = JSON.parse(readFileSync(f, 'utf8')) as unknown[];
  } catch {}
  writeFileSync(f, JSON.stringify([...prev, ...observations], null, 1));
});

interface JoinResult {
  index: number;
  tag: string;
  joinMs: number;
}
interface PageStats {
  tag: string;
  state: {
    open: boolean;
    closeReason: string | null;
    ice: string;
    conn: string;
    channels: string[];
    sent: number[];
    sendFailures: number;
    fallbacks: number;
    buffered: number[];
    maxMessageSize: number | null;
  };
  rx: RecorderSnapshot;
}

type Hx = {
  connect(n: number, o?: object): Promise<(JoinResult | null)[]>;
  burst(i: number, ch: number, n: number, size: number): number;
  stats(i: number): PageStats;
  close(i: number): void;
  closeChannel(i: number, ch: number): void;
  errors: string[];
};

/** Typed page handle. */
export class PageClient {
  constructor(readonly page: Page) {}
  connect(n: number, opts: { inactivityMs?: number | null } = {}): Promise<(JoinResult | null)[]> {
    return this.page.evaluate(
      ([n, o]) => {
        const hx = (globalThis as unknown as { hx: Hx }).hx;
        const oo = { ...o, inactivityMs: o.inactivityMs === null ? Infinity : o.inactivityMs };
        return hx.connect(n, oo);
      },
      [n, { inactivityMs: opts.inactivityMs === undefined ? 10_000 : opts.inactivityMs }] as const,
    );
  }
  burst(i: number, ch: number, n: number, size: number): Promise<number> {
    return this.page.evaluate(([i, ch, n, size]) => (globalThis as unknown as { hx: Hx }).hx.burst(i, ch, n, size), [i, ch, n, size] as const);
  }
  stats(i: number): Promise<PageStats> {
    return this.page.evaluate((i) => (globalThis as unknown as { hx: Hx }).hx.stats(i), i);
  }
  close(i: number): Promise<void> {
    return this.page.evaluate((i) => (globalThis as unknown as { hx: Hx }).hx.close(i), i);
  }
  closeChannel(i: number, ch: number): Promise<void> {
    return this.page.evaluate(([i, ch]) => (globalThis as unknown as { hx: Hx }).hx.closeChannel(i, ch), [i, ch] as const);
  }
  errors(): Promise<string[]> {
    return this.page.evaluate(() => (globalThis as unknown as { hx: Hx }).hx.errors);
  }
}

/** Expected delivery semantics of one channel after `sent` Data messages. */
function checkChannel(ch: number, s: ChannelStats, sent: number, lossy: boolean, where: string): void {
  const ctx = `${where} ch${ch} ${JSON.stringify(s)}`;
  expect(s.corrupt, ctx).toBe(0);
  expect(s.strings, ctx).toBe(0);
  if (ch === 0) {
    expect(s.data, ctx).toBe(sent);
    expect(s.dups, ctx).toBe(0);
    expect(s.reordered, ctx).toBe(0);
  } else if (ch === 1) {
    expect(s.data, ctx).toBe(sent);
    expect(s.dups, ctx).toBe(0);
  } else {
    expect(s.dups, ctx).toBe(0);
    expect(s.data, ctx).toBeLessThanOrEqual(sent);
    // unreliable: nothing is retransmitted; on clean loopback nearly everything arrives
    expect(s.data, ctx).toBeGreaterThanOrEqual(Math.floor(sent * (lossy ? 0.5 : 0.9)));
  }
}

export function defineInteropSuite(kind: BackendKind): void {
  const bskip = backendSkip(kind);
  for (const cond of conditions()) {
    const skip = bskip ?? cond.skip;
    const lossy = cond.impair !== null;
    describe.skipIf(skip !== null)(`${kind} × ${cond.name}${skip ? ` (skipped: ${skip})` : ''}`, () => {
      let browser: Browser;
      let srv: InteropServer;
      let pc: PageClient;
      const T = lossy ? 30_000 : 10_000; // delivery timeouts

      beforeAll(async () => {
        srv = await InteropServer.start({ backend: kind, address: cond.address, impair: cond.impair });
        browser = await launchChromium({ args: cond.browserArgs ?? [] });
        pc = new PageClient(await openHarnessPage(browser, srv.url));
      }, 60_000);
      afterAll(async () => {
        await browser?.close();
        await srv?.close();
      }, 60_000);

      async function join1(opts: { inactivityMs?: number | null } = {}): Promise<{ j: JoinResult; p: ServerPeer }> {
        const [j] = await pc.connect(1, opts);
        expect(j, `join failed: ${(await pc.errors()).join('; ')} / server: ${srv.errors.join('; ')}`).toBeTruthy();
        const p = await srv.peer(j!.tag);
        await p.whenOpen();
        return { j: j!, p };
      }

      async function exchange(j: JoinResult, p: ServerPeer, n: number, size: number, opts: { uu?: boolean } = {}) {
        const chans = opts.uu === false ? [0, 1] : [0, 1, 2];
        await p.whenOpen(T, true);
        const before = await pc.stats(j.index);
        const srvBefore = p.rec.ch.map((c) => c.data);
        const pageBefore = before.rx.ch.map((c) => c.data);
        for (const ch of chans) {
          const ok = p.burst(ch, n, size);
          expect(ok, `server send ch${ch}`).toBe(n);
          expect(await pc.burst(j.index, ch, n, size), `page send ch${ch}`).toBe(n);
        }
        // reliable channels complete; then give the unreliable one a moment
        const done = await until(async () => {
          const st = await pc.stats(j.index);
          return [0, 1].every((ch) => st.rx.ch[ch]!.data - pageBefore[ch]! >= n && p.rec.ch[ch]!.data - srvBefore[ch]! >= n);
        }, T + (size * n) / 1000);
        await sleep(lossy ? 1500 : 300);
        const st = await pc.stats(j.index);
        expect(done, `reliable delivery: page ${JSON.stringify(st.rx.ch)} server ${JSON.stringify(p.rec.ch)}`).toBe(true);
        return { st, srvBefore, pageBefore };
      }

      it('connects like the official client (3 negotiated channels open on both sides)', async () => {
        const { j, p } = await join1();
        const st = await pc.stats(j.index);
        expect(st.state.channels).toEqual(['open', 'open', 'open']);
        expect(st.state.conn).toBe('connected');
        expect(p.open).toEqual([true, true, true]);
        expect(j.joinMs).toBeLessThan(lossy ? 12_000 : 5_000);
        observe({ backend: kind, cond: cond.name, what: 'join', ms: Math.round(j.joinMs), maxMessageSize: st.state.maxMessageSize, remote: p.remoteAddress });
        await pc.close(j.index);
      });

      it('messages both ways on ro/ru/uu with the right order/count semantics', async () => {
        const { j, p } = await join1();
        const N = 300;
        const { st } = await exchange(j, p, N, 64);
        for (let ch = 0; ch < 3; ch++) {
          checkChannel(ch, st.rx.ch[ch]!, N, lossy, 'browser←server');
          checkChannel(ch, p.rec.ch[ch]!, N, lossy, 'server←browser');
        }
        expect(st.state.sendFailures).toBe(0);
        expect(p.sendFailures).toBe(0);
        await pc.close(j.index);
      });

      it('20 KB messages (fragmented) arrive intact', async () => {
        const { j, p } = await join1();
        const N = 10;
        const { st } = await exchange(j, p, N, 20_000, { uu: !lossy });
        for (const ch of [0, 1]) {
          checkChannel(ch, st.rx.ch[ch]!, N, lossy, 'browser←server');
          checkChannel(ch, p.rec.ch[ch]!, N, lossy, 'server←browser');
          expect(st.rx.ch[ch]!.maxLen).toBe(20_000);
          expect(p.rec.ch[ch]!.maxLen).toBe(20_000);
        }
        if (!lossy) {
          // uu (maxRetransmits 0): a burst of 200 KB overruns the window and fragments are
          // abandoned, so only integrity and "at least one arrives" are required
          for (const [s, where] of [[st.rx.ch[2]!, 'browser←server'], [p.rec.ch[2]!, 'server←browser']] as const) {
            expect(s.corrupt, where).toBe(0);
            expect(s.dups, where).toBe(0);
            expect(s.data, where).toBeGreaterThanOrEqual(1);
            observe({ backend: kind, cond: cond.name, what: `uu 20KB burst ${where}`, delivered: s.data, sent: N });
          }
        }
        await pc.close(j.index);
      });

      it('30 clients concurrently (3 pages × 10 PeerConnections)', async () => {
        const pages = [pc, new PageClient(await openHarnessPage(browser, srv.url)), new PageClient(await openHarnessPage(browser, srv.url))];
        try {
          // no app traffic until all 30 are up (slow under loss): disable the official 10 s
          // inactivity timeout, which a real host never triggers (it sends heartbeats)
          const joins = await Promise.all(pages.map((pg) => pg.connect(10, { inactivityMs: null })));
          const errs = (await Promise.all(pages.map((pg) => pg.errors()))).flat();
          const flat = joins.flat();
          expect(flat.filter((x) => x === null).length, `failed joins: ${errs.join('; ')}`).toBe(0);
          const peers = await Promise.all(flat.map((j) => srv.peer(j!.tag)));
          await Promise.all(peers.map((p) => p.whenOpen(T, true)));
          // 20 messages per channel per direction on every connection
          const N = 20;
          for (const p of peers) for (const ch of [0, 1, 2]) p.burst(ch, N, 100);
          await Promise.all(
            pages.map((pg, k) =>
              pg.page.evaluate(
                ([idx, N]) => {
                  const hx = (globalThis as unknown as { hx: Hx }).hx;
                  for (const i of idx) for (const ch of [0, 1, 2]) hx.burst(i, ch, N, 100);
                },
                [joins[k]!.map((j) => j!.index), N] as const,
              ),
            ),
          );
          let missing: string[] = [];
          const ok = await until(async () => {
            missing = [];
            for (const p of peers)
              for (const ch of [0, 1]) if (p.rec.ch[ch]!.data < N) missing.push(`server←${p.tag} ch${ch}: ${p.rec.ch[ch]!.data}`);
            for (let k = 0; k < pages.length; k++)
              for (const j of joins[k]!) {
                const s = await pages[k]!.stats(j!.index);
                for (const ch of [0, 1])
                  if (s.rx.ch[ch]!.data < N) {
                    const sp = srv.peers.get(j!.tag)!;
                    missing.push(
                      `${j!.tag}←server ch${ch}: ${s.rx.ch[ch]!.data} (page: open=${s.state.open} ${s.state.closeReason ?? ''} ${s.state.channels.join('/')} rx ${s.rx.ch.map((c) => c.data).join('/')}; ` +
                        `server: sent ${sp.sendSeq.join('/')} fallbacks ${sp.fallbacks} failures ${sp.sendFailures} open ${sp.open.join('/')})`,
                    );
                  }
              }
            return missing.length === 0;
          }, T * 2, 200);
          expect(ok, `all 30 reliable exchanges complete; missing: ${missing.join('; ')}`).toBe(true);
          await sleep(500);
          for (const p of peers) for (const ch of [0, 1, 2]) checkChannel(ch, p.rec.ch[ch]!, N, lossy, `server←${p.tag}`);
          for (let k = 0; k < pages.length; k++)
            for (const j of joins[k]!) {
              const s = await pages[k]!.stats(j!.index);
              for (const ch of [0, 1, 2]) checkChannel(ch, s.rx.ch[ch]!, N, lossy, `${j!.tag}←server`);
            }
          expect(srv.openPeers().length).toBeGreaterThanOrEqual(30);
          for (let k = 0; k < pages.length; k++) for (const j of joins[k]!) await pages[k]!.close(j!.index);
          const closed = await until(() => peers.every((p) => p.closed !== null), T);
          expect(closed, 'server saw all 30 browser closes').toBe(true);
        } finally {
          for (const pg of pages.slice(1)) await pg.page.close();
        }
      }, 120_000);

      it('browser closes the PeerConnection → server notices', async () => {
        const { j, p } = await join1();
        const t0 = Date.now();
        await pc.close(j.index);
        await p.whenClosed(lossy ? 40_000 : 15_000);
        const dt = Date.now() - t0;
        observe({ backend: kind, cond: cond.name, what: 'browser pc.close → server close', ms: dt, first: p.closed?.first });
      }, 60_000);

      it('browser closes one data channel → official client tears down, server notices', async () => {
        const { j, p } = await join1({ inactivityMs: null });
        await pc.closeChannel(j.index, 1);
        const t0 = Date.now();
        const pageClosed = await until(async () => !(await pc.stats(j.index)).state.open, lossy ? 40_000 : T);
        observe({ backend: kind, cond: cond.name, what: 'browser dc.close(ru) → browser onclose', ms: Date.now() - t0, completed: pageClosed });
        expect(pageClosed, 'stream reset completed (dc.onclose)').toBe(true);
        expect((await pc.stats(j.index)).state.closeReason).toMatch(/^channel-closed:1$/);
        await p.whenClosed(lossy ? 40_000 : 15_000);
      }, 60_000);

      it('server closes → browser notices', async () => {
        const { j, p } = await join1();
        const t0 = Date.now();
        p.close();
        const ok = await until(async () => !(await pc.stats(j.index)).state.open, lossy ? 40_000 : 15_000, 5);
        const st = await pc.stats(j.index);
        observe({ backend: kind, cond: cond.name, what: 'server close → browser close', ms: Date.now() - t0, reason: st.state.closeReason, ice: st.state.ice });
        expect(ok, JSON.stringify(st.state)).toBe(true);
      }, 60_000);

      it('reconnects after both kinds of close', async () => {
        for (let round = 0; round < 3; round++) {
          const { j, p } = await join1();
          const { st } = await exchange(j, p, 20, 200, { uu: false });
          checkChannel(0, st.rx.ch[0]!, 20, lossy, 'reconnect');
          if (round % 2 === 0) await pc.close(j.index);
          else p.close();
          await p.whenClosed(lossy ? 40_000 : 15_000);
        }
      }, 120_000);

      it('server sends on all channels the instant channel 0 opens (official challenge timing)', async () => {
        const early: Promise<void>[] = [];
        const tagWatch = async (tag: string) => {
          const p = await srv.peer(tag);
          await p.whenOpen();
          for (const ch of [0, 1, 2]) p.burst(ch, 1, 21);
        };
        const pr = pc.connect(1);
        // the page tag isn't known before connect resolves; watch every new peer instead
        const seen = new Set(srv.peers.keys());
        const watcher = setInterval(() => {
          for (const tag of srv.peers.keys())
            if (!seen.has(tag)) {
              seen.add(tag);
              early.push(tagWatch(tag));
            }
        }, 1);
        const [j] = await pr;
        clearInterval(watcher);
        await Promise.all(early);
        expect(j, (await pc.errors()).join('; ')).toBeTruthy();
        // the server falls back to channel 0 for a channel not reported open yet (official `Za.pb`)
        let last: PageStats | null = null;
        const ok = await until(async () => {
          last = await pc.stats(j!.index);
          return last.rx.ch[0]!.data + last.rx.ch[1]!.data + last.rx.ch[2]!.data >= (lossy ? 2 : 3);
        }, T);
        expect(ok, JSON.stringify(last)).toBe(true);
        observe({ backend: kind, cond: cond.name, what: 'early sends per channel (fallback to ro)', perChannel: last!.rx.ch.map((c) => c.data) });
        await pc.close(j!.index);
      });

      it.skipIf(process.env.RTC_INTEROP_IDLE === '0' || cond.name === 'eth4' || cond.name === 'dtls13')(
        'idle 40 s without app data: ICE consent keeps it alive',
        async () => {
          const { j, p } = await join1({ inactivityMs: null });
          await sleep(40_000);
          const st = await pc.stats(j.index);
          expect(st.state.open, JSON.stringify(st.state)).toBe(true);
          expect(st.state.conn).toBe('connected');
          expect(p.closed).toBeNull();
          const { st: st2 } = await exchange(j, p, 10, 64, { uu: false });
          checkChannel(0, st2.rx.ch[0]!, 10, lossy, 'after idle');
          await pc.close(j.index);
        },
        90_000,
      );
    });
  }
}
