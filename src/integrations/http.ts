import { ExternalOutcomeUnknownError, ProviderHttpError } from "./errors.js";
import type { ProviderContext } from "./types.js";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface ProviderRequestOptions {
  readonly provider: string;
  readonly baseUrl: string;
  readonly path: string;
  readonly method?: HttpMethod;
  readonly query?: Readonly<
    Record<string, string | number | boolean | undefined>
  >;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly timeoutMs?: number;
}

export interface ProviderResponse<T> {
  readonly data: T;
  readonly headers: Headers;
  readonly status: number;
}

const responseExcerpt = (value: string): string =>
  value.replace(/\s+/g, " ").trim().slice(0, 500);

const buildUrl = (
  baseUrl: string,
  path: string,
  query: ProviderRequestOptions["query"],
): URL => {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(path.replace(/^\//, ""), normalizedBase);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
};

export const normalizeProviderBaseUrl = (value: string): string => {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error("Provider baseUrl must use HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "Provider baseUrl cannot contain credentials, query parameters, or a fragment",
    );
  }
  return url.toString().replace(/\/$/, "");
};

export const providerBaseUrl = (
  context: ProviderContext,
  fallback: string,
): string => {
  const configured = context.connection.metadata.baseUrl;
  if (configured === undefined) return fallback;
  if (typeof configured !== "string") {
    throw new Error("Connection metadata baseUrl must be a string");
  }
  return normalizeProviderBaseUrl(configured);
};

export const requestProviderResponse = async <T>(
  context: ProviderContext,
  options: ProviderRequestOptions,
): Promise<ProviderResponse<T>> => {
  const method = options.method ?? "GET";
  const url = buildUrl(options.baseUrl, options.path, options.query);
  const body =
    options.body === undefined ? undefined : JSON.stringify(options.body);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 30_000,
  );
  let response: Response;
  try {
    response = await context.fetch(url, {
      method,
      headers: {
        accept: "application/json",
        ...(options.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...options.headers,
      },
      ...(body === undefined ? {} : { body }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    const wrapped = new ProviderHttpError(
      `${options.provider} request did not return a response`,
      { provider: options.provider, cause: error },
    );
    if (method === "GET") throw wrapped;
    throw new ExternalOutcomeUnknownError(
      `${options.provider} mutation has an unknown external outcome`,
      { cause: wrapped },
    );
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    clearTimeout(timeout);
    const wrapped = new ProviderHttpError(
      `${options.provider} response body could not be read`,
      { provider: options.provider, status: response.status, cause: error },
    );
    if (method === "GET") throw wrapped;
    throw new ExternalOutcomeUnknownError(
      `${options.provider} mutation returned an unreadable response`,
      { cause: wrapped },
    );
  }
  clearTimeout(timeout);
  if (!response.ok) {
    const error = new ProviderHttpError(
      `${options.provider} request failed with HTTP ${response.status}`,
      {
        provider: options.provider,
        status: response.status,
        ...(text ? { responseExcerpt: responseExcerpt(text) } : {}),
      },
    );
    if (
      method !== "GET" &&
      (response.status === 408 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500)
    ) {
      throw new ExternalOutcomeUnknownError(
        `${options.provider} mutation returned an ambiguous HTTP ${response.status}`,
        { cause: error },
      );
    }
    throw error;
  }
  if (!text.trim()) {
    return {
      data: undefined as T,
      headers: response.headers,
      status: response.status,
    };
  }
  try {
    return {
      data: JSON.parse(text) as T,
      headers: response.headers,
      status: response.status,
    };
  } catch (error) {
    const wrapped = new ProviderHttpError(
      `${options.provider} returned invalid JSON`,
      {
        provider: options.provider,
        status: response.status,
        responseExcerpt: responseExcerpt(text),
        cause: error,
      },
    );
    if (method === "GET") throw wrapped;
    throw new ExternalOutcomeUnknownError(
      `${options.provider} mutation returned an unreadable response`,
      { cause: wrapped },
    );
  }
};

export const requestProviderJson = async <T>(
  context: ProviderContext,
  options: ProviderRequestOptions,
): Promise<T> => (await requestProviderResponse<T>(context, options)).data;
