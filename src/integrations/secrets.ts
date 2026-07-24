export interface SecretResolver {
  resolve(reference: string): Promise<string>;
}

const ENV_REFERENCE = /^env:([A-Z_][A-Z0-9_]*)$/;

export class EnvironmentSecretResolver implements SecretResolver {
  readonly #environment: NodeJS.ProcessEnv;

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    this.#environment = environment;
  }

  async resolve(reference: string): Promise<string> {
    const match = ENV_REFERENCE.exec(reference);
    if (!match) {
      throw new Error(
        `Unsupported secret reference ${reference}; expected env:VARIABLE_NAME`,
      );
    }
    const name = match[1]!;
    const value = this.#environment[name];
    if (!value) {
      throw new Error(`Secret environment variable ${name} is not set`);
    }
    return value;
  }
}

export class CompositeSecretResolver implements SecretResolver {
  readonly #resolvers: readonly SecretResolver[];

  constructor(resolvers: readonly SecretResolver[]) {
    if (resolvers.length === 0) {
      throw new Error("CompositeSecretResolver requires at least one resolver");
    }
    this.#resolvers = resolvers;
  }

  async resolve(reference: string): Promise<string> {
    const errors: string[] = [];
    for (const resolver of this.#resolvers) {
      try {
        return await resolver.resolve(reference);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    throw new Error(
      `No secret resolver could resolve ${reference}: ${errors.join("; ")}`,
    );
  }
}

export const assertSecretReference = (reference: string): string => {
  const trimmed = reference.trim();
  if (!ENV_REFERENCE.test(trimmed)) {
    throw new Error("Secret references must use env:VARIABLE_NAME");
  }
  return trimmed;
};
