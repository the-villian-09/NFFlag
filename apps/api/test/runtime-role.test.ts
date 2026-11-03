import { describe, expect, it } from "vitest";
import { runtimeLogin } from "../src/db/runtime-role.js";

describe("runtime database login", () => {
  it("reads Cloud SQL socket addresses (no host) and ordinary ones", () => {
    const pw = "a".repeat(48);
    expect(runtimeLogin(`postgres://nffl_runtime:${pw}@/nffl?host=/cloudsql/proj:us-east1:nffl-staging`)).toEqual({ user: "nffl_runtime", password: pw });
    expect(runtimeLogin(`postgresql://nffl_runtime:${pw}@localhost:5432/nffl`)).toEqual({ user: "nffl_runtime", password: pw });
    expect(() => runtimeLogin("postgres://nffl_runtime:short@/nffl")).toThrow(/long password/);
    expect(() => runtimeLogin("mysql://x:y@/z")).toThrow();
  });
});
