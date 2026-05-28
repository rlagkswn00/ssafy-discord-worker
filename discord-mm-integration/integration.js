export default {
  async fetch(request, env) {
    try {
      if (request.method === "GET") {
        return new Response("worker is alive", { status: 200 });
      }

      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }

      const contentType = request.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        return new Response("Content-Type must be application/json", {
          status: 400
        });
      }

      const body = await request.json();

      console.log("========== MM RECEIVED ==========");
      console.log(JSON.stringify(body, null, 2));

      const config =
        typeof env.MM_CONFIG === "string"
          ? JSON.parse(env.MM_CONFIG)
          : env.MM_CONFIG;

      const token = body.token || "";
      const text = body.text || "";
      const userName = body.user_name || "";
      const teamDomain = body.team_domain || "";
      const postId = body.post_id || "";
      const channelName = body.channel_name || "";
      const fileIds = parseFileIds(body.file_ids);

      const source = config.sources[token];

      if (!source) {
        console.log("========== UNKNOWN TOKEN ==========");
        console.log(token);
        return new Response("ignored", { status: 200 });
      }

      if (source.category === "행사-이벤트") {
        const minEventLength = 80; // 필요 시 이 값을 늘리거나 줄일 수 있습니다.
        const trimmedLength = text.trim().length;

        if (trimmedLength < minEventLength) {
          console.log("========== SKIP SHORT EVENT MESSAGE ==========");
          console.log(
            JSON.stringify(
              {
                sourceLabel: source.label,
                category: source.category,
                channelName,
                trimmedLength,
                minEventLength,
                preview: text.slice(0, 120)
              },
              null,
              2
            )
          );

          return new Response("ignored", { status: 200 });
        }
      }

      const discordWebhook = config.discord[source.category];

      if (!discordWebhook) {
        console.log("========== DISCORD WEBHOOK NOT FOUND ==========");
        console.log(source.category);
        return new Response("error: webhook not found", { status: 500 });
      }

      let mmLink = "";
      if (teamDomain && postId) {
        mmLink = `https://meeting.ssafy.com/${teamDomain}/pl/${postId}`;
      }

      const cleanedText = normalizeMattermostText(text);

      const fullContent = buildDiscordContent({
        userName,
        cleanedText,
        mmLink,
        source,
        fileCount: fileIds.length
      });

      const contentChunks = splitDiscordContent(fullContent, 1900);

      console.log("========== DISCORD PREPARE ==========");
      console.log(JSON.stringify({
        sourceLabel: source.label,
        category: source.category,
        channelName,
        userName,
        fileCount: fileIds.length,
        chunkCount: contentChunks.length
      }, null, 2));

      let responses = [];

      if (fileIds.length === 0) {
        for (let i = 0; i < contentChunks.length; i++) {
          const payload = { content: contentChunks[i] };

          console.log("========== DISCORD SEND JSON ==========");
          console.log(JSON.stringify({
            chunkIndex: i,
            payload
          }, null, 2));

          const res = await fetch(discordWebhook, {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
          });

          const resText = await res.text();

          responses.push({
            status: res.status,
            body: resText
          });

          if (!res.ok) {
            return new Response(`error: discord failed (${res.status})`, {
              status: 500
            });
          }
        }
      } else {
        const mmToken = await loginToMattermost(config.mmAuth);

        console.log("========== MM LOGIN SUCCESS ==========");
        console.log(JSON.stringify({
          tokenPreview: mmToken.slice(0, 6) + "..."
        }, null, 2));

        const files = [];
        for (const fileId of fileIds) {
          const downloaded = await downloadMattermostFile({
            baseUrl: config.mmAuth.baseUrl,
            bearerToken: mmToken,
            fileId
          });
          files.push(downloaded);
        }

        console.log("========== FILES READY ==========");
        console.log(JSON.stringify(
          files.map(f => ({
            fileId: f.fileId,
            fileName: f.fileName,
            fileType: f.fileType,
            fileSize: f.fileSize
          })),
          null,
          2
        ));

        const firstChunk = contentChunks[0] || "(본문 없음)";

        const form = new FormData();
        form.append("payload_json", JSON.stringify({
          content: firstChunk,
          allowed_mentions: { parse: [] }
        }));

        files.forEach((f, i) => {
          form.append(`files[${i}]`, f.file, f.fileName);
        });

        console.log("========== DISCORD SEND MULTIPART ==========");
        console.log(JSON.stringify({
          uploadCount: files.length,
          firstChunkPreview: firstChunk.slice(0, 300)
        }, null, 2));

        const firstRes = await fetch(`${discordWebhook}?wait=true`, {
          method: "POST",
          body: form
        });

        const firstResText = await firstRes.text();

        responses.push({
          status: firstRes.status,
          body: firstResText
        });

        if (!firstRes.ok) {
          return new Response(`error: discord failed (${firstRes.status})`, {
            status: 500
          });
        }

        for (let i = 1; i < contentChunks.length; i++) {
          const payload = { content: contentChunks[i] };

          console.log("========== DISCORD SEND FOLLOWUP JSON ==========");
          console.log(JSON.stringify({
            chunkIndex: i,
            payload
          }, null, 2));

          const res = await fetch(discordWebhook, {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
          });

          const resText = await res.text();

          responses.push({
            status: res.status,
            body: resText
          });

          if (!res.ok) {
            return new Response(`error: discord followup failed (${res.status})`, {
              status: 500
            });
          }
        }
      }

      console.log("========== DISCORD RESPONSES ==========");
      console.log(JSON.stringify(responses, null, 2));

      return new Response("ok", { status: 200 });

    } catch (err) {
      console.log("========== ERROR ==========");
      console.log(err?.stack || err?.message || String(err));

      return new Response(
        `error: ${err?.message || String(err)}`,
        { status: 500 }
      );
    }
  }
};

function buildDiscordContent({ userName, cleanedText, mmLink, source, fileCount }) {
  let content = "";

  if (userName) {
    content += `**보낸 사람:** ${escapeDiscordInline(userName)}\n\n`;
  }

  if (cleanedText) {
    content += `${cleanedText}\n\n`;
  } else {
    content += `(본문 없음)\n\n`;
  }

  if (fileCount > 0) {
    content += `📎 첨부파일 있음 (${fileCount}개)\n\n`;
  }

  if (mmLink) {
    content += `[${source.label} 채널로 이동](${mmLink})`;
  } else {
    content += `${source.label} 채널 원문 링크 생성 실패`;
  }

  return content.trim();
}

function normalizeMattermostText(text) {
  if (!text) return "";

  let result = text;

  // MM 커스텀 이모지 alias 제거
  result = result.replace(/:[a-zA-Z0-9_+\-]+:/g, "");

  // @all 제거
  result = result.replace(/@all/g, "");

  // Discord에서 헤더 문법 유지
  result = result.replace(/^[ \t]+(?=#{1,6}\s)/gm, "");

  // Discord는 ### 까지만 헤더처럼 렌더링되므로,
  // ####, #####, ###### 는 ### 로 정규화
  result = result.replace(/^(#{4,})\s+/gm, "### ");

  // 과한 공백 정리
  result = result.replace(/[ \t]{2,}/g, " ");

  // 과한 빈 줄 정리
  result = result.replace(/\n{3,}/g, "\n\n");

  return result.trim();
}

function splitDiscordContent(content, maxLength = 1900) {
  if (!content || content.length <= maxLength) {
    return [content];
  }

  const chunks = [];
  let remaining = content;

  while (remaining.length > maxLength) {
    let slicePoint = remaining.lastIndexOf("\n\n", maxLength);
    if (slicePoint < maxLength * 0.5) {
      slicePoint = remaining.lastIndexOf("\n", maxLength);
    }
    if (slicePoint < maxLength * 0.3) {
      slicePoint = maxLength;
    }

    chunks.push(remaining.slice(0, slicePoint).trim());
    remaining = remaining.slice(slicePoint).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks.filter(Boolean);
}

function escapeDiscordInline(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/~/g, "\\~")
    .replace(/`/g, "\\`")
    .replace(/\|/g, "\\|");
}

function parseFileIds(fileIdsRaw) {
  if (!fileIdsRaw) return [];

  if (Array.isArray(fileIdsRaw)) {
    return fileIdsRaw.filter(Boolean);
  }

  return String(fileIdsRaw)
    .split(",")
    .map(v => v.trim())
    .filter(Boolean);
}

async function loginToMattermost(mmAuth) {
  const res = await fetch(`${mmAuth.baseUrl}/api/v4/users/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      login_id: mmAuth.loginId,
      password: mmAuth.password,
      token: "",
      deviceId: ""
    })
  });

  const text = await safeReadText(res);

  if (!res.ok) {
    throw new Error(`MM login failed (${res.status}): ${text}`);
  }

  const token = res.headers.get("Token");

  if (!token) {
    throw new Error("MM login succeeded but Token header not found");
  }

  return token;
}

async function downloadMattermostFile({ baseUrl, bearerToken, fileId }) {
  const url = `${baseUrl}/api/v4/files/${fileId}?download=1`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${bearerToken}`
    }
  });

  if (!res.ok) {
    const text = await safeReadText(res);
    throw new Error(`MM file download failed (${res.status}) for ${fileId}: ${text}`);
  }

  const contentDisposition = res.headers.get("content-disposition") || "";
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const fileName =
    extractFilename(contentDisposition) || `mm-file-${fileId}`;

  const arrayBuffer = await res.arrayBuffer();
  const file = new File([arrayBuffer], fileName, { type: contentType });

  return {
    fileId,
    fileName,
    fileType: contentType,
    fileSize: file.size,
    file
  };
}

function extractFilename(contentDisposition) {
  let match = contentDisposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  match = contentDisposition.match(/filename\s*=\s*"([^"]+)"/i);
  if (match?.[1]) return match[1];

  match = contentDisposition.match(/filename\s*=\s*([^;]+)/i);
  if (match?.[1]) return match[1].trim();

  return null;
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}