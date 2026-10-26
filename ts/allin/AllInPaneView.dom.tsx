// Copyright 2026 Jason (AllIn)
// SPDX-License-Identifier: AGPL-3.0-only

// AllIn: what the Chats tab's conversation pane shows when an AllIn item is open instead of a Signal chat.

import type { JSX } from 'react';
import type { AllInPane } from './store.dom.ts';
import {
  GoogleVoiceConversationPane,
  NewGoogleVoicePane,
} from './GoogleVoicePane.dom.tsx';
import { FantasyPane } from './FantasyPane.dom.tsx';
import { AllInSettingsTab } from './AllInSettingsTab.dom.tsx';

export function AllInPaneView({ pane }: { pane: AllInPane }): JSX.Element {
  switch (pane.kind) {
    case 'googleVoice':
      return (
        <GoogleVoiceConversationPane
          key={pane.threadId}
          threadId={pane.threadId}
        />
      );
    case 'newGoogleVoice':
      return <NewGoogleVoicePane />;
    case 'fantasy':
      return <FantasyPane />;
    case 'settings':
      return <AllInSettingsTab />;
    default:
      return <div />;
  }
}
