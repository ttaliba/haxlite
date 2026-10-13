// NaN bit patterns across JS engines, for haxlite hidden players (docs/04 §7.4).
// Plain script, no imports: runs as-is in node, the SpiderMonkey / JSC shells
// (jsvu) and a browser page. Prints one JSON line.
//
// What the host relies on: a hidden disc's position is NaN read from a float32
// (SetDiscProperties), then only `x = x + finite` every tick, then serialized
// with DataView.setFloat64 into the checksum. Every engine must produce the
// same 8 bytes there. The "fresh" NaNs (0*Infinity, -NaN, sqrt(-1)) are the
// ones that may differ: haxlite never stores them.
(function () {
  var out = typeof print === 'function' && typeof console === 'undefined' ? print : function (s) { console.log(s); };
  var dv = new DataView(new ArrayBuffer(8));
  function hex(x) {
    dv.setFloat64(0, x);
    var h = '';
    for (var i = 0; i < 8; i++) h += (dv.getUint8(i) + 256).toString(16).slice(1);
    return h;
  }
  // 1. the hidden position: float32 NaN on the wire (Math.fround(NaN) written with setFloat32)
  var f = new DataView(new ArrayBuffer(4));
  f.setFloat32(0, NaN);
  var wire = f.getUint32(0).toString(16);
  var disc = { x: 0, y: 0, xspeed: 0.3, yspeed: -0.2, damping: 0.96 };
  disc.x = f.getFloat32(0);
  disc.y = f.getFloat32(0);
  var read = hex(disc.x);
  // 2. the per-tick arithmetic on a hidden disc (cGroup 0: integration only), JIT-hot
  for (var t = 0; t < 200000; t++) {
    disc.x = disc.x + disc.xspeed * 1;
    disc.y = disc.y + disc.yspeed * 1;
    disc.xspeed = (disc.xspeed + 0) * disc.damping + ((t & 7) === 0 ? 0.1 : 0);
    disc.yspeed = (disc.yspeed + 0) * disc.damping - ((t & 15) === 0 ? 0.1 : 0);
  }
  var stepped = hex(disc.x) + ' ' + hex(disc.y);
  // 3. temporaries the renderer / kick test build from it (never stored by the sim)
  var camX = 12.5;
  var e = disc.x - camX;
  var clamp = e > 300 ? 300 : e < -300 ? -300 : e;
  var arrow = 900 < (disc.x - (camX + clamp)) * (disc.x - (camX + clamp));
  var kickOfficial = 4 > Math.sqrt((5 - disc.x) * (5 - disc.x)) - 10 - 15; // game-min.js
  var kickNodeHaxball = !(Math.sqrt((5 - disc.x) * (5 - disc.x)) - 10 - 15 >= 4); // node-haxball 2.3.1
  // 4. fresh NaNs (implementation-defined sign/payload)
  var inf = 1 / (disc.damping - disc.damping);
  var fresh = { zeroTimesInf: hex(0 * inf), infMinusInf: hex(inf - inf), sqrtNeg: hex(Math.sqrt(-disc.damping)), negNaN: hex(-disc.x) };
  // 5. XOR checksum of the two words (what CheckConsistency hashes)
  dv.setFloat64(0, disc.x);
  var w = (dv.getUint32(0) ^ dv.getUint32(4)) >>> 0;
  out(JSON.stringify({ wire: wire, read: read, stepped: stepped, xorWord: w.toString(16), arrow: arrow, kickOfficial: kickOfficial, kickNodeHaxball: kickNodeHaxball, fresh: fresh }));
})();
