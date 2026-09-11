// Terminal prompt adapter, kept behind this interface — text/secret/confirm/
// select — so the setup orchestration can be driven by scripted answers in
// tests without a TTY.
//
// One readline interface per question, closed before the answer is handed
// back. Nothing of ours reads stdin (or holds it in raw mode) between
// questions, so `wrangler login` and `wrangler deploy` — which inherit this
// terminal — own the keyboard while they run, and their prompts reach them.

import readline from "node:readline";

/** The user pressed Ctrl-C or closed stdin. */
export class AbortedError extends Error {
  constructor(message = "setup was cancelled") {
    super(message);
    this.name = "AbortedError";
  }
}

/**
 * Ask one question and release stdin again. `hidden` suppresses readline's
 * echo so a typed secret never reaches the screen.
 */
function ask({ input, output, query, hidden = false }) {
  return new Promise((resolve, reject) => {
    // Previous questions pause stdin when their interface closes; resume so
    // this one can read. After we close, stdin is paused again so an inherited
    // child (wrangler) owns the fd until the next question.
    if (typeof input.resume === "function") input.resume();

    const rl = readline.createInterface({ input, output, terminal: true });
    let settled = false;
    const settle = (done, value) => {
      if (settled) return;
      settled = true;
      rl.close();
      // close() pauses stdin. Keep it paused until the next question so an
      // inherited child (wrangler) owns the fd; emitKeypressEvents may leave a
      // decoder listener, but a paused stream does not steal bytes.
      if (typeof input.pause === "function") input.pause();
      done(value);
    };

    rl.on("SIGINT", () => settle(reject, new AbortedError()));
    rl.on("close", () => settle(reject, new AbortedError()));
    if (hidden) rl._writeToOutput = () => {};

    output.write(query);
    rl.question("", (answer) => {
      if (hidden) output.write("\n");
      settle(resolve, answer);
    });
  });
}

export function createPrompts({ input = process.stdin, output = process.stdout } = {}) {
  const question = (query, options) => ask({ input, output, query, ...options });

  return {
    print(text = "") {
      output.write(`${text}\n`);
    },
    async text(query, { defaultValue } = {}) {
      const suffix = defaultValue ? ` [${defaultValue}]` : "";
      const answer = (await question(`${query}${suffix}: `)).trim();
      return answer.length > 0 ? answer : (defaultValue ?? "");
    },
    async secret(query) {
      return (await question(`${query}: `, { hidden: true })).trim();
    },
    async confirm(query, { defaultValue = false } = {}) {
      const answer = (await question(`${query} ${defaultValue ? "[Y/n]" : "[y/N]"}: `)).trim().toLowerCase();
      if (answer.length === 0) return defaultValue;
      return answer === "y" || answer === "yes";
    },
    async select(query, choices) {
      output.write(`${query}\n`);
      choices.forEach((choice, i) => output.write(`  ${i + 1}) ${choice.label}\n`));
      for (;;) {
        const answer = (await question(`Choose 1-${choices.length}: `)).trim();
        const index = Number(answer);
        if (Number.isInteger(index) && index >= 1 && index <= choices.length) return choices[index - 1].value;
        output.write(`Enter a number between 1 and ${choices.length}.\n`);
      }
    },
  };
}
