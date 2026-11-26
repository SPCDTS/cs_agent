const paths = {
  gmail: "M3 6h18v13H3z M3 7l9 7 9-7",
  github: "M6 8v8 M9 18h4a5 5 0 005-5V8 M6 3a2.5 2.5 0 100 5 2.5 2.5 0 000-5 M6 16a2.5 2.5 0 100 5 2.5 2.5 0 000-5 M18 3a2.5 2.5 0 100 5 2.5 2.5 0 000-5",
  pull_request: "M6 7v10 M6 3a2 2 0 100 4 2 2 0 000-4 M6 17a2 2 0 100 4 2 2 0 000-4 M18 17v-6a5 5 0 00-5-5h-1m3-3-3 3 3 3 M18 17a2 2 0 100 4 2 2 0 000-4",
  issues: "M12 3a9 9 0 100 18 9 9 0 000-18 M12 11a1 1 0 100 2 1 1 0 000-2",
  workflow_run: "M3 4h6v6H3z M15 14h6v6h-6z M6 10v5a2 2 0 002 2h7 M14 5l5 3-5 3z",
  push: "M3 12h5m8 0h5 M12 8a4 4 0 100 8 4 4 0 000-8",
  release: "M3 4h9l9 9-8 8-10-10z M8 8h.01",
  issue_comment: "M3 4h18v13H9l-5 4v-4H3z M7 9h10 M7 12h6",
  pull_request_review: "M5 3h11l3 3v15H5z M13 3v5h6 M8 14l3 3 5-6",
  pull_request_review_comment: "M8 7l-5 5 5 5m8-10 5 5-5 5m-3-12-2 14",
  event: "M4 5h16v14H4z M7 10h3l2-3 2 7 2-4h2",
  chat: "M4 4h16v13H9l-5 4z M8 9h8 M8 12h5",
  agent: "M3 7h15m-4-4 4 4-4 4 M21 17H6m4-4-4 4 4 4",
  subagent: "M4 4h6v5H4z M14 15h6v5h-6z M7 9v8h7",
  file: "M5 3h9l5 5v13H5z M14 3v6h5 M8 14h8 M8 17h5",
  download: "M12 3v12m-5-5 5 5 5-5 M4 16v4h16v-4",
} as const;

export function icon(key: keyof typeof paths) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", paths[key]);
  svg.append(path);
  return svg;
}
