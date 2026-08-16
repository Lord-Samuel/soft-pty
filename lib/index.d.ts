export interface IKillOptions {
  /** Milliseconds to wait before escalating to SIGKILL. Default 3000. */
  graceMs?: number;
  /** Set false to disable SIGKILL escalation entirely. Default true. */
  escalate?: boolean;
}

export interface ISpawnOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: { [key: string]: string | undefined };
  echo?: boolean;
  /** Pass null for raw Buffer 'data' chunks instead of decoded strings. */
  encoding?: string | null;
  handleFlowControl?: boolean;
  flowControlPause?: string;
  flowControlResume?: string;
  uid?: number;
  gid?: number;
  argv0?: string;
}

export interface IDisposable {
  dispose(): void;
}

export interface IExitEvent {
  exitCode: number | undefined;
  signal: string | undefined;
}

export declare class SoftPty {
  pid: number;
  process: string;
  cols: number;
  rows: number;
  spawnError: Error | null;
  handleFlowControl: boolean;

  constructor(file: string, args?: string[], opts?: ISpawnOptions);

  onData(callback: (data: string | Buffer) => void): IDisposable;
  onExit(callback: (e: IExitEvent) => void): IDisposable;

  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string, opts?: { graceMs?: number; escalate?: boolean }): void;
  pause(): void;
  resume(): void;
  clear(): void;
}

export declare function spawn(
  file: string,
  args?: string[],
  opts?: ISpawnOptions
): SoftPty;
