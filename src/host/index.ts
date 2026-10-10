/**
 * src/host — sequencer / netcode (PHASE 2): host frame clock (60 Hz,
 * catch-up loop), event scheduling (frame + order, clamp to [frame, frame+20],
 * input delay 2), broadcast (msg 2), frame sync (msg 3), join snapshot
 * (msg 1), CheckConsistency every 600 frames, Ping event every 3 s.
 * See docs/04.
 */
export {};
