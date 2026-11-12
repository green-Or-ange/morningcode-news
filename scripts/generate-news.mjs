#!/usr/bin/env node
/* =========================================================
   MorningCode · 每日简报生成器
   由 GitHub Actions 每天 00:30（北京时间）运行，无需后端与密钥。
   输出：
     assets/news-data.json  页面优先读取的当日简报
     assets/news-data.js    同源脚本/CDN 兜底版本
   本地手动执行： node scripts/generate-news.mjs
   强制重新生成： FORCE_NEWS=1 node scripts/generate-news.mjs
   ========================================================= */

import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "assets");
const DAILY_DIR = join(OUT_DIR, "daily");
const JSON_OUT = join(OUT_DIR, "news-data.json");
const JS_OUT = join(OUT_DIR, "news-data.js");
const KEEP_DAYS = 14;

const MAX_ITEMS = 10;
const MIN_ITEMS = 6;
const MAX_PER_CATEGORY = 4;
const MAX_AGE_DAYS = 3;

/* ---------------------------------------------------------
   北京时间工具（不依赖运行机器的时区）
   --------------------------------------------------------- */
function beijingParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const get = (type) => (parts.find((part) => part.type === type) || {}).value || "00";
  return {
    year: get("year"), month: get("month"), day: get("day"),
    hour: get("hour"), minute: get("minute"), second: get("second")
  };
}

function beijingDateKey(date = new Date()) {
  const p = beijingParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

function beijingISOString(date = new Date()) {
  const p = beijingParts(date);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+08:00`;
}

function dayNumber(dateKey) {
  const [y, m, d] = String(dateKey).split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

/* ---------------------------------------------------------
   数据源：主源为每日更新的 AI / IT 资讯接口，多实例故障转移。
   rss2json 免费额度可能被共享 IP 用尽，仅作为可选增强。
   --------------------------------------------------------- */
const API_HOSTS = [
  "https://60s.viki.moe",
  "https://60s.crystelf.top"
];

const hostUrls = (path) => API_HOSTS.map((host) => host + path);

const SOURCES = [
  { name: "AI 资讯", weight: 6, parse: "ainews", urls: hostUrls("/v2/ai-news") },
  { name: "IT之家", weight: 2, parse: "itnews", urls: hostUrls("/v2/it-news") },
  { name: "60秒读懂世界", weight: 0, parse: "sixty", urls: hostUrls("/v2/60s") },
  {
    name: "量子位", weight: 4, parse: "rss2json",
    urls: ["https://api.rss2json.com/v1/api.json?rss_url=" +
      encodeURIComponent("https://www.qbitai.com/feed") + "&count=20"]
  },
  {
    name: "InfoQ", weight: 4, parse: "rss2json",
    urls: ["https://api.rss2json.com/v1/api.json?rss_url=" +
      encodeURIComponent("https://www.infoq.cn/feed") + "&count=20"]
  }
];

const KEYWORDS = {
  agent: ["智能体", "Agent", "大模型", "LLM", "GPT", "Claude", "Gemini", "人工智能", "AIGC", "生成式", "多模态", "Copilot", "AI 编程", "AI编程", "Token", "推理模型", "豆包", "千问", "DeepSeek", "ChatGPT", "模型", "自动驾驶", "开源模型", "API"],
  career: ["招聘", "应届", "岗位", "就业", "薪资", "裁员", "校招", "实习", "人才", "求职", "职位", "工资", "毕业生", "人力", "入职", "最低工资", "Offer"],
  learning: ["教程", "入门", "开源", "课程", "学习", "C 语言", "C语言", "编程", "代码", "开发", "GitHub", "算法", "数据结构", "实践", "工具", "框架", "操作系统", "编译器", "调试", "教育", "高校"],
  industry: ["芯片", "算力", "融资", "政策", "厂商", "营收", "产业", "云计算", "硬件", "数据中心", "产能", "销量", "标准", "监管", "生态", "新能源", "机器人", "半导体", "国产化"]
};

const CATEGORY_LABEL = { agent: "智能体", industry: "行业", career: "就业", learning: "学习" };

const INSIGHT = {
  agent: {
    why: "智能体正从「会聊天」走向「会交付」：能拆解任务、调用工具、产出结果。能力边界在往上移，人的价值也随之往需求定义与结果验收迁移。",
    forYou: "让 AI 生成一段 C 代码，你负责逐行检查边界条件、内存释放和返回值。会 review，比会调用更难，也更值钱。"
  },
  career: {
    why: "招聘与岗位口径的变化，往往比技术新闻更早反映市场真实需要。看清楚被奖励的是哪种能力，比追热点更有用。",
    forYou: "把一个课程作业写成「输入—输出—验收标准」三行说明，这就是简历上能讲清楚的项目。"
  },
  learning: {
    why: "工具和方法会持续迭代，但底层原理变化很慢。把新工具当成练手的场景，而不是要背下来的结论。",
    forYou: "挑这条里提到的一个做法，今天用 20 分钟写个最小 demo 验证一遍，记进学习总结。"
  },
  industry: {
    why: "产业链上的投入与调整，最终会传导到岗位需求和开发工具。先看谁在投入、谁在收缩，再决定学什么。",
    forYou: "记录一个你关心的指标（算力、岗位数、开源活跃度），下周再对比一次，练习用数据判断趋势。"
  }
};

/* ---------------------------------------------------------
   工具函数
   --------------------------------------------------------- */
function cleanText(value, max) {
  let text = String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > max) text = text.slice(0, max).replace(/[\s,，、;；]+$/, "") + "…";
  return text;
}

function hash(value) {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) h = ((h << 5) - h + value.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

function safeUrl(value) {
  try {
    const parsed = new URL(value);
    return /^https?:$/.test(parsed.protocol) ? parsed.href : "https://www.qbitai.com/";
  } catch (error) {
    return "https://www.qbitai.com/";
  }
}

function stampOf(value, fallbackDate) {
  const match = String(value || "").match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (!match) return { date: fallbackDate, time: "08:00" };
  const p = (n) => String(n).padStart(2, "0");
  return {
    date: `${match[1]}-${p(Number(match[2]))}-${p(Number(match[3]))}`,
    time: match[4] ? `${p(Number(match[4]))}:${match[5]}` : "08:00"
  };
}

function scoreOf(text, weight) {
  let score = weight;
  let category = "industry";
  let best = 0;
  Object.keys(KEYWORDS).forEach((key) => {
    let hits = 0;
    KEYWORDS[key].forEach((word) => { if (text.indexOf(word) !== -1) hits += 1; });
    if (hits > best) { best = hits; category = key; }
    score += hits * 2;
  });
  return { score, category, relevant: best > 0 };
}

function insightOf(category, title) {
  const base = INSIGHT[category] || INSIGHT.industry;
  let extra = "";
  if (/开源|GitHub|源码/.test(title)) extra = " 这条涉及开源实现，直接读仓库比看二手解读更快。";
  else if (/模型|大模型|推理|智能体/.test(title)) extra = " 留意它真正解决的是哪一类任务，而不是榜单上的数字。";
  else if (/招聘|应届|岗位|薪资|就业/.test(title)) extra = " 把它和课程里正在学的能力对照一下，找出还缺的那一块。";
  else if (/芯片|算力|硬件|数据中心/.test(title)) extra = " 底层资源的变化，最终会体现在你用的开发工具与部署方式上。";
  else if (/教程|入门|课程|学习/.test(title)) extra = " 先把原理弄明白，再决定要不要把工具加进自己的工作流。";
  return { why: base.why + extra, forYou: base.forYou };
}

function parsePayload(source, json) {
  if (source.parse === "ainews") {
    const data = json && json.data;
    if (!data || !Array.isArray(data.news)) return [];
    return data.news.map((item) => ({
      title: item.title, summary: item.detail, url: item.link,
      stamp: item.date || data.date, source: item.source || source.name
    }));
  }
  if (source.parse === "rss2json") {
    if (!json || json.status !== "ok" || !Array.isArray(json.items)) return [];
    return json.items.map((item) => ({
      title: item.title, summary: item.description || item.content,
      url: item.link, stamp: item.pubDate, source: source.name
    }));
  }
  if (source.parse === "itnews") {
    const list = json && json.data;
    if (!Array.isArray(list)) return [];
    return list.map((item) => ({
      title: item.title, summary: item.description,
      url: item.link, stamp: item.created, source: source.name
    }));
  }
  const data = json && json.data;
  if (!data || !Array.isArray(data.news)) return [];
  return data.news.map((line) => ({
    title: line, summary: "", url: data.link, stamp: data.date, source: source.name
  }));
}

async function getJson(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(12000),
    headers: { "user-agent": "morningcode-daily-news/1.0" }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function fetchSource(source) {
  for (const url of source.urls) {
    try {
      const entries = parsePayload(source, await getJson(url));
      if (entries.length) return entries;
    } catch (error) {
      console.warn(`  [跳过] ${source.name} ${url.split("?")[0]} → ${error.message}`);
    }
  }
  return [];
}

/* ---------------------------------------------------------
   主流程
   --------------------------------------------------------- */
async function main() {
  const today = beijingDateKey();

  if (process.env.FORCE_NEWS !== "1") {
    try {
      const previous = JSON.parse(await readFile(JSON_OUT, "utf8"));
      const dated = await readFile(join(DAILY_DIR, `news-${today}.json`), "utf8");
      if (previous.date === today && JSON.parse(dated).date === today) {
        console.log(`今日（${today}）简报已生成，跳过。需要重跑请设置 FORCE_NEWS=1。`);
        return;
      }
    } catch (error) { /* 首次生成 */ }
  }

  console.log(`开始生成 ${today} 的行业简报…`);
  const settled = await Promise.allSettled(SOURCES.map(fetchSource));
  const raw = [];
  const sources = [];
  settled.forEach((result, index) => {
    const source = SOURCES[index];
    if (result.status !== "fulfilled" || !result.value.length) return;
    sources.push(source.name);
    result.value.forEach((entry) => raw.push({ ...entry, weight: source.weight }));
  });
  console.log(`可用来源：${sources.join(" / ") || "无"}，原始条目 ${raw.length} 条`);
  if (!sources.length) throw new Error("所有新闻源均不可用，保留上一期数据");

  const seen = new Set();
  const ranked = [];
  raw.forEach((entry) => {
    const title = cleanText(entry.title, 90);
    if (title.length < 6) return;
    const key = title.replace(/[\s\p{P}]/gu, "").toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    const summary = cleanText(entry.summary, 150);
    const scored = scoreOf(`${title} ${summary}`, entry.weight);
    if (!scored.relevant) return;

    const stamp = stampOf(entry.stamp, today);
    const age = dayNumber(today) - dayNumber(stamp.date);
    if (age < 0 || age > MAX_AGE_DAYS) return;

    const insight = insightOf(scored.category, title);
    ranked.push({
      id: `d-${stamp.date.replace(/-/g, "")}-${hash(title)}`,
      date: stamp.date,
      time: stamp.time,
      category: scored.category,
      source: entry.source,
      readTime: Math.min(6, Math.max(2, Math.round(summary.length / 60) + 2)),
      title,
      summary: summary || `${entry.source} 今日报道，点击原文查看完整背景与数据。`,
      why: insight.why,
      forYou: insight.forYou,
      url: safeUrl(entry.url),
      _score: scored.score - age * 3
    });
  });

  ranked.sort((a, b) => b._score - a._score);
  if (ranked.length < MIN_ITEMS) {
    throw new Error(`相关条目仅 ${ranked.length} 条（少于 ${MIN_ITEMS} 条），保留上一期数据`);
  }

  const picked = [];
  const perCategory = {};
  ranked.forEach((item) => {
    if (picked.length >= MAX_ITEMS) return;
    const used = perCategory[item.category] || 0;
    if (used >= MAX_PER_CATEGORY) return;
    perCategory[item.category] = used + 1;
    picked.push(item);
  });
  ranked.forEach((item) => {
    if (picked.length >= MAX_ITEMS) return;
    if (!picked.includes(item)) picked.push(item);
  });
  const items = picked.map(({ _score, ...item }) => item);

  const counts = {};
  items.forEach((item) => { counts[item.category] = (counts[item.category] || 0) + 1; });
  const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || "industry";
  const label = CATEGORY_LABEL[top];

  const payload = {
    date: today,
    generatedAt: beijingISOString(),
    generator: "GitHub Actions · daily-news.yml",
    edition: `DAILY · ${today}`,
    updatedAt: beijingISOString(),
    headline: `今日焦点 · ${label}：${cleanText(items[0].title, 32)}`,
    editorial: `本期由每日凌晨定时任务从 ${sources.join(" / ")} 自动聚合，按与 C 语言学习者的相关度筛出 ${items.length} 条，其中「${label}」${counts[top]} 条。${INSIGHT[top].why}`,
    sourceLine: `本期来源：${sources.join(" / ")}。由 GitHub Actions 每日 00:30（北京时间）自动生成，仅聚合公开信息，观点为站内编辑分析，版权归原作者所有。`,
    sources,
    defaultOrder: items.map((item) => item.id),
    items
  };

  const jsonText = JSON.stringify(payload, null, 2) + "\n";
  const jsText = "/* 由 GitHub Actions 每日凌晨生成，请勿手工编辑。*/\n" +
    `window.MORNINGCODE_NEWS_SCHEDULED = ${JSON.stringify(payload, null, 2)};\n`;

  await mkdir(DAILY_DIR, { recursive: true });
  await writeFile(JSON_OUT, jsonText, "utf8");
  await writeFile(JS_OUT, jsText, "utf8");
  // 每天一个独立 URL：CDN 对新路径必然回源，不会被 12 小时分支缓存拖住
  await writeFile(join(DAILY_DIR, `news-${today}.json`), jsonText, "utf8");
  await writeFile(join(DAILY_DIR, `news-${today}.js`), jsText, "utf8");

  // 只保留最近 KEEP_DAYS 天，避免仓库无限膨胀
  const cutoff = dayNumber(today) - KEEP_DAYS;
  for (const name of await readdir(DAILY_DIR)) {
    const match = name.match(/^news-(\d{4}-\d{2}-\d{2})\.(json|js)$/);
    if (match && dayNumber(match[1]) < cutoff) await unlink(join(DAILY_DIR, name));
  }

  console.log(`\n已生成 ${items.length} 条（${Object.keys(counts).map((k) => `${CATEGORY_LABEL[k]} ${counts[k]}`).join(" / ")}）`);
  items.forEach((item, index) => console.log(`  ${String(index + 1).padStart(2, "0")}. [${CATEGORY_LABEL[item.category]}] ${item.title}`));
  console.log(`\n输出：${JSON_OUT}\n      ${JS_OUT}\n      assets/daily/news-${today}.json / .js`);
}

main().catch((error) => {
  console.error(`生成失败：${error.message}`);
  process.exitCode = 1;
});
