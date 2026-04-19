import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import { createAgentSession } from "../src/core/sdk.js";

interface ReadTruncationDetails {
	truncated?: boolean;
	truncatedBy?: "lines" | "bytes" | null;
	maxLines?: number;
	maxBytes?: number;
}

describe("createAgentSession readTool settings", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-read-settings-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function writeProjectSettings(settings: Record<string, unknown>): void {
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(settings));
	}

	async function executeRead(
		testFile: string,
		options?: { offset?: number; limit?: number },
	): Promise<{ output: string; truncation: ReadTruncationDetails | undefined }> {
		const { session } = await createAgentSession({
			cwd,
			agentDir,
		});

		try {
			const readDefinition = session.getToolDefinition("read");
			if (!readDefinition) throw new Error("read tool definition should be available");

			const result = await readDefinition.execute(
				"read-test",
				{ path: testFile, offset: options?.offset, limit: options?.limit },
				undefined,
				undefined,
				{} as ExtensionContext,
			);
			const output = result.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			const truncation = (result.details as { truncation?: ReadTruncationDetails } | undefined)?.truncation;

			return { output, truncation };
		} finally {
			session.dispose();
		}
	}

	it("uses built-in defaults when readTool settings are not configured", async () => {
		const testFile = join(cwd, "default-limits.txt");
		const lines = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`);
		writeFileSync(testFile, lines.join("\n"));

		const { output, truncation } = await executeRead(testFile);

		expect(output).toContain("Line 1");
		expect(output).toContain("Line 2000");
		expect(output).not.toContain("Line 2001");
		expect(output).toContain("[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]");
		expect(truncation?.truncatedBy).toBe("lines");
		expect(truncation?.maxLines).toBe(2000);
		expect(truncation?.maxBytes).toBe(50 * 1024);
	});

	it("applies only maxLines override", async () => {
		writeProjectSettings({ readTool: { maxLines: 25 } });

		const testFile = join(cwd, "line-limit-override.txt");
		const lines = Array.from({ length: 80 }, (_, i) => `Line ${i + 1}`);
		writeFileSync(testFile, lines.join("\n"));

		const { output, truncation } = await executeRead(testFile);

		expect(output).toContain("Line 1");
		expect(output).toContain("Line 25");
		expect(output).not.toContain("Line 26");
		expect(output).toContain("[Showing lines 1-25 of 80. Use offset=26 to continue.]");
		expect(truncation?.truncatedBy).toBe("lines");
		expect(truncation?.maxLines).toBe(25);
		expect(truncation?.maxBytes).toBe(50 * 1024);
	});

	it("applies only maxBytes override", async () => {
		writeProjectSettings({ readTool: { maxBytes: 512 } });

		const testFile = join(cwd, "byte-limit-override.txt");
		const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}: ${"x".repeat(80)}`);
		writeFileSync(testFile, lines.join("\n"));

		const { output, truncation } = await executeRead(testFile);

		expect(output).toContain("Line 1:");
		expect(output).toMatch(/\[Showing lines 1-\d+ of 100 \(512B limit\)\. Use offset=\d+ to continue\.\]/);
		expect(truncation?.truncatedBy).toBe("bytes");
		expect(truncation?.maxLines).toBe(2000);
		expect(truncation?.maxBytes).toBe(512);
	});

	it("lets explicit limit exceed configured maxLines", async () => {
		writeProjectSettings({ readTool: { maxLines: 25, maxBytes: 50 * 1024 } });

		const testFile = join(cwd, "limit-overrides-max-lines.txt");
		const lines = Array.from({ length: 80 }, (_, i) => `Line ${i + 1}`);
		writeFileSync(testFile, lines.join("\n"));

		const { output, truncation } = await executeRead(testFile, { limit: 60 });

		expect(output).toContain("Line 1");
		expect(output).toContain("Line 60");
		expect(output).not.toContain("Line 61");
		expect(output).toContain("[20 more lines in file. Use offset=61 to continue.]");
		expect(truncation).toBeUndefined();
	});

	it("applies maxLines and maxBytes overrides together", async () => {
		writeProjectSettings({ readTool: { maxLines: 25, maxBytes: 50 * 1024 } });

		const testFile = join(cwd, "both-overrides.txt");
		const lines = Array.from({ length: 80 }, (_, i) => `Line ${i + 1}`);
		writeFileSync(testFile, lines.join("\n"));

		const { output, truncation } = await executeRead(testFile);

		expect(output).toContain("Line 1");
		expect(output).toContain("Line 25");
		expect(output).not.toContain("Line 26");
		expect(output).toContain("[Showing lines 1-25 of 80. Use offset=26 to continue.]");
		expect(truncation?.truncatedBy).toBe("lines");
		expect(truncation?.maxLines).toBe(25);
		expect(truncation?.maxBytes).toBe(50 * 1024);
	});
});
