import { createInterface } from "node:readline";

export interface Choice<T extends string> {
	value: T;
	label: string;
}

/** Asks questions. The CLI uses `readlinePrompter`; tests pass a scripted implementation. */
export interface Prompter {
	/** Asks for text. `validate` returns an error message to ask again, or `undefined` to accept. */
	ask(
		question: string,
		options?: { defaultValue?: string; validate?: (answer: string) => string | undefined },
	): Promise<string>;
	/** Asks to pick one of `choices`, by number or value. */
	choose<T extends string>(question: string, choices: readonly Choice<T>[], defaultValue: T): Promise<T>;
	/** Asks a yes/no question. */
	confirm(question: string, defaultValue: boolean): Promise<boolean>;
	close(): void;
}

/**
 * A prompter on stdin/stdout (or the given streams). Lines are queued as they arrive, so piped
 * input (`printf "v66.0\n..." | sobjectly init`) works too. If the input ends before a question
 * is answered, the question rejects.
 */
export function readlinePrompter(
	input: NodeJS.ReadableStream = process.stdin,
	output: NodeJS.WritableStream = process.stdout,
): Prompter {
	const interactive = (input as { isTTY?: boolean }).isTTY === true;
	const rl = createInterface({ input, output, terminal: interactive });
	const lines: string[] = [];
	let waiting: { resolve: (line: string) => void; reject: (error: Error) => void } | undefined;
	let closed = false;

	rl.on("line", (line) => {
		if (waiting) {
			const { resolve } = waiting;
			waiting = undefined;
			resolve(line);
		} else {
			lines.push(line);
		}
	});
	rl.on("close", () => {
		closed = true;
		waiting?.reject(new Error("Input ended before all questions were answered."));
		waiting = undefined;
	});

	const readLine = (prompt: string): Promise<string> => {
		if (closed) {
			// Piped input can end while answers are still queued; readline can't prompt after close.
			output.write(prompt);
		} else {
			rl.setPrompt(prompt);
			rl.prompt();
		}
		const queued = lines.shift();
		if (queued !== undefined) {
			if (!interactive) {
				output.write(`${queued}\n`);
			}
			return Promise.resolve(queued);
		}
		if (closed) {
			return Promise.reject(new Error("Input ended before all questions were answered."));
		}
		return new Promise((resolve, reject) => {
			waiting = {
				resolve: (line: string): void => {
					if (!interactive) {
						output.write(`${line}\n`);
					}
					resolve(line);
				},
				reject,
			};
		});
	};

	const ask: Prompter["ask"] = async (question, options = {}) => {
		const suffix = options.defaultValue ? ` (${options.defaultValue})` : "";
		for (;;) {
			const raw = (await readLine(`? ${question}${suffix}: `)).trim();
			const answer = raw === "" ? (options.defaultValue ?? "") : raw;
			const error = options.validate?.(answer);
			if (error === undefined) {
				return answer;
			}
			output.write(`  ${error}\n`);
		}
	};

	return {
		ask,
		async choose(question, choices, defaultValue) {
			output.write(`? ${question}\n`);
			choices.forEach((choice, index) => {
				output.write(`  ${index + 1}) ${choice.label}${choice.value === defaultValue ? " (default)" : ""}\n`);
			});
			const answer = await ask("Choose a number", {
				defaultValue: String(choices.findIndex((choice) => choice.value === defaultValue) + 1),
				validate: (value) => (pick(choices, value) ? undefined : `Enter a number from 1 to ${choices.length}.`),
			});
			return (pick(choices, answer) ?? choices[0]).value;
		},
		async confirm(question, defaultValue) {
			const answer = await ask(`${question} ${defaultValue ? "(Y/n)" : "(y/N)"}`, {
				validate: (value) => (value === "" || /^(y|yes|n|no)$/i.test(value) ? undefined : "Answer y or n."),
			});
			return answer === "" ? defaultValue : /^y/i.test(answer);
		},
		close() {
			rl.close();
		},
	};
}

function pick<T extends string>(choices: readonly Choice<T>[], answer: string): Choice<T> | undefined {
	const index = Number(answer);
	if (Number.isInteger(index) && index >= 1 && index <= choices.length) {
		return choices[index - 1];
	}
	return choices.find((choice) => choice.value.toLowerCase() === answer.toLowerCase());
}
