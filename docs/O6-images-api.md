# O6 图片记忆只读接口

全部接口只支持 GET，复用 dashboard 的 Host、cookie 鉴权与安全头。JSON 继续经 `sessionJson` 脱敏，并受编码后 1 MiB 上限约束，超限返回 413。未登录为 401，非法参数为 400，记录或文件不存在为 404。没有写库、召回、下载或图片解码操作。

## 画廊列表

`GET /api/memory/images?scope=&status=&since=&page=`

- scope 精确匹配，status 为 `ok` / `skipped`。空筛选字段等同省略。
- since 为非负整数毫秒或 ISO 日期，沿用记忆 API 的日期验证；包含该时间点。`YYYY-MM-DD` 按 UTC 零点处理。
- page 从 0 开始，默认 0，最大 1,000,000；每页固定 50 条。未知参数、重复参数和无效值返回 400。
- 按消息时间倒序、消息行 ID 倒序、媒体序号升序排序。超出末页返回空列表；不存在的 scope 返回空列表。
- `totals` 覆盖当前筛选全部记录，不受分页影响。ok / skipped 是媒体记录数；bytes 是安全路径下现存文件字节数之和，未知或已清理按 0 累加。同一内容被多条消息召回按记录重复计数，并非磁盘去重体积。查询不读取图片正文。

```ts
type ImageItem = {
  scope: string; message_id: string; ordinal: number; status: 'ok' | 'skipped';
  sha256: string | null; bytes: number | null; mime: string | null;
  width: number | null; height: number | null; message_ts: number;
  sender_name: string; excerpt: string;
  thumb_href: string | null; href: string | null; present: boolean;
};
type ImagePage = {
  items: ImageItem[]; page: number; has_more: boolean;
  totals: { ok: number; skipped: number; bytes: number };
};
```

message_ts 是消息的 Unix 毫秒时间。摘录先整体脱敏再裁剪至 120 个 UTF-16 单元；不切断代理对。sender_name 同样脱敏。无原始文件路径或远端 URL 输出。bytes 来自受限路径的文件元数据；现有表没有 MIME、宽高，因此这三项为 null，不根据扩展名推测或解码图片。

present 只表示已登记且位于配置 DATA_DIR/media 下的普通文件当前存在，不代表图片能通过正文校验。目录、分片、文件均不得是链接。不存在、越界或链接路径为 false；bytes 为 null。ok 且 present 时 href 与 thumb_href 均为 `/media/<sha256>`，否则为 null。缩略图直接由浏览器缩放原图，不生成副本。

## 图片详情

`GET /api/memory/images/:scope/:message_id/:ordinal`

路径段需 URL 编码，ordinal 为非负安全整数；不接受查询参数。找不到精确三元组返回 404。

```ts
{
  item: ImageItem;
  message: { scope: string; message_id: string; ts: number; sender_name: string; excerpt: string };
  other_media: ImageItem[];
  timeline_href: string;
}
```

other_media 包含同一 scope、同一消息的其它媒体记录（含 skipped），按 ordinal 排序。timeline_href 指向 `/memory/scopes/:scope?from=&to=#messages`，默认消息前后各一小时。消息摘要仍是最多 120 字的脱敏摘录。

## 受控图片字节

`GET /media/:sha256`

只接受 64 位十六进制 SHA-256（大写规范为小写），非法为 400。仅构造媒体目录内固定分片与 png/jpg/gif/webp 候选路径，每个路径必须通过 `ContextStore.mediaPathReferenced` 才调用 `readMediaFile`。沿用该读取器的路径、目录、链接、大小、文件头及内容哈希校验；不支持的魔数返回 415，缺失或其它安全校验失败为 404。

成功响应依据魔数返回 `image/png`、`image/jpeg`、`image/gif` 或 `image/webp`，并设置 `Cache-Control: private, max-age=3600`。二进制使用现有媒体读取器的 10 MiB 上限，JSON 的 1 MiB 上限不适用于图片。不会调用 qq_image、远端 QQ API 或下载器。

## 页面

- `/memory`：图片记忆卡可点击，显示所有域媒体记录总张数（含 skipped）。
- `/memory/images`：scope / 状态 / 起始日期筛选、筛选总计、每页 50 条响应式网格、懒加载图片、时间、发送者、摘录、尺寸与字节、详情及消息时间线链接。已清理文件显示占位，skipped 显示未入库。
- `/memory/images/:scope/:message_id/:ordinal`：大图、元数据、消息摘要、同消息其它图片、时间线与返回链接。

页面为服务端渲染，所有动态文本转义，样式沿用现有 CSP nonce。页面说明统一为“画廊只展示模型通过 qq_image 召回并入库的图片，不会主动下载”。
