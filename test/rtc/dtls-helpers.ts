/**
 * Test helpers for the DTLS server: a UDP harness (one DtlsServer per remote
 * address, optional datagram mangling), an `openssl s_client` runner and a
 * hand-built ClientHello for the cookie/negotiation tests.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import dgram, { type Socket } from 'node:dgram';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RtcCertificate } from '../../src/rtc/cert.js';
import { DtlsServer, type DtlsServerOptions } from '../../src/rtc/dtls/server.js';

export const hasOpenssl = spawnSync('openssl', ['version']).status === 0;

export interface ClientCert {
  certFile: string;
  keyFile: string;
  der: Buffer;
  sha256: Uint8Array;
}

let dir: string | null = null;
function tmp(): string {
  if (dir === null) dir = mkdtempSync(path.join(tmpdir(), 'haxlite-rtc-'));
  return dir;
}

/** ECDSA P-256 client certificate made by our own DER encoder. */
export function ecClientCert(name = 'ec'): ClientCert {
  const c = RtcCertificate.generate({ commonName: 'client' });
  const pem = c.toPem();
  const certFile = path.join(tmp(), `${name}.crt`);
  const keyFile = path.join(tmp(), `${name}.key`);
  writeFileSync(certFile, pem.cert);
  writeFileSync(keyFile, pem.key);
  return { certFile, keyFile, der: c.der, sha256: c.fingerprint };
}

/** RSA-2048 client certificate (openssl CLI). */
export function rsaClientCert(name = 'rsa'): ClientCert {
  const certFile = path.join(tmp(), `${name}.crt`);
  const keyFile = path.join(tmp(), `${name}.key`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-subj', '/CN=rsa', '-days', '2'], {
    stdio: 'ignore',
  });
  const derFile = `${certFile}.der`;
  execFileSync('openssl', ['x509', '-in', certFile, '-outform', 'DER', '-out', derFile]);
  const der = execFileSync('cat', [derFile]);
  return { certFile, keyFile, der, sha256: createHash('sha256').update(der).digest() };
}

export interface HarnessEvents {
  connected: DtlsServer[];
  closes: string[];
  data: string[];
}

export interface DtlsHarness {
  port: number;
  servers: Map<string, DtlsServer>;
  events: HarnessEvents;
  close(): Promise<void>;
}

/**
 * UDP server: one DtlsServer per remote address that echoes `echo:<data>`.
 * `mangle(datagram, fromClient)` may return the datagrams to deliver instead (duplication,
 * corruption, drops) — applied to client→server traffic only.
 */
export async function startDtlsHarness(
  o: {
    fingerprint: Uint8Array;
    algorithm?: string;
    certificate?: RtcCertificate;
    mtu?: number;
    suites?: number[];
    mangle?: (d: Buffer) => Buffer[];
  },
): Promise<DtlsHarness> {
  const certificate = o.certificate ?? RtcCertificate.generate();
  const sock: Socket = dgram.createSocket('udp4');
  const servers = new Map<string, DtlsServer>();
  const events: HarnessEvents = { connected: [], closes: [], data: [] };
  sock.on('message', (msg, r) => {
    const key = `${r.address}|${r.port}`;
    let srv = servers.get(key);
    if (srv === undefined) {
      const opts: DtlsServerOptions = {
        certificate,
        remoteFingerprint: { algorithm: o.algorithm ?? 'sha-256', digest: o.fingerprint },
        send: (d) => sock.send(d, r.port, r.address),
        onConnected: () => events.connected.push(srv!),
        onData: (d) => {
          events.data.push(d.toString());
          srv!.send(Buffer.from(`echo:${d.toString()}`));
        },
        onClose: (reason) => events.closes.push(reason),
      };
      if (o.mtu !== undefined) opts.mtu = o.mtu;
      if (o.suites !== undefined) opts.suites = o.suites;
      srv = new DtlsServer(opts);
      servers.set(key, srv);
    }
    const list = o.mangle ? o.mangle(msg) : [msg];
    for (const d of list) srv.handleDatagram(d, key);
  });
  await new Promise<void>((r) => sock.bind(0, '127.0.0.1', () => r()));
  return {
    port: sock.address().port,
    servers,
    events,
    close: () =>
      new Promise<void>((r) => {
        for (const s of servers.values()) s.close();
        sock.close(() => r());
      }),
  };
}

export interface OpensslResult {
  output: string;
  echoed: boolean;
}

/**
 * Runs `openssl s_client -dtls1_2`, sends `lines` and waits until each is
 * echoed back (or `timeoutMs`).
 */
export function runOpenssl(port: number, args: string[], lines: string[], timeoutMs = 8000): Promise<OpensslResult> {
  return new Promise((resolve) => {
    const p = spawn('openssl', ['s_client', '-dtls1_2', '-connect', `127.0.0.1:${port}`, '-quiet', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let sent = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      p.kill('SIGKILL');
      resolve({ output, echoed: lines.every((l) => output.includes(`echo:${l}`)) });
    };
    const timer = setTimeout(finish, timeoutMs);
    const onOut = (b: Buffer) => {
      output += b.toString();
      if (!sent && /verify return|depth=0/.test(output)) {
        sent = true;
        // one write per line, spaced so that each becomes its own record
        lines.forEach((l, i) => setTimeout(() => p.stdin.write(`${l}\n`), 50 * i));
      }
      if (lines.length > 0 && lines.every((l) => output.includes(`echo:${l}`))) finish();
    };
    p.stdout.on('data', onOut);
    p.stderr.on('data', onOut);
    p.on('exit', () => setTimeout(finish, 50));
    p.stdin.on('error', () => {});
  });
}

// ---------------------------------------------------------------- hand-built ClientHello

export interface ClientHelloOptions {
  random?: Buffer;
  cookie?: Buffer;
  suites?: number[];
  version?: number;
  ems?: boolean;
  groups?: number[];
  sigAlgs?: number[];
  supportedVersions?: number[];
  messageSeq?: number;
  recordSeq?: number;
}

const u16 = (n: number) => Buffer.from([n >>> 8, n & 0xff]);

function ext(type: number, body: Buffer): Buffer {
  return Buffer.concat([u16(type), u16(body.length), body]);
}

/** One datagram: a DTLS record holding a full ClientHello. */
export function clientHelloDatagram(o: ClientHelloOptions = {}): { datagram: Buffer; random: Buffer } {
  const random = o.random ?? randomBytes(32);
  const cookie = o.cookie ?? Buffer.alloc(0);
  const suites = o.suites ?? [0xc02b];
  const exts: Buffer[] = [];
  const groups = o.groups ?? [29, 23];
  const gl = Buffer.concat(groups.map(u16));
  exts.push(ext(10, Buffer.concat([u16(gl.length), gl])));
  exts.push(ext(11, Buffer.from([1, 0])));
  const sl = Buffer.concat((o.sigAlgs ?? [0x0403]).map(u16));
  exts.push(ext(13, Buffer.concat([u16(sl.length), sl])));
  if (o.ems !== false) exts.push(ext(23, Buffer.alloc(0)));
  exts.push(ext(0xff01, Buffer.from([0])));
  if (o.supportedVersions) {
    const v = Buffer.concat(o.supportedVersions.map(u16));
    exts.push(ext(43, Buffer.concat([Buffer.from([v.length]), v])));
  }
  const extBytes = Buffer.concat(exts);
  const sb = Buffer.concat(suites.map(u16));
  const body = Buffer.concat([
    u16(o.version ?? 0xfefd),
    random,
    Buffer.from([0]),
    Buffer.from([cookie.length]),
    cookie,
    u16(sb.length),
    sb,
    Buffer.from([1, 0]),
    u16(extBytes.length),
    extBytes,
  ]);
  const len3 = (n: number) => Buffer.from([(n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
  const hs = Buffer.concat([Buffer.from([1]), len3(body.length), u16(o.messageSeq ?? 0), len3(0), len3(body.length), body]);
  const rec = Buffer.alloc(13);
  rec[0] = 22;
  rec.writeUInt16BE(0xfefd, 1);
  rec.writeUInt16BE(0, 3);
  rec.writeUInt32BE(o.recordSeq ?? 0, 7);
  rec.writeUInt16BE(hs.length, 11);
  return { datagram: Buffer.concat([rec, hs]), random };
}

export interface ParsedRecord {
  type: number;
  version: number;
  epoch: number;
  seq: number;
  fragment: Buffer;
}

export function parseRecords(d: Buffer): ParsedRecord[] {
  const out: ParsedRecord[] = [];
  let p = 0;
  while (p + 13 <= d.length) {
    const len = d.readUInt16BE(p + 11);
    out.push({
      type: d[p]!,
      version: d.readUInt16BE(p + 1),
      epoch: d.readUInt16BE(p + 3),
      seq: d.readUInt16BE(p + 5) * 2 ** 32 + d.readUInt32BE(p + 7),
      fragment: d.subarray(p + 13, p + 13 + len),
    });
    p += 13 + len;
  }
  return out;
}
