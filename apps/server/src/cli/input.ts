/** Console input for the command-line tools: secrets are typed without echo, or piped one per line. */
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

/** Reads lines from stdin; hides typing when attached to a terminal. */
export function lineReader(): {
  ask(prompt: string, secret?: boolean): Promise<string>;
  close(): void;
} {
  let muted = false;
  const output = new Writable({
    write(chunk: Buffer, _encoding, done) {
      if (!muted) process.stdout.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY });
  const lines = rl[Symbol.asyncIterator]();
  return {
    async ask(prompt, secret = false) {
      process.stdout.write(prompt);
      muted = secret && process.stdin.isTTY;
      const next = await lines.next();
      muted = false;
      if (secret && process.stdin.isTTY) process.stdout.write('\n');
      if (next.done) throw new Error('No input');
      return next.value;
    },
    close: () => {
      rl.close();
    },
  };
}
