import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ApprovalRequired, makePrompter } from '../src/confirm.js';

const sink = () => {
  const chunks: string[] = [];
  return { write: (s: string) => void chunks.push(s), text: () => chunks.join('') };
};
const tty = (answers: string) => {
  const s = Object.assign(new PassThrough(), { isTTY: true });
  s.end(answers);
  return s;
};

describe('confirmation steps', () => {
  it('without a terminal and without --yes it never prompts and never waits', async () => {
    const out = sink();
    const p = makePrompter({ yes: false, stdin: Object.assign(new PassThrough(), { isTTY: false }), stdout: { isTTY: true }, out, env: {} });
    await expect(p.ask('Continue? (y/N)', 'the plan')).rejects.toThrow(ApprovalRequired);
    await expect(p.ask('Continue? (y/N)', 'the plan')).rejects.toThrow(/--yes/);
    expect(out.text()).toBe('');
  });

  it('CI=true counts as non-interactive even on a terminal', async () => {
    const p = makePrompter({ yes: false, stdin: tty('y\n'), stdout: { isTTY: true }, out: sink(), env: { CI: 'true' } });
    expect(p.interactive).toBe(false);
    await expect(p.ask('q', 'x')).rejects.toThrow(ApprovalRequired);
  });

  it('--yes approves without a terminal', async () => {
    const p = makePrompter({ yes: true, stdin: Object.assign(new PassThrough(), { isTTY: false }), stdout: { isTTY: false }, out: sink(), env: {} });
    await expect(p.ask('Continue? (y/N)', 'the plan')).resolves.toBe(true);
  });

  it('an empty answer means No, and so does anything but y or yes', async () => {
    const p = makePrompter({ yes: false, stdin: tty('\nmaybe\nn\n'), stdout: { isTTY: true }, out: sink(), env: {} });
    expect(await p.ask('a (y/N)', 'x')).toBe(false);
    expect(await p.ask('b (y/N)', 'x')).toBe(false);
    expect(await p.ask('c (y/N)', 'x')).toBe(false);
  });

  it('a closed stdin means No', async () => {
    const p = makePrompter({ yes: false, stdin: tty(''), stdout: { isTTY: true }, out: sink(), env: {} });
    expect(await p.ask('a (y/N)', 'x')).toBe(false);
  });

  it('y and YES mean yes', async () => {
    const p = makePrompter({ yes: false, stdin: tty('y\nYES\n'), stdout: { isTTY: true }, out: sink(), env: {} });
    expect(await p.ask('a', 'x')).toBe(true);
    expect(await p.ask('b', 'x')).toBe(true);
  });
});
