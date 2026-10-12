import readline from 'node:readline';

/** Ask a question on the terminal; with `secret`, typed characters are not echoed. */
export function ask(question: string, secret = false): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error(`Cannot prompt for "${question.trim()}" without a terminal. Pass it as a flag or env var.`));
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    let muted = false;
    const writable = rl as unknown as { _writeToOutput: (s: string) => void };
    const original = writable._writeToOutput.bind(rl);
    writable._writeToOutput = (s: string) => {
      if (!muted) original(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      if (secret) process.stderr.write('\n');
      resolve(answer.trim());
    });
    muted = secret;
  });
}
