import * as vscode from 'vscode';

export const SECRET_KEYS = {
  bitbucketToken: 'bitbucketAiReview.bitbucket.token',
  modelApiKey: 'bitbucketAiReview.model.apiKey',
} as const;

export type SecretName = keyof typeof SECRET_KEYS;

export class SecretStore {
  public constructor(private readonly storage: vscode.SecretStorage) {}

  public get(name: SecretName): Thenable<string | undefined> {
    return this.storage.get(SECRET_KEYS[name]);
  }

  public async set(name: SecretName, value: string): Promise<void> {
    const normalizedValue = value.trim();
    if (normalizedValue.length === 0) {
      throw new Error('A secret value cannot be empty.');
    }

    await this.storage.store(SECRET_KEYS[name], normalizedValue);
  }

  public delete(name: SecretName): Thenable<void> {
    return this.storage.delete(SECRET_KEYS[name]);
  }

  public async clearAll(): Promise<void> {
    await Promise.all(Object.keys(SECRET_KEYS).map(async (name) => {
      await this.delete(name as SecretName);
    }));
  }
}

export async function promptAndStoreSecret(
  secretStore: SecretStore,
  name: SecretName,
  prompt: string,
  placeHolder: string,
): Promise<boolean> {
  const value = await vscode.window.showInputBox({
    prompt,
    placeHolder,
    password: true,
    ignoreFocusOut: true,
    validateInput: (input) => input.trim().length === 0 ? 'Value cannot be empty.' : undefined,
  });

  if (value === undefined) {
    return false;
  }

  await secretStore.set(name, value);
  return true;
}
