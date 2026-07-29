import { createHash } from 'node:crypto';
import { bytesToHex, hasPrefix } from './hex';

export const ANCHOR_CPI_EVENT_TAG = Uint8Array.from([228, 69, 165, 46, 81, 203, 154, 29]);

export function anchorDiscriminator(namespace: 'event' | 'global' | 'account', name: string): Uint8Array {
  const digest = createHash('sha256').update(`${namespace}:${name}`).digest();
  return Uint8Array.from(digest.subarray(0, 8));
}

export function anchorEventDiscriminatorHex(name: string): string {
  return bytesToHex(anchorDiscriminator('event', name));
}

export interface AnchorCpiPayload {
  eventDiscriminator: Uint8Array;
  eventDiscriminatorHex: string;
  payload: Uint8Array;
}

export function unwrapAnchorCpiEvent(data: Uint8Array): AnchorCpiPayload | null {
  if (!hasPrefix(data, ANCHOR_CPI_EVENT_TAG) || data.length < 16) return null;
  const eventDiscriminator = data.slice(8, 16);
  return {
    eventDiscriminator,
    eventDiscriminatorHex: bytesToHex(eventDiscriminator),
    payload: data.slice(16),
  };
}
