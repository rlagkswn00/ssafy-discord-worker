export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runDailyJobs(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 수동 테스트용
    if (url.pathname === "/run") {
      const type = url.searchParams.get("type") || "all";

      if (type === "frontend") {
        await sendNextContent({
          env,
          category: "frontend",
          tocUrl:
            "https://raw.githubusercontent.com/maeil-mail/maeil-mail-contents/main/frontend/toc.md",
          baseRawUrl:
            "https://raw.githubusercontent.com/maeil-mail/maeil-mail-contents/main/frontend",
          baseGithubUrl:
            "https://github.com/maeil-mail/maeil-mail-contents/blob/main/frontend",
          webhookUrl: env.DISCORD_WEBHOOK_FRONTEND
        });
        return new Response("frontend sent");
      }

      if (type === "backend") {
        await sendNextContent({
          env,
          category: "backend",
          tocUrl:
            "https://raw.githubusercontent.com/maeil-mail/maeil-mail-contents/main/backend/toc.md",
          baseRawUrl:
            "https://raw.githubusercontent.com/maeil-mail/maeil-mail-contents/main/backend",
          baseGithubUrl:
            "https://github.com/maeil-mail/maeil-mail-contents/blob/main/backend",
          webhookUrl: env.DISCORD_WEBHOOK_BACKEND
        });
        return new Response("backend sent");
      }

      await runDailyJobs(env);
      return new Response("all sent");
    }

    return new Response("ok");
  }
};

async function runDailyJobs(env) {
  await Promise.all([
    sendNextContent({
      env,
      category: "frontend",
      tocUrl:
        "https://raw.githubusercontent.com/maeil-mail/maeil-mail-contents/main/frontend/toc.md",
      baseRawUrl:
        "https://raw.githubusercontent.com/maeil-mail/maeil-mail-contents/main/frontend",
      baseGithubUrl:
        "https://github.com/maeil-mail/maeil-mail-contents/blob/main/frontend",
      webhookUrl: env.DISCORD_WEBHOOK_FRONTEND
    }),
    sendNextContent({
      env,
      category: "backend",
      tocUrl:
        "https://raw.githubusercontent.com/maeil-mail/maeil-mail-contents/main/backend/toc.md",
      baseRawUrl:
        "https://raw.githubusercontent.com/maeil-mail/maeil-mail-contents/main/backend",
      baseGithubUrl:
        "https://github.com/maeil-mail/maeil-mail-contents/blob/main/backend",
      webhookUrl: env.DISCORD_WEBHOOK_BACKEND
    })
  ]);
}

async function sendNextContent({
  env,
  category,
  tocUrl,
  baseRawUrl,
  baseGithubUrl,
  webhookUrl
}) {
  const tocText = await fetchText(tocUrl);
  const items = parseToc(tocText);

  if (items.length === 0) {
    throw new Error(`[${category}] toc parsing failed`);
  }

  const kvKey = `${category}:lastIndex`;
  const lastIndexRaw = await env.MAEIL_KV.get(kvKey);
  const lastIndex = lastIndexRaw === null ? -1 : Number(lastIndexRaw);
  const nextIndex = (lastIndex + 1) % items.length;

  const selected = items[nextIndex];
  const answerUrl = `${baseGithubUrl}/${selected.path}`;
  const rawUrl = `${baseRawUrl}/${selected.path}`;

  // 실제 파일이 존재하는지 한 번 확인
  await fetchText(rawUrl);

  const message = [
  `## ${selected.title}`,
  "",
  `### [답변 보기](${answerUrl})`
].join("\n");

  await sendDiscordMessage(webhookUrl, message);

  // 전송 성공 후에만 인덱스 저장
  await env.MAEIL_KV.put(kvKey, String(nextIndex));
}

function parseToc(tocText) {
  const regex = /\[([^\]]+)\]\((contents\/[^)]+)\)/g;
  const items = [];
  let match;

  while ((match = regex.exec(tocText)) !== null) {
    items.push({
      title: sanitizeTitle(match[1]),
      path: match[2]
    });
  }

  return items;
}

function sanitizeTitle(title) {
  return title.trim();
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "maeil-mail-discord-worker"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch: ${url} (${response.status})`);
  }

  return await response.text();
}

async function sendDiscordMessage(webhookUrl, content) {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ content })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Discord webhook failed: ${response.status} ${text}`);
  }
}