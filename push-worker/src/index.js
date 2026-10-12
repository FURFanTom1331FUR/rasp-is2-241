// Worker rasp-push: раз в минуту проверяет, у кого через N минут начинается пара, и шлёт Web Push.
// Подписки — в том же KV, что и у Pages (functions/push/*). Расписание берёт с rasp-is2-241.pages.dev/schedule
// (там копия на краю Cloudflare 45 минут), так что сайт ВГЛТУ не дёргается каждую минуту.
import { handlePush, runCron } from "../../functions/_push.js";

export default {
  async scheduled(controller, env, ctx) {
    const report = await runCron(env, controller.scheduledTime);
    if (!report.idle) console.log(JSON.stringify(report));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const match = /^\/push\/(key|status|subscribe|unsubscribe|test)$/.exec(url.pathname);
    if (match) return handlePush({ request, env, waitUntil: ctx.waitUntil.bind(ctx) }, match[1]);
    return new Response("rasp-push: cron worker for «Пары» notifications", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  },
};
