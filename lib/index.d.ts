export interface ISpawnOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: { [key: string]: string | undefined };
  echo?: boolean;
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

  constructor(file: string, args?: string[], opts?: ISpawnOptions);

  onData(callback: (data: string) => void): IDisposable;
  onExit(callback: (e: IExitEvent) => void): IDisposable;

  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export declare function spawn(
  file: string,
  args?: string[],
  opts?: ISpawnOptions
): SoftPty;
