import type { EventItem } from "./chat-events";
import { icon } from "./chat-icon";
import { el } from "./dom";

export const githubLabels = {
  issues: "Issue", pull_request: "Pull request", workflow_run: "工作流", push: "推送", release: "版本发布",
  issue_comment: "讨论评论", pull_request_review: "PR 评审", pull_request_review_comment: "行内评论", repository: "仓库动态",
} as const;
type Kind = keyof typeof githubLabels;
export type GitHubTarget = { kind: Kind; repo: string; id: string; subject: string };

// 历史会话只保留展示文本。按 Webhook 规范化器生成的目标与锚点识别，标题和评论正文都由外部作者提供。
export function githubTarget(ref: string): GitHubTarget | undefined {
  const parts = /^https:\/\/github\.com\/([a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/([\w.-]{1,100}))(\/.*)?$/.exec(ref);
  if (!parts || parts[2] === "." || parts[2] === "..") return;
  const repo = parts[1]!, path = parts[3] ?? "";
  if (!path || path === "/releases") return { kind: path ? "release" : "repository", repo, id: "", subject: "" };
  const run = /^\/actions\/runs\/(\d+)$/.exec(path);
  if (run) return { kind: "workflow_run", repo, id: run[1]!, subject: "Run #" + run[1] };
  const commit = /^\/commit\/([0-9a-f]{40}|[0-9a-f]{64})$/i.exec(path);
  if (commit) return { kind: "push", repo, id: commit[1]!, subject: "" };
  const thread = /^\/(issues|pull)\/(\d+)(?:#(issuecomment-|pullrequestreview-|discussion_r)\d+)?$/.exec(path);
  if (!thread) return;
  const [, type, id, anchor] = thread;
  if (type === "issues" && anchor && anchor !== "issuecomment-") return;
  const kind = anchor === "issuecomment-" ? "issue_comment" : anchor === "discussion_r" ? "pull_request_review_comment"
    : anchor === "pullrequestreview-" ? "pull_request_review" : type === "pull" ? "pull_request" : "issues";
  return { kind, repo, id: id!, subject: (type === "pull" ? "PR #" : "Issue #") + id };
}

const actions = new Map(Object.entries({
  opened: "已打开", reopened: "已重新打开", closed: "已关闭", published: "已发布", created: "已创建", submitted: "已提交",
  edited: "已编辑", deleted: "已删除", completed: "已完成", requested: "已请求", in_progress: "运行中", ready_for_review: "待评审",
  review_requested: "已请求评审", synchronize: "已更新提交", released: "已正式发布", dismissed: "已撤销",
}));
const translate = (action: string) => actions.get(action) ?? action;
const actionTag = (value: string) => value ? el("span", { className: "event-action", text: translate(value) }) : null;
const heading = (title: string) => el("h4", { text: title || "（无标题）" });

function firstWord(text: string) {
  const space = text.indexOf(" ");
  return space < 0 ? [text, ""] as const : [text.slice(0, space), text.slice(space + 1)] as const;
}

function itemBody(target: GitHubTarget, title: string, summary: string, link: HTMLAnchorElement) {
  const { kind, subject, id } = target;
  switch (kind) {
    case "issues":
      link.textContent = "#" + id;
      return el("div", { className: "gh-ticket" }, [
        link, el("div", {}, [heading(title), actionTag(summary)]),
      ]);
    case "pull_request":
      link.textContent = subject;
      return el("div", { className: "gh-pull" }, [
        el("span", { className: "gh-branch-mark" }, [icon("pull_request")]),
        el("div", {}, [heading(title), el("div", { className: "gh-row" }, [link, actionTag(summary)])]),
      ]);
    case "workflow_run": {
      const [action, conclusion] = firstWord(summary);
      const outcome = action === "completed" ? workflowResults.get(conclusion) : undefined;
      link.textContent = subject;
      return el("div", { className: "gh-run", "data-tone": outcome?.tone }, [
        el("span", { className: "gh-run-mark", "aria-hidden": true, text: outcome?.symbol ?? "·" }),
        el("div", {}, [el("strong", { text: outcome?.text ?? [translate(action), conclusion].filter(Boolean).join(" · ") }),
          heading(title)]), link,
      ]);
    }
    case "push": {
      const ref = title.startsWith("Push ") ? title.slice(5) : title;
      const prefix = ref.startsWith("refs/heads/") ? "refs/heads/" : ref.startsWith("refs/tags/") ? "refs/tags/" : "";
      link.textContent = id.slice(0, 7);
      link.title = id;
      link.setAttribute("aria-label", "Commit " + id);
      return el("div", { className: "gh-push" }, [
        el("div", { className: "gh-commit-line" }, [icon("push"),
          el("span", {}, [prefix ? el("small", { text: prefix === "refs/heads/" ? "分支" : "标签" }) : null,
            el("code", { title: ref, text: ref.slice(prefix.length) || ref })]),
          el("span", { "aria-hidden": true, text: "→" }), link]),
        summary && summary !== "Repository push" ? el("p", { text: summary }) : null,
      ]);
    }
    case "release": {
      const [action, tag] = firstWord(summary);
      link.append(icon("release"), tag || "Releases");
      return el("div", { className: "gh-release" }, [link,
        el("div", {}, [title && title !== tag ? heading(title) : null, actionTag(action)])]);
    }
    case "issue_comment":
    case "pull_request_review":
    case "pull_request_review_comment": {
      const split = /^([a-z_]+(?: [a-z_]+)?):(?: |$)/.exec(summary);
      const [action, state] = firstWord(split?.[1] ?? "");
      const note = split ? summary.slice(split[0].length) : summary;
      link.textContent = subject;
      const context = el("div", { className: "gh-subject" }, [link, heading(title)]);
      if (kind === "pull_request_review") {
        const verdict = reviewStates.get(state);
        return el("div", { className: "gh-review" }, [
          el("div", { className: "gh-verdict", "data-tone": verdict?.tone }, [icon("pull_request_review"),
            el("strong", { text: verdict?.text ?? (state || "评审") }), actionTag(action)]),
          note ? el("p", { text: note }) : null, context,
        ]);
      }
      const quote = note ? el("blockquote", { text: note }) : null;
      if (kind === "pull_request_review_comment") return el("div", { className: "gh-inline" }, [
        context, el("div", { className: "gh-annotation" }, [icon("pull_request_review_comment"), el("div", {}, [actionTag(action), quote])]),
      ]);
      return el("div", { className: "gh-comment" }, [context, quote, actionTag(action)]);
    }
    case "repository":
      link.textContent = title || target.repo;
      return el("div", { className: "gh-row" }, [el("h4", {}, [link]), actionTag(summary)]);
  }
}

const workflowResults = new Map(Object.entries({
  success: { text: "运行成功", tone: "ok", symbol: "✓" }, failure: { text: "运行失败", tone: "bad", symbol: "×" },
  cancelled: { text: "运行已取消", tone: "neutral", symbol: "−" }, skipped: { text: "已跳过", tone: "neutral", symbol: "↷" },
  timed_out: { text: "运行超时", tone: "bad", symbol: "!" },
}));
const reviewStates = new Map(Object.entries({
  approved: { text: "已批准", tone: "ok" }, changes_requested: { text: "请求修改", tone: "bad" },
  commented: { text: "已给出意见", tone: "neutral" }, dismissed: { text: "已撤销评审", tone: "neutral" },
}));

export function githubItem(item: EventItem, target: GitHubTarget) {
  const { repo, kind } = target;
  const title = item.title.startsWith(repo + ": ") ? item.title.slice(repo.length + 2) : item.title;
  const link = el("a", { href: item.ref, target: "_blank", rel: "noopener noreferrer" });
  return el("li", { className: "event-item gh-item", "data-github-kind": kind }, [
    el("span", { className: "gh-kind" }, [icon(kind === "repository" ? "github" : kind), githubLabels[kind]]),
    itemBody(target, title, item.summary, link),
    el("footer", { className: "gh-meta" }, [el("span", { text: repo }), item.actor ? el("span", { text: item.actor }) : null,
      el("time", { title: "事件时间（北京时间）", text: item.time })]),
  ]);
}
