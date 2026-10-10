/**
 * Process-level node-datachannel teardown. libdatachannel keeps worker
 * threads alive; call this once when the process is done with WebRTC (after
 * every HostTransport has been stopped) so Node can exit.
 */
import { cleanup } from 'node-datachannel';

export function shutdownWebRtc(): void {
  cleanup();
}
