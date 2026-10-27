export interface PtyClientOptions {
  url: string;
  secretKey?: string;
  userId?: string;
  sessionId?: string;
  timeout?: number;
  autoReconnect?: boolean;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}

export interface ShellInfo {
  id: string;
  label: string;
  backend: 'ssh' | 'local';
  path?: string;
  args?: string[];
}

export interface TerminalInfo {
  termId: string;
  pid: number;
  backend: 'ssh' | 'local';
  shellId?: string | null;
  remoteShell?: string | null;
  bin?: string;
  cols: number;
  rows: number;
  cwd?: string;
  createdAt: number;
  lastActiveAt: number;
  exited: boolean;
  exitCode: number | null;
}

export interface CreateTerminalOptions {
  cols?: number;
  rows?: number;
  backend?: 'ssh' | 'local';
  /** local 模式使用 */
  shellId?: string;
  /** ssh 模式使用 */
  remoteShell?: string;
  /** local 模式可追加的启动参数 */
  args?: string[];
  /** local 模式的 cwd */
  cwd?: string;
}

export interface RttermMessage {
  channel: 'rtterm';
  notify_type: string;
  data: string | number;
  err_flag: boolean;
  ended: boolean;
  code?: number;
  signal?: number;
  backend?: string;
  replay?: boolean;
}

export class PtyTerminal {
  termId: string;
  info: TerminalInfo | null;
  exited: boolean;
  attachXterm(xterm: any, opts?: { autoResize?: boolean; copyPaste?: boolean }): this;
  onData(fn: (data: string) => void): this;
  onExit(fn: (info: { termId: string; code?: number; signal?: number; error?: string | null }) => void): this;
  write(data: string): Promise<any>;
  resize(cols: number, rows: number): Promise<any>;
  destroy(): Promise<any>;
  detach(): void;
  dispose(): void;
}

export class PtyClient {
  constructor(opts: PtyClientOptions);
  readonly connected: boolean;
  connect(): Promise<this>;
  disconnect(): void;
  setSecretKey(key: string): void;

  listBackends(): Promise<{ backends: string[]; default: string | null }>;
  listShells(): Promise<{ shells: ShellInfo[] }>;
  listTerminals(): Promise<TerminalInfo[]>;
  checkPasswordRequired(): Promise<boolean>;

  createTerminal(opts?: CreateTerminalOptions): Promise<PtyTerminal>;
  createTerminal(cols?: number, rows?: number): Promise<PtyTerminal>;
  attachTerminal(termId: string): Promise<PtyTerminal>;
  detachTerminal(termId: string): Promise<void>;
  write(termId: string, data: string): Promise<any>;
  resize(termId: string, cols: number, rows: number): Promise<any>;
  destroy(termId: string): Promise<any>;

  on(event: string, fn: (...args: any[]) => void): () => void;
  off(event: string, fn: (...args: any[]) => void): void;
  once(event: string, fn: (...args: any[]) => void): () => void;
}

export class Transport {
  constructor(opts: PtyClientOptions);
  connect(): Promise<boolean>;
  request(action: string, params?: Record<string, any>): Promise<any>;
  close(): void;
  isReady(): boolean;
}

export class EventBus {
  on(event: string, fn: (...args: any[]) => void): () => void;
  once(event: string, fn: (...args: any[]) => void): () => void;
  off(event: string, fn: (...args: any[]) => void): void;
  emit(event: string, payload?: any): void;
  removeAll(event?: string): void;
}

export class PtyError extends Error { code: string; }
export class PtyTimeoutError extends PtyError {}
export class PtyNotConnectedError extends PtyError {}
export class PtyRpcError extends PtyError { payload: any; }