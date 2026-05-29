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
  const [...key] = params.key;

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

  const targetUrl = `${endpoint}/${params.action}/${params.key.join("/")}`;
  const method = req.method;
  const shouldNotHaveBody = ["get", "head"].includes(
    method?.toLowerCase() ?? "",
  );

  // 🛑 【核心修正】：绝对不能直接转发 req.body 流！必须将其转为 ArrayBuffer 缓存
  // 这样转发时 fetch 会自动追加精准的 Content-Length，彻底修复 Upstash 接收 chunked 流导致空写的问题
  const bodyData = shouldNotHaveBody ? null : await req.arrayBuffer();

  const fetchOptions: RequestInit = {
    headers: {
      authorization: req.headers.get("authorization") ?? "",
      "content-type": req.headers.get("content-type") ?? "text/plain", // 保持文本格式
    },
    body: bodyData,
    method,
  };

  console.log("[Upstash Proxy Forward]", targetUrl, {
    method,
    hasBody: !!bodyData,
  });
  const fetchResult = await fetch(targetUrl, fetchOptions);

  return fetchResult;
}

export const POST = handle;
export const GET = handle;
export const OPTIONS = handle;

export const runtime = "edge";
