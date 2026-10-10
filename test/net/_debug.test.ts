import { createRequire } from 'node:module';
import { afterAll, beforeAll, it } from 'vitest';
import { FakeMaster } from '../fake-master/index.js';
import { HostTransport, shutdownWebRtc } from '../../src/net/index.js';
import { initLogger } from 'node-datachannel';
const require = createRequire(import.meta.url);
type Any = any;
let master: FakeMaster; let nh: Any;
beforeAll(async () => { master = await FakeMaster.start({ log: (m) => console.log('[master]', m) }); const poly = require(require.resolve('node-datachannel/polyfill', { paths: [require('path').dirname(require.resolve('node-haxball'))] }));
  class PC extends poly.RTCPeerConnection { createDataChannel(l: string, o: Any) { const dc = super.createDataChannel(l, o); const t0 = performance.now();
    dc.addEventListener('open', () => console.log('[cdc]', l, 'open', (performance.now()-t0)|0));
    dc.addEventListener('message', (e: Any) => console.log('[cdc]', l, 'message', dc.readyState, e.data?.byteLength, 'handler', String(dc.onmessage).slice(0, 60)));
    return dc; } }
  nh = require('node-haxball')({ RTCPeerConnection: PC, RTCIceCandidate: poly.RTCIceCandidate, RTCSessionDescription: poly.RTCSessionDescription }, master.nodeHaxballConfig); });
afterAll(async () => { await master.close(); shutdownWebRtc(); });
it('debug join x5', async () => {
  if (process.env.NDC_LOG) initLogger('Debug', (l, m) => console.log('[ndc]', l, m));
  for (let k = 0; k < 5; k++) {
    const t0 = performance.now();
    const t = new HostTransport({ token: 'x', masterUrl: master.httpBase, iceServers: [], log: (m) => console.log('[host]', m) });
    const room = master.waitForRoom(); t.start(); const fr = await room;
    const [, authObj] = await nh.Utils.generateAuth();
    const ok = new Promise<string>((res) => { t.onPeerJoin = (p, i) => res('joined ' + i.auth); setTimeout(() => res('TIMEOUT'), 15000); });
    const j = nh.Room.join({ id: fr.id, password: null, authObj }, { storage: { player_name: 'a', geo: { lat: 0, lon: 0, flag: 'uy' } },
      onConnInfo: (s: Any, x: Any) => console.log('[client] state', s, typeof x === 'string' ? x.slice(0, 40).replace(/\n/g,' ') : x?.code),
      onClose: (e: Any) => console.log('[client] close', e?.code) });
    console.log(k, await ok, (performance.now() - t0) | 0, 'ms');
    t.stop();
  }
}, 120000);
