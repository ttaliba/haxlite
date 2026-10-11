// One cold start: import the package entry, HBInit a public room against the
// FakeMaster, report timings once the room link arrives, then exit.
//   node child.mjs <entry.js> <masterUrl>
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [entry, masterUrl] = process.argv.slice(2);
const t0 = performance.now();
const { HBInit } = await import(pathToFileURL(entry).href);
const tImport = performance.now();
const room = await HBInit({
  roomName: 'startup',
  noPlayer: true,
  public: true,
  token: 'thr1.startup',
  geo: { code: 'ar', lat: -34.6, lon: -58.4 },
  haxlite: { masterUrl, iceServers: [] },
});
const tLink = performance.now();
const cpu = process.cpuUsage();
const mu = process.memoryUsage();
const cjs = Object.keys(createRequire(entry).cache).length;
process.send({
  processToImport: t0,
  importMs: tImport - t0,
  hbinitToLinkMs: tLink - tImport,
  processToLinkMs: tLink,
  cpuMs: (cpu.user + cpu.system) / 1000,
  rssMB: mu.rss / 1048576,
  heapMB: mu.heapUsed / 1048576,
  cjsModules: cjs,
  link: room.haxlite.roomLink !== null,
});
await room.haxlite.stop();
process.exit(0);
