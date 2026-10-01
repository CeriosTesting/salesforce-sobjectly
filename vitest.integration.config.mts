import { existsSync } from "node:fs";

import { defineConfig } from "vitest/config";

// Credentials for the live org come from the environment or a local `.env` (never committed).
if (existsSync(".env")) {
	process.loadEnvFile(".env");
}

export default defineConfig({
	test: {
		environment: "node",
		include: ["./tests/integration/**/*.test.ts"],
		testTimeout: 120_000,
		hookTimeout: 120_000,
		// The tests share one org; run files one after another.
		fileParallelism: false,
	},
});
