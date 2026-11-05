// Copyright 2026 Jason (AllIn)
// SPDX-License-Identifier: AGPL-3.0-only

// AllIn: hands relay messages from AllIn on the user's phone (SyncMessage.allinRelay, received in
// MessageReceiver) to the phone texts store, which registers itself here when it starts.

type Handler = (bytes: Uint8Array) => void;

let handler: Handler | undefined;
const early: Array<Uint8Array> = [];

export function setAllInRelayHandler(next: Handler): void {
  handler = next;
  early.splice(0).forEach(next);
}

export function deliverAllInRelay(bytes: Uint8Array): void {
  if (handler) {
    handler(bytes);
  } else if (early.length < 50) {
    early.push(bytes);
  }
}
