import { execFile } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { type RunCommand, sfCli } from "../../src/auth/sf-cli";
import { SalesforceAuthError } from "../../src/errors";
import { FakeTransport } from "../helpers/fake-transport";

vi.mock("node:child_process", () => ({ execFile: vi.fn<() => void>() }));

const INSTANCE = "https://acme.my.salesforce.com";
const display = (accessToken = "[REDACTED] Use 'sf org auth show-access-token' to view"): string =>
	JSON.stringify({ status: 0, result: { instanceUrl: INSTANCE, accessToken, username: "me@acme.com" } });
const tokenJson = (accessToken: string): string => JSON.stringify({ status: 0, result: { accessToken } });

function runner(responses: Record<string, string | Error>): RunCommand & { calls: string[][] } {
	const calls: string[][] = [];
	const run = vi.fn<RunCommand>((_command, args) => {
		calls.push([...args]);
		const response = responses[args.slice(0, 3).join(" ")] ?? responses[args.slice(0, 2).join(" ")];
		if (response instanceof Error) {
			return Promise.reject(response);
		}
		return response === undefined
			? Promise.reject(new Error(`unexpected ${args.join(" ")}`))
			: Promise.resolve(response);
	});
	return Object.assign(run, { calls });
}

describe("sfCli", () => {
	it("gets the instance URL from org display and the token from show-access-token", async () => {
		const run = runner({ "org display": display(), "org auth show-access-token": tokenJson("00D!token") });
		const auth = sfCli({ targetOrg: "my-org", runCommand: run });
		const token = await auth.getToken({ transport: new FakeTransport() });
		expect(token).toEqual({ accessToken: "00D!token", instanceUrl: INSTANCE });
		expect(run.calls).toEqual([
			["org", "display", "--json", "--target-org", "my-org"],
			["org", "auth", "show-access-token", "--json", "--target-org", "my-org"],
		]);
		await auth.getToken({ transport: new FakeTransport() });
		expect(run.calls).toHaveLength(2);
	});

	it("asks the CLI again after invalidate", async () => {
		const run = runner({ "org display": display(), "org auth show-access-token": tokenJson("00D!token") });
		const auth = sfCli({ runCommand: run });
		const first = await auth.getToken({ transport: new FakeTransport() });
		auth.invalidate?.(first);
		await auth.getToken({ transport: new FakeTransport() });
		expect(run.calls).toHaveLength(4);
		expect(run.calls[0]).toEqual(["org", "display", "--json"]);
	});

	it("falls back to the display token on older CLIs", async () => {
		const run = runner({
			"org display": display("00D!legacy"),
			"org auth show-access-token": JSON.stringify({ status: 1, name: "CommandNotFound", message: "not a command" }),
		});
		const token = await sfCli({ runCommand: run }).getToken({ transport: new FakeTransport() });
		expect(token.accessToken).toBe("00D!legacy");
	});

	it("reports CLI errors, a missing CLI and redacted tokens", async () => {
		const failing = runner({ "org display": JSON.stringify({ status: 1, message: "No authorization for my-org" }) });
		await expect(sfCli({ runCommand: failing }).getToken({ transport: new FakeTransport() })).rejects.toThrow(
			/No authorization for my-org/,
		);

		const missing = runner({ "org display": Object.assign(new Error("spawn sf ENOENT"), { code: "ENOENT" }) });
		const error = await sfCli({ runCommand: missing })
			.getToken({ transport: new FakeTransport() })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(SalesforceAuthError);
		expect((error as Error).message).toMatch(/was not found/);

		const redacted = runner({ "org display": display(), "org auth show-access-token": tokenJson("[REDACTED]") });
		await expect(sfCli({ runCommand: redacted }).getToken({ transport: new FakeTransport() })).rejects.toThrow(
			/no usable access token/,
		);
		expect(() => sfCli({ targetOrg: "bad alias; rm -rf" })).toThrow(/invalid targetOrg/);
	});

	it("parses JSON preceded by update notices or warnings", async () => {
		const warning = " »   Warning: @salesforce/cli update available from 2.100.0 to 2.101.0.\n";
		const run = runner({
			"org display": `${warning}${display()}`,
			"org auth show-access-token": `Warning: deprecated flag\r\n${tokenJson("00D!token")}\n`,
		});
		const token = await sfCli({ runCommand: run }).getToken({ transport: new FakeTransport() });
		expect(token).toEqual({ accessToken: "00D!token", instanceUrl: INSTANCE });
	});

	it("reports output that is not JSON", async () => {
		const run = runner({ "org display": "Error: something went badly wrong" });
		const error = await sfCli({ runCommand: run })
			.getToken({ transport: new FakeTransport() })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(SalesforceAuthError);
		expect((error as Error).message).toBe(
			"`sf org display --json` did not return JSON: Error: something went badly wrong",
		);
	});

	it("requires an instance URL from org display", async () => {
		const run = runner({ "org display": JSON.stringify({ status: 0, result: { username: "me@acme.com" } }) });
		await expect(sfCli({ runCommand: run }).getToken({ transport: new FakeTransport() })).rejects.toThrow(
			/returned no instanceUrl/,
		);
	});
});

type ExecError = Error & { code?: string | number };
type ExecCallback = (error: ExecError | null, stdout: string, stderr: string) => void;
interface ExecCall {
	file: string;
	args: string[];
	options: { windowsVerbatimArguments?: boolean; windowsHide?: boolean; env?: NodeJS.ProcessEnv };
}

/** Makes the mocked `execFile` answer every call with `result`, recording the calls. */
function mockExecFile(result: (call: ExecCall) => { error?: ExecError; stdout?: string; stderr?: string }): ExecCall[] {
	const calls: ExecCall[] = [];
	vi.mocked(execFile).mockImplementation(((
		file: string,
		args: string[],
		options: ExecCall["options"],
		callback: ExecCallback,
	) => {
		const call = { file, args, options };
		calls.push(call);
		const { error, stdout = "", stderr = "" } = result(call);
		queueMicrotask(() => callback(error ?? null, stdout, stderr));
		return {};
	}) as unknown as typeof execFile);
	return calls;
}

const execError = (message: string, code: string | number): ExecError => Object.assign(new Error(message), { code });

describe("sfCli default command runner", () => {
	const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
	const setPlatform = (value: NodeJS.Platform): void => {
		Object.defineProperty(process, "platform", { ...platform, value });
	};

	afterEach(() => {
		Object.defineProperty(process, "platform", platform);
	});

	const answers = (call: ExecCall): { stdout: string } => {
		const commandLine = call.args.join(" ");
		return { stdout: commandLine.includes("show-access-token") ? tokenJson("00D!token") : display() };
	};

	it("runs sf directly without a shell outside Windows", async () => {
		setPlatform("linux");
		const calls = mockExecFile(answers);
		const token = await sfCli({ targetOrg: "my-org" }).getToken({ transport: new FakeTransport() });
		expect(token).toEqual({ accessToken: "00D!token", instanceUrl: INSTANCE });
		expect(calls.map((call) => [call.file, ...call.args])).toEqual([
			["sf", "org", "display", "--json", "--target-org", "my-org"],
			["sf", "org", "auth", "show-access-token", "--json", "--target-org", "my-org"],
		]);
		expect(calls[0]?.options).toMatchObject({ windowsVerbatimArguments: false, windowsHide: true });
		expect(calls[0]?.options.env?.SF_JSON_TO_STDOUT).toBe("true");
	});

	it("turns colors off, even when FORCE_COLOR is set", async () => {
		vi.stubEnv("FORCE_COLOR", "1");
		try {
			const calls = mockExecFile(answers);
			await sfCli().getToken({ transport: new FakeTransport() });
			expect(calls[0]?.options.env?.NO_COLOR).toBe("1");
			expect(calls[0]?.options.env).not.toHaveProperty("FORCE_COLOR");
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("runs the .cmd shim through cmd.exe on Windows with one quoted command line", async () => {
		setPlatform("win32");
		const calls = mockExecFile(answers);
		await sfCli({ targetOrg: "my-org", command: "C:\\Program Files\\sf\\bin\\sf.cmd" }).getToken({
			transport: new FakeTransport(),
		});
		expect(calls[0]?.file).toBe("cmd.exe");
		expect(calls[0]?.args).toEqual([
			"/d",
			"/s",
			"/c",
			'""C:\\Program Files\\sf\\bin\\sf.cmd" org display --json --target-org my-org"',
		]);
		expect(calls[0]?.options.windowsVerbatimArguments).toBe(true);
	});

	it("reports a missing CLI on Windows (exit code 9009)", async () => {
		setPlatform("win32");
		mockExecFile(() => ({
			error: execError("Command failed", 9009),
			stderr: "'sf' is not recognized as an internal or external command,\r\noperable program or batch file.",
		}));
		const error = await sfCli()
			.getToken({ transport: new FakeTransport() })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(SalesforceAuthError);
		expect((error as Error).message).toMatch(/The Salesforce CLI \(sf\) was not found\. Install it/);
	});

	it("reports a missing CLI on Windows from the cmd.exe message alone", async () => {
		setPlatform("win32");
		mockExecFile(() => ({
			error: execError("Command failed", 1),
			stderr: "'sf' is not recognized as an internal or external command",
		}));
		await expect(sfCli().getToken({ transport: new FakeTransport() })).rejects.toThrow(
			/The Salesforce CLI \(sf\) was not found/,
		);
	});

	it("reports a missing CLI elsewhere (ENOENT)", async () => {
		setPlatform("linux");
		mockExecFile(() => ({ error: execError("spawn sf ENOENT", "ENOENT") }));
		const error = await sfCli()
			.getToken({ transport: new FakeTransport() })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(SalesforceAuthError);
		expect((error as Error).message).toMatch(/The Salesforce CLI \(sf\) was not found\. Install it/);
	});

	it("reads the JSON error the CLI prints when it exits non-zero", async () => {
		setPlatform("linux");
		mockExecFile(() => ({
			error: execError("Command failed: sf org display --json", 1),
			stdout: JSON.stringify({
				status: 1,
				name: "NoOrgFound",
				message: "No authorization information found for my-org.",
			}),
		}));
		await expect(sfCli({ targetOrg: "my-org" }).getToken({ transport: new FakeTransport() })).rejects.toThrow(
			"`sf org display --json` failed: No authorization information found for my-org.",
		);
	});

	it("includes stderr when a failing CLI printed no JSON", async () => {
		setPlatform("linux");
		mockExecFile(() => ({ error: execError("Command failed: sf org display --json", 2), stderr: "  segfault  \n" }));
		await expect(sfCli().getToken({ transport: new FakeTransport() })).rejects.toThrow(
			"Command failed: sf org display --json\nsegfault",
		);
	});
});
