import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		globals: true,
		include: ["./tests/**/*.test.ts"],
		exclude: ["./tests/integration/**"],
		coverage: {
			include: ["./src/**/*.ts"],
			exclude: ["./src/**/*.d.ts"],
			reporter: ["text", "lcov", "html"],
		},
		clearMocks: true,
		restoreMocks: true,
		mockReset: true,
	},
});
