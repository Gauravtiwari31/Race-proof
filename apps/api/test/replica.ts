import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appDbUrl } from './urls.js';

export interface Replica {
  url: string;
  process: ChildProcess;
  /** Resolves when the process has exited, however it died. */
  exited: Promise<number | null>;
}

/** A separate OS process running the real entry point, so nothing can be shared by accident. */
export function startReplica(extraEnv: Record<string, string> = {}): Promise<Replica> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      DATABASE_URL: appDbUrl,
      PORT: '0',
      HOST: '127.0.0.1',
      LOG_LEVEL: 'silent',
      PG_POOL_MAX: '10',
      INVITE_LIMIT_PER_IP: '1000000', // every test request shares 127.0.0.1
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return new Promise((resolve, reject) => {
    child.stdout!.on('data', (chunk: Buffer) => {
      const match = /listening (\S+)/.exec(chunk.toString());
      if (match) resolve({ url: match[1]!, process: child, exited });
    });
    void exited.then((code) => reject(new Error(`replica exited early with ${code}`)));
  });
}
