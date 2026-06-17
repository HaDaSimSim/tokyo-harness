import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		ignores: [
			"**/node_modules/**",
			"**/orchestrator/target/**",
			"**/dist/**",
			"**/*.test.ts",
			"orchestrator/tests/mock-pi.mjs",
		],
	},
	{
		rules: {
			"@typescript-eslint/no-explicit-any": "off",
			"@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
		},
	},
);
