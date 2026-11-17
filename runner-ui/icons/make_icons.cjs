// "stage" / "real" 글자가 들어간 1024px 아이콘 PNG 를 만든다 (Playwright 로 HTML 렌더)
const { chromium } = require('/Users/user/Documents/playwright-works/node_modules/@playwright/test');
const specs = [
  { name: 'stage', text: 'stage', sub: '자동화 실행 패널', from: '#2563eb', to: '#1e3a8a' },
  { name: 'real', text: 'real', sub: '자동화 실행 패널', from: '#dc2626', to: '#7f1d1d' },
];
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
  for (const s of specs) {
    await page.setContent(`<html><body style="margin:0;background:transparent">
      <div style="width:1024px;height:1024px;display:flex;align-items:center;justify-content:center;">
        <div style="width:900px;height:900px;border-radius:200px;background:linear-gradient(145deg,${s.from},${s.to});
             display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;
             font-family:-apple-system,'Apple SD Gothic Neo',sans-serif;box-shadow:0 30px 60px rgba(0,0,0,.35)">
          <div style="font-size:280px;font-weight:800;letter-spacing:-8px;line-height:1">${s.text}</div>
          <div style="font-size:88px;font-weight:600;margin-top:40px;opacity:.9">${s.sub}</div>
          <div style="font-size:70px;margin-top:60px;opacity:.75">▶</div>
        </div></div></body></html>`);
    await page.screenshot({ path: `icons/${s.name}.png`, omitBackground: true });
    console.log('made', s.name);
  }
  await browser.close();
})();
