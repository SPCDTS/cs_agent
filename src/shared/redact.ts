import { log } from './log-core.js';
import { registerSecretsCore, sensitive } from './redact-core.js';
export { containsSecret, redact, redactText, registerTemporarySecrets } from './redact-core.js';

export function registerSecrets(values: Iterable<string | undefined>): void {
  registerSecretsCore(values, () => log.warn("长期秘密表已满，新的长期秘密未注册"));
}
function registerEnvSecrets(env: NodeJS.ProcessEnv = process.env): void {
  registerSecrets(Object.entries(env).filter(([k]) => sensitive.test(k)).map(([, v]) => v));
}
registerEnvSecrets();
