/** QQ 号 / 群号须为正整数字符串，且在 OneBot 使用的安全整数范围内。 */
export function isValidId(value: string): boolean {
  return /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
}
