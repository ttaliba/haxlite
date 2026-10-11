/**
 * Quick real-browser check of the ICE-lite + DTLS layers: Chromium creates
 * an RTCPeerConnection exactly like the HaxBall client (offerer, 3
 * negotiated channels, trickle ICE), our endpoint answers, and the
 * connection must reach `connectionState === 'connected'` (= ICE nominated
 * + DTLS handshake verified both ways). The data layer is the raw test
 * layer, so SCTP is out of scope here (see test/rtc-interop for the full
 * stack). Skipped when the preinstalled Chromium is missing.
 */
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RtcEndpoint, rawDataLayer } from '../../src/rtc/index.js';
import type { RtcSession } from '../../src/rtc/index.js';
import type { RtcSessionImpl } from '../../src/rtc/session.js';

const CHROMIUM = process.env.HAXLITE_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const hasChromium = existsSync(CHROMIUM);

type PwBrowser = { newPage(): Promise<PwPage>; close(): Promise<void>; version(): string };
type PwPage = {
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
  close(): Promise<void>;
};

describe.skipIf(!hasChromium)('Chromium ↔ haxlite-rtc (ICE-lite + DTLS)', () => {
  let browser: PwBrowser;
  let ep: RtcEndpoint;

  beforeAll(async () => {
    const { chromium } = (await import('playwright-core')) as unknown as {
      chromium: { launch(o: object): Promise<PwBrowser> };
    };
    browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
    ep = await RtcEndpoint.listen({ address: '127.0.0.1', publicAddresses: ['127.0.0.1'], dataLayer: rawDataLayer });
  }, 30_000);

  afterAll(async () => {
    await ep?.close();
    await browser?.close();
  });

  /** Page-side code (plain JS: the repo has no DOM typings). */
  const PAGE_JS = String.raw`
    globalThis.makeOffer = async (channels) => {
      const pc = new RTCPeerConnection({ iceServers: [] });
      globalThis.pc = pc;
      globalThis.states = [];
      pc.onconnectionstatechange = () => globalThis.states.push(pc.connectionState);
      globalThis.chs = [];
      globalThis.got = [];
      channels.forEach((c, id) => {
        const init = { id, negotiated: true, ordered: c.ordered };
        if (c.maxRetransmits !== undefined) init.maxRetransmits = c.maxRetransmits;
        const dc = pc.createDataChannel(c.name, init);
        dc.binaryType = 'arraybuffer';
        dc.onmessage = (e) => globalThis.got.push(id + ':' + new TextDecoder().decode(e.data));
        globalThis.chs.push(dc);
      });
      const o = await pc.createOffer();
      await pc.setLocalDescription(o);
      return o.sdp;
    };
    globalThis.applyAnswer = async (sdp, waitMs) => {
      const pc = globalThis.pc;
      await pc.setRemoteDescription({ type: 'answer', sdp });
      const t0 = Date.now();
      while (Date.now() - t0 < waitMs) {
        if (pc.connectionState === 'connected' || pc.connectionState === 'failed') break;
        await new Promise((r) => setTimeout(r, 20));
      }
      const stats = await pc.getStats();
      let dtls = null;
      stats.forEach((r) => {
        if (r.type === 'transport') dtls = { dtlsState: r.dtlsState, tlsVersion: r.tlsVersion, dtlsCipher: r.dtlsCipher, dtlsRole: r.dtlsRole };
      });
      return { state: pc.connectionState, states: globalThis.states, ms: Date.now() - t0, dtls };
    };
    globalThis.echoRoundTrip = async () => {
      for (let i = 0; i < 250 && globalThis.chs.some((d) => d.readyState !== 'open'); i++) await new Promise((r) => setTimeout(r, 20));
      const states = globalThis.chs.map((d) => d.readyState);
      globalThis.chs.forEach((d, i) => d.send(new TextEncoder().encode('hi' + i)));
      for (let i = 0; i < 250 && globalThis.got.length < 3; i++) await new Promise((r) => setTimeout(r, 20));
      return { states, got: globalThis.got.slice().sort() };
    };
    true;
  `;
  const HAXBALL = [
    { name: 'ro', ordered: true },
    { name: 'ru', ordered: false },
    { name: 'uu', ordered: false, maxRetransmits: 0 },
  ];
  type PageResult = { state: string; states: string[]; ms: number; dtls: Record<string, unknown> | null };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type G = any;

  async function newPage(): Promise<PwPage> {
    const page = await browser.newPage();
    await page.evaluate((js: string) => (0, eval)(js), PAGE_JS);
    return page;
  }

  const tamperFp = (sdp: string) =>
    sdp.replace(/a=fingerprint:sha-256 ([0-9A-F]{2})/, (_m: string, h: string) => `a=fingerprint:sha-256 ${h === '00' ? '11' : '00'}`);

  async function connect(page: PwPage, opts: { mutateAnswer?: (sdp: string) => string; waitMs?: number } = {}) {
    const offer = await page.evaluate((ch: typeof HAXBALL) => (globalThis as G).makeOffer(ch) as Promise<string>, HAXBALL);
    const session = ep.createSession(offer);
    const answer = opts.mutateAnswer ? opts.mutateAnswer(session.answerSdp) : session.answerSdp;
    const result = await page.evaluate(
      (a: [string, number]) => (globalThis as G).applyAnswer(a[0], a[1]) as Promise<PageResult>,
      [answer, opts.waitMs ?? 10_000] as [string, number],
    );
    return { session, offer, result };
  }

  it('reaches connectionState "connected" with a HaxBall-style offer', async () => {
    const page = await newPage();
    const { session, offer, result } = await connect(page);
    expect(offer).toContain('m=application');
    expect(result.state).toBe('connected');
    expect(result.dtls).toMatchObject({ dtlsState: 'connected', dtlsRole: 'client', tlsVersion: 'FEFD' });
    // Chromium offers ChaCha20-Poly1305 in DTLS 1.2 and we prefer it (allocation-free JS AEAD)
    expect(result.dtls).toMatchObject({ dtlsCipher: 'TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256' });
    expect((session as unknown as RtcSessionImpl).cipherSuite).toBe('TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256');
    expect(session.remoteAddress).not.toBeNull();
    // the browser keeps ICE consent alive; our side is past the DTLS handshake
    expect(['dtls', 'open']).toContain(session.state);
    console.log(`[chromium ${browser.version()}] connected in ${result.ms} ms, ${JSON.stringify(result.dtls)}`);
    session.close();
    await page.close();
  }, 30_000);

  it('cipherSuites: AES-128-GCM preferred by configuration is negotiated with Chromium too', async () => {
    const aesEp = await RtcEndpoint.listen({ address: '127.0.0.1', publicAddresses: ['127.0.0.1'], dataLayer: rawDataLayer, cipherSuites: ['aes128gcm', 'chacha20'] });
    try {
      const page = await newPage();
      const offer = await page.evaluate((ch: typeof HAXBALL) => (globalThis as G).makeOffer(ch) as Promise<string>, HAXBALL);
      const session = aesEp.createSession(offer);
      const result = await page.evaluate(
        (a: [string, number]) => (globalThis as G).applyAnswer(a[0], a[1]) as Promise<PageResult>,
        [session.answerSdp, 10_000] as [string, number],
      );
      expect(result.state).toBe('connected');
      expect(result.dtls).toMatchObject({ dtlsCipher: 'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256' });
      session.close();
      await page.close();
    } finally {
      await aesEp.close();
    }
  }, 30_000);

  it('a wrong answer fingerprint makes Chromium fail (it verifies our certificate)', async () => {
    const page = await newPage();
    const { session, result } = await connect(page, { mutateAnswer: tamperFp, waitMs: 5000 });
    expect(result.state).not.toBe('connected');
    session.close();
    await page.close();
  }, 30_000);

  it('a wrong offer fingerprint makes us reject the client certificate', async () => {
    const page = await newPage();
    const offer = await page.evaluate((ch: typeof HAXBALL) => (globalThis as G).makeOffer(ch) as Promise<string>, HAXBALL);
    const session: RtcSession = ep.createSession(tamperFp(offer));
    const closed = new Promise<string>((r) => (session.onClose = r));
    const result = await page.evaluate(
      (a: [string, number]) => (globalThis as G).applyAnswer(a[0], a[1]) as Promise<PageResult>,
      [session.answerSdp, 5000] as [string, number],
    );
    expect(await closed).toBe('dtls-error:fingerprint-mismatch');
    expect(result.state).not.toBe('connected');
    await page.close();
  }, 30_000);

  it('a DTLS 1.3-enabled Chromium (WebRTC-ForceDtls13) falls back to DTLS 1.2 with us', async () => {
    const { chromium } = (await import('playwright-core')) as unknown as {
      chromium: { launch(o: object): Promise<PwBrowser> };
    };
    const b13 = await chromium.launch({
      executablePath: CHROMIUM,
      headless: true,
      args: ['--force-fieldtrials=WebRTC-ForceDtls13/Enabled/'],
    });
    try {
      const page = await b13.newPage();
      await page.evaluate((js: string) => (0, eval)(js), PAGE_JS);
      const { session, result } = await connect(page);
      expect(result.state).toBe('connected');
      expect(result.dtls).toMatchObject({ tlsVersion: 'FEFD' });
      expect((session as unknown as RtcSessionImpl).dtlsInfo.clientOfferedDtls13).toBe(true);
      session.close();
    } finally {
      await b13.close();
    }
  }, 30_000);

  it('full stack (default SCTP layer): the 3 HaxBall channels open and echo', async () => {
    const full = await RtcEndpoint.listen({ address: '127.0.0.1', publicAddresses: ['127.0.0.1'] });
    try {
      const page = await newPage();
      const offer = await page.evaluate((ch: typeof HAXBALL) => (globalThis as G).makeOffer(ch) as Promise<string>, HAXBALL);
      const s = full.createSession(offer);
      const opened = new Promise<void>((r) => (s.onOpen = r));
      const got: string[] = [];
      s.onMessage = (ch, data) => {
        got.push(`${ch}:${Buffer.from(data).toString()}`);
        s.send(ch, Buffer.concat([Buffer.from('echo-'), data]));
      };
      const result = await page.evaluate(
        (a: [string, number]) => (globalThis as G).applyAnswer(a[0], a[1]) as Promise<PageResult>,
        [s.answerSdp, 10_000] as [string, number],
      );
      expect(result.state).toBe('connected');
      await opened;
      expect(s.state).toBe('open');
      const echo = await page.evaluate(() => (globalThis as G).echoRoundTrip() as Promise<{ states: string[]; got: string[] }>, null);
      expect(echo.states).toEqual(['open', 'open', 'open']);
      expect(echo.got).toEqual(['0:echo-hi0', '1:echo-hi1', '2:echo-hi2']);
      expect(got.sort()).toEqual(['0:hi0', '1:hi1', '2:hi2']);
      await page.close();
    } finally {
      await full.close();
    }
  }, 30_000);
});
