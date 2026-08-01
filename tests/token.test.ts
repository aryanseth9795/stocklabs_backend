import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import {
  generateToken,
  generateTokenPair,
  verifyAccessToken,
  verifyRefreshToken,
} from "../src/utils/token.js";

/**
 * Regression tests for S-01 — the hardcoded fallback secret.
 *
 * The server used to sign every token with the literal "aryanseth" because
 * token.ts read process.env at module-evaluation time, which under ESM runs
 * before dotenv's config(). Anyone could forge a token for any user id.
 */

// The exact literals that used to be baked into src/utils/token.ts.
const OLD_HARDCODED_SECRET = "aryanseth";
const OLD_HARDCODED_REFRESH_SECRET = "aryanseth_refresh";

describe("S-01: tokens are not signed with the hardcoded fallback", () => {
  it("rejects an access token forged with the old hardcoded secret", () => {
    const forged = jwt.sign(
      { userId: "victim-user-id", type: "access" },
      OLD_HARDCODED_SECRET,
      { expiresIn: "15m" },
    );

    expect(verifyAccessToken(forged)).toBeNull();
  });

  it("rejects a refresh token forged with the old hardcoded secret", () => {
    const forged = jwt.sign(
      { userId: "victim-user-id", type: "refresh" },
      OLD_HARDCODED_REFRESH_SECRET,
      { expiresIn: "7d" },
    );

    expect(verifyRefreshToken(forged)).toBeNull();
  });

  it("does not sign real tokens with the hardcoded secret", () => {
    const { accessToken } = generateTokenPair("user-1");

    // If the fallback were still in play, this would verify successfully.
    expect(() => jwt.verify(accessToken, OLD_HARDCODED_SECRET)).toThrow();
  });
});

describe("S-01: cookie tokens verify through the same path as bearer tokens", () => {
  it("generateToken produces a token verifyAccessToken accepts", () => {
    // The web cookie token used to omit `type`, so verifyAccessToken returned
    // null and auth.ts fell through to a legacy branch using a DIFFERENT
    // secret — which meant every authenticated web request 401'd.
    const cookieToken = generateToken("user-42");

    const decoded = verifyAccessToken(cookieToken);
    expect(decoded).not.toBeNull();
    expect(decoded?.userId).toBe("user-42");
    expect(decoded?.type).toBe("access");
  });

  it("round-trips an access/refresh pair", () => {
    const { accessToken, refreshToken } = generateTokenPair("user-7");

    expect(verifyAccessToken(accessToken)?.userId).toBe("user-7");
    expect(verifyRefreshToken(refreshToken)?.userId).toBe("user-7");
  });

  it("does not accept a refresh token where an access token is required", () => {
    const { refreshToken } = generateTokenPair("user-7");
    expect(verifyAccessToken(refreshToken)).toBeNull();
  });

  it("rejects a garbage token", () => {
    expect(verifyAccessToken("not.a.token")).toBeNull();
  });
});
