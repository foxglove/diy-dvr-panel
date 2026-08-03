// Unit tests for the pure modules (captureEngine, settings). Node environment on
// purpose: there is no DOM, no Worker, and no Foxglove app here — captureEngine takes
// an injected OPFS store and clock so it runs as plain TypeScript.
//
// ts-jest compiles through tsconfig.test.json, which overrides only the module format
// (the repo tsconfig targets a bundler with ESM, jest's default runtime is CommonJS).

/** @type {import("jest").Config} */
module.exports = {
  testEnvironment: "node",
  testMatch: ["<rootDir>/src/**/*.test.ts"],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.test.json" }],
  },
};
