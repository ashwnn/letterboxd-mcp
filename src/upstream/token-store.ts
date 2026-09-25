import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { LetterboxdNotLinkedError } from "./errors";
import { requestTokens } from "./client";

/**
 * The only place Letterboxd tokens live. One instance (`idFromName("owner")`)
 * so refresh-token rotation is single-flight no matter which edge location asks.
 */

export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope?: string;
}

export interface MemberIdentity {
  id: string;
  username: string;
  displayName?: string;
}

export interface LinkStatus {
  linked: boolean;
  broken: boolean;
  memberId?: string;
  username?: string;
  expiresAt?: number;
}

export interface TokenWithExpiry {
  token: string;
  expiresAt: number;
  /** Which token was actually used, so callers know whether caching is safe. */
  kind: "member" | "app";
}

const MEMBER_TOKENS_KEY = "memberTokens";
const MEMBER_IDENTITY_KEY = "member";
const APP_TOKENS_KEY = "appTokens";
const BROKEN_KEY = "broken";
const REFRESH_MARGIN_MS = 60_000;
const DEFAULT_TTL_SECONDS = 3_600;

export class LetterboxdTokenStore extends DurableObject<Env> {
  #refreshing = new Map<"member" | "app", Promise<StoredTokens>>();

  async status(): Promise<LinkStatus> {
    const [member, tokens, broken] = await Promise.all([
      this.ctx.storage.get<MemberIdentity>(MEMBER_IDENTITY_KEY),
      this.ctx.storage.get<StoredTokens>(MEMBER_TOKENS_KEY),
      this.ctx.storage.get<boolean>(BROKEN_KEY),
    ]);
    return {
      linked: Boolean(member && tokens),
      broken: broken === true,
      memberId: member?.id,
      username: member?.username,
      expiresAt: tokens?.expiresAt,
    };
  }

  async getToken(kind: "member" | "app" | "any"): Promise<TokenWithExpiry> {
    if (kind === "member") {
      const tokens = await this.#memberTokens();
      return { token: tokens.accessToken, expiresAt: tokens.expiresAt, kind: "member" };
    }
    if (kind === "app") {
      const tokens = await this.#appTokens();
      return { token: tokens.accessToken, expiresAt: tokens.expiresAt, kind: "app" };
    }

    const [member, broken] = await Promise.all([
      this.ctx.storage.get<StoredTokens>(MEMBER_TOKENS_KEY),
      this.ctx.storage.get<boolean>(BROKEN_KEY),
    ]);
    if (member && broken !== true) {
      const tokens = await this.#memberTokens();
      return { token: tokens.accessToken, expiresAt: tokens.expiresAt, kind: "member" };
    }
    const tokens = await this.#appTokens();
    return { token: tokens.accessToken, expiresAt: tokens.expiresAt, kind: "app" };
  }

  async forceRefresh(kind: "member" | "app" | "any"): Promise<TokenWithExpiry> {
    if (kind === "member" || (kind === "any" && (await this.#hasMember()))) {
      const existing = await this.ctx.storage.get<StoredTokens>(MEMBER_TOKENS_KEY);
      if (!existing) throw new LetterboxdNotLinkedError();
      const tokens = await this.#refreshMember(existing);
      return { token: tokens.accessToken, expiresAt: tokens.expiresAt, kind: "member" };
    }
    const tokens = await this.#fetchAppTokens();
    return { token: tokens.accessToken, expiresAt: tokens.expiresAt, kind: "app" };
  }

  async saveMemberTokens(tokens: StoredTokens, member: MemberIdentity): Promise<void> {
    await this.ctx.storage.put(MEMBER_TOKENS_KEY, tokens);
    await this.ctx.storage.put(MEMBER_IDENTITY_KEY, member);
    await this.ctx.storage.delete(BROKEN_KEY);
  }

  async saveAppTokens(tokens: StoredTokens): Promise<void> {
    await this.ctx.storage.put(APP_TOKENS_KEY, tokens);
  }

  async unlink(): Promise<void> {
    await this.ctx.storage.delete([
      MEMBER_TOKENS_KEY,
      MEMBER_IDENTITY_KEY,
      BROKEN_KEY,
    ]);
  }

  async markBroken(): Promise<void> {
    await this.ctx.storage.put(BROKEN_KEY, true);
  }

  async #hasMember(): Promise<boolean> {
    return (await this.ctx.storage.get<StoredTokens>(MEMBER_TOKENS_KEY)) !== undefined;
  }

  async #memberTokens(): Promise<StoredTokens> {
    const [tokens, broken] = await Promise.all([
      this.ctx.storage.get<StoredTokens>(MEMBER_TOKENS_KEY),
      this.ctx.storage.get<boolean>(BROKEN_KEY),
    ]);
    if (!tokens) throw new LetterboxdNotLinkedError();
    if (broken === true) {
      throw new LetterboxdNotLinkedError(
        "The Letterboxd link is no longer valid; relink required.",
      );
    }
    if (tokens.expiresAt - REFRESH_MARGIN_MS > Date.now()) return tokens;
    return this.#refreshMember(tokens);
  }

  async #refreshMember(existing: StoredTokens): Promise<StoredTokens> {
    const inflight = this.#refreshing.get("member");
    if (inflight) return inflight;

    const task = (async (): Promise<StoredTokens> => {
      if (!existing.refreshToken) {
        await this.ctx.storage.put(BROKEN_KEY, true);
        throw new LetterboxdNotLinkedError(
          "No refresh token is stored; relink required.",
        );
      }
      const response = await requestTokens(this.env, {
        grant_type: "refresh_token",
        refresh_token: existing.refreshToken,
      });
      if (!response.access_token) {
        if (response.error === "invalid_grant") {
          await this.ctx.storage.put(BROKEN_KEY, true);
          throw new LetterboxdNotLinkedError(
            "Letterboxd access was revoked; relink required.",
          );
        }
        throw new Error(
          `Letterboxd token refresh failed: ${response.error ?? "unknown error"}`,
        );
      }
      const next: StoredTokens = {
        accessToken: response.access_token,
        refreshToken: response.refresh_token ?? existing.refreshToken,
        expiresAt: Date.now() + (response.expires_in ?? DEFAULT_TTL_SECONDS) * 1_000,
        scope: response.scope ?? existing.scope,
      };
      await this.ctx.storage.put(MEMBER_TOKENS_KEY, next);
      await this.ctx.storage.delete(BROKEN_KEY);
      return next;
    })().finally(() => this.#refreshing.delete("member"));

    this.#refreshing.set("member", task);
    return task;
  }

  async #appTokens(): Promise<StoredTokens> {
    const tokens = await this.ctx.storage.get<StoredTokens>(APP_TOKENS_KEY);
    if (tokens && tokens.expiresAt - REFRESH_MARGIN_MS > Date.now()) return tokens;
    return this.#fetchAppTokens();
  }

  async #fetchAppTokens(): Promise<StoredTokens> {
    const inflight = this.#refreshing.get("app");
    if (inflight) return inflight;

    const task = (async (): Promise<StoredTokens> => {
      const response = await requestTokens(this.env, {
        grant_type: "client_credentials",
      });
      if (!response.access_token) {
        throw new Error(
          `Letterboxd app token request failed: ${response.error ?? "unknown error"}`,
        );
      }
      const next: StoredTokens = {
        accessToken: response.access_token,
        expiresAt: Date.now() + (response.expires_in ?? DEFAULT_TTL_SECONDS) * 1_000,
        scope: response.scope,
      };
      await this.ctx.storage.put(APP_TOKENS_KEY, next);
      return next;
    })().finally(() => this.#refreshing.delete("app"));

    this.#refreshing.set("app", task);
    return task;
  }
}
