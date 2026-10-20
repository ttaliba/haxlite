// UDP traffic generator for the network-namespace checks in haxguard.test.ts. Prints one JSON object.
//   send <src> <dst> <port> <count> <bytes> [stun]   datagrams from src:ephemeral (STUN Binding Request if `stun`)
//   ephemeral <count> <dst> <port>                    one datagram from each of <count> auto-bound sockets
//   bound <port> <dst> <dport>                        one datagram from an explicitly bound port
import dgram from 'node:dgram';

const [cmd, ...args] = process.argv.slice(2);

function stunRequest() {
  const b = Buffer.alloc(20);
  b.writeUInt16BE(0x0001, 0);
  b.writeUInt32BE(0x2112a442, 4);
  for (let i = 8; i < 20; i++) b[i] = i;
  return b;
}

/** Binds a socket (src may be '0.0.0.0' for any address, port 0 for auto-bind). */
function open(src, port) {
  const s = dgram.createSocket('udp4');
  return new Promise((resolve, reject) => {
    s.once('error', reject);
    s.bind(port, src, () => resolve(s));
  });
}

const sendOne = (s, buf, port, host) =>
  new Promise((resolve) => s.send(buf, port, host, (err) => resolve(err ? err.code : null)));

const tally = (errs) => {
  const out = { sent: 0, errors: {} };
  for (const e of errs) {
    if (e === null) out.sent++;
    else out.errors[e] = (out.errors[e] ?? 0) + 1;
  }
  return out;
};

async function main() {
  if (cmd === 'send') {
    const [src, dst, port, count, bytes, kind] = args;
    const s = await open(src, 0);
    const buf = kind === 'stun' ? stunRequest() : Buffer.alloc(Number(bytes), 0xff);
    const errs = [];
    for (let i = 0; i < Number(count); i++) errs.push(await sendOne(s, buf, Number(port), dst));
    s.close();
    return tally(errs);
  }
  if (cmd === 'ephemeral') {
    const [count, dst, port] = args;
    const errs = [];
    let inRange = 0;
    for (let i = 0; i < Number(count); i++) {
      const s = await open('0.0.0.0', 0);
      const local = s.address().port;
      if (local >= 40000 && local <= 40999) inRange++;
      errs.push(await sendOne(s, Buffer.alloc(32, 1), Number(port), dst));
      s.close();
    }
    return { ...tally(errs), inRange };
  }
  if (cmd === 'bound') {
    const [port, dst, dport] = args;
    const s = await open('0.0.0.0', Number(port));
    const err = await sendOne(s, Buffer.alloc(32, 1), Number(dport), dst);
    s.close();
    return tally([err]);
  }
  throw new Error(`unknown command ${cmd}`);
}

main().then(
  (r) => console.log(JSON.stringify(r)),
  (e) => {
    console.error(String(e));
    process.exit(1);
  },
);
