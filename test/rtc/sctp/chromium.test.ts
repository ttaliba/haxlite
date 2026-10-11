/**
 * SctpAssociation against Chromium's dcsctp, through R1's ICE-lite + DTLS
 * endpoint (RtcEndpoint with a dataLayer wrapping SctpAssociation so its
 * stats and channel-close events are observable). Skipped when the
 * preinstalled Chromium is missing.
 */
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RtcEndpoint, type SctpAssociationOptions } from '../../../src/rtc/index.js';
import { SctpAssociation } from '../../../src/rtc/sctp/index.js';

const CHROMIUM = process.env.HAXLITE_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const hasChromium = existsSync(CHROMIUM);

type PwPage = { evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>; close(): Promise<void> };
type PwBrowser = { newPage(): Promise<PwPage>; close(): Promise<void>; version(): string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type G = any;

const PAGE_JS = String.raw`
  globalThis.setup = async () => {
    const pc = new RTCPeerConnection({ iceServers: [] });
    globalThis.pc = pc;
    globalThis.got = [[], [], []];
    globalThis.chs = [
      { ordered: true }, { ordered: false }, { ordered: false, maxRetransmits: 0 },
    ].map((c, id) => {
      const dc = pc.createDataChannel(['ro', 'ru', 'uu'][id], { id, negotiated: true, ...c });
      dc.binaryType = 'arraybuffer';
      dc.onmessage = (e) => globalThis.got[id].push(new Uint8Array(e.data));
      return dc;
    });
    await pc.setLocalDescription(await pc.createOffer());
    return pc.localDescription.sdp;
  };
  globalThis.answer = async (sdp) => {
    await globalThis.pc.setRemoteDescription({ type: 'answer', sdp });
    for (let i = 0; i < 500 && globalThis.chs.some((d) => d.readyState !== 'open'); i++) await new Promise((r) => setTimeout(r, 10));
    return globalThis.chs.map((d) => d.readyState);
  };
  const mk = (ch, i, size) => {
    const m = new Uint8Array(size);
    new DataView(m.buffer).setUint32(0, i);
    for (let k = 4; k < size; k++) m[k] = (i + k * 7 + ch) & 0xff;
    return m;
  };
  const ok = (ch, m) => {
    const i = new DataView(m.buffer, m.byteOffset).getUint32(0);
    for (let k = 4; k < m.length; k++) if (m[k] !== ((i + k * 7 + ch) & 0xff)) return -1;
    return i;
  };
  globalThis.sendAll = (n, sizes) => {
    for (let i = 0; i < n; i++) for (let ch = 0; ch < 3; ch++) globalThis.chs[ch].send(mk(ch, i, sizes[ch]));
  };
  globalThis.waitGot = async (counts, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms && counts.some((c, ch) => globalThis.got[ch].length < c)) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 100));
    return globalThis.got.map((l, ch) => l.map((m) => ok(ch, m)));
  };
  globalThis.closeChannel = async (id) => {
    const dc = globalThis.chs[id];
    dc.close();
    for (let i = 0; i < 300 && dc.readyState !== 'closed'; i++) await new Promise((r) => setTimeout(r, 10));
    return dc.readyState;
  };
  true;
`;

function mk(ch: number, i: number, size: number): Uint8Array {
  const m = new Uint8Array(size);
  new DataView(m.buffer).setUint32(0, i);
  for (let k = 4; k < size; k++) m[k] = (i + k * 7 + ch) & 0xff;
  return m;
}
function ok(ch: number, m: Uint8Array): number {
  const i = new DataView(m.buffer, m.byteOffset).getUint32(0);
  for (let k = 4; k < m.length; k++) if (m[k] !== ((i + k * 7 + ch) & 0xff)) return -1;
  return i;
}

describe.skipIf(!hasChromium)('SctpAssociation ↔ Chromium (dcsctp)', () => {
  let browser: PwBrowser;
  let ep: RtcEndpoint;
  let last: { sctp: SctpAssociation; channelClosed: number[]; closed: string | null } | null = null;

  beforeAll(async () => {
    const { chromium } = (await import('playwright-core')) as unknown as { chromium: { launch(o: object): Promise<PwBrowser> } };
    browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
    ep = await RtcEndpoint.listen({
      address: '127.0.0.1',
      publicAddresses: ['127.0.0.1'],
      dataLayer: (o: SctpAssociationOptions) => {
        const rec = { sctp: null as unknown as SctpAssociation, channelClosed: [] as number[], closed: null as string | null };
        rec.sctp = new SctpAssociation({
          ...o,
          onChannelClose: (id) => rec.channelClosed.push(id),
          onClose: (r) => {
            rec.closed = r;
            o.onClose(r);
          },
        });
        last = rec;
        return rec.sctp;
      },
    });
  }, 30_000);

  afterAll(async () => {
    await ep?.close();
    await browser?.close();
  });

  async function open() {
    const page = await browser.newPage();
    await page.evaluate((js: string) => (0, eval)(js), PAGE_JS);
    const offer = await page.evaluate(() => (globalThis as G).setup() as Promise<string>, null);
    const s = ep.createSession(offer);
    const got: Uint8Array[][] = [[], [], []];
    s.onMessage = (ch, d) => got[ch].push(d);
    const opened = new Promise<void>((r) => (s.onOpen = r));
    const states = await page.evaluate((sdp: string) => (globalThis as G).answer(sdp) as Promise<string[]>, s.answerSdp);
    await opened;
    expect(states).toEqual(['open', 'open', 'open']);
    return { page, s, got, rec: last! };
  }

  const until = async (pred: () => boolean, ms = 10_000): Promise<void> => {
    const t0 = Date.now();
    while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
  };

  it('messages both ways on ro/ru/uu, 20 KB and 200 KB messages', async () => {
    const { page, s, got, rec } = await open();
    const N = 300;
    const sizes = [30, 200, 60];
    await page.evaluate((a: [number, number[]]) => (globalThis as G).sendAll(a[0], a[1]), [N, sizes] as [number, number[]]);
    for (let i = 0; i < N; i++) for (let ch = 0; ch < 3; ch++) expect(s.send(ch, mk(ch, i, sizes[ch]))).toBe(true);
    // big messages, both directions
    for (const size of [20_000, 200_000]) {
      expect(s.send(0, mk(0, 100_000 + size, size))).toBe(true);
      expect(s.send(1, mk(1, 100_000 + size, size))).toBe(true);
    }
    const browserGot = await page.evaluate((c: number[]) => (globalThis as G).waitGot(c, 15_000) as Promise<number[][]>, [N + 2, N + 2, N]);
    await until(() => got[0].length >= N && got[1].length >= N);
    const ids = (l: Uint8Array[], ch: number) => l.map((m) => ok(ch, m));
    // ro: all, in order; ru: all; uu: no loss on loopback, never corrupted
    expect(ids(got[0], 0)).toEqual([...Array(N).keys()]);
    expect(new Set(ids(got[1], 1)).size).toBe(N);
    expect(ids(got[2], 2).every((i) => i >= 0)).toBe(true);
    expect(browserGot[0]).toEqual([...Array(N).keys(), 120_000, 300_000]);
    expect(new Set(browserGot[1]).size).toBe(N + 2);
    expect(browserGot[1]).not.toContain(-1);
    expect(browserGot[2].length).toBe(N);
    // browser → us big messages
    await page.evaluate(() => {
      const g = globalThis as G;
      const m = new Uint8Array(150_000);
      new DataView(m.buffer).setUint32(0, 7);
      for (let k = 4; k < m.length; k++) m[k] = (7 + k * 7 + 0) & 0xff;
      g.chs[0].send(m);
    }, null);
    await until(() => got[0].length === N + 1);
    expect(got[0][N].length).toBe(150_000);
    expect(ok(0, got[0][N])).toBe(7);
    const st = rec.sctp.stats();
    console.log(`[chromium ${browser.version()}] sctp stats: ${JSON.stringify(st)}`);
    // Chromium 141 does not advertise RFC 9653 zero checksum by default: CRC32c both ways.
    expect(typeof st.zeroChecksum).toBe('boolean');
    expect(st.checksumErrors).toBe(0);
    expect(st.malformed).toBe(0);
    expect(st.internalErrors).toBe(0);
    s.close();
    await page.close();
  }, 60_000);

  it('browser dc.close() → stream reset answered, channel reaches "closed" in the browser, others keep working', async () => {
    const { page, s, got, rec } = await open();
    const state = await page.evaluate((id: number) => (globalThis as G).closeChannel(id) as Promise<string>, 1);
    expect(state).toBe('closed');
    await until(() => rec.channelClosed.includes(1));
    expect(rec.channelClosed).toEqual([1]);
    expect(s.send(1, mk(1, 1, 10))).toBe(false);
    // ro / uu still work both ways
    expect(s.send(0, mk(0, 5, 40))).toBe(true);
    const b = await page.evaluate(() => {
      (globalThis as G).chs[2].send(new Uint8Array([0, 0, 0, 9, 1]));
      return (globalThis as G).waitGot([1, 0, 0], 5000) as Promise<number[][]>;
    }, null);
    expect(b[0]).toEqual([5]);
    await until(() => got[2].length === 1);
    expect(got[2].length).toBe(1);
    const rs = await page.evaluate(() => (globalThis as G).chs.map((d: { readyState: string }) => d.readyState) as string[], null);
    expect(rs).toEqual(['open', 'closed', 'open']);
    expect(rec.sctp.stats().internalErrors).toBe(0);
    s.close();
    await page.close();
  }, 60_000);

  it('server closes one channel → browser channel closes', async () => {
    const { page, s, rec } = await open();
    rec.sctp.closeChannel(2);
    const st = await page.evaluate(async () => {
      const dc = (globalThis as G).chs[2];
      for (let i = 0; i < 300 && dc.readyState !== 'closed'; i++) await new Promise((r) => setTimeout(r, 10));
      return dc.readyState;
    }, null);
    expect(st).toBe('closed');
    await until(() => rec.channelClosed.includes(2));
    expect(rec.channelClosed).toEqual([2]);
    s.close();
    await page.close();
  }, 60_000);

  it('browser pc.close() → association reported closed', async () => {
    const { page, s, rec } = await open();
    const closed = new Promise<string>((r) => (s.onClose = r));
    await page.evaluate(() => (globalThis as G).pc.close(), null);
    const reason = await closed;
    expect(reason.startsWith('sctp:') || reason === 'remote-close').toBe(true);
    console.log(`[chromium] pc.close() → session ${reason}, sctp ${rec.closed}`);
    await page.close();
  }, 60_000);
});
