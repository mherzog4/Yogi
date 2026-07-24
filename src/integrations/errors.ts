export class ExternalOutcomeUnknownError extends Error {
  readonly externalId: string | undefined;

  constructor(
    message: string,
    options: { readonly cause?: unknown; readonly externalId?: string } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ExternalOutcomeUnknownError";
    this.externalId = options.externalId;
  }
}

export class ProviderHttpError extends Error {
  readonly provider: string;
  readonly status: number | undefined;
  readonly responseExcerpt: string | undefined;

  constructor(
    message: string,
    options: {
      readonly provider: string;
      readonly status?: number;
      readonly responseExcerpt?: string;
      readonly cause?: unknown;
    },
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ProviderHttpError";
    this.provider = options.provider;
    this.status = options.status;
    this.responseExcerpt = options.responseExcerpt;
  }
}
