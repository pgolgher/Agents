import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "tsconfig.json" }],
  },
  moduleFileExtensions: ["ts", "js", "json"],
  // Don't try to run the playwright-dependent browser code in tests
  moduleNameMapper: {
    "^playwright$": "<rootDir>/src/__mocks__/playwright.ts",
  },
  clearMocks: true,
  coverageDirectory: "coverage",
  collectCoverageFrom: [
    "src/agents/downloadAgent.ts",
    "src/agents/analysisAgent.ts",
  ],
};

export default config;
