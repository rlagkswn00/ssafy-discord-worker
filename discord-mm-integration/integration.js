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

      // "행사" 또는 "행사-이벤트" 카테고리에 한해, 80자 미만의 글은 예외 없이 차단 (사진만 올린 글도 포함)
      if (source.category === "행사" || source.category === "행사-이벤트") {
        const minEventLength = 80; // 필요 시 이 값을 조절하십시오.

        // [스마트 링크 소거 알고리즘] 사진만 단독 전송 시 강제 주입되는 링크 노이즈 문자열 소거
        let cleanText = text || "";
        // 1. 마크다운 이미지 링크 소거: ![이름](주소)
        cleanText = cleanText.replace(/!\[.*?\]\(.*?\)/g, "");
        // 2. 일반 마크다운 링크 소거: [이름](주소)
        cleanText = cleanText.replace(/\[.*?\]\(.*?\)/g, "");
        // 3. HTTP/HTTPS 일반 웹 주소 전체 소거
        cleanText = cleanText.replace(/https?:\/\/[^\s]+/g, "");
        // 4. Mattermost 내부 파일 다운로드 API 경로 소거
        cleanText = cleanText.replace(/\/api\/v4\/files\/[^\s]+/g, "");

        // 링크 주소들을 싹 걷어낸 순수 사용자의 텍스트 입력 글자 수 측정
        const trimmedLength = cleanText.trim().length;

        // 글자수가 80자 미만이면 무조건 차단 (사진만 단독 업로드된 글자수 0자 글도 차단됩니다)
        if (trimmedLength < minEventLength) {
          console.log("========== SKIP SHORT EVENT MESSAGE (STRICT LIMIT) ==========");
          console.log(
            JSON.stringify(
              {
                sourceLabel: source.label,
                category: source.category,
                channelName,
                trimmedLength,
                minEventLength,
                preview: cleanText.slice(0, 120)
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
        // [KV Caching & Self-Healing Session Logic]
        let mmToken = null;
        let isCachedTokenUsed = false;

        // 1. KV 바인딩 존재 여부를 안전하게 검사하고 기존 세션 토큰 조회
        if (env.MM_KV) {
          try {
            mmToken = await env.MM_KV.get("MM_SESSION_TOKEN");
            if (mmToken) {
              isCachedTokenUsed = true;
              console.log("========== MM CACHED TOKEN FOUND ==========");
              console.log(JSON.stringify({
                tokenPreview: mmToken.slice(0, 6) + "..."
              }, null, 2));
            }
          } catch (kvErr) {
            console.log("Warning: Failed to read from Cloudflare KV", kvErr.message);
          }
        }

        // 2. 캐시된 토큰이 없는 경우 최초 로그인 수행 후 캐싱
        if (!mmToken) {
          console.log("========== MM NO CACHED TOKEN - ATTEMPTING LOGIN ==========");
          mmToken = await loginToMattermost(config.mmAuth);
          isCachedTokenUsed = false;
          console.log("========== MM LOGIN SUCCESS ==========");

          if (env.MM_KV) {
            try {
              // 180일 만료 시간에 근접한 안전 만료 시간(170일 = 14,688,000초) 설정 후 캐싱
              await env.MM_KV.put("MM_SESSION_TOKEN", mmToken, { expirationTtl: 14688000 });
              console.log("========== MM TOKEN CACHED TO CF KV ==========");
            } catch (kvErr) {
              console.log("Warning: Failed to write token to Cloudflare KV", kvErr.message);
            }
          }
        }

        let files = [];
        try {
          // 3. 획득한 세션 토큰을 사용하여 파일 다운로드 실행
          for (const fileId of fileIds) {
            const downloaded = await downloadMattermostFile({
              baseUrl: config.mmAuth.baseUrl,
              bearerToken: mmToken,
              fileId
            });
            files.push(downloaded);
          }
        } catch (downloadErr) {
          // 4. 기존 캐시 토큰 사용 중 401 Unauthorized(토큰 만료) 감지 시 자가 치유(Self-Healing) 작동
          if (isCachedTokenUsed && (downloadErr.message.includes("401") || downloadErr.message.includes("Unauthorized"))) {
            console.log("========== MM CACHED TOKEN EXPIRED (401) - SELF-HEALING TRIGERRED ==========");
            
            // 재로그인 및 신규 세션 토큰 획득
            mmToken = await loginToMattermost(config.mmAuth);
            console.log("========== MM RE-LOGIN SUCCESS ==========");

            if (env.MM_KV) {
              try {
                await env.MM_KV.put("MM_SESSION_TOKEN", mmToken, { expirationTtl: 14688000 });
                console.log("========== MM NEW TOKEN RE-CACHED TO CF KV ==========");
              } catch (kvErr) {
                console.log("Warning: Failed to update token to Cloudflare KV", kvErr.message);
              }
            }

            // 새로운 토큰으로 다운로드 재시도
            files = [];
            for (const fileId of fileIds) {
              const downloaded = await downloadMattermostFile({
                baseUrl: config.mmAuth.baseUrl,
                bearerToken: mmToken,
                fileId
              });
              files.push(downloaded);
            }
          } else {
            // 캐시 문제가 아니거나 재시도에서도 에러가 난 경우 최종 예외 전파
            throw downloadErr;
          }
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
        JSON.stringify({
          success: false,
          error: "Internal Server Error",
          message: "Mattermost integration worker encountered an unexpected error. Check Cloudflare logs for details."
        }),
        { 
          status: 500,
          headers: { "Content-Type": "application/json" }
        }
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