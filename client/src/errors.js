export class PtyError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PtyError';
    this.code = code || 'PTY_ERROR';
  }
}

export class PtyTimeoutError extends PtyError {
  constructor(message = 'Request timeout') {
    super(message, 'PTY_TIMEOUT');
    this.name = 'PtyTimeoutError';
  }
}

export class PtyNotConnectedError extends PtyError {
  constructor(message = 'Transport not connected') {
    super(message, 'PTY_NOT_CONNECTED');
    this.name = 'PtyNotConnectedError';
  }
}

export class PtyRpcError extends PtyError {
  constructor(message, payload) {
    super(message, 'PTY_RPC_ERROR');
    this.name = 'PtyRpcError';
    this.payload = payload;
  }
}