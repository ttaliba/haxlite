/** Shared test stadium (.hbs): curves, bias, joints, gravity, spawn points, full kick-off reset. */
export const CUSTOM_HBS = `{
  "name": "haxlite test arena",
  "width": 300, "height": 160, "spawnDistance": 120, "kickOffReset": "full",
  "bg": { "type": "grass", "width": 260, "height": 130, "kickOffRadius": 60, "cornerRadius": 20 },
  "traits": { "wall": { "vis": true, "bCoef": 0.8, "cMask": ["ball", "red", "blue"] } },
  "vertexes": [
    { "x": -260, "y": -130, "trait": "wall" }, { "x": 260, "y": -130, "trait": "wall" },
    { "x": 260, "y": 130, "trait": "wall" }, { "x": -260, "y": 130, "trait": "wall" },
    { "x": -260, "y": -40 }, { "x": -260, "y": 40 }, { "x": 260, "y": -40 }, { "x": 260, "y": 40 }
  ],
  "segments": [
    { "v0": 0, "v1": 1, "trait": "wall", "curve": 20 },
    { "v0": 2, "v1": 3, "trait": "wall", "curve": -30, "bias": 10 },
    { "v0": 0, "v1": 4, "trait": "wall" }, { "v0": 5, "v1": 3, "trait": "wall" },
    { "v0": 1, "v1": 6, "trait": "wall", "curveF": 0.5 }, { "v0": 7, "v1": 2, "trait": "wall", "bias": -5 }
  ],
  "goals": [ { "p0": [-260, -40], "p1": [-260, 40], "team": "red" }, { "p0": [260, -40], "p1": [260, 40], "team": "blue" } ],
  "planes": [ { "normal": [0, 1], "dist": -160 }, { "normal": [0, -1], "dist": -160 }, { "normal": [1, 0], "dist": -300, "bCoef": 0.2 }, { "normal": [-1, 0], "dist": -300 } ],
  "discs": [
    { "pos": [0, 80], "radius": 6, "invMass": 2, "color": "FF00FF", "cGroup": ["ball", "kick"] },
    { "pos": [0, -80], "radius": 6, "invMass": 1, "gravity": [0, 0.01], "damping": 0.98 },
    { "pos": [-260, -40], "radius": 5, "invMass": 0 }, { "pos": [260, 40], "radius": 5, "invMass": 0 }
  ],
  "joints": [ { "d0": 1, "d1": 2, "length": [40, 90], "strength": 0.05 }, { "d0": 0, "d1": 1, "strength": "rigid" } ],
  "redSpawnPoints": [[-100, 0], [-100, 50]], "blueSpawnPoints": [[100, 0]],
  "playerPhysics": { "kickStrength": 6, "kickback": 1.5, "acceleration": 0.12, "radius": 14 },
  "ballPhysics": { "radius": 8, "bCoef": 0.6 }
}`;
