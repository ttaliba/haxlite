/**
 * Process-wide endpoint sharing (src/rtc/shared.ts) and the certificate
 * helpers used by it (process default, async generation, PEM file).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RtcCertificate, acquireSharedEndpoint, sharedEndpointCount } from '../../src/rtc/index.js';

const LOOP = { address: '127.0.0.1', publicAddresses: ['127.0.0.1'] };
const dir = mkdtempSync(path.join(tmpdir(), 'haxlite-rtc-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('shared RtcEndpoint', () => {
  it('same settings → one endpoint (refcounted); different settings → another; last release closes', async () => {
    const before = sharedEndpointCount();
    const a = acquireSharedEndpoint({ ...LOOP });
    const b = acquireSharedEndpoint({ ...LOOP });
    const c = acquireSharedEndpoint({ ...LOOP, idleTimeoutMs: 12_345 });
    const [ea, eb, ec] = await Promise.all([a.ready, b.ready, c.ready]);
    expect(eb).toBe(ea);
    expect(ec).not.toBe(ea);
    expect(sharedEndpointCount()).toBe(before + 2);
    await a.release();
    await a.release(); // idempotent: must not drop b's reference
    expect((ea as unknown as { closed: boolean }).closed).toBe(false);
    await b.release();
    expect((ea as unknown as { closed: boolean }).closed).toBe(true);
    await c.release();
    expect(sharedEndpointCount()).toBe(before);
  });

  it('a fixed port is reused after the last release (the new lease waits for the old socket)', async () => {
    const probe = acquireSharedEndpoint({ ...LOOP });
    const port = (await probe.ready).port;
    await probe.release();
    const a = acquireSharedEndpoint({ ...LOOP, port });
    await a.ready;
    const closing = a.release(); // closes one macrotask later
    const b = acquireSharedEndpoint({ ...LOOP, port }); // same key: must wait, not EADDRINUSE
    const eb = await b.ready;
    await closing;
    expect(eb.port).toBe(port);
    await b.release();
  });

  it('a listen failure rejects the lease and the next lease retries', async () => {
    const bad = acquireSharedEndpoint({ ...LOOP, address: '192.0.2.123' }); // not a local address
    await expect(bad.ready).rejects.toThrow();
    await bad.release();
    const ok = acquireSharedEndpoint({ ...LOOP });
    await expect(ok.ready).resolves.toBeTruthy();
    await ok.release();
  });
});

describe('RtcCertificate helpers', () => {
  it('processDefault is generated once; generateAsync gives a valid self-signed certificate', async () => {
    const p1 = await RtcCertificate.processDefault();
    const p2 = await RtcCertificate.processDefault();
    expect(p2).toBe(p1);
    const c = await RtcCertificate.generateAsync({ commonName: 'x' });
    expect(c.x509.verify(c.x509.publicKey)).toBe(true);
    expect(c.x509.checkPrivateKey(c.privateKey)).toBe(true);
    expect(c.x509.subject).toBe('CN=x');
  });

  it('loadOrCreate writes a 0600 PEM once and loads the same identity afterwards', async () => {
    const file = path.join(dir, 'dtls.pem');
    const a = await RtcCertificate.loadOrCreate(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toMatch(/BEGIN CERTIFICATE[\s\S]*BEGIN PRIVATE KEY/);
    const b = await RtcCertificate.loadOrCreate(file);
    expect(Buffer.from(b.fingerprint)).toEqual(Buffer.from(a.fingerprint));
  });

  it('loadOrCreate replaces an identity that expires within a day (synchronous write + rename)', async () => {
    const file = path.join(dir, 'expiring.pem');
    const old = RtcCertificate.generate({ validDays: 1 }); // valid from 1 day ago: expires now
    writeFileSync(file, old.toPem().cert + old.toPem().key);
    const fresh = await RtcCertificate.loadOrCreate(file);
    expect(Buffer.from(fresh.fingerprint)).not.toEqual(Buffer.from(old.fingerprint));
    const again = await RtcCertificate.loadOrCreate(file);
    expect(Buffer.from(again.fingerprint)).toEqual(Buffer.from(fresh.fingerprint));
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
