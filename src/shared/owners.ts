/** 兼容单 owner 调用；生产配置传入完整 QQ 号列表。 */
export type OwnerIds = readonly string[] | string | undefined;

export function isOwner(owners: OwnerIds, userId: string | undefined): boolean {
  if (!userId) return false;
  return typeof owners === "string" ? owners === userId : owners?.includes(userId) === true;
}

/** actor 必须显式带 qq: 前缀，不能把裸 QQ 号当作已验证身份。 */
export function isOwnerActor(owners: OwnerIds, actor: string | undefined): boolean {
  return !!actor?.startsWith("qq:") && isOwner(owners, actor.slice(3));
}

