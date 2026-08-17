/** Training / harvesting agents. Not ordinary search (Googlebot, Bingbot, Applebot). */
export const AI_CRAWLERS = [
  "GPTBot",
  "ChatGPT-User",
  "OAI-SearchBot",
  "ClaudeBot",
  "Claude-User",
  "Claude-SearchBot",
  "anthropic-ai",
  "Google-Extended",
  "Google-CloudVertexBot",
  "Applebot-Extended",
  "CCBot",
  "Bytespider",
  "Amazonbot",
  "PerplexityBot",
  "YouBot",
  "cohere-ai",
  "Diffbot",
  "ImagesiftBot",
  "meta-externalagent",
  "meta-externalfetcher",
  "FacebookBot",
  "PetalBot",
  "Timpibot",
  "Webzio-Extended",
  "omgili",
  "omgilibot",
  "Ai2Bot",
  "iaskspider",
  "img2dataset",
];

export function isAiCrawler(userAgent: string) {
  const ua = userAgent.toLowerCase();
  if (!ua) return false;
  return AI_CRAWLERS.some((name) => ua.includes(name.toLowerCase()));
}

export function robotsTxt() {
  const lines = [
    "User-agent: *",
    "Disallow: /",
    "",
  ];
  for (const agent of AI_CRAWLERS) {
    lines.push(`User-agent: ${agent}`, "Disallow: /", "");
  }
  return lines.join("\n");
}
