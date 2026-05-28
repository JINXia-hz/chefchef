import {
  getMessageTextContent,
  isDalle3,
  safeLocalStorage,
  trimTopic,
} from "../utils";

import { indexedDBStorage } from "@/app/utils/indexedDB-storage";
import { nanoid } from "nanoid";
import type {
  ClientApi,
  MultimodalContent,
  RequestMessage,
} from "../client/api";
import { getClientApi } from "../client/api";
import { ChatControllerPool } from "../client/controller";
import { showToast } from "../components/ui-lib";
import {
  DEFAULT_INPUT_TEMPLATE,
  DEFAULT_MODELS,
  DEFAULT_SYSTEM_TEMPLATE,
  GEMINI_SUMMARIZE_MODEL,
  DEEPSEEK_SUMMARIZE_MODEL,
  KnowledgeCutOffDate,
  MCP_SYSTEM_TEMPLATE,
  MCP_TOOLS_TEMPLATE,
  ServiceProvider,
  StoreKey,
  SUMMARIZE_MODEL,
} from "../constant";
import Locale, { getLang } from "../locales";
import { prettyObject } from "../utils/format";
import { createPersistStore } from "../utils/store";
import { estimateTokenLength } from "../utils/token";
import { ModelConfig, ModelType, useAppConfig } from "./config";
import { useAccessStore } from "./access";
import { collectModelsWithDefaultModel } from "../utils/model";
import { createEmptyMask, Mask } from "./mask";
import { executeMcpAction, getAllTools, isMcpEnabled } from "../mcp/actions";
import { extractMcpJson, isMcpJson } from "../mcp/utils";

const localStorage = safeLocalStorage();
// ==================== 专属大厨模式与 API 配置区 ====================

// 1. Z-Image-Turbo 凭证配置
const Z_IMAGE_TURBO_KEY = "sk-skdheazwxwwqiojygsocsnkjtzdxuxgsljovfdlkpztyyhfg";
const Z_IMAGE_TURBO_URL = "https://api.siliconflow.cn/v1/images/generations"; 

// 2. 主厨系统提示词
const CHEF_SYSTEM_PROMPT = `你是一个顶级的星级主厨和 AI 图像提示词专家。
当用户向你请求某个菜品或进行修改时，你必须结合用户的个人喜好和口味（如果提供的话），深思熟虑后重新加工，并严格按照以下格式生成内容。不要带有任何格式之外的解释或废话：

---RECIPE---
# [菜名]
[这里写详细的食谱，包含精美丰富的 Markdown 格式、用料、详细步骤]

---PROMPT---
[这里写一段专门为文生图模型量身定制的英文图像生成提示词。必须包含该菜品的细节、高级画质、精美餐具、专业光影构图，例如: food photography, professional studio lighting, depth of field, close-up shot, 8k, photorealistic, elegant plating...]`;

// 3. Z-Image-Turbo 请求封装（支持 OpenAI 兼容格式）
async function requestZImageTurbo(prompt: string): Promise<string> {
  // 自动格式化 base url
  const baseUrl = Z_IMAGE_TURBO_URL.replace(/\/$/, "");
  // 如果你的接口地址本身包含了完整路径，就直接用；否则拼接标准的 /v1/images/generations
  const path = baseUrl.includes("/v1/") ? baseUrl : `${baseUrl}/v1/images/generations`;

  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${Z_IMAGE_TURBO_KEY}`,
    },
    body: JSON.stringify({
      model: "Tongyi-MAI/Z-Image-Turbo",
      prompt: prompt,
      n: 1,
      size: "1024x1024",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Z-Image-Turbo 请求失败: ${response.status} - ${errorText}`);
  }

  const resJson = await response.json();
  // 自动兼容标准 OpenAI 格式 { data: [{ url: "..." }] } 或直接返回 { url: "..." }
  const imageUrl = resJson?.data?.[0]?.url || resJson?.url || resJson?.image;
  
  if (!imageUrl) {
    throw new Error("接口未返回有效的图片字段，请检查控制台返回的 JSON 结构");
  }
  return imageUrl;
}
// ===================================================================

// ==================== 专属大厨：IndexedDB 记忆与喜好引擎 ====================
const CHEF_DB_NAME = "ChefChefMemory";
const CHEF_STORE_NAME = "dish_caches";

// 初始化或打开本地大厨数据库
function openChefDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CHEF_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CHEF_STORE_NAME)) {
        db.createObjectStore(CHEF_STORE_NAME, { keyPath: "dishName" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// 记忆读取：根据菜名检索本地是否有现成的精美成果
async function getRecipeFromMemory(dishName: string): Promise<{ content: string } | null> {
  try {
    const db = await openChefDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(CHEF_STORE_NAME, "readonly");
      const store = transaction.objectStore(CHEF_STORE_NAME);
      const request = store.get(dishName.toLowerCase().trim());
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } catch (e) {
    console.error("[Chef Memory] 读取缓存失败:", e);
    return null;
  }
}

// 记忆写入：将生成完美的 食谱+图片 归档入库
async function saveRecipeToMemory(dishName: string, fullContent: string): Promise<void> {
  try {
    const db = await openChefDB();
    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(CHEF_STORE_NAME, "readwrite");
      const store = transaction.objectStore(CHEF_STORE_NAME);
      const request = store.put({
        dishName: dishName.toLowerCase().trim(),
        content: fullContent,
        updatedAt: Date.now(),
      });
      request.onsuccess = () => {
        console.log(`[Chef Memory] 已成功将 【${dishName}】 录入本地厨房记忆`);
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  } catch (e) {
    console.error("[Chef Memory] 写入缓存失败:", e);
  }
}
// ===================================================================

// ==================== 专属大厨：Upstash 线上云数据库与统一加解密引擎 ====================

// 1. 白嫖配置区
const UPSTASH_REDIS_REST_URL ="https://alert-possum-79616.upstash.io";
const UPSTASH_REDIS_REST_TOKEN = "gQAAAAAAATcAAAIgcDIzNzUwOGYwYjNhMTQ0NTc2OTVkMjU4NGNjZDlmMmIxZAN";

// 2. 原生高效密码学：SHA-256 哈希计算（用于把用户密码转换成唯一的云端匿名 UserID）
async function hashPassword(text: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(text.trim());
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// 3. 原生高级加密标准：AES-GCM 文本加密
async function encryptText(text: string, password: string): Promise<string> {
  const enc = new TextEncoder();
  const pwHash = await crypto.subtle.digest("SHA-256", enc.encode(password));
  const key = await crypto.subtle.importKey("raw", pwHash, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = enc.encode(password.substring(0, 12).padStart(12, "0")); // 派生确定性IV简化存储
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(encrypted)));
}

// 4. 原生高级解密标准：AES-GCM 文本解密
async function decryptText(cipherBase64: string, password: string): Promise<string> {
  try {
    const enc = new TextEncoder();
    const pwHash = await crypto.subtle.digest("SHA-256", enc.encode(password));
    const key = await crypto.subtle.importKey("raw", pwHash, { name: "AES-GCM" }, false, ["decrypt"]);
    const iv = enc.encode(password.substring(0, 12).padStart(12, "0"));
    const encryptedBytes = new Uint8Array(atob(cipherBase64).split("").map(c => c.charCodeAt(0)));
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encryptedBytes);
    return new TextDecoder().decode(decrypted);
  } catch (e) {
    return "⚠️ [解密失败] 您的私钥/密码似乎不正确，无法读取历史偏好。";
  }
}

// 5. 云端通用万能读接口 (HTTP REST)
async function cloudDBGet(key: string): Promise<string | null> {
  if (!UPSTASH_REDIS_REST_URL || UPSTASH_REDIS_REST_URL.includes("这里填入")) return null;
  try {
    const res = await fetch(`${UPSTASH_REDIS_REST_URL.replace(/\/$/, "")}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` }
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.result || null;
  } catch (e) {
    console.error("[CloudDB 故障]", e);
    return null;
  }
}

// 6. 云端通用万能写接口 (HTTP REST)
async function cloudDBSet(key: string, value: string): Promise<boolean> {
  if (!UPSTASH_REDIS_REST_URL || UPSTASH_REDIS_REST_URL.includes("这里填入")) return false;
  try {
    const res = await fetch(`${UPSTASH_REDIS_REST_URL.replace(/\/$/, "")}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
      body: value
    });
    return res.ok;
  } catch (e) {
    console.error("[CloudDB 写入故障]", e);
    return false;
  }
}
// ===================================================================

export type ChatMessageTool = {
  id: string;
  index?: number;
  type?: string;
  function?: {
    name: string;
    arguments?: string;
  };
  content?: string;
  isError?: boolean;
  errorMsg?: string;
};

export type ChatMessage = RequestMessage & {
  date: string;
  streaming?: boolean;
  isError?: boolean;
  id: string;
  model?: ModelType;
  tools?: ChatMessageTool[];
  audio_url?: string;
  isMcpResponse?: boolean;
};

export function createMessage(override: Partial<ChatMessage>): ChatMessage {
  return {
    id: nanoid(),
    date: new Date().toLocaleString(),
    role: "user",
    content: "",
    ...override,
  };
}

export interface ChatStat {
  tokenCount: number;
  wordCount: number;
  charCount: number;
}

export interface ChatSession {
  id: string;
  topic: string;

  memoryPrompt: string;
  messages: ChatMessage[];
  stat: ChatStat;
  lastUpdate: number;
  lastSummarizeIndex: number;
  clearContextIndex?: number;

  mask: Mask;
}

export const DEFAULT_TOPIC = Locale.Store.DefaultTopic;
export const BOT_HELLO: ChatMessage = createMessage({
  role: "assistant",
  content: Locale.Store.BotHello,
});

function createEmptySession(): ChatSession {
  return {
    id: nanoid(),
    topic: DEFAULT_TOPIC,
    memoryPrompt: "",
    messages: [],
    stat: {
      tokenCount: 0,
      wordCount: 0,
      charCount: 0,
    },
    lastUpdate: Date.now(),
    lastSummarizeIndex: 0,

    mask: createEmptyMask(),
  };
}

function getSummarizeModel(
  currentModel: string,
  providerName: string,
): string[] {
  // if it is using gpt-* models, force to use 4o-mini to summarize
  if (currentModel.startsWith("gpt") || currentModel.startsWith("chatgpt")) {
    const configStore = useAppConfig.getState();
    const accessStore = useAccessStore.getState();
    const allModel = collectModelsWithDefaultModel(
      configStore.models,
      [configStore.customModels, accessStore.customModels].join(","),
      accessStore.defaultModel,
    );
    const summarizeModel = allModel.find(
      (m) => m.name === SUMMARIZE_MODEL && m.available,
    );
    if (summarizeModel) {
      return [
        summarizeModel.name,
        summarizeModel.provider?.providerName as string,
      ];
    }
  }
  if (currentModel.startsWith("gemini")) {
    return [GEMINI_SUMMARIZE_MODEL, ServiceProvider.Google];
  } else if (currentModel.startsWith("deepseek-")) {
    return [DEEPSEEK_SUMMARIZE_MODEL, ServiceProvider.DeepSeek];
  }

  return [currentModel, providerName];
}

function countMessages(msgs: ChatMessage[]) {
  return msgs.reduce(
    (pre, cur) => pre + estimateTokenLength(getMessageTextContent(cur)),
    0,
  );
}

function fillTemplateWith(input: string, modelConfig: ModelConfig) {
  const cutoff =
    KnowledgeCutOffDate[modelConfig.model] ?? KnowledgeCutOffDate.default;
  // Find the model in the DEFAULT_MODELS array that matches the modelConfig.model
  const modelInfo = DEFAULT_MODELS.find((m) => m.name === modelConfig.model);

  var serviceProvider = "OpenAI";
  if (modelInfo) {
    // TODO: auto detect the providerName from the modelConfig.model

    // Directly use the providerName from the modelInfo
    serviceProvider = modelInfo.provider.providerName;
  }

  const vars = {
    ServiceProvider: serviceProvider,
    cutoff,
    model: modelConfig.model,
    time: new Date().toString(),
    lang: getLang(),
    input: input,
  };

  let output = modelConfig.template ?? DEFAULT_INPUT_TEMPLATE;

  // remove duplicate
  if (input.startsWith(output)) {
    output = "";
  }

  // must contains {{input}}
  const inputVar = "{{input}}";
  if (!output.includes(inputVar)) {
    output += "\n" + inputVar;
  }

  Object.entries(vars).forEach(([name, value]) => {
    const regex = new RegExp(`{{${name}}}`, "g");
    output = output.replace(regex, value.toString()); // Ensure value is a string
  });

  return output;
}

async function getMcpSystemPrompt(): Promise<string> {
  const tools = await getAllTools();

  let toolsStr = "";

  tools.forEach((i) => {
    // error client has no tools
    if (!i.tools) return;

    toolsStr += MCP_TOOLS_TEMPLATE.replace(
      "{{ clientId }}",
      i.clientId,
    ).replace(
      "{{ tools }}",
      i.tools.tools.map((p: object) => JSON.stringify(p, null, 2)).join("\n"),
    );
  });

  return MCP_SYSTEM_TEMPLATE.replace("{{ MCP_TOOLS }}", toolsStr);
}

const DEFAULT_CHAT_STATE = {
  sessions: [createEmptySession()],
  currentSessionIndex: 0,
  lastInput: "",
};

export const useChatStore = createPersistStore(
  DEFAULT_CHAT_STATE,
  (set, _get) => {
    function get() {
      return {
        ..._get(),
        ...methods,
      };
    }

    const methods = {
      forkSession() {
        // 获取当前会话
        const currentSession = get().currentSession();
        if (!currentSession) return;

        const newSession = createEmptySession();

        newSession.topic = currentSession.topic;
        // 深拷贝消息
        newSession.messages = currentSession.messages.map((msg) => ({
          ...msg,
          id: nanoid(), // 生成新的消息 ID
        }));
        newSession.mask = {
          ...currentSession.mask,
          modelConfig: {
            ...currentSession.mask.modelConfig,
          },
        };

        set((state) => ({
          currentSessionIndex: 0,
          sessions: [newSession, ...state.sessions],
        }));
      },

      clearSessions() {
        set(() => ({
          sessions: [createEmptySession()],
          currentSessionIndex: 0,
        }));
      },

      selectSession(index: number) {
        set({
          currentSessionIndex: index,
        });
      },

      moveSession(from: number, to: number) {
        set((state) => {
          const { sessions, currentSessionIndex: oldIndex } = state;

          // move the session
          const newSessions = [...sessions];
          const session = newSessions[from];
          newSessions.splice(from, 1);
          newSessions.splice(to, 0, session);

          // modify current session id
          let newIndex = oldIndex === from ? to : oldIndex;
          if (oldIndex > from && oldIndex <= to) {
            newIndex -= 1;
          } else if (oldIndex < from && oldIndex >= to) {
            newIndex += 1;
          }

          return {
            currentSessionIndex: newIndex,
            sessions: newSessions,
          };
        });
      },

      newSession(mask?: Mask) {
        const session = createEmptySession();

        if (mask) {
          const config = useAppConfig.getState();
          const globalModelConfig = config.modelConfig;

          session.mask = {
            ...mask,
            modelConfig: {
              ...globalModelConfig,
              ...mask.modelConfig,
            },
          };
          session.topic = mask.name;
        }

        set((state) => ({
          currentSessionIndex: 0,
          sessions: [session].concat(state.sessions),
        }));
      },

      nextSession(delta: number) {
        const n = get().sessions.length;
        const limit = (x: number) => (x + n) % n;
        const i = get().currentSessionIndex;
        get().selectSession(limit(i + delta));
      },

      deleteSession(index: number) {
        const deletingLastSession = get().sessions.length === 1;
        const deletedSession = get().sessions.at(index);

        if (!deletedSession) return;

        const sessions = get().sessions.slice();
        sessions.splice(index, 1);

        const currentIndex = get().currentSessionIndex;
        let nextIndex = Math.min(
          currentIndex - Number(index < currentIndex),
          sessions.length - 1,
        );

        if (deletingLastSession) {
          nextIndex = 0;
          sessions.push(createEmptySession());
        }

        // for undo delete action
        const restoreState = {
          currentSessionIndex: get().currentSessionIndex,
          sessions: get().sessions.slice(),
        };

        set(() => ({
          currentSessionIndex: nextIndex,
          sessions,
        }));

        showToast(
          Locale.Home.DeleteToast,
          {
            text: Locale.Home.Revert,
            onClick() {
              set(() => restoreState);
            },
          },
          5000,
        );
      },

      currentSession() {
        let index = get().currentSessionIndex;
        const sessions = get().sessions;

        if (index < 0 || index >= sessions.length) {
          index = Math.min(sessions.length - 1, Math.max(0, index));
          set(() => ({ currentSessionIndex: index }));
        }

        const session = sessions[index];

        return session;
      },

      onNewMessage(message: ChatMessage, targetSession: ChatSession) {
        get().updateTargetSession(targetSession, (session) => {
          session.messages = session.messages.concat();
          session.lastUpdate = Date.now();
        });

        get().updateStat(message, targetSession);

        get().checkMcpJson(message);

        get().summarizeSession(false, targetSession);
      },

      async onUserInput(
        content: string,
        attachImages?: string[],
        isMcpResponse?: boolean,
      ) {
        const session = get().currentSession();
        const modelConfig = session.mask.modelConfig;

        // 1. 超强指令解析器：支持剥离 【菜名描述】、【密码私钥】、【动态口味喜好】
        const generateRegex = /^(G·|\/生成)\s*(.+?)(?:\s+(?:密码|key|p)[:：](\S+))?(?:\s+(?:偏好|喜好|pref)[:：](\S+))?$/i;
        const match = content.trim().match(generateRegex);
        
        const hasChefContext = session.messages.some(
          (m) => m.role === "assistant" && getMessageTextContent(m).includes("---RECIPE---")
        );
        const isChefMode = !!match || hasChefContext;

        let cleanContent = content;
        let userPassword = "";
        let inlinePreference = "";

        if (match) {
          cleanContent = match[2].trim();     // 干净的菜名
          userPassword = match[3] || "";     // 用户自记的私钥密码
          inlinePreference = match[4] || ""; // 本次指定的临时/更新喜好
        }

        // ============ 【线上全通用设计】第一关：线上全局通用记忆拦截 ============
        if (match && isChefMode) {
          // 云端全局大统一：所有人或任意设备只要生成过这道菜，就可被瞬间通杀击中
          const globalCloudMemory = await cloudDBGet(`chef:dish:${cleanContent.toLowerCase().trim()}`);
          if (globalCloudMemory) {
            console.log(`[Chef Cloud] ⚡ 线上云端数据库成功击中 【${cleanContent}】 的通用厨房记忆！`);
            
            const memoMessage = createMessage({
              role: "assistant",
              content: globalCloudMemory,
              streaming: false,
              model: modelConfig.model,
              date: new Date().toLocaleString(),
            });

            get().updateTargetSession(session, (session) => {
              session.messages = session.messages.concat([
                createMessage({ role: "user", content: content }),
                memoMessage,
              ]);
            });
            get().onNewMessage(memoMessage, session);
            return; // 强行熔断后续大模型和生图请求，极度省钱、全网通用！
          }
        }
        // ===================================================================

        // MCP Response no need to fill template
        let mContent: string | MultimodalContent[] = isMcpResponse
          ? cleanContent
          : fillTemplateWith(cleanContent, modelConfig);

        if (!isMcpResponse && attachImages && attachImages.length > 0) {
          mContent = [
            ...(cleanContent ? [{ type: "text" as const, text: cleanContent }] : []),
            ...attachImages.map((url) => ({
              type: "image_url" as const,
              image_url: { url },
            })),
          ];
        }

        let userMessage: ChatMessage = createMessage({
          role: "user",
          content: mContent,
          isMcpResponse,
        });

        const botMessage: ChatMessage = createMessage({
          role: "assistant",
          streaming: true,
          model: modelConfig.model,
        });

        const recentMessages = await get().getMessagesWithMemory();
        let sendMessages = recentMessages.concat(userMessage);
        
        // ============ 【线上全通用设计】第二关：解密用户隐私并在 LLM 之前织入 ============
        if (isChefMode) {
          let finalPreferences = "无特殊过敏源和饮食限制";

          if (userPassword) {
            const anonymityUserID = await hashPassword(userPassword);
            const userCloudKey = `chef:user:${anonymityUserID}`;

            // 如果提示词里带了新喜好，我们立刻加密把新偏好同步到线上，白嫖永不丢失
            if (inlinePreference) {
              finalPreferences = inlinePreference;
              const encryptedPrefs = await encryptText(inlinePreference, userPassword);
              await cloudDBSet(userCloudKey, encryptedPrefs);
              console.log("[Chef Cloud] 用户新偏好已通过 AES 前端加密同步上云。");
            } else {
              // 如果没有输入新喜好，自动去线上捞出经加密的隐私数据并在前端现场解密
              const encryptedCloudPrefs = await cloudDBGet(userCloudKey);
              if (encryptedCloudPrefs) {
                finalPreferences = await decryptText(encryptedCloudPrefs, userPassword);
                console.log("[Chef Cloud] 成功从云端解密食客的历史口味画像。");
              }
            }
          }

          // 将现场还原出来的个人口味偏好，动态拼接进 DeepSeek 系统提示词
          const dynamicChefPrompt = `${CHEF_SYSTEM_PROMPT}\n\n[食客个人画像与口味偏好（你必须在食谱定制与画面展现中隐式迎合）：${finalPreferences}]`;

          sendMessages = [
            createMessage({
              role: "system",
              content: dynamicChefPrompt,
            }),
            ...sendMessages,
          ];
        }
        // ===================================================================

        const messageIndex = session.messages.length + 1;

        get().updateTargetSession(session, (session) => {
          const savedUserMessage = {
            ...userMessage,
            content: match ? match[0] + " " + cleanContent : mContent,
          };
          session.messages = session.messages.concat([
            savedUserMessage,
            botMessage,
          ]);
        });

        const api: ClientApi = getClientApi(modelConfig.providerName);
        
        api.llm.chat({
          messages: sendMessages,
          config: { ...modelConfig, stream: true },
          onUpdate(message) {
            botMessage.streaming = true;
            if (message) {
              botMessage.content = message;
            }
            get().updateTargetSession(session, (session) => {
              session.messages = session.messages.concat();
            });
          },
          async onFinish(message) {
            botMessage.streaming = false;
            if (message) {
              botMessage.content = message;
              botMessage.date = new Date().toLocaleString();
              get().onNewMessage(botMessage, session);

              if (isChefMode) {
                console.log("[Chef Mode] 第一个 LLM 响应结束，开始解析绘图提示词...");
                const promptMatch = message.match(/---PROMPT---([\s\S]*)/i);
                
                if (promptMatch && promptMatch[1]) {
                  const imagePrompt = promptMatch[1].trim();
                  console.log("[Chef Mode] 提取到绘图提示词: ", imagePrompt);
                  
                  const loadingText = "\n\n⏱️ **美食主厨正在为您精心摆盘并拍摄精美效果图，请稍候...**";
                  
                  if (typeof botMessage.content === "string") {
                    botMessage.content += loadingText;
                  }
                  
                  get().updateTargetSession(session, (s) => {
                    s.messages = s.messages.concat();
                  });

                  requestZImageTurbo(imagePrompt)
                    .then((imageUrl) => {
                      if (typeof botMessage.content === "string") {
                        botMessage.content = botMessage.content.replace(
                          loadingText,
                          `\n\n### 🧑‍🍳 菜品效果图\n![${cleanContent}](${imageUrl})`
                        );
                        
                        // ============ 【线上全通用设计】第三关：大功告成，全量发布到云端公共记忆库 ============
                        cloudDBSet(`chef:dish:${cleanContent.toLowerCase().trim()}`, botMessage.content);
                        // ===================================================================
                      }
                      get().updateTargetSession(session, (s) => {
                        s.messages = s.messages.concat();
                      });
                    })
                    .catch((err) => {
                      console.error("[Chef Mode] 生图失败: ", err);
                      if (typeof botMessage.content === "string") {
                        botMessage.content = botMessage.content.replace(
                          loadingText,
                          `\n\n❌ *[图片生成失败]: ${err.message || err}*`
                        );
                      }
                      get().updateTargetSession(session, (s) => {
                        s.messages = s.messages.concat();
                      });
                    });
                }
              }
            }
            ChatControllerPool.remove(session.id, botMessage.id);
          },
          onBeforeTool(tool: ChatMessageTool) {
            (botMessage.tools = botMessage?.tools || []).push(tool);
            get().updateTargetSession(session, (session) => {
              session.messages = session.messages.concat();
            });
          },
          onAfterTool(tool: ChatMessageTool) {
            botMessage?.tools?.forEach((t, i, tools) => {
              if (tool.id == t.id) {
                tools[i] = { ...tool };
              }
            });
            get().updateTargetSession(session, (session) => {
              session.messages = session.messages.concat();
            });
          },
          onError(error) {
            const isAborted = error.message?.includes?.("aborted");
            botMessage.content +=
              "\n\n" +
              prettyObject({
                error: true,
                message: error.message,
              });
            botMessage.streaming = false;
            userMessage.isError = !isAborted;
            botMessage.isError = !isAborted;
            get().updateTargetSession(session, (session) => {
              session.messages = session.messages.concat();
            });
            ChatControllerPool.remove(
              session.id,
              botMessage.id ?? messageIndex,
            );
            console.error("[Chat] failed ", error);
          },
          onController(controller) {
            ChatControllerPool.addController(
              session.id,
              botMessage.id ?? messageIndex,
              controller,
            );
          },
        });
      },

      getMemoryPrompt() {
        const session = get().currentSession();

        if (session.memoryPrompt.length) {
          return {
            role: "system",
            content: Locale.Store.Prompt.History(session.memoryPrompt),
            date: "",
          } as ChatMessage;
        }
      },

      async getMessagesWithMemory() {
        const session = get().currentSession();
        const modelConfig = session.mask.modelConfig;
        const clearContextIndex = session.clearContextIndex ?? 0;
        const messages = session.messages.slice();
        const totalMessageCount = session.messages.length;

        // in-context prompts
        const contextPrompts = session.mask.context.slice();

        // system prompts, to get close to OpenAI Web ChatGPT
        const shouldInjectSystemPrompts =
          modelConfig.enableInjectSystemPrompts &&
          (session.mask.modelConfig.model.startsWith("gpt-") ||
            session.mask.modelConfig.model.startsWith("chatgpt-"));

        const mcpEnabled = await isMcpEnabled();
        const mcpSystemPrompt = mcpEnabled ? await getMcpSystemPrompt() : "";

        var systemPrompts: ChatMessage[] = [];

        if (shouldInjectSystemPrompts) {
          systemPrompts = [
            createMessage({
              role: "system",
              content:
                fillTemplateWith("", {
                  ...modelConfig,
                  template: DEFAULT_SYSTEM_TEMPLATE,
                }) + mcpSystemPrompt,
            }),
          ];
        } else if (mcpEnabled) {
          systemPrompts = [
            createMessage({
              role: "system",
              content: mcpSystemPrompt,
            }),
          ];
        }

        if (shouldInjectSystemPrompts || mcpEnabled) {
          console.log(
            "[Global System Prompt] ",
            systemPrompts.at(0)?.content ?? "empty",
          );
        }
        const memoryPrompt = get().getMemoryPrompt();
        // long term memory
        const shouldSendLongTermMemory =
          modelConfig.sendMemory &&
          session.memoryPrompt &&
          session.memoryPrompt.length > 0 &&
          session.lastSummarizeIndex > clearContextIndex;
        const longTermMemoryPrompts =
          shouldSendLongTermMemory && memoryPrompt ? [memoryPrompt] : [];
        const longTermMemoryStartIndex = session.lastSummarizeIndex;

        // short term memory
        const shortTermMemoryStartIndex = Math.max(
          0,
          totalMessageCount - modelConfig.historyMessageCount,
        );

        // lets concat send messages, including 4 parts:
        // 0. system prompt: to get close to OpenAI Web ChatGPT
        // 1. long term memory: summarized memory messages
        // 2. pre-defined in-context prompts
        // 3. short term memory: latest n messages
        // 4. newest input message
        const memoryStartIndex = shouldSendLongTermMemory
          ? Math.min(longTermMemoryStartIndex, shortTermMemoryStartIndex)
          : shortTermMemoryStartIndex;
        // and if user has cleared history messages, we should exclude the memory too.
        const contextStartIndex = Math.max(clearContextIndex, memoryStartIndex);
        const maxTokenThreshold = modelConfig.max_tokens;

        // get recent messages as much as possible
        const reversedRecentMessages = [];
        for (
          let i = totalMessageCount - 1, tokenCount = 0;
          i >= contextStartIndex && tokenCount < maxTokenThreshold;
          i -= 1
        ) {
          const msg = messages[i];
          if (!msg || msg.isError) continue;
          tokenCount += estimateTokenLength(getMessageTextContent(msg));
          reversedRecentMessages.push(msg);
        }
        // concat all messages
        const recentMessages = [
          ...systemPrompts,
          ...longTermMemoryPrompts,
          ...contextPrompts,
          ...reversedRecentMessages.reverse(),
        ];

        return recentMessages;
      },

      updateMessage(
        sessionIndex: number,
        messageIndex: number,
        updater: (message?: ChatMessage) => void,
      ) {
        const sessions = get().sessions;
        const session = sessions.at(sessionIndex);
        const messages = session?.messages;
        updater(messages?.at(messageIndex));
        set(() => ({ sessions }));
      },

      resetSession(session: ChatSession) {
        get().updateTargetSession(session, (session) => {
          session.messages = [];
          session.memoryPrompt = "";
        });
      },

      summarizeSession(
        refreshTitle: boolean = false,
        targetSession: ChatSession,
      ) {
        const config = useAppConfig.getState();
        const session = targetSession;
        const modelConfig = session.mask.modelConfig;
        // skip summarize when using dalle3?
        if (isDalle3(modelConfig.model)) {
          return;
        }

        // if not config compressModel, then using getSummarizeModel
        const [model, providerName] = modelConfig.compressModel
          ? [modelConfig.compressModel, modelConfig.compressProviderName]
          : getSummarizeModel(
              session.mask.modelConfig.model,
              session.mask.modelConfig.providerName,
            );
        const api: ClientApi = getClientApi(providerName as ServiceProvider);

        // remove error messages if any
        const messages = session.messages;

        // should summarize topic after chating more than 50 words
        const SUMMARIZE_MIN_LEN = 50;
        if (
          (config.enableAutoGenerateTitle &&
            session.topic === DEFAULT_TOPIC &&
            countMessages(messages) >= SUMMARIZE_MIN_LEN) ||
          refreshTitle
        ) {
          const startIndex = Math.max(
            0,
            messages.length - modelConfig.historyMessageCount,
          );
          const topicMessages = messages
            .slice(
              startIndex < messages.length ? startIndex : messages.length - 1,
              messages.length,
            )
            .concat(
              createMessage({
                role: "user",
                content: Locale.Store.Prompt.Topic,
              }),
            );
          api.llm.chat({
            messages: topicMessages,
            config: {
              model,
              stream: false,
              providerName,
            },
            onFinish(message, responseRes) {
              if (responseRes?.status === 200) {
                get().updateTargetSession(
                  session,
                  (session) =>
                    (session.topic =
                      message.length > 0 ? trimTopic(message) : DEFAULT_TOPIC),
                );
              }
            },
          });
        }
        const summarizeIndex = Math.max(
          session.lastSummarizeIndex,
          session.clearContextIndex ?? 0,
        );
        let toBeSummarizedMsgs = messages
          .filter((msg) => !msg.isError)
          .slice(summarizeIndex);

        const historyMsgLength = countMessages(toBeSummarizedMsgs);

        if (historyMsgLength > (modelConfig?.max_tokens || 4000)) {
          const n = toBeSummarizedMsgs.length;
          toBeSummarizedMsgs = toBeSummarizedMsgs.slice(
            Math.max(0, n - modelConfig.historyMessageCount),
          );
        }
        const memoryPrompt = get().getMemoryPrompt();
        if (memoryPrompt) {
          // add memory prompt
          toBeSummarizedMsgs.unshift(memoryPrompt);
        }

        const lastSummarizeIndex = session.messages.length;

        console.log(
          "[Chat History] ",
          toBeSummarizedMsgs,
          historyMsgLength,
          modelConfig.compressMessageLengthThreshold,
        );

        if (
          historyMsgLength > modelConfig.compressMessageLengthThreshold &&
          modelConfig.sendMemory
        ) {
          /** Destruct max_tokens while summarizing
           * this param is just shit
           **/
          const { max_tokens, ...modelcfg } = modelConfig;
          api.llm.chat({
            messages: toBeSummarizedMsgs.concat(
              createMessage({
                role: "system",
                content: Locale.Store.Prompt.Summarize,
                date: "",
              }),
            ),
            config: {
              ...modelcfg,
              stream: true,
              model,
              providerName,
            },
            onUpdate(message) {
              session.memoryPrompt = message;
            },
            onFinish(message, responseRes) {
              if (responseRes?.status === 200) {
                console.log("[Memory] ", message);
                get().updateTargetSession(session, (session) => {
                  session.lastSummarizeIndex = lastSummarizeIndex;
                  session.memoryPrompt = message; // Update the memory prompt for stored it in local storage
                });
              }
            },
            onError(err) {
              console.error("[Summarize] ", err);
            },
          });
        }
      },

      updateStat(message: ChatMessage, session: ChatSession) {
        get().updateTargetSession(session, (session) => {
          session.stat.charCount += message.content.length;
          // TODO: should update chat count and word count
        });
      },
      updateTargetSession(
        targetSession: ChatSession,
        updater: (session: ChatSession) => void,
      ) {
        const sessions = get().sessions;
        const index = sessions.findIndex((s) => s.id === targetSession.id);
        if (index < 0) return;
        updater(sessions[index]);
        set(() => ({ sessions }));
      },
      async clearAllData() {
        await indexedDBStorage.clear();
        localStorage.clear();
        location.reload();
      },
      setLastInput(lastInput: string) {
        set({
          lastInput,
        });
      },

      /** check if the message contains MCP JSON and execute the MCP action */
      checkMcpJson(message: ChatMessage) {
        const mcpEnabled = isMcpEnabled();
        if (!mcpEnabled) return;
        const content = getMessageTextContent(message);
        if (isMcpJson(content)) {
          try {
            const mcpRequest = extractMcpJson(content);
            if (mcpRequest) {
              console.debug("[MCP Request]", mcpRequest);

              executeMcpAction(mcpRequest.clientId, mcpRequest.mcp)
                .then((result) => {
                  console.log("[MCP Response]", result);
                  const mcpResponse =
                    typeof result === "object"
                      ? JSON.stringify(result)
                      : String(result);
                  get().onUserInput(
                    `\`\`\`json:mcp-response:${mcpRequest.clientId}\n${mcpResponse}\n\`\`\``,
                    [],
                    true,
                  );
                })
                .catch((error) => showToast("MCP execution failed", error));
            }
          } catch (error) {
            console.error("[Check MCP JSON]", error);
          }
        }
      },
    };

    return methods;
  },
  {
    name: StoreKey.Chat,
    version: 3.3,
    migrate(persistedState, version) {
      const state = persistedState as any;
      const newState = JSON.parse(
        JSON.stringify(state),
      ) as typeof DEFAULT_CHAT_STATE;

      if (version < 2) {
        newState.sessions = [];

        const oldSessions = state.sessions;
        for (const oldSession of oldSessions) {
          const newSession = createEmptySession();
          newSession.topic = oldSession.topic;
          newSession.messages = [...oldSession.messages];
          newSession.mask.modelConfig.sendMemory = true;
          newSession.mask.modelConfig.historyMessageCount = 4;
          newSession.mask.modelConfig.compressMessageLengthThreshold = 1000;
          newState.sessions.push(newSession);
        }
      }

      if (version < 3) {
        // migrate id to nanoid
        newState.sessions.forEach((s) => {
          s.id = nanoid();
          s.messages.forEach((m) => (m.id = nanoid()));
        });
      }

      // Enable `enableInjectSystemPrompts` attribute for old sessions.
      // Resolve issue of old sessions not automatically enabling.
      if (version < 3.1) {
        newState.sessions.forEach((s) => {
          if (
            // Exclude those already set by user
            !s.mask.modelConfig.hasOwnProperty("enableInjectSystemPrompts")
          ) {
            // Because users may have changed this configuration,
            // the user's current configuration is used instead of the default
            const config = useAppConfig.getState();
            s.mask.modelConfig.enableInjectSystemPrompts =
              config.modelConfig.enableInjectSystemPrompts;
          }
        });
      }

      // add default summarize model for every session
      if (version < 3.2) {
        newState.sessions.forEach((s) => {
          const config = useAppConfig.getState();
          s.mask.modelConfig.compressModel = config.modelConfig.compressModel;
          s.mask.modelConfig.compressProviderName =
            config.modelConfig.compressProviderName;
        });
      }
      // revert default summarize model for every session
      if (version < 3.3) {
        newState.sessions.forEach((s) => {
          const config = useAppConfig.getState();
          s.mask.modelConfig.compressModel = "";
          s.mask.modelConfig.compressProviderName = "";
        });
      }

      return newState as any;
    },
  },
);
