import { randomBytes } from 'node:crypto';
import { loadCredentials, saveCredentials, type Credentials } from './config.js';
import { decodeUserData, encodeOperations, type WireOperation, type WireUserData } from './proto.js';

const BASE_URL = 'https://www.anylist.com';
const API_VERSION = '3';
const MAX_BODY_IN_ERROR = 2000;

/** Thrown for any non-success HTTP response; message carries status and body. */
export class AnyListHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly method: string,
    readonly url: string
  ) {
    super(`${method} ${url} failed with HTTP ${status}: ${body || '(empty response body)'}`);
    this.name = 'AnyListHttpError';
  }
}

export class NotLoggedInError extends Error {
  constructor() {
    super('Not logged in. Run `anylist auth login` or set ANYLIST_EMAIL and ANYLIST_PASSWORD.');
    this.name = 'NotLoggedInError';
  }
}

export interface CredentialStore {
  load(): Credentials;
  save(credentials: Credentials): void;
}

export interface ClientOptions {
  fetch?: typeof fetch;
  store?: CredentialStore;
  baseUrl?: string;
  /** Email/password override (defaults to ANYLIST_EMAIL / ANYLIST_PASSWORD, then stored values). */
  email?: string;
  password?: string;
}

export const newId = (): string => randomBytes(16).toString('hex');

export class AnyListClient {
  private readonly fetchImpl: typeof fetch;
  private readonly store: CredentialStore;
  private readonly baseUrl: string;
  private credentials: Credentials;
  private readonly emailOverride?: string;
  private readonly passwordOverride?: string;

  constructor(options: ClientOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.store = options.store ?? { load: loadCredentials, save: saveCredentials };
    this.baseUrl = options.baseUrl ?? BASE_URL;
    this.emailOverride = options.email ?? process.env.ANYLIST_EMAIL;
    this.passwordOverride = options.password ?? process.env.ANYLIST_PASSWORD;
    this.credentials = this.store.load();
  }

  get userId(): string | undefined {
    return this.credentials.userId;
  }

  get email(): string | undefined {
    return this.emailOverride ?? this.credentials.email;
  }

  private get password(): string | undefined {
    return this.passwordOverride ?? this.credentials.password;
  }

  private persist(): void {
    this.store.save(this.credentials);
  }

  /** Exchange email/password for tokens and store them. */
  async login(email = this.email, password = this.password, remember = true): Promise<void> {
    if (!email || !password) throw new NotLoggedInError();
    const body = await this.postForm('/auth/token', () => {
      const form = new FormData();
      form.append('email', email);
      form.append('password', password);
      return form;
    });
    this.applyTokens(body);
    this.credentials.email = email;
    if (remember) this.credentials.password = password;
    this.credentials.clientId ??= newId();
    this.persist();
  }

  private applyTokens(body: string): void {
    let parsed: { access_token?: string; refresh_token?: string; user_id?: string };
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error(`Unexpected token response: ${body.slice(0, MAX_BODY_IN_ERROR)}`);
    }
    if (!parsed.access_token || !parsed.refresh_token) {
      throw new Error(`Token response is missing tokens: ${body.slice(0, MAX_BODY_IN_ERROR)}`);
    }
    this.credentials.accessToken = parsed.access_token;
    this.credentials.refreshToken = parsed.refresh_token;
    if (parsed.user_id) this.credentials.userId = parsed.user_id;
  }

  private async refreshTokens(): Promise<void> {
    const refreshToken = this.credentials.refreshToken;
    if (refreshToken) {
      try {
        const body = await this.postForm('/auth/token/refresh', () => {
          const form = new FormData();
          form.append('refresh_token', refreshToken);
          return form;
        });
        this.applyTokens(body);
        this.persist();
        return;
      } catch (err) {
        if (!(err instanceof AnyListHttpError) || err.status !== 401) throw err;
      }
    }
    // Refresh token missing or rejected: fall back to the password.
    await this.login();
  }

  private async postForm(path: string, buildForm: () => FormData): Promise<string> {
    const url = this.baseUrl + path;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'X-AnyLeaf-API-Version': API_VERSION },
      body: buildForm(),
      redirect: 'manual'
    });
    const text = await res.text();
    if (!res.ok) throw new AnyListHttpError(res.status, text.slice(0, MAX_BODY_IN_ERROR), 'POST', url);
    return text;
  }

  /** Authenticated POST. Refreshes the token and retries once on 401. */
  private async authedPost(path: string, buildForm?: () => FormData): Promise<Uint8Array> {
    if (!this.credentials.accessToken) {
      if (this.email && this.password) await this.login();
      else throw new NotLoggedInError();
    }
    this.credentials.clientId ??= newId();
    const url = this.baseUrl + path;
    const attempt = async (): Promise<Response> =>
      this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'X-AnyLeaf-API-Version': API_VERSION,
          'X-AnyLeaf-Client-Identifier': this.credentials.clientId ?? '',
          Authorization: `Bearer ${this.credentials.accessToken}`
        },
        body: buildForm?.(),
        redirect: 'manual'
      });

    let res = await attempt();
    if (res.status === 401) {
      await this.refreshTokens();
      res = await attempt();
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!res.ok) {
      const text = new TextDecoder().decode(bytes).slice(0, MAX_BODY_IN_ERROR);
      throw new AnyListHttpError(res.status, text, 'POST', url);
    }
    return bytes;
  }

  /** Fetch the account snapshot: all shopping lists and recipes. */
  async getUserData(): Promise<WireUserData> {
    return decodeUserData(await this.authedPost('/data/user-data/get'));
  }

  /** Send one or more shopping-list operations. */
  async sendListOperations(operations: WireOperation[]): Promise<void> {
    const payload = encodeOperations(operations);
    await this.authedPost('/data/shopping-lists/update', () => {
      const form = new FormData();
      form.append('operations', new Blob([payload as BlobPart]), 'operations');
      return form;
    });
  }

  /** Build an operation envelope with fresh ids. */
  operation(handlerId: string, listId: string, rest: Partial<WireOperation> = {}): WireOperation {
    return {
      metadata: { operationId: newId(), handlerId, userId: this.userId },
      listId,
      ...rest
    };
  }
}
