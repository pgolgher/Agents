import { chromium } from "playwright";
import dotenv from "dotenv";

dotenv.config({ override: true });

const AGU_URL =
  "https://supersapiens.agu.gov.br/apps/tarefas/judicial/minhas-tarefas/entrada";

async function inspectCards() {
  const email = process.env.AGU_EMAIL!;
  const senha = process.env.AGU_SENHA!;

  const browser = await chromium.launch({ headless: false, slowMo: 150 });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // Login
  await page.goto(AGU_URL, { waitUntil: "networkidle", timeout: 60_000 });
  await page.locator("button.bt-rede").waitFor({ state: "visible", timeout: 20_000 });
  await page.locator("button.bt-rede").click();
  await page.locator('input[name="username"][type="email"]').waitFor({ state: "visible" });
  await page.locator('input[name="username"][type="email"]').click();
  await page.keyboard.press("Control+a");
  await page.locator('input[name="username"][type="email"]').pressSequentially(email, { delay: 50 });
  await page.keyboard.press("Tab");
  await page.locator('input[name="password"]').click();
  await page.keyboard.press("Control+a");
  await page.locator('input[name="password"]').pressSequentially(senha, { delay: 50 });
  await page.keyboard.press("Tab");
  const disabled = await page.locator("button.bt-rede").evaluate((el: HTMLButtonElement) => el.disabled);
  if (disabled) await page.locator('input[name="password"]').press("Enter");
  else await page.locator("button.bt-rede").click();
  await page.waitForURL((u) => !u.toString().includes("/auth/login"), { timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 30_000 });
  console.log("✅ Logged in:", page.url());

  // Wait for task cards, let Angular settle
  await page.locator("cdk-tarefa-list-item").first().waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(5000);

  // Click div.info on first card (confirmed working from previous inspector)
  console.log("\n=== Clicking div.info on first card ===");
  await page.locator("cdk-tarefa-list-item div.info").first().click();

  // Wait for URL to change to task detail
  await page.waitForURL((u) => u.toString().includes("/tarefa/"), { timeout: 20_000 });
  console.log("URL after click:", page.url());

  // Wait a bit more for all API calls to complete and content to render
  await page.waitForTimeout(5000);

  // Find ALL elements with substantial text content
  console.log("\n=== ALL ELEMENTS WITH TEXT > 20 chars ===");
  const textElements = await page.evaluate(() => {
    const results: Array<{ selector: string; text: string; visible: boolean }> = [];
    const seen = new Set<string>();

    document.querySelectorAll("*").forEach((el) => {
      const htmlEl = el as HTMLElement;
      // Skip containers with many children
      if (htmlEl.children.length > 3) return;
      // Skip style/script
      if (["STYLE", "SCRIPT", "HEAD", "META", "LINK"].includes(el.tagName)) return;
      const text = htmlEl.innerText?.trim() ?? "";
      if (text.length < 20 || seen.has(text)) return;
      seen.add(text);
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : "";
      const classes = Array.from(el.classList).slice(0, 3).join(".");
      const sel = `${tag}${id}${classes ? "." + classes : ""}`;
      const rect = htmlEl.getBoundingClientRect();
      results.push({
        selector: sel,
        text: text.slice(0, 120),
        visible: rect.width > 0 && rect.height > 0 && rect.top >= 0,
      });
    });
    return results.slice(0, 40);
  });

  textElements.forEach((e) => {
    if (e.visible) console.log(`  [VISIBLE] ${e.selector}: "${e.text.slice(0, 100)}"`);
  });
  console.log("\n  --- hidden/off-screen ---");
  textElements.forEach((e) => {
    if (!e.visible) console.log(`  [hidden] ${e.selector}: "${e.text.slice(0, 100)}"`);
  });

  // Look specifically for NUP, processo info, party names
  console.log("\n=== SEARCHING FOR TASK-SPECIFIC CONTENT ===");
  const taskContent = await page.evaluate(() => {
    const body = document.body.innerText;
    // Find NUP pattern
    const nupMatch = body.match(/00417\.?\d+\/?\d+/);
    // Find any section with process details
    const contentAreas = Array.from(document.querySelectorAll(
      "cdk-capa, app-capa, agu-capa, .capa, [class*='capa'], mat-card, .processo-info, .right-panel, .detail-panel, div.right, div.panel, .content-area"
    ));
    return {
      nupFound: nupMatch?.[0] ?? "NOT FOUND",
      contentAreas: contentAreas.map(el => ({
        tag: el.tagName,
        classes: Array.from(el.classList).join(" "),
        text: (el as HTMLElement).innerText?.trim().slice(0, 200),
      })),
    };
  });
  console.log("NUP in page:", taskContent.nupFound);
  console.log("Content area elements:", JSON.stringify(taskContent.contentAreas, null, 2));

  // Check router-outlets (where Angular renders route components)
  console.log("\n=== ROUTER-OUTLETS ===");
  const routerOutlets = await page.evaluate(() => {
    const outlets = Array.from(document.querySelectorAll("router-outlet"));
    return outlets.map((el, i) => ({
      index: i,
      nextSibling: el.nextElementSibling
        ? `${el.nextElementSibling.tagName}.${Array.from(el.nextElementSibling.classList).join(".")}`
        : "none",
      nextSiblingText: (el.nextElementSibling as HTMLElement)?.innerText?.trim().slice(0, 200) ?? "",
    }));
  });
  routerOutlets.forEach((o) => {
    console.log(`  outlet[${o.index}]: next=${o.nextSibling}`);
    if (o.nextSiblingText) console.log(`    text: "${o.nextSiblingText.slice(0, 150)}"`);
  });

  await page.waitForTimeout(3000);
  await context.close();
  await browser.close();
}

inspectCards().catch(console.error);
