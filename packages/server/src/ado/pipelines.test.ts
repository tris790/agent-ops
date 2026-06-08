import { expect, test, describe } from "bun:test";
import { parseYamlParameters } from "./pipelines.js";

describe("parseYamlParameters", () => {
  test("parses name/type/default and enum values", () => {
    const yaml = `
trigger:
  - main

parameters:
  - name: deployEnv
    type: string
    default: dev
    values:
      - dev
      - staging
      - prod
  - name: runTests
    type: boolean
    default: true
  - name: copies
    type: number
    default: 1

stages:
  - stage: build
`;
    const params = parseYamlParameters(yaml);
    expect(params).toEqual([
      { name: "deployEnv", type: "string", default: "dev", allowed: ["dev", "staging", "prod"] },
      { name: "runTests", type: "boolean", default: "true", allowed: undefined },
      { name: "copies", type: "number", default: "1", allowed: undefined },
    ]);
  });

  test("returns [] when there is no parameters block", () => {
    expect(parseYamlParameters("steps:\n  - script: echo hi\n")).toEqual([]);
  });

  test("handles quoted defaults", () => {
    const yaml = `parameters:\n  - name: tag\n    type: string\n    default: "v1.0"\n`;
    expect(parseYamlParameters(yaml)).toEqual([
      { name: "tag", type: "string", default: "v1.0", allowed: undefined },
    ]);
  });

  test("ignores an indented (non-top-level) parameters key", () => {
    const yaml = `jobs:\n  - job: a\n    parameters:\n      - name: nope\n        type: string\n`;
    expect(parseYamlParameters(yaml)).toEqual([]);
  });
});
