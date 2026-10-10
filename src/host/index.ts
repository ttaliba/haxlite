/**
 * src/host — the authoritative host engine (sequencer / netcode): 60 Hz
 * frame clock with catch-up, client event scheduling (official `Wa.Mh`),
 * host events (`oc`), heartbeats (msg 3), join snapshot (msg 1),
 * CheckConsistency, pings, kicks/bans, host actions and `.hbr2` recording.
 * See src/host/README.md (facade contract) and docs/04.
 */
export {
  HostConnection,
  HostDefaults,
  HostRoom,
  createHostRoomState,
  type DiscProperties,
  type DiscPropsInput,
  type HostRoomOptions,
  type Scores,
} from './host-room.js';
export {
  MovingAverage,
  ProtocolViolation,
  Sequencer,
  SequencerClient,
  encodePong,
  encodeTargetedEvent,
  type BeforeOperationHook,
  type SequencerOptions,
  type SequencerSink,
} from './sequencer.js';
