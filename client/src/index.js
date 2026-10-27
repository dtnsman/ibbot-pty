import { PtyClient } from './PtyClient.js';
import { PtyTerminal } from './PtyTerminal.js';
import { Transport } from './Transport.js';
import { EventBus } from './EventBus.js';
import {
  PtyError,
  PtyTimeoutError,
  PtyNotConnectedError,
  PtyRpcError
} from './errors.js';

// UMD 全局挂载
if (typeof window !== 'undefined') {
  window.IBotPty = {
    PtyClient,
    PtyTerminal,
    Transport,
    EventBus,
    PtyError,
    PtyTimeoutError,
    PtyNotConnectedError,
    PtyRpcError
  };
}

export {
  PtyClient,
  PtyTerminal,
  Transport,
  EventBus,
  PtyError,
  PtyTimeoutError,
  PtyNotConnectedError,
  PtyRpcError
};

export default {
  PtyClient,
  PtyTerminal,
  Transport,
  EventBus,
  PtyError,
  PtyTimeoutError,
  PtyNotConnectedError,
  PtyRpcError
};