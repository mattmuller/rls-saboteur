import { createInterface } from 'node:readline';

/** Thrown when a question needs a person and there is none, and --yes was not given. Exit code 2. */
export class ApprovalRequired extends Error {
  constructor(what: string) {
    super(
      `Not running: this needs your approval and there is no terminal to ask on.\n` +
        `Needed: ${what}\n` +
        `Pass --yes to approve the plan (temporary copies; your database is not changed) and a test command that comes from .rls-saboteur.json. ` +
        `--yes does NOT approve closing other sessions on your database: that needs its own flag, --close-sessions.`
    );
    this.name = 'ApprovalRequired';
  }
}

/**
 * Text from the project or the database (a config-file command, a database or application name) shown
 * in a question. Control characters, terminal escape sequences and bidirectional overrides are written
 * out visibly (\x1b, \u202e, \n), so the text on screen is exactly what will run or be touched: a
 * hostile .rls-saboteur.json cannot draw "npm test" over a different command.
 */
export function visible(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/g, (c) => {
    if (c === '\n') return '\\n';
    if (c === '\t') return '\\t';
    const code = c.charCodeAt(0);
    return code <= 0xff ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}

/** A whole question: our own line breaks stay, any other control character is made visible. */
function safeQuestion(text: string): string {
  return text.split('\n').map(visible).join('\n');
}

export interface Prompter {
  /** True when a person can answer. */
  readonly interactive: boolean;
  /** Ask a yes/no question. Default is No. Resolves false for anything but y or yes. */
  ask(question: string, needed: string): Promise<boolean>;
  /**
   * A question that --yes does NOT answer (closing other sessions on the database). It is approved by its own
   * flag. Otherwise a person must answer it; with no terminal it throws ApprovalRequired naming that flag.
   */
  askSeparate(question: string, needed: string, flagApproved: boolean, flagName: string): Promise<boolean>;
  say(text: string): void;
}

export interface PrompterOptions {
  yes: boolean;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout?: { isTTY?: boolean };
  /** Where questions are written. Default: process.stderr. */
  out?: { write(s: string): unknown };
  env?: NodeJS.ProcessEnv;
}

export function makePrompter(o: PrompterOptions): Prompter {
  const stdin = o.stdin ?? process.stdin;
  const stdout = o.stdout ?? process.stdout;
  const out = o.out ?? process.stderr;
  const env = o.env ?? process.env;
  const interactive = Boolean(stdin.isTTY) && Boolean(stdout.isTTY) && env.CI !== 'true';
  let lines: string[] | null = null;
  let waiting: ((l: string) => void) | null = null;
  let closed = false;

  const start = (): void => {
    if (lines) return;
    lines = [];
    const rl = createInterface({ input: stdin });
    rl.on('line', (l) => {
      if (waiting) {
        const w = waiting;
        waiting = null;
        w(l);
      } else lines!.push(l);
    });
    rl.on('close', () => {
      closed = true;
      if (waiting) {
        const w = waiting;
        waiting = null;
        w('');
      }
    });
  };
  const nextLine = (): Promise<string> => {
    start();
    if (lines!.length) return Promise.resolve(lines!.shift()!);
    if (closed) return Promise.resolve('');
    return new Promise((r) => (waiting = r));
  };

  return {
    interactive,
    say: (t) => void out.write(t.endsWith('\n') ? t : t + '\n'),
    async ask(question, needed) {
      if (o.yes) {
        out.write(`${safeQuestion(question)} yes (approved with --yes)\n`);
        return true;
      }
      if (!interactive) throw new ApprovalRequired(needed);
      out.write(`${safeQuestion(question)} `);
      const answer = (await nextLine()).trim();
      return /^y(es)?$/i.test(answer);
    },
    async askSeparate(question, needed, flagApproved, flagName) {
      if (flagApproved) {
        out.write(`${safeQuestion(question)} yes (approved with ${flagName})\n`);
        return true;
      }
      if (!interactive) throw new ApprovalRequired(`${needed}. Pass ${flagName} to approve it (--yes does not)`);
      out.write(`${safeQuestion(question)} `);
      const answer = (await nextLine()).trim();
      return /^y(es)?$/i.test(answer);
    }
  };
}
