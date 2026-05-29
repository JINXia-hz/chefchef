import { NextRequest, NextResponse } from "next/server";

async function handle(
  req: NextRequest,
  { params }: { params: { action: string; key: string[] } },
) {
  const requestUrl = new URL(req.url);
  const endpoint = requestUrl.searchParams.get("endpoint");

  if (req.method === "OPTIONS") {
    return NextResponse.json({ body: "OK" }, { status: 200 });
  }

  if (!endpoint || !new URL(endpoint).hostname.endsWith(".upstash.io")) {
    return NextResponse.json(
      {
        error: true,
        msg: "you are not allowed to request " + params.key.join("/"),
      },
      { status: 403 },
    );
  }

  if (params.action !== "get" && params.action !== "set") {
    return NextResponse.json(
      { error: true, msg: "you are not allowed to request " + params.action },
      { status: 403 },
    );
  }

  // 完美拼装目标路径，params.key.join("/") 会把 [hash, "EX", "604800"] 还原为 hash/EX/604800
  const targetUrl = `${endpoint}/${params.action}/${params.key.join("/")}`;
  const method = req.method;
  const shouldNotHaveBody = ["get", "head"].includes(
    method?.toLowerCase() ?? "",
  );

  // 🛑 核心修正：从请求中提前榨出纯文本，拒绝转发 ReadableStream 流，fetch 会自动追加精准的 Content-Length
  const bodyData = shouldNotHaveBody ? null : await req.text();

  // 🛑 核心修复 1：绝对禁止 Next.js 缓存此 Fetch 请求！
  const fetchOptions: RequestInit = {
    headers: {
      authorization: req.headers.get("authorization") ?? "",
      "content-type": req.headers.get("content-type") ?? "text/plain",
    },
    body: bodyData,
    method,
    cache: "no-store", // <-- 新增这一行
  };

  console.log("[Upstash Proxy Forward]", targetUrl, {
    method,
    hasBody: !!bodyData,
  });
  const fetchResult = await fetch(targetUrl, fetchOptions);

  // 🛑 核心修复 2：拦截响应，抹除 content-encoding，避免浏览器二次解压报错，并增加强力无缓存头
  const newHeaders = new Headers(fetchResult.headers);
  newHeaders.delete("content-encoding");
  newHeaders.set("Cache-Control", "no-store, no-cache, must-revalidate");

  return new Response(fetchResult.body, {
    status: fetchResult.status,
    statusText: fetchResult.statusText,
    headers: newHeaders,
  });
}

export const POST = handle;
export const GET = handle;
export const OPTIONS = handle;

export const runtime = "edge";
